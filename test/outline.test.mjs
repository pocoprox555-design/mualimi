import assert from 'node:assert';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { digitClaims, getOutline, groundCountWords, groundText, listOutlineIds, outlineContext, structureIntent, unprovenClaims } from '../lib/outline.mjs';
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
  const unrestricted = await resolveBook('القرآن', { track: 'ديني' });
  assert.equal(unrestricted?.id, 'quran-readings-deni-sixth');
  const weak = await resolveBook('سؤال لا يحدد مادة', { search: true });
  assert.equal(weak ?? null, null);
  // الكتاب الرسمي يسبق دليل المدرس وكتاب التمارين عند تقارب التطابق
  assert.equal((await resolveBook('فهرس الأدب الإنكليزي'))?.id, 'english-literature-sixth-pdf');
  assert.equal((await resolveBook('خطة دليل مدرس الأدب الإنكليزي'))?.id, 'english-literature-teacher-guide-95722f85-pdf');
  assert.equal((await resolveBook('محتويات تمارين الأدب الإنكليزي'))?.id, 'english-literature-exercises-sixth-pdf');
});

// ── قاعدة الصدق: لا رقم بلا سند من نص الصفحة ────────────────────────────────

test('الأرقام تُقرأ بصيغتيها اللاتينية والعربية', () => {
  assert.deepEqual(digitClaims('سنة 1952م'), ['1952م']);
  assert.deepEqual(digitClaims('البقرة ١٥٣ و١٥٤'), ['153', '154']);
  assert.deepEqual(digitClaims('ص 137 (مطبوع 137)'), ['137', '137']);
});

test('رقم لا يثبته نص الصفحة يُحذف ولا يبقى منه أثر', () => {
  const evidence = { hasText: true, numbers: new Set(['195م', '2م', '1951م']) };
  const wrong = groundText('انتفاضة تشرين الثاني 1952م — أ: مقدمات', evidence);
  assert.ok(!wrong.text.includes('1952'), wrong.text);
  assert.ok(!wrong.text.includes('م —'), wrong.text);
  assert.deepEqual(wrong.dropped, ['1952م']);
  // رقم تثبته صفحة سليمة يبقى، وما لا يثبته يُحذف
  const proven = groundText('آذار 1951م — 5% من الأرباح', evidence);
  assert.ok(proven.text.includes('1951م'), proven.text);
  assert.deepEqual(proven.dropped, ['5']);
  // رقم الصفحة نفسها مسموح دائماً
  const folio = groundText('ينتهي في ص 137', evidence, { allow: ['137'] });
  assert.ok(folio.text.includes('137'));
});

test('العدد المكتوب بكلمة يُحذف إن لم يثبته النص، والاسم يبقى', () => {
  const withoutFive = { hasText: true, numbers: new Set(['153', '10', '170']) };
  const chapters = groundCountWords('ينقسم الكتاب إلى سبعة فصول', withoutFive);
  assert.ok(!chapters.text.includes('سبعة'), chapters.text);
  assert.ok(chapters.text.includes('فصول'), chapters.text);
  assert.deepEqual(chapters.dropped, ['7']);
  const units = groundCountWords('خمس وحدات', withoutFive);
  assert.ok(!units.text.includes('خمس'), units.text);
  assert.ok(units.text.includes('وحدات'));
  // عددٌ يقوله النص نفسه يبقى
  const withFive = { hasText: true, numbers: new Set(['5']) };
  const proven = groundCountWords('الوحدة الخامسة: من سورة الأنبياء', withFive);
  assert.ok(proven.text.includes('الخامسة'), proven.text);
  assert.deepEqual(proven.dropped, []);
});

test('ادعاءات الأرقام بلا سند تُحسب لكل صفحة', () => {
  const evidence = { hasText: true, numbers: new Set(['195م', '2م', '1951م']) };
  assert.deepEqual(unprovenClaims('تشرين الثاني 1952م', evidence), ['1952م']);
  assert.deepEqual(unprovenClaims('آذار 1951م', evidence), []);
  // بلا نصّ مستخرج: كل رقم بلا سند
  assert.deepEqual(unprovenClaims('الفهرس 28 مدخلاً', { hasText: false, numbers: new Set() }), ['28']);
});

test('outline لا يخرج رقماً لا يثبت من نص الصفحة في كل الكتب', async () => {
  const ids = await listOutlineIds();
  for (const id of ids) {
    const outline = await getOutline(id);
    assert.ok(outline, id);
    assert.equal(outline.diagnostics.evidenceSource, 'pdf-books', `${id}: لا دليل من pdf-books`);
    assert.ok(outline.diagnostics.pagesWithUnprovenNumbers <= outline.pages.length);
    // الدليل يُقرأ هنا مباشرة من pdf-books: كل رقم في الوصف يجب أن يثبت من نص صفحته.
    const book = JSON.parse(await readFile(new URL(`../curriculum-library/pdf-books/${id}.json`, import.meta.url), 'utf8'));
    const cores = (value) => digitClaims(value).map((digit) => digit.replace(/م$/, ''));
    const evidence = new Map(book.pages.map((page) => [Number(page.physicalPage), new Set(cores(page.fullText || ''))]));
    for (const page of outline.pages) {
      const own = new Set([String(page.physicalPage), String(page.printedPage || '')]);
      const proven = evidence.get(page.physicalPage) || new Set();
      const unproven = cores(page.description).filter((digit) => !own.has(digit) && !proven.has(digit));
      assert.equal(unproven.length, 0, `${id} p${page.physicalPage}: رقم بلا سند ${[...new Set(unproven)].join(',')}`);
    }
  }
});

test('الصفحة المصورة لا يُنسب إليها عدد فصول أو وحدات', async () => {
  const outline = await getOutline('islamic-sixth-preparatory-2025');
  const blind = outline.pages.filter((page) => page.evidence === 'no-text');
  assert.ok(blind.length > 0, 'يجب أن توجد صفحات بلا نص مستخرج');
  for (const page of blind) {
    assert.doesNotMatch(page.description, /ينقسم|يقسم|مقسّم/, `ص${page.physicalPage}: بنية غير مستخرجة`);
  }
  assert.ok(outline.diagnostics.pagesWithoutEvidence >= blind.length);
});

test('سنة خاطئة في outline تُحذف ولا تدخل الـprompt', async () => {
  // «انتفاضة تشرين الثاني 1952م» في ص137: نص الصفحة فيه «195م ٢» لا «1952م».
  const outline = await getOutline('history-sixth-literary-pdf');
  const page = outline.pages.find((entry) => entry.physicalPage === 137);
  assert.ok(page, 'ص137 موجودة في الفهرس');
  assert.ok(!page.title.includes('1952'), page.title);
  assert.ok(page.title.includes('تشرين الثاني'), page.title);
  const block = outlineContext(outline, { structure: true });
  assert.doesNotMatch(block, /تشرين الثاني 1952/);
});

test('البلاغة الخادعة: بنية الكتاب ووصفها لا يُحذف منه إلا ما لا يثبت', async () => {
  const outline = await getOutline('economics-sixth-literary-pdf');
  const page = outline.pages.find((entry) => entry.physicalPage === 4);
  assert.match(page.description, /الفصل/, 'اسم الوحدة يبقى');
  assert.match(page.description, /الخريطة الرسمية للفصول والمباحث/);
});
