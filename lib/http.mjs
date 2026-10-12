import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// ─── التتبّع والسجل ───────────────────────────────────────────────
// السجل القديم كان يكتب عنواناً قصيراً لكل مرحلة فقط، فلا يمكن بعد انتهاء
// الجلسة معرفة أي مقاطع استُرجعت ولا أي prompt أُرسل فعلاً — ومع ذلك لا يمكن
// تشخيص إجابة خاطئة. هنا يُفتح معرّف لكل طلب، وتُسجَّل الاسترجاعات والبرومبت
// والتصحيحات مرتّبةً به، فتصبح الإجابة قابلة للتشخيص حرفياً.
const REQUEST_LOGS = new Map();
const REQUEST_LOG_LIMIT = 200;

export function newRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// أي مفتاح يظهر في السجل يُلغى فوراً من المزوّد؛ فالتمويه هنا إجراء افتراضي.
const SECRET_PATTERNS = [
  /\boc_sk_[A-Za-z0-9_-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/gi,
  /\bb64:[A-Za-z0-9+/=]+/gi,
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
  /("?(?:x-ai-api-key|authorization)"?\s*[:=]\s*"?)[^"\s,]+/gi,
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => (prefix ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…[truncated]` : text;
}

function logLine(requestId, level, message, meta) {
  const stamp = new Date().toISOString();
  const tag = requestId ? `[${requestId}] ` : '';
  const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${stamp}] ${tag}${message}${extra}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function childLogger(requestId, context = {}) {
  const base = { ...context };
  return {
    info: (message, meta) => logLine(requestId, 'info', message, { ...base, ...meta }),
    warn: (message, meta) => logLine(requestId, 'warn', message, { ...base, ...meta }),
    error: (message, meta) => logLine(requestId, 'error', message, { ...base, ...meta }),
    debug: (message, meta) => logLine(requestId, 'debug', message, { ...base, ...meta }),
  };
}

export function logRetrieval(requestId, info = {}) {
  const sources = (info.sources || []).map((source) => ({
    id: source.id,
    bookId: source.bookId,
    printedPage: source.printedPage ?? null,
    physicalPage: source.physicalPage ?? null,
    score: source.score ?? null,
    evidenceStatus: source.evidenceStatus || source.status || null,
    evidenceType: source.evidenceType || null,
    quotableReliable: Boolean(source.quotableReliable),
  }));
  logLine(requestId, 'info', 'retrieval', {
    query: redactSecrets(String(info.query || '').slice(0, 200)),
    expandedTerms: (info.expandedTerms || []).slice(0, 16),
    candidateCount: info.candidateCount ?? null,
    hits: info.hits ?? sources.length,
    sources,
    elapsedMs: info.elapsedMs ?? null,
    budget: info.budget ? {
      maxSources: info.budget.maxSources,
      evidenceChars: info.budget.evidenceChars,
      maxCited: info.budget.maxCited,
    } : null,
  });
  remember(requestId, { sources, query: String(info.query || '').slice(0, 200), retrievedAt: Date.now() });
}

export function logPrompt(requestId, info = {}) {
  const perMessage = (info.perMessage || []).map((message) => ({ role: message.role, chars: message.chars }));
  const meta = {
    model: info.model,
    maxTokens: info.maxTokens ?? null,
    temperature: info.temperature ?? null,
    messageCount: info.messageCount ?? perMessage.length,
    chars: info.chars ?? perMessage.reduce((sum, message) => sum + (message.chars || 0), 0),
    perMessage,
  };
  logLine(requestId, 'info', 'prompt', meta);
  remember(requestId, { prompt: meta });
  // النص الكامل اختياري (متغيّر بيئة) لأنه يحتوي نص الكتب كاملاً.
  if (info.full || process.env.LOG_FULL_PROMPT === '1') {
    logLine(requestId, 'info', 'prompt.full', { messages: redactSecrets(JSON.stringify(info.messages || [])).slice(0, 8_000) });
  }
}

export function logEvidence(requestId, info = {}) {
  logLine(requestId, 'info', 'evidence', {
    blockChars: info.blockChars ?? null,
    sourceIds: info.sourceIds || [],
    truncatedSources: info.truncatedSources || [],
    images: info.images ?? 0,
  });
  remember(requestId, { evidence: { blockChars: info.blockChars ?? null, sourceIds: info.sourceIds || [] } });
}

function remember(requestId, patch) {
  if (!requestId) return;
  const existing = REQUEST_LOGS.get(requestId) || { requestId, createdAt: Date.now() };
  REQUEST_LOGS.set(requestId, { ...existing, ...patch, updatedAt: Date.now() });
  while (REQUEST_LOGS.size > REQUEST_LOG_LIMIT) {
    const oldest = REQUEST_LOGS.keys().next().value;
    REQUEST_LOGS.delete(oldest);
  }
}

export function recordExchange(requestId, entry = {}) {
  remember(requestId, {
    question: String(entry.question || '').slice(0, 500),
    intent: entry.plan?.intent ?? null,
    finish: entry.finish ?? null,
    firstTokenMs: entry.firstTokenMs ?? null,
    totalMs: entry.totalMs ?? null,
    corrections: entry.corrections || [],
  });
}

export function getRequestLog(requestId) {
  const entry = REQUEST_LOGS.get(requestId);
  if (!entry) return null;
  REQUEST_LOGS.delete(requestId);
  return entry;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res, status, data, headers = {}) {
  if (res.writableEnded) return false;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
  return true;
}

export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim() || '{}';
  try { return JSON.parse(raw); } catch { throw new Error('BAD_JSON'); }
}

export function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

export function sseSend(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  return true;
}

export function heartbeat(res, interval = 12_000) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return clearInterval(timer);
    res.write(': keep-alive\n\n');
  }, interval);
  return () => clearInterval(timer);
}

export async function serveStatic(req, res, root) {
  const url = new URL(req.url || '/', 'http://localhost');
  let requestPath;
  try { requestPath = decodeURIComponent(url.pathname); } catch { sendJson(res, 400, { error: 'BAD_PATH' }); return true; }
  if (requestPath === '/') requestPath = '/index.html';
  const normalizedRoot = path.resolve(root);
  const file = path.resolve(normalizedRoot, `.${requestPath}`);
  if (file !== normalizedRoot && !file.startsWith(`${normalizedRoot}${path.sep}`)) {
    sendJson(res, 403, { error: 'FORBIDDEN' });
    return true;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const extension = path.extname(file).toLowerCase();
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  } catch { return false; }
}
