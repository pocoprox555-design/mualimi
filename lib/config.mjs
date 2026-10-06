export const DEFAULT_MODEL = 'mimo-v2.6-flash';
export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
const MIN_VISION_OUTPUT_TOKENS = 4_096;
const MAX_OUTPUT_TOKENS_CEILING = 16_000;
const MIN_OUTPUT_TOKENS = 256;

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
    ['DeepSeek V4 Flash Vision Exp', 'deepseek-v4-flash-vision-exp'],
    ['DeepSeek V4 Flash Vision', 'deepseek-v4-flash-vision-exp'],
    ['DeepSeek-V4-Flash-Vision-Exp', 'deepseek-v4-flash-vision-exp'],
    ['Qwen3.8 Flash', 'qwen3.8-flash'],
    ['GLM 5.3 Flash', 'glm-5.3-flash'],
  ]);
  return aliases.get(model) || model || DEFAULT_MODEL;
}

// المفتاح يأتي من الهيدر فقط - لا من المتغيرات
export function resolveProvider({ env = process.env, headers = {} } = {}) {
  const endpoint = normalizeEndpoint(env.AI_ENDPOINT || DEFAULT_ENDPOINT);
  if (!endpoint) return { error: 'INVALID_ENDPOINT' };
  
  // المفتاح من الهيدر فقط - لا قراءة من env.AI_API_KEY
  const key = decodeKey(header(headers, 'x-ai-api-key', 8000));
  
  const model = normalizeModel(env.AI_MODEL);
  const contextWindow = Math.max(4_096, Math.min(1_000_000, Number(env.AI_CONTEXT_WINDOW) || 1_000_000));
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, contextWindow - 2_048);
  
  const requestedTokens = Number(env.AI_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS;
  const effectiveTokens = requestedTokens > MAX_OUTPUT_TOKENS_CEILING
    ? Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(DEFAULT_MAX_OUTPUT_TOKENS, 8000))
    : requestedTokens;
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS_CEILING, effectiveTokens, maxOutput));
  
  const visionMaxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(maxTokens, MIN_VISION_OUTPUT_TOKENS), maxOutput));
  const maxPromptChars = Math.max(3_000, Math.min(100_000, (contextWindow - Math.max(maxTokens, visionMaxTokens) - 512) * 2));
  
  return { key, endpoint, model, maxTokens, visionMaxTokens, contextWindow, maxPromptChars };
}

export function resolveWebSearch({ env = process.env } = {}) {
  const endpoint = normalizeEndpoint(env.WEB_SEARCH_ENDPOINT || DEFAULT_WEB_SEARCH_ENDPOINT);
  const key = decodeKey(env.WEB_SEARCH_API_KEY);
  return {
    endpoint,
    key,
    enabled: Boolean(endpoint && key),
    timeoutMs: Math.max(500, Math.min(10_000, Number(env.WEB_SEARCH_TIMEOUT_MS) || 5_000)),
    maxResults: Math.max(1, Math.min(8, Number(env.WEB_SEARCH_MAX_RESULTS) || 5)),
    cacheTtlMs: Math.max(0, Math.min(3_600_000, Number(env.WEB_SEARCH_CACHE_TTL_MS) || 300_000)),
  };
}

const VISION_EXACT = new Set([
  'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2-omni',
  'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision',
]);
const VISION_PATTERN = /(?:^|[-_.])(?:vision|omni|vl)(?:[-_.]|$)/i;
const TEXT_ONLY_PATTERN = /(?:^|[-_.])(?:text|textonly|no[-_.]?vision)(?:[-_.]|$)/i;

export function supportsVision(model, env = process.env) {
  const override = String(env?.AI_SUPPORTS_VISION ?? '').trim().toLowerCase();
  if (override === 'true' || override === '1') return true;
  if (override === 'false' || override === '0') return false;
  const name = String(model || '').trim().toLowerCase();
  if (!name || TEXT_ONLY_PATTERN.test(name)) return false;
  return VISION_EXACT.has(name) || VISION_PATTERN.test(name);
}

export function publicConfig(config) {
  return {
    configured: Boolean(config?.key),
    model: config?.model || DEFAULT_MODEL,
    endpoint: config?.endpoint || DEFAULT_ENDPOINT,
    supportsVision: supportsVision(config?.model),
  };
}
