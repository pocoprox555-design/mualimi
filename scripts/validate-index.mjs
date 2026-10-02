// مدقّق الفهرس: يقرأ الطبقات كلها ويخرج رقم اكتمال واحد لكل كتاب + جدول موحّد للمكتبة
// + قائمة الفجوات الحرجة. الفحص لا يُصلح شيئاً: مهمته أن يمنع مرور العيب صامتاً.
//
//   node scripts/validate-index.mjs                     # جدول كامل + خروج بشيفرة غير صفر عند فجوة حرجة
//   node scripts/validate-index.mjs --json out.json     # نفس النتيجة في ملف
//   node scripts/validate-index.mjs --no-exit           # لا يُخرج شيفرة غير صفر (للقياس فقط)
//
// سلسلة المصادر: pdf-sources (PDF) ← pdf-index/pdf-books (المستخرج) ← search-index (وقت التشغيل).
// كل طبقة أقدم من مصدرها أو متناقضة معه تُحسب فجوة، لا تفصيلاً.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText } from '../lib/text.mjs';
import { normalizeDigits } from '../lib/text.mjs';
import { crossBookDuplicates, deadLayers, foreignUnits, judgeNumbers, noTextPages, titleRepetition } from './validate-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'curriculum-library');
const SEARCH_INDEX = path.join(LIB, 'search-index.json');
const PDF_INDEX = path.join(LIB, 'pdf-index.json');
const BOOKS_DIR = path.join(LIB, 'pdf-books');
const OUTLINES_DIR = path.join(LIB, 'outlines');
const ENRICHMENT_DIR = path.join(LIB, 'enrichment');
const SOURCES_DIR = path.join(LIB, 'pdf-sources');
const FAST_INDEX = path.join(LIB, 'fast-index.json');
const CATALOG = path.join(LIB, 'catalog.json');
const LEGACY_INDEX_DIR = path.join(LIB, 'index');

const TEXT_MIN = 20;
const PAGE_TYPES = new Set(['divider', 'lesson_content', 'parallel_text', 'boxed_recap', 'matching', 'exercises', 'glossary', 'contents']);
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const WEIGHT = { critical: 12, high: 6, medium: 2.5, low: 1 };
const PRESS_FILE_SRC = 'IRAQ_G\\d+_[A-Z]{2,4}_\\d{4}\\.indb';
const PRESS_FILE = new RegExp(PRESS_FILE_SRC, 'gi');
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const HEBREW = /[\u0590-\u05ff]/u;
const PUA = /[\uE000-\uF8FF]/g;
const REPLACEMENT = /\uFFFD/g;
const PERSIAN = /[پچژگیک]/g;
const ALLAH_BROKEN = /(?:هللا|هلالا|األله|األه|للهل|الهل|باهلل|اهلل)/g;
const SERIALIZED_ANY = /"text"\s*:|"summary"\s*:|"title"\s*:/;
const DIGIT_RUN = /[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)*/g;
const OUTLINE_ENTRY = /^### الصفحة الفيزيائية (\d+)[^\n]*$/gm;
const RELIGIOUS = /(?:quran|hadith|fiqh|islamic|tazkirah|khutba)/i;
const NO_TEXT_CLAIM = /لا يمكن الإجابة|لا نص مستخرج|لا يوجد نص|صفحة مصورة|تحتاج قراءة بصرية/;
// اسم وحدة عام («الفصل الثاني»، «Unit 3») لا يدل على إسناد خطأ: الكتب تشترك في التسمية.
const GENERIC_UNIT = /^(?:ال)?(?:فصل|فصول|وحدة|وحدات|درس|دروس|باب|أبواب|مبحث|مباحث|قسم|أقسام|بند|بنود|تمهيد|تهيده|مقدمه|مقدمة|خاتمه|خاتمة|غلاف|فهرس|فهرست|محتويات|عناوين|lesson|unit|chapter|part|section|introduction|preface|index|contents)\s*(?:ال)?(?:اول|الأول|أول|الأولى|أولى|ثاني|الثاني|ثانية|الثانية|ثالث|الثالث|ثالثة|الثالثة|رابع|الرابع|رابعة|الرابعة|خامس|الخامس|خمسة|الخامسة|سادس|السادس|ستة|السادسة|سابع|السابع|سبعة|السابعة|ثامن|الثامن|ثمانية|الثامنة|تاسع|التاسع|تسعة|التاسعة|عاشر|العاشر|عشرة|العاشرة|الكتاب|كتاب|\d+)?[\s.\-–—:]*$/i;
// كسر ترتيب القراءة: أسس صارت «x 2»، وجذر داخل قوس مقلوب، و«2 9 + 16 [ √»
const BROKEN_MATH = /(?:[0-9٠-٩۰-۹]\s+[0-9]{1,3}\s*\+\s*[0-9]{1,3}\s*[\[(]?\s*√)|(?:\b[a-zA-Z]\s*\^\s*[0-9])|(?:√\s*\]\s*[0-9])|(?:[0-9٠-٩۰-۹]\s*\^\s*[0-9٠-٩۰-۹]\s*\])|(?:[\])]\s*[^\n]{0,6}?[0-9]{1,3}\s*[\[(])/g;
const digits = (value) => [...String(value || '').matchAll(DIGIT_RUN)].map((match) => normalizeDigits(match[0]).replace(/[.,٫]/g, ''));
const arabicFold = (value) => String(value || '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ٰٟ]/g, '');
const squeeze = (value) => String(value || '').replace(/\s+/g, ' ').trim();
//Forms التقديم (ﻩ ﺱ ﺔ) تُطبَّع NFKC عند البناء، فالمقارنة يجب أن تمرّ عليها أيضاً وإلا حُسب كل سطر مفقوداً.
// signature تُسقط الفروق التي يطبّقها البناء شرعاً: التطبيع، توحيد الأرقام، رموز التشكيل، وطول شرطات الفراغ.
const fold = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const COMBINING = /[̀-ًͯ-ٰٟۖ-ۭ]/g;
const signature = (value) => fold(value).normalize('NFD').replace(COMBINING, '')
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
  .replace(/[_]{2,}/g, '_')
  .replace(/[─-╿—―]{2,}/g, '_');
const countMatches = (text, regex) => (String(text).match(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)) || []).length;
const round = (value) => Math.round(value * 100) / 100;
const pct = (value) => `${(Math.round(value * 1000) / 10).toFixed(1)}%`;

// ── أدوات ────────────────────────────────────────────────────────────────────
async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fileStamp(target) {
  try {
    const info = await stat(target);
    return { exists: true, mtime: info.mtime.toISOString(), bytes: info.size };
  } catch {
    return { exists: false, mtime: null, bytes: 0 };
  }
}

function makeBookReport(id, title) {
  const findings = [];
  return {
    id,
    title,
    pages: 0,
    findings,
    notes: {},
    add(severity, code, message, extra = {}) {
      findings.push({ severity, code, message, ...extra });
    },
    counts() {
      const counts = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const finding of findings) counts[finding.severity] += 1;
      return counts;
    },
    score() {
      const counts = this.counts();
      const penalty = Math.min(80, SEVERITIES.reduce((sum, severity) => sum + counts[severity] * WEIGHT[severity], 0));
      return round(Math.max(0, Math.min(100, 100 - penalty)));
    },
  };
}

async function listFiles(dir, suffix) {
  const out = [];
  for (const name of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (name.isFile() && name.name.endsWith(suffix)) out.push(path.relative(ROOT, path.join(dir, name.name)));
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// النص المتوقَّع بعد التنقية نفسها التي يطبّقها البناء (scripts/build-index.mjs: usableText ثم إزالة الفوليو).
function expectedText(pdfPage, folioCandidates = []) {
  const folios = [pdfPage.printedPage, pdfPage.printedPageNumber, ...folioCandidates]
    .map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  let out = cleanText(String(pdfPage.fullText || '')).replace(new RegExp(PRESS_FILE_SRC, 'gi'), ' ').replace(PRESS_STAMP, ' ');
  let previous;
  do {
    previous = out;
    const head = out.match(/^\s*\d{1,4}\s+/);
    if (head && folios.includes(Number(head[0].trim()))) out = out.slice(head[0].length).trim();
    const tail = out.match(/\s(\d{1,4})\s*$/);
    if (tail && folios.includes(Number(tail[1]))) out = out.slice(0, out.length - tail[0].length).trim();
  } while (out !== previous);
  return out;
}

function duplicateShareOf(values) {
  const list = values.filter(Boolean);
  if (!list.length) return 0;
  const counts = new Map();
  for (const value of list) counts.set(value, (counts.get(value) || 0) + 1);
  return Math.max(...counts.values()) / list.length;
}

function summarizeIntegrity(items) {
  const counts = {};
  for (const item of items) {
    if (item.verdict !== 'unverified') continue;
    counts[item.integrity] = (counts[item.integrity] || 0) + 1;
  }
  return counts;
}

// الدليل على أن طبقة ما حيّة: من يشير إليها في كود المشروع. نتيجة سالبة = موت.
// هذا الملف نفسه مستثنى، وإلا صار قارئاً لنفسه فكل طبقة تبدو حيّة.
const CODE_FILES = ['server.mjs'];
let codeFileList = null;
async function codeReaders(pattern) {
  if (!codeFileList) {
    codeFileList = [
      ...CODE_FILES,
      ...await listFiles(path.join(ROOT, 'lib'), '.mjs'),
      ...await listFiles(path.join(ROOT, 'public'), '.js'),
      ...await listFiles(path.join(ROOT, 'scripts'), '.mjs'),
    ].map((file) => path.resolve(ROOT, file));
  }
  const self = path.resolve(fileURLToPath(import.meta.url));
  const readers = [];
  for (const file of codeFileList) {
    if (file === self) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    if (pattern.test(text)) readers.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  }
  return readers;
}

// ── التحميل ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const asJson = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const noExit = args.includes('--no-exit');
const gate = args.includes('--gate');

const searchIndex = await readJson(SEARCH_INDEX);
if (!searchIndex?.documents) {
  console.error('CURRICULUM_INDEX_INVALID: لا يمكن قراءة curriculum-library/search-index.json');
  process.exit(2);
}
const pdfIndex = await readJson(PDF_INDEX, { books: [] });
const docsByBook = new Map();
for (const doc of searchIndex.documents) {
  if (!docsByBook.has(doc.bookId)) docsByBook.set(doc.bookId, []);
  docsByBook.get(doc.bookId).push(doc);
}
for (const list of docsByBook.values()) list.sort((a, b) => a.physicalPage - b.physicalPage);
const pdfBooks = new Map();
for (const name of (await readdir(BOOKS_DIR).catch(() => [])).filter((file) => file.endsWith('.json')).sort()) {
  const book = await readJson(path.join(BOOKS_DIR, name));
  if (book?.id) pdfBooks.set(book.id, book);
}
const searchBooks = new Map((searchIndex.books || []).map((book) => [book.id, book]));
const pdfIndexById = new Map((pdfIndex.books || []).map((book) => [book.id, book]));

const stamps = {
  'search-index.json': await fileStamp(SEARCH_INDEX),
  'pdf-index.json': await fileStamp(PDF_INDEX),
  outlines: await fileStamp(OUTLINES_DIR),
  enrichment: await fileStamp(ENRICHMENT_DIR),
  'fast-index.json': await fileStamp(FAST_INDEX),
  'catalog.json': await fileStamp(CATALOG),
  'index/materials.json': await fileStamp(path.join(LEGACY_INDEX_DIR, 'materials.json')),
  'index/search-index.json': await fileStamp(path.join(LEGACY_INDEX_DIR, 'search-index.json')),
};
const bookStamps = new Map();
for (const id of pdfBooks.keys()) bookStamps.set(id, await fileStamp(path.join(BOOKS_DIR, `${id}.json`)));
const outlineStamps = new Map();
for (const name of (await readdir(OUTLINES_DIR).catch(() => [])).filter((file) => file.endsWith('.md'))) {
  outlineStamps.set(name.slice(0, -3), await fileStamp(path.join(OUTLINES_DIR, name)));
}
const outlineRaw = new Map();
for (const [id, stamp] of outlineStamps) if (stamp.exists) outlineRaw.set(id, await readFile(path.join(OUTLINES_DIR, `${id}.md`), 'utf8'));
const enrichmentStamps = new Map();
for (const name of (await readdir(ENRICHMENT_DIR).catch(() => [])).filter((file) => file.endsWith('.json'))) {
  enrichmentStamps.set(name.slice(0, -5), await fileStamp(path.join(ENRICHMENT_DIR, name)));
}
const sourceDigests = new Map();
for (const name of await readdir(SOURCES_DIR).catch(() => [])) {
  const buffer = await readFile(path.join(SOURCES_DIR, name));
  sourceDigests.set(createHash('sha256').update(buffer).digest('hex'), { name, bytes: buffer.length });
}
const searchTime = Date.parse(stamps['search-index.json'].mtime);
const olderByHours = (stamp) => (stamp?.exists ? round((searchTime - Date.parse(stamp.mtime)) / 3_600_000) : null);

// ── سجل الفحوص ───────────────────────────────────────────────────────────────
const CHECKS = [
  { id: 'A1', title: 'اكتمال الصفحات: pagesMissingFromIndex / pagesBeyondPdf' },
  { id: 'A2', title: 'صفحة فيها نص في PDF وفارغة في search-index (عتبة 20 حرفاً)' },
  { id: 'A3', title: 'اقتطاع search-index.text مقابل fullText (حروف مصنع ≠ محتوى)' },
  { id: 'A4', title: 'تلف النص: U+FFFD / رموز PUA / فارسية / «هللا» / محارف غريبة' },
  { id: 'A5', title: 'النص غير المرئي المكرر: نسبة تكرار الأسطر داخل الصفحة' },
  { id: 'A6', title: 'خلط الأعمدة وكسر الأقواس والأسس' },
  { id: 'A7', title: 'صفحة بلا نص في الـPDF، وهي تحمل وصفاً في الفهرس' },
  { id: 'B7', title: 'محتوى مخترق/مسرَّب: JSON / CJK / عبري داخل الحقول' },
  { id: 'B8', title: 'أرقام لا يثبتها نص الصفحة (غير مُثبتة ⇒ تحتاج عيناً لا حذفاً)' },
  { id: 'B9', title: 'pageType خارج التعداد' },
  { id: 'B10', title: 'إسناد خاطئ: summary/educationalPurpose يذكر كتاباً آخر' },
  { id: 'B11', title: 'اقتباس ديني يحتاج مراجعة (PUA/U+FFFD ⇒ غير صالح للاستشهاد)' },
  { id: 'C12', title: 'تكرار حرفي في summary / educationalPurpose / title' },
  { id: 'C13', title: 'summary قصير جداً مقابل text (نسبة التغطية)' },
  { id: 'C14', title: 'educationalPurpose فارغ/قصير/مكرر' },
  { id: 'C15', title: 'unit فارغ أو وارد من كتاب آخر' },
  { id: 'C16', title: 'section ثابتة على كل الصفحات' },
  { id: 'C21', title: 'عنوان الصفحة هو عنوان الكتاب ⇒ الصفحة بلا هوية في الاسترجاع' },
  { id: 'D17', title: 'printedPage مخمَّن خلاف README (قاعدة ثوابت build-index.mjs)' },
  { id: 'D18', title: 'طبقة أقدم من مصدرها أو متناقضة معه' },
  { id: 'D19', title: 'enrichment غائب و figures/glossary/activities/exercises صفر' },
  { id: 'D20', title: 'سلامة البصمة: source.checksum و source.bytes مقابل الملف الفعلي' },
  { id: 'D21', title: 'طبقة ميتة: ملف لا يشير إليه أي كود في المشروع' },
  { id: 'D22', title: 'تكرار حرفي بين الكتب (نسخ مقصود أم خطأ فهرسة؟)' },
].map((entry) => ({ ...entry, findings: [], critical: 0 }));
const record = (code, bookId, severity, detail) => {
  const entry = CHECKS.find((item) => item.id === code);
  if (!entry) return;
  entry.findings.push({ bookId, detail, severity });
  entry.critical += severity === 'critical' ? 1 : 0;
};

// ── فحوص الكتب ───────────────────────────────────────────────────────────────
const bookReports = [];
const unverifiedNumbers = [];
const allUnits = new Map();
const foreignUnitOwners = new Map();
for (const [bookId, book] of searchBooks) {
  for (const doc of docsByBook.get(bookId) || []) {
    const unit = String(doc.unit || '').trim();
    if (!unit) continue;
    if (!allUnits.has(unit)) allUnits.set(unit, new Set());
    allUnits.get(unit).add(bookId);
  }
}
// كلمات تعريف الكتاب: من العنوان فقط، وطويلة، وليست مشتركة بين أكثر من كتاب (لا «الديني» ولا «للسادس»).
const identityTokens = new Map();
for (const [id, book] of searchBooks) {
  identityTokens.set(id, arabicFold(book.title).split(/\s+/).filter((word) => word.length >= 8));
}
const tokenOwners = new Map();
for (const [id, words] of identityTokens) for (const word of words) tokenOwners.set(word, (tokenOwners.get(word) || 0) + 1);
const otherBooks = [...searchBooks]
  .map(([id]) => ({ id, tokens: (identityTokens.get(id) || []).filter((word) => tokenOwners.get(word) === 1) }))
  .filter((entry) => entry.tokens.length);

for (const [bookId, book] of searchBooks) {
  const report = makeBookReport(bookId, book.title);
  bookReports.push(report);
  const docs = docsByBook.get(bookId) || [];
  const pdfBook = pdfBooks.get(bookId);
  const pdfPages = new Map((pdfBook?.pages || []).map((page) => [Number(page.physicalPage ?? page.pageNumber), page]));
  const docByPage = new Map(docs.map((doc) => [doc.physicalPage, doc]));
  report.pages = docs.length;

  // A1 ── حضور الصفحات
  const missingFromIndex = [...pdfPages.keys()].filter((page) => !docByPage.has(page));
  const beyondPdf = docs.filter((doc) => !pdfPages.has(doc.physicalPage)).map((doc) => doc.physicalPage);
  const pdfPageCount = pdfPages.size;
  report.notes.pages = { pdf: pdfPageCount, index: docs.length, declared: book.pageCount };
  if (missingFromIndex.length) {
    report.add('high', 'A1', `${missingFromIndex.length} صفحة في pdf-books غائبة عن search-index`, { pages: missingFromIndex.slice(0, 12) });
    record('A1', bookId, 'high', `${missingFromIndex.length} صفحة مفقودة`);
  }
  if (beyondPdf.length) {
    report.add('high', 'A1', `${beyondPdf.length} صفحة في search-index بلا صفحة مصدر`, { pages: beyondPdf.slice(0, 12) });
    record('A1', bookId, 'high', `${beyondPdf.length} صفحة زائدة`);
  }
  if (pdfPageCount - docs.length > 0) {
    report.add('medium', 'A1', `الفهرس ينقصه ${pdfPageCount - docs.length} صفحة عن pdf-books`);
    record('A1', bookId, 'medium', `نقص ${pdfPageCount - docs.length} صفحة`);
  }
  if (pdfBook && pdfPageCount !== book.pageCount) {
    report.add('low', 'A1', `pageCount المعلن ${book.pageCount} لا يطابق pdf-books ${pdfPageCount}`);
  }

  // A2 ── نص موجود في PDF وساقط من فهرس التشغيل
  const lostPages = [];
  for (const [page, pdfPage] of pdfPages) {
    const doc = docByPage.get(page);
    if (!doc) continue;
    if (squeeze(pdfPage.fullText).length >= TEXT_MIN && squeeze(doc.text).length < TEXT_MIN) lostPages.push(page);
  }
  report.notes.textLost = lostPages.length;
  if (lostPages.length) {
    report.add('critical', 'A2', `${lostPages.length} صفحة نصّها في PDF وساقط من search-index`, { pages: lostPages.slice(0, 12) });
    for (const page of lostPages) record('A2', bookId, 'critical', `ص${page} بلا نص في الفهرس`);
  }

  // A7 ── صفحة بلا نص وهي محملة بوصف: الوصف يقرأه النموذج كأنه من الصفحة،
  // فالصفحة التي لا نصّ لها يجب أن تصله مصحوبةً بوسم لا بوصف يُقتطع كدليل.
  const blind = noTextPages(docs);
  report.notes.noText = { empty: blind.empty.length, share: blind.share, withClaims: blind.claims.length };
  if (blind.empty.length) {
    const severity = blind.share > 0.1 || blind.claims.length ? 'high' : 'medium';
    const claimNote = blind.claims.length ? ` · ${blind.claims.length} منها تحمل title/summary بلا سند نصي` : '';
    report.add(severity, 'A7', `${blind.empty.length} من ${docs.length} صفحة بلا نص (${pct(blind.share)})${claimNote}`, { pages: blind.empty.slice(0, 12) });
    record('A7', bookId, severity, `${blind.empty.length} بلا نص${blind.claims.length ? ` · ${blind.claims.length} بوصف` : ''}`);
  }

  // A3 ── الاقتطاع: نقيس النص المتوقَّع بعد التنقية نفسها التي يطبّقها البناء (scripts/build-index.mjs)
  let truncatedPages = 0; let totalExpected = 0; let lostReal = 0;
  const truncSamples = [];
  for (const [page, pdfPage] of pdfPages) {
    const doc = docByPage.get(page);
    if (!doc) continue;
    const expected = expectedText(pdfPage, [doc.printedPage, doc.physicalPage]);
    if (expected.length < TEXT_MIN) continue;
    const indexed = squeeze(doc.text);
    totalExpected += expected.length;
    if (indexed.length >= expected.length * 0.98) continue;
    const flatIndexed = signature(doc.text);
    const lost = expected.split('\n').map((line) => signature(line))
      .filter((line) => line.length >= 25 && !flatIndexed.includes(line.slice(0, 40)));
    if (!lost.length) continue;
    truncatedPages += 1;
    lostReal += lost.reduce((sum, line) => sum + line.length, 0);
    if (truncSamples.length < 5) truncSamples.push({ page, expected: expected.length, indexed: indexed.length, snippet: lost.join(' ').slice(0, 70) });
  }
  const lostShare = totalExpected ? lostReal / totalExpected : 0;
  report.notes.truncation = { pages: truncatedPages, lostShare: round(lostShare * 100), samples: truncSamples };
  if (truncatedPages) {
    const severity = lostShare > 0.15 ? 'high' : lostShare > 0.05 ? 'medium' : 'low';
    report.add(severity, 'A3', `${truncatedPages} صفحة فقدت أسطراً من محتواها (${pct(lostShare)} من النص المتوقع غير وارد في search-index)`, { samples: truncSamples, lostShare: round(lostShare * 100) });
    record('A3', bookId, severity, `${truncatedPages} صفحة · مفقود ${pct(lostShare)}`);
  }

  // A4 ── تلف النص
  const corruption = { replacement: 0, pua: 0, persian: 0, allah: 0, other: 0, chars: 0, pages: 0, samples: [] };
  for (const doc of docs) {
    const text = String(doc.text || '');
    if (!text) continue;
    corruption.chars += text.length;
    const replacement = countMatches(text, REPLACEMENT);
    const pua = countMatches(text, PUA);
    const persian = countMatches(text, PERSIAN);
    const allah = countMatches(text, ALLAH_BROKEN);
    const other = (text.match(/[^\p{L}\p{N}\s.,:;%()\[\]{}«»\-–—/\\*=&+<>؟!،؛؟'"…‏‎؜۝]/gu) || []).length;
    corruption.replacement += replacement;
    corruption.pua += pua;
    corruption.persian += persian;
    corruption.allah += allah;
    corruption.other += other;
    if (replacement || pua || persian || allah) {
      corruption.pages += 1;
      if (corruption.samples.length < 5) corruption.samples.push({ page: doc.physicalPage, snippet: text.slice(0, 60) });
    }
  }
  report.notes.corruption = corruption;
  if (corruption.replacement) {
    report.add('high', 'A4', `${corruption.replacement} محرف تالف U+FFFD في ${corruption.pages} صفحة`);
    record('A4', bookId, 'high', `${corruption.replacement} U+FFFD`);
  }
  if (corruption.pua) {
    report.add('high', 'A4', `${corruption.pua} رمز PUA خاص في ${corruption.pages} صفحة`);
    record('A4', bookId, 'high', `${corruption.pua} PUA`);
  }
  if (corruption.allah) {
    report.add('high', 'A4', `${corruption.allah} موضع «الله» مشوّه (هللا/أهلل)`);
    record('A4', bookId, 'high', `${corruption.allah} الله مشوّه`);
  }
  if (corruption.persian) {
    report.add('medium', 'A4', `${corruption.persian} حرف فارسي/پاكستاني في النص`);
    record('A4', bookId, 'medium', `${corruption.persian} حرف فارسي`);
  }
  if (corruption.chars && corruption.other / corruption.chars > 0.02) {
    report.add('medium', 'A4', `${pct(corruption.other / corruption.chars)} من المحارف خارج العربية/اللاتينية/الرقم`);
    record('A4', bookId, 'medium', `${pct(corruption.other / corruption.chars)} محارف غريبة`);
  }

  // A5 ── النص غير المرئي المكرر: أسطر أو عبارات مطابقة داخل الصفحة نفسها
  const dupRatios = [];
  for (const doc of docs) {
    const text = String(doc.text || '');
    if (text.length < TEXT_MIN) continue;
    const measure = (pieces) => {
      const counts = new Map();
      for (const piece of pieces) counts.set(piece, (counts.get(piece) || 0) + 1);
      let repeated = 0;
      for (const [piece, count] of counts) if (count > 1) repeated += piece.length * (count - 1);
      return repeated / text.length;
    };
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 12);
    const clauses = text.split(/[.!؟?\n،؛;]/).map((clause) => fold(clause).trim()).filter((clause) => clause.length >= 30);
    if (lines.length < 4 && clauses.length < 2) continue;
    const ratio = Math.max(lines.length >= 4 ? measure(lines) : 0, clauses.length >= 2 ? measure(clauses) : 0);
    if (ratio > 0) dupRatios.push({ page: doc.physicalPage, ratio });
  }
  const dupMean = dupRatios.length ? dupRatios.reduce((sum, item) => sum + item.ratio, 0) / dupRatios.length : 0;
  const dupWorst = dupRatios.slice().sort((a, b) => b.ratio - a.ratio).slice(0, 4);
  const dupPeak = dupWorst[0]?.ratio || 0;
  const dupPages = dupRatios.filter((item) => item.ratio > 0.1).length;
  report.notes.duplicateLines = { mean: round(dupMean * 100), peak: round(dupPeak * 100), pages: dupPages, worst: dupWorst.map((item) => ({ page: item.page, ratio: round(item.ratio * 100) })) };
  if (dupPeak > 0.1 || dupMean > 0.05) {
    const severity = dupPeak > 0.2 || dupMean > 0.15 ? 'high' : 'medium';
    report.add(severity, 'A5', `${dupPages} صفحة فيها نص مكرر داخلها؛ المتوسط ${pct(dupMean)} وأسوأ صفحة ${dupWorst[0]?.page} بنسبة ${pct(dupPeak)}`);
    record('A5', bookId, severity, `${dupPages} صفحة · ذروة ${pct(dupPeak)}`);
  }

  // A6 ── كسر الأعمدة والأسس
  let brokenPages = 0; let brokenHits = 0;
  const brokenSamples = [];
  for (const doc of docs) {
    const text = String(doc.text || '');
    if (!text) continue;
    const hits = countMatches(text, BROKEN_MATH);
    if (!hits) continue;
    brokenHits += hits;
    brokenPages += 1;
    if (brokenSamples.length < 4) brokenSamples.push({ page: doc.physicalPage, hits, snippet: (text.match(new RegExp(BROKEN_MATH.source, 'g')) || [''])[0].slice(0, 50) });
  }
  const brokenShare = docs.length ? brokenPages / docs.length : 0;
  report.notes.brokenMath = { pages: brokenPages, hits: brokenHits, share: round(brokenShare * 100), samples: brokenSamples };
  if (brokenPages) {
    const severity = brokenShare > 0.3 ? 'high' : brokenShare > 0.1 ? 'medium' : 'low';
    report.add(severity, 'A6', `${brokenPages} صفحة (${pct(brokenShare)}) فيها كسر أقواس/أسس · ${brokenHits} موضعاً`, { samples: brokenSamples });
    record('A6', bookId, severity, `${brokenPages} صفحة · ${brokenHits} كسر`);
  }

  // B7 ── محتوى مخترق
  const leaks = { json: 0, cjk: 0, hebrew: 0, samples: [] };
  const leakFields = ['title', 'summary', 'preview', 'outlineSummary', 'unit', 'section', 'purpose'];
  for (const doc of docs) {
    for (const field of leakFields) {
      const value = String(doc[field] || '');
      if (!value) continue;
      const isJson = /^\s*\{/.test(value) || SERIALIZED_ANY.test(value);
      const isCjk = CJK.test(value);
      const isHebrew = HEBREW.test(value);
      if (!isJson && !isCjk && !isHebrew) continue;
      if (isJson) leaks.json += 1;
      if (isCjk) leaks.cjk += 1;
      if (isHebrew) leaks.hebrew += 1;
      if (leaks.samples.length < 5) leaks.samples.push({ page: doc.physicalPage, field, snippet: value.slice(0, 60) });
    }
  }
  const leakTotal = leaks.json + leaks.cjk + leaks.hebrew;
  report.notes.leaks = leaks;
  if (leakTotal) {
    const severity = leaks.json ? 'critical' : 'high';
    report.add(severity, 'B7', `${leakTotal} حقل فيه محتوى مخترق (JSON ${leaks.json} · CJK ${leaks.cjk} · عبري ${leaks.hebrew})`, { samples: leaks.samples });
    record('B7', bookId, severity, `${leakTotal} حقل مخترق (JSON ${leaks.json})`);
  }

  // B8 ── أرقام لا يثبتها نص الصفحة
  // ثلاثتها مقصودة: غياب الرقم من النص ليس دليل اختلاق، والنص قد يكون ناقصاً
  // (صفحة مصوّرة، أو رقم داخل جدول أو صورة أو صفحة مقابلة). فالمنفصل هنا
  // «غير مُثبت» بعينه لا «مُختلق»، والتصعيد إلى حرج يبقى عمل مراجعة بصرية.
  const numbers = judgeNumbers(docs);
  report.notes.numbers = { ...numbers.counts, integrity: summarizeIntegrity(numbers.items) };
  for (const item of numbers.unverified) unverifiedNumbers.push({ bookId, ...item });
  if (numbers.unverified.length || numbers.counts.layerless) {
    const pages = new Set(numbers.unverified.map((item) => item.page));
    const layerless = numbers.counts.layerless ? ` · ${numbers.counts.layerless} رقماً في ${blind.empty.length} صفحة بلا طبقة نصّ أصلاً (انظر A7)` : '';
    report.add('high', 'B8', `${numbers.unverified.length} رقم في ${pages.size} صفحة لا يثبته نص الصفحة ⇒ يحتاج مراجعة بصرية لا حذفاً (${numbers.counts.verified} بدليل بصري · ${numbers.counts.structural} ترقيم بنيوي${layerless})`, { samples: numbers.unverified.slice(0, 8) });
    record('B8', bookId, 'high', `${numbers.unverified.length} غير مُثبت${numbers.counts.layerless ? ` · ${numbers.counts.layerless} بلا طبقة نص` : ''}`);
  }

  // B9 ── pageType
  const badTypes = new Map();
  for (const doc of docs) {
    const type = String(doc.pageType || '');
    if (!type || PAGE_TYPES.has(type)) continue;
    badTypes.set(type, (badTypes.get(type) || 0) + 1);
  }
  const badTypeTotal = [...badTypes.values()].reduce((sum, value) => sum + value, 0);
  report.notes.pageTypes = { badTotal: badTypeTotal, kinds: badTypes.size, top: [...badTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  if (badTypeTotal) {
    const share = badTypeTotal / Math.max(1, docs.length);
    const severity = share > 0.2 ? 'high' : 'medium';
    report.add(severity, 'B9', `${badTypeTotal} صفحة pageType خارج التعداد (${badTypes.size} نوعاً: ${[...badTypes.keys()].slice(0, 4).join('، ')})`);
    record('B9', bookId, severity, `${badTypeTotal} صفحة · ${badTypes.size} نوع`);
  }

  // B10 ── إسناد خاطئ: حقل ينسب الصفحة صراحةً إلى كتابٍ آخر («نص صفحة من كتاب X»)
  const ownName = identityTokens.get(bookId)?.[0] || '';
  const misattributed = [];
  let crossReferences = 0;
  for (const doc of docs) {
    const fields = [['summary', doc.summary], ['outlineSummary', doc.outlineSummary], ['educationalPurpose', pdfPages.get(doc.physicalPage)?.educationalPurpose], ['purpose', doc.purpose]];
    for (const [field, rawValue] of fields) {
      const value = arabicFold(rawValue || '');
      if (!value) continue;
      for (const other of otherBooks) {
        if (other.id === bookId) continue;
        if (other.tokens.some((word) => value.includes(word))) crossReferences += 1;
        const claim = new RegExp(`(?:كتاب|ملف)\\s+(?:ال)?${escapeRegExp(other.tokens[0])}`).test(value);
        if (!claim || (ownName && value.includes(ownName))) continue;
        misattributed.push({ page: doc.physicalPage, field, mentions: other.id, token: other.tokens[0], context: value.slice(0, 90) });
        break;
      }
    }
  }
  report.notes.misattributed = { count: misattributed.length, crossReferences, samples: misattributed.slice(0, 5) };
  if (misattributed.length) {
    const severity = misattributed.length > 5 ? 'high' : 'medium';
    report.add(severity, 'B10', `${misattributed.length} حقل يذكر مادة/كتاباً غير هذا الكتاب`, { samples: misattributed.slice(0, 5) });
    record('B10', bookId, severity, `${misattributed.length} حقل`);
  }

  // B11 ── اقتباس ديني
  if (RELIGIOUS.test(bookId)) {
    const unusable = docs.filter((doc) => {
      const text = String(doc.text || '');
      return text && (PUA.test(text) || REPLACEMENT.test(text));
    }).map((doc) => doc.physicalPage);
    report.notes.religiousUnquotable = unusable.length;
    if (unusable.length) {
      report.add('critical', 'B11', `${unusable.length} صفحة فيها رمز تالف/خاص ⇒ غير صالحة للاستشهاد بآية أو حديث`, { pages: unusable.slice(0, 12) });
      record('B11', bookId, 'critical', `${unusable.length} صفحة غير قابلة للاستشهاد`);
    }
  }

  // C12 ── تكرار حرفي
  const titles = titleRepetition(docs, book?.title || '');
  const boiler = {
    summary: duplicateShareOf(docs.map((doc) => squeeze(doc.summary || ''))),
    purpose: duplicateShareOf(docs.map((doc) => squeeze(doc.purpose || ''))),
    title: titles.boilerplateShare,
  };
  report.notes.boilerplate = { summary: round(boiler.summary * 100), purpose: round(boiler.purpose * 100), title: round(boiler.title * 100) };
  const worstBoiler = Math.max(boiler.summary, boiler.purpose, boiler.title);
  if (worstBoiler > 0.5) {
    const severity = worstBoiler > 0.9 ? 'high' : 'medium';
    report.add(severity, 'C12', `تكرار حرفي: summary ${pct(boiler.summary)} · purpose ${pct(boiler.purpose)} · title ${pct(boiler.title)}`);
    record('C12', bookId, severity, `${pct(worstBoiler)} تكرار حرفي`);
  }

  // C21 ── عنوان الصفحة هو عنوان الكتاب: لا عيب في الوصف بل في هوية الصفحة.
  if (titles.bookTitlePages.length) {
    const severity = titles.bookTitleShare > 0.3 ? 'high' : 'medium';
    report.add(severity, 'C21', `${titles.bookTitlePages.length} من ${docs.length} صفحة تحمل عنوان الكتاب («${(book?.title || '').slice(0, 40)}») فلا تُميَّز في الاسترجاع`, { pages: titles.bookTitlePages.slice(0, 10).map((item) => item.page) });
    record('C21', bookId, severity, `${titles.bookTitlePages.length} صفحة بعنوان الكتاب`);
  }

  // C13 ── تغطية summary
  const coverage = docs.filter((doc) => doc.text && doc.text.length >= TEXT_MIN)
    .map((doc) => squeeze(doc.summary).length / doc.text.length);
  const coverageMedian = median(coverage);
  const thin = coverage.filter((value) => value < 0.02).length;
  report.notes.summaryCoverage = { median: round(coverageMedian * 100), thinPages: thin, pages: coverage.length };
  if (coverage.length && coverageMedian < 0.03) {
    const severity = coverageMedian < 0.015 ? 'high' : 'medium';
    report.add(severity, 'C13', `summary يغطي ${pct(coverageMedian)} من النص (وسيط) · ${thin} صفحة تحت 2%`);
    record('C13', bookId, severity, `${pct(coverageMedian)} تغطية`);
  }

  // C14 ── educationalPurpose
  const purposes = docs.map((doc) => squeeze(doc.purpose || ''));
  const purposeEmpty = purposes.filter((value) => !value).length;
  const purposeShort = purposes.filter((value) => value && value.length < 25).length;
  report.notes.educationalPurpose = { empty: purposeEmpty, short: purposeShort, boilerplate: round(boiler.purpose * 100) };
  if (purposeEmpty / Math.max(1, docs.length) > 0.2 || boiler.purpose > 0.9) {
    const severity = boiler.purpose > 0.9 ? 'high' : 'medium';
    report.add(severity, 'C14', `educationalPurpose: ${purposeEmpty} فارغ · ${purposeShort} قصير · تكرار ${pct(boiler.purpose)}`);
    record('C14', bookId, severity, `${purposeEmpty} فارغ · تكرار ${pct(boiler.purpose)}`);
  }

  // C15 ── unit: فارغ، أو اسم وحدة لا يثبته نص الصفحة ويشترك فيه كتاب آخر
  const unitEmpty = docs.filter((doc) => !squeeze(doc.unit || '')).length;
  const distinctUnits = new Set(docs.map((doc) => squeeze(doc.unit || '')).filter(Boolean));
  const foreign = foreignUnits(docs, allUnits, bookId, (value) => GENERIC_UNIT.test(String(value || '').trim()));
  report.notes.units = { empty: unitEmpty, distinct: distinctUnits.size, foreign: foreign.length, samples: foreign.slice(0, 4) };
  if (unitEmpty / Math.max(1, docs.length) > 0.3 || foreign.length) {
    const severity = foreign.length ? 'high' : 'medium';
    report.add(severity, 'C15', `unit: ${unitEmpty}/${docs.length} فارغ · ${foreign.length} اسم وحدة لا يثبته نص الصفحة ويشترك فيه كتاب آخر${foreign.length ? ` (${foreign.slice(0, 2).map((item) => item.unit).join(' | ')})` : ''}`, { samples: foreign.slice(0, 4) });
    record('C15', bookId, severity, `${unitEmpty} فارغ · ${foreign.length} مختلقة`);
  }

  // C16 ── section
  const sections = new Set(docs.map((doc) => squeeze(doc.section || '')).filter(Boolean));
  report.notes.sections = { distinct: sections.size, value: sections.size <= 1 ? [...sections][0]?.slice(0, 40) || null : null };
  if (sections.size <= 1 && docs.length > 1) {
    const severity = docs.length > 50 ? 'high' : 'medium';
    report.add(severity, 'C16', `section واحدة فقط على ${docs.length} صفحة${sections.size ? ` («${[...sections][0].slice(0, 40)}»)` : ' (فارغة)'}`);
    record('C16', bookId, severity, 'قيمة واحدة');
  }

  // D17 ── printedPage مخمَّن (قاعدة الثوابت في scripts/build-index.mjs:130-141)
  const GUESS_RULES = {
    'student-book-sixth-pdf': (page) => (page <= 35 ? page + 4 : page <= 90 ? page + 5 : page + 6),
    'student-activity-sixth-pdf': (page) => page + 3,
    'history-sixth-literary-pdf': (page) => (page >= 3 ? page : null),
  };
  const guessed = [];
  const nullPrinted = [];
  for (const doc of docs) {
    if (doc.printedPage == null) {
      nullPrinted.push(doc.physicalPage);
      continue;
    }
    const pdfPage = pdfPages.get(doc.physicalPage);
    const pdfPrinted = pdfPage ? (pdfPage.printedPage ?? pdfPage.printedPageNumber) : null;
    const rule = GUESS_RULES[bookId];
    if (pdfPrinted == null && rule && rule(doc.physicalPage) === doc.printedPage) guessed.push(doc.physicalPage);
  }
  report.notes.printedPage = { nulls: nullPrinted.length, guessed: guessed.length, samples: guessed.slice(0, 8) };
  if (guessed.length) {
    report.add('high', 'D17', `${guessed.length} صفحة رقمها المطبوع مخمَّن من قاعدة الثوابت في build-index.mjs:130-141 (وREADME ينصّ على أن الفهرس لا يخمنه)`);
    record('D17', bookId, 'high', `${guessed.length} صفحة مخمَّنة`);
  }

  // D18 ── أعمار طبقات الكتاب + تناقض outline
  const stale = [];
  for (const [layer, stamp] of [['pdf-books', bookStamps.get(bookId)], ['outlines', outlineStamps.get(bookId)], ['enrichment', enrichmentStamps.get(bookId)]]) {
    const hours = olderByHours(stamp);
    if (hours != null && hours > 0) stale.push({ layer, olderByHours: hours });
  }
  const raw = outlineRaw.get(bookId);
  const contradicting = raw ? contradictingOutlinePages(raw, docByPage) : [];
  report.notes.staleLayers = stale;
  report.notes.outlineContradiction = contradicting.length;
  if (stale.length) {
    report.add('medium', 'D18', `طبقات أقدم من search-index: ${stale.map((item) => `${item.layer} (${item.olderByHours}س)`).join('، ')}`);
    record('D18', bookId, 'medium', stale.map((item) => item.layer).join('+'));
  }
  if (contradicting.length) {
    report.add('high', 'D18', `${contradicting.length} صفحة يقول فيها الـoutline «لا نص/لا يمكن الإجابة» وفي search-index نص كامل`, { pages: contradicting.slice(0, 12) });
    record('D18', bookId, 'high', `${contradicting.length} صفحة متناقضة`);
  }

  // D19 ── enrichment والمحتوى المنظّم
  const enrichmentFile = enrichmentStamps.get(bookId);
  const enrichment = (await readJson(path.join(ENRICHMENT_DIR, `${bookId}.json`), null))?.pages || null;
  const structured = {
    figures: docs.reduce((sum, doc) => sum + (doc.figures?.length || 0), 0),
    glossary: docs.reduce((sum, doc) => sum + (doc.glossary?.length || 0), 0),
    activities: docs.reduce((sum, doc) => sum + (doc.activities?.length || 0), 0),
    exercises: docs.reduce((sum, doc) => sum + (doc.exercises?.length || 0), 0),
  };
  report.notes.enrichment = { file: Boolean(enrichmentFile), pages: enrichment ? Object.keys(enrichment).length : 0, structured };
  if (!enrichmentFile) {
    report.add('medium', 'D19', 'لا ملف enrichment لهذا الكتاب');
    record('D19', bookId, 'medium', 'enrichment غائب');
  }
  const zeroed = Object.entries(structured).filter(([, value]) => value === 0).map(([key]) => key);
  if (zeroed.length) {
    report.add('medium', 'D19', `محتوى منظّم صفري: ${zeroed.join('، ')}`);
    record('D19', bookId, 'medium', zeroed.join('+'));
  }

  // D20 ── البصمة
  const source = pdfBook?.source || pdfBook?.book?.source || pdfIndexById.get(bookId)?.source || null;
  if (!source?.checksum) {
    report.add('high', 'D20', 'لا بصمة مصدر (source.checksum) في pdf-books/pdf-index');
    record('D20', bookId, 'high', 'بلا بصمة');
  } else {
    const actual = sourceDigests.get(source.checksum);
    report.notes.checksum = { recorded: source.checksum.slice(0, 12), matched: Boolean(actual) };
    if (!actual) {
      report.add('critical', 'D20', `بصمة المصدر لا تطابق أي ملف في pdf-sources (${String(source.fileName || '').slice(0, 26)})`);
      record('D20', bookId, 'critical', 'بصمة غير مطابقة');
    } else if (Number(source.bytes) !== actual.bytes) {
      report.add('high', 'D20', `حجم المصدر مختلف: مسجّل ${source.bytes} · فعلي ${actual.bytes}`);
      record('D20', bookId, 'high', `حجم ${source.bytes}≠${actual.bytes}`);
    }
  }
}

// ── فحوص المكتبة ─────────────────────────────────────────────────────────────
const library = { notes: {}, findings: [] };
const addLibrary = (severity, code, message, extra = {}) => {
  library.findings.push({ severity, code, message, ...extra });
  record(code, 'library', severity, message);
};

library.notes.layers = Object.fromEntries(Object.entries(stamps).map(([layer, stamp]) => [layer, { ...stamp, olderByHours: olderByHours(stamp) }]));
for (const [layer, stamp] of Object.entries(stamps)) {
  const hours = olderByHours(stamp);
  if (layer === 'search-index.json' || hours == null || hours <= 0) continue;
  addLibrary('medium', 'D18', `${layer} أقدم من search-index بـ${hours} ساعة`, { layer, olderByHours: hours });
}

const fastIndex = await readJson(FAST_INDEX, null);
if (fastIndex) {
  const rows = Array.isArray(fastIndex.pages) ? fastIndex.pages : [];
  const fastBooks = new Set(rows.map((row) => row.b));
  const missingBooks = [...searchBooks.keys()].filter((id) => !fastBooks.has(id));
  const chars = rows.reduce((sum, row) => sum + String(row.n || '').length + String(row.p || '').length + String(row.s || '').length, 0);
  const noiseRows = rows.filter((row) => new RegExp(PRESS_FILE_SRC, 'i').test(`${row.n || ''}${row.p || ''}${row.s || ''}`)).length;
  const noTextRows = rows.filter((row) => /صفحة مصورة/.test(String(row.t || '')) || !String(row.p || '').trim()).length;
  const hours = olderByHours(stamps['fast-index.json']);
  const readers = await codeReaders(/fast[-_ ]?index/i);
  library.notes.fastIndex = {
    version: fastIndex.version, builtAt: fastIndex.builtAt,
    books: Array.isArray(fastIndex.books) ? fastIndex.books.length : 0,
    pages: rows.length, olderByHours: hours, missingBooks: missingBooks.length,
    chars, indexChars: searchIndex.stats?.fullTextChars ?? null,
    noiseRows, noTextRows, readers,
  };
  if (hours > 0) {
    addLibrary('high', 'D18', `fast-index.json أقدم من search-index بـ${hours} ساعة · ${library.notes.fastIndex.books} كتاب · ${rows.length} صفحة (مقابل ${searchIndex.documents.length}) · ${missingBooks.length} كتاب غائب${readers.length ? ` · يقرأه: ${readers.join('، ')}` : ' · لا يقرأه أي كود (انظر D21)'}`, { layer: 'fast-index.json' });
  }
  if (noiseRows) addLibrary('medium', 'A4', `fast-index.json فيه ${noiseRows} صف حاملة لحروف المصنع IRAQ_*.indb`, { layer: 'fast-index.json' });
  if (noTextRows) addLibrary('medium', 'A2', `fast-index.json فيه ${noTextRows} صف بلا نص («صفحة مصورة»)` , { layer: 'fast-index.json' });
} else {
  library.notes.fastIndex = null;
}

// D21 ── الطبقات الميتة: الحكم بالبحث في الكود لا بتاريخ الملف.
// طبقة لا يقرأها أحد تبقى في المستودع تضلّل القياس وتوهم بوجود مصدر ثانٍ للحقيقة.
const deadCandidates = [
  { layer: 'fast-index.json', stamp: stamps['fast-index.json'], pattern: /fast[-_ ]?index/i },
  { layer: 'index/search-index.json', stamp: stamps['index/search-index.json'], pattern: /index\/search-index|legacy[-_ ]?index/i },
  { layer: 'index/materials.json', stamp: stamps['index/materials.json'], pattern: /materials\.json/i },
  { layer: 'catalog.json', stamp: stamps['catalog.json'], pattern: /catalog\.json/i },
];
for (const candidate of deadCandidates) {
  candidate.exists = Boolean(candidate.stamp.exists);
  candidate.readers = candidate.exists ? await codeReaders(candidate.pattern) : [];
  candidate.bytes = candidate.stamp.bytes;
  candidate.olderByHours = olderByHours(candidate.stamp);
}
library.notes.deadLayers = deadLayers(deadCandidates);
for (const layer of library.notes.deadLayers) {
  addLibrary('high', 'D21', `${layer.layer} طبقة ميتة: ${(layer.bytes / 1_048_576).toFixed(1)}MB لا يشير إليها أي كود في server.mjs أو lib/ أو public/ أو scripts/ (أقدم بـ${layer.olderByHours} ساعة)`, { layer: layer.layer, dead: true });
}

// D22 ── تكرار حرفي بين الكتب: يُعرف قبل أن يُحتسب مرتين في جواب واحد.
const duplicates = crossBookDuplicates(docsByBook);
library.notes.duplicates = duplicates;
for (const pair of duplicates) {
  addLibrary('medium', 'D22', `${pair.shared} صفحة متطابقة بين «${pair.left}» و«${pair.right}» (إزاحة ${pair.offset})`, { layer: pair.left, pair: pair.right });
}

const enrichedBooks = [...searchBooks.keys()].filter((id) => enrichmentStamps.has(id));
library.notes.enrichedBooks = enrichedBooks.length;
if (enrichedBooks.length < searchBooks.size) {
  addLibrary('medium', 'D19', `enrichment يغطي ${enrichedBooks.length} كتاباً من ${searchBooks.size} (ناقص ${searchBooks.size - enrichedBooks.length})`);
}

const catalog = await readJson(CATALOG, null);
const materials = await readJson(path.join(LEGACY_INDEX_DIR, 'materials.json'), null);
library.notes.catalog = { books: Array.isArray(catalog?.books) ? catalog.books.length : null, schemaVersion: catalog?.schemaVersion ?? null };
library.notes.materials = { entries: Array.isArray(materials?.materials) ? materials.materials.length : null, schemaVersion: materials?.schemaVersion ?? null };
if (!catalog || !Array.isArray(catalog.books) || catalog.books.length === 0) {
  addLibrary('high', 'B10', `catalog.json فارغ (books: ${catalog?.books?.length ?? 'الملف غير موجود/مكسور'}) ولا سكربت في المستودع يولّده`);
}
const materialIds = new Set((materials?.materials || []).map((entry) => entry.bookId));
const missingInMaterials = [...searchBooks.keys()].filter((id) => !materialIds.has(id));
library.notes.materialsMissing = missingInMaterials;
if (missingInMaterials.length) {
  addLibrary('medium', 'B10', `materials.json لا يذكر ${missingInMaterials.length} كتاباً من ${searchBooks.size} (${missingInMaterials.slice(0, 3).join('، ')}${missingInMaterials.length > 3 ? '…' : ''})`);
}

// ── التجميع ──────────────────────────────────────────────────────────────────
const libraryCounts = { critical: 0, high: 0, medium: 0, low: 0 };
for (const report of bookReports) {
  const counts = report.counts();
  for (const severity of SEVERITIES) libraryCounts[severity] += counts[severity];
}
for (const finding of library.findings) libraryCounts[finding.severity] += 1;
// درجة المكتبة = نظافة الفحوص العشرين: كل فحص نظيف يمنح 5، ووجود فجوة عالية يخصم نصفه.
const libraryScore = round(CHECKS.reduce((sum, entry) => {
  const critical = entry.findings.filter((item) => item.severity === 'critical').length;
  const high = entry.findings.filter((item) => item.severity === 'high').length;
  if (critical) return sum;
  return high ? sum + 2.5 : sum + 5;
}, 0) / (CHECKS.length * 5) * 100);
const cleanChecks = CHECKS.filter((entry) => !entry.findings.length).length;
const bookMean = round(bookReports.reduce((sum, report) => sum + report.score(), 0) / Math.max(1, bookReports.length));
const ranked = bookReports.slice().sort((a, b) => {
  const ca = a.counts(); const cb = b.counts();
  for (const severity of SEVERITIES) if (ca[severity] !== cb[severity]) return cb[severity] - ca[severity];
  return a.score() - b.score();
});
const criticals = [
  ...bookReports.flatMap((report) => report.findings.filter((item) => item.severity === 'critical').map((item) => ({ bookId: report.id, ...item }))),
  ...library.findings.filter((item) => item.severity === 'critical').map((item) => ({ bookId: 'library', ...item })),
].sort((a, b) => a.bookId.localeCompare(b.bookId) || a.code.localeCompare(b.code));

// ── العرض ────────────────────────────────────────────────────────────────────
const line = '═'.repeat(120);
console.log(line);
console.log('مدقّق الفهرس — مشروع معلمي');
console.log(`search-index builtAt=${searchIndex.builtAt} · كتب=${searchIndex.books?.length} · صفحات=${searchIndex.documents?.length} · chars=${searchIndex.stats?.fullTextChars ?? '—'} · وقت القياس=${new Date().toISOString()}`);
console.log(line);

console.log('\n▌ جدول الكتب: نسبة الاكتمال + الفجوات لكل خطورة\n');
const head = ['الكتاب'.padEnd(44), 'صفحات'.padStart(6), 'اكتمال'.padStart(7), 'حرج'.padStart(5), 'عالي'.padStart(5), 'متوسط'.padStart(7), 'منخفض'.padStart(7), 'رموز الفحوص'];
console.log(head.join(' '));
console.log('─'.repeat(120));
for (const report of ranked) {
  const counts = report.counts();
  const codes = [...new Set(report.findings.map((item) => item.code))].sort().join(',');
  console.log([
    report.id.padEnd(44),
    String(report.pages).padStart(6),
    String(report.score()).padStart(7),
    String(counts.critical).padStart(5),
    String(counts.high).padStart(5),
    String(counts.medium).padStart(7),
    String(counts.low).padStart(7),
    codes,
  ].join(' '));
}

console.log('\n▌ الجدول الموحّد للمكتبة\n');
console.log(`  كتب=${bookReports.length} · صفحات=${searchIndex.documents.length} · اكتمال المكتبة (متوسط الكتب)=${bookMean}/100 · درجة المكتبة=${libraryScore}/100 · فحوص نظيفة ${cleanChecks}/${CHECKS.length}`);
console.log(`  الفجوات: حرج ${libraryCounts.critical} · عالي ${libraryCounts.high} · متوسط ${libraryCounts.medium} · منخفض ${libraryCounts.low}`);
const totalText = searchIndex.stats?.fullTextChars || 0;
console.log(`  fast-index: ${library.notes.fastIndex ? `${library.notes.fastIndex.books} كتاب · ${library.notes.fastIndex.pages} صفحة · ${library.notes.fastIndex.chars} حرف (${pct(library.notes.fastIndex.chars / Math.max(1, totalText))} من نص المكتبة) · أقدم بـ${library.notes.fastIndex.olderByHours}س · ${library.notes.fastIndex.missingBooks} كتاب غائب · ${library.notes.fastIndex.noTextRows} صف بلا نص · ${library.notes.fastIndex.noiseRows} صف بحروف مصنع` : 'غير موجود'}`);
console.log(`  catalog.json books=${library.notes.catalog.books} · materials.json entries=${library.notes.materials.entries} (ناقص ${library.notes.materialsMissing.length} كتاباً)`);
console.log(`  الطبقات الأقدم من search-index: ${Object.entries(library.notes.layers).filter(([layer]) => layer !== 'search-index.json' && library.notes.layers[layer].olderByHours > 0).map(([layer, stamp]) => `${layer} (${stamp.olderByHours}س)`).join('، ') || 'لا شيء'}`);

console.log('\n▌ نتائج الفحوص (رقم على البيانات الحالية)\n');
for (const entry of CHECKS) {
  const books = new Set(entry.findings.map((item) => item.bookId));
  const bySeverity = (severity) => entry.findings.filter((item) => item.severity === severity).length;
  console.log(`  ${entry.id.padEnd(4)} ${entry.title}`);
  console.log(`       كتب متأثرة=${books.size} · حرج ${bySeverity('critical')} · عالي ${bySeverity('high')} · متوسط ${bySeverity('medium')} · منخفض ${bySeverity('low')}`);
  for (const item of entry.findings.slice(0, 22)) console.log(`        · ${item.bookId}: ${item.detail}`);
  if (entry.findings.length > 22) console.log(`        · …(+${entry.findings.length - 22})`);
}

// طابور المراجعة البصرية: كل رقم لم يثبته نص الصفحة ولا وُجد له دليل بصري مسجّل.
// لا يُحذف من هذا الطابور رقمٌ إلا بعد النظر في صورة الصفحة وتسجيل الحكم.
const queue = [...unverifiedNumbers].sort((a, b) => a.bookId.localeCompare(b.bookId) || a.page - b.page);
console.log(`\n▌ طابور المراجعة البصرية (${queue.length} رقماً)\n`);
if (!queue.length) console.log('  لا أرقام بلا سند نصي ولا دليل بصري.');
for (const item of queue.slice(0, 60)) console.log(`  ${item.bookId} ص${item.page} ${item.field}: ${item.number} (نص الصفحة ${item.integrity})`);
if (queue.length > 60) console.log(`  …(+${queue.length - 60})`);

console.log('\n▌ الفجوات الحرجة (المرتّبة)\n');
if (!criticals.length) console.log('  لا فجوة حرجة.');
criticals.slice(0, 40).forEach((item, index) => console.log(`  ${String(index + 1).padStart(2)}. [${item.code}] ${item.bookId} — ${item.message}`));
if (criticals.length > 40) console.log(`  …(+${criticals.length - 40})`);

const payload = {
  generatedAt: new Date().toISOString(),
  searchIndexBuiltAt: searchIndex.builtAt,
  libraryScore,
  bookMean,
  counts: libraryCounts,
  layers: library.notes.layers,
  fastIndex: library.notes.fastIndex,
  enrichedBooks: library.notes.enrichedBooks,
  catalog: library.notes.catalog,
  materials: library.notes.materials,
  checks: CHECKS.map((entry) => ({ id: entry.id, title: entry.title, books: new Set(entry.findings.map((item) => item.bookId)).size, findings: entry.findings })),
  books: bookReports.map((report) => ({ id: report.id, title: report.title, pages: report.pages, score: report.score(), counts: report.counts(), notes: report.notes, findings: report.findings })),
  criticals,
  visualReviewQueue: queue,
  deadLayers: library.notes.deadLayers,
  duplicates: library.notes.duplicates,
};
if (asJson) {
  await writeFile(asJson, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n  (JSON: ${asJson})`);
}

// البوابة: الفحص الحرج يوقف البناء، والرقم غير المُثبت يوقّفه أيضاً لأنه وصفٌ
// ينتظر عيناً، والنشر قبل مراجعته نشرٌ لادّعاء بلا برهان.
const gateBlocked = Boolean(criticals.length) || Boolean(queue.length);
process.exitCode = gateBlocked && !noExit ? 1 : 0;
if (gate && !noExit && gateBlocked) {
  console.log(`\n  البوابة مغلقة: حرج ${criticals.length} · بانتظار مراجعة بصرية ${queue.length}. لا يُنشر الفهرس قبل تصفيرهما.`);
}

function contradictingOutlinePages(rawText, docByPage) {
  const pages = [];
  const scanner = new RegExp(OUTLINE_ENTRY.source, 'gm');
  let match;
  while ((match = scanner.exec(rawText))) {
    const start = scanner.lastIndex;
    const next = rawText.indexOf('\n### الصفحة الفيزيائية ', start);
    const block = rawText.slice(start, next < 0 ? rawText.length : next);
    if (!NO_TEXT_CLAIM.test(block)) continue;
    const doc = docByPage.get(Number(match[1]));
    if (doc && squeeze(doc.text).length >= TEXT_MIN) pages.push(Number(match[1]));
  }
  return pages;
}
