// إعادة صياغة السؤال المستقل: عندما تسأل الطالبة سؤال متابعة («وماذا عن…»، «الصفحة
// التالية») فقد يحمل سؤالها مرساة (رقم صفحة/كتاب) ضمن سابقة المحادثة لا في نصّه.
// الاسترجاع لا يخمّن: نستخرج المرساة من آخر مدخلات ونُلحقها صراحةً، فنحوّل السؤال
// المعلّق إلى سؤال مستقل كامل يفهمه محرّك البحث وحده. دوال نقية بلا آثار جانبية.
import { pageReference } from './text.mjs';

const QUERY_CAP = 600;

// إشارات المتابعة. القائمة واسعة عمداً: إن أخطأ الكشف لا يضرّ، لأن standaloneQuery
// لا يُلحق مرساةً إلا إن وُجدت فعلاً في السابقة؛ فالإيجابية الكاذبة غير مكلّفة.
const FOLLOW_CORE = new RegExp([
  'وماذا\\s*عن',
  'وفما',
  '^وش',
  '^وما',
  'وكذلك',
  'وهل\\s*هو',
  'السابق',
  'اللي\\s*فات',
  'هذا\\s*الان',
  'التي\\s*بعدها',
  'التالي[ةه]',
  'الموالي[ةه]',
  '^ثم\\b',
].join('|'));

export function isFollowUp(question) {
  const text = String(question ?? '').trim();
  if (!text) return false;
  // سؤال غير عربي (أمر لاتيني/أرقام) ليس متابعةً منهجية.
  if (!/[\u0621-\u064A]/.test(text)) return false;
  if (FOLLOW_CORE.test(text)) return true;
  // واو العطف في أول سؤال قصير (<60) إشارة متابعة («وماذا»، «وهل»…). أمّا الواو
  // في أول كلمة علم («وحدة»، «موضوع») فليست متابعة؛ وطول السؤال يميّز الحالتين.
  return /^\s*و/.test(text) && text.length < QUERY_CAP / 10;
}

// استخراج المرساة من نصّ: رقم صفحة مطبوعة عبر pageReference، وتلميح كتاب/مادة خفيف.
export function extractAnchors(question) {
  const text = String(question ?? '');
  const printedPage = pageReference(text);
  let bookHint = null;
  const book = text.match(/كتاب\s+([^\s،.؟!:]{2,40})/i);
  if (book) bookHint = book[1].trim();
  if (!bookHint) {
    const subject = text.match(/(?:مادة|منهج|في)\s+(عربي|رياضيات?|فيزياء|كيمياء|علوم|إسلامية|تاريخ|جغرافية|انكليزي|حاسوب)/i);
    if (subject) bookHint = subject[1].trim();
  }
  return { printedPage, bookHint };
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function entryText(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return entry;
  return String(entry.text ?? entry.content ?? entry.question ?? entry.query ?? '');
}

// حصر الطول النهائي أبداً. لا نقطع منتصف كلمة إن أعقبنا بنصّ رسمي، نكتفي بالحصر.
function cap(value) {
  const text = String(value ?? '');
  return text.length > QUERY_CAP ? text.slice(0, QUERY_CAP) : text;
}

// حلّ تلميح إلى معرّف كتاب عبر resolver ممرَّر. آمن: لا يرمي ولا ينتظر أكثر من لازم.
async function safeResolveBook(hint, resolvers) {
  const resolve = resolvers?.resolveBook;
  if (typeof resolve !== 'function' || !hint) return null;
  try {
    const result = await resolve(hint, {});
    if (result == null) return null;
    if (typeof result === 'string') return result;
    return result.id ?? result.bookId ?? result.book?.id ?? null;
  } catch {
    return null;
  }
}

// موضع الصفحة الفيزيائية من المطبوعة عبر resolver ممرَّر. آمن ضد الأخطاء والقيم الرديئة.
async function safeLocate(bookId, printedPage, resolvers) {
  const locate = resolvers?.locate;
  if (typeof locate !== 'function' || bookId == null || printedPage == null) return null;
  try {
    const result = await locate(bookId, printedPage);
    return positiveInt(result);
  } catch {
    return null;
  }
}

// مرساة مدخل واحد: صفحته المطبوعة ومعرّفه/عنوانه من الحقول أو من نصّه، وإلّا بحلّ تلميحه.
async function anchorFromEntry(entry, resolvers) {
  const text = entryText(entry);
  const parsed = extractAnchors(text);
  const printedPage = parsed.printedPage ?? positiveInt(entry?.printedPage ?? entry?.page);
  const hint = parsed.bookHint ?? entry?.bookHint ?? entry?.book ?? null;
  let bookId = entry?.bookId ?? null;
  if (bookId == null && hint != null) bookId = await safeResolveBook(hint, resolvers);
  const bookTitle = entry?.bookTitle ?? hint ?? bookId ?? null;
  return { printedPage, bookId, bookTitle, bookHint: hint, text };
}

const NEXT_EXPR = /(?:التالي[ةه]|الموالي[ةه]|التي\s*بعدها|اللي\s*بعدها|الصفحة\s*(?:التالية|الموالية)|بعد\s*هذه|next)/i;
const PREV_EXPR = /(?:السابقت[ةه]|السابق|اللي\s*فات|قبلها|الصفحة\s*السابقة|previous|prev)/i;

/**
 * يحوّل سؤال متابعة إلى سؤال مستقل، بجمع المرساة (صفحة/كتاب) من سابقة المحادثة.
 * @param {string} question نص السؤال الحالي.
 * @param {Array} history مدخلات المحادثة السابقة ({text|content,…} أو نصوص خامة).
 * @param {{resolveBook?:Function, locate?:Function}} resolvers حلّ الكتاب وموضع الصفحة.
 * @returns {Promise<string>} سؤال مستقل، بلا رمي أبداً، محلوص بطول ≤600.
 */
export async function standaloneQuery(question, history = [], resolvers = {}) {
  let query = String(question ?? '').trim();
  if (query.length > QUERY_CAP) query = query.slice(0, QUERY_CAP);
  // ليست متابعة، أو السابقة أقصر من جولتين: لا مرساة تُستخرج، نُرجع السؤال كما هو.
  if (!isFollowUp(query) || !Array.isArray(history) || history.length < 2) return query;

  // نرجع في المدخلات من الأحدث (آخر 6) ونأخذ أول مدخل يحمل مرساة صالحة.
  let anchor = null;
  for (const entry of history.slice(-6).reverse()) {
    const candidate = await anchorFromEntry(entry, resolvers);
    if (candidate.printedPage != null || candidate.bookId != null || candidate.bookTitle != null) {
      anchor = candidate;
      break;
    }
  }
  if (!anchor) return query;

  const bookId = anchor.bookId ?? anchor.bookTitle ?? 'الكتاب';
  // للنصّ المقروء (القوس والتقديم) نفضّل عنوان/تلميح الكتاب على المعرّف الداخلي.
  const humanLabel = anchor.bookTitle ?? anchor.bookHint ?? anchor.bookId ?? 'الكتاب';
  const wantsNext = NEXT_EXPR.test(query);
  const wantsPrev = PREV_EXPR.test(query);

  // طلب صفحة مجاورة («التالي/قبلها») ومعناها صراحةً إلى موضع فيزيائي عبر locate.
  if ((wantsNext || wantsPrev) && anchor.printedPage != null) {
    const physical = await safeLocate(bookId, anchor.printedPage, resolvers);
    if (physical != null) {
      const target = wantsNext ? physical + 1 : physical - 1;
      if (target >= 1) return cap(`اشرحي الصفحة ${target} من ${bookId}`);
    }
  }

  // مرساة عامة: نُلحقها بين قوسين صراحةً حتى لا يخمّن الاسترجاع المقصود.
  let out = anchor.printedPage != null
    ? `${query} (المقصود: الصفحة ${anchor.printedPage} من ${humanLabel})`
    : query;
  // إن ذكرت المرساة كتاباً/مادة بعينها نقدّمه أمام السؤال حتى يُرجَّح في البحث.
  if (humanLabel && humanLabel !== 'الكتاب') out = `${humanLabel} — ${out}`;
  return cap(out);
}
