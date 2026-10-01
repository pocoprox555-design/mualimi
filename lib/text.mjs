// أدوات النص المشتركة بين مولد الفهرس ومحرك البحث.
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const BIDI = /[‌‍‎‏‪-‮⁦-⁧﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ARABIC_PRESENTATION = /[\uFB50-\uFDFF\uFE70-\uFEFF]/g;
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
  'عندك', 'موجود', 'متاح', 'متوفر', 'الصف', 'صف', 'السادس', 'سادس', 'الاعدادي', 'اعدادي',
  'اسلامي', 'الاسلامي', 'الديني', 'ديني', 'للسادس',
  // أدوات الاستفهام والوظائف: تُضعف تغطية البحث حين تبقى ضمن مصطلحات السؤال
  'لماذا', 'كيف', 'متي', 'اين', 'وين', 'مين', 'اي', 'ايه', 'كم', 'فقط', 'ايضا',
  'يوجد', 'هناك', 'هنا', 'يمكن', 'الان',
  // أسماء خفيفة تشير إلى أدوات الصفحة نفسها بدل مضمونها
  'معني', 'معاني', 'كلمه', 'كلمات', 'مفرده', 'مفردات', 'معجم', 'مسرد', 'قائمه',
  'تعريف', 'تعريفات', 'صوره', 'صور', 'رسم', 'رسوم', 'لوحه', 'مشهد', 'شكل',
  'سؤال', 'اسئله', 'جواب', 'جمله', 'جمل', 'نصوص',
  // أفعال مساعدة يسبقها السؤال عادة
  'ساعدني', 'ساعد', 'ساعديني', 'اخبرني', 'اخبر', 'ابحث', 'استخرج', 'وضح', 'عرف',
  'عرفني', 'فسر', 'ترجم', 'اكمل', 'اكمللي',
]);

export function cleanText(value) {
  let text = String(value ?? '').replace(BIDI, '').replace(CONTROL, '');
  for (const [pattern, replacement] of OCR_FIX) text = text.replace(pattern, replacement);
  return text
    .replace(/\r/g, '')
    .replace(ARABIC_PRESENTATION, (character) => character.normalize('NFKC'))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeDigits(value) {
  return String(value ?? '').replace(/[٠-٩۰-۹]/g, (digit) => {
    const value = ARABIC_DIGITS.indexOf(digit);
    return String(value >= 0 ? value : digit.charCodeAt(0) - 0x06f0);
  });
}

export function normalizeAr(value) {
  return normalizeDigits(cleanText(value).normalize('NFKC'))
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

export function searchTokenForms(term) {
  const forms = new Set([String(term || '')]);
  if (term.startsWith('ال') && term.length > 4) forms.add(term.slice(2));
  else if (!term.startsWith('ال') && term.length > 3) forms.add(`ال${term}`);
  for (const suffix of ['كم', 'كن', 'هم', 'هن', 'ها', 'نا', 'ه', 'ك', 'ي']) {
    for (const form of [...forms]) {
      if (form.length > suffix.length + 3 && form.endsWith(suffix)) forms.add(form.slice(0, -suffix.length));
    }
  }
  for (const form of [...forms]) {
    if (form.length > 4 && form.endsWith('ات')) forms.add(form.slice(0, -2));
    if (form.length > 4 && form.endsWith('ه')) { forms.add(`${form.slice(0, -1)}ت`); forms.add(form.slice(0, -1)); }
    else if (form.length > 4 && form.endsWith('ت')) { forms.add(`${form.slice(0, -1)}ه`); forms.add(form.slice(0, -1)); }
  }
  return forms;
}

export function searchTokens(value) {
  const result = new Set();
  for (const term of uniqueTokens(value)) for (const form of searchTokenForms(term)) result.add(form);
  return [...result];
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
