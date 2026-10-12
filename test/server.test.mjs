import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// العمارة الجديدة: النموذج هو المخطّط والخادم مُنفّذ أدوات. لذلك لا يُجهّز
// الخادم مصادر مسبقة ولا يبحث قبل نداء النموذج. ما يبقى مضموناً:
//   • تعطّل المزوّد يُعلَن خطأً صريحاً ولا يُتحوّل إلى جواب محلّي ملفّق.
//   • لا نصّ يصل الطالبة (لا event: delta).
//   • النموذج يملك الأدوات وقواعد الصدق في تعليمات النظام.
test('تعطل النموذج لا يتحول إلى جواب أو fallback محلي', { timeout: 40_000 }, async () => {
  let upstreamCalls = 0;
  let upstreamBody = {};
  let upstreamPrompt = '';
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        upstreamBody = JSON.parse(raw);
        upstreamPrompt = String(upstreamBody.messages?.[0]?.content || '');
      } catch { /* assertion reports the missing prompt */ }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('mock failure');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AI_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1`,
      AI_MODEL: 'mock-model',
    },
    stdio: 'ignore',
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* الخادم قيد البدء */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server starts');
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session': 'test-no-local-answer', 'X-AI-API-Key': 'mualimi-test-key' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'في كتاب الفقه الشافعي، ماذا أتوقع بعد دراسة الوحدة؟' }], studentName: 'رحمة', curriculumTrack: 'ديني' }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    // الخطأ يُعلَن صراحةً ولا يُغطّى بجواب.
    assert.match(body, /event: error/);
    assert.match(body, /UPSTREAM_HTTP_500/);
    // ولا نصّ illustrative يصل الطالبة.
    assert.doesNotMatch(body, /event: delta/);
    // النموذج يملك الأدوات: هذا ما يجعل الخادم «بيئة» لا «مُقرِّر».
    const toolNames = (upstreamBody.tools || []).map((tool) => tool.function?.name);
    assert.ok(toolNames.length >= 8, `expected the tool registry, got ${JSON.stringify(toolNames)}`);
    assert.ok(toolNames.includes('search_books') && toolNames.includes('read_page')
      && toolNames.includes('read_pdf_page') && toolNames.includes('read_pages_range'),
      'required curriculum tools are not offered');
    // وقواعد الصدق موجودة في تعليمات النظام.
    assert.match(upstreamPrompt, /لا تسردي آية أو حديثاً/);
    assert.match(upstreamPrompt, /قواعد الصدق/);
    // لا اقتباس من صفحة لم تُفتح: النص غير المقتطع ممنوع إعادة صياغته.
    assert.match(upstreamPrompt, /UNTRUSTED/);
    // ثلاث محاولات ثم إعلان الفشل (لا صمت ولا حلقة لا نهائية).
    assert.equal(upstreamCalls, 3, `expected 3 upstream attempts, got ${upstreamCalls}`);
  } finally {
    app.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
