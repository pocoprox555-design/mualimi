import test from "node:test"
import assert from "node:assert/strict"
import { createProviderAdapter, extractAssistantPayload, extractStructuredAction, isRetryableProviderError } from "../lib/provider-adapter.mjs"

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) }
}

function sseResponse(sseText, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText))
        controller.close()
      },
    }),
    json: async () => { throw new Error("streaming") },
    text: async () => sseText,
  }
}

test("extracts native tool calls and structured actions", () => {
  const payload = extractAssistantPayload({
    finish_reason: "tool_calls",
    message: { tool_calls: [{ id: "1", function: { name: "open_page", arguments: '{"bookId":"book","pageNumber":41}' } }] },
  })
  assert.equal(payload.finishReason, "tool_calls")
  assert.deepEqual(payload.toolCalls[0].arguments, { bookId: "book", pageNumber: 41 })
  assert.deepEqual(extractStructuredAction('{"action":"list_materials","arguments":{}}'), { type: "tool", name: "list_materials", arguments: {} })
  assert.deepEqual(extractStructuredAction('{"final":"done"}'), { type: "final", content: "done" })
})

test("converts XML-style tool calls emitted as plain text", () => {
  const lt = String.fromCharCode(60)
  const gt = String.fromCharCode(62)
  const nl = String.fromCharCode(10)
  const xmlContent = lt + "tool_call" + gt + nl +
    lt + "function=open_pdf_pages_as_images" + gt + nl +
    lt + "parameter=book_id" + gt + "islamic-sixth-preparatory-2025" + lt + "/parameter" + gt + nl +
    lt + "parameter=page_numbers" + gt + "[122]" + lt + "/parameter" + gt + nl +
    lt + "/tool_call" + gt
  const payload = extractAssistantPayload({
    finish_reason: "tool_calls",
    message: { content: xmlContent },
  })
  assert.equal(payload.content, "")
  assert.equal(payload.toolCalls[0].name, "open_pdf_pages_as_images")
  assert.deepEqual(payload.toolCalls[0].arguments, { bookId: "islamic-sixth-preparatory-2025", pageNumbers: [122] })
})

test("streaming tool turn collects tool calls from SSE deltas", async () => {
  const sseText = [
    "data: " + "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"list_materials\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}",
    "data: " + "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}",
    "data: " + "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
    "data: [DONE]",
  ].join("\n\n") + "\n\n"
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return sseResponse(sseText)
  }
  const provider = createProviderAdapter({ fetchImpl, endpoint: "https://example.test", key: "secret", model: "model" })
  const result = await provider.requestToolTurn({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "list_materials", parameters: { type: "object" } } }], maxTokens: 200 })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, "list_materials")
  assert.equal(result.finishReason, "tool_calls")
  assert.equal(calls[0].body.stream, true)
  assert.equal(calls[0].body.tool_choice, "auto")
  assert.equal(calls[0].body.tools[0].function.name, "list_materials")
})

test("streaming tool turn collects text when no tool calls", async () => {
  const sseText = [
    "data: " + "{\"choices\":[{\"delta\":{\"content\":\"Hello \"},\"finish_reason\":null}]}",
    "data: " + "{\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":null}]}",
    "data: " + "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}",
    "data: [DONE]",
  ].join("\n\n") + "\n\n"
  const fetchImpl = async () => sseResponse(sseText)
  const provider = createProviderAdapter({ fetchImpl, endpoint: "https://example.test", key: "secret", model: "model" })
  const result = await provider.requestToolTurn({ messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 200 })
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.content, "Hello world")
  assert.equal(result.finishReason, "stop")
})

test("finishes a stream when the provider omits the DONE sentinel", async () => {
  let cancelled = false
  const sseText = [
    "data: " + "{\"choices\":[{\"delta\":{\"content\":\"رد سريع\"},\"finish_reason\":null}]}",
    "data: " + "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}",
  ].join("\n\n") + "\n\n"
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sseText)) },
      cancel() { cancelled = true },
    }),
  })
  const provider = createProviderAdapter({ fetchImpl, endpoint: "https://example.test", key: "secret", model: "model" })
  const result = await provider.requestToolTurn({ messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 200 })
  assert.equal(result.content, "رد سريع")
  assert.equal(result.finishReason, "stop")
  assert.equal(cancelled, true)
})

test("classifies retries, unsupported tools, and context overflow", async () => {
  assert.equal(isRetryableProviderError(new Error("fetch failed")), true)
  assert.equal(isRetryableProviderError(new Error("boom")), false)
  const unsupported = createProviderAdapter({ fetchImpl: async () => jsonResponse({ error: "unknown field tools" }, 400), endpoint: "https://example.test", key: "x", model: "m" })
  await assert.rejects(() => unsupported.requestToolTurn({ messages: [], tools: [], maxTokens: 1 }), (error) => error.toolsUnsupported === true)
  const overflow = createProviderAdapter({ fetchImpl: async () => jsonResponse({ error: "maximum context length exceeded" }, 400), endpoint: "https://example.test", key: "x", model: "m" })
  await assert.rejects(() => overflow.requestToolTurn({ messages: [], tools: [], maxTokens: 1 }), (error) => error.contextOverflow === true)
})
