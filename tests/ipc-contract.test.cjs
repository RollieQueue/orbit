'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const contract = require('../electron/ipc-contract.cjs')
const gen = require('../scripts/gen-ipc-types.cjs')
const { createIpcHandlers, assertIpcContract, registerIpcHandlers } = require('../electron/ipc-handlers.cjs')

// electron/ipc-contract.cjs is the one table of the IPC surface. Three things mirror it and are checked here:
// the generated block of src/vite-env.d.ts, the generated electron/preload.cjs, and the handler map of ipc-handlers.cjs.
const root = path.join(__dirname, '..')
const read = (file) => gen.normalize(fs.readFileSync(file, 'utf8'))
const REGENERATE = 'run: node scripts/gen-ipc-types.cjs'

function loadWithElectron(file, stub) {
  const original = Module._load
  Module._load = function (request, ...rest) { return request === 'electron' ? stub : original.call(this, request, ...rest) }
  const resolved = require.resolve(file)
  delete require.cache[resolved]
  try { return require(resolved) } finally { Module._load = original; delete require.cache[resolved] }
}

function fakeContext() {
  return {
    app: { getPath: () => root }, dialog: {}, shell: {}, runtime: {}, quota: {}, stores: {},
    validateWorkspace: (workspace) => workspace, getGitContext: async () => ({ connected: false }), cloneGitWorkspace: async () => null,
    relaunchApp() {}, startedAt: Date.now(), isHealthy: () => false,
  }
}

test('the contract is well-formed: unique methods and channels, typed arguments, one handler argument per push event', () => {
  const methods = contract.methods()
  const channels = contract.ENTRIES.map(entry => entry.channel)
  assert.equal(new Set(methods).size, methods.length, 'method names are unique')
  assert.equal(new Set(channels).size, channels.length, 'channels are unique')
  assert.deepEqual(contract.ENTRIES, [...contract.CALLS, ...contract.EVENTS])
  for (const entry of contract.ENTRIES) {
    assert.match(entry.method, /^[a-z][A-Za-z]+$/, `${entry.method} is a plain method name`)
    assert.match(entry.channel, /^[a-z-]+:[a-z-]+$/, `${entry.channel} is namespace:action`)
    assert.ok(typeof entry.returns === 'string' && entry.returns.length, `${entry.method} has a return type`)
    assert.ok(Array.isArray(entry.args), `${entry.method} has an argument list`)
    let optionalSeen = false
    for (const arg of entry.args) {
      assert.match(arg.name, /^[a-z][A-Za-z]*$/, `${entry.method}: argument name ${arg.name}`)
      assert.ok(typeof arg.type === 'string' && arg.type.length, `${entry.method}: ${arg.name} has a type`)
      if (arg.optional) optionalSeen = true
      else assert.equal(optionalSeen, false, `${entry.method}: a required argument after an optional one`)
    }
    if (entry.push) {
      assert.equal(entry.args.length, 1, `${entry.method} takes the handler only`)
      assert.equal(entry.returns, '() => void', `${entry.method} returns the unsubscribe function`)
    }
  }
  assert.deepEqual(contract.pushChannels().sort(), ['quota:update', 'runtime:event'])
})

test('src/vite-env.d.ts carries the generated bridge block, byte for byte', () => {
  const current = read(gen.TYPES_FILE)
  assert.ok(current.includes(gen.BEGIN) && current.includes(gen.END), 'the generated block is marked')
  assert.equal(current, gen.renderTypes(current), `src/vite-env.d.ts is out of date with electron/ipc-contract.cjs (${REGENERATE})`)
  // The global names the contract's type strings refer to are declared by hand outside the block.
  for (const name of ['GitContext', 'ProjectIndexStatus', 'ProviderHealth', 'RuntimeEvent']) {
    assert.match(current, new RegExp(`^interface ${name} \\{`, 'm'), `${name} is declared in vite-env.d.ts`)
  }
  for (const entry of contract.ENTRIES) assert.ok(current.includes(`\n  ${gen.signature(entry)}\n`), `${entry.method} is typed`)
})

test('electron/preload.cjs is exactly what the generator renders from the contract', () => {
  assert.equal(read(gen.PRELOAD_FILE), gen.renderPreload(), `electron/preload.cjs is out of date with electron/ipc-contract.cjs (${REGENERATE})`)
  assert.ok(!gen.renderPreload().includes('\r') && !gen.renderTypes().includes('\r'), 'the generator writes LF endings')
  assert.ok(!gen.renderPreload().includes('ipc-contract.cjs\')'), 'the sandboxed preload must not require the contract module')
  assert.ok(gen.renderPreload().startsWith('// @ts-check\n'), 'the generated preload is type-checked with the rest of the electron/ shell (tsconfig.main.json)')
})

test('the generator is deterministic and touches only the marked block of vite-env.d.ts', () => {
  assert.equal(gen.renderPreload(), gen.renderPreload())
  const handWritten = 'interface GitContext { path: string }\n'
  const trailing = 'interface RuntimeEvent { type: string }\n'
  const rendered = gen.renderTypes(`/// <reference types="vite/client" />\n${handWritten}${gen.BEGIN}\nstale line\n${gen.END}\n${trailing}`)
  assert.ok(rendered.startsWith(`/// <reference types="vite/client" />\n${handWritten}${gen.BEGIN}\n`), 'text before the block is kept')
  assert.ok(rendered.endsWith(`${gen.END}\n${trailing}`), 'text after the block is kept')
  assert.ok(!rendered.includes('stale line'), 'the old block is replaced')
  assert.equal(gen.renderTypes(rendered), rendered, 'a second pass changes nothing')
  const fresh = gen.renderTypes(`/// <reference types="vite/client" />\n${handWritten}`)
  assert.ok(fresh.startsWith(`/// <reference types="vite/client" />\n${gen.BEGIN}\n`) && fresh.endsWith(`${gen.END}\n${handWritten}`), 'without markers the block goes right after the vite reference')
  assert.equal(gen.renderTypes(fresh), fresh)
  assert.equal(gen.renderTypes('/// <reference types="vite/client" />\r\ninterface A {}\r\n').includes('\r'), false, 'CRLF input is normalized')
})

test('window.orbit exposes exactly the contract: one invoke per call with its channel and arity, on/off per push event', () => {
  const invoked = []
  const listeners = new Map()
  const exposed = {}
  loadWithElectron('../electron/preload.cjs', {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
    ipcRenderer: {
      invoke: (channel, ...args) => { invoked.push({ channel, args }); return Promise.resolve() },
      on: (channel, listener) => { listeners.set(channel, listener) },
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel) },
    },
  })
  assert.deepEqual(Object.keys(exposed), ['orbit'])
  assert.deepEqual(Object.keys(exposed.orbit).sort(), contract.methods().sort(), 'the exposed method names equal the contract')
  for (const entry of contract.CALLS) {
    invoked.length = 0
    const params = entry.args.map((arg, index) => `${arg.name}#${index}`)
    exposed.orbit[entry.method](...params, 'an extra argument')
    assert.equal(invoked.length, 1, `${entry.method} performs one invoke`)
    assert.equal(invoked[0].channel, entry.channel, `${entry.method} invokes ${entry.channel}`)
    assert.deepEqual(invoked[0].args, params, `${entry.method} forwards its ${entry.args.length} argument(s) and drops extras`)
  }
  for (const entry of contract.EVENTS) {
    const received = []
    const off = exposed.orbit[entry.method](payload => received.push(payload))
    assert.equal(typeof off, 'function', `${entry.method} returns an unsubscribe function`)
    listeners.get(entry.channel)({ sender: 'ipc event' }, { hello: entry.channel })
    assert.deepEqual(received, [{ hello: entry.channel }], `${entry.method} hands the payload, not the IPC event, to the handler`)
    off()
    assert.ok(!listeners.has(entry.channel), `${entry.method} unsubscribes`)
  }
})

test('the main-process handlers cover the contract exactly, and a mismatch is a clear start-up error', () => {
  const handlers = createIpcHandlers(fakeContext())
  assert.deepEqual([...handlers.keys()].sort(), contract.callChannels().sort())
  assert.doesNotThrow(() => assertIpcContract(handlers))
  const missing = new Map(handlers)
  missing.delete('runtime:start')
  assert.throws(() => assertIpcContract(missing), /IPC contract mismatch .*no handler for runtime:start/)
  const extra = new Map(handlers)
  extra.set('providers:ask', () => {})
  assert.throws(() => assertIpcContract(extra), /handler without a contract entry: providers:ask/)
  const registered = []
  const ipcMain = { handle: (channel) => registered.push(channel) }
  assert.throws(() => registerIpcHandlers(ipcMain, extra), /IPC contract mismatch/)
  assert.equal(registered.length, 0, 'nothing is registered when the contract does not match')
  registerIpcHandlers(ipcMain, handlers)
  assert.deepEqual(registered.sort(), contract.callChannels().sort())
})

test('every push channel of the contract is sent by the main process', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  for (const channel of contract.pushChannels()) assert.ok(source.includes(`webContents.send('${channel}'`), `main.cjs sends ${channel}`)
})

test('channels the audit removed stay out of the surface', () => {
  const channels = new Set(contract.ENTRIES.map(entry => entry.channel))
  for (const channel of ['runtime:route-message', 'runtime:spawn-subagent', 'project-context:get', 'memory:search', 'providers:ask']) {
    assert.ok(!channels.has(channel), `${channel} is not exposed`)
  }
})
