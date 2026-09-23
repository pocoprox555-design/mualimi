/* ─────────────────────────────────────────────────────────────
   معلمي — منطق التطبيق الرئيسي
   - شاشة الترحيب واختيار الفرع
   - الشات مع Streaming + عرض Markdown (جداول، قوائم، …)
   - التنقل بين: الشات / المحادثات / التقدم / المواعيد
   - مولّد الاختبارات + تتبع التقدم + الإشعارات
   - الإعدادات + PWA
   ───────────────────────────────────────────────────────────── */

;(function () {
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => Array.from(document.querySelectorAll(s))
  const state = {
    view: 'chat',
    loading: false,
    run: null,
    pendingImages: [], // صور مرفقة بانتظار الإرسال (data URLs)
  }

  function toast(msg, ok) {
    const el = $('#toast')
    el.textContent = msg
    el.className = 'toast show ' + (ok ? 'ok' : '')
    clearTimeout(el._t)
    el._t = setTimeout(() => (el.className = 'toast'), 2600)
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function inline(s) {
    let h = escapeHtml(s)
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    h = h.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
    h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return h
  }

  function parseTable(lines, start) {
    const rows = []
    let i = start
    while (i < lines.length && lines[i].includes('|')) {
      let raw = lines[i].split('|')
      if (raw.length && raw[0].trim() === '') raw.shift()
      if (raw.length && raw[raw.length - 1].trim() === '') raw.pop()
      const cells = raw.map((c) => c.trim())
      const isSep = cells.every((c) => /^:?-+:?$/.test(c)) && cells.some((c) => c.includes('-'))
      if (isSep) { i++; continue }
      rows.push(cells)
      i++
    }
    return { rows, next: i }
  }

  function renderMarkdown(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n')
    let html = ''
    let i = 0
    let inCode = false
    let codeBuf = []

    const flushList = (type, items) => {
      if (!items.length) return ''
      const tag = type === 'ul' ? 'ul' : 'ol'
      return '<' + tag + '>' + items.map((it) => '<li>' + inline(it) + '</li>').join('') + '</' + tag + '>'
    }

    while (i < lines.length) {
      const line = lines[i]

      if (/^\s*```/.test(line)) {
        if (inCode) {
          html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'
          codeBuf = []
          inCode = false
        } else {
          inCode = true
        }
        i++
        continue
      }
      if (inCode) { codeBuf.push(line); i++; continue }

      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const { rows, next } = parseTable(lines, i)
        if (rows.length) {
          const head = rows[0]
          const body = rows.slice(1)
          html += '<div class="table-wrap"><table><thead><tr>' +
            head.map((c) => '<th>' + inline(c) + '</th>').join('') +
            '</tr></thead><tbody>' +
            body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
            '</tbody></table></div>'
          i = next
          continue
        }
      }

      const h = line.match(/^\s*(#{1,3})\s+(.*)$/)
      if (h) {
        const lvl = h[1].length
        html += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'
        i++
        continue
      }

      if (/^\s*>\s?/.test(line)) {
        html += '<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'
        i++
        continue
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
          i++
        }
        html += flushList('ul', items)
        continue
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
          i++
        }
        html += flushList('ol', items)
        continue
      }

      if (/^\s*---+\s*$/.test(line)) { html += '<hr/>'; i++; continue }

      const t = line.trim()
      if (t) html += '<p>' + inline(t) + '</p>'
      i++
    }
    return html || '<p></p>'
  }

  const messagesEl = $('#messages')

  function appendUser(text, images = []) {
    const d = document.createElement('div')
    d.className = 'msg user'
    const imgsHtml = images.map((img) => '<img src="' + img + '" alt="صورة مرفقة" loading="lazy" />').join('')
    d.innerHTML = '<div class="bubble">' + inline(text).replace(/\n/g, '<br/>') + imgsHtml + '</div>'
    messagesEl.appendChild(d)
    return d
  }

  // ── إرفاق الصور ──────────────────────────────────────────────
  // يضغط الصورة إلى JPEG بحد أقصى 1280px قبل الإرسال حتى لا تتضخم
  // الطلبات، وتبقى الصفحات المصوّرة مقروءة للنموذج.
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const MAX_SIDE = 1280
          let { width, height } = img
          if (width > MAX_SIDE || height > MAX_SIDE) {
            const ratio = Math.min(MAX_SIDE / width, MAX_SIDE / height)
            width = Math.round(width * ratio)
            height = Math.round(height * ratio)
          }
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          canvas.getContext('2d').drawImage(img, 0, 0, width, height)
          resolve(canvas.toDataURL('image/jpeg', 0.82))
        }
        img.onerror = reject
        img.src = reader.result
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  function renderImagePreview() {
    const box = $('#imagePreview')
    if (!box) return
    if (!state.pendingImages.length) { box.classList.add('hidden'); box.innerHTML = ''; return }
    box.classList.remove('hidden')
    box.innerHTML = state.pendingImages.map((img, index) =>
      '<div class="image-preview-item"><img src="' + img + '" alt="مرفق" />' +
      '<button type="button" class="remove-image" data-index="' + index + '" title="إزالة">×</button></div>'
    ).join('')
    box.querySelectorAll('.remove-image').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pendingImages.splice(Number(btn.dataset.index), 1)
        renderImagePreview()
      })
    })
  }

  async function handleImageAttach() {
    const input = $('#imageInput')
    const files = Array.from(input.files || [])
    if (!files.length) return
    const room = Math.max(0, 4 - state.pendingImages.length)
    for (const file of files.slice(0, room)) {
      try {
        const dataUrl = await compressImage(file)
        state.pendingImages.push(dataUrl)
      } catch {
        toast('تعذر قراءة الصورة — جربي صورة أخرى')
      }
    }
    input.value = ''
    renderImagePreview()
    if (files.length > room) toast('يمكن إرفاق 4 صور كحد أقصى')
  }

  function appendAssistant() {
    const wrap = document.createElement('div')
    wrap.className = 'msg ai'
    const head = document.createElement('div')
    head.className = 'ai-head'
    head.innerHTML = '<span class="ai-badge">م</span><span>المعلم</span><span class="ai-robot" role="img" aria-label="المعلم يعمل"><i class="robot-eye eye-one"></i><i class="robot-eye eye-two"></i></span>'
    const body = document.createElement('div')
    body.className = 'bubble ai-bubble'
    body.innerHTML = '<span class="typing activity-label">المعلم يفكر في سؤالك…</span>'
    const meta = document.createElement('div')
    meta.className = 'msg-meta'
    const srcs = document.createElement('div')
    srcs.className = 'sources'
    wrap.appendChild(head)
    wrap.appendChild(body)
    wrap.appendChild(meta)
    wrap.appendChild(srcs)
    messagesEl.appendChild(wrap)
    return { wrap, body, meta, srcs, robot: head.querySelector('.ai-robot') }
  }

  function setAssistantActivity(active, label = 'المعلم يفكر في سؤالك…') {
    const node = state.run?.assistantNode
    if (!node) return
    node.wrap.classList.toggle('is-running', active)
    const activity = node.body.querySelector('.activity-label')
    if (activity && active) activity.textContent = label
    if (node.robot) node.robot.setAttribute('aria-label', active ? label : 'اكتمل الرد')
  }

  function appendTool(toolName, content) {
    const wrap = document.createElement('div')
    wrap.className = 'msg tool'
    wrap.innerHTML = '<div class="tool-row"><span class="tool-pill">' + escapeHtml(toolName) + '</span><div class="bubble tool-bubble">' + renderMarkdown(content) + '</div></div>'
    messagesEl.appendChild(wrap)
    return wrap
  }

  function appendStatus(text) {
    const row = document.createElement('div')
    row.className = 'status-row'
    row.textContent = text
    messagesEl.appendChild(row)
    return row
  }

  function appendInteractiveAction(action, target = messagesEl) {
    if (!action || !action.ui) return null
    const wrap = document.createElement('div')
    wrap.className = 'interactive-card'

    if (action.ui === 'subject-choice') {
      wrap.innerHTML = '<p class="interactive-question">' + escapeHtml(action.question || 'اختاري المادة التي تريدين الدراسة فيها.') + '</p><div class="subject-choice-grid"></div>'
      const grid = wrap.querySelector('.subject-choice-grid')
      for (const choice of Array.isArray(action.choices) ? action.choices : []) {
        const button = document.createElement('button')
        button.className = 'subject-choice'
        button.type = 'button'
        button.innerHTML = '<span class="subject-icon">' + escapeHtml(choice.icon || '📚') + '</span><span>' + escapeHtml(choice.title || choice.id) + '</span>'
        button.addEventListener('click', () => {
          if (state.loading || button.classList.contains('is-selected')) return
          button.classList.add('is-selected')
          button.disabled = true
          $('#input').value = 'أختار مادة ' + (choice.title || choice.id)
          autoResize($('#input'))
          sendMessage()
        })
        grid.appendChild(button)
      }
    } else if (action.ui === 'quiz') {
      wrap.innerHTML = '<div class="quiz-head"><strong>' + escapeHtml(action.title || 'اختبار') + '</strong><span>' + escapeHtml(action.subject || '') + '</span></div><div class="quiz-questions"></div><div class="quiz-score hidden"></div>'
      const list = wrap.querySelector('.quiz-questions')
      const questions = Array.isArray(action.questions) ? action.questions : []
      let answered = 0
      let score = 0
      for (const [index, question] of questions.entries()) {
        const item = document.createElement('section')
        item.className = 'quiz-question'
        item.innerHTML = '<div class="quiz-prompt"><b>' + (index + 1) + '.</b> ' + escapeHtml(question.prompt || '') + '</div><div class="quiz-options"></div><div class="quiz-explanation hidden"></div>'
        const options = item.querySelector('.quiz-options')
        const explanation = item.querySelector('.quiz-explanation')
        for (const [optionIndex, option] of (Array.isArray(question.options) ? question.options : []).entries()) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'quiz-option'
          button.textContent = option
          button.addEventListener('click', () => {
            if (item.dataset.answered) return
            item.dataset.answered = 'true'
            answered += 1
            const correct = optionIndex === Number(question.correctIndex)
            if (correct) score += 1
            options.querySelectorAll('button').forEach((candidate, candidateIndex) => {
              candidate.disabled = true
              if (candidateIndex === Number(question.correctIndex)) candidate.classList.add('is-correct')
            })
            if (!correct) button.classList.add('is-wrong')
            explanation.textContent = question.explanation || ''
            explanation.classList.remove('hidden')
            if (answered === questions.length) {
              const scoreEl = wrap.querySelector('.quiz-score')
              scoreEl.textContent = 'نتيجتك: ' + score + ' من ' + questions.length
              scoreEl.classList.remove('hidden')
              if (action.subject) Memory.addTestResult(action.subject, score, questions.length)
            }
          })
          options.appendChild(button)
        }
        list.appendChild(item)
      }
    } else return null
    target.appendChild(wrap)
    scrollChat()
    return wrap
  }

  function scrollChat() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function setSendState(loading) {
    state.loading = loading
    $('#sendBtn').disabled = loading
    $('#sendBtn').classList.toggle('hidden', loading)
    $('#cancelBtn').classList.toggle('hidden', !loading)
    if (!loading) $('#sendBtn').innerHTML = '➤'
  }

  function messageToPayload(message) {
    const images = Array.isArray(message.images) ? message.images : []
    const base = { role: message.role, content: message.content }
    if (message.metadata) base.metadata = message.metadata
    if (message.toolName) base.toolName = message.toolName
    if (message.role === 'user' && images.length) {
      // رسالة المستخدم مع صور: content array تدعمها واجهة Chat Completions
      // بصيغة { type: 'text', text } + { type: 'image_url', image_url: { url } }
      return { ...base, content: [{ type: 'text', text: message.content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
    }
    return base
  }

  function currentMessages() {
    const conv = Memory.currentConversation()
    return conv.messages.filter((m) => m.role !== 'system' && !m.pending).map(messageToPayload)
  }

  function updateRunningAssistant(text) {
    if (!state.run || !state.run.assistantNode) return
    state.run.assistantNode.body.innerHTML = text ? renderMarkdown(text) : '<span class="typing activity-label">المعلم يصوغ الإجابة…</span>'
    scrollChat()
  }

  function persistAssistantText(text) {
    if (!state.run) return
    const conv = Memory.getConversation(state.run.convId)
    if (!conv) return
    const msg = conv.messages[state.run.assistantIndex]
    if (!msg) return
    msg.content = text
    msg.citations = Array.isArray(state.run.citations) ? state.run.citations : []
    msg.uiActions = Array.isArray(state.run.uiActions) ? state.run.uiActions : []
    delete msg.pending
    conv.updatedAt = Date.now()
    Memory.persist()
  }

  function toolResultLabel(toolName, payload) {
    if (toolName === 'set_conversation_title') return 'تمت تسمية المحادثة.'
    if (toolName === 'list_materials') return 'تمت مراجعة المواد والكتب المتاحة.'
    if (toolName === 'inspect_book') return 'تم فحص بيانات الكتاب وخريطة صفحاته.'
    if (toolName === 'read_book_guide') return 'تمت قراءة دفعة من المرجع السريع للكتاب.'
    if (toolName === 'list_book_sections') return 'تمت مراجعة أقسام الكتاب.'
    if (toolName === 'open_page') return 'تمت قراءة الصفحة ' + (payload?.pageNumber || '') + '.'
    if (toolName === 'open_pages' || toolName === 'read_adjacent') return 'تمت قراءة الصفحات التي اختارها المعلم.'
    if (toolName === 'search_book') return 'تم البحث داخل مرجع المنهج.'
    if (toolName === 'list_pdf_books') return 'تمت مراجعة كتب PDF وفهارسها.'
    if (toolName === 'inspect_pdf_book') return 'تم فحص صفحات كتاب PDF.'
    if (toolName === 'search_pdf_books') return 'تم البحث داخل كتب PDF.'
    if (toolName === 'locate_pdf_page') return 'تم تحديد الصفحة المطبوعة داخل ملف PDF.'
    if (toolName === 'locate_pdf_pages') {
      const count = Array.isArray(payload?.mappings) ? payload.mappings.length : 0
      const missing = Array.isArray(payload?.notFound) ? payload.notFound.length : 0
      return 'تم تحديد ' + count + ' صفحة مطبوعة' + (missing ? ' (' + missing + ' غير موجودة)' : '') + '.'
    }
    if (toolName === 'open_pdf_pages_as_images') return 'تمت قراءة صفحات PDF بصرياً.'
    return 'اكتملت أداة ' + toolName + '.'
  }

  function appendToolResult(convId, toolName, payload, meta = {}) {
    const content = toolResultLabel(toolName, payload)
    const toolCallId = meta.toolCallId || null
    if (toolCallId && state.run?.persistedToolIds?.has(toolCallId)) return
    Memory.addMessage(convId, 'tool', content, {
      toolName,
      evidence: true,
      status: meta.status || 'ok',
      toolCallId,
      metadata: { ...(meta.metadata || {}), payload },
    })
    if (toolName === 'set_conversation_title' && payload?.title) {
      const conversation = Memory.getConversation(convId)
      if (conversation) {
        conversation.title = String(payload.title).trim().slice(0, 100) || 'محادثة دراسية'
        conversation.updatedAt = Date.now()
        Memory.persist()
        $('#chatTitle').textContent = conversation.title
      }
    }
    if (toolCallId) state.run?.persistedToolIds?.add(toolCallId)
    appendTool(toolName, content)
    if (payload?.ui) {
      appendInteractiveAction(payload)
      state.run?.uiActions?.push(payload)
    }
  }

  function applyEvent(event) {
    const kind = event.event || 'message'
    const data = event.data
    if (kind === 'status') {
      return
    }
    if (kind === 'run:start') {
      state.run.runId = data?.runId || null
      setAssistantActivity(true, 'المعلم يفكر في سؤالك…')
      appendStatus('بدأ المعلم فهم السؤال والتخطيط')
      return
    }
    if (kind === 'stream:start') {
      setAssistantActivity(true, 'المعلم يصوغ الإجابة…')
      updateRunningAssistant('')
      return
    }
    if (kind === 'stream:delta' || kind === 'delta') {
      state.run.text += String(data?.content || '')
      updateRunningAssistant(state.run.text)
      return
    }
    if (kind === 'stream:reset') {
      // الخادم سحب نصاً متدفقاً (إعادة محاولة أو tool call مباغت)
      state.run.text = ''
      updateRunningAssistant('')
      return
    }
    if (kind === 'tool:running' || kind === 'tool_call') {
      setAssistantActivity(true, data?.status || 'المعلم يبحث في المرجع…')
      appendStatus(data?.status || ('استخدام أداة: ' + (data?.name || 'tool')))
      return
    }
    if (kind === 'tool:completed' || kind === 'tool_result') {
      appendToolResult(state.run.convId, data?.name || 'tool', data?.result || {}, {
        toolCallId: data?.id || null,
        metadata: { source: 'tool_result' },
      })
      return
    }
    if (kind === 'tool:error') {
      appendStatus('تعذر استخدام أداة ' + (data?.name || ''))
      return
    }
    if (kind === 'citation') {
      const citation = data || {}
      state.run.citations.push(citation)
      const label = [citation.title, citation.pageNumber ? 'ص ' + citation.pageNumber : ''].filter(Boolean).join(' — ')
      if (label && state.run.assistantNode?.srcs) {
        const item = document.createElement('span')
        item.className = 'source'
        item.textContent = '📚 ' + label
        state.run.assistantNode.srcs.appendChild(item)
      }
      return
    }
    if (kind === 'error') {
      const text = data?.message || 'runtime_error'
      state.run.error = text
      setAssistantActivity(false)
      appendStatus('خطأ: ' + text)
      return
    }
    if (kind === 'final') {
      state.run.text = String(data?.content || state.run.text || '')
      updateRunningAssistant(state.run.text)
      persistAssistantText(state.run.text)
      setAssistantActivity(false)
      const finalTools = Array.isArray(data?.toolResults) ? data.toolResults : data?.toolEvents
      if (Array.isArray(finalTools) && finalTools.length) {
        for (const item of finalTools) {
          appendToolResult(state.run.convId, item.name || 'tool', item.result, {
            toolCallId: item.toolCallId || item.id,
            metadata: { source: 'final' },
          })
        }
      }
      if (!state.run.text.trim() && state.run.uiActions?.length) {
        state.run.assistantNode.body.classList.add('is-empty')
      }
      return
    }
  }

  async function cancelRun() {
    if (!state.run?.controller) return
    state.run.controller.abort()
    appendStatus('تم إيقاف المحادثة')
    setSendState(false)
  }

  async function sendMessage() {
    if (state.loading) return
    const input = $('#input')
    const text = input.value.trim()
    const images = [...state.pendingImages]
    if (!text && !images.length) return

    if (!Teacher.canSend()) {
      toast('مهلاً يا رحما — ثوانٍ فقط بين الرسائل 🙂')
      return
    }

    input.value = ''
    state.pendingImages = []
    renderImagePreview()
    autoResize(input)
    const conv = Memory.currentConversation()
    const mode = 'normal'

    // إذا أرفقت صورة بدون نص، أضف رسالة توضيحية تلقائياً.
    const effectiveText = text || 'اشرح لي هذه الصفحة لو سمحت'

    appendUser(effectiveText, images)
    const assistantNode = appendAssistant()
    $('#chatTitle').textContent = conv.title || 'محادثة جديدة'

    const convId = conv.id
    Memory.addMessage(convId, 'user', effectiveText, { source: 'composer', images: images.length ? images : undefined })
    const assistantIndex = conv.messages.length
    Memory.addMessage(convId, 'assistant', '', { pending: true, mode })

    let fallbackText = ''
    state.run = {
      controller: new AbortController(),
      convId,
      assistantIndex,
      assistantNode,
      text: '',
      persistedToolIds: new Set(),
      citations: [],
      uiActions: [],
      error: null,
    }
    setSendState(true)
    setAssistantActivity(true, 'المعلم يفكر في سؤالك…')
    scrollChat()

    try {
      const gen = Teacher.stream(text, {
        memory: Memory.getMemory(),
        branch: Memory.settings.branch,
        messages: currentMessages(),
        mode,
        signal: state.run.controller.signal,
      })
      for await (const event of gen) {
        applyEvent(event)
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        appendStatus('تم الإيقاف')
      } else if (e && e.message === 'NO_KEY') {
        fallbackText = 'لا يمكنني الرد الآن لأن مفتاح الذكاء الاصطناعي غير مضبوط. أضيفي مفتاح API من الإعدادات (⚙️) ثم أرسلي مجددًا 🔑'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      } else if (e && e.message === 'rate_limit') {
        fallbackText = 'أنا آسف يا رحما، وصلنا حد الطلبات لهذه اللحظة. حاولي بعد ثوانٍ قليلة 🌙'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      } else if (e && e.message === 'offline') {
        fallbackText = 'يبدو أن الإنترنت عندك انقطع. تأكدي من الاتصال ثم أرسلي مجددًا وسأكمل من حيث توقفنا.'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      } else if (e && e.message === 'server_busy') {
        fallbackText = 'الخادم مشغول الآن قليلًا. حاولي بعد لحظات وسأكون جاهزًا فورًا.'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      } else if (e && e.message === 'stream_interrupted') {
        if (!state.run?.text) {
          fallbackText = navigator.onLine === false
            ? 'انقطع الاتصال أثناء الرد. تأكدي من الإنترنت ثم أرسلي مجددًا.'
            : 'انقطع الرد مؤقتًا. أرسلي مجددًا وسأكمل من حيث توقفنا.'
          assistantNode.body.innerHTML = renderMarkdown(fallbackText)
        }
      } else if (e && /AGENT_RUNTIME_DEADLINE|TOO_MANY_TOOL_FAILURES|CONTEXT/i.test(e.message || '')) {
        fallbackText = 'احتاج المعلم لإعادة المحاولة بسبب طول العملية أو المرجع. أرسلي الرسالة مرة أخرى وسأكمل من سياق المحادثة.'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      } else {
        fallbackText = 'تعذر إكمال الرد هذه المرة. سياق المحادثة محفوظ، ويمكنك إعادة الإرسال دون فقدان الرسائل السابقة.'
        assistantNode.body.innerHTML = renderMarkdown(fallbackText)
      }
      console.warn(e)
    } finally {
      const savedConversation = Memory.getConversation(convId)
      const savedAssistant = savedConversation?.messages[state.run?.assistantIndex]
      if (savedAssistant?.pending) {
        savedAssistant.content = state.run?.text || fallbackText
        delete savedAssistant.pending
        Memory.persist()
      }
      setAssistantActivity(false)
      state.loading = false
      setSendState(false)
      updateMemoryPreview()
      renderHistory()
      maybeSummarize(conv)
      if (conv.messages.filter((message) => message.role === 'user').length === 1) void nameConversation(conv)
      state.run = null
    }
  }

  function maybeSummarize(conv) {
    const userMsgs = conv.messages.filter((m) => m.role === 'user').length
    if (userMsgs > 0 && userMsgs % 8 === 0) {
      const transcript = conv.messages
        .filter((m) => !m.pending && ['user', 'assistant'].includes(m.role))
        .map((m) => (m.role === 'user' ? 'رحما: ' : 'المعلم: ') + String(m.content || ''))
        .join('\n')
        .slice(-12000)
      Memory.summarize('احفظ سياق هذه المحادثة بدقة، بما فيه تفضيلات رحما، ما تم شرحه، ما لم يُحسم، والمواد أو الدروس المرتبطة بها. لا تخترع معلومات.\n' + transcript).then(() => updateMemoryPreview())
    }
  }

  async function nameConversation(conv) {
    const user = conv.messages.find((message) => message.role === 'user')
    const assistant = [...conv.messages].reverse().find((message) => message.role === 'assistant' && !message.pending)
    if (!user || !assistant?.content) return
    try {
      const response = await fetch('/api/conversation-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...Memory.getApiHeaders() },
        body: JSON.stringify({ user: user.content, assistant: assistant.content }),
      })
      if (!response.ok) return
      const data = await response.json()
      if (data.title && Memory.setConversationTitle(conv.id, data.title)) {
        if (Memory.currentConversation()?.id === conv.id) $('#chatTitle').textContent = data.title
        renderHistory()
      }
    } catch {}
  }

  function setupComposer() {
    const input = $('#input')
    const send = $('#sendBtn')
    send.addEventListener('click', sendMessage)
    $('#cancelBtn').addEventListener('click', cancelRun)
    const attachBtn = $('#attachBtn')
    if (attachBtn) attachBtn.addEventListener('click', () => $('#imageInput').click())
    const imageInput = $('#imageInput')
    if (imageInput) imageInput.addEventListener('change', handleImageAttach)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
    })
    input.addEventListener('input', () => autoResize(input))
    $$('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        const tag = c.dataset.chip
        input.value = tag === 'اختبار' ? 'جهزي لي اختبارًا قصيرًا في مادة ' : tag === 'جدول' ? 'اصنعي لي جدول مذاكرة أسبوعيًا لمواد ' : 'لخصي لي درس '
        input.focus()
        autoResize(input)
      })
    })
  }

  function autoResize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }

  function updateMemoryPreview() {
    const el = $('#memoryPreview')
    const mem = Memory.getMemory()
    if (mem) {
      const short = mem.split('\n')[0].slice(0, 90)
      el.textContent = short + (mem.length > 90 ? '…' : '')
    } else {
      el.textContent = 'لم أتعلم شيئًا بعد.'
    }
  }

  $('#clearMemoryBtn').addEventListener('click', () => {
    if (confirm('هل تريدين مسح ذاكرتي عنك بالكامل؟')) {
      Memory.clearMemory()
      updateMemoryPreview()
      toast('تم مسح الذاكرة ✅', true)
    }
  })

  function setupWelcome() {
    let chosen = ''
    const startBtn = $('#startBtn')
    $$('.branch-btn').forEach((b) => {
      b.addEventListener('click', () => {
        $$('.branch-btn').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
        chosen = b.dataset.branch
        startBtn.disabled = false
      })
    })
    startBtn.addEventListener('click', () => {
      if (!chosen) return
      Memory.setSetting('branch', chosen)
      enterApp()
    })
  }

  function enterApp() {
    $('#welcome').classList.add('hidden')
    $('#app').classList.remove('hidden')
    const name = 'رحما'
    $('#connLabel').textContent = 'جاهز'
    Teacher.getConfig().then((cfg) => {
      if (!cfg.hasKey) {
        $('#connLabel').textContent = 'المفتاح غير مضبوط'
      }
    }).catch(() => {})
    $('.user-chip').textContent = 'مرحبًا، ' + name
    $('#studentName').textContent = name
    updateMemoryPreview()
    renderHistory()
    renderExams()
    checkReminders()
  }

  function setupNav() {
    $$('.nav-btn').forEach((b) => {
      b.addEventListener('click', () => {
        $$('.nav-btn').forEach((x) => x.classList.remove('active'))
        b.classList.add('active')
        switchView(b.dataset.view)
      })
    })
  }

  function switchView(v) {
    state.view = v
    $('#view-chat').classList.toggle('hidden', v !== 'chat')
    $('#view-history').classList.toggle('hidden', v !== 'history')
    $('#view-progress').classList.toggle('hidden', v !== 'progress')
    $('#view-exams').classList.toggle('hidden', v !== 'exams')
    if (v === 'progress') renderProgress()
    if (v === 'history') renderHistory()
    if (v === 'exams') renderExams()
  }

  function renderHistory() {
    const list = $('#historyList')
    const q = ($('#historySearch').value || '').trim()
    const convs = Memory.searchConversations(q)
    if (!convs.length) {
      list.innerHTML = '<p class="empty">لا توجد محادثات بعد — ابدئي محادثة من الشات 💬</p>'
      return
    }
    list.innerHTML = convs.map((c) => {
      const n = c.messages.filter((m) => m.role === 'user').length
      const when = new Date(c.updatedAt || c.createdAt).toLocaleDateString('ar-IQ', { day: 'numeric', month: 'short' })
      return '<div class="history-item" data-id="' + c.id + '">' +
        '<div class="hi-main"><div class="hi-title">' + escapeHtml(c.title) + '</div>' +
        '<div class="hi-meta">' + n + ' رسالة · ' + when + '</div></div>' +
        '<button class="hi-del" data-id="' + c.id + '" title="حذف">🗑</button></div>'
    }).join('')

    list.querySelectorAll('.hi-del').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        if (confirm('حذف هذه المحادثة؟')) {
          Memory.deleteConversation(b.dataset.id)
          renderHistory()
        }
      })
    })
    list.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openConversation(el.dataset.id))
    })
  }

  function renderConversationMessage(message) {
    if (message.role === 'user') {
      appendUser(message.content, Array.isArray(message.images) ? message.images : [])
      return
    }
    if (message.role === 'assistant') {
      const ai = appendAssistant()
      ai.body.innerHTML = renderMarkdown(message.content || '')
      for (const action of Array.isArray(message.uiActions) ? message.uiActions : []) appendInteractiveAction(action, ai.wrap)
      if (Array.isArray(message.citations)) {
        for (const citation of message.citations) {
          const label = [citation.title, citation.pageNumber ? 'ص ' + citation.pageNumber : ''].filter(Boolean).join(' — ')
          if (!label) continue
          const item = document.createElement('span')
          item.className = 'source'
          item.textContent = '📚 ' + label
          ai.srcs.appendChild(item)
        }
      }
      return
    }
    if (message.role === 'tool') {
      appendTool(message.toolName || message.name || 'tool', message.content || '')
    }
  }

  function openConversation(id) {
    const conv = Memory.setCurrent(id)
    if (!conv) return
    messagesEl.innerHTML = ''
    $('#chatTitle').textContent = conv.title || 'محادثة جديدة'
    const msgs = conv.messages.filter((m) => m.role !== 'system')
    if (!msgs.length) {
      showChatEmpty()
      switchView('chat')
      scrollChat()
      return
    }
    msgs.forEach((m) => renderConversationMessage(m))
    switchView('chat')
    scrollChat()
  }

  function showChatEmpty() {
    const t = 'رحما'
    const branch = Memory.settings.branch || ''
    messagesEl.innerHTML =
      '<div class="chat-empty">' +
        '<div class="ce-logo">م</div>' +
        '<h2>أهلاً يا ' + escapeHtml(t) + ' 🌙</h2>' +
        '<p>أنا معلمك الذكي جاهز لمساعدتك. اسأليني عن أي درس، اطلبي اختبارًا، جدول مذاكرة، أو ملخصًا.</p>' +
        (branch ? '<span class="ce-branch">الفرع ' + escapeHtml(branch) + '</span>' : '') +
      '</div>'
  }

  function newChat() {
      Memory.newConversation({ persist: false })
    messagesEl.innerHTML = ''
    showChatEmpty()
    $('#chatTitle').textContent = 'محادثة جديدة'
    switchView('chat')
  }

  function renderProgress() {
    const canvas = $('#progressCanvas')
    const legend = $('#progressLegend')
    Progress.render(Memory.progress, canvas, legend)
  }

  function renderExams() {
    const list = $('#examList')
    const exams = Memory.upcomingExams()
    if (!exams.length) {
      list.innerHTML = '<p class="empty">لا مواعيد قادمة — أضيفي موعد اختبار أعلاه 📅</p>'
      return
    }
    const today = new Date().toISOString().slice(0, 10)
    list.innerHTML = exams.map((e) => {
      const days = Math.round((new Date(e.date) - new Date(today)) / 86400000)
      const badge = days === 0 ? 'اليوم' : days === 1 ? 'غدًا' : 'بعد ' + days + ' يوم'
      const soon = days <= 3 ? ' soon' : ''
      return '<div class="exam-item' + soon + '"><div class="ex-ico">📚</div>' +
        '<div class="ex-main"><div class="ex-title">' + escapeHtml(e.title) + '</div>' +
        '<div class="ex-date">' + new Date(e.date).toLocaleDateString('ar-IQ', { weekday: 'long', day: 'numeric', month: 'long' }) + '</div></div>' +
        '<span class="ex-days">' + badge + '</span>' +
        '<button class="hi-del" data-id="' + e.id + '" title="حذف">🗑</button></div>'
    }).join('')

    list.querySelectorAll('.hi-del').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        Memory.deleteExam(b.dataset.id)
        renderExams()
      })
    })
  }

  function setupExams() {
    $('#examForm').addEventListener('submit', (e) => {
      e.preventDefault()
      const title = $('#examTitle').value.trim()
      const date = $('#examDate').value
      if (!title || !date) return
      Memory.addExam(title, date)
      $('#examTitle').value = ''
      $('#examDate').value = ''
      renderExams()
      toast('تمت إضافة الموعد ✅', true)
      scheduleReminder(title, date)
    })
  }

  async function enableNotifications() {
    if (!('Notification' in window)) return
    try {
      if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission()
        if (p !== 'granted') return
      }
      const reg = await navigator.serviceWorker.ready
      reg.showNotification('المعلم جاهز يا رحما 🌙', {
        body: 'أنا هنا لمساعدتك في أي وقت. بالتوفيق في دراستك!',
        icon: 'icons/icon.svg',
        badge: 'icons/icon.svg',
        tag: 'ready',
      })
    } catch { /* تجاهل */ }
  }

  function showReminder(title) {
    if (Notification.permission === 'granted' && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_REMINDER',
        title: 'تذكير 📚',
        body: title,
      })
    } else {
      toast('⏰ تذكير: ' + title)
    }
  }

  function scheduleReminder(title, date) {
    const ms = new Date(date).getTime() - Date.now()
    // موعد اليوم (أو تاريخ مضى للتو): ذكّر فور فتح التطبيق بدل إهماله.
    if (ms < 0) {
      const isToday = date === new Date().toISOString().slice(0, 10)
      if (isToday) showReminder(title)
      return
    }
    setTimeout(() => showReminder(title), Math.min(ms, 2147483647))
  }

  function checkReminders() {
    const today = new Date().toISOString().slice(0, 10)
    Memory.exams.filter((e) => e.date === today).forEach((e) => {
      scheduleReminder(e.title, e.date)
    })
  }

  function setupSettings() {
    const gear = $('#settingsBtn')
    if (!gear) return
    const syncApiFields = () => {
      $('#settingsApiKey').value = Memory.settings.apiKey || ''
      $('#settingsApiEndpoint').value = Memory.settings.apiEndpoint || ''
      $('#settingsApiModel').value = Memory.settings.apiModel || ''
    }
    gear.addEventListener('click', () => {
      syncApiFields()
      $('#settingsModal').classList.remove('hidden')
    })
    $('#settingsClose').addEventListener('click', () => $('#settingsModal').classList.add('hidden'))
    $('#settingsName').value = 'رحما'
    $('#settingsBranch').value = Memory.settings.branch || ''
    syncApiFields()
    loadCurriculum()
    $('#uploadCurriculum').addEventListener('click', uploadCurriculum)
    $('#settingsSave').addEventListener('click', () => {
      const apiEndpoint = $('#settingsApiEndpoint').value.trim()
      if (apiEndpoint) {
        try {
          const parsed = new URL(apiEndpoint)
          const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
          if ((parsed.protocol !== 'https:' && !localHttp) || !parsed.host) throw new Error('INVALID_API_ENDPOINT')
        } catch {
          toast('رابط API غير صحيح — استخدمي رابط HTTPS صالحًا')
          return
        }
      }
      Memory.setSetting('name', 'رحما')
      Memory.setSetting('branch', $('#settingsBranch').value)
      Memory.setSetting('apiKey', $('#settingsApiKey').value.trim())
      Memory.setSetting('apiEndpoint', apiEndpoint)
      Memory.setSetting('apiModel', $('#settingsApiModel').value.trim())
      $('.user-chip').textContent = 'مرحبًا، ' + Memory.settings.name
      Teacher.getConfig(true).then((cfg) => {
        $('#connLabel').textContent = cfg.hasKey ? 'جاهز' : 'المفتاح غير مضبوط'
      }).catch(() => {})
      toast('تم حفظ الإعدادات ✅', true)
      $('#settingsModal').classList.add('hidden')
    })
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target === $('#settingsModal')) $('#settingsModal').classList.add('hidden')
    })
  }

  async function loadCurriculum() {
    const list = $('#curriculumList')
    if (!list) return
    try {
      const response = await fetch('/api/curriculum', { cache: 'no-store' })
      const data = await response.json()
      list.innerHTML = (data.documents || []).map((doc) =>
        '<div class="curriculum-item"><span>' + escapeHtml(doc.name) + '<small>' + doc.chunks + ' مقطع</small></span>' +
        '<button type="button" class="remove-book" data-name="' + encodeURIComponent(doc.name) + '" title="حذف">×</button></div>'
      ).join('') || '<span class="empty">لا توجد كتب مرفوعة بعد.</span>'
      list.querySelectorAll('.remove-book').forEach((button) => button.addEventListener('click', async () => {
        await fetch('/api/curriculum?name=' + button.dataset.name, { method: 'DELETE' })
        loadCurriculum()
      }))
    } catch {
      list.textContent = 'تعذر تحميل مكتبة المنهج.'
    }
  }

  async function uploadCurriculum() {
    const input = $('#curriculumFile')
    const status = $('#curriculumStatus')
    const file = input.files?.[0]
    if (!file) { toast('اختاري ملفًا أولًا'); return }
    status.textContent = 'جارٍ استخراج النص وفهرسة الكتاب…'
    const form = new FormData()
    form.append('file', file)
    try {
      const response = await fetch('/api/curriculum', { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'UPLOAD_FAILED')
      status.textContent = 'تمت فهرسة الكتاب بنجاح.'
      input.value = ''
      loadCurriculum()
      toast('تمت إضافة الكتاب إلى المعلم ✅', true)
    } catch (error) {
      status.textContent = error.message === 'NO_TEXT' ? 'هذا الملف لا يحتوي نصًا قابلًا للاستخراج. ملفات PDF المصورة تحتاج OCR.' : 'تعذر رفع الكتاب: ' + error.message
    }
  }

  function setupPWA() {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then((regs) => {
          regs.forEach((r) => r.unregister())
        }).catch(() => {})
      }
      if (window.caches) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {})
      }
      return
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }

  function init() {
    setupWelcome()
    setupNav()
    setupComposer()
    setupExams()
    setupSettings()
    setupPWA()

    $('#historySearch').addEventListener('input', renderHistory)
    $('#newChatBtn').addEventListener('click', newChat)
    $$('.view').forEach((v) => v.classList.add('hidden'))
    $('#view-chat').classList.remove('hidden')

    if (Memory.conversations.length && Memory.currentConversation()) {
      const cur = Memory.currentConversation()
      openConversation(cur.id)
    } else {
      showChatEmpty()
    }

    if (!Memory.settings.branch) {
      $('#welcome').classList.remove('hidden')
      $('#app').classList.add('hidden')
    } else {
      enterApp()
      window.setTimeout(() => enableNotifications(), 1500)
    }
  }

  document.addEventListener('DOMContentLoaded', init)
})()
