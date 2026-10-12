// محرك المعرفة: فهرس مقلوب في الذاكرة.
// Full history of the design lives in MEMORY.md; this file is the runtime entry.
//
// Two index layers after the rebuild:
//   * `getScanIndex()` — a lean scan layer: catalog + printed-page maps + flat
//     postings + per-page scan metadata. It never touches page text or structured
//     content, so its resident footprint is a fraction of the old full load.
//     `search`, `resolveBook`, `getCatalog` and `getHealth` all run on it.
//   * `getIndex()` — the full materialised view (`documents`, `postings`,
//     `documentFrequency`) used for diagnostics and tests.
//
// Scanning is now set-based: candidates come from postings, and term matches are
// counted once per term instead of running `doc.terms.includes(...)` for every
// candidate (which previously executed up to ~90 linear string comparisons per
// candidate on the single request thread).
//
// Search returns every matching indexed page of the requested batch, with its
// full stored text and evidence status. It does not rank, threshold, or drop
// candidates: choosing among them is the model's job.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { brokenYears, cleanText, normalizeAr, searchTokens } from './text.mjs';
import { classifyPageEvidence, getPdfPageEvidence } from './pdf-fallback.mjs';
import * as textToolkit from './text.mjs';

export { searchPdfPages } from './pdf-fallback.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(PROJECT_ROOT, 'curriculum-library');
const SEARCH_INDEX = path.join(LIBRARY, 'search-index.json');
const SHARDS_DIR = path.join(LIBRARY, 'shards');

const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
// حدّ ملفات السجلات المحمّلة. الجلسة الواحدة تعمل عادةً على كتاب واحد (شارد
// واحد)، فالحدّ الصغير يكفي ويحفظ الذاكرة: ستة شاردات ≈ 18MB قرصاً.
const SHARD_CACHE_LIMIT = 6;

function usableText(value) {
  const text = cleanText(value || '');
  return text.length >= 20 && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

function usableMetadata(value) {
  const text = cleanText(value || '');
  return text && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

// ─── سلامة النص الطباعي ─────────────────────────────────────────────
const DAMAGE_FFFD = /\uFFFD/g;
const DAMAGE_PUA = /[\uE000-\uF8FF]/g;
// «هللا» قلب حروف «الله»: لا وجود له في العربية الصحيحة، وهو أثر فك ترميز bidi
// داخل طبقة نص الـPDF. «اال» سقط من هذه القاعدة: هو قابل للإصلاح عند حد الكلمة
// (lib/text.mjs: OCR_FIX) فلم يبقَ دليل تلف بعد إصلاحه.
const DAMAGE_REVERSED = /هللا/g;
// حرف عربي ملاصق بحرف لاتيني **داخل الكلمة نفسها** لا بين كلمتين: أثر ترميز
// خاطئ لا لغة كتاب مدرسي.
const DAMAGE_SCRIPT_MIX = /[\u0600-\u06FF][A-Za-z][\u0600-\u06FF]|[A-Za-z][\u0600-\u06FF][A-Za-z]/g;

function damaged(text) {
  const probe = typeof textToolkit.hasTextDamage === 'function'
    ? textToolkit.hasTextDamage
    : (value) => /\uFFFD/.test(String(value || ''));
  return Boolean(probe(text));
}

// يقيس تلف النص ويذكر سببه صراحةً؛ لا حكم بلا دليل مذكور.
export function assessText(value) {
  const text = cleanText(value || '');
  if (!text) return { text: '', damaged: false, rate: 0, reasons: [], empty: true };
  const size = text.length;
  const replaced = (text.match(DAMAGE_FFFD) || []).length;
  const privateUse = (text.match(DAMAGE_PUA) || []).length;
  const reversed = (text.match(DAMAGE_REVERSED) || []).length;
  const mixed = (text.match(DAMAGE_SCRIPT_MIX) || []).length;
  const years = brokenYears(text);
  const libraryFlag = damaged(text);
  const reasons = [];
  if (replaced) reasons.push(`محارف بديلة مفقودة (U+FFFD) عددها ${replaced} داخل النص المستخرج`);
  if (privateUse) reasons.push(`رموز خاصة لم تُفسَّر (PUA) عددها ${privateUse} — كُمحيت رموز عثمانية أو أقواس المعادلات`);
  if (reversed) reasons.push(`قلب حروف داخل الكلمات في ${reversed} موضعاً (مثل «هللا» بدل «الله»)`);
  if (mixed) reasons.push(`حروف عربية ملاصقة بحروف لاتينية في ${mixed} موضعاً داخل النص`);
  if (years.length) reasons.push(`تواريخ/أرقام خارج المدى الواقعي: ${years.slice(0, 4).join('، ')}`);
  if (libraryFlag && !reasons.length) reasons.push('نسبة رموز غريبة مرتفعة تجعل النص غير موثوق بالنقل الحرفي');
  const rate = (replaced + privateUse) / size + (reversed * 3) / size + (mixed * 2) / size
    + (years.length ? 0.4 : 0) + (libraryFlag ? 0.5 : 0);
  return { text, damaged: reasons.length > 0, rate, reasons, empty: false };
}

// وصف «لا نص/لا يمكن الإجابة» لا يكون دليلاً إذا أثبت نص الصفحة الحالية عكسه.
const STALE_OUTLINE = /(?:لا\s*(?:يمكن\s+(?:الإجابة|الاجابة|الجواب)|يتوفر\s+(?:لها\s+)?نص|يوجد\s+نص|نص\s+مستخرج)|لا\s+نص\s+مستخرج|لا\s+يوجد\s+نص|تحتاج\s+قراءة\s+بصرية|صفحة\s+مصورة|searchable:\s*false|needsOcr:\s*true)/i;

export function usableOutlineSummary(value, { hasCurrentText = false } = {}) {
  const text = cleanText(value || '');
  if (!text || !STALE_OUTLINE.test(text)) return text;
  if (!hasCurrentText) return '';
  const parts = text.split(/\n+|(?<=[.!؟?؛;])\s+/).map((part) => part.trim()).filter(Boolean);
  return cleanText(parts.filter((part) => !STALE_OUTLINE.test(part)).join(' '));
}

function reconcilePageMetadata(value, hasCurrentText) {
  const text = usableMetadata(value);
  return hasCurrentText ? usableOutlineSummary(text, { hasCurrentText: true }) : text;
}

// يختار أنظف نسخة متاحة للاقتباس بمقياس جودة فعلي.
function chooseQuotation(textVerdict, outlineVerdict) {
  const text = textVerdict.empty ? '' : textVerdict.text;
  const outline = outlineVerdict.empty ? '' : outlineVerdict.text;
  if (text && !textVerdict.damaged) {
    return { source: 'pdf-text', text, reasons: [], reliable: true };
  }
  if (text && textVerdict.damaged) {
    if (outline && !outlineVerdict.damaged) {
      return { source: 'outline-description', text: outline, reliable: false, reasons: textVerdict.reasons };
    }
    const reasons = [...textVerdict.reasons, ...(outline ? outlineVerdict.reasons : ['لا نسخة فهرسة سليمة'])];
    return { source: 'unreliable', text: text || outline, reliable: false, reasons };
  }
  if (outline) return { source: outlineVerdict.damaged ? 'unreliable' : 'outline-description', text: outline, reliable: !outlineVerdict.damaged, reasons: outlineVerdict.reasons };
  return { source: 'none', text: '', reliable: false, reasons: ['لا نص ولا وصف فهرسي متاح'] };
}

function resolvedEvidenceStatus(doc, textVerdict, sourceEvidence) {
  if (textVerdict.empty) return 'no-text';
  if (textVerdict.damaged || doc.evidenceStatus === 'damaged-text'
    || sourceEvidence?.evidenceStatus === 'damaged-text') return 'damaged-text';
  if (sourceEvidence?.evidenceStatus === 'ocr-text') return 'ocr-text';
  if (sourceEvidence?.evidenceStatus === 'clean-extracted-text') return 'clean-extracted-text';
  if (doc.evidenceStatus === 'ocr-text') return 'ocr-text';
  return classifyPageEvidence(textVerdict.text, { fullText: doc.text, ocr: doc.ocr });
}

// ═══════════════════════════════════════════════════════════════════
//  الطبقة الخفيفة: كتالوج + postings مسطّحة + وصف المسح
// ═══════════════════════════════════════════════════════════════════

let scanPromise;
let fullPromise;
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse);

// ─── postings مسطّحة وبحث ثنائي ────────────────────────────────────
// الملف المشرَّح يخزّن terms مرتّبةً + offsets + ids مسطّحة + df متوازية. البحث
// ثنائي (17 مقارنة لـ74 ألف مصطلح) أوفر من خريطة بـ74 ألف مفتاح (~4MB دائمة).
function makeLookup(lookup) {
  const terms = Array.isArray(lookup?.terms) ? lookup.terms : [];
  const offsets = lookup?.offsets || [];
  const ids = lookup?.ids ? Int32Array.from(lookup.ids) : new Int32Array(0);
  const df = lookup?.df || [];

  const indexOf = (term) => {
    let lo = 0;
    let hi = terms.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = terms[mid];
      if (value === term) return mid;
      if (value < term) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };

  return {
    terms,
    size: terms.length,
    postingsOf(term) {
      const i = indexOf(term);
      if (i < 0) return EMPTY_POSTINGS;
      return ids.subarray(offsets[i], offsets[i + 1] ?? ids.length);
    },
    dfOf(term) {
      const i = indexOf(term);
      return i < 0 ? 0 : Number(df[i] || 0);
    },
    allTerms() { return terms; },
  };
}

const EMPTY_POSTINGS = new Int32Array(0);

// ─── وصف المسح: ما يحتاجه الترتيب فقط ──────────────────────────────
// `exercisePage` و`staleOutline` يُحسبان وقت البناء (lib/page-kind.mjs) لأن
// قراءتهما تحتاج نص الصفحة؛ وقت التشغيل يقرأهما بلا أي فحص نصّي.
const LEGACY_SCAN_FIELDS = [
  'bookId', 'physicalPage', 'printedPage', 'title', 'section', 'unit', 'pageType',
  'searchable', 'needsOcr', 'evidenceStatus', 'textLength', 'pageOffset',
  'textDamaged', 'enriched', 'normalized', 'exercisePage', 'staleOutline',
];

function scanMetaOf(doc, index) {
  return {
    bookId: doc.bookId,
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage ?? null,
    title: doc.title || '',
    section: doc.section || '',
    unit: doc.unit || '',
    pageType: doc.pageType || '',
    searchable: Boolean(doc.searchable),
    needsOcr: Boolean(doc.needsOcr),
    evidenceStatus: doc.evidenceStatus || null,
    textLength: doc.textLength || 0,
    pageOffset: doc.pageOffset ?? null,
    textDamaged: Boolean(doc.textDamaged),
    enriched: Boolean(doc.enriched),
    normalized: doc.normalized || '',
    exercisePage: isExercisePageOf(doc),
    staleOutline: isStaleOutlineOf(doc),
    shard: index,
    offset: 0,
  };
}

// نسخة محلية من قواعد page-kind تعمل على وثيقة كاملة (مسار legacy فقط).
function isExercisePageOf(doc) {
  if (['exercises', 'questions', 'matching'].includes(String(doc?.pageType || ''))) return true;
  if ((doc?.exercises?.length || 0) > 0) return true;
  const strip = (value) => String(value ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .toLowerCase();
  const title = strip(doc?.title || '').replace(/^[0-9٠-٩\s.،:؛()«»\-–—]+/, '');
  if (/^(?:اختر|عرف|اكمل|استخرج|علم|حدد|سجل|ناقش|بين|صنف|اكتب|مايأتي|سؤال|سئله|اسئله|تمارين|التمارين|تدريب|نشاط|اختبر|ميز|فك)/.test(title)) return true;
  const text = strip(String(doc?.text || '').slice(0, 60));
  return /^(?:اختر|عرف|اكمل|استخرج|علم|حدد|سجل|ناقش|بين|صنف|اكتب|مايأتي|سؤال|سئله|اسئله|تمارين|التمارين|تدريب|نشاط|اختبر|ميز|فك)/
    .test(/^[0-9٠-٩\s.،:؛()«»\-–—]+/.test(text) ? '' : text);
}

function isStaleOutlineOf(doc) {
  return Boolean(String(doc?.text || '').trim()) && STALE_OUTLINE.test(String(doc?.outlineSummary || ''));
}

// ─── تحميل السجلات الكاملة عند الحاجة فقط ─────────────────────────
const shardCache = new Map();

function shardRecords(shard) {
  if (shardCache.has(shard)) return shardCache.get(shard);
  const promise = readJson(path.join(SHARDS_DIR, 'docs', `shard-${String(shard).padStart(4, '0')}.json`))
    .catch((error) => {
      shardCache.delete(shard);
      throw error;
    });
  shardCache.set(shard, promise);
  while (shardCache.size > SHARD_CACHE_LIMIT) {
    const oldest = shardCache.keys().next().value;
    shardCache.delete(oldest);
  }
  return promise;
}

// ─── بناء الفهرس الخفيف من الطبقة المشرَّحة ────────────────────────
function buildScanFromShards(catalog, printedRaw, lookup, meta) {
  const books = catalog.books;
  const booksById = new Map(books.map((book) => [book.id, book]));
  const printed = new Map();
  for (const [bookId, map] of Object.entries(printedRaw || {})) {
    printed.set(bookId, new Map(Object.entries(map).map(([number, physical]) => [Number(number), Number(physical)])));
  }
  const docIndexByBookPage = new Map(meta.map((entry, index) => [`${entry.bookId}:${entry.physicalPage}`, index]));
  const postings = makeLookup(lookup);

  return {
    schemaVersion: catalog.schemaVersion,
    builtAt: catalog.builtAt,
    sourceOfTruth: catalog.sourceOfTruth,
    stats: catalog.stats,
    books,
    booksById,
    printed,
    docCount: meta.length,
    meta,
    postings,
    docIndexByBookPage,
    sharded: true,
    async docAt(index) {
      const entry = meta[index];
      if (!entry) return null;
      const records = await shardRecords(entry.shard);
      return records?.[entry.offset] ?? null;
    },
    async materializeAll() {
      const shards = new Set(meta.map((entry) => entry.shard));
      const records = [];
      for (const shard of [...shards].sort((a, b) => a - b)) {
        const slice = await shardRecords(shard);
        for (const record of slice || []) records.push(record);
      }
      // meta والسجلات مرتبتان بالترتيب ذاته (شارد تصاعدي + offset تصاعدي)،
      // فيُدمج `normalized` من طبقة المسح هنا بدل تكراره في كل ملف سجل.
      if (records.length === meta.length) {
        for (let i = 0; i < records.length; i += 1) {
          if (!records[i].normalized) records[i].normalized = meta[i].normalized;
          if (!records[i].id) records[i].id = `${records[i].bookId}:${records[i].physicalPage}`;
        }
      }
      return records;
    },
  };
}

// ─── بناء الفهرس الخفيف من الملف الكامل (مسار احتياطي) ─────────────
// يعمل قبل تشغيل مقطع التقطيع، ويضمن سلوكاً مطابقاً تماماً: postings وdf
// وtermFrequency كلها مشتقّة من المصدر ذاته.
function buildScanFromLegacy(raw) {
  if (!raw || raw.schemaVersion !== 4 || !Array.isArray(raw.documents) || !Array.isArray(raw.books)) {
    throw new Error('CURRICULUM_INDEX_INVALID');
  }
  const documents = raw.documents;
  const meta = documents.map((doc, index) => scanMetaOf(doc, -1));

  const terms = [];
  const offsets = [0];
  const ids = [];
  const df = [];
  const termIndex = new Map();
  const total = documents.length;

  // جدول df الأصلي مبني من الصيغ الموسّعة؛ نحتفظ به كما هو لأنه مصدر idf.
  const sourceDf = raw.documentFrequency || {};
  for (let index = 0; index < total; index += 1) {
    const tokens = documents[index].terms || [];
    for (const term of tokens) {
      let position = termIndex.get(term);
      if (position == null) {
        position = terms.length;
        termIndex.set(term, position);
        terms.push(term);
        df.push(Number(sourceDf[term] || 1));
      }
      ids.push(index);
      offsets[position + 1] = (offsets[position + 1] || 0) + 1;
    }
  }
  // offsets المتزايدة فوق تُصحَّح إلى إزاحات تراكمية
  let running = 0;
  const offsetsFixed = new Array(terms.length + 1);
  offsetsFixed[0] = 0;
  for (let i = 0; i < terms.length; i += 1) {
    running += offsets[i + 1] || 0;
    offsetsFixed[i + 1] = running;
  }

  const booksById = new Map((raw.books || []).map((book) => [book.id, book]));
  const printed = new Map();
  for (const [bookId, map] of Object.entries(raw.printed || {})) {
    printed.set(bookId, new Map(Object.entries(map).map(([number, physical]) => [Number(number), Number(physical)])));
  }
  const docIndexByBookPage = new Map(documents.map((doc, index) => [`${doc.bookId}:${doc.physicalPage}`, index]));

  return {
    schemaVersion: raw.schemaVersion,
    builtAt: raw.builtAt,
    sourceOfTruth: raw.sourceOfTruth,
    stats: raw.stats,
    books: raw.books,
    booksById,
    printed,
    docCount: total,
    meta,
    postings: { ...makeLookup({ terms, offsets: offsetsFixed, ids, df }), size: terms.length },
    docIndexByBookPage,
    sharded: false,
    async docAt(index) { return documents[index] ?? null; },
    async materializeAll() { return documents; },
  };
}

async function loadScan() {
  try {
    const [catalog, printedRaw, lookup, meta] = await Promise.all([
      readJson(path.join(SHARDS_DIR, 'catalog.json')),
      readJson(path.join(SHARDS_DIR, 'printed.json')),
      readJson(path.join(SHARDS_DIR, 'lookup.json')),
      readJson(path.join(SHARDS_DIR, 'meta.json')),
    ]);
    if (!Array.isArray(meta) || !Array.isArray(lookup?.terms) || !Array.isArray(catalog?.books)) {
      throw new Error('SHARDS_INCOMPLETE');
    }
    return buildScanFromShards(catalog, printedRaw, lookup, meta);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.message !== 'SHARDS_INCOMPLETE') {
      console.warn('sharded index unusable, falling back to search-index.json:', error?.message || error);
    }
    const raw = await readJson(SEARCH_INDEX);
    return buildScanFromLegacy(raw);
  }
}

/** الفهرس الخفيف: لا يحتوي نص الصفحات، ويعمل عليه البحث والإحصاء. */
export function getScanIndex() {
  if (!scanPromise) {
    scanPromise = loadScan().catch((error) => {
      scanPromise = undefined;
      throw error;
    });
  }
  return scanPromise;
}

// ─── الفهرس الكامل (تشخيص واختبارات) ──────────────────────────────
export async function getIndex() {
  if (!fullPromise) {
    fullPromise = (async () => {
      const scan = await getScanIndex();
      const documents = await scan.materializeAll();
      // postings بقي خريطة صريحة هنا لأن الاختبارات والسكربتات تقرأها.
      const postings = new Map();
      for (const term of scan.postings.allTerms()) {
        postings.set(term, [...scan.postings.postingsOf(term)]);
      }
      const documentFrequency = new Map();
      for (const term of scan.postings.allTerms()) {
        documentFrequency.set(term, scan.postings.dfOf(term));
      }
      return { ...scan, documents, postings, documentFrequency };
    })().catch((error) => {
      fullPromise = undefined;
      throw error;
    });
  }
  return fullPromise;
}

// ═══════════════════════════════════════════════════════════════════
//  الكتالوج وحلّ الكتاب
// ═══════════════════════════════════════════════════════════════════

export async function listBooks({ subject = '', track = '' } = {}) {
  const index = await getScanIndex();
  const wantedSubject = normalizeAr(subject);
  return index.books.filter((book) => {
    const subjectOk = !wantedSubject || normalizeAr(book.subject).includes(wantedSubject) || normalizeAr(book.title).includes(wantedSubject);
    return subjectOk && allowedBook(book, { track });
  });
}

export async function getBookPages(bookId) {
  const index = await getScanIndex();
  if (!index.booksById.has(bookId)) return [];
  return index.meta
    .filter((entry) => entry.bookId === bookId)
    .map((entry) => ({
      bookId: entry.bookId,
      physicalPage: entry.physicalPage,
      printedPage: entry.printedPage ?? null,
      title: entry.title || '',
      pageType: entry.pageType || '',
      evidenceStatus: entry.evidenceStatus || 'unverified',
      searchable: Boolean(entry.searchable),
    }));
}

export async function getSubjects() {
  const index = await getScanIndex();
  return [...new Set(index.books.map((book) => book.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
}

export async function getCatalog({ track = '' } = {}) {
  const books = await listBooks({ track });
  const subjects = [...new Set(books.map((book) => book.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  return {
    books,
    subjects,
    pages: books.reduce((total, book) => total + Number(book.pageCount || 0), 0),
    searchablePages: books.reduce((total, book) => total + Number(book.searchablePageCount || 0), 0),
  };
}

// ─── كشف تقادم الفهرس عند الإقلاع ────────────────────────────────────
// `builtAt` وحده لا يكفي: قد يُبنى الفهرس ثم يُستبدل مصدر PDF. البصمة
// (حجم + تاريخ تعديل كل ملف) تُقارن عند الإقلاع، فإن اختلف مصدر بقي الفهرس
// كما هو — فيُرفض الانطلاق بجذر صريح بدل خدمة إجابات من نصّ قديم بصمت.
export async function assertIndexFresh() {
  let manifest;
  try {
    manifest = await readJson(path.join(SHARDS_DIR, 'manifest.json'));
  } catch {
    // لا بصمة (فهرس مبني بأداة أقدم): لا نمنع الانطلاق، ونكتفي بالتحذير.
    console.warn('[index] no shard manifest found; staleness cannot be verified');
    return { ok: true, checked: false, stale: [] };
  }
  const stale = [];
  for (const [bookId, size, mtime, fileName] of manifest.sources || []) {
    if (!fileName) continue;
    const file = path.join(LIBRARY, 'pdf-sources', fileName);
    const info = await stat(file).catch(() => null);
    if (!info || Number(info.size) !== Number(size) || Number(info.mtimeMs).toFixed(0) !== String(mtime)) {
      stale.push(bookId);
    }
  }
  if (stale.length) {
    console.error(`[index] STALE INDEX: ${stale.length} source PDF(s) changed after ${manifest.builtAt} — run \`npm run rebuild-pdf-index && npm run build-index\``);
    console.error(`[index] stale books: ${stale.join(', ')}`);
    return { ok: false, checked: true, stale };
  }
  console.log(`[index] fresh (${manifest.sources?.length || 0} source PDFs verified against ${manifest.builtAt})`);
  return { ok: true, checked: true, stale: [] };
}

export async function getHealth() {
  const index = await getScanIndex();
  const { stats, meta } = index;
  const searchablePages = meta.reduce((total, entry) => total + (entry.searchable ? 1 : 0), 0);
  const visionPages = meta.reduce((total, entry) => total + (entry.needsOcr ? 1 : 0), 0);
  const evidenceStatuses = Object.fromEntries(['clean-extracted-text', 'ocr-text', 'damaged-text', 'no-text']
    .map((status) => [status, meta.reduce((total, entry) => total + (entry.evidenceStatus === status ? 1 : 0), 0)]));
  const fullTextPages = stats?.fullTextPages ?? meta.reduce((total, entry) => total + (entry.textLength > 0 ? 1 : 0), 0);
  return {
    schemaVersion: index.schemaVersion,
    builtAt: index.builtAt,
    books: stats?.books || index.books.length,
    pages: index.docCount,
    indexedPages: stats?.indexedPages || index.docCount,
    searchablePages,
    visionPages,
    outlinePages: stats?.outlinePages || 0,
    printedPageGaps: meta.reduce((total, entry) => total + (entry.printedPage == null ? 1 : 0), 0),
    terms: stats?.terms || index.postings.size,
    // النص والفهرسة مكتفيان بذاتهما؛ مصدر PDF لا يُفتح إلا عبر fallback لصفحة مطلوبة.
    fullTextPages,
    fullTextChars: stats?.fullTextChars ?? meta.reduce((total, entry) => total + entry.textLength, 0),
    evidenceStatuses,
    unclassifiedEvidencePages: Math.max(0, index.docCount - Object.values(evidenceStatuses).reduce((a, b) => a + b, 0)),
    enrichedPages: stats?.enrichedPages ?? meta.reduce((total, entry) => total + (entry.enriched ? 1 : 0), 0),
    enrichedBooks: stats?.enrichedBooks || 0,
    figures: stats?.figures || 0,
    glossaryEntries: stats?.glossaryEntries || 0,
    sharded: index.sharded,
  };
}

function allowedBook(book, { subject = '', track = '' } = {}) {
  const wantedSubject = normalizeAr(subject);
  const wantedTrack = normalizeAr(track);
  if (wantedSubject && !normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject)) return false;
  if (wantedTrack === normalizeAr('ديني') && book.supplementary) return false;
  if (wantedTrack && normalizeAr(book.track || book.branch || 'عام') !== wantedTrack) return false;
  return true;
}

function expandedTerms(query) {
  return searchTokens(query);
}

// Resolve only an unambiguous exact catalog label; the model chooses among books.
export async function resolveBook(query = '', { subject = '', track = '' } = {}) {
  const index = await getScanIndex();
  const wanted = normalizeAr(query);
  if (!wanted) return null;
  const matches = index.books.filter((book) => {
    if (!allowedBook(book, { track })) return false;
    const title = normalizeAr(book.title);
    const bookSubject = normalizeAr(book.subject);
    const exactMatch = wanted === title || wanted === bookSubject;
    const requestedSubject = !subject || normalizeAr(subject) === bookSubject;
    return exactMatch && requestedSubject;
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function locate(bookId, printedNumber) {
  const index = await getScanIndex();
  const number = Number(printedNumber);
  if (!Number.isInteger(number)) return null;
  return index.printed.get(bookId)?.get(number) ?? null;
}

// ═══════════════════════════════════════════════════════════════════
//  البحث: BM25 مبسّط فوق postings
// ═══════════════════════════════════════════════════════════════════

const PAGE_QUERY_NOISE = new Set(['صفحه', 'page', 'ص', 'سوال', 'السوال', 'الثالث', 'الثاني', 'الاول']);

export async function searchCandidates(query, { bookId = '', subject = '', track = '', offset = 0, limit = 8 } = {}) {
  const index = await getScanIndex();
  const terms = expandedTerms(String(query ?? ''));
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.floor(Number(limit) || 8));
  const candidateIds = new Set();

  for (const term of terms) {
    for (const id of index.postings.postingsOf(term)) candidateIds.add(id);
  }

  const candidates = [];
  for (const id of candidateIds) {
    const meta = index.meta[id];
    const book = meta ? index.booksById.get(meta.bookId) : null;
    if (!meta || !book) continue;
    if (bookId && meta.bookId !== bookId) continue;
    if (subject && !allowedBook(book, { subject })) continue;
    if (track && !allowedBook(book, { track })) continue;
    candidates.push({ id, bookId: meta.bookId, physicalPage: meta.physicalPage });
  }
  candidates.sort((a, b) => a.bookId.localeCompare(b.bookId) || a.physicalPage - b.physicalPage);

  const selected = candidates.slice(start, start + pageSize);
  const results = await Promise.all(selected.map(async ({ id, bookId: candidateBookId }) => {
    const meta = index.meta[id];
    const record = await index.docAt(id);
    const book = index.booksById.get(candidateBookId);
    return {
      ...resultFor(index, record || meta, meta, id),
      pageText: String(record?.text || ''),
      structured: Object.fromEntries(STRUCTURED_KEYS.filter((key) => record?.[key] != null).map((key) => [key, record[key]])),
      pageCount: book?.pageCount ?? null,
      resultOrder: id,
    };
  }));

  return {
    query: String(query ?? ''),
    total: candidates.length,
    offset: start,
    limit: pageSize,
    nextOffset: start + results.length < candidates.length ? start + results.length : null,
    results,
  };
}

export async function search(query, options = {}) {
  return (await searchCandidates(query, options)).results;
}

/* Retired deterministic relevance ranking. Model-directed discovery is `searchCandidates()`.
async function searchTrack(query, { bookId = '', subject = '', track = '', limit, onTrace, budgets: budgetOverride } = {}) {
  const index = await getScanIndex();
  const budgets = budgetOverride || activeBudgets;
  if (bookId && !index.booksById.has(bookId)) {
    onTrace?.({ phase: 'search', terms: [], candidateCount: 0, hitCount: 0 });
    return [];
  }
  const text = cleanText(query).slice(0, 400);
  const normalized = normalizeAr(text);
  const terms = expandedTerms(text);
  const explicitBook = bookId || null;
  const subjectBooks = subject ? index.books.filter((book) => allowedBook(book, { subject, track })) : [];
  const subjectBook = subjectBooks.length === 1 ? subjectBooks[0].id : null;
  const referencePage = pageReference(text);

  // مصطلح لا وجود له في أي صفحة من المكتبة لا يصلح دليلاً ولا ضدّاً: يُحذف قبل
  // حساب التغطية وإلا أزاح كلمات مثل «لماذا» و«تبدو» الصفحات التي تجيب فعلاً.
  // وإن لم يبقَ مصطلح معروف نعود لكلها لئلا يتعطل البحث.
  const baseTerms = uniqueTokens(text);
  const knownBaseTerms = baseTerms.filter((term) => index.postings.dfOf(term) > 0 || index.postings.size === 0);
  // ── فهرس الطيّ: تصحيح فروق الهمزة/التاء المربوطة عند غياب النتائج ──
  // مصطلح غائب عن الفهرس لا يعني غياب المعنى: قد يكون سؤال الطالب كتب الهمزة
  // بصورة أخرى. الكلفة صفر حين لا يوجد مصطلح غائب (وهو الغالب).
  const missingTerms = baseTerms.filter((term) => index.postings.dfOf(term) === 0);
  if (missingTerms.length && index.postings.size) {
    // يُمرَّر مصطلحات الطلب نفسه: المقصد منع إعادة إضافة ما ورد في السؤال،
    // لا استبعاد مصطلحات الفهرس (وهي المقصد).
    const queryTerms = new Set([...baseTerms, ...terms]);
    const extras = expandMissing(missingTerms, foldedIndex(index), queryTerms);
    for (const extra of extras) {
      if (!knownBaseTerms.includes(extra)) knownBaseTerms.push(extra);
      if (!terms.includes(extra)) terms.push(extra);
    }
  }
  const pageAddressNumber = referencePage == null ? null : String(referencePage);
  const queryTerms = uniqueTokens(text).filter((term) => !(referencePage && PAGE_QUERY_NOISE.has(term))
    && !(pageAddressNumber && term === pageAddressNumber));
  const discriminating = (term) => dfMaxOf(index, term) > 0;
  const scoringTerms = queryTerms.filter(discriminating);
  const effectiveTerms = scoringTerms.length ? scoringTerms : queryTerms;

  const numericTerms = effectiveTerms.filter((term) => /^\d+$/.test(term));
  const bareNumericQuery = effectiveTerms.length > 0 && numericTerms.length === effectiveTerms.length;
  const pageIdentityBooks = effectiveTerms.length
    ? index.books.filter((book) => allowedBook(book, { subject, track })
      && effectiveTerms.every((term) => titleHasTerm(`${book.title} ${book.subject}`, term)))
    : [];
  const identityBook = pageIdentityBooks.length === 1 ? pageIdentityBooks[0].id : '';
  const requestedBook = explicitBook || subjectBook || identityBook || guessedBook(index, text, '', track);
  const total = index.docCount;

  // ── المرشحون: اتحاد postings لكل صيغة من صيغ السؤال ──────────────
  const candidates = new Set();
  for (const term of terms) {
    for (const id of index.postings.postingsOf(term)) candidates.add(id);
  }
  // ── المطابقة: تُحتسب مرة واحدة لكل مصطلح لا مرة لكل مرشّح ────────
  // المسار القديم كان يستدعي termMatches(doc, term) لكل (مرشّح × مصطلح)، فيقرأ
  // doc.terms بمقارنات خطّية. الآن: لكل مصطلح نجمع مرشحيه مرّة، ونزيد عدّاد
  // مطابقتهم. الكلفة الكلية O(مجموع قوائم postings) بلا حلقة داخلية على المرشحين.
  const matchCount = new Int32Array(total);
  const matchedQueryCount = new Int32Array(total);
  const matchedQueryWeight = new Float64Array(total);
  const formsByTerm = new Map();
  const formsOf = (term) => {
    if (!formsByTerm.has(term)) formsByTerm.set(term, searchTokenForms(term));
    return formsByTerm.get(term);
  };
  // Union of posting lists for every **form** of a term. This is exactly what
  // `termMatches(doc, term)` used to compute by scanning `doc.terms`: it accepted
  // a term and every suffix-attached spelling («السرقة» ⇒ «السرقتها»، «سرقتهم»).
  // The suffix set is the same one applied at query time, so dropping it here
  // would silently narrow every multi-word query.
  const SUFFIXES = ['كم', 'كن', 'هم', 'هن', 'ها', 'نا', 'ه', 'ك', 'ي'];
  const unionCache = new Map();
  const unionOf = (term) => {
    if (unionCache.has(term)) return unionCache.get(term);
    const seen = new Set();
    for (const form of formsOf(term)) {
      for (const id of index.postings.postingsOf(form)) seen.add(id);
      for (const suffix of SUFFIXES) {
        for (const id of index.postings.postingsOf(`${form}${suffix}`)) seen.add(id);
      }
    }
    unionCache.set(term, seen);
    return seen;
  };

  for (const term of terms) {
    for (const id of unionOf(term)) matchCount[id] += 1;
  }
  if (effectiveTerms.length) {
    // وزن المطابقة = مجموع ندرة المصطلحات المطابقة **بلا مُضاعِف الطول**،
    // مطابقةً لـ`termWeight` في المحرّك القديم حرفياً. المُضاعِف (1.25/0.8)
    // يُطبَّق على درجة الصفحة وحدها في حلقة الترتيب، لا على وزن العتبة؛ خلطهما
    // كان يرفع وزن الضجضاء («العرض والطلب في الاقتصاد الأدبي») فوق الحدّ 6
    // المقيس على المكتبة فيمرّ.
    const weights = effectiveTerms.map((term) => {
      const df = Math.max(1, dfExactOf(index, term));
      return { term, weight: Math.log(1 + (total - df + 0.5) / (df + 0.5)) };
    });
    for (const { term, weight } of weights) {
      for (const id of unionOf(term)) {
        matchedQueryCount[id] += 1;
        matchedQueryWeight[id] += weight;
      }
    }
  }

  if (referencePage && requestedBook) {
    const physical = index.printed.get(requestedBook)?.get(referencePage);
    if (physical != null) {
      const direct = index.docIndexByBookPage.get(`${requestedBook}:${physical}`);
      if (direct != null) { candidates.clear(); candidates.add(direct); }
    }
  }
  if (!candidates.size) {
    onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: 0, hitCount: 0 });
    return [];
  }

  const maxResults = Math.max(1, Math.min(budgets.maxSources, Math.floor(Number(limit) || budgets.maxSources)));
  const scopedPageBook = explicitBook || subjectBook || identityBook || (referencePage ? guessedBook(index, text, '', track) : '');
  const scopedBookMeta = scopedPageBook ? index.booksById.get(scopedPageBook) : null;
  const pageHasTopicTerms = scopedBookMeta && effectiveTerms.some((term) => !titleHasTerm(`${scopedBookMeta.title} ${scopedBookMeta.subject}`, term));
  if (referencePage && scopedPageBook && !index.printed.get(scopedPageBook)?.has(referencePage) && !pageHasTopicTerms) {
    onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: candidates.size, hitCount: 0 });
    return [];
  }

  // سؤال فيه رقم صفحة فقط بلا مضمون («صفحة 42») لا يجوز أن يفتح صفحة عشوائية؛
  // وجود مصطلح مضمون واحد على الأقل يجعل البحث عن صفحة منطقياً.
  const unscopedPageQuery = Boolean(referencePage && !explicitBook && !subjectBook && !effectiveTerms.length);
  const exerciseQuery = EXERCISE_QUERY_RE.test(normalizeAr(text));

  // العتبة صارت **نسبة موزونة** لا عدداً مطلقاً: العتبة القديمة (3 مطابقات)
  // كانت تُسقط سؤالاً طبيعياً كلما زاد مضمونه.
  const WEIGHT_FLOOR = 6;
  const COVERAGE_FLOOR = 0.5;
  const ranked = [];
  const relaxed = [];
  const scoreCache = new Map();

  for (const id of candidates) {
    const doc = index.meta[id];
    const book = index.booksById.get(doc.bookId);
    if (!doc || !book || !allowedBook(book, { subject, track })) continue;
    if (explicitBook && doc.bookId !== explicitBook) continue;
    const matched = matchCount[id];
    if (!matched && !(referencePage && doc.bookId === requestedBook)) continue;
    if (!(id in scoreCache)) {
      const matchedQueryTerms = matchedQueryCount[id];
      const directPageMatch = Boolean(referencePage && doc.printedPage === referencePage
        && (!requestedBook || doc.bookId === requestedBook));
      const titleNorm = normalizeAr(`${doc.title} ${doc.section} ${doc.unit}`);
      const exactTitleMatch = effectiveTerms.length >= 2 && effectiveTerms.every((term) => titleNorm.includes(term));
      const coverage = effectiveTerms.length ? matchedQueryTerms / effectiveTerms.length : 0;
      const matchedWeight = matchedQueryWeight[id];
      const numericSpecific = bareNumericQuery && numericTerms.length > 0 && matchedQueryTerms > 0
        && (effectiveTerms.some((term) => idfFromDf(index, dfMaxOf(index, term)) >= 3.2)
          || (doc.textLength > 0 && numericTerms.every((term) => new RegExp(`(?:^|\\D)${term}(?:\\D|$)`).test(String(index.meta[id].normalized || '')))));
      const informative = matchedQueryTerms >= 3
        || (matchedQueryTerms >= 2 && coverage >= COVERAGE_FLOOR && matchedWeight >= WEIGHT_FLOOR);
      const singleTermSpecific = effectiveTerms.length === 1
        && (exactTitleMatch || idfFromDf(index, dfMaxOf(index, effectiveTerms[0])) >= 3.2);
      scoreCache.set(id, { directPageMatch, exactTitleMatch, titleNorm, matchedQueryTerms, coverage, matchedWeight, informative, singleTermSpecific, numericSpecific });
    }
    const cached = scoreCache.get(id);
    if (unscopedPageQuery) continue;
    if (!cached.directPageMatch && !cached.exactTitleMatch && !cached.singleTermSpecific && !cached.numericSpecific && !cached.informative) {
      // مسار احتياطي: عند غياب أي نتيجة تُعاد محاولة أوسع، مُعاد الترتيب بالدرجة
      // وحدها لا بقبول أي صفحة. مشروط بأن يكون الكتاب محدداً (الطالبة اختارت
      // الكتاب أو استُنتج من السؤال) وأن لا تكون الصفحة تمارين، وأن يكون
      // المصطلح المطابق نادراً فعلاً — فلا يفتح هذا المسار ضوضاءً.
      if (requestedBook && doc.bookId === requestedBook && !doc.exercisePage
        && cached.matchedQueryTerms >= 1 && cached.matchedWeight >= 4) {
        relaxed.push({ doc, id, score: cached.matchedQueryWeight + cached.coverage * 2 });
      }
      continue;
    }

    // الدرجة تُحتسب من المصطلحات التي طابقت الصفحة فعلاً. المسار القديم كان
    // يجمع idf لكل صيغة في الاستعلام بلا شرط مطابقة، فتتقارب درجات كل المرشحين.
    let score = 0;
    for (const term of terms) {
      if (!unionOf(term).has(id)) continue;
      const df = Math.max(1, dfExactOf(index, term));
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (term.length >= 4 ? 1.25 : 0.8);
    }
    if (normalized.length > 5 && !doc.staleOutline && String(doc.normalized || '').includes(normalized)) score += 8;
    const titleMatches = terms.reduce((count, term) => count + (cached.titleNorm.includes(term) ? 1 : 0), 0);
    score += titleMatches * 2.4;
    if (requestedBook === doc.bookId) score += 1.5;
    if (referencePage && doc.bookId === requestedBook && doc.printedPage === referencePage) score += 30;
    if (doc.searchable) score += 0.6;
    if (doc.needsOcr) score -= 0.25;
    if (doc.exercisePage) score += exerciseQuery ? 1.5 : -6;
    ranked.push({ doc, id, score });
  }
  const pool = ranked.length ? ranked : relaxed;
  const slice = pool
    .sort((a, b) => b.score - a.score || a.doc.physicalPage - b.doc.physicalPage)
    .slice(0, maxResults);

  // النتائج الفائزة وحدها تُقرأ سجلاتها الكاملة؛ البقية تبقى أيضاحاً خفيفاً.
  const results = [];
  for (const { doc, id, score } of slice) {
    const record = (await index.docAt(id)) || doc;
    results.push(resultFor(index, record, doc, score, id));
  }
  onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: candidates.size, hitCount: results.length });
  return results;
}

const EXERCISE_QUERY_RE = /(?:تمرين|تمارين|تدريب|نشاط|سؤال|سئله|اسئله|واجب|اختبار|اختبر|حل)/;

// ندرة مصطلح انطلاقاً من تردده Document Frequency، وهي الوحدة التي تُقاس عليها
// كل العتبات (3.2 للكلمة الواحدة، 6 لمجموع المطابقة). مقارنة الـdf نفسه بـ3.2
// كانت تُسقط كل كلمة تردّدها أقل من 4 صفحات، فيفشل البحث عن أي مصطلح نادر اسم.
function idfFromDf(index, df) {
  const safe = Math.max(1, Number(df) || 1);
  return Math.log(1 + (index.docCount - safe + 0.5) / (safe + 0.5));
}

// df الأقصى بين صيغ المصطلح: يُستخدم في `singleTermSpecific` وحده، حيث كان
// المحرّك القديم يقيس تردد الكلمة الواحدة بكل صيغها لا بصيغتها المطبوعة.
function dfMaxOf(index, term) {
  let max = 0;
  for (const form of searchTokenForms(term)) {
    const value = index.postings.dfOf(form);
    if (value > max) max = value;
  }
  return max;
}

// df للمصطلح المطابق نفسه: يُطابق `documentFrequency[term]` في المحرّك القديم،
// وهو مصدر `termWeight` و`idf` في حلقة الترتيب معاً.
function dfExactOf(index, term) {
  return index.postings.dfOf(term);
}
*/

// لا يوجد حقل ترتيب: البحث لا يرتّب ولا يرشّح، فالنتيجة تحمل البيانات وحدها.
function resultFor(index, doc, scan, id) {
  const book = index.booksById.get(doc.bookId);
  const hasCurrentText = Boolean(String(doc.text || '').trim());
  const result = {
    id: doc.id || `${doc.bookId}:${doc.physicalPage}`,
    bookId: doc.bookId,
    title: book?.title || doc.bookId,
    subject: book?.subject || '',
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage ?? scan?.printedPage ?? null,
    pageTitle: reconcilePageMetadata(doc.title, hasCurrentText),
    section: doc.section || '',
    unit: doc.unit || '',
    summary: reconcilePageMetadata(doc.summary, hasCurrentText),
    preview: doc.preview,
    searchable: doc.searchable ?? scan?.searchable,
    needsOcr: doc.needsVision ?? doc.needsOcr ?? scan?.needsOcr,
    evidenceStatus: doc.evidenceStatus || scan?.evidenceStatus || null,
    enriched: Boolean(doc.enriched),
  };
  for (const key of ['work', 'author', 'actScene', 'sectionPath', 'titleEn', 'summaryEn', 'answerKeyLocation']) {
    if (doc[key] == null || doc[key] === '') continue;
    result[key] = doc[key];
  }
  if (doc.glossary?.length) result.glossaryCount = doc.glossary.length;
  if (doc.figures?.length) result.figureCount = doc.figures.length;
  if (doc.exercises?.length) result.exerciseCount = doc.exercises.length;
  return result;
}

// ═══════════════════════════════════════════════════════════════════
//  فتح الصفحة وبناء السياق
// ═══════════════════════════════════════════════════════════════════

const STRUCTURED_KEYS = ['unit', 'work', 'author', 'section', 'sectionPath', 'actScene', 'titleEn', 'summaryEn', 'glossary', 'glossaryRefs', 'vocabulary', 'figures', 'activities', 'exercises', 'answerKeyLocation', 'continuesOn', 'recapOf', 'notes'];

// الصفحة تُبنى من سجل الفهرس وحده: النص الكامل والرسوم والمفردات والتمارين كلها داخله.
// السجل يُقرأ من الطبقة المشرَّحة عند الحاجة فقط، فالذاكرة لا تحمل نصوص المكتبة كلها.
export async function fullPage(bookId, physicalPage) {
  const index = await getScanIndex();
  const number = Number(physicalPage);
  if (!index.booksById.has(bookId) || !Number.isInteger(number)) throw new Error('PAGE_NOT_FOUND');
  const id = index.docIndexByBookPage.get(`${bookId}:${number}`);
  if (id == null) throw new Error('PAGE_NOT_FOUND');
  const doc = await index.docAt(id);
  if (!doc) throw new Error('PAGE_NOT_FOUND');

  const text = String(doc.text || '');
  const outlineSummary = usableOutlineSummary(doc.outlineSummary, { hasCurrentText: Boolean(text) });
  const currentSummary = reconcilePageMetadata(doc.summary, Boolean(text));
  const summary = text
    ? (currentSummary || outlineSummary)
    : (outlineSummary || currentSummary || doc.summary || 'هذه الصفحة مصورة ولا يتوفر لها نص موثوق بعد.');
  const textVerdict = assessText(text);
  const sourceEvidence = doc.evidenceStatus ? null : await getPdfPageEvidence(bookId, number);
  const evidenceStatus = resolvedEvidenceStatus(doc, textVerdict, sourceEvidence);
  const outlineVerdict = assessText(outlineSummary);
  const quotation = chooseQuotation(textVerdict, outlineVerdict);
  const damageReasons = quotation.reliable && evidenceStatus !== 'damaged-text'
    ? []
    : [...new Set([
        ...textVerdict.reasons,
        ...outlineVerdict.reasons,
        ...(evidenceStatus === 'damaged-text' && !textVerdict.damaged ? ['بيانات المصدر تشير إلى تلف في طبقة النص'] : []),
      ])];
  const outlineDamageReasons = outlineVerdict.damaged ? outlineVerdict.reasons : [];
  const isDamaged = !quotation.reliable || evidenceStatus === 'damaged-text';
  const needsVision = !text || Boolean(doc.needsOcr) || textVerdict.damaged || !quotation.reliable || evidenceStatus === 'damaged-text';

  const quotableReliable = quotation.reliable && evidenceStatus !== 'damaged-text';
  let evidenceType;
  if ((evidenceStatus === 'damaged-text' && quotation.source === 'pdf-text') || quotation.source === 'unreliable') {
    evidenceType = 'damaged-text';
  } else if (quotation.reliable && quotation.source === 'pdf-text') {
    evidenceType = 'pdf-text';
  } else if (quotation.source === 'outline-description') {
    evidenceType = 'outline-description';
  } else {
    evidenceType = 'summary';
  }
  const page = {
    bookId,
    physicalPage: number,
    printedPage: doc.printedPage ?? null,
    status: evidenceStatus,
    evidenceStatus,
    pageOffset: doc.pageOffset ?? null,
    title: reconcilePageMetadata(doc.title, Boolean(text)) || '',
    section: cleanText(doc.section || ''),
    unit: cleanText(doc.unit || ''),
    pageType: cleanText(doc.pageType || ''),
    purpose: cleanText(doc.purpose || ''),
    summary,
    // Keep the complete indexed text. Outline descriptions are identified separately as non-verbatim metadata.
    text: text || outlineSummary || summary || 'هذه الصفحة مصورة ولا يتوفر لها نص قابل للاستخراج.',
    // النص الأنظف فعلياً: يُقدَّم للاقتباس بدل `text` التالف متى كانت النسخة
    // الفهرسية سليمة (مقيس: 89/164 صفحة في العربية-جزء1 `text` مشوَّه).
    quotableText: quotation.text,
    quotableSource: quotation.source,
    quotableReliable,
    damageReasons,
    outlineDamageReasons,
    damaged: isDamaged,
    searchable: Boolean(text),
    needsVision,
    visionReasons: [
      ...(!text ? ['لا يوجد نص مستخرج من هذه الصفحة'] : []),
      ...(doc.needsOcr ? ['مصدر الصفحة موسوم بأنه يحتاج OCR'] : []),
      ...(evidenceStatus === 'ocr-text' ? ['النص الحالي مستخرج بالـOCR؛ يُستحسن التحقق من موضعه في الصفحة'] : []),
      ...(evidenceStatus === 'damaged-text' && !textVerdict.damaged ? ['بيانات مصدر PDF تشير إلى تلف طبقة النص'] : []),
      ...textVerdict.damaged ? textVerdict.reasons : [],
      ...(!quotation.reliable && outlineVerdict.damaged ? outlineVerdict.reasons : []),
    ],
    evidenceType,
    outlineSummary,
    enriched: Boolean(doc.enriched),
    neighbors: { previous: number > 1 ? number - 1 : null, next: number < Number(index.booksById.get(bookId)?.pageCount || number) ? number + 1 : null },
  };
  for (const key of STRUCTURED_KEYS) {
    const value = doc[key];
    if (value == null || (Array.isArray(value) && !value.length) || (typeof value === 'string' && !value.trim())) continue;
    page[key] = value;
  }
  return page;
}

// المقتطف: النص الكامل إن كان داخل الميزانية، وإلا اختيار موزون حول مصطلحات
// السؤال مع إعلان صريح لما اقتُطع. العتبة مشتقّة من نافذة النموذج لا من ثابت.
/* Retired excerpt/selection helpers; tool results now expose full page text.
function relevantExcerpt(value, query, max) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  const terms = expandedTerms(query);
  const pieces = text
    .split(/\n+|(?<=[.!؟?])\s+/)
    .map((piece, index) => ({ piece: piece.trim(), index, score: terms.reduce((score, term) => score + (normalizeAr(piece).includes(term) ? 1 : 0), 0) }))
    .filter((piece) => piece.piece);
  const selected = [];
  let used = 0;
  for (const piece of [...pieces].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (!piece.score || used + piece.piece.length > max * 0.7) continue;
    selected.push(piece);
    used += piece.piece.length + 1;
  }
  let out;
  if (selected.length) {
    const ordered = selected.sort((a, b) => a.index - b.index).map((piece) => piece.piece).join('\n');
    out = ordered.length >= max * 0.45 ? ordered.slice(0, max) : null;
  }
  if (!out) {
    const head = Math.floor(max * 0.55);
    out = `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
  }
  return out.length >= text.length
    ? text
    : `${out}\n[… اقتُطع ${text.length - out.length} محرفاً من الصفحة؛ اقتُصد على المواضع الأقرب للسؤال …]`;
}

// البيانات المنظّمة (الرسومات والمفردات والتمارين) هي ما لا يظهر في النص، فتلحق به صراحةً.
// السقف كان 2600 محرفاً فاقتطع 21 صفحةً بصمت؛ الآن يُشتق من الميزانية ويُعلَن الاقتطاع.
function structureBlock(page, maxChars) {
  const lines = [];
  for (const figure of page.figures || []) {
    if (!figure?.description) continue;
    const caption = figure.caption ? ` (التعليق المطبوع: ${figure.caption})` : '';
    lines.push(`- صورة${caption}: ${figure.description}`);
    if (figure.figureText?.length) lines.push(`  نص داخل الصورة: ${figure.figureText.join(' | ')}`);
  }
  if (page.glossary?.length) {
    lines.push(`- مفردات الصفحة: ${page.glossary.map((entry) => `${entry.term}${entry.pos ? ` (${entry.pos})` : ''}: ${entry.definition}`).join(' • ')}`);
  }
  for (const exercise of page.exercises || []) {
    const head = `${exercise.letter ? `التمرين ${exercise.letter}` : 'التمارين'}${exercise.instruction ? `: ${exercise.instruction}` : ''}`;
    const items = (exercise.items || []).map((item) => `  ${item.n ?? '—'}) ${item.stem}`).join('\n');
    lines.push(`- ${head}${items ? `\n${items}` : ''}`);
  }
  for (const activity of page.activities || []) {
    if (activity.type === 'exercises' && activity.dispatch) {
      const { target, printedFrom, printedTo } = activity.dispatch;
      lines.push(`- تحويل إلى ${target}: التمارين في الصفحات ${printedFrom}–${printedTo}.`);
      continue;
    }
    const parts = [`نشاط ${activity.number ?? '—'}`];
    if (activity.type) parts.push(activity.type);
    if (activity.instruction) parts.push(activity.instruction);
    if (activity.answerFormat) parts.push(`صيغة الإجابة: ${activity.answerFormat}`);
    if (activity.questions?.length) parts.push(activity.questions.join(' | '));
    lines.push(`- ${parts.join(' — ')}`);
  }
  if (!lines.length) return '';
  return truncateHonestly(lines.join('\n'), maxChars, 'المحتوى المنظّم للصفحة');
}
*/

export async function retrieveContext(query, options = {}) {
  const result = await searchCandidates(query, options);
  options.onTrace?.({ phase: 'search', total: result.total, offset: result.offset, returned: result.results.length, nextOffset: result.nextOffset });
  return {
    sources: result.results,
    block: JSON.stringify(result),
    trace: { total: result.total, offset: result.offset, nextOffset: result.nextOffset },
  };
}

/* Legacy context builder retired: it ranked, excerpted, and capped evidence before the model.
async function retrieveContext(query, options = {}) {
  const budgets = activeBudgets;
  const onTrace = options.onTrace;
  const index = await getScanIndex();
  const hits = await search(query, { ...options, limit: options.limit || budgets.maxSources, budgets });
  const sources = [];
  const blocks = [];
  const tracePages = [];
  // تجميع الكتل بتكلفة خطّية: كان `blocks.join(...)` يُنفَّذ داخل الحلقة فتصير
  // الكلفة تربيعية في عدد المصادر. المحرّف محلي للطلب فلا حالة مشتركة بين الطالبات.
  let joined = '';
  for (const hit of hits) {
    if (sources.length >= budgets.maxSources) break;
    let page;
    try { page = await fullPage(hit.bookId, hit.physicalPage); } catch { page = null; }
    onTrace?.({ phase: 'page', bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true, evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null });
    tracePages.push({ bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true, evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null });
    const quoteSource = page?.quotableSource || (page?.searchable ? 'pdf-text' : 'outline-description');
    const quoteText = page?.quotableText || page?.text || '';
    const content = quoteSource === 'pdf-text'
      ? relevantExcerpt(quoteText, query, budgets.pageChars)
      : truncateHonestly(quoteText || `${hit.pageTitle}\n${hit.summary}\n${hit.preview}`, budgets.previewChars, 'الوصف غير الحرفي');
    if (!content) continue;
    const structure = page ? structureBlock(page, budgets.structureChars) : '';
    const id = `S${sources.length + 1}`;
    const source = {
      id,
      bookId: hit.bookId,
      title: hit.title,
      subject: hit.subject,
      track: index.booksById.get(hit.bookId)?.track || index.booksById.get(hit.bookId)?.branch || 'عام',
      physicalPage: hit.physicalPage,
      printedPage: hit.printedPage,
      pageTitle: hit.pageTitle,
      section: hit.section,
      unit: hit.unit,
      summary: hit.summary,
      preview: hit.preview,
      searchable: page?.searchable ?? hit.searchable,
      needsOcr: page?.needsVision ?? hit.needsOcr,
      status: page?.evidenceStatus || hit.evidenceStatus || null,
      evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null,
      evidenceType: page?.evidenceType || (hit.searchable ? 'pdf-text' : 'outline-description'),
      quotationSource: quoteSource,
      quotableReliable: (page || hit.searchable) ? page?.quotableReliable ?? hit.searchable : false,
      damaged: Boolean(page?.damaged || page?.evidenceStatus === 'damaged-text'),
      enriched: Boolean(page?.enriched),
      score: hit.score,
    };
    for (const key of ['work', 'author', 'actScene', 'sectionPath', 'answerKeyLocation']) {
      if (page?.[key]) source[key] = page[key];
    }
    if (page?.glossary?.length) source.glossaryCount = page.glossary.length;
    if (page?.figures?.length) source.figureCount = page.figures.length;
    if (page?.exercises?.length) source.exerciseCount = page.exercises.length;
    if (page?.damageReasons?.length) source.damageReasons = page.damageReasons;
    // الوسم لم يعد مطلقاً. «صالحة للاستشهاد» لا تُقال إلا بعد فحص سلامة نجح،
    // وكل رفض يُذكر سببه بالتفصيل حتى لا ينقل النموذج نصاً تالفاً بثقة.
    const damageNote = page?.damageReasons?.length ? ` رُصد: ${page.damageReasons.join('؛ ')}.` : '';
    let evidenceLabel;
    if (quoteSource === 'pdf-text' && source.evidenceStatus === 'damaged-text') {
      evidenceLabel = `طبقة النص موسومة بالتلف؛ لا يُنقل منها حرفياً قبل التحقق من صورة الصفحة.${damageNote}`;
    } else if (quoteSource === 'pdf-text' && source.quotableReliable && source.evidenceStatus === 'ocr-text') {
      evidenceLabel = 'نص مستخرج بتقنية OCR من الصفحة — فحص السلامة نجح، وصالح للاستشهاد بعد التحقق البصري من موضع العبارة.';
    } else if (quoteSource === 'pdf-text' && source.quotableReliable) {
      evidenceLabel = 'نص مستخرج من PDF — فحص السلامة نجح، وصالح للاستشهاد بعد التحقق من موضع العبارة في الصفحة.';
    } else if (quoteSource === 'outline-description') {
      evidenceLabel = source.damaged
        ? `نص الصفحة المستخرج تالف فلا يُنقل حرفياً، وهذا وصف فهرسي للصفحة نفسها مقروء بصرياً — للتحديد والتنقل، وليس نقلاً ولا استشهاداً.${damageNote}`
        : 'وصف فهرسي غير حرفي — للتنقل وتحديد الموضوع فقط، وليس اقتباسا من الصفحة.';
    } else {
      evidenceLabel = `لا تتوفر نسخة نصية موثوقة للاقتباس أو بناء الحكم؛ يلزم التحقق من الصفحة المطبوعة أو قراءتها بصرياً.${damageNote || ' رُصد: لا نسخة سليمة من النص ولا من الوصف الفهرسي.'}`;
    }
    const pageLabel = hit.printedPage != null
      ? `الصفحة المطبوعة ${hit.printedPage} (صفحة PDF ${hit.physicalPage})`
      : `صفحة PDF ${hit.physicalPage} (رقم الصفحة المطبوع غير متحقق)`;
    const heading = [`[${id}] ${hit.title} | ${pageLabel} | ${hit.pageTitle}`];
    if (source.work) heading.push(`[العمل: ${source.work}${source.author ? ` — ${source.author}` : ''}${source.section ? ` — ${source.section}` : ''}]`);
    heading.push(`[نوع الدليل: ${evidenceLabel}]`);
    const block = [...heading, content, structure ? `[محتوى منظّم مستخرج من الصفحة]\n${structure}` : ''].filter(Boolean).join('\n');
    // تجميع الكتل بتكلفة خطّية: كان `blocks.join` يُنفَّذ داخل الحلقة فتصير الكلفة تربيعية.
    const projected = blocks.length ? `${joined}${budgets.blockSeparator}${block}` : block;
    if (projected.length > budgets.evidenceChars) break;
    joined = projected;
    sources.push(source);
    blocks.push(block);
  }
  return { sources, block: joined, trace: { pages: tracePages } };
}
*/
