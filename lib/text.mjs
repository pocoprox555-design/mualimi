// أدوات النص المشتركة بين مولد الفهرس ومحرك البحث.
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const BIDI = /[‌‍‎‏‪-‮⁦-⁧﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ARABIC_PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PUA = /[\uE000-\uF8FF]/;

// حرف عربي بلا تشكيل: حدود الكلمة في كل ما يلي تُبنى منه، لا من المدى الكامل
// «ء-ي»، لأن المدى كاملاً يبتلع الحركات فيصير شرط «ليس قبله حرف» غير دقيق.
const LETTER = '\u0621-\u063A\u0641-\u064A';
// رموز Private Use Area. مصدرها خط «KFGQPC Arabic Symbols 01» (مجمع الملك فهد)
// المضمّن في كتاب الحديث: يضع الخط رموز ﷺ وﷻ و﴿﴾ في هذا المدى بلا أسماء Unicode.
// حُدِّدت نصوصها بقراءة أشكال المحارف من الخط المضمّن نفسه، لا بالتخمين.
const PUA_TEXT = new Map([
  ['', 'صلى الله عليه وسلم'],
  ['', 'عليه السلام'],
  ['', 'عليه السلام'],
  ['', 'عليه السلام'],
  ['', 'صلى الله تعالى عليه وسلم'],
  ['', 'تبارك وتعالى'],
  ['', 'رضي الله عنه'],
  ['', 'رضي الله عنه'],
  ['', 'رضي الله عنه'],
  ['', 'رضي الله عنهم'],
  ['', 'رضي الله عنهن'],
  ['', 'رحمه الله'],
  ['', 'رحمه الله'],
]);
const PUA_KNOWN = new RegExp(`[${[...PUA_TEXT.keys()].join('')}]`, 'g');
// رمز PUA واقع بين حرفين في كلمة واحدة (لا واقفاً وحده): هنا فقط يكون تلفاً في النص.
const PUA_INSIDE_WORD = new RegExp(`[${LETTER}]${PUA.source}|${PUA.source}[${LETTER}]`);

const OCR_FIX = [
  // «اﷲ» ألف زائدة قبل رباط الله: 109 مواضع (الحديث 107 + القراءات 2).
  [/اﷲ/g, 'الله'],
  [/\uFDF2/g, 'الله'],
  // «الكرمي» خطأ طباعي لـ«الكريم»: 19 موضعاً في كتاب الإسلامية، وصفر موضع سليم في 20 كتاباً.
  [new RegExp(`(?<![${LETTER}])الكرمي(?![${LETTER}])`, 'g'), 'الكريم'],
  // «الرحمي» خطأ طباعي لـ«الرحيم»: موضع واحد (ص3 من كتاب الإسلامية).
  [new RegExp(`(?<![${LETTER}])الرحمي(?![${LETTER}])`, 'g'), 'الرحيم'],
  [new RegExp(`(?<![${LETTER}])االسالمية(?![${LETTER}])`, 'g'), 'الاسلامية'],
  [new RegExp(`(?<![${LETTER}])اإلسالمية(?![${LETTER}])`, 'g'), 'الإسلامية'],
  // اسم الله مقلوب الحروف في طبعة هذه الكتب: «اهلل» و«هللا» = «الله»، و«وهلل» = «والله».
  // 540 موضعاً حُدِّدت كلها بالقياس. «هلل» وحدها تُترك: هي بين «لله» و«الله» (55 موضعاً).
  [/اهلل/g, 'الله'],
  [new RegExp(`هللا(?![${LETTER}])`, 'g'), 'الله'],
  [new RegExp(`وهلل(?![${LETTER}])`, 'g'), 'والله'],
  // «امل» بألف مقلوبة عن «الم»: يجب أن تبدأ الكلمة، وإلا لُفّت «العاملون» و«كامل»
  // و«معامل» و«التعامل» — 1356 كلمة تحتوي «امل» في المكتبة، والغالبية منها سليمة.
  [new RegExp(`(?<![ء-ي])امل(?=[ء-غف-ي]{2})`, 'g'), 'الم'],
];

// توحيد الحروف الفارسية/الأردية إلى نظائرها العربية: كلٌّ منها حرف عربي + علامة فوقه أو تحته.
// تُطبَّق بعد NFKC لأن تفكيك أشكال العرض يولّدها من جديد: ﻯ ← ی وﻫ ← ھ،
// و«ھ» وحده 1550 كلمة حقيقية في كتاب الحديث (هذا/وهو/أهل/ذهب) كانت بلا أي توكن.
// التغطية كاملة بلا ثغرة: 0679، 067E، 0681–06CF، 06D0–06D3، 06D5، 06E5–06EA.
const ARABIC_UNIFORM = new Map();
for (const [extended, arabic] of Object.entries({
  'ڠڡڢڭ': 'ا',              // ألف بأشكاله: ڠ ڡ ڢ ڭ
  'پ': 'ب',                 // پ
  'ٹڷ': 'ت',                // ٹ · ڷ (ت + نكتا)
  'چڇ': 'ج',                // چ ڇ
  'ڃڧ': 'ح',                // ڃ ڧ
  'ڄڅ': 'خ',                // ڄ څ
  'ڈډڸ': 'د',               // ڈ ډ ڸ
  'ڊ': 'ذ',                 // ڊ
  'ڋڑڹ': 'ر',               // ڋ ڑ ڹ
  'ڌڍڎڒژ': 'ز',             // ڌ ڍ ڎ ڒ ژ
  'ڏړ': 'س',                // ڏ ړ
  'ڐ': 'ص',                 // ڐ
  'ڔ': 'ض',                 // ڔ
  'ڕ': 'ط',                 // ڕ
  'ږ': 'ظ',                 // ږ
  'ڤ': 'ف',                 // ڤ
  'ڙښڛڥڦڨکڪګڬگڴڵڶڻۄۅۆ': 'ك',// ك + خط/نقطة/زخرفة فوقها
  'ڜ': 'ل',                 // ڜ
  'ڝ': 'غ',                 // ڝ
  'ڗڞڟڰں': 'ن',             // ن + خاتم/نقطة/غمسة
  'ځڂڮڱڲڳڼڽھڿۀہۂۃە۩': 'ه',  // ه + حركة/خاتم — و«ھ» أكثرها وروداً (1550 كلمة)
  'ڣۇۋۏۥۧ': 'و',            // واو بأشكالها: ۇ ۋ ۏ ۥ ۧ
  'ۈۉۊیۍێېۑےۓۦ۪ۨ': 'ي',     // ياء بأشكالها: ی ے ې ۓ ێ ۊ ۍ ۦ ۨ ۪
})) for (const character of extended) ARABIC_UNIFORM.set(character, arabic);
const UNIFORM_LETTER = new RegExp(`[${[...ARABIC_UNIFORM.keys()].join('')}]`, 'g');
// علامات مركّبة في المدى 06A0–06FF ليست حروفاً: تُحذف كالتشكيل.
const UNIFORM_MARK = /[۠-ۤۯ۵ۺ-ۿ]/g;

// حروف ونقوش لا ترد في طباعة عربية سليمة: لاتيني موسّع، يوناني، سلافي، أرميني،
// خطوط رسم، وصيني/كوري. الاستدلال عليها يمنع اقتباس صفحة مختلقة بثقة.
const DAMAGE_NOISE = /[¡-ÿĀ-ſʰ-˿Ͱ-ϿЀ-ӿ԰-֏─-▟⺀-鿿가-힯豈-﫿]/;
// نقوش ترد في هذه الكتب سليمة (رياضيات وعلامات ترقيم) فلا تُحسب تلفاً.
const DAMAGE_ALLOWED = /[«»×÷°±²³¹¼½©®ªº]/;
const DAMAGE_ARABIC = /[؀-ۿ]/;
const DAMAGE_LATIN = /[A-Za-z]/;
const DAMAGE_MIN = 40;
const DAMAGE_RATIO = 0.02;
// خلط عربي/لاتيني في كلمة واحدة: كتابان فيه مصطلح إنكليزي داخل قوس فيحسب تلفاً
// («والحقن(Injection»)، فالحدّ لزمّان. موزَّع مقيس: 40 صفحة في الفقه و26 في الحديث.
const DAMAGE_MIX_MIN = 2;

const STOP = new Set([
  'في', 'من', 'الى', 'إلى', 'الي', 'على', 'عن', 'ما', 'ماذا', 'هل', 'هو', 'هي',
  'هذا', 'هذه', 'ذلك', 'تلك', 'ثم', 'او', 'أو', 'و', 'يا', 'مع', 'كل', 'كان',
  'كانت', 'يكون', 'ان', 'أن', 'إن', 'اذا', 'إذا', 'لم', 'لن', 'لا', 'قد', 'بعد',
  'قبل', 'بين', 'عند', 'كما', 'التي', 'الذي', 'غير', 'حتى', 'لي', 'لك', 'له',
  'لها', 'أنا', 'انا', 'أنت', 'انت', 'نحن', 'هم', 'هن', 'ثم', 'بـ', 'ب', 'ك', 'ل',
  'سوال', 'اسيله', 'ماده', 'مواد', 'كتاب', 'كتب', 'اشرح', 'شرح', 'حل', 'اريد', 'اعطني',
  'عندك', 'موجود', 'متاح', 'متوفر', 'الصف', 'صف', 'السادس', 'سادس', 'الاعدادي', 'اعدادي',
  'اسلامي', 'الاسلامي', 'الديني', 'ديني', 'للسادس',
  // أدوات الاستفهام والوظائف: تُضعف تغطية البحث حين تبقى ضمن مصطلحات السؤال
  'لماذا', 'كيف', 'متي', 'اين', 'وين', 'مين', 'اي', 'ايه', 'كم', 'فقط', 'ايضا',
  'يوجد', 'هناك', 'هنا', 'يمكن', 'الان',
  // أسماء خفيفة تشير إلى أدوات الصفحة نفسها بدل مضمونها
  'معني', 'معاني', 'كلمه', 'كلمات', 'مفرده', 'مفردات', 'معجم', 'مسرد', 'قائمه',
  'تعريف', 'تعريفات', 'صوره', 'صور', 'رسم', 'رسوم', 'لوحه', 'مشهد', 'شكل',
  'سؤال', 'اسئله', 'جواب', 'جمله', 'جمل', 'نصوص',
  // أفعال مساعدة يسبقها السؤال عادة
  'ساعدني', 'ساعد', 'ساعديني', 'اخبرني', 'اخبر', 'ابحث', 'استخرج', 'وضح', 'عرف',
  'عرفني', 'فسر', 'ترجم', 'اكمل', 'اكمللي',
]);

export function cleanText(value) {
  let text = String(value ?? '').replace(BIDI, '').replace(CONTROL, '');
  text = text.replace(PUA_KNOWN, (character) => PUA_TEXT.get(character));
  for (const [pattern, replacement] of OCR_FIX) text = text.replace(pattern, replacement);
  return text
    .replace(/\r/g, '')
    .replace(ARABIC_PRESENTATION, (character) => character.normalize('NFKC'))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// أرقام الآيات في المصحف صحيحة 90/91 (تقرير القراءات) فالدالة سليمة. أمّا
// «١٩١٤» في التاريخ و«٠» في الرياضيات فعيبا خط/ToUnicode داخل الـPDF (١٩٩٤ ←
// ١٩١٤ و٠ ← ١) ولا يمكن إصلاحهما هنا.
export function normalizeDigits(value) {
  return String(value ?? '').replace(/[٠-٩۰-۹]/g, (digit) => {
    const value = ARABIC_DIGITS.indexOf(digit);
    return String(value >= 0 ? value : digit.charCodeAt(0) - 0x06f0);
  });
}

export function normalizeAr(value) {
  return normalizeDigits(cleanText(value).normalize('NFKC'))
    .replace(UNIFORM_MARK, '')
    .replace(UNIFORM_LETTER, (character) => ARABIC_UNIFORM.get(character))
    .replace(DIACRITICS, '')
    .replace(/ـ/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/گ/g, 'ك')
    .replace(/چ/g, 'ج')
    .replace(/پ/g, 'ب')
    .replace(/[^ء-غف-يa-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tokens(value, minLength = 2) {
  return normalizeAr(value)
    .split(' ')
    .filter((word) => word.length >= minLength && !STOP.has(word));
}

export function uniqueTokens(value, minLength = 2) {
  return [...new Set(tokens(value, minLength))];
}

export function searchTokenForms(term) {
  const forms = new Set([String(term || '')]);
  if (term.startsWith('ال') && term.length > 4) forms.add(term.slice(2));
  else if (!term.startsWith('ال') && term.length > 3) forms.add(`ال${term}`);
  for (const suffix of ['كم', 'كن', 'هم', 'هن', 'ها', 'نا', 'ه', 'ك', 'ي']) {
    for (const form of [...forms]) {
      if (form.length > suffix.length + 3 && form.endsWith(suffix)) forms.add(form.slice(0, -suffix.length));
    }
  }
  for (const form of [...forms]) {
    if (form.length > 4 && form.endsWith('ات')) forms.add(form.slice(0, -2));
    if (form.length > 4 && form.endsWith('ه')) { forms.add(`${form.slice(0, -1)}ت`); forms.add(form.slice(0, -1)); }
    else if (form.length > 4 && form.endsWith('ت')) { forms.add(`${form.slice(0, -1)}ه`); forms.add(form.slice(0, -1)); }
  }
  return forms;
}

export function searchTokens(value) {
  const result = new Set();
  for (const term of uniqueTokens(value)) for (const form of searchTokenForms(term)) result.add(form);
  return [...result];
}

export function topKeywords(value, count = 10) {
  const frequency = new Map();
  for (const token of tokens(value)) frequency.set(token, (frequency.get(token) || 0) + 1);
  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, count)
    .map(([word]) => word);
}

// وصف بين كلمة الصفحة ورقمها: «الصفحة المطبوعة 179» و«الصفحة الفيزيائية 12».
const PAGE_DESCRIPTOR = new RegExp(
  `(?:رقم\\s*|ال)?(?:مطبوع\\S*|فيزيائ\\S*|فيزيائي\\S*|طبعي\\S*|مادي\\S*|ورقي\\S*)?\\s*[#:.\\-]?\\s*(\\d{1,4})`,
  'i',
);

export function pageReference(value) {
  const text = normalizeDigits(value);
  const match = text.match(new RegExp(
    `(?:صفحات|صفحه|صفحة|ص|pages|page|pp|p)\\s*${PAGE_DESCRIPTOR.source}`,
    'i',
  ));
  return match ? Number(match[1]) : null;
}

// كشف تلف النص الطباعي. لا يُصلح شيئاً: يُرجع true لصفحةٍ لا يُوثق نصها، ليمنع
// الاقتباس المضمون منها. ثلاث إشارات، كلٌّ منها مقيسة على المكتبة:
//   1) U+FFFD: محرف بديل من الـPDF — 652 محرفاً في 84 صفحة (حديث + رياضيات).
//   2) رمز PUA واقع داخل كلمة بين حرفين لا واقفاً وحده.
//   3) كلمتان فأكثر يخلط كلٌّ منهما عربياً بلاتيني، أو نسبة 2% من حروف ونقوش
//      لا ترد في طباعة عربية سليمة (mojibake).
// رموز PUA الواقفة وحدها (رصاص Wingdings في كتاب النشاط 64 موضعاً، ورموز خط
// الرياضيات 596 موضعاً) زخرفة لا تلف، فلا تُحتسب.
export function hasTextDamage(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  if (PUA_INSIDE_WORD.test(text)) return true;
  let mixed = 0;
  for (const word of text.split(/\s+/)) {
    if (word && DAMAGE_ARABIC.test(word) && DAMAGE_LATIN.test(word)) mixed += 1;
    if (mixed >= DAMAGE_MIX_MIN) return true;
  }
  const visible = text.replace(/\s+/g, '');
  if (visible.length < DAMAGE_MIN) return false;
  let noise = 0;
  for (const character of visible) {
    if (DAMAGE_NOISE.test(character) && !DAMAGE_ALLOWED.test(character)) noise += 1;
  }
  return noise / visible.length >= DAMAGE_RATIO;
}

export function compact(value, max = 280) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text.trim();
  const cut = text.slice(0, max);
  const boundary = Math.max(
    cut.lastIndexOf(' '), cut.lastIndexOf('،'), cut.lastIndexOf('.'), cut.lastIndexOf('؛'),
    cut.lastIndexOf('؟'), cut.lastIndexOf('!'), cut.lastIndexOf(':'), cut.lastIndexOf(','),
  );
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut).trim();
}
