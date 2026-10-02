import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D, DOMMatrix, ImageData } from '@napi-rs/canvas';

globalThis.Path2D ||= Path2D;
globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const SOURCES_DIR = path.join(LIBRARY, 'pdf-sources');
const PDF_INDEX = path.join(LIBRARY, 'pdf-index.json');
const AUTH_FILE = 'C:/Users/m/.local/share/opencode/auth.json';
const MODEL_FALLBACK = 'mimo-v2.6-flash';
const SCALE = 2;
const TIMEOUT_MS = 420_000;
const MAX_TOKENS = 16_000;
// بصمة الطبقة: كل صفحة يكتبها هذا السكربت تحمل رقم هذه النسخة وتاريخها وبصمة مصدرها،
// حتى تُعرف أي طبقة قديمة بُنيت قبل الإصلاح. المقياس: صفحات لها `ocr.parser: "raw"`
// (58 في المكتبة) وطبقة OCR قديمة في `student-activity` سبقت بقية الطبقات 10–31 ساعة.
const PIPELINE_VERSION = 'ocr-pages/3-strict';

// عتبات «الصفحة البيضاء»: صفحة بلا طبقة نص (glyphs ≤ 8) ولا حبر مرئي (غير أبيض < 0.4%
// من المنطقة الداخلية بعد استبعاد 9% من كل حافة). مقيسة على 2,280 صفحة: 4 صفحات فقط
// (arabic-grammar ص2 · english-deni ص129 · mathematics-deni ص4 وص6) وكلها فعلاً فارغة.
const BLANK_GLYPH_LIMIT = 8;
const BLANK_INK_LIMIT = 0.004;
const BLANK_INSET = 0.09;
const BLANK_TINT = 24;

// حروف المصنع وتاريخ الطباعة: نسخة محلية من نقش build-index.mjs:16-20 (لا استيراد حتى لا
// يتعارض الملفان؛ فالقاعدة تبقى هنا حتى لو حُذفت من هناك).
const PRESS_FILE = /IRAQ_G\d+_[A-Z]{2,4}_\d{4}\.indb/gi;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;

// بوابة التسلسل: كائن JSON كامل مخزَّن كنص. سبب العطب المقيس: ردّ النموذج كان نص JSON
// لا كائناً ⇒ خُزِّن خاماً في fullText/title/summary (student-book ص76 · student-activity
// ص118 وص162 · islamic-sixth ص72 وص73 — 5 صفحات، `ocr.parser: "raw"` وحدها في المكتبة).
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary|fullText)"\s*:/;
const SERIALIZED_ANYWHERE = /"\s*(?:text|title|summary|fullText)\s*"\s*:/;
const REPLACEMENT_CHAR = /\uFFFD/;
const CJK = /[\u3400-\u9fff]/;
const HEBREW = /[\u0590-\u05FF]/;
const REPLACEMENT_LIMIT = 0.005;

// كشف التلف: محارف خارج نطاق الأبجدية العربية الفعلية. المقياس على 21 كتاباً
// (history-deni-sixth §2.2): 19.13% من محارفه، وأعلى كتاب غيره hadith-deni-sixth 0.22%
// ⇒ حدّ 3% للصفحة و2% للكتاب يفصل بينهما بفارق 87 ضعفاً بلا إنذار كاذب على 20 كتاباً.
const OUT_OF_RANGE = /[\u061B\u061F\u063B-\u063F\u0653-\u065C]/g;
const PAGE_OUT_OF_RANGE_LIMIT = 0.03;
const BOOK_OUT_OF_RANGE_LIMIT = 0.02;
// تمزيخ الحروف: نسبة الحروف العربية الواقفة وحدها + ندرة الأدوات. يُشترط معه محرف
// خارج النطاق حتى لا تُحسب صفحات المعادلات (رياضيات) والصور الرمزية كالتالف.
const DIACRITICS = /[\u0610-\u061A\u064B-\u0652\u0670\u06D6-\u06ED\u0640]/g;
const PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_LETTER = /[\u0621-\u063A\u0641-\u064A]/g;
const SOLO_LETTER = /(?<![\u0621-\u063A\u0641-\u064A])[\u0621-\u063A\u0641-\u064A](?![\u0621-\u063A\u0641-\u064A])/g;
const ARABIC_TOKEN = /[\u0621-\u063A\u0641-\u064A]+/g;
const STOP_WORDS = new Set(['من', 'في', 'على', 'الى', 'إلى', 'عن', 'مع', 'كان', 'كانت', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'الذين', 'اللهم', 'ما', 'لا', 'و', 'او', 'أو', 'ثم', 'قد', 'كل', 'بعض', 'بين', 'عند', 'لدى', 'حتى', 'اذا', 'إذا', 'ان', 'أن', 'بل', 'هو', 'هي', 'هم']);
const SCRAMBLE_OUT_OF_RANGE = 0.008;
const SCRAMBLE_SOLO_LIMIT = 0.06;
const SCRAMBLE_STOP_LIMIT = 0.10;
const STOP_MIN_TOKENS = 20;
const STOP_MIN_LETTERS = 60;
const REJECT_SAMPLE = 400;

// هوية الكتاب: النموذج كان يجيب بلا معرفة الكتاب الذي يقرأه، فنسب نصاً مصحفاً مخترعاً
// إلى «كتاب اللغة العربية» داخل كتاب قراءات قرآنية (quran-readings ص63). صار التلميح
// يحمل هوية الكتاب، وأُلغي الوصف الذي ينسبه إلى كتاب آخر.
// القاعدة: **عبارة المادة كاملة** لكتاب آخر («اللغة العربية»)، لا كلمة ولا كلمتان
// متتاليتان — فالأخيرة تُطلق إنذاراً كاذباً على «تاريخ … الحديث والمعاصر» في غلاف
// كتاب التاريخ نفسه. مقاسه على 2,342 حقلاً وصفياً في المكتبة: ثلاثة حقول فقط، وكلها
// إسناد خاطئ حقيقي (quran ص63 · fiqh-shafii ص106 · islamic ص102).
const IDENTITY_MIN_WORD = 3;
const BOOK_MENTION = /(?:كتاب|مادة|ملف)\s+([^\n،.؛:]{3,80})/g;

function arabicFold(value) {
  return String(value ?? '')
    .replace(/[\u0610-\u061A\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ|ئ/g, 'ء')
    .replace(/\s+/g, ' ')
    .trim();
}

const stripAl = (word) => word.replace(/^(?:و?ال)(?=\S{2,})/, '');
const foldWords = (value) => arabicFold(value).split(/[^\p{L}]+/u).filter(Boolean).map(stripAl);

// عبارات هوية الكتاب: `subject` كاملاً، ومعه نسخته بلا القوس. «الفقه الشافعي» و
// «اللغة العربية» و«القرآن وعلومه — مباحث القراءات» — لا «الصف السادس الإعدادي».
function identityPhrases(book) {
  const phrases = new Set();
  const variants = [book?.subject, String(book?.subject || '').replace(/\([^)]*\)/g, ' '), book?.title];
  for (const source of variants) {
    const words = foldWords(source).filter((word) => word.length >= IDENTITY_MIN_WORD);
    if (words.length < 2) continue;
    phrases.add(words.join(' '));
    if (String(book?.subject || '') === source) {
      const withoutTrack = foldWords(String(source).replace(/\([^)]*\)/g, ' ')).filter((word) => word.length >= IDENTITY_MIN_WORD);
      if (withoutTrack.length >= 2) phrases.add(withoutTrack.join(' '));
    }
  }
  return phrases;
}

// يردّ سبب الرفض حين ينسب الوصف الصفحة صراحةً إلى مادة كتاب آخر لا هذا الكتاب.
function foreignBookReason(value, meta = {}) {
  const own = meta.ownTokens;
  const foreign = meta.foreignTokens;
  if (!own || !foreign || !own.size) return '';
  const text = arabicFold(value ?? '');
  if (!text) return '';
  BOOK_MENTION.lastIndex = 0;
  for (const match of text.matchAll(BOOK_MENTION)) {
    const words = foldWords(match[1]);
    for (let start = 0; start + 1 < words.length; start += 1) {
      for (let end = Math.min(words.length, start + 4); end > start + 1; end -= 1) {
        const phrase = words.slice(start, end).join(' ');
        if (foreign.has(phrase) && !own.has(phrase)) return `foreign-book:${phrase}`;
      }
    }
  }
  return '';
}

const PLACEHOLDER = /تحتاج (?:هذه الصفحة إلى )?القراءة البصرية|صفحة تحتاج OCR|صفحة مصورة|لا نص مستخرج|استخراج محتوى الصفحة من الصورة|تقع هذه الصفحة ضمن درس/;

const PROMPT_RULES = [
  'قواعد صارمة:',
  '- انسخ النص من الصورة حرفًا بحرف، لا تلخص ولا تترجم ولا تختصر داخل text.',
  '- أخرج الصفحة كاملة حتى نهاية آخر سطر؛ لا تتوقف في منتصف النص ولا تُكمل الناقص تخمينًا.',
  '- حافظ على التشكيل وعلامات الترقيم وترتيب السطور قدر الإمكان، وخفّف التعليل إن لم تكن متأكدًا.',
  '- لا تضف مقدمة ولا تعليقًا ولا شرحًا ولا اعتذارًا.',
  '- إن كانت الصفحة زخرفة أو إطاراً أو صورة بلا نص مكتوب فاجعل text فارغًا، واكتب في summary ما هو ظاهر فعلاً.',
  '- لا تنسب إلى الصفحة نصًّا لم يقرأ في الصورة؛ الصفحات التي لا نصّ لها تُترك فارغة بدل اختلاق نص.',
  '- لا تذكر اسم كتاب أو مادة إلا إن كان مذكورًا في الصورة نفسها.',
].join('\n');

function buildPrompt(book) {
  const title = String(book?.title || '').slice(0, 120);
  const subject = String(book?.subject || '').slice(0, 80);
  const identity = [title && `الكتاب: ${title}`, subject && `المادة: ${subject}`].filter(Boolean).join(' · ');
  return [
    'أنت مستخرج نصوص متخصص في اللغة العربية، تقرأ صورًا لصفحات كتب مدرسية عراقية للصف السادس الإعدادي.',
    identity ? `${identity} — الصفحة المعروضة من هذا الكتاب نفسه، فأنت تقرأ هذه الصفحات فقط ولا غيرها.` : '',
    'أعد JSON صالحًا فقط بلا أي نص خارجه وبلا سطر رمز، بالبنية:',
    '{"text":"النص الكامل للصفحة كما هي","title":"عنوان قصير للصفحة (80 حرفًا كحد أقصى)","summary":"جملة أو جملتان (300 حرف كحد أقصى) يصفان محتوى الصفحة تحديدًا","section":"اسم الدرس أو القسم إن ظهر وإلا فارغ","unit":"اسم الوحدة أو الفصل إن ظهر وإلا فارغ"}',
    PROMPT_RULES,
  ].filter(Boolean).join('\n');
}

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
const DRY_RUN = Boolean(flag('dry-run'));
// --force يتجاوز بوابة needsOcr كلها: لا يعيد إلا الصفحات التالفة/الفارغة، فكتاب واحد
// تالف (history-deni-sixth 140 صفحة) لا يختبس 21 كتاباً في جولة واحدة.
const FORCE = flag('force', false) !== false && flag('force', false) !== 'false';
const ONLY_BOOK = (() => {
  const value = flag('book', null);
  return value === null || value === true ? null : String(value).trim();
})();
const ONLY_BOOKS = String(flag('books', '') || '').split(',').map((id) => id.trim()).filter(Boolean);
const SCAN_CORRUPTION = (() => {
  const value = flag('corruption-scan', null);
  if (value === null || value === true) return true;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
})();
const LIMIT = Number(flag('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency', process.env.OCR_CONCURRENCY || 4)) || 4));

function loadDotEnv() {
  const env = {};
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch { /* لا يوجد ملف */ }
  return env;
}

function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!text.startsWith('b64:')) return text;
  try { return Buffer.from(text.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
}

async function collectKeys() {
  const keys = [];
  const env = loadDotEnv();
  const fromEnv = decodeKey(env.AI_API_KEY);
  if (fromEnv) keys.push(fromEnv);
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    for (const entry of Object.values(auth)) if (entry?.key) keys.push(entry.key);
  } catch { /* لا توجد مفاتيح إضافية */ }
  return [...new Set(keys.filter(Boolean))];
}

function endpointFromEnv() {
  const env = loadDotEnv();
  const raw = String(env.AI_ENDPOINT || 'https://opencode.ai/zen/go/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionSeq = 0;
const sessionId = () => `mualimi-ocr-${process.pid}-${(sessionSeq += 1)}`;

class KeyRing {
  constructor(keys, endpoint) {
    this.keys = keys;
    this.endpoint = endpoint;
    this.index = 0;
    this.dead = new Set();
  }
  current() { return this.keys[this.index]; }
  kill() {
    this.dead.add(this.index);
    const next = this.keys.findIndex((_, i) => !this.dead.has(i));
    if (next >= 0) { this.index = next; return true; }
    return false;
  }
}

async function probeKeys(ring) {
  for (let i = 0; i < ring.keys.length; i += 1) {
    ring.index = i;
    try {
      const response = await fetch(ring.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ring.current()}`, 'x-opencode-session': 'mualimi-ocr' },
        body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      });
      if (response.ok) return true;
      await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) { ring.dead.add(i); continue; }
      return true;
    } catch { continue; }
  }
  return false;
}

const MODEL = (() => {
  const env = loadDotEnv();
  const model = String(env.AI_MODEL || MODEL_FALLBACK).trim();
  const aliases = { 'MiMo-V2.6-Flash': 'mimo-v2.6-flash', 'MiMo-V2.6-Pro': 'mimo-v2.6-pro' };
  return aliases[model] || model || MODEL_FALLBACK;
})();

class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const canvasFactory = new NapiCanvasFactory();
const docCache = new Map();

async function openDoc(pdfPath) {
  if (!docCache.has(pdfPath)) {
    const data = new Uint8Array(await readFile(pdfPath));
    docCache.set(pdfPath, await pdfjs.getDocument({ data, canvasFactory, isEvalSupported: false, verbosity: 0 }).promise);
  }
  return docCache.get(pdfPath);
}

async function closeDocs() {
  for (const doc of docCache.values()) await doc.destroy().catch(() => {});
  docCache.clear();
}

// عدد محارف طبقة النص في صفحة الـPDF. بوابة «الصفحة البيضاء»: صفحة glyphs ≤ 8 بلا حبر
// مرئي لا يُقبل فيها نصٌ من نموذج الرؤية إطلاقاً — فأي نص يُقبله على صفحة بيضاء نصٌ
// مخترع (المقياس: 4 صفحات فقط من 2,280، وكلها فعلاً فارغة).
async function pdfGlyphCount(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  let glyphs = 0;
  for (const item of content.items) glyphs += String(item?.str || '').replace(/\s+/g, '').length;
  return glyphs;
}

// يُرجع الصورة ونسبة الحبر المرئي داخل المنطقة الداخلية (تُستبعد 9% من كل حافة كي لا
// يُحسب إطار الصفحة وشريطها زخرفةً على أنها نص). أيّ حرف غير أبيض يُحسب، لا الأسود فقط:
// صفحات المصحف تُطبع بالوردي والأحمر فيكون حبرها «فاتحًا» لا داكنًا.
async function renderPage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: SCALE });
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  const width = canvas.width;
  const height = canvas.height;
  const ix = Math.round(width * BLANK_INSET);
  const iy = Math.round(height * BLANK_INSET);
  const innerWidth = Math.max(1, width - 2 * ix);
  const innerHeight = Math.max(1, height - 2 * iy);
  let ink = 0;
  if (width && height) {
    const pixels = context.getImageData(ix, iy, innerWidth, innerHeight).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (255 - pixels[offset] > BLANK_TINT
        || 255 - pixels[offset + 1] > BLANK_TINT
        || 255 - pixels[offset + 2] > BLANK_TINT) ink += 1;
    }
  }
  const png = Buffer.from(await canvas.encode('png'));
  return { png, ink: ink / (innerWidth * innerHeight) };
}

function isBlankPage(gate) {
  return Number(gate?.glyphs || 0) <= BLANK_GLYPH_LIMIT && Number(gate?.ink || 0) < BLANK_INK_LIMIT;
}

// تحليل صارم لاستجابة النموذج. القاعدة المطلقة: لا يُقبل إلا كائن JSON يحمل نصاً نظيفاً؛
// إن لم يُحلَّل الرد ⇒ تُرفض الصفحة ولا يُكتب فيها خام. (المقياس: `ocr.parser: "raw"`
// في 5 صفحات سببه ردٌّ نصّي خام، والحارس القديم كان يفحص النص بعد استخراجه لا الردّ.)
function parseModelJson(raw) {
  const cleaned = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return { ok: false, reason: 'OCR_RESPONSE_EMPTY' };
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], cleaned] : [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const text = typeof parsed.text === 'string' ? parsed.text
        : typeof parsed.fullText === 'string' ? parsed.fullText : null;
      if (text === null) return { ok: false, reason: 'OCR_RESPONSE_MISSING_TEXT_FIELD' };
      return { ok: true, value: { ...parsed, text } };
    } catch { /* المحاولة التالية */ }
  }
  // لم يُحلَّل الرد ككائن. إن كان نص JSON متسلسلاً فقد رُدّ نصاً لا كائناً — وهو سبب
  // تسرّب `{"text":...}` إلى fullText في 5 صفحات؛ فيُرفض هنا ولا يُكتب خاماً أبداً.
  if (SERIALIZED_ANYWHERE.test(cleaned)) return { ok: false, reason: 'OCR_RESPONSE_IS_SERIALIZED_TEXT' };
  return { ok: false, reason: 'OCR_RESPONSE_NOT_JSON' };
}

// كائن JSON كامل مخزون كنص (من طبقة قديمة). الاستخراج متسامح لا صارم: المخزون
// الملوَّث مقيساً فيه سطر خام داخل السلسلة (\n حرفي)، وهروب غير صالح (\_)، ونص مقطوع
// بلا قوس إغلاق (islamic-sixth ص72). فصار الاستخراج يقرأ حقل text حتى أول قوس غير
// مهرَّب، ثم يفكّ الهروبات، ويرفض ما بعد ذلك. نسخة عن apply-page-patches.mjs:81
// (لا استيراد حتى لا يتعارض الملفان).
const TEXT_KEY = /"(?:text|fullText)"\s*:\s*"/;
const FIELD_KEY = (name) => new RegExp(`"${name}"\\s*:\\s*"`);
const BAD_ESCAPE = /\\(.)/g;
const KNOWN_ESCAPE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\', '/': '/' };

function unescapeJsonString(value) {
  return String(value).replace(BAD_ESCAPE, (match, char) => (char in KNOWN_ESCAPE ? KNOWN_ESCAPE[char] : char));
}

function unwrapField(value, name) {
  const text = String(value ?? '');
  const key = name === 'text' ? text.match(TEXT_KEY) : text.match(FIELD_KEY(name));
  if (!key) return { value: '', closed: false };
  const collapse = (raw) => (name === 'text' ? raw : raw.replace(/\s+/g, ' ')).trim();
  let index = key.index + key[0].length;
  let out = '';
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') { out += text[index] + (text[index + 1] || ''); index += 1; continue; }
    if (char === '"') return { value: collapse(unescapeJsonString(out)), closed: true };
    out += char;
  }
  return { value: collapse(unescapeJsonString(out)), closed: false };
}

function unwrapSerialized(value) {
  const text = String(value ?? '');
  if (!SERIALIZED_FIELD.test(text)) return null;
  const body = unwrapField(text, 'text');
  const content = body.value.replace(/\r\n?/g, '\n');
  if (!content.trim()) return null;
  return {
    text: content,
    truncated: !body.closed,
    title: unwrapField(text, 'title').value,
    summary: unwrapField(text, 'summary').value,
    section: unwrapField(text, 'section').value,
    unit: unwrapField(text, 'unit').value,
  };
}
// حروف المصنع وتاريخ الطباعة داخل نص OCR: نفس نقش build-index.mjs:16-17 (لا استيراد).
// المقياس: 6,516 محرف IRAQ_G12_SB_2024.indb في pdf-books + pdf-index.
function stripPressSlab(value) {
  return String(value ?? '')
    .replace(PRESS_FILE, ' ')
    .replace(PRESS_STAMP, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deriveMeta(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const title = (lines.find((line) => line.length >= 4 && line.length <= 120) || '').slice(0, 140);
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = flat.split(/(?<=[.!؟?])\s+/).filter((sentence) => sentence.length > 24);
  const summary = sentences.slice(0, 2).join(' ').slice(0, 400);
  return { title, summary };
}

function cleanTextBlock(value) {
  return stripPressSlab(String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function cleanField(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^(null|undefined)$/i.test(text)) return '';
  if (/^(لا يوجد|غير مذكور|n\/a|none|-)$/i.test(text)) return '';
  return stripPressSlab(text).slice(0, max);
}

// بوابة ما قبل الحفظ: النص النظيف وحده يصل إلى fullText. تُرفض الصفحة كلها عند:
// JSON متسلسل (في أي موضع)، محارف بديلة U+FFFD بكثافة، صيني/عبري تسرّب، محارف خارج
// نطاق العربية، أو نص يبدأ بـ { أو json.
function contaminationReason(value, limitChars = null) {
  const text = String(value ?? '');
  if (!text.trim()) return '';
  if (SERIALIZED_FIELD.test(text) || SERIALIZED_ANYWHERE.test(text)) return 'serialized-json';
  if (/^\s*(?:\uFEFF)?(?:json\b|\{|`{3}|\\{)/i.test(text)) return 'serialized-json';
  if (CJK.test(text)) return 'cjk-leak';
  if (HEBREW.test(text)) return 'hebrew-leak';
  const visible = text.replace(/\s+/g, '');
  if (!visible.length) return '';
  if (REPLACEMENT_CHAR.test(text) && (text.match(/�/g) || []).length / visible.length > REPLACEMENT_LIMIT) return 'replacement-chars';
  const outOfRange = (text.match(OUT_OF_RANGE) || []).length / visible.length;
  if (outOfRange > (limitChars || PAGE_OUT_OF_RANGE_LIMIT)) return 'out-of-range';
  return '';
}

// قياس تلف نص موجود. يُرجع reasons؛ فراغها نص سليم. هذه هي البوابة التي تجعل صفحة
// «needsOcr=false ونصها تالف» تُعاد للقراءة البصرية بدل أن تُتخطى إلى الأبد.
function corruptionReasons(text) {
  const value = String(text || '');
  if (!value.trim()) return [];
  const reasons = [];
  const chars = value.length || 1;
  const replacement = (value.match(/�/g) || []).length / chars;
  const outOfRange = (value.match(OUT_OF_RANGE) || []).length / chars;
  if (replacement > REPLACEMENT_LIMIT) reasons.push(`replacement-chars:${(replacement * 100).toFixed(2)}%`);
  const skeleton = value.replace(DIACRITICS, '').replace(PRESENTATION, '');
  const letters = (skeleton.match(ARABIC_LETTER) || []).length;
  const tokens = skeleton.match(ARABIC_TOKEN) || [];
  const solo = letters ? (skeleton.match(SOLO_LETTER) || []).length / letters : 0;
  const stop = tokens.length >= STOP_MIN_TOKENS && letters >= STOP_MIN_LETTERS
    ? tokens.filter((token) => STOP_WORDS.has(token)).length / tokens.length
    : null;
  if (outOfRange > PAGE_OUT_OF_RANGE_LIMIT) {
    reasons.push(`out-of-range:${(outOfRange * 100).toFixed(2)}%`);
  } else if (outOfRange > SCRAMBLE_OUT_OF_RANGE && solo > SCRAMBLE_SOLO_LIMIT && stop !== null && stop < SCRAMBLE_STOP_LIMIT) {
    reasons.push(`out-of-range+scramble:${(outOfRange * 100).toFixed(2)}%,solo:${(solo * 100).toFixed(1)}%,stop:${(stop * 100).toFixed(1)}%`);
  }
  return reasons;
}

// نسبة تلف الكتاب كله: طبقة نص واحدة تالفة لخطوطها (المقياس: history-deni-sixth 19.13%
// مقابل 0.22% لأعلى كتاب غيره) فلا تُقاس صفحة صفحة — الكتاب كله مستحق للقراءة البصرية.
function bookCorruptionRatio(pages) {
  let chars = 0;
  let outOfRange = 0;
  for (const page of pages || []) {
    const text = String(page?.fullText || '');
    if (!text.trim()) continue;
    chars += text.length;
    outOfRange += (text.match(OUT_OF_RANGE) || []).length;
  }
  return chars ? outOfRange / chars : 0;
}

function isCorruptBook(pages) {
  return SCAN_CORRUPTION && bookCorruptionRatio(pages) >= BOOK_OUT_OF_RANGE_LIMIT;
}

// الحارس الذي يمنع النشر: يُسقِط النص الملوَّث من الصفحة ويُبقيها needsOcr بدل أن
// تُكتب في pdf-books ثم تُنسخ إلى pdf-index وتُفهرَس في postings. لا يُكتب النص المرفوض
// في fullText إطلاقاً، بل عيّنة قصيرة داخل ocr.rejected لمتابعته.
function quarantine(page, code, detail, meta = {}) {
  const previous = String(page.fullText || '');
  // كل حقل وصفي ملوَّث (JSON متسلسل/صيني/عبري) أو منسوب إلى كتاب آخر يُفرَّغ: الحقل
  // الوصفي يدخل searchableText في build-index.mjs:217-233 فينشر التلوّث مع النص.
  for (const field of ['title', 'summary', 'educationalPurpose']) {
    const value = String(page[field] || '');
    if (!value) continue;
    if (contaminationReason(value) || foreignBookReason(value, meta)) page[field] = '';
  }
  page.fullText = '';
  page.searchable = false;
  page.needsOcr = true;
  page.pageType = 'needs_ocr';
  page.ocr = {
    ...(page.ocr || {}),
    required: true,
    status: 'rejected',
    engine: 'vision',
    model: meta.model || MODEL,
    at: new Date().toISOString(),
    parser: 'json',
    pipeline: PIPELINE_VERSION,
    builtAt: new Date().toISOString(),
    rejectCode: code,
    rejectDetail: detail || '',
    rejectedChars: previous.replace(/\s+/g, '').length,
    rejectedSample: previous.replace(/\s+/g, ' ').slice(0, REJECT_SAMPLE),
  };
  if (meta.source) page.ocr.source = meta.source;
  page.notes = `رُفض ناتج القراءة البصرية (${code}${detail ? `: ${detail}` : ''}) — لم يُنشر شيء من هذه الصفحة.`;
  return { quarantined: true, code };
}

async function callVision(ring, png, prompt) {
  const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } };
  let maxTokens = MAX_TOKENS;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(ring.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ring.current()}`, 'x-opencode-session': sessionId() },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          temperature: 0.1,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, imagePart] }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        if (ring.kill()) { lastError = new Error(`مفتاح مرفوض (${response.status}) — تم التبديل`); continue; }
        throw new Error(`كل المفاتيح مرفوضة (${response.status})`);
      }
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status} ${raw.slice(0, 200)}`);
      const json = JSON.parse(raw);
      const choice = json?.choices?.[0] || {};
      const message = choice.message || {};
      const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || '').join('') : '';
      if (!content) {
        if (choice.finish_reason === 'length' && maxTokens < 48_000) {
          maxTokens = Math.min(48_000, maxTokens * 3);
          lastError = new Error(`سبب طويل جدًا — أعيد بسقف ${maxTokens}`);
          continue;
        }
        if (message.reasoning_content) throw new Error('النموذج أنهى السبب دون نص');
        throw new Error('رد فارغ من المزود');
      }
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(1_500 * attempt);
    }
  }
  throw lastError || new Error('فشل غير معروف');
}

// كل تحقّق يسبق أي كتابة في page. أي فشل ⇒ استثناء ⇒ لا كتابة ولا نشر.
function applyResult(page, parsed, meta = {}) {
  const model = meta.model || MODEL;
  const stamp = new Date().toISOString();
  if (!parsed || typeof parsed !== 'object') throw new Error('OCR_OUTPUT_NOT_VALID_JSON');
  if (typeof parsed.text !== 'string') throw new Error('OCR_OUTPUT_MISSING_TEXT');
  const text = cleanTextBlock(parsed.text);
  const contaminated = contaminationReason(text);
  if (contaminated) throw new Error(`OCR_OUTPUT_CONTAMINATED:${contaminated}`);
  for (const field of ['title', 'summary', 'section', 'unit']) {
    if (parsed[field] === undefined) continue;
    const bad = contaminationReason(cleanField(parsed[field], 460));
    if (bad) throw new Error(`OCR_FIELD_CONTAMINATED:${field}:${bad}`);
  }
  // الانتساب لكتاب آخر يُقاس على الوصف **الوارد من النموذج** فقط؛ أما الحقول القديمة
  // الملوَّثة فتُتجاهل ولا تُستخدم كبديل (وإلا رفضنا نصاً سليماً جديداً بسبب ملخّص قديم).
  const incoming = `${cleanField(parsed.title, 140)} ${cleanField(parsed.summary, 460)}`;
  const foreign = foreignBookReason(incoming, meta);
  if (foreign) throw new Error(`OCR_OUTPUT_FOREIGN:${foreign}`);
  const damage = corruptionReasons(text);
  if (damage.length) throw new Error(`OCR_OUTPUT_CORRUPT:${damage.join('|')}`);
  if (isBlankPage(meta.gate)) throw new Error('OCR_PAGE_BLANK');
  const fallback = deriveMeta(text);
  // البديل الموروث يُقبل فقط إن كان سليماً: لا JSON ولا نسبة لكتاب آخر.
  const inherited = (value, max) => {
    const text2 = cleanField(value, max);
    if (!text2) return '';
    if (contaminationReason(text2)) return '';
    if (foreignBookReason(text2, meta)) return '';
    return text2;
  };
  const titleCandidate = cleanField(parsed.title, 140);
  const summaryCandidate = cleanField(parsed.summary, 460);
  const title = titleCandidate || fallback.title || inherited(page.title, 140);
  const summary = summaryCandidate || fallback.summary || inherited(page.summary, 460);
  const section = cleanField(parsed?.section, 140) || inherited(page.section, 140);
  const unit = cleanField(parsed?.unit, 140) || inherited(page.unit, 140);
  const hasText = text.replace(/\s+/g, '').length >= 20;
  const source = meta.source ? { ...meta.source, ink: Number(meta.gate?.ink || 0).toFixed(5), glyphs: Number(meta.gate?.glyphs || 0) } : null;

  page.fullText = text;
  page.searchable = hasText;
  page.needsOcr = !hasText;
  page.ocr = {
    required: !hasText,
    status: hasText ? 'completed' : 'no-text',
    engine: 'vision',
    model,
    at: stamp,
    builtAt: stamp,
    parser: 'json',
    pipeline: PIPELINE_VERSION,
  };
  if (source) page.ocr.source = source;
  if (title) page.title = title.replace(/—?\s*صفحة تحتاج OCR\s*$/, '').trim();
  if (summary) page.summary = summary;
  if (section) page.section = section;
  if (unit) page.unit = unit;
  if (hasText && (page.pageType === 'needs_ocr' || page.pageType === 'image')) page.pageType = 'scanned_ocr';
  // الغرض القديم الملوَّث أو المنسوب لكتاب آخر يُعاد بناؤه من الملخّص الجديد لا يُحفظ.
  if (!page.educationalPurpose
    || PLACEHOLDER.test(page.educationalPurpose)
    || contaminationReason(page.educationalPurpose)
    || foreignBookReason(page.educationalPurpose, meta)) {
    page.educationalPurpose = summary ? `محتوى الصفحة: ${summary}`.slice(0, 400) : 'استخراج محتوى الصفحة من الصورة.';
  }
  return { hasText, chars: text.length, parser: 'json' };
}

function needsOcr(page, options = {}) {
  if (FORCE) return true;
  if (options.corruptBook) return true;
  const text = String(page.fullText || '');
  if (!text.trim()) return true;
  if (contaminationReason(text)) return true;
  if (page.ocr?.status === 'rejected') return true;
  if (page.ocr?.parser && page.ocr.parser !== 'json') return true;
  if (SCAN_CORRUPTION && corruptionReasons(text).length) return true;
  return Boolean(page.needsOcr || page.ocr?.required);
}

function resolvePdfFile(book) {
  const name = book.source?.fileName || book.book?.source?.fileName
    || book.pages.find((page) => page.sourceProvenance?.fileName)?.sourceProvenance?.fileName;
  if (!name) throw new Error(`لا يوجد ملف PDF مسجل للكتاب ${book.id}`);
  return path.join(SOURCES_DIR, name);
}

// فهرس هوية الكتب: عبارات مادة كل كتاب. تُبنى مرة واحدة ثم تُمرَّر مع كل صفحة.
let identityIndex = null;
async function identityMeta(bookId, book) {
  if (!identityIndex) {
    identityIndex = new Map();
    for (const name of (await readdir(BOOKS_DIR)).filter((entry) => entry.endsWith('.json'))) {
      try {
        const json = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
        identityIndex.set(json.id, identityPhrases(json));
      } catch { /* كتاب غير قابل للقراءة لا يدخل الفهرس */ }
    }
  }
  const own = identityIndex.get(bookId) || identityPhrases(book);
  const foreign = new Set();
  for (const [id, phrases] of identityIndex) {
    if (id === bookId) continue;
    for (const phrase of phrases) foreign.add(phrase);
  }
  return { ownTokens: own, foreignTokens: foreign };
}

let writeChain = Promise.resolve();
function queueWrite(file, data) {
  const temp = `${file}.tmp`;
  writeChain = writeChain
    .then(() => writeFile(temp, data))
    .then(() => rename(temp, file))
    .catch((error) => {
      console.error(`[fatal] تعذر حفظ ${path.basename(file)}: ${error.message}`);
    });
  return writeChain;
}

async function processBook(book, ring, state) {
  const file = path.join(BOOKS_DIR, `${book.id}.json`);
  const json = JSON.parse(await readFile(file, 'utf8'));
  const corruptBook = isCorruptBook(json.pages);
  const options = { corruptBook };
  let pending = json.pages.filter((page) => needsOcr(page, options));
  const serialized = json.pages.filter((page) => unwrapSerialized(page.fullText));
  if (!pending.length && !serialized.length) return { id: book.id, skipped: true, done: 0, failed: 0, repaired: 0 };
  if ((ONLY_BOOK && book.id !== ONLY_BOOK) || (ONLY_BOOKS.length && !ONLY_BOOKS.includes(book.id))) return { id: book.id, skipped: true, done: 0, failed: 0, repaired: 0 };

  const pdfPath = resolvePdfFile(json);
  const identity = await identityMeta(json.id, json);
  const source = { fileName: path.basename(pdfPath), physicalPage: null, printedPage: null, scale: SCALE };
  const bookFingerprint = createHash('sha256').update(`${path.basename(pdfPath)}:${json.pages.length}`).digest('hex').slice(0, 16);
  console.log(`\n[${json.id}] ${pending.length} صفحة تحتاج القراءة البصرية${corruptBook ? ' · الكتاب كله تالف الحروف' : ''} — ${path.basename(pdfPath)}`);
  if (serialized.length) console.log(`  · ${serialized.length} صفحة نصّها JSON متسلسل خام — تُصلَح أولاً`);
  const doc = await openDoc(pdfPath);

  let cursor = 0;
  let done = 0;
  let failed = 0;
  let repaired = 0;
  const save = () => queueWrite(file, `${JSON.stringify(json)}\n`);

  // طبقة قديمة: كائن JSON كامل مخزون داخل fullText. يُستخرج منه الحقل ولا يُنشر النص
  // الخام؛ فإن تعذّر الاستخراج أو كان المستخرج تالفاً تُحجَب الصفحة (قاعدة: الرفض أفضل
  // من النشر المزيّف). حقل `parser: "raw"` وحده كان يبوح بها، فصار `json` أو لا شيء.
  function repairSerialized() {
    for (const page of serialized) {
      const blob = unwrapSerialized(page.fullText);
      const before = String(page.fullText || '').length;
      const text = blob ? cleanTextBlock(blob.text) : '';
      const bad = text ? contaminationReason(text) : 'serialized-json';
      const damage = text && !bad ? corruptionReasons(text) : [];
      const clean = Boolean(text) && !bad && !damage.length;
      if (clean) {
        page.fullText = text;
        page.searchable = true;
        page.needsOcr = false;
        page.ocr = {
          ...(page.ocr || {}),
          status: 'repaired',
          parser: 'json',
          pipeline: PIPELINE_VERSION,
          builtAt: new Date().toISOString(),
          repairedChars: before,
          truncatedSource: Boolean(blob.truncated),
        };
        if (contaminationReason(page.title) && blob.title) page.title = cleanField(blob.title, 140);
        if (contaminationReason(page.summary) && blob.summary) page.summary = cleanField(blob.summary, 460);
        if (!page.section && blob.section) page.section = cleanField(blob.section, 140);
        if (!page.unit && blob.unit) page.unit = cleanField(blob.unit, 140);
        if (contaminationReason(page.educationalPurpose)) page.educationalPurpose = '';
        repaired += 1;
        console.log(`  ⟳ ${page.physicalPage} · فُك JSON المخزَّن (${before} → ${text.length} حرف)${blob.truncated ? ' · المصدر مقطوع' : ''}`);
      } else {
        const reason = bad || damage.join('|') || 'serialized-json';
        quarantine(page, 'serialized-rejected', reason, {
          model: MODEL,
          source: { ...source, physicalPage: page.physicalPage, printedPage: page.printedPage ?? null, fingerprint: bookFingerprint },
          ...identity,
        });
        state.rejected.push({ book: json.id, page: page.physicalPage, code: 'serialized-rejected', detail: reason });
        console.log(`  ⛔ ${page.physicalPage} · حُجبت: ${reason}`);
      }
    }
  }

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      if (LIMIT && state.processed >= LIMIT) return;
      const page = pending[index];
      const started = Date.now();
      const pageSource = { ...source, physicalPage: page.physicalPage, printedPage: page.printedPage ?? null, fingerprint: bookFingerprint };
      try {
        const { png, ink } = await renderPage(doc, Number(page.physicalPage));
        const glyphs = await pdfGlyphCount(doc, Number(page.physicalPage));
        const gate = { ink, glyphs };
        const raw = await callVision(ring, png, buildPrompt(json));
        const parsed = parseModelJson(raw);
        if (!parsed.ok) throw new Error(parsed.reason);
        const result = applyResult(page, parsed.value, { model: MODEL, gate, source: pageSource, ...identity });
        await save();
        done += 1;
        state.processed += 1;
        state.totalChars += result.chars;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ✓ ${page.physicalPage} · ${result.chars} حرف · ${seconds}s · json · glyphs=${glyphs} ink=${(ink * 100).toFixed(2)}%`);
      } catch (error) {
        const message = String(error.message || error);
        // رفض ≠ فشل: ناتج ملوَّث أو مخترع أو صفحة بيضاء يُحجب ولا يُنشر، بدل أن يُكتب
        // ويُنسخ إلى pdf-index ثم يُفهرَس. الحارس صار يمنع النشر لا يسجّل الملاحظة فقط.
        const code = message.split(':')[0];
        if (/^OCR_(OUTPUT|FIELD|RESPONSE|PAGE)/.test(code)) {
          quarantine(page, code, message.slice(code.length + 1), { model: MODEL, source: pageSource, ...identity });
          await save();
          state.rejected.push({ book: json.id, page: page.physicalPage, code, detail: message });
          console.log(`  ⛔ ${page.physicalPage} · رُفض: ${message}`);
        } else {
          failed += 1;
          state.failed.push({ book: json.id, page: page.physicalPage, error: message });
          console.log(`  ✗ ${page.physicalPage} · ${message}`);
        }
      }
    }
  }

  // الإصلاح يُعيد حساب المرشَّح: الصفحة التي فُكّ عنها JSON عادت سليمة فلا تُدفع
  // إلى النموذج زائدةً، والحاجبة تبقى مرشَّحةً فتبقى فرصة استرجاعها بصرياً.
  repairSerialized();
  pending = pending.filter((page) => needsOcr(page, options));
  if (!pending.length && !serialized.length) return { id: json.id, skipped: true, done: 0, failed: 0, repaired };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await save();
  return { id: json.id, skipped: false, done, failed, repaired, total: pending.length };
}

async function rebuildPdfIndex() {
  const index = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
  const books = [];
  for (const entry of index.books) {
    const file = path.join(BOOKS_DIR, `${entry.id}.json`);
    const fresh = JSON.parse(await readFile(file, 'utf8'));
    delete fresh.schemaVersion;
    books.push(fresh);
  }
  index.books = books;
  await writeFile(PDF_INDEX, `${JSON.stringify(index)}\n`);
  const pages = books.reduce((sum, book) => sum + book.pages.length, 0);
  // العدّ يقرأ `searchable` لا وجود النص: وجودُ النص وحده كان يُحسب قابلاً للبحث، فكانت
  // الصفحات المحجوبة تُعلن قابلةً للبحث. الحارس الآن يمنع النشر لا يكتفي بالإحصاء.
  const searchable = books.reduce((sum, book) => sum + book.pages.filter((page) => page.searchable && page.fullText).length, 0);
  const quarantined = books.reduce((sum, book) => sum + book.pages.filter((page) => page.ocr?.status === 'rejected').length, 0);
  console.log(`\npdf-index: ${books.length} كتاب · ${pages} صفحة · ${searchable} قابلة للبحث${quarantined ? ` · ${quarantined} محجوبة` : ''}`);
}

// المكتبة-function هذه لا تُصدَّر إلا في وضع الاستيراد (الاختبار في temp)، فالسكربت
// يبقى برنامجاً تنفيذياً واحداً بلا تغيير في سلوكه.
export {
  PIPELINE_VERSION,
  buildPrompt,
  parseModelJson,
  unwrapSerialized,
  unwrapField,
  stripPressSlab,
  cleanTextBlock,
  cleanField,
  contaminationReason,
  corruptionReasons,
  bookCorruptionRatio,
  isCorruptBook,
  isBlankPage,
  identityPhrases,
  foreignBookReason,
  needsOcr,
  applyResult,
  quarantine,
  deriveMeta,
};

async function main() {
  const files = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json'));
  const books = [];
  for (const name of files) {
    const json = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
    if ((ONLY_BOOK && json.id !== ONLY_BOOK) || (ONLY_BOOKS.length && !ONLY_BOOKS.includes(json.id))) continue;
    const options = { corruptBook: isCorruptBook(json.pages) };
    const pending = json.pages.filter((page) => needsOcr(page, options)).length;
    const serialized = json.pages.filter((page) => unwrapSerialized(page.fullText)).length;
    if (!pending && !serialized) continue;
    books.push({ id: json.id, name, pending, serialized, corrupt: options.corruptBook });
  }

  console.log(`كتب بها صفحات تحتاج القراءة البصرية: ${books.length} · تزامن ${CONCURRENCY} · نموذج ${MODEL} · ${FORCE ? 'إعادة قسرية لكل الصفحات' : SCAN_CORRUPTION ? 'مع كشف التلف' : 'بلا كشف تلف'}`);

  if (DRY_RUN) {
    for (const entry of books) {
      console.log(`  - ${entry.id}: ${entry.pending} صفحة${entry.corrupt ? ' (الكتاب تالف الحروف)' : ''}${entry.serialized ? ` · ${entry.serialized} نص متسلسل` : ''}`);
    }
    console.log(`الإجمالي: ${books.reduce((sum, entry) => sum + entry.pending, 0)} صفحة · بلا أي استدعاء شبكة`);
    return 0;
  }

  const keys = await collectKeys();
  if (!keys.length) { console.error('لا يوجد مفتاح API.'); return 1; }
  const ring = new KeyRing(keys, endpointFromEnv());
  if (!(await probeKeys(ring))) { console.error('كل المفاتيح مرفوضة من المزود (401).'); return 1; }
  console.log(`المفتاح يعمل · المزود ${ring.endpoint} · عدد المفاتيح ${keys.length}`);

  const state = { processed: 0, failed: [], rejected: [], totalChars: 0, repaired: 0 };
  const results = [];
  for (const entry of books) {
    const book = { id: entry.id };
    const result = await processBook(book, ring, state);
    state.repaired += result.repaired || 0;
    results.push(result);
  }

  await writeChain;
  await closeDocs();
  await rebuildPdfIndex();

  console.log('\n=== الملخص ===');
  for (const result of results) {
    if (result.skipped) continue;
    console.log(`  ${result.id}: ${result.done}/${result.total} صفحة · فشل ${result.failed}${result.repaired ? ` · أُصلح ${result.repaired}` : ''}`);
  }
  console.log(`صفحات أُعيد استخراجها: ${state.processed}`);
  console.log(`أحرف مُستخرجة: ${state.totalChars}`);
  console.log(`صفحات فُكّ عنها JSON مخزون خام: ${state.repaired}`);
  console.log(`صفحات رُفض نشرها (حُجبت وبقيت needsOcr): ${state.rejected.length}`);
  for (const entry of state.rejected) console.log(`  ⛔ ${entry.book} صفحة ${entry.page}: ${entry.code}${entry.detail ? ` — ${entry.detail}` : ''}`);
  console.log(`صفحات فشلت تقنياً: ${state.failed.length}`);
  for (const failure of state.failed) console.log(`  ! ${failure.book} صفحة ${failure.page}: ${failure.error}`);
  return state.failed.length || state.rejected.length ? 2 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = await main();
  if (code) process.exitCode = code;
}

