'use strict'
// Lines of code and spent tokens of the project as grouped bars inside Orbit's quota window. Orbit posts the data
// ({ type: 'orbit-skill:data', stats }, electron/project-stats.mts); the page buckets it by day (by hours when the
// history is shorter than four days, by weeks when it is long) and draws an SVG. Tokens are summed per bucket, lines
// are the count at the end of the bucket.
;(() => {
  const query = new URLSearchParams(location.search)
  const daysParam = Number(query.get('days'))
  const DAYS = Number.isFinite(daysParam) && daysParam >= 0 ? daysParam : 30
  const HOUR = 3600e3, DAY = 86400e3
  const SERIES = [
    { key: 'tokens', label: 'Токены', color: '#3987e5' },
    { key: 'lines', label: 'Строки кода', color: '#d95926' },
  ]
  const exact = new Intl.NumberFormat('ru-RU')
  const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 })
  const $ = id => document.getElementById(id)
  const saved = (key, fallback, allowed) => { try { const value = localStorage.getItem(`chart.${key}`); return allowed.includes(value) ? value : fallback } catch { return fallback } }
  const save = (key, value) => { try { localStorage.setItem(`chart.${key}`, value) } catch { /* no storage: this view only */ } }
  let view = saved('view', 'both', ['tokens', 'lines', 'both'])
  let scale = saved('scale', 'auto', ['auto', 'linear', 'log', 'index'])
  let stats = null

  const startOf = (time, size) => {
    const date = new Date(time)
    if (size < DAY) { date.setMinutes(0, 0, 0); date.setHours(date.getHours() - (date.getHours() % (size / HOUR))); return date.getTime() }
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  // The buckets of the shown period with each series' value, or null without any data.
  function bucketize(data) {
    const now = Date.now()
    const points = [...data.tokens, ...data.lines]
    if (!points.length) return null
    const first = Math.min(...points.map(point => point.at))
    const from = DAYS > 0 ? Math.max(first, now - DAYS * DAY) : first
    const span = Math.max(HOUR, now - from)
    let size = span < 4 * DAY ? HOUR : DAY
    if (size === HOUR && span / HOUR > 48) size = 3 * HOUR
    if (size === DAY && span / DAY > 60) size = 7 * DAY
    const buckets = []
    for (let start = startOf(from, size); start <= now; start += size) buckets.push({ start, end: start + size, tokens: 0, lines: null, size })
    const lines = [...data.lines].sort((a, b) => a.at - b.at)
    for (const point of data.tokens) {
      const bucket = buckets.find(item => point.at >= item.start && point.at < item.end)
      if (bucket) bucket.tokens += point.value
    }
    let index = 0, last = null
    for (const bucket of buckets) {
      while (index < lines.length && lines[index].at < bucket.end) last = lines[index++].value
      bucket.lines = last
    }
    return { buckets, from, size }
  }

  const bucketLabel = (bucket, long) => {
    const date = new Date(bucket.start)
    const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')
    if (bucket.size >= 7 * DAY) return long ? `неделя с ${day}` : day
    if (bucket.size >= DAY) return day
    const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    return long || date.getHours() < bucket.size / HOUR ? `${day}, ${time}` : time
  }
  const niceStep = (max, count) => {
    const raw = max / count, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power
  }
  // y(value) for the chosen scale, the ticks to label, and the bottom the bars grow from.
  function axis(mode, values) {
    const positive = values.filter(value => value > 0)
    const max = Math.max(0, ...values)
    if (mode === 'index') return { mode, lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100], label: value => `${value}%` }
    if (mode === 'log' && positive.length) {
      const lo = 10 ** Math.floor(Math.log10(Math.min(...positive)))
      let hi = 10 ** Math.ceil(Math.log10(max))
      if (hi <= lo) hi = lo * 10
      const decades = Math.round(Math.log10(hi / lo)), every = Math.ceil(decades / 6)
      const ticks = []
      for (let power = 0; power <= decades; power += every) ticks.push(lo * 10 ** power)
      return { mode, lo, hi, ticks, label: value => compact.format(value) }
    }
    const step = niceStep(max || 1, 4), hi = Math.ceil((max || 1) / step) * step
    const ticks = []
    for (let value = 0; value <= hi + step / 2; value += step) ticks.push(value)
    return { mode: 'linear', lo: 0, hi, ticks, label: value => compact.format(value) }
  }
  const position = (scaleInfo, value, top, bottom) => {
    if (scaleInfo.mode === 'log') {
      if (!(value > 0)) return bottom
      const share = (Math.log10(value) - Math.log10(scaleInfo.lo)) / (Math.log10(scaleInfo.hi) - Math.log10(scaleInfo.lo))
      return bottom - Math.max(0, Math.min(1, share)) * (bottom - top)
    }
    return bottom - Math.max(0, Math.min(1, (value - scaleInfo.lo) / (scaleInfo.hi - scaleInfo.lo))) * (bottom - top)
  }
  // A bar with rounded top corners standing on the baseline.
  const barPath = (x, y, width, bottom) => {
    const radius = Math.min(4, width / 2, Math.max(0, bottom - y))
    return `M${x},${bottom}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${bottom}Z`
  }
  const el = (name, attrs, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    if (text !== undefined) node.textContent = text
    return node
  }

  function render() {
    for (const button of document.querySelectorAll('#view button')) button.setAttribute('aria-pressed', String(button.dataset.value === view))
    for (const button of document.querySelectorAll('#scale button')) { button.setAttribute('aria-pressed', String(button.dataset.value === scale)); button.disabled = view !== 'both' }
    const plot = $('plot')
    if (!stats) return fit()
    const result = bucketize(stats)
    if (!result) { plot.innerHTML = '<p class="empty">Пока нет ни запусков, ни строк кода.</p>'; return fit() }
    const { buckets, from } = result
    const shown = SERIES.filter(series => view === 'both' || view === series.key)
    const tokensTotal = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)
    const allTokens = stats.tokens.reduce((sum, point) => sum + point.value, 0)
    const linesNow = stats.lines.length ? stats.lines[stats.lines.length - 1].value : 0
    const linesBefore = [...stats.lines].reverse().find(point => point.at < from)?.value ?? stats.lines[0]?.value ?? 0
    const period = DAYS > 0 ? `за ${DAYS} дн.` : 'за всю историю'
    const delta = linesNow - linesBefore
    $('totals').innerHTML = ''
    const total = (label, value, small) => {
      const box = document.createElement('div'); box.className = 'total'
      const span = document.createElement('span'); span.textContent = label
      const bold = document.createElement('b'); bold.textContent = value
      const note = document.createElement('small'); note.textContent = small
      box.append(span, bold, note); $('totals').append(box)
    }
    total(`Токены ${period}`, exact.format(tokensTotal), DAYS > 0 && allTokens !== tokensTotal ? `всего ${compact.format(allTokens)}` : `${stats.tokens.length} запусков`)
    total('Строк кода сейчас', exact.format(linesNow), `${delta >= 0 ? '+' : '−'}${exact.format(Math.abs(delta))} ${period}`)

    const maxOf = key => Math.max(0, ...buckets.map(bucket => bucket[key] || 0))
    const maxTokens = maxOf('tokens'), maxLines = maxOf('lines')
    const ratio = Math.max(maxTokens, maxLines) / Math.max(1, Math.min(maxTokens, maxLines))
    const mode = view !== 'both' ? 'linear' : scale !== 'auto' ? scale : !maxTokens || !maxLines || ratio <= 10 ? 'linear' : 'log'
    const value = (bucket, key) => mode === 'index' ? (bucket[key] || 0) / Math.max(1, key === 'tokens' ? maxTokens : maxLines) * 100 : bucket[key] || 0
    const scaleInfo = axis(mode, buckets.flatMap(bucket => shown.map(series => value(bucket, series.key))))

    $('legend').innerHTML = ''
    for (const series of shown) {
      const item = document.createElement('span'); const swatch = document.createElement('i')
      swatch.style.background = series.color; item.append(swatch, series.label); $('legend').append(item)
    }
    const names = { linear: 'обычная', log: 'логарифмическая', index: 'индекс: каждый ряд в % от своего максимума' }
    const bigger = maxTokens >= maxLines ? 'токенов' : 'строк'
    const why = view === 'both' && scale === 'auto' && mode === 'log' ? ` (авто: ${bigger} в ${compact.format(Math.round(ratio))} раз больше)` : view === 'both' && scale === 'auto' ? ' (авто: величины сравнимы)' : ''
    const source = stats.linesSource === 'git' ? 'строки по истории git и рабочей копии' : stats.linesSource === 'files' ? 'строки по подсчёту файлов (история с первого открытия)' : 'строк нет: папка проекта недоступна'
    $('note').textContent = `${view === 'both' ? `Шкала ${names[mode]}${why}. ` : ''}Токены — ввод и вывод запусков Orbit; ${source}.`

    const width = Math.max(240, plot.clientWidth), height = plot.clientHeight || 168
    const margin = { left: 44, right: 6, top: 6, bottom: 18 }
    const top = margin.top, bottom = height - margin.bottom, left = margin.left, right = width - margin.right
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${shown.map(series => series.label).join(' и ')} по ${buckets[0].size >= DAY ? 'дням' : 'часам'}` })
    for (const tick of scaleInfo.ticks) {
      const y = position(scaleInfo, tick, top, bottom)
      svg.append(el('line', { x1: left, x2: right, y1: y, y2: y, stroke: '#2b2d33', 'stroke-width': 1 }))
      svg.append(el('text', { x: left - 6, y: y + 3.5, 'text-anchor': 'end' }, scaleInfo.label(tick)))
    }
    const group = (right - left) / buckets.length
    const barWidth = Math.max(1.5, Math.min(18, (group * 0.78 - (shown.length - 1) * 2) / shown.length))
    const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor((right - left) / 56))))
    const highlight = el('rect', { x: 0, y: top, width: group, height: bottom - top, fill: '#ffffff', opacity: 0, rx: 4 })
    svg.append(highlight)
    buckets.forEach((bucket, index) => {
      const center = left + group * (index + 0.5)
      const start = center - (shown.length * barWidth + (shown.length - 1) * 2) / 2
      shown.forEach((series, place) => {
        if (bucket[series.key] === null || !(value(bucket, series.key) > 0)) return
        const y = position(scaleInfo, value(bucket, series.key), top, bottom)
        if (bottom - y < 0.5) return
        svg.append(el('path', { d: barPath(start + place * (barWidth + 2), y, barWidth, bottom), fill: series.color }))
      })
      if (index % every === 0) svg.append(el('text', { x: center, y: height - 4, 'text-anchor': 'middle' }, bucketLabel(bucket, false)))
      const hit = el('rect', { x: left + group * index, y: top, width: group, height: bottom - top, fill: 'transparent' })
      hit.addEventListener('mouseenter', () => { highlight.setAttribute('x', String(left + group * index)); highlight.setAttribute('opacity', '0.04'); tip(bucket, center) })
      hit.addEventListener('mouseleave', () => { highlight.setAttribute('opacity', '0'); $('tip').hidden = true })
      svg.append(hit)
    })
    svg.append(el('line', { x1: left, x2: right, y1: bottom, y2: bottom, stroke: '#3a3d45', 'stroke-width': 1 }))
    plot.replaceChildren(svg)
    fit()

    function tip(bucket, center) {
      const box = $('tip')
      box.replaceChildren()
      const title = document.createElement('b'); title.textContent = bucketLabel(bucket, true); box.append(title)
      for (const series of shown) {
        const row = document.createElement('div'); const swatch = document.createElement('i'); swatch.style.background = series.color
        const amount = bucket[series.key] === null ? 'нет данных' : exact.format(bucket[series.key])
        row.append(swatch, `${series.key === 'tokens' ? 'Токены за период' : 'Строк кода'}: ${amount}`); box.append(row)
      }
      box.hidden = false
      const plotBox = plot.getBoundingClientRect(), mainBox = $('app').getBoundingClientRect()
      const x = Math.min(mainBox.width - box.offsetWidth - 6, Math.max(6, plotBox.left - mainBox.left + center - box.offsetWidth / 2))
      box.style.left = `${x}px`
      box.style.top = `${plotBox.top - mainBox.top + 2}px`
    }
  }

  // The frame takes the page's height.
  function fit() {
    if (window.parent !== window) window.parent.postMessage({ type: 'orbit-skill:height', height: Math.ceil(document.documentElement.scrollHeight) }, '*')
  }
  for (const button of document.querySelectorAll('#view button')) button.addEventListener('click', () => { view = button.dataset.value; save('view', view); render() })
  for (const button of document.querySelectorAll('#scale button')) button.addEventListener('click', () => { scale = button.dataset.value; save('scale', scale); render() })
  window.addEventListener('message', event => {
    const data = event.data
    if (event.source !== window.parent || !data || data.type !== 'orbit-skill:data' || !data.stats) return
    const tokens = Array.isArray(data.stats.tokens) ? data.stats.tokens : [], lines = Array.isArray(data.stats.lines) ? data.stats.lines : []
    stats = { ...data.stats, tokens, lines }
    render()
  })
  let width = 0
  new ResizeObserver(() => { if ($('plot').clientWidth !== width) { width = $('plot').clientWidth; render() } }).observe($('plot'))
  render()
  if (window.parent !== window) window.parent.postMessage({ type: 'orbit-skill:ready' }, '*')
  else $('plot').innerHTML = '<p class="empty">Эта страница показывается в окне квот Orbit и получает данные оттуда.</p>'
})()
