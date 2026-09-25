import assert from 'node:assert';
import test from 'node:test';
import { getOutline, listOutlineIds, outlineContext, structureIntent } from '../lib/outline.mjs';
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
  assert.ok(rich.length < 8000, `rich=${rich.length}`);
});

test('قائمة الفهارس المتاحة', async () => {
  const ids = await listOutlineIds();
  assert.ok(ids.includes('english-literature-sixth-pdf'));
  assert.ok(ids.includes('economics-sixth-literary-pdf'));
  assert.ok(ids.includes('history-sixth-literary-pdf'));
});

test('تحديد كتاب المادة من السؤال أو من المادة المحددة', async () => {
  const byQuery = await resolveBook('اسئلة الاقتصاد والعرض والطلب', { branch: 'أدبي' });
  assert.equal(byQuery?.id, 'economics-sixth-literary-pdf');
  const byChapter = await resolveBook('اسئلة فصل التخلف والتنمية', { branch: 'أدبي', search: true });
  assert.equal(byChapter?.id, 'economics-sixth-literary-pdf');
  const bySubject = await resolveBook('سؤال عشوائي', { branch: 'أدبي', subject: 'التاريخ' });
  assert.equal(bySubject?.id, 'history-sixth-literary-pdf');
  const outsideBranch = await resolveBook('القرآن', { branch: 'أدبي', subject: 'الاقتصاد' });
  assert.equal(outsideBranch?.id, 'economics-sixth-literary-pdf');
  const weak = await resolveBook('سؤال لا يحدد مادة', { branch: 'أدبي', search: true });
  assert.equal(weak ?? null, null);
  // الكتاب الرسمي يسبق دليل المدرس وكتاب التمارين عند تقارب التطابق
  assert.equal((await resolveBook('فهرس الأدب الإنكليزي', { branch: 'أدبي' }))?.id, 'english-literature-sixth-pdf');
  assert.equal((await resolveBook('خطة دليل مدرس الأدب الإنكليزي', { branch: 'أدبي' }))?.id, 'english-literature-teacher-guide-95722f85-pdf');
  assert.equal((await resolveBook('محتويات تمارين الأدب الإنكليزي', { branch: 'أدبي' }))?.id, 'english-literature-exercises-sixth-pdf');
});
