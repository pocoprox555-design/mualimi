const BIDI_AND_FORMATTING = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g

const OCR_REPAIRS = [
  [/اﷲ/g, 'الله'],
  [/ﷲ/g, 'الله'],
  [/االله/g, 'الله'],
  [/اهلل/g, 'الله'],
  [/للـه/g, 'لله'],
  [/اإلسـالمية/g, 'الإسلامية'],
  [/اإلسالمية/g, 'الإسلامية'],
  [/االسالمية/g, 'الاسلامية'],
  [/الكرمي/g, 'الكريم'],
  [/الرحمي/g, 'الرحيم'],
  [/املديرية/g, 'المديرية'],
  [/املناهج/g, 'المناهج'],
]

// تشوه شائع في استخراج PDF العربي: انقلاب «ال» إلى «امل» في بداية الكلمة
// (المسلمين → املسلمني، المطالعة → املطالعة). نصححها فقط عندما تليها
// حرفان عربيان فأكثر حتى لا نلمس كلمة «أمل» المستقلة أو «كاملة» وأخواتها.
const WORD_INITIAL_AML = /(^|[\s،؛:!؟()«»\-])امل(?=[\u0600-\u06FF]{2})/g

export function repairWordInitialAml(value) {
  return String(value || '').replace(WORD_INITIAL_AML, '$1الم')
}

const STOP_WORDS = new Set([
  'في', 'من', 'الى', 'إلى', 'على', 'عن', 'ما', 'ماذا', 'هل', 'هو', 'هي', 'هذا', 'هذه',
  'ذلك', 'تلك', 'ثم', 'او', 'أو', 'و', 'يا', 'مع', 'كل', 'كان', 'كانت', 'يكون', 'ان', 'أن',
  'إن', 'اذا', 'إذا', 'لم', 'لن', 'لا', 'قد', 'بعد', 'قبل', 'بين', 'عند', 'كما', 'التي', 'الذي',
])

export function removeFormatting(value) {
  return String(value || '').replace(BIDI_AND_FORMATTING, '')
}

export function repairCommonOcr(value) {
  let text = removeFormatting(value)
  for (const [pattern, replacement] of OCR_REPAIRS) text = text.replace(pattern, replacement)
  return repairWordInitialAml(text)
}

export function cleanArabicText(value) {
  return repairCommonOcr(value)
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeArabic(value) {
  return repairCommonOcr(value)
    .replace(ARABIC_DIACRITICS, '')
    .replace(/ـ/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/گ/g, 'ك')
    .replace(/چ/g, 'ج')
    .replace(/پ/g, 'ب')
    .replace(/ژ/g, 'ز')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function arabicTokens(value, { keepStopWords = false, minLength = 2 } = {}) {
  const words = normalizeArabic(value).split(' ').filter(Boolean)
  return words.filter((word) => word.length >= minLength && (keepStopWords || !STOP_WORDS.has(word)))
}

export function pageLineRange(value) {
  const numbers = [...String(value || '').matchAll(/\[ص\s*\d+\s*-\s*س\s*(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
  if (!numbers.length) return null
  return { from: Math.min(...numbers), to: Math.max(...numbers) }
}
