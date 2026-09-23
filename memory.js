const STORE = {
  settings: 'mualimi_settings_v3',
  memory: 'mualimi_memory_v3',
  conversations: 'mualimi_conversations_v3',
  exams: 'mualimi_exams_v2',
  progress: 'mualimi_progress_v2',
}

const DEFAULT_SETTINGS = {
  name: 'رحما',
  branch: '',
  apiKey: '',
  apiEndpoint: '',
  apiModel: 'MiMo-V2.6-Flash',
  curriculumAdminToken: '',
}

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch { return fallback }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true } catch { return false }
}

function cleanProtocol(text) {
  const value = String(text || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/gi, '')
    .trim()
  return value
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null
  const role = ['user', 'assistant', 'tool'].includes(message.role) ? message.role : null
  if (!role) return null
  return {
    role,
    content: role === 'assistant' ? cleanProtocol(message.content) : String(message.content || ''),
    at: Number(message.at) || Date.now(),
    ...(Array.isArray(message.images) ? { images: message.images.slice(0, 4) } : {}),
    ...(Array.isArray(message.citations) ? { citations: message.citations } : {}),
    ...(Array.isArray(message.sources) ? { sources: message.sources } : {}),
    ...(Array.isArray(message.uiActions) ? { uiActions: message.uiActions } : {}),
    ...(message.toolName ? { toolName: String(message.toolName).slice(0, 100) } : {}),
    ...(message.pending ? { pending: true } : {}),
  }
}

function normalizeConversation(conversation) {
  if (!conversation || typeof conversation !== 'object') return null
  const messages = Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage).filter(Boolean) : []
  return {
    id: String(conversation.id || makeId('conv')),
    title: String(conversation.title || 'محادثة جديدة').slice(0, 100),
    branch: String(conversation.branch || ''),
    createdAt: Number(conversation.createdAt) || Date.now(),
    updatedAt: Number(conversation.updatedAt) || Date.now(),
    messages,
  }
}

function loadConversations() {
  const current = read(STORE.conversations, null)
  const legacy = read('mualimi_conversations_v2', null) || read('mualimi_conversations', [])
  const values = Array.isArray(current) ? current : Array.isArray(legacy) ? legacy : []
  return values.map(normalizeConversation).filter(Boolean)
}

const Memory = {
  settings: { ...DEFAULT_SETTINGS, ...read(STORE.settings, {}), name: 'رحما' },
  memorySummary: String(read(STORE.memory, '')),
  conversations: loadConversations(),
  exams: Array.isArray(read(STORE.exams, [])) ? read(STORE.exams, []) : [],
  progress: read(STORE.progress, {}) || {},
  _current: null,
  _draft: null,

  persist() {
    write(STORE.settings, this.settings)
    write(STORE.memory, this.memorySummary)
    write(STORE.conversations, this.conversations)
    write(STORE.exams, this.exams)
    write(STORE.progress, this.progress)
  },

  setSetting(key, value) {
    this.settings[key] = key === 'name' ? 'رحما' : String(value ?? '')
    this.persist()
  },

  getApiHeaders() {
    const headers = {}
    const key = String(this.settings.apiKey || '').trim()
    const endpoint = String(this.settings.apiEndpoint || '').trim()
    const model = String(this.settings.apiModel || '').trim()
    if (key) headers['X-AI-API-Key'] = key
    if (endpoint) headers['X-AI-Endpoint'] = endpoint
    if (model) headers['X-AI-Model'] = model
    return headers
  },

  getCurriculumHeaders() {
    const token = String(this.settings.curriculumAdminToken || '').trim()
    return token ? { Authorization: `Bearer ${token}` } : {}
  },

  getMemory() { return this.memorySummary || '' },
  setMemory(value) { this.memorySummary = String(value || '').trim(); this.persist() },
  clearMemory() { this.memorySummary = ''; this.persist() },

  getConversation(id) { return this.conversations.find((conversation) => conversation.id === id) || null },
  listConversations() { return [...this.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) },

  newConversation({ persist = true } = {}) {
    const now = Date.now()
    const conversation = { id: makeId('conv'), title: 'محادثة جديدة', branch: this.settings.branch, createdAt: now, updatedAt: now, messages: [] }
    if (persist) this.conversations.push(conversation)
    else this._draft = conversation
    if (persist) this.persist()
    return conversation
  },

  currentConversation() {
    if (this._draft) return this._draft
    if (!this._current || !this.getConversation(this._current.id)) this._current = this.newConversation({ persist: false })
    return this._current
  },

  setCurrent(id) {
    this._draft = null
    this._current = this.getConversation(id) || null
    return this._current
  },

  addMessage(conversationId, role, content, metadata = {}) {
    const conversation = this.getConversation(conversationId) || (this._draft?.id === conversationId ? this._draft : null)
    if (!conversation) return null
    if (this._draft?.id === conversationId) {
      this.conversations.push(conversation)
      this._draft = null
      this._current = conversation
    }
    const message = normalizeMessage({ role, content, ...metadata, at: Date.now() }) || { role, content: String(content || ''), at: Date.now() }
    conversation.messages.push(message)
    conversation.updatedAt = Date.now()
    if (conversation.title === 'محادثة جديدة' && role === 'user') {
      const label = String(content || '').replace(/\s+/g, ' ').trim()
      if (label) conversation.title = label.slice(0, 48)
    }
    this.persist()
    return message
  },

  updateMessage(conversationId, index, patch) {
    const conversation = this.getConversation(conversationId)
    if (!conversation?.messages[index]) return false
    conversation.messages[index] = normalizeMessage({ ...conversation.messages[index], ...patch }) || conversation.messages[index]
    conversation.updatedAt = Date.now()
    this.persist()
    return true
  },

  setConversationTitle(id, title) {
    const conversation = this.getConversation(id)
    const value = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 100)
    if (!conversation || !value) return false
    conversation.title = value
    conversation.updatedAt = Date.now()
    this.persist()
    return true
  },

  deleteConversation(id) {
    this.conversations = this.conversations.filter((conversation) => conversation.id !== id)
    if (this._current?.id === id) this._current = null
    this.persist()
  },

  searchConversations(query) {
    const value = String(query || '').trim().toLowerCase()
    if (!value) return this.listConversations()
    return this.listConversations().filter((conversation) => conversation.title.toLowerCase().includes(value) || conversation.messages.some((message) => String(message.content || '').toLowerCase().includes(value)))
  },

  addExam(title, date) {
    const exam = { id: makeId('exam'), title: String(title).trim().slice(0, 160), date: String(date), at: Date.now() }
    this.exams = [...this.exams.filter((item) => item.id !== exam.id), exam].sort((a, b) => a.date.localeCompare(b.date))
    this.persist()
    return exam
  },
  deleteExam(id) { this.exams = this.exams.filter((exam) => exam.id !== id); this.persist() },
  upcomingExams() { const today = new Date().toISOString().slice(0, 10); return this.exams.filter((exam) => exam.date >= today) },

  addTestResult(subject, score, total, source = {}) {
    const name = String(subject || 'غير محددة').trim() || 'غير محددة'
    if (!this.progress[name]) this.progress[name] = []
    this.progress[name].push({ date: new Date().toISOString().slice(0, 10), score: Number(score) || 0, total: Number(total) || 0, source: source.title ? String(source.title).slice(0, 120) : undefined })
    this.persist()
  },

  async summarize(newInfo, { signal } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90_000)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch('/api/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.getApiHeaders() }, body: JSON.stringify({ memory: this.getMemory(), newInfo }), signal: controller.signal })
      if (response.status === 501) return false
      if (!response.ok) return false
      const data = await response.json()
      if (!data.memory) return false
      this.setMemory(data.memory)
      return true
    } catch { return false } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  },
}

Memory.persist()
export { Memory }
