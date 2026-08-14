import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { arabicTokens, cleanArabicText, normalizeArabic, pageLineRange } from './arabic-text.mjs'
import { inspectPdfBook, listPdfBooks, openPdfPages, searchPdfLibrary } from './pdf-curriculum.mjs'

export const LIBRARY_ROOT = path.resolve(process.env.CURRICULUM_LIBRARY_DIR || path.join(process.cwd(), 'curriculum-library'))
export const BOOKS_DIR = path.join(LIBRARY_ROOT, 'books')
export const INDEX_DIR = path.join(LIBRARY_ROOT, 'index')
export const CATALOG_FILE = path.join(LIBRARY_ROOT, 'catalog.json')
export const SEARCH_INDEX_FILE = path.join(INDEX_DIR, 'search-index.json')
const MATERIALS_INDEX_FILE = path.join(INDEX_DIR, 'materials.json')
const BOOK_MAPS_DIR = path.join(INDEX_DIR, 'book-maps')
const SECTION_INDEX_DIR = path.join(INDEX_DIR, 'sections')
const PAGE_SUMMARIES_DIR = path.join(INDEX_DIR, 'page-summaries')
const REVIEWS_DIR = path.join(LIBRARY_ROOT, 'reviews')

const EMPTY_PAGE_MARKER = 'لا يوجد نص قابل للاستخراج في هذه الصفحة'
const PAGE_HEADER = /^-----\s*\[\s*صفحة\s+(\d+)\s*\]\s*-----\s*$/gm

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableSortByPage(items) {
  return [...items].sort((a, b) => a.pageNumber - b.pageNumber)
}

function titleFromManifest(manifest) {
  return [manifest.title, manifest.subject, manifest.branch].filter(Boolean).join(' · ')
}

function getBookRoot(bookId) {
  return path.join(BOOKS_DIR, assertSafeBookId(bookId))
}

export function assertSafeBookId(value) {
  const id = String(value || '').trim()
  if (!/^[a-z][a-z0-9-]{2,79}$/.test(id)) throw new Error('INVALID_BOOK_ID')
  return id
}

export function pageFileName(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 99999) throw new Error('INVALID_PAGE_NUMBER')
  return `${String(pageNumber).padStart(4, '0')}.txt`
}

export function parseNumberedBook(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r/g, '')
  const matches = [...text.matchAll(PAGE_HEADER)]
  if (!matches.length) throw new Error('NO_PAGE_MARKERS')

  const header = text.slice(0, matches[0].index).trim()
  const pages = matches.map((match, index) => {
    const pageNumber = Number(match[1])
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    const original = text.slice(start, end).trim()
    const cleaned = cleanArabicText(original)
    const needsOcr = !cleaned || cleaned.includes(EMPTY_PAGE_MARKER)
    const searchable = needsOcr ? '' : cleaned
    return {
      pageNumber,
      original,
      cleaned,
      searchable,
      needsOcr,
      lineRange: pageLineRange(original),
      checksum: hash(original),
    }
  })

  const seen = new Set()
  for (const page of pages) {
    if (seen.has(page.pageNumber)) throw new Error(`DUPLICATE_PAGE_${page.pageNumber}`)
    seen.add(page.pageNumber)
  }

  return { header, pages: pages.sort((a, b) => a.pageNumber - b.pageNumber) }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`INVALID_JSON:${path.relative(LIBRARY_ROOT, file)}`, { cause: error })
  }
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, file)
}

async function ensureDerivedDirs() {
  await Promise.all([
    mkdir(BOOKS_DIR, { recursive: true }),
    mkdir(INDEX_DIR, { recursive: true }),
    mkdir(BOOK_MAPS_DIR, { recursive: true }),
    mkdir(SECTION_INDEX_DIR, { recursive: true }),
    mkdir(PAGE_SUMMARIES_DIR, { recursive: true }),
  ])
}

export async function ensureLibrary() {
  await ensureDerivedDirs()
  const catalog = await readJson(CATALOG_FILE, null)
  if (!catalog) await atomicWrite(CATALOG_FILE, `${JSON.stringify({ schemaVersion: 1, updatedAt: null, books: [] }, null, 2)}\n`)
}

function sectionLabel(pageNumber, content) {
  const text = normalizeArabic(content || '')
  if (text.includes('مقدمة')) return 'مقدمة'
  if (text.includes('تمارين')) return 'تمارين'
  if (text.includes('أسئلة')) return 'أسئلة'
  if (text.includes('مراجعة')) return 'مراجعة'
  if (pageNumber <= 3) return 'افتتاحية'
  return `الجزء ${Math.ceil(pageNumber / 4)}`
}

function pageAnalysis(content, needsOcr = false) {
  if (needsOcr) return { title: 'صفحة تحتاج OCR', summary: 'لا يوجد نص قابل للاستخراج في هذه الصفحة.', kind: 'needs_ocr' }
  const cleaned = cleanArabicText(String(content || '').replace(/\[ص\s*\d+\s*-\s*س\s*\d+\]/g, ''))
  const lines = cleaned.split('\n').map((line) => line.trim()).filter((line) => line.length > 2)
  const titleLine = lines.find((line) => line.length <= 100 && !/^\d+$/.test(line)) || lines[0] || 'صفحة دون عنوان واضح'
  const normalized = normalizeArabic(cleaned)
  const kind = /المناقشه|الاسئله|تمارين/.test(normalized) ? 'questions'
    : /معاني الكلمات|تعريف/.test(normalized) ? 'definitions'
      : /الدرس|الوحده|الفصل/.test(normalized) ? 'lesson_start'
        : /مقدمه/.test(normalized) ? 'introduction'
          : 'lesson_content'
  const summaryParts = lines.filter((line) => line !== titleLine && !/^\d+$/.test(line)).slice(0, 3)
  return {
    title: titleLine.slice(0, 120),
    summary: (summaryParts.join(' — ') || titleLine).slice(0, 360),
    kind,
  }
}

function summarizePageContent(content) {
  return pageAnalysis(content).summary
}

async function writeDerivedArtifact(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
  return value
}

async function readCuratedReview(bookId) {
  const [review, pageReview] = await Promise.all([
    readJson(path.join(REVIEWS_DIR, `${bookId}.review.json`), null),
    readJson(path.join(REVIEWS_DIR, `${bookId}.pages.json`), null),
  ])
  if (!review || !pageReview) return null
  if (review.bookId !== bookId || pageReview.bookId !== bookId || !Array.isArray(pageReview.pages)) throw new Error(`INVALID_REVIEW:${bookId}`)
  if (review.verification?.pageCount !== pageReview.pages.length) throw new Error(`REVIEW_PAGE_COUNT_MISMATCH:${bookId}`)
  return { review, pages: new Map(pageReview.pages.map((page) => [page.pageNumber, page])) }
}

export async function rebuildDerivedIndexes() {
  await ensureLibrary()
  const books = await listBooks()
  const materials = []
  const bookMaps = []
  const sectionIndexes = []
  const pageSummaries = []

  for (const book of books) {
    const manifest = await readManifest(book.id)
    if (!manifest) continue
    const pages = stableSortByPage(manifest.pages || [])
    const curated = await readCuratedReview(book.id)
    if (curated && curated.pages.size !== pages.length) throw new Error(`REVIEW_MANIFEST_MISMATCH:${book.id}`)
    const sectionGroups = new Map()
    const mappedPages = []
    for (const page of pages) {
      const opened = await openPage(book.id, page.pageNumber)
      const analysis = pageAnalysis(opened.content, page.needsOcr)
      const curatedPage = curated?.pages.get(page.pageNumber)
      const section = curatedPage?.section || sectionLabel(page.pageNumber, opened.content)
      const sectionKey = `${manifest.id}:${section}`
      if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, [])
      sectionGroups.get(sectionKey).push(page.pageNumber)
      const mapped = {
        pageNumber: page.pageNumber,
        needsOcr: !!page.needsOcr,
        lineRange: page.lineRange,
        unit: curatedPage?.unit || null,
        section,
        title: curatedPage?.title || analysis.title,
        summary: curatedPage?.summary || analysis.summary,
        kind: curatedPage?.kind || analysis.kind,
        lessonRange: curatedPage?.lessonRange || null,
        previousPage: page.pageNumber > 1 ? page.pageNumber - 1 : null,
        nextPage: page.pageNumber < pages.at(-1).pageNumber ? page.pageNumber + 1 : null,
        continuesFrom: curatedPage?.continuesFrom ?? null,
        continuesTo: curatedPage?.continuesTo ?? null,
        reviewed: !!curatedPage,
      }
      mappedPages.push(mapped)
      pageSummaries.push({ bookId: manifest.id, title: manifest.title, subject: manifest.subject, ...mapped })
    }
    const bookMap = {
      bookId: manifest.id,
      title: manifest.title,
      subject: manifest.subject,
      grade: manifest.grade,
      branch: manifest.branch,
      edition: manifest.edition,
      year: manifest.year,
      pageCount: pages.length,
      pages: mappedPages,
    }
    bookMaps.push(bookMap)

    sectionIndexes.push({
      bookId: manifest.id,
      title: manifest.title,
      sections: curated
        ? curated.review.sections.map((item) => ({ unit: item.unit, name: item.lesson, kind: item.kind, from: item.from, to: item.to, pages: Array.from({ length: item.to - item.from + 1 }, (_, index) => item.from + index) }))
        : [...sectionGroups.entries()].map(([key, pageNumbers]) => ({
          name: key.slice(`${manifest.id}:`.length),
          pages: pageNumbers.slice().sort((a, b) => a - b),
        })),
    })

    materials.push({
      bookId: manifest.id,
      title: manifest.title,
      subject: manifest.subject,
      grade: manifest.grade,
      branch: manifest.branch,
      edition: manifest.edition,
      year: manifest.year,
      pageCount: pages.length,
      searchablePageCount: manifest.searchablePageCount,
      needsOcrPageCount: manifest.needsOcrPageCount,
      importedAt: manifest.importedAt,
    })
  }

  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    materials: materials.sort((a, b) => a.subject.localeCompare(b.subject, 'ar')),
  }
  await Promise.all([
    writeDerivedArtifact(MATERIALS_INDEX_FILE, snapshot),
    writeDerivedArtifact(path.join(BOOK_MAPS_DIR, 'index.json'), { schemaVersion: 1, books: bookMaps }),
    writeDerivedArtifact(path.join(SECTION_INDEX_DIR, 'index.json'), { schemaVersion: 1, books: sectionIndexes }),
    writeDerivedArtifact(path.join(PAGE_SUMMARIES_DIR, 'index.json'), { schemaVersion: 1, pages: pageSummaries }),
  ])
  return snapshot
}

export async function importNumberedBook({ sourceFile, metadata }) {
  await ensureLibrary()
  const bookId = assertSafeBookId(metadata.id)
  const absoluteSource = path.resolve(sourceFile)
  const source = await readFile(absoluteSource, 'utf8')
  const parsed = parseNumberedBook(source)
  const finalDir = getBookRoot(bookId)
  const temporaryDir = path.join(BOOKS_DIR, `.${bookId}-${process.pid}-${Date.now()}`)
  await mkdir(path.join(temporaryDir, 'pages'), { recursive: true })
  await mkdir(path.join(temporaryDir, 'source'), { recursive: true })
  try {
    const pageRecords = []
    for (const page of parsed.pages) {
      const file = pageFileName(page.pageNumber)
      await writeFile(path.join(temporaryDir, 'pages', file), `${page.original}\n`, 'utf8')
      pageRecords.push({
        pageNumber: page.pageNumber,
        file: `pages/${file}`,
        checksum: page.checksum,
        characters: page.original.length,
        searchableCharacters: page.searchable.length,
        needsOcr: page.needsOcr,
        lineRange: page.lineRange,
      })
    }
    await writeFile(path.join(temporaryDir, 'source', 'original.txt'), source, 'utf8')
    const sourceInfo = await stat(absoluteSource)
    const now = new Date().toISOString()
    const manifest = {
      schemaVersion: 2,
      id: bookId,
      title: metadata.title,
      subject: metadata.subject,
      grade: metadata.grade || 'السادس الإعدادي',
      branch: metadata.branch || 'عام',
      edition: metadata.edition || null,
      year: metadata.year ? Number(metadata.year) : null,
      language: 'ar',
      source: {
        originalFileName: path.basename(absoluteSource),
        checksum: hash(source),
        bytes: sourceInfo.size,
        provenance: metadata.provenance || 'user-provided',
        licenseStatus: metadata.licenseStatus || 'user-authorized',
        sourceUrl: metadata.sourceUrl || null,
      },
      importedAt: now,
      pageCount: pageRecords.length,
      searchablePageCount: pageRecords.filter((page) => !page.needsOcr).length,
      needsOcrPageCount: pageRecords.filter((page) => page.needsOcr).length,
      header: parsed.header,
      pages: pageRecords,
    }
    await writeFile(path.join(temporaryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rm(finalDir, { recursive: true, force: true })
    try { await rename(temporaryDir, finalDir) } catch (error) {
      if (!['EPERM', 'EACCES', 'EXDEV'].includes(error.code)) throw error
      await cp(temporaryDir, finalDir, { recursive: true, force: true })
      await rm(temporaryDir, { recursive: true, force: true })
    }
    const catalog = await readJson(CATALOG_FILE, { schemaVersion: 1, updatedAt: null, books: [] })
    const summary = {
      id: manifest.id, title: manifest.title, subject: manifest.subject, grade: manifest.grade,
      branch: manifest.branch, edition: manifest.edition, year: manifest.year,
      pageCount: manifest.pageCount, searchablePageCount: manifest.searchablePageCount,
      needsOcrPageCount: manifest.needsOcrPageCount, licenseStatus: manifest.source.licenseStatus,
      importedAt: manifest.importedAt,
    }
    catalog.books = [...catalog.books.filter((book) => book.id !== bookId), summary].sort((a, b) => a.subject.localeCompare(b.subject, 'ar'))
    catalog.updatedAt = now
    await atomicWrite(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`)
    await Promise.all([rebuildSearchIndex(), rebuildDerivedIndexes()])
    return manifest
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true })
    throw error
  }
}

export async function removeLibraryBook(bookId) {
  const safeId = assertSafeBookId(bookId)
  await rm(getBookRoot(safeId), { recursive: true, force: true })
  const catalog = await readJson(CATALOG_FILE, { schemaVersion: 1, books: [] })
  catalog.books = catalog.books.filter((book) => book.id !== safeId)
  catalog.updatedAt = new Date().toISOString()
  await atomicWrite(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`)
  await Promise.all([rebuildSearchIndex(), rebuildDerivedIndexes()])
}

export async function listBooks() {
  await ensureLibrary()
  const catalogBooks = (await readJson(CATALOG_FILE, { books: [] })).books
  const pdfBooks = (await listPdfBooks()).map((book) => ({
    id: book.id,
    title: book.title,
    subject: book.subject,
    grade: book.grade,
    branch: book.branch,
    edition: 'PDF المدرسي',
    year: 2025,
    pageCount: book.pageCount,
    searchablePageCount: book.searchablePageCount,
    needsOcrPageCount: book.pageCount === null ? null : book.pageCount - book.searchablePageCount,
    importedAt: null,
    format: 'pdf',
  }))
  return [...catalogBooks.filter((book) => !pdfBooks.some((pdf) => pdf.id === book.id)), ...pdfBooks]
}

export async function listMaterials() {
  const snapshot = await readJson(MATERIALS_INDEX_FILE, null)
  if (snapshot) return stableClone([...(snapshot.materials || []), ...(await listBooks()).filter((book) => book.format === 'pdf')])
  const rebuilt = await rebuildDerivedIndexes()
  return stableClone([...(rebuilt.materials || []), ...(await listBooks()).filter((book) => book.format === 'pdf')])
}

export async function readManifest(bookId) {
  const safeId = assertSafeBookId(bookId)
  return readJson(path.join(BOOKS_DIR, safeId, 'manifest.json'), null)
}

export async function inspectBook(bookId) {
  const manifest = await readManifest(bookId)
  if (!manifest) {
    const pdf = await inspectPdfBook(bookId)
    return {
      book: { id: pdf.id, title: pdf.title, subject: pdf.subject, edition: 'PDF المدرسي', year: 2025, grade: pdf.grade, branch: pdf.branch },
      pageCount: pdf.pageCount,
      searchablePageCount: pdf.searchablePageCount,
      needsOcrPageCount: pdf.pageCount - pdf.searchablePageCount,
      pages: pdf.pages.map((page) => ({ pageNumber: page.pageNumber, printedPageNumber: page.printedPageNumber, needsOcr: !page.searchable, lineRange: null, checksum: null, title: page.title, summary: page.summary, purpose: page.purpose, kind: page.kind, reviewed: true })),
    }
  }
  return {
    book: {
      id: manifest.id,
      title: manifest.title,
      subject: manifest.subject,
      edition: manifest.edition,
      year: manifest.year,
      grade: manifest.grade,
      branch: manifest.branch,
    },
    pageCount: manifest.pageCount,
    searchablePageCount: manifest.searchablePageCount,
    needsOcrPageCount: manifest.needsOcrPageCount,
    pages: manifest.pages.map((page) => ({
      pageNumber: page.pageNumber,
      file: page.file,
      needsOcr: !!page.needsOcr,
      lineRange: page.lineRange,
      checksum: page.checksum,
    })),
  }
}

async function readBookMap(bookId) {
  const safeId = assertSafeBookId(bookId)
  const index = await readJson(path.join(BOOK_MAPS_DIR, 'index.json'), null)
  let map = index?.books?.find((book) => book.bookId === safeId)
  if (!map) {
    await rebuildDerivedIndexes()
    map = (await readJson(path.join(BOOK_MAPS_DIR, 'index.json'), { books: [] })).books.find((book) => book.bookId === safeId)
  }
  if (!map) throw new Error('BOOK_NOT_FOUND')
  return map
}

export async function readBookGuide(bookId, { cursor = 0, limit = 24 } = {}) {
  const manifest = await readManifest(bookId)
  if (!manifest) {
    const pdf = await inspectPdfBook(bookId)
    const start = Math.max(0, Number(cursor) || 0)
    const size = Math.max(1, Math.min(40, Number(limit) || 24))
    const pages = pdf.pages.slice(start, start + size).map((page) => ({ ...page, reviewed: true }))
    return { bookId: pdf.id, title: `${pdf.title} · ${pdf.subject}`, overview: `${pdf.pageCount} صفحة PDF، منها ${pdf.searchablePageCount} قابلة للبحث و${pdf.pageCount - pdf.searchablePageCount} تحتاج قراءة بصرية.`, cursor: start, nextCursor: start + pages.length < pdf.pages.length ? start + pages.length : null, totalPages: pdf.pages.length, pages }
  }
  const map = await readBookMap(bookId)
  const start = Math.max(0, Number(cursor) || 0)
  const size = Math.max(1, Math.min(40, Number(limit) || 24))
  const pages = map.pages.slice(start, start + size)
  return {
    bookId: manifest.id,
    title: titleFromManifest(manifest),
    overview: `${manifest.pageCount} صفحة، منها ${manifest.searchablePageCount} قابلة للقراءة و${manifest.needsOcrPageCount} تحتاج OCR.`,
    cursor: start,
    nextCursor: start + pages.length < map.pages.length ? start + pages.length : null,
    totalPages: map.pages.length,
    pages,
  }
}

export async function listBookSections(bookId) {
  const safeId = assertSafeBookId(bookId)
  let index = await readJson(path.join(SECTION_INDEX_DIR, 'index.json'), null)
  let book = index?.books?.find((item) => item.bookId === safeId)
  if (!book) {
    await rebuildDerivedIndexes()
    index = await readJson(path.join(SECTION_INDEX_DIR, 'index.json'), { books: [] })
    book = index.books.find((item) => item.bookId === safeId)
  }
  if (!book) {
    const pdf = await inspectPdfBook(safeId)
    return { bookId: pdf.id, title: pdf.title, sections: [{ name: 'فهرس صفحات PDF', pages: pdf.pages.map((page) => page.pageNumber) }] }
  }
  return stableClone(book)
}

// يوحّد شكل صفحة PDF الخام (من openPdfPages) إلى الشكل المعياري الذي
// تعتمده بقية الأدوات (book متداخل + content/summary/needsOcr/lineRange).
// بدون هذا، أداة read_adjacent و /api/library/page?radius=N تُرجع شكلاً
// ناقصًا (bookId بدلاً من book، text بدلاً من content)، مما يُسقط
// citationFromPage عند الوصول إلى page.book.id.
function standardizePdfPage(safeId, page) {
  return {
    book: { id: safeId, title: page.title, subject: page.subject, edition: 'PDF المدرسي', year: 2025 },
    pageNumber: page.pageNumber,
    printedPageNumber: page.printedPageNumber,
    needsOcr: !page.text,
    lineRange: null,
    content: page.text,
    summary: page.text.slice(0, 360),
    image: page.image,
  }
}

export async function openPage(bookId, pageNumber) {
  const safeId = assertSafeBookId(bookId)
  const number = Number(pageNumber)
  const manifest = await readManifest(safeId)
  if (!manifest) {
    const pages = await openPdfPages(safeId, [number])
    const page = pages[0]
    if (!page) throw new Error('PAGE_NOT_FOUND')
    return standardizePdfPage(safeId, page)
  }
  const page = manifest.pages.find((item) => item.pageNumber === number)
  if (!page) throw new Error('PAGE_NOT_FOUND')
  const expected = path.join(BOOKS_DIR, safeId, page.file)
  const resolved = path.resolve(expected)
  const bookRoot = `${path.resolve(path.join(BOOKS_DIR, safeId))}${path.sep}`
  if (!resolved.startsWith(bookRoot)) throw new Error('UNSAFE_PAGE_PATH')
  const content = await readFile(resolved, 'utf8')
  return {
    book: {
      id: manifest.id,
      title: manifest.title,
      subject: manifest.subject,
      edition: manifest.edition,
      year: manifest.year,
    },
    ...page,
    content,
    summary: summarizePageContent(content),
  }
}

export async function openPages(bookId, pageNumbers) {
  if (!Array.isArray(pageNumbers) || !pageNumbers.length) throw new Error('PAGE_NUMBERS_REQUIRED')
  const unique = [...new Set(pageNumbers.map(Number))]
  if (unique.length > 20) throw new Error('TOO_MANY_PAGES')
  return Promise.all(unique.sort((a, b) => a - b).map((number) => openPage(bookId, number)))
}

export async function openAdjacentPages(bookId, pageNumber, radius = 1) {
  const safeId = assertSafeBookId(bookId)
  const safeRadius = Math.max(0, Math.min(5, Number(radius) || 0))
  const manifest = await readManifest(safeId)
  if (!manifest) {
    const pdf = await inspectPdfBook(safeId)
    const numbers = pdf.pages.filter((page) => Math.abs(page.pageNumber - Number(pageNumber)) <= safeRadius).map((page) => page.pageNumber)
    const raw = await openPdfPages(safeId, numbers)
    return raw.map((page) => standardizePdfPage(safeId, page))
  }
  const wanted = manifest.pages
    .filter((page) => Math.abs(page.pageNumber - Number(pageNumber)) <= safeRadius)
    .map((page) => page.pageNumber)
    .sort((a, b) => a - b)
  return Promise.all(wanted.map((number) => openPage(safeId, number)))
}

export async function adjacent(bookId, pageNumber, radius = 1) {
  return openAdjacentPages(bookId, pageNumber, radius)
}

function termFrequency(tokens) {
  const frequencies = Object.create(null)
  for (const token of tokens) frequencies[token] = (frequencies[token] || 0) + 1
  return frequencies
}

export async function rebuildSearchIndex() {
  await ensureLibrary()
  const books = await listBooks()
  const documents = []
  const documentFrequency = Object.create(null)

  for (const book of books) {
    if (book.format === 'pdf') continue
    const manifest = await readManifest(book.id)
    if (!manifest) continue
    for (const page of manifest.pages) {
      if (page.needsOcr) continue
      const opened = await openPage(book.id, page.pageNumber)
      const normalized = normalizeArabic(opened.content)
      const tokens = arabicTokens(normalized)
      const frequencies = termFrequency(tokens)
      for (const term of Object.keys(frequencies)) documentFrequency[term] = (documentFrequency[term] || 0) + 1
      documents.push({
        bookId: book.id,
        title: book.title,
        subject: book.subject,
        edition: book.edition,
        year: book.year,
        pageNumber: page.pageNumber,
        file: page.file,
        lineRange: page.lineRange,
        length: tokens.length,
        terms: frequencies,
        normalizedTitle: normalizeArabic(`${book.title} ${book.subject}`),
        preview: cleanArabicText(opened.content.replace(/\[ص\s*\d+\s*-\s*س\s*\d+\]/g, '')).slice(0, 240),
      })
    }
  }

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    documentCount: documents.length,
    averageDocumentLength: documents.length ? documents.reduce((sum, item) => sum + item.length, 0) / documents.length : 0,
    documentFrequency,
    documents,
  }
  await atomicWrite(SEARCH_INDEX_FILE, `${JSON.stringify(index)}\n`)
  return index
}

export async function searchLibrary(query, { limit = 8, subject = null, bookId = null } = {}) {
  if (bookId && (await listPdfBooks()).some((book) => book.id === bookId)) {
    return (await searchPdfLibrary(query, { bookId, subject, limit })).map((result) => ({ ...result, content: result.preview }))
  }
  const queryTokens = [...new Set(arabicTokens(query))]
  if (!queryTokens.length) return []
  let index = await readJson(SEARCH_INDEX_FILE, null)
  if (!index) index = await rebuildSearchIndex()
  const N = index.documentCount || 1
  const avgLength = index.averageDocumentLength || 1
  const normalizedQuery = normalizeArabic(query)
  const k1 = 1.5
  const b = 0.72

  const ranked = index.documents
    .filter((doc) => !subject || normalizeArabic(doc.subject).includes(normalizeArabic(subject)))
    .filter((doc) => !bookId || doc.bookId === assertSafeBookId(bookId))
    .map((doc) => {
      let score = 0
      for (const term of queryTokens) {
        const tf = doc.terms[term] || 0
        if (!tf) continue
        const df = index.documentFrequency[term] || 0
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgLength))))
        if (doc.normalizedTitle.includes(term)) score += 1.4
      }
      return { doc, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(24, Number(limit) * 4))

  const reranked = []
  for (const item of ranked) {
    const page = await openPage(item.doc.bookId, item.doc.pageNumber)
    const normalizedContent = normalizeArabic(page.content)
    const phraseBonus = normalizedQuery.length > 4 && normalizedContent.includes(normalizedQuery) ? 4 : 0
    const coverage = queryTokens.filter((term) => normalizedContent.includes(term)).length / queryTokens.length
    reranked.push({
      score: Number((item.score + phraseBonus + coverage * 2).toFixed(4)),
      citation: {
        bookId: item.doc.bookId,
        title: item.doc.title,
        subject: item.doc.subject,
        edition: item.doc.edition,
        year: item.doc.year,
        pageNumber: item.doc.pageNumber,
        lineRange: item.doc.lineRange,
      },
      preview: item.doc.preview,
      content: page.content,
    })
  }

  const txtResults = reranked.sort((a, b) => b.score - a.score)
  const sliceLimit = Math.max(1, Math.min(20, Number(limit) || 8))
  // عند البحث في كتاب محدد نُرجع نتائج ذلك الكتاب فقط.
  if (bookId) return txtResults.slice(0, sliceLimit)

  // البحث العابر للكتب: كتب PDF هي المرجع الأساسي الآن وفهرسها هو المصدر
  // الفعلي للمحتوى، لذلك ندمج نتائج بحث PDF مع نتائج النصوص المرقّمة إن وُجدت.
  // لا مضاعفة صناعية: النتائج تُرتَّب حسب جودة المطابقة الحقيقية فقط.
  const pdfResults = (await searchPdfLibrary(query, { subject, limit: Math.max(8, sliceLimit) }))
    .map((result) => ({ ...result, content: result.preview }))

  return [...txtResults, ...pdfResults].sort((a, b) => b.score - a.score).slice(0, sliceLimit)
}

export async function searchMaterials(query, options = {}) {
  const materials = await listMaterials()
  const normalizedQuery = normalizeArabic(query)
  const terms = arabicTokens(query)
  const matches = materials
    .map((material) => {
      const haystack = normalizeArabic(`${material.title} ${material.subject} ${material.branch || ''}`)
      let score = 0
      if (haystack.includes(normalizedQuery)) score += 8
      for (const term of terms) if (haystack.includes(term)) score += 2
      if (options.bookId && material.bookId === assertSafeBookId(options.bookId)) score += 4
      if (options.subject && normalizeArabic(material.subject).includes(normalizeArabic(options.subject))) score += 3
      return { material, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  return matches.slice(0, Math.max(1, Math.min(20, Number(options.limit) || 8))).map((item) => item.material)
}

export async function validateLibrary() {
  const books = await listBooks()
  const issues = []
  let pages = 0
  let searchablePages = 0
  let needsOcrPages = 0
  for (const book of books) {
    if (book.format === 'pdf') {
      pages += Number(book.pageCount || 0)
      searchablePages += Number(book.searchablePageCount || 0)
      needsOcrPages += Number(book.pageCount || 0) - Number(book.searchablePageCount || 0)
      continue
    }
    const manifest = await readManifest(book.id)
    if (!manifest) { issues.push(`${book.id}: missing manifest`); continue }
    for (const page of manifest.pages) {
      pages += 1
      if (page.needsOcr) needsOcrPages += 1
      else searchablePages += 1
      try {
        const opened = await openPage(book.id, page.pageNumber)
        if (hash(opened.content.trim()) !== page.checksum) issues.push(`${book.id}:${page.pageNumber}: checksum mismatch`)
      } catch (error) {
        issues.push(`${book.id}:${page.pageNumber}: ${error.message}`)
      }
    }
  }
  return { ok: issues.length === 0, books: books.length, pages, searchablePages, needsOcrPages, issues }
}

export async function discoverBookIds() {
  await ensureLibrary()
  const entries = await readdir(BOOKS_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
}
