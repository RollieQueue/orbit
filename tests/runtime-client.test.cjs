'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  createRuntimeClient, nodeFork, adaptChildProcess, killProcessTree, listProcessTable, parseProcessTable, orphansOf, CHILD_ENTRY, NODE_EXEC_ARGV,
} = require('../electron/runtime-client.cjs')
const { PROTOCOL_VERSION, ERROR_CODES } = require('../electron/runtime-protocol.mts')

// electron/runtime-client.cjs is main's side of the runtime child process. The state machine is driven against fake
// children (ChildHandle-shaped objects the test answers for), then against the real electron/runtime-child.cjs.
const tick = () => new Promise(resolve => setImmediate(resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await delay(5)
  }
}

let pidSerial = 70000
// A runtime process as the client sees it. By default it reports ready, echoes calls, and exits after a shutdown.
class FakeChild {
  constructor(env, behaviour = {}) {
    this.env = env
    this.osPid = ++pidSerial
    this.sent = []
    this.exited = false
    this.killed = false
    this.listeners = { message: [], exit: [], output: [] }
    this.behaviour = { ready: true, answer: (message) => ({ ok: true, value: { channel: message.channel, args: message.args, pid: this.osPid } }), shutdown: 'exit', marked: [], ...behaviour }
    this.handle = {
      pid: () => (this.exited ? null : this.osPid),
      post: (message) => {
        if (this.exited) throw new Error('channel closed')
        this.sent.push(structuredClone(message))
        setImmediate(() => this.receive(message))
      },
      onMessage: (listener) => this.listeners.message.push(listener),
      onExit: (listener) => this.listeners.exit.push(listener),
      onOutput: (listener) => this.listeners.output.push(listener),
      kill: () => { this.killed = true; this.exit(1) },
    }
    if (this.behaviour.ready) setImmediate(() => this.emit({ t: 'ready', pid: this.osPid, ms: 3, protocol: PROTOCOL_VERSION }))
  }
  emit(message) { if (!this.exited) for (const listener of this.listeners.message) listener(structuredClone(message)) }
  write(stream, text) { for (const listener of this.listeners.output) listener(stream, text) }
  exit(code) {
    if (this.exited) return
    this.exited = true
    setImmediate(() => { for (const listener of this.listeners.exit) listener(code) })
  }
  receive(message) {
    if (this.exited) return
    if (message.t === 'call') {
      const reply = this.behaviour.answer(message)
      if (reply) this.emit({ t: 'result', id: message.id, ...reply })
    } else if (message.t === 'shutdown' && this.behaviour.shutdown !== 'ignore') {
      this.emit({ t: 'shutdown-done', marked: this.behaviour.marked })
      if (this.behaviour.shutdown === 'exit') this.exit(0)
    }
  }
  of(type) { return this.sent.filter(message => message.t === type) }
}

// `table`: the process table the client reads after a runtime with processes exits (a fake; read times go to `listed`).
// `order` records forks and kills, in the order they happened.
function harness({ behaviours = [], settings = {}, onApproval, resolveProxy, table = [], listProcesses, beforeFork } = {}) {
  const children = []
  const statuses = []
  const events = []
  const logs = []
  const killed = []
  const listed = []
  const order = []
  const client = createRuntimeClient({
    userData: 'C:\\profile', repoRoot: 'C:\\repo', env: { ORBIT_TEST_MARK: 'yes' },
    fork: (entry, { env }) => {
      const child = new FakeChild(env, behaviours[children.length] || behaviours.at(-1) || {})
      child.entry = entry
      children.push(child)
      order.push(`fork ${children.length}`)
      return child.handle
    },
    killTree: async (pid) => { killed.push(pid); order.push(`kill ${pid}`); children.find(child => child.osPid === pid)?.exit(1) },
    listProcesses: listProcesses ?? (async () => { listed.push(Date.now()); return table }),
    beforeFork,
    onStatus: status => statuses.push(status),
    onEvent: (channel, payload) => events.push({ channel, payload }),
    onApproval,
    resolveProxy,
    log: (level, text) => logs.push({ level, text }),
    settings: { autoRestartDelayMs: 1, ...settings },
  })
  return { client, children, statuses, events, logs, killed, listed, order, states: () => statuses.map(status => status.state) }
}

test('the child gets the profile, the repository and main\'s pid; calls made while it starts wait and go out in order', async () => {
  const { client, children, states } = harness({ behaviours: [{ ready: false }] })
  assert.equal(client.mode, 'child')
  assert.equal(children.length, 1)
  assert.equal(children[0].entry, CHILD_ENTRY)
  assert.deepEqual([children[0].env.ORBIT_USER_DATA_DIR, children[0].env.ORBIT_REPO_ROOT, children[0].env.ORBIT_PARENT_PID, children[0].env.ORBIT_TEST_MARK], ['C:\\profile', 'C:\\repo', String(process.pid), 'yes'])
  const first = client.call('state:load', [])
  const second = client.call('memory:list', ['C:\\ws', 'chat-1'])
  await tick()
  assert.equal(children[0].of('call').length, 0, 'nothing is sent before ready')
  assert.equal(client.status().state, 'starting')
  children[0].emit({ t: 'ready', pid: children[0].osPid, ms: 4, protocol: PROTOCOL_VERSION })
  assert.deepEqual(await first, { channel: 'state:load', args: [], pid: children[0].osPid })
  assert.deepEqual((await second).args, ['C:\\ws', 'chat-1'])
  assert.deepEqual(children[0].of('call').map(message => message.channel), ['state:load', 'memory:list'])
  const ready = await client.ready
  assert.equal(ready.pid, children[0].osPid)
  assert.ok(ready.ms >= 0)
  assert.deepEqual(client.status(), { ...client.status(), state: 'ready', mode: 'child', pid: children[0].osPid, lastRestartMs: null, restarts: 0, retrying: false })
  assert.deepEqual(states(), ['starting', 'ready'])
  await client.shutdown('quit')
})

test('a runtime error comes back with its message and code; a ready runtime answers at once', async () => {
  const { client } = harness({ behaviours: [{ answer: (message) => message.channel === 'bad' ? { ok: false, error: { message: 'Choose an absolute project folder', code: 'ORBIT_X' } } : { ok: true, value: 42 } }] })
  await client.ready
  assert.equal(await client.call('good', []), 42)
  await assert.rejects(client.call('bad', ['x']), (error) => error.message === 'Choose an absolute project folder' && error.code === 'ORBIT_X')
  await assert.rejects(client.call('', []), /needs a channel/)
  await client.shutdown()
})

test('a call waits at most the queue timeout for a runtime that is not ready', async () => {
  const { client, children } = harness({ behaviours: [{ ready: false }], settings: { queueTimeoutMs: 40 } })
  await assert.rejects(client.call('runtime:list', []), /not ready within 0 s \(starting\); runtime:list was not sent/)
  assert.equal(children[0].of('call').length, 0)
  await client.kill()
  assert.equal(client.status().state, 'stopped')
})

test('events, log lines and output reach main; a malformed message is logged and ignored', async () => {
  const { client, children, events, logs } = harness()
  await client.ready
  children[0].emit({ t: 'event', channel: 'runtime:event', payload: { type: 'run.started', runId: 'r1' } })
  children[0].emit({ t: 'event', channel: 'restart:notice', payload: { kind: 'resumed' } })
  children[0].emit({ t: 'log', level: 'warn', text: 'quota reader slow' })
  children[0].emit({ t: 'nonsense' })
  children[0].write('stderr', 'first line\nsecond ')
  children[0].write('stderr', 'half\n')
  await tick()
  assert.deepEqual(events, [{ channel: 'runtime:event', payload: { type: 'run.started', runId: 'r1' } }, { channel: 'restart:notice', payload: { kind: 'resumed' } }])
  assert.ok(logs.some(line => line.level === 'warn' && line.text === '[runtime] quota reader slow'))
  assert.ok(logs.some(line => line.level === 'warn' && /does not know/.test(line.text)))
  assert.ok(logs.some(line => line.text.endsWith('] first line')) && logs.some(line => line.text.endsWith('] second half')), 'output is logged line by line')
  await client.shutdown()
})

test('an approval opens the dialog and the answer goes back; a withdrawal or an exit aborts the dialog', async () => {
  const asked = []
  const { client, children } = harness({
    onApproval: (request, signal) => {
      asked.push({ request, signal })
      if (request.tool === 'write_file') return Promise.resolve(true)
      return new Promise(resolve => signal.addEventListener('abort', () => resolve(true)))
    },
  })
  await client.ready
  const request = { tool: 'write_file', arguments: { path: 'a.txt' }, runId: 'r1', agentId: 'a1', agentName: 'Проверка', workspace: 'C:\\ws' }
  children[0].emit({ t: 'approval', id: 'q1', request })
  await until(() => children[0].of('approval-result').length === 1, 'approval answered')
  assert.deepEqual(asked[0].request, request)
  assert.deepEqual(children[0].of('approval-result'), [{ t: 'approval-result', id: 'q1', approved: true }])
  children[0].emit({ t: 'approval', id: 'q2', request: { ...request, tool: 'run_command' } })
  await until(() => asked.length === 2, 'second dialog')
  children[0].emit({ t: 'approval-cancel', id: 'q2' })
  assert.equal(asked[1].signal.aborted, true, 'the withdrawn dialog closes')
  await tick()
  assert.equal(children[0].of('approval-result').length, 1, 'a withdrawn question is not answered')
  children[0].emit({ t: 'approval', id: 'q3', request: { ...request, tool: 'delete_file' } })
  await until(() => asked.length === 3, 'third dialog')
  children[0].exit(5)
  await until(() => asked[2].signal.aborted, 'exit aborts the dialog')
  await client.kill()
})

test('restart shuts the old runtime down for a restart, starts a new one, serves the calls made meanwhile and measures it', async () => {
  const { client, children, statuses } = harness({ behaviours: [{ marked: ['run-1'] }, {}] })
  await client.ready
  const restart = client.restart('upgrade')
  assert.equal(client.restart('again'), restart, 'a second request joins the restart in progress')
  const during = client.call('runtime:list', [])
  const { ms, pid } = await restart
  assert.equal(children.length, 2)
  assert.deepEqual(children[0].of('shutdown'), [{ t: 'shutdown', mode: 'restart' }])
  assert.equal(children[0].exited, true)
  assert.equal(pid, children[1].osPid)
  assert.ok(ms >= 0)
  assert.equal((await during).pid, children[1].osPid, 'the call made during the restart is answered by the new runtime')
  const status = client.status()
  assert.deepEqual([status.state, status.pid, status.restarts, status.lastRestartMs], ['ready', children[1].osPid, 1, ms])
  assert.deepEqual(statuses.map(entry => entry.state), ['starting', 'ready', 'restarting', 'restarting', 'ready'])
  await client.shutdown()
})

test('a restart carries the calls that only read over to the new runtime, ahead of the calls made meanwhile; a call that changes something fails', async () => {
  const { client, children } = harness({ behaviours: [{ answer: () => null }, {}] })
  await client.ready
  const read = client.call('providers:health', [{}])
  const save = client.call('state:save', [{ version: 3 }])
  const write = assert.rejects(client.call('memory:save', [{ title: 'x' }]), /restarted or stopped before it answered/)
  await until(() => children[0].of('call').length === 3, 'all three sent')
  const restart = client.restart('upgrade')
  const later = client.call('runtime:list', [])
  const { pid } = await restart
  assert.deepEqual(await read, { channel: 'providers:health', args: [{}], pid })
  assert.equal((await save).pid, pid)
  await write
  assert.equal((await later).pid, pid)
  assert.deepEqual(children[1].of('call').map(message => message.channel), ['providers:health', 'state:save', 'runtime:list'], 'in their original order, before the call made during the restart')
  await client.shutdown()
})

test('a crash rejects the calls in flight and restarts the runtime; the fourth crash within a minute stops it until a restart by hand', async () => {
  const { client, children, states, statuses } = harness({ behaviours: [{ answer: () => null }] })
  await client.ready
  const inFlight = assert.rejects(client.call('runtime:start', [{ prompt: 'x' }]), /stopped unexpectedly: the process exited with code 3: TypeError: boom/)
  const reading = assert.rejects(client.call('runtime:list', []), /stopped unexpectedly/, 'a crash is not a restart: nothing is carried over')
  await until(() => children[0].of('call').length === 2, 'calls sent')
  children[0].write('stderr', 'TypeError: boom\n')
  children[0].exit(3)
  await inFlight
  await reading
  for (let crash = 1; crash <= 3; crash++) {
    await until(() => children.length === crash + 1 && client.status().state === 'ready', `automatic restart ${crash}`)
    children[crash].exit(1)
  }
  await until(() => client.status().state === 'stopped', 'stopped after the fourth crash')
  assert.equal(children.length, 4, 'no fifth process')
  assert.match(client.status().error, /crashed 4 times within 60 s; restart it by hand/)
  assert.equal(client.status().retrying, false, 'the used-up budget is not a restart to wait for')
  await assert.rejects(client.call('runtime:list', []), /Orbit runtime is stopped/)
  assert.deepEqual(states().slice(0, 5), ['starting', 'ready', 'crashed', 'starting', 'ready'])
  assert.deepEqual(statuses.filter(status => status.state === 'crashed').map(status => status.retrying), [true, true, true], 'each crash that is retried says so')
  assert.ok(statuses.filter(status => status.state !== 'crashed').every(status => status.retrying === false))
  const { pid } = await client.restart('by hand')
  assert.equal(pid, children[4].osPid)
  assert.equal(client.status().state, 'ready')
  assert.equal(client.status().restarts, 4, 'three automatic restarts and one by hand')
  await client.shutdown()
})

test('a failure before ready rejects `ready` with the reason the runtime gave, and the start is not retried on its own', async () => {
  const { client, children, statuses } = harness({ behaviours: [{ ready: false }] })
  const early = client.call('state:load', [])
  children[0].emit({ t: 'fatal', error: { message: 'Cannot find module ./runtime.mts', stack: 'Error: Cannot find module' } })
  children[0].exit(1)
  await assert.rejects(client.ready, /Cannot find module \.\/runtime\.mts/)
  await assert.rejects(early, /Orbit runtime is stopped: Cannot find module/, 'a queued call fails at once: nothing is starting')
  await until(() => client.status().state === 'stopped', 'stopped')
  assert.match(client.status().error, /Cannot find module/)
  await delay(20)
  assert.equal(children.length, 1, 'no automatic restart after a failed start')
  assert.ok(statuses.every(status => status.retrying === false && status.state !== 'crashed'), 'never shown as a crash about to be retried')
})

test('a start that fails is never retried on its own, also after a crash or in a restart; a crash of a runtime that had been ready is', async () => {
  // First process: ready. Second (the automatic restart after its crash): fails. Third (a restart asked for): fails.
  // Fourth: asked for again, and it works.
  const { client, children, statuses } = harness({ behaviours: [{}, { ready: false }, { ready: false }, {}] })
  await client.ready
  children[0].exit(3)
  await until(() => children.length === 2, 'the crash of a ready runtime is restarted on its own')
  assert.ok(statuses.some(status => status.state === 'crashed' && status.retrying === true))
  // The new process fails to load (the self-upgrade watcher may be restoring electron/ meanwhile).
  children[1].emit({ t: 'fatal', error: { message: 'SyntaxError: Unexpected token' } })
  children[1].exit(1)
  await until(() => client.status().state === 'stopped', 'stopped after the failed automatic start')
  await delay(20)
  assert.equal(children.length, 2, 'the failed start is not retried')
  assert.deepEqual([client.status().error, client.status().retrying], ['SyntaxError: Unexpected token', false])
  await assert.rejects(client.call('runtime:list', []), /Orbit runtime is stopped: SyntaxError/)

  const restart = client.restart('watcher')
  await until(() => children.length === 3, 'the restart forks')
  children[2].exit(1)
  await assert.rejects(restart, /exited with code 1/)
  await delay(20)
  assert.equal(children.length, 3, 'a restart whose runtime fails to start is not retried either')
  assert.equal(client.status().state, 'stopped')

  const { pid } = await client.restart('window')
  assert.equal(pid, children[3].osPid, 'the next start is the one asked for')
  assert.equal(client.status().state, 'ready')
  await client.shutdown()
})

test('a runtime that speaks another protocol version is refused: stopped with a clear error and not restarted on its own', async () => {
  const { client, children, killed } = harness({ behaviours: [{ ready: false }, {}] })
  const early = client.call('state:load', [])
  children[0].emit({ t: 'ready', pid: children[0].osPid, ms: 2, protocol: PROTOCOL_VERSION + 1 })
  await assert.rejects(client.ready, new RegExp(`speaks protocol ${PROTOCOL_VERSION + 1} and this Orbit window speaks ${PROTOCOL_VERSION}; relaunch Orbit`))
  await assert.rejects(early, /Orbit runtime is stopped: the runtime process speaks protocol/, 'a queued call fails at once instead of waiting 30 s')
  assert.deepEqual(killed, [children[0].osPid])
  assert.equal(children[0].of('call').length, 0, 'nothing was sent to the refused runtime')
  await delay(20)
  assert.equal(children.length, 1, 'no automatic restart: the same code would be refused again')
  assert.deepEqual([client.status().state, client.status().retrying], ['stopped', false])
  assert.match(client.status().error, /relaunch Orbit/)
  await assert.rejects(client.call('runtime:list', []), /Orbit runtime is stopped/)
  const { pid } = await client.restart('by hand')
  assert.equal(pid, children[1].osPid, 'a restart by hand may try again')
  await client.shutdown()
})

test('a fork main refuses (its shell files changed) stops the runtime with that reason: no process, no automatic retry', async () => {
  let refuse = false
  const { client, children, statuses } = harness({ behaviours: [{}], beforeFork: () => { if (refuse) throw new Error('shell files changed — relaunch Orbit') } })
  await client.ready
  refuse = true
  children[0].exit(3)
  await until(() => client.status().state === 'stopped', 'stopped')
  assert.equal(children.length, 1, 'the automatic restart after the crash forked nothing')
  assert.deepEqual([client.status().error, client.status().retrying], ['shell files changed — relaunch Orbit', false])
  assert.deepEqual(statuses.map(status => status.state).slice(-3), ['crashed', 'starting', 'stopped'])
  await delay(20)
  assert.equal(children.length, 1)
  await assert.rejects(client.restart('window'), /shell files changed — relaunch Orbit/)
  assert.equal(children.length, 1, 'a restart asked for is refused the same way')
  await client.shutdown()
})

test('a runtime that never reports ready is killed after the start timeout', async () => {
  const { client, children, killed } = harness({ behaviours: [{ ready: false }], settings: { startTimeoutMs: 40, maxAutoRestarts: 0 } })
  await assert.rejects(client.ready, /did not report ready within 0 s/)
  assert.deepEqual(killed, [children[0].osPid], 'its process tree is killed')
})

test('shutdown returns the runs marked for a restart; a runtime that does not exit has its tree killed', async () => {
  const clean = harness({ behaviours: [{ marked: ['run-7'] }] })
  await clean.client.ready
  assert.deepEqual(await clean.client.shutdown('restart'), { marked: ['run-7'] })
  assert.deepEqual(clean.children[0].of('shutdown'), [{ t: 'shutdown', mode: 'restart' }])
  assert.deepEqual(clean.killed, [], 'a clean exit needs no kill')
  assert.equal(clean.client.status().state, 'stopped')
  await assert.rejects(clean.client.call('state:load', []), /shutting down/)
  await assert.rejects(clean.client.restart(), /shutting down/)

  const stuck = harness({ behaviours: [{ shutdown: 'ignore' }] })
  await stuck.client.ready
  const began = Date.now()
  assert.deepEqual(await stuck.client.shutdown('quit', 60), { marked: [] })
  assert.ok(Date.now() - began >= 50)
  assert.deepEqual(stuck.killed, [stuck.children[0].osPid])

  const lingering = harness({ behaviours: [{ shutdown: 'done-only', marked: ['run-9'] }], settings: { exitGraceMs: 30 } })
  await lingering.client.ready
  assert.deepEqual(await lingering.client.shutdown('restart', 2000), { marked: ['run-9'] })
  assert.deepEqual(lingering.killed, [lingering.children[0].osPid], 'shutdown-done without an exit: killed after the grace')
})

test('the runtime asks main for the system proxy: the resolver\'s route goes back, a failure or no answer in time is null', async () => {
  const asked = []
  const { client, children } = harness({
    settings: { proxyTimeoutMs: 40 },
    resolveProxy: async (url) => {
      asked.push(url)
      if (url.includes('slow')) return new Promise(() => {})
      if (url.includes('broken')) throw new Error('no session')
      return 'PROXY 10.0.0.1:8080; DIRECT'
    },
  })
  await client.ready
  children[0].emit({ t: 'resolve-proxy', id: 'p1', url: 'https://example.com' })
  children[0].emit({ t: 'resolve-proxy', id: 'p2', url: 'https://broken.example' })
  children[0].emit({ t: 'resolve-proxy', id: 'p3', url: 'https://slow.example' })
  await until(() => children[0].of('proxy-result').length === 3, 'three answers')
  const answers = Object.fromEntries(children[0].of('proxy-result').map(message => [message.id, message.route]))
  assert.deepEqual(answers, { p1: 'PROXY 10.0.0.1:8080; DIRECT', p2: null, p3: null })
  assert.deepEqual(asked, ['https://example.com', 'https://broken.example', 'https://slow.example'])
  await client.shutdown()

  const without = harness()
  await without.client.ready
  without.children[0].emit({ t: 'resolve-proxy', id: 'p4', url: 'https://example.com' })
  await until(() => without.children[0].of('proxy-result').length === 1, 'answered')
  assert.deepEqual(without.children[0].of('proxy-result'), [{ t: 'proxy-result', id: 'p4', route: null }], 'no resolver: null')
  await without.client.shutdown()
})

test('the process table rules on their own: which rows are orphans, which pid is still the recorded process', () => {
  const at = 1_000_000
  const rows = parseProcessTable(JSON.stringify([{ p: 10, pp: 1, c: at + 5 }, { p: 11, pp: 10, c: at + 50 }, { p: 'x', pp: 1, c: 1 }, { p: 12, pp: 10, c: null }]))
  assert.deepEqual(rows, [{ pid: 10, ppid: 1, created: at + 5 }, { pid: 11, ppid: 10, created: at + 50 }, { pid: 12, ppid: 10, created: null }])
  assert.deepEqual(parseProcessTable('{"p":4,"pp":0,"c":null}'), [{ pid: 4, ppid: 0, created: null }], 'ConvertTo-Json writes a single row without the array')
  for (const garbage of ['', '#< CLIXML', 'null', '42']) assert.equal(parseProcessTable(garbage), null, JSON.stringify(garbage))
  const exitedAt = at + 1000
  // 10 still runs, created right after the runtime began to start it: it goes, with its tree (its children are not listed).
  assert.deepEqual(orphansOf([{ pid: 10, startedAt: at }], rows, { exitedAt }), [10])
  // The OS may date it a timer tick before the clock the runtime read.
  assert.deepEqual(orphansOf([{ pid: 10, startedAt: at + 60 }], rows, { exitedAt }), [10])
  // Created 3 s after the recorded start: pid 10 is another process now, and 11 is that one's child, not an orphan.
  assert.deepEqual(orphansOf([{ pid: 10, startedAt: at - 3000 }], rows, { exitedAt }), [])
  // The recorded process is gone: its children are orphans, if created after its start and before the runtime was gone.
  const orphans = [{ pid: 21, ppid: 20, created: at + 10 }, { pid: 22, ppid: 20, created: at - 500 }, { pid: 23, ppid: 20, created: exitedAt + 5000 }, { pid: 24, ppid: 20, created: null }]
  assert.deepEqual(orphansOf([{ pid: 20, startedAt: at }], orphans, { exitedAt }), [21])
  // Main and the runtime process are never chosen, nor the kernel's pids.
  assert.deepEqual(orphansOf([{ pid: 10, startedAt: at }], rows, { exitedAt, keep: [10] }), [])
  assert.deepEqual(orphansOf([{ pid: 30, startedAt: at }], [{ pid: 4, ppid: 30, created: at + 1 }], { exitedAt }), [])
})

test('after a crash the process table decides what the runtime left: orphans of its processes and a process still running under its recorded start, never a pid that only matches by number', async () => {
  const t0 = Date.now() - 60000
  const table = [
    { pid: 61101, ppid: 61001, created: t0 + 50 }, // an orphan of 61001, which died with the runtime
    { pid: 61102, ppid: 61001, created: t0 - 5000 }, // older than 61001: it names an earlier process with that pid
    { pid: 61103, ppid: 61001, created: Date.now() + 5000 }, // created after the runtime was gone: not 61001's
    { pid: 61002, ppid: 999, created: t0 + 30000 }, // pid 61002 belongs to another process now...
    { pid: 61201, ppid: 61002, created: t0 + 200 }, // ...so only what was created before that is the old 61002's
    { pid: 61202, ppid: 61002, created: t0 + 30001 }, // the new 61002's own child
    { pid: 61003, ppid: 4242, created: t0 + 305 }, // 61003 still runs, created when the runtime started it
    { pid: 61004, ppid: 4242, created: null }, // an unknown creation time: left alone, with its children
    { pid: 61401, ppid: 61004, created: t0 + 400 },
  ]
  const { client, children, killed, order, logs } = harness({ behaviours: [{}, {}], table })
  await client.ready
  children[0].emit({ t: 'processes', processes: [{ pid: 61001, startedAt: t0 }, { pid: 61002, startedAt: t0 + 100 }, { pid: 61003, startedAt: t0 + 300 }, { pid: 61004, startedAt: t0 + 350 }] })
  children[0].exit(9)
  await until(() => children.length === 2 && client.status().state === 'ready', 'restarted')
  assert.deepEqual([...killed].sort(), [61003, 61101, 61201])
  const forked = order.indexOf('fork 2')
  assert.ok(killed.every(pid => order.indexOf(`kill ${pid}`) < forked), `the new runtime starts after the orphans are stopped: ${order.join(', ')}`)
  assert.ok(logs.some(line => line.level === 'warn' && /stopping 3 process\(es\) the runtime .* left behind/.test(line.text)))
  await client.shutdown()
  assert.deepEqual([...killed].sort(), [61003, 61101, 61201], 'the new runtime reported nothing')
})

test('what a shutdown leaves behind is found the same way and waited for; a bare pid or an unreadable table stops nothing', async () => {
  const startedAt = Date.now() - 1000
  const stuck = harness({ behaviours: [{ marked: [] }], table: [{ pid: 62002, ppid: 62001, created: startedAt + 20 }] })
  await stuck.client.ready
  // What would not die in time is reported last, right before shutdown-done.
  stuck.children[0].emit({ t: 'processes', processes: [{ pid: 62001, startedAt }] })
  await stuck.client.shutdown('quit')
  assert.deepEqual(stuck.killed, [62002], 'shutdown waits until the orphan is stopped')

  // Protocol 2's `pids` is no message any more: a pid without its start time is never killed, and not even looked up.
  const legacy = harness({ behaviours: [{ marked: [] }], table: [{ pid: 63001, ppid: 1, created: startedAt }] })
  await legacy.client.ready
  legacy.children[0].emit({ t: 'pids', pids: [63001] })
  await legacy.client.shutdown('quit')
  assert.deepEqual([legacy.killed, legacy.listed.length], [[], 0])
  assert.ok(legacy.logs.some(line => line.level === 'warn' && /does not know: \{"t":"pids"/.test(line.text)))

  // A clean runtime reports nothing left: the table is not read at all.
  const clean = harness({ behaviours: [{ marked: [] }] })
  await clean.client.ready
  clean.children[0].emit({ t: 'processes', processes: [] })
  await clean.client.shutdown('quit')
  assert.equal(clean.listed.length, 0)

  const blind = harness({ behaviours: [{ marked: [] }], listProcesses: async () => null })
  await blind.client.ready
  blind.children[0].emit({ t: 'processes', processes: [{ pid: 64001, startedAt }] })
  await blind.client.shutdown('quit')
  assert.deepEqual(blind.killed, [])
  assert.ok(blind.logs.some(line => line.level === 'warn' && /could not read the process table.*64001/.test(line.text)))
})

test('an approval Orbit cannot read is answered no at once, so the agent does not wait for ever', async () => {
  const asked = []
  const { client, children, logs } = harness({ onApproval: (request) => { asked.push(request); return true } })
  await client.ready
  children[0].emit({ t: 'approval', id: 'q9', request: { tool: 'write_file', toolUseId: null, arguments: {}, runId: 'r', agentId: 'a', agentName: 'A', workspace: 'C:\\ws' } })
  await until(() => children[0].of('approval-result').length === 1, 'answered')
  assert.deepEqual(children[0].of('approval-result'), [{ t: 'approval-result', id: 'q9', approved: false }])
  assert.equal(asked.length, 0, 'no dialog for a question that cannot be shown')
  assert.ok(logs.some(line => line.level === 'warn' && /approval Orbit cannot read, answered no/.test(line.text)))
  children[0].emit({ t: 'approval', id: 7, request: {} })
  children[0].emit({ t: 'unknown', big: 10n })
  await tick()
  assert.equal(children[0].of('approval-result').length, 1, 'without a string id there is nobody to answer')
  assert.ok(logs.some(line => /does not know: object/.test(line.text)), 'a message JSON cannot print is still logged')
  await client.shutdown()
})

test('an uncaught error of the runtime reaches the window as lastError on its status; the runtime keeps running, a new one starts without it', async () => {
  const { client, children, statuses, logs } = harness({ behaviours: [{}, {}] })
  await client.ready
  children[0].emit({ t: 'uncaught', error: { message: 'boom in a timer', stack: 'Error: boom in a timer\n    at tick' }, count: 1 })
  await until(() => client.status().lastError, 'lastError')
  assert.deepEqual({ ...client.status().lastError, at: 0 }, { message: 'boom in a timer', at: 0, count: 1 })
  assert.equal(client.status().state, 'ready', 'the runtime keeps running')
  children[0].emit({ t: 'uncaught', error: { message: 'again' }, count: 4 })
  await until(() => client.status().lastError?.count === 5, 'a burst counts as its number')
  assert.equal(client.status().lastError.message, 'again')
  assert.ok(statuses.at(-1).lastError, 'pushed on runtime:status-changed')
  assert.ok(logs.some(line => line.level === 'error' && /uncaught error in the runtime \(pid \d+\): Error: boom in a timer/.test(line.text)))
  assert.ok(logs.some(line => line.level === 'error' && /\(4 since the last report; the last one\): again/.test(line.text)))
  await client.restart('x')
  assert.equal('lastError' in client.status(), false)
  await client.shutdown()
})

test('a restart during the first start lets that start finish, so `ready` reports it; a quit ends a start or a restart without calling it a failure', async () => {
  const { client, children, states } = harness({ behaviours: [{ ready: false }, {}] })
  const restart = client.restart('window')
  await delay(20)
  assert.deepEqual([children.length, children[0].of('shutdown').length, children[0].killed], [1, 0, false], 'the starting runtime is left alone')
  children[0].emit({ t: 'ready', pid: children[0].osPid, ms: 5, protocol: PROTOCOL_VERSION })
  assert.equal((await client.ready).pid, children[0].osPid, 'the first start is reported as what it was: ready')
  const { pid } = await restart
  assert.equal(pid, children[1].osPid)
  assert.deepEqual(children[0].of('shutdown'), [{ t: 'shutdown', mode: 'restart' }])
  assert.deepEqual(states(), ['starting', 'ready', 'restarting', 'restarting', 'ready'])
  await client.shutdown()

  const quitting = harness({ behaviours: [{ ready: false }] })
  const quit = quitting.client.shutdown('quit')
  await assert.rejects(quitting.client.ready, (error) => error.code === ERROR_CODES.shuttingDown)
  await quit

  const racing = harness({ behaviours: [{}, { ready: false }] })
  await racing.client.ready
  const restarting = racing.client.restart('signal')
  await until(() => racing.children.length === 2, 'the new runtime is starting')
  const relaunch = racing.client.shutdown('restart')
  await assert.rejects(restarting, (error) => error.code === ERROR_CODES.shuttingDown, 'a restart a relaunch ended did not fail')
  await relaunch
  await assert.rejects(racing.client.restart('late'), (error) => error.code === ERROR_CODES.shuttingDown)
  await assert.rejects(racing.client.call('runtime:list', []), (error) => error.code === ERROR_CODES.shuttingDown)
})

test('rendererHealthy reaches the ready runtime, and a runtime that is starting once it is ready', async () => {
  const { client, children } = harness({ behaviours: [{ ready: false }] })
  client.rendererHealthy({ level: 'full', commit: 'abc' })
  await tick()
  assert.equal(children[0].of('renderer-healthy').length, 0)
  children[0].emit({ t: 'ready', pid: children[0].osPid, ms: 1, protocol: PROTOCOL_VERSION })
  await until(() => children[0].of('renderer-healthy').length === 1, 'delivered on ready')
  client.rendererHealthy({ level: 'runtime', commit: null })
  await until(() => children[0].of('renderer-healthy').length === 2, 'delivered at once')
  assert.deepEqual(children[0].of('renderer-healthy').map(message => message.info), [{ level: 'full', commit: 'abc' }, { level: 'runtime', commit: null }])
  await client.shutdown()
})

test('inprocess mode serves the same calls through the service, relays approvals, and cannot restart', async () => {
  const healthy = []
  let serviceOptions
  const asked = []
  const client = createRuntimeClient({
    mode: 'inprocess', userData: 'C:\\profile', repoRoot: 'C:\\repo',
    createService: async (options) => {
      serviceOptions = options
      return { call: async (channel, args) => ({ channel, args }), rendererHealthy: async (info) => { healthy.push(info) }, shutdown: async (mode) => ({ marked: mode === 'restart' ? ['r1'] : [] }) }
    },
    onApproval: (request, signal) => { asked.push({ request, signal }); return new Promise(resolve => signal.addEventListener('abort', () => resolve(true))) },
  })
  assert.equal(client.mode, 'inprocess')
  assert.deepEqual(await client.ready, { pid: process.pid, ms: (await client.ready).ms })
  assert.equal(client.status().state, 'ready')
  assert.deepEqual(await client.call('memory:list', ['C:\\ws']), { channel: 'memory:list', args: ['C:\\ws'] })
  assert.deepEqual([serviceOptions.userData, serviceOptions.repoRoot, typeof serviceOptions.emit, typeof serviceOptions.cancelApproval], ['C:\\profile', 'C:\\repo', 'function', 'function'])
  const answer = serviceOptions.requestApproval({ id: 'q1', tool: 'write_file', arguments: {}, runId: 'r', agentId: 'a', agentName: 'A', workspace: 'C:\\ws' })
  await until(() => asked.length === 1, 'dialog')
  assert.equal('id' in asked[0].request, false, 'the dialog gets the request without the wire id')
  serviceOptions.cancelApproval('q1')
  assert.equal(await answer, false, 'a withdrawn approval is a no')
  client.rendererHealthy({ level: 'full', commit: 'c1' })
  await until(() => healthy.length === 1, 'renderer-healthy')
  await assert.rejects(client.restart('x'), /inprocess/)
  assert.deepEqual(await client.shutdown('restart'), { marked: ['r1'] })
  assert.equal(client.status().state, 'stopped')
  await assert.rejects(client.call('memory:list', []), /shutting down/)
})

// ---- The real runtime child (electron/runtime-child.cjs) over Node IPC ----------------------------------------------

test('the real runtime child resolves the system proxy through main: systemProxy() in the runtime asks the client', { timeout: 120000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-proxy-'))
  // A fixtures module whose provider check reports what systemProxy() says inside the runtime process.
  const fixtures = path.join(profile, 'proxy-fixtures.cjs')
  fs.writeFileSync(fixtures, [
    `const network = require(${JSON.stringify(path.join(__dirname, '..', 'electron', 'provider-network.mts'))})`,
    'module.exports = { inspectProviders: async () => [{ id: \'probe\', detail: await network.systemProxy() }] }',
  ].join('\n'))
  const asked = []
  let answer = 'PROXY 10.9.8.7:3128; DIRECT'
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'), fork: nodeFork({ cwd: os.tmpdir() }),
    env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    resolveProxy: async (url) => { asked.push(url); if (answer instanceof Error) throw answer; return answer },
  })
  try {
    await client.ready
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: 'http://10.9.8.7:3128' }])
    assert.deepEqual(asked, ['https://daily-cloudcode-pa.googleapis.com'])
    answer = 'DIRECT'
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: '' }], 'DIRECT: no proxy')
    // Main cannot tell: the runtime falls back to what this machine's registry says, as it did before.
    answer = new Error('no session')
    const fallback = await require('../electron/provider-network.mts').systemProxy()
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: fallback }])
    await client.shutdown('quit')
  } finally {
    await client.kill()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('the real runtime child starts, answers, restarts with its fixtures, and shuts down', { timeout: 120000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-client-'))
  const statuses = []
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'),
    fork: nodeFork({ cwd: os.tmpdir() }),
    env: { ORBIT_RUNTIME_FIXTURES: path.join(__dirname, '..', 'scripts', 'smoke-fixtures.cjs'), ORBIT_SMOKE_FIXTURE_DIR: profile },
    onStatus: status => statuses.push(status.state),
    log: (level, text) => logs.push(`${level}: ${text}`),
  })
  try {
    const ready = await client.ready
    t.diagnostic(`first start: ready ${ready.ms} ms after the fork (pid ${ready.pid})`)
    assert.notEqual(ready.pid, process.pid)
    assert.equal(await client.call('state:load', []), null, 'a new profile has no saved state')
    assert.deepEqual(await client.call('runtime:list', []), [])
    const health = await client.call('providers:health', [{}])
    assert.deepEqual(health.map(entry => entry.detail), ['fixture', 'fixture', 'fixture endpoint'], 'the fixtures module replaced the provider check')
    await assert.rejects(client.call('no:such-channel', []), (error) => error.code === 'ORBIT_UNKNOWN_CHANNEL')
    await assert.rejects(client.call('runtime:start', [{ workspace: 'relative/path' }]), /absolute project folder/)
    const saved = { version: 3, projects: [], activeProjectId: null, settings: {} }
    await client.call('state:save', [saved])
    const restarted = await client.restart('test')
    t.diagnostic(`runtime restart: ${restarted.ms} ms (pid ${ready.pid} -> ${restarted.pid})`)
    assert.notEqual(restarted.pid, ready.pid)
    assert.throws(() => process.kill(ready.pid, 0), /ESRCH/, 'the old runtime process is gone')
    assert.deepEqual(await client.call('state:load', []), saved, 'what the old runtime saved, the new one reads')
    assert.deepEqual(statuses.slice(0, 2), ['starting', 'ready'])
    assert.ok(statuses.includes('restarting') && statuses.at(-1) === 'ready')
    assert.deepEqual(await client.shutdown('quit'), { marked: [] })
    assert.equal(client.status().state, 'stopped')
    assert.throws(() => process.kill(restarted.pid, 0), /ESRCH/, 'the runtime exited after shutdown-done')
  } finally {
    await client.kill()
    fs.rmSync(profile, { recursive: true, force: true })
  }
  assert.ok(!logs.some(line => /stopped unexpectedly|fatal/.test(line)), logs.join('\n'))
})

test('the real runtime child takes its profile from --user-data before the environment, and nothing it starts inherits Orbit\'s own variables', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-env-'))
  const fromArgument = path.join(root, 'argument-profile')
  const fromEnvironment = path.join(root, 'environment-profile')
  for (const folder of [fromArgument, fromEnvironment]) fs.mkdirSync(folder)
  // The provider check reports which of the variables main set the runtime itself still has, and which a process it
  // starts inherits.
  const fixtures = path.join(root, 'env-fixtures.cjs')
  fs.writeFileSync(fixtures, `'use strict'
const { execFileSync } = require('node:child_process')
const names = ['ORBIT_USER_DATA_DIR', 'ORBIT_REPO_ROOT', 'ORBIT_PARENT_PID']
const listEnv = 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'
exports.inspectProviders = async () => {
  const inherited = JSON.parse(execFileSync(process.execPath, ['-e', listEnv], { encoding: 'utf8', windowsHide: true }))
  const named = (keys) => names.filter((name) => keys.some((key) => key.toUpperCase() === name))
  return [{ id: 'env', detail: JSON.stringify({ own: named(Object.keys(process.env)), child: named(inherited) }) }]
}
`)
  const client = createRuntimeClient({
    // The client puts this profile, the repository and main's pid into the child's environment...
    userData: fromEnvironment, repoRoot: path.join(__dirname, '..'), env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    // ...and this fork names another profile on the command line.
    fork: (entry, { env }) => adaptChildProcess(childProcess.fork(entry, ['--user-data', fromArgument], {
      execArgv: NODE_EXEC_ARGV, serialization: 'advanced', env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    })),
  })
  try {
    await client.ready
    const [probe] = await client.call('providers:health', [{}])
    assert.deepEqual(JSON.parse(probe.detail), { own: [], child: [] }, 'read once and removed: neither the runtime nor what it starts has them')
    assert.equal(await client.call('state:save', [{ version: 3 }]), true)
    assert.ok(fs.existsSync(path.join(fromArgument, 'workspace-state.json')), 'the profile given by --user-data')
    assert.ok(!fs.existsSync(path.join(fromEnvironment, 'workspace-state.json')), 'not the one in ORBIT_USER_DATA_DIR')
    await client.shutdown('quit')
  } finally {
    await client.kill()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('the real runtime child reports uncaught errors at most once a second and keeps running', { timeout: 120000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-uncaught-'))
  // The provider check throws five errors nothing catches, right after it answered.
  const fixtures = path.join(profile, 'throwing-fixtures.cjs')
  fs.writeFileSync(fixtures, `'use strict'
exports.inspectProviders = async () => {
  for (let index = 0; index < 5; index++) setImmediate(() => { throw new Error('stray ' + index) })
  return [{ id: 'probe', detail: 'answered' }]
}
`)
  const statuses = []
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'), fork: nodeFork({ cwd: os.tmpdir() }), env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    onStatus: status => statuses.push(status), log: (level, text) => logs.push(`${level}: ${text}`),
  })
  try {
    await client.ready
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: 'answered' }])
    await until(() => client.status().lastError?.count === 5, 'all five counted', 10000)
    const reports = statuses.filter(status => status.lastError).map(status => [status.lastError.message, status.lastError.count])
    assert.deepEqual(reports, [['stray 0', 1], ['stray 4', 5]], 'the first at once, the other four as one report a second later')
    const [first, second] = statuses.filter(status => status.lastError).map(status => status.lastError.at)
    assert.ok(second - first >= 900, `a second apart: ${second - first} ms`)
    assert.equal(client.status().state, 'ready')
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: 'answered' }], 'the runtime still answers')
    assert.ok(logs.some(line => /^error: uncaught error in the runtime \(pid \d+\): Error: stray 0/.test(line)), logs.join('\n'))
    await client.shutdown('quit')
  } finally {
    await client.kill()
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// The review's scenario: a runtime starts a native CLI (cmd.exe) that starts a grandchild (PING.EXE), and crashes. On
// Windows the CLI dies with the runtime (libuv's kill-on-close job), the grandchild does not, and taskkill /t cannot
// reach it through the dead CLI; the client finds it in the process table by its parent pid and creation time.
test('Windows: after a crash the orphaned grandchild of a CLI the runtime started is stopped (cmd.exe -> PING.EXE)', { skip: process.platform === 'win32' ? false : 'the process table is read on Windows only', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-reap-'))
  const entry = path.join(root, 'crashing-runtime.cjs')
  const cliFile = path.join(root, 'cli.json')
  fs.writeFileSync(entry, `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
process.send({ t: 'ready', pid: process.pid, ms: 1, protocol: ${PROTOCOL_VERSION} })
const startedAt = Date.now()
const cli = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' })
cli.once('spawn', () => {
  process.send({ t: 'processes', processes: [{ pid: cli.pid, startedAt }] })
  fs.writeFileSync(${JSON.stringify(cliFile)}, JSON.stringify({ pid: cli.pid, startedAt }))
})
process.on('message', (message) => { if (message && message.t === 'call' && message.channel === 'crash') process.exit(1) })
`)
  const logs = []
  const client = createRuntimeClient({
    userData: root, repoRoot: path.join(__dirname, '..'), entry, fork: nodeFork({ cwd: os.tmpdir() }),
    settings: { maxAutoRestarts: 0 }, log: (level, text) => logs.push(`${level}: ${text}`),
  })
  t.after(async () => {
    await client.kill()
    // A failed run leaves nothing either: the CLI's tree, found the same way.
    if (fs.existsSync(cliFile)) {
      const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'))
      for (const pid of orphansOf([cli], (await listProcessTable()) ?? [], { exitedAt: Date.now() })) await killProcessTree(pid)
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const childrenOf = async (cli) => ((await listProcessTable()) ?? []).filter(row => row.ppid === cli.pid && row.created !== null && row.created >= cli.startedAt - 100)
  const imageName = (pid) => childProcess.execFileSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).split(',')[0].replace(/"/g, '').trim()

  await client.ready
  await until(() => fs.existsSync(cliFile), 'the CLI started', 20000)
  const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'))
  let before = []
  for (const deadline = Date.now() + 20000; !before.some(row => imageName(row.pid) === 'PING.EXE') && Date.now() < deadline;) before = await childrenOf(cli)
  assert.ok(before.some(row => imageName(row.pid) === 'PING.EXE'), 'PING.EXE runs under the CLI')

  await assert.rejects(client.call('crash', []), /stopped unexpectedly/)
  let after = before
  for (const deadline = Date.now() + 30000; after.length && Date.now() < deadline;) after = await childrenOf(cli)
  assert.deepEqual(after, [], `nothing the CLI started outlives the runtime:\n${logs.join('\n')}`)
  assert.throws(() => process.kill(before[0].pid, 0), /ESRCH/)
  assert.ok(logs.some(line => /stopping \d+ process\(es\) the runtime \(pid \d+\) left behind/.test(line)), logs.join('\n'))
})

// The same with the real runtime: its provider (a fixture) starts the CLI inside a run, the runtime records it through
// Node's diagnostics channel with the time the spawn began (runtime-host.mts), and then the runtime process dies.
test('Windows: the real runtime records what it starts well enough for main to stop the orphans after it crashed', { skip: process.platform === 'win32' ? false : 'the process table is read on Windows only', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-reap-real-'))
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, 'workspace')
  for (const folder of [profile, workspace]) fs.mkdirSync(folder)
  const cliFile = path.join(root, 'cli.json')
  const fixtures = path.join(root, 'cli-fixtures.cjs')
  fs.writeFileSync(fixtures, `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
exports.runProvider = async (options) => {
  const startedAt = Date.now()
  const cli = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve) => cli.once('spawn', resolve))
  fs.writeFileSync(${JSON.stringify(cliFile)}, JSON.stringify({ pid: cli.pid, startedAt }))
  await new Promise((resolve) => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }) })
  throw Object.assign(new Error('stopped'), { name: 'AbortError' })
}
// The runtime process dies the hard way when asked to: no shutdown, no clean-up of its own.
exports.inspectProviders = async (options) => { if (options && options.crash) setImmediate(() => process.exit(1)); return [] }
`)
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'), fork: nodeFork({ cwd: os.tmpdir() }), env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    settings: { maxAutoRestarts: 0 }, log: (level, text) => logs.push(`${level}: ${text}`),
  })
  t.after(async () => {
    await client.kill()
    if (fs.existsSync(cliFile)) {
      const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'))
      for (const pid of orphansOf([cli], (await listProcessTable()) ?? [], { exitedAt: Date.now() })) await killProcessTree(pid)
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const childrenOf = async (cli) => ((await listProcessTable()) ?? []).filter(row => row.ppid === cli.pid && row.created !== null && row.created >= cli.startedAt - 100)

  await client.ready
  await client.call('runtime:start', [{
    projectId: 'project', chatId: 'chat', prompt: 'Run the CLI', history: [], workspace, memoryEnabled: false,
    providerId: 'custom', model: 'fixture-model', agentInstructions: '', accessMode: 'workspace-write', approvalPolicy: 'never', limits: {},
  }])
  await until(() => fs.existsSync(cliFile), 'the provider started its CLI', 30000)
  const cli = JSON.parse(fs.readFileSync(cliFile, 'utf8'))
  let before = []
  for (const deadline = Date.now() + 20000; !before.length && Date.now() < deadline;) before = await childrenOf(cli)
  assert.ok(before.length > 0, 'the CLI has children of its own')

  await client.call('providers:health', [{ crash: true }]).catch(() => {})
  await until(() => client.status().state === 'stopped', 'the runtime is gone', 20000)
  let after = before
  for (const deadline = Date.now() + 30000; after.length && Date.now() < deadline;) after = await childrenOf(cli)
  assert.deepEqual(after, [], `nothing the CLI started outlives the runtime:\n${logs.join('\n')}`)
  assert.ok(logs.some(line => /stopping \d+ process\(es\) the runtime \(pid \d+\) left behind/.test(line)), logs.join('\n'))
})
