import { rebuildDerivedIndexes, rebuildSearchIndex } from '../lib/curriculum-library.mjs'

try {
  const [index, guide] = await Promise.all([rebuildSearchIndex(), rebuildDerivedIndexes()])
  console.log(JSON.stringify({ ok: true, documents: index.documentCount, materials: guide.materials.length, generatedAt: index.generatedAt }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exit(1)
}
