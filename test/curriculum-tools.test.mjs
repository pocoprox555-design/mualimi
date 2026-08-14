import test from 'node:test'
import assert from 'node:assert/strict'
import { adjacent, inspectBook, listBookSections, listMaterials, openAdjacentPages, openPage, readBookGuide, searchMaterials } from '../lib/curriculum-library.mjs'
import { createCurriculumTools, curriculumToolDefinitions } from '../lib/curriculum-tools.mjs'

test('curriculum material and section helpers are deterministic', async () => {
  const materialsA = await listMaterials()
  const materialsB = await listMaterials()
  assert.deepEqual(materialsA, materialsB)
  assert.ok(Array.isArray(materialsA))
})

test('inspectBook, listBookSections, and adjacent pages stay aligned', async () => {
  const bookId = 'islamic-sixth-preparatory-2025'
  const book = await inspectBook(bookId)
  assert.equal(book.book.id, bookId)
  const sections = await listBookSections(bookId)
  assert.equal(sections.bookId, bookId)
  assert.ok(sections.sections.length > 0)
  const page = await openPage(bookId, 41)
  assert.ok(page.content.length > 0)
  const neighbors = await openAdjacentPages(bookId, 41, 1)
  assert.ok(neighbors.length >= 1)
  assert.deepEqual(await adjacent(bookId, 41, 1), neighbors)
})

test('searchMaterials returns stable metadata matches', async () => {
  const matches = await searchMaterials('الإسلامية', { limit: 5 })
  assert.ok(Array.isArray(matches))
  assert.ok(matches.every((item) => item.title && item.subject))
})

test('book guide explains page 41 and curriculum tools track opened citations', async () => {
  const bookId = 'islamic-sixth-preparatory-2025'
  const guide = await readBookGuide(bookId, { cursor: 40, limit: 4 })
  const page41 = guide.pages.find((page) => page.pageNumber === 41)
  assert.ok(page41)
  assert.equal(page41.title, 'النهي عن الغضب: تعريفه وخطره')
  assert.match(page41.summary, /الوصية النبوية.*لا تغضب/)
  assert.equal(page41.kind, 'ethics_start')
  assert.equal(page41.reviewed, true)

  const tools = createCurriculumTools()
  assert.ok(curriculumToolDefinitions.some((tool) => tool.function.name === 'read_book_guide'))
  await tools.handlers.open_page({ bookId, pageNumber: 41 })
  assert.equal(tools.openedCitations.get(`${bookId}:41`).pageNumber, 41)
})
