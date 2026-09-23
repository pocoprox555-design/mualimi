import test from 'node:test'
import assert from 'node:assert/strict'

test('local memory store preserves conversations, images, sources, and interactive cards', async () => {
  const values = new Map()
  globalThis.localStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }
  globalThis.window = globalThis
  const { Memory } = await import(`../memory.js?memory-test=${Date.now()}`)
  Memory.conversations = []
  Memory._current = null
  Memory._draft = null
  Memory.setSetting('branch', 'أدبي')
  const conversation = Memory.newConversation({ persist: false })
  Memory.addMessage(conversation.id, 'user', 'سؤال', { images: ['data:image/jpeg;base64,aaa'] })
  Memory.addMessage(conversation.id, 'assistant', 'شرح', { citations: [{ title: 'كتاب', pageNumber: 4 }], uiActions: [{ ui: 'quiz', questions: [] }] })
  const saved = Memory.getConversation(conversation.id)
  assert.equal(saved.messages[0].images.length, 1)
  assert.equal(saved.messages[1].citations[0].pageNumber, 4)
  assert.equal(saved.messages[1].uiActions[0].ui, 'quiz')
  assert.equal(Memory.searchConversations('سؤال').length, 1)
})
