// مطابقة ضبابية عربية خفيفة: بلا تضمينات vector embeddings وبلا مكتبات خارجية.
// الغرض أن مصطلحاً في سؤال الطالب غائب عن الفهرس المقلوب (همزة مختلفة، تاء
// مربوطة، لهجة، حرف أعجمي) يظل يصل إلى صفحاته — وهذا هو الفارق بين «لا يوجد
// في المصادر» وبين جواب صحيح.
const CHAR_FOLD = new Map([
  ['أ', 'ا'], // أ إ آ ٱ ← ا: الهمزات الثلاث كتبتها الطباعة الواحدة
  ['إ', 'ا'],
  ['آ', 'ا'],
  ['ٱ', 'ا'],
  ['ء', ''], // الهمزة الواقفة (القرءان ← القرآن) تُحذف: هي حركة لا حرف
  ['ى', 'ي'], // ى ئ ی ← ي: ياءات الطباعة المتعددة
  ['ئ', 'ي'],
  ['ی', 'ي'],
  ['ة', 'ه'], // ة ← ه: التاء المربوطة تُكتب هاءً في كثير من الطبعات
  ['ؤ', 'و'],
  ['گ', 'ك'], // گ ک ← ك: الفارسية والأردية
  ['ک', 'ك'],
  ['پ', 'ب'],
  ['چ', 'ج'],
  ['ژ', 'ز'],
  ['ڤ', 'ف'],
  ['ه', 'ه'], // حرس تطابق: «ه» مفتاحٌ وقيمةٌ معاً فلا يُسقط حرفاً آخر
]);

// التشكيل والتطويل يُحذفان لأنهما زينة لا دلالة: «مَدْرَسَة» و«مدرسة» كلمة واحدة.
const DIACRITICS = /[\u064B-\u0652]/g;
const TATWEEL = /\u0640/g;

const MAX_EXTRA_PER_TERM = 3;
const MAX_EXPANSION_TERMS = 40;
const MIN_FUZZY_LENGTH = 4;

export function foldArabic(word) {
  // NFKC أولاً: «ﻻ» و«ﷲ» أشكال عرض يفكّها التوحيد إلى «لا» و«الله»، فبدونه
  // يبقى السؤال بصورة لا يجدها الفهرس وهو يملك الصفحة نفسها.
  let text = String(word ?? '').normalize('NFKC');
  if (!text) return '';
  let folded = '';
  for (const character of text) {
    const mapped = CHAR_FOLD.get(character);
    folded += mapped === undefined ? character : mapped;
  }
  return folded
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .toLowerCase();
}

// ─── فهرس مطويّ مسطّح: بدل خريطة بـ74 ألف مدخل ─────────────────────
// المصطلحات مرتّبة أبجدياً بصيغتها المطويّة، ومعها موازيٌّ لها بالمصطلح الأصلي.
// الذاكرة مصفوفتان تتشاركان النصوص المُقحَمة (‏~3MB) لا خريطة ومجموعات
// (‏~15MB). والبحث ثنائي في مصفوفة مرتّبة: لا مسح خطّي في الفهرس كله أبداً.
export function buildFoldedIndex(terms) {
  const pairs = [];
  if (!terms || typeof terms[Symbol.iterator] !== 'function') return { folded: [], terms: [] };
  for (const term of terms) {
    const original = String(term ?? '').trim();
    if (!original) continue;
    pairs.push([foldArabic(original), original]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { folded: pairs.map((pair) => pair[0]), terms: pairs.map((pair) => pair[1]) };
}

const FOLD_SCAN_WINDOW = 256;

function lowerBound(folded, value) {  let lo = 0;
  let hi = folded.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (folded[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * يوسّع المصطلحات الغائبة عن الفهرس بمصطلحاتٍ توجد فيه. المسار دقيق لا تقريبي:
 *   1) تطابق مطويّ تام (همزة/تاء مربوطة/ياء) — بحث ثنائي.
 *   2) جيران مسافة تحرير واحدة بحسابين: حذف حرف من السؤال (يبحث عنه ثنائياً،
 *      فيغطي الإدخال والحذف)، ومسح نافذة ±256 موضعاً حول موضع الإدراج (يغطي
 *      الإبدال). لا يُمسح الفهرس كله كما كان يقترح المسار التقريبي.
 * @param {string[]} missing مصطلحات الطلب الغائبة عن الفهرس
 * @param {{folded:string[],terms:string[]}} index مخرجات buildFoldedIndex
 * @param {Set<string>|string[]} queryTerms مصطلحات الطلب نفسه؛ لا يُعاد إضافتها
 */
export function expandMissing(missing, index, queryTerms) {
  const folded = index?.folded;
  const terms = index?.terms;
  if (!folded?.length || !Array.isArray(missing)) return [];
  // مصطلحات الطلب وحده تُستبعد من الإضافة؛ مصطلح الفهرس هو المقصد فلا يُستبعد.
  const seen = new Set();
  if (queryTerms instanceof Set) for (const value of queryTerms) seen.add(String(value ?? '').trim());
  else if (Array.isArray(queryTerms)) for (const value of queryTerms) seen.add(String(value ?? '').trim());
  const extras = [];
  const add = (value) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    extras.push(text);
  };

  for (const raw of missing) {
    if (extras.length >= MAX_EXPANSION_TERMS) break;
    const term = String(raw ?? '').trim();
    if (!term) continue;
    const needle = foldArabic(term);
    if (!needle) continue;
    let added = 0;

    // 1) تطابق مطويّ تام: المصطلحات القريبة من موضع الإدراج
    const at = lowerBound(folded, needle);
    for (let i = at; i < folded.length && folded[i] === needle; i += 1) {
      if (added >= MAX_EXTRA_PER_TERM || extras.length >= MAX_EXPANSION_TERMS) break;
      if (terms[i] !== term) { add(terms[i]); added += 1; }
    }
    if (added) continue;

    // 2) الكلمة القصيرة تطابق آلاف الجيران: تُستثنى، والقصر أهون من الضجيج.
    if (needle.length < MIN_FUZZY_LENGTH) continue;

    // 2أ) حذف حرف واحد من السؤال ⇒ يغطي حرفاً زائداً في السؤال أو ناقصاً في الفهرس
    for (let cut = 0; cut < needle.length && added < MAX_EXTRA_PER_TERM; cut += 1) {
      const neighbour = needle.slice(0, cut) + needle.slice(cut + 1);
      const position = lowerBound(folded, neighbour);
      for (let i = position; i < folded.length && folded[i] === neighbour; i += 1) {
        if (added >= MAX_EXTRA_PER_TERM || extras.length >= MAX_EXPANSION_TERMS) break;
        add(terms[i]);
        added += 1;
      }
    }

    // 2ب) إبدال حرف واحد: نافذة حول موضع الإدراج (الترتيب أبجدي فيجاورها)
    const from = Math.max(0, at - FOLD_SCAN_WINDOW);
    const to = Math.min(folded.length, at + FOLD_SCAN_WINDOW);
    for (let i = from; i < to; i += 1) {
      if (added >= MAX_EXTRA_PER_TERM || extras.length >= MAX_EXPANSION_TERMS) break;
      if (Math.abs(folded[i].length - needle.length) > 1) continue;
      if (!editDistanceAtMost1(folded[i], needle)) continue;
      add(terms[i]);
      added += 1;
    }
  }
  return extras;
}

export function editDistanceAtMost1(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  // فرق حرفين فأكثر يحتاج حذفين أو إبدالين: لا حاجة لجدول برمته.
  if (Math.abs(left.length - right.length) > 1) return false;
  const columns = right.length + 1;
  let previous = new Array(columns);
  let current = new Array(columns);
  for (let column = 0; column < columns; column += 1) previous[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowMin = current[0];
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
      if (current[column] < rowMin) rowMin = current[column];
    }
    // قيم الجدول لا تنقص بالخروج عن الصف: أدنى ما تنتهي إليه المسافة هو أقل قيمة
    // في الصف الحالي، فوُجودها فوق 1 يكفي للحكم بلا حساب بقية الصفوف.
    if (rowMin > 1) return false;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length] <= 1;
}

// كلمةٌ بلا دلالة موضعية: حرف جر أو عطف أو ضمير أو أداة استفهام. إعادة الترتيب
// تُخفّفها لأنها توسّع النتائج ولا تضيّقها — «هذا» مطابق في كل صفحة تقريباً.
const FUNCTION_WORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'الي', 'على', 'عن', 'مع', 'حتى', 'كي', 'لكي', 'منذ',
  'و', 'او', 'أو', 'ثم', 'اما', 'أما', 'لكن', 'بل', 'اذ', 'أذ',
  'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'الذين', 'اللاتي', 'اللذان',
  'انا', 'أنا', 'انت', 'أنت', 'انتم', 'نحن', 'هم', 'هن', 'هو', 'هي',
  'كان', 'كانت', 'يكون', 'تكون', 'ليس', 'ليست', 'قد', 'لن', 'لم', 'لا',
  'ما', 'ماذا', 'متي', 'أين', 'اين', 'كيف', 'لماذا', 'هل', 'كم',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'that', 'this', 'it', 'as',
  'at', 'by', 'from', 'not', 'but',
]);

export function isFunctionWord(token) {
  // الطي قبل البحث: «إلى» و«إلي» و«الى» أداةٌ واحدة بثلاث رسمات.
  const word = foldArabic(token).trim();
  if (!word) return true;
  return FUNCTION_WORDS.has(word);
}
