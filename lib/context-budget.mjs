export function estimatePromptTokens(value) {
  if (Array.isArray(value)) {
    // مصفوفة رسائل (كائنات فيها role) أم مصفوفة أجزاء محتوى (فيها type)؟
    const isMessages = value.length > 0 && value.some((item) => item && typeof item === 'object' && 'role' in item)
    if (isMessages) {
      return value.reduce((total, message) => total + estimatePromptTokens(message?.content || ''), 0)
    }
    let total = 0
    for (const part of value) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'image_url') {
        // تقدير OpenAI المعتاد: صورة ≈ 1105 توكن
        total += 1105
      } else {
        total += estimatePromptTokens(part.text || '')
      }
    }
    return Math.max(1, total)
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value || '')
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length
  const otherChars = Math.max(0, text.length - arabicChars)
  return Math.max(1, Math.ceil(arabicChars / 2.2 + otherChars / 4))
}

export function shouldCompactAt80Percent({ promptTokens, windowTokens, reserveTokens = 0 }) {
  const usable = Math.max(1, Number(windowTokens || 0) - Number(reserveTokens || 0))
  return Number(promptTokens || 0) >= Math.floor(usable * 0.8)
}

function compactToolContent(content, maxChars = 1800) {
  const text = String(content || '')
  if (text.length <= maxChars) return text
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data)) {
      return JSON.stringify({ compacted: true, count: data.length, samples: data.slice(0, 2) }).slice(0, maxChars)
    }
    return JSON.stringify({ compacted: true, keys: Object.keys(data), preview: text.slice(0, 1200) }).slice(0, maxChars)
  } catch {
    return `${text.slice(0, maxChars)}\n[تم ضغط نتيجة أداة قديمة]`
  }
}

function contentToText(content, maxChars = 700) {
  if (Array.isArray(content)) {
    // رسالة متعددة الأجزاء (نص + صور): نحتفظ بالنص ونشير للصور دون data URLs
    const parts = content.map((part) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'image_url') return '[صورة مرفقة]'
      return String(part.text || '')
    }).filter(Boolean)
    return parts.join('\n').slice(0, maxChars)
  }
  return String(content || '').slice(0, maxChars)
}

export function compactConversation(messages, { keepRecent = 14 } = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length <= keepRecent + 2) return list.map((message) => ({ ...message }))
  const system = list.filter((message) => message.role === 'system').slice(0, 2)
  const nonSystem = list.filter((message) => message.role !== 'system')
  const recent = nonSystem.slice(-keepRecent)
  const old = nonSystem.slice(0, -keepRecent)
  const summary = old.map((message) => {
    const role = message.role || 'unknown'
    const content = role === 'tool' ? compactToolContent(message.content, 700) : contentToText(message.content, 700)
    return `${role}: ${content}`
  }).join('\n').slice(0, 12000)
  return [
    ...system,
    { role: 'system', content: `ملخص سياق قديم مضغوط آليًا، ولا يلغي الأدلة الحديثة:\n${summary}` },
    ...recent.map((message) => {
      if (message.role === 'tool') return { ...message, content: compactToolContent(message.content) }
      // الرسائل الحديثة مع صور: نبقي الصور كما هي (دليل حديث مهم)
      return { ...message }
    }),
  ]
}

export function fitContext(messages, { windowTokens, reserveTokens }) {
  let fitted = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : []
  let promptTokens = estimatePromptTokens(fitted)
  if (!shouldCompactAt80Percent({ promptTokens, windowTokens, reserveTokens })) return { messages: fitted, promptTokens, compacted: false }
  fitted = compactConversation(fitted)
  promptTokens = estimatePromptTokens(fitted)
  if (promptTokens + reserveTokens > windowTokens) {
    fitted = compactConversation(fitted, { keepRecent: 8 })
    promptTokens = estimatePromptTokens(fitted)
  }
  return { messages: fitted, promptTokens, compacted: true }
}
