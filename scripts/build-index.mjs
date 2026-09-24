// توليد الفهرس الخفيف: عنوان + شرح مبسط + كلمات مفتاحية + خريطة مطبوع→فيزيائي.
// التشغيل: node scripts/build-index.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanText, normalizeAr, topKeywords } from '../lib/text.mjs';

const ROOT = process.cwd();
const PDF_INDEX = path.join(ROOT, 'curriculum-library', 'pdf-index.json');
const OUT = path.join(ROOT, 'curriculum-library', 'fast-index.json');

function explanationFor(page) {
  const s = cleanText(page.summary || '');
  // الملخصات المراجعة جاهزة — نعتمدها إذا كانت تشرح فعلاً.
  if (s.length >= 40 && !/indb/i.test(s)) return s.slice(0, 280);
  const text = cleanText(page.fullText || '');
  if (!text) return 'صفحة مصورة تحتاج قراءة بصرية؛ لا يوجد نص مستخرج منها.';
  const sents = text.replace(/\n+/g, ' ').split(/(?<=[.!؟?])\s+/).map((x) => x.trim()).filter((x) => x.length > 25 && !/indb|IRAQ_G12/i.test(x));
  const head = cleanText(page.title || '').slice(0, 100);
  const body = sents.slice(0, 2).join(' ').slice(0, 220);
  return [head && `تتناول: ${head}.`, body].filter(Boolean).join(' ').slice(0, 280) || 'محتوى تعليمي من الكتاب المدرسي.';
}

function titleFor(page) {
  const t = cleanText(page.title || '');
  if (t && t.length > 3 && !/indb/i.test(t)) return t.slice(0, 100);
  const lines = cleanText(page.fullText || '').split('\n').map((x) => x.trim()).filter((x) => x.length > 4 && x.length <= 90 && !/indb|IRAQ_G12/i.test(x));
  return (lines[0] || 'صفحة تعليمية').slice(0, 100);
}

const raw = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
const books = [];
const pages = [];
const printed = {};

for (const b of raw.books || []) {
  books.push({
    id: b.id, title: b.title, subject: b.subject, branch: b.branch || 'عام',
    grade: b.grade || 'السادس الإعدادي', year: b.year || 2025,
    pageCount: b.pageCount || (b.pages || []).length,
    kind: b.referenceKind || 'official-textbook',
  });
  printed[b.id] = {};
  for (const p of b.pages || []) {
    const phys = p.physicalPage || p.pageNumber;
    const pr = p.printedPage ?? p.printedPageNumber ?? null;
    if (Number.isInteger(pr)) printed[b.id][pr] = phys;
    const title = titleFor(p);
    const expl = explanationFor(p);
    const preview = cleanText(p.fullText || '').slice(0, 500);
    pages.push({
      b: b.id,
      phys,
      pr,
      t: title,
      s: expl,
      k: topKeywords(`${title} ${expl} ${preview}`.slice(0, 1200)),
      p: preview,
      n: normalizeAr(`${b.title} ${b.subject} ${title} ${expl} ${preview.slice(0, 300)}`).slice(0, 900),
    });
  }
}

await writeFile(OUT, JSON.stringify({ version: 1, builtAt: new Date().toISOString(), books, pages, printed }) + '\n');
const withPr = pages.filter((p) => p.pr != null).length;
console.log(`fast-index: ${books.length} books, ${pages.length} pages, ${withPr} with printed numbers -> ${OUT}`);
