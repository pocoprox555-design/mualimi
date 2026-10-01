import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const BOOKS_DIR = path.join(LIBRARY, 'pdf-books');
const PATCH_DIR = path.join(LIBRARY, 'reports', 'patches');
const AUTH_FILE = 'C:/Users/m/.local/share/opencode/auth.json';
const BATCH = 8;
const TIMEOUT_MS = 180_000;
const TEXT_LIMIT = 1400;

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
const ONLY_BOOK = flag('book', null);
const LIMIT = Number(flag('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency', 6)) || 6));
const DRY_RUN = Boolean(flag('dry-run'));
const REDO = Boolean(flag('redo', false));

function loadDotEnv() {
  const env = {};
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch { /* بدون env */ }
  return env;
}

function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('b64:')) return text;
  try { return Buffer.from(text.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
}

const MODEL = (() => {
  const model = String(loadDotEnv().AI_MODEL || 'mimo-v2.6-flash').trim();
  const aliases = { 'MiMo-V2.6-Flash': 'mimo-v2.6-flash', 'MiMo-V2.6-Pro': 'mimo-v2.6-pro' };
  return aliases[model] || model || 'mimo-v2.6-flash';
})();

const endpoint = (() => {
  const raw = String(loadDotEnv().AI_ENDPOINT || 'https://opencode.ai/zen/go/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`;
})();

async function collectKeys() {
  const keys = [];
  const fromEnv = decodeKey(loadDotEnv().AI_API_KEY || '');
  if (fromEnv) keys.push(fromEnv);
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    for (const entry of Object.values(auth)) if (entry?.key) keys.push(entry.key);
  } catch { /* بدون مفاتيح إضافية */ }
  return [...new Set(keys.filter(Boolean))];
}

const PROMPT = [
  'أنت محرر محتوى لمنصة تعليمية. سأعطيك نصوص صفحات من كتاب مدرسي، لكل صفحة عنصر.',
  'اكتب لكل عنصر الحقول التالية بناءً على نصه فقط:',
  '- title: عنوان دقيق للصفحة (80 حرفًا كحد أقصى) يعبّر عن محتواها الفعلي، لا تنسخ السطر الأول ولا تذكر رقم الصفحة.',
  '- summary: جملة أو جملتين (بين 100 و240 حرفًا) تصفان ما تعرضه الصفحة تحديدًا: الفكرة أو النشاط أو المسائل، لا نسخًا للنص.',
  '- educationalPurpose: جملة واحدة (80 إلى 180 حرفًا) تصف الغرض التربوي من الصفحة: ماذا يتعلّم الطالب أو ماذا يُطلب منه فيها، محددة لهذه الصفحة لا عامة.',
  '- section: اسم الدرس أو القسم أو العنوان الرئيسي إن ورد صراحة في النص، وإلا أعد فارغًا.',
  '- unit: اسم الوحدة أو الفصل إن ورد صراحة، وإلا أعد فارغًا.',
  'قواعد: لا تختلق معلومات غير موجودة في النص؛ اكتب بلغة النص (عربي للعربية وإنكليزية للإنكليزية)؛',
  'تجاهل أرقام صفحات PDF وأسماء الملفات وسطور الترويسة والتذييل؛ لا تضف أي نص خارج JSON.',
  'أعد JSON فقط بالشكل {"results":[{"id":"...","title":"...","summary":"...","educationalPurpose":"...","section":"...","unit":"..."}]}.',
].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionSeq = 0;
const sessionId = () => `mualimi-meta-${process.pid}-${(sessionSeq += 1)}`;

function parseJson(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1], text] : [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* التالي */ }
  }
  return null;
}

let activeKeys = [];

async function probeKey(key) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': `probe-${process.pid}-${Date.now()}` },
      body: JSON.stringify({ model: MODEL, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    await response.text().catch(() => '');
    return response.ok;
  } catch { return false; }
}

async function callModel(payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && activeKeys.length; attempt += 1) {
    const key = activeKeys[0];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': sessionId() },
        body: JSON.stringify({ model: MODEL, stream: false, temperature: 0.2, max_tokens: 6000, messages: [{ role: 'user', content: payload }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        activeKeys.shift();
        lastError = new Error(`مفتاح مرفوض ${response.status}`);
        continue;
      }
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status} ${raw.slice(0, 160)}`);
      const json = JSON.parse(raw);
      const content = String(json?.choices?.[0]?.message?.content || '');
      if (!content) throw new Error('رد فارغ');
      return content;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1_200 * attempt);
    }
  }
  throw lastError || new Error('فشل');
}

await mkdir(PATCH_DIR, { recursive: true });

const doneIds = new Set();
for (const name of (await readdir(PATCH_DIR)).filter((file) => file.endsWith('.json'))) {
  try {
    const raw = JSON.parse(await readFile(path.join(PATCH_DIR, name), 'utf8'));
    for (const entry of (Array.isArray(raw) ? raw : raw.patches || [])) {
      if (entry.summary || entry.title) doneIds.add(`${entry.bookId}:${entry.physicalPage}`);
    }
  } catch { /* ملف تالف يُتجاهل */ }
}

const bookFiles = (await readdir(BOOKS_DIR)).filter((name) => name.endsWith('.json')).sort();
const jobs = [];
for (const name of bookFiles) {
  const book = JSON.parse(await readFile(path.join(BOOKS_DIR, name), 'utf8'));
  if (ONLY_BOOK && book.id !== ONLY_BOOK) continue;
  const pending = book.pages.filter((page) => {
    const text = String(page.fullText || '').trim();
    if (text.length < 40) return false;
    if (!REDO && doneIds.has(`${book.id}:${page.physicalPage}`)) return false;
    return true;
  });
  for (let i = 0; i < pending.length; i += BATCH) {
    jobs.push({ bookId: book.id, pages: pending.slice(i, i + BATCH) });
  }
}

console.log(`صفحات تحتاج وصفًا: ${jobs.reduce((sum, job) => sum + job.pages.length, 0)} في ${jobs.length} دفعة · تزامن ${CONCURRENCY} · نموذج ${MODEL}`);
if (DRY_RUN) { console.log(jobs.map((job) => `${job.bookId}: ${job.pages.length}`).join('\n')); process.exit(0); }

const allKeys = await collectKeys();
if (!allKeys.length) { console.error('لا يوجد مفتاح API.'); process.exit(1); }
activeKeys = (await Promise.all(allKeys.map(async (key) => ((await probeKey(key)) ? key : null)))).filter(Boolean);
if (!activeKeys.length) { console.error('كل المفاتيح مرفوضة من المزود (401).'); process.exit(1); }
console.log(`مفاتيح صالحة: ${activeKeys.length} من ${allKeys.length}`);

let cursor = 0;
let appliedCount = 0;
let failedBatches = 0;
const failed = [];

async function worker() {
  for (;;) {
    const index = cursor;
    cursor += 1;
    if (index >= jobs.length) return;
    if (LIMIT && appliedCount >= LIMIT) return;
    const job = jobs[index];
    const started = Date.now();
    const items = job.pages.map((page) => ({
      id: `${job.bookId}:${page.physicalPage}`,
      section: String(page.section || ''),
      unit: String(page.unit || ''),
      text: String(page.fullText || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT),
    }));
    try {
      const raw = await callModel(`${PROMPT}\n\n${JSON.stringify({ items })}`);
      const parsed = parseJson(raw);
      const results = Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : null;
      if (!results) throw new Error('لم يُعد JSON صالح');
      const patches = results
        .filter((entry) => entry && entry.id)
        .map((entry) => {
          const [bookId, page] = String(entry.id).split(':');
          return {
            bookId,
            physicalPage: Number(page),
            title: String(entry.title || '').slice(0, 140),
            summary: String(entry.summary || '').slice(0, 600),
            ...(entry.educationalPurpose ? { educationalPurpose: String(entry.educationalPurpose).slice(0, 400) } : {}),
            ...(entry.section ? { section: String(entry.section).slice(0, 200) } : {}),
            ...(entry.unit ? { unit: String(entry.unit).slice(0, 200) } : {}),
            note: 'وصف مولّد من نص الصفحة',
          };
        })
        .filter((entry) => entry.bookId && entry.physicalPage && (entry.title || entry.summary));
      if (!patches.length) throw new Error('لا نتائج صالحة في الرد');
      const file = path.join(PATCH_DIR, `enrich-${job.bookId}-${String(index).padStart(4, '0')}.json`);
      await writeFile(`${file}.tmp`, `${JSON.stringify(patches)}\n`);
      await rename(`${file}.tmp`, file);
      appliedCount += patches.length;
      console.log(`  ✓ ${job.bookId} دفعة ${index + 1}/${jobs.length} · ${patches.length} صفحة · ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      failedBatches += 1;
      failed.push({ index, bookId: job.bookId, pages: job.pages.map((page) => page.physicalPage), error: String(error.message || error) });
      console.log(`  ✗ ${job.bookId} دفعة ${index + 1} · ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

console.log('\n=== الملخص ===');
console.log(`صفحات وُصفت: ${appliedCount} · دفعات فاشلة: ${failedBatches}`);
for (const item of failed) console.log(`  ! ${item.bookId} ${item.pages.join(',')}: ${item.error}`);
console.log('شغّل: node scripts/apply-page-patches.mjs');
if (failedBatches) process.exitCode = 2;
