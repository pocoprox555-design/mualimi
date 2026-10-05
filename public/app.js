'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'mualimi.v3';
const LEGACY_SETTINGS = 'm2_settings';
const LEGACY_CONVERSATIONS = 'm2_convs';
const LEGACY_EXAMS = 'm2_exams';
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES_PER_CONVERSATION = 80;
const MAX_REQUEST_MESSAGES = 14;
const MAX_REQUEST_MESSAGE_CHARS = 4_000;
const MAX_SAVED_MESSAGE_CHARS = 5_000;
const MAX_LOCAL_STATE_CHARS = 1_000_000;
const MAX_FALLBACK_STATE_CHARS = 250_000;
const MAX_QUIZ_QUESTIONS = 10;
const MAX_CITATIONS = 16;
const IMAGE_DB_NAME = 'mualimi-image-context-v1';
const IMAGE_STORE_NAME = 'contexts';
const MAX_IMAGE_DATA_URL_CHARS = 800_000;
const MAX_IMAGE_CONTEXTS = 6;
const MAX_IMAGE_CONTEXT_TOTAL_CHARS = 3_600_000;
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const state = {
  settings: { apiKey: '', studentName: 'رحمة', curriculumTrack: 'ديني' },
  books: [],
  curriculum: null,
  ai: { configured: false },
  conversations: [],
  exams: [],
  activeId: null,
  view: 'learn',
  pendingImages: [],
  imageContext: null,
  imageContextCache: new Map(),
  request: null,
  preparingMessage: false,
  composing: false,
  booted: false,
  storageWarningShown: false,
  historyTrimWarningShown: false,
};

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}

function normalizeCitation(source) {
  if (!source || typeof source !== 'object') return null;
  const short = (value, max = 180) => String(value ?? '').slice(0, max);
  const reasons = Array.isArray(source.damageReasons) ? source.damageReasons.map((reason) => short(reason, 140)).filter(Boolean).slice(0, 5) : [];
  const url = safeWebUrl(source.url);
  const evidenceStatus = short(source.evidenceStatus, 60);
  const status = short(source.status, 60);
  const physicalPage = source.physicalPage ?? source.page;
  const evidenceType = short(source.evidenceType, 40);
  const normalizedStatus = normalizedEvidenceToken(evidenceStatus || status);
  const normalizedType = normalizedEvidenceToken(evidenceType);
  const inferredSearchable = source.searchable == null && (['pdf-text', 'ocr-text'].includes(normalizedType) || ['clean-extracted-text', 'clean-text', 'ocr-text'].includes(normalizedStatus));
  return {
    id: short(source.id || 'S', 24),
    bookId: short(source.bookId, 120),
    title: short(source.title, 180),
    subject: short(source.subject, 100),
    track: short(source.track, 60),
    physicalPage: physicalPage != null && Number.isInteger(Number(physicalPage)) && Number(physicalPage) > 0 ? Number(physicalPage) : null,
    printedPage: source.printedPage == null ? null : short(source.printedPage, 40),
    pageTitle: short(source.pageTitle, 180),
    searchable: source.searchable === true || inferredSearchable,
    needsOcr: source.needsOcr === true,
    evidenceType,
    evidenceStatus: evidenceStatus || status,
    status: status || evidenceStatus,
    quotationSource: short(source.quotationSource, 40),
    quotableReliable: source.quotableReliable === true,
    damaged: source.damaged === true,
    damageReasons: reasons,
    sourceType: short(source.sourceType, 40),
    host: short(source.host, 180),
    snippet: short(source.snippet, 450),
    official: source.official === true,
    curriculumSpecific: source.curriculumSpecific === true,
    readable: source.readable === true,
    ...(url ? { url } : {}),
  };
}

function normalizeMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  const original = String(message.content ?? '');
  const cites = Array.isArray(message.cites) ? message.cites.map(normalizeCitation).filter(Boolean).slice(0, MAX_CITATIONS) : [];
  const notices = Array.isArray(message.notices) ? message.notices.map((notice) => String(notice || '').slice(0, 300)).filter(Boolean).slice(0, 4) : [];
  return {
    role: message.role,
    content: original.slice(0, MAX_SAVED_MESSAGE_CHARS),
    truncated: Boolean(message.truncated || original.length > MAX_SAVED_MESSAGE_CHARS),
    cites,
    ...(notices.length ? { notices } : {}),
    ...(message.hasImage ? { hasImage: true, imageOrigin: message.imageOrigin === 'context' ? 'context' : 'attached' } : {}),
  };
}

function normalizeConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return null;
  const originalMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const normalizedMessages = originalMessages.map(normalizeMessage).filter(Boolean);
  const messages = normalizedMessages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  const rawContext = conversation.imageContext;
  const imageContext = rawContext && typeof rawContext === 'object'
    ? { updatedAt: Number(rawContext.updatedAt) || Date.now(), stored: rawContext.stored === true }
    : null;
  return {
    id: String(conversation.id || uid('c')).slice(0, 100),
    title: String(conversation.title || 'جلسة سابقة').slice(0, 100),
    createdAt: Number(conversation.createdAt) || Date.now(),
    updatedAt: Number(conversation.updatedAt || conversation.createdAt) || Date.now(),
    historyTrimmed: conversation.historyTrimmed === true || normalizedMessages.length > MAX_MESSAGES_PER_CONVERSATION,
    imageContext,
    messages,
  };
}

function loadState() {
  const saved = readJson(STORAGE_KEY, null);
  if (saved && typeof saved === 'object') {
    Object.assign(state.settings, saved.settings || {});
    delete state.settings.branch;
    state.conversations = Array.isArray(saved.conversations) ? saved.conversations.map(normalizeConversation).filter(Boolean) : [];
    state.exams = Array.isArray(saved.exams) ? saved.exams : [];
  } else {
    const oldSettings = readJson(LEGACY_SETTINGS, {});
    const oldConversations = readJson(LEGACY_CONVERSATIONS, []);
    const oldExams = readJson(LEGACY_EXAMS, []);
    state.settings.apiKey = oldSettings.key || '';
    state.conversations = Array.isArray(oldConversations) ? oldConversations.map((conversation) => normalizeConversation({
      id: conversation.id || uid('c'),
      title: conversation.title || 'جلسة سابقة',
      createdAt: conversation.at || Date.now(),
      updatedAt: conversation.at || Date.now(),
      messages: Array.isArray(conversation.messages) ? conversation.messages.filter((message) => message?.content).map((message) => ({ ...message, role: message.role === 'assistant' ? 'assistant' : 'user' })) : [],
    })).filter(Boolean) : [];
    state.exams = Array.isArray(oldExams) ? oldExams : [];
  }
  state.settings.apiKey = String(state.settings.apiKey || '').slice(0, 2_048);
  state.settings.studentName = String(state.settings.studentName || 'رحمة').trim().slice(0, 40);
  state.settings.curriculumTrack = 'ديني';
  state.conversations = state.conversations.filter((conversation) => Array.isArray(conversation.messages)).slice(0, MAX_CONVERSATIONS);
  state.exams = state.exams.filter((exam) => exam?.title && exam?.date).slice(0, 80);
  if(state.view === 'plan') state.view = 'learn';
}

function buildStateSnapshot(maxChars) {
  const conversations = state.conversations
    .map((conversation) => ({
      id: conversation.id,
      title: String(conversation.title || 'جلسة جديدة').slice(0, 100),
      createdAt: Number(conversation.createdAt) || Date.now(),
      updatedAt: Number(conversation.updatedAt) || Date.now(),
      historyTrimmed: conversation.historyTrimmed === true,
      imageContext: conversation.imageContext ? { updatedAt: Number(conversation.imageContext.updatedAt) || Date.now(), stored: conversation.imageContext.stored === true } : null,
      messages: (conversation.messages || []).slice(-MAX_MESSAGES_PER_CONVERSATION).map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, MAX_SAVED_MESSAGE_CHARS),
        truncated: Boolean(message.truncated || String(message.content || '').length > MAX_SAVED_MESSAGE_CHARS),
        cites: Array.isArray(message.cites) ? message.cites.map(normalizeCitation).filter(Boolean).slice(0, MAX_CITATIONS) : [],
        ...(Array.isArray(message.notices) && message.notices.length
          ? { notices: message.notices.map((notice) => String(notice || '').slice(0, 300)).filter(Boolean).slice(0, 4) }
          : {}),
        ...(message.hasImage ? { hasImage: true, imageOrigin: message.imageOrigin === 'context' ? 'context' : 'attached' } : {}),
      })),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
  const settings = { ...state.settings, apiKey: String(state.settings.apiKey || '').slice(0, 2_048), studentName: String(state.settings.studentName || 'رحمة').slice(0, 40), curriculumTrack: 'ديني' };
  const snapshot = { settings, conversations, exams: state.exams.slice(-80) };
  const trimmedIds = new Set();
  let serialized = JSON.stringify(snapshot);
  while (serialized.length > maxChars) {
    const candidate = [...conversations].filter((conversation) => conversation.messages.length > 2).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (candidate) {
      candidate.messages.shift();
      candidate.historyTrimmed = true;
      trimmedIds.add(candidate.id);
    } else if (conversations.length > 1) {
      conversations.pop();
    } else if (snapshot.exams.length) {
      snapshot.exams.shift();
    } else {
      break;
    }
    serialized = JSON.stringify(snapshot);
  }
  return { serialized, trimmedIds, fits: serialized.length <= maxChars };
}

function saveState() {
  let result = buildStateSnapshot(MAX_LOCAL_STATE_CHARS);
  let fallback = false;
  try {
    if (!result.fits) throw new Error('STORAGE_LIMIT');
    localStorage.setItem(STORAGE_KEY, result.serialized);
  } catch {
    fallback = true;
    result = buildStateSnapshot(MAX_FALLBACK_STATE_CHARS);
    try {
      if (!result.fits) throw new Error('STORAGE_LIMIT');
      localStorage.setItem(STORAGE_KEY, result.serialized);
    } catch {
      if (!state.storageWarningShown) toast('تعذر حفظ الجلسات؛ قد لا تبقى بعد إغلاق الصفحة.');
      state.storageWarningShown = true;
      return;
    }
  }
  result.trimmedIds.forEach((id) => {
    const conversation = state.conversations.find((item) => item.id === id);
    if (conversation) conversation.historyTrimmed = true;
  });
  if (fallback && !state.storageWarningShown) toast('حُفظت أحدث الجلسات فقط لتوفير المساحة.');
  if (!fallback && result.trimmedIds.size && !state.historyTrimWarningShown) toast('حُفظت أحدث الرسائل فقط لتوفير المساحة.');
  if (fallback || result.trimmedIds.size) state.historyTrimWarningShown = true;
  state.storageWarningShown = fallback;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function safeWebUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2_048) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 3000);
}

function setConnection(mode, text) {
  const dot = $('.connection-dot');
  if (dot) dot.className = `connection-dot ${mode || ''}`;
  if ($('#connectionText')) $('#connectionText').textContent = text;
  if ($('#settingsConnection')) $('#settingsConnection').textContent = text;
}

function renderProviderStatus() {
  const status = $('#providerState');
  if (!status) return;
  const configured = Boolean(state.ai?.configured);
  const verified = state.ai?.verified;
  status.textContent = state.settings.apiKey
    ? 'مفتاح هذا الجهاز'
    : !configured
      ? 'لا يوجد مفتاح'
      : verified === false ? 'المفتاح مرفوض من المزود' : 'مفتاح الخادم فعال';
  status.classList.toggle('offline', !configured || verified === false);
  if ($('#providerModel')) $('#providerModel').textContent = state.ai?.model || '—';
  if ($('#providerEndpoint')) $('#providerEndpoint').textContent = state.ai?.endpoint ? state.ai.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '—';
}

function statusText(data) {
  if (!data?.configured) return 'الكتب جاهزة · الذكاء غير مضبوط';
  if (data.verified === false) return 'الكتب جاهزة · الذكاء متعطل مؤقتا';
  return 'المعلم جاهز';
}

function currentConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function createConversation() {
  const conversation = { id: uid('c'), title: 'جلسة جديدة', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  const removed = state.conversations.slice(MAX_CONVERSATIONS).map((item) => item.id);
  state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
  state.imageContext = { conversationId: conversation.id, dataUrl: '', status: 'none' };
  if (removed.length) {
    removed.forEach((id) => state.imageContextCache.delete(id));
    deleteImageContexts(removed).catch(() => {});
  }
  return conversation;
}

function openConversation(id) {
  if (state.preparingMessage) return toast('انتظري لحظة حتى يكتمل تجهيز الرسالة.');
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  state.activeId = id;
  loadConversationImageContext(conversation);
  state.view = 'learn';
  closeSidebar();
  renderAll();
}

function newChat() {
  if (state.preparingMessage) return toast('انتظري لحظة حتى يكتمل تجهيز الرسالة.');
  if (state.request) return toast('أوقفي الرد الحالي أولا');
  state.activeId = null;
  state.composing = Boolean(state.pendingImages.length);
  state.imageContext = null;
  state.view = 'learn';
  closeSidebar();
  renderAll();
  $('#messageInput')?.focus();
}

function displayDate(timestamp) {
  try { return new Intl.DateTimeFormat('ar-IQ', { day: 'numeric', month: 'short' }).format(new Date(timestamp)); } catch { return ''; }
}

function providerHeaders() {
  const headers = {};
  if (state.settings.apiKey.trim()) headers['X-AI-API-Key'] = state.settings.apiKey.trim();
  return headers;
}

async function fetchJson(url, options = {}, timeout = 18_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...providerHeaders(), ...(options.headers || {}) } });
    let data = {};
    try { data = await response.json(); } catch { /* رد غير JSON */ }
    if (!response.ok) {
      const error = new Error(data.error || `HTTP_${response.status}`);
      error.detail = data.detail || '';
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}

async function loadBootstrap() {
  try {
    const data = await fetchJson('/api/bootstrap', {}, 20_000);
    state.books = Array.isArray(data.books) ? data.books : [];
    state.curriculum = data.curriculum || null;
    state.ai = data;
    renderProviderStatus();
    setConnection('online', statusText(data));
  } catch (error) {
    setConnection('offline', 'تعذر الوصول للخادم');
    toast('تعذر تحميل الكتب الآن، حاولي تحديث الصفحة');
  }
}

async function warmup() {
  try {
    const data = await fetchJson('/api/health', {}, 12_000);
    state.ai = { ...state.ai, ...(data.ai || {}) };
    setConnection('online', statusText(state.ai));
    renderProviderStatus();
  } catch { setConnection('offline', 'تحققي من الاتصال'); }
}

function linkifyUrls(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('a, code, pre, button')) nodes.push(node);
  }
  const expression = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>"'`]+/giu;
  nodes.forEach((node) => {
    const value = node.nodeValue || '';
    expression.lastIndex = 0;
    let match;
    let cursor = 0;
    let found = false;
    const fragment = document.createDocumentFragment();
    while ((match = expression.exec(value))) {
      const isMarkdownLink = Boolean(match[2]);
      let urlText = isMarkdownLink ? match[2] : match[0];
      let trailing = '';
      if (!isMarkdownLink) {
        while (/[.,،؛:!?؟]$/.test(urlText)) { trailing = urlText.slice(-1) + trailing; urlText = urlText.slice(0, -1); }
        while (urlText.endsWith(')') && (urlText.match(/\(/g) || []).length < (urlText.match(/\)/g) || []).length) { trailing = `)${trailing}`; urlText = urlText.slice(0, -1); }
      }
      const href = safeWebUrl(urlText);
      if (!href || !urlText) continue;
      found = true;
      fragment.append(document.createTextNode(value.slice(cursor, match.index)));
      const anchor = document.createElement('a');
      anchor.className = 'external-link';
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.dir = isMarkdownLink ? 'auto' : 'ltr';
      anchor.textContent = isMarkdownLink ? match[1] : urlText;
      fragment.append(anchor, document.createTextNode(trailing));
      cursor = match.index + match[0].length;
    }
    if (found) {
      fragment.append(document.createTextNode(value.slice(cursor)));
      node.replaceWith(fragment);
    }
  });
}

function markdownHtml(source, referencePrefix = '', citationIds = []) {
  let text = escapeHtml(source);
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>').replace(/^###\s+(.+)$/gm, '<h3>$1</h3>').replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // المائل قد يمتد على أكثر من سطر داخل اقتباس الكتاب، فلا يُترك نجمةً ظاهرة للطالبة.
  text = text.replace(/\*([^*]+)\*/g, (_match, inner) => `<em>${String(inner).replace(/\s*\n\s*/g, ' ')}</em>`);
  const ids = new Set(citationIds.map((item) => String(typeof item === 'string' ? item : item?.id || '')));
  const reference = (id) => {
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '');
    if (referencePrefix && ids.has(id) && safeId) return `<a class="reference-mark" href="#${referencePrefix}-source-${safeId}" aria-label="الانتقال إلى المصدر ${id}">${id}</a>`;
    return `<span class="reference-mark">${id}</span>`;
  };
  text = text.replace(/(^|[\s(\[{])\[([A-Z]\d+)\](?=$|[\s،.,؛!؟:：)\]}])/g, (_match, prefix, id) => `${prefix}${reference(id)}`);
  text = text.replace(/(^|[\s(\[{])([A-Z]\d+)(?=$|[\s،.,؛!؟:：)\]}])/g, (_match, prefix, id) => `${prefix}${reference(id)}`);
  const lines = text.split('\n');
  let html = '';
  let list = '';
  const closeList = () => { if (list) { html += list === 'ul' ? '</ul>' : '</ol>'; list = ''; } };
  const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { closeList(); continue; }
    if (isTableLine(line)) {
      closeList();
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        i++;
      }
      i--;
      if (rows.length) {
        const [head, ...body] = rows;
        html += `<div class="table-scroll"><table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>${body.length ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>` : ''}</table></div>`;
      }
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
    if (line.startsWith('&gt;')) { closeList(); html += `<blockquote>${line.replace(/^&gt;\s?/, '')}</blockquote>`; continue; }
    if (line.startsWith('<pre>') || line.startsWith('<h1>') || line.startsWith('<h2>') || line.startsWith('<h3>')) { closeList(); html += line; continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`; continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`; continue; }
    closeList();
    html += `<p>${line}</p>`;
  }
  closeList();
  const container = document.createElement('div');
  container.innerHTML = html;
  linkifyUrls(container);
  return container.innerHTML;
}

function quizFromJson(raw) {
  let quiz;
  try { quiz = JSON.parse(raw); } catch { return null; }
  if (!quiz || typeof quiz !== 'object') return null;
  const list = Array.isArray(quiz.questions) ? quiz.questions : Array.isArray(quiz.quiz) ? quiz.quiz : null;
  if (!list || !list.length) return null;
  const questions = list.map((question) => {
    const options = Array.isArray(question.options) ? question.options.map(String) : [];
    let answer = question.answer;
    if (typeof answer === 'string') {
      const found = options.findIndex((option) => option.trim() === answer.trim());
      answer = found >= 0 ? found : Number(answer);
    }
    return { q: question.q || question.question || '', options, answer: Number(answer), why: question.why || question.explanation || '' };
  }).filter((question) => question.q && question.options.length >= 2);
  if (!questions.length) return null;
  return { title: quiz.title, subject: quiz.subject, questions: questions.slice(0, MAX_QUIZ_QUESTIONS) };
}

function extractQuiz(part) {
  const trimmed = String(part || '').trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/```(?:quiz|json)\s*([\s\S]*?)```/);
  if (fence) {
    const quiz = quizFromJson(fence[1].trim());
    if (quiz) return { quiz, rest: trimmed.replace(fence[0], '').trim() };
  }
  if (trimmed.startsWith('{')) {
    const direct = quizFromJson(trimmed);
    if (direct) return { quiz: direct, rest: '' };
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const inner = quizFromJson(trimmed.slice(start, end + 1));
      if (inner) return { quiz: inner, rest: (trimmed.slice(0, start) + ' ' + trimmed.slice(end + 1)).trim() };
    }
  }
  return null;
}

function quizElement(raw) {
  const quiz = typeof raw === 'object' && raw !== null && raw.questions ? raw : quizFromJson(String(raw || ''));
  if (!quiz) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'quiz-card';
  wrapper.innerHTML = `<h3>${escapeHtml(quiz.title || 'اختبار قصير')}</h3><small>${escapeHtml(quiz.subject || '')}</small>`;
  let score = 0;
  let answered = 0;
  const result = document.createElement('p');
  result.className = 'quiz-result';
  quiz.questions.slice(0, MAX_QUIZ_QUESTIONS).forEach((question, index) => {
    const item = document.createElement('div');
    item.className = 'quiz-question';
    const title = document.createElement('b');
    title.textContent = `${index + 1}. ${question.q || ''}`;
    item.appendChild(title);
    (question.options || []).slice(0, 5).forEach((option, optionIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option;
      button.addEventListener('click', () => {
        if (item.dataset.done) return;
        item.dataset.done = '1'; answered += 1;
        const correct = optionIndex === Number(question.answer);
        if (correct) { score += 1; button.classList.add('correct'); } else { button.classList.add('wrong'); item.querySelectorAll('button')[Number(question.answer)]?.classList.add('correct'); }
        item.querySelectorAll('button').forEach((choice) => { choice.disabled = true; });
        const why = document.createElement('small'); why.textContent = question.why || ''; item.appendChild(why);
        if (answered === Math.min(quiz.questions.length, MAX_QUIZ_QUESTIONS)) result.textContent = `نتيجتك ${score} من ${answered}`;
      });
      item.appendChild(button);
    });
    wrapper.appendChild(item);
  });
  wrapper.appendChild(result);
  return wrapper;
}

function quizPending(text) {
  const t = String(text || '');
  const fenceCount = (t.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    const lastFence = t.lastIndexOf('```');
    if (/```(?:quiz|json)?\s*\{?\s*"?[a-z]*"?/.test(t.slice(lastFence, lastFence + 30)) && /```(?:quiz|json)\s*\{|```json\s*\{/.test(t.slice(lastFence)) ) return true;
    if (/"quiz"\s*:|"(?:q|question)"\s*:|"(?:options|questions)"\s*:/.test(t.slice(lastFence))) return true;
  }
  const trimmed = t.trimStart();
  if (trimmed.startsWith('{') && /"(?:quiz|questions)"\s*:/.test(trimmed.slice(0, 300))) return true;
  return false;
}

function fillAssistantBubble(element, content, streaming = false, referencePrefix = '', citations = []) {
  element.querySelector('.teacher-status')?.remove();
  if (streaming && quizPending(content)) {
    if (element.querySelector('.quiz-loading')) return;
    element.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'quiz-loading';
    loading.innerHTML = '<span class="status-orb"></span><span>جارِ تجهيز الاختبار، لحظة من فضلك…</span>';
    element.appendChild(loading);
    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    element.appendChild(typing);
    return;
  }
  element.innerHTML = '';
  const parts = String(content || '').split(/```quiz\s*([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 2 === 1) { const quiz = quizElement(part.trim()); if (quiz) element.appendChild(quiz); return; }
    if (part.trim()) {
      const found = extractQuiz(part);
      if (found) {
        if (found.rest) { const text = document.createElement('div'); text.innerHTML = markdownHtml(found.rest, referencePrefix, citations); element.appendChild(text); }
        const card = quizElement(found.quiz);
        if (card) element.appendChild(card);
        return;
      }
      const block = document.createElement('div'); block.innerHTML = markdownHtml(part, referencePrefix, citations); element.appendChild(block);
    }
  });
  if (streaming) {
    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    element.appendChild(typing);
  }
}

function normalizedEvidenceToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function evidenceStatusesOf(source) {
  return new Set([source?.evidenceStatus, source?.status].map(normalizedEvidenceToken).filter(Boolean));
}

function citationEvidence(source) {
  const evidenceType = normalizedEvidenceToken(source.evidenceType);
  const statuses = evidenceStatusesOf(source);
  const hasStatus = (...values) => values.some((value) => statuses.has(value));
  const quotationSource = String(source.quotationSource || '');
  const sourceType = normalizedEvidenceToken(source.sourceType);
  const damageReasons = Array.isArray(source.damageReasons) ? source.damageReasons : [];
  const isWeb = sourceType === 'web' || evidenceType === 'external-web';
  const textDamaged = hasStatus('damaged-text') || evidenceType === 'damaged-text' || (source.searchable === true && (source.damaged === true || damageReasons.length > 0));
  const isOcr = hasStatus('ocr-text') || evidenceType === 'ocr-text';
  const cleanPdfStatus = hasStatus('clean-extracted-text', 'clean-text');
  const isPdfImage = evidenceType === 'pdf-image' || hasStatus('pdf-image');
  const noPdfText = hasStatus('no-text', 'unavailable') || source.searchable === false
    || (source.searchable !== true && !cleanPdfStatus && quotationSource !== 'outline-description' && sourceType !== 'web');
  const reliablePdfText = evidenceType === 'pdf-text' && source.searchable !== false && source.quotableReliable === true && !textDamaged && !isPdfImage && !hasStatus('no-text', 'unavailable')
    && (quotationSource === 'pdf-text' || sourceType === 'curriculum');
  let label;
  let warning = false;
  let visual = false;
  if (isWeb) {
    label = source.official
      ? 'مصدر ويب رسمي عراقي · خارج المنهج'
      : source.curriculumSpecific
        ? 'مصدر ويب مرتبط بالمقرر · خارج المنهج'
        : 'مصدر ويب خارجي · ليس من كتاب المنهج';
  } else if (quotationSource === 'outline-description' || evidenceType === 'outline-description') {
    label = `وصف فهرسي غير حرفي${textDamaged ? ' · نص PDF متضرر' : ''}${noPdfText ? ' · لا نص PDF قابل للبحث' : ''}`;
    warning = textDamaged;
  } else if (textDamaged) {
    label = 'نص مستخرج متضرر · لا يُنقل حرفياً';
    warning = true;
  } else if (isPdfImage) {
    label = 'صفحة PDF مصوّرة · افتحي معاينة الصفحة للتحقق';
    visual = true;
    warning = true;
  } else if (isOcr) {
    label = source.quotableReliable === true ? 'نص OCR · فحص السلامة ناجح؛ يُراجع بصرياً' : 'نص OCR غير موثوق';
    warning = source.quotableReliable !== true;
    visual = true;
  } else if (reliablePdfText) {
    label = 'نص PDF · فحص السلامة ناجح';
  } else if (cleanPdfStatus && source.searchable === true) {
    label = source.quotableReliable === true ? 'نص PDF مصنف نظيفًا · راجعي موضعه' : 'نص PDF مصنف نظيفًا · يلزم التحقق';
    warning = source.quotableReliable !== true;
  } else if (evidenceType === 'damaged-text' || quotationSource === 'unreliable') {
    label = 'نص مستخرج غير موثوق · لا يُنقل حرفياً';
    warning = true;
  } else if (evidenceType === 'summary') {
    label = 'ملخص فهرسي · ليس نص الصفحة';
  } else if (sourceType === 'pdf-fallback') {
    label = source.searchable ? 'نص مستخرج من PDF أصلي · راجعي الصفحة' : 'لا نص PDF قابل للبحث · افتحي الصفحة للتحقق';
    visual = !source.searchable;
    warning = !source.searchable;
  } else {
    label = noPdfText ? 'لا نص PDF قابل للبحث' : 'راجعي الصفحة قبل الاقتباس';
    warning = source.quotableReliable !== true;
  }
  if (!isWeb && !isOcr && !isPdfImage && source.needsOcr === true) { label += ' · يلزم تحقق بصري'; visual = true; }
  return { label, warning, visual, damageReasons, isWeb };
}

function citationDomId(prefix, id) {
  const safePrefix = String(prefix || 'answer').replace(/[^A-Za-z0-9_-]/g, '');
  const safeId = String(id || 'S').replace(/[^A-Za-z0-9_-]/g, '');
  return `${safePrefix}-source-${safeId || 'S'}`;
}

function sourceCards(sources, target, compact = false, referencePrefix = '') {
  target.innerHTML = '';
  const items = Array.isArray(sources) ? sources.filter((source) => source && typeof source === 'object').slice(0, MAX_CITATIONS) : [];
  if (!items.length) { target.hidden = true; return; }
  target.hidden = false;
  items.forEach((source) => {
    const id = String(source.id || 'S');
    const url = safeWebUrl(source.url);
    const canOpenPage = source.sourceType !== 'web' && Boolean(String(source.bookId || '').trim()) && source.physicalPage != null && Number.isInteger(Number(source.physicalPage)) && Number(source.physicalPage) > 0;
    const card = document.createElement(url ? 'a' : canOpenPage ? 'button' : 'div');
    const evidence = citationEvidence(source);
    const pageLabel = source.physicalPage != null
      ? `${source.printedPage != null ? `مطبوعة ${source.printedPage}` : 'المطبوع غير متحقق'} · PDF ${source.physicalPage}`
      : source.printedPage != null ? `مطبوعة ${source.printedPage} · صفحة PDF غير محددة` : 'رقم الصفحة غير متاح';
    const title = source.title || source.subject || 'مصدر';
    const subject = source.subject && source.title && source.subject !== source.title ? ` · ${source.subject}` : '';
    card.className = `source-card${evidence.warning ? ' unreliable' : ''}${evidence.visual ? ' visual' : ''}${evidence.isWeb ? ' external-source' : ''}`;
    if (source.sourceType === 'pdf-fallback') card.classList.add('pdf-fallback');
    card.id = citationDomId(referencePrefix, id);
    if (url) {
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.setAttribute('aria-label', `فتح المصدر الخارجي ${title} في علامة جديدة`);
    } else if (canOpenPage) {
      card.type = 'button';
      card.setAttribute('aria-label', `${source.sourceType === 'pdf-fallback' ? 'فتح معاينة الصفحة الأصلية' : 'فتح صفحة الكتاب'}: ${title}، ${pageLabel}، ${evidence.label}`);
      card.addEventListener('click', () => openPage(source.bookId, Number(source.physicalPage), card));
    } else if (source.sourceType === 'pdf-fallback') {
      card.setAttribute('role', 'note');
      card.setAttribute('aria-label', `مرجع إلى ${title}، ${pageLabel}. لا تتوفر معاينة PDF الأصلية هنا.`);
    }
    const heading = document.createElement('span');
    heading.textContent = `${id} · ${title}${subject}`;
    const metadata = document.createElement('small');
    const host = source.host || (url ? new URL(url).hostname.replace(/^www\./, '') : '');
    const provenance = evidence.isWeb
      ? `${host ? `${host} · ` : ''}${evidence.label}`
      : `${pageLabel}${source.sourceType === 'pdf-fallback' ? ` · PDF أصلي · ${canOpenPage ? 'افتحي معاينة الصفحة' : 'مرجع الصفحة'}` : ''} · ${evidence.label}`;
    metadata.textContent = provenance;
    card.append(heading, metadata);
    if (evidence.isWeb && source.snippet) {
      const snippet = document.createElement('small'); snippet.className = 'source-snippet'; snippet.textContent = String(source.snippet).slice(0, 300); card.appendChild(snippet);
    }
    if (evidence.warning && evidence.damageReasons.length) {
      const reason = document.createElement('small');
      reason.className = 'source-reason';
      reason.textContent = evidence.damageReasons.slice(0, 2).join('؛ ');
      card.append(reason);
    }
    target.appendChild(card);
  });
  if (compact) target.classList.add('compact'); else target.classList.remove('compact');
}

function userMessageElement(message) {
  const article = document.createElement('article');
  article.className = 'message user';
  article.innerHTML = `<div class="message-label">أنتِ</div><div class="message-bubble"></div>`;
  const bubble = article.querySelector('.message-bubble');
  const text = document.createElement('p');
  text.innerHTML = escapeHtml(message.content || 'صورة مرفقة').replace(/\n/g, '<br>');
  bubble.appendChild(text);
  if (message.hasImage) {
    const attachment = document.createElement('span');
    attachment.className = 'message-attachment';
    attachment.textContent = message.imageOrigin === 'context' ? '▧ استُخدمت الصورة السابقة' : '▧ صورة مرفقة';
    bubble.appendChild(attachment);
  }
  if (message.truncated) {
    const note = document.createElement('small'); note.className = 'message-truncated'; note.textContent = 'حُفظ الجزء الأول من هذه الرسالة فقط.'; bubble.appendChild(note);
  }
  return article;
}

function assistantMessageElement(message) {
  const article = document.createElement('article');
  article.id = uid('answer');
  article.className = 'message assistant';
  article.innerHTML = '<div class="message-label">المعلم</div><div class="message-bubble"></div><div class="inline-sources source-tray"></div>';
  fillAssistantBubble(article.querySelector('.message-bubble'), message.content, false, article.id, message.cites || []);
  if (message.truncated) {
    const note = document.createElement('small'); note.className = 'message-truncated'; note.textContent = 'حُفظ الجزء الأول من الرد فقط.'; article.querySelector('.message-bubble').appendChild(note);
  }
  sourceCards(message.cites || [], article.querySelector('.inline-sources'), true, article.id);
  appendEvidenceNotices(article, message.notices || []);
  return article;
}

function renderMessages() {
  const list = $('#messageList');
  if (!list) return;
  const conversation = currentConversation();
  list.innerHTML = '';
  if (!conversation || !conversation.messages.length) {
    list.innerHTML = `<div class="welcome-message"><div class="welcome-icon">م</div><h2>من أين نبدأ؟</h2><p>اكتبي اسم الدرس أو السؤال كما يخطر في بالك. سأبحث في الكتب أولا، وأوضح لكِ إن لم أجد نصا موثوقا.</p><div class="welcome-prompt-row"><button class="prompt-chip" data-prompt="اشرح لي أحكام التلاوة بطريقة سهلة">أحكام التلاوة</button><button class="prompt-chip" data-prompt="اشرح لي أسلوب الاستفهام مع أمثلة">أسلوب الاستفهام</button><button class="prompt-chip" data-prompt="اختبرني في التاريخ">اختبار سريع</button></div></div>`;
    bindPromptButtons(list);
    return;
  }
  if (conversation.historyTrimmed) {
    const notice = document.createElement('p');
    notice.className = 'history-storage-note';
    notice.textContent = 'تُعرض أحدث الرسائل المحفوظة فقط لتوفير مساحة التخزين.';
    list.appendChild(notice);
  }
  for (const message of conversation.messages) list.appendChild(message.role === 'assistant' ? assistantMessageElement(message) : userMessageElement(message));
  list.scrollTop = list.scrollHeight;
}

function clearSourceTray() {
  const tray = $('#sourceTray');
  if (!tray) return;
  tray.innerHTML = '';
  tray.hidden = true;
}

function updateHeaderSession(chatting, conversation) {
  const session = $('#headerSession');
  if (!session) return;
  const brand = $('#headerBrand');
  const center = $('#headerCenter');
  const newButton = $('#chatNewButton');
  session.hidden = !chatting;
  if (brand) brand.hidden = chatting;
  if (center) center.hidden = chatting;
  if (newButton) newButton.hidden = !chatting;
  if (chatting) $('#headerSessionTitle').textContent = conversation?.title || 'جلسة جديدة';
}

function showLearnPanel() {
  clearSourceTray();
  const conversation = currentConversation();
  const chatting = Boolean(conversation?.messages?.length || state.composing);
  $('#homePanel').hidden = chatting;
  $('#chatPanel').hidden = !chatting;
  updateHeaderSession(chatting, conversation);
  if (chatting) renderMessages();
  renderPendingImages();
}

function renderRecent() {
  const list = $('#recentList');
  list.innerHTML = '';
  const conversations = state.conversations.filter((conversation) => conversation.messages?.length).slice(0, 8);
  if (!conversations.length) { list.innerHTML = '<p class="empty-side">ستظهر جلساتك هنا بعد أول سؤال.</p>'; return; }
  conversations.forEach((conversation) => {
    const button = document.createElement('button');
    button.className = `recent-item${conversation.id === state.activeId ? ' current' : ''}`;
    button.textContent = conversation.title;
    button.title = conversation.title;
    button.addEventListener('click', () => { openConversation(conversation.id); closeSidebar(); });
    list.appendChild(button);
  });
}

// صيغ العدد العربية: المفرد والمثنى ثم جمع القلة ثم المفرد المنقوص.
function countLabel(count, forms) {
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  if (count <= 10) return `${count} ${forms.few}`;
  return `${count} ${forms.many}`;
}

function daysLabel(days) {
  if (days <= 0) return 'اليوم';
  if (days === 1) return 'غدا';
  if (days === 2) return 'بعد يومين';
  if (days <= 10) return `بعد ${days} أيام`;
  return `بعد ${days} يوما`;
}

function renderPlan() {
  const list = $('#examList');
  if(!list) return;
  // plan view removed in v5 — keep no-op to avoid null crashes
  list.innerHTML = '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = state.exams.filter((exam) => new Date(`${exam.date}T00:00:00`) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  if (next) {
    const days = Math.ceil((new Date(`${next.date}T00:00:00`) - today) / 86_400_000);
    $('#nextExamLabel').textContent = next.title;
    $('#nextExamMeta').textContent = new Intl.DateTimeFormat('ar-IQ', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${next.date}T00:00:00`));
    $('#nextExamDays').textContent = daysLabel(days);
  } else {
    $('#nextExamLabel').textContent = 'لا توجد مواعيد بعد'; $('#nextExamMeta').textContent = 'أضيفي امتحانا أو هدفا دراسيا.'; $('#nextExamDays').textContent = '—';
  }
  if (!upcoming.length) { list.innerHTML = '<div class="empty-state">الخطة الفارغة ليست مشكلة. أضيفي أول موعد، وسنرى الطريق أمامك.</div>'; return; }
  upcoming.forEach((exam) => {
    const date = new Date(`${exam.date}T00:00:00`);
    const days = Math.ceil((date - today) / 86_400_000);
    const item = document.createElement('article'); item.className = 'exam-item';
    item.innerHTML = `<span class="exam-date">${date.getDate()}<small>${new Intl.DateTimeFormat('ar-IQ', { month: 'short' }).format(date)}</small></span><div class="exam-info"><b>${escapeHtml(exam.title)}</b><small>${new Intl.DateTimeFormat('ar-IQ', { weekday: 'long', year: 'numeric' }).format(date)}</small></div><span class="exam-days">${daysLabel(days)}</span><button class="delete-button" type="button" aria-label="حذف الموعد">×</button>`;
    item.querySelector('.delete-button').addEventListener('click', () => { state.exams = state.exams.filter((value) => value.id !== exam.id); saveState(); renderPlan(); toast('حُذف الموعد'); });
    list.appendChild(item);
  });
}

function renderHistory() {
  const list = $('#historyList');
  const query = ($('#historySearch')?.value || '').trim().toLowerCase();
  const conversations = state.conversations.filter((conversation) => {
    if (!conversation.messages?.length) return false;
    if (!query) return true;
    return conversation.title.toLowerCase().includes(query) || conversation.messages.some((message) => String(message.content).toLowerCase().includes(query));
  });
  $('#historyCount').textContent = countLabel(state.conversations.filter((conversation) => conversation.messages?.length).length, { one: 'جلسة واحدة', two: 'جلستان', few: 'جلسات', many: 'جلسة' });
  list.innerHTML = '';
  if (!conversations.length) { list.innerHTML = '<div class="empty-state">لا توجد جلسات مطابقة بعد. كل سؤال جيد هو بداية جديدة.</div>'; return; }
  conversations.forEach((conversation) => {
    const item = document.createElement('article'); item.className = 'history-item';
    item.innerHTML = `<span class="history-icon">◈</span><div class="history-info"><b>${escapeHtml(conversation.title)}</b><small>${countLabel(conversation.messages.filter((message) => message.role === 'user').length, { one: 'سؤال واحد', two: 'سؤالان', few: 'أسئلة', many: 'سؤالاً' })} · ${displayDate(conversation.updatedAt || conversation.createdAt)}</small></div><span class="history-arrow">←</span>`;
    item.addEventListener('click', () => openConversation(conversation.id));
    list.appendChild(item);
  });
}

function setView(view) {
  if (!['learn', 'history'].includes(view)) view = 'learn';
  state.view = view;
  ['learn', 'history'].forEach((name) => {
    const section = $(`#view-${name}`);
    if (section) section.hidden = name !== view;
  });
  const planSection = $('#view-plan');
  if (planSection) planSection.hidden = true;
  $('.nav-item, .mobile-nav-item').forEach((button) => {
    const v = button.dataset.view;
    if (v) button.classList.toggle('active', v === view);
  });
  if (view === 'learn') showLearnPanel();
  if (view === 'history') renderHistory();
  if (view !== 'learn') updateHeaderSession(false, null);
  closeSidebar();
}
function closeSidebar(){
  $('#sidebar')?.classList.remove('open');
  const ov = $('#sidebarOverlay');
  if(ov){ ov.hidden = true; }
  document.body.style.overflow = '';
}
function openSidebar(){
  $('#sidebar')?.classList.add('open');
  const ov = $('#sidebarOverlay');
  if(ov){ ov.hidden = false; }
  document.body.style.overflow = 'hidden';
}

function renderAll() {
  $('#studentName').textContent = state.settings.studentName || 'طالبة';
  renderRecent();
  setView(state.view);
}

function bindPromptButtons(root = document) {
  root.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      openComposer(button.dataset.prompt || '');
    });
  });
}

function openComposer(prompt = '') {
  if (!currentConversation()) createConversation();
  state.composing = true;
  state.view = 'learn';
  renderAll();
  const input = $('#messageInput');
  input.value = prompt;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function renderPendingImages() {
  const preview = $('#imagePreview');
  preview.innerHTML = '';
  preview.hidden = !state.pendingImages.length;
  state.pendingImages.forEach((image, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'image-thumb'; button.setAttribute('aria-label', 'إزالة الصورة المرفقة');
    const element = document.createElement('img'); element.src = image; element.alt = '';
    button.appendChild(element);
    button.addEventListener('click', () => { state.pendingImages.splice(index, 1); renderPendingImages(); });
    preview.appendChild(button);
  });
  renderImageContextStatus();
}

function openImageDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IMAGE_STORAGE_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE_NAME)) request.result.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'conversationId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IMAGE_STORAGE_UNAVAILABLE'));
    request.onblocked = () => reject(new Error('IMAGE_STORAGE_BLOCKED'));
  });
}

async function imageStoreRequest(method, value) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const mode = method === 'get' || method === 'getAll' ? 'readonly' : 'readwrite';
    const transaction = db.transaction(IMAGE_STORE_NAME, mode);
    const store = transaction.objectStore(IMAGE_STORE_NAME);
    const request = method === 'put' ? store.put(value)
      : method === 'get' ? store.get(value)
        : method === 'delete' ? store.delete(value)
          : method === 'clear' ? store.clear()
            : store[method]();
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('IMAGE_STORAGE_FAILED'));
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('IMAGE_STORAGE_FAILED')); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('IMAGE_STORAGE_FAILED')); };
  });
}

async function deleteImageContexts(ids) {
  const values = Array.isArray(ids) ? ids : [ids];
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(IMAGE_STORE_NAME);
    values.filter(Boolean).forEach((id) => store.delete(id));
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('IMAGE_STORAGE_FAILED')); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('IMAGE_STORAGE_FAILED')); };
  });
}

async function clearAllImageContexts() {
  await imageStoreRequest('clear');
}

function rememberImageContext(context) {
  if (!context?.conversationId || !context.dataUrl) return [];
  state.imageContextCache.set(context.conversationId, context);
  const ordered = [...state.imageContextCache.values()].sort((a, b) => Number(b.conversationId === context.conversationId) - Number(a.conversationId === context.conversationId) || b.updatedAt - a.updatedAt);
  let total = 0;
  let count = 0;
  const evicted = [];
  for (const item of ordered) {
    const size = String(item.dataUrl || '').length;
    if (item.conversationId === context.conversationId || (count < MAX_IMAGE_CONTEXTS && total + size <= MAX_IMAGE_CONTEXT_TOTAL_CHARS)) {
      total += size; count += 1;
    } else {
      evicted.push(item.conversationId);
      state.imageContextCache.delete(item.conversationId);
    }
  }
  return evicted;
}

async function storeImageContext(conversationId, dataUrl) {
  const record = { conversationId, dataUrl, updatedAt: Date.now(), size: dataUrl.length };
  await imageStoreRequest('put', record);
  const records = await imageStoreRequest('getAll');
  const ordered = (records || []).sort((a, b) => Number(b.conversationId === conversationId) - Number(a.conversationId === conversationId) || b.updatedAt - a.updatedAt);
  let total = 0;
  let count = 0;
  const evicted = [];
  for (const item of ordered) {
    const size = Number(item.size) || String(item.dataUrl || '').length;
    if (count < MAX_IMAGE_CONTEXTS && total + size <= MAX_IMAGE_CONTEXT_TOTAL_CHARS) {
      total += size; count += 1;
    } else {
      evicted.push(item.conversationId);
    }
  }
  if (evicted.length) await deleteImageContexts(evicted);
  return evicted;
}

function renderImageContextStatus() {
  const element = $('#imageContextStatus');
  if (!element) return;
  element.innerHTML = '';
  const conversation = currentConversation();
  const context = state.imageContext?.conversationId === conversation?.id ? state.imageContext : null;
  if (!conversation?.imageContext && !context?.dataUrl) { element.hidden = true; return; }
  const status = context?.status || (conversation.imageContext?.stored ? 'loading' : 'unavailable');
  const messages = {
    loading: 'جار استعادة الصورة السابقة…',
    saving: 'جار حفظ الصورة للاستخدام في المتابعة…',
    ready: context?.stored === false ? 'الصورة متاحة حتى إغلاق هذه الصفحة.' : 'ستُستخدم الصورة السابقة مع سؤالك التالي.',
    unavailable: 'الصورة السابقة غير متاحة؛ أرفقيها ثانية أو أزيلي السياق.',
  };
  if (!messages[status]) { element.hidden = true; return; }
  element.hidden = false;
  const text = document.createElement('span');
  text.className = 'image-context-text';
  text.textContent = messages[status];
  element.appendChild(text);
  if (status !== 'loading' && status !== 'saving') {
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'image-context-remove'; clear.textContent = 'إزالة';
    clear.setAttribute('aria-label', 'إزالة سياق الصورة السابقة');
    clear.addEventListener('click', () => clearConversationImageContext(conversation.id));
    element.appendChild(clear);
  }
}

function loadConversationImageContext(conversation) {
  if (!conversation?.imageContext) {
    state.imageContext = conversation ? { conversationId: conversation.id, dataUrl: '', status: 'none' } : null;
    renderImageContextStatus();
    return Promise.resolve(state.imageContext);
  }
  const cached = state.imageContextCache.get(conversation.id);
  if (cached?.dataUrl) {
    state.imageContext = cached;
    renderImageContextStatus();
    return cached.promise || Promise.resolve(cached);
  }
  if (state.imageContext?.conversationId === conversation.id) {
    if (state.imageContext.dataUrl || state.imageContext.status === 'loading') return state.imageContext.promise || Promise.resolve(state.imageContext);
  }
  const context = { conversationId: conversation.id, dataUrl: '', status: 'loading', stored: conversation.imageContext.stored === true, updatedAt: conversation.imageContext.updatedAt };
  state.imageContextCache.set(conversation.id, context);
  state.imageContext = context;
  renderImageContextStatus();
  context.promise = imageStoreRequest('get', conversation.id).then((record) => {
    if (record?.dataUrl && record.dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) {
      context.dataUrl = record.dataUrl;
      context.status = 'ready';
      context.stored = true;
      context.updatedAt = Number(record.updatedAt) || Date.now();
      rememberImageContext(context);
    } else {
      context.status = 'unavailable';
      state.imageContextCache.delete(conversation.id);
    }
    return context;
  }).catch(() => {
    context.status = 'unavailable';
    state.imageContextCache.delete(conversation.id);
    return context;
  }).finally(() => {
    if (state.activeId === conversation.id) renderImageContextStatus();
  });
  return context.promise;
}

async function ensureImageContext(conversation) {
  if (!conversation?.imageContext) return null;
  if (state.imageContext?.conversationId === conversation.id && state.imageContext.dataUrl) return state.imageContext;
  return loadConversationImageContext(conversation);
}

async function clearConversationImageContext(conversationId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  delete conversation.imageContext;
  state.imageContextCache.delete(conversationId);
  if (state.imageContext?.conversationId === conversationId) state.imageContext = { conversationId, dataUrl: '', status: 'none' };
  await deleteImageContexts([conversationId]).catch(() => {});
  saveState();
  renderImageContextStatus();
  toast('أُزيل سياق الصورة');
}

function boundConversation(conversation) {
  if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION);
    conversation.historyTrimmed = true;
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) { reject(new Error('IMAGE_TYPE')); return; }
    if (file.size > 8_000_000) { reject(new Error('IMAGE_SIZE')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('IMAGE_READ'));
    reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error('IMAGE_READ'));
      image.onload = () => {
        if (!image.width || !image.height || image.width * image.height > 40_000_000) { reject(new Error('IMAGE_DIMENSIONS')); return; }
        for (const edge of [1200, 1000, 800, 640]) {
          const scale = Math.min(1, edge / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('IMAGE_CANVAS')); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          for (const quality of [.72, .62, .52]) {
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) { resolve(dataUrl); return; }
          }
        }
        reject(new Error('IMAGE_SIZE'));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function* sseEvents(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('ABORTED');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index == null) break;
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } finally { await reader.cancel().catch(() => {}); }
}

function parseSseBlock(block) {
  let eventName = 'message'; let payload = '';
  block.replace(/\r/g, '').split('\n').forEach((line) => {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) payload += line.slice(5).trim();
  });
  if (!payload) return null;
  try { return { event: eventName, data: JSON.parse(payload) }; } catch { return null; }
}

const NO_TRUSTED_EVIDENCE_CODES = new Set([
  'NO_TRUSTED_EVIDENCE', 'NO_TRUSTED_RESULT', 'NO_TRUSTED_RESULTS', 'NO_TRUSTED_SOURCE', 'NO_TRUSTED_SOURCES',
  'NO_TRUSTED_CURRICULUM_WEB', 'NO_TRUSTED_CURRICULUM_WEB_RESULT', 'NO_TRUSTED_CURRICULUM_WEB_EVIDENCE',
  'NO_TRUSTED_CURRICULUM_OR_WEB_RESULT', 'NO_TRUSTED_CURRICULUM_OR_WEB_EVIDENCE', 'NO_TRUSTED_CURRICULUM_OR_WEB',
  'NO_TRUSTED_LOCAL_OR_WEB_RESULT', 'NO_TRUSTED_LOCAL_OR_WEB_EVIDENCE', 'NO_TRUSTED_CURRICULUM_OR_EXTERNAL_RESULT', 'NO_LOCAL_OR_WEB_EVIDENCE',
  'NO_CURRICULUM_WEB_RESULT', 'NO_CURRICULUM_OR_WEB_RESULT', 'NO_CURRICULUM_OR_WEB_EVIDENCE',
]);
const NO_TRUSTED_CURRICULUM_CODES = new Set(['NO_TRUSTED_CURRICULUM', 'NO_TRUSTED_CURRICULUM_RESULT', 'NO_TRUSTED_LOCAL_RESULT', 'NO_CURRICULUM_EVIDENCE', 'NO_LOCAL_EVIDENCE']);
const NO_TRUSTED_WEB_CODES = new Set(['NO_TRUSTED_WEB', 'NO_TRUSTED_WEB_RESULT', 'NO_TRUSTED_WEB_RESULTS', 'NO_TRUSTED_WEB_EVIDENCE', 'NO_WEB_EVIDENCE', 'NO_WEB_RESULT', 'NO_WEB_RESULTS']);
const NO_TRUSTED_EVIDENCE_MESSAGE = 'لم يُعثر على دليل موثوق في كتب المنهج ولا على نتيجة ويب موثوقة؛ أي شرح عام لا يُعد نقلاً موثقاً من الكتاب.';
const NO_TRUSTED_CURRICULUM_MESSAGE = 'لم يُعثر على دليل موثوق من كتب المنهج لهذا الرد؛ أي شرح عام لا يُعد نقلاً موثقاً من الكتاب.';
const NO_TRUSTED_WEB_MESSAGE = 'لم تُعثر على نتيجة ويب موثوقة؛ لا يُنسب أي شرح عام إلى كتاب المنهج.';
const INCOMPLETE_STREAM_CODES = new Set(['UPSTREAM_INCOMPLETE_STREAM', 'INCOMPLETE_PROVIDER_STREAM', 'PROVIDER_STREAM_INCOMPLETE', 'UPSTREAM_STREAM_INCOMPLETE', 'STREAM_INCOMPLETE']);
const INCOMPLETE_STREAM_MESSAGE = 'انقطع تدفّق مزوّد الذكاء قبل اكتمال الرد؛ الجزء الظاهر غير مكتمل وليس إجابة نهائية. راجعي الأدلة وأعيدي المحاولة.';
const INCOMPLETE_STREAM_MARKER = '**انقطع تدفّق مزوّد الذكاء قبل اكتمال الرد؛ الجزء الظاهر غير مكتمل.**';

function evidenceSignalToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isIncompleteProviderStreamCode(value) {
  const token = evidenceSignalToken(String(value || ''));
  return [...INCOMPLETE_STREAM_CODES].some((code) => token === code || token.includes(code));
}

function incompleteProviderStreamSignal(eventName, data) {
  const eventToken = evidenceSignalToken(String(eventName || ''));
  if (isIncompleteProviderStreamCode(eventToken)) return true;
  const records = [data, data?.stream, data?.provider].filter((value) => value && typeof value === 'object');
  const fields = ['code', 'error', 'status', 'evidenceStatus', 'message', 'reason', 'kind', 'type'];
  if (typeof data === 'string' && isIncompleteProviderStreamCode(data)) return true;
  if (records.some((record) => fields.some((field) => isIncompleteProviderStreamCode(record[field])))) return true;
  return records.some((record) => record.incomplete === true || record.streamComplete === false || record.providerStreamComplete === false || (eventToken === 'DONE' && record.complete === false));
}

function noTrustedEvidenceNotice(eventName, data) {
  const eventToken = evidenceSignalToken(String(eventName || ''));
  if (NO_TRUSTED_EVIDENCE_CODES.has(eventToken)) return NO_TRUSTED_EVIDENCE_MESSAGE;
  if (NO_TRUSTED_CURRICULUM_CODES.has(eventToken)) return NO_TRUSTED_CURRICULUM_MESSAGE;
  if (NO_TRUSTED_WEB_CODES.has(eventToken)) return NO_TRUSTED_WEB_MESSAGE;
  if (!['notice', 'status', 'evidence', 'evidence-status', 'evidence_status', 'warning', 'step', 'done', 'error', 'citations', 'result'].includes(String(eventName || '').toLowerCase())) return '';
  const records = [data, data?.evidence, data?.result].filter((value) => value && typeof value === 'object');
  const signalFields = ['code', 'error', 'status', 'evidenceStatus', 'message', 'reason', 'kind', 'type'];
  const tokens = [typeof data === 'string' ? evidenceSignalToken(data) : '', ...records.flatMap((record) => signalFields.map((field) => evidenceSignalToken(record[field])))];
  if (tokens.some((token) => NO_TRUSTED_EVIDENCE_CODES.has(token))) return NO_TRUSTED_EVIDENCE_MESSAGE;
  if (tokens.some((token) => NO_TRUSTED_CURRICULUM_CODES.has(token))) return NO_TRUSTED_CURRICULUM_MESSAGE;
  if (tokens.some((token) => NO_TRUSTED_WEB_CODES.has(token))) return NO_TRUSTED_WEB_MESSAGE;
  const curriculumFlags = records.flatMap((record) => [record.trustedCurriculum, record.curriculumTrusted, record.hasTrustedCurriculum]);
  const webFlags = records.flatMap((record) => [record.trustedWeb, record.webTrusted, record.hasTrustedWeb]);
  if (records.some((record) => [record.trustedEvidence, record.hasTrustedEvidence, record.trustedResult].includes(false))) return NO_TRUSTED_EVIDENCE_MESSAGE;
  if (curriculumFlags.includes(false) && webFlags.includes(false)) return NO_TRUSTED_EVIDENCE_MESSAGE;
  if (curriculumFlags.includes(false)) return NO_TRUSTED_CURRICULUM_MESSAGE;
  if (webFlags.includes(false)) return NO_TRUSTED_WEB_MESSAGE;
  return '';
}

function apiErrorMessage(error) {
  const code = String(error?.message || error);
  if (isIncompleteProviderStreamCode(code)) return INCOMPLETE_STREAM_MESSAGE;
  const evidenceMessage = noTrustedEvidenceNotice('error', { error: code });
  if (evidenceMessage) return evidenceMessage;
  if (code.includes('AI_NOT_CONFIGURED')) return 'الكتب جاهزة، لكن خدمة الذكاء الاصطناعي غير مضبوطة على الخادم حاليا.';
  if (code.includes('RATE_LIMITED')) return 'أرسلتِ طلبات كثيرة بسرعة. انتظري لحظات ثم حاولي من جديد.';
  if (code.includes('UPSTREAM_AUTH')) return 'المفتاح المخصص للخادم مرفوض. يحتاج المسؤول إلى تحديثه.';
  if (code.includes('UPSTREAM_MODEL')) return 'النموذج غير متاح حاليا. يحتاج المسؤول إلى مراجعة إعداداته.';
  if (code.includes('UPSTREAM_BAD_REQUEST')) return 'رفض مزود الذكاء الطلب. تحققي من إعدادات النموذج وحاولي مجددا.';
  if (code.includes('UPSTREAM_TIMEOUT')) return 'تأخر الرد أكثر من اللازم. اختصري السؤال أو حاولي مرة أخرى.';
  if (code.includes('UPSTREAM_BUSY')) return 'المعلم مشغول الآن. حاولي بعد لحظة.';
  if (code.includes('EMPTY_REPLY')) return 'وصل رد فارغ. حاولي صياغة السؤال بطريقة مختلفة.';
  if (!navigator.onLine || code.includes('Failed to fetch')) return 'انقطع الاتصال. تحققي من الإنترنت وحاولي من جديد.';
  return 'حدث عطل مؤقت أثناء الإجابة. حاولي مرة أخرى.';
}

function assistantShell() {
  const article = document.createElement('article'); article.id = uid('answer'); article.className = 'message assistant';
  article.innerHTML = '<div class="message-label">المعلم</div><div class="message-bubble"><div class="teacher-status" role="status" aria-live="polite" aria-atomic="true"><span class="status-orb" aria-hidden="true"></span><span class="status-copy"><span class="status-text">جار تجهيز الرد…</span><small class="status-detail"></small></span></div></div><div class="inline-sources source-tray" hidden></div>';
  $('#messageList').appendChild(article); $('#messageList').scrollTop = $('#messageList').scrollHeight;
  return article;
}

function updateAssistantProgress(shell, progress) {
  const label = String(progress?.label || '').trim().slice(0, 80);
  const detail = String(progress?.detail || '').trim().slice(0, 120);
  const status = shell.querySelector('.status-text');
  const detailElement = shell.querySelector('.status-detail');
  if (!status || !label) return;
  status.textContent = label;
  status.classList.remove('swap');
  void status.offsetWidth;
  status.classList.add('swap');
  if (detailElement) {
    detailElement.textContent = detail;
    detailElement.hidden = !detail;
  }
}

function appendEvidenceNotices(shell, notices, excludedMessage = '') {
  const bubble = shell.querySelector('.message-bubble');
  if (!bubble) return;
  notices.forEach((message) => {
    if (!message || message === excludedMessage || [...bubble.querySelectorAll('.answer-evidence-note')].some((item) => item.textContent === message)) return;
    const note = document.createElement('div');
    note.className = 'evidence-note warning answer-evidence-note';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    note.textContent = message;
    bubble.appendChild(note);
  });
}

function appendRetryNotice(target, message, retry) {
  const notice = document.createElement('div');
  notice.className = 'error-box';
  notice.setAttribute('role', 'alert');
  notice.appendChild(document.createTextNode(message));
  notice.appendChild(document.createElement('br'));
  const button = document.createElement('button');
  button.className = 'retry-button';
  button.type = 'button';
  button.textContent = 'إعادة المحاولة';
  button.addEventListener('click', retry);
  notice.appendChild(button);
  target.appendChild(notice);
}

function partialReplyMarker(error) {
  return isIncompleteProviderStreamCode(error?.message || error)
    ? INCOMPLETE_STREAM_MARKER
    : '**توقّف الرد قبل اكتماله.**';
}

let lastStreamPaint = 0;
const STREAM_THROTTLE_MS = 50;
function renderStream(shell, content) {
  const now = Date.now();
  if (now - lastStreamPaint < 50) return;
  lastStreamPaint = now;
  fillAssistantBubble(shell.querySelector('.message-bubble'), content, true, shell.id, shell._citations || []);
  const list = $('#messageList');
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 140) list.scrollTop = list.scrollHeight;
}

async function requestReply(conversation, question, images, shell) {
  const abort = new AbortController();
  state.request = { abort, conversation, question, images };
  $('#sendButton').hidden = true; $('#stopButton').hidden = false;
  setConnection('online', 'المعلم يكتب...');
  const messages = conversation.messages.slice(-MAX_REQUEST_MESSAGES).map((message) => ({
    role: message.role,
    content: String(message.content || '').slice(0, MAX_REQUEST_MESSAGE_CHARS),
  }));
  const last = messages.at(-1);
  if (images.length && last?.role === 'user') last.content = [{ type: 'text', text: question || 'اشرحي ما يظهر في الصورة المرفقة.' }, ...images.slice(0, 1).map((url) => ({ type: 'image_url', image_url: { url } }))];
  let full = ''; let citations = []; let finished = false; let paint = 0;
  let streamIncomplete = false;
  const streamNotices = new Set();
  try {
    const response = await fetch('/api/chat', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json', 'X-Session': conversation.id, ...providerHeaders() }, body: JSON.stringify({ messages, studentName: state.settings.studentName || 'رحمة', curriculumTrack: state.settings.curriculumTrack || 'ديني' }) });
    if (!response.ok) {
      let data = {}; try { data = await response.json(); } catch { /* ignore */ }
      const error = new Error(data.error || `HTTP_${response.status}`); error.detail = data.detail || ''; throw error;
    }
    for await (const packet of sseEvents(response, abort.signal)) {
      if (incompleteProviderStreamSignal(packet.event, packet.data)) {
        streamIncomplete = true;
        streamNotices.add(INCOMPLETE_STREAM_MESSAGE);
      }
      const evidenceNotice = noTrustedEvidenceNotice(packet.event, packet.data);
      if (evidenceNotice) streamNotices.add(evidenceNotice);
      if (packet.event === 'step') updateAssistantProgress(shell, packet.data);
      if (packet.event === 'citations') {
        citations = Array.isArray(packet.data.items) ? packet.data.items.map(normalizeCitation).filter(Boolean).slice(0, MAX_CITATIONS) : [];
        shell._citations = citations;
        sourceCards(citations, shell.querySelector('.inline-sources'), true, shell.id);
      }
      if (packet.event === 'delta') {
        full += packet.data.text || '';
        if (!paint) paint = requestAnimationFrame(() => { paint = 0; renderStream(shell, full); });
      }
      if (packet.event === 'done') finished = true;
      if (packet.event === 'error') { const error = new Error(packet.data.error || 'UPSTREAM_FAILED'); error.detail = packet.data.detail || ''; throw error; }
    }
    if (paint) cancelAnimationFrame(paint);
    if (streamIncomplete || !finished) throw new Error('UPSTREAM_INCOMPLETE_STREAM');
    if (!full.trim()) throw new Error('EMPTY_REPLY');
    conversation.messages.push({ role: 'assistant', content: full, cites: citations, notices: [...streamNotices] });
    boundConversation(conversation);
    conversation.updatedAt = Date.now();
    fillAssistantBubble(shell.querySelector('.message-bubble'), full, false, shell.id, citations);
    sourceCards(citations, shell.querySelector('.inline-sources'), true, shell.id);
    appendEvidenceNotices(shell, [...streamNotices]);
    clearSourceTray();
    saveState(); renderRecent();
  } catch (error) {
    if (paint) cancelAnimationFrame(paint);
    if (abort.signal.aborted) {
      if (full.trim()) {
        const partial = `${full}\n\n(أوقفتِ الرد هنا)`;
        conversation.messages.push({ role: 'assistant', content: partial, cites: citations, notices: [...streamNotices] });
        boundConversation(conversation);
        fillAssistantBubble(shell.querySelector('.message-bubble'), partial, false, shell.id, citations); sourceCards(citations, shell.querySelector('.inline-sources'), true, shell.id); appendEvidenceNotices(shell, [...streamNotices]); clearSourceTray(); saveState();
      } else shell.remove();
    } else if (full.trim()) {
      // ما وصل قبل انقطاع النموذج مفيد لا يُستبدل؛ نُبقيه ونضيف تحته طريقة إعادة المحاولة.
      const partial = `${full}\n\n${streamIncomplete ? INCOMPLETE_STREAM_MARKER : partialReplyMarker(error)}`;
      conversation.messages.push({ role: 'assistant', content: partial, cites: citations, notices: [...streamNotices] });
      boundConversation(conversation);
      conversation.updatedAt = Date.now();
      fillAssistantBubble(shell.querySelector('.message-bubble'), partial, false, shell.id, citations);
      sourceCards(citations, shell.querySelector('.inline-sources'), true, shell.id);
      clearSourceTray();
      const errorMessage = streamIncomplete ? INCOMPLETE_STREAM_MESSAGE : apiErrorMessage(error);
      appendEvidenceNotices(shell, [...streamNotices], errorMessage);
      appendRetryNotice(shell, errorMessage, () => { shell.remove(); requestReply(conversation, question, images, assistantShell()); });
      saveState();
    } else {
      const errorMessage = streamIncomplete ? INCOMPLETE_STREAM_MESSAGE : apiErrorMessage(error);
      const bubble = shell.querySelector('.message-bubble');
      bubble.replaceChildren();
      appendRetryNotice(bubble, errorMessage, () => { shell.remove(); requestReply(conversation, question, images, assistantShell()); });
      appendEvidenceNotices(shell, [...streamNotices], errorMessage);
    }
  } finally {
    state.request = null; $('#sendButton').hidden = false; $('#stopButton').hidden = true;
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? statusText(state.ai) : 'تحققي من الاتصال');
    if (navigator.onLine) warmup();
    saveState();
  }
}

async function sendMessage(text, images = []) {
  if (state.request || state.preparingMessage) return;
  const question = String(text || '').trim().slice(0, MAX_REQUEST_MESSAGE_CHARS);
  const selectedImages = Array.isArray(images) ? images.slice(0, 2) : [];
  if (!question && !selectedImages.length) return;
  const conversation = currentConversation() || createConversation();
  state.preparingMessage = true;
  $('#sendButton').disabled = true; $('#attachButton').disabled = true; $('#messageInput').disabled = true;
  let requestImages = selectedImages;
  let imageOrigin = selectedImages.length ? 'attached' : '';
  try {
    if (!requestImages.length && conversation.imageContext) {
      const context = await ensureImageContext(conversation);
      if (!context?.dataUrl) {
        context && (context.status = 'unavailable');
        renderImageContextStatus();
        toast('الصورة السابقة غير متاحة؛ أرفقيها ثانية أو أزيلي السياق.');
        return;
      }
      requestImages = [context.dataUrl];
      imageOrigin = 'context';
    }
    if (selectedImages.length) {
      const dataUrl = selectedImages[0];
      // نحفظ أول صورة فقط كسياق للمحادثة؛ الثانية تُرسل مع الطلب الحالي فقط
      const context = { conversationId: conversation.id, dataUrl, status: 'saving', stored: false, updatedAt: Date.now() };
      state.imageContext = context;
      state.imageContextCache.set(conversation.id, context);
      conversation.imageContext = { updatedAt: Date.now(), stored: false };
      renderImageContextStatus();
      try {
        const evicted = await storeImageContext(conversation.id, dataUrl);
        context.status = 'ready'; context.stored = true;
        conversation.imageContext.stored = true;
        evicted.forEach((id) => {
          const previous = state.conversations.find((item) => item.id === id);
          if (previous?.imageContext) previous.imageContext.stored = false;
          const cached = state.imageContextCache.get(id);
          if (cached) cached.stored = false;
        });
        const memoryEvicted = rememberImageContext(context);
        if (evicted.length || memoryEvicted.length) toast('حُفظت الصورة الحالية؛ قد تحتاج صورة أقدم لإعادة الإرفاق.');
      } catch {
        context.status = 'ready'; context.stored = false;
        const memoryEvicted = rememberImageContext(context);
        if (memoryEvicted.length) toast('حُفظت الصورة الحالية؛ قد تحتاج صورة أقدم لإعادة الإرفاق.');
        else toast('الصورة متاحة حتى إغلاق هذه الصفحة فقط.');
      }
      renderImageContextStatus();
    }
  } finally {
    state.preparingMessage = false;
    $('#sendButton').disabled = false; $('#attachButton').disabled = false; $('#messageInput').disabled = false;
  }
  const visibleText = question || 'اشرحي ما يظهر في الصورة المرفقة.';
  conversation.messages.push({ role: 'user', content: visibleText, hasImage: Boolean(requestImages.length), imageOrigin });
  boundConversation(conversation);
  if (conversation.title === 'جلسة جديدة') conversation.title = visibleText.replace(/\s+/g, ' ').slice(0, 46);
  conversation.updatedAt = Date.now();
  state.composing = false;
  state.view = 'learn';
  const input = $('#messageInput');
  input.value = ''; input.style.height = 'auto';
  state.pendingImages = [];
  renderPendingImages();
  saveState(); renderAll();
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
  const shell = assistantShell();
  await requestReply(conversation, question, requestImages, shell);
}

function safePageImageDataUrl(value) {
  if (typeof value !== 'string' || value.length > 1_500_000) return '';
  return /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) ? value : '';
}

function pageEvidenceInfo(page, imageDataUrl = safePageImageDataUrl(page.imageDataUrl)) {
  const source = normalizedEvidenceToken(page.quotableSource);
  const type = normalizedEvidenceToken(page.evidenceType);
  const statuses = evidenceStatusesOf(page);
  const hasStatus = (...values) => values.some((value) => statuses.has(value));
  const damageReasons = Array.isArray(page.damageReasons) ? page.damageReasons.map(String).filter(Boolean).slice(0, 8) : [];
  const visionReasons = Array.isArray(page.visionReasons) ? page.visionReasons.map(String).filter(Boolean).slice(0, 8) : [];
  const damagedText = hasStatus('damaged-text') || type === 'damaged-text' || source === 'unreliable' || page.damaged === true || (page.searchable === true && damageReasons.length > 0);
  const ocrText = hasStatus('ocr-text') || type === 'ocr-text';
  const cleanPdfStatus = hasStatus('clean-extracted-text', 'clean-text');
  const pdfImageStatus = hasStatus('pdf-image') || type === 'pdf-image';
  const noPdfText = hasStatus('no-text', 'unavailable', 'not-found') || page.searchable === false || pdfImageStatus;
  const reliablePdfText = (type === 'pdf-text' || source === 'pdf-text' || cleanPdfStatus) && page.quotableReliable === true && !damagedText && !hasStatus('no-text', 'unavailable', 'not-found') && type !== 'pdf-image' && page.searchable !== false;
  let label;
  let message;
  let warning = false;
  if (hasStatus('not-found', 'unavailable')) {
    label = 'تعذر توفير نص موثوق للصفحة';
    message = 'لم تتوفر بيانات نصية موثوقة لهذه الصفحة. إذا ظهرت صورة أصلية أدناه، فراجعيها بنفسك؛ لا يعني عرضها أن محتواها قُرئ آلياً.';
    warning = true;
  } else if (source === 'outline-description' || type === 'outline-description') {
    label = `وصف فهرسي غير حرفي${noPdfText ? ' · لا نص PDF قابل للبحث' : ''}`;
    message = damagedText
      ? `المعروض وصف فهرسي غير حرفي. النص المستخرج من PDF متضرر${page.searchable ? ' رغم إمكانية البحث فيه' : ''}؛ لا تعتمدي عليه حرفياً.`
      : 'المعروض وصف فهرسي للتنقل وتحديد الموضوع، وليس نصاً مقروءاً حرفياً من PDF.';
    warning = true;
  } else if (damagedText) {
    label = 'نص مستخرج متضرر';
    message = page.searchable === true
      ? 'النص المستخرج متضرر وغير صالح للاقتباس الحرفي، حتى مع إمكانية البحث فيه.'
      : 'النص المتاح متضرر وغير صالح للاقتباس الحرفي.';
    warning = true;
  } else if (ocrText) {
    label = page.quotableReliable === true ? 'نص OCR · يلزم تحقق بصري' : 'نص OCR غير موثوق';
    message = page.quotableReliable === true
      ? 'النص المستخرج بتقنية OCR اجتاز فحص السلامة، ويُستحسن التحقق من موضع العبارة بصرياً قبل الاقتباس.'
      : 'النص المستخرج بتقنية OCR غير موثوق للاقتباس الحرفي؛ تحققي من صورة الصفحة بنفسك.';
    warning = true;
  } else if (reliablePdfText) {
    label = 'نص PDF · اجتاز فحص السلامة';
    message = 'النص المعروض مستخرج من PDF واجتاز فحص السلامة؛ تحققي من موضع العبارة في الصفحة قبل الاقتباس.';
  } else if (noPdfText) {
    label = pdfImageStatus
      ? `صفحة PDF مصوّرة${imageDataUrl ? ' · صورة أصلية معروضة' : ' · لا توجد معاينة صورة'} `
      : 'لا يوجد نص PDF قابل للبحث';
    message = pdfImageStatus && !imageDataUrl
      ? 'بيانات الصفحة تشير إلى PDF مصوّر، لكن لم تصل صورة فعلية إلى نافذة المعاينة. المعلومات الفهرسية لا تؤكد أن الصورة قُرئت بصرياً.'
      : 'المعروض وصف أو ملخص فهرسي للتنقل فقط؛ لا يؤكد ذلك أن الصفحة قُرئت بصرياً.';
    warning = true;
  } else if (cleanPdfStatus) {
    label = 'نص PDF مصنف نظيفاً';
    message = 'حالة النص المستخرجة من الخادم نظيفة، لكن لم يوسم النص هنا بأنه صالح للاقتباس؛ راجعي الصفحة قبل النقل.';
    warning = true;
  } else {
    label = 'ملخص فهرسي';
    message = 'المعروض ملخص أو وصف فهرسي، وليس نص الصفحة.';
    warning = true;
  }
  if (imageDataUrl) message += ' صورة الصفحة الأصلية معروضة أدناه للمراجعة فقط؛ عرضها لا يعني أن محتواها قُرئ آلياً.';
  const ocrFlagged = visionReasons.some((reason) => /OCR/i.test(String(reason)));
  if (ocrFlagged && !ocrText) message += ' مصدر الصفحة موسوم بالحاجة إلى OCR.';
  if (page.searchable === false && !reliablePdfText && !message.includes('لا يوجد نص PDF قابل للبحث')) message += ' لا يوجد نص PDF قابل للبحث.';
  return { label: label.trim(), message, warning, damageReasons, visionReasons, imageAvailable: Boolean(imageDataUrl), damagedText, ocrText, reliablePdfText, noPdfText };
}

let pageModalRequest = 0;
let pageModalOpener = null;

function openPage(bookId, physicalPage, trigger = null) {
  const pageNumber = Number(physicalPage);
  const modal = $('#pageModal');
  const meta = $('#pageModalMeta');
  const body = $('#pageModalBody');
  const requestId = ++pageModalRequest;
  pageModalOpener = trigger || document.activeElement;
  modal.hidden = false; modal.setAttribute('aria-hidden', 'false');
  $('#pageModalBook').textContent = 'من كتبك المدرسية';
  $('#pageModalTitle').textContent = 'جار فتح الصفحة';
  meta.replaceChildren();
  body.replaceChildren();
  body.setAttribute('aria-busy', 'true');
  const loader = document.createElement('span'); loader.className = 'loader-line'; body.appendChild(loader);
  modal.querySelector('[data-close-modal="pageModal"]')?.focus();
  if (!String(bookId || '').trim() || !Number.isInteger(pageNumber) || pageNumber < 1) {
    $('#pageModalTitle').textContent = 'تعذر فتح الصفحة';
    body.textContent = 'رقم الكتاب أو الصفحة غير صالح.';
    body.setAttribute('aria-busy', 'false');
    return;
  }
  fetchJson(`/api/page?bookId=${encodeURIComponent(bookId)}&page=${encodeURIComponent(pageNumber)}`, {}, 15_000).then((page) => {
    if (requestId !== pageModalRequest || modal.hidden) return;
    const book = state.books.find((value) => value.id === bookId);
    $('#pageModalBook').textContent = book?.subject || 'من كتبك المدرسية';
    $('#pageModalTitle').textContent = page.title || 'صفحة من الكتاب';
    meta.replaceChildren();
    const bookTitle = document.createElement('span'); bookTitle.textContent = book?.title || 'كتاب مدرسي'; meta.appendChild(bookTitle);
    const pageNumber = document.createElement('span');
    pageNumber.textContent = `${page.printedPage != null ? `الصفحة المطبوعة ${page.printedPage}` : 'المطبوع غير متحقق'} · صفحة PDF ${page.physicalPage}`;
    meta.appendChild(pageNumber);
    const imageDataUrl = safePageImageDataUrl(page.imageDataUrl);
    const evidence = pageEvidenceInfo(page, imageDataUrl);
    const evidenceLabel = document.createElement('span'); evidenceLabel.className = evidence.warning ? 'evidence-tag warning' : 'evidence-tag'; evidenceLabel.textContent = evidence.label; meta.appendChild(evidenceLabel);
    if (imageDataUrl) {
      const imageLabel = document.createElement('span'); imageLabel.className = 'evidence-tag warning';
      imageLabel.textContent = 'صورة PDF الأصلية · معاينة للمراجعة'; meta.appendChild(imageLabel);
    }
    body.replaceChildren();
    if (page.summary) {
      const summary = document.createElement('div'); summary.className = 'page-summary';
      const title = document.createElement('b'); title.textContent = 'ملخص فهرسي';
      const text = document.createElement('div'); text.textContent = page.summary; text.dir = 'auto';
      summary.append(title, text); body.appendChild(summary);
    }
    const note = document.createElement('div'); note.className = `evidence-note${evidence.warning ? ' warning' : ''}`; note.textContent = evidence.message; body.appendChild(note);
    if (evidence.damageReasons.length) {
      const reasons = document.createElement('small'); reasons.className = 'evidence-reasons';
      reasons.textContent = `أسباب عدم الاعتماد: ${evidence.damageReasons.slice(0, 4).join('؛ ')}`;
      body.appendChild(reasons);
    }
    if (imageDataUrl) {
      const figure = document.createElement('figure'); figure.className = 'page-scan-figure';
      const image = document.createElement('img');
      image.alt = 'صورة الصفحة الأصلية من ملف PDF للمعاينة';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        figure.remove();
        imageLabel.textContent = 'تعذر عرض معاينة صورة PDF';
        const imageMessage = ' صورة الصفحة الأصلية معروضة أدناه للمراجعة فقط؛ عرضها لا يعني أن محتواها قُرئ آلياً.';
        note.textContent = `${evidence.message.replace(imageMessage, '')} تعذر عرض الصورة المرسلة من الخادم؛ لا تتوفر معاينة بصرية هنا.`;
      }, { once: true });
      image.src = imageDataUrl;
      const caption = document.createElement('figcaption');
      caption.textContent = 'صورة الصفحة الأصلية من PDF — للمعاينة البصرية فقط؛ عرضها لا يعني أن محتواها قُرئ آلياً.';
      figure.append(image, caption);
      body.appendChild(figure);
    }
    const excerpt = document.createElement('div'); excerpt.className = 'page-excerpt'; excerpt.dir = 'auto';
    const excerptTitle = document.createElement('strong'); excerptTitle.className = 'page-excerpt-label';
    const excerptSource = normalizedEvidenceToken(page.quotableSource);
    const pageEvidenceType = normalizedEvidenceToken(page.evidenceType);
    const excerptValue = String(page.quotableText || page.text || '').trim();
    excerptTitle.textContent = excerptSource === 'outline-description' || pageEvidenceType === 'outline-description'
      ? `وصف فهرسي غير حرفي${evidence.damagedText ? ' · نص PDF متضرر' : ''} — للتنقل فقط`
      : evidence.damagedText
        ? 'نص مستخرج متضرر — لا يُنقل حرفياً'
        : evidence.ocrText
          ? 'نص مستخرج بتقنية OCR — راجعيه بصرياً قبل النقل'
        : evidence.reliablePdfText
          ? 'نص مستخرج من PDF'
          : evidence.noPdfText
            ? excerptValue ? 'ملخص أو وصف فهرسي — ليس نص الصفحة' : 'لا يوجد نص PDF قابل للبحث'
            : 'ملخص فهرسي — ليس نص الصفحة';
    const excerptText = document.createElement('div'); excerptText.dir = 'auto';
    excerptText.textContent = excerptValue || 'لا يوجد نص أو وصف متاح لهذه الصفحة.';
    excerpt.append(excerptTitle, excerptText);
    body.appendChild(excerpt);
    body.setAttribute('aria-busy', 'false');
  }).catch(() => {
    if (requestId !== pageModalRequest || modal.hidden) return;
    $('#pageModalTitle').textContent = 'تعذر فتح الصفحة';
    body.textContent = 'حاولي مرة أخرى بعد لحظة.';
    body.setAttribute('aria-busy', 'false');
  });
}

function closeModal(id) {
  const element = $(`#${id}`);
  element.hidden = true;
  element.setAttribute('aria-hidden', 'true');
  if (id === 'pageModal') {
    pageModalRequest += 1;
    if (pageModalOpener?.isConnected) pageModalOpener.focus();
    pageModalOpener = null;
  }
}

function bindEvents() {
  $$('.nav-item, .mobile-nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('.quick-action').forEach((button) => button.addEventListener('click', () => openComposer(button.dataset.prompt || '')));
  bindPromptButtons();
  $('#newChatButton').addEventListener('click', newChat); $('#chatNewButton').addEventListener('click', newChat); $('#mobileNewChat').addEventListener('click', newChat); $('#heroStartButton').addEventListener('click', () => openComposer());
  $('#chatBackButton').addEventListener('click', newChat);
  $('#mobileMenuButton').addEventListener('click', () => {
    const sb = $('#sidebar');
    if(sb?.classList.contains('open')) closeSidebar(); else openSidebar();
  });
  $('#sidebarOverlay')?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){
      if($('#sidebar')?.classList.contains('open')) closeSidebar();
      if(!$('#settingsModal')?.hidden) closeModal('settingsModal');
      if(!$('#pageModal')?.hidden) closeModal('pageModal');
    }
  });
  $('#clearHistoryButton').addEventListener('click', () => { if (state.request || state.preparingMessage) return toast(state.request ? 'أوقفي الرد الحالي أولا' : 'انتظري تجهيز الرسالة.'); if (!state.conversations.length || !confirm('مسح كل الجلسات المحفوظة؟')) return; state.conversations = []; state.activeId = null; state.imageContext = null; state.imageContextCache.clear(); state.pendingImages = []; clearAllImageContexts().catch(() => {}); renderPendingImages(); saveState(); renderAll(); toast('مُسحت الجلسات'); });
  $('#composer').addEventListener('submit', (event) => { event.preventDefault(); const text = $('#messageInput').value.trim(); sendMessage(text, state.pendingImages.slice(0, 2)); });
  $('#messageInput').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; });
  $('#messageInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
  $('#stopButton').addEventListener('click', () => state.request?.abort.abort(new DOMException('stopped', 'AbortError')));
  $('#attachButton').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])].slice(0, 2); event.target.value = ''; if (!files.length) return;
    const pending = [];
    for (const file of files) {
      if (state.pendingImages.length + pending.length >= 2) { toast('يمكنك إرفاق صورتين كحد أقصى في الرسالة الواحدة.'); break; }
      try { pending.push(await compressImage(file)); }
      catch (error) {
        const code = String(error?.message || '');
        toast(code === 'IMAGE_TYPE' ? 'اختاري صورة JPEG أو PNG أو WebP.' : code === 'IMAGE_SIZE' || code === 'IMAGE_DIMENSIONS' ? 'الصورة كبيرة؛ اختاري صورة أصغر.' : 'تعذرت قراءة الصورة.');
      }
    }
    if (pending.length) { state.pendingImages.push(...pending); renderPendingImages(); }
  });
  // سحب وإفلات + لصق الصور
  const composer = $('#composer');
  const handleDroppedFiles = async (files) => {
    const list = [...files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type)).slice(0, 2);
    if (!list.length) return;
    const pending = [];
    for (const file of list) {
      if (state.pendingImages.length + pending.length >= 2) { toast('يمكنك إرفاق صورتين كحد أقصى.'); break; }
      try { pending.push(await compressImage(file)); } catch { toast('تعذرت قراءة إحدى الصور.'); }
    }
    if (pending.length) { state.pendingImages.push(...pending); renderPendingImages(); }
  };
  composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drag-over'); });
  composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
  composer.addEventListener('drop', async (e) => { e.preventDefault(); composer.classList.remove('drag-over'); if (e.dataTransfer?.files?.length) await handleDroppedFiles([...e.dataTransfer.files]); });
  document.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    // لا نسرق اللصق داخل حقول النص
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    await handleDroppedFiles(files);
  });
  $('#historySearch')?.addEventListener('input', renderHistory);
  $('#examForm')?.addEventListener('submit', (event) => { event.preventDefault(); const title = $('#examTitle')?.value.trim(); const date = $('#examDate')?.value; if (!title || !date) return; state.exams.push({ id: uid('e'), title, date }); saveState(); event.target.reset(); renderPlan(); toast('أُضيف الموعد إلى خطتك'); });
  $('#settingsButton').addEventListener('click', () => { $('#settingsName').value = state.settings.studentName || ''; $('#providerKey').value = state.settings.apiKey || ''; $('#providerResult').textContent = ''; renderProviderStatus(); $('#settingsModal').hidden = false; $('#settingsModal').setAttribute('aria-hidden', 'false'); });
  $('#saveProvider').addEventListener('click', async () => {
    const apiKey = $('#providerKey').value.trim().slice(0, 2_048);
    const result = $('#providerResult');
    state.settings.apiKey = apiKey;
    saveState();
    renderProviderStatus();
    result.textContent = apiKey ? 'حُفظ المفتاح على هذا الجهاز.' : 'حُذف المفتاح من هذا الجهاز.';
    toast(apiKey ? 'حُفظ المفتاح' : 'حُذف المفتاح');
    warmup();
  });
  $('#saveSettings').addEventListener('click', () => { state.settings.studentName = $('#settingsName').value.trim().slice(0, 40); saveState(); closeModal('settingsModal'); renderAll(); toast('حُفظت إعداداتك'); });
  $('#resetData').addEventListener('click', () => { if (state.request || state.preparingMessage) return toast(state.request ? 'أوقفي الرد الحالي أولا' : 'انتظري تجهيز الرسالة.'); if (!confirm('سيتم حذف المحادثات والخطة من هذا الجهاز. هل أنت متأكدة؟')) return; state.conversations = []; state.exams = []; state.activeId = null; state.imageContext = null; state.imageContextCache.clear(); state.pendingImages = []; clearAllImageContexts().catch(() => {}); renderPendingImages(); saveState(); closeModal('settingsModal'); renderAll(); toast('تم مسح البيانات المحلية'); });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  $$('.modal').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(modal.id); }));
  window.addEventListener('online', () => { $('#offlineBar').hidden = true; warmup(); });
  window.addEventListener('offline', () => { $('#offlineBar').hidden = false; setConnection('offline', 'لا يوجد اتصال'); });
}

function enterApp() {
  $('#app').hidden = false; state.booted = true; renderAll();
}

function boot() {
  loadState();
  try{ bindEvents(); }catch(e){ console.error('bindEvents',e); }
  enterApp();
  if (!navigator.onLine) $('#offlineBar').hidden = false;
  loadBootstrap();
  warmup();
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
