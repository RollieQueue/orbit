'use strict'
// Screenshots of the run timeline (the real AgentsPanel / RunTimeline from src/, rendered by the harness page in harness-dist).
//   npx vite build --config scratchpad/s4-timeline/harness/vite.config.mjs
//   node scripts/run-electron.cjs scratchpad/s4-timeline/capture.cjs [--only=<text in a shot name>] [--animated]
// (or both in one: node scratchpad/s4-timeline/shoot.cjs). PNGs go to scratchpad/s4-timeline/shots/, with report.json: sanity numbers,
// console errors and the DOM audit of every page. Motion is forced off (prefers-reduced-motion) so that every frame is a settled one;
// --animated keeps the pulse of working dots and open bars.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
// One CSS pixel = one image pixel whatever the display's scale, and a throw-away profile (the view choice is kept in localStorage).
app.commandLine.appendSwitch('force-device-scale-factor', '1')
if (!process.argv.includes('--animated')) app.commandLine.appendSwitch('force-prefers-reduced-motion')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-s4-shots-'))
app.setPath('userData', profile)
// Without a listener Electron quits when the last window closes, which would kill the run between two screenshots.
app.on('window-all-closed', () => {})

const SHOTS = path.join(__dirname, 'shots')
const only = (process.argv.find(arg => arg.startsWith('--only=')) || '').slice('--only='.length)
const wanted = (...names) => !only || names.some(name => name.includes(only))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const run = (win, code) => win.webContents.executeJavaScript(code, true)
const report = { when: new Date().toISOString(), shots: [], pages: {}, problems: [] }
const problem = text => { report.problems.push(text); console.log(`  !! ${text}`) }

// Which pages are shot. panel: the real AgentsPanel as shipped (the chart caps its own height and scrolls); bare: the chart alone, uncapped.
const PANELS = [
  ...['e765', 'restart', 'live', 'synthetic', 'synthetic-restart'].flatMap(sample => [340, 700].map(width => ({ sample, width }))),
  { sample: 'e765', width: 300 }, { sample: 'synthetic', width: 300 },
  { sample: 'synthetic-solo', width: 340 }, { sample: 'synthetic-empty', width: 340 },
  { sample: 'synthetic', width: 340, height: 600, suffix: '-h600' },
]
const BARES = [['e765', 340], ['synthetic', 340], ['synthetic-restart', 340], ['live', 340], ['synthetic', 700], ['synthetic', 300], ['synthetic-solo', 340], ['synthetic-empty', 340]]

function imageStats(image) {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const words = new Uint32Array(bitmap.buffer.slice(bitmap.byteOffset, bitmap.byteOffset + bitmap.byteLength))
  const counts = new Map()
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1)
  let top = 0, topCount = 0
  for (const [word, count] of counts) if (count > topCount) { top = word; topCount = count }
  // The bitmap is BGRA: the low 24 bits of a little-endian word read as RRGGBB.
  return { width: size.width, height: size.height, colours: counts.size, top: `#${(top & 0xffffff).toString(16).padStart(6, '0')}`, topShare: topCount / words.length }
}

async function openPage({ sample, width, view, height = 900, select, full }) {
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false, backgroundColor: '#17181b', webPreferences: { backgroundThrottling: false } })
  const errors = []
  // Electron 44: level (a string: debug, info, warning, error) and message are properties of the event; the positional arguments are deprecated.
  win.webContents.on('console-message', event => {
    const numeric = { verbose: 0, debug: 0, info: 1, warning: 2, error: 3 }[event.level] ?? 1
    if (numeric >= 2) errors.push(`[${event.level}] ${String(event.message).slice(0, 300)}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`render-process-gone: ${details.reason}`))
  win.webContents.on('did-fail-load', (_event, code, description) => errors.push(`did-fail-load: ${code} ${description}`))
  const hash = [`sample=${sample}`, `width=${width}`, `view=${view}`, select ? `select=${select}` : '', full === undefined ? '' : `full=${full ? 1 : 0}`].filter(Boolean).join('&')
  await win.loadFile(path.join(__dirname, 'harness-dist', 'index.html'), { hash })
  const until = Date.now() + 15000
  while (!(await run(win, 'window.__ready === true')) && Date.now() < until) await wait(50)
  if (!(await run(win, 'window.__ready === true'))) throw new Error(`${hash}: window.__ready never turned true; page errors: ${await run(win, 'JSON.stringify(window.__errors || [])')}`)
  const fatal = await run(win, 'window.__fatal || ""')
  if (fatal) throw new Error(`${hash}: ${fatal}`)
  await wait(500)
  return { win, errors, hash, cdp: false }
}
async function fitToChart(page, width) {
  const height = await run(page.win, 'Math.ceil(document.querySelector(".harness-bare").getBoundingClientRect().height)')
  page.win.setContentSize(width, Math.min(Math.max(height, 120), 3000))
  await wait(400)
}

// Takes the PNG (the first capture of a hidden window can be the previous frame: invalidate, capture and discard, wait, capture again).
async function shot(page, name) {
  if (!wanted(name)) return null
  const contents = page.win.webContents
  contents.invalidate()
  await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  await wait(400)
  const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
  const stats = imageStats(image)
  const [contentWidth, contentHeight] = page.win.getContentSize()
  const blank = stats.colours <= 20 || stats.topShare > 0.995
  report.shots.push({ name, ...stats, topShare: Math.round(stats.topShare * 1000) / 1000, contentSize: [contentWidth, contentHeight], blank })
  console.log(`${blank ? 'BLANK' : 'ok   '} ${name}.png ${stats.width}x${stats.height} colours=${stats.colours} top=${stats.top} (${Math.round(stats.topShare * 100)}%)`)
  if (blank) problem(`${name}.png looks blank`)
  if (stats.width !== contentWidth || stats.height !== contentHeight) console.log(`  note: image ${stats.width}x${stats.height} differs from the window content ${contentWidth}x${contentHeight}`)
}

async function audit(page, name) {
  let result
  try { result = await run(page.win, 'window.__audit()') } catch (error) { problem(`${name}: the audit threw ${error.message}`); return }
  report.pages[name] = result
  const info = result.info || {}
  const counts = info.counts || {}
  console.log(`  rows=${counts.rows} bars=${counts.bars} (hairline ${counts.hairlineBars}) queue=${counts.queue} markers spawned/finished/handover=${counts.spawned}/${counts.finished}/${counts.handover} restartLine=${counts.restartLine}`
    + ` | chart ${info.root ? `${info.root.w}x${info.root.h}` : '-'}, ${info.scrollsInside}${info.rowsInView ? `, ${info.rowsInView.visible} of ${info.rowsInView.of} rows in view (${info.rowsInView.headerPx}px above the first row)` : ''} | axis [${(info.axis?.labels || []).join(' | ')}] drift [${(info.axis?.tickDriftPx || []).join(', ')}] | bars drift L${info.barDrift?.maxLeftPx} W${info.barDrift?.maxWidthPx}`)
  if (info.ellipsizedNames?.length) console.log(`  ellipsized names: ${info.ellipsizedNames.join('; ')}`)
  for (const issue of result.issues || []) console.log(`  ! ${issue}`)
}

async function finish(page, name) {
  const errors = [...page.errors, ...JSON.parse(await run(page.win, 'JSON.stringify(window.__errors || [])'))]
  if (errors.length) { console.log(`  console/page errors in ${name}: ${JSON.stringify(errors)}`); report.pages[name] = { ...(report.pages[name] || {}), errors } }
  page.win.destroy()
}

// ---- the real mouse: sendInputEvent first; if the page does not report the element as hovered (a hidden window often drops it), the DevTools protocol ----
const clampTo = (value, max) => Math.min(Math.max(Math.round(value), 0), max - 1)
async function mouse(page, type, x, y) {
  const [width, height] = page.win.getContentSize()
  const [px, py] = [clampTo(x, width), clampTo(y, height)]
  if (!page.cdp) { page.win.webContents.sendInputEvent(type === 'move' ? { type: 'mouseMove', x: px, y: py } : { type: type === 'down' ? 'mouseDown' : 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 }); return }
  const debuggerApi = page.win.webContents.debugger
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
  await debuggerApi.sendCommand('Input.dispatchMouseEvent', type === 'move' ? { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 }
    : { type: type === 'down' ? 'mousePressed' : 'mouseReleased', x: px, y: py, button: 'left', buttons: type === 'down' ? 1 : 0, clickCount: 1 })
}
async function pointAt(page, x, y) {
  const approach = [[-40, -25], [-12, -6], [0, 0], [1, 1]]
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const [dx, dy] of approach) { await mouse(page, 'move', x + dx, y + dy); await wait(60) }
    await wait(350)
    const info = await run(page.win, `window.__hover(${x}, ${y})`)
    if (info.hovered || attempt === 1) return { ...info, method: page.cdp ? 'devtools-protocol' : 'sendInputEvent' }
    page.cdp = true
  }
}
async function pointAway(page) {
  const [width, height] = page.win.getContentSize()
  await mouse(page, 'move', width - 2, height - 2)
  await wait(250)
}
// The centre of an element chosen by `pick` (a JS expression run in the page that returns an element), after scrolling it to the middle of the chart.
const centreOf = (page, pick) => run(page.win, `(() => {
  const element = (${pick})
  if (!element) return null
  const root = document.querySelector('.run-timeline')
  if (root && root.contains(element) && root.scrollHeight > root.clientHeight) {
    const area = root.getBoundingClientRect(), box = element.getBoundingClientRect()
    root.scrollTop += box.top + box.height / 2 - (area.top + area.height / 2)
  }
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height }
})()`)

async function hoverShot(page, name, pick, what) {
  if (!wanted(name)) return
  if (!(await centreOf(page, pick))) { problem(`${name}: nothing to hover (${what})`); return }
  await wait(150)
  const spot = await centreOf(page, pick)
  const info = await pointAt(page, spot.x, spot.y)
  console.log(`${name}: hover ${what} at ${Math.round(spot.x)},${Math.round(spot.y)} (${info.method}); target ${info.target}; native title: ${JSON.stringify(info.nativeTitle)}; tips: ${JSON.stringify(info.tips)}`)
  report.pages[name] = { hover: info }
  if (!info.hovered) problem(`${name}: the element was not hovered even through the DevTools protocol`)
  if (!info.tips.length) problem(`${name}: no tooltip appeared`)
  for (const tip of info.tips) if (!tip.insideWindow) problem(`${name}: the tooltip is outside the window: ${JSON.stringify(tip.overflow)}`)
  await shot(page, name)
  await pointAway(page)
}

// ---- flows ----
async function panelFlow({ sample, width, height = 900, suffix = '' }) {
  const name = `${sample}-${width}-panel${suffix}`
  if (!wanted(name, `${name}-scrolled`)) return
  const page = await openPage({ sample, width, view: 'panel', height })
  console.log(`${name}: ${JSON.stringify(await run(page.win, 'window.__info'))} switch=${await run(page.win, 'window.__switch')}`)
  if ((await run(page.win, 'window.__switch')) !== 'clicked') problem(`${name}: the «Таймлайн» button was not found in .agents-view-switch`)
  if (!(await run(page.win, '!!document.querySelector(".run-timeline")'))) problem(`${name}: no .run-timeline after the switch click`)
  await shot(page, name)
  await audit(page, name)
  // The chart caps its own height and scrolls: show the part below the fold as well.
  const scrollable = await run(page.win, '(() => { const root = document.querySelector(".run-timeline"); return !!root && root.scrollHeight > root.clientHeight + 1 })()')
  if (scrollable && wanted(`${name}-scrolled`)) {
    await run(page.win, 'document.querySelector(".run-timeline").scrollTop = 1e6')
    await wait(300)
    await shot(page, `${name}-scrolled`)
  }
  await finish(page, name)
}

async function bareFlow(sample, width) {
  const name = `${sample}-${width}-bare`
  if (!wanted(name)) return
  const page = await openPage({ sample, width, view: 'bare' })
  await fitToChart(page, width)
  await shot(page, name)
  await audit(page, name)
  await finish(page, name)
}

// «Список» ↔ «Таймлайн»: the other state of the switch, and the choice is kept in localStorage.
async function listFlow() {
  const name = 'e765-340-list'
  if (!wanted(name)) return
  const page = await openPage({ sample: 'e765', width: 340, view: 'panel' })
  const press = label => run(page.win, `(() => { const button = [...document.querySelectorAll('.agents-view-switch button')].find(item => item.textContent.includes(${JSON.stringify(label)})); if (button) button.click(); return !!button })()`)
  await press('Список')
  await wait(400)
  const list = await run(page.win, `({ tree: !!document.querySelector('.agent-tree'), chart: !!document.querySelector('.run-timeline'), stored: localStorage.getItem('orbit.agents-view'), active: [...document.querySelectorAll('.agents-view-switch button.active')].map(item => item.textContent) })`)
  console.log(`${name}: after «Список» ${JSON.stringify(list)}`)
  if (!list.tree || list.chart) problem(`${name}: «Список» did not show the agent list instead of the chart`)
  await shot(page, name)
  await press('Таймлайн')
  await wait(400)
  const back = await run(page.win, `({ tree: !!document.querySelector('.agent-tree'), chart: !!document.querySelector('.run-timeline'), stored: localStorage.getItem('orbit.agents-view') })`)
  console.log(`${name}: after «Таймлайн» ${JSON.stringify(back)}`)
  if (back.tree || !back.chart || back.stored !== 'timeline') problem(`${name}: «Таймлайн» did not bring the chart back / was not remembered`)
  await finish(page, name)
}

async function interactionFlow() {
  if (!wanted('e765-340-hover', 'e765-340-hover-right', 'e765-340-hover-marker', 'e765-340-select')) return
  const page = await openPage({ sample: 'e765', width: 340, view: 'panel' })
  const rowOf = text => `[...document.querySelectorAll('.run-timeline-row')].find(row => row.textContent.includes(${JSON.stringify(text)}))`
  const widest = rowExpression => `(() => { const row = ${rowExpression}; return row && [...row.querySelectorAll('.run-timeline-bar')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] })()`
  // The widest bar of a helper that had three turns and changed subscription between two of them.
  await hoverShot(page, 'e765-340-hover', widest(rowOf('review-w1w3')), 'the longest bar of review-w1w3')
  // The bar that reaches furthest to the right: the root's last turn, where the tooltip meets the window's edge.
  await hoverShot(page, 'e765-340-hover-right', `(() => { const row = document.querySelector('.run-timeline-row'); return row && [...row.querySelectorAll('.run-timeline-bar')].sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] })()`, 'the right-most bar of the root')
  await hoverShot(page, 'e765-340-hover-marker', `document.querySelector('.run-timeline-mark.handover')`, 'the handover diamond')
  // Clicking the second row selects that agent: the row is highlighted and the inspector below follows.
  if (wanted('e765-340-select')) {
    await run(page.win, `document.querySelector('.run-timeline').scrollTop = 0`)
    await wait(150)
    const spot = await run(page.win, `(() => { const row = document.querySelectorAll('.run-timeline-row')[1].getBoundingClientRect(); return { x: row.left + 50, y: row.top + 10 } })()`)
    await pointAt(page, spot.x, spot.y)
    await mouse(page, 'down', spot.x, spot.y)
    await mouse(page, 'up', spot.x, spot.y)
    await wait(450)
    await pointAway(page)
    const after = await run(page.win, `({ selected: [...document.querySelectorAll('.run-timeline-row.selected')].map(row => row.textContent.slice(0, 30)), pressed: [...document.querySelectorAll('.run-timeline-row[aria-pressed=true]')].length, inspector: (document.querySelector('.inspector-heading h3') || {}).textContent })`)
    console.log(`e765-340-select: selected ${JSON.stringify(after.selected)}, aria-pressed rows ${after.pressed}, inspector heading ${JSON.stringify(after.inspector)}`)
    if (after.selected.length !== 1 || !after.selected[0].startsWith('tokens')) problem(`e765-340-select: after the click on the second row the selected rows are ${JSON.stringify(after.selected)}`)
    report.pages['e765-340-select'] = { after }
    await shot(page, 'e765-340-select')
  }
  await finish(page, 'e765-340-interaction')
}

// The restart note is a line under the legend with the whole reason in its tooltip.
async function restartNoteFlow(sample) {
  const name = `${sample}-340-hover-note`
  if (!wanted(name)) return
  const page = await openPage({ sample, width: 340, view: 'panel' })
  await hoverShot(page, name, `document.querySelector('.run-timeline-restart-note')`, 'the restart note')
  await finish(page, name)
}

// The chart alone and uncapped: the tooltips of the odd bars (estimated, queued, open, cut) and the flip below near the top.
async function bareHoverFlow() {
  const names = ['synthetic-340-bare-hover', 'synthetic-340-bare-hover-estimated', 'synthetic-340-bare-hover-queue', 'synthetic-340-bare-hover-open', 'synthetic-340-bare-hover-cut']
  if (!wanted(...names)) return
  const page = await openPage({ sample: 'synthetic', width: 340, view: 'bare' })
  await fitToChart(page, 340)
  const rowOf = text => `[...document.querySelectorAll('.run-timeline-row')].find(row => row.textContent.includes(${JSON.stringify(text)}))`
  await hoverShot(page, names[0], `[...document.querySelectorAll('.run-timeline-seg')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]`, 'the widest parallelism segment')
  await hoverShot(page, names[1], `document.querySelector('.run-timeline-bar[data-estimated]')`, 'the estimated bar of legacy-record')
  await hoverShot(page, names[2], `[...document.querySelectorAll('.run-timeline-queue')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]`, 'the widest queue line (queued-lint-check)')
  await hoverShot(page, names[3], `(${rowOf('live-worker')}).querySelector('.run-timeline-bar[data-open]')`, 'the open bar of live-worker')
  await hoverShot(page, names[4], `(${rowOf('crashed-helper')}).querySelector('.run-timeline-bar')`, 'the cut bar of crashed-helper')
  await finish(page, 'synthetic-340-bare-hover')
}

// A live run: the clock must keep the open bars, the summary and a tooltip that stays on screen moving.
async function liveClockFlow() {
  const name = 'synthetic-340-live-clock'
  if (!wanted(name)) return
  const page = await openPage({ sample: 'synthetic', width: 340, view: 'bare' })
  await fitToChart(page, 340)
  const read = () => run(page.win, `(() => {
    const bars = [...document.querySelectorAll('.run-timeline-bar[data-open]')].map(bar => Math.round(bar.getBoundingClientRect().width * 100) / 100)
    const tip = document.querySelector('.run-timeline-tip')
    return { bars, summary: document.querySelector('.run-timeline-summary dd').textContent, tip: tip ? tip.textContent : null }
  })()`)
  const spot = await centreOf(page, `[...document.querySelectorAll('.run-timeline-row')].find(row => row.textContent.includes('live-worker')).querySelector('.run-timeline-bar[data-open]')`)
  await pointAt(page, spot.x, spot.y)
  const before = await read()
  await wait(2600)
  const after = await read()
  console.log(`${name}: summary ${JSON.stringify(before.summary)} -> ${JSON.stringify(after.summary)}; open bar widths ${JSON.stringify(before.bars)} -> ${JSON.stringify(after.bars)}; tooltip ${JSON.stringify((before.tip || '').slice(0, 130))} -> ${JSON.stringify((after.tip || '').slice(0, 130))}`)
  report.pages[name] = { before, after }
  if (before.summary === after.summary) problem(`${name}: the summary did not move in 2.6 s (the clock is not ticking)`)
  if (!before.bars.length || after.bars.some((width, index) => !(width > before.bars[index]))) problem(`${name}: an open bar did not grow in 2.6 s`)
  if (!before.tip || before.tip === after.tip) problem(`${name}: the tooltip under the pointer is missing or did not follow the clock`)
  await finish(page, name)
}

app.whenReady().then(async () => {
  let code = 0
  try {
    fs.mkdirSync(SHOTS, { recursive: true })
    for (const panel of PANELS) await panelFlow(panel)
    for (const [sample, width] of BARES) await bareFlow(sample, width)
    await listFlow()
    await interactionFlow()
    await restartNoteFlow('restart')
    await restartNoteFlow('restart-long')
    await bareHoverFlow()
    await liveClockFlow()
  } catch (error) {
    console.log(`FAILED: ${error.stack || error}`)
    code = 1
  }
  fs.writeFileSync(path.join(SHOTS, 'report.json'), JSON.stringify(report, null, 1))
  const errorPages = Object.entries(report.pages).filter(([, page]) => page.errors?.length).map(([name]) => name)
  console.log(`\n${report.shots.length} PNGs in ${SHOTS}; blank: ${report.shots.filter(item => item.blank).length}; problems: ${report.problems.length}; pages with console/page errors: ${errorPages.length ? errorPages.join(', ') : 'none'}`)
  if (report.problems.length || report.shots.some(item => item.blank)) code = code || 1
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* Chromium may still hold the profile; it is in %TEMP% */ }
  app.exit(code)
})
