import assert from 'node:assert';
import test from 'node:test';
import { catalogIntent, getOutline, listOutlineIds, outlineContext, structureIntent } from '../lib/outline.mjs';
import { resolveBook } from '../lib/index.mjs';

test('كشف نية أسئلة بنية المادة', () => {
  assert.equal(structureIntent('كم فصلا في كتاب الاقتصاد'), true);
  assert.equal(structureIntent('كم عدد دروس الرياضيات'), true);
  assert.equal(structureIntent('اعطني فهرس المادة'), true);
  assert.equal(structureIntent('محتويات كتاب التاريخ'), true);
  assert.equal(structureIntent('وش يحتوي الكتاب'), true);
  assert.equal(structureIntent('خطة دليل مدرس الأدب الإنكليزي'), true);
  assert.equal(structureIntent('اشرح لي قانون الطلب'), false);
  assert.equal(structureIntent('من هو جون أوستن'), false);
  assert.equal(structureIntent(''), false);
});

test('كشف سؤال الكتالوج الكامل', () => {
  assert.equal(catalogIntent('ما عندك من مواد'), true);
  assert.equal(catalogIntent('ماهي المواد المتاحة؟'), true);
  assert.equal(catalogIntent('وش عندكم من الكتب'), true);
  assert.equal(catalogIntent('اعطني كل المواد'), true);
  assert.equal(catalogIntent('ماذا كتب المؤلف؟'), false);
  assert.equal(catalogIntent('ما كتب الطالب في الدرس؟'), false);
  assert.equal(catalogIntent('ماذا يحتوي كتاب التاريخ'), false);
});

test('تحميل فهرس مادة موجودة', async () => {
  const outline = await getOutline('economics-sixth-literary-pdf');
  assert.ok(outline, 'outline should load');
  assert.equal(outline.entries, 112);
  assert.match(outline.header, /محتويات الكتاب/);
  assert.equal(outline.pages.at(-1).physicalPage, 112);
  assert.ok(outline.pages.some((page) => page.physicalPage === 63));
});

test('فهرس غير موجود يعيد null', async () => {
  assert.equal(await getOutline('missing-book'), null);
  assert.equal(await getOutline('../server'), null);
  assert.equal(await getOutline(''), null);
});

test('كتلة السياق تكبر مع نية البنية وتبقى محدودة', async () => {
  const outline = await getOutline('economics-sixth-literary-pdf');
  const plain = outlineContext(outline, { structure: false });
  const rich = outlineContext(outline, { structure: true });
  assert.ok(plain.includes('بطاقة المادة'));
  assert.ok(rich.length > plain.length);
  assert.match(rich, /خريطة الصفحات/);
  assert.match(rich, /ص63/);
  assert.ok(rich.length < 70_000, `rich=${rich.length}`);
});

test('قائمة الفهارس المتاحة', async () => {
  const ids = await listOutlineIds();
  assert.ok(ids.includes('english-literature-sixth-pdf'));
  assert.ok(ids.includes('economics-sixth-literary-pdf'));
  assert.ok(ids.includes('history-sixth-literary-pdf'));
});

test('كل فهرس وصفي يغطي صفحات كتابه دون فجوات', async () => {
  const ids = await listOutlineIds();
  for (const id of ids) {
    const outline = await getOutline(id);
    assert.ok(outline);
    assert.equal(outline.pages.length, outline.entries);
    assert.deepEqual(outline.pages.map((page) => page.physicalPage), Array.from({ length: outline.entries }, (_, index) => index + 1));
  }
});

test('تحديد كتاب المادة من السؤال أو من المادة المحددة', async () => {
  const byQuery = await resolveBook('اسئلة الاقتصاد والعرض والطلب');
  assert.equal(byQuery?.id, 'economics-sixth-literary-pdf');
  const byChapter = await resolveBook('اسئلة فصل التخلف والتنمية', { search: true });
  assert.equal(byChapter?.id, 'economics-sixth-literary-pdf');
  const bySubject = await resolveBook('سؤال عشوائي', { subject: 'التاريخ' });
  assert.equal(bySubject?.id, 'history-sixth-literary-pdf');
  const unrestricted = await resolveBook('القرآن');
  assert.equal(unrestricted?.id, 'islamic-sixth-preparatory-2025');
  const weak = await resolveBook('سؤال لا يحدد مادة', { search: true });
  assert.equal(weak ?? null, null);
  // الكتاب الرسمي يسبق دليل المدرس وكتاب التمارين عند تقارب التطابق
  assert.equal((await resolveBook('فهرس الأدب الإنكليزي'))?.id, 'english-literature-sixth-pdf');
  assert.equal((await resolveBook('خطة دليل مدرس الأدب الإنكليزي'))?.id, 'english-literature-teacher-guide-95722f85-pdf');
  assert.equal((await resolveBook('محتويات تمارين الأدب الإنكليزي'))?.id, 'english-literature-exercises-sixth-pdf');
});
