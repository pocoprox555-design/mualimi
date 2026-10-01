// محرك المعرفة: فهرس مقلوب في الذاكرة. النص الكامل والبيانات المنظّمة كلها داخل الفهرس؛
// لا يُقرأ أي ملف صفحة وقت التشغيل.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, pageReference, searchTokenForms, searchTokens, uniqueTokens } from './text.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_INDEX = path.join(PROJECT_ROOT, 'curriculum-library', 'search-index.json');
const MAX_CONTEXT_SOURCES = 8;
const PAGE_CONTEXT_CHARS = 6_000;
const CONTEXT_CHARS = 36_000;
const STRUCTURE_CONTEXT_CHARS = 2_600;
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
const PRESS_FILE = /IRAQ_G\d+_[A-Z]{2,4}_\d{4}\.indb/gi;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;

let indexPromise;
const STRUCTURED_KEYS = ['unit', 'work', 'author', 'section', 'sectionPath', 'actScene', 'titleEn', 'summaryEn', 'glossary', 'glossaryRefs', 'vocabulary', 'figures', 'activities', 'exercises', 'answerKeyLocation', 'continuesOn', 'recapOf', 'notes'];

const ALIASES = [
  ['عربي', ['اللغه العربيه', 'قواعد', 'ادب']],
  ['العربيه', ['عربي', 'قواعد', 'ادب']],
  ['انكليزي', ['الانكليزيه', 'الانجليزيه', 'english']],
  ['انجليزي', ['الانكليزيه', 'الانجليزيه', 'english']],
  ['جغرافيا', ['الجغرافيه']],
  ['اسلاميات', ['التربيه الاسلاميه', 'القران']],
  ['تاريخ', ['التاريخ']],
  ['رياضيات', ['الرياضيات']],
  ['اتوقع', ['يتوقع', 'تتوقع', 'توقع']],
];
const GENERIC_RESOLUTION_TERMS = new Set(['يحدد', 'محدد', 'عشوائي', 'عام', 'شيء', 'شي', 'سريع', 'صف', 'الصف', 'سادس', 'السادس', 'اعدادي', 'الاعدادي', 'اسلامي', 'الاسلامي', 'ديني', 'الديني', 'فهرس', 'فهره', 'محتويات', 'خطه', 'خطة', 'دروس', 'فصل', 'اسئله', 'اسئلة']);

function usableText(value) {
  const text = cleanText(value || '');
  return text.length >= 20 && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

function usableMetadata(value) {
  const text = cleanText(value || '');
  return text && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

function prepare(raw) {
  if (!raw || raw.schemaVersion !== 4 || !Array.isArray(raw.documents) || !Array.isArray(raw.books)) {
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
    // الفهرس يجب أن يكون مكتفياً بذاته: لا ملف صفحة ولا PDF يُقرأ وقت التشغيل.
    fullTextPages: index.stats?.fullTextPages ?? index.documents.filter((doc) => doc.textLength > 0).length,
    fullTextChars: index.stats?.fullTextChars ?? 0,
    enrichedPages: index.stats?.enrichedPages ?? 0,
    enrichedBooks: index.stats?.enrichedBooks ?? 0,
    figures: index.stats?.figures ?? 0,
    glossaryEntries: index.stats?.glossaryEntries ?? 0,
  };
}

export async function listBooks({ subject = '', track = '' } = {}) {
  const index = await getIndex();
  const wantedSubject = normalizeAr(subject);
  return index.books.filter((book) => {
    const subjectOk = !wantedSubject || normalizeAr(book.subject).includes(wantedSubject) || normalizeAr(book.title).includes(wantedSubject);
    return subjectOk && allowedBook(book, { track });
  });
}

export async function getSubjects() {
  const index = await getIndex();
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
    lines.push(`- ${index + 1}. ${book.subject} — ${book.title} — المسار: ${book.track || book.branch || 'عام'} — ${book.pageCount} صفحة — ${bookKindLabel(book.kind)} — ${book.searchablePageCount} قابلة للبحث و${visionPages} تحتاج قراءة بصرية.`);
  });
  return lines.join('\n');
}

function expandedTerms(query) {
  const normalized = normalizeAr(query);
  const terms = new Set(searchTokens(query));
  for (const [needle, aliases] of ALIASES) {
    if (normalized.includes(needle)) {
      for (const alias of aliases) for (const token of searchTokens(alias)) terms.add(token);
    }
  }
  return [...terms];
}

function termMatches(doc, term) {
  const documentTerms = doc.terms || [];
  const suffixes = ['كم', 'كن', 'هم', 'هن', 'ها', 'نا', 'ه', 'ك', 'ي'];
  for (const variant of searchTokenForms(term)) {
    if (documentTerms.includes(variant)) return true;
    if (suffixes.some((suffix) => documentTerms.includes(`${variant}${suffix}`))) return true;
  }
  return false;
}

function titleHasTerm(title, term) {
  const titleTerms = new Set(uniqueTokens(title));
  return [...searchTokenForms(term)].some((variant) => titleTerms.has(variant));
}

// أفضلية للكتاب المدرسي الرسمي عند تساوي التطابق مع السؤال،
// حتى لا يطغى «دليل المدرس» أو «كتاب التمارين» على الكتاب الأساسي.
const KIND_BONUS = { 'official-textbook': 0.7, 'official-exercises': 0, 'teacher-guide': -0.4 };

function guessedBook(index, query, requestedBookId, track = '') {
  if (requestedBookId && index.booksById.has(requestedBookId)) return requestedBookId;
  const normalizedQuery = normalizeAr(query);
  const queryTerms = uniqueTokens(query).filter((term) => !GENERIC_RESOLUTION_TERMS.has(term));
  if (!queryTerms.length) return null;
  const candidates = [];
  for (const book of index.books) {
    if (!allowedBook(book, { track })) continue;
    const words = uniqueTokens(`${book.title} ${book.subject}`);
    const matched = queryTerms.filter((term) => words.some((word) => normalizedQuery.includes(word)
      && (term.includes(word) || word.includes(term) || (term.startsWith('ال') && term.slice(2).includes(word))
        || (word.startsWith('ال') && word.slice(2).includes(term)))));
    const overlap = new Set(matched).size;
    const exactSubject = normalizeAr(book.subject) && normalizedQuery.includes(normalizeAr(book.subject));
    if (!overlap || (queryTerms.length > 1 && overlap / queryTerms.length < 0.7 && !exactSubject)) continue;
    const score = overlap + (exactSubject ? 1 : 0) + (KIND_BONUS[book.kind] || 0);
    candidates.push({ id: book.id, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (queryTerms.length === 1 && candidates.length > 1 && candidates[0].score - candidates[1].score < 0.5) return null;
  return candidates[0]?.id || null;
}

function allowedBook(book, { subject = '', track = '' } = {}) {
  const wantedSubject = normalizeAr(subject);
  const wantedTrack = normalizeAr(track);
  if (wantedSubject && !normalizeAr(`${book.subject} ${book.title}`).includes(wantedSubject)) return false;
  if (wantedTrack === normalizeAr('ديني') && book.supplementary) return false;
  if (wantedTrack && normalizeAr(book.track || book.branch || 'عام') !== wantedTrack) return false;
  return true;
}

// تحديد كتاب المادة المستهدف: بالمادة المحددة أولاً، ثم بدلالة اسم المادة في السؤال،
// ثم (اختيارياً) بأغلب نتائج البحث حين يكون السؤال عن فصل لا عن اسم مادة.
export async function resolveBook(query = '', { subject = '', track = '', search: useSearch = false } = {}) {
  const index = await getIndex();
  const wanted = normalizeAr(subject);
  if (wanted) {
    const bySubject = index.books.find((book) => normalizeAr(`${book.subject} ${book.title}`).includes(wanted) && allowedBook(book, { track }));
    if (bySubject) return bySubject;
  }
  const guessed = guessedBook(index, String(query || ''), '', track);
  const candidate = guessed ? index.booksById.get(guessed) : null;
  if (candidate && allowedBook(candidate, { track })) return candidate;
  if (!useSearch) return null;
  const meaningfulTerms = uniqueTokens(query).filter((term) => !GENERIC_RESOLUTION_TERMS.has(term));
  if (meaningfulTerms.length < 2) return null;
  const hits = await search(String(query || ''), { limit: 5, track });
  if (!hits.length) return null;
  const winner = hits[0].bookId;
  if (hits.filter((hit) => hit.bookId === winner).length < 2) return null;
  const book = index.booksById.get(winner);
  return book && allowedBook(book, { track }) ? book : null;
}

function resultFor(index, doc, score) {
  const book = index.booksById.get(doc.bookId);
  const result = {
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

// بحث BM25 مبسط: لا يمر على كل الصفحات، بل يبدأ من postings الكلمات الموجودة في السؤال.
// الكتاب المشترك («عام») يدرسه كل الفروع، فيجوز الرجوع إليه إذا لم يجد المسار نتاجه؛
// أما كتب فرع آخر فلا نفتحها أبداً حتى لا تُنسب لطالبة كتابًا ليست منها. استثناء سؤال
// الصفحة لأنها مقصودة لكتابٍ بعينه لا لعموم المكتبة.
export async function search(query, options = {}) {
  const results = await searchTrack(query, options);
  const track = options.track || '';
  if (results.length || !track || track === 'عام' || pageReference(cleanText(query))) return results;
  return searchTrack(query, { ...options, track: 'عام' });
}

async function searchTrack(query, { bookId = '', subject = '', track = '', limit = 8, onTrace } = {}) {
  const index = await getIndex();
  const text = cleanText(query).slice(0, 400);
  const normalized = normalizeAr(text);
  const terms = expandedTerms(text);
  // كتاب مُحدد صراحةً (من العميل أو من فهرس المادة): فلتار حقيقي لا مجرد مكافأة ترتيب.
  const explicitBook = bookId && index.booksById.has(bookId) ? bookId : null;
  const subjectBooks = subject ? index.books.filter((book) => allowedBook(book, { subject, track })) : [];
  const subjectBook = subjectBooks.length === 1 ? subjectBooks[0].id : null;
  const referencePage = pageReference(text);
  const pageQueryNoise = new Set(['صفحه', 'page', 'ص', 'سوال', 'السوال', 'الثالث', 'الثاني', 'الاول']);
  const queryTerms = uniqueTokens(text).filter((term) => !/^\d+$/.test(term)
    && !(referencePage && pageQueryNoise.has(term)));
  // مصطلح لا وجود له في أي صفحة من المكتبة لا يصلح دليلاً ولا ضدّاً: يُحذف قبل حساب التغطية
  // وإلا أزاح كلمات مثل «لماذا» و«تبدو» الصفحات التي تجيب فعلاً.
  // وإن لم يبقَ مصطلح معروف نعود لكلها لئلا يتعطل البحث.
  const termFrequency = (term) => Math.max(0, ...[...searchTokenForms(term)].map((form) => Number(index.documentFrequency?.[form] || 0)));
  const discriminating = (term) => termFrequency(term) > 0;
  const scoringTerms = queryTerms.filter(discriminating);
  const effectiveTerms = scoringTerms.length ? scoringTerms : queryTerms;
  const pageIdentityBooks = effectiveTerms.length
    ? index.books.filter((book) => allowedBook(book, { subject, track })
      && effectiveTerms.every((term) => titleHasTerm(`${book.title} ${book.subject}`, term)))
    : [];
  const identityBook = pageIdentityBooks.length === 1 ? pageIdentityBooks[0].id : '';
  const requestedBook = explicitBook || subjectBook || identityBook || guessedBook(index, text, '', track);
  const candidates = new Set();

  for (const term of terms) {
    for (const id of index.postings.get(term) || []) {
      if (referencePage && requestedBook && index.documents[id]?.bookId !== requestedBook) continue;
      candidates.add(id);
    }
  }
  if (referencePage && requestedBook) {
    const physical = index.printed.get(requestedBook)?.get(referencePage);
    if (physical != null) {
      const direct = index.docsByBookPage.get(`${requestedBook}:${physical}`);
      if (direct != null) { candidates.clear(); candidates.add(direct); }
    }
  }
  if (!candidates.size) {
    onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: 0, hitCount: 0 });
    return [];
  }

  const total = index.documents.length;
  const maxResults = Math.max(1, Math.min(24, Number(limit) || 8));
  const scopedPageBook = explicitBook || subjectBook || identityBook || (referencePage ? guessedBook(index, text, '', track) : '');
  const scopedBookMeta = scopedPageBook ? index.booksById.get(scopedPageBook) : null;
  const pageHasTopicTerms = scopedBookMeta && effectiveTerms.some((term) => !titleHasTerm(`${scopedBookMeta.title} ${scopedBookMeta.subject}`, term));
  if (referencePage && scopedPageBook && !index.printed.get(scopedPageBook)?.has(referencePage) && !pageHasTopicTerms) {
    onTrace?.({ phase: 'search', terms: terms.slice(0, 12), candidateCount: candidates.size, hitCount: 0 });
    return [];
  }
  const ranked = [];
  for (const id of candidates) {
    const doc = index.documents[id];
    const book = index.booksById.get(doc.bookId);
    if (!doc || !book || !allowedBook(book, { subject, track })) continue;
    if (explicitBook && doc.bookId !== explicitBook) continue;
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (!termMatches(doc, term)) continue;
      matched += 1;
      const df = Number(index.documentFrequency?.[term] || 1);
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (term.length >= 4 ? 1.25 : 0.8);
    }
    if (!matched && !(referencePage && doc.bookId === requestedBook)) continue;
    const matchedQueryTerms = effectiveTerms.filter((term) => termMatches(doc, term));
    // الرقم المطبوع في السؤال دليل قاطع بحد ذاته، بشرط أن يكون الكتاب محدداً أو أن يطابق المحتوى.
    const directPageMatch = Boolean(referencePage && doc.printedPage === referencePage
      && (!requestedBook || doc.bookId === requestedBook));
    const titleNorm = normalizeAr(`${doc.title} ${doc.section || ''} ${doc.unit || ''}`);
    const exactTitleMatch = effectiveTerms.length >= 2 && effectiveTerms.every((term) => titleNorm.includes(term));
    // سؤال الطالبة جملة كاملة فيها أدوات وحشو، فنسبة المطابقة تنخفض طبيعياً حتى على الصفحة
    // الصحيحة (9 من 19 مصطلحاً لدرس التوكيد). العتبة القديمة (0.75 ثم مطابقتان) كانت ترفض
    // السؤال كله فلا تصل الطالبة إلى مصدرها ويضطر النموذج للجواب من معرفته العامة.
    // الفاصل هنا عدد المصطلحات المطابقة: الضوضاء المقيسة («ما عاصمة اليابان؟»، «قانون نيوتن
    // الثاني»، «غسيل السيارات في بغداد»، «اشرح لي الموجات الكهربائية») لا تتجاوز مطابقتين،
    // والسؤال الحقيقي يبلغ ثلاثاً فأكثر؛ والترتيب يبقى بندراها (idf) فتسبق الصفحة المميّزة.
    const informative = matchedQueryTerms.length >= 3
      || (effectiveTerms.length === 2 && matchedQueryTerms.length === 2);
    const singleTermSpecific = effectiveTerms.length === 1
      && (exactTitleMatch || Math.log(1 + (total - Math.max(1, termFrequency(effectiveTerms[0])) + 0.5)
        / (Math.max(1, termFrequency(effectiveTerms[0])) + 0.5)) >= 3.2);
    // سؤال فيه رقم صفحة فقط بلا مضمون («صفحة 42») لا يجوز أن يفتح صفحة عشوائية؛
    // وجود مصطلح مضمون واحد على الأقل يجعل البحث عن صفحة منطقياً.
    const unscopedPageQuery = Boolean(referencePage && !explicitBook && !subjectBook && !effectiveTerms.length);
    if (unscopedPageQuery) continue;
    if (!directPageMatch && !exactTitleMatch && !singleTermSpecific && !informative) continue;
    if (normalized.length > 5 && doc.normalized.includes(normalized)) score += 8;
    const titleMatches = terms.reduce((count, term) => count + (titleNorm.includes(term) ? 1 : 0), 0);
    score += titleMatches * 2.4;
    if (requestedBook === doc.bookId) score += 1.5;
    if (referencePage && doc.bookId === requestedBook && doc.printedPage === referencePage) score += 30;
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

// الصفحة تُبنى من سجل الفهرس وحده: النص الكامل والرسوم والمفردات والتمارين كلها داخله.
export async function fullPage(bookId, physicalPage) {
  const index = await getIndex();
  const number = Number(physicalPage);
  if (!index.booksById.has(bookId) || !Number.isInteger(number)) throw new Error('PAGE_NOT_FOUND');
  const docId = index.docsByBookPage.get(`${bookId}:${number}`);
  const doc = docId == null ? null : index.documents[docId];
  if (!doc) throw new Error('PAGE_NOT_FOUND');
  const text = String(doc.text || '').replace(PRESS_FILE, ' ').replace(PRESS_STAMP, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  const outlineSummary = cleanText(doc.outlineSummary || '');
  const summary = compact(text ? (usableMetadata(doc.summary) || outlineSummary) : (outlineSummary || 'هذه الصفحة مصورة ولا يتوفر لها نص موثوق بعد.'), 700);
  const evidenceType = text ? 'pdf-text' : outlineSummary ? 'outline-description' : 'summary';
  const page = {
    bookId,
    physicalPage: number,
    printedPage: doc.printedPage ?? null,
    pageOffset: doc.pageOffset ?? null,
    title: usableMetadata(doc.title) || '',
    section: cleanText(doc.section || ''),
    unit: cleanText(doc.unit || ''),
    pageType: cleanText(doc.pageType || ''),
    purpose: cleanText(doc.purpose || ''),
    summary,
    text: text || outlineSummary || compact(summary || 'هذه الصفحة مصورة ولا يتوفر لها نص قابل للاستخراج.', 4_000),
    searchable: Boolean(text),
    needsVision: !text || Boolean(doc.needsOcr),
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

// البيانات المنظّمة (الرسومات والمفردات والتمارين) هي ما لا يظهر في النص، فتلحق به صراحةً.
function structureBlock(page) {
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
  return compact(lines.join('\n'), STRUCTURE_CONTEXT_CHARS);
}

export async function retrieveContext(query, options = {}) {
  const { onTrace } = options;
  const index = await getIndex();
  const hits = await search(query, { ...options, limit: options.limit || 10 });
  const sources = [];
  const blocks = [];
  const tracePages = [];
  for (const hit of hits) {
    if (sources.length >= MAX_CONTEXT_SOURCES) break;
    let page;
    try { page = await fullPage(hit.bookId, hit.physicalPage); } catch { page = null; }
    onTrace?.({ phase: 'page', bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true });
    tracePages.push({ bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true });
    const content = page?.searchable
      ? relevantExcerpt(page.text, query)
      : compact(page?.outlineSummary || page?.text || `${hit.pageTitle}\n${hit.summary}\n${hit.preview}`, 2_200);
    if (!content) continue;
    const structure = page ? structureBlock(page) : '';
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
      summary: hit.summary,
      preview: hit.preview,
      searchable: page?.searchable ?? hit.searchable,
      needsOcr: page?.needsVision ?? hit.needsOcr,
      evidenceType: page?.evidenceType || (hit.searchable ? 'pdf-text' : 'outline-description'),
      enriched: Boolean(page?.enriched),
      score: hit.score,
    };
    for (const key of ['work', 'author', 'actScene', 'sectionPath', 'answerKeyLocation']) {
      if (page?.[key]) source[key] = page[key];
    }
    if (page?.glossary?.length) source.glossaryCount = page.glossary.length;
    if (page?.figures?.length) source.figureCount = page.figures.length;
    if (page?.exercises?.length) source.exerciseCount = page.exercises.length;
    const evidenceLabel = source.evidenceType === 'pdf-text'
      ? 'نص مستخرج من PDF — صالح للاستشهاد بعد التحقق من وضوح الاستخراج.'
      : 'وصف فهرسي غير حرفي — للتنقل وتحديد الموضوع فقط، وليس اقتباسا من الصفحة.';
    const pageLabel = hit.printedPage != null
      ? `الصفحة المطبوعة ${hit.printedPage} (صفحة PDF ${hit.physicalPage})`
      : `صفحة PDF ${hit.physicalPage} (رقم الصفحة المطبوع غير متحقق)`;
    const heading = [`[${id}] ${hit.title} | ${pageLabel} | ${hit.pageTitle}`];
    if (source.work) heading.push(`[العمل: ${source.work}${source.author ? ` — ${source.author}` : ''}${source.section ? ` — ${source.section}` : ''}]`);
    heading.push(`[نوع الدليل: ${evidenceLabel}]`);
    const block = [...heading, content, structure ? `[محتوى منظّم مستخرج من الصفحة]\n${structure}` : ''].filter(Boolean).join('\n');
    if (blocks.length && blocks.join('\n\n---\n\n').length + block.length + 9 > CONTEXT_CHARS) break;
    sources.push(source);
    blocks.push(block);
  }
  const block = blocks.join('\n\n---\n\n');
  return { sources, block, trace: { pages: tracePages } };
}
