// أدوات النص المشتركة بين مولد الفهرس ومحرك البحث.
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const BIDI = /[‌‍‎‏‪-‮⁦-⁧﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const OCR_FIX = [
  [/امل(?=[ء-غف-ي]{2})/g, 'الم'],
  [/اﷲ/g, 'الله'],
  [/ﷲ/g, 'الله'],
  [/الكرمي/g, 'الكريم'],
  [/الرحمي/g, 'الرحيم'],
  [/اإلسالمية/g, 'الإسلامية'],
  [/االسالمية/g, 'الاسلامية'],
];

const STOP = new Set([
  'في', 'من', 'الى', 'إلى', 'الي', 'على', 'عن', 'ما', 'ماذا', 'هل', 'هو', 'هي',
  'هذا', 'هذه', 'ذلك', 'تلك', 'ثم', 'او', 'أو', 'و', 'يا', 'مع', 'كل', 'كان',
  'كانت', 'يكون', 'ان', 'أن', 'إن', 'اذا', 'إذا', 'لم', 'لن', 'لا', 'قد', 'بعد',
  'قبل', 'بين', 'عند', 'كما', 'التي', 'الذي', 'غير', 'حتى', 'لي', 'لك', 'له',
  'لها', 'أنا', 'انا', 'أنت', 'انت', 'نحن', 'هم', 'هن', 'ثم', 'بـ', 'ب', 'ك', 'ل',
  'سوال', 'اسيله', 'ماده', 'مواد', 'كتاب', 'كتب', 'اشرح', 'شرح', 'حل', 'اريد', 'اعطني',
  'عندك', 'موجود', 'متاح', 'متوفر',
]);

export function cleanText(value) {
  let text = String(value ?? '').replace(BIDI, '').replace(CONTROL, '');
  for (const [pattern, replacement] of OCR_FIX) text = text.replace(pattern, replacement);
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeDigits(value) {
  return String(value ?? '').replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)));
}

export function normalizeAr(value) {
  return normalizeDigits(cleanText(value))
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

export function topKeywords(value, count = 10) {
  const frequency = new Map();
  for (const token of tokens(value)) frequency.set(token, (frequency.get(token) || 0) + 1);
  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, count)
    .map(([word]) => word);
}

export function pageReference(value) {
  const text = normalizeDigits(value);
  const match = text.match(/(?:صفحه|صفحة|ص|page|p)\s*(?:رقم\s*)?[#:.-]?\s*(\d{1,4})\b/i);
  return match ? Number(match[1]) : null;
}

export function compact(value, max = 280) {
  return cleanText(value).replace(/\s+/g, ' ').slice(0, max).trim();
}
