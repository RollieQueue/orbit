const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

// main.cjs and preload.cjs only run inside Electron, so nothing else in the default gate executes them.
// An edit that breaks their loading would still pass typecheck, unit tests and packaging, and the broken
// bundle would then be the one Orbit.cmd starts. Loading them against a stub catches that.
function loadWithElectron(file, stub) {
  const original = Module._load
  Module._load = function (request, ...rest) { return request === 'electron' ? stub : original.call(this, request, ...rest) }
  const resolved = require.resolve(file)
  delete require.cache[resolved]
  try { return require(resolved) } finally { Module._load = original; delete require.cache[resolved] }
}

function loadMain() {
  const handlers = new Map(), appEvents = []
  const saved = { ORBIT_SELF_UPGRADE: process.env.ORBIT_SELF_UPGRADE, ORBIT_USER_DATA: process.env.ORBIT_USER_DATA }
  delete process.env.ORBIT_SELF_UPGRADE; delete process.env.ORBIT_USER_DATA
  try {
    loadWithElectron('../electron/main.cjs', {
      app: {
        requestSingleInstanceLock: () => true, on: (event) => appEvents.push(event), quit() {}, setPath() {},
        getPath: () => os.tmpdir(), whenReady: () => new Promise(() => {}), // never resolves: no window, no stores
      },
      BrowserWindow: class { static getAllWindows() { return [] } },
      dialog: {}, shell: {},
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    })
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  return { handlers, appEvents }
}

test('the main process loads and registers its IPC channels', () => {
  const { handlers, appEvents } = loadMain()
  for (const channel of ['runtime:start', 'runtime:stop', 'runtime:list', 'runtime:get', 'state:load', 'state:save', 'providers:health', 'workspace:pick', 'memory:list', 'capabilities:list']) {
    assert.ok(handlers.has(channel), `${channel} is registered`)
  }
  assert.ok(!handlers.has('providers:ask'), 'the direct, unguarded provider channel stays removed')
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
  for (const [name, member] of Object.entries(exposed.orbit)) {
    if (typeof member !== 'function' || name === 'onRuntimeEvent') continue
    invoked.length = 0
    member('a', 'b', 'c')
    assert.equal(invoked.length, 1, `${name} performs one invoke`)
    assert.ok(handlers.has(invoked[0]), `${name} -> ${invoked[0]} has a handler`)
  }
  assert.equal(typeof exposed.orbit.onRuntimeEvent(() => {}), 'function', 'the event subscription returns an unsubscribe function')
})
