// محرك المعرفة: فهرس مقلوب في الذاكرة. النص الكامل والبيانات المنظّمة داخله؛
// لا يُفتح PDF إلا عبر قارئ الصفحة الدقيقة المنفصل عند الحاجة.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokenYears, cleanText, compact, normalizeAr, pageReference, searchTokenForms, searchTokens, uniqueTokens } from './text.mjs';
import { classifyPageEvidence, getPdfPageEvidence } from './pdf-fallback.mjs';
// `hasTextDamage` ملكية lib/text.mjs (وكيل النص). يُقرأ من مساحة الأسماء عمداً:
// الاستيراد الاسمي لتصدير غير موجود يُفشل ربط الملف كله، بينما هذا يجعل الكود
// يعمل قبل وصول التصدير وبعده، فلا ينهار المحرك إن تأخر بناء دالة الكشف.
import * as textToolkit from './text.mjs';

// Fallback API for callers that have exhausted reliable search-index evidence.
// `searchPdfPages(query, { track, subject, bookId, limit })` returns compact
// page candidates with the book/source metadata, exact physical/printed page
// locator, `forceSource: true`, `sourcePage`, `matchedTerms`, `coverage`,
// `evidenceStatus`, and `textSource: 'pdf-index.fullText'`. These are locator
// candidates only; pass the selected candidate to `readPdfPage` before using
// page text so the exact source page is opened when available.
export { searchPdfPages } from './pdf-fallback.mjs';

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

// ─── سلامة النص الطباعي ─────────────────────────────────────────────
// حكما على «صالح للاستشهاد» لا يجوز أن يُقال بلا فحص. طبقة نص الـPDF نفسها
// تالفة في مواضع (محارف U+FFFD مفقودة، رموز PUA لم تُفسَّر، حروف مقلوبة داخل
// الكلمة، تواريخ مقلوبة)، فالنقل الحرفي منها ينتج نقلاً خاطئاً. كل إشارة هنا
// مُقيسة على search-index.json لا مُخمَّنة.
const DAMAGE_FFFD = /\uFFFD/g;
const DAMAGE_PUA = /[\uE000-\uF8FF]/g;
// «هللا» قلب حروف «الله»: لا وجود له في العربية الصحيحة، وهو أثر فك ترميز bidi
// داخل طبقة نص الـPDF (مقيس: 264 صفحة outline و1055 صفحة نص قبل إصلاح «اال»).
// أما «اال» فسقط من هذه القاعدة: هو فكّ ترميز bidi أيضاً لكنه **قابل للإصلاح عند
// حد الكلمة** (lib/text.mjs: OCR_FIX)، فلم يبقَ دليل تلف بعد إصلاحه.
const DAMAGE_REVERSED = /هللا/g;
// حرف عربي ملاصق بحرف لاتيني **داخل الكلمة نفسها** لا بين كلمتين: أثر ترميز
// خاطئ لا لغة كتاب مدرسي. «أختها Jane وMr Bingley» و«تمارين A وB» خلطٌ صحيح
// يُستبعد، و«الmامنه» و«eناk» تلفٌ حقيقي.
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

// يختار أنظف نسخة متاحة للاقتباس بمقياس جودة فعلي: `text` هو الدليل المقروء
// من الصفحة، و`outlineSummary` طبقة مقروءة بصرياً. إن كان أحدهما أنظف وجب
// الاقتباس منه؛ فإن تلفا معاً فلا يُنقل النص حرفياً ويُذكر السبب.
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
    const reasons = [...textVerdict.reasons, ...(outline ? outlineVerdict.reasons : ['لا نسخة فهرسية سليمة'])];
    return { source: 'unreliable', text: text || outline, reliable: false, reasons };
  }
  if (outline) return { source: outlineVerdict.damaged ? 'unreliable' : 'outline-description', text: outline, reliable: !outlineVerdict.damaged, reasons: outlineVerdict.reasons };
  return { source: 'none', text: '', reliable: false, reasons: ['لا نص ولا وصف فهرسي متاح'] };
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
  const evidenceStatuses = Object.fromEntries(['clean-extracted-text', 'ocr-text', 'damaged-text', 'no-text']
    .map((status) => [status, index.documents.filter((doc) => doc.evidenceStatus === status).length]));
  const classifiedEvidencePages = Object.values(evidenceStatuses).reduce((sum, count) => sum + count, 0);
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
    // النص والفهرسة مكتفيان بذاتهما؛ مصدر PDF لا يُفتح إلا عبر fallback لصفحة مطلوبة.
    fullTextPages: index.stats?.fullTextPages ?? index.documents.filter((doc) => doc.textLength > 0).length,
    fullTextChars: index.stats?.fullTextChars ?? 0,
    evidenceStatuses,
    unclassifiedEvidencePages: Math.max(0, index.documents.length - classifiedEvidencePages),
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

const nonOutlineTermsCache = new WeakMap();

function nonOutlineSearchText(doc, book) {
  const figures = (doc.figures || []).map((figure) => [
    'صورة', figure?.kind, figure?.caption, figure?.description, ...(figure?.figureText || []),
  ].filter(Boolean).join(' ')).join('\n');
  const glossary = ['مفردات معجم', ...(doc.glossary || []).map((entry) => [entry.term, entry.pos, entry.definition].filter(Boolean).join(' '))].join('\n');
  const activities = ['نشاط تمارين', ...(doc.activities || []).map((activity) => [
    activity.type, activity.instruction, activity.answerFormat,
    activity.dispatch ? `${activity.dispatch.target} ${activity.dispatch.printedFrom} ${activity.dispatch.printedTo}` : '',
    ...(activity.questions || []),
  ].filter(Boolean).join(' '))].join('\n');
  const exercises = ['تمارين', ...(doc.exercises || []).map((exercise) => [
    `التمرين ${exercise.letter || ''}`, exercise.instruction,
    ...(exercise.items || []).map((item) => `${item.kind || ''} ${item.stem || ''}`),
  ].filter(Boolean).join(' '))].join('\n');
  return [
    book?.title, book?.subject,
    reconcilePageMetadata(doc.title, Boolean(doc.text)), doc.section, doc.unit, doc.work, doc.author,
    doc.sectionPath, doc.pageType, doc.purpose, reconcilePageMetadata(doc.summary, Boolean(doc.text)), doc.text,
    figures, glossary, activities, exercises,
  ].filter(Boolean).join('\n');
}

function termMatches(doc, term, book = null) {
  let documentTerms = doc.terms || [];
  // بعض الفهارس القديمة خلطت عبارة «لا يمكن الإجابة» داخل postings حتى بعد
  // ظهور نص الصفحة. عندها نطابق من حقول الصفحة الحالية فقط، لا من وصفها المتقادم.
  if (String(doc.text || '').trim() && STALE_OUTLINE.test(String(doc.outlineSummary || ''))) {
    if (!nonOutlineTermsCache.has(doc)) {
      nonOutlineTermsCache.set(doc, uniqueTokens(nonOutlineSearchText(doc, book)));
    }
    documentTerms = nonOutlineTermsCache.get(doc);
  }
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

// ─── صفحات التمارين والفهرس ────────────────────────────────────────
// سؤال «كم عدد شرط القطع في السرقة» يجد صفحة التمارين (ص43) لأن التمارين
// تكرّر مصطلحات السؤال، بينما صفحة الشرح (ص32) تحمل الشرح نفسه. العتبة العمياء
// كانت تُرجح التمارين. هذه دالة تُرجّح صفحة المحتوى على صفحة التمارين والفهرس.
const EXERCISE_PAGE_TYPES = new Set(['exercises', 'questions', 'matching']);
const LEADING_FOLIO = /^[0-9٠-٩\s.،:؛()«»\-–—]+/;
const EXERCISE_IMPERATIVE = /^(?:اختر|عرف|اكمل|استخرج|علم|حدد|سجل|ناقش|بين|صنف|اكتب|مايأتي|سؤال|سئله|اسئله|تمارين|التمارين|تدريب|نشاط|اختبر|ميز|فك)/;
const EXERCISE_QUERY = /(?:تمرين|تمارين|تدريب|نشاط|سؤال|سئله|اسئله|واجب|اختبار|اختبر|حل)/;

function isExercisePage(doc) {
  if (EXERCISE_PAGE_TYPES.has(String(doc.pageType || ''))) return true;
  if ((doc.exercises?.length || 0) > 0) return true;
  const title = normalizeAr(doc.title || '').replace(LEADING_FOLIO, '');
  if (EXERCISE_IMPERATIVE.test(title)) return true;
  // أمر امتحاني في أول سطور النص مع عنوان وصفي (ص43 الفقه: العنوان وصفي
  // والنص يبدأ بـ«1 عرف ما يأتي»).
  return EXERCISE_IMPERATIVE.test(LEADING_FOLIO.test(normalizeAr(doc.text || '')) ? '' : normalizeAr(String(doc.text || '').slice(0, 60)));
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
  const hasCurrentText = Boolean(String(doc.text || '').trim());
  const result = {
    score: Number(score.toFixed(3)),
    id: doc.id,
    bookId: doc.bookId,
    title: book?.title || doc.bookId,
    subject: book?.subject || '',
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage,
    pageTitle: reconcilePageMetadata(doc.title, hasCurrentText),
    section: doc.section || '',
    unit: doc.unit || '',
    summary: reconcilePageMetadata(doc.summary, hasCurrentText),
    preview: doc.preview,
    searchable: doc.searchable,
    needsOcr: doc.needsOcr,
    evidenceStatus: doc.evidenceStatus || null,
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
// المسار المحدد قيد صارم؛ لا تُعاد المحاولة بمسار «عام» أو أي مسار آخر عند غياب النتائج.
export async function search(query, options = {}) {
  return searchTrack(query, options);
}

async function searchTrack(query, { bookId = '', subject = '', track = '', limit = 8, onTrace } = {}) {
  const index = await getIndex();
  if (bookId && !index.booksById.has(bookId)) {
    onTrace?.({ phase: 'search', terms: [], candidateCount: 0, hitCount: 0 });
    return [];
  }
  const text = cleanText(query).slice(0, 400);
  const normalized = normalizeAr(text);
  const terms = expandedTerms(text);
  // كتاب مُحدد صراحةً (من العميل أو من فهرس المادة): فلتار حقيقي لا مجرد مكافأة ترتيب.
  const explicitBook = bookId || null;
  const subjectBooks = subject ? index.books.filter((book) => allowedBook(book, { subject, track })) : [];
  const subjectBook = subjectBooks.length === 1 ? subjectBooks[0].id : null;
  const referencePage = pageReference(text);
  const pageQueryNoise = new Set(['صفحه', 'page', 'ص', 'سوال', 'السوال', 'الثالث', 'الثاني', 'الاول']);
  // الرقم المطبوع في السؤال («صفحة 42») عنوان لا مضمون، فيُحذف؛ لكن الرقم الذي
  // طلبت الطالبة عنه («2513 كم»، «864») مضمون ويبقى. حذف كل رقم كان يُسقط كل
  // استعلام رقمي: 0/6 في الجغرافيا و0/4 في الرياضيات (مقيس).
  const pageAddressNumber = referencePage == null ? null : String(referencePage);
  const queryTerms = uniqueTokens(text).filter((term) => !(referencePage && pageQueryNoise.has(term))
    && !(pageAddressNumber && term === pageAddressNumber));
  // مصطلح لا وجود له في أي صفحة من المكتبة لا يصلح دليلاً ولا ضدّاً: يُحذف قبل حساب التغطية
  // وإلا أزاح كلمات مثل «لماذا» و«تبدو» الصفحات التي تجيب فعلاً.
  // وإن لم يبقَ مصطلح معروف نعود لكلها لئلا يتعطل البحث.
  const termFrequency = (term) => Math.max(0, ...[...searchTokenForms(term)].map((form) => Number(index.documentFrequency?.[form] || 0)));
  const discriminating = (term) => termFrequency(term) > 0;
  const scoringTerms = queryTerms.filter(discriminating);
  const effectiveTerms = scoringTerms.length ? scoringTerms : queryTerms;
  // رقم مجرّد شائع («10» في 230 صفحة) لا يميّز صفحة، فتبقي مصداقيته مشروطة:
  // إما أن يميّز فعلاً (idf عالٍ)، أو أن يكون مقروناً بمصطلح آخر في السؤال.
  // الخنق يبقى بعيداً لأن بوابة `singleTermSpecific` ترفض idf < 3.2 (df > 91).
  const numericTerms = effectiveTerms.filter((term) => /^\d+$/.test(term));
  const bareNumericQuery = effectiveTerms.length > 0 && numericTerms.length === effectiveTerms.length;
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
  // سؤال فيه رقم صفحة فقط بلا مضمون («صفحة 42») لا يجوز أن يفتح صفحة عشوائية؛
  // وجود مصطلح مضمون واحد على الأقل يجعل البحث عن صفحة منطقياً.
  const unscopedPageQuery = Boolean(referencePage && !explicitBook && !subjectBook && !effectiveTerms.length);
  const exerciseQuery = EXERCISE_QUERY.test(normalizeAr(text));
  // وصف فهرسي قديم يقول «لا يمكن الإجابة» محشور داخل `doc.normalized` فيُغذّي
  // المطابقة العباراتية باطلةً (ص10 الجغرافيا). يُحتسب مرة واحدة لكل صفحة ويُستثنى
  // من مكافأة العبارة الكاملة.
  const staleOutlinePages = new Set();
  const markStaleOutline = (doc) => {
    if (STALE_OUTLINE.test(String(doc.outlineSummary || ''))) staleOutlinePages.add(doc);
  };

  const termWeight = (term) => {
    const df = Math.max(1, termFrequency(term));
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  };
  // العتبة صارت **نسبة موزونة** لا عدداً مطلقاً: العتبة القديمة (3 مطابقات)
  // كانت تُسقط سؤالاً طبيعياً كلما زاد مضمونه («أسلوب التعجب وأقسامه» =
  // 2 من 3 ⇒ 0). وتلك النسبة تُدخل ضوضاءً من نوعين مُقيسَين على المكتبة:
  // «قانون نيوتن الثاني» (2 من 3، مجموع idf ‏4.72) و«العرض والطلب في
  // الاقتصاد الأدبي» (2 من 4، ‏5.32). الفاصل هو **نسبة التغطية × مجموع ندرة
  // المصطلحات**: ضوضاء ≤ 5.32، وأسئلة حقيقية ≥ 7.14 ⇒ الحدّ 6.0.
  const WEIGHT_FLOOR = 6;
  const COVERAGE_FLOOR = 0.5;
  const ranked = [];
  const relaxed = [];
  for (const id of candidates) {
    const doc = index.documents[id];
    const book = index.booksById.get(doc.bookId);
    if (!doc || !book || !allowedBook(book, { subject, track })) continue;
    if (explicitBook && doc.bookId !== explicitBook) continue;
    markStaleOutline(doc);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      if (!termMatches(doc, term, book)) continue;
      matched += 1;
      const df = Number(index.documentFrequency?.[term] || 1);
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (term.length >= 4 ? 1.25 : 0.8);
    }
    if (!matched && !(referencePage && doc.bookId === requestedBook)) continue;
    const matchedQueryTerms = effectiveTerms.filter((term) => termMatches(doc, term, book));
    // الرقم المطبوع في السؤال دليل قاطع بحد ذاته، بشرط أن يكون الكتاب محدداً أو أن يطابق المحتوى.
    const directPageMatch = Boolean(referencePage && doc.printedPage === referencePage
      && (!requestedBook || doc.bookId === requestedBook));
    const titleNorm = normalizeAr(`${doc.title} ${doc.section || ''} ${doc.unit || ''}`);
    const exactTitleMatch = effectiveTerms.length >= 2 && effectiveTerms.every((term) => titleNorm.includes(term));
    const coverage = effectiveTerms.length ? matchedQueryTerms.length / effectiveTerms.length : 0;
    const matchedWeight = matchedQueryTerms.reduce((sum, term) => sum + termWeight(term), 0);
    // مسار الرقم: سؤال رقمي («864»، «2513 كم») لا يحمل إلا أرقاماً، فلا ينفعه
    // شرط المصطلحات الثلاثة. يُقبل إذا كان الرقم نادراً (idf عالٍ) أو مقروناً
    // بوحدة/سؤال يفتح صفحة أخرى.
    const numericSpecific = bareNumericQuery && numericTerms.length > 0 && matchedQueryTerms.length > 0
      && (matchedQueryTerms.some((term) => termWeight(term) >= 3.2)
        || (doc.text && numericTerms.every((term) => new RegExp(`(?:^|\\D)${term}(?:\\D|$)`).test(doc.text))));
    // البوابة التكيّفية: إما ثلاثة مصطلحات فأكثر، أو تغطية نصف المصطلحات على
    // الأقل مع وزن ندرتها فوق الحدّ المقيس.
    const informative = matchedQueryTerms.length >= 3
      || (matchedQueryTerms.length >= 2 && coverage >= COVERAGE_FLOOR && matchedWeight >= WEIGHT_FLOOR);
    const singleTermSpecific = effectiveTerms.length === 1
      && (exactTitleMatch || Math.log(1 + (total - Math.max(1, termFrequency(effectiveTerms[0])) + 0.5)
        / (Math.max(1, termFrequency(effectiveTerms[0])) + 0.5)) >= 3.2);
    if (unscopedPageQuery) continue;
    if (!directPageMatch && !exactTitleMatch && !singleTermSpecific && !numericSpecific && !informative) {
      // مسار احتياطي: عند غياب أي نتيجة تُعاد محاولة أوسع، مُعاد الترتيب بالدرجة
      // وحدها لا بقبول أي صفحة. مشروط بأن يكون الكتاب محدداً (الطالبة اختارت
      // الكتاب أو استُنتج من السؤال) وأن لا تكون الصفحة تمارين، وأن يكون
      // المصطلح المطابق نادراً فعلاً — فلا يفتح هذا المسار ضوضاءً.
      if (requestedBook && doc.bookId === requestedBook && !isExercisePage(doc)
        && matchedQueryTerms.length >= 1 && matchedWeight >= 4) {
        relaxed.push({ doc, score: score + matchedWeight + coverage * 2 });
      }
      continue;
    }
    if (normalized.length > 5 && doc.normalized.includes(normalized) && !staleOutlinePages.has(doc)) score += 8;
    const titleMatches = terms.reduce((count, term) => count + (titleNorm.includes(term) ? 1 : 0), 0);
    score += titleMatches * 2.4;
    if (requestedBook === doc.bookId) score += 1.5;
    if (referencePage && doc.bookId === requestedBook && doc.printedPage === referencePage) score += 30;
    if (doc.searchable) score += 0.6;
    if (doc.needsOcr) score -= 0.25;
    // صفحة التمارين تكرّر مصطلحات السؤال فتتقدّم على صفحة الشرح (ص43 الفقه
    // ‏33.8 بدل ص32 ‏32.3 قبل هذا). يُرجَّح المحتوى ما لم يكن السؤال عن تمارين.
    // الفارق المقيس بين الصفتين 1.5 درجة، فالعقوبة تتجاوزه بهامش واضح.
    if (isExercisePage(doc)) score += exerciseQuery ? 1.5 : -6;
    ranked.push({ doc, score });
  }
  const pool = ranked.length ? ranked : relaxed;
  const results = pool
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

function resolvedEvidenceStatus(doc, textVerdict, sourceEvidence) {
  if (textVerdict.empty) return 'no-text';
  if (textVerdict.damaged || doc.evidenceStatus === 'damaged-text'
    || sourceEvidence?.evidenceStatus === 'damaged-text') return 'damaged-text';
  // pdf-index metadata is the current provenance for its fullText and should
  // supersede an older search-index classification when both are available.
  if (sourceEvidence?.evidenceStatus === 'ocr-text') return 'ocr-text';
  if (sourceEvidence?.evidenceStatus === 'clean-extracted-text') return 'clean-extracted-text';
  if (doc.evidenceStatus === 'ocr-text') return 'ocr-text';
  return classifyPageEvidence(textVerdict.text, { fullText: doc.text, ocr: doc.ocr });
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
  const outlineSummary = usableOutlineSummary(doc.outlineSummary, { hasCurrentText: Boolean(text) });
  const usableOutline = outlineSummary;
  const currentSummary = reconcilePageMetadata(doc.summary, Boolean(text));
  const summary = compact(text ? (currentSummary || usableOutline) : (usableOutline || 'هذه الصفحة مصورة ولا يتوفر لها نص موثوق بعد.'), 700);
  // حكم الاستشهاد مشروط بفحص سلامة، لا يُقال «صالحة للاستشهاد» بلا دليل.
  // `quotation` أنظف نسخة متاحة بين نص الصفحة ووصفها الفهرسي بمقياس تلف فعلي.
  const textVerdict = assessText(text);
  const sourceEvidence = doc.evidenceStatus ? null : await getPdfPageEvidence(bookId, number);
  const evidenceStatus = resolvedEvidenceStatus(doc, textVerdict, sourceEvidence);
  const outlineVerdict = assessText(usableOutline);
  const quotation = chooseQuotation(textVerdict, outlineVerdict);
  // سبب الرفض يخص الاقتباس المقدَّم؛ فإن سَلِم ذاك تُذكر عوارض الطبقة الأخرى
  // وحدها منفصلةً ولا تبطل الاقتباس السليم.
  const damageReasons = quotation.reliable && evidenceStatus !== 'damaged-text'
    ? []
    : [...new Set([
        ...textVerdict.reasons,
        ...outlineVerdict.reasons,
        ...(evidenceStatus === 'damaged-text' && !textVerdict.damaged ? ['بيانات المصدر تشير إلى تلف في طبقة النص'] : []),
      ])];
  const outlineDamageReasons = outlineVerdict.damaged ? outlineVerdict.reasons : [];
  const damaged = !quotation.reliable || evidenceStatus === 'damaged-text';
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
    text: text || outlineSummary || compact(summary || 'هذه الصفحة مصورة ولا يتوفر لها نص قابل للاستخراج.', 4_000),
    // النص الأنظف فعلياً: يُقدَّم للاقتباس بدل `text` التالف متى كانت النسخة
    // الفهرسية سليمة (مقيس: 89/164 صفحة في العربية-جزء1 `text` مشوَّه).
    quotableText: quotation.text,
    quotableSource: quotation.source,
    quotableReliable,
    damageReasons,
    outlineDamageReasons,
    damaged,
    searchable: Boolean(text),
    // needsVision صار يعلن الصفحة فعلاً: لا نص، أو OCR مطلوب، أو نص مستخرج
    // ثبت تلفه (مقيس: 0 صفحة كانت تُعلَن قبل هذا الإصلاح).
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
    onTrace?.({ phase: 'page', bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true, evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null });
    tracePages.push({ bookTitle: hit.title, pageTitle: hit.pageTitle, printedPage: hit.printedPage, physicalPage: hit.physicalPage, needsVision: page ? page.needsVision : true, evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null });
    // الاقتباس يأتي من **أنظف نسخة متاحة** لا من `page.text` تالفاً: إن كان
    // النص المستخرج مشوَّهاً والوصف الفهرسي سليماً فالأوصاف هي المقروء.
    const quoteSource = page?.quotableSource || (page?.searchable ? 'pdf-text' : 'outline-description');
    const quoteText = page?.quotableText || page?.text || '';
    // النص الحرفي يُقتطع حول مصطلحات السؤال، والنسخة غير الحرفية تُقدَّم
    // كاملةً مكرَّصةً لأنها وصف لا نقل.
    const content = quoteSource === 'pdf-text'
      ? relevantExcerpt(quoteText, query)
      : compact(quoteText || `${hit.pageTitle}\n${hit.summary}\n${hit.preview}`, 2_200);
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
      status: page?.evidenceStatus || hit.evidenceStatus || null,
      evidenceStatus: page?.evidenceStatus || hit.evidenceStatus || null,
      evidenceType: page?.evidenceType || (hit.searchable ? 'pdf-text' : 'outline-description'),
      quotationSource: quoteSource,
      quotableReliable: page?.quotableReliable ?? hit.searchable,
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
    if (blocks.length && blocks.join('\n\n---\n\n').length + block.length + 9 > CONTEXT_CHARS) break;
    sources.push(source);
    blocks.push(block);
  }
  const block = blocks.join('\n\n---\n\n');
  return { sources, block, trace: { pages: tracePages } };
}
