// سياسة الاسترجاع: تُشتق كل ميزانية للسياق والدليل من نافذة النموذج الحقيقية.
//
// سابقاً كانت هذه أرقاماً سحرية مثبّتة في server/index (8 مصادر، 4 استشهادات،
// 2600 محرف للبنية)، وكان صفّرها المشكلة: اقتطاع صامت للأدلة حين يكون الكتاب
// أوسع من الحدّ الثابت. النموذج الهدف يملك نافذة مليون محرف، فتُشتق الآن كل
// الحدود من `contextWindow` الممرَّر، فلا اقتطاع إلا عند حدّ النموذج نفسه.
import { normalizeAr } from './text.mjs';

// حصر قيمة بين حدّين. تُستخدم لتقييد النافذة ولأرضيات/سقوف العد (لا تقلّ عن
// أدنى، ولا تزدّ عن أقصى) لأن النوافذ الشاذة (صغيرة جداً أو صفر) تُفسد الاشتقاق.
export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function deriveBudgets({ contextWindow = 1_000_000, maxTokens = 16_000, visionMaxTokens = 16_000 } = {}) {
  // قيم غير رقمية تمرّ أحياناً من الإعدادات؛ نرجعها للافتراضية بدل أن تُسمّم الاشتقاق بـNaN.
  contextWindow = Number.isFinite(contextWindow) ? contextWindow : 1_000_000;
  maxTokens = Number.isFinite(maxTokens) ? maxTokens : 16_000;
  visionMaxTokens = Number.isFinite(visionMaxTokens) ? visionMaxTokens : 16_000;

  const clampedWindow = clamp(contextWindow, 4_096, 1_000_000);
  // نحجز ما يطلبه المخرج (نص أو رؤية) وهامش سلامة 1024 للنظام والسلامة.
  const reserveOut = Math.max(maxTokens, visionMaxTokens, 1_024);
  const usable = Math.max(2_048, clampedWindow - reserveOut - 1_024);
  // 62% للدليل المُسترجَع، والباقي لتعليمات النظام وسجل المحادثة.
  const usableTokensForEvidence = Math.floor(usable * 0.62);

  return {
    contextWindow: clampedWindow,
    maxTokens,
    visionMaxTokens,
    usableTokens: usable,
    evidenceTokens: usableTokensForEvidence,
    // 1 محرف رمزي عربي ≈ محرفين (مقيس على هذه المكتبة). نستخدم 1.9 احتياطاً.
    // قد تتجاوز القيمة 200,000 — وهذا مقصود مع نافذة المليون، فليست سقفاً مُخترَعاً.
    evidenceChars: Math.floor(usableTokensForEvidence * 1.9),
    maxSources: clamp(Math.round(usableTokensForEvidence / 1400), 8, 48),        // كان مثبّتاً 8
    maxCited: clamp(Math.round(usableTokensForEvidence / 900), 8, 32),           // كان مثبّتاً 4
    maxCrossBook: clamp(Math.round(usableTokensForEvidence / 4000), 2, 16),      // كان مثبّتاً 2
    maxPageRequests: clamp(Math.round(usableTokensForEvidence / 5000), 2, 12),   // كان مثبّتاً 4
    maxImages: clamp(Math.round(usableTokensForEvidence / 12000), 1, 12),        // كان مثبّتاً 2
    pageChars: 8_000,            // أقصى صفحة مقيسة في المكتبة 3847؛ 8000 هامش آمن
    structureChars: 24_000,      // كان 2600 (اقت ّطع 21 صفحة)؛ أكبر صفحة منظّمة 5734
    outlineHeaderChars: 8_000,   // أكبر ترويسة مخطط مقيسة 3007
    outlineDigestChars: 120_000, // كان 60,000 وغير مُستوفى أبداً؛ سخي لأسئلة البنية
    previewChars: 1_400,
    summaryChars: 2_000,         // كان 700
    blockSeparator: '\n\n---\n\n',
  };
}

// لا اقتطاع صامت: النموذج والطالبة كلاهما يرى ما أُزيل. عند تجاوز الحدّ نُلحق
// إشعاراً بعدد المحارف المحذوفة، ونقطع عند فاصل كلمة إن أمكن حتى لا نشوّه كلمة.
export function truncateHonestly(value, max, label = 'المحتوى') {
  const text = String(value ?? '');
  const cap = Math.max(0, Math.floor(Number(max) || 0));
  if (text.length <= cap) return text;
  let cut = text.slice(0, cap);
  // لا نقطع وسط كلمة: نرتدّ لآخر فاصل (مسافة أو سطر) إن كان قريباً (≤120 محرفاً)،
  // وإلا نقطع قسرياً عند الحدّ حمايةً للنافذة.
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (lastBreak >= 0 && cap - lastBreak <= 120) cut = text.slice(0, lastBreak);
  const omitted = text.length - cut.length;
  return `${cut}\n[… اقتُطع ${omitted} محرفاً من ${label} ضمن حد نافذة النموذج؛ لا تذكر ما اقتُطع كأنه كامل …]`;
}

// اختبار موثوقية مصدر واحد ليكون أصلاً للاقتباس الحرفي. المرآة: pdf-image بعد
// رؤية بصرية، أو pdf-fallback نظيف/ocr صريح، أو نص pdf مُستخرج سليم بلا تلف.
function reliableSource(s) {
  const status = String(s?.evidenceStatus || s?.status || '').toLowerCase();
  const type = String(s?.evidenceType || '').toLowerCase();
  if (status === 'damaged-text' || type === 'damaged-text') {
    return s?.evidenceType === 'pdf-image' && s?.visionProvided === true;
  }
  if (s?.sourceType === 'pdf-fallback') {
    return s?.readable === true && s?.quotableReliable === true
      && ['pdf-text', 'ocr-text'].includes(type)
      && (!status || ['clean-extracted-text', 'ocr-text'].includes(status));
  }
  return type === 'pdf-text' && s?.quotableReliable === true && status !== 'damaged-text';
}

// يقرّر ما يُسمح للنموذج فعله حين لا يوجد دليل محلي قابل للاقتباس. وضعان فقط:
// grounded حين يوجد مصدر موثوق أو مطابقة دقيقة موثوقة، وإلا ungrounded (شرح عام).
// أدلة الويب والكتالوج لا تُحتسب: الأولى خارجية ليست من الكتاب، والثانية بيانات
// وصفية لا نص صفحة؛ فكلتاهما لا تُصلح مصدراً للنقل الحرفي عن صفحة بعينها.
export function decideEvidencePolicy({ sources = [], exactResults = [], pageGate = false } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const exact = Array.isArray(exactResults) ? exactResults : [];
  const reliable = list.filter(reliableSource).length + exact.filter((r) => r?.reliable === true).length;
  if (reliable > 0) return { mode: 'grounded', reason: 'دليل محلي موثوق متاح.', hasQuotable: true };

  const total = list.length + exact.length;
  const rejected = total; // reliable = 0 هنا، فكل المرشحين مرفوضون
  const base = total > 0
    ? `لا يوجد دليل محلي موثوق: رُفض ${rejected} من ${total} مرشح صفحة/مطابقة لعدم اجتياز فحص السلامة.`
    : 'لا توجد أي مصادر صفحة أو مطابقة محلية مرفقة لهذا السؤال.';
  // طلبت الطالبة صفحة بعينها فلا يُعوَّض النقص شرحاً من الكتاب؛ يُصرَّح بذلك.
  const gate = pageGate ? ' وقد طُلبت صفحة بعينها، فالنقل عن الكتاب غير ممكن هنا.' : '';
  return { mode: 'ungrounded-teaching-only', reason: `${base}${gate}`, hasQuotable: false };
}

export const GROUND_FIRST_SENTENCE = 'هذا شرح عام من معرفتي بالمنهج، لا من نصّ صفحة؛ لا يوجد في مكتبتك دليل مباشر لهذا السؤال.';

// تعليمات «الشرح العام» حين لا يوجد دليل قابل للاقتباس. قواعد صارمة تمنع اختلاق
// نص أو صفحة أو إحالة، وتُلزم بافتتاحية صادقة واحدة، بلا اعتذار ولا طلب نسخ.
export const UNGROUNDED_INSTRUCTION = [
  'لا يوجد دليل موثوق من كتب المنهج في هذا الطلب، فأنتِ الآن في وضع «شرح عام» لا وضع «نقل عن الكتاب». قواعد صارمة:',
  'ممنوع منعاً باتاً: نقل أي نص من كتاب، أو ذكر رقم صفحة، أو ذكر عنوان صفحة، أو ذكر عدد فصول أو وحدات أو دروس أو أبواب أو مباحث، أو ذكر رقم آية أو راوٍ، أو ذكر تمرين أو جدول بعينه، أو نسبة أي معلومة إلى كتاب بعينه.',
  'مسموح: شرح المفهوم شرحاً pedagogياً عاماً من معرفتك بالمنهج.',
  `إلزام: ابدئي الرد حرفياً بهذه الجملة: «${GROUND_FIRST_SENTENCE}»`,
  'لا تعتذري، ولا تطلبي من الطالبة كتابة نص الصفحة، ولا تذكري حدود الأدوات.',
].join('\n');

// الكلمات الدالة الافتتاحية (طولها ≥4 بعد التوحيد) تُحسب مرة واحدة عند التحميل.
const SIGNIFICANT_DISCLOSURE = normalizeAr(GROUND_FIRST_SENTENCE)
  .split(' ')
  .filter((word) => word.length >= 4);

// هل بدأ الرد بالإفصاح الصادق المطلوب؟ نوحّد النصّين (NFKC، حذف تشكيل، توحيد
// الهمزة والتاء المربوطة، طيّ المسافات) عبر normalizeAr، ونطلب أن تتضمّن أول
// 260 محرفاً ≥70% من كلمات الجملة الافتتاحية الدالة — تحمّل صياغة النموذج المختلفة.
export function answerStartsWithDisclosure(text) {
  const significant = SIGNIFICANT_DISCLOSURE;
  if (!significant.length) return true;
  const head = normalizeAr(String(text ?? '').slice(0, 260));
  const headWords = new Set(head.split(' '));
  const hits = significant.filter((word) => headWords.has(word)).length;
  return hits / significant.length >= 0.7;
}
