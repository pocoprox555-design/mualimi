import assert from 'node:assert';
import test from 'node:test';
import { getHealth, getIndex, getSubjects, listBooks, locate, fullPage, retrieveContext, search } from '../lib/index.mjs';

test('الفهرس canonical متكامل', async () => {
  const index = await getIndex();
  const health = await getHealth();
  assert.equal(index.schemaVersion, 3);
  assert.equal(index.books.length, 12);
  assert.ok(index.documents.length >= 1400, `documents=${index.documents.length}`);
  assert.ok(index.postings.size >= 10_000);
  assert.equal(health.pages, index.documents.length);
  assert.ok(index.documents.every((page) => page.title.length > 2 && page.summary.length >= 20));
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
  const books = await listBooks({ branch: 'أدبي' });
  assert.ok(books.some((book) => book.subject === 'التاريخ'));
  const subjects = await getSubjects();
  assert.ok(subjects.includes('الرياضيات'));
  const context = await retrieveContext('اشرح أسلوب الاستفهام', { limit: 3 });
  assert.ok(context.sources.length > 0);
  assert.match(context.block, /\[S1\]/);
});
