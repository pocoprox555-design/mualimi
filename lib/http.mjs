// أدوات HTTP صغيرة: JSON + SSE + ملفات ثابتة. بصفر اعتماديات.
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

export function sendJson(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function readJsonBody(req, maxBytes = 6 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error('TOO_LARGE');
    chunks.push(c);
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
  if (res.writableEnded) return false;
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  return true;
}

export function heartbeat(res, intervalMs = 15_000) {
  const t = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
    res.write(': ping\n\n');
  }, intervalMs);
  return () => clearInterval(t);
}

export async function serveStatic(req, res, root) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep) && file !== root) { sendJson(res, 403, { error: 'FORBIDDEN' }); return true; }
  try {
    const st = await stat(file);
    if (st.isDirectory()) return false;
    const ext = path.extname(file).toLowerCase();
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  } catch { return false; }
}
