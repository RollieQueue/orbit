const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// main.cjs and preload.cjs only run inside Electron, so nothing else in the default gate executes them.
// An edit that breaks their loading would still pass typecheck and unit tests, and the broken files would be
// the ones Orbit.cmd starts from this repository. Loading them against a stub catches that.
function loadWithElectron(file, stub) {
  const original = Module._load
  Module._load = function (request, ...rest) { return request === 'electron' ? stub : original.call(this, request, ...rest) }
  const resolved = require.resolve(file)
  delete require.cache[resolved]
  try { return require(resolved) } finally { Module._load = original; delete require.cache[resolved] }
}

function loadMain({ lock = true } = {}) {
  const handlers = new Map(), appEvents = [], appHandlers = new Map(), calls = { relaunch: [], exit: [], quit: 0, lock: [] }
  const saved = { ORBIT_USER_DATA: process.env.ORBIT_USER_DATA, ORBIT_HEALTH_FILE: process.env.ORBIT_HEALTH_FILE }
  delete process.env.ORBIT_USER_DATA
  process.env.ORBIT_HEALTH_FILE = '0' // no health report and no crash hook from a test process
  let exported
  try {
    exported = loadWithElectron('../electron/main.cjs', {
      app: {
        requestSingleInstanceLock: (data) => { calls.lock.push(data); return lock },
        on: (event, handler) => { appEvents.push(event); appHandlers.set(event, handler) },
        quit() { calls.quit++ }, exit: (code) => calls.exit.push(code), relaunch: (options) => calls.relaunch.push(options), setPath() {},
        getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', whenReady: () => new Promise(() => {}), // never resolves: no window, no stores
      },
      BrowserWindow: class { static getAllWindows() { return [] } },
      dialog: {}, shell: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    })
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  return { handlers, appEvents, appHandlers, calls, exported }
}

const trusted = { sender: { isDestroyed: () => false, getURL: () => 'file:///C:/orbit/dist/index.html' }, senderFrame: { url: 'file:///C:/orbit/dist/index.html', parent: null } }

test('the main process loads and registers its IPC channels', () => {
  const { handlers, appEvents } = loadMain()
  for (const channel of ['runtime:start', 'runtime:stop', 'runtime:list', 'runtime:get', 'runtime:changes', 'state:load', 'state:save', 'providers:health', 'quota:get', 'workspace:pick', 'memory:list', 'memory:pin', 'memory:stats', 'memory:forget-chat', 'memory:sharing', 'capabilities:list', 'capabilities:pin', 'app:ping', 'app:relaunch']) {
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

test('a second instance started with --relaunch makes the running one flush and restart without the flag', async () => {
  const { appHandlers, calls, exported } = loadMain()
  assert.deepEqual(calls.lock, [{ relaunch: false }], 'the lock request carries whether this start is a relaunch signal')
  const secondInstance = appHandlers.get('second-instance')
  secondInstance({}, ['electron.exe', 'C:\\repo'], 'C:\\', { relaunch: false })
  assert.deepEqual([calls.relaunch.length, calls.exit.length], [0, 0], 'an ordinary second instance only focuses the window')
  secondInstance({}, ['electron.exe', 'C:\\repo', '--relaunch'], 'C:\\', { relaunch: true })
  secondInstance({}, ['electron.exe', 'C:\\repo', '--relaunch'], 'C:\\', { relaunch: true })
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(calls.relaunch.length, 1, 'a repeated signal during the grace period does not relaunch twice')
  assert.deepEqual(calls.relaunch[0], { args: process.argv.slice(1).filter((arg) => arg !== '--relaunch') })
  assert.deepEqual(calls.exit, [0])
  assert.equal(exported.isRelaunchSignal(['electron.exe', 'x'], undefined), false)
  assert.equal(exported.isRelaunchSignal(['electron.exe', 'x'], { relaunch: true }), true, 'additionalData is the reliable channel when Chromium rewrites argv')
  assert.deepEqual(exported.relaunchArgs(['electron.exe', 'C:\\repo', '--relaunch', '--other']), ['C:\\repo', '--other'])
  assert.deepEqual(exported.relaunchArgs(['Orbit.exe', '--relaunch']), [], 'a packaged exe relaunches with no app path')
})

test('app:relaunch from the window replies first and then restarts the process', async () => {
  const { handlers, calls } = loadMain()
  const reply = handlers.get('app:relaunch')(trusted)
  assert.deepEqual(reply, { ok: true, pid: process.pid })
  assert.equal(calls.relaunch.length, 0, 'the reply leaves before the relaunch starts')
  await new Promise((resolve) => setTimeout(resolve, 450))
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
  const repo = path.resolve(__dirname, '..')
  const expected = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim()
  assert.match(expected, /^[0-9a-f]{40}$/)
  assert.equal(exported.readHeadCommit(repo), expected)
  assert.equal(exported.readHeadCommit(os.tmpdir()), null, 'outside a repository the commit is unknown, not an error')
})
