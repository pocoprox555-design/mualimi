import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D, DOMMatrix, ImageData } from '@napi-rs/canvas';

globalThis.Path2D ||= Path2D;
globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const SOURCES_DIR = path.join(LIBRARY, 'pdf-sources');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return fallback;
  const found = args[index];
  if (found.includes('=')) return found.slice(found.indexOf('=') + 1);
  const next = args[index + 1];
  if (next && !next.startsWith('--')) return next;
  return true;
}

const bookId = flag('book', null);
const pageNumber = Number(flag('page', 0));
const scale = Number(flag('scale', 2)) || 2;
const out = flag('out', path.join(ROOT, 'page-export.png'));

if (!bookId || !pageNumber) {
  console.error('الاستخدام: node scripts/export-page-image.mjs --book <bookId> --page <physicalPage> [--out file.png] [--scale 2]');
  process.exit(1);
}

const book = JSON.parse(await readFile(path.join(BOOKS_DIR, `${bookId}.json`), 'utf8'));
const pageRecord = book.pages.find((entry) => Number(entry.physicalPage) === pageNumber);
if (!pageRecord) {
  console.error(`لا توجد صفحة ${pageNumber} في الكتاب ${bookId}`);
  process.exit(1);
}
const pdfName = book.source?.fileName || pageRecord.sourceProvenance?.fileName;
if (!pdfName) { console.error('لا يوجد ملف PDF مسجل لهذا الكتاب'); process.exit(1); }

class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height));
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const canvasFactory = new NapiCanvasFactory();
const data = new Uint8Array(await readFile(path.join(SOURCES_DIR, pdfName)));
const doc = await pdfjs.getDocument({ data, canvasFactory, isEvalSupported: false, verbosity: 0 }).promise;
const page = await doc.getPage(pageNumber);
const viewport = page.getViewport({ scale });
const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
context.fillStyle = '#ffffff';
context.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
const png = Buffer.from(await canvas.encode('png'));
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, png);
await doc.destroy().catch(() => {});
console.log(`${out} ${canvas.width}x${canvas.height} ${png.length} bytes`);
