// يبني الفهرس canonical مرة واحدة من pdf-index.json.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, topKeywords, uniqueTokens } from '../lib/text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCE = path.join(LIBRARY, 'pdf-index.json');
const OUTPUT = path.join(LIBRARY, 'search-index.json');

function pageTitle(page) {
  const title = cleanText(page.title || '');
  if (title && title.length > 3 && !/indb|iraq_g12/i.test(title)) return title.slice(0, 140);
  const lines = cleanText(page.fullText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 4 && line.length < 120 && !/indb|iraq_g12/i.test(line));
  return (lines[0] || 'صفحة تعليمية').slice(0, 140);
}

function pageSummary(page, title) {
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

for (const book of raw.books || []) {
  books.push({
    id: book.id,
    title: cleanText(book.title),
    subject: cleanText(book.subject),
    branch: cleanText(book.branch || 'عام'),
    grade: cleanText(book.grade || 'السادس الإعدادي'),
    year: book.year || 2025,
    edition: cleanText(book.edition || ''),
    publisher: cleanText(book.publisher || ''),
    pageCount: book.pageCount || (book.pages || []).length,
    searchablePageCount: book.searchablePageCount || (book.pages || []).filter((page) => page.fullText).length,
    kind: book.referenceKind || 'official-textbook',
  });
  printed[book.id] = {};
  for (const page of book.pages || []) {
    const physicalPage = Number(page.physicalPage ?? page.pageNumber);
    const printedPage = Number.isInteger(page.printedPage ?? page.printedPageNumber)
      ? Number(page.printedPage ?? page.printedPageNumber)
      : null;
    if (printedPage != null) printed[book.id][printedPage] = physicalPage;
    const title = pageTitle(page);
    const summary = pageSummary(page, title);
    const preview = compact(page.fullText || '', 700);
    const normalized = normalizeAr(`${book.title} ${book.subject} ${title} ${page.section || ''} ${page.unit || ''} ${summary} ${preview}`);
    const terms = uniqueTokens(normalized);
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
      normalized: normalized.slice(0, 1_600),
      terms,
      keywords: topKeywords(`${title} ${summary} ${preview}`, 12),
      searchable: Boolean(page.fullText),
      needsOcr: Boolean(page.needsOcr || page.ocr?.required || !page.fullText),
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
