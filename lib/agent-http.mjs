import { timingSafeEqual } from 'node:crypto'
import formidable from 'formidable'
import { addDocument, clearDocumentFile, listDocuments, removeDocument, MAX_FILE_BYTES } from '../curriculum.mjs'
import { listBooks, listMaterials, listBookSections, inspectBook, openAdjacentPages, openPage, readBookGuide, searchLibrary } from './curriculum-library.mjs'
import { createCurriculumTools } from './curriculum-tools.mjs'
import { createProviderAdapter } from './provider-adapter.mjs'
import { AgentRunner } from './agent-runner.mjs'
import { buildSystemPrompt } from './agent-prompt.mjs'
import { normalizeClientMessages } from './message-normalizer.mjs'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, publicProviderConfig, resolveProviderConfig } from './app-config.mjs'
import { createSseWriter } from './sse-protocol.mjs'

const JSON_BODY_LIMIT = 32 * 1024 * 1024
const MAX_MEMORY_CHARS = 24_000

function sendJson(res, status, data) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function sanitize(value, maxLength = 4_000) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r/g, ' ').trim().slice(0, maxLength)
}

async function parseJsonBody(req, maxBytes = JSON_BODY_LIMIT) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > maxBytes) throw new Error('REQUEST_TOO_LARGE')
  }
  try { return JSON.parse(body || '{}') } catch { throw new Error('INVALID_JSON') }
}

function publicError(error) {
  const code = String(error?.message || error || 'BAD_REQUEST')
  if (/^UPSTREAM_HTTP_/.test(code)) return 'UPSTREAM_ERROR'
  if (/API_KEY|NO_KEY/.test(code)) return 'NO_KEY'
  return sanitize(code, 160) || 'BAD_REQUEST'
}

function timeoutSignal(parent, milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), milliseconds)
  const onAbort = () => controller.abort()
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort) } }
}

function parseAdminToken(value) { return String(value || '').replace(/^Bearer\s+/i, '').trim() }

export function installAgentHttp(app, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) }
  const configuredAdminToken = () => String(env.CURRICULUM_ADMIN_TOKEN || '').trim()
  const canManage = (req) => {
    const expected = configuredAdminToken()
    if (!expected) return env.NODE_ENV !== 'production'
    const supplied = parseAdminToken(req.headers.authorization || req.headers['x-curriculum-admin-token'])
    const expectedBuffer = Buffer.from(expected)
    const suppliedBuffer = Buffer.from(supplied)
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
  }
  const providerFor = (req) => resolveProviderConfig({ env, headers: req.headers })

  app.use(async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost')
    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const config = providerFor(req)
        if (config.error) { sendJson(res, 400, { error: config.error }); return }
        sendJson(res, 200, { ...publicProviderConfig(config), materials: await listMaterials(), curriculum: await listDocuments() })
        return
      }

      if (url.pathname === '/api/library/books' && req.method === 'GET') { sendJson(res, 200, { books: await listBooks() }); return }
      if (url.pathname === '/api/library/inspect' && req.method === 'GET') {
        sendJson(res, 200, await inspectBook(sanitize(url.searchParams.get('bookId'), 80)))
        return
      }
      if (url.pathname === '/api/library/guide' && req.method === 'GET') {
        sendJson(res, 200, await readBookGuide(sanitize(url.searchParams.get('bookId'), 80), { cursor: Number(url.searchParams.get('cursor')) || 0, limit: Number(url.searchParams.get('limit')) || 24 }))
        return
      }
      if (url.pathname === '/api/library/sections' && req.method === 'GET') {
        sendJson(res, 200, await listBookSections(sanitize(url.searchParams.get('bookId'), 80)))
        return
      }
      if (url.pathname === '/api/library/search' && req.method === 'GET') {
        const query = sanitize(url.searchParams.get('q'), 800)
        if (!query) { sendJson(res, 400, { error: 'QUERY_REQUIRED' }); return }
        const results = await searchLibrary(query, { bookId: sanitize(url.searchParams.get('bookId'), 80) || null, subject: sanitize(url.searchParams.get('subject'), 120) || null, limit: Math.min(20, Number(url.searchParams.get('limit')) || 8) })
        sendJson(res, 200, { results: results.map(({ content, ...result }) => result) })
        return
      }
      if (url.pathname === '/api/library/page' && req.method === 'GET') {
        const bookId = sanitize(url.searchParams.get('bookId'), 80)
        const page = Number(url.searchParams.get('page'))
        const radius = Math.min(5, Math.max(0, Number(url.searchParams.get('radius')) || 0))
        sendJson(res, 200, { pages: radius ? await openAdjacentPages(bookId, page, radius) : [await openPage(bookId, page)] })
        return
      }

      if (url.pathname === '/api/curriculum' && req.method === 'GET') { sendJson(res, 200, { documents: await listDocuments() }); return }
      if (url.pathname === '/api/curriculum' && ['POST', 'DELETE'].includes(req.method) && !canManage(req)) { sendJson(res, 403, { error: 'ADMIN_REQUIRED' }); return }
      if (url.pathname === '/api/curriculum' && req.method === 'DELETE') {
        const name = sanitize(url.searchParams.get('name'), 180)
        if (name) await removeDocument(name)
        sendJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/api/curriculum' && req.method === 'POST') {
        let temporaryPath = ''
        try {
          const files = await new Promise((resolve, reject) => formidable({ maxFileSize: MAX_FILE_BYTES, multiples: false }).parse(req, (error, fields, parsed) => error ? reject(error) : resolve({ fields, files: parsed })))
          const uploaded = files.files.file?.[0] || files.files.file
          if (!uploaded) throw new Error('NO_FILE')
          temporaryPath = uploaded.filepath
          const document = await addDocument({ filePath: temporaryPath, originalName: uploaded.originalFilename || 'material', mime: uploaded.mimetype || 'application/octet-stream' })
          sendJson(res, 200, { ok: true, document })
        } catch (error) {
          sendJson(res, error?.code === 1009 ? 413 : 400, { error: publicError(error) })
        } finally {
          if (temporaryPath) await clearDocumentFile(temporaryPath)
        }
        return
      }

      if (url.pathname === '/api/summarize' && req.method === 'POST') {
        const config = providerFor(req)
        if (config.error) { sendJson(res, 400, { error: config.error }); return }
        if (!config.key) { sendJson(res, 501, { code: 'NO_KEY' }); return }
        const data = await parseJsonBody(req, 128 * 1024)
        const timeout = timeoutSignal(null, 90_000)
        try {
          const provider = createProviderAdapter(config)
          const result = await provider.requestStructuredTurn({
            messages: [
              { role: 'system', content: 'أخرج JSON صالحاً فقط بالشكل {"final":"..."}. لخّص ذاكرة رحما الدراسية مع الحفاظ على الحقائق والتفضيلات والمواضيع والأسئلة غير المكتملة دون اختلاق.' },
              { role: 'user', content: `الذاكرة الحالية:\n${sanitize(data.memory, 10_000)}\n\nالمعلومات الجديدة:\n${sanitize(data.newInfo, 18_000)}` },
            ],
            toolNames: [], maxTokens: 1_000, signal: timeout.signal,
          })
          sendJson(res, 200, { memory: sanitize(result.action?.content || '', 20_000) })
        } finally { timeout.cleanup() }
        return
      }

      if (url.pathname === '/api/conversation-title' && req.method === 'POST') {
        const config = providerFor(req)
        if (config.error) { sendJson(res, 400, { error: config.error }); return }
        if (!config.key) { sendJson(res, 501, { code: 'NO_KEY' }); return }
        const data = await parseJsonBody(req, 128 * 1024)
        const timeout = timeoutSignal(null, 60_000)
        try {
          const provider = createProviderAdapter(config)
          const result = await provider.requestStructuredTurn({
            messages: [
              { role: 'system', content: 'أخرج JSON صالحاً فقط بالشكل {"final":"عنوان"}. اختر عنواناً عربياً وصفياً قصيراً من كلمتين إلى ست كلمات، ولا تنسخ رسالة رحما.' },
              { role: 'user', content: `رسالة رحما:\n${sanitize(data.user, 7_000)}\n\nرد المعلم:\n${sanitize(data.assistant, 10_000)}` },
            ],
            toolNames: [], maxTokens: 120, signal: timeout.signal,
          })
          let title = result.action?.content || ''
          try { title = JSON.parse(title).title || JSON.parse(title).final || title } catch { /* النموذج قد يعيد النص داخل final */ }
          sendJson(res, 200, { title: sanitize(title, 100) || 'محادثة دراسية' })
        } finally { timeout.cleanup() }
        return
      }

      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const config = providerFor(req)
        if (config.error) { sendJson(res, 400, { error: config.error }); return }
        if (!config.key) { sendJson(res, 501, { code: 'NO_KEY' }); return }
        const data = await parseJsonBody(req)
        const messages = normalizeClientMessages(data.messages)
        if (!messages.length || !messages.some((message) => message.role === 'user')) { sendJson(res, 400, { error: 'EMPTY_MESSAGES' }); return }

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders?.()
        const writer = createSseWriter(res)
        const requestAbort = new AbortController()
        const abortRequest = () => { if (!res.writableEnded) requestAbort.abort() }
        req.on('aborted', abortRequest)
        res.on('close', abortRequest)
        const curriculum = createCurriculumTools()
        const runner = new AgentRunner({
          provider: createProviderAdapter(config),
          toolDefinitions: curriculum.definitions,
          toolHandlers: curriculum.handlers,
          maxOutputTokens: Math.max(2_000, config.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS),
          windowTokens: Math.max(16_000, config.contextWindow || DEFAULT_CONTEXT_WINDOW),
          maxRuntimeMs: Number(env.AI_AGENT_TIMEOUT_MS) || 300_000,
        })
        try {
          const result = await runner.run({
            messages,
            systemPrompt: buildSystemPrompt({ memory: sanitize(data.memory, MAX_MEMORY_CHARS), branch: sanitize(data.branch, 80) }),
            signal: requestAbort.signal,
            writer,
            openedCitations: curriculum.openedCitations,
          })
          if (!writer.closed) writer.end('run:done', { runId: result.runId, ok: true })
        } catch (error) {
          if (error?.name === 'AbortError') writer.end('run:cancelled', { ok: false })
          else writer.end('error', { type: 'runtime_error', message: publicError(error) })
        } finally {
          req.off?.('aborted', abortRequest)
          res.off?.('close', abortRequest)
        }
        return
      }

      if (next) next()
      else sendJson(res, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) createSseWriter(res).end('error', { type: 'http_error', message: publicError(error) })
      } else sendJson(res, error.message === 'REQUEST_TOO_LARGE' ? 413 : 400, { error: publicError(error) })
    }
  })
}
