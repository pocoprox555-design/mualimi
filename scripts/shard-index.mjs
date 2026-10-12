// يبني طبقة تشغيل مُشرَّحة (sharded) من search-index.json.
//
// المسار القديم كان يحمّل الملف الكامل (36.4MB على القرص ⇒ ~121MB heap) مع كل
// حقوله المتراكبة (documents × terms × normalized × documentFrequency × postings).
// هنا يُقسَّم إلى:
//   shards/catalog.json  الكتب + الإحصاءات
//   shards/printed.json   خرائط الرقم المطبوع ← الفيزيائي
//   shards/lookup.json    postings مسطّحة (terms مرتّبة + offsets + ids + df) بحث ثنائي
//   shards/meta.json      بيانات مسح خفيفة لكل صفحة (بلا النص الكامل)
//   shards/docs/*.json    سجل الصفحة الكامل، يُقرأ عند الحاجة فقط
//   shards/manifest.json  بصمة المصدر لكشف التقادم عند الإقلاع
//
// المكسب: searchTrack صار يعمل على postings وحدها (لا يمسّ doc.terms إطلاقاً)،
// وسجل الصفحة الثقيل (النص/الرسوم/المفردات/التمارين) لا يُقرأ إلا لمن تُفتح
// صفحته فعلاً. المخزون الدائم ينزل من ~121MB إلى ~25MB.
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueTokens } from '../lib/text.mjs';
import { isExercisePage, isStaleOutline } from '../lib/page-kind.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCE = path.join(LIBRARY, 'search-index.json');
const OUT = path.join(LIBRARY, 'shards');
const DOCS_DIR = path.join(OUT, 'docs');

// سجلّ واحد لكل N صفحة. الحجم يوزّع بين عدد الملفات (وصول عشوائي) وحجم الملف
// (إدخال/إخراج متكرر). 250 صفحة ⇒ ~10 ملفات لكل مكتبة، ~200KB للملف.
const SHARD_DOCS = 250;

// نفس عبارات STALE_OUTLINE في lib/index.mjs: وصف فهرسي قديم يقول «لا يمكن
// الإجابة» محشور في مصطلحات الصفحة. عند وجود نصّ حقيقي نستبدل المصطلحات
// بمصطلحات محتوى الصفحة وحدها، فيزول الشرط الخاص عن مسار المسح بالكامل.
const STALE_OUTLINE = /(?:لا\s*(?:يمكن\s+(?:الإجابة|الاجابة|الجواب)|يتوفر\s+(?:لها\s+)?نص|يوجد\s+نص|نص\s+مستخرج)|لا\s+نص\s+مستخرج|لا\s+يوجد\s+نص|تحتاج\s+قراءة\s+بصرية|صفحة\s+مصورة|searchable:\s*false|needsOcr:\s*true)/i;

// الحقول التي يبني منها الفهرس نصّ البحث غير الفهرس. تُستخدم لإعادة حساب
// مصطلحات الصفحة حين يكون وصفها الفهرسي قديماً ومتناقضاً مع نصها الحالي.
function nonOutlineSearchableText(doc, book) {
  const figures = (doc.figures || []).map((figure) => [
    'صورة', figure?.kind, figure?.caption, figure?.description, ...(figure?.figureText || []),
  ].filter(Boolean).join(' ')).join('\n');
  const glossary = ['مفردات معجم', ...(doc.glossary || []).map((entry) => [entry.term, entry.pos, entry.definition].filter(Boolean).join(' '))].join('\n');
  const activities = ['نشاط تمارين', ...(doc.activities || []).map((activity) => [
    activity.type, activity.instruction, activity.answerFormat,
    activity.dispatch ? `${activity.dispatch.target} ${activity.dispatch.printedFrom} ${activity.dispatch.printedTo}` : '',
    ...(activity.questions || []),
  ].filter(Boolean).join(' '))].join('\n');
  const exercises = ['تمارين', ...(doc.exercises || []).map((exercise) => [
    `التمرين ${exercise.letter || ''}`, exercise.instruction,
    ...(exercise.items || []).map((item) => `${item.kind || ''} ${item.stem || ''}`),
  ].filter(Boolean).join(' '))].join('\n');
  return [
    book?.title, book?.subject, doc.title, doc.section, doc.unit, doc.work, doc.author,
    doc.sectionPath, doc.pageType, doc.purpose, doc.summary, doc.text,
    figures, glossary, activities, exercises,
  ].filter(Boolean).join('\n');
}

// الحقول الخفيفة التي يحتاجها المسح والترتيب فقط. لا نصّ صفحة ولا بنية منظّمة:
// تلك تُقرأ من shards/docs عند فتح الصفحة وحدها.
function scanMeta(doc) {
  return {
    bookId: doc.bookId,
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage ?? null,
    title: doc.title || '',
    section: doc.section || '',
    unit: doc.unit || '',
    pageType: doc.pageType || '',
    searchable: Boolean(doc.searchable),
    needsOcr: Boolean(doc.needsOcr),
    evidenceStatus: doc.evidenceStatus || null,
    textLength: doc.textLength || 0,
    pageOffset: doc.pageOffset ?? null,
    textDamaged: Boolean(doc.textDamaged),
    enriched: Boolean(doc.enriched),
    normalized: doc.normalized || '',
    // يُحسب وقت البناء لأن قراءته تحتاج نص الصفحة؛ وقت التشغيل يقرأه بلا فحص.
    exercisePage: isExercisePage(doc),
    staleOutline: isStaleOutline(doc),
    shard: 0,
    offset: 0,
  };
}

// سجل الصفحة الكامل: كل ما يلزم fullPage() وstructureBlock() والاقتباس والتشخيص.
function pageRecord(doc) {
  return {
    id: doc.id || `${doc.bookId}:${doc.physicalPage}`,
    bookId: doc.bookId,
    physicalPage: doc.physicalPage,
    printedPage: doc.printedPage ?? null,
    title: doc.title || '',
    section: doc.section || '',
    unit: doc.unit || '',
    work: doc.work || '',
    author: doc.author || '',
    actScene: doc.actScene || '',
    sectionPath: doc.sectionPath || '',
    pageType: doc.pageType || '',
    purpose: doc.purpose || '',
    summary: doc.summary || '',
    preview: doc.preview || '',
    text: doc.text || '',
    textLength: doc.textLength || 0,
    // `normalized` و`terms` يبقى في طبقة meta وحدها، ويُدمجان في العرض الكامل
    // (`materializeAll`) فلا يتكرّر النص المطبوع مرتين على القرص وفي الذاكرة.
    keywords: doc.keywords || [],
    verifiedNumbers: doc.verifiedNumbers || [],
    outlineSummary: doc.outlineSummary || '',
    searchable: Boolean(doc.searchable),
    needsOcr: Boolean(doc.needsOcr),
    evidenceStatus: doc.evidenceStatus || null,
    textDamaged: Boolean(doc.textDamaged),
    pageOffset: doc.pageOffset ?? null,
    enriched: Boolean(doc.enriched),
    titleEn: doc.titleEn || '',
    summaryEn: doc.summaryEn || '',
    answerKeyLocation: doc.answerKeyLocation || '',
    glossary: doc.glossary || [],
    glossaryRefs: doc.glossaryRefs || [],
    figures: doc.figures || [],
    activities: doc.activities || [],
    exercises: doc.exercises || [],
    vocabulary: doc.vocabulary || [],
    continuesOn: doc.continuesOn || '',
    recapOf: doc.recapOf || '',
    notes: doc.notes || '',
  };
}

/**
 * يبني طبقة التشغيل المشرَّحة. دالة نقرة (بلا آثار على الملفات) لكي يستدعيها
 * build-index.mjs في الأمر ذاته، ولكي تُختبر مستلةً عن القرص.
 * @param {object} index مخرجات build-index.mjs (search-index.json)
 * @param {string} outDir مجلد الوجهة
 * @param {{sourceDigests?: Array<[string,number,number]>}} [options] بصمة المصدر لكشف التقادم
 */
export async function buildShards(index, outDir = OUT, options = {}) {
  if (!index?.documents?.length) throw new Error('SHARD_SOURCE_EMPTY');
  const docsDir = path.join(outDir, 'docs');
  await mkdir(docsDir, { recursive: true });

  const meta = index.documents.map(scanMeta);
  const records = index.documents.map(pageRecord);

  // ── إعادة حساب مصطلحات الصفحات ذات الوصف الفهرسي المتناقض ────────────────
  // المسار القديم كان يفحص ذلك في كل مرشح أثناء البحث (nonOutlineTermsCache
  // + nonOutlineSearchText) فيزيد كلفة المسح ويحتاج حقول البنية كاملة في الذاكرة.
  // هنا يُحسب مرة واحدة وقت البناء، فيصير المسح وقت التشغيل postings خالصة.
  const booksById = new Map((index.books || []).map((book) => [book.id, book]));
  const altTerms = [];
  let altCount = 0;
  for (let id = 0; id < index.documents.length; id += 1) {
    const doc = index.documents[id];
    const stale = String(doc.text || '').trim() && STALE_OUTLINE.test(String(doc.outlineSummary || ''));
    if (!stale) continue;
    altCount += 1;
    if (!Array.isArray(altTerms[id])) altTerms[id] = [];
    altTerms[id] = uniqueTokens(nonOutlineSearchableText(doc, booksById.get(doc.bookId)));
  }

  // ── postings مسطّحة مرتبة ───────────────────────────────────────────────
  // postings الأصلية مبنية من tokens كل صفحة (بلا صيغ موسّعة)، وهذا بالضبط ما
  // يجعل termMatches وقت التشغيل بحثاً في postings لا مسحاً في doc.terms: صيغ
  // السؤال تُوسّع مرة واحدة، وكل مرشح يُجمع بجَمْع مجموعة لا بمقارنات نصّية.
  const buckets = new Map();
  for (let id = 0; id < index.documents.length; id += 1) {
    const terms = altTerms[id] && altTerms[id].length ? altTerms[id] : (index.documents[id].terms || []);
    for (const term of terms) {
      let bucket = buckets.get(term);
      if (!bucket) { bucket = []; buckets.set(term, bucket); }
      bucket.push(id);
    }
  }
  // جدول df الأصلي مبني من الصيغ الموسّعة؛ نحتفظ به كما هو لأنه مصدر idf.
  const sourceDf = index.documentFrequency || {};
  const terms = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const offsets = new Array(terms.length + 1);
  const ids = [];
  const df = new Array(terms.length);
  let cursor = 0;
  for (let i = 0; i < terms.length; i += 1) {
    const bucket = buckets.get(terms[i]);
    offsets[i] = cursor;
    for (const id of bucket) ids.push(id);
    cursor += bucket.length;
    df[i] = Number(sourceDf[terms[i]] || bucket.length);
  }
  offsets[terms.length] = cursor;

  const lookup = { terms, offsets, ids, df, alt: altCount };

  // ── تقسيم سجلات الصفحات ─────────────────────────────────────────────────
  const shardCount = Math.max(1, Math.ceil(records.length / SHARD_DOCS));
  for (let s = 0; s < shardCount; s += 1) {
    const slice = records.slice(s * SHARD_DOCS, (s + 1) * SHARD_DOCS);
    const file = path.join(docsDir, `shard-${String(s).padStart(4, '0')}.json`);
    await writeFile(file, `${JSON.stringify(slice)}\n`);
    for (let i = 0; i < slice.length; i += 1) {
      meta[s * SHARD_DOCS + i].shard = s;
      meta[s * SHARD_DOCS + i].offset = i;
    }
  }

  // ── كتالوج + خرائط الطباعة ──────────────────────────────────────────────
  const catalog = {
    schemaVersion: index.schemaVersion,
    builtAt: index.builtAt,
    sourceOfTruth: index.sourceOfTruth || 'curriculum-library/pdf-sources',
    stats: index.stats,
    books: index.books,
  };
  const printed = {};
  for (const [bookId, map] of Object.entries(index.printed || {})) printed[bookId] = map;

  const manifest = {
    builtAt: index.builtAt,
    generatedAt: new Date().toISOString(),
    docs: records.length,
    terms: terms.length,
    postingsEntries: ids.length,
    shards: shardCount,
    altTermPages: altCount,
    sources: options.sourceDigests || [],
  };

  // كتابة ذرّية: ملف مؤقّت ثم إعادة تسمية، فلا يبقى فصل نصف مكتوب عند الانقطاع.
  const atomic = async (file, data) => {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  };
  await atomic(path.join(outDir, 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  await atomic(path.join(outDir, 'printed.json'), `${JSON.stringify(printed)}\n`);
  await atomic(path.join(outDir, 'lookup.json'), `${JSON.stringify(lookup)}\n`);
  await atomic(path.join(outDir, 'meta.json'), `${JSON.stringify(meta)}\n`);
  await atomic(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

/** سطر الأوامر: `node scripts/shard-index.mjs` */
const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  const index = JSON.parse(await readFile(SOURCE, 'utf8'));
  // بصمة المصدر تُقرأ من pdf-index.json فهو الطبقة التي تحمل اسم الملف وحجمه،
  // بينما search-index.json لا ينقل fileName إلى كتبه. البصمة تكشف عند الإقلاع
  // فهرساً بُنِي قبل تغيّر الـPDF.
  let pdfIndex = { books: [] };
  try { pdfIndex = JSON.parse(await readFile(path.join(LIBRARY, 'pdf-index.json'), 'utf8')); } catch { /* بلا بصمة */ }
  const sourceByName = new Map();
  for (const book of pdfIndex.books || []) {
    const fileName = book.source?.fileName || book.pages?.find((page) => page.sourceProvenance?.fileName)?.sourceProvenance?.fileName;
    if (fileName) sourceByName.set(book.id, fileName);
  }
  const digests = [];
  for (const book of index.books || []) {
    const file = path.join(LIBRARY, 'pdf-sources', sourceByName.get(book.id) || '');
    const info = await stat(file).catch(() => null);
    digests.push([book.id, info ? info.size : 0, info ? Number(info.mtimeMs).toFixed(0) : '0']);
  }
  const manifest = await buildShards(index, OUT, { sourceDigests: digests });
  console.log(`shards: ${manifest.docs} pages · ${manifest.terms} terms · ${manifest.postingsEntries} postings · ${manifest.shards} shard files`);
  console.log(`  alt-term pages: ${manifest.altTermPages} (stale outline recomputed at build time)`);
  console.log(`  out: ${path.relative(ROOT, OUT)}`);
}
