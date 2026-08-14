/* ─────────────────────────────────────────────────────────────
   معلمي — تتبع التقدم
   يرسم أداء رحما في كل مادة عبر الوقت (من نتائج الاختبارات
   المحفوظة محليًا) باستخدام canvas — دون استدعاء النموذج.
   ───────────────────────────────────────────────────────────── */

;(function () {
  const PALETTE = ['#c9a24b', '#7fb3c9', '#9f8fca', '#7fbf7f', '#d98c8c', '#e0b96a']

  function render(data, canvas, legendEl) {
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 300
    const h = canvas.clientHeight || 260
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, w, h)
    legendEl.innerHTML = ''

    const subjects = Object.keys(data).filter((s) => Array.isArray(data[s]) && data[s].length)
    if (!subjects.length) {
      ctx.fillStyle = '#8b94a3'
      ctx.font = '15px Tajawal, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('لا توجد نتائج اختبارات بعد — أكملي أول اختبار لتظهر هنا.', w / 2, h / 2)
      return
    }

    const pad = { top: 24, right: 16, bottom: 34, left: 34 }
    const plotW = w - pad.left - pad.right
    const plotH = h - pad.top - pad.bottom

    // القيمة القصوى
    let max = 100
    subjects.forEach((s) => {
      data[s].forEach((p) => {
        if (p.total && p.score) max = Math.max(max, Math.round((p.score / p.total) * 100))
      })
    })
    max = Math.ceil(max / 10) * 10

    // شبكة + محاور
    ctx.strokeStyle = 'rgba(201,162,75,0.15)'
    ctx.fillStyle = '#8b94a3'
    ctx.font = '11px Tajawal, sans-serif'
    ctx.textAlign = 'right'
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + plotH - (plotH * i) / 4
      const val = Math.round((max * i) / 4)
      ctx.beginPath()
      ctx.moveTo(pad.left, y)
      ctx.lineTo(w - pad.right, y)
      ctx.stroke()
      ctx.fillText(String(val), pad.left - 6, y + 4)
    }

    let colorIndex = 0
    subjects.forEach((subject) => {
      const pts = data[subject]
      if (pts.length < 1) return
      const color = PALETTE[colorIndex++ % PALETTE.length]

      const xs = pts.map((_, i) => pad.left + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1)))
      const ys = pts.map((p) => {
        const pct = p.total ? Math.round((p.score / p.total) * 100) : p.score
        return pad.top + plotH - (Math.min(pct, max) / max) * plotH
      })

      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.lineJoin = 'round'
      ctx.beginPath()
      xs.forEach((x, i) => (i === 0 ? ctx.moveTo(x, ys[i]) : ctx.lineTo(x, ys[i])))
      ctx.stroke()

      // نقاط
      pts.forEach((p, i) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(xs[i], ys[i], 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#0e1a2e'
        ctx.lineWidth = 2
        ctx.stroke()
      })

      // وسيلة الإيضاح — اسم المادة يأتي من النموذج، لذا ندرجه كنص لا HTML.
      const chip = document.createElement('div')
      chip.className = 'legend-item'
      const swatch = document.createElement('i')
      swatch.style.background = color
      const label = document.createElement('span')
      label.textContent = subject
      chip.appendChild(swatch)
      chip.appendChild(label)
      legendEl.appendChild(chip)
    })
  }

  window.Progress = { render }
})()
