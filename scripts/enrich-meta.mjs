import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const PATCH_DIR = path.join(LIBRARY, 'reports', 'patches');
// الترقيعات المرفوضة خارج PATCH_DIR عمداً: apply-page-patches.mjs يقرأ كل *.json من PATCH_DIR.
const REJECT_DIR = path.join(LIBRARY, 'reports', 'patches-rejected');
const AUTH_FILE = 'C:/Users/m/.local/share/opencode/auth.json';
const BATCH = 8;
const TIMEOUT_MS = 180_000;

// حدّ النص المُرسل للنموذج. قياس على المكتبة الحالية (2342 صفحة):
// p50=1184 · p90=1960 · p95=2239 · p99=2993 · أقصى=4020 محرف. فـ6000 يغطّي كل صفحة بلا قصّ.
// ما تجاوز 6000 يُرسل موزّعاً (رأس + وسط + ذيل) بدل بتر الذيل بصمت.
const TEXT_LIMIT = 6000;
const SAMPLE_SEGMENT = 2000;

const TITLE_MAX = 90;
const SUMMARY_MIN = 90;
const PURPOSE_MIN = 60;
const PURPOSE_MAX = 200;
const MAX_REPAIR_ROUNDS = 2;
const MAX_ATTEMPTS = 3;
const PAGE_TEXT_MIN = 40;

// حواجز التلف المنقولة من build-index.mjs:13-17 و lib/index.mjs:14 (نسخ محلي، بلا استيراد).
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
const REPLACEMENT_CHAR = /[\uFFFD\uE000-\uF8FF]/;
const PRESS_FILE = /IRAQ_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.indb(?:[ \t]*\d{1,4})?/;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/;

// العنوان الذي يعكس الترقيم («ص 5» / «صفحة 12» / «- 29 -» / «p.3»). «(ص)» وحدها تشريف
// النبي ﷺ ولا تُعدّ ترقيماً، لذلك لا تُطابَق بلا رقم بعدها.
const FOLIO = /(?:\(\s*(?:ص|صفحه|صفحة|page)\s*[-:]?\s*\d{1,4}\s*\)|(?:^|\s)(?:ص|صفحه|صفحة|page)\s*[-:]?\s*\d{1,4}(?=\s|$)|-\s*\d{1,4}\s*-\s*$|\bp{1,2}\.\s*\d{1,4}\b)/i;

const DIACRITICS = /[\u064B-\u0652\u0640]/g;
const normalizeAr = (value) => String(value ?? '')
  .replace(DIACRITICS, '')
  .replace(/[أإآٱ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه')
  .replace(/[ؤئ]/g, 'ء')
  .replace(/\s+/g, ' ')
  .trim();

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// قوالب ميتة مقيسة على المكتبة الحالية (822+242+166+…) — أي إسناد إليها من توليد جديد مرفوض.
// النمط يُبنى من نصوصه بعد التطبيع، وإلا لم يطابق «الامثله» Normalized بنمط «الأمثلة».
const DEAD_TEMPLATE_LIST = [
  'نص الصفحة مستخرج من كتاب',
  'صفحة مصورة من كتاب',
  'محتوى الصفحة:',
  'استخراج محتوى الصفحة من الصورة',
  'قراءة التعريفات والأمثلة والمحتوى التعليمي',
  'تطبيق المفاهيم والتدرب على نمط الأسئلة',
  'شرح درس أو وحدة من المنهج',
  'تحديد موضوعات الكتاب ومواقعها',
  'مراجعة وتثبيت المعلومات',
  'تعزيز الفهم للمفاهيم الأساسية',
];
const DEAD_TEMPLATE = new RegExp(`^(?:${DEAD_TEMPLATE_LIST.map((item) => escapeRe(normalizeAr(item))).join('|')})`);

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return fallback;
  const found = args[index];
  if (found.includes('=')) return found.slice(found.indexOf('=') + 1);
  const next = args[index + 1];
  if (next && !next.startsWith('--')) return next;
  return true;
}
const ONLY_BOOK = flag('book', null);
const LIMIT = Number(flag('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency', 6)) || 6));
const DRY_RUN = Boolean(flag('dry-run'));
const REDO = Boolean(flag('redo', false));
const REQUIRED = String(flag('require', 'title,summary,educationalPurpose'))
  .split(',').map((item) => item.trim()).filter(Boolean);
const OPTIONAL = ['section', 'unit'];
const ASKED = [...REQUIRED, ...OPTIONAL];

function loadDotEnv() {
  const env = {};
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch { /* بدون env */ }
  return env;
}

function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('b64:')) return text;
  try { return Buffer.from(text.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
}

const MODEL = (() => {
  const model = String(loadDotEnv().AI_MODEL || 'mimo-v2.6-flash').trim();
  const aliases = { 'MiMo-V2.6-Flash': 'mimo-v2.6-flash', 'MiMo-V2.6-Pro': 'mimo-v2.6-pro' };
  return aliases[model] || model || 'mimo-v2.6-flash';
})();

const endpoint = (() => {
  const raw = String(loadDotEnv().AI_ENDPOINT || 'https://opencode.ai/zen/go/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
})();

async function collectKeys() {
  const keys = [];
  const fromEnv = decodeKey(loadDotEnv().AI_API_KEY || '');
  if (fromEnv) keys.push(fromEnv);
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    for (const entry of Object.values(auth)) if (entry?.key) keys.push(entry.key);
  } catch { /* بدون مفاتيح إضافية */ }
  return [...new Set(keys.filter(Boolean))];
}

const PROMPT = [
  'أنت محرر محتوى لمنصة تعليمية. سأعطيك نصوص صفحات من كتاب مدرسي، لكل صفحة عنصر.',
  'اكتب لكل عنصر الحقول المطلوبة فقط، بناءً على نص عنصره وحده:',
  `- title: عنوان دقيق لمحتوى هذه الصفحة (${TITLE_MAX} حرفًا كحد أقصى). عنوان موضوعي كـ«قواعد الإعراب: أدوات النفي»، لا «تكملة» ولا «لا عنوان جديد» ولا رقم صفحة ولا سطر الترويسة.`,
  `- summary: من ${SUMMARY_MIN} إلى 400 حرف تصف الصفحة كلها: ماذا تعرض (تعريف/قاعدة/نص/مخطط/جدول/تمرين) وأي مصطلحات وردت فيه، وما الذي يليه في الصفحة التالية إن ذُكر.`,
  '- educationalPurpose: جملة واحدة من 60 إلى 180 حرفًا تصف المهمة التربوية لهذه الصفحة بعينها: ماذا يفعل الطالب فيها (يقرأ، يستنتج، يحل، يقارن، يلخص) وعلى أي مفهوم أو مصطلح يعمل. لا جمل عامة تصلح لكل صفحات الكتاب.',
  '- section: اسم الدرس أو القسم إن ورد في النص، وإلا فارغ.',
  '- unit: اسم الوحدة أو الفصل إن ورد في النص، وإلا فارغ.',
  'قواعد ملزمة:',
  '1. كل جملة يجب أن يستندها إلى نص الصفحة. لا تخترع أسماء أشخاص أو كتب أو أحزاب أو مواد لم ترد في النص.',
  '2. لا تنسب محتوى الصفحة إلى كتاب أو مادة غير هذا الكتاب إطلاقًا، حتى لو ذُكر اسم كتاب آخر في تذييل الصفحة أو في OCR تالف.',
  '3. لا تكرر صياغة صفحة أخرى: كل صفحة تُوصف بمحتواها الخاص.',
  '4. اكتب بلغة النص (عربي للعربية وإنكليزية للإنكليزية).',
  '5. تجاهل أرقام صفحات PDF وأسماء الملفات وسطور الترويسة والتذييل وحروف المصنع وتواريخ الطباعة.',
  '6. إن كان النص المُرسل عيّنة موزّعة من صفحة طويلة (فواصل «وسط الصفحة» و«ذيل الصفحة» ظاهرة)، فالوصف يجب أن يغطي الصفحة كلها بما فيها الذيل.',
  '7. لا تضف أي نص خارج JSON.',
  `أعد JSON فقط بالشكل {"results":[{"id":"...","title":"...","summary":"...","educationalPurpose":"...","section":"...","unit":"..."}]}.`,
].join('\n');

function repairPrompt(problems) {
  return [
    'المحاولة السابقة رُفضت. أصلحها وفق الأخطاء المرفقة لكل عنصر، وأعد JSON كاملاً لنفس العناصر فقط.',
    'الأخطاء بصيغة {"id":"...","errors":["..."]}. لا تعيد نفس الصياغة المرفوضة.',
    JSON.stringify({ problems }),
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionSeq = 0;
const sessionId = () => `mualimi-meta-${process.pid}-${(sessionSeq += 1)}`;

function parseJson(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], text] : [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* التالي */ }
  }
  return null;
}

let activeKeys = [];

async function probeKey(key) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': `probe-${process.pid}-${Date.now()}` },
      body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    await response.text().catch(() => '');
    return response.ok;
  } catch { return false; }
}

async function callModel(payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && activeKeys.length; attempt += 1) {
    const key = activeKeys[0];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': sessionId() },
        body: JSON.stringify({ model: MODEL, stream: false, temperature: 0.3, max_tokens: 6000, messages: [{ role: 'user', content: payload }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        activeKeys.shift();
        lastError = new Error(`مفتاح مرفوض ${response.status}`);
        continue;
      }
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status} ${raw.slice(0, 160)}`);
      const json = JSON.parse(raw);
      const content = String(json?.choices?.[0]?.message?.content || '');
      if (!content) throw new Error('رد فارغ');
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1_200 * attempt);
    }
  }
  throw lastError || new Error('فشل');
}

await mkdir(PATCH_DIR, { recursive: true });
await mkdir(REJECT_DIR, { recursive: true });

const patchFiles = (await readdir(PATCH_DIR)).filter((name) => name.endsWith('.json') && !name.startsWith('rejected-'));
const bookFiles = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json')).sort();
const books = new Map();
for (const name of bookFiles) {
  const book = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
  books.set(book.id, book);
}

// ---------------------------------------------------------------------------
// معجم المواد: يُشتق من subject/title لكل كتاب. يُستخدم لحجب إسناد نص إلى مادة غير
// معرّف الكتاب (المقياس: ص106 من fiqh-shafii كانت تنسب نفسها إلى «كتاب اللغة العربية»).
// ---------------------------------------------------------------------------
function subjectPhrases(book) {
  const out = new Set();
  const push = (value) => {
    const text = normalizeAr(value);
    if (!text) return;
    const words = text.split(/[^ء-يa-z0-9]+/).filter(Boolean);
    if (words.length >= 2) out.add(text);
    if (words.length >= 3) out.add(words.slice(0, 2).join(' '));
  };
  push(book.subject);
  push(String(book.subject || '').split('—')[0]);
  push(book.title);
  return out;
}

const ownPhrases = new Map([...books.values()].map((book) => [book.id, subjectPhrases(book)]));
function foreignSubjects(bookId) {
  const mine = ownPhrases.get(bookId) || new Set();
  const out = new Set();
  for (const [id, phrases] of ownPhrases) {
    if (id === bookId) continue;
    for (const phrase of phrases) if (!mine.has(phrase)) out.add(phrase);
  }
  return [...out].filter((phrase) => phrase.length >= 6).sort((a, b) => b.length - a.length);
}
const foreignCache = new Map([...books.keys()].map((id) => [id, foreignSubjects(id)]));

// ---------------------------------------------------------------------------
// السبب الجذري لغياب educationalPurpose: بوابة «تم» كانت على مستوى الصفحة لا الحقل،
// والحقل نفسه كان يُكتب بشرط (سطر الحقل الاختياري عند بناء الترقيعة) فيُحذف بصمت إن
// تركه النموذج. ف صفحة لها title وsummary تُعدّ «منجزة» فلا يُعاد توليدها أبداً،
// ويبقى educationalPurpose ناقصاً فيها دائماً (822+242+166 تكرار حرفي مقيس).
// ---------------------------------------------------------------------------
const doneFields = new Map();
for (const name of patchFiles) {
  let raw;
  try { raw = JSON.parse(await readFile(path.join(PATCH_DIR, name), 'utf8')); }
  catch { continue; }
  const entries = Array.isArray(raw) ? raw : raw.patches || [];
  for (const entry of entries) {
    if (!entry?.bookId || !entry?.physicalPage) continue;
    const key = `${entry.bookId}:${entry.physicalPage}`;
    const set = doneFields.get(key) || new Set();
    for (const field of ASKED) {
      if (typeof entry[field] === 'string' && entry[field].trim()) set.add(field);
    }
    doneFields.set(key, set);
  }
}

// دفتر المحاولات المرفوضة: يمنع إعادة سؤال الصفحة نفسها إلى الأبد.
const attempts = new Map();
for (const name of (await readdir(REJECT_DIR)).filter((file) => file.endsWith('.json'))) {
  let raw;
  try { raw = JSON.parse(await readFile(path.join(REJECT_DIR, name), 'utf8')); }
  catch { continue; }
  for (const item of raw?.rejects || []) {
    const key = `${item.bookId}:${item.physicalPage}:${item.field}`;
    attempts.set(key, (attempts.get(key) || 0) + 1);
  }
}

// قيم مُولَّدة خلال هذه الجلسة — لكشف التكرار الحرفي عبر الدُفعات (لا داخل الدفعة فقط).
const seenInRun = new Map();
const rejectRows = [];
const rejectCodes = new Map();
function noteReject(row) {
  rejectRows.push(row);
  rejectCodes.set(row.code, (rejectCodes.get(row.code) || 0) + 1);
}

function valueProblems(field, value, bookId, ownText) {
  const problems = [];
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return ['EMPTY'];
  if (SERIALIZED_FIELD.test(text)) problems.push('SERIALIZED_JSON');
  if (CJK.test(text)) problems.push('CJK');
  if (REPLACEMENT_CHAR.test(text)) problems.push('U_FFFD');
  if (PRESS_FILE.test(text) || PRESS_STAMP.test(text)) problems.push('PRESS_SLAB');
  if (DEAD_TEMPLATE.test(normalizeAr(text))) problems.push('DEAD_TEMPLATE');
  if (FOLIO.test(text)) problems.push('FOLIO_IN_TEXT');
  const foreign = foreignCache.get(bookId) || [];
  const normalized = normalizeAr(text);
  const own = normalizeAr(ownText || '');
  const hit = foreign.find((phrase) => normalized.includes(phrase) && !(own.length >= 300 && own.includes(phrase)));
  if (hit) problems.push(`FOREIGN_SUBJECT:${hit}`);
  if (field === 'title') {
    if (text.length > TITLE_MAX) problems.push(`TITLE_TOO_LONG:${text.length}`);
    if (FOLIO.test(text)) problems.push('TITLE_FOLIO');
  }
  if (field === 'summary' && text.length < SUMMARY_MIN) problems.push(`SUMMARY_TOO_SHORT:${text.length}`);
  if (field === 'educationalPurpose') {
    if (text.length < PURPOSE_MIN) problems.push(`PURPOSE_TOO_SHORT:${text.length}`);
    else if (text.length > PURPOSE_MAX) problems.push(`PURPOSE_TOO_LONG:${text.length}`);
  }
  return [...new Set(problems)];
}

function clipField(field, text) {
  if (field === 'title') return text.slice(0, TITLE_MAX);
  if (field === 'summary') return text.slice(0, 600);
  if (field === 'educationalPurpose') return text.slice(0, 400);
  return text.slice(0, 200);
}


// --self-test: إثبات بلا شبكة لقواعد الرفض. يخرج قبل أي مفتاح أو طلب شبكة.
if (Boolean(flag('self-test'))) {
  const OWN = 'صفحة فيها نص كافٍ يذكّر الكتاب نفسه repeatedly with enough words to pass the own-text allowance rule for foreign subjects.';
  const cases = [];
  const check = (label, field, value, bookId, expect) => {
    const got = valueProblems(field, value, bookId, OWN);
    const pass = expect.every((code) => got.some((item) => item.startsWith(code)));
    cases.push(`${pass ? 'PASS' : 'FAIL'}  ${label}  ⇒ [${got.join(', ')}]`);
  };
  check('قالب ميت 43 محرفاً', 'educationalPurpose', 'قراءة التعريفات والأمثلة والمحتوى التعليمي.', 'islamic-sixth-preparatory-2025', ['DEAD_TEMPLATE', 'PURPOSE_TOO_SHORT']);
  check('قالب الاستيراد', 'summary', 'نص الصفحة مستخرج من كتاب الحديث؛ راجعي المقتطف أو افتحي الصفحة للتفاصيل.', 'hadith-deni-sixth', ['DEAD_TEMPLATE']);
  check('عنوان 120 محرفاً', 'title', 'قواعد الإعراب: أسلوب التمني والنداء والاستفهام مع التطبيق على الأمثلة shale'.padEnd(120, '٠'), 'arabic-sixth-preparatory-part-1-2025', ['TITLE_TOO_LONG']);
  check('عنوان يعكس الترقيم', 'title', 'النحو الواضح في قواعد اللغة العربية - 29 -', 'arabic-grammar-deni-sixth', ['FOLIO_IN_TEXT', 'TITLE_FOLIO']);
  check('عنوان فيه «ص 5»', 'title', 'شرح الآيات (ص 5) من سورة البقرة', 'islamic-sixth-preparatory-2025', ['FOLIO_IN_TEXT', 'TITLE_FOLIO']);
  check('إسناد إلى مادة أخرى', 'summary', 'صفحة شبه فارغة من كتاب اللغة العربية، تحتوي على عبارة ورقم الصفحة 102 في الأسفل.', 'fiqh-shafii-deni-sixth', ['FOREIGN_SUBJECT:اللغه العربيه']);
  check('JSON مخزَّن كنص', 'title', '{"text":"Round up', 'student-book-sixth-pdf', ['SERIALIZED_JSON']);
  check('تلويث صيني', 'summary', 'متابعة نص المطالعة تصف بغداد كم城市发展 Monument والمدن المتعددة', 'arabic-sixth-preparatory-part-1-2025', ['CJK']);
  check('حرف مصنع', 'fullText', 'IRAQ_G12_SB_2024.indb 46 Round up Unit 7 Revision', 'student-book-sixth-pdf', ['PRESS_SLAB']);
  check('محرف بديل U+FFFD', 'summary', 'نصcontains \uFFFD corruption', 'hadith-deni-sixth', ['U_FFFD']);

  // التكرار الحرفي داخل الدفعة الواحدة
  const dupPurpose = 'فهم مفهوم الاستهالك وأنواعه من حيث الجهة والطبيعة ثم بدء دراسة العوامل المؤثرة فيه.';
  const batchPage = { bookId: 'economics-sixth-literary-pdf', physicalPage: 45, fields: new Set(['educationalPurpose']) };
  const batch = acceptResults([
    { id: 'economics-sixth-literary-pdf:45', educationalPurpose: dupPurpose },
    { id: 'economics-sixth-literary-pdf:45', educationalPurpose: dupPurpose },
  ], new Map([['economics-sixth-literary-pdf:45', batchPage]]));
  const dupOk = batch.accepted.length === 1 && batch.failed[0]?.problems.includes('educationalPurpose:DUPLICATE_LITERAL');
  cases.push(`${dupOk ? 'PASS' : 'FAIL'}  تكرار حرفي داخل الدفعة ⇒ قُبل ${batch.accepted.length} ورُفض ${batch.failed.length}`);

  // مرجع شرعي داخل كتابه يُقبل
  const ownOk = acceptResults([
    { id: 'islamic-sixth-preparatory-2025:22', educationalPurpose: 'يتلو الطالب آيات من سورة النساء ثم يستنبط الأحكام الفقهية الثلاثة الواردة فيها مع بيان السبب.' },
  ], new Map([['islamic-sixth-preparatory-2025:22', { bookId: 'islamic-sixth-preparatory-2025', physicalPage: 22, fullText: OWN, fields: new Set(['educationalPurpose']) }]]));
  const ownPass = ownOk.accepted.length === 1;
  cases.push(`${ownPass ? 'PASS' : 'FAIL'}  غرض تربوي سليم (72 محرفاً، داخل كتابه) ⇒ ${ownPass ? 'قُبل' : ownOk.failed.map((item) => item.problems.join()).join('|')}`);

  // عيّنة موزّعة للصفحة الطويلة
  const longPage = { bookId: 'hadith-deni-sixth', physicalPage: 5, fields: new Set(['summary']), fullText: 'ا'.repeat(TEXT_LIMIT + 5000) };
  const sampled = buildItem(longPage);
  const hasHead = sampled.text.startsWith('ا'.repeat(SAMPLE_SEGMENT));
  const hasTail = sampled.text.endsWith('ا'.repeat(SAMPLE_SEGMENT));
  const hasMarkers = sampled.text.includes('وسط الصفحة') && sampled.text.includes('ذيل الصفحة');
  const sampledOk = hasHead && hasTail && hasMarkers && sampled.text.length < longPage.fullText.length;
  cases.push(`${sampledOk ? 'PASS' : 'FAIL'}  عيّنة موزّعة: رأس=${hasHead} ذيل=${hasTail} فواصل=${hasMarkers} طول=${sampled.text.length} من ${longPage.fullText.length}`);

  console.log(`=== اختبار الحواجز بلا شبكة (TEXT_LIMIT=${TEXT_LIMIT} · TITLE_MAX=${TITLE_MAX} · PURPOSE=${PURPOSE_MIN}-${PURPOSE_MAX}) ===`);
  console.log(cases.join('\n'));
  process.exit(cases.some((line) => line.startsWith('FAIL')) ? 1 : 0);
}

function buildItem(page) {
  const raw = String(page.fullText || '').replace(/\s+/g, ' ').trim();
  let text = raw;
  let sampled = false;
  if (raw.length > TEXT_LIMIT) {
    const midStart = Math.max(0, Math.floor(raw.length / 2) - Math.floor(SAMPLE_SEGMENT / 2));
    text = [
      raw.slice(0, SAMPLE_SEGMENT),
      '⟦… وسط الصفحة …⟧',
      raw.slice(midStart, midStart + SAMPLE_SEGMENT),
      '⟦… ذيل الصفحة …⟧',
      raw.slice(-SAMPLE_SEGMENT),
    ].join('\n');
    sampled = true;
  }
  const item = {
    id: `${page.bookId}:${page.physicalPage}`,
    fields: [...page.fields],
    section: String(page.section || ''),
    unit: String(page.unit || ''),
    text,
  };
  if (sampled) item.sampledFrom = raw.length;
  return item;
}

// يقبل نتائج الدفعة ويعيد { accepted, failed }. التكرار يُقاس على الدفعة وعلى الجلسة.
function acceptResults(results, pageById) {
  const accepted = [];
  const failed = [];
  const batchSeen = new Map();
  for (const entry of results) {
    if (!entry || !entry.id) continue;
    const id = String(entry.id);
    const [bookId, pageNo] = id.split(':');
    const page = Number(pageNo);
    const pageRef = pageById.get(id);
    const ownText = pageRef?.fullText || '';
    const wanted = pageRef?.fields || new Set();
    const record = { bookId, physicalPage: page, note: 'وصف مولّد من نص الصفحة' };
    const problems = [];
    const flag = (field, code, value) => problems.push({ field, code, value });
    for (const field of ASKED) {
      if (field === 'section' || field === 'unit') {
        const value = String(entry[field] || '').replace(/\s+/g, ' ').trim();
        if (!value) continue;
        const issues = valueProblems(field, value, bookId, ownText).filter((code) => code !== 'EMPTY');
        if (issues.length) { for (const code of issues) flag(field, code, value); continue; }
        record[field] = clipField(field, value);
        continue;
      }
      if (!wanted.has(field)) continue;
      const value = String(entry[field] ?? '').replace(/\s+/g, ' ').trim();
      if (!value) { flag(field, 'MISSING', ''); continue; }
      const issues = valueProblems(field, value, bookId, ownText);
      if (issues.length) { for (const code of issues) flag(field, code, value); continue; }
      const runKey = `${bookId}:${field}`;
      if (!seenInRun.has(runKey)) seenInRun.set(runKey, new Set());
      const runSet = seenInRun.get(runKey);
      if (batchSeen.has(`${field}:${value}`) || runSet.has(value)) {
        flag(field, 'DUPLICATE_LITERAL', value);
        continue;
      }
      batchSeen.set(`${field}:${value}`, id);
      runSet.add(value);
      record[field] = clipField(field, value);
    }
    if (record.educationalPurpose) {
      const purposeKey = normalizeAr(record.educationalPurpose);
      const summaryKey = normalizeAr(record.summary || '');
      if (summaryKey === purposeKey) flag('educationalPurpose', 'PURPOSE_EQUALS_SUMMARY', record.educationalPurpose);
      else if (summaryKey.startsWith(purposeKey)) flag('educationalPurpose', 'PURPOSE_ECHOES_SUMMARY', record.educationalPurpose);
    }
    if (problems.length) {
      for (const problem of problems) noteReject({ bookId, physicalPage: page, field: problem.field, code: problem.code, value: String(problem.value).slice(0, 200) });
      failed.push({ id, problems: problems.map((problem) => `${problem.field}:${problem.code}`), entry });
      continue;
    }
    if (!record.title && !record.summary && !record.educationalPurpose) {
      failed.push({ id, problems: ['entry:NOTHING_USABLE'] });
      continue;
    }
    accepted.push(record);
  }
  return { accepted, failed };
}

const jobs = [];
const pendingByField = new Map();
const starved = [];
const skippedShort = [];
const skippedEmpty = [];
for (const name of bookFiles) {
  const book = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
  if (ONLY_BOOK && book.id !== ONLY_BOOK) continue;
  const pending = [];
  for (const page of book.pages) {
    const raw = String(page.fullText || '').trim();
    const key = `${book.id}:${page.physicalPage}`;
    if (!raw) { skippedEmpty.push(key); continue; }
    if (raw.length < PAGE_TEXT_MIN) { skippedShort.push(`${key} (${raw.length})`); continue; }
    const done = doneFields.get(key) || new Set();
    const fields = REDO ? new Set(ASKED) : new Set(REQUIRED.filter((field) => !done.has(field)));
    if (!fields.size) continue;
    const blocked = ASKED.filter((field) => fields.has(field) && (attempts.get(`${book.id}:${page.physicalPage}:${field}`) || 0) >= MAX_ATTEMPTS);
    if (blocked.length) { starved.push(`${key} [${blocked.join(',')}]`); continue; }
    for (const field of fields) pendingByField.set(field, (pendingByField.get(field) || 0) + 1);
    pending.push({ bookId: book.id, physicalPage: page.physicalPage, fullText: raw, section: page.section, unit: page.unit, fields });
  }
  for (let i = 0; i < pending.length; i += BATCH) {
    const pages = pending.slice(i, i + BATCH);
    const pageById = new Map(pages.map((page) => [`${page.bookId}:${page.physicalPage}`, page]));
    jobs.push({ bookId: book.id, pages, pageById });
  }
}

const pendingPages = jobs.reduce((sum, job) => sum + job.pages.length, 0);
console.log(`صفحات تحتاج وصفًا: ${pendingPages} في ${jobs.length} دفعة · تزامن ${CONCURRENCY} · نموذج ${MODEL}`);
console.log(`الحقول الناقصة: ${REQUIRED.map((f) => `${f}=${pendingByField.get(f) || 0}`).join(' · ')}`);
console.log(`ترقيعات مقروءة: ${patchFiles.length} ملف · حقول مكتملة لكل صفحة تُقارن بالحقل لا بالصفحة`);
if (skippedShort.length) console.log(`صفحات قصيرة جداً تُخطّى: ${skippedShort.length}`);
if (skippedEmpty.length) console.log(`صفحات بلا نص (تحتاج OCR لا وصفاً): ${skippedEmpty.length}`);
if (starved.length) console.log(`صفحات توقفت بعد ${MAX_ATTEMPTS} محاولات مرفوضة (راجع reports/patches-rejected): ${starved.length}`);
console.log(jobs.map((job) => `${job.bookId}: ${job.pages.length} [${[...new Set(job.pages.flatMap((page) => [...page.fields]))].join(',')}]`).join('\n'));

if (DRY_RUN) {
  // تدقيق بلا شبكة: كم ترقيعة قائمة في PATCH_DIR يرفضها الحاجز الجديد؟
  const codes = new Map();
  let checked = 0;
  const samples = new Map();
  for (const file of patchFiles) {
    let raw;
    try { raw = JSON.parse(await readFile(path.join(PATCH_DIR, file), 'utf8')); }
    catch { codes.set('CORRUPT_FILE', (codes.get('CORRUPT_FILE') || 0) + 1); continue; }
    const entries = Array.isArray(raw) ? raw : raw.patches || [];
    for (const entry of entries) {
      checked += 1;
      const book = books.get(String(entry.bookId));
      const page = book?.pages.find((item) => Number(item.physicalPage) === Number(entry.physicalPage));
      const ownText = String(page?.fullText || '');
      for (const field of [...REQUIRED, 'fullText']) {
        if (entry[field] === undefined) continue;
        for (const code of valueProblems(field, String(entry[field]), String(entry.bookId), ownText)) {
          const tag = `${field}:${code}`;
          codes.set(tag, (codes.get(tag) || 0) + 1);
          if (!samples.has(tag)) samples.set(tag, `${file} ${entry.bookId}:${entry.physicalPage} ${String(entry[field]).slice(0, 90)}`);
        }
      }
    }
  }
  console.log('\n=== تدقيق الترقيعات القائمة بلا شبكة ===');
  console.log(`مدقَّق: ${checked} مدخل في ${patchFiles.length} ملف`);
  if (!codes.size) console.log('لا ترقيعة يرفضها الحاجز الجديد.');
  else console.log([...codes.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${String(count).padStart(5)}  ${code}  ←  ${samples.get(code)}`).join('\n'));
  process.exit(0);
}

const allKeys = await collectKeys();
if (!allKeys.length) { console.error('لا يوجد مفتاح API.'); process.exit(1); }
activeKeys = (await Promise.all(allKeys.map(async (key) => ((await probeKey(key)) ? key : null)))).filter(Boolean);
if (!activeKeys.length) { console.error('كل المفاتيح مرفوضة من المزود (401).'); process.exit(1); }
console.log(`مفاتيح صالحة: ${activeKeys.length} من ${allKeys.length}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let cursor = 0;
let appliedCount = 0;
let failedBatches = 0;
const failed = [];

async function exists(target) {
  try { await readFile(target, 'utf8'); return true; } catch { return false; }
}

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= jobs.length) return;
    if (LIMIT && appliedCount >= LIMIT) return;
    const job = jobs[index];
    const started = Date.now();
    const items = job.pages.map((page) => buildItem(page));
    const accepted = [];
    let retry = null;
    try {
      const raw = await callModel(`${PROMPT}\n\n${JSON.stringify({ items })}`);
      const parsed = parseJson(raw);
      const results = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : null;
      if (!results) throw new Error('لم يُعد JSON صالح');
      const first = acceptResults(results, job.pageById);
      accepted.push(...first.accepted);
      retry = first.failed;
      for (let round = 0; round < MAX_REPAIR_ROUNDS && retry.length; round += 1) {
        const payload = `${PROMPT}\n\n${repairPrompt(retry.map((item) => ({ id: item.id, errors: item.problems })))}`;
        const again = parseJson(await callModel(payload));
        const nextResults = Array.isArray(again?.results) ? again.results : Array.isArray(again) ? again : [];
        if (!nextResults.length) break;
        const second = acceptResults(nextResults, job.pageById);
        accepted.push(...second.accepted);
        retry = second.failed;
      }
      if (!accepted.length) throw new Error(`كل النتائج مرفوضة (${[...new Set((retry || []).flatMap((item) => item.problems))].slice(0, 4).join(', ')})`);
      const firstPage = Math.min(...accepted.map((entry) => entry.physicalPage));
      const lastPage = Math.max(...accepted.map((entry) => entry.physicalPage));
      // اسم الملف = الكتاب + أول وآخر صفحة مُقبل، لا رقم دفعة عالمي. الترقيم العالمي
      // كان يعيد استخدام نفس الاسم في تشغيل لاحق فيطمس ترقيعة دفعة سابقة بصمت.
      let name = `enrich-${job.bookId}-${String(firstPage).padStart(4, '0')}-${String(lastPage).padStart(4, '0')}.json`;
      for (let guard = 1; await exists(path.join(PATCH_DIR, name)); guard += 1) {
        name = `enrich-${job.bookId}-${firstPage}-${lastPage}-b${guard}.json`;
      }
      const file = path.join(PATCH_DIR, name);
      await writeFile(`${file}.tmp`, `${JSON.stringify(accepted)}\n`);
      await rename(`${file}.tmp`, file);
      appliedCount += accepted.length;
      console.log(`  ✓ ${job.bookId} ${accepted.length}/${job.pages.length} صفحة${retry.length ? ` · مرفوض ${retry.length}` : ''} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${name}`);
    } catch (error) {
      failedBatches += 1;
      failed.push({ index, bookId: job.bookId, pages: job.pages.map((page) => page.physicalPage), error: String(error.message || error) });
      console.log(`  ✗ ${job.bookId} دفعة ${index + 1} · ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

if (rejectRows.length) {
  const file = path.join(REJECT_DIR, `enrich-${stamp}-${process.pid}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), count: rejectRows.length, rejects: rejectRows }, null, 1)}\n`);
  await rename(`${file}.tmp`, file);
}

console.log('\n=== الملخص ===');
console.log(`صفحات وُصفت: ${appliedCount} · دفعات فاشلة: ${failedBatches} · نتائج مرفوضة: ${rejectRows.length}`);
if (rejectCodes.size) console.log([...rejectCodes.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `  ${String(count).padStart(4)}  ${code}`).join('\n'));
for (const item of failed) console.log(`  ! ${item.bookId} ${item.pages.join(',')}: ${item.error}`);
console.log(rejectRows.length ? `المرفوضات في: ${path.relative(ROOT, REJECT_DIR)}` : 'لا مرفوضات.');
console.log('شغّل: node scripts/apply-page-patches.mjs');
if (failedBatches) process.exitCode = 2;