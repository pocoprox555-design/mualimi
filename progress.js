const PALETTE = ['#d69a58', '#3b9b9b', '#7b78b6', '#c66e72', '#6f9d72', '#9c7a55']

function render(data, canvas, legend) {
  if (!canvas || !legend) return
  const context = canvas.getContext('2d')
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth || 320
  const height = canvas.clientHeight || 270
  canvas.width = width * ratio
  canvas.height = height * ratio
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  legend.innerHTML = ''
  const subjects = Object.keys(data || {}).filter((subject) => Array.isArray(data[subject]) && data[subject].length)
  if (!subjects.length) {
    context.fillStyle = '#718395'
    context.font = '15px Tajawal, sans-serif'
    context.textAlign = 'center'
    context.fillText('ستظهر نتائجكِ هنا بعد أول اختبار.', width / 2, height / 2)
    return
  }
  const padding = { top: 24, right: 18, bottom: 34, left: 38 }
  const plotWidth = Math.max(40, width - padding.left - padding.right)
  const plotHeight = Math.max(40, height - padding.top - padding.bottom)
  const max = 100
  context.font = '11px Tajawal, sans-serif'
  context.textAlign = 'right'
  context.fillStyle = '#7890a1'
  context.strokeStyle = 'rgba(59, 155, 155, .16)'
  for (let step = 0; step <= 4; step += 1) {
    const y = padding.top + plotHeight - (plotHeight * step) / 4
    context.beginPath(); context.moveTo(padding.left, y); context.lineTo(width - padding.right, y); context.stroke()
    context.fillText(String(step * 25), padding.left - 8, y + 4)
  }
  subjects.forEach((subject, subjectIndex) => {
    const color = PALETTE[subjectIndex % PALETTE.length]
    const points = data[subject]
    const x = (index) => padding.left + (points.length === 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1))
    const y = (point) => padding.top + plotHeight - Math.max(0, Math.min(100, (point.score / Math.max(1, point.total)) * 100)) / 100 * plotHeight
    context.strokeStyle = color; context.lineWidth = 2.5; context.lineJoin = 'round'; context.beginPath()
    points.forEach((point, index) => index ? context.lineTo(x(index), y(point)) : context.moveTo(x(index), y(point)))
    context.stroke()
    points.forEach((point, index) => { context.fillStyle = color; context.beginPath(); context.arc(x(index), y(point), 4, 0, Math.PI * 2); context.fill() })
    const item = document.createElement('span')
    item.className = 'legend-item'
    const swatch = document.createElement('i')
    swatch.style.background = color
    const label = document.createElement('span')
    label.textContent = subject
    item.append(swatch, label)
    legend.appendChild(item)
  })
}

const Progress = { render }
export { Progress }
