import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRunner } from '../lib/agent-runner.mjs'
import { encodeSseEvent } from '../lib/sse-protocol.mjs'

function streamResponse(parts) {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
        controller.close()
      },
    }),
  }
}

function writer(events) {
  return { emit: (event, data) => events.push({ event, data }), end: (event, data) => events.push({ event, data }) }
}

// ── Test 1: streaming tool turn + continuation ──
// requestToolTurn now returns streaming results (stream: true).
// When there are no tool calls, draftContent IS the final answer.
// Continuation re-enters the loop via requestToolTurn with "تابع" appended.
test('model autonomously calls tools, receives results, and continues long final output', async () => {
  const events = []
  let turn = 0
  const provider = {
    async requestToolTurn() {
      turn += 1
      if (turn === 1) {
        // First turn: model calls a tool
        return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'list_materials', arguments: {}, rawArguments: '{}' }] }
      }
      if (turn === 2) {
        // Second turn: network error → triggers retry
        throw new Error('fetch failed')
      }
      if (turn === 3) {
        // Retry succeeds: model produces partial output, finish_reason = length
        return { content: 'الجزء الأول ', finishReason: 'length', toolCalls: [] }
      }
      // Turn 4 (continuation): model finishes
      return { content: 'الجزء الثاني', finishReason: 'stop', toolCalls: [] }
    },
    async requestStructuredTurn() { throw new Error('not expected') },
    async requestFinal() {
      throw new Error('requestFinal should not be called — streaming tool turn replaces it')
    },
  }
  const opened = new Map([['book:41', { bookId: 'book', title: 'كتاب', subject: 'مادة', pageNumber: 41 }]])
  const runner = new AgentRunner({
    provider,
    toolDefinitions: [{ type: 'function', function: { name: 'list_materials', parameters: { type: 'object' } } }],
    toolHandlers: { list_materials: async () => ({ folder: 'المواد', materials: [{ title: 'كتاب' }] }) },
    maxRuntimeMs: 10_000,
  })
  const result = await runner.run({ messages: [{ role: 'user', content: 'سؤال' }], systemPrompt: 'تعليمات', writer: writer(events), openedCitations: opened })
  assert.equal(result.finalText, 'الجزء الأول الجزء الثاني')
  assert.ok(events.some((item) => item.event === 'tool:running'))
  assert.ok(events.some((item) => item.event === 'tool:completed'))
  assert.ok(events.some((item) => item.event === 'status' && item.data.type === 'retrying'))
  assert.ok(events.some((item) => item.event === 'status' && item.data.type === 'continuing'))
  assert.ok(events.some((item) => item.event === 'citation' && item.data.pageNumber === 41))
})

// ── Test 2: structured fallback ──
// When native tools fail, structured turn is used. The 'final' action
// sets draftContent directly — no requestFinal call needed.
test('falls back to structured actions when native tools are unsupported', async () => {
  let nativeCalls = 0
  let structuredCalls = 0
  const provider = {
    async requestToolTurn() {
      nativeCalls += 1
      const error = new Error('unknown field tools')
      error.toolsUnsupported = true
      throw error
    },
    async requestStructuredTurn() {
      structuredCalls += 1
      return structuredCalls === 1
        ? { action: { type: 'tool', name: 'list_materials', arguments: {} } }
        : { action: { type: 'final', content: 'الإجابة' }, finishReason: 'stop' }
    },
    async requestFinal() {
      throw new Error('requestFinal should not be called in structured mode')
    },
  }
  const events = []
  const runner = new AgentRunner({ provider, toolDefinitions: [], toolHandlers: { list_materials: async () => ({ materials: [] }) } })
  const result = await runner.run({ messages: [{ role: 'user', content: 'سؤال' }], systemPrompt: 'تعليمات', writer: writer(events) })
  assert.equal(nativeCalls, 1)
  assert.ok(structuredCalls >= 2)
  assert.equal(result.finalText, 'الإجابة')
  assert.ok(events.some((item) => item.event === 'status' && item.data.type === 'provider_fallback'))
})

test('aborts before invoking provider', async () => {
  const controller = new AbortController()
  controller.abort()
  const runner = new AgentRunner({
    provider: { requestToolTurn: async () => { throw new Error('must not run') } },
    toolDefinitions: [], toolHandlers: {},
  })
  await assert.rejects(() => runner.run({ messages: [{ role: 'user', content: 'سؤال' }], systemPrompt: 'تعليمات', writer: writer([]), signal: controller.signal }), /AbortError/)
})

test('cancellation reaches a provider that is still generating', async () => {
  const controller = new AbortController()
  let called = false
  const provider = {
    requestToolTurn: async ({ signal }) => {
      called = true
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
      return { content: '', finishReason: 'stop', toolCalls: [] }
    },
  }
  const runner = new AgentRunner({ provider, toolDefinitions: [], toolHandlers: [], maxRuntimeMs: 2_000 })
  const promise = runner.run({ messages: [{ role: 'user', content: 'سؤال' }], systemPrompt: 'تعليمات', writer: writer([]), signal: controller.signal })
  setTimeout(() => controller.abort(), 15)
  await assert.rejects(promise, /AbortError/)
  assert.equal(called, true)
})
