import assert from 'node:assert';
import test from 'node:test';
import { buildEvidenceCorpus, groundReligiousText, isGrounded, stripForeignScripts } from '../lib/grounding.mjs';

// آية موجودة فعلاً في الدليل تبقى كما هي.
test('آية مسندة في الدليل تُحفظ بلا تغيير', () => {
  const evidence = 'الصفحة ٢٢: قال تعالى ﴿واعتصموا بحبل الله جميعا ولا تفرقوا﴾ في سياق درس الوحدة.';
  const answer = 'الموضوع عن الوحدة، والدليل: ﴿واعتصموا بحبل الله جميعا ولا تفرقوا﴾.';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, false);
  assert.equal(result.text, answer);
  assert.deepEqual(result.removed, []);
});

// آية من ذاكرة النموذج غير واردة في الصفحة تُزال حتى لو كانت آية حقيقية.
test('آية بلا سند في الدليل تُزال مع إشعار', () => {
  const evidence = 'الصفحة ٢٢ تتحدث عن التوافيق في الرياضيات ولا تحتوي أي نص قرآني.';
  const answer = 'قال تعالى: ﴿إنما المؤمنون إخوة فأصلحوا بين أخويكم﴾ وهذا يدل على الوحدة.';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('إنما المؤمنون إخوة'));
  assert.ok(result.text.includes('لم يرد نص هذه الآية'));
  assert.equal(result.notices.length, 1);
});

// فرق بسيط في الاستخراج (همزة/تشكيل) لا يُسقط آية موجودة فعلاً.
test('تطابق الآيات يتحمّل فرق التشكيل والهمزة', () => {
  const evidence = '﴿وَأَنِ احْكُم بَيْنَهُم بِمَا أَنزَلَ اللَّهُ﴾';
  const answer = '﴿وأن احكم بينهم بما أنزل الله﴾';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, false);
});

// نسبة رقم آية غير واردة في الدليل تُحذف وحدها ويبقى اسم السورة.
test('رقم آية مختلق يُزال ولا تبقى إحالة زائفة', () => {
  const evidence = 'الصفحة ٧٨ من كتاب التفسير تتناول أحكاما عامة بلا أرقام آيات.';
  const answer = 'ورد هذا الحكم في سورة التوبة الآية ٤١.';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('٤١') && !result.text.includes('41'));
  assert.ok(result.text.includes('سورة التوبة'));
});

// رقم آية وارد في نص الدليل يبقى.
test('رقم آية ثابت في الدليل يبقى', () => {
  const evidence = 'تشير الصفحة إلى سورة النور الآية ٣٥ صراحة.';
  const answer = 'الموضوع في سورة النور الآية ٣٥.';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, false);
});

// وجود آية مسندة في الرد يمنع حذف أرقام الآيات (تقليل الإنذار الكاذب).
test('آية مسندة تحمي رقم الآية المرافق من الحذف', () => {
  const evidence = '﴿الله نور السماوات والأرض﴾ وردت في سورة النور.';
  const answer = 'قال تعالى ﴿الله نور السماوات والأرض﴾ وهي في سورة النور الآية ٣٥.';
  const result = groundReligiousText(answer, evidence);
  assert.ok(result.text.includes('٣٥') || result.text.includes('35'));
});

// نص عادي بلا محتوى ديني لا يُمس إطلاقاً.
test('رد تعليمي عادي لا يتأثر بالحارس', () => {
  const answer = 'التوافيق: ق(ن،ر) = ن! ÷ (ر! × (ن-ر)!)، ومثالها ق(100،98) = 4950.';
  const result = groundReligiousText(answer, 'الصفحة ٢٢ عن التوافيق.');
  assert.equal(result.changed, false);
  assert.equal(result.text, answer);
});

// isGrounded: تغطية الكلمات العالية تكفي عند غياب التطابق الحرفي.
test('isGrounded يعتمد التغطية العالية للكلمات', () => {
  const corpus = buildEvidenceCorpus('الرحمن الرحيم مالك يوم الدين إياك نعبد وإياك نستعين');
  assert.equal(isGrounded('مالك يوم الدين إياك نعبد', corpus), true);
  assert.equal(isGrounded('قل هو الله أحد الله الصمد', corpus), false);
});

// حديث مقتبس بين قوسين ولا سند له في الدليل يُزال ويبقى المقدِّم.
test('قول نبوي مختلق بين قوسين يُزال', () => {
  const evidence = 'الصفحة ٣٠ تتحدث عن آداب الحوار بلا أحاديث.';
  const answer = 'قال رسول الله ﷺ: «إنما الأعمال بالنيات وإنما لكل امرئ ما نوى».';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('بالنيات'));
  assert.ok(result.text.includes('لم يرد نص هذا القول'));
});

// حديث وارد نصاً في الدليل يبقى بلا تغيير.
test('قول نبوي مسند في الدليل يُحفظ', () => {
  const evidence = 'في الصفحة: قال رسول الله «الدين النصيحة» رواه مسلم.';
  const answer = 'قال رسول الله: «الدين النصيحة» وهذا أساس التعامل.';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, false);
});

// اقتباس عادي غير ديني بين قوسين لا يُمس.
test('اقتباس غير ديني لا يتأثر بالحارس', () => {
  const evidence = 'الصفحة عن التوافيق.';
  const answer = 'عرّف الكتاب التوافيق بأنها «اختيار عناصر من مجموعة بلا ترتيب».';
  const result = groundReligiousText(answer, evidence);
  assert.equal(result.changed, false);
  assert.equal(result.text, answer);
});


// ==== منظّف الرموز الدخيلة (CJK/عبري/سريلي) ====

test('رمز صيني وسط كلمة عربية يُحذف ويبقى الباقي', () => {
  // رصد حي: «الجزع وال斩وال» — النموذج الصغير يوضع رمزا CJK وسط الكلمة.
  const answer = 'أن يمسك الإنسان عن الجزع وال斩وال عند المصيبة.';
  const result = stripForeignScripts(answer);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('\u65A9'));
  assert.match(result.text, /الجزع والوال/);
  assert.ok(result.removed.length >= 1);
});

test('كلمة عبرية داخل نص عربي تُحذف', () => {
  // رصد حي: «ما أאוקטوبر إلا إياك نعبد»
  const answer = 'الإقرار بالنقص: ما أאוקטوبر إلا إياك نعبد.';
  const result = stripForeignScripts(answer);
  assert.equal(result.changed, true);
  assert.ok(!/[\u0590-\u05FF]/.test(result.text));
  assert.match(result.text, /إلا إياك نعبد/);
});

test('نص سليم عربي/لاتيني لا يلمسه المنظّف', () => {
  const answer = 'الدرس Math والعلوم: أحكام التلاوة صفحة ٤٢، معادلة س=ع×ز.';
  const result = stripForeignScripts(answer);
  assert.equal(result.changed, false);
  assert.equal(result.text, answer);
});

test('أقواس الآية ﴿﴾ لا يمسها المنظّف', () => {
  const answer = 'قال تعالى ﴿واعتصموا بحبل الله جميعا﴾.';
  const result = stripForeignScripts(answer);
  assert.equal(result.changed, false);
  assert.match(result.text, /﴿[^﴾]+﴾/);
});

test('الحذف ينظّف الفراغ المزدوج الناتج', () => {
  const answer = 'كلمة أ 斩  ب نهاية.';
  const result = stripForeignScripts(answer);
  assert.ok(!/  /.test(result.text), 'لا فراغ مزدوج: ' + JSON.stringify(result.text));
});
