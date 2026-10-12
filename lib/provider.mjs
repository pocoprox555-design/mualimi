// ── بثّ نداءات الأدوات (tool calls) ──────────────────────────────────────
// لماذا يُجمّع نداء الأداة بالفهرس؟ المزودون يقسّمون `arguments` تقسيماً
// عشوائياً: منهم من يرسلها كاملة في حزمة واحدة (حال mimo المستهدف)، ومنهم
// من يقطّعها شظايا. فتُحفظ حالة كل فهرس، وتُبثّ شظيتها فوراً حدث `tool`،
// ثم حدث نهائي يحمل المتراكم كاملاً مع `final: true`. ولا تُحلّل الشظايا
// هنا: الوسائط تُبنى بالوصل فقط، فالمشوّه يمرّ كما وصل ولا يُسقط البثّ.

const MAX_ATTEMPTS = 3;
const BACKOFF = [650, 1_400, 2_800];
const DEFAULT_TIMEOUT = 75_000;
const TOOL_CHOICES = new Set(['auto', 'none', 'required']);

const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('ABORTED'));
  const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('ABORTED')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// المؤقّت هنا مهلة خمول لا مهلة إجمالية: كل حزمة تصل من النموذج تُعيد ضبطه،
// فلا يُقطع بثٌّ سليم بحكم طول الإجابة بل بحكم توقّف النموذج فعلاً.
function timeoutController(parent, milliseconds) {
  const controller = new AbortController();
  const fire = () => {
    const error = new Error('UPSTREAM_TIMEOUT');
    error.code = 'UPSTREAM_TIMEOUT';
    controller.abort(error);
  };
  let timer = setTimeout(fire, milliseconds);
  const poke = (delay = milliseconds) => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    timer = setTimeout(fire, delay);
  };
  const abort = () => controller.abort(parent?.reason || new Error('ABORTED'));
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    poke,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function retryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function chatUrl(endpoint) {
  const base = String(endpoint).replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function errorFromResponse(status, body) {
  const error = new Error(`UPSTREAM_HTTP_${status}`);
  error.status = status;
  error.retryable = retryable(status);
  try {
    const json = JSON.parse(body);
    error.detail = String(json?.error?.message || json?.message || '').slice(0, 300);
    if (status === 400 && /context.*(?:length|window|limit)|too many tokens|maximum.*tokens/i.test(error.detail)) error.code = 'CONTEXT_WINDOW_EXCEEDED';
  } catch { error.detail = String(body || '').slice(0, 300); }
  return error;
}

// الأدوات تُرسل فقط إذا كانت قائمة غير فارغة: بعض المزودين يرفضون
// `tools: []` بخطأ 400، ويرفضون `tool_choice` حين لا أدوات.
function toolPayload(tools, toolChoice) {
  if (!Array.isArray(tools) || !tools.length) return {};
  return { tools, tool_choice: TOOL_CHOICES.has(toolChoice) ? toolChoice : 'auto' };
}

async function postOnce({ endpoint, key, body, signal, session }) {
  const timeout = timeoutController(signal, Math.max(20_000, Math.min(120_000, Number(process.env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT)));
  try {
    const response = await fetch(chatUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': 'mualimi/3.0',
        'x-opencode-session': String(session || 'mualimi-default').slice(0, 100),
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: timeout.signal,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const error = errorFromResponse(response.status, bodyText);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, Math.min(60_000, delay));
      }
      throw error;
    }
    if (!response.body) throw new Error('UPSTREAM_EMPTY_BODY');
    return { response, signal: timeout.signal, poke: timeout.poke, dispose: timeout.dispose };
  } catch (error) {
    timeout.dispose();
    if (timeout.signal.aborted && !signal?.aborted && error?.name === 'AbortError') {
      const timeoutError = new Error('UPSTREAM_TIMEOUT');
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  }
}

function contentFromChoice(choice) {
  const value = choice?.delta?.content ?? choice?.message?.content ?? '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
}

// ميزانية الاستدلال تُحتسب من `max_tokens` قبل النص، وهي غير ظاهرة في المخرجات.
// إخراجها يسمح للخادم أن يعرف أن `length` جاء من الاستدلال لا من طول الإجابة.
function usageEvent(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const reasoningTokens = Number(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0) || 0;
  const completionTokens = Number(usage?.completion_tokens ?? 0) || 0;
  return { type: 'usage', usage, reasoningTokens, completionTokens };
}

function sseBlocks(buffer) {
  const blocks = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match || match.index == null) break;
    blocks.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { blocks, rest };
}

// الفهرس عدد صحيح في المعيار، لكن بعض المزودين يرسلونه نصاً أو يحذفونه،
// فيُستعمل موضع العنصر في المصفوفة حينها.
function toolIndex(value, position) {
  const parsed = value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Math.max(0, position);
}

// الوسائط نصٌّ في المعيار؛ من يرسلها كائناً جاهزاً نحوّله نصاً. ولا نتحقق
// من صحة JSON أبداً: المشوّه يُمرَّر كما وصل فلا يفشل البثّ.
function toolCallParts(item) {
  // بعض المزودين يضعون `name` و`arguments` في جذر العنصر لا تحت `function`.
  const fn = item?.function && typeof item.function === 'object' ? item.function : item;
  const args = typeof fn?.arguments === 'string' ? fn.arguments
    : fn?.arguments && typeof fn.arguments === 'object' ? JSON.stringify(fn.arguments) : '';
  return { id: typeof item?.id === 'string' ? item.id : '', name: typeof fn?.name === 'string' ? fn.name : '', args };
}

// Fragments can interleave; completed calls are emitted only after provider termination.
function toolCollector() {
  const calls = new Map();

  const slot = (index) => {
    if (!calls.has(index)) calls.set(index, { id: '', name: '', args: '', done: false });
    return calls.get(index);
  };
  const closeOne = (index) => {
    const call = calls.get(index);
    if (!call || call.done) return null;
    call.done = true;
    return { type: 'tool', tool: { index, id: call.id, name: call.name, arguments: call.args, final: true } };
  };
  const closeBelow = (limit = Infinity) => [...calls.keys()].filter((index) => index < limit).map(closeOne).filter(Boolean);

  const ingest = (toolCalls, quiet) => {
    const events = [];
    if (!Array.isArray(toolCalls)) return events;
    toolCalls.forEach((item, position) => {
      if (!item || typeof item !== 'object') return;
      const index = toolIndex(item.index, position);
      // Tool fragments may interleave across indexes; close only at a completed turn.
      const call = slot(index);
      const parts = toolCallParts(item);
      if (parts.id && !call.id) call.id = parts.id;
      if (parts.name && !call.name) call.name = parts.name;
      if (!parts.args) return;
      call.args += parts.args;
      // الشظية وحدها في الحدث؛ المتراكم الكامل يأتي في الحدث النهائي.
      if (!quiet) events.push({ type: 'tool', tool: { index, id: call.id, name: call.name, arguments: parts.args } });
    });
    return events;
  };

  return {
    ingest,
    // يُغلق ما بقي من نداءات لم تُغلق بعد: نهاية البثّ أو `finish_reason`.
    close: closeBelow,
    count: () => calls.size,
    // الردّ غير المبثوث يحمل الرسالة كاملة، فيُرصَد النداء بلا شظايا نهائياً.
    snapshot(toolCalls) { ingest(toolCalls, true); return closeBelow(); },
  };
}

async function* readCompletion(response, { signal, onFirstToken, onActivity }) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  // الاحتياط: ردّ JSON واحد لا بثّ، فتصل النداءات كاملة في الرسالة.
  if (!contentType.includes('event-stream')) {
    const data = await response.json();
    onActivity?.();
    const usage = usageEvent(data?.usage);
    if (usage) yield usage;
    const choice = data?.choices?.[0];
    if (!choice) throw Object.assign(new Error('UPSTREAM_INVALID_RESPONSE'), { code: 'UPSTREAM_INVALID_RESPONSE' });
    const text = contentFromChoice(choice);
    if (text) onFirstToken?.();
    if (text) yield { type: 'text', text };
    for (const event of toolCollector().snapshot(choice?.message?.tool_calls)) yield event;
    yield { type: 'done', finish: choice?.finish_reason || 'stop' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotText = false;
  let finished = false;
  let finishReason = '';
  let usage = null;
  const tools = toolCollector();
  const cancel = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });

  const parseBlock = (block) => {
    const dataLines = block
      .replace(/\r/g, '')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('data:'))
      .map((line) => line.trimStart().slice(5).trim());
    if (!dataLines.length) return null;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') return { terminal: true, finish: finishReason };
    let data;
    try { data = JSON.parse(payload); } catch { throw Object.assign(new Error('UPSTREAM_INVALID_SSE'), { code: 'UPSTREAM_INVALID_SSE' }); }
    const choice = data?.choices?.[0];
    if (data?.usage) usage = usageEvent(data.usage);
    if (!choice) {
      if (data?.usage) return null;
      throw Object.assign(new Error('UPSTREAM_INVALID_RESPONSE'), { code: 'UPSTREAM_INVALID_RESPONSE' });
    }
    const text = contentFromChoice(choice);
    const finish = choice?.finish_reason;
    return {
      text,
      // بعض المزودين يرسلون الرسالة كاملة داخل حزمة بدل `delta`.
      toolCalls: choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? null,
      terminal: Boolean(finish),
      finish: finish || '',
    };
  };

  // الكتلة تُعالج في مكان واحد تخدمه حلقة البثّ والذيل معاً.
  const emitBlock = function* (block) {
    const item = parseBlock(block);
    if (!item) return;
    if (item.text) {
      if (!gotText) { gotText = true; onFirstToken?.(); }
      yield { type: 'text', text: item.text };
    }
    for (const event of tools.ingest(item.toolCalls)) yield event;
    if (item.terminal) {
      finished = true;
      finishReason = item.finish || finishReason;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const parsed = sseBlocks(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        yield* emitBlock(block);
        if (finished) break;
      }
      if (finished) break;
    }
    // بعض البروكسيات تغلق الاتصال قبل إضافة فاصل SSE أخير.
    const tail = buffer.trim();
    if (tail && !finished) yield* emitBlock(tail);
    if (!finished) {
      const error = new Error('UPSTREAM_INCOMPLETE_STREAM');
      error.code = 'UPSTREAM_INCOMPLETE_STREAM';
      throw error;
    }
    for (const event of tools.close()) yield event;
    if (usage) yield usage;
    // مزودون يُرسلون النداءات بلا `finish_reason`؛ وجود نداء وحده يكفي ليقول
    // المتصل إن الجولة التالية نتيجة أداة لا نصّ.
    yield { type: 'done', finish: finishReason || (tools.count() ? 'tool_calls' : 'stop') };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

export async function* streamCompletion({
  endpoint, key, model, messages, maxTokens, temperature = 0.2,
  tools = null, tool_choice = 'auto', signal, session, onFirstToken, onAttempt,
}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('ABORTED');
    // الإعادة مسموحة قبل أول مخرج فقط: نصّ أو شظية أداة. بعد ذلك فأي خطأ
    // يعني بثاً نصفَه مخرَج، وإعادته تُكرّر ما رآه المستخدم.
    let emitted = false;
    const attemptStarted = Date.now();
    const attemptInfo = { attempt };
    onAttempt?.(attemptInfo);
    try {
      const request = await postOnce({
        endpoint,
        key,
        signal,
        session,
        body: {
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...toolPayload(tools, tool_choice),
        },
      });
      try {
        for await (const event of readCompletion(request.response, {
          signal: request.signal,
          onFirstToken,
          onActivity: request.poke,
        })) {
          // شظية الأداة نشاط كالنصّ: تُعيد ضبط مهلة الخمول وتمنع الإعادة.
          if (event.type === 'text' || (event.type === 'tool' && event.tool.final)) { emitted = true; request.poke(); }
          yield event;
        }
      } finally { request.dispose(); }
      attemptInfo.ms = Date.now() - attemptStarted;
      return;
    } catch (error) {
      attemptInfo.ms = Date.now() - attemptStarted;
      attemptInfo.error = error.code || error.message;
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      if (error?.name === 'AbortError' && /abort/i.test(String(error?.message))) {
        const timeoutError = new Error('UPSTREAM_TIMEOUT');
        timeoutError.code = 'UPSTREAM_TIMEOUT';
        error = timeoutError;
      }
      if (emitted || error?.retryable === false || (!error?.retryable && !/timeout|network|fetch failed|econn|enotfound|eai_again|socket|reset|empty_body|incomplete_stream/i.test(String(error?.message)))) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(error.retryAfterMs ?? BACKOFF[attempt - 1], signal);
    }
  }
  throw lastError || new Error('UPSTREAM_FAILED');
}
