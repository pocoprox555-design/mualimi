// Cached page-level pdf-index search plus exact-page PDF fallback. The search
// index is built once from derivative fullText; opening/rendering a source PDF
// remains restricted to the exact physical page selected by its caller.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  brokenYears,
  cleanText,
  hasTextDamage,
  normalizeAr,
  normalizeDigits,
  searchTokenForms,
  searchTokens,
  uniqueTokens,
} from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_INDEX = path.join(ROOT, 'curriculum-library', 'pdf-index.json');
const SOURCES_DIR = path.join(ROOT, 'curriculum-library', 'pdf-sources');
const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,80}$/i;
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_PIXELS = 1_700_000;
const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;
const OCR_ENGINES = /(?:^|[-+])(?:vision|ocr)(?:$|[-+])|visual-transcription/i;
// «هللا» وحده: لا وجود له في العربية الصحيحة (قلب «الله»). أما «اال» فليس دليل
// تلف بعد إصلاحه عند حد الكلمة (lib/text.mjs: OCR_FIX)، فالإبقاء عليه هنا كان
// يسمّي 963 صفحة سليمة «تالفة».
const DAMAGE_REVERSED = /هللا/u;
// خلط عربي/لاتيني في الموضع الواحد قد يكون سليماً (مصطلح إنكليزي داخل قوس مثل
// «والحقن(Injection») أو شوائب خطّية لعلامة حاشية مثل «„zzzzzËeنh»، فلا يُوسم
// به الصفحة إلا موضعان فأكثر — بموازاة DAMAGE_MIX_MIN في lib/text.mjs. الموضع
// الواحد كان يُسقط صفحات مقروءة بالكامل (39 صفحة، 37 منها >400 حرف).
const DAMAGE_MIXED_WORD = /[\u0600-\u06FF][A-Za-z][\u0600-\u06FF]|[A-Za-z][\u0600-\u06FF][A-Za-z]/gu;
const DAMAGE_MIXED_MIN = 2;
const ENGLISH_QUERY_NOISE = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'for',
  'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'their', 'this',
  'that', 'these', 'those', 'to', 'was', 'were', 'what', 'which', 'who', 'with',
]);

const EVIDENCE_STATUSES = new Set([
  'clean-extracted-text',
  'ocr-text',
  'damaged-text',
  'no-text',
]);

let pdfCatalogPromise;
let pdfSearchIndexPromise;
let pdfRuntimePromise;
let pdfWorkQueue = Promise.resolve();

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
  // `required`, `needed`, `pending` and `no-text` describe work/state, not an
  // OCR result. In the current corpus, completed/visual engines identify the
  // pages whose fullText actually came from OCR; `pdf-text` is not OCR.
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
 * Classify page evidence consistently for search-index, outlines and fallback.
 * OCR provenance is taken from the source page's `ocr` metadata; damaged text
 * takes precedence over provenance, and a folio-only/empty page is `no-text`.
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
    pdfCatalogPromise = readFile(PDF_INDEX, 'utf8')
      .then((raw) => JSON.parse(raw))
      .then((index) => {
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
              ? {
                  engine: rawPage.ocr.engine || null,
                  status: rawPage.ocr.status || null,
                  required: Boolean(rawPage.ocr.required),
                }
              : null;
            pages.set(physicalPage, {
              physicalPage,
              printedPage: positiveInteger(rawPage.printedPage ?? rawPage.printedPageNumber),
              title: cleanText(rawPage.title || ''),
              text: String(rawPage.fullText || ''),
              ocr,
              needsOcr: Boolean(rawPage.needsOcr || rawPage.ocr?.required),
              textDamaged: rawPage.textDamaged === true,
            });
          }
          const source = entry.source || entry.book?.source || {};
          const provenanceName = rawPages.find((page) => page.sourceProvenance?.fileName)?.sourceProvenance?.fileName;
          books.set(entry.id, {
            id: entry.id,
            title: cleanText(entry.title || entry.book?.title || ''),
            subject: cleanText(entry.subject || entry.book?.subject || ''),
            track: cleanText(entry.track || entry.book?.track || entry.branch || entry.book?.branch || ''),
            branch: cleanText(entry.branch || entry.book?.branch || ''),
            supplementary: Boolean(entry.supplementary ?? entry.book?.supplementary),
            pageCount: positiveInteger(entry.pageCount) || pages.size,
            source: {
              fileName: source.fileName || provenanceName || '',
              bytes: Number(source.bytes) || null,
              checksum: source.checksum || null,
            },
            pages,
          });
        }
        return books;
      })
      .catch((error) => {
        pdfCatalogPromise = undefined;
        throw error;
      });
  }
  return pdfCatalogPromise;
}

function buildPdfSearchIndex(books) {
  const pages = [];
  const postings = new Map();
  for (const book of books.values()) {
    for (const page of book.pages.values()) {
      const terms = new Set(searchTokens(page.text));
      if (!terms.size) continue;
      const pageId = pages.push({ book, page }) - 1;
      for (const term of terms) {
        if (!postings.has(term)) postings.set(term, []);
        postings.get(term).push(pageId);
      }
    }
  }
  return { books: [...books.values()], pages, postings };
}

async function loadPdfSearchIndex() {
  if (!pdfSearchIndexPromise) {
    pdfSearchIndexPromise = loadPdfCatalog()
      .then(buildPdfSearchIndex)
      .catch((error) => {
        pdfSearchIndexPromise = undefined;
        throw error;
      });
  }
  return pdfSearchIndexPromise;
}

function allowedSearchBook(book, { track = '', subject = '', bookId = '' } = {}) {
  if (bookId && book.id !== bookId) return false;
  const wantedTrack = normalizeAr(track);
  const bookTrack = normalizeAr(book.track || book.branch || '');
  // A requested track is a hard boundary. Missing/mismatched metadata is not
  // allowed to fall through into another track.
  if (wantedTrack && (!bookTrack || bookTrack !== wantedTrack)) return false;
  if (wantedTrack === normalizeAr('ديني') && book.supplementary) return false;
  const wantedSubject = normalizeAr(subject);
  return !wantedSubject || normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject);
}

/**
 * Search page-level `fullText` candidates from the cached pdf-index.json.
 * Stable API: `searchPdfPages(query, { track, subject, bookId, limit })`
 * returns candidates with `{ bookId, title, subject, track, physicalPage,
 * printedPage, pageNumber, printedPageNumber, source, pageTitle, sourcePage,
 * forceSource, matchedTerms, coverage, score, evidenceStatus, needsOcr,
 * textSource, pdfOpened, visualVerified }`.
 * `sourcePage` is `{ physicalPage, printedPage, pageNumber,
 * printedPageNumber, title, evidenceStatus, needsOcr, textDamaged }` from the
 * pdf-index mapping (it omits fullText); the physical/printed folios are
 * repeated at top level for direct use with
 * `readPdfPage({ bookId, physicalPage, printedPage, forceSource })`.
 *
 * This is a fallback locator only: `pdf-index.fullText` is derivative
 * extraction/OCR evidence and does not prove that the visual page is correct.
 * Call only after search-index retrieval has no reliable local evidence, then
 * call `readPdfPage` for selected candidates before presenting page text.
 */
export async function searchPdfPages(query, { track = '', subject = '', bookId = '', limit = 5 } = {}) {
  const text = cleanText(String(query || '')).slice(0, 400);
  const queryTerms = uniqueTokens(text).filter((term) => !ENGLISH_QUERY_NOISE.has(term)).slice(0, 32);
  if (!queryTerms.length) return [];

  const index = await loadPdfSearchIndex();
  const candidates = new Map();
  const eligibleBooks = new Set();
  const requestedBookId = String(bookId || '').trim();
  for (const book of index.books) {
    if (allowedSearchBook(book, { track, subject, bookId: requestedBookId })) eligibleBooks.add(book.id);
  }
  if (requestedBookId && !eligibleBooks.has(requestedBookId)) return [];

  const queryStats = [];
  for (const queryTerm of queryTerms) {
    const pageIds = new Set();
    for (const form of searchTokenForms(queryTerm)) {
      for (const pageId of index.postings.get(form) || []) pageIds.add(pageId);
    }
    const idf = Math.log(1 + (index.pages.length - pageIds.size + 0.5) / (pageIds.size + 0.5));
    const weight = idf * (queryTerm.length >= 4 ? 1.25 : 0.8);
    queryStats.push({ queryTerm, pageIds, idf, weight });
  }

  for (const { queryTerm, pageIds, weight } of queryStats) {
    for (const pageId of pageIds) {
      const entry = index.pages[pageId];
      if (!eligibleBooks.has(entry.book.id)) continue;
      let candidate = candidates.get(pageId);
      if (!candidate) {
        candidate = { entry, matchedTerms: [], matchedWeight: 0 };
        candidates.set(pageId, candidate);
      }
      candidate.matchedTerms.push(queryTerm);
      candidate.matchedWeight += weight;
    }
  }

  const maxResults = Math.max(1, Math.min(24, Math.floor(Number(limit) || 5)));
  const totalWeight = queryStats.reduce((sum, item) => sum + item.weight, 0);
  const expectedTerms = queryStats.length;
  return [...candidates.values()]
    .map(({ entry, matchedTerms, matchedWeight }) => {
      const coverage = expectedTerms ? matchedTerms.length / expectedTerms : 0;
      const weightedCoverage = totalWeight ? matchedWeight / totalWeight : 0;
      const onlyTerm = expectedTerms === 1 ? queryStats[0] : null;
      const informative = matchedTerms.length >= 3
        || (matchedTerms.length >= 2 && coverage >= 0.75 && matchedWeight >= 6)
        || (onlyTerm && onlyTerm.idf >= 3.2);
      if (!informative) return null;
      const { book, page } = entry;
      const evidenceStatus = classifyPageEvidence(page.text, page);
      const sourcePage = {
        physicalPage: page.physicalPage,
        printedPage: page.printedPage,
        pageNumber: page.physicalPage,
        printedPageNumber: page.printedPage,
        title: page.title,
        evidenceStatus,
        needsOcr: page.needsOcr,
        textDamaged: page.textDamaged,
      };
      return {
        score: Number((matchedWeight + weightedCoverage * 2).toFixed(3)),
        bookId: book.id,
        title: book.title || book.id,
        subject: book.subject,
        track: book.track || book.branch || 'عام',
        physicalPage: page.physicalPage,
        printedPage: page.printedPage,
        // Keep the locator directly consumable by backend aliases and
        // `readPdfPage(candidate)`; the page number is always physical.
        pageNumber: page.physicalPage,
        printedPageNumber: page.printedPage,
        source: { ...book.source },
        pageTitle: page.title,
        coverage: Number(coverage.toFixed(3)),
        sourcePage,
        matchedTerms,
        evidenceStatus,
        needsOcr: page.needsOcr,
        textSource: 'pdf-index.fullText',
        pdfOpened: false,
        visualVerified: false,
        forceSource: true,
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

/** Return compact source evidence metadata without opening a PDF. */
export async function getPdfPageEvidence(bookId, physicalPage) {
  const number = positiveInteger(physicalPage);
  if (number == null) return null;
  try {
    const book = await getBook(bookId);
    const page = book?.pages.get(number);
    if (!page) return null;
    return {
      evidenceStatus: classifyPageEvidence(page.text, page),
      printedPage: page.printedPage,
      title: page.title,
      needsOcr: page.needsOcr,
      ocr: page.ocr,
      textDamaged: page.textDamaged,
      textSource: 'pdf-index.fullText',
      pdfOpened: false,
    };
  } catch {
    return null;
  }
}

function result({
  bookId,
  physicalPage = null,
  printedPage = null,
  text = '',
  evidenceType = 'unavailable',
  status = 'unavailable',
  title = '',
  imageDataUrl = '',
  pdfOpened = false,
  textSource = 'none',
  sourceProvenance = null,
}) {
  const page = {
    bookId: String(bookId || ''),
    physicalPage,
    printedPage,
    text,
    evidenceType,
    status,
    title: cleanText(title || ''),
    pdfOpened: Boolean(pdfOpened),
    textSource,
    sourceProvenance: sourceProvenance || { textSource, pdfOpened: Boolean(pdfOpened) },
    visualVerified: false,
  };
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
      if (canvasAndContext.canvas) {
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
      }
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
        // Text extraction can still succeed when the optional native canvas is unavailable.
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

// تحميل pdfjs والـcanvas أول مرة يكلّف ثوانٍ، فيقع كلها على أول طالب يطلب
// صفحة. التسخين بعد الإقلاع ينقلها من زمن الطالب إلى زمن الخادم الخامل.
export async function warmPdfRuntime() {
  try {
    await loadPdfRuntime();
    return true;
  } catch (error) {
    console.warn('pdf runtime warmup skipped:', error?.message || error);
    return false;
  }
}

function extractText(content) {
  let output = '';
  for (const item of content?.items || []) {
    const value = String(item?.str || '').replace(/[\t ]+/g, ' ').trim();
    if (!value) continue;
    if (output && !/[\s\n]$/.test(output)) output += ' ';
    output += value;
    output += item.hasEOL ? '\n' : ' ';
  }
  return cleanText(output);
}

async function renderPageImage(page, canvasApi, canvasFactory) {
  if (!canvasApi || !canvasFactory) return '';
  const unscaled = page.getViewport({ scale: 1 });
  const pixelRatio = Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, unscaled.width * unscaled.height));
  let scale = Math.min(1.6, pixelRatio);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const viewport = page.getViewport({ scale });
    const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
    try {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
      const jpg = Buffer.from(await canvas.encode('jpeg', 82));
      const dataUrl = `data:image/jpeg;base64,${jpg.toString('base64')}`;
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) return dataUrl;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    scale *= 0.72;
  }
  return '';
}

async function inspectPdfPage(filePath, physicalPage, { renderForVerification = false } = {}) {
  const pageNumber = positiveInteger(physicalPage);
  if (pageNumber == null) throw new Error('PDF_PHYSICAL_PAGE_INVALID');
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PDF_BYTES) throw new Error('PDF_SOURCE_SIZE_UNSUPPORTED');
  const buffer = await readFile(filePath);
  // pdfjs-dist rejects Node Buffer explicitly even though it subclasses Uint8Array.
  // A view keeps the PDF load bounded without copying up to 90 MB student-book PDFs.
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { pdfjs, canvasApi } = await loadPdfRuntime();
  const canvasFactory = canvasApi ? createCanvasFactory(canvasApi) : null;
  const document = await pdfjs.getDocument({
    data,
    ...(canvasFactory ? { canvasFactory } : {}),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    if (pageNumber > document.numPages) return { status: 'not-found', text: '', imageDataUrl: '' };
    // Fetch and render only the requested 1-indexed physical page; never walk
    // the document's other pages as part of exact-page fallback.
    const page = await document.getPage(pageNumber);
    const text = extractText(await page.getTextContent());
    let imageDataUrl = '';
    if (renderForVerification || !hasUsefulText(text) || classifyPageEvidence(text) === 'damaged-text') {
      try {
        imageDataUrl = await renderPageImage(page, canvasApi, canvasFactory);
      } catch {
        // Keep source-page extraction usable if the optional renderer fails.
      }
    }
    return { status: classifyPageEvidence(text), text, imageDataUrl };
  } finally {
    await document.destroy().catch(() => {});
  }
}

function serializePdfWork(task) {
  const work = pdfWorkQueue.then(task, task);
  pdfWorkQueue = work.then(() => undefined, () => undefined);
  return work;
}

function pageTitle(book, page, physicalPage) {
  return page?.title || book?.title || `صفحة PDF ${physicalPage}`;
}

function pageSourceProvenance(book, textSource, pdfOpened, sourceStatus) {
  return {
    fileName: book?.source?.fileName || null,
    bytes: book?.source?.bytes ?? null,
    checksum: book?.source?.checksum || null,
    sourceStatus,
    textSource,
    pdfOpened: Boolean(pdfOpened),
  };
}

function indexedTextResult({ book, bookId, physicalPage, printedPage, title, page, text, sourceStatus }) {
  const useful = hasUsefulText(text);
  const status = classifyPageEvidence(text, page || {});
  const textSource = useful ? 'pdf-index.fullText' : 'none';
  const evidenceType = !useful
    ? 'unavailable'
    : status === 'damaged-text'
      ? 'damaged-text'
      : status === 'ocr-text' ? 'ocr-text' : 'pdf-text';
  return result({
    bookId,
    physicalPage,
    printedPage,
    text: useful ? text : '',
    evidenceType,
    status: useful ? status : 'unavailable',
    title,
    pdfOpened: false,
    textSource,
    sourceProvenance: pageSourceProvenance(book, textSource, false, sourceStatus),
  });
}

/**
 * Resolve one exact physical page. Source verification is on by default for
 * this fallback reader; set `forceSource: false` to allow a clean
 * `pdf-index.fullText` result without opening the source PDF. `pdfOpened`,
 * `textSource`, and `sourceProvenance` distinguish the two origins.
 *
 * Stable API: `readPdfPage(bookId, physicalPage, { forceSource })` returns
 * `{ bookId, physicalPage, printedPage, text, imageDataUrl?, evidenceType,
 * status, title, pdfOpened, textSource, sourceProvenance, visualVerified }`.
 * The backend's object form `{ bookId, physicalPage, printedPage, forceSource }` is also
 * accepted; when only `printedPage` is supplied it must resolve uniquely.
 * Successful `status` values are `clean-extracted-text`, `ocr-text`,
 * `damaged-text`, and `no-text`; `not-found`/`unavailable` are operational
 * outcomes. `pdfOpened` is true only when the requested page was read from the
 * source PDF; a `pdf-index.fullText` result has `pdfOpened: false` and is not
 * visual verification. `forceSource` opens the source and attempts to render
 * only the requested physical page, within the source and image-size limits.
 */
export async function readPdfPage(bookOrRequest, requestedPhysicalPage, options = {}) {
  const request = bookOrRequest && typeof bookOrRequest === 'object'
    ? bookOrRequest
    : { ...options, bookId: bookOrRequest, physicalPage: requestedPhysicalPage };
  const bookId = String(request.bookId || '');
  let physicalPage = positiveInteger(request.physicalPage);
  const requestedPrintedPage = positiveInteger(request.printedPage);
  const forceSource = request.forceSource !== false;
  if (!SAFE_ID.test(bookId)) {
    return result({ bookId, physicalPage, printedPage: requestedPrintedPage, evidenceType: 'unavailable', status: 'not-found' });
  }

  let book;
  try { book = await getBook(bookId); } catch {
    return result({ bookId, physicalPage, printedPage: requestedPrintedPage, evidenceType: 'unavailable', status: 'unavailable' });
  }
  if (!book) return result({ bookId, physicalPage, printedPage: requestedPrintedPage, evidenceType: 'unavailable', status: 'not-found' });

  if (physicalPage == null && requestedPrintedPage != null) {
    const matches = [...book.pages.values()].filter((page) => page.printedPage === requestedPrintedPage);
    if (matches.length !== 1) {
      return result({ bookId, printedPage: requestedPrintedPage, evidenceType: 'unavailable', status: 'not-found', title: book.title });
    }
    physicalPage = matches[0].physicalPage;
  }
  if (physicalPage == null || physicalPage > book.pageCount) {
    return result({ bookId, physicalPage, printedPage: requestedPrintedPage, evidenceType: 'unavailable', status: 'not-found', title: book.title });
  }

  const page = book.pages.get(physicalPage) || null;
  const printedPage = page?.printedPage ?? requestedPrintedPage ?? null;
  const title = pageTitle(book, page, physicalPage);
  let text = cleanText(page?.text || '');
  let status = classifyPageEvidence(text, page || {});
  const sourceTextDamaged = Boolean(page?.textDamaged || status === 'damaged-text');
  if (hasUsefulText(text) && status !== 'damaged-text' && !forceSource) {
    return indexedTextResult({
      book, bookId, physicalPage, printedPage, title, page, text,
      sourceStatus: 'not-attempted',
    });
  }

  const filePath = sourcePath(book.source.fileName);
  if (!filePath) {
    return indexedTextResult({
      book, bookId, physicalPage, printedPage, title, page, text,
      sourceStatus: 'unavailable',
    });
  }

  try {
    const inspected = await serializePdfWork(() => inspectPdfPage(filePath, physicalPage, {
      renderForVerification: forceSource || sourceTextDamaged,
    }));
    if (inspected.status === 'not-found') {
      return result({
        bookId, physicalPage, printedPage, evidenceType: 'unavailable', status: 'not-found', title,
        sourceProvenance: pageSourceProvenance(book, 'none', false, 'page-not-found'),
      });
    }
    const pdfOpened = true;
    let textSource = hasUsefulText(text) ? 'pdf-index.fullText' : 'none';
    if (inspected.text && (!hasUsefulText(text) || inspected.status !== 'damaged-text')) {
      text = inspected.text;
      // A cleaned PDF.js string must not erase source metadata that explicitly
      // marked this page's text damaged. Keep the warning and provide the page
      // image for visual verification instead of promoting it to reliable text.
      status = sourceTextDamaged ? 'damaged-text' : inspected.status;
      textSource = 'pdf-source.pdfjs';
    }
    const imageDataUrl = inspected.imageDataUrl || '';
    const evidenceType = status === 'damaged-text'
      ? 'damaged-text'
      : status === 'ocr-text'
        ? 'ocr-text'
        : hasUsefulText(text)
          ? 'pdf-text'
          : imageDataUrl ? 'pdf-image' : 'no-text';
    const outputText = hasUsefulText(text) ? text : '';
    return result({
      bookId,
      physicalPage,
      printedPage,
      text: outputText,
      evidenceType,
      status: hasUsefulText(text) ? status : 'no-text',
      title,
      imageDataUrl,
      pdfOpened,
      textSource,
      sourceProvenance: pageSourceProvenance(book, textSource, pdfOpened, 'opened'),
    });
  } catch {
    return indexedTextResult({
      book, bookId, physicalPage, printedPage, title, page, text,
      sourceStatus: 'open-failed',
    });
  }
}
