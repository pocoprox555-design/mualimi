import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readBookGuide } from '../lib/curriculum-library.mjs'

const bookId = 'islamic-sixth-preparatory-2025'
const outputDir = path.join(process.cwd(), 'curriculum-library', 'reviews')

const sections = [
  { unit: 'تمهيد الكتاب', lesson: 'صفحة العنوان وبيانات الطبعة', kind: 'front_matter', from: 1, to: 3 },
  { unit: 'تمهيد الكتاب', lesson: 'من أحكام التلاوة', kind: 'recitation_rules', from: 4, to: 8 },
  { unit: 'تمهيد الكتاب', lesson: 'بيان تعريف المصطلحات', kind: 'definitions', from: 9, to: 9 },

  { unit: 'الوحدة الأولى', lesson: 'من سورة البقرة (153–170)', kind: 'quran', from: 10, to: 19 },
  { unit: 'الوحدة الأولى', lesson: 'أصحاب الكهف', kind: 'quran_story', from: 20, to: 25 },
  { unit: 'الوحدة الأولى', lesson: 'التعاون بين المسلمين', kind: 'hadith', from: 26, to: 30 },
  { unit: 'الوحدة الأولى', lesson: 'نظام الأسرة في الإسلام', kind: 'research', from: 31, to: 40 },
  { unit: 'الوحدة الأولى', lesson: 'النهي عن الغضب', kind: 'ethics', from: 41, to: 45 },

  { unit: 'الوحدة الثانية', lesson: 'من سورة آل عمران (90–97)', kind: 'quran', from: 46, to: 49 },
  { unit: 'الوحدة الثانية', lesson: 'مريم بنت عمران (عليها السلام)', kind: 'quran_story', from: 50, to: 57 },
  { unit: 'الوحدة الثانية', lesson: 'الناجون يوم القيامة', kind: 'hadith', from: 58, to: 63 },
  { unit: 'الوحدة الثانية', lesson: 'حقوق الزوجين وواجباتهما', kind: 'research', from: 64, to: 69 },
  { unit: 'الوحدة الثانية', lesson: 'قصص وعبر', kind: 'ethics', from: 70, to: 71 },

  { unit: 'الوحدة الثالثة', lesson: 'من سورة النساء (1–10)', kind: 'quran', from: 72, to: 78 },
  { unit: 'الوحدة الثالثة', lesson: 'موسى والعبد الصالح (عليهما السلام)', kind: 'quran_story', from: 79, to: 84 },
  { unit: 'الوحدة الثالثة', lesson: 'محاسبة النفس', kind: 'hadith', from: 85, to: 87 },
  { unit: 'الوحدة الثالثة', lesson: 'نظرة عامة للنظام الاقتصادي في الإسلام', kind: 'research', from: 88, to: 96 },
  { unit: 'الوحدة الثالثة', lesson: 'الرجولة', kind: 'ethics', from: 97, to: 101 },

  { unit: 'الوحدة الرابعة', lesson: 'من سورة الإسراء (23–39)', kind: 'quran', from: 102, to: 112 },
  { unit: 'الوحدة الرابعة', lesson: 'النبي شعيب (عليه السلام)', kind: 'quran_story', from: 113, to: 119 },
  { unit: 'الوحدة الرابعة', lesson: 'في الجهاد وكرامة المجاهد', kind: 'hadith', from: 120, to: 121 },
  { unit: 'الوحدة الرابعة', lesson: 'الوظائف الاقتصادية للدولة', kind: 'research', from: 122, to: 128 },
  { unit: 'الوحدة الرابعة', lesson: 'التكبر', kind: 'ethics', from: 129, to: 131 },

  { unit: 'الوحدة الخامسة', lesson: 'من سورة الأنبياء', kind: 'quran', from: 132, to: 140 },
  { unit: 'الوحدة الخامسة', lesson: 'نبأ الفاسق', kind: 'quran_story', from: 141, to: 142 },
  { unit: 'الوحدة الخامسة', lesson: 'حسن الخلق', kind: 'hadith', from: 143, to: 147 },
  { unit: 'الوحدة الخامسة', lesson: 'التسامح والتعايش السلمي', kind: 'research', from: 148, to: 155 },
  { unit: 'الوحدة الخامسة', lesson: 'القناعة', kind: 'ethics', from: 156, to: 163 },
  { unit: 'فهرس الكتاب', lesson: 'الفهرس العام', kind: 'index', from: 164, to: 164 },
]

function sectionFor(pageNumber) {
  return sections.find((section) => pageNumber >= section.from && pageNumber <= section.to)
}

const curated = JSON.parse(await readFile(path.join(outputDir, `${bookId}.curated.json`), 'utf8'))
const curatedPages = curated.pages || {}

const allPages = []
let cursor = 0
while (true) {
  const guide = await readBookGuide(bookId, { cursor, limit: 40 })
  allPages.push(...guide.pages)
  if (guide.nextCursor === null) break
  cursor = guide.nextCursor
}

const pages = allPages.map((page) => {
  const section = sectionFor(page.pageNumber)
  if (!section) throw new Error(`No curated section for page ${page.pageNumber}`)
  const isFirst = page.pageNumber === section.from
  const isLast = page.pageNumber === section.to
  const reviewed = curatedPages[String(page.pageNumber)] || null
  const title = reviewed?.title || (page.needsOcr
    ? `${section.lesson} — صفحة تحتاج OCR`
    : (isFirst ? section.lesson : page.title))
  const summary = reviewed?.summary || (page.needsOcr
    ? `تقع هذه الصفحة ضمن درس «${section.lesson}» في ${section.unit}، لكن النص غير قابل للاستخراج ويحتاج OCR من النسخة المصورة قبل الاعتماد على تفاصيلها.`
    : page.summary)
  return {
    pageNumber: page.pageNumber,
    title,
    summary,
    kind: reviewed?.kind || (page.needsOcr ? 'needs_ocr' : (isFirst ? `${section.kind}_start` : page.kind)),
    unit: section.unit,
    section: section.lesson,
    lessonRange: { from: section.from, to: section.to },
    continuesFrom: !isFirst ? page.pageNumber - 1 : null,
    continuesTo: !isLast ? page.pageNumber + 1 : null,
    needsOcr: page.needsOcr,
    lineRange: page.lineRange,
    notes: page.needsOcr ? 'لا يجوز اختلاق محتوى هذه الصفحة؛ يلزم OCR.' : null,
  }
})

const review = {
  schemaVersion: 1,
  bookId,
  metadata: {
    title: 'القرآن الكريم والتربية الإسلامية للصف السادس الإعدادي',
    subject: 'التربية الإسلامية',
    grade: 'السادس الإعدادي',
    branch: 'عام',
    edition: 'الطبعة التاسعة',
    year: 2025,
    hijriYear: 1447,
    publisher: 'جمهورية العراق — وزارة التربية — المديرية العامة للمناهج',
  },
  verification: {
    metadataSourcePages: [1, 164],
    structureSourcePage: 164,
    pageCount: pages.length,
    readablePages: pages.filter((page) => !page.needsOcr).length,
    needsOcrPages: pages.filter((page) => page.needsOcr).length,
    reviewMethod: 'مراجعة النص المرقم كاملًا وربط الصفحات بالفهرس الرسمي في الصفحة 164.',
  },
  sections,
  quality: {
    strengths: ['ترقيم صريح للصفحات والأسطر', 'بيانات طبعة واضحة', 'فهرس رسمي كامل للوحدات والدروس'],
    concerns: ['أخطاء OCR عربية شائعة', 'صفحات كثيرة غير قابلة للاستخراج', 'بعض بدايات أو نهايات الدروس تقع في صفحات تحتاج OCR'],
    policy: 'لا تعتمد على تفاصيل صفحة needsOcr حتى تتوفر نسخة OCR؛ استخدم الصفحات المقروءة والفهرس لتحديد موضع الدرس فقط.',
  },
}

if (pages.length !== 164) throw new Error(`Expected 164 pages, found ${pages.length}`)
const readablePages = pages.filter((page) => !page.needsOcr).map((page) => String(page.pageNumber))
const missingCurated = readablePages.filter((pageNumber) => !curatedPages[pageNumber])
if (missingCurated.length) throw new Error(`Readable pages missing manual summaries: ${missingCurated.join(', ')}`)
await mkdir(outputDir, { recursive: true })
await writeFile(path.join(outputDir, `${bookId}.review.json`), `${JSON.stringify(review, null, 2)}\n`, 'utf8')
await writeFile(path.join(outputDir, `${bookId}.pages.json`), `${JSON.stringify({ schemaVersion: 1, bookId, pages }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ok: true, bookId, pages: pages.length, readable: review.verification.readablePages, needsOcr: review.verification.needsOcrPages, sections: sections.length }, null, 2))
