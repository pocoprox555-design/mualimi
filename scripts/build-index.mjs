// يبني الفهرس canonical مرة واحدة من pdf-index.json.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, compact, normalizeAr, normalizeDigits, topKeywords, searchTokens, uniqueTokens } from '../lib/text.mjs';
import { getOutline } from '../lib/outline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCE = path.join(LIBRARY, 'pdf-index.json');
const OUTPUT = path.join(LIBRARY, 'search-index.json');
const ENRICHMENT_DIR = path.join(LIBRARY, 'enrichment');
const SERIALIZED_FIELD = /^\s*\{\s*"(?:text|title|summary)"\s*:/;
const CJK = /[\u3400-\u9fff]/u;
// حروف الطباعة تعلو كل صفحة مطبعة من المصانع وتفسد التوكنات والكلمات المفتاحية.
// النمط يتضمّن أي slug مصنع لا يتقيّد بتسمية واحدة (IRAQ_G12_TB_2025_EXTENDED مثلاً).
const PRESS_SLUG = /IRAQ_[A-Z0-9]+(?:_[A-Z0-9]+)*\.indb/gi;
// الشريحة المطبوعة هي «اسم_الملف رقم_الصفحة»: الرقم جزء من الشريحة لا من المتن، فيُزال معها.
const PRESS_SLAB_LINE = /(?:IRAQ_[A-Z0-9]+(?:_[A-Z0-9]+)*\.indb[ \t]*\d{1,4}|\d{1,4}[ \t]+IRAQ_[A-Z0-9]+(?:_[A-Z0-9]+)*\.indb)/gi;
const PRESS_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/g;
// رقم الصفحة المطبوع يلتصق بأول سطر من النص المستخرج («115 Act 1, Scene 1 …»).
// البديل الأقصر (رقمان مفصولان بمسافة) يسبق الرقم الصلب حتى لا يُؤكل نصف رقم حقيقي («11 3 - العوامل» = 113).
const LEADING_FOLIO = /^((?:[0-9٠-٩۰-۹]{1,2}\s+[0-9٠-٩۰-۹]{1,2})|[0-9٠-٩۰-۹]{1,4})(?:\s+|$)/;
const TRAILING_FOLIO = /(?:\s)((?:[0-9٠-٩۰-۹]{1,2}\s+[0-9٠-٩۰-۹]{1,2})|[0-9٠-٩۰-۹]{1,4})\s*$/;
// تلف النص: بديل استخراجي محلي عن hasTextDamage في lib/text.mjs (وحدة ليُوحَّد لاحقاً).
const DAMAGED = /[\uFFFD\uE000-\uF8FF]/;
const FOLIO_DIGITS = '[0-9٠-٩۰-۹]';

// النص يحتفظ بأي محتوى حقيقي مهما قصر؛ أما «قابل للبحث» فيبقى له حدّه الأدنى 20 محرفاً:
// صفحة من ست كلمات لا تُعامَل كصفحة نصية كاملة، لكنها تُحفظ حتى لا يخفيها الفهرس عن النموذج.
const SEARCHABLE_MIN = 20;
// حد أدنى للملخص كي لا يصبح اقتطاعاً فارغاً (اختبار الفهرس يتطلب 20 محرفاً).
const SUMMARY_MIN = 20;
// ترقيم الفصول والدروس مطبوع داخل المتن («تمارين 1 - 5»)؛ نرفض العنوان الصوري منه.
const TITLE_PATCH = /(تكملة|تتمة|تتمه|لا عنوان|لا يوجد عنوان|لا نصّ|لا نص |لا يوجد نص|لا يمكن الإجابة|بعدة صفحات|صفحة تالية فقط|مكرر)/;
// جملة المخطط التي تصف الصفحة بصرياً لا تُفهرس: «لا يوجد نص مستخرج» و«searchable: false».
const OUTLINE_NEGATIVE = /(غير واضح|لا يوجد عنوان|لا نص مستخرج|لا يوجد نص مستخرج|لا يمكن|لا يتوفر|تحتاج قراءة بصرية|searchable:\s*false|needsOcr:\s*true|صفحة مصورة)/;
// قالب ميت يصف الكتاب كله ولا يصف الصفحة: يُستبدل بوصف مُشتق من الصفحة نفسها.
const BOOK_LEVEL_PURPOSE = /^(?:نص الصفحة مستخرج من كتاب|صفحة مصورة من كتاب|محتوى الصفحة: صفحة (?:مقدمة|غلاف|فاصلة))/;
const PURPOSE_FALLBACK = 'الهدف التربوي لهذه الصفحة لم يُحدَّد في المصدر؛ اعتمد العنوان والملخص والنص.';
// صفحة بلا نص تستند إلى وصف المخطط، فيبقى لها دليل يُعرض بدل الفراغ.
const OUTLINE_FALLBACK = 'وصف بصري لهذه الصفحة؛ لا يتوفّر لها نص مطبوع في الكتاب، ولا يُنسب إليها سؤال قبل قراءتها.';

// نص طويل يُقتطع عند حد كلمة لا في وسطها.
function clipAtWord(value, max = 140) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
}

// مسطرة الكتابة في تمارين اللغة الإنكليزية («______» × 58) رسم لا نص: تُختصر إلى فراغ واحد
// حتى لا تُضخّم النص المخزَّن ولا تُزيح حساب التغطية. نقاط الفهرس العربية («….») لا تُمَس.
const WRITE_RULE = /_{6,}/g;

function stripPressSlab(value) {
  return cleanText(value)
    .replace(PRESS_SLAB_LINE, ' ')
    .replace(PRESS_SLUG, ' ')
    .replace(PRESS_STAMP, ' ')
    .replace(WRITE_RULE, '_')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// رقم الصفحة المطبوع يلتصق بأول سطر من النص المستخرج، وقد يتكرر («178 178 Appendix A …»).
// رقم واحد له قراءتان في النص المستخرج: «11 3 - العوامل» = folio‎11 ثم رقم بند 3،
// و«1 0 الحياة» = folio‎10 مكتوباً مقسوماً. لذا تُجرى القراءتان وتُنزع أطولُهما المطابقة للفolio
// المثبَّت، فلا يُؤكل رقم حقيقي ولا يبقى folio منقوصاً.
const FOLIO_SPLIT = /^([0-9٠-٩۰-۹]{1,2})[ \t]+([0-9٠-٩۰-۹]{1,2})(?=[ \t]|$)/;
const FOLIO_SOLID = /^([0-9٠-٩۰-۹]{1,4})(?=[ \t]|$)/;
const FOLIO_SPLIT_TAIL = /(?<=[ \t])([0-9٠-٩۰-۹]{1,2})[ \t]+([0-9٠-٩۰-۹]{1,2})[ \t]*$/;
const FOLIO_SOLID_TAIL = /(?<=[ \t])([0-9٠-٩۰-۹]{1,4})[ \t]*$/;

function stripLeadingFolio(value, printedPage) {
  if (!printedPage) return value;
  let out = value;
  for (let guard = 0; guard < 4; guard += 1) {
    const newline = out.indexOf('\n');
    const head = newline < 0 ? out : out.slice(0, newline);
    const split = head.match(FOLIO_SPLIT);
    const solid = head.match(FOLIO_SOLID);
    let cut = 0;
    if (split && Number(normalizeDigits(`${split[1]}${split[2]}`)) === printedPage) cut = split[0].length;
    else if (solid && Number(normalizeDigits(solid[1])) === printedPage) cut = solid[0].length;
    if (!cut) break;
    const rest = head.slice(cut);
    out = (newline < 0 ? rest : `${rest}${out.slice(newline)}`).replace(/^[ \t]+/, '').replace(/^\n+/, '');
  }
  return out;
}

// رقم الصفحة المطبوع يُلصق في ذيل الصفحة أيضًا («… something 109 109»). لا يُمسّ رقم مفرد
// حتى لا نأكل رقماً حقيقياً في نهاية صفحة حسابية.
function stripTrailingFolio(value, printedPage) {
  if (!printedPage) return value;
  let out = value.trimEnd();
  let stripped = 0;
  while (stripped < 2) {
    const split = out.match(FOLIO_SPLIT_TAIL);
    const solid = out.match(FOLIO_SOLID_TAIL);
    let index = null;
    if (split && Number(normalizeDigits(`${split[1]}${split[2]}`)) === printedPage) index = split.index + split[0].indexOf(split[1]);
    else if (solid && Number(normalizeDigits(solid[1])) === printedPage) index = solid.index;
    if (index == null) break;
    out = out.slice(0, index).trimEnd();
    stripped += 1;
  }
  return stripped >= 2 ? out : value;
}

// folio مستخرج من شريحة الطباعة نفسها («IRAQ_G12_SB_2024.indb 46»).
function slugFolio(value) {
  const match = normalizeDigits(String(value || '')).match(/\.indb\s+([0-9]{1,4})\b/i);
  return match ? Number(match[1]) : null;
}

// كل القراءات الممكنة للرقم في أول سطرين أو آخر سطرين من نص الصفحة، بأي صورة للأرقام.
function folioLines(value) {
  return String(value || '').split('\n').map((line) => normalizeDigits(cleanText(line)).replace(/[ \t]{2,}/g, ' ').trim());
}

function folioValues(match) {
  if (!match) return [];
  return [Number(normalizeDigits(match[2] ? `${match[1]}${match[2]}` : match[1]))].filter(Number.isInteger);
}

function headFolioValues(value) {
  const out = [];
  for (const line of folioLines(value).slice(0, 2)) out.push(...folioValues(line.match(FOLIO_SPLIT)), ...folioValues(line.match(FOLIO_SOLID)));
  return [...new Set(out)];
}

function tailFolioValues(value) {
  const out = [];
  for (const line of folioLines(value).slice(-2)) out.push(...folioValues(line.match(FOLIO_SPLIT_TAIL)), ...folioValues(line.match(FOLIO_SOLID_TAIL)));
  return [...new Set(out)];
}

function hasLetters(value) {
  return /[\p{L}]/u.test(value);
}

// صفحة بلا حرف واحد ليست صفحة: أرقام مجرّدة أو رموز. نص حقيقي مهما قصر يبقى.
function usableText(value) {
  const text = stripPressSlab(value || '');
  return text.length >= 1 && hasLetters(text) && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

// معاينة تُظهر بداية الصفحة وآخرها بدل قصّها في منتصف كلمة، مع إعلان صريح عن المحذوف.
const PREVIEW_HEAD = 700;
const PREVIEW_TAIL = 400;
function buildPreview(value) {
  if (value.length <= PREVIEW_HEAD + PREVIEW_TAIL) return value;
  const head = value.slice(0, PREVIEW_HEAD);
  const tail = value.slice(-PREVIEW_TAIL);
  const omitted = value.length - PREVIEW_HEAD - PREVIEW_TAIL;
  return `${head} …[تم حذف ${omitted} حرفاً من هذه الصفحة؛ النص الكامل في الحقل text]… ${tail}`;
}

async function loadEnrichment() {
  const all = new Map();
  let files;
  try { files = (await readdir(ENRICHMENT_DIR)).filter((name) => name.endsWith('.json')).sort(); } catch { return all; }
  for (const name of files) {
    const bookId = name.replace(/\.json$/, '');
    const raw = JSON.parse(await readFile(path.join(ENRICHMENT_DIR, name), 'utf8'));
    if (raw.schemaVersion !== 1 || raw.bookId !== bookId) continue;
    all.set(bookId, raw.pages || {});
  }
  return all;
}

function usableMetadata(value) {
  const text = stripPressSlab(value || '');
  return text && !SERIALIZED_FIELD.test(text) && !CJK.test(text) ? text : '';
}

// ملخّص المخطط يُقبل للعرض فقط إذا خلا من عبارات «لا يوجد نص» و«searchable:false».
function usefulOutlineValue(value) {
  return cleanText(value || '') && !OUTLINE_NEGATIVE.test(value);
}

// التنظيف لا يترك للصفحة بلا نص واصفاً فارغاً: يُبقي الجمل التي فيها معلومة فعلية
// («التمرين 1: عرّف ما يأتي») ويُسقط جملة «لا نص مستخرج (تحتاج قراءة بصرية)».
function cleanOutlineSummary(value) {
  const raw = cleanText(value || '');
  if (!raw) return '';
  if (!OUTLINE_NEGATIVE.test(raw)) return raw;
  const parts = raw.split(/\n+|(?<=[.!؟?])\s+/).map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => !OUTLINE_NEGATIVE.test(part));
  const rest = kept.join(' ').replace(/\s+/g, ' ').trim();
  return rest.length >= 60 ? rest : '';
}

// عنوان الصفحة يُقاس لا أن يُفترض: كل مرشّح يُقاس بمكوّناته (ترقيع؟ رقم صفحة؟
// كلمات؟ تغطية من نص الصفحة نفسها؟) فيُختار الأعلى، ويُقصّ عند حدود كلمة.
const TITLE_FOLIO_HEAD = new RegExp(`^\\s*${FOLIO_DIGITS}{1,2}\\s+${FOLIO_DIGITS}{1,2}(?:\\s+|$)|^\\s*${FOLIO_DIGITS}{1,4}(?:\\s+|$)`);
const TITLE_FOLIO_TAIL = new RegExp(`(?:\\s)${FOLIO_DIGITS}{1,2}\\s+${FOLIO_DIGITS}{1,2}\\s*$|(?:\\s)${FOLIO_DIGITS}{1,4}\\s*$`);

function hasBareFolio(value) {
  return TITLE_FOLIO_HEAD.test(value) || TITLE_FOLIO_TAIL.test(value);
}

function titleWords(value) {
  return cleanText(value).split(/\s+/).filter((word) => hasLetters(word));
}

function titleCoverage(value, text) {
  const haystack = normalizeAr(text);
  if (!haystack) return null;
  const tokens = [...new Set(normalizeAr(value).split(' ').filter((word) => word.length >= 4 && hasLetters(word)))];
  if (!tokens.length) return null;
  return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
}

function scoreTitle(value, weight, text) {
  const title = cleanText(value);
  if (!title) return -1;
  if (/indb|iraq_/i.test(title)) return -1;
  const words = titleWords(title);
  if (!words.length) return -1;
  let score = weight;
  if (TITLE_PATCH.test(title)) score -= 6;
  if (hasBareFolio(title)) score -= 3;
  if (words.length === 1) score -= 2.5;
  if (words.length >= 3) score += 2;
  score += Math.min((title.match(/\p{L}/gu) || []).length, 60) / 30;
  if (title.length < 8) score -= 3;
  if (title.length > 140) score -= 2;
  const coverage = titleCoverage(title, text);
  if (coverage != null) score += coverage * 4;
  return score;
}

// أول سطر وصفي من المتن حين يكون العنوانان الموروثان ترقيعاً («تكملة»، «لا عنوان»).
function firstDescriptiveLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = cleanText(raw);
    if (!line || line.length < 6 || line.length > 150) continue;
    if (!hasLetters(line) || /indb|iraq_/i.test(line)) continue;
    if (hasBareFolio(line)) continue;
    return line;
  }
  return '';
}

function pageTitle(page, outlinePage, extra, text) {
  const candidates = [
    { value: extra?.title, weight: 3 },
    { value: page.title, weight: 2 },
    { value: outlinePage?.title, weight: 1 },
    { value: firstDescriptiveLine(text), weight: 0 },
  ];
  let best = null;
  for (const candidate of candidates) {
    const score = scoreTitle(candidate.value, candidate.weight, text);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { value: candidate.value, score };
  }
  return clipAtWord(best?.value || 'صفحة تعليمية');
}

// الملخص يغطّي الصفحة كلها: من أولها ووسطها وآخرها، لا أول جملتين فقط.
function spreadSummary(text, max = 460) {
  const flat = cleanText(text).replace(/\s+/g, ' ');
  if (!flat) return '';
  const sentences = flat.split(/(?<=[.!؟?؟])\s+/).map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 18 && !/indb|iraq_/i.test(sentence));
  if (!sentences.length) return compact(flat, max);
  if (sentences.length <= 4) return compact(sentences.join(' '), max);
  const last = sentences.length - 1;
  const picks = new Set([0, Math.floor(last / 2), last]);
  for (const step of [last / 4, (3 * last) / 4]) picks.add(Math.round(step));
  return compact([...picks].sort((a, b) => a - b).map((index) => sentences[index]).join(' '), max);
}

function pageSummary(page, title, outlineSummary, fullText, isTemplate) {
  if (!fullText && usefulOutlineValue(outlineSummary)) return compact(outlineSummary, 520);
  const reviewed = compact(usableMetadata(page.summary), 420);
  // ملخّص ميت واحد يتكرر على الكتاب كله لا يصف الصفحة: يُستبدل بوصف موزّع على الصفحة.
  if (!isTemplate && reviewed.length >= 40 && !/indb|iraq_/i.test(reviewed)) return reviewed;
  const spread = spreadSummary(fullText);
  if (spread.length >= SUMMARY_MIN) return spread;
  if (reviewed.length >= SUMMARY_MIN) return reviewed;
  if (!fullText) return 'صفحة مصورة تحتاج قراءة بصرية؛ لا يوجد نص مستخرج منها.';
  return compact(`${title ? `تتناول: ${title}. ` : ''}${fullText.replace(/\s+/g, ' ')}`, 460)
    || 'محتوى تعليمي من الكتاب المدرسي.';
}

const raw = JSON.parse(await readFile(SOURCE, 'utf8'));
const enrichment = await loadEnrichment();
const books = [];
const documents = [];
const printed = {};
const documentFrequency = {};
let outlinePages = 0;
let enrichedPages = 0;

// الغرض التربوي الميت مربوط بـ pageType قديم، فيتكرر عبر كتب لا داخلها فقط؛
// فيُقاس عبر المكتبة كلها: قيمة واحدة على خمس صفحات فأكثر قالب لا وصف لصفحة.
const purposeFrequency = new Map();
for (const book of raw.books || []) {
  for (const page of book.pages || []) {
    const value = cleanText(page.educationalPurpose || '');
    if (value) purposeFrequency.set(value, (purposeFrequency.get(value) || 0) + 1);
  }
}

// رقم الصفحة المطبوع لا يُخمن (README). ثلاثة مصادر فقط، وكلها مبنية على دليل:
// 1) parser        : القيمة التي قرأها مستخرِج الـPDF من تذييل الصفحة.
// 2) outline-footer: الرقم المقروء من شريط التذييل في outlines/<id>.md.
// 3) own-text      : الرقم نفسه داخل نص الصفحة، ولا يُقبل إلا إذا طابق إزاحةَ الـparser.
// رقم شريحة المصنع («IRAQ_G12_SB_2024.indb 97») بيانات نشر لا folio، فلا يُشتق منه رقم صفحة.
// ما لا يثبته أي مصدر = null، وتبقى الإزاحة المرجّعة في pageOffsetHint كتلميح لا كحقيقة.
function printedPageFor(page, outlinePage, verifiedFolio) {
  const parsed = page.printedPage ?? page.printedPageNumber;
  if (Number.isInteger(parsed)) return { printedPage: parsed, source: 'parser' };
  const footerRaw = normalizeDigits(String(outlinePage?.printedPage ?? '')).trim();
  const footer = /^\d{1,4}$/.test(footerRaw) ? Number(footerRaw) : null;
  const slug = slugFolio(page.fullText);
  if (footer != null) return { printedPage: footer, source: slug === footer ? 'outline-footer+own-text' : 'outline-footer' };
  if (verifiedFolio != null) return { printedPage: verifiedFolio, source: 'own-text' };
  return { printedPage: null, source: 'unknown' };
}

// الإزاحة المرجّعة للكتاب تُشتق من صفحات الـparser فقط، وتُستخدم للتحقق لا للتخمين:
// لا يُقبل folio من نص الصفحة إلا إذا طابق إزاحةً أثبتها الـparser في صفحات أخرى من الكتاب نفسه.
function bookOffsets(pages) {
  const offsets = new Set();
  for (const page of pages) {
    const physicalPage = Number(page.physicalPage ?? page.pageNumber);
    const parsed = page.printedPage ?? page.printedPageNumber;
    if (Number.isInteger(parsed)) offsets.add(parsed - physicalPage);
  }
  return offsets;
}

// الغرض التربوي في `pdf-index` مربوط بـ pageType قديم، فنقله كما هو يُنسب للصفحة ما لا يخصّها.
// القاعدة: purpose المُغذّاة أولاً، ثم قيمة المصدر إن كانت خاصة بهذه الصفحة لا قالباً على الكتاب كله،
// وإلا يُشتق من الصفحة نفسها بدل ترك الحقل فارغاً.
function purposeFor(page, extra, purposeFrequency) {
  const enriched = cleanText(extra?.educationalPurpose || '');
  if (enriched) return enriched;
  const raw = cleanText(page.educationalPurpose || '');
  if (raw && !BOOK_LEVEL_PURPOSE.test(raw) && (purposeFrequency.get(raw) || 0) < 5) return raw;
  const derived = compact(
    [cleanText(page.title || ''), cleanText(page.summary || '').split(/(?<=[.!؟?])\s+/)[0]].filter(Boolean).join(' — '),
    240,
  );
  return derived.length >= 20 ? derived : PURPOSE_FALLBACK;
}

// الحقول المنظّمة تأتي من التغذية البصرية؛ ما لم تُغطَّ فيه يبقى من المستخرِج.
function applyEnrichment(doc, extra) {
  if (!extra) return doc;
  const assign = (key, value) => {
    if (value == null) return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'string' && !value.trim()) return;
    doc[key] = value;
  };
  for (const key of ['unit', 'work', 'author', 'section', 'sectionPath', 'actScene', 'pageType', 'title', 'titleEn', 'summary', 'summaryEn', 'answerKeyLocation', 'continuesOn', 'recapOf', 'notes', 'vocabulary', 'lessonRange', 'educationalPurpose']) {
    assign(key, extra[key]);
  }
  for (const key of ['glossary', 'glossaryRefs', 'figures', 'activities', 'exercises', 'verifiedNumbers']) {
    assign(key, extra[key]);
  }
  doc.enriched = true;
  enrichedPages += 1;
  return doc;
}
for (const book of raw.books || []) {
  const pages = book.pages || [];
  const outline = await getOutline(book.id);
  const outlineByPage = new Map((outline?.pages || []).map((page) => [page.physicalPage, page]));
  outlinePages += outlineByPage.size;
  const bookEnrichment = enrichment.get(book.id) || {};
  const offsets = bookOffsets(pages);
  const offsetHint = offsets.size === 1 ? [...offsets][0] : null;
  // «ملخّص الكتاب كله» يُقاس بعدّاد القيم المكرّرة داخل الكتاب نفسه، لا بقائمة مكتوبة يدوياً.
  const summaryCounter = new Map();
  for (const page of pages) {
    const value = compact(stripPressSlab(page.summary || ''), 420);
    if (value) summaryCounter.set(value, (summaryCounter.get(value) || 0) + 1);
  }
  const searchablePageCount = pages.filter((page) => {
    const text = usableText(page.fullText);
    return text.length >= SEARCHABLE_MIN;
  }).length;
  books.push({
    id: book.id,
    title: cleanText(book.title),
    subject: cleanText(book.subject),
    branch: cleanText(book.branch || 'عام'),
    track: cleanText(book.track || book.branch || 'عام'),
    supplementary: Boolean(book.supplementary),
    grade: cleanText(book.grade || 'السادس الإعدادي'),
    year: book.year === undefined ? 2025 : book.year,
    edition: cleanText(book.edition || ''),
    publisher: cleanText(book.publisher || ''),
    pageCount: book.pageCount || pages.length,
    searchablePageCount,
    visionPageCount: pages.length - searchablePageCount,
    kind: book.referenceKind || 'official-textbook',
    enrichedPageCount: Object.keys(bookEnrichment).length,
    enriched: Object.keys(bookEnrichment).length > 0,
  });
printed[book.id] = {};
  for (const page of pages) {
    const physicalPage = Number(page.physicalPage ?? page.pageNumber);
    const outlinePage = outlineByPage.get(physicalPage);
    const pageText = usableText(page.fullText);
    const hasBodyText = pageText.length >= SEARCHABLE_MIN;
    // folio من نص الصفحة يُقبل فقط إذا طابق إزاحةَ الـparser المثبتة في هذا الكتاب.
// رقم شريحة المصنع بيانات نشر لا folio، فلا يدخل في هذا العدّاد.
    const pageFolios = new Set([...headFolioValues(page.fullText), ...tailFolioValues(page.fullText)].filter((value) => value != null));
    const verifiedFolio = offsetHint != null && pageFolios.has(physicalPage + offsetHint) ? physicalPage + offsetHint : null;
    const evidence = printedPageFor(page, outlinePage, verifiedFolio);
    const printedPage = evidence.printedPage;
    if (printedPage != null) printed[book.id][printedPage] = physicalPage;
    const fullText = stripTrailingFolio(stripLeadingFolio(pageText, printedPage), printedPage);
    // صفحة بلا نص تستند إلى وصف المخطط؛ لولا nettoyage stink الحكم «outline-description» ينهار.
    const outlineSummary = cleanOutlineSummary(compact(outlinePage?.description || '', 2_200))
      || (hasBodyText || !outlinePage ? '' : OUTLINE_FALLBACK);
    const extra = bookEnrichment[physicalPage];
    const title = pageTitle(page, outlinePage, extra, fullText);
    const isTemplateSummary = (summaryCounter.get(compact(stripPressSlab(page.summary || ''), 420)) || 0) >= 8;
    const summary = pageSummary(page, title, outlineSummary, fullText, isTemplateSummary);
    const preview = buildPreview(fullText);
    const purpose = purposeFor(page, extra, purposeFrequency);
    // تسميات المحتوى المنظّم تُفهرس ككلمات، فيصل سؤال «ما معنى...» أو «التمرين D» إلى صفحته.
    const figureText = (extra?.figures || []).map((figure) => [
      'صورة', figure.kind || '', figure.caption || '', figure.description || '', (figure.figureText || []).join(' '),
    ].join(' ')).join('\n');
    const glossaryText = ['مفردات معجم', (extra?.glossary || []).map((entry) => `${entry.term} ${entry.pos || ''} ${entry.definition}`).join(' ')].join('\n');
    const activityText = ['نشاط تمارين', (extra?.activities || []).flatMap((activity) => [
      activity.type || '', activity.instruction || '', activity.answerFormat || '',
      activity.dispatch ? `${activity.dispatch.target} ${activity.dispatch.printedFrom} ${activity.dispatch.printedTo}` : '',
      ...(activity.questions || []),
    ].join(' ')).join(' ')].join('\n');
    const exerciseText = ['تمارين', (extra?.exercises || []).map((exercise) => [
      `التمرين ${exercise.letter || ''}`, exercise.instruction || '',
      ...(exercise.items || []).map((item) => `${item.kind || ''} ${item.stem || ''}`),
    ].join(' ')).join('\n')].join('\n');
    const section = cleanText(extra?.section || page.section || '');
    const unit = cleanText(extra?.unit || page.unit || '');
    const pageType = cleanText(extra?.pageType || page.pageType || '');
    const searchableText = [
      book.title,
      book.subject,
      title,
      section,
      unit,
      extra?.work || '',
      extra?.author || '',
      extra?.sectionPath || '',
      pageType,
      purpose,
      summary,
      fullText,
      // وصف المخطط يدخل الفهرسة فقط إذا كان نظيفاً: صفحة اليوم لها نص لا يصحّ أن يُقال لها «لا نص».
      usefulOutlineValue(outlineSummary) ? outlineSummary : '',
      figureText,
      glossaryText,
      activityText,
      exerciseText,
    ].join('\n');
    const normalized = normalizeAr(searchableText);
    const terms = uniqueTokens(searchableText);
    const indexedTerms = searchTokens(searchableText);
    const id = `${book.id}:${physicalPage}`;
    const doc = {
      id,
      bookId: book.id,
      physicalPage,
      printedPage,
      pageOffset: printedPage == null ? null : printedPage - physicalPage,
      printedPageSource: evidence.source,
      pageOffsetHint: printedPage == null ? offsetHint : null,
      title,
      section,
      unit,
      pageType,
      purpose,
      purposeSource: extra?.educationalPurpose ? 'enrichment' : (purpose ? 'derived' : 'none'),
      summary,
      preview,
      text: fullText,
      textLength: fullText.length,
      textDamaged: DAMAGED.test(fullText),
      normalized,
      terms,
      keywords: topKeywords(searchableText, 12).filter((word) => !/^\d+$/.test(word)),
      searchable: fullText.length >= SEARCHABLE_MIN,
      // نصّ أقصر من حدّ الصفحة النصية يعني أن طبقة النص لا تغطّي الصفحة، فتبقى صالحة للرؤية.
      needsOcr: Boolean(page.needsOcr || page.ocr?.required || !fullText || fullText.length < SEARCHABLE_MIN),
      outlineSummary,
      enriched: false,
    };
    applyEnrichment(doc, extra);
    const docIndex = documents.push(doc) - 1;
    for (const term of indexedTerms) {
      if (!documentFrequency[term]) documentFrequency[term] = 0;
      documentFrequency[term] += 1;
      doc._index = docIndex;
    }
  }
}

const postings = {};
for (let id = 0; id < documents.length; id += 1) {
  for (const term of documents[id].terms) (postings[term] ||= []).push(id);
}
for (const doc of documents) delete doc._index;

const output = {
  schemaVersion: 4,
  builtAt: new Date().toISOString(),
  sourceOfTruth: 'curriculum-library/pdf-sources',
  stats: {
    books: books.length,
    pages: documents.length,
    indexedPages: documents.filter((doc) => doc.searchable || doc.summary).length,
    searchablePages: documents.filter((doc) => doc.searchable).length,
    visionPages: documents.filter((doc) => doc.needsOcr).length,
    outlinePages,
    terms: Object.keys(postings).length,
    enrichedPages,
    enrichedBooks: books.filter((book) => book.enriched).length,
    fullTextPages: documents.filter((doc) => doc.textLength > 0).length,
    fullTextChars: documents.reduce((sum, doc) => sum + doc.textLength, 0),
    structuredPages: documents.filter((doc) => doc.figures?.length || doc.glossary?.length || doc.exercises?.length).length,
    figures: documents.reduce((sum, doc) => sum + (doc.figures?.length || 0), 0),
    glossaryEntries: documents.reduce((sum, doc) => sum + (doc.glossary?.length || 0), 0),
  },
  books,
  documents,
  postings,
  documentFrequency,
  printed,
};

await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
console.log(`search-index: ${books.length} books, ${documents.length} pages, ${Object.keys(postings).length} terms -> ${OUTPUT}`);
console.log(`  full text: ${output.stats.fullTextPages} pages / ${output.stats.fullTextChars} chars · enriched: ${enrichedPages} pages across ${output.stats.enrichedBooks} books · figures: ${output.stats.figures} · glossary: ${output.stats.glossaryEntries}`);

// تشخيص ذاتي: يعدّ الحقول المنقولة فعلاً من enrichment/<id>.json لكل حقل في SCHEMA.md،
// ويكشف أي حقل موجود في الملفات ولم يصل إلى الوثيقة.
const TRANSFERRED = ['unit', 'work', 'author', 'section', 'sectionPath', 'actScene', 'pageType', 'title', 'titleEn',
  'summary', 'summaryEn', 'glossary', 'glossaryRefs', 'vocabulary', 'figures', 'activities', 'exercises',
  'answerKeyLocation', 'continuesOn', 'recapOf', 'notes', 'lessonRange', 'educationalPurpose', 'verifiedNumbers'];
const transferredCounts = Object.fromEntries(TRANSFERRED.map((key) => [key, 0]));
for (const doc of documents) {
  for (const key of TRANSFERRED) {
    const value = doc[key];
    if (value == null) continue;
    if (Array.isArray(value) ? value.length : true) transferredCounts[key] += 1;
  }
}
const presentInFiles = new Set();
for (const pages of enrichment.values()) {
  for (const extra of Object.values(pages)) for (const key of Object.keys(extra)) presentInFiles.add(key);
}
const notCarried = [...presentInFiles].filter((key) => !TRANSFERRED.includes(key) && !['physicalPage', 'pageNumber'].includes(key));
const printedSources = {};
for (const doc of documents) printedSources[doc.printedPageSource] = (printedSources[doc.printedPageSource] || 0) + 1;
console.log(`  transferred enrichment fields: ${TRANSFERRED.map((key) => `${key}=${transferredCounts[key]}`).join(' ')}`);
console.log(`  enrichment keys present in files but not carried: ${notCarried.length ? notCarried.join(', ') : 'none'}`);
console.log(`  printedPage sources: ${Object.entries(printedSources).map(([key, value]) => `${key}=${value}`).join(' ')} · offsetHint=${documents.filter((doc) => doc.pageOffsetHint != null).length} · damagedText=${documents.filter((doc) => doc.textDamaged).length}`);
