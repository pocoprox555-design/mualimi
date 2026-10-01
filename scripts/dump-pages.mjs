import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS_DIR = path.join(ROOT, 'curriculum-library', 'pdf-books');

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
const withText = Boolean(flag('text', false));
const textChars = Number(flag('chars', 400)) || 400;
const only = flag('pages', null);

if (!bookId) {
  console.error('الاستخدام: node scripts/dump-pages.mjs --book <bookId> [--text] [--chars 400] [--pages 3,7,9]');
  process.exit(1);
}

const book = JSON.parse(await readFile(path.join(BOOKS_DIR, `${bookId}.json`), 'utf8'));
const wanted = only ? new Set(String(only).split(',').map((value) => Number(value))) : null;

console.log(`# ${book.title} · ${book.pages.length} صفحة · searchable=${book.pages.filter((page) => page.fullText).length}`);
for (const page of book.pages) {
  if (wanted && !wanted.has(Number(page.physicalPage))) continue;
  const text = String(page.fullText || '').replace(/\s+/g, ' ').trim();
  const flags = [
    text.length >= 40 ? `text=${text.length}` : `NO_TEXT(${text.length})`,
    page.needsOcr ? 'needsOcr' : '',
    page.ocr?.status ? `ocr=${page.ocr.status}` : '',
  ].filter(Boolean).join(' ');
  console.log(`\n[صفحة ${page.physicalPage}] مطبوع=${page.printedPage ?? 'null'} · ${flags} · pageType=${page.pageType || '-'}`);
  console.log(`  title   : ${page.title || '-'}`);
  console.log(`  summary : ${page.summary || '-'}`);
  console.log(`  section : ${page.section || '-'} | unit: ${page.unit || '-'}`);
  console.log(`  purpose : ${page.educationalPurpose || '-'}`);
  if (withText && text) console.log(`  text    : ${text.slice(0, textChars)}`);
}
