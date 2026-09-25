// يبني الفهرس canonical مرة واحدة من pdf-index.json.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, topKeywords, uniqueTokens } from '../lib/text.mjs';
import { getOutline } from '../lib/outline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCE = path.join(LIBRARY, 'pdf-index.json');
const OUTPUT = path.join(LIBRARY, 'search-index.json');

function usefulOutlineValue(value) {
  return cleanText(value || '') && !/(غير واضح|لا يوجد عنوان|لا نص مستخرج|تحتاج قراءة بصرية)/.test(value);
}

function pageTitle(page, outlinePage) {
  const outlineTitle = cleanText(outlinePage?.title || '');
  if (usefulOutlineValue(outlineTitle) && outlineTitle.length > 3) return outlineTitle.slice(0, 140);
  const title = cleanText(page.title || '');
  if (title && title.length > 3 && !/indb|iraq_g12/i.test(title)) return title.slice(0, 140);
  const lines = cleanText(page.fullText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 4 && line.length < 120 && !/indb|iraq_g12/i.test(line));
  return (lines[0] || 'صفحة تعليمية').slice(0, 140);
}

function pageSummary(page, title, outlineSummary) {
  if (!page.fullText && usefulOutlineValue(outlineSummary)) return compact(outlineSummary, 520);
  const reviewed = compact(page.summary || '', 420);
  if (reviewed.length >= 40 && !/indb|iraq_g12/i.test(reviewed)) return reviewed;
  const text = cleanText(page.fullText || '').replace(/\s+/g, ' ');
  if (!text) return 'صفحة مصورة تحتاج قراءة بصرية؛ لا يوجد نص مستخرج منها.';
  const sentences = text
    .split(/(?<=[.!؟?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 24 && !/indb|iraq_g12/i.test(sentence));
  return compact([title && `تتناول: ${title}.`, sentences.slice(0, 2).join(' ')].filter(Boolean).join(' '), 420) || 'محتوى تعليمي من الكتاب المدرسي.';
}

const raw = JSON.parse(await readFile(SOURCE, 'utf8'));
const books = [];
const documents = [];
const printed = {};
const documentFrequency = {};
let outlinePages = 0;

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

for (const book of raw.books || []) {
  const pages = book.pages || [];
  const outline = await getOutline(book.id);
  const outlineByPage = new Map((outline?.pages || []).map((page) => [page.physicalPage, page]));
  outlinePages += outlineByPage.size;
  const searchablePageCount = pages.filter((page) => Boolean(page.fullText)).length;
  books.push({
    id: book.id,
    title: cleanText(book.title),
    subject: cleanText(book.subject),
    branch: cleanText(book.branch || 'عام'),
    grade: cleanText(book.grade || 'السادس الإعدادي'),
    year: book.year || 2025,
    edition: cleanText(book.edition || ''),
    publisher: cleanText(book.publisher || ''),
    pageCount: book.pageCount || pages.length,
    searchablePageCount,
    visionPageCount: pages.length - searchablePageCount,
    kind: book.referenceKind || 'official-textbook',
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
    const title = pageTitle(page, outlinePage);
    const summary = pageSummary(page, title, outlineSummary);
    const preview = compact(page.fullText || '', 1_200);
    const searchableText = [
      book.title,
      book.subject,
      title,
      page.section || '',
      page.unit || '',
      summary,
      page.fullText || '',
      outlineSummary,
    ].join('\n');
    const normalized = normalizeAr(searchableText);
    const terms = uniqueTokens(searchableText);
    const id = `${book.id}:${physicalPage}`;
    const doc = {
      id,
      bookId: book.id,
      physicalPage,
      printedPage,
      title,
      section: cleanText(page.section || ''),
      unit: cleanText(page.unit || ''),
      pageType: cleanText(page.pageType || ''),
      purpose: cleanText(page.educationalPurpose || ''),
      summary,
      preview,
      normalized: normalized.slice(0, 4_000),
      terms,
      keywords: topKeywords(`${title} ${summary} ${preview}`, 12),
      searchable: Boolean(page.fullText),
      needsOcr: Boolean(page.needsOcr || page.ocr?.required || !page.fullText),
      outlineSummary,
    };
    const docIndex = documents.push(doc) - 1;
    for (const term of terms) {
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
  schemaVersion: 3,
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
  },
  books,
  documents,
  postings,
  documentFrequency,
  printed,
};

await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`search-index: ${books.length} books, ${documents.length} pages, ${Object.keys(postings).length} terms -> ${OUTPUT}`);
