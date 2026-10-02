import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
function boolFlag(name, fallback) {
  const value = flag(name, null);
  if (value === null || value === true) return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}
// --library يوجّه القراءة والكتابة إلى نسخة أخرى من المكتبة (للتحقق على نسخة في temp).
const LIBRARY = String(flag('library', path.join(ROOT, 'curriculum-library')));
const DRY_RUN = Boolean(flag('dry-run'));
// في apply قديم هذه القيمة تحذير لا رفض: الترقيعات القائمة قد تذكر «القرآن الكريم» في صفحة
// نحو شرعية وهيalzواجب سليمة، ورفضها يعني ترك وصف صحيح. الوضع reject للدقق الصارم.
const FOREIGN_MODE = String(flag('foreign-subject', 'warn'));
const ONLY_BOOK = flag('book', null);
const REPAIR_SERIALIZED = boolFlag('repair-serialized', true);
const PRESS_CLEAN = boolFlag('press-clean', true);

const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const PDF_INDEX = path.join(LIBRARY, 'pdf-index.json');
const PATCH_DIR = String(flag('patches', path.join(LIBRARY, 'reports', 'patches')));
const REJECT_DIR = String(flag('rejects', path.join(LIBRARY, 'reports', 'patches-rejected')));
const REPORT_FILE = path.join(LIBRARY, 'reports', 'apply-page-patches-report.json');

const FIELDS = ['title', 'summary', 'section', 'unit', 'educationalPurpose', 'pageType'];
const TITLE_MAX = 90;

// حواجز التلف: نسخ محلي من build-index.mjs:13-17 و lib/index.mjs:14 — لا استيراد حتى لا
// يتعارض الملفان؛ حتى لو حُذف من build-index بقي الحاجز هنا.
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
const REPLACEMENT_CHAR = /[\uFFFD\uE000-\uF8FF]/;
const PRESS_FILE = /IRAQ_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.indb(?:[ \t]*\d{1,4})?/g;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;
const PRESS_FILE_TEST = /IRAQ_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.indb(?:[ \t]*\d{1,4})?/;
const PRESS_STAMP_TEST = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/;
const FOLIO = /(?:\(\s*(?:ص|صفحه|صفحة|page)\s*[-:]?\s*\d{1,4}\s*\)|-\s*\d{1,4}\s*-\s*$|\bp{1,2}\.\s*\d{1,4}\b)/i;
const DIACRITICS = /[\u064B-\u0652\u0640]/g;
const normalizeAr = (value) => String(value ?? '')
  .replace(DIACRITICS, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
  .replace(/ة/g, 'ه').replace(/[ؤئ]/g, 'ء').replace(/\s+/g, ' ').trim();
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DEAD_TEMPLATE_LIST = [
  'نص الصفحة مستخرج من كتاب',
  'صفحة مصورة من كتاب',
  'محتوى الصفحة:',
  'استخراج محتوى الصفحة من الصورة',
  'قراءة التعريفات والأمثلة والمحتوى التعليمي',
  'تطبيق المفاهيم والتدرب على نمط الأسئلة',
  'شرح درس أو وحدة من المنهج',
  'تحديد موضوعات الكتاب ومواقعها',
];
const DEAD_TEMPLATE = new RegExp(`^(?:${DEAD_TEMPLATE_LIST.map((item) => escapeRe(normalizeAr(item))).join('|')})`);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanBlock(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// حروف المصنع وتاريخ الطباعة: نفس نقش build-index.mjs:16-17. تُنظَّف هنا عند الكتابة لأن
// pdf-books/pdf-index تمرّ من مسار بناء لا يمرّ بـ usableText (المقياس: 584 اسماً + 584 خاتمة).
function pressSlabChars(value) {
  return value.length - value.replace(PRESS_FILE, ' ').replace(PRESS_STAMP, ' ').length;
}

function stripPressSlab(value) {
  return value
    .replace(PRESS_FILE, ' ')
    .replace(PRESS_STAMP, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// تهريب محارف التحكم داخل السلاسل فقط: الأسطر حقيقية داخل النص المخزَّن، لكن لا يجوز
// المساس بأسطر البنية (حالة `{\n"text": ...`).
function escapeControlCharsInStrings(body) {
  let out = '';
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }
    if (char === '\\') { out += char + (body[i + 1] ?? ''); i += 1; continue; }
    if (char === '"') { inString = false; out += char; continue; }
    if (char === '\n' || char === '\r') { out += '\\n'; continue; }
    if (char === '\t') { out += '\\t'; continue; }
    out += char;
  }
  return out;
}

// كائن JSON كامل مخزَّن كنص (ocr.parser === "raw") — يُستخرج منه «.text» بدل الاحتفاظ به.
// المخزَّن يحوي أسطراً حقيقية داخل السلاسل بدل \n، فيفشل JSON.parse المباشر؛ لذلك ثلاثة
// مسارات: كما هو، ثم بتهريب محارف التحكم داخل السلاسل، ثم مسح مُوجَّه لحقل text.
function unwrapSerialized(value) {
  const text = String(value ?? '');
  if (!SERIALIZED_FIELD.test(text)) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0) return null;
  // تخزين مبتور بلا خاتمة: لا JSON.parse، لكن المسح المُوجَّه ينقذ المتاح.
  const body = end > start ? text.slice(start, end + 1) : text.slice(start);
  if (end > start) {
    for (const candidate of [body, escapeControlCharsInStrings(body)]) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) return parsed;
      } catch { /* المسار التالي */ }
    }
  }
  const marker = body.indexOf('"text"');
  if (marker < 0) return null;
  const colon = body.indexOf(':', marker);
  let cursor = colon + 1;
  while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1;
  if (body[cursor] !== '"') return null;
  const quoted = body.indexOf('","', cursor + 1);
  const stop = quoted >= 0 ? quoted : body.length;
  if (stop <= cursor + 1) return null;
  // لا خاتمة ⇒ التخزين نفسه مبتور (closing brace مفقود): يُنقذ المتاح ويُعلَّم.
  const salvaged = body.slice(cursor + 1, stop).replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return { text: salvaged, truncated: quoted < 0 };
}

let patchFiles = [];
try {
  patchFiles = (await readdir(PATCH_DIR)).filter((name) => name.endsWith('.json') && !name.startsWith('rejected-'));
} catch {
  console.log('لا يوجد مجلد ترقيعات.');
  process.exit(0);
}
if (!patchFiles.length) { console.log('لا توجد ترقيعات.'); process.exit(0); }

// ترتيب التطبيق: المولَّد أولاً (`enrich-*`) ثم المراجَع (`agent-*` وما شابه) أخيراً، فتفوز
// التصحيحات المتحقَّق منها على الوصف المولَّد. الترتيب الأبجدي القديم كان يفعل العكس.
const priorityOf = (name) => (name.startsWith('enrich-') ? 0 : 1);
patchFiles.sort((a, b) => priorityOf(a) - priorityOf(b) || a.localeCompare(b));

const bookCache = new Map();
const bookFile = (bookId) => path.join(BOOKS_DIR, `${bookId}.json`);
async function loadBook(bookId) {
  if (!bookCache.has(bookId)) {
    if (!await exists(bookFile(bookId))) return null;
    bookCache.set(bookId, JSON.parse(await readFile(bookFile(bookId), 'utf8')));
  }
  return bookCache.get(bookId);
}
async function exists(target) {
  try { await readFile(target, 'utf8'); return true; } catch { return false; }
}

// معجم المواد مبني من كل الكتب (لا من الكتاب المعني وحده) ليُحجب الإسناد إلى مادة أخرى.
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

const allBooks = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json')).sort();
const ownPhrases = new Map();
for (const name of allBooks) {
  const book = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
  ownPhrases.set(book.id, subjectPhrases(book));
  bookCache.set(book.id, book);
}
const foreignCache = new Map();
for (const bookId of ownPhrases.keys()) {
  const mine = ownPhrases.get(bookId);
  const out = new Set();
  for (const [id, phrases] of ownPhrases) {
    if (id === bookId) continue;
    for (const phrase of phrases) if (!mine.has(phrase)) out.add(phrase);
  }
  foreignCache.set(bookId, [...out].filter((phrase) => phrase.length >= 6).sort((a, b) => b.length - a.length));
}

// القواعد: `hard` = لا يُطبَّق إطلاقاً. الطول تحذير لا رفض — ترقيعات الوكيل المراجَع قد
// تكون مختصرة لكن صحيحة، فرفضُها يعني فقدان وصفٍ صحيح، والتحذير يظهر في التقرير.
function valueProblems(field, value, bookId, ownText) {
  const hard = [];
  const soft = [];
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { hard: ['EMPTY'], soft: [] };
  if (SERIALIZED_FIELD.test(text)) hard.push('SERIALIZED_JSON');
  if (CJK.test(text)) hard.push('CJK');
  if (REPLACEMENT_CHAR.test(text)) hard.push('U_FFFD');
  if (PRESS_FILE_TEST.test(text) || PRESS_STAMP_TEST.test(text)) hard.push('PRESS_SLAB');
  if (DEAD_TEMPLATE.test(normalizeAr(text))) hard.push('DEAD_TEMPLATE');
  if (field === 'title' && FOLIO.test(text)) hard.push('TITLE_FOLIO');
  {
    const normalized = normalizeAr(text);
    const own = normalizeAr(ownText || '');
    const hit = (foreignCache.get(bookId) || [])
      .find((phrase) => normalized.includes(phrase) && !(own.length >= 300 && own.includes(phrase)));
    if (hit) (FOREIGN_MODE === 'reject' ? hard : soft).push(`FOREIGN_SUBJECT:${hit}`);
  }
  if (field === 'title' && text.length > TITLE_MAX) soft.push(`TITLE_TOO_LONG:${text.length}`);
  if (field === 'educationalPurpose' && text.length < 60) soft.push(`PURPOSE_SHORT:${text.length}`);
  if (field === 'summary' && text.length < 40) soft.push(`SUMMARY_SHORT:${text.length}`);
  return { hard: [...new Set(hard)], soft: [...new Set(soft)] };
}

let applied = 0;
let appliedFields = 0;
let alreadyApplied = 0;
let rejectedEntries = 0;
let pressChars = 0;
let slabChars = 0;
let repairedPages = 0;
let repairedFields = 0;
const missing = [];
const errors = [];
const softWarn = new Map();
const rejectRows = [];
const rejectCodes = new Map();
const conflicts = [];
// آخر قيمة مُطبَّقة لكل (كتاب، صفحة، حقل): التكرار بين ملفات الترقيعات يُحسب مرة واحدة.
const tracked = new Map();
const repairedLog = [];
const dirtyBooks = new Set();
const dupWatch = new Map();

// ---------------------------------------------------------------------------
// مسح المكتبة كلها قبل تطبيق الترقيعات: يُصلح تلف التخزين (JSON مخزَّن كنص) وينظّف حروف
// المصنع وتواريخ الطباعة. كان ذلك يحدث في build-index فقط وقت التشغيل، فبقي 584 اسماً و584
// خاتمة داخل pdf-books/pdf-index. مسح الصفحات كلها لا صفحات الترقيعات فقط، لأن التلف
// (ص76 في student-book) لا ترقيعة تغطيه أصلاً.
// ---------------------------------------------------------------------------
for (const [bookId, book] of bookCache) {
  if (ONLY_BOOK && bookId !== ONLY_BOOK) continue;
  for (const page of book.pages) {
    const blob = REPAIR_SERIALIZED ? unwrapSerialized(page.fullText) : null;
    if (blob) {
      const before = String(page.fullText).length;
      page.fullText = cleanBlock(stripPressSlab(blob.text));
      repairedPages += 1;
      pressChars += pressSlabChars(blob.text);
      slabChars += before - String(page.fullText).length - pressSlabChars(blob.text);
      repairedLog.push(`${bookId}:${page.physicalPage} (${before} → ${String(page.fullText).length} محرف${blob.truncated ? ' · مبتور' : ''})`);
      dirtyBooks.add(bookId);
    }
    if (REPAIR_SERIALIZED) {
      // حقول وصفية ملوّثة بنفس الكائن: تُستعاد من الـ blob إن أمكن وإلا تُفرَّغ.
      for (const field of FIELDS) {
        if (!SERIALIZED_FIELD.test(String(page[field] ?? ''))) continue;
        const salvage = blob?.[field];
        page[field] = typeof salvage === 'string' && salvage.trim()
          ? clean(stripPressSlab(salvage)).slice(0, field === 'title' ? TITLE_MAX : 600)
          : '';
        repairedFields += 1;
        dirtyBooks.add(bookId);
      }
    }
    if (!PRESS_CLEAN) continue;
    for (const field of ['fullText', ...FIELDS]) {
      const value = page[field];
      if (typeof value !== 'string' || !value) continue;
      const cleaned = field === 'fullText' ? cleanBlock(stripPressSlab(value)) : clean(stripPressSlab(value));
      if (cleaned === value) continue;
      pressChars += pressSlabChars(value);
      slabChars += value.length - cleaned.length - pressSlabChars(value);
      page[field] = cleaned;
      if (field === 'fullText' && cleaned) page.searchable = true;
      dirtyBooks.add(bookId);
    }
  }
}

function noteReject(row) {
  rejectRows.push(row);
  rejectCodes.set(row.code, (rejectCodes.get(row.code) || 0) + 1);
}

for (const name of patchFiles) {
  let raw;
  try { raw = JSON.parse(await readFile(path.join(PATCH_DIR, name), 'utf8')); }
  catch (error) { errors.push(`${name}: JSON تالف (${error.message})`); continue; }
  const entries = Array.isArray(raw) ? raw : raw.patches || [];
  if (!Array.isArray(entries)) { errors.push(`${name}: لا مصفوفة مدخلات`); continue; }
  for (const entry of entries) {
    const bookId = String(entry.bookId || '').trim();
    const physicalPage = Number(entry.physicalPage);
    if (!bookId || !physicalPage) { errors.push(`${name}: سجل بلا bookId أو physicalPage`); continue; }
    if (ONLY_BOOK && bookId !== ONLY_BOOK) continue;
    const book = await loadBook(bookId);
    if (!book) { errors.push(`${name}: تعذر فتح ${bookId}`); continue; }
    const page = book.pages.find((item) => Number(item.physicalPage) === physicalPage);
    if (!page) { missing.push(`${bookId}:${physicalPage}`); continue; }

    const ownText = String(page.fullText || '');
    const changes = [];
    const rejects = [];
    for (const field of FIELDS) {
      if (entry[field] === undefined) continue;
      const incoming = String(entry[field]);
      const cleaned = stripPressSlab(incoming);
      const value = clean(cleaned);
      if (!value) continue;
      const { hard, soft } = valueProblems(field, value, bookId, ownText);
      if (hard.length) {
        for (const code of hard) {
          rejects.push({ field, code });
          noteReject({ source: name, bookId, physicalPage, field, code, value: value.slice(0, 160) });
        }
        continue;
      }
      for (const code of soft) softWarn.set(code, (softWarn.get(code) || 0) + 1);
      const stored = clean(page[field]);
      const clipped = field === 'title' ? value.slice(0, TITLE_MAX) : field === 'summary' ? value.slice(0, 600) : value.slice(0, 200);
      tracked.set(`${bookId}:${physicalPage}:${field}`, clipped);
      if (stored === clipped || stored.startsWith(clipped)) { alreadyApplied += 1; continue; }
      const dupKey = `${bookId}:${field}:${value}`;
      if (dupWatch.has(dupKey)) conflicts.push(`${bookId}:${physicalPage} ${field} = نفس النص حرفياً في ${dupWatch.get(dupKey)}`);
      else dupWatch.set(dupKey, `${bookId}:${physicalPage}`);
      pressChars += pressSlabChars(incoming);
      page[field] = clipped;
      appliedFields += 1;
      changes.push(field);
    }
    if (entry.fullText !== undefined) {
      const incoming = String(entry.fullText);
      const cleaned = stripPressSlab(incoming);
      const text = cleanBlock(cleaned);
      const hasText = text.replace(/\s+/g, '').length >= 5;
      if (!hasText) {
        // ترقيعة بنص فارغ كانت ستمسح نص الصفحة وتُسقطها من البحث (قياس: 3 صفحات في
        // agent-ocr-student.json نصّها ""), فرفض صريح.
        rejects.push({ field: 'fullText', code: hasText ? 'FULL_TEXT_TOO_SHORT' : 'EMPTY_FULL_TEXT_WOULD_WIPE' });
        noteReject({ source: name, bookId, physicalPage, field: 'fullText', code: hasText ? 'FULL_TEXT_TOO_SHORT' : 'EMPTY_FULL_TEXT_WOULD_WIPE', value: text.slice(0, 160) });
      } else {
        tracked.set(`${bookId}:${physicalPage}:fullText`, clean(text));
        if (clean(page.fullText) === clean(text)) alreadyApplied += 1;
        else {
          pressChars += pressSlabChars(incoming);
          page.fullText = text;
          page.searchable = true;
          page.needsOcr = false;
          page.ocr = {
            required: false,
            status: 'completed',
            engine: entry.vision ? 'agent-vision' : page.ocr?.engine || 'vision',
            model: entry.model || page.ocr?.model || 'mimo-v2.6-flash',
            at: new Date().toISOString(),
            parser: 'patch',
          };
          changes.push('fullText');
          appliedFields += 1;
        }
      }
    }
    if (rejects.length) {
      rejectedEntries += 1;
      console.log(`  ✗ ${bookId}:${physicalPage} ${rejects.map((item) => `${item.field}:${item.code}`).join(' · ')}`);
    }
    if (!changes.length) continue;
    dirtyBooks.add(bookId);
    if (entry.note) {
      page.reviewNotes = String(entry.note).slice(0, 400);
      page.reviewed = true;
    }
    applied += 1;
  }
}

// «المعلّقة قبل التشغيل» = كل حقل في الترقيعات لم يكن مخزنه مطابقاً لها، أي ما لم يصل إلى
// pdf-books في تشغيل سابق. «بعد التشغيل» = المتبقي بعد تطبيق كل ما قَبِلَ.
const pendingBefore = appliedFields + rejectRows.length;
const pendingAfterItems = [];
let pendingAfter = rejectRows.length;
for (const [key, value] of tracked) {
  const [bookId, physical, field] = key.split(':');
  const page = bookCache.get(bookId)?.pages.find((entry) => Number(entry.physicalPage) === Number(physical));
  const storedField = clean(page?.[field] || '');
  if (page && (storedField === value || storedField.startsWith(value))) continue;
  pendingAfter += 1;
  if (pendingAfterItems.length < 25) pendingAfterItems.push(`${key} مخزَّن=${clean(page?.[field] || '').slice(0, 50)} | ترقيعة=${value.slice(0, 50)}`);
}

function duplicationReport() {
  const out = {
    educationalPurpose: { filled: 0, unique: 0, duplicated: 0, ratio: 0 },
    summary: { filled: 0, unique: 0, duplicated: 0, ratio: 0 },
  };
  const maps = { educationalPurpose: new Map(), summary: new Map() };
  for (const book of bookCache.values()) {
    for (const page of book.pages) {
      for (const field of ['educationalPurpose', 'summary']) {
        const value = String(page[field] || '').trim();
        if (!value) continue;
        maps[field].set(value, (maps[field].get(value) || 0) + 1);
        out[field].filled += 1;
      }
    }
  }
  for (const field of ['educationalPurpose', 'summary']) {
    const counts = [...maps[field].values()];
    out[field].unique = counts.length;
    out[field].duplicated = counts.filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    out[field].ratio = out[field].filled ? +(100 * out[field].duplicated / out[field].filled).toFixed(1) : 0;
  }
  return out;
}

const dup = duplicationReport();

const report = {
  at: new Date().toISOString(),
  library: LIBRARY,
  dryRun: DRY_RUN,
  patchFiles: patchFiles.length,
  applied,
  changedEntries: applied,
  alreadyApplied,
  pendingBefore,
  pendingAfter,
  pendingAfterItems,
  rejectedEntries,
  pressCharsRemoved: pressChars,
  otherCharsNormalized: slabChars,
  serializedRepairedPages: repairedPages,
  serializedRepairedFields: repairedFields,
  serializedRepaired: repairedLog,
  softWarnings: Object.fromEntries([...softWarn.entries()].sort((a, b) => b[1] - a[1])),
  rejectCodes: Object.fromEntries([...rejectCodes.entries()].sort((a, b) => b[1] - a[1])),
  missing,
  errors,
  duplication: dup,
};

const tail = () => {
  if (rejectCodes.size) console.log('رفض:\n' + [...rejectCodes.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => `  ${String(count).padStart(5)}  ${code}`).join('\n'));
  if (softWarn.size) console.log('تحذيرات (لا رفض):\n' + [...softWarn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => `  ${String(count).padStart(5)}  ${code}`).join('\n'));
  if (missing.length) console.log(`صفحات غير موجودة: ${missing.length}`);
  for (const error of errors.slice(0, 20)) console.log(`خطأ: ${error}`);
};

if (DRY_RUN) {
  console.log('\n=== محاكاة بلا كتابة ===');
  console.log(`ترقيعات: ${patchFiles.length} ملف (المولَّد أولاً ثم المراجَع)`);
  console.log(`معلّقة قبل التشغيل: ${pendingBefore} حقل في ${applied + rejectedEntries} صفحة · قُبل وطُبِّق: ${appliedFields} · مرفوض: ${rejectRows.length} حقل · مطابق مسبقاً: ${alreadyApplied}`);
  console.log(`محارف حروف مصنع/تواريخ ستُنظَّف: ${pressChars} · صفحات JSON مخزَّن ستُفكّ: ${repairedPages}${repairedLog.length ? ` (${repairedLog.join(', ')})` : ''}`);
  console.log(`تكرار حرفي (بعد المحاكاة): educationalPurpose=${dup.educationalPurpose.ratio}% (${dup.educationalPurpose.duplicated}/${dup.educationalPurpose.filled}) · summary=${dup.summary.ratio}% (${dup.summary.duplicated}/${dup.summary.filled})`);
  tail();
  process.exit(missing.length || errors.length ? 1 : 0);
}

await mkdir(path.dirname(REPORT_FILE), { recursive: true });
if (rejectRows.length) await mkdir(REJECT_DIR, { recursive: true });

if (applied) {
  for (const bookId of dirtyBooks) {
    const book = bookCache.get(bookId);
    const file = bookFile(bookId);
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(book)}\n`);
    await rename(temp, file);
    const searchable = book.pages.filter((page) => page.fullText).length;
    console.log(`${bookId}: ${book.pages.length} صفحة · ${searchable} قابلة للبحث`);
  }
  try {
    const index = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
    index.books = index.books.map((entry) => {
      const fresh = bookCache.get(entry.id);
      if (!fresh) return entry;
      const copy = { ...fresh };
      delete copy.schemaVersion;
      return copy;
    });
    const tempIndex = `${PDF_INDEX}.tmp`;
    await writeFile(tempIndex, `${JSON.stringify(index)}\n`);
    await rename(tempIndex, PDF_INDEX);
    report.pdfIndex = 'updated';
  } catch (error) {
    report.pdfIndex = `skipped: ${error.message}`;
    console.log(`pdf-index لم يُحدَّث: ${error.message}`);
  }
}

if (rejectRows.length) {
  const file = path.join(REJECT_DIR, `apply-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
  await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), count: rejectRows.length, rejects: rejectRows }, null, 1)}\n`);
}
await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 1)}\n`);

console.log('\n=== الملخص ===');
console.log(`ترقيعات معلّقة قبل التشغيل: ${pendingBefore} حقل في ${applied + rejectedEntries} صفحة · طُبِّق الآن: ${appliedFields} حقل في ${applied} صفحة · بقي معلّقاً بعد: ${pendingAfter} · مرفوض: ${rejectedEntries}`);
console.log(`محارف حروف مصنع/تواريخ أُزيلت: ${pressChars} · صفحات JSON مخزَّن أُصلحت: ${repairedPages}${repairedLog.length ? ` (${repairedLog.join(', ')})` : ''}`);
console.log(`تكرار حرفي: educationalPurpose=${dup.educationalPurpose.ratio}% (${dup.educationalPurpose.duplicated}/${dup.educationalPurpose.filled}) · summary=${dup.summary.ratio}% (${dup.summary.duplicated}/${dup.summary.filled})`);
if (conflicts.length) console.log(`تعارض: ${conflicts.length} مدخل طُبِّق مرتين لنفس الحقل (آخر واحد يفوز)`);
tail();
console.log(`التقرير: ${path.relative(ROOT, REPORT_FILE)}`);
if (missing.length || errors.length) process.exitCode = 1;