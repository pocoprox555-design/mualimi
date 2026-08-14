const NEWLINE = /\r?\n/

function toDataLines(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text).split(NEWLINE)
}

export function encodeSseEvent(event, data) {
  let payload = ''
  if (event) payload += `event: ${String(event)}\n`
  if (data !== undefined) {
    for (const line of toDataLines(data)) payload += `data: ${line}\n`
  }
  payload += '\n'
  return payload
}

export function createSseWriter(res) {
  return {
    emit(event, data) {
      if (!res || res.writableEnded) return
      res.write(encodeSseEvent(event, data))
    },
    comment(text) {
      if (!res || res.writableEnded) return
      res.write(`: ${String(text || '').replace(NEWLINE, ' ')}\n\n`)
    },
    end(event, data) {
      if (event) this.emit(event, data)
      if (res && !res.writableEnded) res.end()
    },
  }
}

function parseMaybeJson(value) {
  if (value === '') return ''
  try { return JSON.parse(value) } catch { return value }
}

export function parseSseChunk(buffer) {
  const events = []
  const blocks = buffer.split(/\r?\n\r?\n/)
  const remainder = blocks.pop() || ''
  for (const block of blocks) {
    const lines = block.split(NEWLINE)
    let event = 'message'
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        event = line.slice(6).trim() || 'message'
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''))
      }
    }
    const raw = dataLines.join('\n')
    events.push({ event, data: parseMaybeJson(raw), raw })
  }
  return { events, remainder }
}

async function* streamBody(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.remainder
      for (const event of parsed.events) {
        if (event.raw === '[DONE]') return
        yield event
      }
    }
    const tail = buffer.trim()
    if (tail) {
      const parsed = parseSseChunk(`${tail}\n\n`)
      for (const event of parsed.events) {
        if (event.raw === '[DONE]') return
        yield event
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* parseSseStream(source, { signal } = {}) {
  const body = source?.body || source
  if (!body || typeof body.getReader !== 'function') {
    throw new TypeError('SSE source must be a Response body or ReadableStream')
  }
  yield* streamBody(body, signal)
}

export function parseSseEventPayload(event) {
  if (!event || typeof event !== 'object') return { event: 'message', data: event }
  return {
    event: event.event || 'message',
    data: event.data,
    raw: event.raw,
  }
}
