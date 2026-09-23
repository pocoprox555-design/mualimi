import { normalizeMessage } from './message-normalizer.mjs'
import { parseSseStream } from './sse-protocol.mjs'

function parseJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function camelCase(value) {
  return String(value || '').replace(/[_-](.)/g, (_, character) => character.toUpperCase())
}

export function parseTextToolCalls(content) {
  const text = String(content || '')
  const calls = []
  const pattern = /<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/tool_call>/gi
  for (const match of text.matchAll(pattern)) {
    const args = {}
    const parameters = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi
    for (const parameter of match[2].matchAll(parameters)) {
      const key = camelCase(parameter[1].trim())
      const raw = parameter[2].trim()
      let value = raw
      try { value = JSON.parse(raw) } catch {
        if (/^-?\d+(?:\.\d+)?$/.test(raw)) value = Number(raw)
      }
      args[key] = value
    }
    calls.push({ id: `text_call_${calls.length + 1}`, name: match[1].trim(), arguments: args, rawArguments: JSON.stringify(args) })
  }
  return { content: text.replace(pattern, '').trim(), toolCalls: calls }
}

function providerError(status, body) {
  const error = new Error(`UPSTREAM_HTTP_${status}`)
  error.status = status
  error.providerMessage = String(body || '').slice(0, 2_000)
  error.retryable = status === 408 || status === 409 || status === 429 || status >= 500
  error.toolsUnsupported = status === 400 && /tool|function|unsupported|unknown field|parallel_tool/i.test(error.providerMessage)
  error.contextOverflow = status === 400 && /context|token|maximum.*length|too long/i.test(error.providerMessage)
  return error
}

function completionUrl(endpoint) {
  const base = String(endpoint || '').replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

async function postChat({ fetchImpl, endpoint, key, body, signal }) {
  const response = await fetchImpl(completionUrl(endpoint), {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'X-Client-Name': 'mualimi',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw providerError(response.status, text)
  }
  return response
}

export function parseFinishReason(choice) {
  return choice?.finish_reason || choice?.message?.finish_reason || choice?.reason || null
}

export function extractAssistantPayload(choice) {
  const message = choice?.message || {}
  const nativeCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const parsedText = parseTextToolCalls(message.content || '')
  const toolCalls = nativeCalls.length
    ? nativeCalls.map((call, index) => ({
        id: call.id || `call_${index + 1}`,
        name: call.function?.name || call.name || '',
        arguments: parseJson(call.function?.arguments || call.arguments || '{}') || {},
        rawArguments: call.function?.arguments || call.arguments || '{}',
      }))
    : parsedText.toolCalls
  return {
    content: parsedText.content,
    finishReason: parseFinishReason(choice),
    toolCalls,
  }
}

export function extractStructuredAction(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.final === 'string') return { type: 'final', content: parsed.final }
  if (typeof parsed.action !== 'string') return null
  return { type: 'tool', name: parsed.action, arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {} }
}

export function isRetryableProviderError(error) {
  if (!error || error.name === 'AbortError') return false
  if (error.retryable) return true
  return /timeout|temporar|rate|reset|econnreset|enotfound|eai_again|fetch failed|network|overload|unavailable|internal|service error|upstream|too many/i.test(String(error.message || error))
}

async function collectJsonTurn(response) {
  const payload = await response.json()
  return extractAssistantPayload(payload?.choices?.[0] || {})
}

export async function collectStreamingToolTurn(response, signal) {
  const contentType = String(response.headers?.get?.('content-type') || '')
  if (!response.body || (contentType && !contentType.includes('event-stream'))) return collectJsonTurn(response)

  let content = ''
  let finishReason = null
  const calls = new Map()
  for await (const event of parseSseStream(response, { signal })) {
    const choice = event.data?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (delta.content) content += String(delta.content)
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = call.index ?? calls.size
      const current = calls.get(index) || { id: '', name: '', rawArguments: '' }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name = call.function.name
      if (call.function?.arguments) current.rawArguments += call.function.arguments
      calls.set(index, current)
    }
    if (choice.finish_reason) {
      finishReason = choice.finish_reason
      // بعض البوابات لا ترسل [DONE] أو لا تغلق اتصال SSE بعد آخر choice.
      // إشارة النهاية كافية لأن كل delta وtool call سبق أن وصل.
      break
    }
  }

  const nativeCalls = [...calls.values()].filter((call) => call.name).map((call, index) => ({
    id: call.id || `stream_call_${index + 1}`,
    name: call.name,
    arguments: parseJson(call.rawArguments) || {},
    rawArguments: call.rawArguments || '{}',
  }))
  const parsedText = nativeCalls.length ? { content, toolCalls: [] } : parseTextToolCalls(content)
  return { content: parsedText.content, toolCalls: nativeCalls.length ? nativeCalls : parsedText.toolCalls, finishReason }
}

function emitTextInChunks(content, onText) {
  if (!onText || !content) return
  const text = String(content)
  for (let index = 0; index < text.length; index += 160) onText(text.slice(index, index + 160))
}

export function createProviderAdapter({ fetchImpl = fetch, endpoint, key, model }) {
  return {
    model,

    async requestToolTurn({ messages, tools, maxTokens, signal, onText }) {
      const response = await postChat({
        fetchImpl,
        endpoint,
        key,
        signal,
        body: {
          model,
          messages: messages.map((message) => normalizeMessage(message, { allowSystem: true })),
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          max_tokens: maxTokens,
          stream: true,
        },
      })
      const result = await collectStreamingToolTurn(response, signal)
      // لا نمرر النص قبل معرفة ما إذا كان جزءاً من استدعاء أداة أو بروتوكولاً
      // نصياً. بذلك لا يظهر XML/JSON في واجهة رحما ولو أخطأ المزوّد.
      if (!result.toolCalls.length) emitTextInChunks(result.content, onText)
      return result
    },

    async requestStructuredTurn({ messages, toolNames, maxTokens, signal }) {
      const instruction = {
        role: 'system',
        content: [
          'أخرج JSON صالحاً فقط، بلا Markdown أو شرح خارجي.',
          `لاستدعاء أداة استخدم: {"action":"اسم الأداة","arguments":{}}. الأدوات المتاحة: ${toolNames.join(', ') || 'لا توجد أدوات'}.`,
          'عندما تكتمل الإجابة استخدم: {"final":"نص الإجابة النهائي"}.',
        ].join('\n'),
      }
      const response = await postChat({
        fetchImpl,
        endpoint,
        key,
        signal,
        body: { model, messages: [instruction, ...messages.map((message) => normalizeMessage(message, { allowSystem: true }))], max_tokens: maxTokens, stream: false },
      })
      const choice = (await response.json())?.choices?.[0] || {}
      return { action: extractStructuredAction(choice.message?.content), finishReason: parseFinishReason(choice) }
    },

  }
}
