// بروكسي المزود: محاولة مرنة — streaming أولاً، ثم JSON عادي عند الفشل.
// retry تلقائي: 3 محاولات بفاصل تصاعدي. لا أدوات، لا حلقات — استدعاء واحد فقط.
const RETRIES = 3;
const BACKOFF = [800, 2000, 4000];
const TIMEOUT_MS = 45_000;

function timeoutSignal(ms, parent) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error('UPSTREAM_TIMEOUT')), ms);
  parent?.addEventListener('abort', () => { clearTimeout(t); c.abort(parent.reason); }, { once: true });
  if (parent?.aborted) c.abort(parent.reason);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(signal.reason);
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

function retryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function chatUrl(endpoint) {
  const base = String(endpoint).replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

async function postOnce({ endpoint, key, body, stream, signal, session }) {
  const { signal: sig, done } = timeoutSignal(TIMEOUT_MS, signal);
  try {
    const res = await fetch(chatUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': 'mualimi/2.0',
        // المزود يشترط جلسة ثابتة لكل محادثة للتوجيه والتخزين المؤقت
        'x-opencode-session': String(session || 'mualimi-default'),
      },
      body: JSON.stringify({ ...body, stream }),
      signal: sig,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`UPSTREAM_HTTP_${res.status}`);
      err.status = res.status;
      err.retryable = retryable(res.status);
      try {
        const j = JSON.parse(text);
        err.detail = String(j?.error?.message || j?.message || '').slice(0, 200);
      } catch { err.detail = text.slice(0, 200); }
      throw err;
    }
    return res;
  } finally { done(); }
}

// يبثّ أحداث SSE للمزود ويعيد النص الكامل. يدعم event-stream وJSON.
export async function* streamCompletion({ endpoint, key, model, messages, maxTokens, signal, session, onFirstToken }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    try {
      const res = await postOnce({ endpoint, key, body: { model, messages, max_tokens: maxTokens, temperature: 0.6 }, stream: true, signal, session });
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('event-stream') || !res.body) {
        // المزود ردّ JSON عادي — نحوّله لدفعة واحدة (fallback)
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || '';
        onFirstToken?.();
        if (text) yield { type: 'text', text };
        yield { type: 'done', finish: data?.choices?.[0]?.finish_reason || 'stop' };
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let gotText = false;
      const cancel = () => reader.cancel().catch(() => {});
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split('\n')) {
              const l = line.trim();
              if (!l.startsWith('data:')) continue;
              const payload = l.slice(5).trim();
              if (payload === '[DONE]') { yield { type: 'done', finish: 'stop' }; return; }
              try {
                const j = JSON.parse(payload);
                const ch = j?.choices?.[0];
                const delta = ch?.delta?.content || ch?.message?.content || '';
                if (delta) { if (!gotText) { gotText = true; onFirstToken?.(); } yield { type: 'text', text: String(delta) }; }
                if (ch?.finish_reason) { yield { type: 'done', finish: ch.finish_reason }; return; }
              } catch { /* سطر غير JSON — تجاهل */ }
            }
          }
        }
        yield { type: 'done', finish: 'stop' };
        return;
      } finally {
        signal?.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw signal.reason;
      const canRetry = e?.retryable !== false && (e?.retryable || /timeout|network|fetch failed|econn|enotfound|eai_again|socket|reset/i.test(String(e?.message)));
      if (!canRetry || attempt === RETRIES) throw e;
      await sleep(BACKOFF[attempt - 1] || 4000, signal);
    }
  }
  throw lastErr || new Error('UPSTREAM_FAILED');
}
