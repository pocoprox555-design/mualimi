// إعادة توليد pdf-index.json من pdf-books وحدها.
//
// لماذا هذا السكربت: pdf-index.json هو جسر pdf-books إلى build-index، وbuild-index لا
// يقرأ إلا pdf-index. فأي تعديل يدوي على pdf-books (تصحيح رقم، إضافة verifiedNumbers،
// وصف بصري) لا يصل إلى التشغيل إلا بطبقة وسيطة،namely apply-page-patches — وهي تفرض
// الترقيعات على البيانات، أي أنها قد تُعيد تطبيق وصف قديم فوق عمل يدوي. هذا السكربت
// يبني الجسر من المصدر مباشرةً بلا ترقيعات، فيغلق ثغرة خط الإنتاج.
//
//   node scripts/rebuild-pdf-index.mjs              # إعادة التوليد
//   node scripts/rebuild-pdf-index.mjs --dry-run    # تقرير فقط بلا كتابة
//   node scripts/rebuild-pdf-index.mjs --book <id>  # كتاب واحد
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const PDF_INDEX = path.join(LIBRARY, 'pdf-index.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyBook = args.includes('--book') ? args[args.indexOf('--book') + 1] : null;

const index = await readFile(PDF_INDEX, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
if (!index?.books) {
  console.error(`CURRICULUM_PDF_INDEX_INVALID: لا يمكن قراءة ${PDF_INDEX}`);
  process.exit(2);
}

const names = (await readdir(BOOKS_DIR).catch(() => [])).filter((file) => file.endsWith('.json')).sort();
const fresh = new Map();
for (const name of names) {
  const bookId = name.slice(0, -5);
  if (onlyBook && bookId !== onlyBook) continue;
  const book = await readFile(path.join(BOOKS_DIR, name), 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
  if (!book?.pages?.length) {
    console.error(`  تخطّي ${bookId}: لا صفحات`);
    continue;
  }
  fresh.set(book.id || bookId, book);
}

const known = new Set(index.books.map((entry) => entry.id));
const rows = [];
let changed = 0;
let added = 0;
const problems = [];

for (const book of index.books) {
  if (onlyBook && book.id !== onlyBook) continue;
  const source = fresh.get(book.id);
  if (!source) {
    if (!onlyBook) problems.push(`${book.id}: في pdf-index وليس في pdf-books`);
    continue;
  }
  const replacement = { ...source };
  delete replacement.schemaVersion;
  const before = JSON.stringify(book);
  const after = JSON.stringify(replacement);
  const pagesBefore = book.pages?.length ?? 0;
  const pagesAfter = replacement.pages.length;
  const same = before === after;
  if (!same) changed += 1;
  if (pagesBefore !== pagesAfter) problems.push(`${book.id}: عدد الصفحات ${pagesBefore} → ${pagesAfter}`);
  rows.push({ id: book.id, pages: pagesAfter, changed: !same });
  book.__replacement = replacement;
}

for (const [bookId, book] of fresh) {
  if (known.has(bookId)) continue;
  const replacement = { ...book };
  delete replacement.schemaVersion;
  index.books.push(replacement);
  added += 1;
  problems.push(`${bookId}: في pdf-books وليس في pdf-index — أُضيف`);
  rows.push({ id: bookId, pages: book.pages.length, changed: true, added: true });
}

const rebuiltAt = new Date().toISOString();
for (const book of index.books) {
  if (book.__replacement) {
    const replacement = book.__replacement;
    delete book.__replacement;
    Object.keys(book).forEach((key) => { if (!(key in replacement)) delete book[key]; });
    Object.assign(book, replacement);
  }
}
index.rebuiltAt = rebuiltAt;
index.rebuiltFrom = 'pdf-books';

console.log(`pdf-index: ${index.books.length} كتاب · ${rows.length} مُعاد · ${changed} تغيّر · ${added} أُضيف · ${rebuiltAt}`);
for (const row of rows.filter((item) => item.changed || item.added)) console.log(`  ${row.added ? '+' : '~'} ${row.id} · ${row.pages} صفحة`);
for (const problem of problems) console.log(`  ! ${problem}`);

if (dryRun) {
  console.log('\n=== محاكاة بلا كتابة ===');
  process.exit(problems.some((problem) => problem.includes('أُضيف')) ? 1 : 0);
}

const temp = `${PDF_INDEX}.tmp`;
await writeFile(temp, `${JSON.stringify(index)}\n`, 'utf8');
await rename(temp, PDF_INDEX);
console.log(`  كُتب ${path.relative(ROOT, PDF_INDEX)}`);
