// Runs mined deep-page cases against a live server and scores whether the app
// actually REACHED the target page (not merely answered plausibly).
//
// Usage: node scripts/run-retrieval-probes.mjs [--cases file] [--shard i/n] [--out file]
//
// Scoring per case:
//   reachedPage   - a citation names the expected book AND the expected physical
//                   or printed page. This is the real retrieval signal.
//   answeredTerms - share of the page's distinctive terms present in the answer.
//   evidence      - evidence type/status of the citation used.
//   latency       - firstTokenMs and total ms.
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeAr } from '../lib/text.mjs';

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(flag('base', process.env.PROBE_BASE || 'http://127.0.0.1:3000'));
const casesPath = String(flag('cases', '.probe-cases.json'));
const outPath = String(flag('out', '.probe-results.json'));
const shard = String(flag('shard', '0/1'));
const [shardIndex, shardCount] = shard.split('/').map((n) => Number(n) || 1);

const all = JSON.parse(await readFile(casesPath, 'utf8'));
const cases = all.filter((_, i) => i % shardCount === shardIndex - 1);

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let name = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    let parsed = null;
    try { parsed = JSON.parse(data.join('\n')); } catch { parsed = data.join('\n'); }
    events.push({ name, data: parsed });
  }
  return events;
}

function samePage(citation, testCase) {
  if (!citation || citation.bookId !== testCase.bookId) return false;
  const physical = Number(citation.physicalPage);
  const printed = citation.printedPage == null ? null : Number(citation.printedPage);
  return physical === testCase.physicalPage
    || (testCase.printedPage != null && printed === testCase.printedPage);
}

async function probe(testCase) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PROBE_TIMEOUT')), 240_000);
  try {
    const response = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: testCase.question }],
        studentName: 'رحمة',
        curriculumTrack: 'ديني',
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const events = parseSse(raw);
    let answer = '';
    let citations = [];
    let steps = [];
    let done = null;
    let error = null;
    for (const event of events) {
      if (event.name === 'delta') answer += event.data?.text || '';
      else if (event.name === 'citations') citations = event.data?.items || [];
      else if (event.name === 'step') steps.push(`${event.data?.label}${event.data?.detail ? ` — ${event.data.detail}` : ''}`);
      else if (event.name === 'done') done = event.data;
      else if (event.name === 'error') error = event.data?.error || event.data;
    }
    const matched = citations.find((citation) => samePage(citation, testCase));
    const normalizedAnswer = normalizeAr(answer);
    const hitTerms = testCase.keyTerms.filter((term) => normalizedAnswer.includes(normalizeAr(term)));
    return {
      caseId: testCase.caseId,
      bookId: testCase.bookId,
      subject: testCase.subject,
      position: testCase.position,
      physicalPage: testCase.physicalPage,
      printedPage: testCase.printedPage,
      keyTerms: testCase.keyTerms,
      reachedPage: Boolean(matched),
      termHitRatio: testCase.keyTerms.length ? hitTerms.length / testCase.keyTerms.length : 0,
      citationCount: citations.length,
      citedBooks: [...new Set(citations.filter((c) => c.bookId).map((c) => `${c.bookId} p${c.physicalPage}`))],
      matchedCitation: matched
        ? { id: matched.id, evidenceType: matched.evidenceType, evidenceStatus: matched.evidenceStatus || matched.status, sourceType: matched.sourceType, quotableReliable: matched.quotableReliable }
        : null,
      usedWeb: citations.some((c) => c.sourceType === 'web'),
      firstTokenMs: done?.firstTokenMs ?? null,
      finish: done?.finish ?? null,
      totalMs: Date.now() - started,
      steps,
      error,
      answerPreview: answer.replace(/\s+/g, ' ').slice(0, 700),
    };
  } catch (error) {
    return {
      caseId: testCase.caseId,
      bookId: testCase.bookId,
      position: testCase.position,
      physicalPage: testCase.physicalPage,
      printedPage: testCase.printedPage,
      keyTerms: testCase.keyTerms,
      reachedPage: false,
      termHitRatio: 0,
      totalMs: Date.now() - started,
      error: String(error?.message || error),
      answerPreview: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const [i, testCase] of cases.entries()) {
  const result = await probe(testCase);
  results.push(result);
  console.log(
    `${String(i + 1).padStart(2)}/${cases.length} ${result.reachedPage ? 'HIT ' : 'MISS'} ${result.caseId.padEnd(34)}`
    + ` terms=${(result.termHitRatio * 100).toFixed(0).padStart(3)}% ft=${String(result.firstTokenMs ?? '-').padStart(6)}ms`
    + ` ev=${result.matchedCitation?.evidenceType || '-'}${result.usedWeb ? ' +web' : ''}`
    + `${result.error ? ` ERR=${result.error}` : ''}`,
  );
}

await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
const hits = results.filter((r) => r.reachedPage).length;
const full = results.filter((r) => r.termHitRatio >= 0.99).length;
const web = results.filter((r) => r.usedWeb).length;
console.log(`\nshard ${shard}: cases=${results.length} reachedPage=${hits} allTerms=${full} webUsed=${web} -> ${outPath}`);