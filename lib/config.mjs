export const DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp';
export const DEFAULT_ENDPOINT = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// النموذج المُهيّأ نموذج استدلال: `max_tokens` يحدّ الاستدلال والإجابة معًا،
// فـ completion_tokens_details.reasoning_tokens تُستهلك قبل ظهور أي نص.
// قياس مباشر: قراءة صفحة PDF واحدة = 276 رمز استدلال، فلا نص إطلاقًا عند
// max_tokens=200، ونفس القراءة تجيب صحيحة عند 4000. لذلك الحد الافتراضي
// 8000 لا 3000: ميزانية أصغر من ذلك تُخرج ردًا فارغًا أو finish_reason=length.
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
// أرضية Vision: أي دور يحمل صورة صفحة يحتاج 4096 رمز على الأقل، وإلا استهلك
// الاستدلالُ الميزانية كلها ولم يُكتب رد. تبقى ضمن السقف الأعلى دائمًا.
const MIN_VISION_OUTPUT_TOKENS = 4_096;
// السقف الصلب يبقى كما كان: تجاوزه يفسد ميزانية النافذة ويطيل زمن الوصول.
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
    // النموذج الافتراضي: Flash يدعم قراءة صور الصفحات صراحةً، وتسعير الصور
    // عند المزوّد يتبع أبعادها، فيبقى الاسم القديم أو المسافات الزائدة فوق نفسه.
    ['DeepSeek V4 Flash Vision Exp', 'deepseek-v4-flash-vision-exp'],
    ['DeepSeek V4 Flash Vision', 'deepseek-v4-flash-vision-exp'],
    ['DeepSeek-V4-Flash-Vision-Exp', 'deepseek-v4-flash-vision-exp'],
    ['Qwen3.8 Flash', 'qwen3.8-flash'],
    ['GLM 5.3 Flash', 'glm-5.3-flash'],
  ]);
  return aliases.get(model) || model || DEFAULT_MODEL;
}

// هذا التطبيق خاص، لذلك يمكن للمستخدم تغيير المفتاح من الإعدادات دون تعديل ملفات الخادم.
export function resolveProvider({ env = process.env, headers = {} } = {}) {
  const endpoint = normalizeEndpoint(env.AI_ENDPOINT || DEFAULT_ENDPOINT);
  if (!endpoint) return { error: 'INVALID_ENDPOINT' };
  const key = decodeKey(header(headers, 'x-ai-api-key', 8000)) || decodeKey(env.AI_API_KEY);
  const model = normalizeModel(env.AI_MODEL);
  const contextWindow = Math.max(4_096, Math.min(1_000_000, Number(env.AI_CONTEXT_WINDOW) || 1_000_000));
  const maxOutput = Math.max(MIN_OUTPUT_TOKENS, contextWindow - 2_048);
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS_CEILING, Number(env.AI_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS, maxOutput));
  // ميزانية منفصلة لدور يحمل صور صفحات: لا تنزل تحت أرضية Vision مهما صُغّر الإعداد،
  // حتى لا يُقتطع رد يُبنى على قراءة بصرية.
  const visionMaxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(maxTokens, MIN_VISION_OUTPUT_TOKENS), maxOutput));
  const maxPromptChars = Math.max(3_000, Math.min(100_000, (contextWindow - Math.max(maxTokens, visionMaxTokens) - 512) * 2));
  return { key, endpoint, model, maxTokens, visionMaxTokens, contextWindow, maxPromptChars };
}

// Brave is a JSON search API, not a scraped results page. The adapter stays
// disabled until a key is configured; local curriculum retrieval still works.
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

export function publicConfig(config) {
  return {
    configured: Boolean(config?.key),
    model: config?.model || DEFAULT_MODEL,
    endpoint: config?.endpoint || DEFAULT_ENDPOINT,
  };
}
