// تطبيع عربي خفيف: تشكيل، همزات، OCR شائع — نسخة مبسطة وسريعة.
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const BIDI = /[‌‍‎‏‪-‮⁦-⁧﻿]/g;

const OCR_FIX = [
  [/امل(?=[ء-غف-ي]{2})/g, 'الم'],
  [/اﷲ/g, 'الله'],
  [/ﷲ/g, 'الله'],
  [/الكرمي/g, 'الكريم'],
  [/الرحمي/g, 'الرحيم'],
  [/اإلسالمية/g, 'الإسلامية'],
  [/االسالمية/g, 'الاسلامية'],
];

export function cleanText(v) {
  let s = String(v || '').replace(BIDI, '');
  for (const [re, rep] of OCR_FIX) s = s.replace(re, rep);
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeAr(v) {
  return cleanText(v)
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

const STOP = new Set('في من الى الي على عن ما ماذا هل هو هي هذا هذه ذلك تلك ثم او و يا مع كل كان كانت يكون ان أن إن اذا إذا لم لن لا قد بعد قبل بين عند كما التي الذي غير حتى'.split(' '));

export function tokens(v, minLen = 2) {
  return normalizeAr(v).split(' ').filter((w) => w.length >= minLen && !STOP.has(w));
}

export function topKeywords(text, n = 8) {
  const freq = new Map();
  for (const t of tokens(text)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}
