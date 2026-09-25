// محرك المعرفة: فهرس مقلوب في الذاكرة + تحميل كسول للنص الكامل.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, pageReference, uniqueTokens } from './text.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_ROOT = path.join(PROJECT_ROOT, 'curriculum-library');
const SEARCH_INDEX = path.join(LIBRARY_ROOT, 'search-index.json');
const BOOKS_DIR = path.join(LIBRARY_ROOT, 'pdf-books');
const MAX_CONTEXT_SOURCES = 8;
const PAGE_CONTEXT_CHARS = 6_000;
const CONTEXT_CHARS = 36_000;

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
const GENERIC_RESOLUTION_TERMS = new Set(['يحدد', 'محدد', 'عشوائي', 'عام', 'شيء', 'شي', 'سريع']);

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
  const searchablePages = index.stats?.searchablePages ?? index.documents.filter((doc) => doc.searchable).length;
  const visionPages = index.stats?.visionPages ?? index.documents.filter((doc) => doc.needsOcr).length;
  return {
    schemaVersion: index.schemaVersion,
    builtAt: index.builtAt,
    books: index.stats?.books || index.books.length,
    pages: index.stats?.pages || index.documents.length,
    indexedPages: index.stats?.indexedPages || index.documents.length,
    searchablePages,
    visionPages,
    outlinePages: index.stats?.outlinePages || 0,
    printedPageGaps: index.documents.filter((doc) => doc.printedPage == null).length,
    terms: index.stats?.terms || index.postings.size,
  };
}

export async function listBooks({ subject = '' } = {}) {
  const index = await getIndex();
  const wantedSubject = normalizeAr(subject);
  return index.books.filter((book) => {
    const subjectOk = !wantedSubject || normalizeAr(book.subject).includes(wantedSubject) || normalizeAr(book.title).includes(wantedSubject);
    return subjectOk;
  });
}

export async function getSubjects() {
  const index = await getIndex();
  return [...new Set(index.books.map((book) => book.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
}

export async function getCatalog() {
  const books = await listBooks();
  const subjects = [...new Set(books.map((book) => book.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  return {
    books,
    subjects,
    pages: books.reduce((total, book) => total + Number(book.pageCount || 0), 0),
    searchablePages: books.reduce((total, book) => total + Number(book.searchablePageCount || 0), 0),
  };
}

function bookKindLabel(kind) {
  if (kind === 'official-exercises') return 'كتاب تمارين رسمي';
  if (kind === 'teacher-guide') return 'دليل مدرس';
  return 'كتاب مدرسي رسمي';
}

export function catalogContext(catalog) {
  if (!catalog?.books?.length) return '';
  const lines = [
    `الكتالوج الكامل للمكتبة: ${catalog.books.length} كتابا، ${catalog.subjects.length} مواد/تصنيفات، ${catalog.pages} صفحة فيزيائية.`,
    `النص المستخرج القابل للبحث: ${catalog.searchablePages} صفحة؛ الصفحات الباقية صفحات مصورة أو تحتاج قراءة بصرية.`,
    'هذه بيانات كتالوج دقيقة وليست مقتطفات من صفحة واحدة:',
  ];
  catalog.books.forEach((book, index) => {
    const visionPages = Number(book.visionPageCount ?? Math.max(0, Number(book.pageCount || 0) - Number(book.searchablePageCount || 0)));
    lines.push(`- ${index + 1}. ${book.subject} — ${book.title} — ${book.pageCount} صفحة — ${bookKindLabel(book.kind)} — ${book.searchablePageCount} قابلة للبحث و${visionPages} تحتاج قراءة بصرية.`);
  });
  return lines.join('\n');
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

// أفضلية للكتاب المدرسي الرسمي عند تساوي التطابق مع السؤال،
// حتى لا يطغى «دليل المدرس» أو «كتاب التمارين» على الكتاب الأساسي.
const KIND_BONUS = { 'official-textbook': 0.7, 'official-exercises': 0, 'teacher-guide': -0.4 };

function guessedBook(index, query, requestedBookId) {
  if (requestedBookId && index.booksById.has(requestedBookId)) return requestedBookId;
  const normalizedQuery = normalizeAr(query);
  let best = null;
  for (const book of index.books) {
    const words = uniqueTokens(`${book.title} ${book.subject}`);
    const overlap = words.reduce((score, word) => score + (normalizedQuery.includes(word) ? 1 : 0), 0);
    if (!overlap) continue;
    const score = overlap + (KIND_BONUS[book.kind] || 0);
    if (score > 0 && (!best || score > best.score)) best = { id: book.id, score };
  }
  return best?.id || null;
}

function allowedBook(book, { subject = '' } = {}) {
  const wantedSubject = normalizeAr(subject);
  if (wantedSubject && !normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject)) return false;
  return true;
}

// تحديد كتاب المادة المستهدف: بالمادة المحددة أولاً، ثم بدلالة اسم المادة في السؤال،
// ثم (اختيارياً) بأغلب نتائج البحث حين يكون السؤال عن فصل لا عن اسم مادة.
export async function resolveBook(query = '', { subject = '', search: useSearch = false } = {}) {
  const index = await getIndex();
  const wanted = normalizeAr(subject);
  if (wanted) {
    const bySubject = index.books.find((book) => normalizeAr(`${book.subject} ${book.title}`).includes(wanted) && allowedBook(book));
    if (bySubject) return bySubject;
  }
  const guessed = guessedBook(index, String(query || ''), '');
  const candidate = guessed ? index.booksById.get(guessed) : null;
  if (candidate && allowedBook(candidate)) return candidate;
  if (!useSearch) return null;
  const meaningfulTerms = uniqueTokens(query).filter((term) => !GENERIC_RESOLUTION_TERMS.has(term));
  if (meaningfulTerms.length < 2) return null;
  const hits = await search(String(query || ''), { limit: 5 });
  if (!hits.length) return null;
  const winner = hits[0].bookId;
  if (hits.filter((hit) => hit.bookId === winner).length < 2) return null;
  const book = index.booksById.get(winner);
  return book && allowedBook(book) ? book : null;
}

function resultFor(index, doc, score) {
  const book = index.booksById.get(doc.bookId);
  return {
    score: Number(score.toFixed(3)),
    id: doc.id,
    bookId: doc.bookId,
    title: book?.title || doc.bookId,
    subject: book?.subject || '',
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
export async function search(query, { bookId = '', subject = '', limit = 8, onTrace } = {}) {
  const index = await getIndex();
  const text = cleanText(query).slice(0, 400);
  const normalized = normalizeAr(text);
  const terms = expandedTerms(text);
  // كتاب مُحدد صراحةً (من العميل أو من فهرس المادة): فلتار حقيقي لا مجرد مكافأة ترتيب.
  const explicitBook = bookId && index.booksById.has(bookId) ? bookId : null;
  const requestedBook = explicitBook || guessedBook(index, text, '');
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
  if (!candidates.size) {
    onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: 0, hitCount: 0 });
    return [];
  }

  const total = index.documents.length;
  const maxResults = Math.max(1, Math.min(24, Number(limit) || 8));
  const ranked = [];
  for (const id of candidates) {
    const doc = index.documents[id];
    const book = index.booksById.get(doc.bookId);
    if (!doc || !book || !allowedBook(book, { subject })) continue;
    if (explicitBook && doc.bookId !== explicitBook) continue;
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
  const results = ranked
    .sort((a, b) => b.score - a.score || a.doc.physicalPage - b.doc.physicalPage)
    .slice(0, maxResults)
    .map(({ doc, score }) => resultFor(index, doc, score));
  onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: candidates.size, hitCount: results.length });
  return results;
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
  const outlineSummary = cleanText(page.outlineSummary || indexed?.outlineSummary || '');
  const summary = compact(page.summary || indexed?.summary || outlineSummary || '', 700);
  const evidenceType = text ? 'pdf-text' : outlineSummary ? 'outline-description' : 'summary';
  return {
    bookId,
    physicalPage: number,
    printedPage: page.printedPage ?? page.printedPageNumber ?? indexed?.printedPage ?? null,
    title: cleanText(page.title || indexed?.title || ''),
    section: cleanText(page.section || indexed?.section || ''),
    unit: cleanText(page.unit || indexed?.unit || ''),
    summary,
    text: text || outlineSummary || compact(page.summary || indexed?.summary || 'هذه الصفحة مصورة ولا يتوفر لها نص قابل للاستخراج.', 4_000),
    searchable: Boolean(text),
    needsVision: !text || Boolean(page.needsOcr || page.ocr?.required),
    evidenceType,
    outlineSummary,
  };
}

function relevantExcerpt(value, query, max = PAGE_CONTEXT_CHARS) {
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
  if (selected.length) {
    const ordered = selected.sort((a, b) => a.index - b.index).map((piece) => piece.piece).join('\n');
    if (ordered.length >= max * 0.45) return ordered.slice(0, max);
  }
  const head = Math.floor(max * 0.55);
  const tail = max - head;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

export async function retrieveContext(query, options = {}) {
  const { onTrace } = options;
  const hits = await search(query, { ...options, limit: options.limit || 10 });
  const sources = [];
  const blocks = [];
  const tracePages = [];
  for (const hit of hits) {
    if (sources.length >= MAX_CONTEXT_SOURCES) break;
    let page;
    try { page = await fullPage(hit.bookId, hit.physicalPage); } catch { page = null; }
    onTrace?.({ phase: 'page', bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage ?? hit.physicalPage, needsVision: page ? page.needsVision : true });
    tracePages.push({ bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage ?? hit.physicalPage, needsVision: page ? page.needsVision : true });
    const content = page?.searchable
      ? relevantExcerpt(page.text, query)
      : compact(page?.outlineSummary || page?.text || `${hit.pageTitle}\n${hit.summary}\n${hit.preview}`, 2_200);
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
      evidenceType: page?.evidenceType || (hit.searchable ? 'pdf-text' : 'outline-description'),
      score: hit.score,
    };
    const evidenceLabel = source.evidenceType === 'pdf-text'
      ? 'نص مستخرج من PDF — صالح للاستشهاد بعد التحقق من وضوح الاستخراج.'
      : 'وصف فهرسي غير حرفي — للتنقل وتحديد الموضوع فقط، وليس اقتباسا من الصفحة.';
    const block = `[${id}] ${hit.title} | الصفحة ${hit.printedPage ?? hit.physicalPage} | ${hit.pageTitle}\n[نوع الدليل: ${evidenceLabel}]\n${content}`;
    if (blocks.length && blocks.join('\n\n---\n\n').length + block.length + 9 > CONTEXT_CHARS) break;
    sources.push(source);
    blocks.push(block);
  }
  const block = blocks.join('\n\n---\n\n');
  return { sources, block, trace: { pages: tracePages } };
}
