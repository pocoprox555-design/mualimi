// تصنيف نوع الصفحة: صفحة تمارين/أسئلة تُرجَّح تأخيراً عن صفحة الشرح عند تساوي
// المطابقة، لأن سؤالاً مثل «كم عدد شرط القطع» يطابق صفحة التمارين (تكرّر المصطلح)
// وصفحة الشرح معاً. القاعدة واحدة هنا ليبنيها مقطع التقطيع وقت البناء، ويقرأها
// محرك المسح وقت التشغيل بلا فحص نصّي داخل الحلقة.
const EXERCISE_PAGE_TYPES = new Set(['exercises', 'questions', 'matching']);
const LEADING_FOLIO = /^[0-9٠-٩\s.،:؛()«»\-–—]+/;
const EXERCISE_IMPERATIVE = /^(?:اختر|عرف|اكمل|استخرج|علم|حدد|سجل|ناقش|بين|صنف|اكتب|مايأتي|سؤال|سئله|اسئله|تمارين|التمارين|تدريب|نشاط|اختبر|ميز|فك)/;
const EXERCISE_QUERY = /(?:تمرين|تمارين|تدريب|نشاط|سؤال|سئله|اسئله|واجب|اختبار|اختبر|حل)/;

// هل الاستعلام نفسه سؤال عن تمارين؟ إن كان كذلك فترجيح صفحة التمارين يعود موجباً.
export function isExerciseQuery(text) {
  return EXERCISE_QUERY.test(normalize(text));
}

function normalize(value) {
  return String(value ?? '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .toLowerCase();
}

/**
 * هل هذه الصفحة صفحة تمارين/أسئلة؟ الدليل: نوع الصفحة الموسوم، أو وجود تمارين
// منظّمة، أو عنواناً يبدأ بأمر امتحاني، أو نصاً يبدأ بأمر امتحاني بعد تجريد
// رقم الصفحة الملتصق. يُحسب مرة واحدة وقت البناء لأنه يقرأ النص.
 */
export function isExercisePage(doc) {
  if (EXERCISE_PAGE_TYPES.has(String(doc?.pageType || ''))) return true;
  if ((doc?.exercises?.length || 0) > 0) return true;
  const title = normalize(doc?.title || '').replace(LEADING_FOLIO, '');
  if (EXERCISE_IMPERATIVE.test(title)) return true;
  const text = normalize(String(doc?.text || '').slice(0, 60));
  return EXERCISE_IMPERATIVE.test(LEADING_FOLIO.test(text) ? '' : text);
}

/**
 * هل وصف هذه الصفحة الفهرسي متناقض مع نصها الحالي (يقول «لا يوجد نص» وعندها
 * نص)؟Pages هكذا تُستبعد مصطلحاتها الوصفية من الفهرسة وقت البناء، فيزول الشرط
 * الخاص عن مسار المسح بالكامل.
 */
export function isStaleOutline(doc) {
  const text = String(doc?.text || '').trim();
  if (!text) return false;
  return STALE_OUTLINE.test(String(doc?.outlineSummary || ''));
}

const STALE_OUTLINE = /(?:لا\s*(?:يمكن\s+(?:الإجابة|الاجابة|الجواب)|يتوفر\s+(?:لها\s+)?نص|يوجد\s+نص|نص\s+مستخرج)|لا\s+نص\s+مستخرج|لا\s+يوجد\s+نص|تحتاج\s+قراءة\s+بصرية|صفحة\s+مصورة|searchable:\s*false|needsOcr:\s*true)/i;
