// تقييم نموذج على مسار الوكيل الحقيقي: نظام الأدوات + الاسترجاع + الصياغة.
// الاستخدام: node scripts/eval-model.mjs <model-name> ["سؤال اختياري"]
import path from 'node:path'
import process from 'node:process'
try { process.loadEnvFile(path.join(process.cwd(), '.env')) } catch {}

const { createCurriculumTools } = await import('../lib/curriculum-tools.mjs')
const { createProviderAdapter } = await import('../lib/provider-adapter.mjs')
const { AgentRunner } = await import('../lib/agent-runner.mjs')
const { buildSystemPrompt } = await import('../lib/agent-prompt.mjs')

const model = process.argv[2]
if (!model) { console.error('Usage: node scripts/eval-model.mjs <model> ["question"]'); process.exit(1) }
const question = process.argv[3] || 'اشرحيلي درس النهي عن الغضب من كتاب التربية الاسلامية للسادس الإعدادي'

const endpoint = String(process.env.AI_ENDPOINT || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '')
let key = String(process.env.AI_API_KEY || '').trim()
// يتوافق مع production-server.mjs و agent-http.mjs: يدعم base64 (b64:) أو نص عادي
if (key.startsWith('b64:')) key = Buffer.from(key.slice(4), 'base64').toString('utf8').trim()
if (!key) { console.error('AI_API_KEY missing'); process.exit(1) }

const systemPrompt = buildSystemPrompt({ branch: process.env.EVAL_BRANCH || 'غير محدد' })

const curriculum = createCurriculumTools()
const provider = createProviderAdapter({ endpoint, key, model })
const runner = new AgentRunner({
  provider,
  toolDefinitions: curriculum.definitions,
  toolHandlers: curriculum.handlers,
  maxOutputTokens: 3000,
  windowTokens: 120000,
  maxRuntimeMs: 120000,
})

const events = []
const writer = { emit: (e, d) => events.push({ e, d }), end: (e, d) => events.push({ e, d }) }
const started = Date.now()
try {
  const result = await runner.run({
    messages: [{ role: 'user', content: question }],
    systemPrompt,
    writer,
    openedCitations: curriculum.openedCitations,
  })
  const tools = events.filter((x) => x.e === 'tool:running').map((x) => x.d.name)
  const errors = events.filter((x) => x.e === 'tool:error' || (x.e === 'error')).map((x) => x.d?.message || x.d?.error)
  console.log(JSON.stringify({
    model,
    ok: true,
    seconds: Math.round((Date.now() - started) / 1000),
    toolCalls: tools,
    citations: [...curriculum.openedCitations.values()].map((c) => `${c.bookId}:${c.pageNumber}`),
    toolErrors: errors,
    finalLength: result.finalText.length,
    finalPreview: result.finalText.slice(0, 500),
  }, null, 2))
} catch (error) {
  console.log(JSON.stringify({ model, ok: false, error: error.message || String(error), seconds: Math.round((Date.now() - started) / 1000) }, null, 2))
}
