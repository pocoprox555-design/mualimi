import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArabic, cleanArabicText, pageLineRange, repairWordInitialAml } from '../lib/arabic-text.mjs'
import { assertSafeBookId, listBooks, openPage, parseNumberedBook, searchLibrary } from '../lib/curriculum-library.mjs'
import { getPdfIndex, locatePdfPage, locatePdfPages } from '../lib/pdf-curriculum.mjs'

test('Arabic normalization repairs common PDF extraction errors', () => {
  assert.equal(normalizeArabic('بِسْمِ اﷲ'), normalizeArabic('بسم الله'))
  assert.equal(normalizeArabic('التربية اإلسالمية'), normalizeArabic('التربية الإسلامية'))
  assert.equal(cleanArabicText('\u202Bاملديرية العامة للمناهج\u202C'), 'المديرية العامة للمناهج')
})

test('word-initial امل ligature artifact is repaired without touching real words', () => {
  // انقلاب «ال» إلى «امل» في بداية الكلمة (بعد فراغ أو ترقيم أو بداية النص)
  assert.equal(repairWordInitialAml('املطالعة'), 'المطالعة')
  assert.equal(repairWordInitialAml('في املناقشة العامة'), 'في المناقشة العامة')
  assert.equal(normalizeArabic('املطالعة'), normalizeArabic('المطالعة'))
  assert.equal(normalizeArabic('املرأة'), normalizeArabic('المرأة'))
  // لا نلمس كلمة «أمل»/«الأمل» ولا «كاملة» وأخواتها (امل ليست بداية كلمة)
  assert.equal(repairWordInitialAml('الأمل في الحياة'), 'الأمل في الحياة')
  assert.equal(repairWordInitialAml('فرصة كاملة وشاملة'), 'فرصة كاملة وشاملة')
})

test('cross-book search merges PDF results even when the text index is empty', async () => {
  const results = await searchLibrary('الغضب', { limit: 5 })
  assert.ok(Array.isArray(results))
  assert.ok(results.length > 0, 'cross-book search should return PDF-backed results')
  assert.ok(results.every((r) => r.citation && r.citation.bookId && r.citation.pageNumber != null))
})

test('numbered parser preserves pages and marks missing text for OCR', () => {
  const parsed = parseNumberedBook(`عنوان الكتاب\n----- [ صفحة 1 ] -----\n[ص1-س1] درس مهم\n----- [ صفحة 2 ] -----\n(لا يوجد نص قابل للاستخراج في هذه الصفحة - قد تكون صفحة تصميمية أو صورة)`)
  assert.equal(parsed.pages.length, 2)
  assert.deepEqual(parsed.pages[0].lineRange, { from: 1, to: 1 })
  assert.equal(parsed.pages[0].needsOcr, false)
  assert.equal(parsed.pages[1].needsOcr, true)
})

test('line ranges use the first and last numbered source line', () => {
  assert.deepEqual(pageLineRange('[ص42-س9] أ\n[ص42-س3] ب\n[ص42-س12] ج'), { from: 3, to: 12 })
})

test('book ids reject traversal and unsafe paths', () => {
  assert.throws(() => assertSafeBookId('../secret'), /INVALID_BOOK_ID/)
  assert.throws(() => assertSafeBookId('Book With Spaces'), /INVALID_BOOK_ID/)
  assert.equal(assertSafeBookId('islamic-sixth-2025'), 'islamic-sixth-2025')
})

test('imported Islamic book is available page-by-page and searchable', async () => {
  const books = await listBooks()
  const book = books.find((item) => item.id === 'islamic-sixth-preparatory-2025')
  assert.ok(book, 'Run curriculum:import before the test suite')
  assert.equal(book.year, 2025)
  const page = await openPage(book.id, 41)
  assert.match(page.content, /الغضب/)
  const results = await searchLibrary('ما أسباب الغضب وأضراره وعلاجه', { bookId: book.id, limit: 6 })
  assert.ok(results.some((result) => [41, 42, 44].includes(result.citation.pageNumber)))
  assert.ok(results.every((result) => result.citation.title && result.citation.subject))
})

test('PDF index exposes physical/printed mapping and stable provenance', async () => {
  const index = await getPdfIndex()
  assert.equal(index.schemaVersion, 2)
  const book = index.books.find((item) => (item.book?.id || item.id) === 'islamic-sixth-preparatory-2025')
  assert.ok(book)
  const page = book.pages.find((item) => (item.physicalPage || item.pageNumber) === 41)
  assert.equal(page.physicalPage, 41)
  assert.equal(page.printedPage, 41)
  assert.equal(page.ocr.required, false)
  assert.equal(page.sourceProvenance.type, 'pdf')
  const single = await locatePdfPage('islamic-sixth-preparatory-2025', 41)
  assert.equal(single.matches[0].physicalPage, 41)
  const batch = await locatePdfPages('islamic-sixth-preparatory-2025', [41, 42, 999])
  assert.deepEqual(batch.mappings.map((item) => item.printedPageNumber), [41, 42])
  assert.deepEqual(batch.notFound, [999])
})
