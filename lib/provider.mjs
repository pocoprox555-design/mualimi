const MAX_ATTEMPTS = 3;
const BACKOFF = [650, 1_400, 2_800];
const DEFAULT_TIMEOUT = 75_000;

const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('ABORTED'));
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason || new Error('ABORTED'));
  }, { once: true });
});

function timeoutController(parent, milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error('UPSTREAM_TIMEOUT');
    error.code = 'UPSTREAM_TIMEOUT';
    controller.abort(error);
  }, milliseconds);
  const abort = () => controller.abort(parent?.reason || new Error('ABORTED'));
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
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
  } catch { error.detail = String(body || '').slice(0, 300); }
  return error;
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
      throw errorFromResponse(response.status, bodyText);
    }
    if (!response.body) throw new Error('UPSTREAM_EMPTY_BODY');
    return { response, signal: timeout.signal, dispose: timeout.dispose };
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

async function* readCompletion(response, { signal, onFirstToken }) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('event-stream')) {
    const data = await response.json();
    const text = contentFromChoice(data?.choices?.[0]);
    if (text) onFirstToken?.();
    if (text) yield { type: 'text', text };
    yield { type: 'done', finish: data?.choices?.[0]?.finish_reason || 'stop' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotText = false;
  let finished = false;
  const cancel = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = sseBlocks(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) {
        const dataLines = block
          .replace(/\r/g, '')
          .split('\n')
          .filter((line) => line.trimStart().startsWith('data:'))
          .map((line) => line.trimStart().slice(5).trim());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') { finished = true; break; }
        let data;
        try { data = JSON.parse(payload); } catch { continue; }
        const choice = data?.choices?.[0];
        const text = contentFromChoice(choice);
        if (text) {
          if (!gotText) { gotText = true; onFirstToken?.(); }
          yield { type: 'text', text };
        }
        if (choice?.finish_reason) { finished = true; break; }
      }
      if (finished) break;
    }
    // بعض البروكسيات تغلق الاتصال قبل إضافة فاصل SSE أخير.
    const tail = buffer.trim();
    if (tail && !finished) {
      for (const line of tail.replace(/\r/g, '').split('\n')) {
        if (!line.trimStart().startsWith('data:')) continue;
        const payload = line.trimStart().slice(5).trim();
        if (payload === '[DONE]') { finished = true; break; }
        try {
          const text = contentFromChoice(JSON.parse(payload)?.choices?.[0]);
          if (text) { if (!gotText) { gotText = true; onFirstToken?.(); } yield { type: 'text', text }; }
        } catch { /* بيانات غير مكتملة */ }
      }
    }
    yield { type: 'done', finish: 'stop' };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

export async function* streamCompletion({ endpoint, key, model, messages, maxTokens, signal, session, onFirstToken }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('ABORTED');
    let emittedText = false;
    try {
      const request = await postOnce({
        endpoint,
        key,
        signal,
        session,
        body: { model, messages, max_tokens: maxTokens, temperature: 0.45 },
      });
      try {
        for await (const event of readCompletion(request.response, { signal: request.signal, onFirstToken })) {
          if (event.type === 'text') emittedText = true;
          yield event;
        }
      } finally { request.dispose(); }
      return;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      if (error?.name === 'AbortError' && /abort/i.test(String(error?.message))) {
        const timeoutError = new Error('UPSTREAM_TIMEOUT');
        timeoutError.code = 'UPSTREAM_TIMEOUT';
        error = timeoutError;
      }
      if (emittedText || error?.retryable === false || (!error?.retryable && !/timeout|network|fetch failed|econn|enotfound|eai_again|socket|reset|empty_body/i.test(String(error?.message)))) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(BACKOFF[attempt - 1], signal);
    }
  }
  throw lastError || new Error('UPSTREAM_FAILED');
}
