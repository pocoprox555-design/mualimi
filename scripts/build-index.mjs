// يبني الفهرس canonical مرة واحدة من pdf-index.json.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, topKeywords, searchTokens, uniqueTokens } from '../lib/text.mjs';
import { getOutline } from '../lib/outline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCE = path.join(LIBRARY, 'pdf-index.json');
const OUTPUT = path.join(LIBRARY, 'search-index.json');
const ENRICHMENT_DIR = path.join(LIBRARY, 'enrichment');
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
// حروف الطباعة تعلو كل صفحة مطبعة من المصانع وتفسد التوكنات والكلمات المفتاحية.
const PRESS_FILE = /IRAQ_G\d+_[A-Z]{2,4}_\d{4}\.indb/gi;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;
// رقم الصفحة المطبوع يلتصق بأول سطر من النص المستخرج («115 Act 1, Scene 1 …»).
const LEADING_FOLIO = /^\s*\d{1,4}\s+/;

function stripPressSlab(value) {
  return cleanText(value)
    .replace(PRESS_FILE, ' ')
    .replace(PRESS_STAMP, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// رقم الصفحة المطبوع يلتصق بأول سطر من النص المستخرج، وقد يتكرر («178 178 Appendix A …»).
function stripLeadingFolio(value, printedPage) {
  if (!printedPage) return value;
  let out = value;
  let previous;
  do {
    previous = out;
    const match = out.match(LEADING_FOLIO);
    if (match && Number(match[0].trim()) === printedPage) out = out.slice(match[0].length).trim();
  } while (out !== previous);
  return out;
}

// رقم الصفحة المطبوع يُلصق في ذيل الصفحة أيضًا («… something 109 109»). لا يُمسّ رقم مفرد
// حتى لا نأكل رقماً حقيقياً في نهاية صفحة حسابية.
function stripTrailingFolio(value, printedPage) {
  if (!printedPage) return value;
  let out = value.trimEnd();
  let stripped = 0;
  while (stripped < 2) {
    const match = out.match(/\s(\d{1,4})$/);
    if (!match || Number(match[1]) !== printedPage) break;
    out = out.slice(0, match.index).trimEnd();
    stripped += 1;
  }
  return stripped >= 2 ? out : value;
}

function usableText(value) {
  const text = stripPressSlab(value || '');
  return text.length >= 20 && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

// معاينة تُظهر بداية الصفحة وآخرها بدل قصّها في منتصف كلمة، مع إعلان صريح عن المحذوف.
const PREVIEW_HEAD = 700;
const PREVIEW_TAIL = 400;
function buildPreview(value) {
  if (value.length <= PREVIEW_HEAD + PREVIEW_TAIL) return value;
  const head = value.slice(0, PREVIEW_HEAD);
  const tail = value.slice(-PREVIEW_TAIL);
  const omitted = value.length - PREVIEW_HEAD - PREVIEW_TAIL;
  return `${head} …[تم حذف ${omitted} حرفاً من هذه الصفحة؛ النص الكامل في الحقل text]… ${tail}`;
}

async function loadEnrichment() {
  const all = new Map();
  let files;
  try { files = (await readdir(ENRICHMENT_DIR)).filter((name) => name.endsWith('.json')).sort(); } catch { return all; }
  for (const name of files) {
    const bookId = name.replace(/\.json$/, '');
    const raw = JSON.parse(await readFile(path.join(ENRICHMENT_DIR, name), 'utf8'));
    if (raw.schemaVersion !== 1 || raw.bookId !== bookId) continue;
    all.set(bookId, raw.pages || {});
  }
  return all;
}

function usableMetadata(value) {
  const text = cleanText(value || '');
  return text && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

function usefulOutlineValue(value) {
  return cleanText(value || '') && !/(غير واضح|لا يوجد عنوان|لا نص مستخرج|تحتاج قراءة بصرية)/.test(value);
}

function pageTitle(page, outlinePage) {
  const outlineTitle = usableMetadata(outlinePage?.title);
  if (usefulOutlineValue(outlineTitle) && outlineTitle.length > 3) return outlineTitle.slice(0, 140);
  const title = usableMetadata(page.title);
  if (title && title.length > 3 && !/indb|iraq_g12/i.test(title)) return title.slice(0, 140);
  const lines = usableText(page.fullText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 4 && line.length < 120 && !/indb|iraq_g12/i.test(line));
  return (lines[0] || 'صفحة تعليمية').slice(0, 140);
}

function pageSummary(page, title, outlineSummary, fullText) {
  if (!fullText && usefulOutlineValue(outlineSummary)) return compact(outlineSummary, 520);
  const reviewed = compact(usableMetadata(page.summary), 420);
  if (reviewed.length >= 40 && !/indb|iraq_g12/i.test(reviewed)) return reviewed;
  const text = fullText.replace(/\s+/g, ' ');
  if (!text) return 'صفحة مصورة تحتاج قراءة بصرية؛ لا يوجد نص مستخرج منها.';
  const sentences = text
    .split(/(?<=[.!؟?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24 && !/indb|iraq_g12/i.test(sentence));
  return compact([title && `تتناول: ${title}.`, sentences.slice(0, 2).join(' ')].filter(Boolean).join(' '), 420) || 'محتوى تعليمي من الكتاب المدرسي.';
}

const raw = JSON.parse(await readFile(SOURCE, 'utf8'));
const enrichment = await loadEnrichment();
const books = [];
const documents = [];
const printed = {};
const documentFrequency = {};
let outlinePages = 0;
let enrichedPages = 0;

function printedPageFor(bookId, physicalPage, current) {
  if (Number.isInteger(current)) return current;
  // هذه التحويلات مثبتة في ترويسات الفهارس من تذييل PDF، وتغطي ما لم يلتقطه parser القديم.
  if (bookId === 'student-book-sixth-pdf') {
    if (physicalPage <= 35) return physicalPage + 4;
    if (physicalPage <= 90) return physicalPage + 5;
    return physicalPage + 6;
  }
  if (bookId === 'student-activity-sixth-pdf') return physicalPage + 3;
  if (bookId === 'history-sixth-literary-pdf' && physicalPage >= 3) return physicalPage;
  return null;
}

// الحقول المنظّمة تأتي من التغذية البصرية؛ ما لم تُغطَّ فيه يبقى من المستخرِج.
function applyEnrichment(doc, extra) {
  if (!extra) return doc;
  const assign = (key, value) => {
    if (value == null) return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'string' && !value.trim()) return;
    doc[key] = value;
  };
  for (const key of ['unit', 'work', 'author', 'section', 'sectionPath', 'actScene', 'pageType', 'title', 'titleEn', 'summary', 'summaryEn', 'answerKeyLocation', 'continuesOn', 'recapOf', 'notes', 'vocabulary']) {
    assign(key, extra[key]);
  }
  for (const key of ['glossary', 'glossaryRefs', 'figures', 'activities', 'exercises']) {
    assign(key, extra[key]);
  }
  // `educationalPurpose` في المصدر نص جاهز مرتبط بـ pageType القديم؛ الصفحة المُغذّاة لها وصف حقيقي بدلها.
  if (!doc.purpose) doc.purpose = '';
  doc.enriched = true;
  enrichedPages += 1;
  return doc;
}
for (const book of raw.books || []) {
  const pages = book.pages || [];
  const outline = await getOutline(book.id);
  const outlineByPage = new Map((outline?.pages || []).map((page) => [page.physicalPage, page]));
  outlinePages += outlineByPage.size;
  const bookEnrichment = enrichment.get(book.id) || {};
  const searchablePageCount = pages.filter((page) => Boolean(usableText(page.fullText))).length;
  books.push({
    id: book.id,
    title: cleanText(book.title),
    subject: cleanText(book.subject),
    branch: cleanText(book.branch || 'عام'),
    track: cleanText(book.track || book.branch || 'عام'),
    supplementary: Boolean(book.supplementary),
    grade: cleanText(book.grade || 'السادس الإعدادي'),
    year: book.year === undefined ? 2025 : book.year,
    edition: cleanText(book.edition || ''),
    publisher: cleanText(book.publisher || ''),
    pageCount: book.pageCount || pages.length,
    searchablePageCount,
    visionPageCount: pages.length - searchablePageCount,
    kind: book.referenceKind || 'official-textbook',
    enrichedPageCount: Object.keys(bookEnrichment).length,
    enriched: Object.keys(bookEnrichment).length > 0,
  });
  printed[book.id] = {};
  for (const page of pages) {
    const physicalPage = Number(page.physicalPage ?? page.pageNumber);
    const outlinePage = outlineByPage.get(physicalPage);
    const printedPage = printedPageFor(book.id, physicalPage, Number.isInteger(page.printedPage ?? page.printedPageNumber)
      ? Number(page.printedPage ?? page.printedPageNumber)
      : null);
    if (printedPage != null) printed[book.id][printedPage] = physicalPage;
    const outlineSummary = compact(outlinePage?.description || '', 2_200);
    const fullText = stripTrailingFolio(stripLeadingFolio(usableText(page.fullText), printedPage), printedPage);
    const title = pageTitle({ ...page, fullText }, outlinePage);
    const summary = pageSummary(page, title, outlineSummary, fullText);
    const preview = buildPreview(fullText);
    const extra = bookEnrichment[physicalPage];
    // تسميات المحتوى المنظّم تُفهرس ككلمات، فيصل سؤال «ما معنى...» أو «التمرين D» إلى صفحته.
    const figureText = (extra?.figures || []).map((figure) => [
      'صورة', figure.kind || '', figure.caption || '', figure.description || '', (figure.figureText || []).join(' '),
    ].join(' ')).join('\n');
    const glossaryText = ['مفردات معجم', (extra?.glossary || []).map((entry) => `${entry.term} ${entry.pos || ''} ${entry.definition}`).join(' ')].join('\n');
    const activityText = ['نشاط تمارين', (extra?.activities || []).flatMap((activity) => [
      activity.type || '', activity.instruction || '', activity.answerFormat || '',
      activity.dispatch ? `${activity.dispatch.target} ${activity.dispatch.printedFrom} ${activity.dispatch.printedTo}` : '',
      ...(activity.questions || []),
    ].join(' ')).join('\n')].join('\n');
    const exerciseText = ['تمارين', (extra?.exercises || []).map((exercise) => [
      `التمرين ${exercise.letter || ''}`, exercise.instruction || '',
      ...(exercise.items || []).map((item) => `${item.kind || ''} ${item.stem || ''}`),
    ].join(' ')).join('\n')].join('\n');
    const searchableText = [
      book.title,
      book.subject,
      title,
      extra?.section || page.section || '',
      extra?.unit || page.unit || '',
      extra?.work || '',
      extra?.author || '',
      extra?.sectionPath || '',
      summary,
      fullText,
      outlineSummary,
      figureText,
      glossaryText,
      activityText,
      exerciseText,
    ].join('\n');
    const normalized = normalizeAr(searchableText);
    const terms = uniqueTokens(searchableText);
    const indexedTerms = searchTokens(searchableText);
    const id = `${book.id}:${physicalPage}`;
    const doc = {
      id,
      bookId: book.id,
      physicalPage,
      printedPage,
      pageOffset: printedPage == null ? null : printedPage - physicalPage,
      title,
      section: cleanText(extra?.section || page.section || ''),
      unit: cleanText(extra?.unit || page.unit || ''),
      pageType: cleanText(extra?.pageType || page.pageType || ''),
      purpose: cleanText(page.educationalPurpose || ''),
      summary,
      preview,
      text: fullText,
      textLength: fullText.length,
      normalized,
      terms,
      keywords: topKeywords(searchableText, 12).filter((word) => !/^\d+$/.test(word)),
      searchable: Boolean(fullText),
      needsOcr: Boolean(page.needsOcr || page.ocr?.required || !fullText),
      outlineSummary,
      enriched: false,
    };
    applyEnrichment(doc, extra);
    const docIndex = documents.push(doc) - 1;
    for (const term of indexedTerms) {
      if (!documentFrequency[term]) documentFrequency[term] = 0;
      documentFrequency[term] += 1;
      doc._index = docIndex;
    }
  }
}

const postings = {};
for (let id = 0; id < documents.length; id += 1) {
  for (const term of documents[id].terms) (postings[term] ||= []).push(id);
}
for (const doc of documents) delete doc._index;

const output = {
  schemaVersion: 4,
  builtAt: new Date().toISOString(),
  sourceOfTruth: 'curriculum-library/pdf-sources',
  stats: {
    books: books.length,
    pages: documents.length,
    indexedPages: documents.filter((doc) => doc.searchable || doc.summary).length,
    searchablePages: documents.filter((doc) => doc.searchable).length,
    visionPages: documents.filter((doc) => doc.needsOcr).length,
    outlinePages,
    terms: Object.keys(postings).length,
    enrichedPages,
    enrichedBooks: books.filter((book) => book.enriched).length,
    fullTextPages: documents.filter((doc) => doc.textLength > 0).length,
    fullTextChars: documents.reduce((sum, doc) => sum + doc.textLength, 0),
    structuredPages: documents.filter((doc) => doc.figures?.length || doc.glossary?.length || doc.exercises?.length).length,
    figures: documents.reduce((sum, doc) => sum + (doc.figures?.length || 0), 0),
    glossaryEntries: documents.reduce((sum, doc) => sum + (doc.glossary?.length || 0), 0),
  },
  books,
  documents,
  postings,
  documentFrequency,
  printed,
};

await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`search-index: ${books.length} books, ${documents.length} pages, ${Object.keys(postings).length} terms -> ${OUTPUT}`);
console.log(`  full text: ${output.stats.fullTextPages} pages / ${output.stats.fullTextChars} chars · enriched: ${enrichedPages} pages across ${output.stats.enrichedBooks} books · figures: ${output.stats.figures} · glossary: ${output.stats.glossaryEntries}`);
