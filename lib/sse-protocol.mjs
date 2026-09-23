const LINE_BREAK = /\r?\n/
const BLOCK_BREAK = /\r?\n\r?\n/

function dataLines(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return String(text ?? '').split(LINE_BREAK)
}

export function encodeSseEvent(event, data) {
  let output = ''
  if (event) output += `event: ${String(event)}\n`
  if (data !== undefined) {
    for (const line of dataLines(data)) output += `data: ${line}\n`
  }
  return `${output}\n`
}

export function createSseWriter(res) {
  let closed = false
  const canWrite = () => !closed && res && !res.writableEnded && !res.destroyed
  return {
    emit(event, data) {
      if (!canWrite()) return false
      res.write(encodeSseEvent(event, data))
      return true
    },
    comment(text = '') {
      if (!canWrite()) return false
      res.write(`: ${String(text).replace(LINE_BREAK, ' ')}\n\n`)
      return true
    },
    end(event, data) {
      if (event) this.emit(event, data)
      if (res && !res.writableEnded) res.end()
      closed = true
    },
    get closed() { return closed || Boolean(res?.writableEnded || res?.destroyed) },
  }
}

function parseData(value) {
  if (value === '') return ''
  if (value === '[DONE]') return null
  try { return JSON.parse(value) } catch { return value }
}

export function parseSseChunk(buffer) {
  const blocks = String(buffer || '').split(BLOCK_BREAK)
  const remainder = blocks.pop() || ''
  const events = []
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = 'message'
    const lines = []
    for (const line of block.split(LINE_BREAK)) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message'
      else if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^\s/, ''))
    }
    if (!lines.length) continue
    const raw = lines.join('\n')
    events.push({ event, data: parseData(raw), raw })
  }
  return { events, remainder }
}

async function* streamBody(body, signal) {
  if (!body || typeof body.getReader !== 'function') throw new TypeError('SSE source must be a Response body or ReadableStream')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancelReader, { once: true })
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
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) {
      const parsed = parseSseChunk(`${tail}\n\n`)
      for (const event of parsed.events) {
        if (event.raw === '[DONE]') return
        yield event
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function* parseSseStream(source, { signal } = {}) {
  yield* streamBody(source?.body || source, signal)
}
