import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import { arabicTokens, cleanArabicText, normalizeArabic } from './lib/arabic-text.mjs'

const DATA_DIR = path.resolve(process.env.CURRICULUM_DATA_DIR || path.join(process.cwd(), 'curriculum-data'))
const INDEX_FILE = path.join(DATA_DIR, 'index.json')
const MAX_FILE_BYTES = 60 * 1024 * 1024
const MAX_CONTEXT_CHARS = 24_000
const INDEX_SCHEMA_VERSION = 2

let cached = null

function digest(value) { return createHash('sha256').update(value).digest('hex') }

function tokens(value) { return [...new Set(arabicTokens(value))] }

function chunkText(text) {
  const clean = cleanArabicText(text)
  const paragraphs = clean.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > 1_800) {
      chunks.push(current)
      current = ''
    }
    current += `${current ? '\n\n' : ''}${paragraph}`
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : clean.match(/.{1,1800}/gs) || []
}

async function loadIndex() {
  if (cached) return cached
  await mkdir(DATA_DIR, { recursive: true })
  try {
    const parsed = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
    cached = parsed.schemaVersion === INDEX_SCHEMA_VERSION ? parsed : { schemaVersion: INDEX_SCHEMA_VERSION, documents: [], chunks: [] }
  } catch { cached = { schemaVersion: INDEX_SCHEMA_VERSION, documents: [], chunks: [] } }
  return cached
}

async function saveIndex(index) {
  cached = index
  await mkdir(DATA_DIR, { recursive: true })
  const temporary = `${INDEX_FILE}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(temporary, INDEX_FILE)
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
  const info = await stat(filePath)
  if (info.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
  const name = String(originalName || '').trim().slice(0, 180)
  const extension = path.extname(name).toLowerCase()
  if (!name || !['.pdf', '.txt', '.md'].includes(extension)) throw new Error('UNSUPPORTED_FILE')
  const text = await extractText(filePath, extension)
  if (text.replace(/\s/g, '').length < 20) throw new Error('NO_TEXT')

  const index = await loadIndex()
  const sourceHash = digest(await readFile(filePath))
  const id = `upload_${sourceHash.slice(0, 20)}`
  const chunks = chunkText(text).map((content, position) => ({
    id: `${id}_${position + 1}`,
    documentId: id,
    documentName: name,
    content,
    terms: tokens(content),
    sourceProvenance: { type: 'uploaded-material', name, authority: 'supporting-reference' },
  }))
  index.documents = (index.documents || []).filter((document) => document.name !== name)
  index.chunks = (index.chunks || []).filter((chunk) => chunk.documentName !== name)
  const document = {
    id,
    name,
    mime: String(mime || 'application/octet-stream').slice(0, 120),
    size: info.size,
    checksum: sourceHash,
    chunks: chunks.length,
    sourceProvenance: { type: 'uploaded-material', name, authority: 'supporting-reference' },
  }
  index.documents.push(document)
  index.chunks.push(...chunks)
  index.documents.sort((a, b) => a.name.localeCompare(b.name, 'ar'))
  await saveIndex(index)
  return document
}

export async function removeDocument(name) {
  const index = await loadIndex()
  const value = String(name || '')
  index.documents = (index.documents || []).filter((document) => document.name !== value)
  index.chunks = (index.chunks || []).filter((chunk) => chunk.documentName !== value)
  await saveIndex(index)
}

export async function listDocuments() { return (await loadIndex()).documents || [] }

export async function searchCurriculum(query, limit = 6) {
  const normalizedQuery = normalizeArabic(query)
  const queryTerms = tokens(query)
  if (!queryTerms.length) return { context: '', results: [] }
  const index = await loadIndex()
  const ranked = (index.chunks || []).map((chunk) => {
    const body = normalizeArabic(chunk.content)
    const hits = queryTerms.reduce((count, term) => count + (body.includes(term) ? 1 : 0), 0)
    const phrase = normalizedQuery.length > 4 && body.includes(normalizedQuery) ? 3 : 0
    return { chunk, score: hits + phrase }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 6)))

  let used = 0
  const results = []
  for (const { chunk, score } of ranked) {
    const block = `\n[${chunk.documentName}]\n${chunk.content}`
    if (used + block.length > MAX_CONTEXT_CHARS) break
    used += block.length
    results.push({ ...chunk, score: Number(score.toFixed(4)) })
  }
  return {
    context: results.map((result) => `[${result.documentName}]\n${result.content}`).join('\n\n'),
    results,
  }
}

export async function clearDocumentFile(filePath) {
  try { await unlink(filePath) } catch { /* الملف المؤقت قد يكون حُذف بعد انتهاء multipart */ }
}

export { MAX_FILE_BYTES }
