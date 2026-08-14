/* ─────────────────────────────────────────────────────────────
   معلمي — عميل النموذج (Teacher)
   - يستدعي /api/chat عبر الوكيل الآمن مع Streaming.
   - يقرأ SSE باسم الحدث ويحافظ على الحمولة JSON.
   - يعتمد كليًا على مزوّد الذكاء الاصطناعي عبر الوكيل (لا ردود محلية).
   - تحديد معدل طلبات محلي + لا تقليل سياق في العميل.
   ───────────────────────────────────────────────────────────── */

;(function () {
  const MIN_GAP = 800

  let config = null
  let configPromise = null
  let lastSent = 0

  function getConfig(force) {
    if (config && !force) return Promise.resolve(config)
    if (configPromise) return configPromise
    configPromise = fetch('/api/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((c) => {
        config = { hasKey: !!c.hasKey, model: c.model || 'deepseek-v4-flash', streaming: !!c.streaming }
        return config
      })
      .catch(() => {
        config = { hasKey: false, model: 'deepseek-v4-flash', streaming: false }
        return config
      })
      .finally(() => { configPromise = null })
    return configPromise
  }

  function canSend() {
    return Date.now() - lastSent >= MIN_GAP
  }

  function markSent() {
    lastSent = Date.now()
  }

  const RETRY_DELAYS = [2000, 4000]
  // مهلة العميل يجب أن تغطي كامل وقت الوكيل (300 ثانية) + هامش للاتصال
  const REQUEST_TIMEOUT_MS = 310000

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function fetchWithTimeout(url, options, timeoutMs, signal) {
    const controller = new AbortController()
    const onUserAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onUserAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        throw new Error('TIMEOUT')
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onUserAbort)
    }
  }

  function isNetworkError(error) {
    if (!error) return false
    if (error instanceof TypeError) return true
    return /fetch failed|failed to fetch|networkerror|load failed|econnreset|etimedout|net::err/i.test(String(error.message || ''))
  }

  function classifyError(error) {
    if (!error) return 'no_retry'
    if (error.name === 'AbortError') return 'abort'
    const message = String(error.message || '')
    if (message === 'NO_KEY') return 'no_key'
    if (message === 'rate_limit') return 'retry'
    if (message === 'TIMEOUT') return 'retry'
    if (/^http_5\d\d$/.test(message)) return 'retry'
    if (/^http_4\d\d$/.test(message)) return 'no_retry'
    if (isNetworkError(error)) return 'retry'
    return 'no_retry'
  }

  function parseEventBlock(block) {
    const event = { event: 'message', data: '' }
    for (const line of String(block || '').split(/\r?\n/)) {
      if (line.startsWith('event:')) event.event = line.slice(6).trim() || 'message'
      else if (line.startsWith('data:')) event.data += (event.data ? '\n' : '') + line.slice(5).replace(/^\s/, '')
    }
    if (!event.data) return null
    if (event.data === '[DONE]') return { event: 'done', data: null }
    try {
      event.data = JSON.parse(event.data)
    } catch {
      // keep raw string
    }
    return event
  }

  async function* parseStream(res, { signal } = {}) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          const event = parseEventBlock(block)
          if (event) yield event
        }
      }
      const tail = buffer.trim()
      if (tail) {
        const event = parseEventBlock(`${tail}\n\n`)
        if (event) yield event
      }
    } finally {
      reader.releaseLock()
    }
  }

  async function requestWithRetry(messages, opts) {
    const { signal } = opts
    const body = JSON.stringify({
      messages,
      memory: opts.memory || '',
      branch: opts.branch || '',
      mode: opts.mode || 'normal',
    })
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const res = await fetchWithTimeout('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }, REQUEST_TIMEOUT_MS, signal)

        if (res.status === 501) {
          const json = await res.json().catch(() => ({}))
          if (json.code === 'NO_KEY') throw new Error('NO_KEY')
          throw new Error('http_501')
        }
        if (res.status === 429) throw new Error('rate_limit')
        if (!res.ok) throw new Error('http_' + res.status)
        return res
      } catch (error) {
        const kind = classifyError(error)
        if (kind === 'abort' || kind === 'no_key' || kind === 'no_retry') throw error
        if (attempt === RETRY_DELAYS.length) break
        await delay(RETRY_DELAYS[attempt], signal)
      }
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline')
    throw new Error('server_busy')
  }

  async function* callProxy(messages, opts) {
    const res = await requestWithRetry(messages, opts)
    try {
      yield* parseStream(res, { signal: opts.signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new Error('stream_interrupted')
    }
  }

  window.Teacher = {
    canSend,
    getConfig,

    async *stream(userMessage, { memory, branch, messages, mode, signal }) {
      markSent()
      yield* callProxy(messages, { memory, branch, mode, signal })
    },
  }
})()
