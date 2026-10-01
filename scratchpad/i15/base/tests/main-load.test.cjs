const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

// main.cjs and preload.cjs only run inside Electron, so nothing else in the default gate executes them.
// An edit that breaks their loading would still pass typecheck and unit tests, and the broken files would be
// the ones Orbit.cmd starts from this repository. Loading them against a stub catches that. The stub's utilityProcess
// hands out fake runtime processes (FakeRuntime below), so the flows of the child mode run here without a real child,
// and main's node:child_process is replaced so that nothing (the self-upgrade script) is really spawned.
const repo = path.resolve(__dirname, '..')

// `overrides` replace what main.cjs and the runtime client it drives require; the client is loaded afresh for that (it
// kills process trees and reads the process table, which must never run for real against the fake runtimes here).
const CLIENT = require.resolve('../electron/runtime-client.cjs')
function loadWithElectron(file, stub, { loaded = [], overrides = {} } = {}) {
  const original = Module._load
  const resolved = require.resolve(file)
  const replaced = new Set([resolved, CLIENT])
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return stub
    if (replaced.has(parent?.filename) && Object.hasOwn(overrides, request)) return overrides[request]
    try { loaded.push(Module._resolveFilename(request, parent)) } catch { /* Reported by the load itself. */ }
    return original.call(this, request, parent, ...rest)
  }
  delete require.cache[resolved]
  if (Object.keys(overrides).length) delete require.cache[CLIENT]
  try { return require(resolved) } finally { Module._load = original; delete require.cache[resolved] }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await delay(5)
  }
}

// Made-up pids no system hands out, so that nothing real could ever be hit by one.
let pidSerial = 1_000_000_000
// A runtime process as utilityProcess.fork returns it: it spawns, reports ready (`slow`: 100 ms later; or fails with
// `fatal`), echoes calls and exits after `shutdown-done`.
class FakeRuntime extends EventEmitter {
  constructor(modulePath, args, options, behaviour) {
    super()
    Object.assign(this, { modulePath, args, options, behaviour, pid: undefined, stdout: null, stderr: null, received: [], exited: false, osPid: ++pidSerial })
    const ready = () => { if (!this.exited) this.emit('message', { t: 'ready', pid: this.osPid, ms: 12, protocol: require('../electron/runtime-protocol.mts').PROTOCOL_VERSION }) }
    setImmediate(() => {
      this.pid = this.osPid
      this.emit('spawn')
      if (behaviour === 'fatal') { this.emit('message', { t: 'fatal', error: { message: 'SyntaxError in runtime.mts' } }); this.exitWith(1) }
      else if (behaviour === 'slow') setTimeout(ready, 100)
      else ready()
    })
  }
  postMessage(message) {
    this.received.push(structuredClone(message))
    setImmediate(() => {
      if (message.t === 'call') this.emit('message', { t: 'result', id: message.id, ok: true, value: { channel: message.channel, args: message.args, pid: this.osPid } })
      if (message.t === 'shutdown') { this.emit('message', { t: 'shutdown-done', marked: [] }); this.exitWith(0) }
    })
  }
  kill() { this.exitWith(1); return true }
  exitWith(code) {
    if (this.exited) return
    this.exited = true
    setImmediate(() => { this.pid = undefined; this.emit('exit', code) })
  }
  of(type) { return this.received.filter(message => message.t === type) }
}

// `runtime`: the behaviour of every fake runtime process, or a list of them (one per fork, the last one repeats).
// `fingerprint`: a replacement for electron/fingerprint.cjs (the code hashes main compares).
// `proxyEnv`: the proxy variables main starts with (none otherwise, whatever this machine has); `systemRoute`: what
// the system's proxy settings answer for any URL.
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
function loadMain({ lock = true, ready = false, healthFile = '0', mode, argv = [], userData = os.tmpdir(), runtime = 'ok', isPackaged = false, loaded = [], fingerprint, proxyEnv = {}, systemRoute = 'PROXY main-session.example:8080; DIRECT' } = {}) {
  const handlers = new Map(), appEvents = [], appHandlers = new Map(), calls = { relaunch: [], exit: [], quit: 0, lock: [] }
  const windows = [], forks = [], dialogs = [], opened = [], spawned = [], proxyLookups = [], proxySets = [], executed = []
  const privileged = [], protocols = new Map(), webRequests = []
  const behaviourOf = (index) => (Array.isArray(runtime) ? runtime[Math.min(index, runtime.length - 1)] : runtime)
  const saved = { ORBIT_USER_DATA: process.env.ORBIT_USER_DATA, ORBIT_HEALTH_FILE: process.env.ORBIT_HEALTH_FILE, ORBIT_RUNTIME_MODE: process.env.ORBIT_RUNTIME_MODE, ...Object.fromEntries(PROXY_NAMES.map(name => [name, process.env[name]])) }
  for (const name of PROXY_NAMES) delete process.env[name]
  Object.assign(process.env, proxyEnv)
  delete process.env.ORBIT_USER_DATA
  process.env.ORBIT_HEALTH_FILE = healthFile // '0': no health report file and no crash hook from a test process
  if (mode) process.env.ORBIT_RUNTIME_MODE = mode; else delete process.env.ORBIT_RUNTIME_MODE
  const crashHooks = process.listeners('uncaughtException')
  process.argv.push(...argv)
  // The members of BrowserWindow main.cjs uses. The test fires the first did-finish-load; a reload fires it by itself.
  // The renderer check answers healthy, except for as many IPC round trips as `failPings` says; `beforePing` runs
  // first when a test sets it.
  class FakeWindow {
    static getAllWindows() { return windows.filter(win => !win.destroyed) }
    constructor(options) {
      const events = new EventEmitter()
      Object.assign(this, { options, destroyed: false, sent: [], reloads: 0, failPings: 0, beforePing: null })
      const reload = () => { this.reloads++; setImmediate(() => events.emit('did-finish-load')) }
      this.webContents = {
        setWindowOpenHandler() {}, on: (event, listener) => events.on(event, listener), once: (event, listener) => events.once(event, listener),
        removeListener: (event, listener) => events.removeListener(event, listener),
        fire: (event, ...args) => events.emit(event, ...args),
        executeJavaScript: async (code) => {
          if (!code.includes('ping')) return true
          if (this.beforePing) await this.beforePing()
          if (this.failPings > 0) { this.failPings--; return { pid: -1 } }
          return { pid: process.pid }
        },
        getURL: () => 'file:///C:/orbit/dist/index.html',
        send: (channel, payload) => this.sent.push([channel, payload]),
        reload, reloadIgnoringCache: reload,
      }
      windows.push(this)
    }
    setMenuBarVisibility() {}
    loadFile() { return Promise.resolve() }
    loadURL() { return Promise.resolve() }
    once() {}
    show() {}
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    restore() {}
    focus() {}
  }
  const fakeChildProcess = {
    ...childProcess,
    spawn: (file, args, options) => {
      const child = Object.assign(new EventEmitter(), { unref() {} })
      spawned.push({ file, args, options, child })
      return child
    },
    // taskkill of a runtime's tree and the PowerShell process table (runtime-client.cjs): recorded, never run.
    execFile: (file, args, options, callback) => {
      executed.push({ file, args })
      setImmediate(() => { if (typeof callback === 'function') callback(null, '', '') })
      return new EventEmitter()
    },
  }
  let exported
  try {
    exported = loadWithElectron('../electron/main.cjs', {
      app: {
        isPackaged,
        requestSingleInstanceLock: (data) => { calls.lock.push(data); return lock },
        on: (event, handler) => { appEvents.push(event); appHandlers.set(event, handler) },
        quit() { calls.quit++ }, exit: (code) => calls.exit.push(code), relaunch: (options) => calls.relaunch.push(options), setPath() {},
        getPath: () => userData, getVersion: () => '0.0.0-test',
        whenReady: () => (ready ? Promise.resolve() : new Promise(() => {})), // pending: no runtime, no window
      },
      BrowserWindow: FakeWindow,
      dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 1 } }, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() {} },
      shell: { openExternal: async (url) => { opened.push(url) }, openPath: async (target) => { opened.push(`path:${target}`); return '' } },
      // The window's session, which main may set the environment's proxy on, and a partition left on the system's settings.
      session: {
        defaultSession: { resolveProxy: async (url) => { proxyLookups.push(`window ${url}`); return 'DIRECT' }, setProxy: async (config) => { proxySets.push(config) }, webRequest: { onBeforeSendHeaders: (filter, listener) => { webRequests.push({ filter, listener }) } } },
        fromPartition: (partition) => ({ resolveProxy: async (url) => { proxyLookups.push(`${partition} ${url}`); return systemRoute } }),
      },
      protocol: { registerSchemesAsPrivileged: (schemes) => { schemes.forEach(scheme => privileged.push(scheme)) }, handle: (scheme, handler) => { protocols.set(scheme, handler) } },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      utilityProcess: { fork: (modulePath, args, options) => { const child = new FakeRuntime(modulePath, args, options, behaviourOf(forks.length)); forks.push(child); return child } },
    }, { loaded, overrides: { 'node:child_process': fakeChildProcess, ...(fingerprint ? { './fingerprint.cjs': fingerprint } : {}) } })
  } finally {
    process.argv.splice(process.argv.length - argv.length, argv.length)
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    // With a health file main.cjs installs a process-wide crash hook that exits the process; a test must not keep it.
    for (const listener of process.listeners('uncaughtException')) if (!crashHooks.includes(listener)) process.removeListener('uncaughtException', listener)
  }
  return { handlers, appEvents, appHandlers, calls, exported, windows, forks, dialogs, opened, spawned, proxyLookups, proxySets, executed, privileged, protocols, webRequests }
}

const trusted = { sender: { isDestroyed: () => false, getURL: () => 'file:///C:/orbit/dist/index.html' }, senderFrame: { url: 'file:///C:/orbit/dist/index.html', parent: null } }
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const recordRunning = spawned => spawned.filter(entry => entry.args[1] === '--record-running')
const { rendererHash } = require('../electron/fingerprint.cjs')

test('the main process loads and registers its IPC channels', () => {
  const { handlers, appEvents } = loadMain()
  for (const channel of ['runtime:start', 'runtime:stop', 'runtime:list', 'runtime:get', 'runtime:changes', 'state:load', 'state:save', 'providers:health', 'quota:get', 'workspace:pick', 'memory:list', 'memory:pin', 'memory:stats', 'memory:forget-chat', 'memory:sharing', 'capabilities:list', 'capabilities:pin', 'app:ping', 'app:relaunch', 'runtime:restart', 'runtime:status']) {
    assert.ok(handlers.has(channel), `${channel} is registered`)
  }
  assert.ok(!handlers.has('providers:ask'), 'the direct, unguarded provider channel stays removed')
  // Channels the renderer never called (wave 2 audit): a stub, a runtime-internal path and a store the runtime reads itself.
  for (const channel of ['runtime:route-message', 'runtime:spawn-subagent', 'project-context:get', 'memory:search']) {
    assert.ok(!handlers.has(channel), `${channel} stays out of the surface`)
  }
  assert.deepEqual([...handlers.keys()].sort(), require('../electron/ipc-contract.cjs').callChannels().sort(), 'the registered channels are exactly the contract')
  assert.ok(appEvents.includes('before-quit') && appEvents.includes('window-all-closed') && appEvents.includes('second-instance'))
})

test('an Orbit started from an agent\'s command (the self-upgrade watcher) drops the names of that agent\'s run', () => {
  const names = ['ORBIT_RUN_ID', 'ORBIT_CHAT_ID', 'ORBIT_PROJECT_ID', 'ORBIT_AGENT_ID', 'ORBIT_RESUME_FILE', 'ORBIT_RESTART_SOURCE']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) process.env[name] = `stale-${name}`
    loadMain()
    for (const name of names) assert.equal(process.env[name], undefined, `${name} is removed`)
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] }
  }
})

test('in child mode main loads only shell files, also once the runtime runs: a runtime change needs no relaunch', async () => {
  // Every require made while main loads, starts its runtime process and forwards a call (lazy requires included). The
  // CommonJS modules earlier tests loaded are evaluated again, so their own requires are seen too.
  for (const file of Object.keys(require.cache)) if (file.startsWith(path.join(repo, 'electron') + path.sep) && file.endsWith('.cjs')) delete require.cache[file]
  const loaded = []
  const original = Module._load
  Module._load = function (request, parent, ...rest) {
    try { loaded.push(Module._resolveFilename(request, parent)) } catch { /* Not a file. */ }
    return original.call(this, request, parent, ...rest)
  }
  let exported
  try {
    const main = loadMain({ ready: true, loaded })
    exported = main.exported
    await until(() => main.forks.length === 1 && main.windows.length === 1, 'runtime started')
    await main.handlers.get('state:load')(trusted)
  } finally {
    Module._load = original
  }
  await exported.shutdownRuntime('quit')
  const { SHELL_FILES } = require('../electron/fingerprint.cjs')
  const electronDir = path.join(repo, 'electron') + path.sep
  const local = [...new Set(loaded.filter(file => path.isAbsolute(file) && file.startsWith(electronDir)))].map(file => path.relative(repo, file).split(path.sep).join('/'))
  assert.ok(local.includes('electron/runtime-client.cjs') && local.includes('electron/git.mts') && local.includes('electron/runtime-protocol.mts'))
  for (const file of local) assert.ok(SHELL_FILES.includes(file), `main.cjs loads ${file}, which is not in SHELL_FILES of electron/fingerprint.cjs`)
  for (const runtimeModule of ['electron/runtime.mts', 'electron/runtime-host.mts', 'electron/run-store.mts', 'electron/memory.mts', 'electron/providers.mts', 'electron/quota.mts']) {
    assert.ok(!local.includes(runtimeModule), `main.cjs must not load ${runtimeModule} in child mode`)
  }
  // The shell's ES modules must not pull runtime modules in through their own imports either.
  for (const file of local.filter(name => name.endsWith('.mts'))) {
    const imports = fs.readFileSync(path.join(repo, file), 'utf8').match(/^import (?!type\b)[^\n]*from '\.[^']*'/gm) || []
    assert.deepEqual(imports, [], `${file} imports electron/ modules at run time`)
  }
})

test('orbit-skill:// serves the files of a skill package and nothing else; shell:open-path opens only attachments and skill packages', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-skills-'))
  const main = loadMain({ ready: true, userData })
  try {
    fs.mkdirSync(path.join(userData, 'skills', 'party'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'skills', 'party', 'page.html'), '<h1>party</h1>')
    fs.writeFileSync(path.join(userData, 'secret.txt'), 'private')
    await until(() => main.protocols.has('orbit-skill') && main.forks.length === 1 && main.windows.length === 1, 'the scheme is served once the app is ready')
    assert.deepEqual(main.privileged.map(item => item.scheme), ['orbit-skill'])
    assert.equal(main.privileged[0].privileges.standard, true); assert.equal(main.privileged[0].privileges.secure, true)
    const serve = main.protocols.get('orbit-skill')
    const page = await serve(new Request('orbit-skill://party/page.html'))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.equal(await page.text(), '<h1>party</h1>')
    // No host but the YouTube frame: a page cannot send what it read anywhere.
    const csp = page.headers.get('content-security-policy')
    for (const rule of ["default-src 'self'", "connect-src 'self'", "form-action 'none'", 'frame-src https://www.youtube.com https://www.youtube-nocookie.com']) assert.ok(csp.includes(rule), rule)
    assert.doesNotMatch(csp, /\*|https?:(?!\/\/www\.youtube)/, 'no wildcard or other web host')
    // Its frame may move only within its own package.
    const [win] = main.windows
    const navigate = (from, to, isMainFrame = false) => { let prevented = false; win.webContents.fire('will-frame-navigate', { url: to, isMainFrame, frame: { url: from }, preventDefault: () => { prevented = true } }); return prevented }
    assert.equal(navigate('orbit-skill://party/page.html', 'https://evil.example/?data=secret'), true)
    assert.equal(navigate('orbit-skill://party/page.html', 'orbit-skill://other/page.html'), true)
    assert.equal(navigate('orbit-skill://party/page.html', 'orbit-skill://party/next.html'), false)
    assert.equal(navigate('https://www.youtube.com/embed/x', 'https://www.youtube.com/embed/y'), false, 'the player frame is not a skill page')
    assert.equal(navigate('', 'orbit-skill://party/page.html'), false, 'the stage opening a page')
    for (const url of ['orbit-skill://party/%2e%2e/%2e%2e/secret.txt', 'orbit-skill://party/..%2f..%2fsecret.txt', 'orbit-skill://party/missing.html', 'orbit-skill://party/', 'orbit-skill://other/page.html']) {
      assert.equal((await serve(new Request(url))).status, 404, url)
    }
    // YouTube's embed gets a web Referer when the page sends none or its own scheme's; the player's own requests keep theirs.
    const [hook] = main.webRequests
    const referer = (headers) => new Promise(resolve => hook.listener({ requestHeaders: headers }, ({ requestHeaders }) => resolve(requestHeaders.Referer)))
    assert.equal(await referer({}), 'https://orbit.local/')
    assert.equal(await referer({ Referer: 'orbit-skill://party/' }), 'https://orbit.local/')
    assert.equal(await referer({ Referer: 'https://www.youtube.com/embed/x' }), 'https://www.youtube.com/embed/x')
    const open = main.handlers.get('shell:open-path')
    assert.equal(await open(trusted, path.join(userData, 'skills', 'party')), '')
    assert.equal(await open(trusted, path.join(userData, 'attachments', 'chat', 'a.png')), '')
    for (const target of [path.join(userData, 'secret.txt'), path.join(userData, 'skills', '..', 'secret.txt'), '', 'C:\Windows']) {
      await assert.rejects(async () => open(trusted, target), /Only Orbit attachments and skill packages/, String(target))
    }
    assert.deepEqual(main.opened, [`path:${path.join(userData, 'skills', 'party')}`, `path:${path.join(userData, 'attachments', 'chat', 'a.png')}`])
  } finally {
    await main.exported.shutdownRuntime('quit')
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('main answers its own channels and forwards every other one to the runtime: exactly the contract', () => {
  const { SHELL_CHANNELS, RUNTIME_CHANNELS } = require('../electron/runtime-protocol.mts')
  const contract = require('../electron/ipc-contract.cjs').callChannels()
  assert.deepEqual([...SHELL_CHANNELS, ...RUNTIME_CHANNELS].sort(), [...contract].sort())
  assert.equal(new Set([...SHELL_CHANNELS, ...RUNTIME_CHANNELS]).size, contract.length, 'no channel is both')
})

test('every IPC channel refuses a sender that is not Orbit\'s own window', () => {
  const { handlers } = loadMain()
  const foreign = { sender: { isDestroyed: () => false, getURL: () => 'https://evil.example' }, senderFrame: { url: 'https://evil.example', parent: null } }
  const nested = { sender: { isDestroyed: () => false, getURL: () => 'file:///C:/orbit/dist/index.html' }, senderFrame: { url: 'file:///C:/orbit/dist/index.html', parent: { url: 'file:///C:/orbit/dist/index.html' } } }
  assert.ok(handlers.size >= 20)
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler(foreign, {}), /Unauthorized IPC origin/, `${channel} must reject a foreign origin`)
    assert.throws(() => handler(nested, {}), /Unauthorized IPC frame/, `${channel} must reject a nested frame`)
  }
})

test('every call the preload exposes has a main-process handler behind it', () => {
  const { handlers } = loadMain()
  const invoked = []
  const exposed = {}
  loadWithElectron('../electron/preload.cjs', {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
    ipcRenderer: { invoke: (channel) => { invoked.push(channel); return Promise.resolve() }, on() {}, removeListener() {} },
  })
  assert.ok(exposed.orbit && typeof exposed.orbit.startTask === 'function')
  assert.equal(typeof exposed.orbit.relaunch, 'function', 'window.orbit.relaunch() exists for the UI and the upgrade loop')
  assert.equal(typeof exposed.orbit.ping, 'function', 'window.orbit.ping() is the health round trip')
  // Event subscriptions (the contract's push entries) listen instead of invoking; each is checked below for its unsubscribe function.
  const subscriptions = require('../electron/ipc-contract.cjs').EVENTS.map(entry => entry.method)
  for (const [name, member] of Object.entries(exposed.orbit)) {
    if (typeof member !== 'function' || subscriptions.includes(name)) continue
    invoked.length = 0
    member('a', 'b', 'c')
    assert.equal(invoked.length, 1, `${name} performs one invoke`)
    assert.ok(handlers.has(invoked[0]), `${name} -> ${invoked[0]} has a handler`)
  }
  for (const name of subscriptions) assert.equal(typeof exposed.orbit[name](() => {}), 'function', `${name} returns an unsubscribe function`)
})

test('app:ping answers with this process, so the health check proves a renderer → main → renderer round trip', () => {
  const { handlers } = loadMain()
  const reply = handlers.get('app:ping')(trusted)
  assert.equal(reply.pid, process.pid)
  assert.ok(Number.isFinite(reply.startedAt) && reply.startedAt <= Date.now())
  assert.equal(reply.healthy, false, 'no health report has been written in a test process')
})

test('before the runtime exists, runtime calls fail clearly and the status says starting', async () => {
  const { handlers } = loadMain()
  await assert.rejects(handlers.get('state:load')(trusted), /runtime has not started yet/)
  assert.deepEqual((({ state, mode, pid, restarts, retrying }) => ({ state, mode, pid, restarts, retrying }))(handlers.get('runtime:status')(trusted)), { state: 'starting', mode: 'child', pid: null, restarts: 0, retrying: false })
  assert.deepEqual(await handlers.get('runtime:restart')(trusted), { ok: false, ms: 0, pid: null, error: 'The runtime has not started yet' })
})

test('the runtime mode: a child process from the repository, inside main in a packaged build unless ORBIT_RUNTIME_MODE says otherwise', () => {
  const mode = options => loadMain(options).handlers.get('runtime:status')(trusted).mode
  assert.equal(mode({}), 'child')
  assert.equal(mode({ isPackaged: true }), 'inprocess')
  assert.equal(mode({ isPackaged: true, mode: 'child' }), 'child')
  assert.equal(mode({ mode: 'inprocess' }), 'inprocess')
  assert.equal(mode({ mode: 'bogus' }), 'child')
})

test('a second instance started with --relaunch makes the running one shut its runtime down and restart without the flag', async () => {
  const { appHandlers, calls, exported } = loadMain()
  assert.deepEqual(calls.lock, [{ relaunch: false, restartRuntime: false, reloadRenderer: false }], 'the lock request carries which restart this start asks for')
  const secondInstance = appHandlers.get('second-instance')
  secondInstance({}, ['electron.exe', 'C:\\repo'], 'C:\\', { relaunch: false })
  assert.deepEqual([calls.relaunch.length, calls.exit.length], [0, 0], 'an ordinary second instance only focuses the window')
  secondInstance({}, ['electron.exe', 'C:\\repo', '--relaunch'], 'C:\\', { relaunch: true })
  secondInstance({}, ['electron.exe', 'C:\\repo', '--relaunch'], 'C:\\', { relaunch: true })
  await delay(100)
  assert.equal(calls.relaunch.length, 1, 'a repeated signal while the relaunch runs does not relaunch twice')
  assert.deepEqual(calls.relaunch[0], { args: process.argv.slice(1).filter((arg) => !['--relaunch', '--restart-runtime', '--reload-renderer'].includes(arg)) })
  assert.deepEqual(calls.exit, [0])
  assert.equal(exported.isRelaunchSignal(['electron.exe', 'x'], undefined), false)
  assert.equal(exported.isRelaunchSignal(['electron.exe', 'x'], { relaunch: true }), true, 'additionalData is the reliable channel when Chromium rewrites argv')
  assert.deepEqual(exported.relaunchArgs(['electron.exe', 'C:\\repo', '--relaunch', '--other']), ['C:\\repo', '--other'])
  assert.deepEqual(exported.relaunchArgs(['Orbit.exe', '--relaunch']), [], 'a packaged exe relaunches with no app path')
})

test('the new restart flags are recognised: --restart-runtime and --reload-renderer, from argv or additionalData', () => {
  const { exported } = loadMain()
  const { restartSignal, relaunchArgs } = exported
  assert.equal(restartSignal(['electron.exe', 'C:\\repo', '--restart-runtime'], undefined), 'restart-runtime')
  assert.equal(restartSignal(['electron.exe'], { restartRuntime: true }), 'restart-runtime')
  assert.equal(restartSignal(['electron.exe', '--reload-renderer'], null), 'reload-renderer')
  assert.equal(restartSignal(['electron.exe'], { reloadRenderer: true }), 'reload-renderer')
  assert.equal(restartSignal(['electron.exe', '--reload-renderer', '--relaunch'], null), 'relaunch', 'the strongest request wins')
  assert.equal(restartSignal(['electron.exe', '--restart-runtime'], { reloadRenderer: true }), 'restart-runtime')
  assert.equal(restartSignal(['electron.exe', 'C:\\repo'], {}), null)
  assert.deepEqual(relaunchArgs(['electron.exe', 'C:\\repo', '--restart-runtime', '--reload-renderer', '--x']), ['C:\\repo', '--x'], 'a relaunch never carries a restart flag')
  const losing = loadMain({ lock: false, argv: ['--restart-runtime'] })
  assert.deepEqual(losing.calls.lock, [{ relaunch: false, restartRuntime: true, reloadRenderer: false }], 'a signalling start tells the running instance which restart it wants')
  assert.equal(losing.calls.quit, 1)
})

test('app:relaunch from the window replies first and then restarts the process', async () => {
  const { handlers, calls } = loadMain()
  const reply = handlers.get('app:relaunch')(trusted)
  assert.deepEqual(reply, { ok: true, pid: process.pid })
  assert.equal(calls.relaunch.length, 0, 'the reply leaves before the relaunch starts')
  await delay(100)
  assert.equal(calls.relaunch.length, 1)
  assert.deepEqual(calls.exit, [0])
})

test('a losing instance quits at once, with or without the relaunch flag', () => {
  const { handlers, calls, appEvents } = loadMain({ lock: false })
  assert.equal(calls.quit, 1)
  assert.equal(handlers.size, 0, 'no channels are registered by the instance that quits')
  assert.ok(!appEvents.includes('second-instance'))
})

test('the health report records the commit of this repository without spawning git', () => {
  const { exported } = loadMain()
  const expected = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim()
  assert.match(expected, /^[0-9a-f]{40}$/)
  assert.equal(exported.readHeadCommit(repo), expected)
  assert.equal(exported.readHeadCommit(os.tmpdir()), null, 'outside a repository the commit is unknown, not an error')
})

test('child mode: the runtime process is forked, a runtime channel is forwarded, a main channel is served by main, events and approvals flow', async () => {
  const { handlers, forks, windows, dialogs, opened, appHandlers, calls, spawned, proxyLookups } = loadMain({ ready: true })
  await until(() => forks.length === 1 && windows.length === 1, 'runtime forked and window created')
  const [runtime] = forks
  assert.equal(runtime.modulePath, path.join(repo, 'electron', 'runtime-child.cjs'))
  assert.deepEqual([runtime.options.serviceName, runtime.options.stdio, runtime.options.env.ORBIT_USER_DATA_DIR, runtime.options.env.ORBIT_REPO_ROOT], ['Orbit runtime', 'pipe', os.tmpdir(), repo])
  // A runtime channel: the arguments reach the runtime process as the window sent them, the answer comes back.
  assert.deepEqual(await handlers.get('memory:list')(trusted, 'C:\\ws', 'chat-1'), { channel: 'memory:list', args: ['C:\\ws', 'chat-1'], pid: runtime.osPid })
  assert.deepEqual(runtime.of('call').map(message => [message.channel, message.args]), [['memory:list', ['C:\\ws', 'chat-1']]])
  // Main's own channels never reach the runtime.
  await handlers.get('shell:open')(trusted, 'https://example.com/docs')
  assert.deepEqual(opened, ['https://example.com/docs'])
  assert.throws(() => handlers.get('shell:open')(trusted, 'file:///C:/secret'), /Only http\(s\) links/)
  const status = handlers.get('runtime:status')(trusted)
  assert.deepEqual([status.state, status.mode, status.pid], ['ready', 'child', runtime.osPid])
  assert.equal(runtime.of('call').length, 1, 'shell:open and runtime:status were answered by main')
  // Events: the runtime's pushes reach the window on the same channel, a foreign channel does not.
  runtime.emit('message', { t: 'event', channel: 'runtime:event', payload: { type: 'run.started' } })
  runtime.emit('message', { t: 'event', channel: 'quota:update', payload: { providerId: 'codex', snapshot: null } })
  runtime.emit('message', { t: 'event', channel: 'restart:notice', payload: { kind: 'resumed' } })
  runtime.emit('message', { t: 'event', channel: 'secret:thing', payload: 1 })
  const pushed = windows[0].sent.filter(([channel]) => channel !== 'runtime:status-changed')
  assert.deepEqual(pushed, [['runtime:event', { type: 'run.started' }], ['quota:update', { providerId: 'codex', snapshot: null }], ['restart:notice', { kind: 'resumed' }]])
  assert.ok(windows[0].sent.some(([channel, payload]) => channel === 'runtime:status-changed' && payload.state === 'ready'), 'the window hears the runtime status')
  // An approval question opens main's dialog; the answer goes back to the runtime.
  runtime.emit('message', { t: 'approval', id: 'q1', request: { tool: 'write_file', arguments: { path: 'approved.txt' }, runId: 'r1', agentId: 'a1', agentName: 'Проверка', workspace: 'C:\\ws' } })
  await until(() => runtime.of('approval-result').length === 1, 'approval answered')
  assert.ok(dialogs[0].message.includes('Проверка') && dialogs[0].detail.includes('approved.txt'))
  assert.deepEqual(runtime.of('approval-result'), [{ t: 'approval-result', id: 'q1', approved: true }])
  // The runtime has no Electron session: main resolves the system proxy for it with a session left on the system's
  // settings (the window's may go through the environment's proxy).
  runtime.emit('message', { t: 'resolve-proxy', id: 'p1', url: 'https://daily-cloudcode-pa.googleapis.com' })
  await until(() => runtime.of('proxy-result').length === 1, 'proxy answered')
  assert.deepEqual(runtime.of('proxy-result'), [{ t: 'proxy-result', id: 'p1', route: 'PROXY main-session.example:8080; DIRECT' }])
  assert.deepEqual(proxyLookups, ['orbit-system-proxy https://daily-cloudcode-pa.googleapis.com'])
  // Quitting waits for the runtime once: before-quit is held, the runtime shuts down, then Orbit quits.
  let prevented = 0
  appHandlers.get('before-quit')({ preventDefault: () => { prevented++ } })
  appHandlers.get('before-quit')({ preventDefault: () => { prevented++ } })
  assert.equal(prevented, 2)
  await until(() => calls.quit === 1, 'quit after the runtime shut down')
  assert.deepEqual(runtime.of('shutdown'), [{ t: 'shutdown', mode: 'quit' }], 'one shutdown, however often quit is asked for')
  prevented = 0
  appHandlers.get('before-quit')({ preventDefault: () => { prevented++ } })
  assert.equal(prevented, 0, 'the second pass lets the quit through')
  assert.deepEqual(spawned, [], 'without a health file nothing records the running sources')
})

test('health: the start is reported once the renderer AND the runtime are ready; a renderer reload and a runtime restart are later generations', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, appHandlers, handlers, exported, spawned } = loadMain({ ready: true, healthFile })
  try {
    await until(() => forks.length === 1 && windows.length === 1, 'started')
    const [win] = windows
    const secondInstance = appHandlers.get('second-instance')
    await delay(20)
    assert.equal(fs.existsSync(healthFile), false, 'no report before the page loaded')
    win.webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile), 'start reported')
    const first = readJson(healthFile)
    assert.equal(first.ok, true, first.error)
    assert.deepEqual([first.level, first.generation, first.restartedAt], ['full', 1, first.startedAt])
    assert.match(first.shellHash, /^[0-9a-f]{40}$/)
    assert.match(first.runtimeHash, /^[0-9a-f]{40}$/)
    // What the window runs: the build record of dist/ when there is one, else the renderer inputs on disk.
    assert.match(first.rendererHash, /^[0-9a-f]{40}$/)
    assert.ok(['build', 'files'].includes(first.rendererSource), first.rendererSource)
    if (first.rendererSource === 'files') assert.equal(first.rendererHash, rendererHash(repo))
    else assert.equal(first.rendererHash, readJson(path.join(repo, 'dist', 'orbit-build.json')).rendererHash)
    assert.deepEqual(first.runtime, { mode: 'child', ready: true, pid: forks[0].osPid, ms: first.runtime.ms })
    assert.ok(Number.isFinite(first.runtime.ms))
    const commit = exported.readHeadCommit(repo)
    assert.deepEqual(forks[0].of('renderer-healthy'), [{ t: 'renderer-healthy', info: { level: 'full', commit } }], 'a healthy start is told to the runtime')
    // A healthy start from the repository records the running sources as the rollback base, detached.
    assert.equal(recordRunning(spawned).length, 1)
    const [record] = spawned
    assert.deepEqual([record.file, record.options.detached, record.options.stdio, record.options.cwd], ['node', true, 'ignore', os.tmpdir()])
    // The instance and its code hashes go along (the renderer hash of this very report): the script may not read this
    // health file.
    assert.deepEqual(record.args, [path.join(repo, 'scripts', 'self-upgrade.cjs'), '--record-running', '--pid', String(process.pid), '--started-at', String(first.startedAt), '--shell-hash', first.shellHash, '--runtime-hash', first.runtimeHash, '--renderer-hash', first.rendererHash])
    // Without node on PATH, Electron's binary runs the script as Node.
    record.child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))
    assert.equal(spawned.length, 2)
    assert.deepEqual([spawned[1].file, spawned[1].args, spawned[1].options.env.ELECTRON_RUN_AS_NODE], [process.execPath, record.args, '1'])
    // Another spawn failure is only logged.
    spawned[1].child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }))
    assert.equal(spawned.length, 2)

    secondInstance({}, ['electron.exe', repo, '--reload-renderer'], repo, { reloadRenderer: true })
    await until(() => readJson(healthFile).generation === 2, 'renderer reload reported')
    const reload = readJson(healthFile)
    assert.deepEqual([reload.ok, reload.level, reload.runtime.pid, win.reloads], [true, 'renderer', forks[0].osPid, 1])
    assert.ok(reload.restartedAt > first.restartedAt && reload.writtenAt >= reload.restartedAt)
    assert.equal(forks.length, 1, 'a renderer reload leaves the runtime alone')
    // A healthy reload records the running sources too: a later rollback must not put src/ back to what the start ran.
    assert.equal(recordRunning(spawned).length, 3)
    assert.deepEqual(recordRunning(spawned)[2].args.slice(-2), ['--renderer-hash', reload.rendererHash])

    const signalled = Date.now()
    secondInstance({}, ['electron.exe', repo, '--restart-runtime'], repo, { restartRuntime: true })
    await until(() => readJson(healthFile).generation === 3, 'runtime restart reported')
    const restart = readJson(healthFile)
    assert.deepEqual([restart.ok, restart.level, restart.runtime.mode, restart.runtime.ready, restart.runtime.pid], [true, 'runtime', 'child', true, forks[1].osPid])
    assert.ok(restart.restartedAt >= signalled, 'fresh for the script that signalled')
    assert.ok(Number.isFinite(restart.ipcMs), 'the window was checked again after the runtime restart')
    assert.match(restart.runtimeHash, /^[0-9a-f]{40}$/)
    assert.deepEqual(forks[0].of('shutdown'), [{ t: 'shutdown', mode: 'restart' }])
    assert.deepEqual(forks[1].of('renderer-healthy'), [{ t: 'renderer-healthy', info: { level: 'runtime', commit } }])
    assert.equal(win.reloads, 1, 'the window stays open through a runtime restart')
    assert.equal(recordRunning(spawned).length, 4, 'a healthy runtime restart records the running sources')

    // The window's own restart request: a generation too, answered with the new runtime's pid.
    const reply = await handlers.get('runtime:restart')(trusted)
    assert.deepEqual(reply, { ok: true, ms: reply.ms, pid: forks[2].osPid })
    assert.equal(readJson(healthFile).generation, 4)
    const status = handlers.get('runtime:status')(trusted)
    assert.deepEqual([status.state, status.restarts, status.lastRestartMs], ['ready', 2, reply.ms])
    assert.deepEqual(await handlers.get('state:load')(trusted), { channel: 'state:load', args: [], pid: forks[2].osPid }, 'calls go to the newest runtime')

    // Requests during a restart: that restart may predate the code they are about, so one more follows, shared by them.
    const [one, two, three] = await Promise.all([1, 2, 3].map(() => handlers.get('runtime:restart')(trusted)))
    assert.deepEqual([one.pid, two.pid, three.pid], [forks[3].osPid, forks[4].osPid, forks[4].osPid])
    assert.deepEqual([forks.length, readJson(healthFile).generation, readJson(healthFile).ok], [5, 6, true])
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('restart signals that arrive before the start is reported wait for that report, so theirs is a later generation', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, appHandlers, exported } = loadMain({ ready: true, healthFile })
  try {
    await until(() => forks.length === 1 && windows.length === 1, 'started')
    appHandlers.get('second-instance')({}, ['electron.exe', repo, '--reload-renderer'], repo, { reloadRenderer: true })
    appHandlers.get('second-instance')({}, ['electron.exe', repo, '--restart-runtime'], repo, { restartRuntime: true })
    await delay(30)
    assert.deepEqual([windows[0].reloads, forks.length, fs.existsSync(healthFile)], [0, 1, false], 'nothing restarts before the start is reported')
    windows[0].webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile) && readJson(healthFile).generation === 3, 'both signals handled after the start report')
    assert.deepEqual([windows[0].reloads, forks.length], [1, 2])
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('health: after a runtime restart the window is checked again; one reload is allowed, a second failure makes the restart unhealthy', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, handlers, exported, spawned } = loadMain({ ready: true, healthFile })
  try {
    await until(() => windows.length === 1, 'window created')
    const [win] = windows
    win.webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile) && readJson(healthFile).ok, 'start reported')
    win.failPings = 1
    const recovered = await handlers.get('runtime:restart')(trusted)
    assert.deepEqual([recovered.ok, recovered.pid, win.reloads], [true, forks[1].osPid, 1], 'the reload fixed the window')
    assert.deepEqual([readJson(healthFile).generation, readJson(healthFile).ok], [2, true])
    win.failPings = 2
    const failed = await handlers.get('runtime:restart')(trusted)
    assert.equal(failed.ok, false)
    assert.match(failed.error, /renderer check failed after the runtime restart and one reload: IPC round trip returned an unexpected reply/)
    const health = readJson(healthFile)
    assert.deepEqual([health.generation, health.ok, health.level, win.reloads], [3, false, 'runtime', 2])
    assert.deepEqual(forks[2].of('renderer-healthy'), [], 'an unhealthy restart does not continue a pending task')
    assert.equal(recordRunning(spawned).length, 2, 'and records nothing')
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('health: a runtime that fails to start makes the start unhealthy', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { windows, exported, spawned } = loadMain({ ready: true, healthFile, runtime: 'fatal' })
  try {
    await until(() => windows.length === 1, 'window created')
    windows[0].webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile), 'start reported')
    const health = readJson(healthFile)
    assert.equal(health.ok, false)
    assert.match(health.error, /^runtime failed to start: SyntaxError in runtime\.mts/)
    assert.equal(health.generation, 1)
    assert.deepEqual(spawned, [], 'a failed start records nothing')
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

// Chromium reads only the system's proxy settings; the agents' CLIs go through HTTP(S)_PROXY (electron/window-proxy.cjs).
test('with the system proxy off the window goes through the environment\'s proxy, the runtime still hears the system\'s; a frame inside the page failing is no failed renderer', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { windows, forks, proxyLookups, proxySets, exported } = loadMain({ ready: true, healthFile, proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:12334', NO_PROXY: '::1' }, systemRoute: 'DIRECT' })
  try {
    await until(() => proxySets.length === 1 && forks.length === 1 && windows.length === 1, 'the window\'s proxy set')
    assert.deepEqual(proxySets, [{ mode: 'fixed_servers', proxyRules: 'https=http://127.0.0.1:12334,direct://', proxyBypassRules: '[::1]' }])
    const [runtime] = forks
    runtime.emit('message', { t: 'resolve-proxy', id: 'p1', url: 'https://daily-cloudcode-pa.googleapis.com' })
    await until(() => runtime.of('proxy-result').length === 1, 'proxy answered')
    assert.equal(runtime.of('proxy-result')[0].route, 'DIRECT', 'the system\'s route, not the window\'s proxy')
    const { PROBE_URLS } = require('../electron/window-proxy.cjs')
    assert.deepEqual(proxyLookups, [...PROBE_URLS, 'https://daily-cloudcode-pa.googleapis.com'].map(url => `orbit-system-proxy ${url}`))
    // The video player's frame failing: the window is not brought over the others, and no failed renderer is reported.
    const [win] = windows
    let shown = 0
    win.show = () => { shown++ }
    win.webContents.fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://www.youtube.com/embed/x', false)
    win.webContents.fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://www.youtube.com/embed/y', false)
    assert.deepEqual([shown, fs.existsSync(healthFile)], [0, false])
    // The page itself: shown at once; an aborted navigation (replaced by another) is no broken build, a failure is.
    win.webContents.fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///C:/orbit/dist/index.html', true)
    assert.deepEqual([shown, fs.existsSync(healthFile)], [1, false])
    win.webContents.fire('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///C:/orbit/dist/index.html', true)
    assert.equal(shown, 2)
    const health = readJson(healthFile)
    assert.equal(health.ok, false)
    assert.match(health.error, /^renderer failed to load \(-6\): ERR_FILE_NOT_FOUND/)
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('the window\'s runtime restart during the first start waits for the start\'s report: the start stays healthy, the restart is a later generation', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, handlers, exported, executed } = loadMain({ ready: true, healthFile, runtime: 'slow' })
  try {
    await until(() => forks.length === 1 && windows.length === 1, 'started')
    // Asked for before the runtime is ready (it takes 100 ms here) and before the page loaded.
    const restart = handlers.get('runtime:restart')(trusted)
    windows[0].webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile), 'start reported')
    const start = readJson(healthFile)
    assert.deepEqual([start.generation, start.ok, start.error], [1, true, undefined], 'the restart did not turn the start into a failed one')
    const reply = await restart
    assert.deepEqual([reply.ok, reply.pid], [true, forks[1].osPid])
    const report = readJson(healthFile)
    assert.deepEqual([report.generation, report.ok, report.level], [2, true, 'runtime'])
    assert.deepEqual(forks[0].of('shutdown'), [{ t: 'shutdown', mode: 'restart' }], 'the first runtime was ready, and stopped as one')
    assert.deepEqual(executed, [], 'no process tree was killed')
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('health: a quit during the first start is no failed start; nothing is reported', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, appHandlers, calls, executed } = loadMain({ ready: true, healthFile, runtime: 'slow' })
  try {
    await until(() => forks.length === 1 && windows.length === 1, 'started')
    windows[0].webContents.fire('did-finish-load')
    appHandlers.get('before-quit')({ preventDefault() {} })
    await until(() => calls.quit === 1, 'quit once the runtime was stopped')
    await delay(150)
    assert.equal(fs.existsSync(healthFile), false, 'a report would read as a failed start to the self-upgrade watcher')
    assert.deepEqual([forks[0].exited, forks[0].of('shutdown').length], [true, 0], 'a runtime that was not ready is ended at once')
    assert.deepEqual(executed.map(entry => entry.args.join(' ')), [`/pid ${forks[0].osPid} /t /f`], 'its tree was killed (by the faked taskkill)')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('health: a runtime restart whose new runtime dies while the window is checked is not reported healthy', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, handlers, exported } = loadMain({ ready: true, healthFile })
  try {
    await until(() => windows.length === 1, 'window created')
    const [win] = windows
    win.webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile) && readJson(healthFile).ok, 'start reported')
    // The new runtime is ready; it crashes during the window's round trip, which then passes.
    win.beforePing = async () => { win.beforePing = null; forks[1].exitWith(3); await delay(30) }
    const reply = await handlers.get('runtime:restart')(trusted)
    assert.equal(reply.ok, false)
    assert.match(reply.error, /^the new runtime \(pid \d+\) stopped while the window was checked: the process exited with code 3$/)
    const health = readJson(healthFile)
    assert.deepEqual([health.generation, health.ok, health.level, health.runtime.ready], [2, false, 'runtime', false])
    assert.deepEqual(forks[1].of('renderer-healthy'), [], 'the runtime that died is not told the restart was healthy')
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('health: a restart a relaunch ends, and one asked for during the relaunch, write no report', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const { forks, windows, handlers, appHandlers, calls } = loadMain({ ready: true, healthFile, runtime: ['ok', 'slow'] })
  try {
    await until(() => windows.length === 1, 'window created')
    windows[0].webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile) && readJson(healthFile).ok, 'start reported')
    const secondInstance = appHandlers.get('second-instance')
    // A restart under way: its new runtime is still starting when the relaunch begins.
    const restart = handlers.get('runtime:restart')(trusted)
    await until(() => forks.length === 2, 'the new runtime is starting')
    secondInstance({}, ['electron.exe', repo, '--relaunch'], repo, { relaunch: true })
    assert.deepEqual(await restart, { ok: false, ms: (await restart).ms, pid: null, error: 'the runtime was stopped before it was ready: Orbit is shutting down' })
    // Asked for while the relaunch runs: refused at once, without a report.
    secondInstance({}, ['electron.exe', repo, '--restart-runtime'], repo, { restartRuntime: true })
    assert.deepEqual(await handlers.get('runtime:restart')(trusted), { ok: false, ms: 0, pid: null, error: 'Orbit is shutting down' })
    await until(() => calls.relaunch.length === 1, 'relaunched')
    await delay(20)
    const health = readJson(healthFile)
    assert.deepEqual([health.generation, health.ok], [1, true], 'still the start\'s report: nothing reads as a failed upgrade')
    assert.equal(forks.length, 2, 'nothing more was forked')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('after the shell files changed a runtime-only restart is refused: the running runtime stays, and a crash is not followed by a fork', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-health-'))
  const healthFile = path.join(folder, 'health.json')
  const hashes = { shell: 'a'.repeat(40), runtime: 'b'.repeat(40) }
  const fingerprint = { ...require('../electron/fingerprint.cjs'), fingerprints: () => ({ ...hashes }) }
  const { forks, windows, handlers, exported } = loadMain({ ready: true, healthFile, fingerprint })
  const shellChanged = 'shell files changed — relaunch Orbit'
  try {
    await until(() => windows.length === 1, 'window created')
    windows[0].webContents.fire('did-finish-load')
    await until(() => fs.existsSync(healthFile) && readJson(healthFile).ok, 'start reported')
    assert.equal(readJson(healthFile).shellHash, hashes.shell)
    hashes.shell = 'c'.repeat(40) // main.cjs, the preload, the IPC contract or the runtime protocol changed on disk
    assert.deepEqual(await handlers.get('runtime:restart')(trusted), { ok: false, ms: 0, pid: null, error: shellChanged })
    assert.deepEqual([forks.length, forks[0].of('shutdown').length, handlers.get('runtime:status')(trusted).state], [1, 0, 'ready'], 'the running runtime is left alone')
    const refused = readJson(healthFile)
    assert.deepEqual([refused.generation, refused.ok, refused.level, refused.error], [2, false, 'runtime', `runtime restart refused: ${shellChanged}`], 'whoever asked hears it')
    // A crash: the automatic restart would fork a runtime next to the old shell; it is refused the same way.
    forks[0].exitWith(3)
    await until(() => handlers.get('runtime:status')(trusted).state === 'stopped', 'stopped')
    const status = handlers.get('runtime:status')(trusted)
    assert.deepEqual([status.error, status.retrying, forks.length], [shellChanged, false, 1])
    assert.ok(windows[0].sent.some(([channel, pushed]) => channel === 'runtime:status-changed' && pushed.state === 'stopped' && pushed.error === shellChanged), 'the window hears why')
    await exported.shutdownRuntime('quit')
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('inprocess mode: the runtime is built inside main, calls are served, and --restart-runtime relaunches', { timeout: 60000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-inprocess-'))
  const { handlers, forks, windows, appHandlers, calls, exported } = loadMain({ ready: true, mode: 'inprocess', userData: profile })
  try {
    await until(() => windows.length === 1, 'window created')
    await until(() => handlers.get('runtime:status')(trusted).state === 'ready', 'service built', 30000)
    assert.equal(forks.length, 0, 'no runtime process')
    assert.equal(handlers.get('runtime:status')(trusted).pid, process.pid)
    assert.equal(await handlers.get('state:load')(trusted), null, 'the real service answers from the profile')
    assert.deepEqual(await handlers.get('runtime:list')(trusted), [])
    const reply = await handlers.get('runtime:restart')(trusted)
    assert.equal(reply.ok, false)
    assert.match(reply.error, /inprocess/)
    appHandlers.get('second-instance')({}, ['electron.exe', repo, '--restart-runtime'], repo, { restartRuntime: true })
    await until(() => calls.relaunch.length === 1, 'relaunched', 15000)
    assert.deepEqual(calls.exit, [0])
    assert.equal(handlers.get('runtime:status')(trusted).state, 'stopped', 'the runtime was shut down before the relaunch')
  } finally {
    await exported.shutdownRuntime('quit')
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
