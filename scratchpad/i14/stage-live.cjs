// I14: live check of the skill stage in the real Orbit window. electron/main.cjs runs as the app does (its orbit-skill://
// handler with the CSP header, the YouTube Referer hook, the runtime child process, the built renderer from dist/), with the
// celebration package of this repository installed in a temporary profile. Runs answer from a local OpenAI-compatible
// fixture server and the vendor CLIs from scripts/smoke-fixtures.cjs, so no subscription is touched. The window is shown
// (animations run at full speed only in a shown window) and muted.
//   node scripts/run-electron.cjs scratchpad/i14/stage-live.cjs                  normal motion
//   I14_REDUCED=1 node scripts/run-electron.cjs scratchpad/i14/stage-live.cjs    prefers-reduced-motion forced
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
const { StateStore } = require(path.join(repo, 'electron', 'run-store.mts'))
const { CapabilityStore } = require(path.join(repo, 'electron', 'capabilities.mts'))

const reduced = process.env.I14_REDUCED === '1'
if (reduced) app.commandLine.appendSwitch('force-prefers-reduced-motion')
const tag = reduced ? 'reduced' : 'normal'
const shots = path.join(__dirname, 'shots')
fs.mkdirSync(shots, { recursive: true })

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-i14-stage-'))
const profile = path.join(temporary, 'profile')
const workspace = path.join(temporary, 'alpha')
fs.mkdirSync(workspace)
process.env.ORBIT_RUNTIME_MODE = 'child'
process.env.ORBIT_RUNTIME_FIXTURES = path.join(repo, 'scripts', 'smoke-fixtures.cjs')
process.env.ORBIT_SMOKE_FIXTURE_DIR = temporary
process.env.ORBIT_SMOKE = '1'
process.env.ORBIT_USER_DATA = profile
process.env.ORBIT_DEV = '0'
process.env.ORBIT_HEALTH_FILE = '0'
process.env.ORBIT_OPENAI_MODEL = 'fixture-model'
delete process.env.ORBIT_OPENAI_API_KEY
new StateStore(profile).save({
  version: 3,
  activeProjectId: 'alpha',
  projects: [{ id: 'alpha', workspace: { path: workspace, name: 'Альфа', connected: false, branch: '', changedFiles: 0 }, activeChatId: 'alpha-chat',
    chats: [{ id: 'alpha-chat', title: 'Новый чат', messages: [], updated: new Date().toISOString() }] }],
  settings: { providerId: 'custom', models: { custom: 'fixture-model' }, memoryEnabled: false, accessMode: 'workspace-write', approvalPolicy: 'never', agentInstructions: '',
    limits: { maxAgents: 4, maxDepth: 2, maxConcurrent: 2, maxTurns: 4, maxTotalTurns: 8 } },
})

// The package as an agent installs it (capability_install {fromDir}), with a 5-second segment so the page ends by itself soon.
const store = new CapabilityStore(profile)
const { entry: skill } = store.save({ fromDir: path.join(repo, 'skills', 'task-completed-celebration'), workspace }, { origin: 'user' })
store.setParams(skill.id, { start: 42, end: 47 }, workspace)
store.flush()
const packageId = skill.package.id

const server = http.createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: 'Готово.' }, finish_reason: 'stop' }] }))
  }, 60)
})

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw new Error(`Timed out: ${label}`)
}
const report = { mode: tag, packageId, steps: [] }
const note = (step, data) => { report.steps.push({ step, ...data }); console.log(JSON.stringify({ step, ...data })) }

async function exercise(win) {
  win.webContents.setAudioMuted(true)
  const errors = []
  win.webContents.on('console-message', (_event, ...args) => {
    const detail = args.length === 1 ? args[0] : { level: args[0], message: args[1] }
    if (detail.level === 3 || detail.level === 'error') errors.push(String(detail.message).slice(0, 300))
  })
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  const skillFrame = () => win.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(`orbit-skill://${packageId}/`))
  const inPage = async code => {
    const frame = skillFrame()
    if (!frame) throw new Error('no skill frame')
    return frame.executeJavaScript(code)
  }
  const stageShown = () => evaluate(`!!document.querySelector('.skill-stage iframe')`)
  const flag = () => evaluate(`sessionStorage.getItem('orbit.skill-stage.fullscreen')`)
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const shot = async name => {
    win.webContents.invalidate()
    await win.webContents.capturePage()
    await delay(500)
    fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage()).toPNG())
  }
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'renderer ready', 30000)
  const runIds = async () => (await evaluate(`window.orbit.listRuns()`)).map(run => run.runId)
  const send = async text => {
    await evaluate(`(() => { const field = document.querySelector('textarea[aria-label="Сообщение агенту"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await waitFor(() => evaluate(`!document.querySelector('button[aria-label="Отправить сообщение"]').disabled`), 'send enabled')
    const before = new Set(await runIds())
    await evaluate(`document.querySelector('form.composer').requestSubmit()`)
    let runId = null
    await waitFor(async () => {
      const runs = await evaluate(`window.orbit.listRuns()`)
      const run = runs.find(item => !before.has(item.runId))
      if (run && run.status === 'completed') runId = run.runId
      return !!runId
    }, `run of "${text}" completes`, 20000)
    return runId
  }
  // A run completes -> the stage shows the package page full screen, with the parameters and the run in its address.
  const openStage = async (text) => {
    const runId = await send(text)
    await waitFor(stageShown, 'the stage shows the page', 15000)
    const frame = await evaluate(`(() => { const f = document.querySelector('.skill-stage iframe'); return { src: f.src, sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), title: f.title, dialog: f.parentElement.getAttribute('role') } })()`)
    const url = new URL(frame.src)
    assert.equal(url.protocol, 'orbit-skill:')
    assert.equal(url.host, packageId)
    assert.equal(url.pathname, '/page.html')
    assert.equal(url.searchParams.get('orbit_event'), 'task-completed')
    assert.equal(url.searchParams.get('orbit_run'), runId)
    assert.deepEqual([url.searchParams.get('start'), url.searchParams.get('end'), url.searchParams.get('text'), url.searchParams.get('confetti')], ['42', '47', 'TASK COMPLETED', 'true'])
    assert.equal(frame.sandbox, 'allow-scripts allow-same-origin allow-presentation')
    await waitFor(() => win.isFullScreen(), 'the window goes full screen', 5000)
    assert.equal(await flag(), '1', 'the stage records that it switched full screen on')
    await waitFor(() => inPage('!!window.celebrationState').catch(() => false), 'the page runs in its frame', 10000)
    return { runId, frame }
  }
  const closed = async (label) => {
    await waitFor(async () => !(await stageShown()), `${label}: the stage closes`, 30000)
    await waitFor(() => !win.isFullScreen(), `${label}: the window leaves full screen`, 5000)
    assert.equal(await flag(), null, `${label}: the flag is cleared`)
  }
  const motion = async () => {
    const sample = () => inPage(`(() => { const c = document.getElementById('confetti'); const flyer = document.getElementById('flyer');
      return { transform: flyer.style.transform, spin: getComputedStyle(document.getElementById('spin')).animationName,
        pulse: getComputedStyle(document.getElementById('words')).animationName, backdrop: getComputedStyle(document.getElementById('backdrop')).animationName,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, canvas: c.hidden ? 'hidden' : c.toDataURL(), pieces: window.celebrationState.pieces,
        x: window.celebrationState.textX, y: window.celebrationState.textY, centreX: Math.round((innerWidth - flyer.offsetWidth) / 2), centreY: Math.round((innerHeight - flyer.offsetHeight) / 2),
        words: document.querySelectorAll('.word').length, size: [innerWidth, innerHeight] } })()`)
    const first = await sample()
    await delay(1200)
    const second = await sample()
    const digest = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)
    return {
      reduce: first.reduce, spin: first.spin, pulse: first.pulse, backdrop: first.backdrop, words: first.words, size: first.size,
      textMoved: first.transform !== second.transform, transforms: [first.transform, second.transform], text: [first.x, first.y], centre: [first.centreX, first.centreY],
      confettiChanged: first.canvas !== second.canvas, canvases: [digest(first.canvas), digest(second.canvas)], pieces: [first.pieces, second.pieces],
    }
  }
  const pageState = () => inPage('JSON.stringify(window.celebrationState)').then(JSON.parse).catch(() => null)

  // 1. The page ends by itself at the end of the segment (or 12 s without video); the stage closes and full screen ends.
  const first = await openStage('ORBIT_I14: первая задача')
  note('stage opened', { runId: first.runId, src: first.frame.src, fullScreen: win.isFullScreen() })
  await delay(2500)
  await shot(`${tag}-stage.png`)
  const moved = await motion()
  note('motion', moved)
  assert.equal(moved.reduce, reduced, 'the page sees the reduced-motion preference')
  assert.equal(moved.words, 2)
  if (reduced) {
    assert.deepEqual([moved.spin, moved.pulse, moved.backdrop], ['none', 'none', 'none'])
    assert.equal(moved.textMoved, false, 'the text stands still')
    assert.ok(Math.abs(moved.text[0] - moved.centre[0]) <= 1 && Math.abs(moved.text[1] - moved.centre[1]) <= 1, 'the text is in the middle')
    assert.equal(moved.confettiChanged, false, 'the confetti lies still')
    assert.ok(moved.pieces[0] >= 40 && moved.pieces[0] === moved.pieces[1], 'the confetti is drawn')
  } else {
    assert.deepEqual([moved.spin, moved.pulse, moved.backdrop], ['word-spin', 'word-pulse', 'backdrop-turn'])
    assert.equal(moved.textMoved, true, 'the text flies')
    assert.equal(moved.confettiChanged, true, 'the confetti falls')
  }
  let last = null
  if (reduced) {
    // A click on the page closes it (the page posts orbit-skill:close to the stage).
    const [x, y] = await evaluate(`(() => { const r = document.querySelector('.skill-stage').getBoundingClientRect(); return [Math.round(r.width / 2), Math.round(r.height / 2)] })()`)
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await closed('click on the page')
    note('closed by a click on the page', { fullScreen: win.isFullScreen() })
  } else {
    const opened = Date.now()
    while (await stageShown()) { last = (await pageState()) || last; await delay(250); if (Date.now() - opened > 40000) break }
    await closed('end of the segment')
    note('closed by itself', { afterMs: Date.now() - opened, lastState: last })
  }

  // 2. Esc closes the stage.
  await openStage('ORBIT_I14: вторая задача')
  await delay(1500)
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await closed('Esc')
  note('closed by Esc', { fullScreen: win.isFullScreen() })

  if (!reduced) {
    // 3. The × button closes the stage (a real click at its place, above the page's frame).
    await openStage('ORBIT_I14: третья задача')
    await delay(1000)
    const [bx, by] = await evaluate(`(() => { const r = document.querySelector('.skill-stage-close').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 })
    await closed('the × button')
    note('closed by ×', { at: [bx, by] })

    // 4. A window reload while the page shows (a self-upgrade reload) leaves no full screen behind and does not show the page again.
    await openStage('ORBIT_I14: четвёртая задача')
    await delay(1000)
    assert.equal(win.isFullScreen(), true)
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
    await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'renderer ready after reload', 30000)
    await waitFor(() => !win.isFullScreen(), 'full screen undone after the reload', 5000)
    assert.equal(await flag(), null)
    await delay(3000)
    assert.equal(await stageShown(), false, 'the handled run does not show its page again after the reload')
    note('reload while shown', { fullScreen: win.isFullScreen(), stage: await stageShown() })

    // 5. A switched-off skill shows nothing.
    await evaluate(`window.orbit.setCapabilityEnabled(${JSON.stringify(skill.id)}, false, ${JSON.stringify(workspace)})`)
    await send('ORBIT_I14: пятая задача')
    await delay(4000)
    assert.equal(await stageShown(), false, 'a switched-off skill shows no page')
    assert.equal(win.isFullScreen(), false)
    note('switched off', { stage: false })
  }
  const pageErrors = errors.filter(text => !/youtube|ytimg|googlevideo|doubleclick|Permissions-Policy|Refused to (load|frame)/i.test(text))
  note('console errors', { all: errors.length, relevant: pageErrors })
  assert.deepEqual(pageErrors, [])
}

let orbit = null
const timeout = setTimeout(() => { console.error('I14 stage check exceeded 180 s'); app.exit(1) }, 180000)
let started = false
app.on('browser-window-created', (_event, win) => {
  if (started) return
  started = true
  win.webContents.once('did-finish-load', async () => {
    let code = 0
    try { await exercise(win) } catch (error) { console.error(error.stack); code = 1 }
    try { await orbit?.shutdownRuntime('quit') } catch (error) { console.error(`runtime shutdown failed: ${error.stack}`); code = 1 }
    fs.writeFileSync(path.join(__dirname, `report-${tag}.json`), JSON.stringify({ ...report, ok: code === 0 }, null, 1))
    console.log(JSON.stringify({ ok: code === 0, mode: tag }))
    clearTimeout(timeout)
    server.closeAllConnections()
    server.close()
    try { win.setFullScreen(false) } catch { /* closing anyway */ }
    win.destroy()
    app.exit(code)
  })
})
app.on('quit', () => {
  if (path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    try { fs.rmSync(temporary, { recursive: true, force: true }) } catch { /* Windows may still hold profile handles. */ }
  }
})
server.listen(0, '127.0.0.1', () => {
  process.env.ORBIT_OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  orbit = require(path.join(repo, 'electron', 'main.cjs'))
})
