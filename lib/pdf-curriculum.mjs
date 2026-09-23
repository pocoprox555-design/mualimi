import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { normalizeArabic } from './arabic-text.mjs'

const PDF_ROOT = path.resolve(process.env.CURRICULUM_PDF_DIR || path.join(process.cwd(), 'curriculum-library', 'pdf-sources'))
const LIBRARY_ROOT = path.join(PDF_ROOT, '..')
const INDEX_FILE = path.join(LIBRARY_ROOT, 'pdf-index.json')
const BOOK_MANIFEST_DIR = path.join(LIBRARY_ROOT, 'pdf-books')
const REVIEWS_DIR = path.join(LIBRARY_ROOT, 'reviews')
const MAX_IMAGE_WIDTH = 1_500

const require = createRequire(import.meta.url)
let pdfjsPromise
const documentCache = new Map()
const MAX_CACHED_DOCUMENTS = 6

function normalize(value) { return normalizeArabic(value) }

function hash(value) { return createHash('sha256').update(value).digest('hex') }

async function fileChecksum(file) { return hash(await readFile(file)) }

function metadataFor(fileName) {
  const name = normalize(fileName)
  const common = { grade: 'السادس الإعدادي', year: 2025 }
  if (name.includes('اسلاميه')) return { ...common, id: 'islamic-sixth-preparatory-2025', title: 'القرآن الكريم والتربية الإسلامية للصف السادس الإعدادي', subject: 'التربية الإسلامية', branch: 'عام', referenceKind: 'official-textbook' }
  if (name.includes('العربي') && name.includes('الجزء الاول')) return { ...common, id: 'arabic-sixth-preparatory-part-1-2025', title: 'اللغة العربية للصف السادس الإعدادي — الجزء الأول', subject: 'اللغة العربية', branch: 'عام', referenceKind: 'official-textbook' }
  if (name.includes('العربي') && name.includes('الجزء الثاني')) return { ...common, id: 'arabic-sixth-preparatory-part-2-2025', title: 'اللغة العربية للصف السادس الإعدادي — الجزء الثاني', subject: 'اللغة العربية', branch: 'عام', referenceKind: 'official-textbook' }
  if (name.includes('دليل المدرس') && name.includes('الادب')) return { ...common, id: `english-literature-teacher-guide-${hash(fileName).slice(0, 8)}-pdf`, title: `دليل مدرس الأدب الإنكليزي — ${fileName.replace(/\.pdf$/i, '')}`, subject: 'دليل المدرس', branch: 'أدبي', referenceKind: 'teacher-guide' }
  if (name.includes('رياضيات')) return { ...common, id: 'mathematics-sixth-literary-pdf', title: 'الرياضيات للصف السادس الإعدادي الأدبي', subject: 'الرياضيات', branch: 'أدبي', referenceKind: 'official-textbook' }
  if (name.includes('جغرافي')) return { ...common, id: 'geography-sixth-literary-pdf', title: 'الجغرافية للصف السادس الإعدادي الأدبي', subject: 'الجغرافية', branch: 'أدبي', referenceKind: 'official-textbook' }
  if (name.includes('تاريخ')) return { ...common, id: 'history-sixth-literary-pdf', title: 'التاريخ للصف السادس الإعدادي الأدبي', subject: 'التاريخ', branch: 'أدبي', referenceKind: 'official-textbook' }
  if (name.includes('اقتصاد')) return { ...common, id: 'economics-sixth-literary-pdf', title: 'الاقتصاد للصف السادس الإعدادي الأدبي', subject: 'الاقتصاد', branch: 'أدبي', referenceKind: 'official-textbook' }
  if (name.includes('النشاط')) return { ...common, id: 'student-activity-sixth-pdf', title: 'كتاب النشاط للصف السادس الإعدادي', subject: 'كتاب النشاط', branch: 'عام', referenceKind: 'official-exercises' }
  if (name.includes('الطالب')) return { ...common, id: 'student-book-sixth-pdf', title: 'كتاب الطالب للصف السادس الإعدادي', subject: 'كتاب الطالب', branch: 'عام', referenceKind: 'official-textbook' }
  if (name.includes('تمارين') && name.includes('انكليزي')) return { ...common, id: 'english-literature-exercises-sixth-pdf', title: 'تمارين الأدب الإنكليزي للسادس الإعدادي', subject: 'اللغة الإنكليزية', branch: 'أدبي', referenceKind: 'official-exercises' }
  if (name.includes('الادب') && name.includes('انكليزي')) return { ...common, id: 'english-literature-sixth-pdf', title: 'الأدب الإنكليزي للسادس الإعدادي', subject: 'اللغة الإنكليزية', branch: 'أدبي', referenceKind: 'official-textbook' }
  return null
}

function pagePurpose(text) {
  const value = normalize(text)
  if (!String(text || '').trim()) return { pageType: 'image', title: 'صفحة مصورة', summary: 'تحتاج هذه الصفحة إلى القراءة البصرية من صورة PDF.', educationalPurpose: 'استخراج محتوى الصفحة من الصورة.' }
  const contents = /contents|الفهرس|المحتويات|الفهرست/.test(value)
  const pageType = contents ? 'contents'
    : /exercise|تمرين|اسئله|اسئلة|questions|choose the correct|true and false|complete the/.test(value) ? 'exercises'
      : /lesson|الدرس|الفصل|الوحده|الوحدة/.test(value) ? 'lesson'
        : /review|مراجعه|مراجعة/.test(value) ? 'review' : 'lesson_content'
  const first = String(text).replace(/\s+/g, ' ').trim()
  const educationalPurpose = pageType === 'contents' ? 'تحديد موضوعات الكتاب ومواقعها.'
    : pageType === 'exercises' ? 'تطبيق المفاهيم والتدرب على نمط الأسئلة.'
      : pageType === 'lesson' ? 'شرح درس أو وحدة من المنهج.'
        : pageType === 'review' ? 'مراجعة وتثبيت المعلومات.' : 'قراءة التعريفات والأمثلة والمحتوى التعليمي.'
  return { pageType, title: first.slice(0, 120) || 'صفحة دون عنوان واضح', summary: first.slice(0, 360), educationalPurpose }
}

function leadingPrintedCandidate(text) {
  const match = String(text || '').trimStart().match(/^(\d{1,4})(?=\s|$)/)
  return match ? Number(match[1]) : null
}

function keywordPrintedNumber(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  const direct = value.match(/^(\d{1,4})\s+(?:Literature|Unit|الفصل|الوحدة)/i)
  if (direct) return Number(direct[1])
  const unit = value.match(/\bUnit\s+\d+\s+(\d{1,4})\s+(?:Lesson|AB)\b/i)
  if (unit) return Number(unit[1])
  return null
}

function endingPrintedCandidate(text) {
  const match = String(text || '').replace(/\s+/g, ' ').trim().match(/(?:^|\s)(\d{1,4})\s*$/)
  return match ? Number(match[1]) : null
}

function resolvePrintedNumbers(pages) {
  const candidates = pages.map((page) => {
    if (page.pageType === 'contents') return null
    const value = keywordPrintedNumber(page.fullText) ?? leadingPrintedCandidate(page.fullText) ?? endingPrintedCandidate(page.fullText)
    return Number.isInteger(value) && value >= 1 && value <= Math.max(pages.length * 2, 400) ? value : null
  })
  const resolved = new Array(pages.length).fill(null)
  const offsets = new Map()
  candidates.forEach((value, index) => {
    if (value != null) offsets.set(value - (index + 1), (offsets.get(value - (index + 1)) || 0) + 1)
  })
  const consensus = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0]
  if (consensus && consensus[1] >= 5) {
    for (let index = 0; index < pages.length; index += 1) {
      const value = index + 1 + consensus[0]
      if (value >= 1 && candidates[index] === value) resolved[index] = value
    }
  }
  for (let index = 0; index < pages.length; index += 1) {
    if (resolved[index] != null || candidates[index] == null) continue
    if (index === 0 && candidates[index] <= 10) { resolved[index] = candidates[index]; continue }
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (resolved[previous] == null) continue
      if (candidates[index] === resolved[previous] + index - previous) resolved[index] = candidates[index]
      break
    }
  }
  // إذا كانت صفحة وسط نطاق متسلسل مصوّرة ولا تحمل رقماً قابلاً للاستخراج،
  // نملأها فقط عندما يثبت الرقمان على جانبيها الاستمرارية نفسها.
  for (let left = 0; left < resolved.length; left += 1) {
    if (resolved[left] == null) continue
    let right = left + 1
    while (right < resolved.length && resolved[right] == null) right += 1
    if (right >= resolved.length || resolved[right] - resolved[left] !== right - left) continue
    for (let index = left + 1; index < right; index += 1) resolved[index] = resolved[left] + index - left
  }
  return resolved
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

async function readReview(bookId) {
  const pages = await readJson(path.join(REVIEWS_DIR, `${bookId}.pages.json`))
  const review = await readJson(path.join(REVIEWS_DIR, `${bookId}.review.json`))
  if (!pages?.pages || pages.bookId !== bookId) return null
  return { review, pages: new Map(pages.pages.map((page) => [Number(page.pageNumber), page])) }
}

async function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
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
    const entry = documentCache.get(book.id)
    documentCache.delete(book.id)
    documentCache.set(book.id, entry)
    return entry
  }
  while (documentCache.size >= MAX_CACHED_DOCUMENTS) {
    const oldestId = documentCache.keys().next().value
    const oldest = documentCache.get(oldestId)
    documentCache.delete(oldestId)
    try { await oldest?.document?.destroy?.() } catch { /* الإخلاء best-effort */ }
  }
  const [{ getDocument }, { createCanvas }] = await Promise.all([pdfjs(), import('@napi-rs/canvas')])
  const options = { data: new Uint8Array(await readFile(book.file)) }
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
  const book = (await listPdfBooks()).find((item) => item.id === bookId)
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

export async function listPdfBooks() {
  const entries = await readdir(PDF_ROOT, { withFileTypes: true }).catch(() => [])
  const cached = await readJson(INDEX_FILE, null)
  const books = []
  for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.pdf'))) {
    const metadata = metadataFor(entry.name)
    if (!metadata) continue
    const file = path.join(PDF_ROOT, entry.name)
    const info = await stat(file)
    const indexed = cached?.books?.find((item) => item.book?.id === metadata.id && item.book?.source?.fileName === entry.name)
      || cached?.books?.find((item) => item.id === metadata.id && item.fileName === entry.name)
    books.push({
      ...metadata,
      file,
      fileName: entry.name,
      size: info.size,
      pageCount: indexed?.pageCount || null,
      searchablePageCount: indexed?.searchablePageCount || null,
    })
  }
  return books.sort((a, b) => a.title.localeCompare(b.title, 'ar'))
}

function pageRecord({ book, physicalPage, printedPage, fullText, analysis, reviewPage, pageCount }) {
  const reviewed = Boolean(reviewPage)
  const needsOcr = reviewed ? Boolean(reviewPage.needsOcr) : !fullText || fullText.length < 10
  const pageType = reviewPage?.kind || analysis.pageType
  return {
    physicalPage,
    printedPage: printedPage ?? null,
    // Aliases keep the public tool contract simple while the schema remains explicit.
    pageNumber: physicalPage,
    printedPageNumber: printedPage ?? null,
    fullText: needsOcr ? '' : fullText,
    searchable: !needsOcr && fullText.length > 10,
    ocr: { required: needsOcr, status: needsOcr ? 'needed' : 'text' },
    needsOcr,
    title: reviewPage?.title || analysis.title,
    summary: reviewPage?.summary || analysis.summary,
    section: reviewPage?.section || null,
    unit: reviewPage?.unit || null,
    pageType,
    educationalPurpose: analysis.educationalPurpose,
    lessonRange: reviewPage?.lessonRange || null,
    reviewed,
    lineRange: reviewPage?.lineRange || null,
    sourceProvenance: {
      type: 'pdf',
      fileName: book.fileName,
      physicalPage,
      authority: book.referenceKind === 'teacher-guide' ? 'supporting-reference' : 'official-reference',
    },
    neighbors: { previous: physicalPage > 1 ? physicalPage - 1 : null, next: physicalPage < pageCount ? physicalPage + 1 : null },
  }
}

export async function rebuildPdfIndex() {
  await mkdir(BOOK_MANIFEST_DIR, { recursive: true })
  const sourceBooks = await listPdfBooks()
  const books = []
  for (const source of sourceBooks) {
    const { document } = await openDocument(source)
    const review = await readReview(source.id)
    const reviewedMetadata = review?.review?.metadata || {}
    const metadata = {
      ...source,
      title: reviewedMetadata.title || source.title,
      subject: reviewedMetadata.subject || source.subject,
      grade: reviewedMetadata.grade || source.grade,
      branch: reviewedMetadata.branch || source.branch,
      edition: reviewedMetadata.edition || source.edition || null,
      year: reviewedMetadata.year || source.year,
      publisher: reviewedMetadata.publisher || null,
    }
    const rawPages = []
    for (let physicalPage = 1; physicalPage <= document.numPages; physicalPage += 1) {
      const fullText = await extractPageText(source, physicalPage)
      rawPages.push({ physicalPage, fullText, analysis: pagePurpose(fullText) })
    }
    const printed = resolvePrintedNumbers(rawPages)
    const pages = rawPages.map((page, index) => pageRecord({
      book: metadata,
      physicalPage: page.physicalPage,
      printedPage: printed[index],
      fullText: page.fullText,
      analysis: page.analysis,
      reviewPage: review?.pages.get(page.physicalPage),
      pageCount: document.numPages,
    }))
    const checksum = await fileChecksum(source.file)
    const book = {
      id: source.id,
      title: metadata.title,
      subject: metadata.subject,
      grade: metadata.grade,
      branch: metadata.branch,
      edition: metadata.edition,
      year: metadata.year,
      publisher: metadata.publisher,
      referenceKind: source.referenceKind,
      pageCount: document.numPages,
      searchablePageCount: pages.filter((page) => page.searchable).length,
      book: {
        id: source.id,
        title: metadata.title,
        subject: metadata.subject,
        grade: metadata.grade,
        branch: metadata.branch,
        edition: metadata.edition,
        year: metadata.year,
        publisher: metadata.publisher,
        referenceKind: source.referenceKind,
        source: { type: 'pdf', fileName: source.fileName, bytes: source.size, checksum, publisher: metadata.publisher, authoritative: source.referenceKind !== 'teacher-guide' },
      },
      source: { type: 'pdf', fileName: source.fileName, bytes: source.size, checksum, publisher: metadata.publisher, authoritative: source.referenceKind !== 'teacher-guide' },
      pages,
    }
    books.push(book)
    await writeFile(path.join(BOOK_MANIFEST_DIR, `${source.id}.json`), `${JSON.stringify({ schemaVersion: 2, ...book })}\n`, 'utf8')
  }
  books.sort((a, b) => a.title.localeCompare(b.title, 'ar'))
  const result = { schemaVersion: 2, sourceOfTruth: 'curriculum-library/pdf-sources', books }
  await writeFile(INDEX_FILE, `${JSON.stringify(result)}\n`, 'utf8')
  return result
}

async function readIndex() {
  const index = await readJson(INDEX_FILE, null)
  return index?.schemaVersion === 2 ? index : null
}

function canonicalBook(book) {
  if (!book) return null
  if (book.book?.id) return book
  return { ...book, book: { id: book.id, title: book.title, subject: book.subject, grade: book.grade, branch: book.branch, year: book.year, source: book.source || null }, pages: (book.pages || []).map((page) => ({
    ...page,
    physicalPage: page.physicalPage || page.pageNumber,
    printedPage: page.printedPage ?? page.printedPageNumber ?? null,
    fullText: page.fullText ?? page.text ?? '',
    searchable: page.searchable ?? Boolean(page.text),
  })) }
}

export async function getPdfIndex({ rebuild = false } = {}) {
  return rebuild ? rebuildPdfIndex() : (await readIndex()) || rebuildPdfIndex()
}

export async function inspectPdfBook(bookId) {
  const index = await getPdfIndex()
  const book = canonicalBook(index.books.find((item) => (item.book?.id || item.id) === bookId))
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  return {
    ...book,
    file: undefined,
    pages: book.pages.map(({ fullText, text, ...page }) => ({ ...page, preview: fullText.slice(0, 320) })),
  }
}

export async function searchPdfLibrary(query, { limit = 8, subject = null, bookId = null } = {}) {
  const index = await getPdfIndex()
  const terms = normalize(query).split(/\s+/).filter((term) => term.length > 1)
  if (!terms.length) return []
  const results = []
  for (const rawBook of index.books) {
    const book = canonicalBook(rawBook)
    if (bookId && book.book.id !== bookId) continue
    if (subject && !normalize(book.book.subject).includes(normalize(subject))) continue
    for (const page of book.pages) {
      const haystack = normalize(`${book.book.title} ${book.book.subject} ${page.fullText}`)
      const printedHit = terms.some((term) => /^\d+$/.test(term) && Number(term) === page.printedPage)
      const hits = terms.filter((term) => haystack.includes(term)).length + (printedHit ? 3 : 0)
      if (!hits) continue
      results.push({
        score: Number((hits / terms.length).toFixed(4)),
        citation: { bookId: book.book.id, title: book.book.title, subject: book.book.subject, pageNumber: page.physicalPage, printedPageNumber: page.printedPage },
        preview: page.fullText.slice(0, 360),
      })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
}

async function indexedBook(bookId) {
  const index = await getPdfIndex()
  const book = canonicalBook(index.books.find((item) => (item.book?.id || item.id) === bookId))
  if (!book) throw new Error('PDF_BOOK_NOT_FOUND')
  return book
}

export async function locatePdfPage(bookId, printedPage) {
  const book = await indexedBook(bookId)
  const wanted = Number(printedPage)
  const matches = book.pages.filter((page) => page.printedPage === wanted)
  return { bookId, title: book.book.title, subject: book.book.subject, printedPageNumber: wanted, matches: matches.map(({ fullText, ...page }) => ({ ...page, preview: fullText.slice(0, 320) })) }
}

export async function locatePdfPages(bookId, printedPageNumbers) {
  const book = await indexedBook(bookId)
  const numbers = [...new Set((Array.isArray(printedPageNumbers) ? printedPageNumbers : []).map(Number).filter((number) => Number.isInteger(number) && number >= 1))].slice(0, 50)
  const mappings = []
  const notFound = []
  for (const printedPageNumber of numbers) {
    const page = book.pages.find((item) => item.printedPage === printedPageNumber)
    if (page) mappings.push({ printedPageNumber, pdfPageNumber: page.physicalPage })
    else notFound.push(printedPageNumber)
  }
  return { bookId, title: book.book.title, subject: book.book.subject, mappings, notFound }
}

export async function openPdfPages(bookId, pageNumbers, { includeImages = true } = {}) {
  const book = await indexedBook(bookId)
  const source = (await listPdfBooks()).find((item) => item.id === bookId)
  const numbers = [...new Set((Array.isArray(pageNumbers) ? pageNumbers : []).map(Number))].filter((number) => Number.isInteger(number) && number >= 1 && number <= book.pageCount).slice(0, 25)
  const pages = []
  for (const physicalPage of numbers) {
    const indexed = book.pages.find((page) => page.physicalPage === physicalPage)
    if (!indexed) continue
    let image = null
    if (includeImages && source) {
      try { image = (await renderPdfPage(bookId, physicalPage)).dataUrl } catch { image = null }
    }
    pages.push({
      bookId,
      title: book.book.title,
      subject: book.book.subject,
      pageNumber: physicalPage,
      physicalPage,
      printedPageNumber: indexed.printedPage,
      printedPage: indexed.printedPage,
      text: indexed.fullText,
      fullText: indexed.fullText,
      image,
      needsOcr: indexed.ocr?.required || !indexed.searchable,
      sourceProvenance: indexed.sourceProvenance,
      lineRange: indexed.lineRange || null,
    })
  }
  return pages
}
