// إعداد المزود: من التطبيق (headers) أولاً، ثم متغيرات الخادم.
// المفتاح والرابط والنموذج تُضبط من داخل التطبيق — لا شيء صلب هنا.
export const DEFAULT_MODEL = 'mimo-v2.6-flash';

// أسماء موديلات هذا المزود حساسة لحالة الأحرف — نوحّد المعروف منها.
export function normalizeModel(m) {
  const s = String(m || '').trim();
  if (/^mimo-/i.test(s)) return s.toLowerCase();
  return s;
}

function header(headers, name, max = 500) {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

export function decodeKey(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('b64:')) {
    try { return Buffer.from(s.slice(4), 'base64').toString('utf8').trim(); } catch { return ''; }
  }
  return s;
}

function normEndpoint(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return '';
    if (!u.host || u.username || u.password) return '';
    return u.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

export function resolveProvider({ env = process.env, headers = {} } = {}) {
  const wantEndpoint = header(headers, 'x-ai-endpoint');
  const endpoint = wantEndpoint
    ? normEndpoint(wantEndpoint)
    : normEndpoint(env.AI_ENDPOINT || 'https://opencode.ai/zen/go/v1');
  if (wantEndpoint && !endpoint) return { error: 'INVALID_ENDPOINT' };
  const key = decodeKey(header(headers, 'x-ai-api-key', 8000)) || decodeKey(env.AI_API_KEY);
  const model = normalizeModel(header(headers, 'x-ai-model', 200) || String(env.AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL);
  return { key, endpoint: endpoint || 'https://opencode.ai/zen/go/v1', model };
}

export function publicConfig(cfg) {
  return { hasKey: Boolean(cfg?.key), model: cfg?.model || DEFAULT_MODEL };
}
