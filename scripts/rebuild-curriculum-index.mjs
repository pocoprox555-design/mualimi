import { rebuildDerivedIndexes, rebuildSearchIndex } from '../lib/curriculum-library.mjs'

try {
  const [guide, index] = await Promise.all([rebuildDerivedIndexes(), rebuildSearchIndex()])
  console.log(JSON.stringify({ ok: true, schemaVersion: 2, documents: index.documentCount, materials: guide.materials.length }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exit(1)
}
