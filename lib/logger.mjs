// سجل موازٍ للطلب: بلا سطر واحد يحفظ السؤال والأدلة المسترجعة والرسالة المُرسلة
// حرفياً، لا يمكن إعادة بناء جواب خاطئ بعد وقوعه — فيُسجَّل هنا تعريف الطلب
// كاملاً، ويُربط كل سطر بمعرّفه حتى تُقرأ سيرة الطلب من أولها إلى آخرها.
const MAX_RECORDS = 200;
const MAX_TEXT = 4000;
const MAX_META = 1200;

// المطابقة لا تعتمد على معرفة شكل المفاتيح مقدّماً: أي نص يشبه مفتاحاً يُطمَس
// قبل أن يصل السطر إلى المخرج، فلا يُطبع سر في سجل قد يُرفَع مع تقرير عطل.
const SECRET_RULES = [
  [/oc_sk_[A-Za-z0-9._-]{4,}/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9._-]{8,}/g, '[REDACTED]'],
  [/b64:[A-Za-z0-9+/=_-]{4,}/g, '[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]'],
  [/(x-ai-api-key["'\s:=>]+)[^"'\s,;}]{4,}/gi, '$1[REDACTED]'],
];

const requestLogs = new Map();

export function newRequestId() {
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
  return `req_${Date.now().toString(36)}_${random}`;
}

function truncate(text, max) {
  return String(text ?? '').slice(0, max);
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_RULES) text = text.replace(pattern, replacement);
  return truncate(text, MAX_TEXT);
}

function safeJson(value) {
  try {
    return truncate(redactSecrets(JSON.stringify(value) ?? ''), MAX_META);
  } catch {
    return '[unserializable]';
  }
}

function pairs(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${typeof value === 'object' ? safeJson(value) : redactSecrets(String(value))}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function writeLine(level, requestId, message) {
  const prefix = `[${new Date().toISOString()}] [${String(requestId ?? '').trim() || 'req_none'}]`;
  const text = redactSecrets(String(message ?? ''));
  if (level === 'error') console.error(prefix, text);
  else if (level === 'warn') console.warn(prefix, text);
  else console.log(prefix, text);
}

export function childLogger(requestId, context = {}) {
  const base = pairs(context);
  const make = (level) => (message, meta) => {
    // سطر سجل لا يسقط الطلب أبداً: أي عطل في التسجيل يُبلع هنا.
    try {
      writeLine(level, requestId, `${String(message ?? '')}${base}${pairs(meta)}`);
    } catch { /* التسجيل لا يُسقط الطلب */ }
  };
  return { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') };
}

function short(value, max = 180) {
  return truncate(redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim(), max);
}

function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : '?';
}

function milliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}ms` : '?';
}

function sourceSummary(source) {
  const row = source && typeof source === 'object' ? source : {};
  return `${String(row.id ?? '?')}[${String(row.bookId ?? '?')} printed=${String(row.printedPage ?? '?')} physical=${String(row.physicalPage ?? '?')} score=${String(row.score ?? '?')} ${String(row.evidenceStatus ?? '?')}/${String(row.evidenceType ?? '?')}]`;
}

export function logRetrieval(requestId, info = {}) {
  try {
    const hits = Array.isArray(info?.hits) ? info.hits : [];
    const sources = Array.isArray(info?.sources) ? info.sources : [];
    const expanded = Array.isArray(info?.expandedTerms) ? info.expandedTerms : [];
    const line = `retrieval query="${short(info?.query, 240)}" hits=${numberOf(hits.length || sources.length)}`
      + ` candidates=${numberOf(info?.candidateCount)} expanded=${numberOf(expanded.length)}`
      + ` elapsed=${milliseconds(info?.elapsedMs)} budget=${numberOf(info?.budget)}`
      + ` sources=${sources.map(sourceSummary).join(' ') || 'none'}`;
    writeLine('info', requestId, line);
  } catch { /* التسجيل لا يُسقط الطلب */ }
}

export function logPrompt(requestId, info = {}) {
  try {
    const perMessage = Array.isArray(info?.perMessage) ? info.perMessage : [];
    const line = `prompt model=${String(info?.model ?? 'unknown')} maxTokens=${numberOf(info?.maxTokens)}`
      + ` temperature=${numberOf(info?.temperature)} messages=${numberOf(info?.messageCount)}`
      + ` chars=${numberOf(info?.chars)} perMessage=${perMessage
        .map((row) => `${String(row?.role ?? '?')}:${numberOf(row?.chars)}`)
        .join(',') || 'none'}`;
    writeLine('info', requestId, line);
    // النص الكامل لِلرسائل لا يُطبع إلا بطلب صريح: الرسم الافتراضي يحصي الأحرف
    // وحدها كي لا يغرق السجل، والمفتاح إن وُجد داخل الرسالة يُطمَس قبله.
    if (info?.full === true || process.env.LOG_FULL_PROMPT === '1') {
      const messages = Array.isArray(info?.messages) ? info.messages : [];
      writeLine('info', requestId, `prompt-full messages=${messages.length ? safeJson(messages) : 'none'}`);
    }
  } catch { /* التسجيل لا يُسقط الطلب */ }
}

export function logEvidence(requestId, info = {}) {
  try {
    const sourceIds = Array.isArray(info?.sourceIds) ? info.sourceIds.map((id) => String(id ?? '?')) : [];
    const truncated = Array.isArray(info?.truncatedSources) ? info.truncatedSources : [];
    const images = Array.isArray(info?.images) ? info.images.length : info?.images;
    const line = `evidence blockChars=${numberOf(info?.blockChars)} sources=${sourceIds.join(',') || 'none'}`
      + ` truncated=${truncated.length} images=${numberOf(images)}`;
    writeLine('info', requestId, line);
  } catch { /* التسجيل لا يُسقط الطلب */ }
}

function remember(requestId, entry) {
  const key = String(requestId ?? '').trim();
  if (!key) return null;
  // Map يحفظ ترتيب الإدخال، فالإخراج يسقط الأقدم إدخالاً لا الأقدم مطالبةً.
  const previous = requestLogs.get(key);
  const record = {
    ...mergeEntry(previous, entry),
    requestId: key,
    createdAt: previous?.createdAt || new Date().toISOString(),
  };
  requestLogs.set(key, record);
  while (requestLogs.size > MAX_RECORDS) {
    const oldest = requestLogs.keys().next().value;
    requestLogs.delete(oldest);
  }
  return record;
}

function mergeEntry(previous, entry) {
  const merged = previous && typeof previous === 'object' ? { ...previous } : {};
  if (!entry || typeof entry !== 'object') return merged;
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    // تصحيحات الجواب وقائمة مصادره تتراكم على مرات النداء المتعددة لطلب واحد،
    // فلا يُستبدل القديم بالجديد ضياعاً لأول ما رُصد.
    if (Array.isArray(value) && Array.isArray(merged[key]) && merged[key].length) {
      merged[key] = [...merged[key], ...value];
    } else if (value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

export function recordExchange(requestId, entry) {
  try {
    const record = remember(requestId, entry && typeof entry === 'object' ? { ...entry } : {});
    if (!record) return null;
    const corrections = Array.isArray(record.corrections) ? record.corrections.length : 0;
    writeLine('info', requestId, `exchange question="${short(record.question, 160)}" finish=${String(record.finish ?? '?')}`
      + ` usage=${safeJson(record.usage)} firstToken=${milliseconds(record.firstTokenMs)} total=${milliseconds(record.totalMs)} corrections=${numberOf(corrections)}`);
    return record;
  } catch {
    return null;
  }
}

export function getRequestLog(requestId) {
  try {
    const key = String(requestId ?? '').trim();
    if (!key) return null;
    const record = requestLogs.get(key);
    if (!record) return null;
    // القراءة تسقط السجل: من يقرأه هو من يملك استكمال التحقيق، فينتهي دوره هنا.
    requestLogs.delete(key);
    return record;
  } catch {
    return null;
  }
}
