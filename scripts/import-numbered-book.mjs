import path from 'node:path'
import process from 'node:process'
import { importNumberedBook } from '../lib/curriculum-library.mjs'

function parseArgs(argv) {
  const result = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) { result._.push(value); continue }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) result[key] = true
    else { result[key] = next; index += 1 }
  }
  return result
}

const args = parseArgs(process.argv.slice(2))
const sourceFile = args._[0]
if (!sourceFile || !args.id || !args.title || !args.subject) {
  console.error('Usage: npm run curriculum:import -- <file.txt> --id <book-id> --title <title> --subject <subject> [--branch <branch>] [--edition <edition>] [--year <year>]')
  process.exit(1)
}

try {
  const manifest = await importNumberedBook({
    sourceFile: path.resolve(sourceFile),
    metadata: {
      id: args.id,
      title: args.title,
      subject: args.subject,
      grade: args.grade,
      branch: args.branch,
      edition: args.edition,
      year: args.year,
      provenance: args.provenance,
      licenseStatus: args.license,
      sourceUrl: args.url,
    },
  })
  console.log(JSON.stringify({
    ok: true,
    bookId: manifest.id,
    pages: manifest.pageCount,
    searchablePages: manifest.searchablePageCount,
    needsOcrPages: manifest.needsOcrPageCount,
  }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  process.exit(1)
}
