// فهرس pdf-index المخزون + احتياطي الصفحة الدقيقة من ملف الـPDF.
// إصلاحات هذه النسخة: (١) مستند pdfjs المفتوح يُحفظ للكتاب في ذاكرة LRU
// بمدخلين (الطبقة المجانية ٥١٢ME) فلا يُقرأ ملفّ ٩٠ME مع كل طلب؛ (٢) `signal`
// يُلغي العمل فعلاً — إلغاءٌ وسط قراءة أو رسم أو تحليل يُلقي ABORTED؛
// (٣) النصّ يُبنى بترتيب القراءة (lib/pdf-layout.mjs) والصورة تُرسم عند الحاجة.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokenYears, cleanText, hasTextDamage, normalizeAr, normalizeDigits, searchTokenForms, searchTokens, uniqueTokens } from './text.mjs';
import { reconstructText } from './pdf-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_INDEX = path.join(ROOT, 'curriculum-library', 'pdf-index.json');
const SOURCES_DIR = path.join(ROOT, 'curriculum-library', 'pdf-sources');
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,80}$/i;
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_PIXELS = 1_700_000;
const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;
const OCR_ENGINES = /(?:^|[-+])(?:vision|ocr)(?:$|[-+])|visual-transcription/i;
// «هللا» لا وجود له في العربية الصحيحة (قلب «الله»): هو قلب الـOCR نفسه.
const DAMAGE_REVERSED = /هللا/u;
// خلط عربي/لاتيني موضعان فأكثر فقط: الموضع الواحد قد يكون مصطلحاً إنكليزياً
// بين قوسين أو شائبة حاشية، وكان يُسقط 39 صفحة مقروءة باسم «تالفة».
const DAMAGE_MIXED_WORD = /[\u0600-\u06FF][A-Za-z][\u0600-\u06FF]|[A-Za-z][\u0600-\u06FF][A-Za-z]/gu;
const DAMAGE_MIXED_MIN = 2;
const ENGLISH_QUERY_NOISE = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'for',
  'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'their', 'this',
  'that', 'these', 'those', 'to', 'was', 'were', 'what', 'which', 'who', 'with',
]);

let pdfCatalogPromise;
let pdfSearchIndexPromise;
let pdfRuntimePromise;
let pdfWorkQueue = Promise.resolve();
// مؤقّت المكنسة الدورية للمستندات الخاملة (يبدأ مع أول مستند مفتوح).
let docSweeper = null;
const pdfStats = { lastOpenMs: 0, totalOpens: 0, totalRenders: 0, cacheHits: 0, pageTextCacheHits: 0, idleEvictions: 0 };

// «أُلغي العمل» ليس «فشل الملف»: بدون تمييزهما يُقعّد الطالب على نصّ الفهرس
// كأنه دليلٌ فُتح، وتبقى قراءة ٩٠ME تعمل في الخلفية بلا مُنتظِر.
function abortError(signal) {
  const error = new Error('PDF_WORK_ABORTED');
  error.code = 'ABORTED';
  if (signal?.reason) error.reason = signal.reason;
  return error;
}

function isAbortError(error) {
  return error?.code === 'ABORTED' || error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
}

// ─── ذاكرة المستندات المفتوحة ───────────────────────────────────
// كان كل طلب صفحة يقرأ الملف كاملاً (حتى ٩٠ME في هذه المكتبة) ويعيد تحليله مع
// pdfjs. الآن يُحفظ المستند المفتوح لكل كتاب ويُعاد استخدامه، وآخر استخدامين
// فقط يبقيان في الذاكرة (الطبقة المجانية ٥١٢ME). الإبطال بعد ١٢٠ ثانية خمول
// يُبقي الذاكرة محرّرة أثناء فترات الصمت.
const MAX_OPEN_DOCS = 2;
const MAX_PAGE_TEXT_CACHE = 128;
const DOC_IDLE_MS = 120_000;
const DOC_SWEEP_MS = 30_000;
const openDocs = new Map();
const pageTextCache = new Map();

function cachedPageText(bookId, physicalPage) {
  const key = `${bookId}:${physicalPage}`;
  const entry = pageTextCache.get(key);
  if (!entry) return null;
  pageTextCache.delete(key);
  pageTextCache.set(key, entry);
  pdfStats.pageTextCacheHits += 1;
  return entry;
}

function storePageText(bookId, physicalPage, value) {
  const key = `${bookId}:${physicalPage}`;
  pageTextCache.delete(key);
  pageTextCache.set(key, value);
  while (pageTextCache.size > MAX_PAGE_TEXT_CACHE) pageTextCache.delete(pageTextCache.keys().next().value);
}

/** إحصاءات مراقبة: مستندات مفتوحة، زمن آخر فتح، وعدد الفتح والرسوم. */
export function getPdfStats() {
  return {
    openDocuments: openDocs.size, cachedBooks: openDocs.size, cachedBookIds: [...openDocs.keys()],
    cachedPageTexts: pageTextCache.size,
    lastOpenMs: pdfStats.lastOpenMs, totalOpens: pdfStats.totalOpens, totalRenders: pdfStats.totalRenders,
    cacheHits: pdfStats.cacheHits, pageTextCacheHits: pdfStats.pageTextCacheHits || 0, idleEvictions: pdfStats.idleEvictions,
  };
}

// الأقل استعمالاً يُطرد أولاً: `openDocs` يُعاد إدراجه عند كل استخدام، فآخر
// مفاتيحه هو الأحدث استعمالاً.
async function evictLruDocument() {
  const oldest = openDocs.keys().next().value;
  const entry = oldest == null ? null : openDocs.get(oldest);
  if (!entry) return;
  openDocs.delete(oldest);
  try { await entry.document.destroy(); } catch { /* هدم مستندٍ لا يهمّ */ }
}

async function getOpenDocument(filePath, bookId, signal) {
  const cacheKey = String(bookId || filePath);
  const hit = openDocs.get(cacheKey);
  if (hit) {
    // لا ملف ولا stat ولا readFile: المستند المُحلَّل جاهز من طلبٍ سابق.
    openDocs.delete(cacheKey);
    openDocs.set(cacheKey, hit);
    hit.lastUsed = Date.now();
    pdfStats.cacheHits += 1;
    return { document: hit.document, entry: hit, fromCache: true };
  }
  if (signal?.aborted) throw abortError(signal);
  const startedAt = Date.now();
  // fs يتحقّق من نوع الإشارة: نمرّرها فقط إن كانت AbortSignal حقيقية فتتُلغى
  // قراءة ملفّ ٩٠ME فعلاً، وإلا نعتمد على فحص `aborted` قبل كل await.
  const fsOptions = signal instanceof AbortSignal ? { signal } : undefined;
  const info = await stat(filePath, fsOptions);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PDF_BYTES) throw new Error('PDF_SOURCE_SIZE_UNSUPPORTED');
  const buffer = await readFile(filePath, fsOptions);
  // pdfjs-dist يرفض Node Buffer صراحةً وإن كان يُشتق من Uint8Array؛ العرض
  // يبقي القراءة محدودة بلا نسخ ملف بحجم ٩٠ME.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { pdfjs, canvasApi } = await loadPdfRuntime();
  if (signal?.aborted) throw abortError(signal);
  // مدخل ثالث يُخرج الأقل استعمالاً قبل أن يُفتح الجديد.
  while (openDocs.size >= MAX_OPEN_DOCS) await evictLruDocument();
  const canvasFactory = canvasApi ? createCanvasFactory(canvasApi) : null;
  const document = await pdfjs.getDocument({ data, ...(canvasFactory ? { canvasFactory } : {}), isEvalSupported: false, verbosity: 0 }).promise;
  pdfStats.totalOpens += 1;
  pdfStats.lastOpenMs = Date.now() - startedAt;
  if (signal?.aborted) {
    // pdfjs لا يقبل الإلغاء وسط التحليل: نُحرّر ما فُتح بدل أن نُخزّن ميّتاً.
    try { await document.destroy(); } catch { /* لا شيء */ }
    throw abortError(signal);
  }
  const entry = { document, canvasApi, canvasFactory, lastUsed: Date.now() };
  openDocs.set(cacheKey, entry);
  startDocSweeper();
  return { document, entry, fromCache: false };
}

// إبطال دوري للخمول: بلا هذا يبقى كتابٌ كامل محتفظاً به بين سؤال وآخر. الهدم
// يجري داخل طابور العمل نفسه حتى لا يُهدم مستندٌ تعمل عليه مهمّة الآن،
// ومؤقّته unref كي لا يُبقي العملية حيّة وحده.
function startDocSweeper() {
  if (docSweeper) return;
  docSweeper = setInterval(() => {
    const now = Date.now();
    const expired = [...openDocs.entries()].filter(([, entry]) => now - entry.lastUsed > DOC_IDLE_MS);
    if (!expired.length) return;
    void serializePdfWork(async () => {
      for (const [key, entry] of expired) {
        if (openDocs.get(key) !== entry) continue;
        openDocs.delete(key);
        pdfStats.idleEvictions += 1;
        try { await entry.document.destroy(); } catch { /* هدم مستندٍ لا يهمّ */ }
      }
    }).catch(() => {});
  }, DOC_SWEEP_MS);
  docSweeper.unref?.();
}

function positiveInteger(value) {
  const normalized = normalizeDigits(String(value ?? '')).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function sourceLooksLikeOcr(page = {}) {
  const ocr = page.ocr && typeof page.ocr === 'object' ? page.ocr : {};
  const engine = String(ocr.engine || page.ocrEngine || '').trim();
  const status = String(ocr.status || page.ocrStatus || '').trim().toLowerCase();
  // `needed`/`pending`/`no-text` حالة عمل لا نتيجة OCR، ومحرّكات المكتمل
  // والبصري هي التي جاء نصّها من OCR فعلاً؛ و`pdf-text` ليس OCR.
  if (['needed', 'pending', 'no-text'].includes(status)) return false;
  if (OCR_ENGINES.test(engine)) return true;
  if (/^(?:pdf-text|none|visual-required)$/i.test(engine)) return false;
  return ['completed', 'repaired', 'text+visual'].includes(status);
}

function explicitlyDamaged(page = {}) {
  return page.textDamaged === true
    || page.evidenceStatus === 'damaged-text'
    || page.status === 'damaged-text';
}

function damagedEvidence(value) {
  const raw = String(value ?? '');
  if (!raw.trim()) return false;
  if (hasTextDamage(raw) || DAMAGE_REVERSED.test(raw)) return true;
  if ((raw.match(DAMAGE_MIXED_WORD) || []).length >= DAMAGE_MIXED_MIN) return true;
  return brokenYears(raw).length > 0;
}

function hasUsefulText(value) {
  const text = cleanText(value);
  if (!text) return false;
  const visible = text.replace(/\s/g, '');
  return visible.length >= 20 || /[\p{L}]{4,}/u.test(text);
}

/**
 * تصنيف دليل الصفحة باصطلاح واحد للفهرس والمخططات والاحتياطي: التلف يسبق
 * أصل OCR، والصفحة بلا نصّ مفيد (أرقام حاشية فقط) هي `no-text`.
 */
export function classifyPageEvidence(text, sourcePage = {}) {
  const raw = String(text ?? '');
  if (!hasUsefulText(raw)) return 'no-text';
  const original = sourcePage.fullText ?? sourcePage.text ?? '';
  if (explicitlyDamaged(sourcePage) || damagedEvidence(raw) || (original && damagedEvidence(original))) return 'damaged-text';
  if (sourceLooksLikeOcr(sourcePage)) return 'ocr-text';
  return 'clean-extracted-text';
}

async function loadPdfCatalog() {
  if (!pdfCatalogPromise) {
    // وعدٌ فاشل لا يُعاد استعماله: الفهرس يُبنى من جديد بين الطلبات.
    pdfCatalogPromise = (async () => {
      const index = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
      if (!Array.isArray(index?.books)) throw new Error('CURRICULUM_PDF_INDEX_INVALID');
      const books = new Map();
      for (const entry of index.books) {
        if (!SAFE_ID.test(String(entry?.id || ''))) continue;
        const rawPages = Array.isArray(entry.pages) ? entry.pages : [];
        const pages = new Map();
        for (const rawPage of rawPages) {
          const physicalPage = positiveInteger(rawPage.physicalPage ?? rawPage.pageNumber);
          if (physicalPage == null) continue;
          const ocr = rawPage.ocr && typeof rawPage.ocr === 'object'
            ? { engine: rawPage.ocr.engine || null, status: rawPage.ocr.status || null, required: Boolean(rawPage.ocr.required) }
            : null;
          pages.set(physicalPage, {
            physicalPage, printedPage: positiveInteger(rawPage.printedPage ?? rawPage.printedPageNumber),
            title: cleanText(rawPage.title || ''), text: String(rawPage.fullText || ''), ocr,
            needsOcr: Boolean(rawPage.needsOcr || rawPage.ocr?.required), textDamaged: rawPage.textDamaged === true,
          });
        }
        const source = entry.source || entry.book?.source || {};
        const provenanceName = rawPages.find((page) => page.sourceProvenance?.fileName)?.sourceProvenance?.fileName;
        books.set(entry.id, {
          id: entry.id, title: cleanText(entry.title || entry.book?.title || ''), subject: cleanText(entry.subject || entry.book?.subject || ''),
          track: cleanText(entry.track || entry.book?.track || entry.branch || entry.book?.branch || ''),
          branch: cleanText(entry.branch || entry.book?.branch || ''), supplementary: Boolean(entry.supplementary ?? entry.book?.supplementary),
          pageCount: positiveInteger(entry.pageCount) || pages.size,
          source: { fileName: source.fileName || provenanceName || '', bytes: Number(source.bytes) || null, checksum: source.checksum || null },
          pages,
        });
      }
      return books;
    })().catch((error) => {
      pdfCatalogPromise = undefined;
      throw error;
    });
  }
  return pdfCatalogPromise;
}

function buildPdfSearchIndex(books) {
  const pages = [];
  const postings = new Map();
  for (const book of books.values()) for (const page of book.pages.values()) {
    const terms = new Set(searchTokens(page.text));
    if (!terms.size) continue;
    const pageId = pages.push({ book, page }) - 1;
    for (const term of terms) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(pageId);
    }
  }
  return { books: [...books.values()], pages, postings };
}

async function loadPdfSearchIndex() {
  if (!pdfSearchIndexPromise) {
    pdfSearchIndexPromise = loadPdfCatalog().then(buildPdfSearchIndex).catch((error) => {
      pdfSearchIndexPromise = undefined;
      throw error;
    });
  }
  return pdfSearchIndexPromise;
}

function allowedSearchBook(book, { track = '', subject = '', bookId = '' } = {}) {
  if (bookId && book.id !== bookId) return false;
  const wantedTrack = normalizeAr(track);
  // المسار المطلوب حدٌّ قاطع: غياب البيانات الوصفية أو اختلافها لا يُسقط البحث في مسارٍ آخر.
  if (wantedTrack && wantedTrack !== normalizeAr(book.track || book.branch || '')) return false;
  if (wantedTrack === normalizeAr('ديني') && book.supplementary) return false;
  const wantedSubject = normalizeAr(subject);
  return !wantedSubject || normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject);
}

/**
 * مرشّحون من fullText على مستوى الصفحة في pdf-index.json المخزون. محدِّدٌ
 * احتياطي فقط: النصّ المشتق لا يُثبت أن الصفحة البصرية صحيحة، فيُستدعى بعد
 * تعذّر البحث المحلي ثم يُتلى بـ`readPdfPage` قبل عرض النصّ.
 */
export async function searchPdfPages(query, { track = '', subject = '', bookId = '', limit = 5 } = {}) {
  const text = cleanText(String(query || '')).slice(0, 400);
  const queryTerms = uniqueTokens(text).filter((term) => !ENGLISH_QUERY_NOISE.has(term)).slice(0, 32);
  if (!queryTerms.length) return [];

  const index = await loadPdfSearchIndex();
  const candidates = new Map();
  const eligibleBooks = new Set();
  const requestedBookId = String(bookId || '').trim();
  for (const book of index.books) if (allowedSearchBook(book, { track, subject, bookId: requestedBookId })) eligibleBooks.add(book.id);
  if (requestedBookId && !eligibleBooks.has(requestedBookId)) return [];

  const queryStats = [];
  for (const queryTerm of queryTerms) {
    const pageIds = new Set();
    for (const form of searchTokenForms(queryTerm)) for (const pageId of index.postings.get(form) || []) pageIds.add(pageId);
    const idf = Math.log(1 + (index.pages.length - pageIds.size + 0.5) / (pageIds.size + 0.5));
    queryStats.push({ queryTerm, pageIds, idf, weight: idf * (queryTerm.length >= 4 ? 1.25 : 0.8) });
  }
  for (const { queryTerm, pageIds, weight } of queryStats) for (const pageId of pageIds) {
    if (!eligibleBooks.has(index.pages[pageId].book.id)) continue;
    if (!candidates.has(pageId)) candidates.set(pageId, { entry: index.pages[pageId], matchedTerms: [], matchedWeight: 0 });
    const candidate = candidates.get(pageId);
    candidate.matchedTerms.push(queryTerm);
    candidate.matchedWeight += weight;
  }

  const maxResults = Math.max(1, Math.min(24, Math.floor(Number(limit) || 5)));
  const totalWeight = queryStats.reduce((sum, item) => sum + item.weight, 0);
  const expectedTerms = queryStats.length;
  return [...candidates.values()]
    .map(({ entry, matchedTerms, matchedWeight }) => {
      const coverage = expectedTerms ? matchedTerms.length / expectedTerms : 0;
      const weightedCoverage = totalWeight ? matchedWeight / totalWeight : 0;
      // عتبة الإفادة: ثلاثة مصطلحات، أو مصطلحان بغطاء عالٍ ووزن كافٍ، أو
      // مصطلح نادرٌ بمعرفته >= 3.2. بدونها يُرجَّح كل تطابق عابر.
      const onlyTerm = expectedTerms === 1 ? queryStats[0] : null;
      const informative = matchedTerms.length >= 3
        || (matchedTerms.length >= 2 && coverage >= 0.75 && matchedWeight >= 6)
        || (onlyTerm && onlyTerm.idf >= 3.2);
      if (!informative) return null;
      const { book, page } = entry;
      const evidenceStatus = classifyPageEvidence(page.text, page);
      // الفوليوهات الفيزيائية/المطبوعة مكرّرة في المستوى الأعلى كي يُستهَل
      // المرشّح مباشرة بـ`readPdfPage(candidate)`؛ الرقم دائماً فيزيائي.
      const sourcePage = {
        physicalPage: page.physicalPage, printedPage: page.printedPage, pageNumber: page.physicalPage,
        printedPageNumber: page.printedPage, title: page.title, evidenceStatus,
        needsOcr: page.needsOcr, textDamaged: page.textDamaged,
      };
      return {
        score: Number((matchedWeight + weightedCoverage * 2).toFixed(3)),
        bookId: book.id, title: book.title || book.id, subject: book.subject, track: book.track || book.branch || 'عام',
        physicalPage: page.physicalPage, printedPage: page.printedPage, pageNumber: page.physicalPage,
        printedPageNumber: page.printedPage, source: { ...book.source }, pageTitle: page.title,
        coverage: Number(coverage.toFixed(3)), sourcePage, matchedTerms, evidenceStatus,
        needsOcr: page.needsOcr, textSource: 'pdf-index.fullText', pdfOpened: false,
        visualVerified: false, forceSource: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length
      || a.bookId.localeCompare(b.bookId) || a.physicalPage - b.physicalPage)
    .slice(0, maxResults);
}

async function getBook(bookId) {
  if (!SAFE_ID.test(String(bookId || ''))) return null;
  const books = await loadPdfCatalog();
  return books.get(bookId) || null;
}

/** دليل مصدر مختصر بلا فتح الـPDF. */
export async function getPdfPageEvidence(bookId, physicalPage) {
  const number = positiveInteger(physicalPage);
  if (number == null) return null;
  try {
    const page = (await getBook(bookId))?.pages.get(number);
    if (!page) return null;
    return {
      evidenceStatus: classifyPageEvidence(page.text, page), printedPage: page.printedPage,
      title: page.title, needsOcr: page.needsOcr, ocr: page.ocr, textDamaged: page.textDamaged,
      textSource: 'pdf-index.fullText', pdfOpened: false,
    };
  } catch {
    return null;
  }
}

function result({
  bookId, physicalPage = null, printedPage = null, text = '', evidenceType = 'unavailable',
  status = 'unavailable', title = '', imageDataUrl = '', imageError = '', error = '', pdfOpened = false, textSource = 'none',
  sourceProvenance = null, fromCache = null, pageTextCacheHit = null,
}) {
  const page = {
    bookId: String(bookId || ''), physicalPage, printedPage, text, evidenceType, status,
    title: cleanText(title || ''), pdfOpened: Boolean(pdfOpened), textSource,
    sourceProvenance: sourceProvenance || { textSource, pdfOpened: Boolean(pdfOpened) }, visualVerified: false,
  };
  // «من الذاكرة» يفرّق «فُتح الملف الآن» من «أُعيد استخدام مستند مفتوح سلفاً»:
  // pdfOpened صادق في الحالتين، والفرق في الذاكرة لا في الدليل.
  if (fromCache != null) page.fromCache = Boolean(fromCache);
  if (pageTextCacheHit != null) page.pageTextCacheHit = Boolean(pageTextCacheHit);
  if (imageError) page.imageError = String(imageError);
  if (error) page.error = String(error);
  if (imageDataUrl) page.imageDataUrl = imageDataUrl;
  if (imageDataUrl) page.imageSource = 'pdf-source-image';
  return page;
}

function sourcePath(fileName) {
  const name = String(fileName || '').trim();
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || !/\.pdf$/i.test(name)) return '';
  const resolved = path.resolve(SOURCES_DIR, name);
  const relative = path.relative(SOURCES_DIR, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return resolved;
}

function createCanvasFactory(canvasApi) {
  return {
    create(width, height) {
      const canvas = canvasApi.createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
      canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
    },
    destroy(canvasAndContext) {
      if (!canvasAndContext) return;
      if (canvasAndContext.canvas) { canvasAndContext.canvas.width = 0; canvasAndContext.canvas.height = 0; }
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };
}

async function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = (async () => {
      let canvasApi = null;
      try {
        canvasApi = await import('@napi-rs/canvas');
        globalThis.Path2D ||= canvasApi.Path2D;
        globalThis.DOMMatrix ||= canvasApi.DOMMatrix;
        globalThis.ImageData ||= canvasApi.ImageData;
      } catch {
        // استخراج النصّ ينجح حتى بلا الـcanvas الأصلي الاختياري.
      }
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      return { pdfjs, canvasApi };
    })().catch((error) => {
      pdfRuntimePromise = undefined;
      throw error;
    });
  }
  return pdfRuntimePromise;
}

// ثواني تحميل pdfjs الأولى تنتقل بلا هذا التسخين من زمن الطالب إلى زمن الخادم الخامل.
export async function warmPdfRuntime() {
  try {
    await loadPdfRuntime();
    return true;
  } catch (error) {
    console.warn('pdf runtime warmup skipped:', error?.message || error);
    return false;
  }
}

// الرسم التنازلي: سقف 1.7M بكسل وأربع محاولات بمقياس ×0.72 حتى يبقى
// dataURL تحت 1.5MB؛ الصورة الأكبر تُرمى ويُعاد التصغير بدل أن تُرسَل ثقيلة.
async function renderPageImage(page, canvasApi, canvasFactory, signal) {
  if (!canvasApi || !canvasFactory) return '';
  if (signal?.aborted) throw abortError(signal);
  const unscaled = page.getViewport({ scale: 1 });
  const pixelRatio = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, unscaled.width * unscaled.height));
  let scale = Math.min(1.6, pixelRatio);
  for (let attempt = 0; attempt < 4 && !signal?.aborted; attempt += 1, scale *= 0.72) {
    const viewport = page.getViewport({ scale });
    const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
    try {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // pdfjs لا يأخذ AbortSignal: نُلحق الإشارة بالمهمّة ونطلب cancel() عند
      // المهلة، فلا تبقى مهمّة ترسم بعد أن يكون الطالب قد رجع.
      const task = page.render({ canvasContext: context, viewport, canvasFactory });
      signal?.addEventListener?.('abort', () => {
        try { task.cancel?.(); } catch { /* انتهت أو لا تقبل الإلغاء */ }
      }, { once: true });
      await task.promise;
      const jpg = Buffer.from(await canvas.encode('jpeg', 82));
      const dataUrl = `data:image/jpeg;base64,${jpg.toString('base64')}`;
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) return dataUrl;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return '';
}

// استخراج صفحة من مستند **مفتوح مسبقاً**: لا يقرأ الملف ولا يحلّله. `wantImage`
// يقرّر الرسم: false يمنعه مطلقاً، true يفرضه، والافتراضي يرسم فقط حين لا نصّ
// مفيد أو النصّ تالف — فصفحة نظيفة لا تُرسَل صورتها للقراءة البصرية أصلاً،
// ورسمها إهدار ثوانٍ وذاكرة على الطبقة المجانية.
async function inspectPdfPage(filePath, physicalPage, { wantImage = null, sourceTextDamaged = false, signal, bookId } = {}) {
  const pageNumber = positiveInteger(physicalPage);
  if (pageNumber == null) throw new Error('PDF_PHYSICAL_PAGE_INVALID');
  if (signal?.aborted) throw abortError(signal);
  const { document, entry, fromCache } = await getOpenDocument(filePath, bookId, signal);
  if (pageNumber > document.numPages) return { status: 'not-found', text: '', imageDataUrl: '', fromCache };
  const page = await document.getPage(pageNumber);
  if (signal?.aborted) throw abortError(signal);

  let cached = cachedPageText(bookId, pageNumber);
  let text;
  let textStatus;
  if (cached) {
    text = cached.text;
    textStatus = cached.status;
  } else {
    text = cleanText(reconstructText(await page.getTextContent()));
    textStatus = classifyPageEvidence(text);
    storePageText(bookId, pageNumber, { text, status: textStatus });
  }
  if (signal?.aborted) throw abortError(signal);

  const damaged = sourceTextDamaged || textStatus === 'damaged-text';
  const shouldRender = wantImage === true || (wantImage !== false && (damaged || !hasUsefulText(text)));
  let imageDataUrl = '';
  let imageError = '';
  if (shouldRender) {
    try {
      imageDataUrl = await renderPageImage(page, entry.canvasApi, entry.canvasFactory, signal);
      if (!imageDataUrl) imageError = entry.canvasApi ? 'لم يُنتج الرسم صورة ضمن حد الصورة المدعوم.' : 'مكتبة الرسم غير متاحة؛ تعذر إنشاء صورة الصفحة.';
      pdfStats.totalRenders += 1;
    } catch (error) {
      if (isAbortError(error)) throw error;
      imageError = String(error?.message || error);
    }
  }
  return { status: textStatus, text, imageDataUrl, imageError, fromCache, pageTextCacheHit: Boolean(cached) };
}

// كل عمل PDF يُسلسل على طابور واحد: Node أحادي الخيط، وتحليلان متوازيان في
// pdfjs يتزاحمان على الذاكرة. المهمّة التي أُلغيت أثناء انتظار دورها لا تُنفَّذ
// ولا تؤخّر ما بعدها — الطابور يتقدّم فوراً بدل أن ينتظر عملاً لا مُنتظِر له.
function serializePdfWork(task, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  // pdfWorkQueue لا يرفض أبداً (المساود يبتلع الأخطاء)، فـ`.then` وحده يكفي
  // لانتظار الدور؛ ثم تُفحص الإشارة قبل أن يبدأ عملٌ قد أُلغي أثناء الانتظار.
  const work = pdfWorkQueue.then(async () => {
    if (signal?.aborted) throw abortError(signal);
    return await task();
  });
  pdfWorkQueue = work.then(() => undefined, () => undefined);
  return work;
}

function pageTitle(book, page, physicalPage) {
  return page?.title || book?.title || `صفحة PDF ${physicalPage}`;
}

function pageSourceProvenance(book, textSource, pdfOpened, sourceStatus) {
  return {
    fileName: book?.source?.fileName || null, bytes: book?.source?.bytes ?? null,
    checksum: book?.source?.checksum || null, sourceStatus, textSource, pdfOpened: Boolean(pdfOpened),
  };
}

function indexedTextResult({ book, bookId, physicalPage, printedPage, title, page, text, sourceStatus, error = '' }) {
  const useful = hasUsefulText(text);
  const status = classifyPageEvidence(text, page || {});
  const textSource = useful ? 'pdf-index.fullText' : 'none';
  const evidenceType = !useful ? 'unavailable'
    : status === 'damaged-text' ? 'damaged-text'
    : status === 'ocr-text' ? 'ocr-text' : 'pdf-text';
  // الحالة والمصدر يقولان بصراحة إن الملف لم يُفتح — لا مجال للالتباس.
  return result({
    bookId, physicalPage, printedPage, text: useful ? text : '', evidenceType, title,
    status: useful ? status : 'unavailable', pdfOpened: false, textSource, error,
    sourceProvenance: pageSourceProvenance(book, textSource, false, sourceStatus),
  });
}
/**
 * حلّ صفحة فيزيائية واحدة بدقّة. `forceSource: false` يسمح بنتيجة نظيفة من
 * `pdf-index.fullText` دون فتح الملف؛ و`pdfOpened`/`textSource`/
 * `sourceProvenance`/`fromCache` تفرّق بين الأصلين. النتائج الناجحة
 * `clean-extracted-text` و`ocr-text` و`damaged-text` و`no-text`، وأمّا
 * `not-found`/`unavailable` فنتائج تشغيلية. الطلب يقبل `signal` (إلغاء المهلة)
 * و`wantImage` (رسم الصفحة) بالإضافة إلى الصياغة القديمة بثلاث وسائط.
 */
export async function readPdfPage(bookOrRequest, requestedPhysicalPage, options = {}) {
  const request = bookOrRequest && typeof bookOrRequest === 'object'
    ? bookOrRequest
    : { ...options, bookId: bookOrRequest, physicalPage: requestedPhysicalPage };
  const bookId = String(request.bookId || '');
  let physicalPage = positiveInteger(request.physicalPage);
  const requestedPrintedPage = positiveInteger(request.printedPage);
  const forceSource = request.forceSource !== false;
  // إشارة الإلغاء: مهلة الطالب تُلغي العمل فعلاً لا أن تتركه يعمل بلا مُنتظِر.
  const signal = request.signal && typeof request.signal === 'object' ? request.signal : null;
  // `wantImage`: false يمنع رسم الصورة إطلاقاً، true يفرضه، والافتراضي يرسم
  // فقط حين لا نصّ مفيد أو النصّ تالف — فصورة صفحة نظيفة لا تُرسَل للقراءة
  // البصرية، ورسمها إهدار ثوانٍ وذاكرة على الطبقة المجانية.
  const wantImage = request.wantImage == null ? null : Boolean(request.wantImage);
  if (signal?.aborted) throw abortError(signal);
  // كتابٌ أو صفحةٌ غير صالحة: نتيجة تشغيلية واضحة بلا رمي.
  if (!SAFE_ID.test(bookId)) return result({ bookId, physicalPage, printedPage: requestedPrintedPage, status: 'not-found' });

  let book;
  try { book = await getBook(bookId); } catch {
    return result({ bookId, physicalPage, printedPage: requestedPrintedPage, status: 'unavailable' });
  }
  if (!book) return result({ bookId, physicalPage, printedPage: requestedPrintedPage, status: 'not-found' });

  if (physicalPage == null && requestedPrintedPage != null) {
    const matches = [...book.pages.values()].filter((page) => page.printedPage === requestedPrintedPage);
    physicalPage = matches.length === 1 ? matches[0].physicalPage : null;
  }
  if (physicalPage == null || physicalPage > book.pageCount) {
    return result({ bookId, physicalPage, printedPage: requestedPrintedPage, title: book.title, status: 'not-found' });
  }

  const page = book.pages.get(physicalPage) || null;
  const printedPage = page?.printedPage ?? requestedPrintedPage ?? null;
  const title = pageTitle(book, page, physicalPage);
  let text = cleanText(page?.text || '');
  let status = classifyPageEvidence(text, page || {});
  const sourceTextDamaged = Boolean(page?.textDamaged || status === 'damaged-text');
  const indexOnly = { book, bookId, physicalPage, printedPage, title, page, text };
  if (hasUsefulText(text) && status !== 'damaged-text' && !forceSource) {
    return indexedTextResult({ ...indexOnly, sourceStatus: 'not-attempted' });
  }

  const filePath = sourcePath(book.source.fileName);
  if (!filePath) return indexedTextResult({ ...indexOnly, sourceStatus: 'unavailable' });

  try {
    // عمل الـPDF مُسلسَل على طابور واحد (Node خيط واحد، وتحليلان متوازيان
    // يُهلكان الذاكرة). المهمّة تستقبل إشارة الإلغاء فتتحرّق فوراً بدل أن تُكمَل
    // في الخلفية بعد أن تكون المهلة قد أعادت null للطالب.
    const inspected = await serializePdfWork(() => inspectPdfPage(filePath, physicalPage, {
      wantImage, sourceTextDamaged, signal, bookId,
    }), signal);
    if (inspected.status === 'not-found') {
      return result({
        bookId, physicalPage, printedPage, evidenceType: 'unavailable', status: 'not-found', title,
        fromCache: Boolean(inspected.fromCache),
        sourceProvenance: pageSourceProvenance(book, 'none', false, 'page-not-found'),
      });
    }
    const pdfOpened = true;
    const fromCache = Boolean(inspected.fromCache);
    let textSource = hasUsefulText(text) ? 'pdf-index.fullText' : 'none';
    if (inspected.text && (!hasUsefulText(text) || inspected.status !== 'damaged-text')) {
      text = inspected.text;
      // نصّ pdfjs النظيف لا يمحو بيانات المصدر التي وسمت الصفحة تالفة صراحةً:
      // نُبقي التحذير ونُرسل الصورة للقراءة البصرية بدل ترقيتها إلى نصّ موثوق.
      status = sourceTextDamaged ? 'damaged-text' : inspected.status;
      textSource = 'pdf-source.pdfjs';
    }
    const imageDataUrl = inspected.imageDataUrl || '';
    const damaged = status === 'damaged-text';
    const evidenceType = damaged ? 'damaged-text'
      : status === 'ocr-text' ? 'ocr-text'
      : hasUsefulText(text) ? 'pdf-text' : imageDataUrl ? 'pdf-image' : 'no-text';
    const outputText = hasUsefulText(text) ? text : '';
    return result({
      bookId, physicalPage, printedPage, text: outputText, evidenceType, title, imageDataUrl,
      imageError: inspected.imageError,
      pageTextCacheHit: inspected.pageTextCacheHit,
      status: hasUsefulText(text) ? status : 'no-text', pdfOpened, textSource, fromCache,
      sourceProvenance: pageSourceProvenance(book, textSource, pdfOpened, 'opened'),
    });
  } catch (error) {
    // أُلغي العمل: نُعيد الخطأ كي يعرف الطالب أنه إلغاء لا فشل، فلا يُقعّد على
    // نصّ الفهرس كأنه دليلٌ فُتح من الملف الأصلي.
    if (isAbortError(error) || signal?.aborted) throw isAbortError(error) ? error : abortError(signal);
    // الاحتياطي على نصّ الفهرس مشروع، لكن لا بصمت: السبب يُسجَّل (وإن مُرِّر
    // `step` من الخادم أُبلغ به) حتى لا يُظنّ أن ملف الـPDF قد فُتح ونجح.
    const reason = error?.message || String(error);
    if (typeof request.step === 'function') request.step('تعذّر فتح ملف الـPDF الأصلي؛ استُخدم نصّ الفهرس', { reason });
    console.warn('pdf fallback: تعذّر فتح مصدر الصفحة:', reason);
    return indexedTextResult({ ...indexOnly, sourceStatus: 'open-failed', error: reason });
  }
}
