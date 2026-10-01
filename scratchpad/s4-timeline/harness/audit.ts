// Numbers about the chart's layout, read from the real DOM after it rendered (capture.cjs prints them next to every screenshot):
// overflow and clipping, the axis against the tracks, bars against the data, text contrast, how far apart the state colours are.
import { buildRunTimeline } from '../../../src/run-timeline'
import type { RunSnapshot } from '../../../src/types'

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits
const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: round(rect.left), y: round(rect.top), w: round(rect.width), h: round(rect.height) } }
const describe = (element: Element) => `${element.tagName.toLowerCase()}${typeof element.className === 'string' && element.className.trim() ? `.${element.className.trim().split(/\s+/).join('.')}` : ''}`
const textOf = (element: Element, length = 40) => (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, length)

type Color = [number, number, number, number]
function parseColor(value: string): Color | null {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i)
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16), 1]
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) return null
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
}
const over = (top: Color, bottom: Color): Color => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1) as Color
// What the element sits on: its own and its ancestors' backgrounds laid over each other, down to the page's #17181b.
function backdrop(element: Element): Color {
  const layers: Color[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (color && color[3] > 0) { layers.push(color); if (color[3] === 1) break }
  }
  return layers.reverse().reduce((below, layer) => over(layer, below), [23, 24, 27, 1] as Color)
}
const channel = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4 }
const luminance = (color: Color) => 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2])
const contrast = (a: Color, b: Color) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
function lab(color: Color) {
  const [r, g, b] = [channel(color[0]), channel(color[1]), channel(color[2])]
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
const deltaE = (a: Color, b: Color) => { const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b); return Math.hypot(l1 - l2, a1 - a2, b1 - b2) }

const STATES = ['working', 'done', 'waiting', 'paused', 'error', 'cancelled', 'interrupted', 'restarting']
const TEXTS: [string, string][] = [
  ['axis label', '.run-timeline-axis > span'], ['summary term', '.run-timeline-summary dt'], ['summary value', '.run-timeline-summary dd'],
  ['strip heading', '.run-timeline-parallel-head span'], ['row name', '.run-timeline-row:not(.selected) .run-timeline-name strong'],
  ['selected row name', '.run-timeline-row.selected .run-timeline-name strong'], ['row time', '.run-timeline-name em'], ['legend', '.run-timeline-legend li'],
  ['restart note', '.run-timeline-restart-note'], ['empty text', '.run-timeline-empty'], ['view switch', '.agents-view-switch button:not(.active)'],
  ['view switch (active)', '.agents-view-switch button.active'], ['tooltip title', '.run-timeline-tip strong'], ['tooltip line', '.run-timeline-tip span'],
]

export function audit(run: RunSnapshot) {
  const issues: string[] = []
  const info: Record<string, unknown> = {}
  const page = document.documentElement
  info.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
  if (page.scrollWidth > page.clientWidth + 1) issues.push(`the page scrolls horizontally (scrollWidth ${page.scrollWidth} > ${page.clientWidth})`)
  if (page.scrollHeight > page.clientHeight + 1) issues.push(`the page scrolls vertically (scrollHeight ${page.scrollHeight} > ${page.clientHeight})`)
  const root = document.querySelector<HTMLElement>('.run-timeline')
  if (!root) { issues.push('no .run-timeline in the page'); return { issues, info } }
  const rootRect = root.getBoundingClientRect()
  info.root = { ...box(root), scrollW: root.scrollWidth, clientW: root.clientWidth, scrollH: root.scrollHeight, clientH: root.clientHeight, scrollTop: Math.round(root.scrollTop), scrollbarW: root.offsetWidth - root.clientWidth }
  if (root.scrollWidth > root.clientWidth + 1) issues.push(`.run-timeline scrolls horizontally: scrollWidth ${root.scrollWidth} > clientWidth ${root.clientWidth}`)
  info.scrollsInside = root.scrollHeight > root.clientHeight + 1 ? `${root.scrollHeight - root.clientHeight}px of the chart are below the fold (the chart is ${root.clientHeight}px high)` : 'fits'

  // Everything inside must stay inside the chart's width (the tooltip is fixed to the window and checked separately).
  const limit = rootRect.left + root.clientWidth
  const spill = [...root.querySelectorAll('*')].filter(el => !el.closest('.run-timeline-tip')).map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && (rect.right > limit + 1 || rect.left < rootRect.left - 1))
  if (spill.length) issues.push(`${spill.length} elements stick out of the chart sideways: ${spill.slice(0, 4).map(({ el, rect }) => `${describe(el)} «${textOf(el, 20)}» ${round(rect.left)}..${round(rect.right)} vs ${round(rootRect.left)}..${round(limit)}`).join('; ')}`)

  const rowEls = [...root.querySelectorAll<HTMLElement>('.run-timeline-row')]
  const bars = [...root.querySelectorAll<HTMLElement>('.run-timeline-bar')]
  const marks = [...root.querySelectorAll<HTMLElement>('.run-timeline-mark')]
  info.counts = {
    rows: rowEls.length, bars: bars.length, hairlineBars: bars.filter(bar => bar.getBoundingClientRect().width < 3).length, queue: root.querySelectorAll('.run-timeline-queue').length,
    segments: root.querySelectorAll('.run-timeline-seg').length, spawned: marks.filter(mark => mark.classList.contains('spawned')).length,
    finished: marks.filter(mark => mark.classList.contains('finished')).length, handover: marks.filter(mark => mark.classList.contains('handover')).length,
    restartLine: root.querySelectorAll('.run-timeline-restart').length, legend: [...root.querySelectorAll('.run-timeline-legend li')].map(li => textOf(li, 30)),
    states: [...new Set(bars.map(bar => bar.dataset.state))],
  }
  info.selectedRows = rowEls.filter(row => row.classList.contains('selected')).map(row => textOf(row.querySelector('.run-timeline-name strong') || row, 30))
  // How much of the chart is usable before any scrolling: the height above the first row (summary, legend, axis, strip) and the rows in view.
  if (rowEls.length) {
    const rows = rowEls.map(row => row.getBoundingClientRect())
    const inView = rows.reduce((sum, rect) => sum + Math.max(0, Math.min(rect.bottom, rootRect.bottom - 1) - Math.max(rect.top, rootRect.top + 1)) / Math.max(rect.height, 1), 0)
    info.rowsInView = { visible: round(inView, 1), of: rowEls.length, headerPx: Math.round(rows[0].top - rootRect.top + root.scrollTop), rowPx: round(rows[0].height) }
  }

  // Names: how many are cut by the ellipsis, and whether any is squeezed to nothing by the time label next to it.
  const ellipsized: string[] = [], squeezed: string[] = []
  for (const row of rowEls) {
    const name = row.querySelector<HTMLElement>('.run-timeline-name strong')
    if (!name) continue
    if (name.scrollWidth > name.clientWidth + 1) ellipsized.push(`${textOf(name, 60)} (${name.clientWidth}px of ${name.scrollWidth}px)`)
    if (name.clientWidth < 48) squeezed.push(textOf(name, 30))
  }
  info.ellipsizedNames = ellipsized
  if (squeezed.length) issues.push(`names squeezed to under 48px: ${squeezed.join(', ')}`)
  const cutSummary = [...root.querySelectorAll<HTMLElement>('.run-timeline-summary dt, .run-timeline-summary dd')].filter(el => el.scrollWidth > el.clientWidth + 1)
  if (cutSummary.length) issues.push(`summary text cut by an ellipsis: ${cutSummary.map(el => `«${textOf(el, 40)}»`).join(', ')}`)
  const note = root.querySelector<HTMLElement>('.run-timeline-restart-note')
  if (note) info.restartNote = note.scrollWidth > note.clientWidth + 1 ? `cut by an ellipsis (${note.clientWidth}px of ${note.scrollWidth}px)` : 'whole'

  // The axis against the tracks: every label's anchor against the grid line of the same tick.
  const pad = parseFloat(getComputedStyle(root).getPropertyValue('--tl-pad')) || 14
  const axis = root.querySelector<HTMLElement>('.run-timeline-axis')
  const labels = [...(axis?.querySelectorAll<HTMLElement>(':scope > span') ?? [])]
  const firstTrack = root.querySelector<HTMLElement>('.run-timeline-track')
  const grid = firstTrack ? [...firstTrack.querySelectorAll<HTMLElement>(':scope > .run-timeline-grid')] : []
  if (axis && firstTrack) {
    const axisRect = axis.getBoundingClientRect(), trackRect = firstTrack.getBoundingClientRect()
    const anchors = labels.map(label => { const fraction = parseFloat((label.style.left.match(/\*\s*([0-9.eE+-]+)\)\s*$/) || [])[1]); return axisRect.left + pad + (axisRect.width - 2 * pad) * fraction })
    const drifts = anchors.map((anchor, index) => grid[index] ? anchor - grid[index].getBoundingClientRect().left : NaN)
    info.axis = {
      labels: labels.map(label => label.textContent), padPx: pad, axisW: round(axisRect.width), trackW: round(trackRect.width), trackLeftMinusAxisInner: round(trackRect.left - (axisRect.left + pad)),
      trackWidthMinusAxisInner: round(trackRect.width - (axisRect.width - 2 * pad)), gridLines: grid.length, tickDriftPx: drifts.map(drift => round(drift, 2)),
    }
    if (grid.length !== labels.length) issues.push(`axis has ${labels.length} labels but the tracks have ${grid.length} grid lines`)
    if (drifts.some(drift => Math.abs(drift) > 1)) issues.push(`axis labels are off their grid lines by ${drifts.map(drift => round(drift, 1)).join(', ')}px`)
    const rects = labels.map(label => ({ label, rect: label.getBoundingClientRect() })).sort((a, b) => a.rect.left - b.rect.left)
    rects.forEach(({ label, rect }, index) => {
      if (rect.left < axisRect.left - 0.5 || rect.right > axisRect.right + 0.5) issues.push(`axis label «${label.textContent}» is outside the axis (${round(rect.left)}..${round(rect.right)} vs ${round(axisRect.left)}..${round(axisRect.right)})`)
      const next = rects[index + 1]
      if (next && next.rect.left < rect.right + 3) issues.push(`axis labels «${label.textContent}» and «${next.label.textContent}» touch or overlap (gap ${round(next.rect.left - rect.right)}px)`)
    })
  }

  // Bars against the data: where each should be on its track, from the same builder the component uses.
  const timeline = buildRunTimeline(run, Date.now())
  const span = Math.max(timeline.end - timeline.start, 1)
  if (!root.querySelector('.run-timeline-empty') && rowEls.length !== timeline.rows.length) issues.push(`${rowEls.length} rows in the DOM, ${timeline.rows.length} agents in the data`)
  let leftDrift = 0, widthDrift = 0, outside = 0
  rowEls.forEach((rowEl, index) => {
    const data = timeline.rows[index]
    const track = rowEl.querySelector<HTMLElement>('.run-timeline-track')
    if (!data || !track) return
    const trackRect = track.getBoundingClientRect()
    const barEls = [...rowEl.querySelectorAll<HTMLElement>('.run-timeline-bar')]
    if (barEls.length !== data.bars.length) issues.push(`row «${data.name}»: ${barEls.length} bars in the DOM, ${data.bars.length} in the data`)
    barEls.forEach((barEl, position) => {
      const bar = data.bars[position]
      const rect = barEl.getBoundingClientRect()
      if (rect.left < trackRect.left - 0.5 || rect.right > trackRect.right + 0.5) outside++
      if (!bar) return
      leftDrift = Math.max(leftDrift, Math.abs(rect.left - (trackRect.left + (bar.start - timeline.start) / span * trackRect.width)))
      const expectedWidth = (bar.end - bar.start) / span * trackRect.width
      if (expectedWidth >= 2) widthDrift = Math.max(widthDrift, Math.abs(rect.width - expectedWidth))
    })
  })
  info.barDrift = { maxLeftPx: round(leftDrift, 2), maxWidthPx: round(widthDrift, 2) }
  const tolerance = timeline.live ? 2.5 : 1
  if (leftDrift > tolerance || widthDrift > tolerance) issues.push(`bars are off their data positions: left by ${round(leftDrift, 2)}px, width by ${round(widthDrift, 2)}px`)
  if (outside) issues.push(`${outside} bars stick out of their track`)

  // Text contrast (WCAG: 4.5:1 for small text) and how far apart the bar colours are.
  const lowContrast: string[] = []
  const contrasts: Record<string, string> = {}
  for (const [name, selector] of TEXTS) {
    const element = document.querySelector(selector)
    if (!element) continue
    const style = getComputedStyle(element)
    const background = backdrop(element)
    const color = parseColor(style.color)
    if (!color) continue
    const ratio = contrast(over(color, background), background)
    contrasts[name] = `${round(ratio, 2)}:1 ${style.color} on rgb(${background.slice(0, 3).map(Math.round).join(',')}) ${style.fontSize}`
    if (ratio < 4.5 && parseFloat(style.fontSize) < 18) lowContrast.push(`${name} ${round(ratio, 2)}:1 (${style.fontSize})`)
  }
  info.textContrast = contrasts
  if (lowContrast.length) issues.push(`text under 4.5:1 contrast: ${lowContrast.join(', ')}`)
  const track = parseColor(getComputedStyle(root).getPropertyValue('--tl-track')) || [28, 31, 35, 1]
  const colors: Record<string, Color> = {}
  for (const state of STATES) {
    const probe = document.createElement('span')
    probe.setAttribute('data-state', state)
    root.appendChild(probe)
    const bar = parseColor(getComputedStyle(probe).getPropertyValue('--bar'))
    probe.remove()
    // A finished bar is drawn at .82 opacity over the track; an open one at 1.
    if (bar) colors[state] = over([bar[0], bar[1], bar[2], 0.82], track)
  }
  const pairs: { pair: string; deltaE: number }[] = []
  const names = Object.keys(colors)
  names.forEach((a, i) => names.slice(i + 1).forEach(b => pairs.push({ pair: `${a}/${b}`, deltaE: round(deltaE(colors[a], colors[b]), 1) })))
  pairs.sort((a, b) => a.deltaE - b.deltaE)
  info.closestStateColors = pairs.slice(0, 8)
  // «Stopped» and «interrupted» share one colour and one legend entry on purpose (RunTimeline.tsx), so that pair is not reported.
  const alike = pairs.filter(item => item.deltaE < 12 && item.pair !== 'cancelled/interrupted')
  if (alike.length) issues.push(`state colours hard to tell apart (ΔE < 12): ${alike.map(item => `${item.pair} ${item.deltaE}`).join(', ')}`)
  const trackContrast = Object.entries(colors).map(([state, color]) => [state, round(contrast(color, track), 2)] as const)
  info.barVsTrackContrast = Object.fromEntries(trackContrast)
  const faint = trackContrast.filter(([, ratio]) => ratio < 3).map(([state, ratio]) => `${state} ${ratio}:1`)
  if (faint.length) issues.push(`bars under 3:1 against the track: ${faint.join(', ')}`)

  info.tips = tooltips()
  return { issues, info }
}

// The tooltips on the page: what they say, where they are, and whether they fit in the window.
export function tooltips() {
  return [...document.querySelectorAll<HTMLElement>('.run-timeline-tip')].map(tip => {
    const rect = tip.getBoundingClientRect()
    return {
      text: textOf(tip, 240), box: box(tip), below: tip.classList.contains('below'),
      insideWindow: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      overflow: { left: round(Math.max(0, -rect.left)), top: round(Math.max(0, -rect.top)), right: round(Math.max(0, rect.right - window.innerWidth)), bottom: round(Math.max(0, rect.bottom - window.innerHeight)) },
    }
  })
}
export function hoverInfo(x: number, y: number) {
  const target = document.elementFromPoint(x, y)
  const title = target?.closest('[title]')
  return {
    at: { x, y }, target: target ? describe(target) : null, state: target?.getAttribute('data-state') ?? null, hovered: !!target?.matches(':hover'),
    nativeTitle: title ? title.getAttribute('title') : null, tips: tooltips(),
  }
}
