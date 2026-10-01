import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
const PDF_INDEX = path.join(LIBRARY, 'pdf-index.json');
const AUTH_FILE = 'C:/Users/m/.local/share/opencode/auth.json';
const MODEL_FALLBACK = 'mimo-v2.6-flash';
const SCALE = 2;
const TIMEOUT_MS = 420_000;
const MAX_TOKENS = 16_000;

const PROMPT = [
  'أنت مستخرج نصوص متخصص في اللغة العربية، تقرأ صورًا لصفحات كتب مدرسية عراقية للصف السادس الإعدادي.',
  'أعد JSON صالحًا فقط بلا أي نص خارجه وبلا سطر رمز، بالبنية:',
  '{"text":"النص الكامل للصفحة كما هي","title":"عنوان قصير للصفحة (80 حرفًا كحد أقصى)","summary":"جملة أو جملتان (300 حرف كحد أقصى) يصفان محتوى الصفحة تحديدًا","section":"اسم الدرس أو القسم إن ظهر وإلا فارغ","unit":"اسم الوحدة أو الفصل إن ظهر وإلا فارغ"}',
  'قواعد صارمة:',
  '- انسخ النص من الصورة حرفًا بحرف، لا تلخص ولا تترجم ولا تختصر داخل text.',
  '- أخرج الصفحة كاملة حتى نهاية آخر سطر؛ لا تتوقف في منتصف النص ولا تُكمل الناقص تخمينًا.',
  '- حافظ على التشكيل وعلامات الترقيم وترتيب السطور قدر الإمكان، وخفّف التعليل إن لم تكن متأكدًا.',
  '- لا تضف مقدمة ولا تعليقًا ولا شرحًا ولا اعتذارًا.',
  '- لا تخترع ما لا يوجد في الصورة؛ إن لم يوجد عنوان صريح فاجعل title أول سطر مفيد من الصفحة.',
  '- إن كانت الصفحة شعارًا أو صورة بلا نص مكتوب فاجعل text فارغًا وصف ما فيها في summary.',
].join('\n');

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
const DRY_RUN = Boolean(flag('dry-run'));
const ONLY_BOOK = flag('book', null);
const ONLY_BOOKS = String(flag('books', '') || '').split(',').map((id) => id.trim()).filter(Boolean);
const LIMIT = Number(flag('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency', process.env.OCR_CONCURRENCY || 4)) || 4));

function loadDotEnv() {
  const env = {};
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch { /* لا يوجد ملف */ }
  return env;
}

function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!text.startsWith('b64:')) return text;
  try { return Buffer.from(text.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
}

async function collectKeys() {
  const keys = [];
  const env = loadDotEnv();
  const fromEnv = decodeKey(env.AI_API_KEY);
  if (fromEnv) keys.push(fromEnv);
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    for (const entry of Object.values(auth)) if (entry?.key) keys.push(entry.key);
  } catch { /* لا توجد مفاتيح إضافية */ }
  return [...new Set(keys.filter(Boolean))];
}

function endpointFromEnv() {
  const env = loadDotEnv();
  const raw = String(env.AI_ENDPOINT || 'https://opencode.ai/zen/go/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionSeq = 0;
const sessionId = () => `mualimi-ocr-${process.pid}-${(sessionSeq += 1)}`;

class KeyRing {
  constructor(keys, endpoint) {
    this.keys = keys;
    this.endpoint = endpoint;
    this.index = 0;
    this.dead = new Set();
  }
  current() { return this.keys[this.index]; }
  kill() {
    this.dead.add(this.index);
    const next = this.keys.findIndex((_, i) => !this.dead.has(i));
    if (next >= 0) { this.index = next; return true; }
    return false;
  }
}

async function probeKeys(ring) {
  for (let i = 0; i < ring.keys.length; i += 1) {
    ring.index = i;
    try {
      const response = await fetch(ring.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ring.current()}`, 'x-opencode-session': 'mualimi-ocr' },
        body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      });
      if (response.ok) return true;
      await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) { ring.dead.add(i); continue; }
      return true;
    } catch { continue; }
  }
  return false;
}

const MODEL = (() => {
  const env = loadDotEnv();
  const model = String(env.AI_MODEL || MODEL_FALLBACK).trim();
  const aliases = { 'MiMo-V2.6-Flash': 'mimo-v2.6-flash', 'MiMo-V2.6-Pro': 'mimo-v2.6-pro' };
  return aliases[model] || model || MODEL_FALLBACK;
})();

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
const docCache = new Map();

async function openDoc(pdfPath) {
  if (!docCache.has(pdfPath)) {
    const data = new Uint8Array(await readFile(pdfPath));
    docCache.set(pdfPath, await pdfjs.getDocument({ data, canvasFactory, isEvalSupported: false, verbosity: 0 }).promise);
  }
  return docCache.get(pdfPath);
}

async function closeDocs() {
  for (const doc of docCache.values()) await doc.destroy().catch(() => {});
  docCache.clear();
}

async function renderPage(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: SCALE });
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  return Buffer.from(await canvas.encode('png'));
}

function parseModelJson(raw) {
  const cleaned = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], cleaned] : [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* المحاولة التالية */ }
  }
  return null;
}

function deriveMeta(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const title = (lines.find((line) => line.length >= 4 && line.length <= 120) || '').slice(0, 140);
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = flat.split(/(?<=[.!؟?])\s+/).filter((sentence) => sentence.length > 24);
  const summary = sentences.slice(0, 2).join(' ').slice(0, 400);
  return { title, summary };
}

function cleanTextBlock(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanField(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^(null|undefined)$/i.test(text)) return '';
  if (/^(لا يوجد|غير مذكور|n\/a|none|-)$/i.test(text)) return '';
  return text.slice(0, max);
}

async function callVision(ring, png) {
  const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } };
  let maxTokens = MAX_TOKENS;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(ring.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ring.current()}`, 'x-opencode-session': sessionId() },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          temperature: 0.1,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, imagePart] }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        if (ring.kill()) { lastError = new Error(`مفتاح مرفوض (${response.status}) — تم التبديل`); continue; }
        throw new Error(`كل المفاتيح مرفوضة (${response.status})`);
      }
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status} ${raw.slice(0, 200)}`);
      const json = JSON.parse(raw);
      const choice = json?.choices?.[0] || {};
      const message = choice.message || {};
      const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || '').join('') : '';
      if (!content) {
        if (choice.finish_reason === 'length' && maxTokens < 48_000) {
          maxTokens = Math.min(48_000, maxTokens * 3);
          lastError = new Error(`سبب طويل جدًا — أعيد بسقف ${maxTokens}`);
          continue;
        }
        if (message.reasoning_content) throw new Error('النموذج أنهى السبب دون نص');
        throw new Error('رد فارغ من المزود');
      }
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(1_500 * attempt);
    }
  }
  throw lastError || new Error('فشل غير معروف');
}

const PLACEHOLDER = /تحتاج (?:هذه الصفحة إلى )?القراءة البصرية|صفحة تحتاج OCR|صفحة مصورة|لا نص مستخرج|استخراج محتوى الصفحة من الصورة|تقع هذه الصفحة ضمن درس/;

function applyResult(page, parsed, model) {
  if (!parsed || typeof parsed.text !== 'string') throw new Error('OCR_OUTPUT_NOT_VALID_JSON');
  const text = cleanTextBlock(parsed.text);
  if (/^\s*\{\s*"(?:text|title|summary)"\s*:/.test(text) || /[\u3400-\u9fff]/u.test(text)) {
    throw new Error('OCR_OUTPUT_CONTAMINATED');
  }
  const fallback = deriveMeta(text);
  const titleCandidate = cleanField(parsed.title, 140);
  const summaryCandidate = cleanField(parsed.summary, 460);
  const title = (/[\u3400-\u9fff]/u.test(titleCandidate) ? '' : titleCandidate) || fallback.title || cleanField(page.title, 140);
  const summary = (/[\u3400-\u9fff]/u.test(summaryCandidate) ? '' : summaryCandidate) || fallback.summary || cleanField(page.summary, 460);
  const section = cleanField(parsed?.section, 140) || cleanField(page.section, 140);
  const unit = cleanField(parsed?.unit, 140) || cleanField(page.unit, 140);
  const hasText = text.replace(/\s+/g, '').length >= 20;

  page.fullText = text;
  page.searchable = hasText;
  page.needsOcr = !hasText;
  page.ocr = {
    required: !hasText,
    status: hasText ? 'completed' : 'no-text',
    engine: 'vision',
    model,
    at: new Date().toISOString(),
    parser: parsed ? 'json' : 'raw',
  };
  if (title) page.title = title.replace(/—?\s*صفحة تحتاج OCR\s*$/, '').trim();
  if (summary) page.summary = summary;
  if (section) page.section = section;
  if (unit) page.unit = unit;
  if (hasText && (page.pageType === 'needs_ocr' || page.pageType === 'image')) page.pageType = 'scanned_ocr';
  if (PLACEHOLDER.test(page.educationalPurpose || '') || !page.educationalPurpose) {
    page.educationalPurpose = summary ? `محتوى الصفحة: ${summary}`.slice(0, 400) : 'استخراج محتوى الصفحة من الصورة.';
  }
  return { hasText, chars: text.length, parsed: true };
}

function needsOcr(page) {
  return Boolean(page.needsOcr || page.ocr?.required || !String(page.fullText || '').trim());
}

function resolvePdfFile(book) {
  const name = book.source?.fileName || book.book?.source?.fileName
    || book.pages.find((page) => page.sourceProvenance?.fileName)?.sourceProvenance?.fileName;
  if (!name) throw new Error(`لا يوجد ملف PDF مسجل للكتاب ${book.id}`);
  return path.join(SOURCES_DIR, name);
}

let writeChain = Promise.resolve();
function queueWrite(file, data) {
  const temp = `${file}.tmp`;
  writeChain = writeChain
    .then(() => writeFile(temp, data))
    .then(() => rename(temp, file))
    .catch((error) => {
      console.error(`[fatal] تعذر حفظ ${path.basename(file)}: ${error.message}`);
    });
  return writeChain;
}

async function processBook(book, ring, state) {
  const file = path.join(BOOKS_DIR, `${book.id}.json`);
  const json = JSON.parse(await readFile(file, 'utf8'));
  const pending = json.pages.filter((page) => needsOcr(page));
  if (!pending.length) return { id: book.id, skipped: true, done: 0, failed: 0 };
  if ((ONLY_BOOK && book.id !== ONLY_BOOK) || (ONLY_BOOKS.length && !ONLY_BOOKS.includes(book.id))) return { id: book.id, skipped: true, done: 0, failed: 0 };

  const pdfPath = resolvePdfFile(json);
  console.log(`\n[${json.id}] ${pending.length} صفحة تحتاج OCR — ${path.basename(pdfPath)}`);
  const doc = await openDoc(pdfPath);

  let cursor = 0;
  let done = 0;
  let failed = 0;
  const save = () => queueWrite(file, `${JSON.stringify(json)}\n`);

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      if (LIMIT && state.processed >= LIMIT) return;
      const page = pending[index];
      const started = Date.now();
      try {
        const png = await renderPage(doc, Number(page.physicalPage));
        const raw = await callVision(ring, png);
        const parsed = parseModelJson(raw);
        const result = applyResult(page, parsed, MODEL);
        await save();
        done += 1;
        state.processed += 1;
        state.totalChars += result.chars;
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ✓ ${page.physicalPage} · ${result.chars} حرف · ${seconds}s · ${result.parsed ? 'json' : 'نص خام'}`);
      } catch (error) {
        failed += 1;
        state.failed.push({ book: json.id, page: page.physicalPage, error: String(error.message || error) });
        console.log(`  ✗ ${page.physicalPage} · ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await save();
  return { id: json.id, skipped: false, done, failed, total: pending.length };
}

async function rebuildPdfIndex() {
  const index = JSON.parse(await readFile(PDF_INDEX, 'utf8'));
  const books = [];
  for (const entry of index.books) {
    const file = path.join(BOOKS_DIR, `${entry.id}.json`);
    const fresh = JSON.parse(await readFile(file, 'utf8'));
    delete fresh.schemaVersion;
    books.push(fresh);
  }
  index.books = books;
  await writeFile(PDF_INDEX, `${JSON.stringify(index)}\n`);
  const pages = books.reduce((sum, book) => sum + book.pages.length, 0);
  const searchable = books.reduce((sum, book) => sum + book.pages.filter((page) => page.fullText).length, 0);
  console.log(`\npdf-index: ${books.length} كتاب · ${pages} صفحة · ${searchable} قابلة للبحث`);
}

const files = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json'));
const books = [];
for (const name of files) {
  const json = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
    if (json.pages?.some(needsOcr)
      && (!ONLY_BOOK || json.id === ONLY_BOOK)
      && (!ONLY_BOOKS.length || ONLY_BOOKS.includes(json.id))) books.push({ id: json.id, name });
}

console.log(`كتب بها صفحات تحتاج OCR: ${books.length} · تزامن ${CONCURRENCY} · نموذج ${MODEL}`);

if (DRY_RUN) {
  for (const entry of books) console.log(`  - ${entry.id}`);
  process.exit(0);
}

const keys = await collectKeys();
if (!keys.length) { console.error('لا يوجد مفتاح API.'); process.exit(1); }
const ring = new KeyRing(keys, endpointFromEnv());
if (!(await probeKeys(ring))) { console.error('كل المفاتيح مرفوضة من المزود (401).'); process.exit(1); }
console.log(`المفتاح يعمل · المزود ${ring.endpoint} · عدد المفاتيح ${keys.length}`);

const state = { processed: 0, failed: [], totalChars: 0 };
const results = [];
for (const entry of books) {
  const book = { id: entry.id };
  results.push(await processBook(book, ring, state));
}

await writeChain;
await closeDocs();
await rebuildPdfIndex();

console.log('\n=== الملخص ===');
for (const result of results) {
  if (result.skipped) continue;
  console.log(`  ${result.id}: ${result.done}/${result.total} صفحة · فشل ${result.failed}`);
}
console.log(`صفحات أُعيد استخراجها: ${state.processed}`);
console.log(`أحرف مُستخرجة: ${state.totalChars}`);
console.log(`صفحات فشلت: ${state.failed.length}`);
for (const failure of state.failed) console.log(`  ! ${failure.book} صفحة ${failure.page}: ${failure.error}`);
if (state.failed.length) process.exitCode = 2;
