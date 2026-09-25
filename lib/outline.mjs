// فهارس المواد: ملف واحد لكل مادة في curriculum-library/outlines، يُقرأ عند الحاجة ويُخزَّن مؤقتاً.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, normalizeAr } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTLINES_DIR = path.join(ROOT, 'curriculum-library', 'outlines');
const MARKER = '## التفاصيل صفحة بصفحة';
const ENTRY = /^### الصفحة الفيزيائية (\d+)(?: — المطبوعة (\S+))?/gm;

let idsPromise;
const cache = new Map();

const safeId = (bookId) => /^[a-z0-9][a-z0-9-]{1,80}$/i.test(String(bookId || ''));

const STRUCTURE_PATTERNS = [
  // عدّ: كم فصلا / عدد الدروس / كم صفحة ...
  /(كم|عدد|عده)[^؟?]{0,30}(فصول|وحدات|دروس|تمارين|اسئله|صفحات|فصلا|وحده|درسا|تمرين|سؤال|صفحة|فصل)/,
  // فهرس أو محتويات بشكل مباشر
  /(فهرس|فهره|محتويات)/,
  // بنية/خطة الكتاب
  /(خطة|خطه|بنيه|بنية|مخطط|توزيع)/,
  // ماذا يحوي الكتاب
  /(وش|ماذا|اشرح|لخص|اوجز)[^؟?]{0,20}(يحتوي|تحتوي|الكتاب|الماده|المنهج)/,
];

// نية السؤال: هل يسأل عن بنية المادة وعدد أقسامها بدل سؤال معرفي محدد؟
export function structureIntent(query) {
  const text = normalizeAr(query);
  if (!text) return false;
  return STRUCTURE_PATTERNS.some((pattern) => pattern.test(text));
}

export async function listOutlineIds() {
  if (!idsPromise) {
    idsPromise = readdir(OUTLINES_DIR, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name.slice(0, -3)))
      .catch(() => []);
  }
  return idsPromise;
}

export async function getOutline(bookId) {
  if (!safeId(bookId)) return null;
  if (cache.has(bookId)) return cache.get(bookId);
  if (!(await listOutlineIds()).includes(bookId)) return null;

  let outline = null;
  try {
    const raw = await readFile(path.join(OUTLINES_DIR, `${bookId}.md`), 'utf8');
    const cut = raw.indexOf(MARKER);
    const header = (cut > 0 ? raw.slice(0, cut) : raw).trim();
    const pages = [];
    const scanner = new RegExp(ENTRY.source, 'gm');
    let match;
    while ((match = scanner.exec(raw))) {
      const start = scanner.lastIndex;
      const next = raw.indexOf('\n### الصفحة الفيزيائية ', start);
      const block = raw.slice(start, next < 0 ? raw.length : next);
      const type = cleanText((block.match(/^\- \*\*النوع\*\*:\s*(.+)$/) || [])[1] || '').slice(0, 60);
      const title = cleanText((block.match(/^\- \*\*العنوان الرسمي\*\*:\s*(.+)$/) || [])[1] || '').replace(/\s+/g, ' ').slice(0, 90);
      pages.push({ physicalPage: Number(match[1]), printedPage: match[2] || '', type, title });
    }
    outline = { bookId, header, pages, entries: pages.length };
  } catch {
    return null;
  }
  cache.set(bookId, outline);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return outline;
}

function digest(outline, max = 2600) {
  const lines = [];
  let used = 0;
  for (const page of outline.pages) {
    const label = `ص${page.physicalPage}${page.printedPage && page.printedPage !== String(page.physicalPage) ? ` (مطبوع ${page.printedPage})` : ''}: ${page.title || page.type || 'صفحة'}`;
    if (used + label.length > max) break;
    lines.push(`- ${label}`);
    used += label.length + 1;
  }
  return lines.join('\n');
}

// الكتلة التي تُحقن في الـsystem prompt: ترويسة الفهرس دائماً، وخريطة الصفحات عند سؤال البنية.
export function outlineContext(outline, { structure = false } = {}) {
  if (!outline) return '';
  const head = outline.header.slice(0, 4200);
  if (!structure || !outline.pages.length) return head;
  return `${head}\n\n## خريطة الصفحات (تختصراً)\n${digest(outline)}`;
}
