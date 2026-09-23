export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inline(value) {
  let html = escapeHtml(value)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>')
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  html = html.replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]+\)/gi, '$1')
  return html
}

function tableRows(lines, start) {
  const rows = []
  let index = start
  while (index < lines.length && lines[index].includes('|')) {
    const cells = lines[index].split('|').map((cell) => cell.trim()).filter((cell, cellIndex, all) => !(cellIndex === 0 && cell === '' && all.length > 1) && !(cellIndex === all.length - 1 && cell === '' && all.length > 1))
    if (!cells.length) break
    if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells)
    index += 1
  }
  return { rows, next: index }
}

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r/g, '').split('\n')
  let html = ''
  let index = 0
  let code = false
  let codeLines = []
  while (index < lines.length) {
    const line = lines[index]
    if (/^\s*```/.test(line)) {
      if (code) {
        html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`
        codeLines = []
        code = false
      } else code = true
      index += 1
      continue
    }
    if (code) { codeLines.push(line); index += 1; continue }

    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?(?:\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/.test(lines[index + 1])) {
      const table = tableRows(lines, index)
      if (table.rows.length) {
        const [head, ...body] = table.rows
        html += `<div class="table-scroll"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        index = table.next
        continue
      }
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      html += `<h${level}>${inline(heading[2])}</h${level}>`
      index += 1
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*[-*]\s+/, '')); index += 1 }
      html += `<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*\d+[.)]\s+/, '')); index += 1 }
      html += `<ol>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`
      continue
    }
    if (/^\s*>\s?/.test(line)) { html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`; index += 1; continue }
    if (/^\s*---+\s*$/.test(line)) { html += '<hr>'; index += 1; continue }
    if (line.trim()) html += `<p>${inline(line.trim())}</p>`
    index += 1
  }
  if (codeLines.length) html += `<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`
  return html || '<p></p>'
}
