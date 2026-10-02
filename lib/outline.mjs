// فهارس المواد: ملف واحد لكل مادة في curriculum-library/outlines، يُقرأ عند الحاجة ويُخزَّن مؤقتاً.
//
// قاعدة الصدق المطبَّقة هنا: لا يخرج من هذا الملف رقم واحد إلا إذا ثبت في نص الصفحة المستخرج من
// الـPDF (`curriculum-library/pdf-books/<bookId>.json`). الرقم غير المثبت يُحذف من الوصف ويُسجَّل
// في `diagnostics` بدل أن يدخل الـsystem prompt أو يُصدَّر كـ`title`. والصفحة التي لا نصّ
// مستخرجاً لها (صفحة مصورة) لا يُنسب إليها عدد فصول أو وحدات أو دروس لأنها ليست مستخرجة أصلاً.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, normalizeAr, normalizeDigits } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTLINES_DIR = path.join(ROOT, 'curriculum-library', 'outlines');
const EVIDENCE_DIR = path.join(ROOT, 'curriculum-library', 'pdf-books');
const MARKER = '## التفاصيل صفحة بصفحة';
const ENTRY = /^### الصفحة الفيزيائية (\d+)[^\n]*$/gm;
const EVIDENCE_CACHE_LIMIT = 4;

let idsPromise;
const cache = new Map();
const evidenceCache = new Map();

const safeId = (bookId) => /^[a-z0-9][a-z0-9-]{1,80}$/i.test(String(bookId || ''));

const STRUCTURE_PATTERNS = [
  // عدّ: كم فصلا / عدد الدروس / كم صفحة ...
  /(كم|عدد|عده)[^؟?]{0,30}(فصول|وحدات|دروس|تمارين|اسئله|صفحات|فصلا|وحده|درسا|تمرين|سؤال|صفحة|فصل)/,
  // فهرس أو محتويات بشكل مباشر
  /(فهرس|فهره|محتويات)/,
  // بنية/خطة الكتاب
  /(خطة|خطه|بنيه|بنية|مخطط|توزيع)/,
  // ماذا يحوي الكتاب
  /(وش|ماذا|اشرح|لخص|اوجز)[^؟?]{0,20}(يحتوي|تحتوي|الكتاب|الماده|المنهج)/,
];

// نية السؤال: هل يسأل عن بنية المادة وعدد أقسامها بدل سؤال معرفي محدد؟
export function structureIntent(query) {
  const text = normalizeAr(query);
  if (!text) return false;
  return STRUCTURE_PATTERNS.some((pattern) => pattern.test(text));
}

// ── أرقام وادعاءات البنية ────────────────────────────────────────────────────
const DIGIT_RUN = /[0-9٠-٩۰-۹]+(?:[.,٫/][0-9٠-٩۰-۹]+)*(?:\s?م(?![؀-ۿ]))?/g;
// مفردات العدّ مكتوبةً بالكلمة: «الفصول السبعة»، «خمس وحدات».
const STRUCTURE_NOUNS = ['الفصول', 'فصول', 'الفصل', 'فصل', 'الوحدات', 'وحدات', 'الوحدة', 'وحدة',
  'الدروس', 'دروس', 'الدرس', 'درس', 'المباحث', 'مباحث', 'المبحث', 'مبحث', 'الأبواب', 'أبواب',
  'الباب', 'باب', 'الأسئلة', 'أسئلة', 'السؤال', 'سؤال', 'التمارين', 'تمارين', 'التمرين', 'تمرين',
  'الصفحات', 'صفحات', 'الصفحة', 'صفحة'];
const COUNT_WORDS = new Map([
  ['الثلاث', 3], ['ثلاثة', 3], ['ثلاث', 3], ['ثالثة', 3], ['الثالثة', 3], ['ثالث', 3],
  ['الخمس', 5], ['خمسة', 5], ['خمس', 5], ['الخامسة', 5], ['خامس', 5],
  ['السبع', 7], ['سبعة', 7], ['سبع', 7], ['السابعة', 7], ['سابع', 7],
  ['الاثنين', 2], ['اثنين', 2], ['اثنان', 2], ['الثانية', 2], ['ثاني', 2],
  ['الأربع', 4], ['أربعة', 4], ['اربع', 4], ['الرابعة', 4], ['رابع', 4],
  ['الست', 6], ['ستة', 6], ['ست', 6], ['السادسة', 6], ['سادس', 6],
  ['الثمان', 8], ['ثمانية', 8], ['ثمان', 8], ['الثامنة', 8], ['ثامن', 8],
  ['التسع', 9], ['تسعة', 9], ['تسع', 9], ['التاسعة', 9], ['تاسع', 9],
  ['العشر', 10], ['عشرة', 10], ['عشر', 10], ['العاشرة', 10], ['عاشر', 10],
  ['الواحدة', 1], ['واحدة', 1], ['واحد', 1], ['الأولى', 1], ['الاولى', 1], ['الاول', 1],
]);
// صيغ المؤنث/التأنيث المقترنة: «الثلاثة فصول»، «السبعة أبواب».
for (const [word, count] of [...COUNT_WORDS]) {
  if (!word.startsWith('ال')) continue;
  const stem = word.slice(2);
  for (const suffix of ['ة', 'تان', 'تين']) {
    if (!COUNT_WORDS.has(`ال${stem}${suffix}`)) COUNT_WORDS.set(`ال${stem}${suffix}`, count);
  }
}
const COUNT_FORMS = [...COUNT_WORDS.keys()].sort((a, b) => b.length - a.length).join('|');
const NOUN_FORMS = STRUCTURE_NOUNS.join('|');
// «الفصول السبعة» أو «سبع وحدات» أو «ثلاثة فصول»: الاسم يبقى والعدد وحده يُحذف إن لم يثبت.
const COUNT_CLAIM = new RegExp(
  `(?:ال(?<a>${NOUN_FORMS})\\s+(?<b>${COUNT_FORMS})|(?<c>${COUNT_FORMS})\\s+(?:ال)?(?<d>${NOUN_FORMS}))`,
  'gu',
);
// ادعاء بنية الكتاب على صفحة لم يُستخرج نصها: «الكتاب ينقسم إلى سبعة فصول».
// لا يشمل ما يقسمه المؤلف داخل مضمون الصفحة («يقسم أفلاطون المجتمع إلى ثلاث طبقات»).
const STRUCTURE_SPLIT_CLAIM = new RegExp(`(?:الكتاب|المادة|المنهج)\\s*(?:ينقسم|ينقسمُ|يقسم|مقسّم|مقسم|تقسم)?\\s*(?:إلى|الي)?\\s*(?:${COUNT_FORMS})?\\s*(?:أقسام|فصل|فصول|وحدة|وحدات|أجزاء|محاور|عناوين)`);

// كل الأرقام (بصيغتيها اللاتينية والعربية) داخل قيمة واحدة، بعد توحيد الأرقام.
export function digitClaims(value) {
  return [...String(value || '').matchAll(DIGIT_RUN)].map((match) => normalizeDigits(match[0]).replace(/[.,٫/\s]/g, ''));
}

// الأرقام التي لا يثبتها نص الصفحة. بلا دليل (نص الصفحة غير متاح) تُحسب كلها بلا سند.
export function unprovenClaims(value, evidence, { allow = [] } = {}) {
  const permitted = new Set(allow);
  const digits = digitClaims(value);
  if (!evidence?.hasText) return digits.filter((digit) => !permitted.has(digit));
  return digits.filter((digit) => !permitted.has(digit) && !evidence.numbers.has(digit));
}

// حذف الأرقام التي لا سند لها، مع أثرها («1952م» => «م» فتبقى «تشرين الثاني»).
export function groundText(value, evidence, { allow = [] } = {}) {
  const permitted = new Set(allow);
  const dropped = [];
  const text = String(value || '').replace(DIGIT_RUN, (match) => {
    const digits = normalizeDigits(match).replace(/[.,٫/\s]/g, '');
    if (!digits || permitted.has(digits) || evidence?.numbers.has(digits)) return match;
    dropped.push(digits);
    return ' ';
  });
  return { text: tidy(text), dropped };
}

// «الفصول السبعة» و«خمس وحدات»: عددٌ مكتوب بكلمة. لا يثبت إلا إن كان رقمه في نص الصفحة.
export function groundCountWords(value, evidence) {
  const dropped = [];
  const forms = [...COUNT_WORDS.keys()];
  const text = String(value || '').replace(COUNT_CLAIM, (match, a, b, c, d) => {
    const word = b || c;
    const count = word ? COUNT_WORDS.get(word) : null;
    // عددٌ مصرَّح به لِما يقوله النص: يُبقى كما هو. وإلا يُحذف العدد وحده ويبقى الاسم.
    if (!count || evidence?.numbers.has(String(count))) return match;
    dropped.push(String(count));
    if (a) return `ال${a}`;
    return d;
  });
  return { text: tidy(text), dropped };
}

function tidy(value) {
  return String(value || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    // مسافة قبل النقطة داخل عدد («3 .15») ليست فاصل جملة، فلا تُحذف حتى لا يلتصق الرقم.
    .replace(/[ \t]+\.(?=[ \t]|$)/g, '.')
    .replace(/[ \t]+([،,;:])/g, '$1')
    .replace(/([،,;:])\s*([،,.;:])/g, '$1')
    .replace(/^[\s\-–—:;,.]+|[\s\-–—:;,.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function loadEvidence(bookId) {
  if (evidenceCache.has(bookId)) return evidenceCache.get(bookId);
  let pages = null;
  try {
    const book = JSON.parse(await readFile(path.join(EVIDENCE_DIR, `${bookId}.json`), 'utf8'));
    pages = new Map();
    for (const page of book.pages || []) {
      const text = String(page.fullText || '');
      pages.set(Number(page.physicalPage ?? page.pageNumber), {
        length: text.length,
        numbers: new Set(digitClaims(text)),
      });
    }
  } catch {
    pages = null;
  }
  if (evidenceCache.size >= EVIDENCE_CACHE_LIMIT) evidenceCache.delete(evidenceCache.keys().next().value);
  evidenceCache.set(bookId, pages);
  return pages;
}

export async function listOutlineIds() {
  if (!idsPromise) {
    idsPromise = readdir(OUTLINES_DIR, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name.slice(0, -3)))
      .catch(() => []);
  }
  return idsPromise;
}

export async function getOutline(bookId) {
  if (!safeId(bookId)) return null;
  if (cache.has(bookId)) return cache.get(bookId);
  if (!(await listOutlineIds()).includes(bookId)) return null;

  let outline = null;
  try {
    const raw = await readFile(path.join(OUTLINES_DIR, `${bookId}.md`), 'utf8');
    const evidence = await loadEvidence(bookId);
    const cut = raw.indexOf(MARKER);
    const header = (cut > 0 ? raw.slice(0, cut) : raw).trim();
    const pages = [];
    const scanner = new RegExp(ENTRY.source, 'gm');
    let match;
    const diagnostics = {
      evidenceSource: evidence ? 'pdf-books' : 'none',
      pages: 0,
      pagesWithoutEvidence: 0,
      pagesWithUnprovenNumbers: 0,
      unprovenNumbers: [],
      unprovenCounts: [],
      structureClaimsRemoved: 0,
    };
    while ((match = scanner.exec(raw))) {
      const start = scanner.lastIndex;
      const next = raw.indexOf('\n### الصفحة الفيزيائية ', start);
      const block = raw.slice(start, next < 0 ? raw.length : next);
      const heading = match[0];
      const physicalPage = Number(match[1]);
      const printed = heading.match(/—\s*المطبوعة\s*:?\s*([٠-٩0-9]+)/);
      const printedPage = printed ? printed[1] : '';
      const field = (label) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const value = block.match(new RegExp(`^- \\*\\*${escaped}\\*\\*:\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n### |$)`, 'm'))?.[1] || '';
        return cleanText(value).replace(/\s+/g, ' ').trim();
      };
      // الدليل: أرقام نص الصفحة نفسها. ما عداها فلا يُثبَت من هذا الكتاب.
      const pageEvidence = evidence?.get(physicalPage);
      const grounded = pageEvidence
        ? { hasText: pageEvidence.length >= 20, numbers: pageEvidence.numbers }
        : null;
      const allow = [String(physicalPage), printedPage ? normalizeDigits(printedPage) : ''].filter(Boolean);
      const rawType = field('النوع').slice(0, 60);
      const rawTitle = field('العنوان الرسمي').slice(0, 140);
      const details = [
        ['المحتوى', field('المحتوى')],
        ['التمارين والأسئلة', field('التمارين والأسئلة')],
        ['التمارين', field('التمارين')],
        ['الفعاليات والأحداث', field('الفعاليات والأحداث')],
        ['الأهداف', field('الأهداف')],
        ['ملاحظة للاستخدام', field('ملاحظة للاستخدام')],
      ].filter(([, value]) => value);
      const ground = (value) => {
        // لا دليل أصلا (ملف pdf-books غير متاح): لا نُمسح الوصف، ونعلن ذلك في الفحص.
        if (!evidence) return cleanText(value).replace(/\s+/g, ' ').trim();
        const digits = groundText(value, grounded, { allow });
        const counts = groundCountWords(digits.text, grounded);
        for (const count of [...digits.dropped, ...counts.dropped]) {
          if (!diagnostics.unprovenNumbers.includes(count)) diagnostics.unprovenNumbers.push(count);
        }
        for (const count of counts.dropped) {
          if (!diagnostics.unprovenCounts.includes(count)) diagnostics.unprovenCounts.push(count);
        }
        const text = counts.text;
        // بنية غير مستخرجة: صفحة بلا نصّ لا يُنسب إليها تقسيم ولا عدد فصول.
        if (!grounded?.hasText && STRUCTURE_SPLIT_CLAIM.test(text)) {
          diagnostics.structureClaimsRemoved += 1;
          return text.split(/[؛;]/).map((clause) => clause.trim()).filter((clause) => clause && !STRUCTURE_SPLIT_CLAIM.test(clause)).join('؛ ');
        }
        return text;
      };
      const type = ground(rawType);
      const title = ground(rawTitle);
      const detailsText = details
        .map(([label, value]) => [label, ground(value)])
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
      // الفحص: كل رقم في العنوان أو الوصف يجب أن يثبت من نص الصفحة نفسها.
      if (grounded) {
        const claims = [rawType, rawTitle, ...details.map(([, item]) => item)]
          .flatMap((value) => unprovenClaims(value, grounded, { allow }));
        if (claims.length) diagnostics.pagesWithUnprovenNumbers += 1;
      }
      diagnostics.pages += 1;
      if (!grounded?.hasText) diagnostics.pagesWithoutEvidence += 1;
      const description = cleanText([title && `العنوان: ${title}`, type && `النوع: ${type}`, detailsText].filter(Boolean).join('\n')).slice(0, 2_200);
      pages.push({
        physicalPage,
        printedPage,
        type,
        title,
        description,
        evidence: grounded?.hasText ? 'pdf-text' : grounded ? 'no-text' : 'unverified',
      });
    }
    outline = { bookId, header, pages, entries: pages.length, diagnostics };
  } catch {
    return null;
  }
  cache.set(bookId, outline);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return outline;
}

function digest(outline, max = 60_000) {
  const lines = [];
  let used = 0;
  for (const page of outline.pages) {
    const label = `ص${page.physicalPage}${page.printedPage && page.printedPage !== String(page.physicalPage) ? ` (مطبوع ${page.printedPage})` : ''}: ${page.title || page.type || 'صفحة'}`;
    if (used + label.length > max) break;
    lines.push(`- ${label}`);
    used += label.length + 1;
  }
  return lines.join('\n');
}

// الكتلة التي تُحقن في الـsystem prompt: ترويسة الفهرس دائماً، وخريطة الصفحات عند سؤال البنية.
export function outlineContext(outline, { structure = false } = {}) {
  if (!outline) return '';
  const head = outline.header.slice(0, 4200);
  if (!structure || !outline.pages.length) return head;
  return `${head}\n\n## خريطة الصفحات (تختصراً)\n${digest(outline)}`;
}
