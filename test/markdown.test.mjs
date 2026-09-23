import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../markdown.js'

test('markdown renderer supports Arabic headings, tables, lists, and escaped code', () => {
  const html = renderMarkdown('# عنوان\n\n- نقطة\n- أخرى\n\n| المادة | النتيجة |\n| --- | --- |\n| العربي | جيد |\n\n```js\nconst value = "<safe>"\n```')
  assert.match(html, /<h1>عنوان<\/h1>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<table>/)
  assert.match(html, /&lt;safe&gt;/)
})

test('markdown renderer does not create unsafe links or raw HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[رابط](javascript:alert(1))')
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /javascript:/)
})
