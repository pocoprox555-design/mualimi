import assert from 'node:assert';
import test from 'node:test';
import http from 'node:http';
import { streamCompletion } from '../lib/provider.mjs';

function mock(routes) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => routes(req, res, body));
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
const ep = (p) => `http://127.0.0.1:${p}/v1`;
async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

test('بثّ SSE يُجمّع النص', async () => {
  const { srv, port } = await mock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"مرحبا "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"يا رحما"},"finish_reason":"stop"}]}\n\n');
    res.end();
  });
  try {
    const evs = await collect(streamCompletion({ endpoint: ep(port), key: 'k', model: 'm', messages: [], maxTokens: 10 }));
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'مرحبا يا رحما');
    assert.ok(evs.some((e) => e.type === 'done'));
  } finally { srv.close(); }
});

test('رد JSON عادي يُقبل كبديل', async () => {
  const { srv, port } = await mock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'جواب كامل' }, finish_reason: 'stop' }] }));
  });
  try {
    const evs = await collect(streamCompletion({ endpoint: ep(port), key: 'k', model: 'm', messages: [], maxTokens: 10 }));
    assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'جواب كامل');
  } finally { srv.close(); }
});

test('خطأ 500 يُعاد تلقائيًا ثم ينجح', async () => {
  let n = 0;
  const { srv, port } = await mock((req, res) => {
    n++;
    if (n === 1) { res.writeHead(500); res.end('busy'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  try {
    const evs = await collect(streamCompletion({ endpoint: ep(port), key: 'k', model: 'm', messages: [], maxTokens: 10 }));
    assert.equal(n, 2);
    assert.ok(evs.some((e) => e.type === 'text'));
  } finally { srv.close(); }
});

test('خطأ 401 يفشل فورًا بدون إعادة', async () => {
  let n = 0;
  const { srv, port } = await mock((req, res) => { n++; res.writeHead(401); res.end('no'); });
  try {
    await assert.rejects(() => collect(streamCompletion({ endpoint: ep(port), key: 'k', model: 'm', messages: [], maxTokens: 10 })), /UPSTREAM_HTTP_401/);
    assert.equal(n, 1);
  } finally { srv.close(); }
});
