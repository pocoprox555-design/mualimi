// Mines verifiable, page-specific facts from deep/late/middle pages of the
// Rahma track books, so probes can test whether retrieval actually reaches
// obscure content instead of only easy front-of-book material.
//
// Output: JSON array of cases with { caseId, bookId, bookTitle, subject,
// physicalPage, printedPage, position, keyTerms, quote, question }.
import { readFile } from 'node:fs/promises';
import { normalizeAr, uniqueTokens } from '../lib/text.mjs';

const LIB = new URL('../curriculum-library/', import.meta.url);
const index = JSON.parse(await readFile(new URL('search-index.json', LIB), 'utf8'));

const TRACK = 'ديني';
const STOP = new Set([
  'في', 'من', 'الى', 'إلى', 'على', 'عن', 'ما', 'هل', 'هو', 'هي', 'هذا', 'هذه', 'ذلك', 'تلك',
  'ثم', 'او', 'أو', 'و', 'يا', 'مع', 'كل', 'كان', 'كانت', 'يكون', 'ان', 'أن', 'إن', 'اذا',
  'إذا', 'لم', 'لن', 'لا', 'قد', 'بعد', 'قبل', 'بين', 'عند', 'كما', 'التي', 'الذي', 'غير',
  'حتى', 'لي', 'لك', 'له', 'لها', 'انا', 'أنا', 'انت', 'أنت', 'نحن', 'هم', 'هن', 'به', 'له',
]);

function isTracked(book) {
  const track = normalizeAr(book.track || book.branch || 'عام');
  if (track !== normalizeAr(TRACK)) return false;
  if (book.supplementary) return false;
  return true;
}

// A fact sentence must be long enough to be a real claim, contain at least one
// distinctive rare-ish term, and avoid OCR-damaged fragments.
// Damaged sentences are excluded on purpose: a probe must measure whether the
// app can REACH a deep page, not whether a page's text layer is damaged. Damage
// handling is verified separately by the evidence-status assertions.
const DAMAGE = /[\uFFFD\uE000-\uF8FF]/;
const SUSPECT = /اال|هللا|االق|واال|حلل|االقتصاد/;

function pickFactSentence(doc) {
  const text = String(doc.text || '');
  if (text.length < 260) return null;
  const sentences = text
    .split(/\n+|(?<=[.!؟?؛;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 320);
  if (!sentences.length) return null;
  const scored = sentences
    .map((sentence) => {
      const tokens = uniqueTokens(sentence).filter((t) => t.length >= 5 && !STOP.has(t));
      const distinct = new Set(tokens);
      // Prefer sentences with multiple distinctive terms: they make a question
      // that can only be answered from this exact page.
      const score = distinct.size + Math.min(3, Math.floor(sentence.length / 110));
      return { sentence, score, terms: [...distinct] };
    })
    .filter((item) => item.terms.length >= 2)
    // Drop sentences whose own terms are visibly damaged, otherwise the probe
    // would fail for a reason unrelated to retrieval.
    .filter((item) => !DAMAGE.test(item.sentence) && !item.terms.some((t) => SUSPECT.test(t)));
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

const cases = [];
for (const book of index.books.filter(isTracked)) {
  const docs = index.documents
    .filter((doc) => doc.bookId === book.id && doc.text && doc.textLength >= 260 && doc.evidenceStatus !== 'no-text')
    .sort((a, b) => a.physicalPage - b.physicalPage);
  if (docs.length < 12) continue;

  // Late third, middle, and last pages: exactly where a keyword-only search
  // is most likely to fail.
  const targets = [
    { label: 'late', doc: docs[Math.floor(docs.length * 0.72)] },
    { label: 'middle', doc: docs[Math.floor(docs.length * 0.5)] },
    { label: 'last', doc: docs[docs.length - 1] },
    { label: 'deep', doc: docs[Math.floor(docs.length * 0.88)] },
  ];

  const used = new Set();
  for (const { label, doc } of targets) {
    if (!doc || used.has(doc.physicalPage)) continue;
    const fact = pickFactSentence(doc);
    if (!fact) continue;
    used.add(doc.physicalPage);
    const terms = fact.terms.slice(0, 3);
    cases.push({
      caseId: `${book.id}#${doc.physicalPage}`,
      bookId: book.id,
      bookTitle: book.title,
      subject: book.subject,
      physicalPage: doc.physicalPage,
      printedPage: doc.printedPage,
      pageTotal: docs.length,
      position: label,
      evidenceStatus: doc.evidenceStatus,
      keyTerms: terms,
      quote: fact.sentence,
      // Question names the topic but never the page, so the app must find it.
      question: `في كتاب ${book.subject}، ما الذي يقوله النص عن: ${terms.join('، ')}؟`,
    });
  }
}

// Windows shells mangle UTF-8 on plain redirection, so the harness writes the
// file itself with an explicit UTF-8 encoding.
const outPath = process.argv[2] || new URL('../.probe-cases.json', import.meta.url);
const { writeFile } = await import('node:fs/promises');
await writeFile(outPath, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
console.log(`probe cases: ${cases.length} -> ${outPath}`);