// حارس الإسناد: يمنع النموذج من سرد نص ديني لم يرد في الدليل المرفق.
//
// القاعدة العليا في التطبيق تقول: «لا تسردي آية أو حديثاً إلا إذا كان منقولاً
// نصاً في المقتطف المرفق». النموذج الصغير (mimo-flash) يخالف هذه القاعدة رغم
// صرامة الـprompt — فهو يكمل آية من ذاكرته أو ينسبها لسورة ورقم خاطئين (عطل C9/C10
// في اختبار رحمة). الـprompt وحده لا يكفي؛ فمثل ترشيح معرّفات المصادر
// (citationStreamFilter) الذي لا يعتمد على التزام النموذج، يكون الإسناد حتمياً هنا.
//
// الدالة نقية (بلا آثار جانبية) حتى تُختبر وحدها: تأخذ نص الرد ونص الدليل،
// وتُرجع النص بعد إزالة ما لا سند له مع إشعارات صادقة للطالبة.
import { normalizeAr, normalizeDigits } from './text.mjs';

// قوسا الآية القرآنية ﴿ … ﴾: علامة لا لبس فيها على اقتباس آية.
const VERSE_SPAN = /﴿([\s\S]*?)﴾/g;
// قول إلهي أو نبوي بين علامتي اقتباس: «قال تعالى: "…"»، «قال رسول الله ﷺ: «…»».
// الحدّان (مقدِّم ديني + اقتباس بين قوسين) يجعلان الكشف حتمياً قليل الإنذار الكاذب.
const SACRED_QUOTE = /((?:قال|يقول|قول)\s+(?:الله|تعالى|رسول\s+الله|النبي|محمد)(?:\s+(?:تعالى|ﷺ|صلى\s+الله\s+عليه\s+وسلم|عليه\s+السلام))?|عن\s+(?:رسول\s+الله|النبي))\s*[:：]?\s*(?:[«"']([^»"']{12,})[»"'])/g;
// نسبة صريحة برقم آية: «الآية ٤١»، «آية 78»، «الآيات ٥-٧».
const AYAH_NUMBER = /(الآيات|الآية|آيات|آيه|آية)\s*([0-9٠-٩۰-۹]{1,3})/g;
const SURAH_NAMES = new Set(['البقرة', 'آل عمران', 'النساء', 'المائدة', 'الانعام', 'الاعراف', 'الانفال', 'التوبة', 'يونس', 'هود', 'يوسف', 'الرعد', 'ابراهيم', 'الحجر', 'النحل', 'الاسراء', 'الكهف', 'مريم', 'طه', 'الانبياء', 'الحج', 'المؤمنون', 'النور', 'الفرقان', 'الشعراء', 'النمل', 'القصص', 'العنكبوت', 'الروم', 'لقمان', 'السجدة', 'الاحزاب', 'سبأ', 'فاطر', 'يس', 'الصافات', 'ص', 'الزمر', 'غافر', 'فصلت', 'الشورى', 'الزخرف', 'الدخان', 'الجاثية', 'الاحقاف', 'محمد', 'الفتح', 'الحجرات', 'ق', 'الذاريات', 'الطور', 'النجم', 'القمر', 'الرحمن', 'الواقعة', 'الحديد', 'المجادلة', 'الحشر', 'الممتحنة', 'الصف', 'الجمعة', 'المنافقون', 'التغابن', 'الطلاق', 'التحريم', 'الملك', 'القلم', 'الحاقة', 'المعارج', 'نوح', 'الجن', 'المزمل', 'المدثر', 'القيامة', 'الانسان', 'المرسلات', 'النبأ', 'النازعات', 'عبس', 'التكوير', 'الانفطار', 'المطففين', 'الانشقاق', 'البروج', 'الطارق', 'الاعلى', 'الغاشية', 'الفجر', 'البلد', 'الشمس', 'الليل', 'الضحى', 'الشرح', 'التين', 'العلق', 'القدر', 'البينة', 'الزلزلة', 'العاديات', 'القارعة', 'التكاثر', 'العصر', 'الهمزة', 'الفيل', 'قريش', 'الماعون', 'الكوثر', 'الكافرون', 'النصر', 'المسد', 'الاخلاص', 'الفلق', 'الناس', 'الفاتحة']);

// النص القصير جداً (كلمة واحدة) قد يتطابق صدفة؛ لا نطلب سنداً له.
const MIN_GROUNDED_CHARS = 12;
// إن لم يتطابق النص حرفياً، تكفي تغطية عالية من كلماته الدالة لاحتمال
// فرق بسيط في الاستخراج (مسافة، همزة، تطويل) بدل حذف آية موجودة فعلاً.
const TOKEN_OVERLAP_FLOOR = 0.85;

const NOTE_VERSE = '(لم يرد نص هذه الآية في الصفحة المرفقة — راجعيها في كتابك)';
const NOTE_HADITH = '(لم يرد نص هذا القول في الصفحة المرفقة — راجعيه في كتابك)';
const NOTE_AYAH = '(لم يثبت رقم الآية في الصفحة المرفقة)';

function contentTokens(value) {
  return normalizeAr(value).split(' ').filter((word) => word.length >= 3);
}

// دليل الإسناد: النص المُوحَّد للمقارنة + مجموعة كلماته + أرقامه الواردة.
export function buildEvidenceCorpus(evidenceText) {
  const normalized = normalizeAr(evidenceText || '');
  const words = new Set(contentTokens(evidenceText || ''));
  const numbers = new Set(
    [...normalizeDigits(String(evidenceText || '')).matchAll(/\d{1,4}/g)].map((match) => match[0]),
  );
  return { normalized, words, numbers };
}

// هل للنص سند في الدليل؟ تطابق تام بعد التوحيد، أو تغطية كلمات عالية.
export function isGrounded(text, corpus) {
  const needle = normalizeAr(text);
  const visible = needle.replace(/\s/g, '');
  if (visible.length < MIN_GROUNDED_CHARS) return true;
  if (corpus.normalized && corpus.normalized.includes(needle)) return true;
  const tokens = contentTokens(text);
  if (!tokens.length) return true;
  const hits = tokens.filter((token) => corpus.words.has(token)).length;
  return hits / tokens.length >= TOKEN_OVERLAP_FLOOR;
}

function tidy(value) {
  return String(value || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([،,;:!?؟])/g, '$1')
    .replace(/([،,;:!?؟])\s*([،,;:!?؟])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// إزالة كل آية ﴿…﴾ لا سند لها في الدليل. هذه هي القاعدة الأساسية: حتى الآية
// الصحيحة من الذاكرة تُحذف إن لم تكن في الصفحة المرفقة، لأن المطلوب شرح من
// الكتاب لا من رأس النموذج.
function groundVerses(text, corpus) {
  const removed = [];
  let groundedAny = false;
  const out = String(text || '').replace(VERSE_SPAN, (whole, inner) => {
    const verse = String(inner || '').trim();
    if (!verse) return '';
    if (isGrounded(verse, corpus)) { groundedAny = true; return whole; }
    removed.push(verse.slice(0, 120));
    return NOTE_VERSE;
  });
  return { text: out, removed, groundedAny };
}

// نسبة رقم آية صريحة (سورة + رقم) لا رقم لها في الدليل ولا آية مسندة في الرد:
// يُحذف الرقم وحده ويبقى اسم السورة، فلا نختلق إحالة.
function groundAyahNumbers(text, corpus, groundedAnyVerse) {
  if (groundedAnyVerse) return { text, removed: [] };
  const removed = [];
  const out = String(text || '').replace(AYAH_NUMBER, (whole, label, digits) => {
    const number = normalizeDigits(digits);
    if (corpus.numbers.has(number)) return whole;
    removed.push(`${label} ${number}`.trim());
    return NOTE_AYAH;
  });
  return { text: out, removed };
}

// قول إلهي/نبوي مقتبس بين قوسين ولا سند له في الدليل: يُستبدل النص المختلق
// بملاحظة صادقة، ويبقى المقدِّم («قال رسول الله») لتستقيم الجملة.
function groundSacredQuotes(text, corpus) {
  const removed = [];
  let groundedAny = false;
  const out = String(text || '').replace(SACRED_QUOTE, (whole, intro, quote) => {
    const inner = String(quote || '').trim();
    if (!inner) return whole;
    if (isGrounded(inner, corpus)) { groundedAny = true; return whole; }
    removed.push(inner.slice(0, 120));
    return `${intro}: ${NOTE_HADITH}`;
  });
  return { text: out, removed, groundedAny };
}

/**
 * فحص رد النموذج وإزالة النص الديني بلا سند من الدليل المرفق.
 * @param {string} answer نص الرد الكامل بعد اكتمال الجولة.
 * @param {string} evidenceText نص الأدلة التي رآها النموذج (localBlock + web).
 * @returns {{text:string, changed:boolean, removed:string[], notices:string[]}}
 */
export function groundReligiousText(answer, evidenceText) {
  const original = String(answer ?? '');
  if (!original || !/﴿|الآية|آية|آيه|سورة|قال|يقول|عن\s+(?:رسول|النبي)/.test(original)) {
    return { text: original, changed: false, removed: [], notices: [] };
  }
  const corpus = buildEvidenceCorpus(evidenceText || '');
  const verses = groundVerses(original, corpus);
  const quotes = groundSacredQuotes(verses.text, corpus);
  const ayahs = groundAyahNumbers(quotes.text, corpus, verses.groundedAny || quotes.groundedAny);
  const removed = [...verses.removed, ...quotes.removed, ...ayahs.removed];
  const text = tidy(ayahs.text);
  if (!removed.length) return { text: original, changed: false, removed: [], notices: [] };
  const notices = [
    'أُزيل نص ديني لم يرد في الصفحة المرفقة؛ الشرح المعروض من دليل الكتاب فقط، فلا يُنسب إلى الصفحة ما ليس فيها.',
  ];
  return { text, changed: text !== original, removed, notices };
}

// نمط حروف غير عربية/لاتينية يظهر من خلل رموز النموذج الصغير: عبري، صيني/ياباني/
// كوري (CJK)، سريلي. لا يجوز أيٌّ منها في ردّ مدرّس عربي، فيُزال حتمياً. النطاقات
// محصورة فلا تمس العربية واللاتينية والأرقام والرموز الرياضية وعلامات التنصيص.
const FOREIGN_SCRIPT = /[\u0590-\u05FF\u0400-\u04FF\u2E80-\u303F\u3040-\u30FF\u3130-\u318F\u31C0-\u31EF\u3200-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F]|[\uD840-\uD86F][\uDC00-\uDFFF]|[\uD87E-\uD87F][\uDC00-\uDE1F]/g;
const FOREIGN_NOTE = 'أُزيلت رموز غير عربية ظهرت خطأً في العرض؛ اعتمدي نص كتابك للمصطلحات.';

// إزالة الحروف الدخيلة (عبرية/CJK/سريلي) من الرد. تعمل على كل رد، لا على الديني
// فقط، لأن الخلل يظهر في أي نص. تُبقي الجملة كما هي وتحذف الرمز وحده، فلا تُعدم
// إجابة سليمة بسبب حرف مكسور واحد.
export function stripForeignScripts(answer) {
  const text = String(answer ?? '');
  if (!FOREIGN_SCRIPT.test(text)) return { text, changed: false, removed: [], notices: [] };
  FOREIGN_SCRIPT.lastIndex = 0;
  const samples = [...new Set(text.match(FOREIGN_SCRIPT) || [])].slice(0, 8);
  const cleaned = text
    .replace(FOREIGN_SCRIPT, '')
    // فراغ مزدوج نشأ من حذف الرمز داخل كلمة: لا نترك أثر الحذف ظاهراً
    .replace(/ {2,}/g, ' ')
    .trim();
  return { text: cleaned, changed: cleaned !== text, removed: samples, notices: [FOREIGN_NOTE] };
}

export const __test = { SURAH_NAMES, MIN_GROUNDED_CHARS, TOKEN_OVERLAP_FLOOR, NOTE_VERSE, NOTE_HADITH, NOTE_AYAH };
