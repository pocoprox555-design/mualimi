export const DEFAULT_MODEL = 'mimo-v2.6-flash';
export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1';

function header(headers, name, max = 500) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

export function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!text.startsWith('b64:')) return text;
  try { return Buffer.from(text.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
}

export function normalizeEndpoint(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    if (!url.host || url.username || url.password || url.search || url.hash) return '';
    return url.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

function normalizeModel(value) {
  const model = String(value || '').trim();
  const aliases = new Map([
    ['MiMo-V2.6-Flash', 'mimo-v2.6-flash'],
    ['MiMo-V2.6-Pro', 'mimo-v2.6-pro'],
    ['MiMo-V2.5', 'mimo-v2.5'],
    ['MiMo-V2.5-Pro', 'mimo-v2.5-pro'],
  ]);
  return aliases.get(model) || model || DEFAULT_MODEL;
}

// هذا التطبيق خاص، لذلك يمكن للمستخدم تغيير المفتاح من الإعدادات دون تعديل ملفات الخادم.
export function resolveProvider({ env = process.env, headers = {} } = {}) {
  const endpoint = normalizeEndpoint(env.AI_ENDPOINT || DEFAULT_ENDPOINT);
  if (!endpoint) return { error: 'INVALID_ENDPOINT' };
  const key = decodeKey(header(headers, 'x-ai-api-key', 8000)) || decodeKey(env.AI_API_KEY);
  const model = normalizeModel(env.AI_MODEL);
  const maxTokens = Math.max(256, Math.min(16_000, Number(env.AI_MAX_OUTPUT_TOKENS) || 3_000));
  return { key, endpoint, model, maxTokens };
}

export function publicConfig(config) {
  return {
    configured: Boolean(config?.key),
    model: config?.model || DEFAULT_MODEL,
    endpoint: config?.endpoint || DEFAULT_ENDPOINT,
  };
}
