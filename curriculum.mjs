import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'

const DATA_DIR = path.join(process.cwd(), 'curriculum-data')
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
const MAX_FILE_BYTES = 60 * 1024 * 1024
const MAX_CONTEXT_CHARS = 12000

let cached = null

function normalize(value) {
  return String(value || '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ـ]/g, '')
    .toLowerCase()
}

function tokens(value) {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1)
}

function chunkText(text) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > 1500 && current) {
      chunks.push(current)
      current = ''
    }
    current += (current ? '\n\n' : '') + paragraph
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : clean.match(/.{1,1500}/gs) || []
}

async function loadIndex() {
  if (cached) return cached
  await mkdir(DATA_DIR, { recursive: true })
  try { cached = JSON.parse(await readFile(INDEX_FILE, 'utf8')) } catch { cached = { documents: [], chunks: [] } }
  return cached
}

async function saveIndex(index) {
  cached = index
  await writeFile(INDEX_FILE, JSON.stringify(index), 'utf8')
}

async function extractText(filePath, extension) {
  const buffer = await readFile(filePath)
  if (extension === '.pdf') {
    const parser = new PDFParse({ data: buffer })
    try { return (await parser.getText()).text || '' } finally { await parser.destroy() }
  }
  return buffer.toString('utf8')
}

export async function addDocument({ filePath, originalName, mime }) {
  const stat = await import('node:fs/promises').then((fs) => fs.stat(filePath))
  if (stat.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
  const extension = path.extname(originalName).toLowerCase()
  if (!['.pdf', '.txt', '.md'].includes(extension)) throw new Error('UNSUPPORTED_FILE')
  const text = await extractText(filePath, extension)
  if (text.replace(/\s/g, '').length < 20) throw new Error('NO_TEXT')
  const index = await loadIndex()
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  index.documents = index.documents.filter((doc) => doc.name !== originalName)
  index.chunks = index.chunks.filter((chunk) => chunk.documentName !== originalName)
  const chunks = chunkText(text).map((content, position) => ({ id: `${id}-${position}`, documentName: originalName, content, terms: [...new Set(tokens(content))] }))
  index.documents.push({ id, name: originalName, mime, size: stat.size, chunks: chunks.length, addedAt: new Date().toISOString() })
  index.chunks.push(...chunks)
  await saveIndex(index)
  return index.documents.at(-1)
}

export async function removeDocument(name) {
  const index = await loadIndex()
  index.documents = index.documents.filter((doc) => doc.name !== name)
  index.chunks = index.chunks.filter((chunk) => chunk.documentName !== name)
  await saveIndex(index)
}

export async function listDocuments() {
  return (await loadIndex()).documents
}

export async function searchCurriculum(query, limit = 6) {
  const queryTerms = [...new Set(tokens(query))]
  if (!queryTerms.length) return { context: '', results: [] }
  const index = await loadIndex()
  const scored = index.chunks.map((chunk) => {
    const body = normalize(chunk.content)
    const hits = queryTerms.reduce((count, term) => count + (body.includes(term) ? 1 : 0), 0)
    const phrase = normalize(query).length > 4 && body.includes(normalize(query)) ? 3 : 0
    return { chunk, score: hits + phrase }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
  let used = 0
  const results = []
  for (const item of scored) {
    const block = `\n[${item.chunk.documentName}]\n${item.chunk.content}`
    if (used + block.length > MAX_CONTEXT_CHARS) break
    used += block.length
    results.push(item.chunk)
  }
  return { context: results.length ? results.map((item) => `[${item.documentName}]\n${item.content}`).join('\n\n') : '', results }
}

export async function clearDocumentFile(filePath) {
  try { await unlink(filePath) } catch { /* formidable temporary file may already be gone */ }
}

export { MAX_FILE_BYTES }
