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

test('تعطل النموذج لا يتحول إلى جواب أو fallback محلي', { timeout: 30_000 }, async () => {
  let upstreamCalls = 0;
  let upstreamMessages = [];
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { upstreamMessages = JSON.parse(raw).messages || []; } catch { /* test assertion reports missing prompt */ }
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('mock failure');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AI_API_KEY: 'mualimi-test-key',
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
      headers: { 'Content-Type': 'application/json', 'X-Session': 'test-no-local-answer' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'في كتاب الفقه الشافعي، ماذا أتوقع بعد دراسة الوحدة؟' }], studentName: 'رحمة', curriculumTrack: 'ديني' }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: error/);
    assert.match(body, /UPSTREAM_HTTP_500/);
    assert.doesNotMatch(body, /event: delta/);
    assert.match(body, /fiqh-shafii-deni-sixth/);
    assert.match(upstreamMessages[0]?.content || '', /رحمة تدرس السادس الإعدادي في مسار «ديني»/);
    assert.equal(upstreamCalls, 3);
  } finally {
    app.kill();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
