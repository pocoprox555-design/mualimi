import assert from 'node:assert';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getCatalog, getHealth, getIndex, getSubjects, listBooks, locate, fullPage, resolveBook, retrieveContext, search } from '../lib/index.mjs';
import { assessText, usableOutlineSummary } from '../lib/index.mjs';

// نفس نمط تجاهل الوصف الفهرسي الباطل داخل الاختبار، حتى لا يمرّ الاختبار
//measurement-safely إذا أُعيد بناء الفهرس فجأة.
const STALE_BLOCK = /لا (يمكن|يتوفر)|لا نص مستخرج|تحتاج قراءة بصرية|searchable:\s*false|needsOcr:\s*true/;

// عملا Literature Focus في كتاب اللغة الإنجليزية للصف السادس.
const LITERATURE_WORKS = ['Pride and Prejudice', 'As You Like It'];
// الكتب التي تسمّي وحدتها باسم العمل نفسه (`Literature Focus — Pride and Prejudice`)
// لا برقم الوحدة (`Unit 3`) كدليل المعلم.
const STUDENT_LITERATURE_BOOKS = new Set([
  'english-literature-sixth-pdf',
  'english-literature-exercises-sixth-pdf',
  'student-book-sixth-pdf',
]);
// الحرف الصيني في حقل معروض: عطبٌ كان في 10 حقول قبل إصلاحه، ولا يصحّ أن يعود.
const CJK = /[\u3400-\u9fff]/u;


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
  // لا يتسرّب كائن JSON متسلسل إلى المعاينة: الحقل المتسلسل يبدأ بـ `{` ثم مفتاح نصّي.
  assert.deepEqual(
    index.documents.filter((page) => /^\s*\{\s*"/u.test(page.preview)).map((page) => page.id),
    [],
    'كائن JSON متسلسل تسرّب إلى preview',
  );
  // أمّا القوس المعقوف في أول معاينة رياضية فهو ترميز مجموعة/فَترة موجود في PDF نفسه
  // (تحقّقنا: `{ x : x ∈ r,x < − 2 }`)، لا تسريب. يُسمّى بالصفحة لا بقاعدة عامة، فأي
  // قوس ثانٍ بلا مراجعة يُفشل الاختبار.
  const braceHeads = index.documents.filter((page) => /^\s*\{/u.test(page.preview));
  assert.deepEqual(braceHeads.map((page) => page.id), ['mathematics-sixth-literary-pdf:96'], 'قوس مجموعة جديد بلا مراجعة');
  assert.match(braceHeads[0].preview, /^\{\s*r,x/u, 'القوس المعقوف ليس ترميز مجموعة');
  assert.match(braceHeads[0].text, /^\{\s*r,x/u, 'نص الصفحة لا يطابق المعاينة');
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
  // 53 صفحة كانت رقمَ كتابين مُغذَّيَين فقط. اليوم 20 كتاباً و1936 صفحة؛ والأرقام
  // مثبّتة بالحرف لا بعتبة، لأن أي نقص في التغذية يجب أن يُسقط الاختبار لا أن يمرّ.
  assert.equal(enriched.length, 1936);
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
  assert.equal(index.documents.filter((doc) => doc.glossary?.length).length, 204);
  assert.equal(index.stats.glossaryEntries, 801);
  assert.equal(index.stats.figures, 260);
  // والعتبات تُحرس المكسب من الانحدار إن أُعيد بناء التغذية لاحقاً.
  assert.ok(index.stats.glossaryEntries >= 600, `مفردات=${index.stats.glossaryEntries}`);
  assert.ok(index.stats.figures >= 200, `رسومات=${index.stats.figures}`);
  // وعشرون كتاباً مُغذّى لا Literature Focus وحده.
  assert.equal(index.stats.enrichedBooks, 20);
  // وثلاثة كتب كانت بلا تغذية أصلاً وصارت مُغذّاة: الإنجليزي الديني وكتاب الطالب ودليل المعلم.
  for (const id of ['english-deni-sixth', 'student-book-sixth-pdf', 'english-literature-teacher-guide-95722f85-pdf']) {
    const book = index.books.find((entry) => entry.id === id);
    assert.ok(book, `${id} غير موجود`);
    assert.equal(book.enriched, true, `${id} ما زال بلا تغذية`);
    assert.ok(book.enrichedPageCount > 0, `${id} enrichedPageCount=0`);
  }
});

test('كل رقم مُتحقَّق منه مرفق بملاحظة مراجعة تذكر ما قُرئ', async () => {
  const index = await getIndex();
  const verified = index.documents.filter((doc) => Array.isArray(doc.verifiedNumbers) && doc.verifiedNumbers.length);
  assert.ok(verified.length >= 40, `صفحات بدليل بصري=${verified.length}`);
  for (const doc of verified) {
    assert.match(String(doc.notes || ''), /مراجعة بصرية/, `${doc.id} رقم بلا ملاحظة مراجعة`);
    for (const number of doc.verifiedNumbers) assert.ok(/^\d+$/.test(String(number)), `${doc.id} مدخل غير رقمي: ${number}`);
  }
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
  const enriched = index.documents.filter((entry) => entry.enriched);
  // شرط الاختبار كان على Literature Focus وحده (عملٌ مُسمّى)، واليوم 20 كتاباً مُغذّى
  // منها بلا `work`: الأغلفة والفهارس ومقدّمات الكتب، والكتب العربية بلا مؤلف أصلاً.
  // فالشرط يُقاس حيث يحمل الحقل دلالته: عملٌ مُسمّى يقتضي مؤلفاً، واسمَ وحدةٍ مطابقاً له.
  const works = enriched.filter((doc) => doc.work);
  assert.equal(works.length, 95, 'عدد صفحات Literature Focus المُغذّاة');
  for (const doc of works) {
    assert.ok(doc.unit, `${doc.id} وحدة فارغة`);
    assert.ok(doc.author, `${doc.id} مؤلف فارغ`);
    // لا يجوز أن تسمّي الوحدة عملاً غير عمل الصفحة. الوحدة قد تسمّي عملاً أو تسمّي
    // رقمَ وحدةٍ في دليل المعلم (`Unit 3`) فلا تسمّي عملاً البتّة — والتناقض هو الممنوع.
    const unitWork = LITERATURE_WORKS.find((name) => doc.unit.includes(name));
    assert.equal(unitWork ?? doc.work, doc.work, `${doc.id} وحدة "${doc.unit}" تسمّي عملاً غير "${doc.work}"`);
  }
  // وكتب الطالب تسمّي الوحدةَ باسم العمل لا برقمه، فالمطابقة فيها شرط لا اختيار.
  const studentBooks = works.filter((doc) => STUDENT_LITERATURE_BOOKS.has(doc.bookId));
  assert.equal(studentBooks.length, 69);
  for (const doc of studentBooks) {
    assert.ok(doc.unit.includes(doc.work), `${doc.id} وحدة "${doc.unit}" لا تطابق العمل "${doc.work}"`);
  }
  // ولا اسم مؤلف بلا عمل مُسمّى: اسمٌ بلا مِرسى لا يصحّ في كتاب عربي.
  assert.deepEqual(enriched.filter((doc) => doc.author && !doc.work).map((doc) => doc.id), [], 'مؤلف بلا عمل');
  // واسمُ وحدةٍ مطلوب أينما سمّى المصدرُ الصفحةَ بمسار درس (`الكتاب > الدرس > الباب`)
  // لا مقدّمة الكتاب وحدها — 839 صفحة، ولا واحدة بلا وحدة.
  const lessonScoped = enriched.filter((doc) => doc.sectionPath && String(doc.sectionPath).split(' > ').length > 1);
  assert.equal(lessonScoped.length, 839, 'عدد الصفحات ذات مسار درس');
  for (const doc of lessonScoped) assert.ok(doc.unit, `${doc.id} وحدة فارغة داخل مسار درس`);
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
  // 824 كانت قبل حذف النص المصحف المختلق من `quran-readings-deni-sixth` ص63 (الصفحة
  // بيضاء فعلاً: حرفان في طبقة النص وهما رقم الطبع ٥٩). انخفض العدّ واحداً لأن ص63 صارت
  // `searchable: false`، وهذا هو الإصلاح لا الانحدار، فالثقابة تُثبَّت أدناه باسمها.
  assert.equal(books.reduce((sum, book) => sum + book.searchablePageCount, 0), 823);
  const quranBlank = await fullPage('quran-readings-deni-sixth', 63);
  assert.equal(quranBlank.searchable, false, 'ص63 استُعيد فيها نصٌ لم يكن في الكتاب');
  assert.equal(quranBlank.needsVision, true);
  assert.equal(quranBlank.evidenceType, 'outline-description');
  assert.equal(quranBlank.printedPage, 59, 'رقم الصفحة المطبوعة ٥٩ سليم ولا يُلمس');
  // والنص المصحف المختلق «الحمد لله الذي هدانا للقرآن» لا يبقى مستخرجاً في أي صفحة.
  const index = await getIndex();
  assert.deepEqual(
    index.documents.filter((doc) => /هدانا للقرآن/u.test(String(doc.text || ''))).map((doc) => doc.id),
    [],
    'النص المصحف المختلق ما زال مستخرجاً',
  );
  assert.deepEqual(
    index.documents.filter((doc) => /هدانا للقرآن/u.test(`${doc.title} ${doc.summary}`)).map((doc) => doc.id),
    [],
    'النص المصحف المختلق ما زال في حقل معروض',
  );
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

test('الملخص بلغة غير متوقعة صُحِّح بالعربية فصارت الصفحة مرجعاً موثوقاً', async () => {
  // ص65 كان `summary` كله صينياً (73 محرف CJK) فيُعامل كغير موثوق: `searchable:false`
  // و`needsVision:true`. صُحِّح بالعربية، فالصفحة صارت نصاً مضموناً يُنقل ناقلاً.
  const page = await fullPage('islamic-sixth-preparatory-2025', 65);
  assert.equal(page.searchable, true);
  assert.equal(page.needsVision, false);
  assert.equal(page.evidenceType, 'pdf-text');
  assert.equal(page.damaged, false, `رُصد: ${page.damageReasons}`);
  assert.equal(page.quotableReliable, true);
  assert.equal(page.quotableSource, 'pdf-text');
  assert.equal(page.quotableText, page.text, 'النص السليم لم يُقدَّم كما هو');
  // وفي الحقول المعروضة كلها لا حرف صيني واحد.
  assert.doesNotMatch(page.summary, CJK);
  assert.doesNotMatch(page.title, CJK);
  assert.doesNotMatch(page.summary, /本页/u);
  // ولا يبقى أثر الحقل القديم: الملخص يذكر حديث «خيركم خيركم لأهله» من نص الصفحة.
  assert.match(page.summary, /خيرُكم خيرُكم لأهلِه/u);
  assert.ok(page.text.includes('خيرُكم خيرُكم لأهلِه'), 'الملخص يصف نصاً ليس في الصفحة');
  assert.doesNotMatch(page.text, /本页|\{"text"/u);
});

test('لا حرف صيني في أي حقل معروض عبر المكتبة كلها', async () => {
  // كان في 10 حقول `title`/`summary` قبل إصلاحها؛ الصفر اليوم شرط لا يخفى.
  const index = await getIndex();
  const offenders = index.documents
    .filter((doc) => CJK.test(`${doc.title} ${doc.summary}`))
    .map((doc) => `${doc.id} :: ${doc.title} / ${doc.summary}`);
  assert.deepEqual(offenders, [], `حروف صينية في حقول معروضة: ${offenders.join(' | ')}`);
  // والعدّ الصريح يثبت أن الفحص لم يمرّ لأن المكتبة صارت فارغة.
  assert.equal(index.documents.length, 2342);
});

// ─── العيب 1: «صالحة للاستشهاد» كانت تُقال بلا فحص سلامة ────────────
test('العيب 1: لا مصدر يُوسم «صالحة للاستشهاد» وفيه تلف، وكل رفض يذكر سببه', async () => {
  const probes = [
    ['حديث البيعان بالخيار', 'hadith-deni-sixth'],
    ['ماذا قال رسول الله', 'hadith-deni-sixth'],
    ['أخلاق الصحابة', 'hadith-deni-sixth'],
    ['مبدأ الملكية المزدوجة', 'islamic-sixth-preparatory-2025'],
    ['نظام الاقتصاد في العراق', 'geography-sixth-literary-pdf'],
    ['منحنى الطلب البياني', 'economics-sixth-literary-pdf'],
  ];
  let refusedWithReason = 0;
  for (const [query, bookId] of probes) {
    const context = await retrieveContext(query, { bookId, limit: 6 });
    const blocks = context.block.split('\n\n---\n\n').filter((block) => block.trim());
    assert.ok(blocks.length > 0, `${query}: لا بلوك`);
    for (const [index, block] of blocks.entries()) {
      // «صالحة للاستشهاد» لا تُقال إلا لصفحة اجتازت فحص السلامة.
      if (block.includes('صالح للاستشهاد')) {
        assert.doesNotMatch(block, /\uFFFD|هللا/, `${query} [${context.sources[index]?.id}] وُسم صالح للاستشهاد وفيه تلف`);
        assert.equal(context.sources[index].quotableReliable, true);
      } else {
        refusedWithReason += 1;
        // كل رفض يذكر سببه: لا «غير موثوق» مجرّدة.
        assert.match(block, /رُصد|لا نسخة سليمة/, `${query}: رفض بلا سبب مذكور`);
        assert.ok(context.sources[index].damageReasons?.length > 0, `${query}: رفض بلا قائمة أسباب`);
      }
    }
  }
  // الرقم قبل الإصلاح: 0 استشهاد مرفوض. لولا هذا الفحص كانت كل البلوكات موسومة.
  assert.ok(refusedWithReason >= 5, `استشهادات مرفوضة=${refusedWithReason} — لا يزال الحكم شبه مطلق`);
});

test('العيب 1: حكم السلامة يقيس كل إشارات التلف ويسمّي سببها', () => {
  const cases = [
    ['محارف بديلة مفقودة', 'نص فيه محرف بديل \uFFFD داخل الجملة العربية', /محارف بديلة/],
    ['رموز PUA', 'ثم أُخبر بهما \uF0BE في نظام المعادلات', /رموز خاصة/],
    ['قلب الحروف', 'االستفهام في النحو، واالسالم في الصفحة', /قلب حروف/],
    ['تواريخ مقلوبة', 'بدأ عام 7974م ثم 7839م وانتهى', /خارج المدى الواقعي/],
    ['خلط حروف داخل الكلمة', 'الmامنه الدnah مكتوب هكذا', /ملاصقة بحروف لاتينية/],
  ];
  for (const [label, text, pattern] of cases) {
    const verdict = assessText(text);
    assert.equal(verdict.damaged, true, `${label}: لم يُكتشف التلف`);
    assert.match(verdict.reasons.join(' | '), pattern, `${label}: سبب غير مطابق`);
  }
  // نص سليم يجب أن يمرّ بلا أسباب.
  const clean = assessText('قال رسول الله صلى الله عليه وسلم: خيركم من تعلم القرآن وعلّمه.');
  assert.equal(clean.damaged, false, 'نص سليم رُفض');
  assert.deepEqual(clean.reasons, []);
  // الخلط اللاتيني الصحيح بين كلمتين ليس تلفاً: لا يجوز أن تسمّيه إشاراتنا
  // (حرف عربي ملاصق لحرف لاتيني **داخل الكلمة**). حكم «النسبة الغريبة» يأتي
  // من lib/text.mjs ويُختبر هناك، لا هنا.
  const bilingual = assessText('ذكر المؤلف رحل Jane Austen وMr Bingley ثم أكمل، وتمارين A وB في آخر الصفحة.');
  const ownReasons = bilingual.reasons.filter((reason) => /محارف بديلة|رموز خاصة|قلب حروف|تواريخ\/أرقام|ملاصقة بحروف لاتينية/.test(reason));
  assert.deepEqual(ownReasons, [], `خلط لغوي صحيح سُمّي تلفاً: ${ownReasons.join(' | ')}`);
});

// ─── العيب 2: الاقتباس كان يأتي من `doc.text` المشوّه ───────────────
test('العيب 2: الاقتباس يأتي من أنظف نسخة بين `text` و`outlineSummary`', async () => {
  // ص3 في العربية-جزء1: `text` فيه قلب حروف، و`outlineSummary` سليم.
  const page = await fullPage('arabic-sixth-preparatory-part-1-2025', 3);
  assert.match(page.text, /اال/, 'الافتراض: نص الصفحة مشوّه');
  assert.equal(page.damaged, true, 'الصفحة المشوّهة يجب أن تُوسم تالفة');
  assert.equal(page.quotableSource, 'outline-description', 'لم يُقدَّم بديل أنظف');
  assert.equal(page.quotableReliable, false, 'الوصف الفهرسي ليس نقلاً حرفياً');
  assert.notEqual(page.quotableText, page.text, 'قُدِّم النص التالف نفسه');
  assert.doesNotMatch(page.quotableText, /هللا/, 'النسخة المقدَّمة تالفة أيضاً');
  // والمقدَّم فعلاً في سياق الإجابة هو النسخة النظيفة.
  const context = await retrieveContext('المقدمة واللغة العربية للصف السادس', {
    bookId: 'arabic-sixth-preparatory-part-1-2025',
    limit: 6,
  });
  const target = context.sources.find((source) => source.physicalPage === 3);
  assert.ok(target, 'الصفحة 3 لم تدخل المصادر');
  assert.equal(target.quotationSource, 'outline-description');
  assert.ok(context.block.includes('المقدِّمة') || context.block.includes('المقدمة'));
});

test('العيب 2: الصفحة السليمة تُقدَّم بنصّها الحرفي كما هي', async () => {
  const page = await fullPage('english-literature-sixth-pdf', 13);
  assert.equal(page.quotableSource, 'pdf-text');
  assert.equal(page.quotableReliable, true);
  assert.equal(page.quotableText, page.text, 'النص السليم لم يُقدَّم كما هو');
  assert.equal(page.needsVision, false);
});

// ─── العيب 3: `needsVision` لم يكن يعلن أي صفحة ─────────────────────
test('العيب 3: needsVision يعلن الصفحة التالفة ويذكر سبب الرفض', async () => {
  const index = await getIndex();
  // books التي لا تملك أي إشارة تلف: لا يجوز أن تُعلن قراءة بصرية.
  const healthy = index.documents.filter((doc) => doc.bookId === 'student-book-sixth-pdf' && doc.text);
  assert.ok(healthy.length > 100);
  for (const doc of healthy.slice(0, 25)) {
    const page = await fullPage(doc.bookId, doc.physicalPage);
    assert.equal(page.damaged, false, `${doc.bookId} p${doc.physicalPage} رُفض بلا سبب حقيقي: ${page.damageReasons}`);
    assert.equal(page.needsVision, false, `${doc.bookId} p${doc.physicalPage} لماذا تحتاج قراءة بصرية؟`);
  }
  // صفحة حديث كان نصّها 544 محرفاً بديلاً (U+FFFD)؛ حُذفت كلها من `pdf-books` فلا
  // يجوز أن تعود محرفاً بديلاً واحداً. وهذا إثبات للإصلاح لا إثباتٌ للعيب.
  const hadith = await fullPage('hadith-deni-sixth', 8);
  assert.doesNotMatch(hadith.text, /\uFFFD/u, 'محرف بديل عاد إلى نص الصفحة بعد حذفه');
  assert.ok(hadith.text.includes('حديث'), 'نص الصفحة فُقد بالكلية');
  const hadithBook = await readFile(new URL('../curriculum-library/pdf-books/hadith-deni-sixth.json', import.meta.url), 'utf8');
  assert.equal((hadithBook.match(/\uFFFD/gu) || []).length, 0, 'ما زال في كتاب الحديث محرف بديل');
  // والتغذية البصرية للكتاب أضافت 80 رسمة و120 مدخل مسرد بدل التلف.
  const hadithDocs = index.documents.filter((doc) => doc.bookId === 'hadith-deni-sixth');
  assert.equal(hadithDocs.reduce((sum, doc) => sum + (doc.figures?.length || 0), 0), 80);
  assert.equal(hadithDocs.reduce((sum, doc) => sum + (doc.glossary?.length || 0), 0), 120);
  // ومع ذلك تبقى الصفحة مرفوضة الاقتباس لأن `outlineSummary` فيها 10 محارف بديلة:
  // الرفض يذكر سببه ولا يسكت. هذا هو السلوك الذي بُني من الأصل.
  assert.equal(hadith.needsVision, true);
  assert.equal(hadith.damaged, true);
  assert.ok(hadith.visionReasons.length > 0, 'لا سبب مذكور للحاجة إلى قراءة بصرية');
  assert.match(hadith.visionReasons.join(' | '), /محارف بديلة/);
  assert.equal(hadith.quotableReliable, false, 'صفحة فيها محارف بديلة في دليلها تُقبل نقلها');
  assert.equal(hadith.quotableSource, 'unreliable');
  assert.ok(hadith.damageReasons.length > 0, 'رُفضت بلا سبب مذكور');
  // والرفض يظهر في سياق الإجابة نفسه: البلوك يذكر السبب ولا يوسم «صالحة للاستشهاد».
  const hadithContext = await retrieveContext('حديث البيعان بالخيار معاني الكلمات', { bookId: 'hadith-deni-sixth', limit: 3 });
  const hadithAt = hadithContext.sources.findIndex((source) => source.physicalPage === 8);
  assert.ok(hadithAt >= 0, 'صفحة الحديث ص8 غابت عن سياق الإجابة');
  const hadithBlock = hadithContext.block.split('\n\n---\n\n')[hadithAt];
  assert.ok(hadithBlock, 'لا بلوك يقابل المصدر ص8');
  assert.doesNotMatch(hadithBlock, /صالح للاستشهاد/u);
  assert.match(hadithBlock, /رُصد|لا نسخة سليمة/u, 'الرفض بلا سبب مذكور في البلوك');
  assert.match(hadithBlock, /محارف بديلة|قلب حروف/u, 'السبب المذكور غير سبب الرفض الحقيقي');
  // صفحة رياضيات فيها رموز محجوبة: أسئلتها لا تُجاب أصلاً بلا قراءة بصرية.
  const mathDamaged = index.documents.filter((doc) => doc.bookId === 'mathematics-deni-sixth'
    && /[\uE000-\uF8FF]/u.test(String(doc.text || '')) && doc.textLength > 200);
  assert.ok(mathDamaged.length >= 20, `صفحات رياضيات محجوبة=${mathDamaged.length}`);
  const mathPage = await fullPage(mathDamaged[0].bookId, mathDamaged[0].physicalPage);
  assert.equal(mathPage.needsVision, true);
  assert.equal(mathPage.quotableReliable, false, 'صفحة رموزها محجوبة لا يُقبل نقلها');
});

// ─── العيب 4: الفلتر الرقمي كان يُسقط كل مصطلح رقمي ─────────────────
test('العيب 4: الاستعلام الرقمي يعيد صفحة تحوي الرقم', async () => {
  const cases = [
    ['864', 'mathematics-sixth-literary-pdf', 105],
    ['9177', 'geography-sixth-literary-pdf', 164],
    ['15000', 'geography-sixth-literary-pdf', 117],
    ['2513 كم', 'geography-sixth-literary-pdf', 113],
    ['303', 'geography-sixth-literary-pdf', 73],
    // «721» كان خطأ استخراج: الرقم في الصفحة 720 لا 721. صُحِّح في المصدر، فالبحث
    // عن الرقم الصحيح هو البرهان على الإصلاح، والبحث عن الرقم التالف صفرٌ مقصود.
    ['720', 'mathematics-deni-sixth', null],
  ];
  for (const [query, bookId, physicalPage] of cases) {
    const hits = await search(query, { bookId, limit: 5 });
    assert.ok(hits.length > 0, `«${query}» رجع صفر نتيجة`);
    assert.ok(hits.every((hit) => hit.bookId === bookId), `«${query}» خرج من الكتاب المطلوب`);
    if (physicalPage != null) {
      assert.ok(hits.some((hit) => hit.physicalPage === physicalPage), `«${query}» لم يعد ص${physicalPage}: ${hits.map((hit) => hit.physicalPage)}`);
    }
    // النتيجة يجب أن تُثبت الرقم نصاً لا أن تأتي مصادفة.
    const index = await getIndex();
    const digits = String(query).replace(/\D/g, '');
    assert.ok(hits.some((hit) => {
      const doc = index.documents.find((entry) => entry.bookId === hit.bookId && entry.physicalPage === hit.physicalPage);
      return doc && new RegExp(`(^|\\D)${digits}(\\D|$)`).test(String(doc.text || ''));
    }), `«${query}»: لا نتيجة تحوي الرقم نصاً`);
  }
  // الرقم المطبوع في السؤال يبقى عنواناً لا مضموناً.
  assert.deepEqual(await search('صفحة 30', { limit: 5 }), []);
  assert.deepEqual(await search('حل السؤال الثالث صفحة 42', { limit: 5 }), []);
  // والرقم التالف 721 لا يُنشر بعد التصحيح: صفرٌ داخل الكتاب وصفرٌ عبر المكتبة.
  const index = await getIndex();
  const stale = index.documents.filter((doc) => /(^|\D)721(\D|$)/u.test(String(doc.text || '')));
  assert.deepEqual(stale.map((doc) => doc.id), [], 'الرقم التالف 721 ما زال مستخرجاً');
  assert.deepEqual(await search('721', { bookId: 'mathematics-deni-sixth', limit: 5 }), [], '«721» عاد إلى النتائج');
  assert.deepEqual(await search('721', { limit: 10 }), [], '«721» عاد إلى نتائج المكتبة كلها');
  // والرقم الصحيح 720 موجودٌ في ثلاث صفحات، أهمّها ص14 التي تُثبته نصّاً.
  const fixed = await search('720', { bookId: 'mathematics-deni-sixth', limit: 5 });
  assert.equal(fixed.length, 3, `«720» رجع ${fixed.length} صفحة`);
  assert.ok(fixed.some((hit) => hit.physicalPage === 14));
  assert.ok(index.documents.some((doc) => doc.bookId === 'mathematics-deni-sixth'
    && doc.physicalPage === 14 && /(^|\D)720(\D|$)/u.test(String(doc.text || ''))), 'الرقم غير موجود نصاً في ص14');
});

// ─── العيب 5: عتبة «ثلاثة مصطلحات» كانت تُسقط أسئلة واقعية ───────────
test('العيب 5: العتبة تكيّفية فالأسئلة الواقعية ترجع مصدرها', async () => {
  const cases = [
    ['أسلوب التعجب وأقسامه', 'arabic-sixth-preparatory-part-2-2025', 8],
    ['مفهوم المسرحية وعناصرها', 'arabic-sixth-preparatory-part-2-2025', 19],
    ['نشأة الرمزية', 'arabic-sixth-preparatory-part-2-2025', null],
    ['ماذا يعني أسلوب النداء؟', 'arabic-sixth-preparatory-part-1-2025', null],
    ['الحرب العالمية الأولى', 'history-deni-sixth', null],
    ['الحاجات الخاصة والعامة', 'economics-sixth-literary-pdf', null],
    ['القاعدة السابعة للاشتقاق', 'mathematics-sixth-literary-pdf', null],
  ];
  for (const [query, bookId, physicalPage] of cases) {
    const hits = await search(query, { bookId, limit: 5 });
    assert.ok(hits.length > 0, `«${query}» رجع صفر نتيجة بعد خفض العتبة`);
    if (physicalPage != null) {
      assert.ok(hits.some((hit) => hit.physicalPage === physicalPage),
        `«${query}» لم يصل إلى ص${physicalPage}: ${hits.map((hit) => hit.physicalPage)}`);
    }
  }
});

test('العيب 5: خفض العتبة لا يفتح باب الضوضاء', async () => {
  assert.deepEqual(await search('ما عاصمة اليابان؟', { limit: 5 }), []);
  assert.deepEqual(await search('قانون نيوتن الثاني', { limit: 5 }), []);
  assert.deepEqual(await search('اشرح لي الموجات الكهربائية', { limit: 5 }), []);
  assert.deepEqual(await search('العرض والطلب في الاقتصاد الأدبي', { track: 'ديني' }), []);
  assert.deepEqual(await search('الحديث النبوي صفحة 1', { track: 'ديني' }), []);
  assert.deepEqual(await resolveBook('الرواية للصف السادس', { track: 'ديني' }), null);
});

// ─── العيب 6: `outlineSummary` القديم «لا يمكن الإجابة» ──────────────
test('العيب 6: الوصف الفهرسي الباطل يُتجاهل عند الاقتباس', () => {
  const staleSamples = [
    'العنوان: صفحة مصورة النوع: صفحة مصورة المحتوى: لا نص مستخرج (تحتاج قراءة بصرية). ملاحظة للاستخدام: لا يمكن الإجابة عن أي سؤال من هذه الصفحة قبل قراءتها بصرياً.',
    'الصفحة موسومة في المصدر: `searchable: false | needsOcr: true` — لا ينسب إليها نص.',
    'لا يتوفر نص قابل للاستخراج من هذه الصفحة؛ تحتاج قراءة بصرية قبل الإجابة.',
  ];
  for (const sample of staleSamples) {
    assert.equal(usableOutlineSummary(sample), '', `لم يُتجاهل الوصف الباطل: ${sample.slice(0, 40)}`);
  }
  const healthy = 'العنوان: المطلب الثاني: المشكلة الاقتصادية النوع: مبحث + مطلب المحتوى: الندرة النسبية للموارد الاقتصادية.';
  assert.ok(usableOutlineSummary(healthy), 'وصف سليم رُفض خطأ');
  // ولا يصل النص الباطل إلى سياق الإجابة.
  assert.equal(STALE_BLOCK.test(usableOutlineSummary(staleSamples[0])), false);
});

test('العيب 6: صفحة فيها نص لا تُقدَّم بوصفها الباطل', async () => {
  // ص10 الجغرافيا: 133 حرف OCR اليوم، و`outlineSummary` القديم كان يقول
  // «لا يمكن الإجابة» وهي المرتبة الأولى في بحث «أقاليم الكثافة السكانية».
  const index = await getIndex();
  const geo = index.documents.find((doc) => doc.bookId === 'geography-sixth-literary-pdf' && doc.physicalPage === 10);
  assert.ok(geo.textLength > 100, 'الافتراض: الصفحة لها نص OCR');
  const page = await fullPage('geography-sixth-literary-pdf', 10);
  assert.doesNotMatch(page.summary, /لا يمكن الإجابة|لا نص مستخرج|searchable:\s*false/);
  const context = await retrieveContext('أقاليم الكثافة السكانية', { bookId: 'geography-sixth-literary-pdf', limit: 3 });
  assert.ok(context.sources.length > 0);
  assert.doesNotMatch(context.block, /لا يمكن الإجابة عن أي سؤال|searchable:\s*false|needsOcr:\s*true/);
});

// ─── العيب 7: استعلام يعيد صفحة التمارين بدل المحتوى ─────────────────
test('العيب 7: سؤال عن الشرط يرجع صفحة الشرح لا صفحة التمارين', async () => {
  const hits = await search('كم عدد شرط القطع في السرقة', { bookId: 'fiqh-shafii-deni-sixth', limit: 8 });
  assert.ok(hits.length > 0);
  // ص43 صفحة تمارين («اختر من بين الأقواس»)، وص32 صفحة الشرح.
  const exercisesRank = hits.findIndex((hit) => hit.physicalPage === 43);
  const contentRank = hits.findIndex((hit) => hit.physicalPage === 32);
  assert.ok(contentRank >= 0, 'صفحة الشرح ص32 غابت عن النتائج');
  assert.ok(exercisesRank < 0 || exercisesRank > contentRank,
    `صفحة التمارين ما زالت تتقدّم: تمارين #${exercisesRank} · محتوى #${contentRank}`);
  assert.notEqual(hits[0].physicalPage, 43, 'أول نتيجة ما زالت صفحة التمارين');
});

test('العيب 7: طلب التمارين نفسه يبقى يفتح صفحة التمارين', async () => {
  const hits = await search('تمارين الوحدة الأولى', { bookId: 'student-activity-sixth-pdf', limit: 5 });
  assert.ok(hits.length > 0, 'سؤال عن تمارين رجع صفراً');
});

