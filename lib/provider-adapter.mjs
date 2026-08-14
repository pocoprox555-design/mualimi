function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return { role: 'user', content: String(message || '') }
  const role = ['system', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'user'
  const result = { role, content: Array.isArray(message.content) ? message.content : String(message.content || '') }
  if (message.tool_call_id) result.tool_call_id = message.tool_call_id
  if (Array.isArray(message.tool_calls)) result.tool_calls = message.tool_calls
  return result
}

function parseJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function camelCase(value) {
  return String(value || '').replace(/[_-](.)/g, (_, character) => character.toUpperCase())
}

function parseTextToolCalls(content) {
  const text = String(content || '')
  const toolCalls = []
  const pattern = /<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/tool_call>/gi
  for (const match of text.matchAll(pattern)) {
    const name = match[1].trim()
    const argumentsObject = {}
    const parameters = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi
    for (const parameter of match[2].matchAll(parameters)) {
      const key = camelCase(parameter[1].trim())
      const raw = parameter[2].trim()
      let value = raw
      try { value = JSON.parse(raw) } catch {
        if (/^\d+$/.test(raw)) value = Number(raw)
      }
      argumentsObject[key] = value
    }
    toolCalls.push({
      id: `text_call_${toolCalls.length + 1}`,
      name,
      arguments: argumentsObject,
      rawArguments: JSON.stringify(argumentsObject),
    })
  }
  return { content: text.replace(pattern, '').trim(), toolCalls }
}

function providerError(status, body) {
  const error = new Error(body || `HTTP_${status}`)
  error.status = status
  error.retryable = status === 408 || status === 429 || status >= 500
  error.toolsUnsupported = status === 400 && /tool|function|unsupported|unknown field/i.test(body || '')
  error.contextOverflow = status === 400 && /context|token|maximum.*length|too long/i.test(body || '')
  return error
}

async function postChat({ fetchImpl, endpoint, key, body, signal }) {
  const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw providerError(response.status, text.slice(0, 2000))
  }
  return response
}

export function parseFinishReason(choice) {
  return choice?.finish_reason || choice?.message?.finish_reason || choice?.reason || null
}

export function extractAssistantPayload(choice) {
  const calls = choice?.message?.tool_calls || []
  const parsedText = calls.length ? { content: String(choice?.message?.content || ''), toolCalls: [] } : parseTextToolCalls(choice?.message?.content || '')
  return {
    content: parsedText.content,
    finishReason: parseFinishReason(choice),
    toolCalls: Array.isArray(calls) && calls.length ? calls.map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name || call.name || '',
      arguments: parseJson(call.function?.arguments || call.arguments || '{}'),
      rawArguments: call.function?.arguments || call.arguments || '{}',
    })) : parsedText.toolCalls,
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
  if (!error) return false
  if (error.name === 'AbortError') return false
  if (error.retryable) return true
  // server_error / Upstream request failed تأتي أحيانًا كرمز 400 من البوابة
  // بينما السبب عابر في المزوّد الخلفي؛ نعيد المحاولة بدل إفشال الجولة كلها.
  return /timeout|temporar|rate|reset|econnreset|enotfound|eai_again|fetch failed|network|overload|unavailable|internal|service error|server_error|upstream|too many/i.test(String(error.message || error))
}

// ── Streaming tool turn ──────────────────────────────────────────────
// يجمع محتوى المساعد و tool_calls من بث SSE متدفق، ويمرر النص للعميل
// تدريجياً عبر onText (تأثير الكتابة الحرف بحرف). إذا ظهرت tool calls
// تُهمل النصوص المعلّقة (احتياط أمان) — استدعاء الأداة ليس رسالة للطالبة.
async function collectStreamingToolTurn(response, signal, { onText } = {}) {
  const body = response.body || response
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason = null
  let sawToolCall = false
  let pendingText = ''
  const SAFE_BUFFER = 60 // نحتفظ بآخر 60 حرفاً احتياطاً قبل أي tool call مباغت
  const toolCallsMap = new Map() // index → { id, name, rawArgs }

  const pushText = (text, flushAll = false) => {
    if (sawToolCall) { pendingText = ''; return }
    pendingText += text
    if (flushAll) {
      if (pendingText && onText) onText(pendingText)
      pendingText = ''
      return
    }
    if (pendingText.length > SAFE_BUFFER) {
      const sendLength = pendingText.length - SAFE_BUFFER
      if (onText) onText(pendingText.slice(0, sendLength))
      pendingText = pendingText.slice(sendLength)
    }
  }

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''

      for (const block of blocks) {
        if (!block.trim()) continue
        const lines = block.split(/\r?\n/)
        let eventData = ''
        for (const line of lines) {
          if (line.startsWith('data:')) {
            eventData += (eventData ? '\n' : '') + line.slice(5).replace(/^\s/, '')
          }
        }
        if (!eventData || eventData === '[DONE]') continue

        let parsed
        try { parsed = JSON.parse(eventData) } catch { continue }
        const choice = parsed.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}
        if (delta.content) {
          content += delta.content
          pushText(delta.content)
        }

        const toolDelta = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
        if (toolDelta.length) {
          sawToolCall = true
          pendingText = ''
          for (const tc of toolDelta) {
            const idx = tc.index ?? toolCallsMap.size
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                id: tc.id || `stream_call_${idx}`,
                name: tc.function?.name || '',
                rawArgs: tc.function?.arguments || '',
              })
            } else {
              const existing = toolCallsMap.get(idx)
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.rawArgs += tc.function.arguments
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    }
  } finally {
    reader.releaseLock()
  }

  // تفريغ ما تبقى من النص إن لم تظهر tool calls
  pushText('', true)

  const toolCalls = [...toolCallsMap.values()]
    .filter((tc) => tc.name)
    .map((tc, index) => ({
      id: tc.id || `stream_call_${index}`,
      name: tc.name,
      arguments: parseJson(tc.rawArgs) || {},
      rawArguments: tc.rawArgs || '{}',
    }))

  return { content, toolCalls, finishReason }
}

export function createProviderAdapter({ fetchImpl = fetch, endpoint, key, model }) {
  return {
    model,

    // ── Streaming tool turn ──────────────────────────────────────────
    // يستخدم stream: true ليجمع المحتوى و tool_calls معاً. إذا لم تكن
    // هناك tool calls، يكون content هو الإجابة النهائية مباشرة — لا حاجة
    // لاستدعاء ثانٍ. onText يمرر النص للعميل تدريجياً أثناء التوليد.
    async requestToolTurn({ messages, tools, maxTokens, signal, onText }) {
      const response = await postChat({
        fetchImpl,
        endpoint,
        key,
        signal,
        body: {
          model,
          messages: messages.map(normalizeMessage),
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: true,
          max_tokens: maxTokens,
          stream: true,
        },
      })
      const result = await collectStreamingToolTurn(response, signal, { onText })
      return { content: result.content, finishReason: result.finishReason, toolCalls: result.toolCalls }
    },

    async requestStructuredTurn({ messages, toolNames, maxTokens, signal }) {
      const instruction = {
        role: 'system',
        content: [
          'المزوّد لا يدعم tool calling الأصلي. تصرّف كوكيل وأخرج JSON فقط دون Markdown.',
          `لاستدعاء أداة: {"action":"اسم_الأداة","arguments":{...}}. الأدوات: ${toolNames.join(', ')}.`,
          'إذا اكتملت الإجابة: {"final":"نص الإجابة النهائي"}.',
        ].join('\n'),
      }
      const response = await postChat({
        fetchImpl,
        endpoint,
        key,
        signal,
        body: { model, messages: [instruction, ...messages.map(normalizeMessage)], max_tokens: maxTokens, stream: false },
      })
      const choice = (await response.json())?.choices?.[0] || {}
      return { action: extractStructuredAction(choice?.message?.content), finishReason: parseFinishReason(choice) }
    },

    async requestFinal({ messages, maxTokens, signal }) {
      return postChat({
        fetchImpl,
        endpoint,
        key,
        signal,
        body: { model, messages: messages.map(normalizeMessage), max_tokens: maxTokens, stream: true },
      })
    },
  }
}
