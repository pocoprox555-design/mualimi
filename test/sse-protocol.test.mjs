import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeSseEvent, parseSseChunk } from '../lib/sse-protocol.mjs'

test('encodes named SSE events with JSON payloads', () => {
  const encoded = encodeSseEvent('status', { type: 'run_started' })
  assert.match(encoded, /event: status/)
  assert.match(encoded, /data: \{"type":"run_started"\}/)
})

test('parses multi-event SSE chunks and preserves names', () => {
  const source = [
    encodeSseEvent('status', { type: 'run_started' }),
    encodeSseEvent('delta', { content: 'مرحبا' }),
  ].join('')
  const { events, remainder } = parseSseChunk(source)
  assert.equal(remainder, '')
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'status')
  assert.equal(events[0].data.type, 'run_started')
  assert.equal(events[1].event, 'delta')
  assert.equal(events[1].data.content, 'مرحبا')
})
