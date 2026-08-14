import test from 'node:test'
import assert from 'node:assert/strict'
import { estimatePromptTokens, fitContext, shouldCompactAt80Percent } from '../lib/context-budget.mjs'

test('estimates Arabic context and compacts before the usable window is full', () => {
  const tokens = estimatePromptTokens('ا'.repeat(2000))
  assert.ok(tokens > 800)
  assert.equal(shouldCompactAt80Percent({ promptTokens: 8000, windowTokens: 10000 }), true)
})

test('compaction preserves recent tool evidence and latest user message', () => {
  const messages = [{ role: 'system', content: 'تعليمات' }]
  for (let index = 0; index < 30; index += 1) messages.push({ role: 'user', content: `رسالة قديمة ${index} ${'س'.repeat(300)}` })
  messages.push({ role: 'tool', tool_call_id: 'current', content: JSON.stringify({ page: 41, evidence: 'الغضب' }) })
  messages.push({ role: 'user', content: 'السؤال الحالي' })
  const fitted = fitContext(messages, { windowTokens: 2500, reserveTokens: 500 })
  assert.equal(fitted.compacted, true)
  assert.ok(fitted.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'current'))
  assert.equal(fitted.messages.at(-1).content, 'السؤال الحالي')
})
