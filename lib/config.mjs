export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const MIN_OUTPUT_TOKENS = 256;
// سقوف النموذج الهدف: مليون للسياق ومخرجات تتجاوز ١٢٨ ألف توكن. لا سقوف
// مُخترعة هنا — القيم افتراضات تُستبدَل من البيئة، والحقيقة أن النافذة كبيرة
// فتُشتق منها كل ميزانيات الاسترجاع (lib/retrieval-policy.mjs).
const CONTEXT_WINDOW_DEFAULT = 1_000_000;
const OUTPUT_TOKENS_DEFAULT = 8_000;
const OUTPUT_TOKENS_CEILING = 384_000; // حد خرج DeepSeek V4.1 Flash (384K tokens) according to model documentation.
const MAX_PROMPT_CHARS_CEILING = Infinity;
const MIN_PROMPT_CHARS = 4_000;

// جدول تحذير فقط: إن أُعلنت نافذة أكبر من المعروف للنموذج نُحذّر في الإقلاع،
// ولا نمنع ولا نُصحّح — من قال مليون توكن فهو يعرف مزوّده.
const KNOWN_WINDOWS = new Map([
  ['deepseek-v4.1-flash', 1_000_000],
]);

// السجل المسموح: لا يعمل التطبيق إلا بنموذج مسجّل هنا. أي قيمة أخرى في AI_MODEL
// (على Render أو محليًا، ومنها النماذج القديمة المحذوفة مثل mimo-*) تُتجاهَل
// ويُستعمل الافتراضي، مع إشعار ظاهر في الإقلاع وواجهة /api/health وconfig.
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL, ...KNOWN_WINDOWS.keys()]);

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

const MODEL_ALIASES = new Map([
  ['DeepSeek V4.1 Flash', 'deepseek-v4.1-flash'],
  ['DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash'],
]);

function resolveModel(value) {
  const requested = String(value || '').trim();
  const model = MODEL_ALIASES.get(requested) || requested;
  if (!model || SUPPORTED_MODELS.has(model)) return { model: model || DEFAULT_MODEL, requested, ignored: false };
  return { model: DEFAULT_MODEL, requested, ignored: true };
}

// المفتاح يأتي من الهيدر فقط - لا من المتغيرات
export function resolveProvider({ env = process.env, headers = {} } = {}) {
  const endpoint = normalizeEndpoint(env.AI_ENDPOINT || DEFAULT_ENDPOINT);
  if (!endpoint) return { error: 'INVALID_ENDPOINT' };

  // المفتاح من الهيدر فقط: لا يُقرأ من البيئة ولا يُحفظ على الخادم.
  const key = decodeKey(header(headers, 'x-ai-api-key', 8000));

  const requested = resolveModel(env.AI_MODEL);
  const model = requested.model;
  const warnModel = requested.ignored
    ? `AI_MODEL_NOT_REGISTERED(requested=${requested.requested}, using=${model})`
    : null;
  const declaredWindow = Number(env.AI_CONTEXT_WINDOW) || 0;
  const contextWindow = Math.max(4_096, Math.min(1_000_000, declaredWindow || CONTEXT_WINDOW_DEFAULT));
  const knownWindow = KNOWN_WINDOWS.get(model) || 0;
  // Explicit provider settings are authoritative; known values only warn.
  const budgetWindow = contextWindow;
  const warnContext = declaredWindow && knownWindow && declaredWindow > knownWindow
    ? `AI_CONTEXT_WINDOW_MAY_EXCEED_MODEL(model=${model}, declared=${declaredWindow}, known≈${knownWindow})`
    : null;
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, budgetWindow - 2_048);

  const requestedTokens = Number(env.AI_MAX_OUTPUT_TOKENS) || OUTPUT_TOKENS_DEFAULT;
  const effectiveTokens = requestedTokens > OUTPUT_TOKENS_CEILING
    ? OUTPUT_TOKENS_CEILING
    : requestedTokens;
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(OUTPUT_TOKENS_CEILING, effectiveTokens, maxOutput));

  const visionMaxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(OUTPUT_TOKENS_CEILING, Math.max(maxTokens, 4_096), maxOutput));
  const maxPromptChars = Math.max(MIN_PROMPT_CHARS, Math.min(MAX_PROMPT_CHARS_CEILING, (budgetWindow - Math.max(maxTokens, visionMaxTokens) - 512) * 2));

  return { key, endpoint, model, maxTokens, visionMaxTokens, contextWindow, budgetWindow, maxPromptChars, warnContext, warnModel };
}

const VISION_EXACT = new Set([
  'deepseek-v4.1-flash',
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
    contextWarning: config?.warnContext || null,
    modelNotice: config?.warnModel || null,
  };
}
