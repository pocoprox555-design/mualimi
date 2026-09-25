import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

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
