import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const PDF_INDEX = path.join(LIBRARY, 'pdf-index.json');
const PATCH_DIR = path.join(LIBRARY, 'reports', 'patches');

const FIELDS = ['title', 'summary', 'section', 'unit', 'educationalPurpose', 'pageType'];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanBlock(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let patchFiles = [];
try {
  patchFiles = (await readdir(PATCH_DIR)).filter((name) => name.endsWith('.json')).sort();
} catch {
  console.log('لا يوجد مجلد ترقيعات.');
  process.exit(0);
}
if (!patchFiles.length) { console.log('لا توجد ترقيعات.'); process.exit(0); }

const bookCache = new Map();
const bookFile = (bookId) => path.join(BOOKS_DIR, `${bookId}.json`);
async function loadBook(bookId) {
  if (!bookCache.has(bookId)) {
    bookCache.set(bookId, JSON.parse(await readFile(bookFile(bookId), 'utf8')));
  }
  return bookCache.get(bookId);
}

let applied = 0;
const missing = [];
const errors = [];

for (const name of patchFiles) {
  const raw = JSON.parse(await readFile(path.join(PATCH_DIR, name), 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.patches || [];
  for (const entry of entries) {
    const bookId = String(entry.bookId || '').trim();
    const physicalPage = Number(entry.physicalPage);
    if (!bookId || !physicalPage) { errors.push(`${name}: سجل بلا bookId أو physicalPage`); continue; }
    let book;
    try { book = await loadBook(bookId); } catch (error) { errors.push(`${name}: تعذر فتح ${bookId}`); continue; }
    const page = book.pages.find((item) => Number(item.physicalPage) === physicalPage);
    if (!page) { missing.push(`${bookId}:${physicalPage}`); continue; }

    for (const field of FIELDS) {
      if (entry[field] === undefined) continue;
      const value = clean(entry[field]);
      if (value) page[field] = field === 'title' ? value.slice(0, 140) : field === 'summary' ? value.slice(0, 600) : value.slice(0, 200);
    }
    if (entry.fullText !== undefined) {
      const text = cleanBlock(entry.fullText);
      const hasText = text.replace(/\s+/g, '').length >= 5;
      page.fullText = text;
      page.searchable = hasText;
      page.needsOcr = !hasText;
      page.ocr = {
        required: !hasText,
        status: hasText ? (page.ocr?.status && page.ocr.status !== 'needed' ? page.ocr.status : 'completed') : 'no-text',
        engine: entry.vision ? 'agent-vision' : page.ocr?.engine || 'vision',
        model: entry.model || page.ocr?.model || 'mimo-v2.6-flash',
        at: new Date().toISOString(),
        parser: 'patch',
      };
    }
    if (entry.note) {
      page.reviewNotes = String(entry.note).slice(0, 400);
      page.reviewed = true;
    }
    applied += 1;
  }
}

if (!applied) {
  console.log('لا ترقيعات صالحة للتطبيق.');
  if (missing.length) console.log(`صفحات غير موجودة: ${missing.join(', ')}`);
  process.exit(missing.length || errors.length ? 1 : 0);
}

await mkdir(PATCH_DIR, { recursive: true });
for (const [bookId, book] of bookCache) {
  const file = bookFile(bookId);
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(book)}\n`);
  await rename(temp, file);
  const searchable = book.pages.filter((page) => page.fullText).length;
  console.log(`${bookId}: ${book.pages.length} صفحة · ${searchable} قابلة للبحث`);
}

const index = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
index.books = index.books.map((entry) => {
  const fresh = bookCache.get(entry.id);
  if (!fresh) return entry;
  const copy = { ...fresh };
  delete copy.schemaVersion;
  return copy;
});
const tempIndex = `${PDF_INDEX}.tmp`;
await writeFile(tempIndex, `${JSON.stringify(index)}\n`);
await rename(tempIndex, PDF_INDEX);

const totalSearchable = [...bookCache.values()].reduce((sum, book) => sum + book.pages.filter((page) => page.fullText).length, 0);
console.log(`\nطُبّق ${applied} ترقيع · ${totalSearchable} صفحة قابلة للبحث في الكتب المعدّلة · pdf-index محدّث`);
if (missing.length) console.log(`صفحات مفقودة: ${missing.join(', ')}`);
for (const error of errors) console.log(`خطأ: ${error}`);
if (missing.length || errors.length) process.exitCode = 1;
