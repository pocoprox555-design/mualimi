// معلمي 3: خادم واحد ينسّق استرجاع المصادر ويترك تفسير الطلب وصياغة الإجابة للنموذج.
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')); } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

import { publicConfig, resolveProvider, resolveWebSearch } from './lib/config.mjs';
import { getCatalog, getHealth, getSubjects, listBooks, locate, fullPage, search, retrieveContext, resolveBook, catalogContext } from './lib/index.mjs';
import * as corpusIndex from './lib/index.mjs';
import { getOutline, listOutlineIds, outlineContext } from './lib/outline.mjs';
import { streamCompletion } from './lib/provider.mjs';
import { pageReference } from './lib/text.mjs';
import { heartbeat, readJsonBody, sendJson, serveStatic, sseHeaders, sseSend } from './lib/http.mjs';
import { searchWeb } from './lib/web-search.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const startedAt = Date.now();
const MAX_HISTORY = 14;
const MAX_MESSAGE = 4_000;
// النموذج نموذج استدلال: 600 رمز كانت تُنفد كلها في reasoning_content قبل كائن
// التخطيط، فيفشل التخطيط ويضيعت جولة كاملة. 2048 تغطي الاستدلال+kائن JSON.
const MAX_PLAN_TOKENS = 2_048;
const MAX_PLAN_CHARS = 6_000;
// مهلة مستقلة للمخطط: تجاوزها لا يعني تعطّل المزوّد، والأفضل المتابعة بالبحث
// المحلي على الانتظار. لا تُعامل كمشكلة مزوّد حتى لا تُنهى الإجابة كلها.
const PLAN_DEADLINE_MS = 18_000;
// ميزانية زمنية لكل عمل PDF (فتح صفحة/رسمها). العمل مُسلسل داخل pdf-fallback،
// فكل محاولة زائدة تدفع زمن أول رمز في الإجابة إلى الخلف.
const RETRIEVAL_DEADLINE_MS = 12_000;
const MAX_PDF_ATTEMPTS = 3;
const PDF_PAGE_DEADLINE_MS = 8_000;
// صفحة موسومة damaged-text نصوصها غير قابلة للنقل لكن صورتها تُقرأ بصرياً،
// فيكفي فتح واحدة فقط (الأقوى) لإخراجها من دائرة الحذف.
const MAX_DAMAGED_VISION_PAGES = 1;
// مهلة جولة القراءة البصرية وحدها: فتح صفحة ورسمها ~1.3 ثانية، والجولة تتوقف
// عند هذه المهلة مهما تعداد المرشحون.
const VISION_PASS_BUDGET_MS = 6_000;
// عدد المرشحين المفتوحين في جولة واحدة. خمسة تكفي للوصول إلى الصفحة المطلوبة
// حين يعطي المرشحون الأعلى نصًا سليمة بدل صورة، وتبقى الحزمة محدودة عملًا
// (~1.3 ثانية لكل فتح) ومحدودة بست ثوانٍ بمهلة الجولة.
const VISION_PASS_MAX_ATTEMPTS = 5;
const MAX_EVIDENCE_IMAGES = 2;
// مصادر من كتب أخرى تظهر عند هذا العدد فقط كحد أقصى، ومن ثم تُقتطع بدل عرضها
// على الطالبة كأنها من كتاب سؤالها.
const MAX_CROSS_BOOK_SOURCES = 2;
const MAX_ANSWER_ROUNDS = 3;
const MAX_ANSWER_CHARS = 64_000;
const counters = new Map();
const providerHealth = { verified: null, lastError: null, checkedAt: 0 };

const clean = (value, max = 4000) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()
  .slice(0, max);

function textOf(content) {
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n');
  return typeof content === 'string' ? content : '';
}

function historyFor(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .slice(-MAX_HISTORY)
    .map((message) => ({
      role: message.role,
      content: clean(textOf(message.content), MAX_MESSAGE) || (message.role === 'user' && imageParts(message.content).length ? '[صورة مرفقة]' : ''),
    }))
    .filter((message) => message.content);
}

function safeSession(value) {
  const session = clean(value, 80).replace(/[^a-zA-Z0-9._:-]/g, '-');
  return session || `mualimi-${Date.now().toString(36)}`;
}

function systemPrompt(context, studentName = '', outlineBlock = '', catalogBlock = '', track = 'ديني', webBlock = '', citationIds = [], catalogScope = 'track', primaryBlock = '', visionBlock = '') {
  const name = String(studentName || 'رحمة').trim().slice(0, 40);
  const allowedCitations = [...new Set(citationIds)].filter((id) => /^[A-Z]\d{1,5}$/.test(id));
  const citationList = allowedCitations.length ? allowedCitations.map((id) => `[${id}]`).join('، ') : 'لا توجد إحالات متاحة';
  return [
    'أنت «معلمي»، مدرس عراقي محترف وهادئ للسادس الإعدادي.',
    `الطالبة ${name} تدرس السادس الإعدادي في مسار «${track}». استخدمي مصادر هذا المسار وحدها في الإجابة المدرسية؛ لا تخلطي كتب الأدبي أو التعليم العام بمنهجها لمجرد تشابه اسم المادة. إذا طلبت مقارنة مسارين فوضحي الفرق صراحة.`,
    'خاطبي الطالبة بصيغة المؤنث وبالعربية الفصحى السهلة مع لمسة عراقية طبيعية عند الحاجة. كوني ودودة وصبورة كمدرسة تعرف سياق المحادثة: تذكري ما قالته في الجلسة، اسألي سؤال توضيح واحدًا عند غموض المادة أو المقصود، ولا تكرري طلب معلومة سبق أن ذكرتها.',
    catalogBlock
      ? `\n## بيانات الكتالوج ونطاقها\n${catalogBlock}\n\nنطاق هذه البيانات ${catalogScope === 'global' ? 'جميع الكتب المتاحة في التطبيق عبر المسارات' : `كتب مسار «${track}» فقط، وليست جميع كتب التطبيق`}. عند السؤال عن كتب مسار رحمة اذكري كتب «${track}» فقط. لا تصفي كتالوج المسار بأنه كتالوج التطبيق الكامل؛ اذكري كل المسارات فقط إذا كان النطاق المعروض عالميًا. ميّزي بين الاسم الرسمي للكتاب والمادة المقابلة له، واذكري أن المطابقة جزئية عندما يختلف المقرر الرسمي عن اسم المادة في جدولها.`
      : '',
    primaryBlock
      ? `\n## الكتاب المقصود بسؤال الطالبة\n${primaryBlock}\n\nهذا الكتاب هو مصدر السؤال، وصفحاته هي الأدلة الأساسية. اعتمدي صفحاته أولًا وأجيبي منها. إن ظهرت لديك صفحة من كتاب آخر فاعلمي أنها من كتاب آخر ومن مادة مختلفة، واذكري ذلك صراحة، ولا تعرضيها كأنها من هذا الكتاب. ولا تعودي إلى كتاب آخر ما دامت في هذا الكتاب صفحة تجيب.`
      : '',
    outlineBlock
      ? `\n## مخطط وصفي للمادة\n${outlineBlock}\n\nهذا مخطط فهرسي للتنقل والبنية وأرقام الصفحات، وليس نسخا حرفيا من PDF. استعمليه للفصول والوحدات وتحديد الصفحة فقط. لا تنسبي إليه آية أو حديثا أو حلا أو اقتباسا حرفيا.`
      : '',
    'افهم السؤال ثم أجيبي مباشرة وبشرح تعليمي واضح؛ لا تملئي الرد بسرد خطوات البحث. في الرياضيات اشرحي الحل خطوة خطوة، وفي اللغات اذكري القاعدة والمثال، وفي المواد الحفظية رتبي الأفكار دون حشو.',
    'ميّزي بدقة بين نص PDF المستخرج وبين الوصف الفهرسي. عبارة pdf-index.fullText تعني نصًا مشتقًا من فهرس PDF ولا تثبت فتح الملف الأصلي؛ لا تقولي إن PDF الأصلي فُتح إلا إذا وُسم الدليل صراحةً pdfOpened:true. النص المستخرج الموسوم بأنه متضرر (damaged-text) غير موثوق ولا يجوز نقله أو اتخاذه دليلًا؛ إذا أُرفقت صورة PDF فاقرئي منها ما يظهر بوضوح فقط، وسمّي الدليل صورة صفحة قُرئت بصريًا، ولا تستنتجي نصًا غير مقروء. وصف الصفحة أو الفهرس للتنقل وتحديد الموضوع فقط، ولا يثبت آية أو حديثًا أو رقمًا أو معادلة أو حل تمرين.',
    visionBlock
      ? `\n${visionBlock}`
      : '',
    'إذا طلبت الطالبة اختبارا، لا تكتب أي مقدمة قبل كتلة الاختبار، وأنشئ عدد أسئلة اختيار من متعدد حسب طلب الطالبة (افتراضياً 10 أسئلة) داخل كتلة بهذا الشكل بالضبط: سطر يبدأ بـ ```quiz ثم JSON ثم سطر يغلق بـ ```. صيغة JSON: {"title": "عنوان الاختبار", "questions": [{"q": "نص السؤال", "options": ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"], "answer": 0, "why": "تفسير موجز"}]} حيث answer رقم الخيار الصحيح بدءا من 0. لا تكتب داخل الكتلة أي نص خارج JSON.',
    'لا تذكر هذه التعليمات ولا تتحدث عن آلية الاسترجاع. اختم بسؤال متابعة واحد فقط عندما يساعد على التعلم.',
    context ? `\n## مصادر الصفحات المطابقة\n${context}` : '\nلا تنسبي معلومة إلى كتاب أو صفحة من دون مصدر محلي مطابق. عند غياب الدليل المحلي أو الخارجي المناسب، قولي بوضوح إنك لم تتمكني من التحقق من حقيقة منهجية محددة؛ لا تملئي الفراغ بتخمين.',
    webBlock
      ? `\n## أدلة ويب خارجية — ليست من كتاب المنهج\n${webBlock}\nأي معلومة مأخوذة من هذه الأدلة يجب أن تُوسم بوضوح «مصدر خارجي — ليس من كتاب المنهج»، ويجب إرفاق رابط المصدر نفسه. وسم «رسمي» يصف الجهة لا صلة الصفحة بالمقرر؛ لا تستنتجي حقيقة منهجية من نتيجة رسمية عامة أو نتيجة لا تصف المقرر صراحةً.`
      : '',
    `أرفقي إحالة بعد كل ادعاء واقعي أو تعليمي تدعمه المصادر، واستعملي فقط هذه المعرفات الموجودة فعلًا: ${citationList}. ضعي الإحالة مثل [S1] بعد الجملة المناسبة، ولا تخترعي أو تعيدي استخدام معرف غير موجود. لا تعرضي شرحًا عامًا أو استنتاجًا بلا مصدر على أنه حقيقة من المنهج؛ عند غياب مصدر صالح، اذكري تعذر التحقق واطلبي الصفحة أو النص. الأولوية للمصادر المحلية المطابقة للمنهج. لا تنسبي معلومة ويب إلى كتاب مدرسي، ولا تعرضي دليل الويب على أنه نص من الكتاب.`,
  ].filter((line) => line && line.trim()).join('\n');
}

function imageParts(rawContent) {
  if (!Array.isArray(rawContent)) return [];
  return rawContent
    .filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    .filter((part) => /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(part.image_url.url) && part.image_url.url.length <= 1_500_000)
    .slice(0, 2)
    .map((part) => ({ type: 'image_url', image_url: { url: part.image_url.url } }));
}

function modelMessages(body, sourceBlock, outlineBlock, catalogBlock, track, webBlock = '', extraImages = [], citationIds = [], catalogScope = 'track', primaryBlock = '') {
  const history = historyFor(body.messages);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const rawLast = rawMessages.filter((message) => message?.role === 'user').at(-1);
  const lastText = clean(textOf(rawLast?.content), MAX_MESSAGE);
  const lastIndex = history.findLastIndex((message) => message.role === 'user');
  const prior = history.slice(0, Math.max(0, lastIndex)).slice(-MAX_HISTORY);
  const images = [...imageParts(rawLast?.content), ...extraImages].slice(0, 2);
  const visionBlock = images.length
    ? '## صورة صفحة مرفقة\nأُرفقت صورة صفحة PDF في هذه الرسالة. يمكنكِ قراءتها بصريًا وهي دليل مسموح: اذكري ما يظهر فيها بوضوح فقط، وسمّي الدليل «صورة صفحة قُرئت بصريًا» مع معرّفها، ولا تخمّني ما لا يظهر، ولا تقرئي الأرقام والكلمات الصغيرة غير الواضحة. أجيبي عمّا سُئلت عنه فقط من الصفحة، دون استعراض الصفحة كلها أو نسخ نصها كاملًا؛ فالإجابة المطوّلة على سؤال واحد تُضيّع وقت الطالبة.'
    : '';
  return [
    { role: 'system', content: systemPrompt(sourceBlock, clean(body.studentName, 40), outlineBlock, catalogBlock, track, webBlock, citationIds, catalogScope, primaryBlock, visionBlock) },
    ...prior,
    { role: 'user', content: images.length ? [{ type: 'text', text: lastText || 'اشرحي ما يظهر في الصورة المرفقة.' }, ...images] : lastText },
  ];
}

function contentCost(content) {
  if (typeof content === 'string') return Math.ceil(content.length / 2);
  if (!Array.isArray(content)) return 0;
  let textLength = 0;
  let imageCost = 0;
  for (const part of content) {
    if (part?.type === 'text') textLength += String(part.text || '').length;
    if (part?.type === 'image_url') imageCost += Math.min(8_000, Math.ceil(String(part.image_url?.url || '').length / 256));
  }
  return Math.ceil(textLength / 2) + imageCost;
}

function promptCost(messages) {
  return messages.reduce((total, message) => total + contentCost(message?.content) + 12, 0);
}

function shrinkText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  if (maxChars <= 800) return text.slice(0, maxChars);
  const marker = '\n[… اختُصر السياق ضمن حد نافذة النموذج …]\n';
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.58);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

// تحافظ على تعليمات النظام وآخر طلب، وتحذف أقدم تاريخ المحادثة قبل تقليص السياق.
function fitMessages(messages, config, reservedTokens) {
  const contextWindow = Number(config.contextWindow) || 1_000_000;
  const charLimit = Number(config.maxPromptChars) || 100_000;
  const tokenBudget = Math.max(1_024, Math.min(contextWindow - reservedTokens - 512, Math.floor(charLimit / 2)));
  const fitted = messages.map((message) => ({ ...message }));
  while (promptCost(fitted) > tokenBudget && fitted.length > 2) fitted.splice(1, 1);

  if (promptCost(fitted) > tokenBudget && typeof fitted[0]?.content === 'string') {
    const remainder = fitted.slice(1).reduce((total, message) => total + contentCost(message.content) + 12, 0);
    const systemBudget = Math.max(500, tokenBudget - remainder - 12);
    fitted[0] = { ...fitted[0], content: shrinkText(fitted[0].content, systemBudget * 2) };
  }
  if (promptCost(fitted) > tokenBudget && fitted.length) {
    const lastIndex = fitted.length - 1;
    const latest = fitted[lastIndex];
    const remainder = fitted.slice(0, lastIndex).reduce((total, message) => total + contentCost(message.content) + 12, 0);
    const latestBudget = Math.max(300, tokenBudget - remainder - 12);
    if (typeof latest.content === 'string') {
      fitted[lastIndex] = { ...latest, content: shrinkText(latest.content, latestBudget * 2) };
    } else if (Array.isArray(latest.content)) {
      let textBudget = latestBudget * 2;
      const content = latest.content.map((part) => {
        if (part?.type !== 'text') return part;
        const text = String(part.text || '');
        const clipped = shrinkText(text, Math.max(200, textBudget));
        textBudget = Math.max(0, textBudget - clipped.length);
        return { ...part, text: clipped };
      });
      fitted[lastIndex] = { ...latest, content };
    }
  }
  return fitted;
}

const PLAN_INSTRUCTIONS = [
  'أنت مخطط استعمال أدوات لمعلم رقمي. مهمتك الوحيدة فهم نية الطالبة وتحديد عمليات الاسترجاع؛ لا تجب عن سؤالها ولا تكتب أي حقيقة أو شرح أو حل تعليمي.',
  'أعد كائن JSON فقط، دون Markdown أو نص قبله أو بعده، وبالمفاتيح التالية: {"intent":"curriculum|catalog|external|conversation|unclear","use_local":true,"local_query":"","book_query":"","subject":"","use_outline":false,"use_catalog":false,"catalog_scope":"track|global","exact_page":{"printed_page":null,"physical_page":null},"web_fallback":{"enabled":false,"query":""}}.',
  'إذا كان الطلب شرحًا أو حلًا أو ترجمة أو سؤالًا عن درس أو صفحة من المنهج، فاختر curriculum واطلب البحث المحلي أولًا بصياغة بحث موجزة وأمينة للسؤال. لا تخترع اسم كتاب أو رقم صفحة.',
  'إذا كان السؤال عن الكتب أو بنيتها فاختر catalog أو use_outline بحسب المطلوب. اجعل catalog_scope=global فقط إذا طلبت كل كتب التطبيق أو جميع المسارات؛ وإلا فالنطاق track ويقتصر على مسار الطالبة. إذا كان السؤال عن معلومة آنية أو خارج المنهج فاختر external. التحية والمحادثة البسيطة conversation.',
  'استخرج رقم الصفحة المطبوعة أو الفيزيائية فقط إذا كان صريحًا في السؤال أو الصورة. عند سؤال منهجي، فعّل web_fallback بوصفه خطة احتياطية عند غياب الدليل المحلي والصفحة الأصلية فقط، وصغ استعلامًا موجّهًا إلى المنهج العراقي والمصدر الرسمي عند الإمكان. لا تطلب الويب لمجرد أن الإجابة يمكن توسيعها.',
].join('\n');

function parsePlannerJson(value) {
  const fenced = String(value || '').match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = String(fenced || value || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function pageNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 9_999 ? number : null;
}

function normalizedQuestion(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .toLocaleLowerCase('ar');
}

function globalCatalogRequest(question) {
  const text = normalizedQuestion(question);
  return /(?:كل|جميع|كافة)\s+(?:(?:كتب|الكتب)\s+)(?:(?:الموجودة|المتاحة)\s+)?(?:في\s+)?(?:التطبيق|المكتبة|كل\s+المسارات|جميع\s+المسارات)|(?:كتب|الكتب)\s+(?:في\s+)?(?:كل|جميع)\s+المسارات|\b(?:all\s+(?:app\s+)?books|books\s+across\s+all\s+tracks)\b/.test(text);
}

function catalogQuestion(question) {
  const text = normalizedQuestion(question);
  return globalCatalogRequest(question)
    || /(?:كتالوج|فهرس|قائمة\s+(?:ال)?كتب|(?:كل|جميع)\s+(?:كتب|الكتب)|كتب\s+(?:التطبيق|المكتبة)|محتويات\s+الكتاب)/.test(text);
}

function catalogListQuestion(question) {
  const text = normalizedQuestion(question);
  return globalCatalogRequest(question)
    || /(?:كتالوج|فهرس\s+(?:الكتب|المكتبة)|قائمة\s+(?:ال)?كتب|(?:كل|جميع)\s+(?:كتب|الكتب)|كتب\s+(?:التطبيق|المكتبة|مساري)|(?:ما|اذكر|اعرض|اعرضي).{0,30}الكتب\s+(?:المتاحة|الموجودة)|الكتب\s+(?:المتاحة|الموجودة))/.test(text);
}

function catalogAdequatelyAnswers(plan, question, catalog) {
  if (!catalog?.books?.length || !(plan.intent === 'catalog' || plan.useCatalog)) return false;
  const text = normalizedQuestion(question);
  const asksCurriculumContent = /(?:اشرح|شرح|حل|ترجم|درس|الدرس|صفحة|فصل|وحدة|محتويات|تفاصيل|آية|حديث|قاعدة|معادلة|ماذا\s+في)/.test(text);
  if (catalogListQuestion(question) && !asksCurriculumContent) return true;

  const requested = [plan.bookQuery, plan.subject]
    .map((value) => normalizedQuestion(value))
    .filter((value) => value.length >= 2);
  const itemPresent = catalog.books.some((book) => {
    const name = normalizedQuestion(`${book.title || ''} ${book.subject || ''}`);
    const mentionedTitle = [book.title, book.subject]
      .map((value) => normalizedQuestion(value))
      .some((value) => value.length >= 4 && text.includes(value));
    const plannedItem = requested.some((value) => {
      if (name.includes(value)) return true;
      const tokens = value.split(/\s+/).filter((token) => token.length >= 3);
      return tokens.length > 0 && tokens.every((token) => name.includes(token));
    });
    return mentionedTitle || plannedItem;
  });
  if (!itemPresent) return false;

  const asksAvailability = /(?:موجود|موجودة|متوفر|متوفرة|متاح|متاحة|ضمن\s+(?:الكتالوج|التطبيق|المكتبة|المسار)|في\s+(?:التطبيق|المكتبة|الكتالوج|المسار))/.test(text)
    && /(?:كتاب|كتب|الكتاب|المادة|المنهج)/.test(text);
  const asksBookIdentification = plan.intent === 'catalog'
    && /(?:(?:أي|ما)\s+(?:هو\s+)?(?:ال)?كتاب|اسم\s+(?:ال)?كتاب|الكتاب\s+(?:المقرر|المخصص|المناسب))/.test(text)
    && !asksCurriculumContent;
  return asksAvailability || asksBookIdentification;
}

function curriculumQuestion(question, subject = '', bookId = '') {
  if (subject || bookId) return true;
  const text = normalizedQuestion(question);
  return /(?:المنهج|منهج|كتاب|الكتاب|درس|المادة|الصف|السادس|اعدادي|صفحة|اشرح|حل|ترجم|تمرين|اختبر|واجب|فصل|وحدة|معادلة|نظرية)/.test(text);
}

function needsPlannerBeforeLocal(question, hasImages = false) {
  if (hasImages || pageReference(question) != null || catalogQuestion(question)) return true;
  const text = normalizedQuestion(question);
  return /(?:فهرس|محتويات|ترتيب\s+(?:الوحدات|الفصول)|outline|table\s+of\s+contents|(?:اليوم|الان|حاليا|احدث|آخر\s+الاخبار|الطقس|سعر|من\s+هو|من\s+هي|ابحث.*(?:الويب|الانترنت)|latest|current|today|news|weather|price))/.test(text);
}

function normalizePlan(raw, question) {
  const intents = new Set(['curriculum', 'catalog', 'external', 'conversation', 'unclear']);
  const globalCatalog = globalCatalogRequest(question) || raw?.catalog_scope === 'global';
  const intent = globalCatalog ? 'catalog' : intents.has(raw?.intent) ? raw.intent : 'unclear';
  const exact = raw?.exact_page && typeof raw.exact_page === 'object' ? raw.exact_page : {};
  const web = raw?.web_fallback && typeof raw.web_fallback === 'object' ? raw.web_fallback : {};
  const webQuery = clean(web.query ?? raw?.web_query, 300);
  return {
    intent,
    useLocal: intent === 'conversation' || intent === 'catalog' ? false : intent === 'curriculum' ? true : raw?.use_local !== false,
    useCatalog: Boolean(raw?.use_catalog) || intent === 'catalog' || globalCatalog,
    catalogScope: globalCatalog ? 'global' : 'track',
    useOutline: Boolean(raw?.use_outline),
    localQuery: clean(raw?.local_query, 400) || clean(question, 400),
    bookQuery: clean(raw?.book_query, 160),
    subject: clean(raw?.subject, 120),
    exactPage: {
      printedPage: pageNumber(exact.printed_page ?? exact.printedPage),
      physicalPage: pageNumber(exact.physical_page ?? exact.physicalPage),
    },
    webFallback: { enabled: Boolean(web.enabled ?? raw?.use_web) && webQuery.length >= 2, query: webQuery },
  };
}

function fallbackPlan(question) {
  const isCatalog = catalogQuestion(question);
  const globalCatalog = globalCatalogRequest(question);
  return {
    intent: isCatalog ? 'catalog' : curriculumQuestion(question) ? 'curriculum' : 'unclear',
    useLocal: !isCatalog,
    useCatalog: isCatalog,
    catalogScope: globalCatalog ? 'global' : 'track',
    useOutline: false,
    localQuery: clean(question, 400),
    bookQuery: '',
    subject: '',
    exactPage: { printedPage: pageReference(question), physicalPage: null },
    webFallback: { enabled: false, query: '' },
  };
}

async function planIntent({ config, body, question, subject, bookId, track, session, signal, deadlineMs = PLAN_DEADLINE_MS }) {
  const history = historyFor(body.messages);
  const lastIndex = history.findLastIndex((message) => message.role === 'user');
  const prior = history.slice(0, Math.max(0, lastIndex)).slice(-6);
  const rawLast = (Array.isArray(body.messages) ? body.messages : []).filter((message) => message?.role === 'user').at(-1);
  const images = imageParts(rawLast?.content);
  const text = clean(textOf(rawLast?.content), MAX_MESSAGE) || (images.length ? 'أرسلت صورة لصفحة أو سؤال دراسي؛ حددي نية الاسترجاع دون الإجابة.' : question);
  const current = images.length
    ? { role: 'user', content: [{ type: 'text', text }, ...images] }
    : { role: 'user', content: text };
  const studentName = clean(body.studentName, 40) || 'رحمة';
  const planTokens = Math.min(MAX_PLAN_TOKENS, config.maxTokens);
  const messages = fitMessages([
    { role: 'system', content: `${PLAN_INSTRUCTIONS}\nالطالبة ${studentName} تدرس السادس الإعدادي في مسار «${track}». المادة المحددة: ${subject || 'غير محددة'}. الكتاب المختار إن وجد: ${bookId || 'غير محدد'}.` },
    ...prior,
    current,
  ], config, planTokens);
  // مهلة التخطيط مستقلة عن مهلة الطلب: تجاوزها قرار محسوب (المتابعة بالبحث
  // المحلي) لا عطل مزوّد، فلا يجوز إنهاء الإجابة كلها بسببه.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('PLANNER_DEADLINE')), Math.max(1_000, deadlineMs));
  const planSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let output = '';
  let finish = '';
  try {
    for await (const event of streamCompletion({
      endpoint: config.endpoint,
      key: config.key,
      model: config.model,
      messages,
      maxTokens: planTokens,
      signal: planSignal,
      session: `${session}-plan`.slice(0, 100),
    })) {
      if (event.type === 'text') {
        output += event.text;
        if (output.length > MAX_PLAN_CHARS) throw new Error('PLAN_TOO_LARGE');
      } else if (event.type === 'done') finish = event.finish || 'stop';
    }
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) {
      const expired = new Error('PLANNER_DEADLINE');
      expired.code = 'PLANNER_DEADLINE';
      throw expired;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const parsed = parsePlannerJson(output);
  if (!parsed || finish === 'length') throw new Error('PLAN_INCOMPLETE');
  return normalizePlan(parsed, question);
}

function requestIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function withinRateLimit(req) {
  const now = Date.now();
  const key = requestIp(req);
  const current = counters.get(key);
  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= Math.max(4, Number(process.env.RATE_LIMIT_PER_MINUTE) || 18);
}

function exactPageMatch(source, bookId, printedPage, physicalPage) {
  return source?.bookId === bookId
    && ((physicalPage != null && Number(source.physicalPage) === physicalPage)
      || (printedPage != null && Number(source.printedPage) === printedPage));
}

function sourceEvidenceStatus(source) {
  return String(source?.evidenceStatus || source?.status || '').toLowerCase();
}

function isReliablePdfPageText(page) {
  const text = clean(page?.text ?? page?.quotableText, 12_000);
  const status = String(page?.evidenceStatus || page?.status || '').toLowerCase();
  const evidenceType = String(page?.evidenceType || '').toLowerCase();
  return Boolean(text)
    && ['clean-extracted-text', 'ocr-text'].includes(status)
    && ['pdf-text', 'ocr-text'].includes(evidenceType);
}

function isReliableLocalSource(source) {
  const status = sourceEvidenceStatus(source);
  const evidenceType = String(source?.evidenceType || '').toLowerCase();
  const imageEvidence = source?.sourceType === 'pdf-fallback'
    && evidenceType === 'pdf-image'
    && source?.visionProvided === true;
  // damaged-text describes the text layer, never evidence that can be quoted.
  // A separate rendered page image counts only because that image is sent to vision.
  if (status === 'damaged-text' || evidenceType === 'damaged-text') return imageEvidence;
  if (imageEvidence) return true;
  if (source?.sourceType === 'pdf-fallback') {
    return source?.readable === true
      && source?.searchable === true
      && source?.quotableReliable === true
      && ['pdf-text', 'ocr-text'].includes(evidenceType)
      && (!status || ['clean-extracted-text', 'ocr-text'].includes(status));
  }
  return evidenceType === 'pdf-text'
    && source?.quotableReliable === true
    && status !== 'damaged-text';
}

function pageCitation(page, book, id, requested = {}) {
  const printedPage = page?.printedPage ?? requested.printedPage ?? null;
  const physicalPage = page?.physicalPage ?? requested.physicalPage ?? null;
  const evidenceStatus = page?.evidenceStatus || page?.status || null;
  const reliable = evidenceStatus === 'damaged-text'
    ? false
    : page?.quotableReliable ?? Boolean(page?.searchable && page?.quotableText);
  return {
    id,
    sourceType: 'curriculum',
    bookId: page?.bookId || book?.id || requested.bookId,
    title: book?.title || page?.bookTitle || page?.title || requested.bookId,
    subject: page?.subject || book?.subject || '',
    physicalPage,
    printedPage,
    pageTitle: page?.pageTitle || page?.title || '',
    evidenceType: page?.evidenceType || (page?.searchable ? 'pdf-text' : 'outline-description'),
    status: evidenceStatus,
    evidenceStatus,
    searchable: Boolean(page?.searchable),
    needsOcr: Boolean(page?.needsVision),
    quotableReliable: Boolean(reliable),
    damaged: Boolean(page?.damaged || evidenceStatus === 'damaged-text'),
  };
}

function indexedPageBlock(page, source) {
  const damagedText = sourceEvidenceStatus(source) === 'damaged-text' || source.evidenceType === 'damaged-text';
  const quotation = page?.quotableSource === 'pdf-text' && page?.quotableReliable && !damagedText
    ? page.quotableText
    : source.evidenceType === 'outline-description'
      ? page?.quotableText || page?.outlineSummary || page?.summary || ''
      : damagedText
        ? page?.outlineSummary || page?.summary || ''
        : page?.text || page?.summary || '';
  const text = clean(quotation, 12_000);
  if (!text) return '';
  const pageLabel = source.printedPage != null
    ? `الصفحة المطبوعة ${source.printedPage} (صفحة PDF ${source.physicalPage ?? 'غير محددة'})`
    : `صفحة PDF ${source.physicalPage ?? 'غير محددة'} (رقم مطبوع غير متحقق)`;
  const evidence = source.evidenceType === 'pdf-text' && source.quotableReliable && !damagedText
    ? 'نص مستخرج من PDF، فحص الاقتباس موثوق.'
    : source.evidenceType === 'outline-description'
      ? 'وصف فهرسي غير حرفي؛ لا يصلح اقتباسًا.'
      : damagedText
        ? 'طبقة نص PDF موسومة بالتلف؛ لا تصلح للاستشهاد. لا يُستخدم إلا وصف الفهرس غير الحرفي إن ظهر هنا.'
        : 'نص الصفحة غير موثوق حرفيًا؛ يلزم التحقق البصري.';
  return `[${source.id}] ${source.title} | ${pageLabel} | ${source.pageTitle}\n[نوع الدليل: ${evidence}]\n${text}`;
}

function fallbackPageBlock(page, source) {
  const pageLabel = source.printedPage != null
    ? `الصفحة المطبوعة ${source.printedPage} (صفحة PDF ${source.physicalPage ?? 'غير محددة'})`
    : `صفحة PDF ${source.physicalPage ?? 'غير محددة'} (رقم مطبوع غير متحقق)`;
  const evidenceType = clean(page?.evidenceType || source.evidenceType, 60) || 'pdf-page';
  const status = clean(page?.status || page?.evidenceStatus || 'unavailable', 60);
  const text = source.quotableReliable && !source.damaged && ['pdf-text', 'ocr-text'].includes(source.evidenceType)
    ? clean(page?.text, 12_000)
    : '';
  const imageProvided = source.evidenceType === 'pdf-image' && source.visionProvided === true;
  const pdfOpened = source.pdfOpened === true;
  const textSource = clean(source.textSource, 80);
  const textFromOriginal = pdfOpened && textSource === 'pdf-source.pdfjs';
  const textFromIndex = textSource === 'pdf-index.fullText';
  const body = text
    || (imageProvided
      ? pdfOpened
        ? 'فُتح ملف PDF الأصلي وأُرفقت صورة الصفحة للقراءة البصرية. لا تنقلي إلا ما يظهر فيها بوضوح.'
        : 'أُرفقت صورة صفحة للقراءة البصرية، لكن لم يتأكد فتح ملف PDF الأصلي. لا تنقلي إلا ما يظهر فيها بوضوح.'
      : 'لم يتوفر نص موثوق أو صورة قابلة للقراءة لهذه الصفحة.');
  const evidence = text
    ? textFromOriginal
      ? `نص مستخرج من ملف PDF الأصلي (${evidenceType}) واجتاز فحص السلامة`
      : textFromIndex
        ? `نص مشتق من pdf-index.fullText (${evidenceType})؛ ${pdfOpened ? 'فُتح ملف PDF لكن النص المعروض من الفهرس' : 'لم يُفتح ملف PDF الأصلي'}`
        : `نص من مصدر PDF غير محدد (${evidenceType})؛ لم يُثبت استخراجه من الملف الأصلي`
    : imageProvided
      ? `صورة ${pdfOpened ? 'من ملف PDF الأصلي' : 'متاحة للصفحة'} أُرسلت للقراءة البصرية${source.damaged ? '؛ طبقة النص المستخرجة متضررة' : ''}`
      : `دليل PDF غير كافٍ (${evidenceType})`;
  return `[${source.id}] ${source.title} | ${pageLabel} | ${source.pageTitle}\n[نوع الدليل: ${evidence} — الحالة: ${status}]\n${body}`;
}

function savePageCitation(sources, source) {
  const index = sources.findIndex((item) => exactPageMatch(item, source.bookId, source.printedPage, source.physicalPage));
  if (index >= 0) {
    const id = sources[index].id;
    sources[index] = { ...sources[index], ...source, id };
    return id;
  }
  const id = source.id || `P${sources.filter((item) => item.sourceType === 'curriculum').length + 1}`;
  sources.push({ ...source, id });
  return id;
}

function safeImageDataUrl(value) {
  const image = String(value || '');
  return /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(image) && image.length <= 1_500_000
    ? image
    : '';
}

function safePdfImage(value) {
  const image = safeImageDataUrl(value);
  return image ? { type: 'image_url', image_url: { url: image } } : null;
}

async function exactPdfFallback(bookId, printedPage, physicalPage, deadlineMs = PDF_PAGE_DEADLINE_MS) {
  const budget = Math.max(500, deadlineMs);
  let timer;
  try {
    const module = await import('./lib/pdf-fallback.mjs');
    if (typeof module.readPdfPage !== 'function') return null;
    // العمل مُسلسل داخل pdf-fallback، فالتنفيذ المعلّق لا يُنتظر: تجاوز المهلة
    // يمنع أن pushes استخراج صفحة واحدة زمن أول رمز في الإجابة إلى الخلف.
    return await Promise.race([
      module.readPdfPage({ bookId, printedPage, physicalPage, forceSource: true }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), budget); }),
    ]);
  } catch (error) {
    console.warn('exact PDF page fallback failed:', error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pdfFallbackProgress(source, step) {
  const pageLabel = `${source.title} — ${source.printedPage != null ? `الصفحة المطبوعة ${source.printedPage}` : `صفحة PDF ${source.physicalPage}`}`;
  if (source.evidenceType === 'pdf-image' && source.visionProvided) {
    step('pdf', 'فُتح PDF الأصلي وأُرسلت صورته للقراءة البصرية', pageLabel);
  } else if (source.textSource === 'pdf-index.fullText') {
    step('pdf', source.pdfOpened ? 'استُخدم نص مشتق من فهرس PDF' : 'استُخدم نص فهرس PDF دون فتح الأصل', `${pageLabel} — ${source.pdfOpened ? 'فُتح الأصل، لكن النص من الفهرس المشتق' : 'لم يُفتح ملف PDF الأصلي'}`);
  } else if (source.pdfOpened && source.textSource === 'pdf-source.pdfjs') {
    step('pdf', 'فُتح PDF الأصلي واستُخرج النص منه', pageLabel);
  } else {
    step('pdf', 'عُثر على نص PDF قابل للاستخدام', `${pageLabel} — لم يُثبت أن النص مستخرج من ملف PDF الأصلي`);
  }
}

function pdfFallbackEvidence(page, { bookId, printedPage, physicalPage, book, sources, step, id = '', sendImageToVision = true, emitProgress = true }) {
  if (!page || (page.bookId && page.bookId !== bookId)) return null;
  const status = clean(page.status || page.evidenceStatus, 60).toLowerCase();
  if (/not.?found|missing|failed|error|unavailable|unsupported/.test(status)) return null;
  const text = clean(page.text, 12_000);
  const reliableText = isReliablePdfPageText({ ...page, text, status });
  const pdfOpened = page.pdfOpened === true;
  const textSource = clean(page.textSource, 80) || (pdfOpened ? 'unknown-source' : 'unknown');
  const image = reliableText || !sendImageToVision || !pdfOpened ? null : safePdfImage(page.imageDataUrl);
  if (!reliableText && !image) return null;

  const imageEvidence = Boolean(image);
  const evidenceType = reliableText
    ? status === 'ocr-text' || page.evidenceType === 'ocr-text' ? 'ocr-text' : 'pdf-text'
    : 'pdf-image';
  const citation = {
    id,
    sourceType: pdfOpened ? 'pdf-fallback' : 'curriculum',
    bookId,
    title: book?.title || clean(page.title, 180) || bookId,
    subject: book?.subject || '',
    track: book?.track || book?.branch || '',
    physicalPage: page.physicalPage ?? physicalPage,
    printedPage: page.printedPage ?? printedPage,
    pageTitle: clean(page.title, 180),
    evidenceType,
    status: status || (reliableText ? 'clean-extracted-text' : 'no-text'),
    evidenceStatus: status || (reliableText ? 'clean-extracted-text' : 'no-text'),
    readable: true,
    searchable: reliableText,
    quotableReliable: reliableText,
    needsOcr: imageEvidence || Boolean(page.needsOcr),
    damaged: status === 'damaged-text',
    visionProvided: imageEvidence,
    pdfOpened,
    textSource,
    visualVerified: page.visualVerified === true,
  };
  citation.id = savePageCitation(sources, citation);
  const block = fallbackPageBlock({ ...page, text: reliableText ? text : '' }, citation);
  if (emitProgress) pdfFallbackProgress(citation, step);
  return { block, image, reliable: isReliableLocalSource(citation), citation, text: reliableText ? text : '' };
}

// صفحة موسومة بـ damaged-text نصها غير قابل للنقل، لكن صورتها المرسومة يقرأها
// النموذج فعلًا؛ فحذف الصفحة من السياق يهدر مصدرًا صحيحًا. تُفتح الصفحة وتُرسل
// كدليل بصري، فيعود المعرّف نفسه إلى السياق وإلى قائمة الإحالات، بدل أن يجيب
// النموذج من صفحة مجاورة ويقرّر أن الصفحة المطلوبة لا تحوي شيئًا.
function damagedNeedingVision(source) {
  const damaged = sourceEvidenceStatus(source) === 'damaged-text'
    || source?.evidenceType === 'damaged-text'
    || source?.damaged === true;
  if (!damaged) return false;
  return !(source?.evidenceType === 'pdf-image' && source?.visionProvided === true);
}

async function visionEvidenceForDamagedPages({
  sources,
  block,
  books = [],
  subject = '',
  focusBookIds = null,
  step,
  deadlineAt = 0,
  limit = MAX_DAMAGED_VISION_PAGES,
  budgetMs = VISION_PASS_BUDGET_MS,
  maxAttempts = VISION_PASS_MAX_ATTEMPTS,
}) {
  const images = [];
  let currentBlock = block;
  if (!sources?.length || limit <= 0) return { block: currentBlock, images };
  const inScope = { bookId: '', subject, books };
  const candidates = sources
    .filter((source) => damagedNeedingVision(source)
      && (pageNumber(source?.physicalPage) != null || pageNumber(source?.printedPage) != null)
      && (!focusBookIds?.size || focusBookIds.has(source.bookId))
      && pdfBookInScope(source?.bookId, inScope))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  if (!candidates.length) return { block: currentBlock, images };

  // الميزانية هنا على الصور لا على المحاولات: محاولة تُرجع نصًا سليمةً تُحسّن
  // المصدر ولا تُرسل صورة، فلا يجوز أن تستهلك حصة القراءة البصرية الصفحة التالية.
  // تتوقف المحاولات عند بلوغ عدد الصور المطلوب أو انتهاء مهلة الجولة، فتبقى
  // الحزمة محدودة زمنيًا مهما طال قائمة المرشحين.
  const stopAt = Math.min(deadlineAt || Infinity, Date.now() + Math.max(1_000, budgetMs));
  let attempts = 0;
  for (const candidate of candidates) {
    if (images.length >= limit || attempts >= Math.max(1, maxAttempts)) break;
    if (Date.now() > stopAt) {
      step('pdf', 'توقفت محاولات القراءة البصرية', 'بلغ فتح الصفحات ميزانيته الزمنية؛ لن أضع في الإجابة صفحة لم أفتحها');
      break;
    }
    attempts += 1;
    const candidateBookId = clean(candidate.bookId, 100);
    const printedPage = pageNumber(candidate.printedPage);
    const physicalPage = pageNumber(candidate.physicalPage);
    const book = books.find((entry) => entry.id === candidateBookId) || null;
    const page = await exactPdfFallback(candidateBookId, printedPage, physicalPage);
    const evidence = page && pdfFallbackEvidence(page, {
      bookId: candidateBookId,
      printedPage,
      physicalPage,
      book,
      sources,
      step,
      id: candidate.id,
      sendImageToVision: true,
    });
    if (!evidence) {
      const label = `${book?.title || candidate.title || candidateBookId} — ${printedPage != null ? `الصفحة المطبوعة ${printedPage}` : `صفحة PDF ${physicalPage}`}`;
      step('pdf', 'تعذّر فتح الصفحة المطابقة كدليل', `${label}؛ لن أجيب من صفحة أخرى مكانها`);
      continue;
    }
    if (!evidence.image) continue;
    images.push(evidence.image);
    currentBlock = replaceLocalBlock(currentBlock, evidence.citation.id, evidence.block);
  }
  return { block: currentBlock, images };
}

function pdfBookInScope(candidateBookId, { bookId = '', subject = '', books = [] } = {}) {
  if (!candidateBookId || (bookId && candidateBookId !== bookId)) return false;
  const book = books.find((entry) => entry.id === candidateBookId);
  if (!book) return false;
  const wantedSubject = normalizedQuestion(subject);
  return !wantedSubject || normalizedQuestion(`${book.subject || ''} ${book.title || ''}`).includes(wantedSubject);
}

function unreliablePdfPageHints(sources, options = {}) {
  const seen = new Set();
  return sources.filter((source) => {
    if (isReliableLocalSource(source) || !pdfBookInScope(source?.bookId, options)) return false;
    const physical = pageNumber(source?.physicalPage);
    const printed = pageNumber(source?.printedPage);
    if (physical == null && printed == null) return false;
    const key = `${source.bookId}:${physical ?? `printed-${printed}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).slice(0, 2);
}

function commitPageSources(target, selected) {
  target.splice(0, target.length, ...selected);
}

async function searchPdfFallback(query, {
  track,
  subject,
  bookId,
  limit = 5,
  books = [],
  sources = [],
  pageHints = [],
  step,
  sendImageToVision = true,
  deadlineAt = 0,
  maxAttempts = MAX_PDF_ATTEMPTS,
}) {
  let candidates = [];
  if (typeof corpusIndex.searchPdfPages === 'function') {
    try {
      const results = await corpusIndex.searchPdfPages(query, { track, subject, bookId, limit });
      candidates = Array.isArray(results) ? results
        : Array.isArray(results?.results) ? results.results
          : results && typeof results === 'object' ? [results] : [];
    } catch (error) {
      console.warn('PDF page search failed:', error?.message || error);
      step('pdf', 'تعذر البحث في مرشحات PDF', 'سأفحص الصفحات غير الموثوقة التي طابقها البحث المحلي فقط');
    }
  } else {
    step('pdf', 'تعذر تشغيل بحث صفحات PDF', 'سأفحص الصفحات غير الموثوقة التي طابقها البحث المحلي فقط');
  }

  const inScope = { bookId, subject, books };
  const hints = (Array.isArray(pageHints) && pageHints.length ? pageHints : unreliablePdfPageHints(sources, inScope))
    .filter((hint) => !isReliableLocalSource(hint) && pdfBookInScope(hint?.bookId, inScope)
      && (pageNumber(hint?.physicalPage) != null || pageNumber(hint?.printedPage) != null))
    .slice(0, 2);
  const attempted = new Set();
  const attemptedKey = (candidateBookId, physical, printed) => `${candidateBookId}:${physical ?? `printed-${printed}`}`;
  let bestHint = null;
  // كل محاولة تفتح ملف PDF وترسم صفحة، والعمل مُسلسل؛ تجاوز العدد والوقت يطيل
  // زمن أول رمز دون أن يزيد فرص العثور على دليل.
  let allowance = Math.max(1, maxAttempts);
  const outOfBudget = () => Boolean(deadlineAt) && Date.now() > deadlineAt;

  const tryPage = async ({ candidateBookId, physicalPage, printedPage, title, id = '', label }) => {
    const book = books.find((entry) => entry.id === candidateBookId) || null;
    const pageLabel = `${book?.title || title || candidateBookId} — ${printedPage != null ? `الصفحة المطبوعة ${printedPage}` : `صفحة PDF ${physicalPage}`}`;
    step('pdf', label, pageLabel);
    const page = await exactPdfFallback(candidateBookId, printedPage, physicalPage);
    const trialSources = sources.map((source) => ({ ...source }));
    const evidence = pdfFallbackEvidence(page, {
      bookId: candidateBookId,
      printedPage,
      physicalPage,
      book,
      sources: trialSources,
      step,
      id,
      sendImageToVision,
      emitProgress: false,
    });
    if (evidence) {
      return { evidence, trialSources, pageLabel };
    }

    const pdfOpened = page?.pdfOpened === true;
    const textSource = clean(page?.textSource, 80);
    const failureDetail = pdfOpened
      ? `${pageLabel} — فُتح الملف الأصلي لكن لم يتوفر نص سليم أو صورة قابلة للقراءة`
      : textSource === 'pdf-index.fullText'
        ? `${pageLabel} — نص الفهرس المشتق غير كافٍ، ولم يُفتح الملف الأصلي`
        : `${pageLabel} — لم يتأكد فتح الملف الأصلي ولم يتوفر دليل صالح`;
    step('pdf', pdfOpened ? 'فُتح المرشح لكن تعذرت قراءته' : 'تعذر التحقق من المرشح', failureDetail);
    return null;
  };

  for (const [index, hint] of hints.entries()) {
    if (allowance <= 0 || outOfBudget()) break;
    const hintBookId = clean(hint.bookId, 100);
    const physicalPage = pageNumber(hint.physicalPage);
    const printedPage = pageNumber(hint.printedPage);
    const key = attemptedKey(hintBookId, physicalPage, printedPage);
    if (attempted.has(key)) continue;
    attempted.add(key);
    allowance -= 1;
    const result = await tryPage({
      candidateBookId: hintBookId,
      physicalPage,
      printedPage,
      title: hint.title,
      id: hint.id,
      label: `أفحص الصفحة المطابقة من البحث المحلي ${index + 1}`,
    });
    if (result && !bestHint) {
      bestHint = result;
      const citation = result.evidence.citation;
      const provenanceDetail = citation.textSource === 'pdf-index.fullText'
        ? `${citation.title} — ${citation.pdfOpened ? 'فُتح الأصل لكن النص مشتق من الفهرس؛ أتابع مقارنة المرشحات' : 'النص مشتق من الفهرس ولم يُفتح الأصل؛ أتابع المقارنة'}`
        : `${citation.title} — ${citation.pdfOpened ? 'فُتح المصدر الأصلي؛ أتابع مقارنة المرشحات' : 'لم يُثبت فتح المصدر الأصلي؛ أتابع مقارنة المرشحات'}`;
      const provenanceLabel = citation.evidenceType === 'pdf-image' && citation.pdfOpened
        ? 'فُتحت صفحة مرشحة في PDF الأصلي'
        : citation.textSource === 'pdf-index.fullText'
          ? 'عُثر على نص مشتق لصفحة مرشحة'
          : citation.pdfOpened
            ? 'استُخرج نص من صفحة PDF مرشحة'
            : 'عُثر على نص مرشح دون فتح الأصل';
      step('pdf', provenanceLabel, provenanceDetail);
    }
  }

  const ranked = [];
  for (const candidate of candidates) {
    if (allowance <= 0 || outOfBudget()) break;
    const candidateBookId = clean(candidate?.bookId ?? candidate?.book_id ?? bookId, 100);
    const physicalPage = pageNumber(candidate?.physicalPage ?? candidate?.physical_page ?? candidate?.pageNumber ?? candidate?.page);
    const printedPage = pageNumber(candidate?.printedPage ?? candidate?.printed_page);
    if (!pdfBookInScope(candidateBookId, inScope) || (physicalPage == null && printedPage == null)) continue;
    const key = attemptedKey(candidateBookId, physicalPage, printedPage);
    if (attempted.has(key)) continue;
    attempted.add(key);
    allowance -= 1;
    ranked.push({ item: candidate, bookId: candidateBookId, physicalPage, printedPage });
    if (ranked.length >= 3) break;
  }

  let bestRanked = null;
  for (const [index, candidate] of ranked.entries()) {
    const result = await tryPage({
      candidateBookId: candidate.bookId,
      physicalPage: candidate.physicalPage,
      printedPage: candidate.printedPage,
      title: candidate.item.title,
      label: `أفحص مرشح فهرس PDF ${index + 1} من ${ranked.length}`,
    });
    if (result) {
      bestRanked = result;
      break;
    }
  }

  const selected = bestRanked || bestHint;
  if (selected) {
    commitPageSources(sources, selected.trialSources);
    pdfFallbackProgress(selected.evidence.citation, step);
    return selected.evidence;
  }
  step('pdf', 'لم أجد صفحة PDF قابلة للاستخدام', `فُحصت ${attempted.size} صفحات دقيقة ضمن نطاق الكتاب والمسار ولم يظهر دليل صالح`);
  return { block: '', image: null, reliable: false };
}

async function retrieveExactPage({ bookId, printedPage, physicalPage, books, sources, step, deadlineAt = 0 }) {
  if (!bookId || (printedPage == null && physicalPage == null)) return { block: '', image: null, reliable: false };
  const book = books.find((item) => item.id === bookId) || null;
  const existing = sources.find((item) => exactPageMatch(item, bookId, printedPage, physicalPage));
  if (isReliableLocalSource(existing)) return { block: '', image: null, reliable: true };

  let resolvedPhysical = physicalPage;
  if (resolvedPhysical == null && printedPage != null) {
    try { resolvedPhysical = await locate(bookId, printedPage); } catch { resolvedPhysical = null; }
  }
  let indexedPage = null;
  if (resolvedPhysical != null) {
    try { indexedPage = await fullPage(bookId, resolvedPhysical); } catch { indexedPage = null; }
  }

  if (indexedPage) {
    const citation = pageCitation(indexedPage, book, existing?.id || '', { bookId, printedPage, physicalPage: resolvedPhysical });
    citation.readable = isReliableLocalSource(citation);
    const id = savePageCitation(sources, citation);
    citation.id = id;
    const block = existing && !citation.readable ? '' : indexedPageBlock(indexedPage, citation);
    if (citation.readable) return { block, image: null, reliable: true };
  }

  step('pdf', 'أحاول فتح الصفحة الأصلية', `${book?.title || bookId} — ${printedPage != null ? `الصفحة المطبوعة ${printedPage}` : `صفحة PDF ${resolvedPhysical}`}`);
  if (deadlineAt && Date.now() > deadlineAt) {
    step('pdf', 'تجاوز فتح الصفحة ميزانيته الزمنية', 'لن أضع في الإجابة صفحة لم أتحقق منها؛ سأقول للطلبة ما تعذّر التحقق منه');
    return { block: '', image: null, reliable: false };
  }
  const page = await exactPdfFallback(bookId, printedPage, resolvedPhysical);
  if (page) {
    const evidence = pdfFallbackEvidence(page, {
      bookId,
      printedPage,
      physicalPage: resolvedPhysical,
      book,
      sources,
      step,
      id: existing?.id || '',
    });
    if (evidence) return evidence;
  }

  if (indexedPage && !existing) {
    const citation = pageCitation(indexedPage, book, '', { bookId, printedPage, physicalPage: resolvedPhysical });
    const id = savePageCitation(sources, citation);
    citation.id = id;
    return { block: indexedPageBlock(indexedPage, citation), image: null, reliable: false };
  }
  step('pdf', 'تعذر فتح دليل موثوق للصفحة', 'لم يتوفر نص سليم أو صورة أصلية قابلة للقراءة');
  return { block: '', image: null, reliable: false };
}

function webEvidenceBlock(sources) {
  return sources.map((source) => {
    const label = source.official && source.curriculumSpecific
      ? 'مصدر رسمي عراقي مرتبط بالمقرر — خارجي وليس نسخة الكتاب'
      : source.official
      ? 'مصدر رسمي عراقي خارجي — ليس من كتاب المنهج'
      : source.curriculumSpecific
        ? 'مصدر مرتبط بالمنهج العراقي — خارجي وليس نسخة الكتاب'
        : 'مصدر ويب خارجي — ليس من كتاب المنهج';
    return `[${source.id}] ${label}\nالعنوان: ${clean(source.title, 240)}\nالرابط: ${clean(source.url, 1_500)}\n${clean(source.snippet, 900)}`;
  }).join('\n\n');
}

function localTrace(step) {
  return (info) => {
    if (info.phase === 'search') {
      const termsText = (info.terms || []).slice(0, 6).join('، ');
      step('search', 'بحثت في الكتب', info.hitCount
        ? `فحصت ${info.candidateCount} صفحة مرشحة بكلمات: ${termsText} — وجدت ${info.hitCount} مطابقة`
        : `لم أجد مطابقات مباشرة بكلمات: ${termsText}`);
    } else if (info.phase === 'page') {
      const shortTitle = clean(info.pageTitle, 60);
      const pageLabel = info.printedPage != null ? `الصفحة المطبوعة ${info.printedPage}` : `صفحة PDF ${info.physicalPage}`;
      step('page', 'فتحت صفحة من كتابك', `${info.bookTitle} — ${pageLabel} — ${shortTitle}${info.needsVision ? ' · تحتاج قراءة بصرية' : ''}`);
    }
  };
}

async function retrieveLocalEvidence(query, { bookId = '', subject = '', track, books, step, allowPdfFallback = true, deadlineAt = 0 }) {
  let retrieved = { block: '', sources: [] };
  let error = null;
  try {
    retrieved = await retrieveContext(query, {
      bookId,
      subject,
      track,
      limit: 10,
      onTrace: localTrace(step),
    });
  } catch (caught) {
    error = caught;
    console.error('curriculum retrieval failed:', caught?.message || caught);
    step('search', 'تعذر البحث في فهرس الكتب', 'لم أتمكن من قراءة نتائج البحث المحلي؛ لن أتعامل مع غيابها كدليل');
  }

  let image = null;
  if (allowPdfFallback && !retrieved.sources.some(isReliableLocalSource)) {
    const pageHints = unreliablePdfPageHints(retrieved.sources, { bookId, subject, books });
    const fallback = await searchPdfFallback(query, { track, subject, bookId, limit: 5, books, sources: retrieved.sources, pageHints, step, deadlineAt });
    if (fallback.block) {
      retrieved.block = withoutSourceBlock(retrieved.block, fallback.citation?.id);
      retrieved.block = [retrieved.block, fallback.block].filter(Boolean).join('\n\n---\n\n');
    }
    image = fallback.image;
  }
  return { retrieved, image, error };
}

// جولة تخطيط إضافية لا تُبرَّر عندما يكون البحث المحلي نفسه كافيًا: النموذج يقرأ
// الطلب الأصلي ويفهم نيته، والجولة تضيف زمنًا بلا معلومات جديدة.
function strongLocalEvidence(sources) {
  if (sources?.some(isReliableLocalSource)) return true;
  return Boolean(dominantLocalBook(sources));
}

function fastCurriculumPlan(question, subject) {
  return {
    intent: 'curriculum',
    useLocal: true,
    useCatalog: false,
    catalogScope: 'track',
    useOutline: false,
    localQuery: clean(question, 400),
    bookQuery: '',
    subject,
    exactPage: { printedPage: null, physicalPage: null },
    webFallback: { enabled: false, query: '' },
  };
}
function scopedCatalogBlock(catalog, scope, track) {
  const raw = catalogContext(catalog);
  if (!raw) return '';
  const global = scope === 'global';
  const firstLine = global
    ? 'الكتالوج الكامل لجميع الكتب المتاحة في التطبيق عبر المسارات:'
    : `كتالوج كتب مسار «${track}» فقط — لا يمثل جميع كتب التطبيق:`;
  const body = raw.replace(/^الكتالوج الكامل للمكتبة:/m, firstLine);
  const scopeLabel = global
    ? 'النطاق: كل المسارات والكتب المتاحة في التطبيق.'
    : `النطاق: مسار «${track}» فقط.`;
  return `[C1] ${scopeLabel}\n${body}`;
}

function catalogCitation(catalog, scope, track) {
  return {
    id: 'C1',
    sourceType: 'catalog',
    title: scope === 'global' ? 'بيانات فهرس جميع كتب التطبيق' : `بيانات فهرس مسار ${track}`,
    subject: 'كتالوج الكتب',
    track: scope === 'global' ? 'جميع المسارات' : track,
    evidenceType: 'summary',
    evidenceStatus: 'catalog-metadata',
    status: 'catalog-metadata',
    searchable: false,
    quotableReliable: true,
    readable: true,
    bookCount: Number(catalog?.books?.length) || 0,
  };
}

function outlineCitation(outline, book) {
  return {
    id: 'O1',
    sourceType: 'curriculum',
    bookId: outline.bookId,
    title: book?.title || outline.bookId,
    subject: book?.subject || '',
    track: book?.track || book?.branch || '',
    pageTitle: 'مخطط وصفي للكتاب',
    evidenceType: 'outline-description',
    quotationSource: 'outline-description',
    evidenceStatus: 'no-text',
    status: 'no-text',
    searchable: false,
    needsOcr: false,
    quotableReliable: false,
  };
}

function citationSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const id = String(source?.id || '');
    if (!/^[A-Z]\d{1,5}$/.test(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// كتل السياق تُفصل بـ `---`، وكل كتلة تبدأ بمعرّف مصدرها.Primitive واحدة
// للقراءة والإزالة والاستبدال تُبقي كل الفلاتر متسقة فيما تحذفه.
function blockIdOf(part) {
  return String(part || '').match(/^\[([A-Z]\d{1,5})\]/)?.[1] || '';
}

function splitLocalBlocks(block) {
  return String(block || '').split('\n\n---\n\n');
}

function filterLocalBlock(block, dropIds) {
  const drop = dropIds instanceof Set ? dropIds : new Set(dropIds || []);
  if (!drop.size) return String(block || '');
  return splitLocalBlocks(block)
    .filter((part) => {
      const id = blockIdOf(part);
      return !id || !drop.has(id);
    })
    .join('\n\n---\n\n');
}

function replaceLocalBlock(block, sourceId, replacement) {
  if (!sourceId || !replacement) return block;
  const parts = splitLocalBlocks(block);
  const index = parts.findIndex((part) => blockIdOf(part) === sourceId);
  if (index < 0) return [String(block || '').trim(), replacement].filter(Boolean).join('\n\n---\n\n');
  parts[index] = replacement;
  return parts.join('\n\n---\n\n');
}

function sourceRankFor(source, focusBookIds) {
  if (!focusBookIds?.size) return 0;
  if (!source?.bookId) return 0;
  return focusBookIds.has(source.bookId) ? 0 : 1;
}

// كتاب يهيمن على نتائج البحث: أكثر من نصف أعلى الصفحات من كتاب واحد. التمييز
// القاطع لا يحتمل التخمين، فيُبنى على عدد لا على رتبة واحدة. يُستعمل لتخطّي
// جولة التخطيط فقط، لا لحذف مصادر.
function dominantLocalBook(sources) {
  const counts = new Map();
  for (const source of (Array.isArray(sources) ? sources : []).slice(0, 8)) {
    if (!source?.bookId) continue;
    const current = counts.get(source.bookId) || { bookId: source.bookId, count: 0, score: 0 };
    current.count += 1;
    current.score += Number(source.score) || 0;
    counts.set(source.bookId, current);
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count || (entry.count === best.count && entry.score > best.score)) best = entry;
  if (!best || best.count < 3) return '';
  let total = 0;
  for (const entry of counts.values()) total += entry.count;
  return best.count / total >= 0.5 ? best.bookId : '';
}

// كتب يسمّيها الطالبة في سؤاله نصًّا. الإشارة أدقّ من عدّ النتائج، وهي أساس
// قبول تقليم المصادر من كتب أخرى: لا يُحذف دليل كتابٍ لم تطلبه الطالبة.
function booksNamedInQuestion(question, books = []) {
  const text = normalizedQuestion(question);
  if (text.length < 3) return new Set();
  const named = new Set();
  for (const book of books) {
    const names = [book?.title, book?.subject]
      .map((value) => normalizedQuestion(value || ''))
      .filter((value) => value.length >= 4);
    if (names.some((name) => text.includes(name))) named.add(book.id);
  }
  return named;
}

// مجموعة كتب تركيز الإجابة: ما طلبته الطالبة، أو حدّده العميل، أو حُلّ من
// سؤالها. أقوى صفحة عائدة تُضاف فقط حين لا شيء محدَّد: فلا يُحذف الدليل الأقوى
// أبدًا، ولا يُخلط كتابٌ لم تطلبه الطالبة بسبب رتبة بحث واحدة.
function focusBookIds({ question, books = [], sources = [], selectedBookId = '', resolvedBookId = '' }) {
  const focus = booksNamedInQuestion(question, books);
  if (selectedBookId) focus.add(selectedBookId);
  if (resolvedBookId) focus.add(resolvedBookId);
  if (focus.size) return focus;
  let best = null;
  for (const source of sources || []) {
    if (!source?.bookId) continue;
    if (!best || (Number(source.score) || 0) > (Number(best.score) || 0)) best = source;
  }
  if (best?.bookId) focus.add(best.bookId);
  return focus;
}

// عزل المسار حاجب أخير: أي مصدر من كتاب خارج كتب المسار يُسقط من السياق ومن
// قائمة الإحالات مهما بدا مناسبًا، فلا يظهر كتاب أدبي في سؤال ديني.
function offTrackSources(sources, allowedBookIds) {
  if (!allowedBookIds || !allowedBookIds.size) return [];
  return (sources || []).filter((source) => source?.bookId && !allowedBookIds.has(source.bookId));
}

// مصادر الكتب الأخرى تبقى بحدّ صغير ومقصود، ثم تُقتطع. عرضها كلها كأنها مصادر
// سؤال الرياضيات يوهم الطالبة برد من كتاب لا صلة له بسؤالها.
function capCrossBookSources(sources, focusBookIds, allowed = MAX_CROSS_BOOK_SOURCES) {
  if (!focusBookIds?.size) return { kept: [...(sources || [])], dropped: [] };
  const kept = [];
  const dropped = [];
  let others = 0;
  for (const source of sources || []) {
    if (!source?.bookId || focusBookIds.has(source.bookId)) { kept.push(source); continue; }
    if (others < allowed) { others += 1; kept.push(source); continue; }
    dropped.push(source);
  }
  return { kept, dropped };
}

// ترتيب الكتل نفسها ليطابق ترتيب المصادر: كتب تركيز السؤال أولًا. لا يُعاد
// الترتيب إلا إذا عُرفت كل كتلة بمعرّف مصدرها، وإلا تُترك كما وصلت.
function orderLocalBlock(block, sources, focusBookIds) {
  if (!focusBookIds?.size) return block;
  const byId = new Map();
  const loose = [];
  for (const part of splitLocalBlocks(block)) {
    const id = blockIdOf(part);
    if (!id) { loose.push(part); continue; }
    byId.set(id, [...(byId.get(id) || []), part]);
  }
  if (!byId.size) return block;
  const ordered = [...(sources || [])]
    .sort((a, b) => sourceRankFor(a, focusBookIds) - sourceRankFor(b, focusBookIds))
    .flatMap((source) => byId.get(source.id) || []);
  if (!ordered.length) return block;
  return [...ordered, ...loose].filter((part) => part && part.trim()).join('\n\n---\n\n');
}

function answerCitationSource(source) {
  const damaged = sourceEvidenceStatus(source) === 'damaged-text' || source?.evidenceType === 'damaged-text';
  if (!damaged) return true;
  return source?.evidenceType === 'outline-description'
    || (source?.sourceType === 'pdf-fallback' && source?.evidenceType === 'pdf-image' && source?.visionProvided === true);
}

function withoutSourceBlock(block, sourceId) {
  if (!sourceId) return block;
  return filterLocalBlock(block, new Set([sourceId]));
}

// ذيل قد يكون بداية وسم `<think>` مقطوعة بين دفعتين. الشرط يبدأ بـ `<` فلا
// يُحتجز من النص العربي العادي شيء.
function partialThinkTagLength(text) {
  const max = Math.min(7, text.length);
  for (let size = max; size > 0; size -= 1) {
    if (/^<\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/i.test(text.slice(text.length - size))) return size;
  }
  return 0;
}

function citationStreamFilter(allowedIds) {
  let pending = '';
  let tagCarry = '';
  const allowed = new Set(allowedIds);
  // وسم إغلاق تفكير النموذج يصل أحيانًا داخل `content` فيظهر للطالبة حرفيًا.
  // يُحذف الوسم وحده؛ تفكير النموذج نفسه يبقى في reasoning_content ولا يصل هنا.
  const stripThinkTags = (chunk, final) => {
    let text = tagCarry + String(chunk || '');
    tagCarry = '';
    if (!final) {
      const cut = partialThinkTagLength(text);
      if (cut) { tagCarry = text.slice(text.length - cut); text = text.slice(0, text.length - cut); }
    }
    return text.replace(/<\/?think>/gi, '');
  };
  const consume = (chunk, final = false) => {
    const text = pending + stripThinkTags(chunk, final);
    pending = '';
    let cursor = 0;
    let output = '';
    while (cursor < text.length) {
      const open = text.indexOf('[', cursor);
      if (open < 0) { output += text.slice(cursor); break; }
      output += text.slice(cursor, open);
      const close = text.indexOf(']', open + 1);
      if (close < 0) {
        const tail = text.slice(open);
        if (!final && tail.length <= 20 && /^\[(?:[A-Za-z]+\d{0,12})?$/.test(tail)) pending = tail;
        else if (final && /^\[[A-Za-z]+\d{0,12}$/.test(tail)) { /* drop an incomplete source ID */ }
        else output += tail;
        break;
      }
      const id = text.slice(open + 1, close);
      if (/^[A-Za-z]+\d+$/.test(id)) {
        if (allowed.has(id)) output += text.slice(open, close + 1);
      } else {
        output += text.slice(open, close + 1);
      }
      cursor = close + 1;
    }
    if (final && pending) {
      if (!/^\[[A-Za-z]+\d{0,12}$/.test(pending)) output += pending;
      pending = '';
    }
    return output;
  };
  return { push: (chunk) => consume(chunk), finish: () => consume('', true) };
}

function errorCode(error) {
  if (error?.code === 'UPSTREAM_INCOMPLETE_STREAM' || /UPSTREAM_INCOMPLETE_STREAM/i.test(String(error?.message))) return 'UPSTREAM_INCOMPLETE_STREAM';
  if (error?.code === 'UPSTREAM_TIMEOUT' || /UPSTREAM_TIMEOUT|timeout/i.test(String(error?.message))) return 'UPSTREAM_TIMEOUT';
  if (error?.status === 401 || error?.status === 403) return 'UPSTREAM_AUTH';
  if (error?.status === 404) return 'UPSTREAM_MODEL';
  if (error?.status === 400) return 'UPSTREAM_BAD_REQUEST';
  if (error?.status === 429) return 'UPSTREAM_BUSY';
  if (error?.status) return `UPSTREAM_HTTP_${error.status}`;
  return 'UPSTREAM_FAILED';
}

function isProviderFailure(error) {
  return Boolean(error?.status || String(error?.code || '').startsWith('UPSTREAM_')
    || /UPSTREAM_|timeout|network|fetch failed|econn|enotfound|socket|reset/i.test(String(error?.message)));
}

function publicBook(book, ready) {
  const { branch: _branch, ...safe } = book;
  return { ...safe, hasOutline: ready.has(book.id) };
}

async function pageForApi(bookId, printedPage, requestedPhysicalPage) {
  let physicalPage = requestedPhysicalPage;
  if (physicalPage == null && printedPage != null) {
    try { physicalPage = await locate(bookId, printedPage); } catch { physicalPage = null; }
  }

  let indexed = null;
  if (physicalPage != null) {
    try { indexed = await fullPage(bookId, physicalPage); } catch { indexed = null; }
  }

  let pdf = null;
  if (!isReliablePdfPageText(indexed)) {
    pdf = await exactPdfFallback(bookId, printedPage, physicalPage);
  }
  const imageDataUrl = safeImageDataUrl(pdf?.imageDataUrl);
  const reliablePdfText = isReliablePdfPageText(pdf);
  const pdfStatus = String(pdf?.evidenceStatus || pdf?.status || '').toLowerCase();
  const usableImage = Boolean(imageDataUrl) && !/not.?found|missing|failed|error|unavailable|unsupported/.test(pdfStatus);
  if (!indexed && !reliablePdfText && !usableImage && pdfStatus !== 'damaged-text') return null;

  const page = indexed ? { ...indexed } : {
    bookId,
    physicalPage: pdf?.physicalPage ?? physicalPage,
    printedPage: pdf?.printedPage ?? printedPage,
    title: clean(pdf?.title, 180) || `صفحة PDF ${physicalPage ?? 'غير محددة'}`,
    text: '',
    summary: '',
  };
  page.bookId = bookId;
  page.physicalPage = pdf?.physicalPage ?? page.physicalPage ?? physicalPage;
  page.printedPage = pdf?.printedPage ?? page.printedPage ?? printedPage;

  if (reliablePdfText) {
    const text = clean(pdf.text, 12_000);
    page.text = text;
    page.quotableText = text;
    page.quotableSource = 'pdf-text';
    page.quotableReliable = true;
    page.searchable = true;
    page.evidenceType = pdf.evidenceType === 'ocr-text' || pdf.status === 'ocr-text' ? 'ocr-text' : 'pdf-text';
    page.evidenceStatus = pdf.status;
    page.status = pdf.status;
    page.damaged = false;
    page.needsVision = pdf.status === 'ocr-text';
  } else if (usableImage) {
    page.imageDataUrl = imageDataUrl;
    page.text = '';
    page.quotableText = '';
    page.evidenceType = 'pdf-image';
    page.evidenceStatus = pdfStatus || 'no-text';
    page.status = pdfStatus || 'no-text';
    page.quotableReliable = false;
    page.quotableSource = 'pdf-image';
    page.searchable = false;
    page.needsVision = true;
    page.damaged = pdfStatus === 'damaged-text';
    page.visionReasons = [...new Set([...(Array.isArray(page.visionReasons) ? page.visionReasons : []), 'تتوفر صورة صفحة PDF أصلية للقراءة البصرية'])];
    if (page.damaged && !page.damageReasons?.length) page.damageReasons = ['طبقة النص المستخرجة من PDF موسومة بالتلف'];
  } else if (pdfStatus === 'damaged-text') {
    page.evidenceType = 'damaged-text';
    page.evidenceStatus = 'damaged-text';
    page.status = 'damaged-text';
    page.quotableReliable = false;
    page.damaged = true;
    page.needsVision = true;
  }
  if (pdf) {
    page.pdfOpened = pdf.pdfOpened === true;
    page.textSource = clean(pdf.textSource, 80) || (page.pdfOpened ? 'unknown-source' : 'unknown');
    page.visualVerified = pdf.visualVerified === true;
  }
  return page;
}

async function handleChat(req, res) {
  if (!withinRateLimit(req)) return sendJson(res, 429, { error: 'RATE_LIMITED' });

  let body;
  try { body = await readJsonBody(req); } catch (error) {
    return sendJson(res, error.message === 'TOO_LARGE' ? 413 : 400, { error: error.message });
  }
  const history = historyFor(body.messages);
  if (!history.some((message) => message.role === 'user')) return sendJson(res, 400, { error: 'EMPTY_MESSAGE' });
  const question = [...history].reverse().find((message) => message.role === 'user')?.content || '';
  if (!question && !imageParts((Array.isArray(body.messages) ? body.messages : []).at(-1)?.content).length) {
    return sendJson(res, 400, { error: 'EMPTY_MESSAGE' });
  }

  const subject = clean(body.subject, 120);
  const requestedBookId = clean(body.bookId, 100);
  // المسار يُطلب من العميل لا يُفرض من الخادم، وإلا صار إعداد المسار في الواجهة بلا أثر.
  const requestedTrack = clean(body.curriculumTrack, 40);
  const track = ['ديني', 'أدبي', 'عام', 'ديني إضافي'].includes(requestedTrack) ? requestedTrack : 'ديني';
  const config = resolveProvider({ headers: req.headers });
  if (config.error) return sendJson(res, 500, { error: config.error });

  // بدء SSE مبكرا حتى تصل خطوات المعلم الحية أثناء الاسترجاع نفسه.
  const abort = new AbortController();
  const onClose = () => abort.abort(new Error('CLIENT_ABORTED'));
  req.once('aborted', onClose);
  res.once('close', onClose);
  sseHeaders(res);
  const stopHeartbeat = heartbeat(res);
  const started = Date.now();
  const step = (phase, label, detail) => sseSend(res, 'step', { phase, label, detail: clean(detail, 160), at: Date.now() - started });
  const session = safeSession(req.headers['x-session']);
  let firstTokenAt = 0;
  let output = '';
  try {
    if (!config.key) {
      sseSend(res, 'citations', { items: [] });
      sseSend(res, 'error', { error: 'AI_NOT_CONFIGURED' });
      return;
    }

    let books = [];
    let catalog = null;
    let outline = null;
    let resolvedBook = null;
    try {
      books = await listBooks({ track });
    } catch (error) {
      console.error('book list load failed:', error?.message || error);
      step('search', 'تعذر تحميل قائمة الكتب', 'سأمتنع عن نسبة الإجابة إلى كتاب غير متحقق');
    }
    // لقطة كتب المسار تُلتقط مرة واحدة ولا تُستبدل بالكتالوج الأوسع: هي الحاجب
    // الأخير الذي يمنع كتاب أدبي من الظهور في سؤال ديني.
    const trackBookIds = new Set(books.map((book) => book.id));

    let selectedBookId = books.some((book) => book.id === requestedBookId) ? requestedBookId : '';
    const rawLast = (Array.isArray(body.messages) ? body.messages : []).filter((message) => message?.role === 'user').at(-1);
    const hasImages = imageParts(rawLast?.content).length > 0;
    let retrieved = { block: '', sources: [] };
    let retrievedImage = null;
    let prefetch = { attempted: false, query: '', bookId: '', subject: '' };
    let plan = null;
    let plannerError = null;
    // ميزانية زمنية واحدة لكل عمل الاسترجاع في هذا الطلب؛ تقيّد فتح صفحات PDF
    // حتى لا يطال زمن أول رمز في الإجابة.
    const retrievalDeadlineAt = started + RETRIEVAL_DEADLINE_MS;

    step('intent', 'أفهم طلبك', 'أبدأ بالمصادر المحلية؛ أستدعي مخطط النية عند الحاجة');
    if (!needsPlannerBeforeLocal(question, hasImages)) {
      const query = clean(question, 400);
      const local = await retrieveLocalEvidence(query, {
        bookId: selectedBookId,
        subject,
        track,
        books,
        step,
        allowPdfFallback: pageReference(question) == null,
        deadlineAt: retrievalDeadlineAt,
      });
      retrieved = local.retrieved;
      retrievedImage = local.image;
      prefetch = { attempted: true, query, bookId: selectedBookId, subject };
      if (strongLocalEvidence(retrieved.sources)) {
        // النموذج يقرأ الطلب الأصلي ويقرّر كيف يجيب؛ فمع وجود دليل محلي قوي
        // (أو كتاب واحد يهيمن على النتائج) جولة تخطيط إضافية لا تضيف معلومة
        // وتضيف زمن انتظار، فتُؤجَّل.
        plan = fastCurriculumPlan(question, subject);
        step('intent', 'وجدت دليلاً محلياً مناسباً', 'سيفهم النموذج طلبك ويجيب من المصدر المطابق دون جولة تخطيط إضافية');
      }
    }

    if (!plan) {
      try {
        plan = await planIntent({ config, body, question, subject, bookId: requestedBookId, track, session, signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) throw error;
        if (error?.code === 'PLANNER_DEADLINE') {
          // تجاوز مهلة المخطط قرار محسوب لا عطل مزوّد: نتابع بالبحث المحلي
          // ولا نُنهي الإجابة كلها ولا نُبلغ الطالب بفشل في النموذج.
          console.warn('intent planning exceeded its deadline; using local-query fallback');
          step('intent', 'تجاوز تخطيط النية زمنه المسموح', 'سأعتمد على البحث المحلي مباشرة بدل انتظار جولة تخطيط إضافية');
          plan = fallbackPlan(question);
        } else {
          plannerError = error;
          console.warn('intent planning failed; using local-query fallback:', error?.message || error);
          step('intent', 'تعذر تحديد خطة الأدوات بدقة', 'سأعتمد على البحث المتاح ولن أنسب معلومة بلا دليل');
          plan = fallbackPlan(question);
        }
      }
    }

    const resolvedSubject = subject || plan.subject;
    if (plan.useCatalog) {
      try {
        catalog = await getCatalog({ track: plan.catalogScope === 'global' ? '' : track });
        if (Array.isArray(catalog?.books)) {
          books = catalog.books;
          if (!catalog.books.length) {
            step('catalog', 'لم أجد كتباً في هذا النطاق', 'لن أصف قائمة فارغة بأنها الكتالوج الكامل');
            catalog = null;
          }
        }
      } catch (error) {
        console.error('catalog load failed:', error?.message || error);
        step('catalog', 'تعذر تحميل بيانات الكتالوج', 'لن أقدّم قائمة كتب غير مكتملة على أنها كاملة');
      }
    }

    selectedBookId = books.some((book) => book.id === requestedBookId) ? requestedBookId : '';
    if (selectedBookId) resolvedBook = books.find((book) => book.id === selectedBookId) || null;
    const printedPage = plan.exactPage.printedPage ?? pageReference(question);
    const physicalPage = plan.exactPage.physicalPage;
    const shouldResolveBook = Boolean(plan.bookQuery || plan.useOutline || printedPage != null || physicalPage != null);
    let bookResolutionFailed = false;
    if (!resolvedBook && shouldResolveBook) {
      try {
        resolvedBook = await resolveBook(plan.bookQuery || question, {
          subject: resolvedSubject,
          track,
          search: Boolean(plan.useOutline || printedPage != null || physicalPage != null),
        });
      } catch (error) {
        bookResolutionFailed = true;
        console.warn('book resolution failed:', error?.message || error);
        step('book', 'تعذر تحديد الكتاب', 'لن أختار كتابًا عشوائيًا أو أنسب الصفحة إلى كتاب غير متحقق');
      }
    }
    if (!resolvedBook && shouldResolveBook && !bookResolutionFailed) {
      step('book', 'لم أجد كتابًا مطابقًا يمكن التحقق منه', 'لن أخمّن اسم الكتاب أو رقم الصفحة');
    }
    const targetBookId = selectedBookId || resolvedBook?.id || '';
    if ((plan.useOutline || printedPage != null || physicalPage != null) && targetBookId) {
      try {
        outline = await getOutline(targetBookId);
        if (outline) {
          const bookMeta = resolvedBook || books.find((book) => book.id === targetBookId) || null;
          step('outline', 'فتحت فهرس الكتاب', `${bookMeta?.subject || bookMeta?.title || targetBookId} — فهرس موثّق من الكتاب نفسه (${outline.entries} صفحة مفهرسة)`);
        } else if (plan.useOutline) {
          step('outline', 'مخطط الكتاب غير متاح', 'لن أستنتج ترتيب الفصول أو أرقام الصفحات من دون فهرس');
        }
      } catch (error) {
        console.error('outline load failed:', error?.message || error);
        step('outline', 'تعذر تحميل مخطط الكتاب', 'لن أستنتج ترتيب الفصول أو أرقام الصفحات من دون فهرس');
      }
    } else {
      step('subject', 'حددت المسار الدراسي', `سأبحث في كتب مسار ${track} المتاحة`);
    }

    if (plan.useLocal) {
      const localBookId = selectedBookId || ((plan.useOutline || printedPage != null || physicalPage != null) ? outline?.bookId || targetBookId : '');
      const query = plan.localQuery || question;
      // يُعاد استعمال نتائج الجولة الأولى متى تطابق الاستعلام والكتاب والمادة.
      // شرط «بلا صفحة محددة» كان يفرض بحثًا ثانيًا كاملًا بلا فائدة، لأن استرجاع
      // الصفحة المحددة لاحقًا يُلحق دليلها بنفس المصادر بدل إعادة البناء.
      const canReusePrefetch = prefetch.attempted
        && prefetch.query === clean(query, 400)
        && prefetch.bookId === localBookId
        && prefetch.subject === resolvedSubject;
      if (!canReusePrefetch) {
        const local = await retrieveLocalEvidence(query, {
          bookId: localBookId,
          subject: resolvedSubject,
          track,
          books,
          step,
          allowPdfFallback: (printedPage == null && physicalPage == null) || !localBookId,
          deadlineAt: retrievalDeadlineAt,
        });
        retrieved = local.retrieved;
        retrievedImage = local.image;
      }
    } else {
      retrieved = { block: '', sources: [] };
      retrievedImage = null;
    }

    let exactPage = { block: '', image: null, reliable: false };
    if (targetBookId && (printedPage != null || physicalPage != null)) {
      exactPage = await retrieveExactPage({
        bookId: targetBookId,
        printedPage,
        physicalPage,
        books,
        sources: retrieved.sources,
        step,
        deadlineAt: retrievalDeadlineAt,
      });
      if (exactPage.citation?.id) retrieved.block = withoutSourceBlock(retrieved.block, exactPage.citation.id);
    }

    // كتب تركيز الإجابة: ما سمّته الطالبة أو حدّده العميل أو حُلّ من سؤالها،
    // ولا تُحذف أقوى صفحة عائدة أبدًا مهما التبس التركيز. عليه تبنى الأولوية
    // والتقليم وإحدى صفحات القراءة البصرية، فلا يُشتق من تخمين بلا نتيجة.
    const supportedResolved = resolvedBook?.id && retrieved.sources.some((source) => source.bookId === resolvedBook.id)
      ? resolvedBook.id
      : '';
    const focus = focusBookIds({
      question,
      books,
      sources: retrieved.sources,
      selectedBookId,
      resolvedBookId: supportedResolved,
    });
    const namedBooks = booksNamedInQuestion(question, books);
    // كتاب طلبته الطالبة نصًّا: يُقتصر معه على مصدر واحد من كتاب آخر، فالكتاب
    // أصبح معلومًا قطعًا فلا داعي لتقديم صفحات كتب أخرى كأنها مصادر له.
    const crossBookCap = (namedBooks.size || selectedBookId) ? 1 : MAX_CROSS_BOOK_SOURCES;
    // ترتيب المجموعة يتبع أولوية الإشارة: المذكور نصًّا قبل المحدَّد من العميل.
    const primaryBookId = [...focus].find((id) => books.some((book) => book.id === id)) || '';
    const primaryBook = primaryBookId ? (books.find((book) => book.id === primaryBookId) || null) : null;
    // صفحة داكنة الفهرس تخرج من دائرة الحذف: تُفتح صورتها وتُرسل للقراءة البصرية،
    // فتدخل في السياق وفي قائمة الإحالات بدل أن يجيب النموذج من صفحة مجاورة.
    const damagedVision = await visionEvidenceForDamagedPages({
      sources: retrieved.sources,
      block: retrieved.block,
      books,
      subject: resolvedSubject,
      focusBookIds: focus,
      step,
      deadlineAt: retrievalDeadlineAt,
    });
    retrieved.block = damagedVision.block;

    const outlineBook = outline ? resolvedBook || books.find((book) => book.id === outline.bookId) || null : null;
    const outlineBlock = outline ? `[O1] ${outlineContext(outline, { structure: plan.useOutline })}` : '';
    const catalogBlock = catalog?.books?.length ? scopedCatalogBlock(catalog, plan.catalogScope, track) : '';
    const reliableLocalEvidence = retrieved.sources.some(isReliableLocalSource) || exactPage.reliable;
    const catalogAnswersRequest = catalogAdequatelyAnswers(plan, question, catalog);
    const webConfig = resolveWebSearch();
    let webSources = [];
    const isCurriculumIntent = plan.intent === 'curriculum'
      || (!['external', 'conversation'].includes(plan.intent) && curriculumQuestion(question, resolvedSubject, requestedBookId));
    const automaticCurriculumFallback = plan.intent === 'curriculum'
      || (plan.intent === 'unclear' && curriculumQuestion(question, resolvedSubject, requestedBookId));
    const shouldUseWeb = !reliableLocalEvidence
      && !catalogAnswersRequest
      && plan.intent !== 'conversation'
      && (plan.webFallback.enabled || automaticCurriculumFallback);
    if (shouldUseWeb) {
      const webQuery = plan.webFallback.query || plan.localQuery || question;
      if (webConfig.enabled) {
        step('web', 'أبحث في الويب بعد مصادر المنهج', 'أفضّل المصادر العراقية الرسمية والمرتبطة بالمقرر');
        try {
          const results = await searchWeb(webQuery, {
            config: webConfig,
            signal: abort.signal,
            preferCurriculum: isCurriculumIntent,
            subject: resolvedSubject,
            track,
          });
          webSources = isCurriculumIntent
            ? results.filter((source) => source.curriculumSpecific)
            : results;
          if (webSources.length) {
            step('web', 'وجدت أدلة خارجية', `${webSources.length} مصدرًا؛ ستظهر بوضوح كمصادر خارج كتاب المنهج`);
          } else {
            step('web', 'لم أجد مصدرًا خارجيًا مناسبًا', 'لن أقدّم نتائج عامة على أنها حقائق من المنهج');
          }
        } catch (error) {
          if (abort.signal.aborted) throw error;
          console.warn('web search failed:', error?.message || error);
          step('web', 'تعذر الوصول إلى البحث الخارجي', 'لم تُتحقق المعلومة عبر الويب؛ لن أستبدل ذلك بتخمين');
        }
      } else {
        step('web', 'البحث الخارجي غير مهيأ', webConfig.key
          ? 'إعداد نقطة بحث صالحة غير متوفر؛ لا يوجد مصدر خارجي يمكن الاستشهاد به'
          : 'يلزم ضبط WEB_SEARCH_API_KEY؛ سأوضح أن المعلومة لم تُتحقق خارجيًا');
      }
    }

    const exactBlockId = blockIdOf(exactPage.block);
    const exactSource = exactBlockId ? retrieved.sources.find((source) => source.id === exactBlockId) : null;
    const exactPageBlock = exactBlockId && (!exactSource || !answerCitationSource(exactSource)) ? '' : exactPage.block;

    // 1) عزل المسار: مصدر من خارج كتب المسار يُسقط كليًا، بلا استثناء.
    const offTrack = offTrackSources(retrieved.sources, trackBookIds);
    if (offTrack.length) {
      step('search', 'استبعدت مصدرًا من خارج مسار الطالبة', `${offTrack.length} صفحة من كتب لا تدخل في مسار «${track}»؛ لن أعرضها كمصدر`);
    }
    // 2) تركيز الكتاب: مصادر الكتب الأخرى تُقصّ بعد حدّ صغير بدل سردها كلها.
    const scopedSources = retrieved.sources.filter((source) => !offTrack.includes(source));
    const capped = capCrossBookSources(scopedSources, focus, crossBookCap);
    if (capped.dropped.length) {
      step('search', 'اقتطعت صفحات من كتب أخرى', `${capped.dropped.length} صفحة من كتب لم تطلبها الطالبة حُذفت؛ المصدر الأساس ${primaryBook?.title || primaryBookId}`);
    }
    // ترتيب المصادر والكتل معًا: كتب التركيز أولًا في القائمة وفي النص.
    const orderedSources = focus.size
      ? [...capped.kept].sort((a, b) => sourceRankFor(a, focus) - sourceRankFor(b, focus))
      : capped.kept;
    const droppedIds = new Set([...offTrack, ...capped.dropped].map((source) => source.id));
    const orderedBlock = orderLocalBlock(filterLocalBlock(retrieved.block, droppedIds), orderedSources, focus);
    // 3) موثوقية الدليل: ما لا يصلح للإسناد يخرج من السياق ومن الإحالات معًا،
    //    حتى لا يستشهد النموذج بدليل لا تحتمله الصفحة.
    const citeableSources = orderedSources.filter(answerCitationSource);
    const uncitable = new Set(orderedSources.filter((source) => !answerCitationSource(source)).map((source) => source.id));
    const localBlock = [filterLocalBlock(orderedBlock, uncitable), exactPageBlock].filter(Boolean).join('\n\n---\n\n');
    const externalBlock = webEvidenceBlock(webSources);
    // ترتيب الصور: صفحة الطالب أولًا، ثم الصفحة المطلوبة بالضبط، ثم أقوى
    // صفحة داكنة الفهرس التي فُتحت، ثم مرشح البحث العام.
    const extraImages = [exactPage.image, ...damagedVision.images, retrievedImage].filter(Boolean).slice(0, MAX_EVIDENCE_IMAGES);
    const primaryBlock = primaryBook
      ? `${primaryBook.title}${primaryBook.subject ? ` — ${primaryBook.subject}` : ''}`
      : '';
    const allSources = citationSources([
      ...citeableSources,
      ...(outline ? [outlineCitation(outline, outlineBook)] : []),
      ...(catalogBlock ? [catalogCitation(catalog, plan.catalogScope, track)] : []),
      ...webSources,
    ]);
    const messages = modelMessages(body, localBlock, outlineBlock, catalogBlock, track, externalBlock, extraImages, allSources.map((source) => source.id), plan.catalogScope, primaryBlock);
    sseSend(res, 'citations', { items: allSources });
    if (outline) sseSend(res, 'notice', { message: 'OUTLINE_CONTEXT', bookId: outline.bookId, structure: plan.useOutline });
    if (catalog) sseSend(res, 'notice', { message: 'CATALOG_CONTEXT' });
    if (plannerError && isProviderFailure(plannerError)) {
      const code = errorCode(plannerError);
      providerHealth.verified = false;
      providerHealth.lastError = code;
      providerHealth.checkedAt = Date.now();
      sseSend(res, 'error', { error: code, detail: clean(plannerError?.detail, 180) });
      return;
    }

    const maxAnswerChars = Math.min(MAX_ANSWER_CHARS, config.maxTokens * 4);
    // النموذج نموذج استدلال: `max_tokens` يحدّ الاستدلال والإجابة معًا، ورموز
    // الاستدلال لا تظهر في `output` إطلاقًا. لذلك:
    //  - دور يحمل صور صفحات يأخذ ميزانية Vision الأعلى، فلا يُقتطع قبل الكتابة.
    //  - جولة الإكمال بعد `length` تأخذ ميزانية كاملة جديدة، لا الباقي المتبقي
    //    المحسوب من نصّ مرئي؛ إعطاؤها الباقي يجعل النموذج يعيد الاستدلال
    //    فيُقتطع ثانيةً دون أن يكتب شيئًا.
    const roundBudget = Math.max(config.maxTokens, Number(config.visionMaxTokens) || 0);
    const allowedCitationIds = allSources.map((source) => source.id);
    for (let round = 0; round < MAX_ANSWER_ROUNDS; round += 1) {
      const roundMessages = round === 0
        ? messages
        : [
          ...messages,
          { role: 'assistant', content: output },
          { role: 'user', content: `أكملي إجابتك على سؤال الطالبة: ${clean(question, 1_000)}. تابعي من آخر نقطة دون إعادة ما سبق، ولا تبدئي مقدمة أو خاتمة جديدة، وكوني مباشرة في الاستنتاج.${extraImages.length ? ' الصورة المرفقة قد لم تُذكر بعد؛ اذكري ما يظهر فيها بوضوح إن كان ذا صلة بالسؤال.' : ''}` },
        ];
      const requestMessages = fitMessages(roundMessages, config, roundBudget);
      let finish = '';
      let reasoningTokens = 0;
      const citationFilter = citationStreamFilter(allowedCitationIds);
      // النموذج نموذج استدلال: قد لا يصل أي رمز لدقائق قبل أول كلمة. إرسال
      // خطوة مرئية دوريًا يحوّل الانتظار الصامت إلى تقدّم معلن للطالبة.
      const roundStart = Date.now();
      const waiting = setInterval(() => {
        if (firstTokenAt) return;
        step('write', 'أقرأ الأدلة وأفكّر في الإجابة', `مرّت ${Math.round((Date.now() - roundStart) / 1000)} ثانية قبل أول كلمة؛ البحث والاسترجاع انتهيا والنموذج يستدلّ الآن`);
      }, 12_000);
      try {
        for await (const event of streamCompletion({
          endpoint: config.endpoint,
          key: config.key,
          model: config.model,
          messages: requestMessages,
          maxTokens: roundBudget,
          signal: abort.signal,
          session,
          onFirstToken: () => { firstTokenAt ||= Date.now(); step('write', 'بدأت الكتابة', extraImages.length ? 'أقرأ الصفحة المصوّرة وأشرح اعتمادًا على الأدلة المتاحة' : 'أشرح الآن اعتمادًا على الأدلة المتاحة'); },
        })) {
          if (event.type === 'text') {
            const text = citationFilter.push(event.text);
            if (text) {
              if (output.length + text.length > maxAnswerChars) throw new Error('REPLY_TOO_LONG');
              output += text;
              sseSend(res, 'delta', { text });
            }
          } else if (event.type === 'done') {
            finish = event.finish || 'stop';
          } else if (event.type === 'usage') {
            reasoningTokens = Math.max(reasoningTokens, Number(event.reasoningTokens) || 0);
          }
        }
      } finally {
        clearInterval(waiting);
      }
      const citationTail = citationFilter.finish();
      if (citationTail) {
        if (output.length + citationTail.length > maxAnswerChars) throw new Error('REPLY_TOO_LONG');
        output += citationTail;
        sseSend(res, 'delta', { text: citationTail });
      }

      if (finish === 'length') {
        // جولة كاملة بلا أي نص يعني أن الاستدلال وحده استنفد الميزانية. تكرار
        // الجولة ثالثة بمثلها لا يزيد النصّ المكتوب، ويضاعف زمن انتظار الطالبة.
        if (!output.trim() && round >= 1) throw new Error('REPLY_TRUNCATED');
        if (round + 1 < MAX_ANSWER_ROUNDS && output.length < maxAnswerChars) {
          step('write', output.trim() ? 'أكمل الإجابة' : 'لم تُكتب إجابة بعد',
            output.trim()
              ? `بلغ النموذج حدّ الكتابة فتابع من آخر نقطة بميزانية ${roundBudget} رمز`
              : `استهلك الاستدلال ميزانية الجولة (${reasoningTokens || 'غير معروف'} رمز استدلال) فأعيد بميزانية ${roundBudget} رمز`);
          continue;
        }
        if (!output.trim()) throw new Error('REPLY_TRUNCATED');
        // النصّ الموجود يُسلَّم كما وصل مع إشعار صريح بدل رمي الإجابة كلها
        // والاكتفاء بخطأ «مبتورة».
        sseSend(res, 'notice', { message: 'ANSWER_LIMIT_REACHED' });
      } else if (finish === 'tool_calls' || finish === 'function_call') throw new Error('MODEL_TOOL_CALLS_UNSUPPORTED');
      else if (finish === 'content_filter') throw new Error('REPLY_FILTERED');
      if (!output.trim()) throw new Error('EMPTY_REPLY');

      providerHealth.verified = true;
      providerHealth.lastError = null;
      providerHealth.checkedAt = Date.now();
      sseSend(res, 'done', {
        finish,
        firstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
        sources: allSources.length,
      });
      break;
    }
  } catch (error) {
    if (!abort.signal.aborted && !res.writableEnded) {
      const code = errorCode(error);
      if (config.key) { providerHealth.verified = false; providerHealth.lastError = code; providerHealth.checkedAt = Date.now(); }
      const known = ['EMPTY_REPLY', 'REPLY_TOO_LONG', 'REPLY_TRUNCATED', 'REPLY_FILTERED', 'MODEL_TOOL_CALLS_UNSUPPORTED'];
      sseSend(res, 'error', { error: known.includes(error?.message) ? error.message : code, detail: clean(error?.detail, 180) });
    }
  } finally {
    stopHeartbeat();
    req.off?.('aborted', onClose);
    res.off?.('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

async function api(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/health' && req.method === 'GET') {
    try {
      const curriculum = await getHealth();
      const ai = resolveProvider({ headers: req.headers });
      return sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), curriculum, ai: { ...publicConfig(ai), verified: providerHealth.verified, lastError: providerHealth.lastError } });
    } catch (error) { return sendJson(res, 503, { ok: false, error: error.message }); }
  }
  if ((pathname === '/api/bootstrap' || pathname === '/api/config') && req.method === 'GET') {
    try {
      const config = resolveProvider({ headers: req.headers });
      const [books, subjects, curriculum, outlines] = await Promise.all([listBooks(), getSubjects(), getHealth(), listOutlineIds()]);
      const ready = new Set(outlines);
      return sendJson(res, 200, {
        app: { name: 'معلمي', version: '3.0.0' },
        ...publicConfig(config),
        verified: providerHealth.verified,
        lastError: providerHealth.lastError,
        books: books.map((book) => publicBook(book, ready)),
        subjects,
        curriculum,
      });
    } catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (pathname === '/api/books' && req.method === 'GET') {
    const books = await listBooks({ subject: clean(url.searchParams.get('subject'), 120), track: clean(url.searchParams.get('track'), 80) });
    const ready = new Set(await listOutlineIds());
    return sendJson(res, 200, { books: books.map((book) => publicBook(book, ready)) });
  }
  if (pathname === '/api/outline' && req.method === 'GET') {
    const outline = await getOutline(clean(url.searchParams.get('bookId'), 100));
    if (!outline) return sendJson(res, 404, { error: 'OUTLINE_NOT_FOUND' });
    return sendJson(res, 200, { bookId: outline.bookId, entries: outline.entries, header: outline.header, pages: outline.pages });
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    const query = clean(url.searchParams.get('q'), 400);
    if (query.length < 2) return sendJson(res, 400, { error: 'QUERY_REQUIRED' });
    const bookId = clean(url.searchParams.get('bookId'), 100);
    const subject = clean(url.searchParams.get('subject'), 120);
    const track = clean(url.searchParams.get('track'), 80);
    const limit = Math.max(1, Math.min(24, Number(url.searchParams.get('limit')) || 8));
    let results;
    try {
      results = await search(query, { bookId, subject, track, limit });
      if (!results.length) {
        const books = await listBooks({ track });
        const fallback = await searchPdfFallback(query, { track, subject, bookId, limit, books, sources: [], step: () => {}, sendImageToVision: false });
        if (fallback.citation) results = [{
          ...fallback.citation,
          score: 0,
          preview: clean(fallback.text || fallback.citation.pageTitle, 700),
        }];
      }
    } catch (error) {
      console.warn('curriculum search endpoint failed:', error?.message || error);
      return sendJson(res, 503, { error: 'SEARCH_FAILED' });
    }
    return sendJson(res, 200, { results });
  }
  if (pathname === '/api/page' && req.method === 'GET') {
    const bookId = clean(url.searchParams.get('bookId'), 100);
    const printedValue = url.searchParams.get('printed');
    const physicalValue = url.searchParams.get('page');
    const printed = printedValue == null ? null : pageNumber(printedValue);
    const physical = physicalValue == null ? null : pageNumber(physicalValue);
    if (!bookId || (physical == null && printed == null)) return sendJson(res, 400, { error: 'BAD_PARAMS' });
    const page = await pageForApi(bookId, printed, physical);
    if (!page) return sendJson(res, 404, { error: 'PAGE_NOT_FOUND' });
    return sendJson(res, 200, page);
  }
  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (req.method === 'GET' && await serveStatic(req, res, PUBLIC_ROOT)) return;
    if (req.method === 'GET') {
      const served = await serveStatic({ url: '/' }, res, PUBLIC_ROOT);
      if (served) return;
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error('request failed:', error?.message || error);
    if (!res.headersSent) sendJson(res, 500, { error: 'SERVER_ERROR' });
    else if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.PORT) || 3000;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.listen(port, '0.0.0.0', () => console.log(`Mualimi 3 ready on :${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
