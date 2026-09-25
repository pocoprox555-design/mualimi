// فهارس المواد: ملف واحد لكل مادة في curriculum-library/outlines، يُقرأ عند الحاجة ويُخزَّن مؤقتاً.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, normalizeAr } from './text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTLINES_DIR = path.join(ROOT, 'curriculum-library', 'outlines');
const MARKER = '## التفاصيل صفحة بصفحة';
const ENTRY = /^### الصفحة الفيزيائية (\d+)[^\n]*$/gm;

const CATALOG_PATTERNS = [
  /(?:ماهي|ما|وش|شنو|شن|ايش|ماذا)\s+(?:هي\s+)?(?:المواد|الكتب)(?:\s|$|[؟?])/,
  /(?:عندك|عندكم|لديك|لدينا|يوجد|توجد|متاحه|متوفره|موجوده)[^؟?]{0,24}(?:المواد|ماده|مواد|الكتب|كتب)(?:\s|$|[؟?])/,
  /(?:المواد|ماده|مواد|الكتب|كتب)[^؟?]{0,24}(?:عندك|عندكم|لديك|لدينا|متاحه|متوفره|موجوده|في مكتبتك)/,
  /(?:كل|جميع|قايمه|قائمه)\s+(?:المواد|ماده|مواد|الكتب|كتب)(?:\s|$|[؟?])/,
];

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

// كشف سؤال الجرد يُستخدم فقط لاختيار البديل المحلي عند غياب النموذج.
// أما مع وجود النموذج فالكتالوج الكامل يُرسل له دائما وهو وحده المتحكم الذي يفهم النية ويجيب.
export function catalogIntent(query) {
  const text = normalizeAr(query);
  if (!text) return false;
  return CATALOG_PATTERNS.some((pattern) => pattern.test(text));
}

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
      const heading = match[0];
      const printed = heading.match(/—\s*المطبوعة\s*:?\s*([٠-٩0-9]+)/);
      const field = (label) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const value = block.match(new RegExp(`^- \\*\\*${escaped}\\*\\*:\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n### |$)`, 'm'))?.[1] || '';
        return cleanText(value).replace(/\s+/g, ' ').trim();
      };
      const type = field('النوع').slice(0, 60);
      const title = field('العنوان الرسمي').slice(0, 140);
      const details = [
        ['المحتوى', field('المحتوى')],
        ['التمارين والأسئلة', field('التمارين والأسئلة')],
        ['التمارين', field('التمارين')],
        ['الفعاليات والأحداث', field('الفعاليات والأحداث')],
        ['الأهداف', field('الأهداف')],
        ['ملاحظة للاستخدام', field('ملاحظة للاستخدام')],
      ]
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
      const description = cleanText([title && `العنوان: ${title}`, type && `النوع: ${type}`, details].filter(Boolean).join('\n')).slice(0, 2_200);
      pages.push({
        physicalPage: Number(match[1]),
        printedPage: printed ? printed[1] : '',
        type,
        title,
        description,
      });
    }
    outline = { bookId, header, pages, entries: pages.length };
  } catch {
    return null;
  }
  cache.set(bookId, outline);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return outline;
}

function digest(outline, max = 60_000) {
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
