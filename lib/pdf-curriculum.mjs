import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { normalizeArabic } from './arabic-text.mjs'

const PDF_ROOT = path.resolve(process.env.CURRICULUM_PDF_DIR || path.join(process.cwd(), 'curriculum-library', 'pdf-sources'))
const INDEX_FILE = path.join(PDF_ROOT, '..', 'pdf-index.json')
const BOOK_MANIFEST_DIR = path.join(PDF_ROOT, '..', 'pdf-books')
const MAX_IMAGE_WIDTH = 1500

const require = createRequire(import.meta.url)

let pdfjsPromise
const MAX_CACHED_DOCUMENTS = 8
const documentCache = new Map() // LRU: الأحدث في الآخر

function evictOldestDocument() {
  if (documentCache.size <= MAX_CACHED_DOCUMENTS) return
  const oldest = documentCache.keys().next().value
  if (oldest) documentCache.delete(oldest)
}

// نستخدم التطبيع العربي الكامل (إزالة التشكيل + إصلاحات OCR + توحيد الهمزات)
// حتى تتطابق استعلامات الطالبة مع نص الكتب المشكّل أو المتضرر من الاستخراج.
function normalize(value) {
  return normalizeArabic(value)
}

function leadingPrintedCandidate(text) {
  const match = String(text || '').trimStart().match(/^(\d{1,4})(?=\s|$)/)
  return match ? Number(match[1]) : null
}

// مطابقات عالية الثقة: الرقم يسبق كلمة مفتاحية معروفة.
function keywordPrintedNumber(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const leading = value.match(/^(\d{1,4})\s+(?:Literature|Unit|الفصل|الوحدة)/i)
  if (leading) return Number(leading[1])
  const englishLeading = value.match(/^(\d{1,4})\s+[A-Z](?:\s+|$)/)
  if (englishLeading) return Number(englishLeading[1])
  const unitPage = value.match(/\bUnit\s+\d+\s+(\d{1,4})\s+(?:Lesson|AB)\b/i)
  if (unitPage) return Number(unitPage[1])
  return null
}

// مرشح ضعيف: رقم في آخر الصفحة؛ قد يكون رقم سؤال أو فهرس، لذلك لا يُعتمد
// إلا إذا أيده تصويت الإزاحة أو الجسر.
function endingPrintedCandidate(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const ending = value.match(/(?:^|\s)(\d{1,4})\s*$/)
  return ending ? Number(ending[1]) : null
}

// تمرير استمرارية: كثير من كتبنا تبدأ صفحتها بالرقم المطبوع مباشرة («41 الدرس…»)
// لكن المطابقة الحرفية أعلاه تفوته. نتحقق من تسلسل الأرقام عبر الصفحات، مع
// جسْر الفجوات الناتجة عن الصفحات الفارغة (الرقم المطبوع يتقدم 1 لكل صفحة
// فيزيائية)، ثم تمرير تصويت على إزاحة ثابتة (مطبوع = فيزيائي + إزاحة) لضبط الباقي.
function offsetConsensus(candidates, resolved, minSupport) {
  const offsets = Object.create(null)
  candidates.forEach((candidate, index) => {
    if (!candidate) return
    if (resolved[index] != null && resolved[index] !== candidate.value) return
    const offset = candidate.value - (index + 1)
    offsets[offset] = (offsets[offset] || 0) + 1
  })
  const consensus = Object.entries(offsets).sort((a, b) => b[1] - a[1])[0]
  if (!consensus || consensus[1] < minSupport) return false
  const offset = Number(consensus[0])
  let changed = false
  for (let i = 0; i < candidates.length; i += 1) {
    if (resolved[i] != null || !candidates[i]) continue
    if (candidates[i].value === i + 1 + offset) { resolved[i] = candidates[i].value; changed = true }
  }
  return changed
}

function resolvePrintedNumbers(pages, pageCount) {
  const candidates = pages.map((page) => {
    // صفحات الفهرس مليئة بالأرقام؛ نعتمد فقط رقمها الافتتاحي إن وُجد.
    const keyword = page.kind === 'contents' ? null : keywordPrintedNumber(page.text)
    if (keyword != null) return { value: keyword, strict: true }
    const leading = leadingPrintedCandidate(page.text)
    if (leading != null && leading >= 1 && leading <= Math.max(pageCount * 2, 400)) return { value: leading, strict: false }
    const ending = page.kind === 'contents' ? null : endingPrintedCandidate(page.text)
    if (ending != null && ending >= 1 && ending <= Math.max(pageCount * 2, 400)) return { value: ending, strict: false }
    return null
  })
  const resolved = new Array(pages.length).fill(null)

  for (let i = 0; i < pages.length; i += 1) {
    const candidate = candidates[i]
    if (!candidate) continue
    if (candidate.strict) { resolved[i] = candidate.value; continue }
    if (i === 0 && candidate.value <= 10) resolved[i] = candidate.value
  }

  // تصويت المرشحات على إزاحة ثابتة (مطبوع = فيزيائي + إزاحة) يوفّر بذورًا
  // حتى في الكتب كثيرة الصفحات الفارغة مثل الإسلامية.
  offsetConsensus(candidates, resolved, 6)

  for (let i = 0; i < pages.length; i += 1) {
    const candidate = candidates[i]
    if (!candidate || resolved[i] != null) continue
    // جسْر: أقرب صفحة سابقة محسومة؛ نقبل إذا تطابق الرقم مع المسافة.
    for (let j = i - 1; j >= 0; j -= 1) {
      if (resolved[j] == null) continue
      if (candidate.value === resolved[j] + (i - j)) resolved[i] = candidate.value
      break
    }
  }

  // تمرير أخير: إزاحة مجمَع عليها من الصفحات المحسومة لقبول البقية.
  offsetConsensus(candidates, resolved, 5)
  return resolved
}

function pagePurpose(text) {
  const normalized = normalize(text)
  if (!text) return { kind: 'image', title: 'صفحة مصورة', summary: 'تحتاج هذه الصفحة إلى القراءة البصرية من صورة PDF.', purpose: 'استخراج محتوى الصفحة من الصورة.' }
  const isContents = /contents|الفهرست|الفهرس|المحتويات/.test(normalized)
  // الحالة الخاصة بدرس «النهي عن الغضب» تُطبق على صفحة الدرس نفسها فقط،
  // لا على صفحة الفهرس التي تذكر عنوانه ضمن قائمة المحتويات.
  if (!isContents && normalized.includes('النهي عن الغضب')) return { kind: 'ethics_start', title: 'النهي عن الغضب: تعريفه وخطره', summary: 'الوصية النبوية لا تغضب، مع شرح معنى الغضب وأضراره وعلاجه.', purpose: 'فهم خطر الغضب وطرق التعامل معه.', questionCount: 0 }
  const kind = isContents ? 'contents'
    : /exercise|تمرين|اسئله|اسئلة|questions|choose the correct|true and false|find a word|complete the/.test(normalized) ? 'exercises'
      : /lesson|الدرس|الفصل|الوحده|الوحدة/.test(normalized) ? 'lesson'
        : /review|مراجعه|مراجعة/.test(normalized) ? 'review' : 'content'
  const first = String(text).replace(/\s+/g, ' ').trim()
  const title = first.slice(0, 110) || 'صفحة دون عنوان واضح'
  const summary = first.slice(0, 300)
  const purpose = kind === 'contents' ? 'خريطة موضوعات الكتاب وأرقام الصفحات.'
    : kind === 'exercises' ? 'تدريبات وأسئلة للمراجعة والتطبيق.'
      : kind === 'lesson' ? 'شرح درس أو وحدة من المنهج.'
        : kind === 'review' ? 'مراجعة وتثبيت للمعلومات.' : 'محتوى الدرس والأمثلة والتعريفات.'
  const questionCount = (String(text).match(/(?:^|\s)\d+[.)]?\s/g) || []).length
  return { kind, title, summary, purpose, questionCount }
}

function metadataFor(fileName) {
  const name = normalize(fileName)
  if (name.includes('اسلاميه')) return { id: 'islamic-sixth-preparatory-2025', title: 'القرآن الكريم والتربية الإسلامية للصف السادس الإعدادي', subject: 'التربية الإسلامية', grade: 'السادس الإعدادي', branch: 'عام' }
  if (name.includes('العربي') && name.includes('الجزء الاول')) return { id: 'arabic-sixth-preparatory-part-1-2025', title: 'اللغة العربية للصف السادس الإعدادي — الجزء الأول', subject: 'اللغة العربية', grade: 'السادس الإعدادي', branch: 'عام' }
  if (name.includes('العربي') && name.includes('الجزء الثاني')) return { id: 'arabic-sixth-preparatory-part-2-2025', title: 'اللغة العربية للصف السادس الإعدادي — الجزء الثاني', subject: 'اللغة العربية', grade: 'السادس الإعدادي', branch: 'عام' }
  if (name.includes('دليل المدرس') && name.includes('الادب')) return { id: `english-literature-teacher-guide-${createHash('sha1').update(fileName).digest('hex').slice(0, 8)}-pdf`, title: `دليل مدرس الأدب الإنكليزي — ${fileName.replace(/\.pdf$/i, '')}`, subject: 'دليل المدرس', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('رياضيات')) return { id: 'mathematics-sixth-literary-pdf', title: 'الرياضيات للصف السادس الإعدادي الأدبي', subject: 'الرياضيات', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('جغرافي')) return { id: 'geography-sixth-literary-pdf', title: 'الجغرافية للصف السادس الإعدادي الأدبي', subject: 'الجغرافية', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('تاريخ')) return { id: 'history-sixth-literary-pdf', title: 'التاريخ للصف السادس الإعدادي الأدبي', subject: 'التاريخ', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('اقتصاد')) return { id: 'economics-sixth-literary-pdf', title: 'الاقتصاد للصف السادس الإعدادي الأدبي', subject: 'الاقتصاد', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('النشاط')) return { id: 'student-activity-sixth-pdf', title: 'كتاب النشاط للصف السادس الإعدادي', subject: 'كتاب النشاط', grade: 'السادس الإعدادي', branch: 'عام' }
  if (name.includes('الطالب')) return { id: 'student-book-sixth-pdf', title: 'كتاب الطالب للصف السادس الإعدادي', subject: 'كتاب الطالب', grade: 'السادس الإعدادي', branch: 'عام' }
  if (name.includes('تمارين') && name.includes('انكليزي')) return { id: 'english-literature-exercises-sixth-pdf', title: 'تمارين الأدب الإنكليزي للسادس الإعدادي', subject: 'اللغة الإنكليزية', grade: 'السادس الإعدادي', branch: 'أدبي' }
  if (name.includes('الادب') && name.includes('انكليزي')) return { id: 'english-literature-sixth-pdf', title: 'الأدب الإنكليزي للسادس الإعدادي', subject: 'اللغة الإنكليزية', grade: 'السادس الإعدادي', branch: 'أدبي' }
  return null
}

async function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => module)
  return pdfjsPromise
}

function standardFontDataUrl() {
  try {
    const fontsDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
    return `${fontsDir.split(path.sep).join('/')}/`
  } catch { return undefined }
}

async function openDocument(book) {
  if (documentCache.has(book.id)) {
    // LRU: نقل المفتاح إلى نهاية الترتيب (الأحدث)
    const entry = documentCache.get(book.id)
    documentCache.delete(book.id)
    documentCache.set(book.id, entry)
    return entry
  }
  evictOldestDocument()
  const [{ getDocument }, { createCanvas }] = await Promise.all([pdfjs(), import('@napi-rs/canvas')])
  const data = new Uint8Array(await readFile(book.file))
  const options = { data }
  const fonts = standardFontDataUrl()
  if (fonts) options.standardFontDataUrl = fonts
  const entry = { document: await getDocument(options).promise, createCanvas }
  documentCache.set(book.id, entry)
  return entry
}

async function extractPageText(book, pageNumber) {
  const { document } = await openDocument(book)
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim()
}

export async function renderPdfPage(bookId, pageNumber, scale = 1.6) {
  const books = await listPdfBooks()
  const book = books.find((item) => item.id === bookId)
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  const { document, createCanvas } = await openDocument(book)
  const page = await document.getPage(Number(pageNumber))
  const base = page.getViewport({ scale })
  const ratio = Math.min(1, MAX_IMAGE_WIDTH / base.width)
  const viewport = page.getViewport({ scale: scale * ratio })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height }
}

async function readIndex() {
  try { return JSON.parse(await readFile(INDEX_FILE, 'utf8')) } catch { return null }
}

export async function listPdfBooks() {
  const entries = await readdir(PDF_ROOT, { withFileTypes: true }).catch(() => [])
  const books = []
  for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.pdf'))) {
    const metadata = metadataFor(entry.name)
    if (!metadata) continue
    const file = path.join(PDF_ROOT, entry.name)
    const size = (await stat(file)).size
    const cached = (await readIndex())?.books?.find((item) => item.id === metadata.id && item.fileName === entry.name)
    books.push({ ...metadata, file, fileName: entry.name, size, pageCount: cached?.pageCount || null, searchablePageCount: cached?.searchablePageCount || null })
  }
  return books.sort((a, b) => a.title.localeCompare(b.title, 'ar'))
}

export async function rebuildPdfIndex() {
  await mkdir(path.dirname(INDEX_FILE), { recursive: true })
  await mkdir(BOOK_MANIFEST_DIR, { recursive: true })
  const books = await listPdfBooks()
  const indexed = []
  for (const book of books) {
    const { document } = await openDocument(book)
    const pages = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const text = await extractPageText(book, pageNumber)
      const pageInfo = pagePurpose(text)
      pages.push({ pageNumber, printedPageNumber: null, text, searchable: text.length > 10, ...pageInfo })
    }
    // حسم الأرقام المطبوعة: كلمات مفتاحية، ثم رقم الافتتاح بتسلسل متتابع،
    // ثم تصويت إزاحة، والأرقام الختامية فقط عندما يؤيدها التسلسل.
    const resolved = resolvePrintedNumbers(pages, document.numPages)
    pages.forEach((page, index) => { page.printedPageNumber = resolved[index] })
    const manifest = { ...book, file: undefined, pageCount: document.numPages, searchablePageCount: pages.filter((page) => page.searchable).length, pages }
    indexed.push(manifest)
    await writeFile(path.join(BOOK_MANIFEST_DIR, `${book.id}.json`), `${JSON.stringify({ schemaVersion: 1, ...manifest })}\n`, 'utf8')
  }
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), books: indexed }
  await writeFile(INDEX_FILE, `${JSON.stringify(result)}\n`, 'utf8')
  return result
}

export async function inspectPdfBook(bookId) {
  const index = await readIndex() || await rebuildPdfIndex()
  const book = index.books.find((item) => item.id === bookId)
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  return { ...book, file: undefined, pages: book.pages.map(({ text, ...page }) => ({ ...page, preview: text.slice(0, 260) })) }
}

export async function searchPdfLibrary(query, { limit = 8, subject = null, bookId = null } = {}) {
  const index = await readIndex() || await rebuildPdfIndex()
  const terms = normalize(query).split(/\s+/).filter((term) => term.length > 1)
  if (!terms.length) return []
  const results = []
  for (const book of index.books) {
    if (bookId && book.id !== bookId) continue
    if (subject && !normalize(book.subject).includes(normalize(subject))) continue
    for (const page of book.pages) {
      const haystack = normalize(`${book.title} ${book.subject} ${page.text}`)
      const exactPageHit = terms.some((term) => /^\d+$/.test(term) && Number(term) === page.printedPageNumber)
      const hits = terms.filter((term) => haystack.includes(term)).length + (exactPageHit ? 3 : 0)
      if (hits) results.push({ score: hits / terms.length, citation: { bookId: book.id, title: book.title, subject: book.subject, pageNumber: page.pageNumber, printedPageNumber: page.printedPageNumber }, preview: page.text.slice(0, 320) })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
}

export async function locatePdfPage(bookId, printedPage) {
  const index = await readIndex() || await rebuildPdfIndex()
  const book = index.books.find((item) => item.id === bookId)
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  const wanted = Number(printedPage)
  const matches = book.pages.filter((page) => page.printedPageNumber === wanted)
  return { bookId, title: book.title, printedPageNumber: wanted, matches: matches.map(({ text, ...page }) => ({ ...page, preview: text.slice(0, 320) })) }
}

// ── locatePdfPages (جمع): يحوّل مصفوفة أرقام مطبوعة إلى خريطة
// { printedPageNumber → pdfPageNumber } في استدعاء واحد.
// مثال: locatePdfPages("history", [1,2,3,...,20]) يُعيد:
// { mappings: [{printed:1, pdf:5}, {printed:2, pdf:6}, ...], notFound: [] }
export async function locatePdfPages(bookId, printedPageNumbers) {
  const index = await readIndex() || await rebuildPdfIndex()
  const book = index.books.find((item) => item.id === bookId)
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  const wantedSet = new Set([...new Set(printedPageNumbers.map(Number))].filter((n) => n >= 1).slice(0, 50))
  const mappings = []
  const notFound = []
  for (const printed of wantedSet) {
    const page = book.pages.find((p) => p.printedPageNumber === printed)
    if (page) mappings.push({ printedPageNumber: printed, pdfPageNumber: page.pageNumber })
    else notFound.push(printed)
  }
  return {
    bookId,
    title: book.title,
    subject: book.subject,
    mappings: mappings.sort((a, b) => a.printedPageNumber - b.printedPageNumber),
    notFound,
  }
}

export async function openPdfPages(bookId, pageNumbers) {
  const index = await readIndex() || await rebuildPdfIndex()
  const book = index.books.find((item) => item.id === bookId)
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  const numbers = [...new Set(pageNumbers.map(Number))].filter((number) => number >= 1 && number <= book.pageCount).slice(0, 25)
  const pages = []
  for (const pageNumber of numbers) {
    let image = null
    try { image = await renderPdfPage(bookId, pageNumber) } catch { /* يبقى النص متاحاً إذا تعذر رسم صفحة PDF */ }
    const source = book.pages.find((page) => page.pageNumber === pageNumber)
    pages.push({ bookId, title: book.title, subject: book.subject, pageNumber, printedPageNumber: source?.printedPageNumber || null, text: source?.text || '', image: image?.dataUrl || null })
  }
  return pages
}

export async function pdfLibraryStatus() {
  const books = await listPdfBooks()
  return { books: books.length, files: books.map(({ file, ...book }) => book), indexed: !!(await readIndex()) }
}
