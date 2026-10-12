// Curriculum access only: cached source text, stored metadata and unranked discovery.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTextDamage } from './text.mjs';
import { readStoredPage, listStoredBooks } from './pdf-fallback.mjs';
export { searchPdfPages } from './pdf-fallback.mjs';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../curriculum-library');
const SHARDS = path.join(LIBRARY, 'shards');
const readJson = (file) => readFile(file, 'utf8').then(JSON.parse);
const fold = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ـ/g, '');
const fieldsOf = ['title', 'summary', 'unit', 'section', 'outlineSummary', 'purpose', 'glossary', 'glossaryRefs', 'vocabulary', 'figures', 'activities', 'exercises', 'notes'];
let scanPromise;
let searchPromise;
const shardCache = new Map();

async function recordsOf(shard) {
  if (!shardCache.has(shard)) {
    shardCache.set(shard, readJson(path.join(SHARDS, 'docs', `shard-${String(shard).padStart(4, '0')}.json`)).catch((error) => {
      shardCache.delete(shard);
      throw error;
    }));
    while (shardCache.size > 6) shardCache.delete(shardCache.keys().next().value);
  }
  return shardCache.get(shard);
}

export function getScanIndex() {
  if (!scanPromise) scanPromise = (async () => {
    let catalog, meta, docAt;
    try {
      [catalog, meta] = await Promise.all([readJson(path.join(SHARDS, 'catalog.json')), readJson(path.join(SHARDS, 'meta.json'))]);
      if (!Array.isArray(catalog.books) || !Array.isArray(meta)) throw new Error('SHARDS_INCOMPLETE');
      docAt = async (position) => {
        const entry = meta[position];
        return entry ? (await recordsOf(entry.shard))[entry.offset] : null;
      };
    } catch (error) {
      console.warn('index metadata fallback:', error.message);
      catalog = await readJson(path.join(LIBRARY, 'search-index.json'));
      if (!Array.isArray(catalog.books) || !Array.isArray(catalog.documents)) throw new Error('CURRICULUM_INDEX_INVALID');
      meta = catalog.documents;
      docAt = async (position) => meta[position] ?? null;
    }
    const sources = new Map((await listStoredBooks()).map((book) => [book.id, book]));
    const books = catalog.books.map((book) => ({ ...book, source: sources.get(book.id)?.source || null }));
    return { schemaVersion: catalog.schemaVersion, builtAt: catalog.builtAt, stats: catalog.stats, books,
      booksById: new Map(books.map((book) => [book.id, book])), meta, docCount: meta.length, docAt,
      sharded: !catalog.documents, docIndexByBookPage: new Map(meta.map((entry, i) => [`${entry.bookId}:${entry.physicalPage}`, i])) };
  })().catch((error) => { scanPromise = undefined; throw error; });
  return scanPromise;
}

function allowed(book, { subject = '', track = '' } = {}) {
  return (!subject || fold(`${book.subject} ${book.title}`).includes(fold(subject)))
    && (!track || fold(book.track || book.branch || 'عام') === fold(track));
}

export async function listBooks(options = {}) {
  return (await getScanIndex()).books.filter((book) => allowed(book, options));
}
export async function getSubjects() {
  return [...new Set((await listBooks()).map((book) => book.subject).filter(Boolean))].sort();
}
export async function getCatalog(options = {}) {
  const books = await listBooks(options);
  return { books, subjects: [...new Set(books.map((book) => book.subject))], pages: books.reduce((n, book) => n + book.pageCount, 0),
    searchablePages: books.reduce((n, book) => n + (book.searchablePageCount || 0), 0) };
}
export async function getBookPages(bookId) {
  const index = await getScanIndex();
  return Promise.all(index.meta.filter((entry) => entry.bookId === bookId).map(async (entry) => {
    const page = await readStoredPage(bookId, entry.physicalPage);
    return { bookId, physicalPage: page.physicalPage, printedPage: page.printedPage,
      printedPageSource: page.printedPageSource ?? page.pageMappingSource ?? 'unverified-stored-mapping',
      title: page.title, pageType: page.pageType, evidenceStatus: page.evidenceStatus, searchable: page.searchable };
  }));
}
export async function locate(bookId, printedNumber) {
  const matches = (await getBookPages(bookId)).filter((page) => page.printedPage === Number(printedNumber));
  return matches.length === 1 ? matches[0].physicalPage : null;
}
export async function resolveBook(query = '', options = {}) {
  const matches = (await listBooks(options)).filter((book) => fold(query) === fold(book.title) || fold(query) === fold(book.subject));
  return matches.length === 1 ? matches[0] : null;
}

export async function fullPage(bookId, physicalPage) {
  const index = await getScanIndex();
  const position = index.docIndexByBookPage.get(`${bookId}:${Number(physicalPage)}`);
  if (position == null) throw Object.assign(new Error('PAGE_NOT_FOUND'), { code: 'PAGE_NOT_FOUND' });
  const [doc, stored] = await Promise.all([index.docAt(position), readStoredPage(bookId, physicalPage)]);
  if (!doc) throw Object.assign(new Error('PAGE_RECORD_MISSING'), { code: 'PAGE_RECORD_MISSING' });
  const { text: indexedText, ...metadata } = doc;
  return { ...metadata, ...stored, outlineSummary: doc.outlineSummary || '',
    indexedTextDiffers: indexedText !== stored.text,
    indexedTextNotice: 'text هو fullText المخزّن دون تغيير وقت التشغيل. نسخة البحث مشتقة وقد تختلف؛ لا تُستخدم بدلاً منه.',
    neighbors: { previous: physicalPage > 1 ? physicalPage - 1 : null, next: physicalPage < index.booksById.get(bookId).pageCount ? physicalPage + 1 : null } };
}

async function searchView() {
  if (!searchPromise) searchPromise = (async () => {
    const index = await getScanIndex();
    const pages = [];
    for (const entry of index.meta) {
      const page = await fullPage(entry.bookId, entry.physicalPage);
      const fields = { text: fold(page.text) };
      for (const key of fieldsOf) if (page[key] != null) fields[key] = fold(typeof page[key] === 'string' ? page[key] : JSON.stringify(page[key]));
      pages.push({ bookId: entry.bookId, physicalPage: entry.physicalPage, fields });
    }
    return pages;
  })().catch((error) => { searchPromise = undefined; throw error; });
  return searchPromise;
}
export async function warmSearch() { await searchView(); }

export async function searchCandidates(query, { bookId = '', subject = '', track = '', offset = 0, limit = 8, match = 'any' } = {}) {
  const index = await getScanIndex();
  const words = match === 'phrase' ? [fold(query)] : fold(query).split(/\s+/).filter(Boolean);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const count = Math.max(1, Math.floor(Number(limit) || 8));
  const candidates = [];
  if (words.length && words[0]) for (const page of await searchView()) {
    const book = index.booksById.get(page.bookId);
    if (!book || (bookId && page.bookId !== bookId) || !allowed(book, { subject, track })) continue;
    const matches = words.map((word) => Object.keys(page.fields).filter((key) => page.fields[key].includes(word)));
    if (match === 'all' ? matches.some((fields) => !fields.length) : matches.every((fields) => !fields.length)) continue;
    candidates.push({ bookId: page.bookId, physicalPage: page.physicalPage,
      matchedTerms: words.filter((_, i) => matches[i].length), matchedIn: [...new Set(matches.flat())] });
  }
  candidates.sort((a, b) => a.bookId.localeCompare(b.bookId) || a.physicalPage - b.physicalPage);
  const results = await Promise.all(candidates.slice(start, start + count).map(async (entry) => ({
    ...await fullPage(entry.bookId, entry.physicalPage), matchedTerms: entry.matchedTerms, matchedIn: entry.matchedIn,
  })));
  return { query: String(query ?? ''), match, terms: words,
    normalization: 'NFKC/lowercase/Arabic vowels and hamza folding; substring matching; no spelling repair, stopwords or stemming',
    total: candidates.length, offset: start, limit: count, nextOffset: start + results.length < candidates.length ? start + results.length : null, results };
}
export async function search(query, options) { return (await searchCandidates(query, options)).results; }
export async function retrieveContext(query, options = {}) {
  const result = await searchCandidates(query, options);
  return { sources: result.results, block: JSON.stringify(result), trace: { total: result.total, offset: result.offset, nextOffset: result.nextOffset } };
}

export async function getHealth() {
  const index = await getScanIndex();
  const statuses = Object.fromEntries(['clean-extracted-text', 'ocr-text', 'damaged-text', 'no-text'].map((status) => [status, 0]));
  for (const page of index.meta) if (page.evidenceStatus in statuses) statuses[page.evidenceStatus] += 1;
  return { ...index.stats, schemaVersion: index.schemaVersion, builtAt: index.builtAt, books: index.books.length, pages: index.docCount,
    indexedPages: index.docCount, searchablePages: index.meta.filter((page) => page.searchable).length,
    visionPages: index.meta.filter((page) => page.needsOcr).length,
    printedPageGaps: index.meta.filter((page) => page.printedPage == null).length,
    evidenceStatuses: statuses, sharded: index.sharded,
    statusNotice: 'الحالات والإحصاءات المخزّنة تخص نسخة الفهرس المشتقة، وليست تحققاً بصرياً من PDF.' };
}
export async function assertIndexFresh() {
  let manifest;
  try { manifest = await readJson(path.join(SHARDS, 'manifest.json')); }
  catch { return { ok: null, checked: false, reason: 'SOURCE_MANIFEST_UNAVAILABLE' }; }
  const stale = [], unknown = [];
  for (const [bookId, size, mtime, fileName] of manifest.sources || []) {
    if (!fileName) { unknown.push(bookId); continue; }
    const info = await stat(path.join(LIBRARY, 'pdf-sources', fileName)).catch(() => null);
    if (!info || info.size !== Number(size) || info.mtimeMs.toFixed(0) !== String(mtime)) stale.push(bookId);
  }
  return { ok: stale.length ? false : unknown.length ? null : true, checked: unknown.length === 0, stale, unknown };
}
// Diagnostic exports used by existing scripts; never select or rewrite model evidence.
export function assessText(value) {
  const text = String(value ?? '');
  const damaged = hasTextDamage(text);
  return { text, damaged, rate: damaged ? 1 : 0, reasons: damaged ? ['علامات تلف في النص المستخرج'] : [], empty: !text.trim() };
}
export function usableOutlineSummary(value) { return String(value ?? ''); }
export async function getIndex() {
  const raw = await readJson(path.join(LIBRARY, 'search-index.json'));
  const postings = new Map();
  for (const [i, doc] of raw.documents.entries()) for (const term of new Set(doc.terms || [])) {
    if (!postings.has(term)) postings.set(term, []);
    postings.get(term).push(i);
  }
  return { ...raw, postings, documentFrequency: new Map(Object.entries(raw.documentFrequency || {})) };
}
