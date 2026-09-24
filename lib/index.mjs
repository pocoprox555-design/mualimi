// الفهرس في الذاكرة: يُحمّل مرة واحدة، البحث فوري (<10ms).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeAr, tokens } from './text.mjs';

let cache = null;
let bookCache = new Map(); // LRU صغير للنص الكامل

const FAST = path.join(process.cwd(), 'curriculum-library', 'fast-index.json');
const BOOKS_DIR = path.join(process.cwd(), 'curriculum-library', 'pdf-books');

export async function getIndex() {
  if (cache) return cache;
  const raw = JSON.parse(await readFile(FAST, 'utf8'));
  // مجموعة توكنز جاهزة لكل صفحة لسرعة المطابقة
  for (const p of raw.pages) p._tok = new Set(p.n.split(' ').filter((w) => w.length >= 2));
  cache = raw;
  return cache;
}

export async function listBooks() {
  const idx = await getIndex();
  return idx.books;
}

// بحث فوري: تداخل التوكنز + مكافأة العبارة + ترجيح العنوان
export async function search(query, { bookId = null, subject = null, limit = 6 } = {}) {
  const idx = await getIndex();
  const q = normalizeAr(query);
  const qt = [...new Set(tokens(query))];
  if (!qt.length) return [];
  const out = [];
  for (const p of idx.pages) {
    if (bookId && p.b !== bookId) continue;
    let s = 0;
    for (const t of qt) if (p._tok.has(t)) s += t.length >= 4 ? 2 : 1;
    if (!s) continue;
    if (p.n.includes(q) && q.length > 4) s += 4;
    if (p.t && normalizeAr(p.t).split(' ').some((w) => qt.includes(w))) s += 2;
    const book = idx.books.find((b) => b.id === p.b);
    if (subject && book && normalizeAr(book.subject).includes(normalizeAr(subject))) s += 2;
    out.push({ s, p, book });
  }
  return out
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(1, Math.min(12, limit)))
    .map(({ s, p, book }) => ({
      score: s,
      bookId: p.b,
      title: book?.title || p.b,
      subject: book?.subject || '',
      phys: p.phys,
      printed: p.pr,
      pageTitle: p.t,
      explanation: p.s,
      preview: p.p,
    }));
}

// مطبوع → فيزيائي: فوري من الخريطة
export async function locate(bookId, printedNum) {
  const idx = await getIndex();
  const phys = idx.printed?.[bookId]?.[String(printedNum).trim()];
  return phys != null ? Number(phys) : null;
}

// النص الكامل لصفحة: من ملف الكتاب (تخزين مؤقت لآخر 3 كتب).
// الصفحات المصورة بلا نص تُرجع الشرح المبسط + needsVision بدل الفشل الصامت.
export async function fullPage(bookId, phys) {
  let book = bookCache.get(bookId);
  if (!book) {
    book = JSON.parse(await readFile(path.join(BOOKS_DIR, `${bookId}.json`), 'utf8'));
    bookCache.set(bookId, book);
    if (bookCache.size > 3) bookCache.delete(bookCache.keys().next().value);
  }
  const page = (book.pages || []).find((p) => (p.physicalPage || p.pageNumber) === Number(phys));
  if (!page) throw new Error('PAGE_NOT_FOUND');
  const text = (page.fullText || '').trim();
  if (text) return { text, title: page.title || '', searchable: true, needsVision: false };
  const idx = await getIndex();
  const fast = idx.pages.find((p) => p.b === bookId && p.phys === Number(phys));
  return {
    text: fast ? `${fast.t}\n${fast.s}` : '',
    title: page.title || fast?.t || '',
    searchable: false,
    needsVision: true,
  };
}
