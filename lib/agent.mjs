// The model decides; the connector transports turns and executes read-only tools.
import { streamCompletion } from './provider.mjs';
import { TOOLS, executeTool } from './tools.mjs';

const MAX_ROUNDS = 4096; // Emergency protection against an actual unending conversation.

function failure(code, detail = code) {
  return Object.assign(new Error(detail), { code });
}

function argumentsOf(raw) {
  try {
    const args = typeof raw === 'object' ? raw : JSON.parse(raw || '{}');
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Expected a JSON object.');
    return args;
  } catch (error) {
    return { parseError: error.message };
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const sizeOf = (value) => JSON.stringify(value ?? '').length;

export async function runAgentLoop({
  config, messages, tools = TOOLS, signal, session,
  onText, onCitations, onStep, onTrace, sendImage = true, temperature = 0.1, maxTokens,
}) {
  const conversation = messages.map((message) => ({ ...message }));
  const citations = [];
  const seenCitations = new Set();
  const toolCalls = [];
  const resultCache = new Map();
  let evidenceChars = 0;
  let continuations = 0;
  let interruptions = 0;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    let text = '';
    let finish = '';
    let streamError;
    const calls = new Map();
    const started = Date.now();
    const trace = { round, promptChars: sizeOf(conversation), tools: [] };
    onTrace?.(trace);
    try {
      for await (const event of streamCompletion({
        endpoint: config.endpoint, key: config.key, model: config.model,
        messages: conversation, tools, tool_choice: 'auto',
        maxTokens: maxTokens || config.maxTokens, temperature, signal, session,
        onFirstToken: () => onStep?.({ phase: 'write', label: 'بدأت الكتابة' }),
        onAttempt: (attempt) => (trace.attempts ||= []).push(attempt),
      })) {
        if (event.type === 'text') {
          text += event.text;
          await onText?.(event.text);
        } else if (event.type === 'tool' && event.tool.final) {
          calls.set(event.tool.index, event.tool);
        } else if (event.type === 'done') {
          finish = event.finish;
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      streamError = error;
    }
    trace.modelMs = Date.now() - started;
    trace.finish = finish || streamError?.code || streamError?.message;

    // Never execute a tool call from an unfinished provider turn.
    if (streamError) {
      interruptions += 1;
      const transient = streamError.retryable === true || /timeout|network|fetch failed|econn|socket|reset|incomplete_stream/i.test(String(streamError.code || streamError.message));
      if (!text || !transient || interruptions > 3) throw streamError;
      conversation.push({ role: 'assistant', content: text });
      conversation.push({ role: 'system', content: 'انقطع النقل. تابعي من آخر موضع وصل دون تكراره؛ يمكنك استخدام الأدوات إن احتجتِ.' });
      continuations += 1;
      onStep?.({ phase: 'write', label: 'أستكمل الرد بعد انقطاع الاتصال' });
      continue;
    }
    interruptions = 0;

    if (calls.size) {
      const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
      const assistantCalls = ordered.map((call) => ({
        id: call.id || `call_${round}_${call.index}`, type: 'function',
        function: { name: call.name || '__missing_tool_name__', arguments: call.arguments || '{}' },
      }));
      conversation.push({ role: 'assistant', content: text, tool_calls: assistantCalls });
      const results = await Promise.all(ordered.map(async (call, index) => {
        const name = assistantCalls[index].function.name;
        const args = argumentsOf(call.arguments);
        const key = `${name}:${canonical(args)}`;
        const info = { name, args, round, cached: resultCache.has(key) };
        toolCalls.push(info);
        trace.tools.push(info);
        onStep?.({ phase: 'tool', label: 'أقرأ من مكتبة المنهج' });
        const toolStarted = Date.now();
        if (!resultCache.has(key)) {
          // Cache in-flight identical reads, but not failures: retries can recover.
          resultCache.set(key, executeTool(name, args, { signal, sendImage }).catch((error) => ({
            ok: false, error: error.code || 'TOOL_FAILED', content: error.message,
          })));
        }
        const result = await resultCache.get(key);
        if (!result?.ok || result.image) resultCache.delete(key);
        signal?.throwIfAborted();
        const { image, ...payload } = result;
        // meta.page is the same complete page already serialized in content, not another evidence version.
        if (payload.meta?.page) {
          const { page, ...meta } = payload.meta;
          payload.meta = meta;
        }
        info.ms = Date.now() - toolStarted;
        info.ok = Boolean(result.ok);
        info.error = result.error || null;
        if (!result.ok) info.detail = String(result.content || '').slice(0, 300);
        info.chars = String(result.content || '').length;
        info.returned = result.meta?.returned ?? result.meta?.opened ?? null;
        info.nextOffset = result.meta?.nextOffset ?? null;
        info.status = result.meta?.page?.status ?? null;
        info.source = result.meta?.page?.textSource ?? null;
        info.pdfCache = result.meta?.page?.fromCache ?? null;
        info.image = Boolean(image && sendImage);
        info.pages = [...(result.meta?.citations || []), ...(result.meta?.citation ? [result.meta.citation] : [])].map((page) => ({ bookId: page.bookId, physicalPage: page.physicalPage, printedPage: page.printedPage, status: page.evidenceStatus }));
        evidenceChars += info.chars;
        for (const source of [...(result.meta?.citations || []), ...(result.meta?.citation ? [result.meta.citation] : [])]) {
          const sourceKey = `${source.bookId}:${source.physicalPage}`;
          if (!seenCitations.has(sourceKey)) {
            seenCitations.add(sourceKey);
            citations.push(source);
            onCitations?.(source);
          }
        }
        const content = JSON.stringify(payload);
        return {
          role: 'tool', tool_call_id: assistantCalls[index].id, name,
          content: image && sendImage ? [
            { type: 'text', text: content }, { type: 'image_url', image_url: { url: image } },
          ] : content,
        };
      }));
      conversation.push(...results);
      continue;
    }

    if (finish === 'length') {
      if (text) conversation.push({ role: 'assistant', content: text });
      conversation.push({ role: 'system', content: 'وصل النقل إلى حد خرج المزوّد. تابعي من آخر موضع وصل دون تكراره.' });
      continuations += 1;
      onStep?.({ phase: 'write', label: 'أستكمل الإجابة' });
      continue;
    }
    if (finish === 'content_filter') throw failure('UPSTREAM_CONTENT_FILTER');
    if (finish === 'tool_calls') throw failure('UPSTREAM_MISSING_TOOL_CALLS');
    if (!text.trim()) throw failure('EMPTY_REPLY');
    return {
      text, citations, finish, rounds: round, continuations, toolCalls, evidenceChars,
      promptChars: sizeOf(conversation), messageCount: conversation.length,
      perMessage: conversation.map((message) => ({ role: message.role, chars: sizeOf(message) })),
    };
  }
  throw failure('AGENT_TOOL_ROUND_LIMIT', `The model exceeded the emergency limit of ${MAX_ROUNDS} turns.`);
}
