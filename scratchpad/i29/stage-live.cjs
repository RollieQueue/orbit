// I29: live check in the real Orbit window that the celebration's video loads when the system proxy is off and the web is
// reachable only through HTTP(S)_PROXY (this machine: DNS gives NXDOMAIN for YouTube, the proxy at 127.0.0.1:12334 works).
// electron/main.cjs runs as the app does, in a temporary profile with the celebration package of this repository and the
// fixture providers of scripts/smoke-fixtures.cjs (no subscription is touched). The window is shown and muted.
//   node scripts/run-electron.cjs scratchpad/i29/stage-live.cjs                    with the environment's proxy
//   I29_NO_ENV_PROXY=1 node scripts/run-electron.cjs scratchpad/i29/stage-live.cjs  control: without it (as before I29)
const { app, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
const { StateStore } = require(path.join(repo, 'electron', 'run-store.mts'))
const { CapabilityStore } = require(path.join(repo, 'electron', 'capabilities.mts'))

const control = process.env.I29_NO_ENV_PROXY === '1'
const tag = control ? 'no-env-proxy' : 'env-proxy'
const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || ''
if (control) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[name]
const shots = path.join(__dirname, 'shots')
fs.mkdirSync(shots, { recursive: true })

// What main writes to its console: the proxy follower's lines, frame and renderer failures.
const logged = []
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => { logged.push(`${level}: ${args.map(String).join(' ')}`); original(...args) }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-i29-stage-'))
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

// The package as an agent installs it, with a 5-second segment so the page ends by itself soon after the video plays.
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
const report = { mode: tag, envProxy, packageId, steps: [] }
const note = (step, data) => { report.steps.push({ step, ...data }); console.log(JSON.stringify({ step, ...data })) }

async function exercise(win) {
  win.webContents.setAudioMuted(true)
  const evaluate = code => win.webContents.executeJavaScript(code, true)
  const skillFrame = () => win.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(`orbit-skill://${packageId}/`))
  const inPage = async code => {
    const frame = skillFrame()
    if (!frame) throw new Error('no skill frame')
    return frame.executeJavaScript(code)
  }
  const stageShown = () => evaluate(`!!document.querySelector('.skill-stage iframe')`)
  const shot = async name => {
    win.webContents.invalidate()
    await win.webContents.capturePage()
    await delay(500)
    fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage()).toPNG())
  }

  // 1. The sessions: the window's goes through the environment's proxy (the system says DIRECT), loopback stays direct,
  // the system's own partition still says DIRECT (what the runtime hears).
  const youtube = 'https://www.youtube.com/'
  const windowRoute = () => session.defaultSession.resolveProxy(youtube)
  if (!control) await waitFor(async () => /^PROXY 127\.0\.0\.1:12334/.test(await windowRoute()), 'the window\'s session takes the environment\'s proxy', 10000)
  const routes = {
    window: await windowRoute(), windowHttp: await session.defaultSession.resolveProxy('http://example.com/'),
    windowLoopback: await session.defaultSession.resolveProxy('http://127.0.0.1:5173/'), windowLocalhost: await session.defaultSession.resolveProxy('http://localhost:5173/'),
    system: await session.fromPartition('orbit-system-proxy').resolveProxy(youtube), app: await app.resolveProxy(youtube),
  }
  note('routes', routes)
  assert.equal(routes.system, 'DIRECT', 'the system proxy is off on this machine (the case I29 is about)')
  assert.equal(routes.windowLoopback, 'DIRECT')
  assert.equal(routes.windowLocalhost, 'DIRECT')
  if (control) assert.equal(routes.window, 'DIRECT')
  else assert.match(routes.window, /^PROXY 127\.0\.0\.1:12334/)

  // 2. A run completes -> the celebration page shows full screen; its video loads and plays (or, in the control, fails).
  await waitFor(() => evaluate(`!!document.querySelector('textarea[aria-label="Сообщение агенту"]:not(:disabled)')`), 'renderer ready', 30000)
  await evaluate(`(() => { const field = document.querySelector('textarea[aria-label="Сообщение агенту"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'ORBIT_I29: задача'); field.dispatchEvent(new Event('input', {bubbles:true})); })()`)
  await waitFor(() => evaluate(`!document.querySelector('button[aria-label="Отправить сообщение"]').disabled`), 'send enabled')
  await evaluate(`document.querySelector('form.composer').requestSubmit()`)
  await waitFor(stageShown, 'the stage shows the page', 30000)
  const opened = Date.now()
  await waitFor(() => inPage('!!window.celebrationState').catch(() => false), 'the page runs in its frame', 10000)
  const states = []
  let shotTaken = false
  while (await stageShown()) {
    const state = await inPage('JSON.stringify({ video: window.celebrationState.video, time: window.celebrationState.time, issue: window.celebrationState.videoIssue, playerState: window.celebrationState.playerState })').then(JSON.parse).catch(() => null)
    if (state && JSON.stringify(state) !== JSON.stringify(states.at(-1)?.state)) states.push({ atMs: Date.now() - opened, state })
    if (state?.video === 'playing' && state.time > 43 && !shotTaken) { shotTaken = true; await shot(`${tag}-playing.png`) }
    if (Date.now() - opened > 60000) break
    await delay(200)
  }
  const closedAfterMs = Date.now() - opened
  note('stage', { closedAfterMs, states })
  const played = states.filter(entry => entry.state.video === 'playing' || entry.state.video === 'ended')
  const failures = logged.filter(line => /renderer failed to load/.test(line))
  const frameFailures = logged.filter(line => /a frame of the window failed to load/.test(line))
  const proxyLines = logged.filter(line => /proxy/i.test(line) && line.includes('[orbit]'))
  note('main console', { rendererFailures: failures, frameFailures: frameFailures.slice(0, 5), proxyLines })
  assert.deepEqual(failures, [], 'no frame failure is reported as a failed renderer')
  if (control) {
    assert.equal(played.length, 0, 'without the proxy the video does not load (the state before I29)')
  } else {
    assert.ok(played.some(entry => entry.state.time >= 46), 'the video played the segment to its end')
    assert.ok(closedAfterMs < 25000, 'the page closed at the end of the segment, not after the no-video timeout')
    assert.ok(proxyLines.some(line => line.includes('the system proxy is off')), 'main says the window took the environment\'s proxy')
  }
}

let orbit = null
const timeout = setTimeout(() => { console.error('I29 stage check exceeded 150 s'); app.exit(1) }, 150000)
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
