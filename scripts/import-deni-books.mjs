// Import official sixth-grade Islamic education PDFs into the searchable curriculum.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCES = path.join(LIBRARY, 'pdf-sources');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const OUTLINES_DIR = path.join(LIBRARY, 'outlines');
const INDEX_FILE = path.join(LIBRARY, 'pdf-index.json');
const CJK = /[\u3400-\u9fff]/u;

const BOOKS = [
  {
    file: 'كتاب مباحث القراءات القرانية السادس الاعدادي.pdf',
    id: 'quran-readings-deni-sixth',
    title: 'مباحث القراءات القرآنية — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'القرآن وعلومه — مباحث القراءات',
    edition: '1445هـ — 2023م', year: 2023,
    url: 'http://taleemdeny.edu.iq/images/books/%20مباحث القراءات القرانية الصف السادس.pdf',
    expectedPages: 63,
  },
  {
    file: 'كتاب الفقه السادس الاعدادي.pdf',
    id: 'fiqh-shafii-deni-sixth',
    title: 'الفقه الإسلامي — كتاب الطالب — الصف السادس الإعدادي الإسلامي (الشافعي)',
    subject: 'الفقه الشافعي',
    edition: 'السادس الإعدادي الإسلامي', year: null,
    url: 'http://taleemdeny.edu.iq/images/books/%20الفقه الشافعي الصف السادس.pdf',
    expectedPages: 106,
  },
  {
    file: 'كتاب الفقه الحنفي السادس الاعدادي.pdf',
    id: 'fiqh-hanafi-deni-sixth',
    title: 'الحدود والجنايات والأيمان والنذر في الفقه الحنفي — الصف السادس',
    subject: 'الفقه الحنفي (إضافي)',
    edition: 'الطبعة الأولى 1436هـ — 2015م', year: 2015,
    url: 'http://taleemdeny.edu.iq/images/books/%20الفقه الحنفي الصف السادس.pdf',
    expectedPages: 45,
  },
  {
    file: 'كتاب التاريخ والسيرة السادس الاعدادي.pdf',
    id: 'history-deni-sixth',
    title: 'تاريخ العالم الإسلامي الحديث والمعاصر — الصف السادس الإعدادي الإسلامي',
    subject: 'التاريخ والسيرة (التعليم الديني)',
    edition: 'الطبعة الثالثة 1442هـ — 2020م', year: 2020,
    url: 'http://taleemdeny.edu.iq/images/books/%20تاريخ العالم الاسلامي الصف السادس.pdf',
    expectedPages: 140,
  },
  {
    file: 'كتاب النحو والتطبيق السادس الاعدادي.pdf',
    id: 'arabic-grammar-deni-sixth',
    title: 'النحو الواضح في قواعد اللغة العربية — الصف السادس الإعدادي الإسلامي',
    subject: 'النحو والتطبيق (التعليم الديني)',
    edition: 'الطبعة الرابعة 1442هـ — 2020م', year: 2020,
    url: 'http://taleemdeny.edu.iq/images/books/%20النحو الواضح الصف السادس.pdf',
    expectedPages: 105,
  },
  {
    file: 'كتاب البلاغة السادس الاعدادي.pdf',
    id: 'balagha-deni-sixth',
    title: 'البلاغة العربية — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'البلاغة (التعليم الديني)',
    edition: '1445هـ — 2023م', year: 2023,
    url: 'http://taleemdeny.edu.iq/images/books/%20البلاغة العربية الصف السادس.pdf',
    expectedPages: 59,
  },
  {
    file: 'كتاب اللغة الانكليزية السادس الاعدادي.pdf',
    id: 'english-deni-sixth',
    title: "English Course for Iraqi Islamic Schools — Student's Book (6)",
    subject: 'اللغة الإنكليزية (التعليم الديني)',
    edition: '2015 Edition', year: 2015,
    url: 'http://taleemdeny.edu.iq/images/books/%20اللغة الانكليزية الصف السادس.pdf',
    expectedPages: 129,
  },
  {
    file: 'كتاب الرياضيات السادس الاعدادي.pdf',
    id: 'mathematics-deni-sixth',
    title: 'الرياضيات للصف السادس الثانوي — ديوان الوقف السني',
    subject: 'الرياضيات (التعليم الديني)',
    edition: 'الطبعة السابعة 2019م', year: 2019,
    url: 'http://taleemdeny.edu.iq/images/books/%20الرياضيات الصف السادس.pdf',
    expectedPages: 80,
  },
  {
    file: 'كتاب الحديث السادس الاعدادي.pdf',
    id: 'hadith-deni-sixth',
    title: 'الحديث النبوي الشريف وعلومه — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'الحديث (التعليم الديني)',
    edition: 'الصف السادس الإعدادي الإسلامي', year: null,
    url: 'http://taleemdeny.edu.iq/images/books/%20الحديث الصف السادس.pdf',
    expectedPages: 159,
  },
];

function clean(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

function extractPageText(items) {
  const lines = [];
  let line = '';
  for (const item of items) {
    const part = String(item.str || '').trim();
    if (part) line += `${line ? ' ' : ''}${part}`;
    if (item.hasEOL && line) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);
  return lines.join('\n').trim();
}

function titleFor(text, bookTitle, pageNumber) {
  const line = clean(text.split('\n').find((value) => value.trim().length > 8) || '');
  if (line && !/^\d{1,4}$/.test(line)) return line.slice(0, 140);
  return line ? `صفحة ${pageNumber} — ${line}`.slice(0, 140) : `صفحة مصورة من ${bookTitle}`;
}

function printedPageFor(spec, physicalPage) {
  const offsets = {
    'quran-readings-deni-sixth': { first: 6, offset: -4 },
    'fiqh-shafii-deni-sixth': { first: 6, offset: -4 },
    'history-deni-sixth': { first: 1, offset: 0 },
    'arabic-grammar-deni-sixth': { first: 5, offset: 0 },
    'balagha-deni-sixth': { first: 6, offset: -4 },
    'english-deni-sixth': { first: 6, offset: 0 },
    'mathematics-deni-sixth': { first: 1, offset: 0 },
    'hadith-deni-sixth': { first: 7, offset: -5 },
  }[spec.id];
  if (!offsets || physicalPage < offsets.first) return null;
  return physicalPage + offsets.offset;
}

function outlineFor(book, pages) {
  const lines = [
    `# فهرس مادة: ${book.subject}`,
    '',
    `- **الكتاب**: ${book.title}`,
    '- **المرحلة**: السادس الإعدادي الإسلامي — ديوان الوقف السني',
    `- **عدد صفحات PDF**: ${pages.length}`,
    `- **الطبعة المسجلة**: ${book.edition || 'غير ظاهرة في بيانات الغلاف'}`,
    '- **قاعدة الدقة**: النص المستخرج من PDF دليل نصي؛ الصفحات المصورة بلا نص لا يجوز اقتباس محتواها.',
    '',
    '## التفاصيل صفحة بصفحة',
  ];
  for (const page of pages) {
    const title = page.title || 'صفحة مصورة تحتاج قراءة بصرية';
    const detail = page.fullText
      ? `مقتطف فهرسي من النص المستخرج: ${clean(page.fullText).slice(0, 500)}`
      : 'لا يتوفر نص قابل للاستخراج من هذه الصفحة؛ تحتاج قراءة بصرية قبل الإجابة عن تفاصيلها.';
    lines.push(
      '',
      `### الصفحة الفيزيائية ${page.physicalPage}`,
      `- **النوع**: ${page.searchable ? 'نص مستخرج من PDF' : 'صفحة مصورة'}`,
      `- **العنوان الرسمي**: ${title}`,
      `- **المحتوى**: ${detail}`,
      `- **ملاحظة للاستخدام**: ${page.searchable ? 'يمكن الاستشهاد بالنص المستخرج بعد فحص موضعه.' : 'لا تنسب إليها نصًا أو حكمًا أو رقمًا قبل القراءة البصرية.'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

await mkdir(BOOKS_DIR, { recursive: true });
await mkdir(OUTLINES_DIR, { recursive: true });
const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'));
const known = new Set(index.books.map((book) => book.id));
let importedBooks = 0;
let updatedMetadata = false;
let totalPages = 0;
let searchablePages = 0;

for (const spec of BOOKS) {
  if (known.has(spec.id)) {
    if (spec.id === 'fiqh-hanafi-deni-sixth') {
      const bookFile = path.join(BOOKS_DIR, `${spec.id}.json`);
      const book = JSON.parse(await readFile(bookFile, 'utf8'));
      const entry = index.books.find((candidate) => candidate.id === spec.id);
      if (book.track !== 'ديني إضافي' || !book.supplementary || entry?.track !== 'ديني إضافي') {
        book.track = 'ديني إضافي';
        book.supplementary = true;
        if (entry) { entry.track = book.track; entry.supplementary = true; }
        await writeFile(bookFile, `${JSON.stringify(book)}\n`);
        updatedMetadata = true;
      }
    }
    console.log(`موجود مسبقًا: ${spec.id}`);
    continue;
  }
  const filePath = path.join(SOURCES, spec.file);
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`ملف PDF غير صالح: ${spec.file}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const source = {
    type: 'pdf', fileName: spec.file, bytes: bytes.length, checksum, authoritative: true, url: spec.url,
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  if (doc.numPages !== spec.expectedPages) throw new Error(`عدد صفحات غير متوقع لـ ${spec.id}: ${doc.numPages}`);
  const pages = [];
  for (let physicalPage = 1; physicalPage <= doc.numPages; physicalPage += 1) {
    const pdfPage = await doc.getPage(physicalPage);
    const rawText = extractPageText((await pdfPage.getTextContent()).items);
    const fullText = rawText.length >= 20 && !CJK.test(rawText) ? rawText : '';
    const searchable = Boolean(fullText);
    const pageTitle = searchable ? titleFor(fullText, spec.title, physicalPage) : `صفحة مصورة — ${spec.subject}`;
    pages.push({
      physicalPage,
      printedPage: printedPageFor(spec, physicalPage),
      pageNumber: physicalPage,
      printedPageNumber: printedPageFor(spec, physicalPage),
      fullText,
      searchable,
      ocr: { required: !searchable, status: searchable ? 'text' : 'needed', engine: searchable ? 'pdf-text' : 'none' },
      needsOcr: !searchable,
      title: pageTitle,
      summary: searchable ? `نص الصفحة مستخرج من كتاب ${spec.subject}؛ راجعي المقتطف أو افتحي الصفحة للتفاصيل.` : `صفحة مصورة من كتاب ${spec.subject} لا يتوفر لها نص مستخرج بعد.`,
      section: spec.subject,
      unit: '',
      pageType: searchable ? 'pdf-text' : 'needs_ocr',
      educationalPurpose: '',
      sourceProvenance: { type: 'pdf', fileName: spec.file, physicalPage, authority: 'official-reference', checksum },
    });
  }
  await doc.destroy();

  const book = {
    schemaVersion: 1,
    id: spec.id,
    title: spec.title,
    subject: spec.subject,
    grade: 'السادس الإعدادي الإسلامي',
    branch: 'ديني',
    track: 'ديني',
    supplementary: spec.id === 'fiqh-hanafi-deni-sixth',
    edition: spec.edition,
    year: spec.year,
    publisher: 'ديوان الوقف السني — دائرة التعليم الديني والدراسات الإسلامية',
    referenceKind: 'official-textbook',
    pageCount: pages.length,
    searchablePageCount: pages.filter((page) => page.searchable).length,
    source,
    pages,
  };
  await writeFile(path.join(BOOKS_DIR, `${spec.id}.json`), `${JSON.stringify(book)}\n`);
  await writeFile(path.join(OUTLINES_DIR, `${spec.id}.md`), outlineFor(book, pages));
  const { schemaVersion: _schemaVersion, ...indexBook } = book;
  index.books.push(indexBook);
  known.add(spec.id);
  importedBooks += 1;
  totalPages += pages.length;
  searchablePages += book.searchablePageCount;
  console.log(`${spec.subject}: ${pages.length} صفحة · ${book.searchablePageCount} نصية · ${pages.length - book.searchablePageCount} تحتاج قراءة بصرية`);
}

if (importedBooks || updatedMetadata) {
  const temp = `${INDEX_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(index)}\n`);
  await rename(temp, INDEX_FILE);
}
console.log(`\nأضيف ${importedBooks} كتب رسمية · ${totalPages} صفحة · ${searchablePages} صفحة نصية قابلة للفهرسة.${updatedMetadata ? ' حُدّث تصنيف الكتاب الحنفي كملحق إضافي.' : ''}`);
