import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { arabicTokens, cleanArabicText, normalizeArabic, pageLineRange } from './arabic-text.mjs'
import {
  getPdfIndex,
  inspectPdfBook,
  listPdfBooks,
  openPdfPages,
  searchPdfLibrary,
} from './pdf-curriculum.mjs'

export const LIBRARY_ROOT = path.resolve(process.env.CURRICULUM_LIBRARY_DIR || path.join(process.cwd(), 'curriculum-library'))
export const BOOKS_DIR = path.join(LIBRARY_ROOT, 'books')
export const INDEX_DIR = path.join(LIBRARY_ROOT, 'index')
export const CATALOG_FILE = path.join(LIBRARY_ROOT, 'catalog.json')
export const SEARCH_INDEX_FILE = path.join(INDEX_DIR, 'search-index.json')
const MATERIALS_INDEX_FILE = path.join(INDEX_DIR, 'materials.json')
const BOOK_MAPS_INDEX_FILE = path.join(INDEX_DIR, 'book-maps', 'index.json')
const SECTION_INDEX_FILE = path.join(INDEX_DIR, 'sections', 'index.json')
const PAGE_SUMMARIES_INDEX_FILE = path.join(INDEX_DIR, 'page-summaries', 'index.json')
const REVIEWS_DIR = path.join(LIBRARY_ROOT, 'reviews')

const PAGE_MARKER = /^-----\s*\[\s*صفحة\s+(\d+)\s*\]\s*-----\s*$/gm
const EMPTY_PAGE_MARKER = 'لا يوجد نص قابل للاستخراج في هذه الصفحة'

function hash(value) { return createHash('sha256').update(value).digest('hex') }

function stableClone(value) { return JSON.parse(JSON.stringify(value)) }

function stableSortPages(pages) { return [...pages].sort((a, b) => (a.physicalPage || a.pageNumber) - (b.physicalPage || b.pageNumber)) }

function titleFromManifest(manifest) { return [manifest.title, manifest.subject, manifest.branch].filter(Boolean).join(' · ') }

function bookRoot(bookId) { return path.join(BOOKS_DIR, assertSafeBookId(bookId)) }

export function assertSafeBookId(value) {
  const id = String(value || '').trim()
  if (!/^[a-z][a-z0-9-]{2,79}$/.test(id)) throw new Error('INVALID_BOOK_ID')
  return id
}

export function pageFileName(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 99_999) throw new Error('INVALID_PAGE_NUMBER')
  return `${String(pageNumber).padStart(4, '0')}.txt`
}

export function parseNumberedBook(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r/g, '')
  const matches = [...text.matchAll(PAGE_MARKER)]
  if (!matches.length) throw new Error('NO_PAGE_MARKERS')
  const header = text.slice(0, matches[0].index).trim()
  const pages = matches.map((match, index) => {
    const physicalPage = Number(match[1])
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    const original = text.slice(start, end).trim()
    const fullText = cleanArabicText(original)
    const needsOcr = !fullText || fullText.includes(EMPTY_PAGE_MARKER)
    return {
      physicalPage,
      printedPage: physicalPage,
      pageNumber: physicalPage,
      cleaned: fullText,
      searchableText: needsOcr ? '' : fullText,
      needsOcr,
      original,
      fullText: needsOcr ? '' : fullText,
      searchable: !needsOcr,
      ocr: { required: needsOcr, status: needsOcr ? 'needed' : 'text' },
      lineRange: pageLineRange(original),
      checksum: hash(original),
    }
  })
  const seen = new Set()
  for (const page of pages) {
    if (seen.has(page.physicalPage)) throw new Error(`DUPLICATE_PAGE_${page.physicalPage}`)
    seen.add(page.physicalPage)
  }
  return { header, pages: pages.sort((a, b) => a.physicalPage - b.physicalPage) }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`INVALID_JSON:${path.relative(LIBRARY_ROOT, file)}`, { cause: error })
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, file)
}

async function ensureDerivedDirs() {
  await Promise.all([
    mkdir(BOOKS_DIR, { recursive: true }),
    mkdir(INDEX_DIR, { recursive: true }),
    mkdir(path.dirname(BOOK_MAPS_INDEX_FILE), { recursive: true }),
    mkdir(path.dirname(SECTION_INDEX_FILE), { recursive: true }),
    mkdir(path.dirname(PAGE_SUMMARIES_INDEX_FILE), { recursive: true }),
  ])
}

export async function ensureLibrary() {
  await ensureDerivedDirs()
  const catalog = await readJson(CATALOG_FILE, null)
  if (!catalog || catalog.schemaVersion !== 2) await atomicWrite(CATALOG_FILE, `${JSON.stringify({ schemaVersion: 2, sourceOfTruth: 'curriculum-library/books', books: [] }, null, 2)}\n`)
}

function pageAnalysis(content, needsOcr = false) {
  if (needsOcr) return { title: 'صفحة تحتاج OCR', summary: 'لا يوجد نص قابل للاستخراج في هذه الصفحة.', pageType: 'image', educationalPurpose: 'تحتاج إلى قراءة بصرية قبل الاستشهاد بها.' }
  const cleaned = cleanArabicText(String(content || '').replace(/\[ص\s*\d+\s*-\s*س\s*\d+\]/g, ''))
  const lines = cleaned.split('\n').map((line) => line.trim()).filter((line) => line.length > 2)
  const title = lines.find((line) => line.length <= 100 && !/^\d+$/.test(line)) || lines[0] || 'صفحة دون عنوان واضح'
  const normalized = normalizeArabic(cleaned)
  const pageType = /المناقشه|الاسئله|تمارين/.test(normalized) ? 'exercises'
    : /معاني الكلمات|تعريف/.test(normalized) ? 'definitions'
      : /الدرس|الوحده|الفصل/.test(normalized) ? 'lesson_start'
        : /مقدمه/.test(normalized) ? 'introduction' : 'lesson_content'
  return {
    title: title.slice(0, 120),
    summary: (lines.filter((line) => line !== title && !/^\d+$/.test(line)).slice(0, 3).join(' — ') || title).slice(0, 360),
    pageType,
    educationalPurpose: pageType === 'exercises' ? 'تطبيق المفاهيم والتدرب على الأسئلة.' : 'قراءة شرح الدرس وتعريفاته وأمثلته.',
  }
}

async function readCuratedReview(bookId) {
  const [review, pages] = await Promise.all([
    readJson(path.join(REVIEWS_DIR, `${bookId}.review.json`)),
    readJson(path.join(REVIEWS_DIR, `${bookId}.pages.json`)),
  ])
  if (!review || !pages || pages.bookId !== bookId || !Array.isArray(pages.pages)) return null
  return { review, pages: new Map(pages.pages.map((page) => [Number(page.pageNumber), page])) }
}

async function importedCatalog() {
  const catalog = await readJson(CATALOG_FILE, { books: [] })
  return Array.isArray(catalog.books) ? catalog.books : []
}

export async function readManifest(bookId) {
  const safeId = assertSafeBookId(bookId)
  return readJson(path.join(BOOKS_DIR, safeId, 'manifest.json'), null)
}

export async function listBooks() {
  await ensureLibrary()
  const pdfBooks = (await listPdfBooks()).map(({ file, ...book }) => ({
    ...book,
    format: 'pdf',
    edition: book.edition || 'PDF مدرسي',
    source: { type: 'pdf', fileName: book.fileName, authoritative: book.referenceKind !== 'teacher-guide' },
  }))
  const localBooks = (await importedCatalog()).map((book) => ({ ...book, format: book.format || 'numbered-text' }))
  return [...localBooks.filter((book) => !pdfBooks.some((pdf) => pdf.id === book.id)), ...pdfBooks]
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ar'))
}

export async function listMaterials() {
  const snapshot = await readJson(MATERIALS_INDEX_FILE, null)
  if (snapshot?.schemaVersion === 2 && Array.isArray(snapshot.materials)) return stableClone(snapshot.materials)
  const rebuilt = await rebuildDerivedIndexes()
  return stableClone(rebuilt.materials || [])
}

function importedPageMetadata(manifest, page, reviewPage = null) {
  const physicalPage = page.physicalPage || page.pageNumber
  const analysis = pageAnalysis(page.fullText, page.ocr?.required ?? page.needsOcr)
  return {
    physicalPage,
    printedPage: page.printedPage ?? physicalPage,
    pageNumber: physicalPage,
    printedPageNumber: page.printedPage ?? physicalPage,
    fullText: page.fullText || '',
    searchable: Boolean(page.searchable && page.fullText),
    ocr: page.ocr || { required: Boolean(page.needsOcr), status: page.needsOcr ? 'needed' : 'text' },
    title: reviewPage?.title || analysis.title,
    summary: reviewPage?.summary || analysis.summary,
    section: reviewPage?.section || null,
    unit: reviewPage?.unit || null,
    pageType: reviewPage?.kind || analysis.pageType,
    kind: reviewPage?.kind || analysis.pageType,
    educationalPurpose: analysis.educationalPurpose,
    lessonRange: reviewPage?.lessonRange || null,
    reviewed: Boolean(reviewPage),
    sourceProvenance: { type: 'numbered-text', fileName: manifest.source?.originalFileName || null, physicalPage, authority: 'official-reference' },
    neighbors: { previous: physicalPage > 1 ? physicalPage - 1 : null, next: physicalPage < manifest.pageCount ? physicalPage + 1 : null },
  }
}

function pdfPageMetadata(book, page) {
  return {
    physicalPage: page.physicalPage || page.pageNumber,
    printedPage: page.printedPage ?? page.printedPageNumber ?? null,
    pageNumber: page.physicalPage || page.pageNumber,
    printedPageNumber: page.printedPage ?? page.printedPageNumber ?? null,
    fullText: page.fullText ?? page.text ?? '',
    searchable: page.searchable ?? Boolean(page.fullText || page.text),
    ocr: page.ocr || { required: !page.searchable, status: page.searchable ? 'text' : 'needed' },
    needsOcr: page.needsOcr ?? page.ocr?.required ?? !page.searchable,
    title: page.title,
    summary: page.summary,
    section: page.section || null,
    unit: page.unit || null,
    pageType: page.pageType || page.kind || 'lesson_content',
    kind: page.pageType || page.kind || 'lesson_content',
    educationalPurpose: page.educationalPurpose || page.purpose || 'قراءة محتوى الصفحة.',
    lessonRange: page.lessonRange || null,
    reviewed: Boolean(page.reviewed),
    lineRange: page.lineRange || null,
    sourceProvenance: page.sourceProvenance || { type: 'pdf', physicalPage: page.physicalPage || page.pageNumber, authority: book.referenceKind === 'teacher-guide' ? 'supporting-reference' : 'official-reference' },
    neighbors: page.neighbors || { previous: null, next: null },
  }
}

export async function inspectBook(bookId) {
  const safeId = assertSafeBookId(bookId)
  const manifest = await readManifest(safeId)
  if (manifest) {
    const review = await readCuratedReview(safeId)
    const pages = stableSortPages(manifest.pages || []).map((page) => importedPageMetadata(manifest, page, review?.pages.get(page.physicalPage || page.pageNumber)))
    return {
      book: { id: manifest.id, title: manifest.title, subject: manifest.subject, edition: manifest.edition, year: manifest.year, grade: manifest.grade, branch: manifest.branch, source: manifest.source },
      pageCount: pages.length,
      searchablePageCount: pages.filter((page) => page.searchable).length,
      needsOcrPageCount: pages.filter((page) => page.ocr.required).length,
      pages,
    }
  }
  const pdf = await inspectPdfBook(safeId)
  const book = pdf.book || pdf
  const pages = (pdf.pages || []).map((page) => pdfPageMetadata(book, page))
  return { book: { id: book.id, title: book.title, subject: book.subject, edition: book.edition, year: book.year, grade: book.grade, branch: book.branch, source: book.source }, pageCount: pdf.pageCount, searchablePageCount: pdf.searchablePageCount, needsOcrPageCount: pages.filter((page) => page.ocr.required).length, pages }
}

async function readBookMap(bookId) {
  const safeId = assertSafeBookId(bookId)
  let index = await readJson(BOOK_MAPS_INDEX_FILE, null)
  if (index?.schemaVersion !== 2) {
    await rebuildDerivedIndexes()
    index = await readJson(BOOK_MAPS_INDEX_FILE, { books: [] })
  }
  const book = index.books?.find((item) => item.bookId === safeId)
  if (!book) throw new Error('BOOK_NOT_FOUND')
  return book
}

export async function readBookGuide(bookId, { cursor = 0, limit = 24 } = {}) {
  const safeId = assertSafeBookId(bookId)
  const info = await inspectBook(safeId)
  const start = Math.max(0, Number(cursor) || 0)
  const size = Math.max(1, Math.min(40, Number(limit) || 24))
  const pages = info.pages.slice(start, start + size)
  return {
    bookId: safeId,
    title: titleFromManifest(info.book),
    overview: `${info.pageCount} صفحة، منها ${info.searchablePageCount} قابلة للقراءة و${info.needsOcrPageCount} تحتاج OCR أو قراءة بصرية.`,
    cursor: start,
    nextCursor: start + pages.length < info.pages.length ? start + pages.length : null,
    totalPages: info.pages.length,
    pages,
  }
}

export async function listBookSections(bookId) {
  const safeId = assertSafeBookId(bookId)
  let index = await readJson(SECTION_INDEX_FILE, null)
  if (index?.schemaVersion !== 2) {
    await rebuildDerivedIndexes()
    index = await readJson(SECTION_INDEX_FILE, { books: [] })
  }
  const found = index.books?.find((book) => book.bookId === safeId)
  if (found) return stableClone(found)
  const info = await inspectBook(safeId)
  const groups = new Map()
  for (const page of info.pages) {
    const name = page.section || page.unit || page.pageType || 'محتوى الكتاب'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(page.physicalPage)
  }
  return { bookId: safeId, title: info.book.title, sections: [...groups].map(([name, pages]) => ({ name, pages })) }
}

function importedBookPath(bookId, page) {
  const root = path.resolve(bookRoot(bookId))
  const target = path.resolve(path.join(root, page.file))
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('UNSAFE_PAGE_PATH')
  return target
}

export async function openPage(bookId, pageNumber) {
  const safeId = assertSafeBookId(bookId)
  const number = Number(pageNumber)
  const manifest = await readManifest(safeId)
  if (!manifest) {
    const pages = await openPdfPages(safeId, [number], { includeImages: false })
    const page = pages[0]
    if (!page) throw new Error('PAGE_NOT_FOUND')
    return {
      book: { id: safeId, title: page.title, subject: page.subject, edition: 'PDF مدرسي', year: 2025 },
      physicalPage: page.physicalPage || page.pageNumber,
      printedPage: page.printedPage ?? page.printedPageNumber ?? null,
      pageNumber: page.pageNumber,
      printedPageNumber: page.printedPageNumber ?? null,
      fullText: page.fullText ?? page.text ?? '',
      content: page.fullText ?? page.text ?? '',
      searchable: !page.needsOcr,
      ocr: { required: Boolean(page.needsOcr), status: page.needsOcr ? 'needed' : 'text' },
      summary: (page.fullText ?? page.text ?? '').slice(0, 360),
      image: page.image,
      sourceProvenance: page.sourceProvenance || { type: 'pdf', physicalPage: page.pageNumber },
    }
  }
  const page = manifest.pages.find((item) => (item.physicalPage || item.pageNumber) === number)
  if (!page) throw new Error('PAGE_NOT_FOUND')
  const content = await readFile(importedBookPath(safeId, page), 'utf8')
  const review = await readCuratedReview(safeId)
  const metadata = importedPageMetadata(manifest, { ...page, fullText: cleanArabicText(content) }, review?.pages.get(number))
  return {
    book: { id: manifest.id, title: manifest.title, subject: manifest.subject, edition: manifest.edition, year: manifest.year },
    ...metadata,
    content,
  }
}

export async function openPages(bookId, pageNumbers) {
  if (!Array.isArray(pageNumbers) || !pageNumbers.length) throw new Error('PAGE_NUMBERS_REQUIRED')
  const unique = [...new Set(pageNumbers.map(Number))]
  if (unique.length > 20) throw new Error('TOO_MANY_PAGES')
  return Promise.all(unique.sort((a, b) => a - b).map((number) => openPage(bookId, number)))
}

export async function openAdjacentPages(bookId, pageNumber, radius = 1) {
  const safeRadius = Math.max(0, Math.min(5, Number(radius) || 0))
  const info = await inspectBook(bookId)
  const wanted = Number(pageNumber)
  const numbers = info.pages.filter((page) => Math.abs(page.physicalPage - wanted) <= safeRadius).map((page) => page.physicalPage)
  return openPages(bookId, numbers)
}

export async function adjacent(bookId, pageNumber, radius = 1) { return openAdjacentPages(bookId, pageNumber, radius) }

function termFrequency(tokens) {
  const frequencies = Object.create(null)
  for (const token of tokens) frequencies[token] = (frequencies[token] || 0) + 1
  return frequencies
}

async function allIndexedDocuments() {
  const documents = []
  const books = await listBooks()
  for (const book of books) {
    if (book.format === 'pdf') {
      const index = await getPdfIndex()
      const raw = index.books.find((item) => (item.book?.id || item.id) === book.id)
      const pages = raw?.pages || []
      for (const page of pages) {
        const fullText = page.fullText ?? page.text ?? ''
        if (!page.searchable || !fullText) continue
        const tokens = arabicTokens(fullText)
        documents.push({
          bookId: book.id,
          title: book.title,
          subject: book.subject,
          edition: book.edition,
          year: book.year,
          physicalPage: page.physicalPage || page.pageNumber,
          printedPage: page.printedPage ?? page.printedPageNumber ?? null,
          pageType: page.pageType || page.kind,
          sourceProvenance: page.sourceProvenance,
          length: tokens.length,
          terms: termFrequency(tokens),
          normalizedTitle: normalizeArabic(`${book.title} ${book.subject}`),
          preview: cleanArabicText(fullText).slice(0, 360),
        })
      }
      continue
    }
    const manifest = await readManifest(book.id)
    if (!manifest) continue
    for (const page of manifest.pages || []) {
      if (page.ocr?.required || page.needsOcr) continue
      const opened = await openPage(book.id, page.physicalPage || page.pageNumber)
      const tokens = arabicTokens(opened.fullText || opened.content)
      documents.push({
        bookId: book.id,
        title: book.title,
        subject: book.subject,
        edition: book.edition,
        year: book.year,
        physicalPage: opened.physicalPage,
        printedPage: opened.printedPage,
        pageType: opened.pageType,
        sourceProvenance: opened.sourceProvenance,
        length: tokens.length,
        terms: termFrequency(tokens),
        normalizedTitle: normalizeArabic(`${book.title} ${book.subject}`),
        preview: cleanArabicText(opened.fullText || opened.content).slice(0, 360),
      })
    }
  }
  return documents
}

export async function rebuildSearchIndex() {
  await ensureLibrary()
  const documents = await allIndexedDocuments()
  const documentFrequency = Object.create(null)
  for (const document of documents) for (const term of Object.keys(document.terms)) documentFrequency[term] = (documentFrequency[term] || 0) + 1
  const index = {
    schemaVersion: 2,
    sourceOfTruth: 'curriculum-library/pdf-sources + curriculum-library/books',
    documentCount: documents.length,
    averageDocumentLength: documents.length ? documents.reduce((sum, item) => sum + item.length, 0) / documents.length : 0,
    documentFrequency,
    documents: documents.sort((a, b) => a.bookId.localeCompare(b.bookId) || a.physicalPage - b.physicalPage),
  }
  await atomicWrite(SEARCH_INDEX_FILE, `${JSON.stringify(index)}\n`)
  return index
}

async function searchTextIndex(query, { limit = 8, subject = null, bookId = null } = {}) {
  const queryTokens = [...new Set(arabicTokens(query))]
  if (!queryTokens.length) return []
  let index = await readJson(SEARCH_INDEX_FILE, null)
  if (index?.schemaVersion !== 2) index = await rebuildSearchIndex()
  const N = index.documentCount || 1
  const average = index.averageDocumentLength || 1
  const normalizedQuery = normalizeArabic(query)
  const k1 = 1.5
  const b = 0.72
  return index.documents
    .filter((doc) => !bookId || doc.bookId === assertSafeBookId(bookId))
    .filter((doc) => !subject || normalizeArabic(doc.subject).includes(normalizeArabic(subject)))
    .map((doc) => {
      let score = 0
      for (const term of queryTokens) {
        const tf = doc.terms[term] || 0
        if (!tf) continue
        const df = index.documentFrequency[term] || 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / average))))
        if (doc.normalizedTitle.includes(term)) score += 1.4
      }
      const phrase = normalizedQuery.length > 4 && normalizeArabic(doc.preview).includes(normalizedQuery) ? 3 : 0
      const coverage = queryTokens.filter((term) => doc.terms[term]).length / queryTokens.length
      return { doc, score: score + phrase + coverage * 2 }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(24, Number(limit) * 4))
    .map(({ doc, score }) => ({
      score: Number(score.toFixed(4)),
      citation: { bookId: doc.bookId, title: doc.title, subject: doc.subject, edition: doc.edition, year: doc.year, pageNumber: doc.physicalPage, printedPageNumber: doc.printedPage, pageType: doc.pageType, sourceProvenance: doc.sourceProvenance },
      preview: doc.preview,
      content: doc.preview,
    }))
}

export async function searchLibrary(query, { limit = 8, subject = null, bookId = null } = {}) {
  if (bookId && (await listPdfBooks()).some((book) => book.id === bookId)) return (await searchPdfLibrary(query, { bookId, subject, limit })).map((result) => ({ ...result, content: result.preview }))
  const textResults = await searchTextIndex(query, { limit, subject, bookId })
  if (bookId) return textResults.slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
  const pdfResults = (await searchPdfLibrary(query, { subject, limit: Math.max(8, Number(limit) || 8) })).map((result) => ({ ...result, content: result.preview }))
  return [...textResults, ...pdfResults].sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
}

export async function searchMaterials(query, options = {}) {
  const materials = await listMaterials()
  const normalized = normalizeArabic(query)
  const terms = arabicTokens(query)
  return materials.map((material) => {
    const haystack = normalizeArabic(`${material.title} ${material.subject} ${material.branch || ''}`)
    let score = haystack.includes(normalized) ? 8 : 0
    for (const term of terms) if (haystack.includes(term)) score += 2
    if (options.bookId && material.bookId === assertSafeBookId(options.bookId)) score += 4
    if (options.subject && normalizeArabic(material.subject).includes(normalizeArabic(options.subject))) score += 3
    return { material, score }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(options.limit) || 8))).map((item) => item.material)
}

export async function rebuildDerivedIndexes() {
  await ensureLibrary()
  const books = await listBooks()
  const materials = []
  const bookMaps = []
  const sections = []
  const pageSummaries = []
  for (const book of books) {
    const info = await inspectBook(book.id)
    const pages = info.pages.map((page) => ({ ...page }))
    const mapPages = pages.map((page) => ({ ...page, fullText: undefined })).map((page) => { delete page.fullText; return page })
    bookMaps.push({ bookId: info.book.id, book: info.book, pageCount: info.pageCount, pages: mapPages })
    const groups = new Map()
    for (const page of pages) {
      const key = page.section || page.unit || page.pageType || 'محتوى الكتاب'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(page.physicalPage)
      pageSummaries.push({ bookId: info.book.id, ...page, fullText: undefined })
      delete pageSummaries.at(-1).fullText
    }
    sections.push({ bookId: info.book.id, title: info.book.title, sections: [...groups].map(([name, pageNumbers]) => ({ name, pages: pageNumbers })) })
    materials.push({
      bookId: info.book.id,
      title: info.book.title,
      subject: info.book.subject,
      grade: info.book.grade,
      branch: info.book.branch,
      edition: info.book.edition,
      year: info.book.year,
      format: book.format || 'numbered-text',
      referenceKind: book.referenceKind || (info.book.source?.authoritative === false ? 'supporting-reference' : 'official-textbook'),
      pageCount: info.pageCount,
      searchablePageCount: info.searchablePageCount,
      needsOcrPageCount: info.needsOcrPageCount,
      source: info.book.source || book.source || null,
    })
  }
  const snapshot = { schemaVersion: 2, sourceOfTruth: 'curriculum-library', materials: materials.sort((a, b) => a.title.localeCompare(b.title, 'ar')) }
  await Promise.all([
    atomicWrite(MATERIALS_INDEX_FILE, `${JSON.stringify(snapshot, null, 2)}\n`),
    atomicWrite(BOOK_MAPS_INDEX_FILE, `${JSON.stringify({ schemaVersion: 2, books: bookMaps }, null, 2)}\n`),
    atomicWrite(SECTION_INDEX_FILE, `${JSON.stringify({ schemaVersion: 2, books: sections }, null, 2)}\n`),
    atomicWrite(PAGE_SUMMARIES_INDEX_FILE, `${JSON.stringify({ schemaVersion: 2, pages: pageSummaries }, null, 2)}\n`),
  ])
  return snapshot
}

export async function importNumberedBook({ sourceFile, metadata }) {
  await ensureLibrary()
  const bookId = assertSafeBookId(metadata.id)
  const absoluteSource = path.resolve(sourceFile)
  const source = await readFile(absoluteSource, 'utf8')
  const parsed = parseNumberedBook(source)
  const destination = bookRoot(bookId)
  const temporary = path.join(BOOKS_DIR, `.${bookId}-${process.pid}.tmp`)
  await mkdir(path.join(temporary, 'pages'), { recursive: true })
  await mkdir(path.join(temporary, 'source'), { recursive: true })
  try {
    const pages = []
    for (const page of parsed.pages) {
      const file = pageFileName(page.physicalPage)
      await writeFile(path.join(temporary, 'pages', file), `${page.original}\n`, 'utf8')
      pages.push({ ...page, file: `pages/${file}`, original: undefined })
      delete pages.at(-1).original
    }
    await writeFile(path.join(temporary, 'source', 'original.txt'), source, 'utf8')
    const sourceInfo = await stat(absoluteSource)
    const manifest = {
      schemaVersion: 3,
      id: bookId,
      title: metadata.title,
      subject: metadata.subject,
      grade: metadata.grade || 'السادس الإعدادي',
      branch: metadata.branch || 'عام',
      edition: metadata.edition || null,
      year: metadata.year ? Number(metadata.year) : null,
      language: 'ar',
      format: 'numbered-text',
      source: { originalFileName: path.basename(absoluteSource), checksum: hash(source), bytes: sourceInfo.size, provenance: metadata.provenance || 'user-provided', licenseStatus: metadata.licenseStatus || 'user-authorized', sourceUrl: metadata.sourceUrl || null },
      pageCount: pages.length,
      searchablePageCount: pages.filter((page) => page.searchable).length,
      needsOcrPageCount: pages.filter((page) => page.ocr.required).length,
      header: parsed.header,
      pages,
    }
    await writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rm(destination, { recursive: true, force: true })
    try { await rename(temporary, destination) } catch (error) {
      if (!['EPERM', 'EACCES', 'EXDEV'].includes(error.code)) throw error
      await cp(temporary, destination, { recursive: true, force: true })
      await rm(temporary, { recursive: true, force: true })
    }
    const catalog = await readJson(CATALOG_FILE, { schemaVersion: 2, sourceOfTruth: 'curriculum-library/books', books: [] })
    const summary = { id: manifest.id, title: manifest.title, subject: manifest.subject, grade: manifest.grade, branch: manifest.branch, edition: manifest.edition, year: manifest.year, pageCount: manifest.pageCount, searchablePageCount: manifest.searchablePageCount, needsOcrPageCount: manifest.needsOcrPageCount, licenseStatus: manifest.source.licenseStatus, source: manifest.source }
    catalog.books = [...(catalog.books || []).filter((book) => book.id !== bookId), summary].sort((a, b) => a.title.localeCompare(b.title, 'ar'))
    await atomicWrite(CATALOG_FILE, `${JSON.stringify({ ...catalog, schemaVersion: 2 }, null, 2)}\n`)
    await rebuildSearchIndex()
    await rebuildDerivedIndexes()
    return manifest
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function validateLibrary() {
  const books = await listBooks()
  const issues = []
  let pages = 0
  let searchablePages = 0
  let needsOcrPages = 0
  for (const book of books) {
    if (book.format === 'pdf') {
      if (!book.fileName) issues.push(`${book.id}: missing PDF file name`)
      pages += Number(book.pageCount || 0)
      searchablePages += Number(book.searchablePageCount || 0)
      needsOcrPages += Number(book.pageCount || 0) - Number(book.searchablePageCount || 0)
      continue
    }
    const manifest = await readManifest(book.id)
    if (!manifest) { issues.push(`${book.id}: missing manifest`); continue }
    for (const page of manifest.pages || []) {
      pages += 1
      if (page.ocr?.required || page.needsOcr) needsOcrPages += 1
      else searchablePages += 1
      try {
        const opened = await openPage(book.id, page.physicalPage || page.pageNumber)
        if (hash(opened.content.trim()) !== page.checksum) issues.push(`${book.id}:${page.pageNumber}: checksum mismatch`)
      } catch (error) { issues.push(`${book.id}:${page.pageNumber}: ${error.message}`) }
    }
  }
  return { ok: issues.length === 0, schemaVersion: 2, books: books.length, pages, searchablePages, needsOcrPages, issues }
}
