// قواعد الحكم في مدقّق الفهرس، مفصولة عن القراءة والعرض.
// الغرض: كل حكم في الفحص يكون دالة نقية قابلة للاختبار، وأن يكون لكل حكم سنده مذكوراً.
// المبدأ الحاكم: غياب الرقم من نص الصفحة ليس دليل اختلاق. النص قد يكون ناقصاً
// (صفحة مصوّرة، أو رقم في جدول أو صورة أو صفحة مقابلة)،⇒ فالحكم هنا «غير مُثبت»
// لا «مُختلق»، والتصعيد إلى حرج يبقى عمل العين لا عمل الآلة.
import { createHash } from 'node:crypto';
import { normalizeDigits } from '../lib/text.mjs';

const DIGIT_RUN = /[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)*/g;
const WEIRD = /[\uFFFD\uE000-\uF8FF]/g;
const PERSIAN = /[پچژگیک]/g;
// «قُرئ من صورة الصفحة» دليل بصري صريح؛ رقمٌ ذُكر مع مثل هذه العبارة لا يُطالب بسند من النص.
const VISUAL_EVIDENCE = /(?:بصري[ًا]?|معاينة|مقروء[ةه]?\s+من|كما\s+ورد|قُرئت|قرأت|مراجعة\s+الصفح|image|ocr)/i;
const STRUCTURE_BEFORE = /(?:unit|chapter|lesson|exercise|part|section|activity|form|الفصل|الوحدة|الدرس|التمرين|البند|المبحث|الجزء|الباب|المحاضرة|الصفحة|رقم|ص)\s*[:\-\s]*$/i;
const RANGE_AROUND = /[0-9٠-٩]\s*[-–—]\s*[0-9٠-٩]/;
const UNIT_STOPWORDS = new Set(['of', 'the', 'and', 'في', 'من', 'الى', 'على', 'و']);

export const TEXT_MIN = 20;
// حدّ النص الذي يُعتدّ به في مقارنة الأرقام: دونه فالغياب لا يدل على شيء.
const INTACT_MIN = 200;
const WEIRD_RATE = 0.02;

export function digitRuns(value) {
  return [...String(value || '').matchAll(DIGIT_RUN)].map((match) => normalizeDigits(match[0]).replace(/[.,٫]/g, ''));
}

export const foldText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
  .replace(/[-–—:،,؛;.()\[\]{}«»"'’“”]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// سلامة النص كما يحتاجها حكم الأرقام: «سليم» يعني أن ما في الصفحة نُقل كاملاً،
// فغياب الرقم عندها حكم على الوصف لا على الطبقة.
export function pageIntegrity(doc) {
  const text = String(doc?.text || '');
  const size = text.trim().length;
  if (!size) return { state: 'empty', length: 0, weirdRate: 0 };
  const weird = (text.match(WEIRD) || []).length + (text.match(PERSIAN) || []).length;
  const weirdRate = weird / Math.max(1, text.length);
  if (doc.needsOcr || doc.textDamaged || weirdRate > WEIRD_RATE) return { state: 'damaged', length: size, weirdRate: round(weirdRate) };
  if (size < INTACT_MIN) return { state: 'thin', length: size, weirdRate: round(weirdRate) };
  return { state: 'intact', length: size, weirdRate: round(weirdRate) };
}

function visualEvidence(doc, number) {
  const declared = Array.isArray(doc?.verifiedNumbers) ? doc.verifiedNumbers.map((value) => normalizeDigits(String(value))) : [];
  if (declared.includes(number)) return 'verifiedNumbers';
  const notes = String(doc?.notes || '');
  if (notes.includes(number) && VISUAL_EVIDENCE.test(notes)) return 'notes';
  return '';
}

// تسمية بنيوية («3-10»، «Unit 3»، «الفصل الثاني») رقم ترقيم لا ادّعاء واقعة؛
// يُحاسَب تكراراً لا اختراقاً، ويبقى معروضاً لمراجعة بصرية واحدة.
function structuralLabel(fieldValue, number) {
  const value = String(fieldValue || '');
  const at = value.indexOf(number);
  if (at < 0) return false;
  const before = value.slice(Math.max(0, at - 24), at);
  const around = value.slice(Math.max(0, at - 12), at + number.length + 12);
  return STRUCTURE_BEFORE.test(before) || RANGE_AROUND.test(around);
}

/**
 * حكم على كل رقم في حقول الوصف لا يثبته نص الصفحة.
 * أربعة أحكام لا خمسة: proven (في النص) · verified (دليل بصري مسجّل) ·
 * structural (ترقيم بنيوي) · unverified (غيابه لا حكم عليه).
 */
export function judgeNumbers(docs, { fields = ['title', 'summary', 'outlineSummary'] } = {}) {
  const items = [];
  const counts = { proven: 0, verified: 0, structural: 0, layerless: 0, unverified: 0 };
  for (const doc of docs) {
    const text = String(doc?.text || '');
    // صفحة بلا نص لا تُتجاهل: أرقام وصفها (آيات، تواريخ) هي بعينها أكثر ما يحتاج برهاناً.
    const integrity = pageIntegrity(doc);
    const proven = new Set(digitRuns(text));
    const own = new Set([String(doc.physicalPage), String(doc.printedPage ?? '')]);
    for (const field of fields) {
      const value = String(doc?.[field] || '');
      if (!value) continue;
      for (const number of new Set(digitRuns(value))) {
        if (number.length < 2 || own.has(number) || proven.has(number)) { counts.proven += 1; continue; }
        const evidence = visualEvidence(doc, number);
        if (evidence) { counts.verified += 1; items.push({ page: doc.physicalPage, field, number, verdict: 'verified', via: evidence }); continue; }
        if (structuralLabel(value, number)) { counts.structural += 1; items.push({ page: doc.physicalPage, field, number, verdict: 'structural' }); continue; }
        // صفحة لا طبقة نصّ فيها أصلاً: لا يمكن إثبات الرقم منها أبداً، والحكم عليه
        // بالمقارنة لا معنى له. يُحسب على الكتاب كله لا كرقم منفرد.
        if (integrity.state === 'empty') { counts.layerless += 1; items.push({ page: doc.physicalPage, field, number, verdict: 'layerless' }); continue; }
        counts.unverified += 1;
        items.push({ page: doc.physicalPage, field, number, verdict: 'unverified', integrity: integrity.state });
      }
    }
  }
  return { items, counts, unverified: items.filter((item) => item.verdict === 'unverified') };
}

// عنوان الصفحة الذي هو عنوان الكتاب ليس وصفاً: يجعل الصفحة بلا هوية في الاسترجاع.
// يُفصل عن التكرار الحرفي لأن عطبه في الاسترجاع لا في الوصف.
export function titleRepetition(docs, bookTitle) {
  const bookFold = foldText(bookTitle);
  // عنوان الصفحة قد يكون العنوان نفسه أو جزءاً منه أو امتداداً له («النحو الواضح»
  // في صفحة عنوانها «النحو الواضح في قواعد اللغة العربية للصف السادس الإعدادي»).
  const overlapsBook = (value) => Boolean(value) && value.length >= 12 && (value === bookFold || value.includes(bookFold) || bookFold.includes(value));
  const asBookTitle = [];
  const counts = new Map();
  for (const doc of docs) {
    const title = foldText(doc.title);
    if (!title) continue;
    counts.set(title, (counts.get(title) || 0) + 1);
    if (overlapsBook(title)) asBookTitle.push({ page: doc.physicalPage, title: String(doc.title).slice(0, 60) });
  }
  const values = docs.map((doc) => foldText(doc.title)).filter(Boolean);
  const share = values.length ? Math.max(0, ...[...counts.values()]) / values.length : 0;
  const boilerplate = [...counts.entries()].filter(([value, n]) => n > 1 && !overlapsBook(value)).map(([value, n]) => ({ value: value.slice(0, 60), count: n }));
  return { bookTitlePages: asBookTitle, bookTitleShare: values.length ? round(asBookTitle.length / values.length) : 0, boilerplateShare: round(share), boilerplate: boilerplate.slice(0, 5) };
}

// اسم وحدة لا يثبته نص الصفحة: لا يُحسب اختراقاً لمجرد اشتراك كتابين في تسمية عامة
// («الفصل الثاني»)، ولا يُحسب على كتابٍ إنكليزي بسبب مقارنة حسّاسة لعلامات الترقيم.
export function foreignUnits(docs, unitOwners, bookId, isGeneric = () => false) {
  const foreign = [];
  for (const doc of docs) {
    const unit = foldText(doc.unit);
    if (!unit || isGeneric(doc.unit)) continue;
    const others = [...(unitOwners.get(String(doc.unit || '').trim()) || new Set())].filter((id) => id !== bookId);
    if (!others.length) continue;
    const words = unit.split(' ').filter((word) => word.length >= 3 && !UNIT_STOPWORDS.has(word));
    const pageWords = new Set(foldText(doc.text).split(' '));
    const proven = words.length ? words.filter((word) => pageWords.has(word)).length / words.length : 0;
    if (proven >= 0.8) continue;
    foreign.push({ page: doc.physicalPage, unit: String(doc.unit).slice(0, 40), alsoIn: others[0], proven: round(proven * 100) });
  }
  return foreign;
}

// صفحة بلا نص تحمل وصفاً: الوصف هنا يقرأه النموذج كأنه من الصفحة، فلا بد من وسمه.
// تُفصل عن A1/A2 لأن العيب فيها في الطبقة المنقولة لا في السجل.
export function noTextPages(docs) {
  const empty = [];
  const claims = [];
  for (const doc of docs) {
    if (String(doc.text || '').trim()) continue;
    empty.push(doc.physicalPage);
    const described = [doc.title, doc.summary, doc.outlineSummary].map((value) => String(value || '').trim()).filter(Boolean);
    if (described.length) claims.push({ page: doc.physicalPage, fields: described.length, searchable: Boolean(doc.searchable), needsOcr: Boolean(doc.needsOcr) });
  }
  return { empty, claims, share: docs.length ? round(empty.length / docs.length) : 0 };
}

// طبقة لا يقرأها أحد: الحكم بالبحث في الكود لا بالتاريخ. الطبقات الميتة أضخم مصدر
// تضليل في المكتبة، بقاءً منها يُفسد القياس ويوهم أن هناك مصدراً ثانياً للحقيقة.
export function deadLayers(layers) {
  return layers.filter((layer) => layer.exists && !layer.readers?.length).map((layer) => ({
    layer: layer.layer, bytes: layer.bytes, olderByHours: layer.olderByHours,
  }));
}

// تكرار حرفي بين الكتب: صفحة بنفس التوقيع في كتابين تعني إما خطأ فهرسة أو نسخاً مقصوداً،
// وفي الحالتين يجب أن يُعرف قبل أن يُحتسب مرتين في جواب واحد.
export function crossBookDuplicates(docsByBook, { minShared = 3 } = {}) {
  const signatures = new Map();
  for (const [bookId, docs] of docsByBook) {
    for (const doc of docs) {
      const text = foldText(doc.text).replace(/[0-9٠-٩۰-۹]+/g, '#');
      if (text.length < 200) continue;
      const hash = createHash('sha1').update(text).digest('hex');
      if (!signatures.has(hash)) signatures.set(hash, []);
      signatures.get(hash).push({ bookId, page: doc.physicalPage });
    }
  }
  const pairs = new Map();
  for (const hits of signatures.values()) {
    const books = [...new Set(hits.map((hit) => hit.bookId))];
    if (books.length < 2) continue;
    for (let i = 0; i < books.length; i += 1) {
      for (let j = i + 1; j < books.length; j += 1) {
        const key = `${books[i]}|${books[j]}`;
        const matched = hits.filter((hit) => hit.bookId === books[i] || hit.bookId === books[j]);
        pairs.set(key, (pairs.get(key) || []).concat(matched));
      }
    }
  }
  return [...pairs.entries()]
    .filter(([, hits]) => hits.length >= minShared * 2)
    .map(([key, hits]) => {
      const [left, right] = key.split('|');
      const leftPages = hits.filter((hit) => hit.bookId === left).map((hit) => hit.page).sort((a, b) => a - b);
      const rightPages = hits.filter((hit) => hit.bookId === right).map((hit) => hit.page).sort((a, b) => a - b);
      const offset = median(rightPages.map((page, index) => page - (leftPages[index] ?? page)));
      return { left, right, shared: leftPages.length, leftPages: leftPages.slice(0, 8), rightPages: rightPages.slice(0, 8), offset };
    })
    .sort((a, b) => b.shared - a.shared);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}