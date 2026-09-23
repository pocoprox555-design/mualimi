import { rebuildPdfIndex } from '../lib/pdf-curriculum.mjs'
import { rebuildDerivedIndexes, rebuildSearchIndex } from '../lib/curriculum-library.mjs'

try {
  const pdf = await rebuildPdfIndex()
  const derived = await rebuildDerivedIndexes()
  const search = await rebuildSearchIndex()
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: 2,
    pdfBooks: pdf.books.length,
    materials: derived.materials.length,
    documents: search.documentCount,
  }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exit(1)
}
