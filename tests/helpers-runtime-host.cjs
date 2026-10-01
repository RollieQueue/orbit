const { fork } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Shared by tests/runtime-host*.test.cjs (one file of 10 tests took 4.7 s on its own).
// The runtime child process (electron/runtime-child.cjs + electron/runtime-host.mts) as main drives it: forked on
// plain Node with the protocol of electron/runtime-protocol.mts, a temporary profile and a fake provider loaded through
// ORBIT_RUNTIME_FIXTURES. Every process starts from os.tmpdir(): on Windows a process locks its working directory.
const repo = path.resolve(__dirname, '..')
const entry = path.join(repo, 'electron', 'runtime-child.cjs')
const FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
const protocol = require('../electron/runtime-protocol.mts')

// A fake provider: answers at once, asks for an approval first (ASK_APPROVAL; ASK_ODD_APPROVAL with the null tool id a
// Claude session can send), or holds the turn until the run stops (HOLD), with a process of its own running meanwhile,
// as a CLI would. It reads only the current task: the chat digest earlier in the prompt quotes the prompts of earlier runs.
const FIXTURES = `'use strict'
const { spawn } = require('node:child_process')
let turns = 0
const aborted = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
const taskOf = (prompt) => { const at = prompt.lastIndexOf('YOUR CURRENT TASK:'); return at >= 0 ? prompt.slice(at) : prompt }
exports.runProvider = async (options) => {
  turns++
  const prompt = taskOf(String(options.prompt || ''))
  if (prompt.includes('ASK_ODD_APPROVAL')) {
    const approved = await options.onApproval({ tool: 'run_command', arguments: { command: 'npm test' }, toolUseId: null })
    return { text: approved ? 'approval: yes' : 'approval: no', model: 'fixture-model' }
  }
  if (prompt.includes('ASK_APPROVAL')) {
    const approved = await options.onApproval({ tool: 'write_file', arguments: { path: 'approved.txt', content: 'fixture' } })
    return { text: approved ? 'approval: yes' : 'approval: no', model: 'fixture-model' }
  }
  if (prompt.includes('HOLD')) {
    const cli = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    await aborted(options.signal)
    await new Promise((resolve) => { cli.once('exit', resolve); cli.kill() })
    throw Object.assign(new Error('The fixture turn was stopped'), { name: 'AbortError' })
  }
  return { text: 'fixture answer ' + turns, model: 'fixture-model' }
}
exports.inspectProviders = async () => [{ id: 'custom', supported: true, available: true, authenticated: null, detail: 'fixture', model: 'fixture-model' }]
exports.patchQuotaReaders = (readers) => {
  for (const id of Object.keys(readers)) readers[id] = async () => ({ windows: [], state: 'unknown', detail: 'fixture reader' })
}
`

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-host-'))
  const layout = { root, userData: path.join(root, 'profile'), workspace: path.join(root, 'workspace'), fixtures: path.join(root, 'fixtures.cjs'), stops: [] }
  fs.mkdirSync(layout.userData)
  fs.mkdirSync(layout.workspace)
  fs.writeFileSync(layout.fixtures, FIXTURES)
  // Every child of the test has exited before its folder goes; a handle Windows releases late makes it best effort.
  t.after(async () => {
    await Promise.all(layout.stops.map((stop) => stop()))
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Released after exit. */ }
  })
  return layout
}

function payload(layout, prompt, extra = {}) {
  return {
    projectId: 'project', chatId: 'chat', prompt, history: [], workspace: layout.workspace, memoryEnabled: false,
    providerId: 'custom', model: 'fixture-model', agentInstructions: '', accessMode: 'workspace-write', approvalPolicy: 'never', limits: {}, ...extra,
  }
}

// One forked runtime child and the parent's view of it: every message it sent, calls with results, and its exit.
function startChild(layout, { env = {}, fixtures = layout.fixtures } = {}) {
  const began = performance.now()
  const child = fork(entry, [], {
    cwd: os.tmpdir(), execArgv: FLAGS, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ORBIT_USER_DATA_DIR: layout.userData, ORBIT_REPO_ROOT: repo, ORBIT_RUNTIME_FIXTURES: fixtures, ...env },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', () => {})
  const messages = []
  const waiters = new Set()
  child.on('message', (message) => {
    messages.push(message)
    for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  let gone = null
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  // 'close' comes after the exit and after the IPC channel and pipes are drained: nothing more can arrive, so whoever
  // still waits fails now, with what the child printed ('exit' alone may precede the last messages).
  child.once('close', (code, signal) => {
    gone = { code, signal }
    for (const waiter of [...waiters]) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.reject(new Error(`The child exited (${code ?? signal}) before ${waiter.label}; child stderr:\n${stderr.slice(-3000)}`)) }
  })
  layout.stops.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  const waitFor = (predicate, label, timeout = 20000) => {
    const seen = messages.find(predicate)
    if (seen) return Promise.resolve(seen)
    if (gone) return Promise.reject(new Error(`The child had exited (${gone.code ?? gone.signal}) before ${label}; child stderr:\n${stderr.slice(-3000)}`))
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${label}; child stderr:\n${stderr.slice(-3000)}`)) }, timeout) }
      waiters.add(waiter)
    })
  }
  let nextId = 1
  const call = async (channel, ...args) => {
    const id = nextId++
    child.send({ t: 'call', id, channel, args })
    const reply = await waitFor((message) => message.t === 'result' && message.id === id, `the result of ${channel}`)
    if (reply.ok) return reply.value
    throw protocol.deserializeError(reply.error)
  }
  const ready = waitFor((message) => message.t === 'ready' || message.t === 'fatal', 'ready').then((message) => {
    if (message.t === 'fatal') throw protocol.deserializeError(message.error)
    return { ...message, wallMs: Math.round(performance.now() - began) }
  })
  ready.catch(() => {}) // Observed by the tests that await it; never an unhandled rejection.
  const event = (predicate, label) => waitFor((message) => message.t === 'event' && message.channel === 'runtime:event' && predicate(message.payload), label).then((message) => message.payload)
  return { child, messages, waitFor, call, ready, exited, event, stderr: () => stderr, send: (message) => child.send(message) }
}

// P1 (electron/resume.mts, restart_orbit): a shutdown for a restart ends the run the intent names as 'restarting', and
// the next runtime continues it once main reports the renderer healthy.
const restartSupport = (() => {
  try {
    const resume = require('../electron/resume.mts')
    const { OrbitRuntime } = require('../electron/runtime.mts')
    return typeof resume.markRestartingRuns === 'function' && typeof OrbitRuntime.prototype.markRestarting === 'function' && typeof OrbitRuntime.prototype.setRestartHost === 'function'
  } catch { return false }
})()

module.exports = { repo, protocol, temporary, payload, startChild, restartSupport }
