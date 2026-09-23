import { Memory } from './memory.js'
import { Teacher } from './teacher.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import { Progress } from './progress.js'

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

const state = {
  view: 'chat',
  loading: false,
  run: null,
  pendingImages: [],
  lastRequest: null,
  reminderTimers: [],
}

function toast(message, kind = '') {
  const element = $('#toast')
  if (!element) return
  element.textContent = message
  element.className = `toast visible ${kind}`
  clearTimeout(element._timer)
  element._timer = setTimeout(() => { element.className = 'toast' }, 3_000)
}

function scrollMessages() {
  const messages = $('#messages')
  if (messages) messages.scrollTop = messages.scrollHeight
}

function currentConversation() { return Memory.currentConversation() }

function messagePayload(message) {
  const images = Array.isArray(message.images) ? message.images : []
  if (message.role === 'user' && images.length) return { role: 'user', content: [{ type: 'text', text: String(message.content || '') }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
  return { role: message.role, content: String(message.content || '') }
}

function currentMessages() {
  return currentConversation().messages.filter((message) => !message.pending && message.content !== '' && ['user', 'assistant', 'tool'].includes(message.role)).map(messagePayload)
}

function appendUserMessage(text, images = []) {
  const wrapper = document.createElement('article')
  wrapper.className = 'message user-message'
  const bubble = document.createElement('div')
  bubble.className = 'message-bubble'
  const textNode = document.createElement('p')
  textNode.className = 'user-text'
  textNode.innerHTML = escapeHtml(text).replace(/\n/g, '<br>')
  bubble.appendChild(textNode)
  if (images.length) {
    const gallery = document.createElement('div')
    gallery.className = 'message-images'
    images.forEach((src) => {
      const image = document.createElement('img')
      image.src = src
      image.alt = 'صورة أرفقتها رحما'
      image.loading = 'lazy'
      image.addEventListener('click', () => window.open(src, '_blank', 'noopener'))
      gallery.appendChild(image)
    })
    bubble.appendChild(gallery)
  }
  wrapper.appendChild(bubble)
  $('#messages').appendChild(wrapper)
  return wrapper
}

function appendAssistantMessage() {
  const wrapper = document.createElement('article')
  wrapper.className = 'message assistant-message'
  const header = document.createElement('div')
  header.className = 'assistant-header'
  header.innerHTML = '<span class="teacher-avatar">م</span><strong>المعلم</strong><span class="assistant-presence">معكِ الآن</span><span class="teacher-pulse" aria-hidden="true"></span>'
  const status = document.createElement('div')
  status.className = 'assistant-status'
  status.textContent = 'أفهم سؤالك...'
  const bubble = document.createElement('div')
  bubble.className = 'message-bubble assistant-bubble'
  bubble.innerHTML = '<span class="typing">أفهم سؤالك...</span>'
  const actions = document.createElement('div')
  actions.className = 'assistant-actions'
  const sources = document.createElement('div')
  sources.className = 'sources'
  wrapper.append(header, status, bubble, actions, sources)
  $('#messages').appendChild(wrapper)
  return { wrapper, header, status, bubble, actions, sources }
}

function setAssistantStatus(label, active = true) {
  const node = state.run?.assistantNode
  if (!node) return
  node.status.textContent = label || ''
  node.status.classList.toggle('hidden', !label)
  node.wrapper.classList.toggle('is-running', active)
  $('#connLabel').textContent = active ? label || 'المعلم يكتب لكِ' : 'جاهز لسماعك'
  $('#connectionDot')?.classList.toggle('busy', active)
}

function updateAssistantText(text) {
  const node = state.run?.assistantNode
  if (!node) return
  node.bubble.innerHTML = text ? renderMarkdown(text) : '<span class="typing">المعلم يرتب الشرح...</span>'
  scrollMessages()
}

function citationLabel(citation) {
  const page = citation.printedPageNumber ?? citation.pageNumber
  return [citation.title, page ? `ص ${page}` : ''].filter(Boolean).join(' · ')
}

function addCitation(citation) {
  const node = state.run?.assistantNode
  const label = citationLabel(citation)
  if (!node || !label) return
  const item = document.createElement('span')
  item.className = 'source-chip'
  item.textContent = `▦ ${label}`
  node.sources.appendChild(item)
}

function renderQuiz(action, target) {
  const card = document.createElement('section')
  card.className = 'interactive-card quiz-card'
  const questions = Array.isArray(action.questions) ? action.questions : []
  card.innerHTML = `<div class="interactive-heading"><div><span class="section-kicker">تدريب من الصفحات المقروءة</span><h3>${escapeHtml(action.title || 'اختبار قصير')}</h3></div><span class="subject-tag">${escapeHtml(action.subject || '')}</span></div><div class="quiz-list"></div><div class="quiz-result hidden"></div>`
  const list = card.querySelector('.quiz-list')
  let answered = 0
  let score = 0
  questions.forEach((question, questionIndex) => {
    const row = document.createElement('div')
    row.className = 'quiz-question'
    row.innerHTML = `<p class="quiz-prompt"><b>${questionIndex + 1}</b> ${escapeHtml(question.prompt || '')}</p><div class="quiz-options"></div><p class="quiz-explanation hidden"></p>`
    const options = row.querySelector('.quiz-options')
    const explanation = row.querySelector('.quiz-explanation')
    ;(Array.isArray(question.options) ? question.options : []).forEach((option, optionIndex) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'quiz-option'
      button.textContent = option
      button.addEventListener('click', () => {
        if (row.dataset.answered) return
        row.dataset.answered = 'true'
        answered += 1
        const correct = optionIndex === Number(question.correctIndex)
        if (correct) score += 1
        options.querySelectorAll('button').forEach((candidate, index) => {
          candidate.disabled = true
          if (index === Number(question.correctIndex)) candidate.classList.add('correct')
        })
        if (!correct) button.classList.add('wrong')
        explanation.textContent = question.explanation || 'راجعي الفكرة في الشرح السابق.'
        explanation.classList.remove('hidden')
        if (answered === questions.length) {
          const result = card.querySelector('.quiz-result')
          result.textContent = `نتيجتكِ ${score} من ${questions.length}. أحسنتِ على المحاولة.`
          result.classList.remove('hidden')
          Memory.addTestResult(action.subject, score, questions.length, { title: action.title })
          renderProgressSummary()
        }
      })
      options.appendChild(button)
    })
    list.appendChild(row)
  })
  target.appendChild(card)
  return card
}

function renderSubjectChoice(action, target) {
  const card = document.createElement('section')
  card.className = 'interactive-card choice-card'
  card.innerHTML = `<div class="interactive-heading"><div><span class="section-kicker">نبدأ من المكان الصحيح</span><h3>${escapeHtml(action.question || 'أي مادة ندرس اليوم؟')}</h3></div></div><div class="choice-grid"></div>`
  const grid = card.querySelector('.choice-grid')
  ;(Array.isArray(action.choices) ? action.choices : []).forEach((choice) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'choice-button'
    button.innerHTML = `<span>${escapeHtml(choice.icon || '▦')}</span><strong>${escapeHtml(choice.title || choice.id || '')}</strong>`
    button.addEventListener('click', () => {
      if (state.loading) return
      $('#input').value = `أختار مادة ${choice.title || choice.id}`
      resizeInput($('#input'))
      sendMessage()
    })
    grid.appendChild(button)
  })
  target.appendChild(card)
  return card
}

function appendAction(action) {
  const node = state.run?.assistantNode
  if (!node || !action) return
  if (action.ui === 'quiz') renderQuiz(action, node.actions)
  if (action.ui === 'subject-choice') renderSubjectChoice(action, node.actions)
  scrollMessages()
}

function setComposerLoading(loading) {
  state.loading = loading
  $('#sendBtn').classList.toggle('hidden', loading)
  $('#cancelBtn').classList.toggle('hidden', !loading)
  $('#sendBtn').disabled = loading
  $('#attachBtn').disabled = loading
  $('#input').disabled = loading
}

function renderPendingImages() {
  const preview = $('#imagePreview')
  preview.innerHTML = ''
  preview.classList.toggle('hidden', !state.pendingImages.length)
  state.pendingImages.forEach((src, index) => {
    const item = document.createElement('div')
    item.className = 'image-preview-item'
    const image = document.createElement('img')
    image.src = src
    image.alt = `مرفق ${index + 1}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.setAttribute('aria-label', 'إزالة الصورة')
    remove.textContent = '×'
    remove.addEventListener('click', () => { state.pendingImages.splice(index, 1); renderPendingImages() })
    item.append(image, remove)
    preview.appendChild(item)
  })
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('IMAGE_READ_FAILED'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('IMAGE_READ_FAILED'))
      image.onload = () => {
        const maxSide = 1_280
        const ratio = Math.min(1, maxSide / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * ratio))
        canvas.height = Math.max(1, Math.round(image.height * ratio))
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      image.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

async function attachImages() {
  const input = $('#imageInput')
  const files = [...(input.files || [])]
  const room = Math.max(0, 4 - state.pendingImages.length)
  for (const file of files.slice(0, room)) {
    try { state.pendingImages.push(await compressImage(file)) } catch { toast('تعذّر قراءة إحدى الصور') }
  }
  input.value = ''
  renderPendingImages()
  if (files.length > room) toast('يمكن إرفاق أربع صور في الرسالة الواحدة')
}

function messageToView(message) {
  if (message.role === 'user') return appendUserMessage(message.content, message.images || [])
  if (message.role === 'assistant' && (message.content || (message.uiActions || []).length)) {
    const node = appendAssistantMessage()
    node.status.classList.add('hidden')
    node.bubble.innerHTML = message.content ? renderMarkdown(message.content) : ''
    ;(message.uiActions || []).forEach((action) => {
      if (action.ui === 'quiz') renderQuiz(action, node.actions)
      if (action.ui === 'subject-choice') renderSubjectChoice(action, node.actions)
    })
    ;(message.citations || []).forEach((citation) => {
      state.run = { assistantNode: node }
      addCitation(citation)
    })
    state.run = null
    return node.wrapper
  }
  return null
}

function renderConversation(conversation) {
  const messages = $('#messages')
  messages.innerHTML = ''
  $('#chatTitle').textContent = conversation?.title || 'محادثة جديدة'
  const visible = (conversation?.messages || []).filter((message) => !message.pending && (message.content || message.uiActions?.length))
  if (!visible.length) showEmptyChat()
  else visible.forEach(messageToView)
  scrollMessages()
}

function showEmptyChat() {
  const branch = Memory.settings.branch
  $('#messages').innerHTML = `<div class="empty-chat"><div class="empty-mark">م</div><span class="section-kicker">مساحتك جاهزة</span><h2>من أين نبدأ يا رحما؟</h2><p>اكتبي سؤالاً، أرفقي صورة، أو اطلبي مني أن أشرح لكِ درساً خطوة خطوة.</p>${branch ? `<span class="branch-badge">الفرع ${escapeHtml(branch)}</span>` : ''}</div>`
}

function setView(view) {
  state.view = view
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view))
  $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== `view-${view}`))
  if (view === 'history') renderHistory()
  if (view === 'progress') renderProgressView()
  if (view === 'exams') renderExams()
}

function renderHistory() {
  const list = $('#historyList')
  const conversations = Memory.searchConversations($('#historySearch').value)
  list.innerHTML = ''
  if (!conversations.length) { list.innerHTML = '<p class="empty-panel">لا توجد جلسات مطابقة بعد.</p>'; return }
  conversations.forEach((conversation) => {
    const item = document.createElement('article')
    item.className = 'history-item'
    const count = conversation.messages.filter((message) => message.role === 'user').length
    const date = new Date(conversation.updatedAt || conversation.createdAt).toLocaleDateString('ar-IQ', { day: 'numeric', month: 'short' })
    item.innerHTML = `<div class="history-icon">◌</div><div class="history-main"><strong>${escapeHtml(conversation.title)}</strong><span>${count} ${count === 1 ? 'رسالة' : 'رسائل'} · ${date}</span></div><button type="button" class="delete-button" aria-label="حذف المحادثة">×</button>`
    item.addEventListener('click', () => { Memory.setCurrent(conversation.id); renderConversation(conversation); setView('chat') })
    item.querySelector('.delete-button').addEventListener('click', (event) => { event.stopPropagation(); if (window.confirm('هل تريدين حذف هذه المحادثة؟')) { Memory.deleteConversation(conversation.id); renderHistory() } })
    list.appendChild(item)
  })
}

function renderProgressSummary() {
  const entries = Object.values(Memory.progress).flat().filter((entry) => entry.total)
  const average = entries.length ? Math.round(entries.reduce((sum, entry) => sum + (entry.score / entry.total) * 100, 0) / entries.length) : null
  $('#progressAverage').textContent = average == null ? '—' : `${average}%`
  $('#progressCount').textContent = String(entries.length)
  $('#progressSubjects').textContent = String(Object.keys(Memory.progress).filter((subject) => Memory.progress[subject]?.length).length)
}

function renderProgressView() {
  renderProgressSummary()
  Progress.render(Memory.progress, $('#progressCanvas'), $('#progressLegend'))
}

function renderExams() {
  const list = $('#examList')
  const exams = Memory.upcomingExams()
  list.innerHTML = ''
  if (!exams.length) { list.innerHTML = '<p class="empty-panel">لا توجد مواعيد قادمة. أضيفي أول موعد من الأعلى.</p>'; return }
  const today = new Date()
  exams.forEach((exam) => {
    const date = new Date(`${exam.date}T00:00:00`)
    const days = Math.ceil((date - new Date(today.toISOString().slice(0, 10))) / 86_400_000)
    const item = document.createElement('article')
    item.className = `exam-item ${days <= 3 ? 'soon' : ''}`
    item.innerHTML = `<span class="exam-icon">◷</span><div><strong>${escapeHtml(exam.title)}</strong><span>${date.toLocaleDateString('ar-IQ', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div><b>${days === 0 ? 'اليوم' : days === 1 ? 'غداً' : `بعد ${days} يوم`}</b><button type="button" class="delete-button" aria-label="حذف الموعد">×</button>`
    item.querySelector('.delete-button').addEventListener('click', () => { Memory.deleteExam(exam.id); renderExams(); scheduleReminders() })
    list.appendChild(item)
  })
}

function announceExam(exam) {
  toast(`تذكير: ${exam.title}`, 'success')
  if (window.Notification?.permission === 'granted') {
    try { new Notification('موعد دراسي', { body: exam.title, icon: '/icons/icon.svg' }) } catch { /* إشعار النظام اختياري */ }
  }
}

function scheduleReminders() {
  state.reminderTimers.forEach((timer) => clearTimeout(timer))
  state.reminderTimers = []
  const today = new Date().toISOString().slice(0, 10)
  for (const exam of Memory.upcomingExams()) {
    if (exam.date === today) { announceExam(exam); continue }
    const when = new Date(`${exam.date}T09:00:00`).getTime() - Date.now()
    if (when > 0 && when <= 2_147_483_647) state.reminderTimers.push(setTimeout(() => announceExam(exam), when))
  }
}

function friendlyError(error) {
  const code = String(error?.message || '')
  if (error?.name === 'AbortError') return 'أوقفتُ الرد. يمكنكِ الإرسال مرة أخرى متى شئتِ.'
  if (code === 'NO_KEY') return 'لا يوجد مفتاح مضبوط بعد. يمكنكِ إضافته من الإعدادات أو استخدام إعدادات الخادم.'
  if (code === 'TIMEOUT') return 'استغرق الاتصال وقتاً أطول من اللازم. أعيدي المحاولة وسأكمل معكِ.'
  if (code === 'STREAM_INTERRUPTED') return 'انقطع الاتصال أثناء الرد. أعيدي المحاولة، وستبقى رسالتكِ محفوظة.'
  if (code === 'HTTP_429' || code === 'rate_limit') return 'تعذر الاتصال بالمزوّد الآن. أعيدي المحاولة بعد لحظة.'
  if (/AGENT_RUNTIME_DEADLINE|TOO_MANY_TOOL|CONTEXT|UPSTREAM_ERROR/.test(code)) return 'احتاجت قراءة المرجع وقتاً أطول من المتاح. أعيدي المحاولة وسأتابع بخطوات أقصر.'
  if (navigator.onLine === false) return 'يبدو أن الاتصال بالإنترنت انقطع. تحققي منه ثم أعيدي الإرسال.'
  return 'تعذر إكمال هذه الجلسة. سياقكِ محفوظ ويمكنكِ إعادة المحاولة.'
}

function showRetry(message) {
  const node = state.run?.assistantNode
  if (!node) return
  node.bubble.innerHTML = `<div class="error-message"><span>!</span><p>${escapeHtml(message)}</p><button type="button" class="retry-button">إعادة المحاولة</button></div>`
  node.bubble.querySelector('.retry-button').addEventListener('click', () => {
    if (state.lastRequest) sendMessage(state.lastRequest)
  })
}

function applyEvent(event) {
  const data = event.data || {}
  if (!state.run) return
  if (event.event === 'run:start') { state.run.runId = data.runId; setAssistantStatus('أفهم سؤالك...'); return }
  if (event.event === 'stream:start') { state.run.streamStarted = true; setAssistantStatus('أرتب لكِ الشرح...', true); if (!state.run.text) state.run.assistantNode.bubble.innerHTML = ''; return }
  if (event.event === 'stream:delta' || event.event === 'delta') { state.run.text += String(data.content || ''); updateAssistantText(state.run.text); return }
  if (event.event === 'stream:reset') { state.run.text = ''; updateAssistantText(''); return }
  if (event.event === 'status') { setAssistantStatus(data.message || 'أراجع سؤالك...', true); return }
  if (event.event === 'tool:running') { setAssistantStatus(data.status || 'أبحث في الكتاب...', true); return }
  if (event.event === 'tool:completed') { setAssistantStatus('أكمل الشرح من المرجع...', true); return }
  if (event.event === 'tool:error') { setAssistantStatus(data.message || 'أحاول طريقة أخرى...', true); return }
  if (event.event === 'ui') { state.run.uiActions.push(data); appendAction(data); return }
  if (event.event === 'title') { if (data.title && Memory.setConversationTitle(state.run.convId, data.title)) $('#chatTitle').textContent = data.title; return }
  if (event.event === 'citation') { state.run.citations.push(data); addCitation(data); return }
  if (event.event === 'final') {
    state.run.text = String(data.content || state.run.text || '')
    state.run.citations = Array.isArray(data.citations) ? data.citations : state.run.citations
    if (!state.run.uiActions.length && Array.isArray(data.uiActions)) { state.run.uiActions = data.uiActions; data.uiActions.forEach(appendAction) }
    updateAssistantText(state.run.text)
    persistAssistant()
    setAssistantStatus('', false)
    return
  }
  if (event.event === 'error') { state.run.error = data.message || 'runtime_error'; showRetry(friendlyError(new Error(data.message))); return }
  if (event.event === 'run:cancelled') { state.run.cancelled = true; setAssistantStatus('أوقفتُ الرد.', false); return }
}

function persistAssistant() {
  if (!state.run) return
  Memory.updateMessage(state.run.convId, state.run.assistantIndex, { content: state.run.text, pending: false, citations: state.run.citations, uiActions: state.run.uiActions })
}

async function sendMessage(request = null) {
  if (state.loading) return
  const input = $('#input')
  const text = request?.text ?? input.value.trim()
  const images = request?.images ?? [...state.pendingImages]
  if (!text && !images.length) return
  const effectiveText = text || 'اشرحِي لي ما يظهر في الصور المرفقة.'
  input.value = ''
  state.pendingImages = []
  renderPendingImages()
  resizeInput(input)
  const conversation = currentConversation()
  const convId = conversation.id
  appendUserMessage(effectiveText, images)
  const node = appendAssistantMessage()
  Memory.addMessage(convId, 'user', effectiveText, { images: images.length ? images : undefined })
  const assistantIndex = Memory.currentConversation().messages.length
  Memory.addMessage(convId, 'assistant', '', { pending: true })
  state.lastRequest = { text, images }
  state.run = { convId, assistantIndex, assistantNode: node, text: '', citations: [], uiActions: [], controller: new AbortController(), error: null }
  $('#chatTitle').textContent = Memory.currentConversation().title
  setComposerLoading(true)
  setAssistantStatus('أفهم سؤالك...', true)
  scrollMessages()
  try {
    for await (const event of Teacher.stream(currentMessages(), { memory: Memory.getMemory(), branch: Memory.settings.branch, mode: 'normal', signal: state.run.controller.signal })) applyEvent(event)
    if (!state.run.error && !state.run.cancelled) persistAssistant()
  } catch (error) {
    if (error?.name === 'AbortError') { state.run.cancelled = true; setAssistantStatus('أوقفتُ الرد.', false) }
    else { state.run.error = error.message; showRetry(friendlyError(error)); persistAssistant() }
  } finally {
    if (state.run?.error && !state.run.text) persistAssistant()
    setComposerLoading(false)
    setAssistantStatus('', false)
    const completedConversation = Memory.getConversation(convId)
    if (completedConversation && completedConversation.messages.filter((message) => message.role === 'user').length % 8 === 0) {
      const transcript = completedConversation.messages.filter((message) => ['user', 'assistant'].includes(message.role) && !message.pending).map((message) => `${message.role === 'user' ? 'رحما' : 'المعلم'}: ${message.content}`).join('\n')
      void Memory.summarize(transcript).then(updateMemoryPreview)
    }
    renderHistory()
    updateMemoryPreview()
    state.loading = false
    state.run = null
  }
}

function cancelRun() { if (state.run?.controller) state.run.controller.abort() }

function resizeInput(input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px` }

function updateMemoryPreview() {
  const memory = Memory.getMemory()
  $('#memoryPreview').textContent = memory ? `${memory.split('\n')[0].slice(0, 96)}${memory.length > 96 ? '…' : ''}` : 'سأحفظ ما يفيدكِ في رحلتك الدراسية.'
}

function newConversation() { Memory.newConversation({ persist: false }); renderConversation(Memory.currentConversation()); setView('chat'); $('#input').focus() }

function setupWelcome() {
  let selected = Memory.settings.branch
  $$('.branch-card').forEach((button) => {
    if (button.dataset.branch === selected) button.classList.add('selected')
    button.addEventListener('click', () => { $$('.branch-card').forEach((item) => item.classList.remove('selected')); button.classList.add('selected'); selected = button.dataset.branch; $('#startBtn').disabled = false })
  })
  $('#startBtn').disabled = !selected
  $('#startBtn').addEventListener('click', () => { if (!selected) return; Memory.setSetting('branch', selected); enterApp() })
}

function enterApp() {
  $('#welcome').classList.add('hidden')
  $('#app').classList.remove('hidden')
  $('#branchLabel').textContent = Memory.settings.branch ? `الفرع ${Memory.settings.branch}` : 'فرع غير محدد'
  $('#settingsBranch').value = Memory.settings.branch
  updateMemoryPreview()
  renderConversation(currentConversation())
  renderHistory()
  renderExams()
  scheduleReminders()
  renderProgressSummary()
  Teacher.getConfig().then((config) => { $('#connLabel').textContent = config.hasKey ? 'جاهز لسماعك' : 'أضيفي مفتاحاً أو استخدمي الخادم'; $('#connectionDot')?.classList.toggle('warning', !config.hasKey) }).catch(() => {})
  loadCurriculum()
}

function validateEndpoint(value) {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
}

function openSettings() {
  $('#settingsApiKey').value = Memory.settings.apiKey || ''
  $('#settingsApiEndpoint').value = Memory.settings.apiEndpoint || ''
  $('#settingsApiModel').value = Memory.settings.apiModel || ''
  $('#settingsAdminToken').value = Memory.settings.curriculumAdminToken || ''
  $('#settingsBranch').value = Memory.settings.branch || ''
  $('#settingsModal').classList.remove('hidden')
  $('#settingsApiKey').focus()
}

function closeSettings() { $('#settingsModal').classList.add('hidden') }

async function loadCurriculum() {
  try {
    const response = await fetch('/api/curriculum', { cache: 'no-store', headers: Memory.getCurriculumHeaders() })
    const data = await response.json()
    const list = $('#curriculumList')
    list.innerHTML = ''
    if (!data.documents?.length) { $('#curriculumStatus').textContent = 'لا توجد ملفات مساعدة بعد.'; return }
    data.documents.forEach((document) => {
      const item = document.createElement('div')
      item.className = 'curriculum-item'
      item.innerHTML = `<span>${escapeHtml(document.name)}<small>${document.chunks} مقطع</small></span><button type="button" aria-label="حذف الملف">×</button>`
       item.querySelector('button').addEventListener('click', async () => { await fetch(`/api/curriculum?name=${encodeURIComponent(document.name)}`, { method: 'DELETE', headers: Memory.getCurriculumHeaders() }); loadCurriculum() })
      list.appendChild(item)
    })
  } catch { $('#curriculumStatus').textContent = 'تعذر تحميل الملفات المساعدة.' }
}

async function uploadCurriculum() {
  const file = $('#curriculumFile').files?.[0]
  if (!file) { toast('اختاري ملفاً أولاً'); return }
  const form = new FormData()
  form.append('file', file)
  $('#curriculumStatus').textContent = 'أستخرج النص وأبني الفهرس...'
  try {
    const response = await fetch('/api/curriculum', { method: 'POST', headers: Memory.getCurriculumHeaders(), body: form })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'UPLOAD_FAILED')
    $('#curriculumStatus').textContent = 'تمت فهرسة الملف بنجاح.'
    $('#curriculumFile').value = ''
    loadCurriculum()
    toast('صار الملف متاحاً للبحث', 'success')
  } catch (error) { $('#curriculumStatus').textContent = `تعذر الفهرسة: ${error.message}` }
}

function setupSettings() {
  $('#settingsBtn').addEventListener('click', openSettings)
  $('#settingsClose').addEventListener('click', closeSettings)
  $('#settingsCancel').addEventListener('click', closeSettings)
  $('#settingsModal').addEventListener('click', (event) => { if (event.target === $('#settingsModal')) closeSettings() })
  $('#uploadCurriculum').addEventListener('click', uploadCurriculum)
  $('#settingsSave').addEventListener('click', () => {
    const endpoint = $('#settingsApiEndpoint').value.trim()
    if (!validateEndpoint(endpoint)) { toast('استخدمي Endpoint يبدأ بـ HTTPS'); return }
    Memory.setSetting('branch', $('#settingsBranch').value)
    Memory.setSetting('apiKey', $('#settingsApiKey').value.trim())
    Memory.setSetting('apiEndpoint', endpoint)
    Memory.setSetting('apiModel', $('#settingsApiModel').value.trim())
    Memory.setSetting('curriculumAdminToken', $('#settingsAdminToken').value.trim())
    $('#branchLabel').textContent = Memory.settings.branch ? `الفرع ${Memory.settings.branch}` : 'فرع غير محدد'
    Teacher.getConfig(true).catch(() => {})
    closeSettings()
    toast('حُفظت إعداداتكِ على هذا الجهاز', 'success')
  })
}

function setupComposer() {
  const input = $('#input')
  $('#sendBtn').addEventListener('click', () => sendMessage())
  $('#cancelBtn').addEventListener('click', cancelRun)
  $('#attachBtn').addEventListener('click', () => $('#imageInput').click())
  $('#imageInput').addEventListener('change', attachImages)
  input.addEventListener('input', () => resizeInput(input))
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } })
  $$('.suggestion').forEach((button) => button.addEventListener('click', () => { input.value = button.dataset.chip === 'اختبار' ? 'حضّري لي اختباراً من الدرس الذي ندرسه' : button.dataset.chip === 'ملخص' ? 'لخّصي لي الفكرة التي شرحناها' : 'اصنعي لي خطة مذاكرة مناسبة'; input.focus(); resizeInput(input) }))
}

function setupNavigation() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)))
  $('#newChatBtn').addEventListener('click', newConversation)
  $('#historyNewBtn').addEventListener('click', newConversation)
  $('#historySearch').addEventListener('input', renderHistory)
  $('#examForm').addEventListener('submit', (event) => { event.preventDefault(); const title = $('#examTitle').value.trim(); const date = $('#examDate').value; if (!title || !date) return; Memory.addExam(title, date); $('#examTitle').value = ''; $('#examDate').value = ''; renderExams(); scheduleReminders(); toast('أضيف الموعد إلى قائمتكِ', 'success') })
  $('#clearMemoryBtn').addEventListener('click', () => { if (window.confirm('هل تريدين مسح الذاكرة الدراسية المحفوظة؟')) { Memory.clearMemory(); updateMemoryPreview(); toast('تم مسح الذاكرة', 'success') } })
}

function setupPwa() { if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') navigator.serviceWorker.register('/sw.js').catch(() => {}) }

function init() {
  setupWelcome(); setupComposer(); setupNavigation(); setupSettings(); setupPwa()
  if (Memory.settings.branch) enterApp()
  else { $('#welcome').classList.remove('hidden'); $('#app').classList.add('hidden') }
}

document.addEventListener('DOMContentLoaded', init)
