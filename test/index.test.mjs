import assert from 'node:assert';
import test from 'node:test';
import { getCatalog, getHealth, getIndex, getSubjects, listBooks, locate, fullPage, resolveBook, retrieveContext, search } from '../lib/index.mjs';

test('الفهرس canonical متكامل', async () => {
  const index = await getIndex();
  const health = await getHealth();
  assert.equal(index.schemaVersion, 4);
  assert.equal(index.books.length, 21);
  assert.equal(index.documents.length, 2342);
  assert.ok(index.postings.size >= 10_000);
  assert.equal(health.pages, index.documents.length);
  assert.ok(index.documents.every((page) => page.title.length > 2 && page.summary.length >= 20));
  assert.ok(index.documents.every((page) => !/[\u3400-\u9fff]/u.test(`${page.title} ${page.summary} ${page.preview}`)));
  assert.ok(index.documents.every((page) => !/^\s*\{/u.test(page.preview)));
  assert.equal(health.searchablePages, index.documents.filter((page) => page.searchable).length);
  assert.equal(health.visionPages, index.documents.filter((page) => page.needsOcr).length);
  assert.equal(health.outlinePages, index.documents.length);
  assert.ok(health.printedPageGaps >= 16);
});

test('الفهرس مكتفي بذاته: نص كل صفحة داخله بلا ملف خارجي', async () => {
  const index = await getIndex();
  // كل صفحة لها نص يجب أن يكون نصها الكامل مخزّنا في الوثيقة نفسها.
  for (const doc of index.documents) {
    if (!doc.searchable) continue;
    assert.ok(doc.textLength > 0, `${doc.id} بلا نص`);
    assert.equal(doc.textLength, doc.text.length, `${doc.id} طول النص لا يطابق المخزّن`);
    assert.ok(doc.text.length >= 20, `${doc.id} نص قصير`);
  }
  // لا اقتطاع: الصيغة المطبّعة يجب أن تحتوي الصيغة المطبّعة للنص الكامل.
  for (const doc of index.documents) {
    if (!doc.searchable) continue;
    assert.ok(doc.normalized.length >= doc.text.length * 0.5, `${doc.id} normalized مقصوص`);
  }
  // حروف الطباعة لا تتسرّب للنص.
  assert.ok(index.documents.every((doc) => !/IRAQ_G\d+_[A-Z]{2,4}_\d{4}\.indb/.test(doc.text)));
  // ولا يتسرّب رقم الصفحة المطبوع ملتصقاً في أول النص أو آخره.
  for (const doc of index.documents) {
    if (!doc.searchable || doc.printedPage == null) continue;
    const folio = String(doc.printedPage);
    assert.ok(!new RegExp(`^${folio}(\\s${folio})*\\s`).test(doc.text), `${doc.id} رقم مطبوع في أول النص`);
    assert.ok(!new RegExp(`(\\s${folio}){2,}\\s*$`).test(doc.text), `${doc.id} رقم مطبوع مكرر في آخر النص`);
  }
  // حروف المصنع لا تصل الكلمات المفتاحية.
  assert.ok(index.documents.every((doc) => (doc.keywords || []).every((word) => !/^\d+$/.test(word))));
});

test('التغذية البصرية تجعل رسومات ومفردات الكتاب مقروءة بلا PDF', async () => {
  const index = await getIndex();
  const enriched = index.documents.filter((doc) => doc.enriched);
  assert.equal(enriched.length, 53);
  for (const doc of enriched) {
    assert.ok(doc.title.length > 3, `${doc.id} عنوان فارغ`);
    assert.ok(!/لا عنوان|لا يوجد عنوان|يحتاج قراءة بصرية|وصف مولّد/.test(`${doc.title} ${doc.summary}`), `${doc.id} نص استخراجي`);
    for (const figure of doc.figures || []) assert.ok(figure.description?.length > 60, `${doc.id} وصف صورة قصير`);
    for (const exercise of doc.exercises || []) {
      for (const item of exercise.items || []) {
        if (item.kind !== 'gap') continue;
        assert.ok(String(item.stem).includes('_'), `${doc.id} تمرين فراغ بلا شرطات`);
      }
    }
  }
  assert.equal(index.documents.filter((doc) => doc.glossary?.length).length, 13);
  assert.equal(index.stats.glossaryEntries, 102);
  assert.ok(index.stats.figures >= 17);
});

test('صفحة الكتاب المدرسي تعرّف الدرس كاملاً', async () => {
  const page = await fullPage('english-literature-sixth-pdf', 13);
  assert.equal(page.printedPage, 109);
  assert.equal(page.pageOffset, 96);
  assert.equal(page.work, 'Pride and Prejudice');
  assert.equal(page.author, 'Jane Austen');
  assert.equal(page.enriched, true);
  // النص الكامل يصل بلا قصّ، ومحتوى المفردات يصل معاً.
  assert.ok(page.text.includes('my best wishes for your health and happiness'), 'ذيل الصفحة غير موجود');
  assert.ok(page.text.includes('You could not have made the offer of your hand'), 'وسط الصفحة غير موجود');
  assert.ok(page.glossary.some((entry) => entry.term === 'foundation' && entry.definition.includes('beginning')));
  assert.ok(page.glossary.some((entry) => entry.term === 'gentlemanlike'));
});

test('صفحة التمارين تحفظ الفراغات وتشرح شكل الإجابة', async () => {
  const page = await fullPage('english-literature-exercises-sixth-pdf', 2);
  assert.equal(page.pageType, 'exercises');
  assert.equal(page.work, 'Pride and Prejudice');
  const gap = page.exercises.flatMap((exercise) => exercise.items || []).find((item) => item.kind === 'gap');
  assert.ok(gap, 'لا يوجد تمرين فراغ');
  assert.ok(gap.stem.includes('______'), `الفراغ غير محفوظ: ${gap.stem}`);
  assert.ok(page.exercises.some((exercise) => exercise.letter === 'E'));
});

test('الوحدة تُسمّي العمل داخل Literature Focus بلا تناقض', async () => {
  const index = await getIndex();
  for (const doc of index.documents.filter((entry) => entry.enriched)) {
    assert.ok(doc.unit, `${doc.id} وحدة فارغة`);
    assert.ok(doc.author, `${doc.id} مؤلف فارغ`);
    // لا يجوز أن تسمّي الوحدة شيئاً لا يسمّيها العمل على الصفحة نفسها.
    if (doc.work) assert.ok(doc.unit.includes(doc.work), `${doc.id} وحدة "${doc.unit}" لا تطابق العمل "${doc.work}"`);
  }
  // كتاب الطالب: 15 صفحة لرواية أوستن و14 لمسرحية شكسبير، والوحدتان متمايزتان.
  const text = index.documents.filter((doc) => doc.enriched && doc.bookId === 'english-literature-sixth-pdf');
  assert.equal(text.filter((doc) => doc.unit === 'Literature Focus — Pride and Prejudice').length, 15);
  assert.equal(text.filter((doc) => doc.unit === 'Literature Focus — As You Like It').length, 14);
  assert.equal(text.filter((doc) => doc.author === 'Jane Austen').length, 15);
  assert.equal(text.filter((doc) => doc.author === 'William Shakespeare').length, 14);
});

test('صفحة p21 لا تنسب مشهداً إلى مشهد آخر', async () => {
  const page = await fullPage('english-literature-sixth-pdf', 21);
  // Act 2 Scene 4 فيه Silvius وحده؛ نصيحة Corin تَرِد في سرد Act 2 Scene 2.
  assert.match(page.summaryEn, /Act 2, Scene 4 is a single panel in which Silvius alone/);
  assert.doesNotMatch(page.summaryEn, /Scene 4 gives Silvius' protestation and Corin/);
  assert.doesNotMatch(page.summary, /بتوسله/);
});

test('عدد سطور الإجابة في الملخص يطابق الحقل', async () => {
  const expected = { 4: 8, 8: 6, 20: 11 };
  for (const [physical, lines] of Object.entries(expected)) {
    const page = await fullPage('english-literature-exercises-sixth-pdf', Number(physical));
    const exercise = page.exercises.find((entry) => entry.letter === 'E');
    assert.equal(exercise.answerLines, lines, `p${physical}: عدد سطور التمرين E`);
    const activity = page.activities.find((entry) => entry.answerFormat?.startsWith('ruled_lines_'));
    assert.equal(activity.answerFormat, `ruled_lines_${lines}`, `p${physical}: answerFormat`);
    assert.ok(new RegExp(`\\b${lines}\\b`).test(page.summaryEn), `p${physical}: summaryEn لا يذكر ${lines}`);
  }
});

test('البحث المقلوب سريع ودقيق', async () => {
  const started = Date.now();
  const results = await search('أحكام التلاوة', { limit: 5 });
  assert.ok(Date.now() - started < 2000, 'fast');
  assert.ok(results.length > 0);
  assert.equal(results[0].bookId, 'islamic-sixth-preparatory-2025');
  assert.ok(results[0].summary.length >= 20);
});

test('يرفض الاسترجاع الضعيف الذي يخلط بين موضوعات غير مرتبطة', async () => {
  assert.deepEqual(await search('ما عاصمة اليابان؟', { limit: 5 }), []);
  assert.deepEqual(await search('قانون نيوتن الثاني', { limit: 5 }), []);
  assert.deepEqual(await search('حل السؤال الثالث صفحة 42', { limit: 5 }), []);
});

test('منهج رحمة الديني معزول عن كتب الأدبي ويغطي الكتب الرسمية المضافة', async () => {
  const books = await listBooks({ track: 'ديني' });
  assert.equal(books.length, 8);
  assert.equal(books.reduce((sum, book) => sum + book.pageCount, 0), 841);
  assert.equal(books.reduce((sum, book) => sum + book.searchablePageCount, 0), 824);
  assert.ok(books.some((book) => book.id === 'fiqh-shafii-deni-sixth'));
  assert.equal((await listBooks({ track: 'ديني إضافي' })).length, 1);
  assert.equal(await locate('quran-readings-deni-sixth', 2), 6);
  assert.equal(await locate('fiqh-shafii-deni-sixth', 2), 6);
  assert.equal(await locate('hadith-deni-sixth', 2), 7);
  assert.equal(await locate('fiqh-hanafi-deni-sixth', 1), null);
  const printedPage = await search('الفقه الشافعي صفحة 2', { track: 'ديني', limit: 5 });
  assert.equal(printedPage.length, 1);
  assert.equal(printedPage[0].physicalPage, 6);
  assert.equal(printedPage[0].printedPage, 2);
  const learningGoal = await search('في كتاب الفقه الشافعي، ماذا أتوقع بعد دراسة الوحدة؟', { track: 'ديني', limit: 1 });
  assert.equal(learningGoal[0].printedPage, 2);
  assert.match(learningGoal[0].preview, /يتوقع منك/);
  const hits = await search('مباحث القراءات القرآنية', { track: 'ديني', limit: 5 });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => books.some((book) => book.id === hit.bookId)));
  assert.equal(await resolveBook('الرواية للصف السادس', { track: 'ديني' }), null);
  assert.deepEqual(await search('العرض والطلب في الاقتصاد الأدبي', { track: 'ديني' }), []);
  assert.deepEqual(await search('الحديث النبوي صفحة 1', { track: 'ديني' }), []);
});

test('السؤال الذي يحتوي مادة وصفحة يرفع الصفحة الصحيحة', async () => {
  const results = await search('اشرح صفحة 6 من كتاب التربية الاسلامية', { limit: 3 });
  assert.equal(results[0].bookId, 'islamic-sixth-preparatory-2025');
  assert.equal(results[0].printedPage, 6);
});

test('الصفحة المصورة ترجع ملخصا بدل الفراغ', async () => {
  const page = await fullPage('islamic-sixth-preparatory-2025', 24);
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
  assert.equal(catalog.books.length, 21);
  assert.equal(catalog.pages, 2342);
  assert.equal(catalog.searchablePages, (await getHealth()).searchablePages);
  assert.equal(new Set(catalog.subjects).size, 19);
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
  const page = await fullPage('islamic-sixth-preparatory-2025', 24);
  assert.equal(page.searchable, false);
  assert.equal(page.needsVision, true);
  assert.equal(page.evidenceType, 'outline-description');
});

test('النص المشوّه أو الملخص بلغة غير متوقعة لا يُعرض كمرجع موثوق', async () => {
  const page = await fullPage('islamic-sixth-preparatory-2025', 65);
  assert.equal(page.searchable, false);
  assert.equal(page.needsVision, true);
  assert.equal(page.evidenceType, 'outline-description');
  assert.doesNotMatch(page.text, /本页|\{"text"/u);
});
