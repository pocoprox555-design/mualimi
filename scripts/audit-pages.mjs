import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const REPORT_DIR = path.join(LIBRARY, 'reports');
const PLACEHOLDER = /تحتاج هذه الصفحة إلى القراءة البصرية|صفحة تحتاج OCR|صفحة مصورة تحتاج|صفحة مصورة$|لا نص مستخرج|غير قابل للاستخراج|لا يوجد عنوان|تحتاج قراءة بصرية/;
const JUNK = /indb|iraq_g12|\.indb|\d{2}\/\d{2}\/\d{4}/i;
const SHORT_TEXT = 40;

const issues = [];
const stats = {
  books: 0,
  pages: 0,
  searchable: 0,
  vision: 0,
  noText: 0,
  placeholders: 0,
  weakSummaries: 0,
  weakTitles: 0,
  junkMeta: 0,
  dumpTitles: 0,
  dumpSummaries: 0,
  flagMismatches: 0,
  dupSummaries: 0,
  dupTitles: 0,
  indexMismatches: 0,
  missingDocs: 0,
  weakDocs: 0,
  missingOutlines: 0,
};

function add(bookId, physicalPage, code, detail) {
  issues.push({ bookId, physicalPage, code, detail });
}

function textOf(page) {
  return String(page.fullText || '').trim();
}

function metaProblems(page) {
  const found = [];
  const title = String(page.title || '').trim();
  const summary = String(page.summary || '').trim();
  if (!title || title.length < 4) found.push('WEAK_TITLE');
  else if (PLACEHOLDER.test(title)) found.push('PLACEHOLDER_TITLE');
  if (!summary || summary.length < 40) found.push('WEAK_SUMMARY');
  else if (PLACEHOLDER.test(summary)) found.push('PLACEHOLDER_SUMMARY');
  if (JUNK.test(`${title} ${summary}`)) found.push('JUNK_META');
  return found;
}

const bookFiles = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json')).sort();
const books = [];
for (const name of bookFiles) books.push(JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8')));
stats.books = books.length;

const pdfIndex = JSON.parse(await readFile(path.join(LIBRARY, 'pdf-index.json'), 'utf8'));
const searchIndex = JSON.parse(await readFile(path.join(LIBRARY, 'search-index.json'), 'utf8'));

const outlineDir = path.join(LIBRARY, 'outlines');
const outlineCounts = {};
for (const name of (await readdir(outlineDir)).filter((file) => file.endsWith('.md'))) {
  const raw = await readFile(path.join(outlineDir, name), 'utf8');
  outlineCounts[name.replace(/\.md$/, '')] = (raw.match(/^### الصفحة الفيزيائية \d+/gm) || []).length;
}

const pdfIndexById = new Map(pdfIndex.books.map((book) => [book.id, book]));
const docsById = new Map(searchIndex.documents.map((doc) => [`${doc.bookId}:${doc.physicalPage}`, doc]));

for (const book of books) {
  stats.pages += book.pages.length;
  const indexBook = pdfIndexById.get(book.id);
  if (!indexBook) add(book.id, 0, 'INDEX_BOOK_MISSING', 'الكتاب غير موجود في pdf-index.json');
  if (outlineCounts[book.id] !== book.pages.length) {
    add(book.id, 0, 'OUTLINE_COUNT_MISMATCH', `مدخل الفهرس ${outlineCounts[book.id] ?? 0} مقابل صفحات ${book.pages.length}`);
  }

  for (const page of book.pages) {
    const physicalPage = Number(page.physicalPage);
    const text = textOf(page);
    const searchable = Boolean(page.searchable);
    const needsOcr = Boolean(page.needsOcr || page.ocr?.required);

    if (text.length >= SHORT_TEXT) stats.searchable += 1;
    else {
      stats.noText += 1;
      add(book.id, physicalPage, needsOcr ? 'NO_TEXT' : 'NO_TEXT_BUT_NOT_FLAGGED', `نص فارغ أو قصير (${text.length} حرف)`);
    }
    if (needsOcr) stats.vision += 1;

    if (searchable !== Boolean(text)) {
      stats.flagMismatches += 1;
      add(book.id, physicalPage, 'SEARCHABLE_FLAG_MISMATCH', `searchable=${searchable} مع نص ${text.length} حرف`);
    }
    if (needsOcr && text.length >= SHORT_TEXT) {
      stats.flagMismatches += 1;
      add(book.id, physicalPage, 'NEEDSOCR_FLAG_STALE', 'needsOcr مثبت رغم وجود نص');
    }
    if (!needsOcr && !page.ocr?.status) {
      add(book.id, physicalPage, 'OCR_STATUS_MISSING', 'لا يوجد ocr.status للصفحة غير المجتازة');
    }

    const problems = metaProblems(page);
    const flatText = text.replace(/\s+/g, ' ').trim();
    const flatSummary = String(page.summary || '').replace(/\s+/g, ' ').trim();
    const flatTitle = String(page.title || '').replace(/\s+/g, ' ').trim();
    if (flatText.length >= 40 && flatSummary && flatText.startsWith(flatSummary.slice(0, 60))) {
      problems.push('DUMP_SUMMARY');
      stats.dumpSummaries += 1;
    }
    if (flatText.length >= 40 && flatTitle && flatText.startsWith(flatTitle.slice(0, 60))) {
      problems.push('DUMP_TITLE');
      stats.dumpTitles += 1;
    }
    for (const code of problems) {
      if (code === 'WEAK_SUMMARY' || code === 'PLACEHOLDER_SUMMARY') stats.weakSummaries += 1;
      else if (code === 'WEAK_TITLE' || code === 'PLACEHOLDER_TITLE') stats.weakTitles += 1;
      else if (code === 'JUNK_META') stats.junkMeta += 1;
      if (code.startsWith('PLACEHOLDER')) stats.placeholders += 1;
      add(book.id, physicalPage, code, `${String(page.title || '').slice(0, 60)} | ${String(page.summary || '').slice(0, 80)}`);
    }

    const indexPage = indexBook?.pages.find((entry) => Number(entry.physicalPage) === physicalPage);
    if (!indexPage) add(book.id, physicalPage, 'INDEX_PAGE_MISSING', 'الصفحة غير موجودة في pdf-index.json');
    else if (JSON.stringify(indexPage) !== JSON.stringify(page)) {
      stats.indexMismatches += 1;
      add(book.id, physicalPage, 'INDEX_PAGE_STALE', 'الصفحة في pdf-index.json تختلف عن pdf-books');
    }

    const doc = docsById.get(`${book.id}:${physicalPage}`);
    if (!doc) {
      stats.missingDocs += 1;
      add(book.id, physicalPage, 'SEARCH_DOC_MISSING', 'لا توجد وثيقة في search-index.json');
    } else {
      if (String(doc.title || '').length <= 2 || String(doc.summary || '').length < 20) {
        stats.weakDocs += 1;
        add(book.id, physicalPage, 'SEARCH_DOC_WEAK_META', `title=${String(doc.title).slice(0, 40)} summary=${String(doc.summary).slice(0, 60)}`);
      }
      if (Boolean(doc.searchable) !== Boolean(text)) {
        add(book.id, physicalPage, 'SEARCH_DOC_FLAG_MISMATCH', `doc.searchable=${doc.searchable} مع نص ${text.length} حرف`);
      }
      if (text.length >= SHORT_TEXT && !String(doc.preview || '').trim()) {
        add(book.id, physicalPage, 'SEARCH_DOC_EMPTY_PREVIEW', 'preview فارغ مع وجود نص');
      }
      if (text.length >= SHORT_TEXT && (!Array.isArray(doc.terms) || doc.terms.length === 0)) {
        add(book.id, physicalPage, 'SEARCH_DOC_NO_TERMS', 'لا مصطلحات مفهرسة للصفحة');
      }
    }

    const outlineEntryCount = outlineCounts[book.id] || 0;
    if (outlineEntryCount !== book.pages.length) stats.missingOutlines += 0;
    if (physicalPage && outlineEntryCount === 0) add(book.id, physicalPage, 'OUTLINE_FILE_MISSING', 'لا يوجد ملف فهرس مادة');
  }
}

const orphanDocs = searchIndex.documents.filter(
  (doc) => !books.some((book) => book.id === doc.bookId && book.pages.some((page) => Number(page.physicalPage) === Number(doc.physicalPage))),
);
for (const doc of orphanDocs) add(doc.bookId, doc.physicalPage, 'SEARCH_DOC_ORPHAN', 'وثيقة في الفهرس بلا صفحة مقابلة');

for (const book of books) {
  const bySummary = new Map();
  const byTitle = new Map();
  for (const page of book.pages) {
    const summary = String(page.summary || '').replace(/\s+/g, ' ').trim();
    const title = String(page.title || '').replace(/\s+/g, ' ').trim();
    if (summary) (bySummary.get(summary) || bySummary.set(summary, []).get(summary)).push(Number(page.physicalPage));
    if (title) (byTitle.get(title) || byTitle.set(title, []).get(title)).push(Number(page.physicalPage));
    if (summary && title && summary === title) add(book.id, Number(page.physicalPage), 'TITLE_EQUALS_SUMMARY', title.slice(0, 80));
  }
  for (const [summary, pages] of bySummary) {
    if (pages.length > 1) {
      stats.dupSummaries += pages.length;
      for (const page of pages) add(book.id, page, 'DUP_SUMMARY_SAME_BOOK', `صفحات ${pages.join(',')} · ${summary.slice(0, 70)}`);
    }
  }
  for (const [title, pages] of byTitle) {
    if (pages.length > 3) {
      stats.dupTitles += pages.length;
      for (const page of pages) add(book.id, page, 'DUP_TITLE_SAME_BOOK', `${pages.length} صفحات بعنوان واحد: ${title.slice(0, 60)}`);
    }
  }
}

const byCode = {};
for (const issue of issues) byCode[issue.code] = (byCode[issue.code] || 0) + 1;
const byBook = {};
for (const issue of issues) {
  (byBook[issue.bookId] ||= {});
  byBook[issue.bookId][issue.code] = (byBook[issue.bookId][issue.code] || 0) + 1;
}

const report = {
  builtAt: new Date().toISOString(),
  stats: {
    ...stats,
    expectedPages: 1456,
    searchIndexDocuments: searchIndex.documents.length,
    searchIndexStats: searchIndex.stats,
    issues: issues.length,
  },
  byCode,
  byBook,
  issues,
};

await mkdir(REPORT_DIR, { recursive: true });
const out = path.join(REPORT_DIR, 'pages-audit.json');
await writeFile(out, `${JSON.stringify(report, null, 1)}\n`);

console.log('=== تدقيق الصفحات ===');
console.log(`كتب: ${stats.books} · صفحات: ${stats.pages} · قابلة للبحث: ${stats.searchable} · بلا نص: ${stats.noText} · تحتاج رؤية: ${stats.vision}`);
console.log(`وثائق search-index: ${searchIndex.documents.length} · إحصاء الفهرس: ${JSON.stringify(searchIndex.stats)}`);
console.log(`مشكلات: ${issues.length}`);
for (const [code, count] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${count}`);
}
console.log('\nتفصيل حسب الكتاب:');
for (const [bookId, codes] of Object.entries(byBook)) {
  const total = Object.values(codes).reduce((sum, count) => sum + count, 0);
  console.log(`  ${bookId}: ${total} — ${Object.entries(codes).map(([code, count]) => `${code}=${count}`).join(' ')}`);
}
console.log(`\nالتقرير: ${out}`);
if (issues.length) process.exitCode = 1;
