import assert from 'node:assert';
import test from 'node:test';
import { getCatalog, getHealth, getIndex, getSubjects, listBooks, locate, fullPage, retrieveContext, search } from '../lib/index.mjs';

test('الفهرس canonical متكامل', async () => {
  const index = await getIndex();
  const health = await getHealth();
  assert.equal(index.schemaVersion, 3);
  assert.equal(index.books.length, 12);
  assert.ok(index.documents.length >= 1400, `documents=${index.documents.length}`);
  assert.ok(index.postings.size >= 10_000);
  assert.equal(health.pages, index.documents.length);
  assert.ok(index.documents.every((page) => page.title.length > 2 && page.summary.length >= 20));
  assert.equal(health.searchablePages, 1241);
  assert.equal(health.visionPages, 215);
  assert.equal(health.outlinePages, 1456);
  assert.equal(health.printedPageGaps, 16);
});

test('البحث المقلوب سريع ودقيق', async () => {
  const started = Date.now();
  const results = await search('أحكام التلاوة', { limit: 5 });
  assert.ok(Date.now() - started < 2000, 'fast');
  assert.ok(results.length > 0);
  assert.equal(results[0].bookId, 'islamic-sixth-preparatory-2025');
  assert.ok(results[0].summary.length >= 20);
});

test('السؤال الذي يحتوي مادة وصفحة يرفع الصفحة الصحيحة', async () => {
  const results = await search('اشرح صفحة 6 من كتاب التربية الاسلامية', { limit: 3 });
  assert.equal(results[0].bookId, 'islamic-sixth-preparatory-2025');
  assert.equal(results[0].printedPage, 6);
});

test('الصفحة المصورة ترجع ملخصا بدل الفراغ', async () => {
  const page = await fullPage('islamic-sixth-preparatory-2025', 6);
  assert.ok(page.text.length > 20);
  assert.equal(page.needsVision, true);
});

test('خريطة المطبوع إلى الفيزيائي والمصادر تعمل', async () => {
  assert.equal(await locate('islamic-sixth-preparatory-2025', 6), 6);
  assert.equal(await locate('student-book-sixth-pdf', 5), 1);
  assert.equal(await locate('student-activity-sixth-pdf', 4), 1);
  assert.equal(await locate('history-sixth-literary-pdf', 204), 204);
  const books = await listBooks();
  assert.ok(books.some((book) => book.subject === 'التاريخ'));
  assert.equal(books.length, (await listBooks()).length);
  const subjects = await getSubjects();
  assert.ok(subjects.includes('الرياضيات'));
  const context = await retrieveContext('اشرح أسلوب الاستفهام', { limit: 3 });
  assert.ok(context.sources.length > 0);
  assert.match(context.block, /\[S1\]/);
});

test('الكتالوج يعيد كل الكتب ولا يتحول إلى بحث صفحات', async () => {
  const catalog = await getCatalog();
  assert.equal(catalog.books.length, 12);
  assert.equal(catalog.pages, 1456);
  assert.equal(catalog.searchablePages, 1241);
  assert.equal(new Set(catalog.subjects).size, 10);
  assert.ok(catalog.books.some((book) => book.id === 'student-activity-sixth-pdf'));
});

test('البحث يصل إلى نص الصفحة بعد أول 700 حرف', async () => {
  const results = await search('المستنصرية', { limit: 10 });
  assert.ok(results.some((result) => result.bookId === 'arabic-sixth-preparatory-part-1-2025' && result.physicalPage === 6));
});

test('كل صفحة PDF لها سجل قابل للفتح', async () => {
  const index = await getIndex();
  for (const document of index.documents) {
    const page = await fullPage(document.bookId, document.physicalPage);
    assert.equal(page.bookId, document.bookId);
    assert.equal(page.physicalPage, document.physicalPage);
  }
});

test('الصفحة المصورة تظل معلّمة حتى مع وجود وصف فهرسي', async () => {
  const page = await fullPage('islamic-sixth-preparatory-2025', 2);
  assert.equal(page.searchable, false);
  assert.equal(page.needsVision, true);
  assert.equal(page.evidenceType, 'outline-description');
});
