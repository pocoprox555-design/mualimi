// معلمي — وسيط رفيع بين الطالبة والنموذج وملفات المنهج.
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env')); } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

import { publicConfig, resolveProvider, supportsVision } from './lib/config.mjs';
import { assertIndexFresh, getHealth, getSubjects, listBooks, searchCandidates } from './lib/index.mjs';
import { TOOLS, executeTool, TOOL_NAMES } from './lib/tools.mjs';
import { runAgentLoop } from './lib/agent.mjs';
import {
  heartbeat, readJsonBody, sendJson, serveStatic, sseHeaders, sseSend,
  newRequestId, logPrompt, logEvidence, recordExchange, childLogger,
} from './lib/http.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const STUDENT_TRACK = 'ديني';
const startedAt = Date.now();
const providerHealth = { verified: null, lastError: null, checkedAt: 0, fingerprint: '' };

function providerFingerprint(config) {
  return createHash('sha256')
    .update(`${config?.endpoint || ''}\0${config?.model || ''}\0${config?.key || ''}`)
    .digest('hex');
}

function providerHealthFor(config) {
  return providerHealth.fingerprint === providerFingerprint(config)
    ? { verified: providerHealth.verified, lastError: providerHealth.lastError }
    : { verified: null, lastError: null };
}

function markProviderHealth(config, verified, lastError = null) {
  providerHealth.fingerprint = providerFingerprint(config);
  providerHealth.verified = verified;
  providerHealth.lastError = lastError;
  providerHealth.checkedAt = Date.now();
}

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function textOf(content) {
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n');
  return typeof content === 'string' ? content : '';
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    .map((part) => part.image_url.url)
    .filter((url) => /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(url))
    .filter((url) => url.length <= 1_500_000);
}

function historyFor(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: message.content }));
}

function safeSession(value) {
  const session = clean(value).replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 100);
  return session || `mualimi-${Date.now().toString(36)}`;
}

function systemPrompt(studentName = '', canSeeImages = false) {
  const name = clean(studentName).slice(0, 80) || 'رحمة';
  return `أنتِ معلّمة خبيرة بالمنهج ومعلّمة ${name} الخاصة، بعربية واضحة وصيغة المؤنث. مكتبة كتب المنهج وفهارسها كاملة بين يديك عبر الأدوات. أنتِ تقررين أين تبحثين وماذا تقرئين ومتى تكتفين. تحققي من الكتب قبل كل معلومة منهجية، واذكري الكتاب والصفحة؛ فرّقي الرقم المطبوع عن رقم PDF الفيزيائي. الأوصاف ليست نص الكتاب وحالات الاستخراج والترقيم ليست ضماناً بصرياً. اعترفي صراحةً إن لم تجدي أو لم تستطيعي التحقق. عند طلب رحمة اختباراً تفاعلياً صريحاً، قدّمي تمهيداً قصيراً ثم كتلة واحدة داخل سياج الشيفرة الموسوم quiz، بصيغة JSON ذات المفاتيح title وsubject وquestions؛ وليحتوِ كل سؤال على q وoptions وanswer (فهرس يبدأ من صفر) وwhy. اجعلي الخيارات واضحة ومتوازنة، ولا تذكري الإجابة الصحيحة أو تفسيرها خارج الكتلة كي يكشفهما التطبيق بعد اختيار رحمة. استندي إلى الأدوات للتحقق من الحقائق المنهجية، ولا تختلقي أسئلة أو أدلة. انقلي ما أعطتك الأدوات كما هو: لا تُكملي الناقص من ذاكرتك، ولا تُسوّي المتعارض بصمت، وما لم يرد في نتيجة أداة فصرّحي بغيابه. اعملي بالأدوات بصمت ولا تسردي خطواتك داخل الرد، وإذا غمض المطلوب فاسألي سؤالاً واحداً ولا تفترضي، وأجيبي باختصار (الأهم فالخلاصة) بلا حشو ولا سؤال متابعة مكرر. المسار المعتمد لرحمة هو التعليم الديني (ديوان الوقف السني)؛ استخدمي كتبه فقط، وكتاب الرياضيات المطلوب هو كتاب ديوان الوقف السني. كتب الأدبي خارج نطاقها. الصور ${canSeeImages ? 'مدعومة' : 'غير مدعومة'} في هذا الطلب.`;
}

function errorCode(error) {
  if (error?.code && /^[A-Z0-9_]+$/.test(String(error.code))) return String(error.code);
  if (error?.status === 401 || error?.status === 403) return 'UPSTREAM_AUTH';
  if (error?.status === 400) return 'UPSTREAM_BAD_REQUEST';
  if (error?.status === 404) return 'UPSTREAM_MODEL';
  if (error?.status === 408) return 'UPSTREAM_TIMEOUT';
  if (error?.status === 429) return 'UPSTREAM_BUSY';
  if (error?.status) return `UPSTREAM_HTTP_${error.status}`;
  if (/timeout/i.test(String(error?.message || ''))) return 'UPSTREAM_TIMEOUT';
  if (/network|fetch failed|econn|enotfound|socket|reset/i.test(String(error?.message || ''))) return 'UPSTREAM_NETWORK';
  return 'UPSTREAM_FAILED';
}

async function handleChat(req, res) {
  let body;
  try { body = await readJsonBody(req, 8 * 1024 * 1024); } catch (error) {
    return sendJson(res, error.message === 'TOO_LARGE' ? 413 : 400, { error: error.message });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const currentIndex = rawMessages.findLastIndex((message) => message?.role === 'user');
  if (currentIndex < 0) return sendJson(res, 400, { error: 'EMPTY_MESSAGE' });
  const rawCurrent = rawMessages[currentIndex];
  const question = textOf(rawCurrent?.content);
  const priorHistory = historyFor(rawMessages.slice(0, currentIndex));
  const suppliedImageCount = Array.isArray(rawCurrent?.content)
    ? rawCurrent.content.filter((part) => part?.type === 'image_url').length
    : 0;
  const images = imageParts(rawCurrent?.content);
  const config = resolveProvider({ headers: req.headers });
  const hasUnsupportedImages = rawMessages.some((message) => Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url' && (!supportsVision(config.model) || imageParts([part]).length !== 1)));
  if (hasUnsupportedImages) return sendJson(res, 400, { error: 'IMAGE_INPUT_UNSUPPORTED', detail: 'لم يُرسل الطلب: صورة غير مدعومة أو أكبر من حد النقل؛ لم تُحذف بصمت.' });
  const rejectedImageCount = Math.max(0, suppliedImageCount - images.length);
  if (!question.trim() && !images.length && !rejectedImageCount) return sendJson(res, 400, { error: 'EMPTY_MESSAGE' });

  const started = Date.now();
  const requestId = newRequestId();
  const session = safeSession(req.headers['x-session']);
  const log = childLogger(requestId, { model: config.model });
  if (config.warnContext) log.warn('declared context window exceeds the known model window', { warning: config.warnContext, budgetWindow: config.budgetWindow, maxPromptChars: config.maxPromptChars });
  if (config.error) {
    log.error('provider configuration failed', { code: config.error, question: question.slice(0, 500) });
    recordExchange(requestId, { question, finish: 'error', error: config.error, totalMs: Date.now() - started });
    return sendJson(res, 500, { error: config.error });
  }

  const abort = new AbortController();
  const onClose = () => abort.abort(new Error('CLIENT_ABORTED'));
  req.once('aborted', onClose);
  res.once('close', onClose);
  sseHeaders(res);
  const stopHeartbeat = heartbeat(res);
  const canSee = supportsVision(config.model);
  const citations = [];
  const citationKeys = new Set();
  let output = '';
  let firstTokenAt = 0;
  const trace = [];
  log.info('question received', {
    question: question.slice(0, 500),
    priorMessages: priorHistory.length,
    imagesReceived: suppliedImageCount,
    imagesAccepted: images.length,
    imagesRejected: rejectedImageCount,
  });

  const step = (phase, label, detail = '') => {
    if (detail) log.info(`step ${phase}`, { label: clean(label).slice(0, 90), detail: clean(detail).slice(0, 240) });
    if (['write', 'tool'].includes(phase)) sseSend(res, 'step', { phase, label: clean(label).slice(0, 90), at: Date.now() - started });
  };

  try {
    if (!config.key) {
      log.warn('question not sent because no API key was provided', { question: question.slice(0, 500) });
      recordExchange(requestId, { question, finish: 'error', error: 'AI_NOT_CONFIGURED', totalMs: Date.now() - started });
      sseSend(res, 'citations', { items: [] });
      sseSend(res, 'error', { error: 'AI_NOT_CONFIGURED' });
      return;
    }

    const currentUserContent = rawCurrent.content;
    const conversation = [
      { role: 'system', content: systemPrompt(body.studentName, canSee) },
      ...priorHistory,
      { role: 'user', content: currentUserContent },
    ];

    sseSend(res, 'citations', { items: [] });
    const result = await runAgentLoop({
      config,
      messages: conversation,
      tools: TOOLS,
      signal: abort.signal,
      session,
      requestId,
      onTrace: (round) => trace.push(round),
      sendImage: canSee,
      track: STUDENT_TRACK,
      onText(text) {
        output += text;
        firstTokenAt ||= Date.now();
        return sseSend(res, 'delta', { text });
      },
      onStep: (info) => step(info.phase, info.label, info.detail),
      onCitations(source) {
        const key = `${source.bookId}:${source.physicalPage}`;
        if (citationKeys.has(key)) return;
        citationKeys.add(key);
        citations.push(source);
        sseSend(res, 'citations', { items: citations });
      },
    });

    if (!output.trim()) throw Object.assign(new Error('EMPTY_REPLY'), { code: 'EMPTY_REPLY' });
    logEvidence(requestId, {
      blockChars: result.evidenceChars,
      sourceIds: citations.map((source) => source.id),
      images: images.length,
      truncatedSources: result.truncatedSources || [],
    });
    logPrompt(requestId, {
      model: config.model,
      maxTokens: config.maxTokens,
      messageCount: result.messageCount,
      chars: result.promptChars,
      perMessage: result.perMessage,
    });
    recordExchange(requestId, {
      question,
      finish: result.finish,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
      totalMs: Date.now() - started,
      toolCalls: result.toolCalls,
      rounds: result.rounds,
      continuations: result.continuations,
      trace,
    });
    markProviderHealth(config, true);
    sseSend(res, 'done', {
      finish: result.finish,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
      sources: citations.length,
      tools: result.toolCalls.map((call) => call.name),
      rounds: result.rounds,
    });
  } catch (error) {
    const code = abort.signal.aborted ? 'CLIENT_ABORTED' : errorCode(error);
    recordExchange(requestId, {
      question,
      finish: 'error',
      error: code,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : 0,
      totalMs: Date.now() - started,
      partialChars: output.length,
      trace,
    });
    if (abort.signal.aborted) {
      log.info('client cancelled chat', { code, outputChars: output.length });
    } else if (!res.writableEnded) {
      log.error('chat failed', { code, detail: clean(error?.detail || error?.message).slice(0, 300), outputChars: output.length });
      if (String(code).startsWith('UPSTREAM_')) markProviderHealth(config, false, code);
      sseSend(res, 'error', { error: code, detail: clean(error?.detail || error?.message).slice(0, 240) });
    }
  } finally {
    stopHeartbeat();
    req.off?.('aborted', onClose);
    res.off?.('close', onClose);
    // Abort the controller so any in-flight provider fetch or agent round
    // sees the signal and unwinds immediately — prevents orphaned connections
    // lingering after the SSE stream has been fully sent.
    if (!abort.signal.aborted) abort.abort(new Error('REQUEST_COMPLETE'));
    if (!res.writableEnded) res.end();
    // Force-close the underlying socket if still open; keep-alive can keep
    // the TCP connection alive long after the logical response ended.
    if (!res.destroyed) res.destroy();
  }
}

async function api(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/health' && req.method === 'GET') {
    try {
      const curriculum = await getHealth();
      const ai = resolveProvider({ headers: req.headers });
      return sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), curriculum, ai: { ...publicConfig(ai), ...providerHealthFor(ai) } });
    } catch (error) { return sendJson(res, 503, { ok: false, error: error.message }); }
  }
  if ((pathname === '/api/bootstrap' || pathname === '/api/config') && req.method === 'GET') {
    try {
      const config = resolveProvider({ headers: req.headers });
      const [books, subjects, curriculum] = await Promise.all([listBooks({ track: STUDENT_TRACK }), getSubjects({ track: STUDENT_TRACK }), getHealth()]);
      return sendJson(res, 200, {
        app: { name: 'معلمي', version: '8.0.0' },
        ...publicConfig(config),
        ...providerHealthFor(config),
        books,
        subjects,
        curriculum,
        tools: [...TOOL_NAMES],
      });
    } catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (pathname === '/api/books' && req.method === 'GET') {
    try {
      const books = await listBooks({ subject: clean(url.searchParams.get('subject')), track: STUDENT_TRACK });
      return sendJson(res, 200, { books });
    } catch (error) { return sendJson(res, 503, { error: error.message }); }
  }
  if (pathname === '/api/search' && req.method === 'GET') {
    const query = clean(url.searchParams.get('q'));
    if (!query) return sendJson(res, 400, { error: 'QUERY_REQUIRED' });
    try {
      const results = await searchCandidates(query, {
        bookId: clean(url.searchParams.get('bookId')),
        subject: clean(url.searchParams.get('subject')),
        track: STUDENT_TRACK,
        offset: Number(url.searchParams.get('offset')) || 0,
        limit: Number(url.searchParams.get('limit')) || 24,
      });
      return sendJson(res, 200, results);
    } catch (error) { return sendJson(res, 503, { error: 'SEARCH_FAILED', detail: clean(error?.message).slice(0, 240) }); }
  }
  if (pathname === '/api/page' && req.method === 'GET') {
    const bookId = clean(url.searchParams.get('bookId'));
    const printed = url.searchParams.get('printed');
    const physical = url.searchParams.get('page');
    if (!bookId) return sendJson(res, 400, { error: 'BAD_PARAMS' });
    const result = await executeTool('read_page', {
      bookId,
      printedPage: printed == null ? undefined : Number(printed),
      physicalPage: physical == null ? undefined : Number(physical),
    }, { sendImage: false, track: STUDENT_TRACK });
    if (!result.ok) return sendJson(res, 404, { error: result.error || 'PAGE_NOT_FOUND', detail: result.content });
    return sendJson(res, 200, result.meta?.page || {});
  }
  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
    if (req.method === 'GET' && await serveStatic(req, res, PUBLIC_ROOT)) return;
    if (req.method === 'GET' && await serveStatic({ url: '/' }, res, PUBLIC_ROOT)) return;
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error('request failed:', error?.message || error);
    if (!res.headersSent) sendJson(res, 500, { error: 'SERVER_ERROR', detail: clean(error?.message).slice(0, 240) });
    else if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.PORT) || 3000;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.listen(port, '0.0.0.0', () => {
  const boot = resolveProvider({});
  console.log(`Mualimi thin-agent ready on :${port} (model=${boot.model}, tools=${TOOL_NAMES.size})`);
  if (boot.warnModel) console.warn(`model notice: ${boot.warnModel}`);
  setTimeout(async () => {
    try { console.log('index freshness:', JSON.stringify(await assertIndexFresh())); } catch (error) { console.warn('index freshness check failed:', error?.message || error); }
    import('./lib/pdf-fallback.mjs').then((module) => module.warmPdfRuntime?.()).catch(() => {});
    import('./lib/index.mjs').then((module) => module.warmSearch?.()).catch((error) => console.warn('search warmup failed:', error.message));
  }, 1_000).unref?.();
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
