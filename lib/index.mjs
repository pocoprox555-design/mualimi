// محرك المعرفة: فهرس مقلوب في الذاكرة + تحميل كسول للنص الكامل.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, pageReference, uniqueTokens } from './text.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_ROOT = path.join(PROJECT_ROOT, 'curriculum-library');
const SEARCH_INDEX = path.join(LIBRARY_ROOT, 'search-index.json');
const BOOKS_DIR = path.join(LIBRARY_ROOT, 'pdf-books');

let indexPromise;
let booksCache;
const bookDocuments = new Map();

const ALIASES = [
  ['عربي', ['اللغه العربيه', 'قواعد', 'ادب']],
  ['العربيه', ['عربي', 'قواعد', 'ادب']],
  ['انكليزي', ['الانكليزيه', 'الانجليزيه', 'english']],
  ['انجليزي', ['الانكليزيه', 'الانجليزيه', 'english']],
  ['جغرافيا', ['الجغرافيه']],
  ['اسلاميات', ['التربيه الاسلاميه', 'القران']],
  ['تاريخ', ['التاريخ']],
  ['رياضيات', ['الرياضيات']],
];

function prepare(raw) {
  if (!raw || raw.schemaVersion !== 3 || !Array.isArray(raw.documents) || !Array.isArray(raw.books)) {
    throw new Error('CURRICULUM_INDEX_INVALID');
  }
  const books = raw.books;
  const booksById = new Map(books.map((book) => [book.id, book]));
  const postings = new Map(Object.entries(raw.postings || {}).map(([term, ids]) => [term, ids]));
  const printed = new Map();
  for (const [bookId, pages] of Object.entries(raw.printed || {})) {
    printed.set(bookId, new Map(Object.entries(pages).map(([number, physical]) => [Number(number), Number(physical)])));
  }
  const docsByBookPage = new Map(raw.documents.map((doc, id) => [`${doc.bookId}:${doc.physicalPage}`, id]));
  return { ...raw, books, booksById, postings, printed, docsByBookPage };
}

export async function getIndex() {
  if (!indexPromise) {
    indexPromise = readFile(SEARCH_INDEX, 'utf8')
      .then((content) => prepare(JSON.parse(content)))
      .catch((error) => {
        indexPromise = undefined;
        throw error;
      });
  }
  return indexPromise;
}

export async function getHealth() {
  const index = await getIndex();
  return {
    schemaVersion: index.schemaVersion,
    builtAt: index.builtAt,
    books: index.stats?.books || index.books.length,
    pages: index.stats?.pages || index.documents.length,
    indexedPages: index.stats?.indexedPages || index.documents.length,
    terms: index.stats?.terms || index.postings.size,
  };
}

export async function listBooks({ branch = '', subject = '' } = {}) {
  const index = await getIndex();
  const wantedBranch = normalizeAr(branch);
  const wantedSubject = normalizeAr(subject);
  return index.books.filter((book) => {
    const branchOk = !wantedBranch || wantedBranch === 'عام' || normalizeAr(book.branch) === wantedBranch || normalizeAr(book.branch) === 'عام';
    const subjectOk = !wantedSubject || normalizeAr(book.subject).includes(wantedSubject) || normalizeAr(book.title).includes(wantedSubject);
    return branchOk && subjectOk;
  });
}

export async function getSubjects() {
  const index = await getIndex();
  return [...new Set(index.books.map((book) => book.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
}

function expandedTerms(query) {
  const normalized = normalizeAr(query);
  const terms = new Set(uniqueTokens(query));
  for (const [needle, aliases] of ALIASES) {
    if (normalized.includes(needle)) {
      for (const alias of aliases) for (const token of uniqueTokens(alias)) terms.add(token);
    }
  }
  return [...terms];
}

function guessedBook(index, query, requestedBookId) {
  if (requestedBookId && index.booksById.has(requestedBookId)) return requestedBookId;
  const normalizedQuery = normalizeAr(query);
  let best = null;
  for (const book of index.books) {
    const words = uniqueTokens(`${book.title} ${book.subject}`);
    const overlap = words.reduce((score, word) => score + (normalizedQuery.includes(word) ? 1 : 0), 0);
    if (overlap && (!best || overlap > best.score)) best = { id: book.id, score: overlap };
  }
  return best?.id || null;
}

function allowedBook(book, { branch = '', subject = '' } = {}) {
  const wantedBranch = normalizeAr(branch);
  const wantedSubject = normalizeAr(subject);
  if (wantedBranch && wantedBranch !== 'عام' && normalizeAr(book.branch) !== wantedBranch && normalizeAr(book.branch) !== 'عام') return false;
  if (wantedSubject && !normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject)) return false;
  return true;
}

function resultFor(index, doc, score) {
  const book = index.booksById.get(doc.bookId);
  return {
    score: Number(score.toFixed(3)),
    id: doc.id,
    bookId: doc.bookId,
    title: book?.title || doc.bookId,
    subject: book?.subject || '',
    branch: book?.branch || 'عام',
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage,
    pageTitle: doc.title,
    section: doc.section || '',
    unit: doc.unit || '',
    summary: doc.summary,
    preview: doc.preview,
    searchable: doc.searchable,
    needsOcr: doc.needsOcr,
  };
}

// بحث BM25 مبسط: لا يمر على كل الصفحات، بل يبدأ من postings الكلمات الموجودة في السؤال.
export async function search(query, { bookId = '', subject = '', branch = '', limit = 8 } = {}) {
  const index = await getIndex();
  const text = cleanText(query).slice(0, 400);
  const normalized = normalizeAr(text);
  const terms = expandedTerms(text);
  const requestedBook = guessedBook(index, text, bookId);
  const referencePage = pageReference(text);
  const candidates = new Set();

  for (const term of terms) {
    for (const id of index.postings.get(term) || []) candidates.add(id);
  }
  if (referencePage && requestedBook) {
    const physical = index.printed.get(requestedBook)?.get(referencePage) ?? referencePage;
    const direct = index.docsByBookPage.get(`${requestedBook}:${physical}`);
    if (direct != null) candidates.add(direct);
  }
  if (!candidates.size) return [];

  const total = index.documents.length;
  const maxResults = Math.max(1, Math.min(12, Number(limit) || 8));
  const ranked = [];
  for (const id of candidates) {
    const doc = index.documents[id];
    const book = index.booksById.get(doc.bookId);
    if (!doc || !book || !allowedBook(book, { branch, subject })) continue;
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (!doc.terms?.includes(term)) continue;
      matched += 1;
      const df = Number(index.documentFrequency?.[term] || 1);
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (term.length >= 4 ? 1.25 : 0.8);
    }
    if (!matched && !(referencePage && doc.bookId === requestedBook)) continue;
    if (normalized.length > 5 && doc.normalized.includes(normalized)) score += 8;
    const titleNorm = normalizeAr(`${doc.title} ${doc.section || ''} ${doc.unit || ''}`);
    const titleMatches = terms.reduce((count, term) => count + (titleNorm.includes(term) ? 1 : 0), 0);
    score += titleMatches * 2.4;
    if (requestedBook === doc.bookId) score += 1.5;
    if (referencePage && doc.bookId === requestedBook && (doc.printedPage === referencePage || doc.physicalPage === referencePage)) score += 30;
    if (doc.searchable) score += 0.6;
    if (doc.needsOcr) score -= 0.25;
    ranked.push({ doc, score });
  }
  return ranked
    .sort((a, b) => b.score - a.score || a.doc.physicalPage - b.doc.physicalPage)
    .slice(0, maxResults)
    .map(({ doc, score }) => resultFor(index, doc, score));
}

export async function locate(bookId, printedNumber) {
  const index = await getIndex();
  const number = Number(printedNumber);
  if (!Number.isInteger(number)) return null;
  return index.printed.get(bookId)?.get(number) ?? null;
}

async function loadBook(bookId) {
  if (bookDocuments.has(bookId)) return bookDocuments.get(bookId);
  const filename = path.join(BOOKS_DIR, `${bookId}.json`);
  const book = JSON.parse(await readFile(filename, 'utf8'));
  const pages = new Map((book.pages || []).map((page) => [Number(page.physicalPage ?? page.pageNumber), page]));
  const value = { book, pages };
  bookDocuments.set(bookId, value);
  while (bookDocuments.size > 4) bookDocuments.delete(bookDocuments.keys().next().value);
  return value;
}

export async function fullPage(bookId, physicalPage) {
  const index = await getIndex();
  const number = Number(physicalPage);
  if (!index.booksById.has(bookId) || !Number.isInteger(number)) throw new Error('PAGE_NOT_FOUND');
  const { pages } = await loadBook(bookId);
  const page = pages.get(number);
  if (!page) throw new Error('PAGE_NOT_FOUND');
  const docId = index.docsByBookPage.get(`${bookId}:${number}`);
  const indexed = docId == null ? null : index.documents[docId];
  const text = cleanText(page.fullText || '');
  return {
    bookId,
    physicalPage: number,
    printedPage: page.printedPage ?? page.printedPageNumber ?? indexed?.printedPage ?? null,
    title: cleanText(page.title || indexed?.title || ''),
    section: cleanText(page.section || indexed?.section || ''),
    unit: cleanText(page.unit || indexed?.unit || ''),
    summary: compact(page.summary || indexed?.summary || '', 500),
    text: text || compact(page.summary || indexed?.summary || 'هذه الصفحة مصورة ولا يتوفر لها نص قابل للاستخراج.', 4_000),
    searchable: Boolean(text),
    needsVision: !text || Boolean(page.needsOcr || page.ocr?.required),
  };
}

export async function retrieveContext(query, options = {}) {
  const hits = await search(query, { ...options, limit: options.limit || 7 });
  const sources = [];
  const blocks = [];
  for (const hit of hits) {
    if (sources.length >= 6) break;
    let page;
    try { page = await fullPage(hit.bookId, hit.physicalPage); } catch { page = null; }
    const content = compact(page?.text || `${hit.pageTitle}\n${hit.summary}\n${hit.preview}`, 2_400);
    if (!content) continue;
    const id = `S${sources.length + 1}`;
    const source = {
      id,
      bookId: hit.bookId,
      title: hit.title,
      subject: hit.subject,
      physicalPage: hit.physicalPage,
      printedPage: hit.printedPage,
      pageTitle: hit.pageTitle,
      section: hit.section,
      summary: hit.summary,
      preview: hit.preview,
      searchable: page?.searchable ?? hit.searchable,
      needsOcr: page?.needsVision ?? hit.needsOcr,
      score: hit.score,
    };
    sources.push(source);
    blocks.push(`[${id}] ${hit.title} | الصفحة ${hit.printedPage ?? hit.physicalPage} | ${hit.pageTitle}\n${content}`);
  }
  return { sources, block: blocks.join('\n\n---\n\n').slice(0, 11_000) };
}
