'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'mualimi.v3';
const LEGACY_SETTINGS = 'm2_settings';
const LEGACY_CONVERSATIONS = 'm2_convs';
const LEGACY_EXAMS = 'm2_exams';
const MAX_CONVERSATIONS = 30;
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const state = {
  settings: { branch: '', apiKey: '' },
  books: [],
  subjects: [],
  curriculum: null,
  ai: { configured: false },
  conversations: [],
  exams: [],
  activeId: null,
  view: 'learn',
  selectedSubject: '',
  libraryQuery: '',
  libraryResults: [],
  pendingImages: [],
  request: null,
  composing: false,
  searchTimer: null,
  booted: false,
};

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}

function loadState() {
  const saved = readJson(STORAGE_KEY, null);
  if (saved && typeof saved === 'object') {
    Object.assign(state.settings, saved.settings || {});
    state.conversations = Array.isArray(saved.conversations) ? saved.conversations : [];
    state.exams = Array.isArray(saved.exams) ? saved.exams : [];
  } else {
    const oldSettings = readJson(LEGACY_SETTINGS, {});
    const oldConversations = readJson(LEGACY_CONVERSATIONS, []);
    const oldExams = readJson(LEGACY_EXAMS, []);
    state.settings.branch = oldSettings.branch || '';
    state.settings.apiKey = oldSettings.key || '';
    state.conversations = Array.isArray(oldConversations) ? oldConversations.map((conversation) => ({
      id: conversation.id || uid('c'),
      title: conversation.title || 'جلسة سابقة',
      createdAt: conversation.at || Date.now(),
      updatedAt: conversation.at || Date.now(),
      messages: Array.isArray(conversation.messages) ? conversation.messages.filter((message) => message?.content).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content).slice(0, 5000),
        cites: Array.isArray(message.cites) ? message.cites : [],
      })) : [],
    })) : [];
    state.exams = Array.isArray(oldExams) ? oldExams : [];
  }
  if (!['أحيائي', 'تطبيقي', 'أدبي'].includes(state.settings.branch)) state.settings.branch = '';
  state.conversations = state.conversations.filter((conversation) => Array.isArray(conversation.messages)).slice(0, MAX_CONVERSATIONS);
  state.exams = state.exams.filter((exam) => exam?.title && exam?.date).slice(0, 80);
}

function saveState() {
  try {
    const conversations = state.conversations.slice(0, MAX_CONVERSATIONS).map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: (conversation.messages || []).slice(-80).map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 5000),
        cites: Array.isArray(message.cites) ? message.cites.slice(0, 8) : [],
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, conversations, exams: state.exams.slice(0, 80) }));
  } catch {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, conversations: state.conversations.slice(0, 8), exams: state.exams.slice(0, 20) })); } catch { /* التخزين اختياري */ }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
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
  status.textContent = state.settings.apiKey ? 'مفتاح هذا الجهاز' : configured ? 'مفتاح الخادم فعال' : 'لا يوجد مفتاح';
  status.classList.toggle('offline', !configured);
  if ($('#providerModel')) $('#providerModel').textContent = state.ai?.model || '—';
  if ($('#providerEndpoint')) $('#providerEndpoint').textContent = state.ai?.endpoint ? state.ai.endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '—';
}

function currentConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function createConversation() {
  const conversation = { id: uid('c'), title: 'جلسة جديدة', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
  return conversation;
}

function openConversation(id) {
  if (!state.conversations.some((conversation) => conversation.id === id)) return;
  state.activeId = id;
  state.view = 'learn';
  renderAll();
}

function newChat() {
  if (state.request) return toast('أوقفي الرد الحالي أولا');
  state.activeId = null;
  state.composing = false;
  state.pendingImages = [];
  state.libraryResults = [];
  state.view = 'learn';
  renderAll();
  $('#messageInput')?.focus();
}

function displayDate(timestamp) {
  try { return new Intl.DateTimeFormat('ar-IQ', { day: 'numeric', month: 'short' }).format(new Date(timestamp)); } catch { return ''; }
}

function bookInitial(book) {
  return String(book?.subject || book?.title || 'م').replace(/^ال/, '').trim().slice(0, 1) || 'م';
}

function visibleBooks() {
  const branch = state.settings.branch;
  return state.books.filter((book) => !branch || branch === 'أدبي' || book.branch === 'عام' || book.branch === branch);
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
    state.subjects = Array.isArray(data.subjects) ? data.subjects : [];
    state.curriculum = data.curriculum || null;
    state.ai = data;
    renderProviderStatus();
    setConnection('online', data.configured ? 'المعلم جاهز' : 'الكتب جاهزة · الذكاء غير مضبوط');
    renderBooks();
    renderLibrary();
  } catch (error) {
    setConnection('offline', 'تعذر الوصول للخادم');
    toast('تعذر تحميل الكتب الآن، حاولي تحديث الصفحة');
  }
}

async function warmup() {
  try {
    const data = await fetchJson('/api/health', {}, 12_000);
    setConnection('online', data.ai?.configured ? 'المعلم جاهز' : 'الكتب جاهزة · الذكاء غير مضبوط');
    state.ai = { ...state.ai, ...(data.ai || {}) };
    renderProviderStatus();
  } catch { setConnection('offline', 'تحققي من الاتصال'); }
}

function markdownHtml(source) {
  let text = escapeHtml(source);
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>').replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|\s)(S\d+)(?=\s|$|[،.؛])/g, '$1<span class="reference-mark">$2</span>');
  const lines = text.split('\n');
  let html = '';
  let list = '';
  const closeList = () => { if (list) { html += list === 'ul' ? '</ul>' : '</ol>'; list = ''; } };
  for (const line of lines) {
    if (!line.trim()) { closeList(); continue; }
    if (line.startsWith('<pre>') || line.startsWith('<h2>') || line.startsWith('<h3>')) { closeList(); html += line; continue; }
    if (/^\s*[-*]\s+/.test(line)) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`; continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`; continue; }
    closeList();
    html += `<p>${line}</p>`;
  }
  closeList();
  return html;
}

function quizElement(raw) {
  let quiz;
  try { quiz = JSON.parse(raw); } catch { return null; }
  if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'quiz-card';
  wrapper.innerHTML = `<h3>${escapeHtml(quiz.title || 'اختبار قصير')}</h3><small>${escapeHtml(quiz.subject || '')}</small>`;
  let score = 0;
  let answered = 0;
  const result = document.createElement('p');
  result.className = 'quiz-result';
  quiz.questions.slice(0, 8).forEach((question, index) => {
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
        if (answered === Math.min(quiz.questions.length, 8)) result.textContent = `نتيجتك ${score} من ${answered}`;
      });
      item.appendChild(button);
    });
    wrapper.appendChild(item);
  });
  wrapper.appendChild(result);
  return wrapper;
}

function fillAssistantBubble(element, content, streaming = false) {
  element.innerHTML = '';
  const parts = String(content || '').split(/```quiz\s*([\s\S]*?)```/g);
  parts.forEach((part, index) => {
    if (index % 2 === 1) { const quiz = quizElement(part.trim()); if (quiz) element.appendChild(quiz); return; }
    if (part.trim()) { const block = document.createElement('div'); block.innerHTML = markdownHtml(part); element.appendChild(block); }
  });
  if (streaming) {
    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    element.appendChild(typing);
  }
}

function sourceCards(sources, target, compact = false) {
  target.innerHTML = '';
  if (!sources?.length) { target.hidden = true; return; }
  target.hidden = false;
  sources.slice(0, 6).forEach((source) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `source-card${source.needsOcr ? ' vision' : ''}`;
    button.innerHTML = `<span>${escapeHtml(source.id || 'S')} · ${escapeHtml(source.subject || source.title || 'كتاب')}</span><small>${escapeHtml(source.printedPage ? `صفحة ${source.printedPage}` : `صفحة ${source.physicalPage}`)}${source.needsOcr ? ' · صفحة مصورة' : ''}</small>`;
    button.addEventListener('click', () => openPage(source.bookId, source.physicalPage));
    target.appendChild(button);
  });
  if (compact) target.classList.add('compact'); else target.classList.remove('compact');
}

function userMessageElement(message) {
  const article = document.createElement('article');
  article.className = 'message user';
  article.innerHTML = `<div class="message-label">أنتِ</div><div class="message-bubble"></div>`;
  const bubble = article.querySelector('.message-bubble');
  bubble.innerHTML = `<p>${escapeHtml(message.content || 'صورة مرفقة').replace(/\n/g, '<br>')}</p>`;
  return article;
}

function assistantMessageElement(message) {
  const article = document.createElement('article');
  article.className = 'message assistant';
  article.innerHTML = '<div class="message-label">المعلم</div><div class="message-bubble"></div><div class="inline-sources source-tray"></div>';
  fillAssistantBubble(article.querySelector('.message-bubble'), message.content);
  sourceCards(message.cites || [], article.querySelector('.inline-sources'), true);
  return article;
}

function renderMessages() {
  const list = $('#messageList');
  if (!list) return;
  const conversation = currentConversation();
  list.innerHTML = '';
  if (!conversation || !conversation.messages.length) {
    list.innerHTML = `<div class="welcome-message"><div class="welcome-icon">م</div><h2>من أين نبدأ؟</h2><p>اكتبي اسم الدرس أو السؤال كما يخطر في بالك. سأبحث في كتبك وأضع المصدر مع الشرح.</p><div class="welcome-prompt-row"><button class="prompt-chip" data-prompt="اشرح لي أحكام التلاوة بطريقة سهلة">أحكام التلاوة</button><button class="prompt-chip" data-prompt="اشرح لي أسلوب الاستفهام مع أمثلة">أسلوب الاستفهام</button><button class="prompt-chip" data-prompt="اختبرني في التاريخ">اختبار سريع</button></div></div>`;
    bindPromptButtons(list);
    return;
  }
  for (const message of conversation.messages) list.appendChild(message.role === 'assistant' ? assistantMessageElement(message) : userMessageElement(message));
  list.scrollTop = list.scrollHeight;
}

function showLearnPanel() {
  const conversation = currentConversation();
  const chatting = Boolean(conversation?.messages?.length || state.composing);
  $('#homePanel').hidden = chatting;
  $('#chatPanel').hidden = !chatting;
  if (chatting) {
    $('#chatTitle').textContent = conversation.title;
    renderMessages();
  }
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
    button.addEventListener('click', () => { openConversation(conversation.id); $('#sidebar').classList.remove('open'); });
    list.appendChild(button);
  });
}

function renderBooks() {
  const books = visibleBooks();
  const featured = $('#featuredBooks');
  if (!featured) return;
  featured.innerHTML = '';
  books.slice(0, 3).forEach((book) => {
    const button = document.createElement('button');
    button.className = 'book-tile';
    button.innerHTML = `<div class="book-tile-top"><span class="book-label">${escapeHtml(bookInitial(book))}</span><span class="book-arrow">↗</span></div><h3>${escapeHtml(book.title)}</h3><small>${escapeHtml(book.subject)} · ${book.pageCount || 0} صفحة</small>`;
    button.addEventListener('click', () => openLibraryForBook(book));
    featured.appendChild(button);
  });
  if (!books.length) featured.innerHTML = '<div class="empty-state">لم تصل قائمة الكتب بعد.</div>';
}

function renderSubjectFilters() {
  const element = $('#subjectFilters');
  element.innerHTML = '';
  const subjects = [...new Set(visibleBooks().map((book) => book.subject).filter(Boolean))];
  [['', 'كل المواد'], ...subjects.map((subject) => [subject, subject])].forEach(([value, label]) => {
    const button = document.createElement('button');
    button.className = `filter-chip${state.selectedSubject === value ? ' active' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => { state.selectedSubject = value; renderLibrary(); });
    element.appendChild(button);
  });
}

function renderResultCards() {
  const element = $('#libraryResults');
  element.innerHTML = '';
  if (!state.libraryQuery || state.libraryQuery.trim().length < 2) return;
  if (!state.libraryResults.length) { element.innerHTML = '<div class="empty-state">لم أعثر على صفحة مطابقة. جربي اسم الدرس أو كلمة أقرب.</div>'; return; }
  state.libraryResults.forEach((result) => {
    const card = document.createElement('article');
    card.className = 'result-card';
    card.innerHTML = `<span class="result-book-mark">${escapeHtml(bookInitial(result))}</span><div class="result-content"><h3>${escapeHtml(result.pageTitle || result.title)}</h3><p>${escapeHtml(result.summary || result.preview || '')}</p><div class="result-meta"><span>${escapeHtml(result.subject)}</span><span>${escapeHtml(result.printedPage ? `صفحة ${result.printedPage}` : `صفحة ${result.physicalPage}`)}</span>${result.needsOcr ? '<span>مصورة</span>' : ''}</div></div><button class="result-open" type="button" aria-label="فتح الصفحة">←</button>`;
    card.querySelector('.result-open').addEventListener('click', () => openPage(result.bookId, result.physicalPage));
    card.addEventListener('click', (event) => { if (!event.target.closest('button')) openPage(result.bookId, result.physicalPage); });
    element.appendChild(card);
  });
}

function renderLibraryBooks() {
  const element = $('#libraryBooks');
  element.innerHTML = '';
  const books = visibleBooks().filter((book) => !state.selectedSubject || book.subject === state.selectedSubject);
  if (!books.length) { element.innerHTML = '<div class="empty-state">لا توجد كتب لهذا الاختيار.</div>'; return; }
  books.forEach((book) => {
    const card = document.createElement('article');
    card.className = 'library-book-card';
    const kind = book.kind === 'teacher-guide' ? 'دليل مدرس' : book.kind === 'official-exercises' ? 'تمارين' : 'كتاب رسمي';
    card.innerHTML = `<header><div><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.subject)} · ${escapeHtml(book.branch || 'عام')}</p></div><span class="book-kind">${kind}</span></header><div class="book-card-foot"><span>${book.pageCount || 0} صفحة · ${book.searchablePageCount || 0} قابلة للبحث</span><b>ابحثي فيه ←</b></div>`;
    card.addEventListener('click', () => openLibraryForBook(book));
    element.appendChild(card);
  });
}

function renderLibrary() {
  if (!$('#libraryBooks')) return;
  $('#librarySearch').value = state.libraryQuery;
  $('#clearLibrarySearch').hidden = !state.libraryQuery;
  $('#libraryStats').textContent = state.curriculum ? `${state.curriculum.books} كتب · ${state.curriculum.pages} صفحة` : '';
  renderSubjectFilters();
  renderResultCards();
  renderLibraryBooks();
}

function openLibraryForBook(book) {
  state.view = 'library';
  state.selectedSubject = book.subject || '';
  state.libraryQuery = book.subject || book.title || '';
  state.libraryResults = [];
  renderAll();
  searchLibrary();
}

async function searchLibrary() {
  const query = state.libraryQuery.trim();
  if (query.length < 2) { state.libraryResults = []; renderResultCards(); return; }
  try {
    const params = new URLSearchParams({ q: query, limit: '10', branch: state.settings.branch });
    if (state.selectedSubject) params.set('subject', state.selectedSubject);
    const data = await fetchJson(`/api/search?${params}`);
    state.libraryResults = data.results || [];
  } catch { state.libraryResults = []; }
  if (state.view === 'library') renderResultCards();
}

function renderPlan() {
  const list = $('#examList');
  list.innerHTML = '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = state.exams.filter((exam) => new Date(`${exam.date}T00:00:00`) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const next = upcoming[0];
  if (next) {
    const days = Math.ceil((new Date(`${next.date}T00:00:00`) - today) / 86_400_000);
    $('#nextExamLabel').textContent = next.title;
    $('#nextExamMeta').textContent = new Intl.DateTimeFormat('ar-IQ', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${next.date}T00:00:00`));
    $('#nextExamDays').textContent = days === 0 ? 'اليوم' : days === 1 ? 'غدا' : `بعد ${days}\nيوما`;
  } else {
    $('#nextExamLabel').textContent = 'لا توجد مواعيد بعد'; $('#nextExamMeta').textContent = 'أضيفي امتحانا أو هدفا دراسيا.'; $('#nextExamDays').textContent = '—';
  }
  if (!upcoming.length) { list.innerHTML = '<div class="empty-state">الخطة الفارغة ليست مشكلة. أضيفي أول موعد، وسنرى الطريق أمامك.</div>'; return; }
  upcoming.forEach((exam) => {
    const date = new Date(`${exam.date}T00:00:00`);
    const days = Math.ceil((date - today) / 86_400_000);
    const item = document.createElement('article'); item.className = 'exam-item';
    item.innerHTML = `<span class="exam-date">${date.getDate()}<small>${new Intl.DateTimeFormat('ar-IQ', { month: 'short' }).format(date)}</small></span><div class="exam-info"><b>${escapeHtml(exam.title)}</b><small>${new Intl.DateTimeFormat('ar-IQ', { weekday: 'long', year: 'numeric' }).format(date)}</small></div><span class="exam-days">${days === 0 ? 'اليوم' : days === 1 ? 'غدا' : `بعد ${days} يوم`}</span><button class="delete-button" type="button" aria-label="حذف الموعد">×</button>`;
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
  $('#historyCount').textContent = `${state.conversations.filter((conversation) => conversation.messages?.length).length} جلسات`;
  list.innerHTML = '';
  if (!conversations.length) { list.innerHTML = '<div class="empty-state">لا توجد جلسات مطابقة بعد. كل سؤال جيد هو بداية جديدة.</div>'; return; }
  conversations.forEach((conversation) => {
    const item = document.createElement('article'); item.className = 'history-item';
    item.innerHTML = `<span class="history-icon">◈</span><div class="history-info"><b>${escapeHtml(conversation.title)}</b><small>${conversation.messages.filter((message) => message.role === 'user').length} أسئلة · ${displayDate(conversation.updatedAt || conversation.createdAt)}</small></div><span class="history-arrow">←</span>`;
    item.addEventListener('click', () => openConversation(conversation.id));
    list.appendChild(item);
  });
}

function setView(view) {
  if (!['learn', 'library', 'plan', 'history'].includes(view)) view = 'learn';
  state.view = view;
  ['learn', 'library', 'plan', 'history'].forEach((name) => {
    const section = $(`#view-${name}`);
    if (section) section.hidden = name !== view;
  });
  $$('.nav-item, .mobile-nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'learn') showLearnPanel();
  if (view === 'library') renderLibrary();
  if (view === 'plan') renderPlan();
  if (view === 'history') renderHistory();
  $('#sidebar').classList.remove('open');
}

function renderAll() {
  $('#branchBadge').textContent = state.settings.branch ? `الفرع ${state.settings.branch}` : '';
  $('#studentName').textContent = state.settings.branch ? `طالبة ${state.settings.branch}` : 'طالبة';
  renderRecent();
  renderBooks();
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
    const element = document.createElement('img'); element.src = image; element.alt = 'مرفق؛ اضغطي للحذف';
    element.addEventListener('click', () => { state.pendingImages.splice(index, 1); renderPendingImages(); });
    preview.appendChild(element);
  });
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('IMAGE_READ'));
    reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error('IMAGE_READ'));
      image.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', .72));
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

function apiErrorMessage(error) {
  const code = String(error?.message || error);
  if (code.includes('AI_NOT_CONFIGURED')) return 'الكتب جاهزة، لكن خدمة الذكاء الاصطناعي غير مضبوطة على الخادم حاليا.';
  if (code.includes('RATE_LIMITED')) return 'أرسلتِ طلبات كثيرة بسرعة. انتظري لحظات ثم حاولي من جديد.';
  if (code.includes('UPSTREAM_AUTH')) return 'المفتاح المخصص للخادم مرفوض. يحتاج المسؤول إلى تحديثه.';
  if (code.includes('UPSTREAM_MODEL')) return 'النموذج غير متاح حاليا. يحتاج المسؤول إلى مراجعة إعداداته.';
  if (code.includes('UPSTREAM_BAD_REQUEST')) return 'رفض مزود الذكاء الطلب أو أن النموذج غير متاح. حاولي من المصدر المباشر أدناه.';
  if (code.includes('UPSTREAM_TIMEOUT')) return 'تأخر الرد أكثر من اللازم. اختصري السؤال أو حاولي مرة أخرى.';
  if (code.includes('UPSTREAM_BUSY')) return 'المعلم مشغول الآن. حاولي بعد لحظة.';
  if (code.includes('EMPTY_REPLY')) return 'وصل رد فارغ. حاولي صياغة السؤال بطريقة مختلفة.';
  if (!navigator.onLine || code.includes('Failed to fetch')) return 'انقطع الاتصال. تحققي من الإنترنت وحاولي من جديد.';
  return 'حدث عطل مؤقت أثناء الإجابة. حاولي مرة أخرى.';
}

function assistantShell() {
  const article = document.createElement('article'); article.className = 'message assistant';
  article.innerHTML = '<div class="message-label">المعلم</div><div class="message-bubble"><span class="typing"><i></i><i></i><i></i></span></div><div class="inline-sources source-tray"></div>';
  $('#messageList').appendChild(article); $('#messageList').scrollTop = $('#messageList').scrollHeight;
  return article;
}

function renderStream(shell, content) {
  fillAssistantBubble(shell.querySelector('.message-bubble'), content, true);
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
}

async function requestReply(conversation, question, images, shell) {
  const abort = new AbortController();
  state.request = { abort, conversation, question, images };
  $('#sendButton').hidden = true; $('#stopButton').hidden = false;
  setConnection('online', 'المعلم يكتب...');
  const messages = conversation.messages.map((message) => ({ role: message.role, content: message.content }));
  const last = messages.at(-1);
  if (images.length && last?.role === 'user') last.content = [{ type: 'text', text: question || 'اشرحي الصورة المرفقة.' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  let full = ''; let citations = []; let finished = false; let paint = 0;
  try {
    const response = await fetch('/api/chat', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json', 'X-Session': conversation.id, ...providerHeaders() }, body: JSON.stringify({ messages, branch: state.settings.branch }) });
    if (!response.ok) {
      let data = {}; try { data = await response.json(); } catch { /* ignore */ }
      const error = new Error(data.error || `HTTP_${response.status}`); error.detail = data.detail || ''; throw error;
    }
    for await (const packet of sseEvents(response, abort.signal)) {
      if (packet.event === 'citations') { citations = packet.data.items || []; sourceCards(citations, $('#sourceTray')); }
      if (packet.event === 'delta') {
        full += packet.data.text || '';
        if (!paint) paint = requestAnimationFrame(() => { paint = 0; renderStream(shell, full); });
      }
      if (packet.event === 'done') finished = true;
      if (packet.event === 'error') { const error = new Error(packet.data.error || 'UPSTREAM_FAILED'); error.detail = packet.data.detail || ''; throw error; }
    }
    if (paint) cancelAnimationFrame(paint);
    if (!full.trim()) throw new Error(finished ? 'EMPTY_REPLY' : 'UPSTREAM_FAILED');
    conversation.messages.push({ role: 'assistant', content: full, cites: citations });
    conversation.updatedAt = Date.now();
    fillAssistantBubble(shell.querySelector('.message-bubble'), full);
    sourceCards(citations, shell.querySelector('.inline-sources'), true);
    saveState(); renderRecent();
  } catch (error) {
    if (paint) cancelAnimationFrame(paint);
    if (abort.signal.aborted) {
      if (full.trim()) {
        const partial = `${full}\n\n(أوقفتِ الرد هنا)`;
        conversation.messages.push({ role: 'assistant', content: partial, cites: citations });
        fillAssistantBubble(shell.querySelector('.message-bubble'), partial); sourceCards(citations, shell.querySelector('.inline-sources'), true); saveState();
      } else shell.remove();
    } else {
      shell.querySelector('.message-bubble').innerHTML = `<div class="error-box">${escapeHtml(apiErrorMessage(error))}<br><button class="retry-button" type="button">إعادة المحاولة</button></div>`;
      shell.querySelector('.retry-button').addEventListener('click', () => { shell.remove(); requestReply(conversation, question, images, assistantShell()); });
    }
  } finally {
    state.request = null; $('#sendButton').hidden = false; $('#stopButton').hidden = true;
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? (state.ai.configured ? 'المعلم جاهز' : 'الكتب جاهزة') : 'تحققي من الاتصال');
    saveState();
  }
}

async function sendMessage(text, images = []) {
  if (state.request) return;
  const question = String(text || '').trim();
  if (!question && !images.length) return;
  const conversation = currentConversation() || createConversation();
  const visibleText = question || 'اشرحي ما يظهر في الصورة المرفقة.';
  conversation.messages.push({ role: 'user', content: visibleText });
  if (conversation.title === 'جلسة جديدة') conversation.title = visibleText.replace(/\s+/g, ' ').slice(0, 46);
  conversation.updatedAt = Date.now();
  state.composing = false;
  state.view = 'learn';
  saveState(); renderAll();
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
  const shell = assistantShell();
  await requestReply(conversation, question, images, shell);
}

function openPage(bookId, physicalPage) {
  $('#pageModal').hidden = false; $('#pageModal').setAttribute('aria-hidden', 'false');
  $('#pageModalBook').textContent = 'من كتبك المدرسية'; $('#pageModalTitle').textContent = 'جار فتح الصفحة'; $('#pageModalMeta').innerHTML = ''; $('#pageModalBody').innerHTML = '<span class="loader-line"></span>';
  fetchJson(`/api/page?bookId=${encodeURIComponent(bookId)}&page=${encodeURIComponent(physicalPage)}`, {}, 15_000).then((page) => {
    const book = state.books.find((value) => value.id === bookId);
    $('#pageModalBook').textContent = book?.subject || 'كتاب مدرسي'; $('#pageModalTitle').textContent = page.title || 'صفحة من الكتاب';
    $('#pageModalMeta').innerHTML = `<span>${escapeHtml(book?.title || '')}</span><span>${escapeHtml(page.printedPage ? `الصفحة ${page.printedPage}` : `الصفحة ${page.physicalPage}`)}</span>${page.needsVision ? '<span>تحتاج قراءة بصرية</span>' : ''}`;
    $('#pageModalBody').innerHTML = `${page.summary ? `<div class="page-summary">${escapeHtml(page.summary)}</div>` : ''}${page.needsVision && !page.searchable ? '<div class="vision-note">هذه الصفحة مصورة أو لا تحتوي نصا مستخرجا بالكامل. الملخص الظاهر هو المتاح الموثوق حاليا.</div>' : ''}<div>${escapeHtml(page.text || 'لا يوجد نص متاح لهذه الصفحة.')}</div>`;
  }).catch(() => { $('#pageModalTitle').textContent = 'تعذر فتح الصفحة'; $('#pageModalBody').textContent = 'حاولي مرة أخرى بعد لحظة.'; });
}

function closeModal(id) { const element = $(`#${id}`); element.hidden = true; element.setAttribute('aria-hidden', 'true'); }

function bindEvents() {
  $$('.nav-item, .mobile-nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-go-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.goView)));
  $$('.quick-action').forEach((button) => button.addEventListener('click', () => openComposer(button.dataset.prompt || '')));
  bindPromptButtons();
  $('#newChatButton').addEventListener('click', newChat); $('#chatNewButton').addEventListener('click', newChat); $('#mobileNewChat').addEventListener('click', newChat); $('#heroStartButton').addEventListener('click', () => openComposer());
  $('#chatBackButton').addEventListener('click', newChat);
  $('#mobileMenuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#clearHistoryButton').addEventListener('click', () => { if (!state.conversations.length || !confirm('مسح كل الجلسات المحفوظة؟')) return; state.conversations = []; state.activeId = null; saveState(); renderAll(); toast('مُسحت الجلسات'); });
  $('#composer').addEventListener('submit', (event) => { event.preventDefault(); const input = $('#messageInput'); const text = input.value.trim(); const images = state.pendingImages.map((url) => ({ type: 'image_url', image_url: { url } })); input.value = ''; input.style.height = 'auto'; state.pendingImages = []; renderPendingImages(); sendMessage(text, images.map((item) => item.image_url.url)); });
  $('#messageInput').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; });
  $('#messageInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
  $('#stopButton').addEventListener('click', () => state.request?.abort.abort(new DOMException('stopped', 'AbortError')));
  $('#attachButton').addEventListener('click', () => $('#imageInput').click());
  $('#imageInput').addEventListener('change', async (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { state.pendingImages = [await compressImage(file)]; renderPendingImages(); } catch { toast('تعذرت قراءة الصورة'); } });
  $('#librarySearch').addEventListener('input', (event) => { state.libraryQuery = event.target.value; $('#clearLibrarySearch').hidden = !state.libraryQuery; clearTimeout(state.searchTimer); state.searchTimer = setTimeout(searchLibrary, 260); renderResultCards(); });
  $('#clearLibrarySearch').addEventListener('click', () => { state.libraryQuery = ''; state.libraryResults = []; renderLibrary(); });
  $('#historySearch').addEventListener('input', renderHistory);
  $('#examForm').addEventListener('submit', (event) => { event.preventDefault(); const title = $('#examTitle').value.trim(); const date = $('#examDate').value; if (!title || !date) return; state.exams.push({ id: uid('e'), title, date }); saveState(); event.target.reset(); renderPlan(); toast('أُضيف الموعد إلى خطتك'); });
  $('#settingsButton').addEventListener('click', () => { $('#settingsBranch').value = state.settings.branch || 'أحيائي'; $('#providerKey').value = state.settings.apiKey || ''; $('#providerResult').textContent = ''; renderProviderStatus(); $('#settingsModal').hidden = false; $('#settingsModal').setAttribute('aria-hidden', 'false'); });
  $('#saveProvider').addEventListener('click', async () => {
    const apiKey = $('#providerKey').value.trim();
    const result = $('#providerResult');
    state.settings.apiKey = apiKey;
    saveState();
    renderProviderStatus();
    result.textContent = apiKey ? 'حُفظ المفتاح على هذا الجهاز.' : 'حُذف المفتاح من هذا الجهاز.';
    toast(apiKey ? 'حُفظ المفتاح' : 'حُذف المفتاح');
    warmup();
  });
  $('#saveSettings').addEventListener('click', () => { state.settings.branch = $('#settingsBranch').value; saveState(); closeModal('settingsModal'); renderAll(); toast('حُفظ الفرع الدراسي'); });
  $('#resetData').addEventListener('click', () => { if (!confirm('سيتم حذف المحادثات والخطة من هذا الجهاز. هل أنت متأكدة؟')) return; state.conversations = []; state.exams = []; state.activeId = null; saveState(); closeModal('settingsModal'); renderAll(); toast('تم مسح البيانات المحلية'); });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  $$('.modal').forEach((modal) => modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(modal.id); }));
  window.addEventListener('online', () => { $('#offlineBar').hidden = true; warmup(); });
  window.addEventListener('offline', () => { $('#offlineBar').hidden = false; setConnection('offline', 'لا يوجد اتصال'); });
}

function enterApp() {
  $('#onboarding').hidden = true; $('#app').hidden = false; state.booted = true; renderAll();
}

function boot() {
  loadState();
  let chosen = state.settings.branch;
  $$('.branch-choice').forEach((button) => button.addEventListener('click', () => { chosen = button.dataset.branch; $$('.branch-choice').forEach((item) => item.classList.toggle('selected', item === button)); $('#startButton').disabled = false; }));
  $('#startButton').addEventListener('click', () => { if (!chosen) return; state.settings.branch = chosen; saveState(); enterApp(); });
  bindEvents();
  if (state.settings.branch) enterApp(); else $('#onboarding').hidden = false;
  if (!navigator.onLine) $('#offlineBar').hidden = false;
  loadBootstrap();
  warmup();
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
