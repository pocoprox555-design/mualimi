export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_MODEL = 'MiMo-V2.6-Flash'
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 131_000

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function decodeApiKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!raw.startsWith('b64:')) return raw
  try {
    return Buffer.from(raw.slice(4), 'base64').toString('utf8').trim()
  } catch {
    return ''
  }
}

export function normalizeEndpoint(value, { allowLocalHttp = true } = {}) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const isLocalHttp = url.protocol === 'http:' && allowLocalHttp && LOCAL_HOSTS.has(url.hostname)
    if ((url.protocol !== 'https:' && !isLocalHttp) || !url.host || url.username || url.password) return ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function headerValue(headers, name, maxLength) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first.trim().slice(0, maxLength) : ''
}

function integerSetting(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum) return fallback
  return Math.min(number, maximum)
}

export function resolveProviderConfig({ env = process.env, headers = {} } = {}) {
  const requestedEndpoint = headerValue(headers, 'x-ai-endpoint', 500)
  const endpoint = requestedEndpoint
    ? normalizeEndpoint(requestedEndpoint, { allowLocalHttp: env.NODE_ENV !== 'production' })
    : normalizeEndpoint(env.AI_ENDPOINT || DEFAULT_ENDPOINT)
  if (requestedEndpoint && !endpoint) return { error: 'INVALID_API_ENDPOINT' }

  const requestedKey = decodeApiKey(headerValue(headers, 'x-ai-api-key', 8_000))
  const configuredKey = decodeApiKey(env.AI_API_KEY)
  // لا نرسل مفتاح الخادم إلى Endpoint اختارته الواجهة؛ يجب أن يأتي المفتاح
  // من الجهاز نفسه عند تغيير المزوّد.
  const key = requestedKey || (requestedEndpoint ? '' : configuredKey)
  const model = headerValue(headers, 'x-ai-model', 200) || String(env.AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  const contextWindow = integerSetting(env.AI_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, 16_000, 2_000_000)
  const maxOutputTokens = integerSetting(env.AI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 1_000, 200_000)

  return { key, endpoint: endpoint || DEFAULT_ENDPOINT, model, contextWindow, maxOutputTokens }
}

export function publicProviderConfig(config) {
  return {
    hasKey: Boolean(config?.key),
    model: config?.model || DEFAULT_MODEL,
    contextWindow: config?.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: config?.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    streaming: true,
  }
}
