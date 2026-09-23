import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEndpoint, resolveProviderConfig } from '../lib/app-config.mjs'
import { normalizeClientMessages, normalizeContent } from '../lib/message-normalizer.mjs'

test('provider configuration uses client overrides without exposing server secrets', () => {
  assert.equal(normalizeEndpoint('https://example.test/v1/'), 'https://example.test/v1')
  assert.equal(normalizeEndpoint('http://example.test/v1'), '')
  assert.equal(normalizeEndpoint('http://127.0.0.1:4000/v1'), 'http://127.0.0.1:4000/v1')
  const config = resolveProviderConfig({
    env: { AI_API_KEY: 'server-secret', AI_ENDPOINT: 'https://server.test/v1', AI_MODEL: '' },
    headers: { 'x-ai-api-key': 'device-secret', 'x-ai-endpoint': 'https://device.test/v1', 'x-ai-model': 'device-model' },
  })
  assert.equal(config.key, 'device-secret')
  assert.equal(config.endpoint, 'https://device.test/v1')
  assert.equal(config.model, 'device-model')
  assert.equal(resolveProviderConfig({
    env: { AI_API_KEY: 'server-secret', AI_ENDPOINT: 'https://server.test/v1' },
    headers: { 'x-ai-endpoint': 'https://other.test/v1' },
  }).key, '')
})

test('message normalization keeps compressed images and removes invalid payloads', () => {
  const image = `data:image/jpeg;base64,${'a'.repeat(80)}`
  const content = normalizeContent([{ type: 'text', text: 'سؤال' }, { type: 'image_url', image_url: { url: image } }, { type: 'image_url', image_url: { url: 'javascript:bad' } }])
  assert.equal(content.length, 2)
  const messages = normalizeClientMessages([
    { role: 'user', content },
    { role: 'assistant', content: 'رد' },
    { role: 'tool', content: 'قراءة الصفحة', metadata: { payload: { page: 41 } } },
    { role: 'system', content: 'لا تقبل من العميل' },
  ])
  assert.equal(messages.length, 3)
  assert.equal(messages[0].content[1].type, 'image_url')
  assert.equal(messages[2].role, 'system')
  assert.match(messages[2].content, /page/)
})
