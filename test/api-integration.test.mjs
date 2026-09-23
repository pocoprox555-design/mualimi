import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import connect from 'connect'
import { installAgentHttp } from '../lib/agent-http.mjs'
import { parseSseChunk } from '../lib/sse-protocol.mjs'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) { return new Promise((resolve) => server.close(() => resolve())) }

function providerSse(events) {
  return events.map((event) => `data: ${JSON.stringify({ choices: [{ delta: event.delta || {}, finish_reason: event.finishReason || null }] })}\n\n`).join('') + 'data: [DONE]\n\n'
}

test('local API streams a safe tool loop and forwards provider headers/config', async () => {
  const upstreamCalls = []
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body)
      upstreamCalls.push({ headers: req.headers, payload })
      const isFirst = upstreamCalls.length === 1
      const stream = isFirst
        ? providerSse([
            { delta: { tool_calls: [{ index: 0, id: 'title-1', function: { name: 'set_conversation_title', arguments: '{"title":"درس جديد"}' } }] } },
            { delta: {}, finishReason: 'tool_calls' },
          ])
        : providerSse([
            { delta: { content: 'شرح من الوكيل' } },
            { delta: {}, finishReason: 'stop' },
          ])
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(stream)
    })
  })
  const upstreamPort = await listen(upstream)
  const app = connect()
  installAgentHttp(app, { env: { AI_API_KEY: 'server-secret', AI_ENDPOINT: `http://127.0.0.1:${upstreamPort}/v1`, AI_MODEL: 'mock-model', NODE_ENV: 'test' } })
  const server = http.createServer(app)
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-API-Key': 'device-secret', 'X-AI-Model': 'device-model' },
      body: JSON.stringify({ branch: 'أدبي', messages: [{ role: 'user', content: [{ type: 'text', text: 'اشرحي هذا' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'a'.repeat(80)}` } }] }] }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    const { events } = parseSseChunk(text)
    assert.ok(events.some((event) => event.event === 'tool:running'))
    assert.ok(events.some((event) => event.event === 'final' && event.data.content === 'شرح من الوكيل'))
    assert.ok(events.some((event) => event.event === 'run:done'))
    assert.doesNotMatch(text, /tool_calls|<tool_call>|function=|page: 41/)
    assert.equal(upstreamCalls[0].headers.authorization, 'Bearer device-secret')
    assert.equal(upstreamCalls[0].headers['x-client-name'], 'mualimi')
    assert.equal(upstreamCalls[0].payload.model, 'device-model')
    assert.equal(upstreamCalls[0].payload.messages.at(-1).content[1].type, 'image_url')
  } finally {
    await close(server)
    await close(upstream)
  }
})

test('agent runtime deadline aborts a hanging provider without waiting forever', async () => {
  const app = connect()
  const upstream = http.createServer((_req, res) => { /* يبقى الاتصال مفتوحاً حتى يلغيه الوكيل */ })
  const upstreamPort = await listen(upstream)
  installAgentHttp(app, { env: { AI_API_KEY: 'secret', AI_ENDPOINT: `http://127.0.0.1:${upstreamPort}/v1`, AI_AGENT_TIMEOUT_MS: '35', NODE_ENV: 'test' } })
  const server = http.createServer(app)
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'سؤال' }] }) })
    const text = await response.text()
    assert.match(text, /AGENT_RUNTIME_DEADLINE/)
  } finally {
    await close(server)
    await close(upstream)
  }
})
