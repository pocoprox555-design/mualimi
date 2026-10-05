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
import { normalizeDigits, pageReference } from './lib/text.mjs';
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
const PLAN_DEADLINE_MS = 14_000;
// ميزانية زمنية لكل عمل PDF (فتح صفحة/رسمها). العمل مُسلسل داخل pdf-fallback،
// فكل محاولة زائدة تدفع زمن أول رمز في الإجابة إلى الخلف.
const RETRIEVAL_DEADLINE_MS = 9_000;
const MAX_PDF_ATTEMPTS = 3;
const PDF_PAGE_DEADLINE_MS = 8_000;
// صفحة موسومة damaged-text نصوصها غير قابلة للنقل لكن صورتها تُقرأ بصرياً،
// فيكفي فتح واحدة فقط (الأقوى) لإخراجها من دائرة الحذف.
const MAX_DAMAGED_VISION_PAGES = 1;
// مهلة جولة القراءة البصرية وحدها: فتح صفحة ورسمها ~1.3 ثانية، والجولة تتوقف
// عند هذه المهلة مهما تعداد المرشحون.
const VISION_PASS_BUDGET_MS = 5_000;
// عدد المرشحين المفتوحين في جولة واحدة. خمسة تكفي للوصول إلى الصفحة المطلوبة
// حين يعطي المرشحون الأعلى نصًا سليمة بدل صورة، وتبقى الحزمة محدودة عملًا
// (~1.3 ثانية لكل فتح) ومحدودة بست ثوانٍ بمهلة الجولة.
const VISION_PASS_MAX_ATTEMPTS = 5;
const MAX_EVIDENCE_IMAGES = 2;
// نص الصفحة الواحدة في الـprompt. صفحة كتاب مدرسي كاملة أقل من هذا بكثير،
// والسقف الأعلى لا يضيف للطالب إلا زمن انتظار قبل أول كلمة.
const MAX_PAGE_CHARS = 8_000;
// بطاقات المصادر المعروضة للطالبة: مصدر أو مصدران من كتاب السؤال يكفيان،
// والباقي ضجيج يملأ الشاشة على الجوال.
const MAX_CITED_SOURCES = 4;
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

function systemPrompt(context, studentName = '', outlineBlock = '', catalogBlock = '', track = 'ديني', webBlock = '', citationIds = [], catalogScope = 'track', primaryBlock = '', visionBlock = '', gateBlock = '', quizBlock = '') {
  const name = String(studentName || 'رحمة').trim().slice(0, 40);
  return [
    'أنت «معلمي»، معلم خاص محترف وذكي للطالبة رحمة — تدرّسين السادس الإعدادي بكل تفاصيله. أنتِ تعرفين المنهج العراقي كاملاً حرفياً لأن كل كتب الـ 21 مستخرجة نصاً في pdf-books (fullText)، ولديك وصول مباشر لكل صفحة. لا تقولي أبداً "ما عندي وصول للكتب" أو "حطي نص الصفحة" — النص موجود عندك، افتحيه واشرحيه مباشرة.',
    `الطالبة ${name} تدرس السادس الإعدادي في مسار «${track}». أولويتك كتب هذا المسار، لكنك معلمة شاملة: إذا سألت عن مادة أو مسار آخر وضحي الفرق بذكاء ولا ترفضي.`,
    'خاطبي الطالبة بصيغة المؤنث وبالعربية الفصحى السهلة بلمسة عراقية دافئة وطبيعية. كوني ودودة جداً، صبورة، مشجعة، كأم ثانية ومعلمة خاصة تحب رحمة. تذكري سياق الجلسة، لا تكرري طلب معلومة ذكرتها، واسألي سؤال متابعة واحداً فقط عند الحاجة.',
    'إذا كانت رسالة الطالبة تحية أو سؤالا وديّا عن الحال بلا طلب دراسي — كوني إنسانة دافئة: ردي بود، اسألي عن يومها وشجعيها، ولا تبحثي في الكتب ولا تذكري مصادر. افهمي النية بنفسك.',
    'إذا طلبت صفحة محددة برقمها — لديك نصها الكامل في pdf-books (fullText). افتحيها فورا واشرحيها خطوة بخطوة بأسلوب تعليمي واضح من النص نفسه. لا تطلبي منها نص الصفحة أبدا. إذا طلبت أكثر من صفحة من كتب مختلفة، اشرحي كل واحدة بعنوانها ومادتها على حدة.',
    'قواعد الشرح العام: لكل سؤال منهجي (اشرحي، حلي، لخصي، ترجمي) — اشرحي مباشرة وبأسلوب تعليمي ممتع. في الرياضيات: خطوة خطوة مع القاعدة والمثال. في اللغات: القاعدة + الأمثلة. في الحفظيات: رتبي الأفكار بنقاط واضحة. لا تملئي الرد بسرد خطوات البحث ولا تذكري مصادرك ولا خطواتك الداخلية.',

    // ── القاعدة العليا: لا نص ديني ولا صفحة مخترعة ─────────────────────────
    'قاعدة لا تُخترق مهما بدا الأمر واضحاً: لا تسردي آية أو حديثاً أو نصاً دينياً أو حكماً شرعياً ولا نصاً لكتاب مدرسي حرفياً إلا إذا كان منقولاً نصاً في المقتطف المرفق أمامك. إن لم تجده في المقتطف فلا تسرديه إطلاقاً — لا من الذاكرة ولا بالإكمال ولا بالتخمين. لا تخترعي سورة ولا آية ولا رقم آية ولا حديثاً ولا راوياً ولا نسبة. إذا احتجت لذكر آية فاذكري القاعدة أو المعنى فقط، أو قولي للطالبة صراحة إن النص لم يرد في الصفحة. آية ناقصة تُعلم الطالب بحدود الأداة، وآية محرَّفة تُكذّب الكتاب.',
    'إن طلبت الطالبة نصاً دينياً بعينه (آية بعينها، حديث بعينه، حكماً بعينه) ولم تجده منقولاً في المقتطف: قولي لها بصراحة وجملة واحدة إن النسخة الرقمية لتلك الصفحة لا تُظهره كاملاً، ووجّهيها إلى الصفحة في كتابها. هذا جواب صحيح لا عذر، ولا تعوّضيه بنص من ذاكرتك ولا بإكمالٍ أو تصحيحٍ من عندك ولا بآية «مقاربة». ولا تكتبي رموز نقص (…) ولا ﴿…﴾ فارغة ولا حروفاً مبتورة.',
    'كذلك لا تختلقي محتوى صفحة لم تُفتح لك: لا تمثلة ولا أمثلة ولا تمارين ولا أرقاماً ولا أسماء ولا جداول ولا خطوات ولا عناوين صفحات من عندك. إذا لم يظهر لك دليل الطلب، قولي للطالبة بوضوح ما تعذّر، ولا تملئي الفراغ.',
    'لا تختلقي كتاباً ولا مادة ولا مساراً: اذكري فقط ما ورد في كتالوج المسار المرفق لك بنفس الأسماء، ولا تختلقي عدد صفحات. إذا كانت أسئلتها عن مادة أو مسار آخر غير كتب مسارها، اشرحيها لك شرحاً عاماً جيداً ووضّحي بلطف في جملة واحدة أنها ليست من كتبك ولا من منهجك، ولا تسمّي المنهج الديني على أنها مادة فيه.',

    // ── بنية الإخراج ────────────────────────────────────────────────────────
    'أسلوبي في الكتابة: Markdown نظيف فقط. عناوين بثلاثة # على الأكثر، قوائم نقطية، وخط عريض للكلمات المفتاحية. ممنوع منعاً باتاً: رموز LaTeX الخام مثل $$ أو \\frac أو ^{} أو _ في النص — اكتبيها بصيغة مقروءة مثل «ق(100،98) = 4950». ممنوع الخطوط الطويلة من ___ أو ---- أو جداول ASCII، وممنوع عنوان بأربع علامات # فما فوق. الجداول بصيغة Markdown المعتادة فقط، وإذا تعذّر عرضه كجدول فاكتبي المحتوى نقاطاً مرقمة بدل خلايا ملتصقة.',
    'لا تكتب في نصّك للطالبة أي معرّف مصدر بين أقواس مثل [S1] ولا [O1] ولا [C1] — الطالبة ترى المصادر في بطاقاتها أسفل الرد، ولا تحتاج رموزاً غريبة في متن الكلام.',
    catalogBlock
      ? `\n## بيانات الكتالوج ونطاقها\n${catalogBlock}\n\nهذا هو المصدر الوحيد لحقيقة الكتب المتاحة، استعمليه عند السؤال عن الكتب أو المواد أو خطة المذاكرة، ولا تذكريه في ردّ سؤال آخر. نطاق هذه البيانات ${catalogScope === 'global' ? 'جميع الكتب المتاحة في التطبيق عبر المسارات' : `كتب مسار «${track}» فقط، وليست جميع كتب التطبيق`}. عند السؤال عن كتب مسار رحمة اذكري كتب «${track}» فقط. لا تصفي كتالوج المسار بأنه كتالوج التطبيق الكامل؛ اذكري كل المسارات فقط إذا كان النطاق المعروض عالميًا. أي كتاب لم يرد هنا ممنوع عليك ذكره.`
      : '\n## لا كتالوج في هذا الطلب\nلم يُحمَّل كتالوج الكتب لهذا السؤال. إن سألتك الطالبة عن كتبها أو عن موادها فجاوبي بجملة صادقة واحدة (مثل: لم أستطع عرض قائمة الكتب الآن، أعيدي السؤال أو اسأليني عن الكتاب مباشرة) ولا تسردي قائمة كتب ولا مادة من ذاكرتك.',
    primaryBlock
      ? `\n## الكتاب المقصود بسؤال الطالبة\n${primaryBlock}\n\nهذا الكتاب هو مصدر السؤال، وصفحاته هي الأدلة الأساسية. اعتمدي صفحاته أولًا وأجيبي منها. إن ظهرت لديك صفحة من كتاب آخر فاعلمي أنها من كتاب آخر ومن مادة مختلفة، واذكري ذلك صراحة.`
      : '',
    outlineBlock
      ? `\n## مخطط وصفي للمادة\n${outlineBlock}\n\nهذا مخطط فهرسي للتنقل والبنية وأرقام الصفحات، وليس نسخا حرفيا من PDF. استعمليه للفصول والوحدات وتحديد الصفحة فقط. لا تنسبي إليه آية أو حديثا أو حلا حرفيا.`
      : '',
    'ميّزي بين نص PDF المستخرج (fullText) وبين الوصف الفهرسي. إذا وُسم الدليل pdfOpened:true فهو من الملف الأصلي، وإلا فهو من الفهرس المستخرج لكنه موثوق للشرح. النص الموسوم damaged-text لا يُنقل حرفياً، لكن اشرحي معناه إن وُجد وصف فهرسي أو صورة بصرية.',
    visionBlock
      ? `\n${visionBlock}`
      : '',
    quizBlock
      ? `\n${quizBlock}`
      : '',
    gateBlock
      ? `\n${gateBlock}`
      : '',
    context ? `\n## مصادر الصفحات المطابقة (من pdf-books — نصوص مستخرجة فعلية)\n${context}` : '\n## لا دليل محلي مرفق\nلم يُعثر على صفحة أو نص من كتب المنهج يطابق هذا الطلب. اشرحي من خبرتك التعليمية، وابدئي بعبارة صادقة قصيرة مثل «هذا الشرح من معرفتي بالمنهج، لا من نص صفحة» — ولا تنسبي شيئاً إلى كتاب أو صفحة بعينها، ولا تختلقي عنوان صفحة ولا تمريناً ولا جدولاً. لا تعتذري بـ «ما عندي وصول»، ولا تطلبي منها نص الصفحة.',
    webBlock
      ? `\n## أدلة ويب خارجية — ليست من كتاب المنهج\n${webBlock}\nأي معلومة مأخوذة من هذه الأدلة يجب أن تُوسم بوضوح «مصدر خارجي — ليس من كتاب المنهج»، ويجب إرفاق رابط المصدر نفسه.`
      : '',
    'الأولوية للمصادر المحلية المرفقة، ثم خبرتك مع التصريح بذلك، ثم الويب. لا تنسبي معلومة ويب إلى كتاب مدرسي.',
    'تذكري: أنتِ معلمة رحمة الخاصة، ذكية بلا حدود، لا قيود غبية، تشرحين كل شيء في المنهج وخارجه كأفضل معلمة بشرية في العراق. كوني مفيدة دائماً، لا ترفضي أي سؤال تعليمي.',
  ].filter((line) => line && line.trim()).join('\n');
}


function supportsVision(model){ return /vision/i.test(String(model||'')) || /deepseek.*flash/i.test(String(model||'')); }
function imageParts(rawContent) {
  if (!Array.isArray(rawContent)) return [];
  return rawContent
    .filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    .filter((part) => /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(part.image_url.url) && part.image_url.url.length <= 1_500_000)
    .slice(0, 2)
    .map((part) => ({ type: 'image_url', image_url: { url: part.image_url.url } }));
}

function modelMessages(body, sourceBlock, outlineBlock, catalogBlock, track, webBlock = '', extraImages = [], citationIds = [], catalogScope = 'track', primaryBlock = '', model = '', gateBlock = '', quizBlock = '') {
  const history = historyFor(body.messages);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const rawLast = rawMessages.filter((message) => message?.role === 'user').at(-1);
  const lastText = clean(textOf(rawLast?.content), MAX_MESSAGE);
  const lastIndex = history.findLastIndex((message) => message.role === 'user');
  const prior = history.slice(0, Math.max(0, lastIndex)).slice(-MAX_HISTORY);
  const canSee = supportsVision(model);
  const rawImages = [...imageParts(rawLast?.content), ...extraImages].slice(0, 2);
  const images = canSee ? rawImages : [];
  const visionBlock = images.length
    ? '## صورة صفحة مرفقة\nأُرفقت صورة صفحة PDF في هذه الرسالة. يمكنكِ قراءتها بصريًا وهي دليل مسموح: اذكري ما يظهر فيها بوضوح فقط، وسمّي الدليل «صورة صفحة قُرئت بصريًا» مع معرّفها، ولا تخمّني ما لا يظهر، ولا تقرئي الأرقام والكلمات الصغيرة غير الواضحة. أجيبي عمّا سُئلت عنه فقط من الصفحة، دون استعراض الصفحة كلها أو نسخ نصها كاملًا؛ فالإجابة المطوّلة على سؤال واحد تُضيّع وقت الطالبة.'
    : rawImages.length && !canSee
      ? '## ملاحظة صور\nأرسلت الطالبة صورة مع السؤال، والنموذج الحالي لا يقرأ الصور بصرياً، فلا تسردي أي محتوى لتلك الصورة ولا تختلقي وصفاً لها. اعتمدي على النصوص المستخرجة من pdf-books وحدها. إن كان السؤال كله عن الصورة فجاوبي بلطف بجملة واحدة صادقة: لم أتمكن من قراءة الصورة هذه المرة، وأستطيع أن أشرح لها الموضوع نفسه من نصوص الكتاب. لا تطلبي منها أن تكتب نص الصورة ولا تعتذري بأنك بلا وصول، ولا تظهري خطأ تقنياً.'
      : '';
  return [
    { role: 'system', content: systemPrompt(sourceBlock, clean(body.studentName, 40), outlineBlock, catalogBlock, track, webBlock, citationIds, catalogScope, primaryBlock, visionBlock, gateBlock, quizBlock) },
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
  'أنت مخطط استعمال أدوات لمعلم رقمي. مهمتك الوحيدة فهم نية الطالبة وتحديد عمليات الاسترجاع؛ لا تجب عن سؤالها ولا تكتب أي حقيقة أو شرح.',
  'أعد كائن JSON فقط، دون Markdown أو نص قبله أو بعده، وبالمفاتيح التالية: {"intent":"curriculum|catalog|external|conversation|unclear","use_local":true,"local_query":"","book_query":"","subject":"","use_outline":false,"use_catalog":false,"catalog_scope":"track|global","exact_page":{"printed_page":null,"physical_page":null},"quiz":{"requested":false,"questions":0},"web_fallback":{"enabled":false,"query":""}}.',
  'افهم النية بنفسك كمعلم ذكي: التحية والكلام الودي الشخصي بلا طلب دراسي -> conversation بلا أي بحث. السؤال المنهجي أو طلب شرح/حل/صفحة -> curriculum مع use_local=true. السؤال عن الكتب نفسها -> catalog. المعلومة الآنية أو خارج المنهج تماما -> external.',
  'استخرج رقم الصفحة فقط إذا ذكر صراحة في النص أو الصورة. إذا طلبت أكثر من صفحة فضع الأولى في exact_page والباقي سيستخرج تلقائيا. لا تخترع أرقاما.',
  'إذا طلبت الطالبة اختباراً أو تدريباً أو «اختبريني» فاجعل quiz.requested=true، وضع في quiz.questions عدد الأسئلة الذي طلبته إن ذكرته (وإلا 0 ليُفترض 5)، واذكر book_query إن كان الاختبار في كتاب محدد.',
  'عند سؤال منهجي فعل web_fallback كخطة احتياطية فقط عند غياب الدليل المحلي، بصياغة موجهة للمنهج العراقي.',
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

// كل «صفحة N» في سؤال الطالبة، مع الكتاب الذي تنتمي إليه إن سمّته. النافذة
// ٦٠ محرفاً حول الرقم تكفي لاسم المادة أو الكتاب، والأرقام العربية تُطبّع
// أولاً وإلا فات «صفحة ٢٢» كل استخراج والنتيجة كتاب عشوائي.
function extractPageRequests(question, books = []) {
  const raw = normalizeDigits(String(question || ''));
  const re = /(?:صفحة|صفحه|الصفحة|الصفحه|ص\.?)\s*(\d{1,4})/gi;
  const out = [];
  let m;
  while ((m = re.exec(raw))) {
    const n = pageNumber(m[1]);
    if (n == null) continue;
    if (out.some(o=>o.printedPage===n)) continue;
    // hint: نافذة واسعة حول الرقم تلتقط «من الفقه» و«في كتاب التربية الإسلامية»
    const start = Math.max(0, m.index - 60);
    const ctx = normalizedQuestion(raw.slice(start, m.index + m[0].length + 60));
    let hint = '';
    const pickHint = (candidates) => {
      let bestLen = 0;
      let best = '';
      for (const cand of [...new Set(candidates.filter(Boolean))]) {
        const norm = normalizedQuestion(cand);
        if (norm.length < 3) continue;
        // take first 2 tokens of title as key
        const key = norm.split(' ').slice(0, 2).join(' ');
        if (key.length < 3) continue;
        if (ctx.includes(norm) || ctx.includes(key)) {
          if (norm.length > bestLen) { bestLen = norm.length; best = cand; }
        }
      }
      return best;
    };
    // أسماء المواد أولاً وبأولوية تامة: «اللغة العربية» موضوع لكتبها جزآن، أما
    // العنوان الكامل «… — الجزء الثاني» فيسمّي كتاباً واحداً في يقينٍ زائف
    // فيُفتح جزءٌ بالتخمين. لا يُلجأ إلى العناوين إلا إن لم يطابق اسم مادة.
    hint = pickHint(books.map((book) => book.subject || ''));
    if (!hint) hint = pickHint(books.map((book) => book.title || ''));

    // also try to capture "من <text>" after page
    if (!hint) {
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 30);
      const man = after.match(/\s*من\s*([^\s،,؛\.و]{2,30})(?:\s+[^\s،,؛\.و]{1,30})?/);
      if (man) hint = man[1].trim();
    }
    out.push({ printedPage: n, physicalPage: null, bookHint: hint });
    if (out.length >= 4) break;
  }
  return out;
}

function globalCatalogRequest(question) {
  const text = normalizedQuestion(question);
  return /(?:كل|جميع|كافة)\s+(?:(?:كتب|الكتب)\s+)(?:(?:الموجودة|المتاحة)\s+)?(?:في\s+)?(?:التطبيق|المكتبة|كل\s+المسارات|جميع\s+المسارات)|(?:كتب|الكتب)\s+(?:في\s+)?(?:كل|جميع)\s+المسارات|\b(?:all\s+(?:app\s+)?books|books\s+across\s+all\s+tracks)\b/.test(text);
}

// «شنو الكتب المتاحة عندي؟» و«الكتب الموجودة» سؤال كتالوج صريح. كان هذا
// التعبير أضيق من نمط «سؤال قائمة الكتب» فلم يُكشف الطلب، فلم يُحمَّل كتالوج،
// فعجز النموذج عن شيء فسرد كتباً من ذاكرته. النمط الأوسع هو المرجع الآن.
function catalogQuestion(question) {
  const text = normalizedQuestion(question);
  return globalCatalogRequest(question)
    || /(?:كتالوج|فهرس\s+(?:الكتب|المكتبة)|قائمة\s+(?:ال)?كتب|(?:ال)?كتب\s+(?:المتاحة|المموجودة|المتوفرة|عندي|لي)|(?:كل|جميع)\s+(?:كتب|الكتب)|كتب\s+(?:التطبيق|المكتبة|مساري|الفصل)|محتويات\s+الكتاب)/.test(text);
}

// طلب الاختبار: الواجهة تملك بطاقة تفاعلية أصلاً، فلماذا وصل الاختبار نصاً؟
// لأن النموذج لم يُلزم بكتلة quiz. هذان يقرّران الإلزام وعدد الأسئلة.
function quizRequest(question) {
  const text = normalizedQuestion(question);
  return /(?:اختبر|اختبري|اختبار|امتحان|تدريب|quiz|test\s+me)/.test(text)
    && !/(?:حل|تصحيح|صحح)\s*(?:ال)?(?:امتحان|اختبار)/.test(text);
}

function quizCount(question) {
  // «٥ أسئلة» تصل بصور مختلفة: أرقام عربية، همزات، تاء مربوطة، تشكيل. بعد
  // التوحيد لا يبقى إلا «سوال» و«سوالات» و«اسله» و«اسيله» و«سيله».
  const text = normalizeDigits(String(question || ''))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ءة]/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
  const match = text.match(/(\d{1,2})\s*(?:سو?ال|ا?س[ي]?له|question)/);
  const count = match ? Number(match[1]) : 0;
  return count >= 2 && count <= 30 ? count : 0;
}

// الأرقام تُكتب بالعربية في التعليمات كما تكتبها الطالبة، فلا يلتبس العدد
// المكتوب لاتينياً بسؤال مكتوب عربياً.
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function arNumber(value) {
  return String(value).replace(/\d/g, (digit) => AR_DIGITS[Number(digit)]);
}

// الاختبار يصل إلى الطالبة بطاقة تفاعلية فقط إن أخرجتِ بكتلة quiz. الشرط
// ليس «مرجواً» بل إخراج مفروض: مقدمة قصيرة سطر واحد ثم الكتلة بلا أي نص
// بعدها، وعدد الأسئلة هو ما طلبته الطالبة (عشرة افتراضياً لا أكثر).
function quizInstruction(requestedCount) {
  const count = requestedCount >= 2 && requestedCount <= 30 ? requestedCount : 10;
  return [
    '## اختبار تفاعلي — إلزامي الآن',
    'الطالبة طلبت اختباراً، وقد أعدّت الواجهة لها بطاقة تفاعلية تُبنى من كائن JSON واحد. إذا لم تكتب هذه الكتلة ظهر الرد نصاً غير قابل للنقر، وهو فشل لا يُغتفر.',
    'اكتبي سطراً تمهيدياً واحداً قصيراً فقط (لا أكثر) ثم كتلة بالشكل التالي بالضبط، ولا شيء بعدها:',
    '```quiz',
    '{"title":"عنوان الاختبار","questions":[{"q":"نص السؤال","options":["الخيار الأول","الخيار الثاني","الخيار الثالث","الخيار الرابع"],"answer":0,"why":"سبب مختصر"}]}',
    '```',
    `الشروط: ${arNumber(count)} أسئلة بالضبط؛ لكل سؤال أربعة خيارات مختلفة، وanswer رقم الصحيح بدءاً من 0، وwhy يشرح الصحيح لماذا؛ لا نص خارج JSON داخل الكتلة ولا كود ملتف حولها؛ ولا تكتب عناوين Markdown قبل الكتلة أو بعدها إلا سطراً واحداً.`,
  ].join('\n');
}

function quizBlockPresent(text) {
  return /```(?:quiz|json)\s*\{/.test(String(text || ''));
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
  let intent = globalCatalog ? 'catalog' : intents.has(raw?.intent) ? raw.intent : 'unclear';
  const exact = raw?.exact_page && typeof raw.exact_page === 'object' ? raw.exact_page : {};
  const web = raw?.web_fallback && typeof raw.web_fallback === 'object' ? raw.web_fallback : {};
  const quiz = raw?.quiz && typeof raw.quiz === 'object' ? raw.quiz : {};
  const webQuery = clean(web.query ?? raw?.web_query, 300);
  const hasPage = pageReference(question) != null;
  if (hasPage && intent === 'conversation') intent = 'curriculum';
  // سؤال الكتب صريح في نصه، فلا يُترك للنموذج أن يقرره: وإلا سرد كتباً من
  // ذاكرته حين يعجز أو يتأخر. الكتالوج بيانات محلية رخيصة تُحمَّل دائماً.
  const asksCatalog = catalogQuestion(question);
  return {
    intent: asksCatalog ? 'catalog' : intent,
    useLocal: asksCatalog || intent === 'conversation' || intent === 'catalog' ? false : intent === 'curriculum' ? true : hasPage ? true : raw?.use_local !== false,
    useCatalog: Boolean(raw?.use_catalog) || asksCatalog || intent === 'catalog' || globalCatalog,
    catalogScope: globalCatalog ? 'global' : 'track',
    useOutline: Boolean(raw?.use_outline),
    localQuery: clean(raw?.local_query, 400) || clean(question, 400),
    bookQuery: clean(raw?.book_query, 160),
    subject: clean(raw?.subject, 120),
    exactPage: {
      printedPage: pageNumber(exact.printed_page ?? exact.printedPage),
      physicalPage: pageNumber(exact.physical_page ?? exact.physicalPage),
    },
    quiz: {
      requested: Boolean(quiz.requested ?? raw?.use_quiz) || quizRequest(question),
      // عدد أسئلة طلبته الطالبة نصاً حجّة قاطعة على ما خطّطه النموذج.
      questions: Math.max(0, Math.min(30, Number(quiz.questions ?? raw?.quiz_questions) || 0)) || quizCount(question),
    },
    webFallback: { enabled: Boolean(web.enabled ?? raw?.use_web) && webQuery.length >= 2, query: webQuery },
  };
}

function fallbackPlan(question) {
  const isCatalog = catalogQuestion(question);
  const globalCatalog = globalCatalogRequest(question);
  const hasPage = pageReference(question) != null;
  const pageNum = hasPage ? pageReference(question) : null;
  return {
    intent: isCatalog ? 'catalog' : curriculumQuestion(question) ? 'curriculum' : hasPage ? 'curriculum' : 'unclear',
    useLocal: !isCatalog,
    useCatalog: isCatalog,
    catalogScope: globalCatalog ? 'global' : 'track',
    useOutline: false,
    localQuery: clean(question, 400),
    bookQuery: '',
    subject: '',
    exactPage: { printedPage: pageNum, physicalPage: null },
    quiz: { requested: quizRequest(question), questions: quizCount(question) },
    webFallback: { enabled: false, query: '' },
  };
}

// رقم صفحة في السؤال قرار قائم على معطى لا على تخمين، فلا يحتاج مخططاً
// إضافياً: planDirect يبنيه فوراً. الربح مزدوج: لا انتظار لتخطيط، ولا بحث عام
// يُفسد جواب صفحة محددة، والكتاب يُحلّ محلياً من اسم المادة.
function planDirect(question, subject = '') {
  const printed = pageReference(question);
  return {
    intent: 'curriculum',
    useLocal: true,
    useCatalog: false,
    catalogScope: 'track',
    useOutline: true,
    localQuery: clean(question, 400),
    bookQuery: '',
    subject,
    exactPage: { printedPage: printed, physicalPage: null },
    quiz: { requested: quizRequest(question), questions: quizCount(question) },
    webFallback: { enabled: false, query: '' },
  };
}

async function planIntent({ config, body, question, subject, bookId, track, session, signal, deadlineMs = PLAN_DEADLINE_MS }) {
  const history = historyFor(body.messages);
  const lastIndex = history.findLastIndex((message) => message.role === 'user');
  const prior = history.slice(0, Math.max(0, lastIndex)).slice(-6);
  const rawLast = (Array.isArray(body.messages) ? body.messages : []).filter((message) => message?.role === 'user').at(-1);
  const hasImage = imageParts(rawLast?.content).length > 0;
  const text = clean(textOf(rawLast?.content), MAX_MESSAGE) || (hasImage ? 'أرسلت صورة لصفحة أو سؤال دراسي؛ حددي نية الاسترجاع دون الإجابة.' : question);
  const current = { role: 'user', content: hasImage ? text + ' [مرفق صورة — ستقرأ لاحقا في جولة الإجابة]' : text };
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
  // التطبيق خاص لرحمة — لا قيود
  return true;
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
  const text = clean(page?.text ?? page?.quotableText, MAX_PAGE_CHARS);
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
  const text = clean(quotation, MAX_PAGE_CHARS);
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
    ? clean(page?.text, MAX_PAGE_CHARS)
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
  const text = clean(page.text, MAX_PAGE_CHARS);
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
  sendImageToVision = true,
}) {
  const images = [];
  let currentBlock = block;
  // بلا نموذج بصري لا معنى لفتح صفحة ورسم صورتها: لا تُقرأ، فلا تصل، وتقتطع
  // ميزانية الوقت بلا فائدة. الصفحة المتضررة تبقى بوصفها الفهرسي وحده.
  if (!sendImageToVision) return { block: currentBlock, images };
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

async function retrieveExactPage({ bookId, printedPage, physicalPage, books, sources, step, deadlineAt = 0, canSee = false }) {
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

  step('pdf', 'أفتح الصفحة الأصلية', `${book?.title || bookId} — ${printedPage != null ? `الصفحة المطبوعة ${printedPage}` : `صفحة PDF ${resolvedPhysical}`}`);
  if (deadlineAt && Date.now() > deadlineAt) {
    step('pdf', 'تأخر فتح الصفحة', 'لن أضع في الإجابة صفحة لم أتحقق منها؛ سأقول للطلبة ما تعذّر التحقق منه');
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
      sendImageToVision: canSee,
    });
    if (evidence) return evidence;
  }

  if (indexedPage && !existing) {
    const citation = pageCitation(indexedPage, book, '', { bookId, printedPage, physicalPage: resolvedPhysical });
    const id = savePageCitation(sources, citation);
    citation.id = id;
    return { block: indexedPageBlock(indexedPage, citation), image: null, reliable: false };
  }
  step('pdf', 'لم أتأكد من هذه الصفحة', 'لم يتوفر نص سليم أو صورة أصلية قابلة للقراءة');
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

async function retrieveLocalEvidence(query, { bookId = '', subject = '', track, books, step, allowPdfFallback = true, deadlineAt = 0, sendImageToVision = false }) {
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
    const fallback = await searchPdfFallback(query, { track, subject, bookId, limit: 5, books, sources: retrieved.sources, pageHints, step, deadlineAt, sendImageToVision });
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
    quiz: { requested: quizRequest(question), questions: quizCount(question) },
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

// مخطط الكتاب لم يعد يُعرض بطاقة مصدر: بلا رقم صفحة وبوصف غير حرفي، كان
// يملأ شريط المصادر ويوهم الطالبة بأن الجواب من هناك. يبقى داخل الـprompt
// للتنقل فقط. الطالبة طلبت إزالة هذه البطاقة، وهذه هي الإزالة.
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
  // كل معرّف مصدر بين قوسين — مسموح كان أو مخترع — يُحذف من نص الطالبة. المصادر
  // لها بطاقاتها أسفل الرد، ورمز [S1] في متن الكلام كان يربك الطالبة ويوهمها
  // بإحالة لا وجود لها. الترشيح حتمي فلا يُعتمد على التزام النموذج وحده.
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
        // معرّف مصدر: يُحذف، ولا مسافة زائدة خلفه حتى لا تنكسر الجملة.
      } else {
        output += text.slice(open, close + 1);
      }
      cursor = close + 1;
    }
    if (final && pending) {
      if (!/^\[[A-Za-z]+\d{0,12}$/.test(pending)) output += pending;
      pending = '';
    }
    return output.replace(/( +)([،.,؛:!?؟])/g, '$2');
  };
  return { push: (chunk) => consume(chunk), finish: () => consume('', true), allowed };
}

function visionNotSupported(error){
  const msg = String(error?.message||error?.detail||'').toLowerCase();
  return msg.includes('image') && (msg.includes('not support') || msg.includes('cannot read') || msg.includes('vision'));
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
    const text = clean(pdf.text, MAX_PAGE_CHARS);
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
  // الخطوة المعروضة للطالبة قصيرة ودافئة بلا مصطلحات داخلية، والتفاصيل
  // التشخيصية تبقى في سجل الخادم. ما يراه الطالبة: «أفتح صفحة من كتابك».
  const step = (phase, label, detail = '') => {
    if (detail) console.log(`[${new Date().toISOString()}] ${phase}: ${label} — ${clean(detail, 200)}`);
    sseSend(res, 'step', { phase, label: clean(label, 90), at: Date.now() - started });
  };
  const session = safeSession(req.headers['x-session']);
  const canSee = supportsVision(config.model);
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
    const pageAsked = pageReference(question) != null;
    // سؤال «صفحة N» لا يحتاج مخطط نية: الرقم معطى، والكتاب يُحلّ محلياً من
    // اسم المادة. التخطيط هنا كان يضيف حتى ١٤ ثانية انتظاراً قبل أول حرف، ثم
    // بحثٌ عام يلوّث جواب صفحة محددة بصفحات كتب أخرى.
    const probeTrace = [];

    // سؤال الكتب يُحمَّل محلياً قبل التخطيط: قراءة فهرس داخلية بلا شبكة ولا
    // استدلال. هكذا لا يعجز النموذج عن قائمة الكتب حين يتأخر مخطط النية، وهي
    // الطريقة التي سرد بها كتباً لا وجود لها في منهجها.
    if (catalogQuestion(question) && !catalog) {
      try {
        catalog = await getCatalog({ track: globalCatalogRequest(question) ? '' : track });
        if (!catalog?.books?.length) catalog = null;
      } catch (error) {
        console.error('catalog pre-load failed:', error?.message || error);
      }
    }

    step('intent', 'أفهم طلبك', 'أبدأ بالمصادر المحلية');
    if (pageAsked) {
      plan = planDirect(question, subject);
    } else if (!needsPlannerBeforeLocal(question, hasImages)) {
      const query = clean(question, 400);
      const local = await retrieveLocalEvidence(query, {
        bookId: selectedBookId,
        subject,
        track,
        books,
        // أثر التتبّع يجمع ولا يُعرض:Probe قد ينتهي بأنه تحية أو سؤال خارجي،
        // ولا يجوز أن تشاهدي «بحثت في الكتب» في رد ودي.
        step: (info) => probeTrace.push(info),
        allowPdfFallback: false,
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
          step('intent', 'أفهم طلبك', 'تجاوز تخطيط الطلب وقته؛ أتابع بالبحث المحلي مباشرة');
          plan = fallbackPlan(question);
        } else {
          plannerError = error;
          console.warn('intent planning failed; using local-query fallback:', error?.message || error);
          step('intent', 'أفهم طلبك', 'تعذر تخطيط دقيق؛ سأعتمد على البحث المتاح ولن أنسب معلومة بلا دليل');
          plan = fallbackPlan(question);
        }
      }
    }

    const resolvedSubject = subject || plan.subject;
    // نتائج الاستطلاع تُعرض الآن فقط، حين ثبت أن الطلب طلب دراسي.
    if (plan.intent === 'curriculum' && probeTrace.length) {
      const replay = localTrace(step);
      probeTrace.forEach(replay);
    }
    // EARLY_CONVERSATION: if intent is pure conversation, answer directly without any retrieval
    if (plan.intent === 'conversation') {
      step('write','أفهمك','رد ودي بلا بحث في الكتب');
      const convoMessages = modelMessages(body, '', '', '', track, '', [], [], 'track', '', config.model);
      sseSend(res, 'citations', { items: [] });
      const roundBudget = Math.max(config.maxTokens, Number(config.visionMaxTokens) || 0);
      let out = '';
      try {
        for await (const event of streamCompletion({ endpoint: config.endpoint, key: config.key, model: config.model, messages: fitMessages(convoMessages, config, roundBudget), maxTokens: roundBudget, signal: abort.signal, session, onFirstToken: () => { firstTokenAt ||= Date.now(); step('write','أتحدث معك',''); } })) {
          if (event.type === 'text') { out += event.text; sseSend(res, 'delta', { text: event.text }); firstTokenAt ||= Date.now(); }
          if (event.type === 'done') break;
        }
        if (!out.trim()) out = 'أهلا يا رحمة! أنا هنا أساعدك دائما — كيف كانت مذاكرتك اليوم؟';
        providerHealth.verified = true; providerHealth.lastError = null; providerHealth.checkedAt = Date.now();
        sseSend(res, 'done', { finish: 'stop', firstTokenMs: firstTokenAt ? firstTokenAt - started : Date.now()-started, sources: 0 });
      } catch (e) {
        if (!abort.signal.aborted) sseSend(res, 'error', { error: 'UPSTREAM_FAILED', detail: '' });
      } finally { stopHeartbeat(); req.off?.('aborted', onClose); res.off?.('close', onClose); if(!res.writableEnded) res.end(); }
      return;
    }
    // كتالوج المسار يُحمَّل في كل طلب دراسي لا عند سؤال الكتب وحده. قاعدة
    // «لا تختلقي كتاباً ولا مادة» لا تُطبَّق إلا إذا كانت البيانات أمام
    // النموذج: بلاه كانت «خطة المذاكرة» تُبنى على مواد لا وجود لها (C16).
    // القراءة محلية من الفهرس المحمّل أصلاً، فالكلفة صفر تقريباً.
    if (!catalog) {
      try {
        catalog = await getCatalog({ track: plan.catalogScope === 'global' ? '' : track });
        if (!catalog?.books?.length) {
          console.warn('catalog is empty for this scope; the model will not invent a list');
          catalog = null;
        } else if (plan.catalogScope === 'global') {
          books = catalog.books;
        }
      } catch (error) {
        console.error('catalog load failed:', error?.message || error);
        catalog = null;
      }
    }

    selectedBookId = books.some((book) => book.id === requestedBookId) ? requestedBookId : '';
    if (selectedBookId) resolvedBook = books.find((book) => book.id === selectedBookId) || null;
    const printedPage = plan.exactPage.printedPage ?? pageReference(question);
    const physicalPage = plan.exactPage.physicalPage;

    // ── صفحات الطالبة: تُحلّ أولاً لأنها تحدد أي كتاب يُبحث فيه ────────────
    // «صفحة ٢٢» بلا مادة لا يجوز أن تُنسب إلى أول كتاب في القائمة؛ إما أن
    // تُسمّي الطالبة الكتاب، أو نسألها عنه. لا داعي لمخطط نية أصلاً هنا.
    const pageRequests = extractPageRequests(question, books);
    if ((printedPage != null || physicalPage != null) && !pageRequests.some((r) => r.printedPage === printedPage)) {
      pageRequests.unshift({ printedPage, physicalPage, bookHint: plan.bookQuery || '' });
    }
    const resolvedRequests = [];
    let ambiguousHint = '';
    for (const req of pageRequests.slice(0, 4)) {
      if (req.printedPage == null && req.physicalPage == null) continue;
      let bid = '';
      const hintNorm = normalizedQuestion(req.bookHint || '');
      // اسم مادة مطابق تماماً لمواد كتابين = كتابان للصفحة نفسها («اللغة
      // العربية» جزء أول وجزء ثانٍ). النحو جزء من اللغة لا كتابها، فاختياره
      // هنا هو سبب «شرح صفحة من كتاب آخر». يُترك بلا اختيار فتسأل الطالبة.
      const exactSubject = hintNorm.length >= 3
        ? books.filter((book) => normalizedQuestion(book.subject || '') === hintNorm)
        : [];
      if (exactSubject.length === 1) {
        bid = exactSubject[0].id;
      } else if (exactSubject.length > 1) {
        console.warn(`page hint "${req.bookHint}" matches ${exactSubject.length} books; asking instead of guessing`);
        ambiguousHint = req.bookHint;
        continue;
      }
      if (!bid && req.bookHint) {
        try {
          const rb = await resolveBook(req.bookHint, { subject: resolvedSubject, track, search: true });
          if (rb?.id) bid = rb.id;
        } catch { /* لا كتاب مؤكد */ }
      }
      if (!bid || !books.some((b) => b.id === bid)) {
        if (hintNorm.length >= 3) {
          const cand = books.find((b) => normalizedQuestion(`${b.title || ''} ${b.subject || ''}`).includes(hintNorm)
            || (normalizedQuestion(b.subject || '').length >= 3 && normalizedQuestion(b.subject || '').includes(hintNorm)));
          if (cand) bid = cand.id;
        }
      }
      // كتاب العميل (اختيار صريح في الواجهة) حجّة قاطعة، أما غيابها فلا.
      if (!bid && !req.bookHint && selectedBookId) bid = selectedBookId;
      if (bid) resolvedRequests.push({ ...req, bookId: bid });
    }
    // صفحة بلا كتاب مؤكد: لا تخمين. نسأل الطالبة، ولا نفتح ولا نعرض.
    const ambiguousPage = pageRequests.length > 0 && resolvedRequests.length === 0;
    if (ambiguousPage && !ambiguousHint) ambiguousHint = pageRequests.find((req) => req.bookHint)?.bookHint || '';

    const shouldResolveBook = !pageAsked && Boolean(plan.bookQuery || plan.useOutline || printedPage != null || physicalPage != null);
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
        step('book', 'تحققت من طلبك', 'لن أختار كتابًا عشوائيًا أو أنسب الصفحة إلى كتاب غير متحقق');
      }
    }
    if (!resolvedBook && shouldResolveBook && !bookResolutionFailed) {
      step('book', 'تحققت من طلبك', 'لم أجد كتابًا مطابقًا يمكن التحقق منه؛ لن أخمّن اسم الكتاب');
    }
    const targetBookId = resolvedRequests[0]?.bookId || (ambiguousPage ? '' : selectedBookId || resolvedBook?.id || '');
    if (!resolvedBook && targetBookId) resolvedBook = books.find((book) => book.id === targetBookId) || null;
    if (ambiguousPage) {
      step('book', 'أحتاج توضيحاً واحداً', 'لم تسمّي الكتاب الذي تقصدين صفحته، وكل الكتب لها صفحة رقمها نفسه');
    }
    if ((plan.useOutline || printedPage != null || physicalPage != null) && targetBookId) {
      try {
        outline = await getOutline(targetBookId);
        if (outline) {
          const bookMeta = resolvedBook || books.find((book) => book.id === targetBookId) || null;
          step('outline', 'فتحت فهرس الكتاب', `${bookMeta?.subject || bookMeta?.title || targetBookId} — ${outline.entries} صفحة مفهرسة`);
        } else if (plan.useOutline) {
          step('outline', 'مخطط الكتاب غير متاح', 'لن أستنتج ترتيب الفصول أو أرقام الصفحات من دون فهرس');
        }
      } catch (error) {
        console.error('outline load failed:', error?.message || error);
        step('outline', 'تعذر تحميل مخطط الكتاب', 'لن أستنتج ترتيب الفصول أو أرقام الصفحات من دون فهرس');
      }
    } else if (!ambiguousPage) {
      step('subject', 'حددت المسار الدراسي', `سأبحث في كتب مسار ${track} المتاحة`);
    }

    // طلب صفحة محددة لا يُعطى بحثاً عاماً: صفحات كتب أخرى كانت تُقرأ جواباً
    // على صفحة لم تُفتح، وتضاعف حجم الـprompt فيتحول إلى انتظار.
    const wantGenericSearch = plan.useLocal && !pageAsked;
    if (wantGenericSearch) {
      const localBookId = selectedBookId || (plan.useOutline ? outline?.bookId || targetBookId : '');
      const query = plan.localQuery || question;
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
          sendImageToVision: canSee,
        });
        retrieved = local.retrieved;
        retrievedImage = local.image;
      }
    } else {
      retrieved = { block: '', sources: [] };
      retrievedImage = null;
    }

    let exactPage = { block: '', image: null, reliable: false, citations: [] };
    let extraExactBlocks = [];
    let extraExactImages = [];
    const exactResults = [];
    if (resolvedRequests.length) {
      step('pdf', 'أفتح الصفحات المطلوبة', resolvedRequests.map(r=> 'ص'+r.printedPage+' '+ (books.find(b=>b.id===r.bookId)?.title||r.bookId).slice(0,18)).join('، '));
      const results = await Promise.all(resolvedRequests.map(r=> retrieveExactPage({ bookId: r.bookId, printedPage: r.printedPage, physicalPage: r.physicalPage, books, sources: retrieved.sources, step, deadlineAt: retrievalDeadlineAt, canSee })));
      for (let i=0;i<results.length;i++){
        const res = results[i];
        if (!res || (!res.block && !res.image)) continue;
        exactResults.push(res);
        if (i===0) { exactPage = res; if (res.citation?.id) retrieved.block = withoutSourceBlock(retrieved.block, res.citation.id); }
        else {
          if (res.block) extraExactBlocks.push(res.block);
          if (res.image) extraExactImages.push(res.image);
          if (res.citation?.id) retrieved.block = withoutSourceBlock(retrieved.block, res.citation.id);
        }
      }
      exactPage.extraBlocks = extraExactBlocks;
      exactPage.extraImages = extraExactImages;
    } else if (targetBookId && (printedPage != null || physicalPage != null)) {
      exactPage = await retrieveExactPage({ bookId: targetBookId, printedPage, physicalPage, books, sources: retrieved.sources, step, deadlineAt: retrievalDeadlineAt, canSee });
      if (exactPage.citation?.id) retrieved.block = withoutSourceBlock(retrieved.block, exactPage.citation.id);
      if (exactPage.block || exactPage.image) exactResults.push(exactPage);
      exactPage.extraBlocks = []; extraExactBlocks = []; extraExactImages = [];
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
      sendImageToVision: canSee,
    });
    retrieved.block = damagedVision.block;

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
          step('web', 'أبحث في الويب بعد مصادر المنهج', 'web search enabled; preferring official Iraqi curriculum sources');

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
        // «البحث الخارجي غير مهيأ» معلومة إعداد داخلية: كشف WEB_SEARCH_API_KEY
        // للطالبة يربكها ويوهمها بأن النتيجة ناقصة بسبب التطبيق.
        console.warn(`web search unavailable (key=${webConfig.key ? 'set' : 'missing'})`);
      }
    }

    const exactBlockId = blockIdOf(exactPage.block);
    const exactSource = exactBlockId ? retrieved.sources.find((source) => source.id === exactBlockId) : null;
    // كتلة الصفحة تُسقط إن كان مصدرها تالفاً غير قابل للنقل. أمّا الوصف
    // الفهرسي المُعلَن داخلها ([نوع الدليل: وصف فهرسي غير حرفي]) فباقٍ: هو
    // الطريق الوحيد لشرح معنى صفحة بلا طبقة نص، وقواعد البرومبت تمنع نقله
    // حرفياً. إسقاطه كان يجعل البوابة تتكلم عن دليل لم يوصل.
    const exactBlockIsDescription = /وصف فهرسي غير حرفي|نص مستخرج من PDF ناقص/.test(String(exactPage.block || ''));
    const exactPageBlock = exactBlockId && exactSource && !answerCitationSource(exactSource) && !exactBlockIsDescription
      ? ''
      : exactPage.block;

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

    // ── بوابة الصدق: صفحة طلبتها الطالبة ولم تُفتح ⇒ لا جواب من ذاكرة ────────
    // وجود صفحات من كتب أخرى في السياق كان هو سبب «شرح صفحة ٢٢ رياضيات» من
    // كتاب النحو: النموذج لم يجد طلبها فأجاب ممّا وجد. هنا يُحذف تشويش البحث
    // العام، وتُوضع قاعدة صريحة: لا وصف لهذه الصفحة، لا تختلقي واحدة.
    const exactReliable = exactResults.some((result) => result?.reliable);
    const exactHasBlock = exactResults.some((result) => result?.block);
    // البطاقات لصفحات لم تُفتح تُسقط كلها: الطالبة كانت ترى مصدراً بلا رقم
    // صفحة وتظن أن الجواب منها.
    const pageGate = (pageAsked || ambiguousPage) && !exactReliable;
    const gateSources = pageGate ? [] : orderedSources;
    // 3) موثوقية الدليل: ما لا يصلح للإسناد يخرج من السياق ومن الإحالات معًا،
    //    حتى لا يستشهد النموذج بدليل لا تحتمله الصفحة.
    const shownSources = gateSources.filter(answerCitationSource)
      .filter((source) => source.physicalPage != null || source.printedPage != null)
      .slice(0, MAX_CITED_SOURCES);
    const uncitable = new Set(gateSources.filter((source) => !answerCitationSource(source)).map((source) => source.id));
    const extraExactBlock = (exactPage.extraBlocks || []).join('\n\n---\n\n');
    const localBlock = [
      pageGate ? '' : filterLocalBlock(orderedBlock, uncitable),
      exactPageBlock,
      extraExactBlock,
    ].filter(Boolean).join('\n\n---\n\n');
    // البوابة تُشتق من ما في البرومبت فعلاً لا ممّا نُيّته: كتلة الصفحة قد
    // تُسقط لمصادر غير صالحة، فلو صفّرنا «غير حرفي» من نية كتلة محذوفة
    // لِما تغيّر السلوك إلا الكلام: النموذج يُقال عنه إن وصله وصفٌ وهو غائب.
    const exactTextInPrompt = Boolean(exactPageBlock || extraExactBlock);
    const gateBlock = ambiguousPage
      ? `## توضيح مطلوب قبل أي شرح\n${ambiguousHint
        ? `ذكرت الطالبة «${ambiguousHint}» وهو اسم مادة لكتبها أكثر من جزء واحد، فالصفحة ${printedPage ?? ''} تختلف من كتاب لآخر. اسأليها سؤالاً واحداً قصيراً تسمّين فيه الجزء المطلوب${ambiguousHint === '' ? '' : ''}. ولا تختاري كتاباً ولا صفحة ولا تشرحي صفحة من كتاب آخر.`
        : 'طلبت الطالبة رقم صفحة ولم تسمِّ الكتاب الذي تقصده، وكل كتاب في مسارها يحمل صفحات بنفس الأرقام. اسأليها سؤالاً واحداً قصيراً: من أي كتاب الصفحة؟ ولا تختاري كتاباً ولا صفحة ولا تشرحي صفحة من كتاب آخر.'} ولا تسردي كتباً بصيغة «من المعتاد».`
      : pageGate && !exactTextInPrompt
        ? `## الصفحة المطلوبة لم تُفتح\nلم أصل إلى نص سليم من الصفحة ${printedPage ?? ''} المطلوبة ولا إلى صورة قابلة لقراءتها، ولا حتى إلى وصف فهرسي لها، فلا دليل لك عن محتواها. ممنوع عليكِ وصف هذه الصفحة أو تمثيل مضمونها أو ذكر عنوانها الفرعي أو تمارينها أو أمثلتها من ذاكرتك. قولي للطالبة بصراحة وبسطرين إن النص الرقمي لهذه الصفحة لم يظهر لها، واعرضي إن أرادت ما تعرفينه عن الموضوع العام بصيغة «من معرفتي بالمنهج»، مع دعوة صريحة لمراجعة الصفحة في كتابها. ولا تعتذري بأنك بلا وصول، ولا تطلبي منها كتابة النص.`
        : pageGate
          ? '## دليل الصفحة غير حرفي\nما وصل عن هذه الصفحة هو وصف فهرسي أو نص مستخرج موسوم بالتلف، وليس نص الصفحة السليم. اشرحي المعنى والفكرة العامة استناداً إليه، واذكري بوضوح أن ما قلته «من وصف الفهرس لا من نص الصفحة». ممنوع نسخ عبارة أو آية أو حديث أو رقم أو مثال بوصفه من الكتاب. ولا تسألي الطالبة عن نص الصفحة ولا تعتذري بأنك بلا وصول.'
          : '';
    const externalBlock = webEvidenceBlock(webSources);
    // ترتيب الصور: صفحة الطالب أولًا، ثم الصفحة المطلوبة بالضبط، ثم أقوى
    // صفحة داكنة الفهرس التي فُتحت، ثم مرشح البحث العام.
    const extraImages = [exactPage.image, ...(exactPage.extraImages||[]), ...damagedVision.images, retrievedImage].filter(Boolean).slice(0, MAX_EVIDENCE_IMAGES);
    const primaryBlock = primaryBook
      ? `${primaryBook.title}${primaryBook.subject ? ` — ${primaryBook.subject}` : ''}`
      : '';
    // بطاقات المصادر: صفحات قابلة للإسناد فقط، وبحدّ أعلى. مخطط الكتاب يبقى
    // في الـprompt للتنقل ولا يظهر بطاقة بلا رقم صفحة («رقم الصفحة غير متاح»)
    // كانت تضلل الطالبة، والمقصود منها شرح صفحة لا فهرسة كتب.
    const allSources = citationSources([
      ...shownSources,
      ...(catalogAnswersRequest && catalogBlock ? [catalogCitation(catalog, plan.catalogScope, track)] : []),
      ...webSources,
    ]);
    const quizBlock = plan.quiz?.requested ? quizInstruction(plan.quiz.questions) : '';
    const messages = modelMessages(body, localBlock, outlineBlock, catalogBlock, track, externalBlock, extraImages, allSources.map((source) => source.id), plan.catalogScope, primaryBlock, config.model, gateBlock, quizBlock);
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
      // جولة إصلاح الاختبار: نطلب الكتلة وحدها، فتبقى مقدمة الرد السابقة سليمة
      // وتُضاف البطاقة تحتها بدل إعادة توليد الرد كاملاً.
      const quizMissing = Boolean(plan.quiz?.requested) && !quizBlockPresent(output);
      const roundMessages = round === 0
        ? messages
        : quizMissing
          ? [
            ...messages,
            { role: 'assistant', content: output },
            { role: 'user', content: `الاختبار لم يأتِ في الصورة المطلوبة فلم تظهر أزراره للطالبة. أجيبي الآن بكتلة الاختبار فقط، بلا أي شرح أو مقدمة: سطر \`\`\`quiz ثم كائن JSON فيه ${arNumber(plan.quiz.questions >= 2 ? plan.quiz.questions : 10)} أسئلة (كل سؤال q وخيارات options ورقم الصحيح في answer يبدأ من 0 وwhy للسبب) ثم سطر \`\`\` يغلقها. لا تكتب شيئاً خارج الكتلة.` },
          ]
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

      // اختبار بلا كتلة quiz = اختبار نصي غير قابل للنقر. جولة إصلاح واحدة
      // فقط، والمحتوى السابق يبقى كما هو ثم تُضاف البطاقة، فلا يُعاد كل الرد.
      if (plan.quiz?.requested && !quizBlockPresent(output)) {
        if (round + 1 < MAX_ANSWER_ROUNDS) {
          step('write', 'أجهّز بطاقة الاختبار', 'لم تأتِ الاختبارات بالشكل التفاعلي المطلوب؛ أطلبها الآن بصيغتها الصحيحة');
          continue;
        }
      }

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
      if (visionNotSupported(error)){
        // القاعدة: لا نطلب من الطالبة كتابة نص الصفحة. الرسالة تصف العطل كما هو.
        sseSend(res, 'error', { error: 'VISION_NOT_SUPPORTED', detail: `النموذج المشغّل حالياً (${clean(config.model, 60)}) لا يقرأ الصور. سأشرح لك الموضوع من نصوص كتبك؛ ولقراءة صورة worksheet اختاري نموذجاً يدعم الرؤية من الإعدادات.` });
      } else {
        const code = errorCode(error);
        if (config.key) { providerHealth.verified = false; providerHealth.lastError = code; providerHealth.checkedAt = Date.now(); }
        const known = ['EMPTY_REPLY', 'REPLY_TOO_LONG', 'REPLY_TRUNCATED', 'REPLY_FILTERED', 'MODEL_TOOL_CALLS_UNSUPPORTED'];
        sseSend(res, 'error', { error: known.includes(error?.message) ? error.message : code, detail: clean(error?.detail, 180) });
      }
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
    // الكاميرا مسموحة للتطبيق نفسه: input[type=file][capture] يحتاجها على
    // الجوال لالتقاط صورة صفحة مباشرة. المنع الكامل كان يجعل الخيار بلا أثر.
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
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
server.listen(port, '0.0.0.0', () => {
  console.log(`Mualimi 3 ready on :${port}`);
  // تسخين محرك PDF وفهرس الكتب بعد الإقلاع: تحميل pdfjs يكلّف ثوانٍ
  // كانت كلها تُدفع على أول طلب صفحة، وهي أبطأ نقطة في المسار كله.
  setTimeout(() => {
    import('./lib/pdf-fallback.mjs').then((module) => module.warmPdfRuntime?.()).catch(() => {});
    corpusIndex.getIndex?.().catch(() => {});
  }, 1_000).unref?.();
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
