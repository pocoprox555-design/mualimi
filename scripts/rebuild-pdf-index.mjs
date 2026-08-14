import { rebuildPdfIndex } from '../lib/pdf-curriculum.mjs'

try {
  const index = await rebuildPdfIndex()
  console.log(JSON.stringify({
    ok: true,
    books: index.books.length,
    pages: index.books.reduce((sum, book) => sum + book.pageCount, 0),
    searchablePages: index.books.reduce((sum, book) => sum + book.searchablePageCount, 0),
    generatedAt: index.generatedAt,
  }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exit(1)
}
