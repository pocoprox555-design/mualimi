import assert from 'node:assert';
import test from 'node:test';
import { getIndex, search, locate, listBooks, fullPage } from '../lib/index.mjs';

test('الفهرس متكامل: 12 كتابًا وكل الصفحات', async () => {
  const idx = await getIndex();
  assert.equal(idx.books.length, 12);
  assert.ok(idx.pages.length >= 1400, `pages=${idx.pages.length}`);
  for (const p of idx.pages) {
    assert.ok(p.t && p.t.length > 2, 'title');
    assert.ok(p.s && p.s.length >= 20, 'explanation');
  }
});

test('البحث فوري ودقيق', async () => {
  const t = Date.now();
  const r = await search('أحكام التلاوة', { limit: 5 });
  assert.ok(Date.now() - t < 2000, 'fast');
  assert.ok(r.length > 0);
  assert.ok(r[0].explanation.length >= 20);
});

test('صفحة مصورة ترجع شرحًا بدل الفراغ', async () => {
  const pg = await fullPage('islamic-sixth-preparatory-2025', 6);
  assert.ok(pg.text.length > 20, 'explanation fallback');
  assert.equal(pg.needsVision, true);
});
test('خريطة مطبوع→فيزيائي تعمل', async () => {
  const phys = await locate('islamic-sixth-preparatory-2025', 6);
  assert.equal(phys, 6);
  const books = await listBooks();
  assert.equal(books.length, 12);
});
