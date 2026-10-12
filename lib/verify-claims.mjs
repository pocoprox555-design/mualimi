// تدقيق المزاعم: تعميم حارس الديني في grounding.mjs على كل المزاعم الواقعية
// (تعريفات، أرقام، تواريخ، أعداد، إحالات صفحات). هذا إصلاح ثغرة التدقيق التي
// كانت «التحقق يغطي النص القرآني فقط»، فيمرّ رقم صفحة أو عدد فصول أو تاريخ من
// غير مقابل في الدليل المرفق. القاعدة: نُبقي المعنى ونحذف المحرف غير القابل
// للإثبات وحده، ولا نختلق ولا نُسقط جملةً بسبب رمز مشتبه.
import { buildEvidenceCorpus, isGrounded } from './grounding.mjs';
import { normalizeAr, normalizeDigits } from './text.mjs';

// صنف الأرقام (لاتينية/هندية/فارسية)، وحشوة اسم المعدود: حروف بلا رقم ولا سطر.
// حصر الحشوة يمنع قاعدة العدد من القفز فوق رقم مجاور (سنة/صفحة) واقتطاع جزء منه.
const DIGITS = '0-9\u0660-\u0669\u06F0-\u06F9';
const NUM = `[${DIGITS}]`;
const NON_DIGIT = `[^${DIGITS}\n]`;
const NOTE_UNVERIFIED = '(غير منقول عن المقتطف المرفق)';
const AYAH_PLACEHOLDER = '(لم يثبت رقم الآية في الصفحة المرفقة)';

// اقتباس بين «…» أو "…" (مستقيم/منحني) طوله ≥20. المُلحق الاختياري يلتهم ملاحظة
// التدقيق السابقة حتى تبقى العملية idempotent: تشغيلها مرتين لا يغيّر النصّ في المرة الثانية.
// رموز \u تُكتب حرفياً هنا (لا كأحرف ملتوية) لتجنّب الالتباس البصري بين علامات الاقتباس.
const NOTE_TAIL = '(?:\\s*\\([^)]*منقول[^)]*\\))?';
const QUOTED_SPAN = new RegExp(
  `\u00AB([\\s\\S]{20,}?)\u00BB${NOTE_TAIL}`
  + `|\u201C([\\s\\S]{20,}?)\u201D${NOTE_TAIL}`
  + `|\u0022([\\s\\S]{20,}?)\u0022${NOTE_TAIL}`
  + `|\u201E([\\s\\S]{20,}?)\u201C${NOTE_TAIL}`,
  'g',
);
// إحالة صفحة: «صفحة 41»، «ص 41»، «page 12». الكلمة تبقى ويُحذف الرقم إن لم يُثبت.
// `(?!NUM)` يمنع اقتطاع رقم من وسط سلسلة أرقام أطول، فلا يترك بقايا ولا يكسر idempotency.
const PAGE_REF = new RegExp(`(?:صفحة|ص|page|p)\\s*#?\\s*(${NUM}{1,4})(?!${NUM})`, 'g');
// عدد: اسم معدود (فصول/دروس/…) تلته حشوة بلا رقم ثم رقم خلاله. حصر الحشوة بغير
// الرقم يضمن أن الرقم يخصّ ذلك الاسم لا سنة/صفحة مجاورة؛ `(?!NUM)` كحدّ سفلي أيضاً.
const COUNT = new RegExp(
  `(فصول|وحدات|دروس|أبواب|مباحث|أقسام|تمارين|أسئلة|أنواع|أشكال)(?:${NON_DIGIT}{0,14}?)(${NUM}{1,3})(?!${NUM})`,
  'g',
);
// سنة (1000–2099). سنة بلا سند تلحقها «م» (زيادة الميلاد)؛ تُحذف السنة و«م» معها
// لأن «م» وحدها بلا رقم لا معنى لها. لا نلمس اسم القرن المجاور إن بقي.
const DATE = new RegExp(`(?<!${NUM})(1${NUM}{3}|20${NUM}{2})\\s*م?(?!${NUM})`, 'g');
// رقم آية: يُستبدل الإحالة كلها بعبارة صادقة بدل الرقم. حدّ `(?!NUM)` كأعلاه.
const AYAH = new RegExp(`(?:الآية|آية)\\s*(${NUM}{1,3})(?!${NUM})`, 'g');

const SIGNIFICANT_MIN = 4;
// أدوات ربط طويلة (≥4) تُستثنى من شرط «كل كلمة دالة واردة» في التدقيق الصارم،
// فهي ليست دليل هوية نصّ. القائمة مختصرة عمداً؛ الأقصر من 4 محارف مستثنى أصلاً.
const FUNCTION_WORDS = new Set([
  'التي', 'الذي', 'الذين', 'اللاتي', 'اللواتي', 'اللذان', 'اللتان', 'اللذين',
  'هناك', 'ايضا', 'كذلك', 'حيث', 'عندما', 'بينما', 'اذا', 'لكن', 'الا',
]);

// تدقيق صارم للاقتباس: تضمين حرفي كافٍ، وإلّا تغطية ≥0.85 مع ورد كل كلمة دالة
// (طول ≥4 وغير أداة) في الدليل. أقصر من isGrounded: يمنع الاقتباس المُخترق بجزء.
export function isGroundedStrict(needle, corpus) {
  // isGrounded يعطي الأساس (تضمين أو تغطية ≥0.85)؛ نضيف شرط الكلمات الدالة.
  if (!isGrounded(needle, corpus)) return false;
  const normalized = normalizeAr(needle);
  if (!normalized) return true;
  if (corpus?.normalized && corpus.normalized.includes(normalized)) return true; // تطابق حرفي: كافٍ
  const tokens = normalized.split(' ').filter((word) => word.length >= 3);
  const significant = tokens.filter((word) => word.length >= SIGNIFICANT_MIN && !FUNCTION_WORDS.has(word));
  const words = corpus?.words;
  return significant.every((word) => Boolean(words?.has(word)));
}

// القوائم المُسبقة: 'ayah:41'، 'count:7'، 'date:1952' مُصرّح بها مسبقاً. نبني
// زوجين (نوع:رقم) وأرقاماً عامة حتى يُقبل الرقم بأي نوع أو بلا نوع.
function buildAllowed(allowed) {
  const pairs = new Set();
  const numbers = new Set();
  for (const raw of Array.isArray(allowed) ? allowed : []) {
    const entry = normalizeDigits(String(raw ?? '')).toLowerCase();
    if (!entry) continue;
    const colon = entry.indexOf(':');
    if (colon >= 0) {
      pairs.add(entry);
      numbers.add(entry.slice(colon + 1));
    } else {
      numbers.add(entry);
    }
  }
  return { pairs, numbers };
}

// رقم ثابت؟ ورد في أرقام الدليل، أو مُصرّح به مسبقاً بنفس النوع أو بلا نوع.
function numberProven(value, kind, corpus, allowed) {
  return corpus.numbers.has(value) || allowed.pairs.has(`${kind}:${value}`) || allowed.numbers.has(value);
}

// طيّ المسافات المزدوجة الناتجة عن حذف رقم داخل جملة. idempotent بطبيعتها.
function tidySpaces(value) {
  return String(value ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function verifyQuoted(text, corpus, flagged, kept) {
  return text.replace(QUOTED_SPAN, (match, ...rest) => {
    const inner = rest.find((group) => typeof group === 'string');
    if (inner == null) return match;
    const claim = inner.trim();
    if (isGroundedStrict(claim, corpus)) {
      if (claim) kept.push({ kind: 'quoted-span', claim: claim.slice(0, 120) });
      return match;
    }
    flagged.push({ kind: 'quoted-span', claim: claim.slice(0, 120), action: 'wrapped-unverifiable' });
    return `«${claim}» ${NOTE_UNVERIFIED}`;
  });
}

function verifyPageRef(text, corpus, allowed, flagged, kept) {
  return text.replace(PAGE_REF, (match, digit) => {
    const value = normalizeDigits(digit);
    if (numberProven(value, 'page-ref', corpus, allowed)) {
      kept.push({ kind: 'page-ref', claim: value });
      return match;
    }
    flagged.push({ kind: 'page-ref', claim: value, action: 'removed-number' });
    return match.slice(0, match.length - digit.length).replace(/[\s#]+$/, '');
  });
}

function verifyCount(text, corpus, allowed, flagged, kept) {
  return text.replace(COUNT, (match, noun, digit) => {
    const value = normalizeDigits(digit);
    if (numberProven(value, 'count', corpus, allowed)) {
      kept.push({ kind: 'count', claim: value });
      return match;
    }
    flagged.push({ kind: 'count', claim: value, action: 'removed-number-kept-noun' });
    return match.slice(0, match.length - digit.length).replace(/\s+$/, '');
  });
}

function verifyDate(text, corpus, allowed, flagged, kept) {
  return text.replace(DATE, (match, digit) => {
    const value = normalizeDigits(digit);
    if (numberProven(value, 'date', corpus, allowed)) {
      kept.push({ kind: 'date', claim: value });
      return match;
    }
    flagged.push({ kind: 'date', claim: value, action: 'removed-year' });
    return '';
  });
}

function verifyAyah(text, corpus, allowed, flagged, kept) {
  return text.replace(AYAH, (match, digit) => {
    const value = normalizeDigits(digit);
    if (numberProven(value, 'ayah', corpus, allowed)) {
      kept.push({ kind: 'ayah', claim: value });
      return match;
    }
    flagged.push({ kind: 'ayah', claim: value, action: 'placeholder' });
    return AYAH_PLACEHOLDER;
  });
}

/**
 * تدقيق ردّ النموذج على كل المزاعم الواقعية مقابل الدليل المرفق.
 * @param {string} answer نص الرد.
 * @param {string} evidenceText نص الأدلة التي رآها النموذج.
 * @param {{allowed?: string[]}} options أرقام مُصرّح بها مسبقاً ('ayah:41'…).
 * @returns {{text:string, changed:boolean, flagged:Array<{kind:string,claim:string,action:string}>, kept:Array<{kind:string,claim:string}>}}
 */
export function verifyClaims(answer, evidenceText, { allowed = [] } = {}) {
  const original = String(answer ?? '');
  const corpus = buildEvidenceCorpus(evidenceText ?? '');
  const allowedSets = buildAllowed(allowed);
  const flagged = [];
  const kept = [];
  if (!original) return { text: original, changed: false, flagged, kept };

  let text = original;
  text = verifyQuoted(text, corpus, flagged, kept);
  text = verifyPageRef(text, corpus, allowedSets, flagged, kept);
  text = verifyCount(text, corpus, allowedSets, flagged, kept);
  text = verifyDate(text, corpus, allowedSets, flagged, kept);
  text = verifyAyah(text, corpus, allowedSets, flagged, kept);
  if (flagged.length) text = tidySpaces(text);
  return { text, changed: text !== original, flagged, kept };
}

export const __test = {
  kinds: ['quoted-span', 'page-ref', 'count', 'date', 'ayah'],
  patterns: { QUOTED_SPAN, PAGE_REF, COUNT, DATE, AYAH },
  isGroundedStrict,
  FUNCTION_WORDS,
  NOTE_UNVERIFIED,
  AYAH_PLACEHOLDER,
};
