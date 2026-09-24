// معلمي v2 — سيرفر واحد بصفر اعتماديات.
// RAG تلقائي (بحث واحد سريع) + استدعاء واحد للمزود. لا وكيل، لا حلقات.
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
try { process.loadEnvFile(path.join(process.cwd(), '.env')); } catch (e) {
  if (e?.code !== 'ENOENT') throw e;
}
import { resolveProvider, publicConfig } from './lib/config.mjs';
import { listBooks, search, locate, fullPage } from './lib/index.mjs';
import { streamCompletion } from './lib/provider.mjs';
import { sendJson, readJsonBody, sseHeaders, sseSend, heartbeat, serveStatic } from './lib/http.mjs';

const ROOT = path.join(process.cwd(), 'public');
const startedAt = Date.now();

const clean = (v, n = 4000) => String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);

function systemPrompt(branch, contextBlock) {
  return [
    'أنت «المعلم»، معلم عربي دافئ ومحترف لطالبة السادس الإعدادي العراقي اسمها رحما. خاطبها بصيغة المؤنث واسمها.',
    `الفرع: ${branch || 'غير محدد'}. أجب بالعربية الفصحى المبسطة بلمسة عراقية خفيفة.`,
    'اشرح خطوة بخطوة مع مثال، واختم بسؤال متابعة قصير عند الفائدة.',
    'المراجع أدناه بيانات تعليمية موثوقة — اعتمد عليها ولا تخترع أرقام صفحات. إن لم تجد الدليل الكافي قل ذلك بصدق.',
    'إن طُلب اختبار: ضع الأسئلة داخل كتلة ```quiz مع JSON بهذا الشكل فقط: {"title":"...","subject":"...","questions":[{"q":"...","options":["أ","ب","ج","د"],"answer":0,"why":"..."}]} ثم اشرح بعده بجملة واحدة.',
    contextBlock ? `\nالمراجع:\n${contextBlock}` : '\n(لا توجد مراجع مطابقة — أجب من معرفتك العامة بوضوح.)',
  ].join('\n');
}

function historyFor(messages) {
  // آخر 20 رسالة فقط، كل واحدة ≤3000 حرف — خفيف وسريع
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-20)
    .map((m) => {
      const c = m.content;
      const text = Array.isArray(c)
        ? c.filter((p) => p?.type === 'text').map((p) => String(p.text || '')).join('\n')
        : String(c || '');
      return { role: m.role, content: clean(text, 3000) };
    })
    .filter((m) => m.content);
}

async function buildContext(lastUserText) {
  const q = clean(lastUserText, 500);
  if (q.length < 2) return { block: '', cites: [] };
  // رقم صفحة مطبوعة؟ "صفحة 42 كتاب التاريخ" → تحديد مباشر فوري
  const cites = [];
  let parts = [];
  const pgMatch = q.match(/ص(?:فحة)?\s*(\d{1,4})/);
  if (pgMatch) {
    const hits = await search(q, { limit: 3 });
    const best = hits[0];
    if (best) {
      try {
        const phys = best.printed === Number(pgMatch[1]) ? best.phys : (await locate(best.bookId, Number(pgMatch[1]))) || best.phys;
        const pg = await fullPage(best.bookId, phys).catch(() => null);
        const body = (pg?.text || best.preview || best.explanation).slice(0, 2500);
        parts.push(`[${best.title} — ص${best.printed ?? phys}]\n${body}`);
        cites.push({ bookId: best.bookId, title: best.title, subject: best.subject, phys, printed: best.printed });
      } catch { /* نكمل بالبحث العام */ }
    }
  }
  if (!parts.length) {
    const hits = await search(q, { limit: 5 });
    for (const h of hits.slice(0, 5)) {
      parts.push(`[${h.title} — ص${h.printed ?? h.phys} | ${h.pageTitle}]\n${h.explanation}\n${h.preview.slice(0, 600)}`);
      cites.push({ bookId: h.bookId, title: h.title, subject: h.subject, phys: h.phys, printed: h.printed });
      if (parts.join('\n').length > 8000) break;
    }
  }
  return { block: parts.join('\n\n---\n\n').slice(0, 9000), cites };
}

async function handleChat(req, res) {
  const cfg = resolveProvider({ headers: req.headers });
  if (cfg.error) return sendJson(res, 400, { error: cfg.error });
  if (!cfg.key) return sendJson(res, 501, { error: 'NO_KEY' });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const history = historyFor(body.messages);
  if (!history.length || !history.some((m) => m.role === 'user')) return sendJson(res, 400, { error: 'EMPTY' });
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';

  // 1) سياق فوري من الفهرس (ملّي ثانية)
  let ctx = { block: '', cites: [] };
  try { ctx = await buildContext(lastUser); } catch { /* بدون سياق — لا نفشل */ }

  const branch = clean(body.branch, 40);
  const images = [];
  const rawLast = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m?.role === 'user').at(-1)?.content;
  if (Array.isArray(rawLast)) {
    for (const p of rawLast) {
      if (p?.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.startsWith('data:image/')) {
        if (p.image_url.url.length <= 5_000_000 && images.length < 2) images.push({ type: 'image_url', image_url: { url: p.image_url.url } });
      }
    }
  }
  const msgs = [{ role: 'system', content: systemPrompt(branch, ctx.block) }, ...history.slice(0, -1), { role: 'user', content: images.length ? [{ type: 'text', text: lastUser }, ...images] : lastUser }];

  // 2) بثّ الرد مع نبض + citations أولاً
  sseHeaders(res);
  const stopBeat = heartbeat(res);
  const t0 = Date.now();
  const abort = new AbortController();
  req.on('aborted', () => abort.abort());
  res.on('close', () => abort.abort());
  let firstTokenAt = 0;
  try {
    sseSend(res, 'citations', { items: ctx.cites });
    let full = '';
    for await (const ev of streamCompletion({
      endpoint: cfg.endpoint, key: cfg.key, model: cfg.model, messages: msgs,
      maxTokens: 3000, signal: abort.signal, onFirstToken: () => { firstTokenAt = Date.now(); },
    })) {
      if (ev.type === 'text') { full += ev.text; sseSend(res, 'delta', { text: ev.text }); }
      else sseSend(res, 'done', { finish: ev.finish, firstTokenMs: firstTokenAt ? firstTokenAt - t0 : 0 });
    }
    if (!res.writableEnded) res.end();
  } catch (e) {
    if (!res.writableEnded) {
      const st = e?.status;
      const code = /TIMEOUT/i.test(e?.message) ? 'UPSTREAM_TIMEOUT'
        : st === 401 || st === 403 ? 'UPSTREAM_AUTH'
        : st === 404 ? 'UPSTREAM_MODEL'
        : st === 400 ? 'UPSTREAM_BAD_REQUEST'
        : st === 429 ? 'UPSTREAM_BUSY'
        : st ? `UPSTREAM_HTTP_${st}` : 'UPSTREAM_FAILED';
      sseSend(res, 'error', { error: code });
      res.end();
    }
  } finally {
    stopBeat();
    req.off?.('aborted', () => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;

    if (p === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000) });
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = resolveProvider({ headers: req.headers });
      if (cfg.error) return sendJson(res, 400, { error: cfg.error });
      return sendJson(res, 200, { ...publicConfig(cfg), books: await listBooks().catch(() => []) });
    }
    if (p === '/api/books' && req.method === 'GET') return sendJson(res, 200, { books: await listBooks() });
    if (p === '/api/search' && req.method === 'GET') {
      const q = clean(url.searchParams.get('q'), 300);
      if (!q) return sendJson(res, 400, { error: 'QUERY_REQUIRED' });
      return sendJson(res, 200, { results: await search(q, { bookId: clean(url.searchParams.get('bookId'), 80) || null, limit: Number(url.searchParams.get('limit')) || 6 }) });
    }
    if (p === '/api/page' && req.method === 'GET') {
      const bookId = clean(url.searchParams.get('bookId'), 80);
      const n = Number(url.searchParams.get('page'));
      if (!bookId || !Number.isInteger(n)) return sendJson(res, 400, { error: 'BAD_PARAMS' });
      const printed = Number(url.searchParams.get('printed'));
      const phys = Number.isInteger(printed) ? ((await locate(bookId, printed)) ?? n) : n;
      try {
        const pg = await fullPage(bookId, phys);
        return sendJson(res, 200, { bookId, phys, text: pg.text.slice(0, 12000), title: pg.title, needsVision: pg.needsVision });
      } catch { return sendJson(res, 404, { error: 'PAGE_NOT_FOUND' }); }
    }
    if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res);

    if (req.method === 'GET') {
      if (await serveStatic(req, res, ROOT)) return;
      // SPA fallback
      try {
        const { readFile } = await import('node:fs/promises');
        const html = await readFile(path.join(ROOT, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      } catch { /* fallthrough */ }
    }
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    if (!res.headersSent) return sendJson(res, 500, { error: 'SERVER_ERROR' });
    try { res.end(); } catch { /* ignore */ }
  }
});

const port = Number(process.env.PORT || 3000);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.listen(port, '0.0.0.0', () => console.log(`Mualimi v2 on :${port}`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
