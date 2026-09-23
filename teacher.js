import { parseSseStream } from './lib/sse-protocol.mjs'
import { Memory } from './memory.js'

const RETRY_DELAYS = [1_500, 3_500]
const REQUEST_TIMEOUT_MS = 310_000
let cachedConfig = null
let configPromise = null

function abortError() { return new DOMException('Aborted', 'AbortError') }

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()) }, { once: true })
  })
}

async function fetchWithTimeout(url, options, timeoutMs, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw signal?.aborted ? abortError() : new Error('TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function retryable(error) {
  if (!error || error.name === 'AbortError') return false
  return ['TIMEOUT', 'NETWORK', 'SERVER_BUSY', 'rate_limit'].includes(error.message) || /fetch failed|network|failed to fetch|5\d\d/.test(String(error.message || ''))
}

async function getConfig(force = false) {
  if (cachedConfig && !force) return cachedConfig
  if (configPromise) return configPromise
  configPromise = fetch('/api/config', { cache: 'no-store', headers: Memory.getApiHeaders() })
    .then(async (response) => {
      if (!response.ok) throw new Error('CONFIG_FAILED')
      return response.json()
    })
    .then((data) => {
      cachedConfig = { hasKey: Boolean(data.hasKey), model: data.model || Memory.settings.apiModel || 'MiMo-V2.6-Flash', streaming: data.streaming !== false }
      return cachedConfig
    })
    .catch(() => {
      cachedConfig = { hasKey: Boolean(Memory.settings.apiKey), model: Memory.settings.apiModel || 'MiMo-V2.6-Flash', streaming: false }
      return cachedConfig
    })
    .finally(() => { configPromise = null })
  return configPromise
}

async function request(messages, options) {
  const body = JSON.stringify({ messages, memory: options.memory || '', branch: options.branch || '', mode: options.mode || 'normal' })
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (options.signal?.aborted) throw abortError()
    try {
      const response = await fetchWithTimeout('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...Memory.getApiHeaders() }, body }, REQUEST_TIMEOUT_MS, options.signal)
      if (response.status === 501) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.code === 'NO_KEY' ? 'NO_KEY' : 'SERVER_BUSY')
      }
      if (response.status === 429) throw new Error('rate_limit')
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
      return response
    } catch (error) {
      if (!retryable(error) || attempt === RETRY_DELAYS.length) throw error
      await delay(RETRY_DELAYS[attempt], options.signal)
    }
  }
  throw new Error('SERVER_BUSY')
}

async function* stream(messages, options = {}) {
  const response = await request(messages, options)
  try {
    for await (const event of parseSseStream(response, { signal: options.signal })) yield event
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new Error('STREAM_INTERRUPTED')
  }
}

const Teacher = { getConfig, stream }
export { Teacher }
