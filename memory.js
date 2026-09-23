/* ─────────────────────────────────────────────────────────────
   معلمي — وحدة الذاكرة المحلية
   - إعدادات الطالبة (الاسم، الفرع)
   - ملخص الذاكرة الدائمة (Memory Summary)
   - المحادثات (قائمة بالرسائل + العنوان + المادة)
   - مواعيد الاختبارات
   - نتائج الاختبارات (لتتبع التقدم)
   - التلخيص التلقائي عبر /api/summarize
   كل التخزين محلي في المتصفح (localStorage) — خصوصية كاملة.
   ───────────────────────────────────────────────────────────── */

const STORE = {
  settings: 'mualimi_settings',
  memory: 'mualimi_memory',
  conversations: 'mualimi_conversations_v2',
  exams: 'mualimi_exams',
  progress: 'mualimi_progress',
}

// المحادثات القديمة كانت تحفظ محادثات فارغة وبنية قديمة؛ ابدأ مخزنًا نظيفًا مرة واحدة.
try { localStorage.removeItem('mualimi_conversations') } catch {}

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE[key])
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
function save(key, val) {
  try {
    localStorage.setItem(STORE[key], JSON.stringify(val))
  } catch (e) {
    console.warn('تعذر الحفظ محليًا', e)
  }
}

function cleanHistoricalAssistantContent(content) {
  const text = String(content || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/gi, '')
    .trim()
  return text || 'تمت معالجة المرجع السابق.'
}

const DEFAULT_SETTINGS = {
  name: 'رحما',
  branch: '',
  apiKey: '',
  apiEndpoint: '',
  apiModel: 'MiMo-V2.6-Flash',
}

const Memory = {
  settings: { ...DEFAULT_SETTINGS, ...load('settings', {}), name: 'رحما' },
  memorySummary: load('memory', ''),
  conversations: load('conversations', []).map((conversation) => {
    const title = /^(كيفك|شلونك|اهلا|أهلا|مرحبا|مرحبًا|السلام عليكم)$/i.test(String(conversation.title || '').trim()) ? 'ترحيب وتعارف' : conversation.title
    const messages = Array.isArray(conversation.messages) ? conversation.messages.map((message) =>
      message.role === 'assistant' && /<tool_call>|<function=|<parameter=/i.test(message.content || '')
        ? { ...message, content: cleanHistoricalAssistantContent(message.content) }
        : message)
      : []
    return { ...conversation, title, messages }
  }),
  exams: load('exams', []),
  progress: load('progress', {}), // { مادة: [ {date, score, total} ] }

  persist() {
    save('settings', this.settings)
    save('memory', this.memorySummary)
    save('conversations', this.conversations)
    save('exams', this.exams)
    save('progress', this.progress)
  },

  /* ── الإعدادات ── */
  setSetting(key, val) {
    this.settings[key] = key === 'name' ? 'رحما' : val
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

  /* ── الذاكرة الدائمة ── */
  getMemory() {
    return this.memorySummary || ''
  },
  setMemory(summary) {
    this.memorySummary = (summary || '').trim()
    this.persist()
  },
  clearMemory() {
    this.memorySummary = ''
    this.persist()
  },

  /* ── المحادثات ── */
  getConversation(id) {
    return this.conversations.find((c) => c.id === id) || null
  },
  listConversations() {
    return [...this.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  },
  newConversation({ persist = true } = {}) {
    const c = {
      id: 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: 'محادثة جديدة',
      branch: this.settings.branch,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    if (persist) this.conversations.push(c)
    else this._draft = c
    if (persist) this.persist()
    return c
  },
  currentConversation() {
    if (this._draft) return this._draft
    if (!this._current || !this.getConversation(this._current.id)) {
      this._current = this.newConversation({ persist: false })
    }
    return this._current
  },
  setCurrent(id) {
    this._draft = null
    this._current = this.getConversation(id) || null
    return this._current
  },
  addMessage(convId, role, content, meta = {}) {
    const c = this.getConversation(convId) || (this._draft?.id === convId ? this._draft : null)
    if (!c) return null
    if (this._draft?.id === convId) {
      this.conversations.push(c)
      this._draft = null
    }
    c.messages.push({ role, content, at: Date.now(), ...meta })
    c.updatedAt = Date.now()
    if (c.title === 'محادثة جديدة' && role === 'user') {
      c.title = String(content || '').slice(0, 40)
    }
    this.persist()
    return c
  },
  setConversationTitle(id, title) {
    const conversation = this.getConversation(id)
    if (!conversation || !String(title || '').trim()) return false
    conversation.title = String(title).trim().slice(0, 100)
    conversation.updatedAt = Date.now()
    this.persist()
    return true
  },
  deleteConversation(id) {
    this.conversations = this.conversations.filter((c) => c.id !== id)
    if (this._current && this._current.id === id) this._current = null
    this.persist()
  },
  searchConversations(q) {
    q = (q || '').trim().toLowerCase()
    if (!q) return this.listConversations()
    return this.listConversations().filter((c) =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => (m.content || '').toLowerCase().includes(q))
    )
  },

  /* ── مواعيد الاختبارات ── */
  addExam(title, date) {
    this.exams.push({ id: 'ex_' + Date.now().toString(36), title, date, at: Date.now() })
    this.exams.sort((a, b) => (a.date < b.date ? -1 : 1))
    this.persist()
    return this.exams
  },
  deleteExam(id) {
    this.exams = this.exams.filter((e) => e.id !== id)
    this.persist()
  },
  upcomingExams() {
    const today = new Date().toISOString().slice(0, 10)
    return this.exams.filter((e) => e.date >= today)
  },

  /* ── نتائج الاختبارات (تتبع التقدم) ── */
  addTestResult(subject, score, total) {
    if (!this.progress[subject]) this.progress[subject] = []
    this.progress[subject].push({ date: new Date().toISOString().slice(0, 10), score, total })
    this.persist()
  },

  /* ── التلخيص التلقائي للذاكرة ── */
  async summarize(newInfo) {
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.getApiHeaders() },
        body: JSON.stringify({ memory: this.getMemory(), newInfo }),
      })
      if (res.status === 501) return false // لا مفتاح — لا تلخيص
      const json = await res.json()
      if (json.memory) {
        this.setMemory(json.memory)
        return true
      }
      return false
    } catch {
      return false
    }
  },
}

window.Memory = Memory
