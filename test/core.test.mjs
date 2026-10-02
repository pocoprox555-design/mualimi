import assert from 'node:assert';
import test from 'node:test';
import { cleanText, compact, hasTextDamage, normalizeAr, pageReference, tokens } from '../lib/text.mjs';
import { publicConfig, resolveProvider } from '../lib/config.mjs';

// رموز Private Use Area من خط «KFGQPC Arabic Symbols 01»: أشكالها قُرئت من الخط
// المضمّن في كتاب الحديث، وهذه رموزها في المدى E000–F8FF.
const PUA_SALLA = ''; // صلى الله عليه وسلم
const PUA_RADI = ''; // رضي الله عنه
const PUA_ALAYH = ''; // عليه السلام
const PUA_RAHMA = ''; // رحمه الله
const PUA_MATH = ''; // × من خط الرياضيات: رمز لا نعرف نصوصه
const PUA_BULLET = ''; // رصاصة من خط Wingdings في كتاب النشاط

test('تطبيع عربي: تشكيل وهمزات وتاء مربوطة', () => {
  assert.equal(normalizeAr('أحكامُ التِّلاوة'), 'احكام التلاوه');
  assert.equal(normalizeAr('القرآن الكريم'), 'القران الكريم');
  assert.equal(normalizeAr('ﻳﺘوﻗﻊ'), 'يتوقع');
});

test('إصلاح OCR والأرقام العربية', () => {
  assert.match(cleanText('املديرية العامة'), /المديرية/);
  assert.match(cleanText('ﻳﺘوﻗﻊ ﻣﻨﻚ'), /يتوقع منك/);
  assert.equal(pageReference('اشرح صفحة ٤٢ من الكتاب'), 42);
});

test('توكنز بدون كلمات توقف', () => {
  const result = tokens('ما هي أحكام التلاوة في القرآن');
  assert.ok(result.includes('احكام'));
  assert.ok(!result.includes('ما'));
});

test('قاعدة امل لا تلوي الكلمات السليمة وتبقى تصلح التالف', () => {
  // العيب المقيس: القاعدة كانت بلا حدود كلمة، فتلوّت «العاملون» و«كامل» و«معامل»
  // و«التعامل» و«العوامل» — 1356 كلمة تحتوي «امل» في المكتبة.
  assert.equal(normalizeAr('العاملون'), 'العاملون');
  assert.equal(normalizeAr('العاملين'), 'العاملين');
  assert.equal(normalizeAr('العوامل'), 'العوامل');
  assert.equal(normalizeAr('التعامل'), 'التعامل');
  assert.equal(normalizeAr('معامل ومعاملة'), 'معامل ومعامله');
  assert.equal(normalizeAr('كامل وشامل وتكامل'), 'كامل وشامل وتكامل');
  assert.equal(normalizeAr('تاملته'), 'تاملته');
  assert.equal(normalizeAr('عامل وعاملة'), 'عامل وعامله');
  assert.doesNotMatch(normalizeAr('العاملون'), /العالمون/);
  // الإصلاح ما زال يعمل: الألف المقلوبة تصير لاماً حين تبدأ الكلمة.
  assert.equal(normalizeAr('املشتقة'), 'المشتقه');
  assert.equal(normalizeAr('املؤمن'), 'المومن');
  assert.equal(normalizeAr('املبد'), 'المبد');
  assert.equal(cleanText('املديرية العامة'), 'المديرية العامة');
});

test('قواعد الكرمي والرحمي والإسلامية تبقى محدّدة بحدود الكلمة', () => {
  // 19 موضعاً في كتاب الإسلامية، وصفر موضع سليم في العشرين كتاباً الأخرى.
  assert.match(cleanText('الكرمي'), /الكريم/);
  assert.match(cleanText('الرحمي'), /الرحيم/);
  assert.match(cleanText('االسالمية'), /الاسلامية/);
  assert.match(cleanText('اإلسالمية'), /الإسلامية/);
  // لا تُلتقط داخل كلمة أخرى ولا يمتدّalous إلى كلمة مشابهة.
  assert.ok(!cleanText('كرمي').includes('الكريم'));
  assert.ok(!cleanText('الكرام').includes('الكريم'));
  assert.ok(!cleanText('الرحمة').includes('الرحيم'));
});

test('اسم الله المقلوب يعود صحيحاً: اهلل و هللا و وهلل', () => {
  // 540 موضعاً حُدِّدت كلها بالقياس: 259 «اهلل» و271 «هللا» و10 «وهلل».
  assert.match(cleanText('الحمد اهلل'), /الحمد الله/);
  assert.match(cleanText('رواه رسول اهلل'), /رسول الله/);
  assert.match(cleanText('عبد هللا طالب'), /عبد الله طالب/);
  assert.match(cleanText('الحلف بغير هللا'), /الحلف بغير الله/);
  assert.match(cleanText('(وهلل دره من الأذن)'), /والله دره/);
  // «الله» و«لله» و«بالله» و«ولله» و«فبالله» سليمة أصلاً ولا يجوز المساس بها.
  for (const word of ['الله', 'لله', 'بالله', 'ولله', 'فبالله', 'كفالله', 'تعالى']) {
    assert.ok(cleanText(`الحمد ${word} رب العالمين`).includes(word), `تلفت: ${word}`);
  }
  // «هلل» وحدها ملتبسة بين «لله» و«الله» (55 موضعاً) فتركناها بلا تخمين.
  assert.ok(cleanText('الحمد هلل').includes('هلل'));
});

test('رموز PUA في المصحف والحديث تُوسَّع إلى نصها وتصبح قابلة للبحث', () => {
  assert.equal(cleanText(`قال رسول الله ${PUA_SALLA} عن زيد`),
    'قال رسول الله صلى الله عليه وسلم عن زيد');
  assert.equal(cleanText(`قال ${PUA_RADI} كرار بنCommas`.replace(' كرار بنCommas', '')),
    'قال رضي الله عنه');
  assert.match(cleanText(`عليه ${PUA_ALAYH}`), /عليه السلام/);
  assert.match(cleanText(`رواه ${PUA_RAHMA}`), /رحمه الله/);
  // البحث عن «صلى الله عليه وسلم» كان يرجع صفر نتيجة من كتاب الحديث.
  assert.deepEqual(tokens(`قال رسول الله ${PUA_SALLA}`),
    ['قال', 'رسول', 'الله', 'صلي', 'الله', 'عليه', 'وسلم']);
  // رموز لا نعرف نصوصها تبقى كما هي: لا تخمين.
  assert.ok(cleanText(`س ${PUA_MATH} ص`).includes(PUA_MATH));
  assert.ok(cleanText(`vocabulary ${PUA_BULLET} A good way`).includes(PUA_BULLET));
});

test('الحروف الفارسية والأردية تُوحَّد ولا تُحذف عند الترشيح', () => {
  // «ھ» وحده 1550 كلمة حقيقية في كتاب الحديث: هذا/وهو/أهل/ذهب.
  assert.equal(normalizeAr('ھذا'), 'هذا');
  assert.equal(normalizeAr('وھو'), 'وهو');
  assert.equal(normalizeAr('أھل'), 'اهل');
  // أشكال العرض تنفك في NFKC إلى هذه الحروف نفسها، والتوحيد يأتي بعدها فيلتقطها.
  assert.equal(normalizeAr('ﻳﺘوﻗﻊ'), 'يتوقع');
  assert.equal(normalizeAr('ﮭ'), 'ه', 'ﮭ ينفك في NFKC إلى «ھ» لا إلى «ه»');
  assert.equal(normalizeAr('ﮫ'), 'ه', 'ﮫ ينفك في NFKC إلى «ھ»');
  assert.equal(normalizeAr('ﻫ'), 'ه');
  assert.equal(normalizeAr('ﻳ'), 'ي');
  // لا محرف في المدى 0679–06EA يفلت: إمّا يُوحَّد إلى حرف عربي أو يُحذف كعلامة.
  // الغرض من العيب المقيس: 3.2% من كلمات كتاب الحديث بلا أي توكن بحثي.
  const unified = new Set();
  for (let cp = 0x0679; cp <= 0x06EA; cp += 1) {
    const character = String.fromCodePoint(cp);
    const result = normalizeAr(character);
    assert.ok(result === '' || /^[ء-ي]$/.test(result),
      `الحرف U+${cp.toString(16).toUpperCase()} يفلت كـ${JSON.stringify(result)}`);
    if (result) unified.add(cp);
  }
  assert.equal(unified.size, 92, 'عدد الحروف الموحَّدة تغيّر');
  // المهمّ أن الحروف الشائعة تعطي نظائرها الصحيحة.
  assert.equal(normalizeAr('کتاب'), 'كتاب');
  assert.equal(normalizeAr('گل'), 'كل');
  assert.equal(normalizeAr('پول'), 'بول');
  assert.equal(normalizeAr('چاي'), 'جاي');
  assert.equal(normalizeAr('ڤصل'), 'فصل');
  assert.equal(normalizeAr('ں'), 'ن');
  assert.equal(normalizeAr('ڭ'), 'ا');
  assert.equal(normalizeAr('ک'), 'ك');
  assert.equal(normalizeAr('ڝ'), 'غ');
  // الأرقام الهندية والفارسية تبقى تُحوَّل أرقاماً.
  assert.equal(normalizeAr('١٩٩٤ و ۱۹۹۴'), '1994 و 1994');
});

test('pageReference يقبل صيغ الصفحة الطبيعية كلها', () => {
  // العيب G1 (عالي) في تقرير تمارين الأدب الإنكليزي: «الصفحة المطبوعة 179»
  // كانت ترجع null، فالبحث يردّ صفحة خاطئة بدرجة 82.3.
  assert.equal(pageReference('الصفحة المطبوعة 179'), 179);
  assert.equal(pageReference('الصفحة الفيزيائية 12'), 12);
  assert.equal(pageReference('ص 45'), 45);
  assert.equal(pageReference('صفحة 45'), 45);
  assert.equal(pageReference('الصفحة ٣'), 3);
  assert.equal(pageReference('من صفحة 12'), 12);
  assert.equal(pageReference('ص. 7'), 7);
  assert.equal(pageReference('pp. 5–7'), 5);
  assert.equal(pageReference('page 12'), 12);
  assert.equal(pageReference('p. 12'), 12);
  // لا تنكسر الصيغ المقيسة سابقاً.
  assert.equal(pageReference('اشرح صفحة ٤٢ من الكتاب'), 42);
  assert.equal(pageReference('صفحة 179 من كتاب التمارين'), 179);
  assert.equal(pageReference('التمرين D صفحة 187'), 187);
  assert.equal(pageReference('ماذا في الصفحة 173؟'), 173);
  assert.equal(pageReference('page 101 of the Student Book'), 101);
  assert.equal(pageReference('صفحة رقم 88'), 88);
  // ولا تنشأ مطابقة زائفة من كلمة إنكليزية أو من وصف غير معروف.
  assert.equal(pageReference('Exercise 3 page 168'), 168);
  assert.equal(pageReference('صفحة الھيophysics 5'), null);
  assert.equal(pageReference('ما هي التمارين في تمارين الأدب الإنكليزي؟'), null);
  assert.equal(pageReference(''), null);
});

test('compact يقطع عند حدّ كلمة ويحافظ على الحدّ الأقصى', () => {
  const long = 'القرآن الكريم كتاب نزل فيه كلام الله تعالى على النبي محمد صلى الله عليه وسلم'
    + ' وهو الكتاب الذي لا يمسه إلا المطهرون وذكر فيه من لا ينفعه علم';
  const cut = compact(long, 60);
  assert.ok(cut.length <= 60, `الطول ${cut.length}`);
  assert.ok(cut.length > 30, `قصّ القطع قصّر كثيراً: ${cut.length}`);
  // آخر محرف قبل القطع ليس داخل كلمة: ما يلي القطع في الأصل مسافة.
  assert.equal(long.slice(cut.length, cut.length + 1), ' ');
  assert.equal(long.slice(0, cut.length).trim(), cut);
  // نص أقصر من الحد لا يُمسّ، ونص بلا حدود يبقى مقصوصاً عند الحد.
  assert.equal(compact('كلمة قصيرة', 60), 'كلمة قصيرة');
  assert.equal(compact('a'.repeat(50), 40).length, 40);
  // العيب المقيس: «…ع تأكيد تداخل خريطة الشعر الحد|ي» كانت تنتهي بـ«الحد».
  const example = 'الفصل الأول: Poetry and the Arab heritage, and the interrelation between them, and'
    + ' the confirmation of overlap between the poetry map and the classical';
  const piece = compact(example, 60);
  assert.ok(!/[\u0640-\u064A]$/.test(piece.replace(/\s+$/, '')) || example[piece.length] === ' ');
});

test('hasTextDamage يكشف تلف النص ويترك الصفحات السليمة', () => {
  // 1) محرف بديل U+FFFD: 652 محرفاً في 84 صفحة (حديث + رياضيات).
  assert.equal(hasTextDamage('نص عربي طويل فيه محرف بديل \uFFFD و五十 نصوص عربية أخرى'), true);
  // 2) رموز PUA الواقفة وحدها نقوش لا تلف: رصاص Wingdings وخط الرياضيات.
  assert.equal(hasTextDamage(`Unit 1 Study Tip – learning vocabulary ${PUA_BULLET} A good way to learn`), false);
  assert.equal(hasTextDamage(`س ${PUA_MATH} ص ورقة رياضيات`), false);
  // 3) خلط عربي/لاتيني في كلمتين فأكثر (موزع مقيس: 40 صفحة في الفقه و26 في الحديث).
  assert.equal(hasTextDamage('zzzzËeنه و هي جناية و alHawl in the middle of نص عربي طويل'), true);
  // 4) نسبة عالية من حروف لا ترد في طباعة عربية سليمة.
  assert.equal(hasTextDamage('Ä ÃÂ Á À ¿ ¾ texto نصوص عربية كثيرة هنا用以在这里 الطويل'), true);
  // علامات الرياضيات وعلامات الترقيم نقوش سليمة.
  assert.equal(hasTextDamage('س 2 - 3 ÷ س < 2 معادلة رياضية قصيرة'), false);
  assert.equal(hasTextDamage('القرآن الكريم نزل على النبي محمد صلى الله عليه وسلم في رمضان'), false);
  assert.equal(hasTextDamage(''), false);
  assert.equal(hasTextDamage('قصير'), false);
});

test('مفتاح الجهاز يتجاوز مفتاح الخادم دون تغيير الوجهة أو النموذج', () => {
  const config = resolveProvider({
    env: { AI_API_KEY: 'server-key', AI_ENDPOINT: 'https://server.example/v1', AI_MODEL: 'M1' },
    headers: { 'x-ai-api-key': 'user-key', 'x-ai-endpoint': 'https://attacker.example/v1', 'x-ai-model': 'U1' },
  });
  assert.equal(config.key, 'user-key');
  assert.equal(config.endpoint, 'https://server.example/v1');
  assert.equal(config.model, 'M1');
  assert.equal(publicConfig(config).configured, true);
  assert.equal(publicConfig(config).key, undefined);
});

test('مفتاح b64 يُفك ورابط غير صالح يُرفض', () => {
  const raw = Buffer.from('secret123').toString('base64');
  assert.equal(resolveProvider({ env: { AI_API_KEY: `b64:${raw}`, AI_ENDPOINT: 'https://example.com/v1' } }).key, 'secret123');
  assert.equal(resolveProvider({ env: { AI_ENDPOINT: 'ftp://x' } }).error, 'INVALID_ENDPOINT');
});
