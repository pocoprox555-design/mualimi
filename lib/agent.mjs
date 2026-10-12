// Open tool loop: the model interprets the conversation and chooses every curriculum action.
import { streamCompletion } from './provider.mjs';
import { TOOLS, executeTool } from './tools.mjs';
import { childLogger } from './http.mjs';

const MAX_TOOL_ROUNDS = 64;
const MAX_CONTINUATIONS = 24;
const MAX_REPEAT_CALLS = 3;
const TOOL_TIMEOUT_MS = 180_000;
const REQUEST_DEADLINE_MS = 30 * 60 * 1_000;
const KEEP_RECENT_TOOL_RESULTS = 8;
const IMAGE_CONTEXT_CHAR_ESTIMATE = 24_000;

function agentError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (Array.isArray(raw)) return { parseError: 'tool arguments must be a JSON object' };
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be a JSON object');
    return parsed;
  } catch (error) {
    return { parseError: String(error?.message || error) };
  }
}

function serializedSize(value) {
  try { return JSON.stringify(value ?? '').length; } catch { return String(value ?? '').length; }
}

function contentSize(message) {
  const content = message?.content;
  const contentChars = Array.isArray(content)
    ? content.reduce((total, part) => {
        if (part?.type === 'text') return total + String(part.text || '').length;
        if (part?.type === 'image_url') return total + IMAGE_CONTEXT_CHAR_ESTIMATE;
        return total + serializedSize(part);
      }, 0)
    : serializedSize(content);
  return contentChars + serializedSize(message?.tool_calls || []);
}

function contextSize(messages) {
  return messages.reduce((total, message) => total + contentSize(message), 0);
}

function fitContext(messages, maxPromptChars, log, requestId) {
  const limit = Math.max(4_000, Number(maxPromptChars) || 1_000_000);
  const before = contextSize(messages);
  if (before <= limit) return { chars: before, compacted: [] };

  const toolIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndexes.push(index);
  }
  const oldIndexes = toolIndexes.slice(0, Math.max(0, toolIndexes.length - KEEP_RECENT_TOOL_RESULTS));
  const compacted = [];
  for (const index of oldIndexes) {
    if (contextSize(messages) <= limit) break;
    const message = messages[index];
    const previousChars = contentSize(message);
    message.content = `[محتوى نتيجة أداة قديمة أُزيل لتوفير نافذة السياق (${previousChars} محرفاً). اسم الأداة: ${message.name || 'غير معروف'}؛ أعيدي استدعاء الأداة إذا احتجتِ هذه البيانات.]`;
    compacted.push({ name: message.name || 'unknown', chars: previousChars });
  }
  let after = contextSize(messages);
  const continuationIndexes = messages
    .map((message, index) => message?.role === 'assistant' && message?.name === 'agent-continuation' ? index : -1)
    .filter((index) => index >= 0);
  const oldContinuations = continuationIndexes.slice(0, Math.max(0, continuationIndexes.length - 1));
  let compactedContinuations = 0;
  for (const index of oldContinuations) {
    if (after <= limit) break;
    const message = messages[index];
    const previousChars = contentSize(message);
    message.content = `[جزء سابق من الرد بُثّ للطالبة واختُصر هنا لتوفير السياق (${previousChars} محرفاً). أكملي من الجزء الأحدث دون إعادة ما سبق.]`;
    compactedContinuations += 1;
    after = contextSize(messages);
  }
  if (compacted.length || compactedContinuations) {
    log.warn('old conversation content compacted', { toolResults: compacted.length, responseParts: compactedContinuations, before, after, limit, requestId });
  }
  if (after > limit) throw agentError('CONTEXT_WINDOW_EXCEEDED', `The conversation still exceeds the configured prompt budget after older tool results and already-streamed response parts were marked for re-fetch (${after} > ${limit} characters).`);
  return { chars: after, compacted, compactedContinuations };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function callKey(name, args) {
  return `${String(name || '')}:${canonical(args)}`;
}

function citationKey(source) {
  return `${source.bookId}:${source.printedPage ?? source.physicalPage}`;
}

function conciseToolMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const { citation, citations, page, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

function callToolWithTimeout(name, args, { signal, sendImage }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = signal.reason || agentError('CLIENT_ABORTED');
      controller.abort(error);
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      const error = agentError('TOOL_TIMEOUT', `Tool ${name} exceeded ${TOOL_TIMEOUT_MS}ms.`);
      controller.abort(error);
      finish(resolve, {
        ok: false,
        error: 'TOOL_TIMEOUT',
        content: `تعذّر إكمال الأداة ${name} خلال المهلة. يمكن تجربة أداة أخرى أو إعادة النداء بمدخلات مختلفة.`,
        meta: { detail: error.message },
      });
    }, TOOL_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    executeTool(name, args, { sendImage, signal: controller.signal })
      .then((result) => finish(resolve, result), (error) => finish(reject, error));
  });
}

/** Run model turns, execute each requested tool, and return every result to the model. */
export async function runAgentLoop(input) {
  const {
    config,
    messages,
    tools = TOOLS,
    signal,
    session,
    requestId,
    onText,
    onCitations,
    onStep,
    sendImage = true,
    temperature = 0.1,
    maxTokens,
  } = input;
  const log = childLogger(requestId, { model: config.model });
  const toolDefinitions = Array.isArray(tools) ? tools : [];
  const conversation = messages.map((message) => ({ ...message }));
  const replyBudget = Number(maxTokens) || config.maxTokens;
  const citations = [];
  const citationKeys = new Set();
  const toolCalls = [];
  const evidenceLengths = [];
  const repeatCounts = new Map();
  const deadline = Date.now() + REQUEST_DEADLINE_MS;
  let rounds = 0;
  let continuations = 0;
  let finish = 'stop';
  let completed = false;

  const addCitation = (source) => {
    if (!source?.bookId) return;
    const key = citationKey(source);
    if (citationKeys.has(key)) return;
    citationKeys.add(key);
    citations.push(source);
    onCitations?.(source);
  };

  for (rounds = 1; rounds <= MAX_TOOL_ROUNDS; rounds += 1) {
    if (signal?.aborted) throw signal.reason || agentError('CLIENT_ABORTED');
    if (Date.now() >= deadline) throw agentError('AGENT_DEADLINE', 'The agent request exceeded its overall deadline.');

    const toolDefinitionChars = serializedSize(toolDefinitions);
    fitContext(conversation, Math.max(4_000, (Number(config.maxPromptChars) || 1_000_000) - toolDefinitionChars), log, requestId);
    const roundText = [];
    const roundCalls = new Map();
    let sawToolCall = false;
    let streamError = null;

    try {
      const stream = streamCompletion({
        endpoint: config.endpoint,
        key: config.key,
        model: config.model,
        messages: conversation,
        maxTokens: replyBudget,
        temperature,
        tools: toolDefinitions.length ? toolDefinitions : null,
        tool_choice: toolDefinitions.length ? 'auto' : 'none',
        signal,
        session,
        onFirstToken: () => onStep?.({ phase: 'write', label: 'بدأت الكتابة' }),
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          roundText.push(event.text);
          onText?.(event.text);
        } else if (event.type === 'tool') {
          sawToolCall = true;
          const index = Number.isInteger(Number(event.tool?.index)) ? Number(event.tool.index) : 0;
          const entry = roundCalls.get(index) || { index, id: '', name: '', arguments: '', final: false };
          if (event.tool?.id) entry.id = event.tool.id;
          if (event.tool?.name) entry.name = event.tool.name;
          const fragment = String(event.tool?.arguments ?? '');
          entry.arguments = event.tool?.final ? fragment : entry.arguments + fragment;
          entry.final ||= Boolean(event.tool?.final);
          roundCalls.set(index, entry);
        } else if (event.type === 'done') {
          finish = event.finish || 'stop';
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      streamError = error;
      log.warn('model stream interrupted', {
        round: rounds,
        code: error?.code || error?.message || 'UPSTREAM_FAILED',
        partialChars: roundText.join('').length,
        calls: roundCalls.size,
      });
    }

    const responseText = roundText.join('');
    const calls = [...roundCalls.values()].sort((a, b) => a.index - b.index);

    if (calls.length) {
      const assistantCalls = calls.map((call) => ({
        id: call.id || `call_${rounds}_${call.index}`,
        type: 'function',
        function: { name: call.name || '__missing_tool_name__', arguments: call.arguments || '{}' },
      }));
      conversation.push({ role: 'assistant', content: responseText || '', tool_calls: assistantCalls });

      for (const call of calls) {
        const callName = call.name || '__missing_tool_name__';
        const args = parseArguments(call.arguments);
        const key = callKey(callName, args);
        const repeated = (repeatCounts.get(key) || 0) + 1;
        repeatCounts.set(key, repeated);
        const callInfo = { name: callName, args, round: rounds, repeated };
        toolCalls.push(callInfo);
        onStep?.({ phase: 'tool', label: `تنفيذ ${call.name || 'أداة غير معروفة'}` });
        log.info('tool call', {
          name: callName,
          args: canonical(args).slice(0, 500),
          round: rounds,
          repeated,
        });

        let result;
        if (repeated > MAX_REPEAT_CALLS) {
          result = {
            ok: false,
            error: 'REPEATED_TOOL_CALL',
            content: `تم تكرار النداء نفسه ${repeated} مرات بمدخلات مطابقة. لم يُنفّذ مجدداً لتفادي حلقة بلا تقدم؛ غيّري المدخلات أو أجيبي بما لديك.`,
            meta: { repeated },
          };
        } else {
          result = await callToolWithTimeout(callName, args, { sendImage, signal });
        }

        const toolMeta = result?.meta || {};
        const meta = conciseToolMeta(toolMeta);
        let payload = {
          ok: Boolean(result?.ok),
          ...(result?.error ? { error: result.error } : {}),
          content: String(result?.content ?? ''),
          ...(meta ? { meta } : {}),
        };
        const image = result?.image && sendImage ? result.image : '';
        const contentParts = () => {
          const parts = [{ type: 'text', text: JSON.stringify(payload) }];
          if (image) parts.push({ type: 'image_url', image_url: { url: image } });
          return parts;
        };
        const promptLimit = Math.max(4_000, (Number(config.maxPromptChars) || 1_000_000) - serializedSize(toolDefinitions));
        const availableChars = promptLimit - contextSize(conversation);
        const proposedContent = contentParts();
        const proposedSize = contentSize({ role: 'tool', content: proposedContent });
        if (payload.ok && proposedSize > availableChars) {
          log.warn('tool result exceeds remaining context; returning pagination guidance', {
            name: callName,
            contentChars: payload.content.length,
            proposedChars: proposedSize,
            availableChars,
          });
          payload = {
            ok: false,
            error: 'TOOL_RESULT_EXCEEDS_CONTEXT',
            content: `النتيجة الكاملة لهذه الدفعة (${payload.content.length} محرفاً) لا تتسع في السياق المتبقي (${Math.max(0, availableChars)} محرفاً). لم يُحذف جزء من النتيجة؛ أعيدي النداء بدفعة أصغر باستخدام offset/limit، أو قسّمي نطاق الصفحات.`,
          };
        } else {
          if (toolMeta.citations) for (const source of toolMeta.citations) addCitation(source);
          if (toolMeta.citation) addCitation(toolMeta.citation);
        }

        evidenceLengths.push(payload.content.length);
        const parts = [{ type: 'text', text: JSON.stringify(payload) }];
        if (payload.ok && image) parts.push({ type: 'image_url', image_url: { url: image } });
        conversation.push({
          role: 'tool',
          tool_call_id: call.id || `call_${rounds}_${call.index}`,
          name: callName,
          content: parts.length > 1 ? parts : JSON.stringify(payload),
        });
        log.info('tool result', {
          name: callName,
          ok: payload.ok,
          error: payload.error || null,
          chars: payload.content.length,
          excerpt: payload.content.replace(/\s+/g, ' ').slice(0, 600),
        });
      }
      continue;
    }

    const needsFinalTextAfterTools = !responseText.trim() && evidenceLengths.length > 0;
    if (finish === 'length' || streamError || (sawToolCall && finish === 'tool_calls') || needsFinalTextAfterTools) {
      if (continuations >= MAX_CONTINUATIONS) {
        throw agentError('AGENT_CONTINUATION_LIMIT', `The model did not complete after ${continuations} continuation turns.`);
      }
      if (streamError && !responseText) throw streamError;
      if (responseText) conversation.push({ role: 'assistant', name: 'agent-continuation', content: responseText });
      const reason = finish === 'length'
        ? 'وصل الرد إلى حد خرج المزوّد. تابعي من آخر كلمة دون إعادة ما سبق، وأكملي الإجابة كاملة.'
        : sawToolCall
          ? 'لم يصل اسم/وسيط مكتمل لأداة. تابعي نصاً بما لديك، أو أعيدي نداء الأداة بوسيط JSON صالح.'
          : needsFinalTextAfterTools
            ? 'اكتبي الإجابة النهائية للطالبة الآن اعتماداً على نتائج الأدوات التي حصلتِ عليها.'
            : 'انقطع البث بعد جزء من الرد. تابعي من آخر كلمة دون تكرار ما ظهر، واكملي الإجابة كاملة.';
      conversation.push({ role: 'user', content: reason });
      continuations += 1;
      onStep?.({ phase: 'write', label: 'أستكمل الإجابة' });
      log.info('continuation requested', { round: rounds, continuations, reason: finish || streamError?.code || 'incomplete' });
      finish = 'stop';
      continue;
    }

    if (streamError) throw streamError;
    if (finish === 'content_filter') throw agentError('UPSTREAM_CONTENT_FILTER');
    completed = true;
    break;
  }

  if (!completed) throw agentError('AGENT_TOOL_ROUND_LIMIT', `The agent reached its ${MAX_TOOL_ROUNDS}-round tool-loop limit.`);

  const evidenceChars = evidenceLengths.reduce((total, length) => total + length, 0);
  const promptChars = contextSize(conversation);
  const perMessage = conversation.map((message) => ({ role: message.role, chars: contentSize(message) }));
  return {
    text: '',
    citations,
    finish,
    rounds,
    continuations,
    toolCalls,
    evidenceChars,
    promptChars,
    messageCount: conversation.length,
    perMessage,
  };
}
