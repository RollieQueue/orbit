const test = require('node:test')
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

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

test('the protocol keeps an error\'s message, stack and code, and rejects messages that are not its own', () => {
  const error = Object.assign(new Error('refused'), { code: 'EPERM' })
  const wire = protocol.serializeError(error)
  assert.deepEqual([wire.message, wire.code, typeof wire.stack], ['refused', 'EPERM', 'string'])
  const back = protocol.deserializeError(wire)
  assert.ok(back instanceof Error)
  assert.deepEqual([back.message, back.code, back.stack], ['refused', 'EPERM', wire.stack])
  assert.deepEqual(protocol.serializeError('plain'), { message: 'plain' })
  assert.deepEqual(protocol.serializeError(Object.assign(new Error('numbered'), { code: 42, stack: undefined })), { message: 'numbered', code: '42' })
  assert.deepEqual(protocol.parseToChild({ t: 'call', id: 1, channel: 'runtime:list', args: [] }), { t: 'call', id: 1, channel: 'runtime:list', args: [] })
  assert.deepEqual(protocol.parseToChild({ t: 'renderer-healthy', info: { level: 'runtime', commit: null } }), { t: 'renderer-healthy', info: { level: 'runtime', commit: null } })
  for (const garbage of [null, 'call', [], { t: 'call', id: '1', channel: 'x', args: [] }, { t: 'call', id: 1, channel: 'x' }, { t: 'shutdown', mode: 'now' }, { t: 'approval-result', id: 'a' }, { t: 'renderer-healthy', info: { level: 'all', commit: null } }, { t: 'other' }]) {
    assert.equal(protocol.parseToChild(garbage), null, JSON.stringify(garbage))
  }
  assert.deepEqual(protocol.parseFromChild({ t: 'result', id: 3, ok: false, error: { message: 'x', code: 'E' } }), { t: 'result', id: 3, ok: false, error: { message: 'x', code: 'E' } })
  assert.equal(protocol.parseFromChild({ t: 'ready', pid: 5, ms: 9, protocol: protocol.PROTOCOL_VERSION }).protocol, protocol.PROTOCOL_VERSION)
  assert.equal(protocol.parseFromChild({ t: 'ready', pid: 5, ms: 9 }).protocol, 0, 'a runtime that predates the version field reads as version 0, a mismatch')
  assert.deepEqual(protocol.parseFromChild({ t: 'processes', processes: [{ pid: 4, startedAt: 1700000000000, extra: 1 }] }), { t: 'processes', processes: [{ pid: 4, startedAt: 1700000000000 }] })
  assert.deepEqual(protocol.parseFromChild({ t: 'uncaught', error: { message: 'boom', stack: 'Error: boom' }, count: 3 }), { t: 'uncaught', error: { message: 'boom', stack: 'Error: boom' }, count: 3 })
  assert.deepEqual(protocol.parseFromChild({ t: 'approval', id: 'a', request: { tool: 't', arguments: { a: 1 }, runId: 'r', agentId: 'root', agentName: 'Orbit', workspace: 'w' } }).request.arguments, { a: 1 })
  for (const garbage of [
    { t: 'ready', pid: 'x', ms: 1 }, { t: 'result', id: 1, ok: false }, { t: 'shutdown-done', marked: [1] }, { t: 'log', level: 'debug', text: 'x' },
    { t: 'approval', id: 'a', request: { tool: 't' } }, { t: 'approval', id: 'a', request: { tool: 't', arguments: {}, toolUseId: null, runId: 'r', agentId: 'root', agentName: 'Orbit', workspace: 'w' } },
    // Protocol 2's bare pids: without a start time a pid cannot be told from a reused one.
    { t: 'pids', pids: [4, 8] }, { t: 'processes', processes: [4] }, { t: 'processes', processes: [{ pid: 4 }] }, { t: 'processes', processes: [{ pid: 0, startedAt: 1 }] }, { t: 'processes' },
    { t: 'uncaught', error: { message: 'x' }, count: 0 }, { t: 'uncaught', error: 'x', count: 1 },
  ]) {
    assert.equal(protocol.parseFromChild(garbage), null, JSON.stringify(garbage))
  }
})

test('the runtime channels and main\'s channels together are the IPC contract, without overlap', () => {
  const calls = require('../electron/ipc-contract.cjs').callChannels()
  const runtime = new Set(protocol.RUNTIME_CHANNELS), shell = new Set(protocol.SHELL_CHANNELS)
  assert.deepEqual([...runtime].filter((channel) => shell.has(channel)), [])
  assert.deepEqual(calls.filter((channel) => !runtime.has(channel) && !shell.has(channel)), [], 'every contract channel is served by main or the runtime')
  assert.deepEqual([...runtime].filter((channel) => !calls.includes(channel)), [], 'the runtime serves only contract channels')
  assert.deepEqual([...protocol.EVENT_CHANNELS].sort(), ['quota:update', 'restart:notice', 'runtime:event'])
})

test('a forked runtime starts, answers calls, forwards events and approvals, and exits after shutdown', async (t) => {
  const layout = temporary(t)
  const runtime = startChild(layout)
  const ready = await runtime.ready
  assert.equal(ready.pid, runtime.child.pid)
  assert.equal(ready.protocol, protocol.PROTOCOL_VERSION)
  assert.ok(ready.ms > 0 && ready.ms < 20000)
  t.diagnostic(`cold start on Node ${process.versions.node}: ready ${ready.ms} ms after the child's process start, ${ready.wallMs} ms after fork()`)

  // Plain calls: stores, state, lists; errors keep their message and code.
  assert.deepEqual(await runtime.call('runtime:list'), [])
  const note = await runtime.call('memory:save', { title: 'Fact', content: 'The child answers', scope: 'project', workspace: layout.workspace })
  assert.equal(note.title, 'Fact')
  assert.deepEqual((await runtime.call('memory:list', layout.workspace)).map((entry) => entry.id), [note.id])
  assert.deepEqual(await runtime.call('memory:list', 42), [], 'a workspace that is not a string sees no project notes')
  assert.equal(await runtime.call('state:save', { version: 3, projects: [] }), true)
  assert.deepEqual(await runtime.call('state:load'), { version: 3, projects: [] })
  assert.equal((await runtime.call('providers:health'))[0].detail, 'fixture')
  assert.equal((await runtime.call('quota:get', {}, true)).codex.detail, 'fixture reader', 'the fixture patched the quota readers')
  await assert.rejects(runtime.call('memory:save', null), /Memory entry is required/)
  await assert.rejects(runtime.call('no:such-channel'), (error) => error.code === protocol.ERROR_CODES.unknownChannel)
  await assert.rejects(runtime.call('runtime:start', { ...payload(layout, 'x'), workspace: 'relative' }), /Choose an absolute project folder/)
  assert.equal(await runtime.call('runtime:stop', 7), false)
  assert.equal(await runtime.call('runtime:get', 'missing'), null)

  // A run: its events reach the parent before and after the result of the call that started it.
  const runId = await runtime.call('runtime:start', payload(layout, 'Say hello'))
  assert.match(runId, /^[\w-]+$/)
  const finished = await runtime.event((event) => event.type === 'run.finished' && event.runId === runId, 'run.finished')
  assert.equal(finished.status, 'completed')
  const startedAt = runtime.messages.findIndex((message) => message.t === 'event' && message.payload.type === 'run.started' && message.payload.runId === runId)
  const answeredAt = runtime.messages.findIndex((message) => message.t === 'result' && message.value === runId)
  assert.ok(startedAt >= 0 && startedAt < answeredAt, 'run.started reaches main before the run id it answers with, as it did in-process')
  const run = await runtime.call('runtime:get', runId)
  assert.ok(run.messages.some((message) => message.text === 'fixture answer 1'))
  assert.deepEqual((await runtime.call('runtime:list')).map((item) => item.runId), [runId])

  // Approval round trip: the question reaches main with its run and agent; the answer reaches the provider.
  const asking = await runtime.call('runtime:start', payload(layout, 'ASK_APPROVAL for a write', { chatId: 'chat-approval' }))
  const approval = await runtime.waitFor((message) => message.t === 'approval' && message.request.runId === asking, 'approval')
  assert.equal(typeof approval.id, 'string')
  assert.deepEqual({ ...approval.request, workspace: undefined }, { tool: 'write_file', arguments: { path: 'approved.txt', content: 'fixture' }, runId: asking, agentId: 'root', agentName: 'Orbit', workspace: undefined })
  assert.equal(approval.request.workspace, fs.realpathSync.native(layout.workspace))
  runtime.send({ t: 'approval-result', id: approval.id, approved: true })
  await runtime.event((event) => event.type === 'run.finished' && event.runId === asking, 'approved run finished')
  assert.ok((await runtime.call('runtime:get', asking)).messages.some((message) => message.text === 'approval: yes'))

  // A question whose tool id is null (a Claude session sends tool_use_id: null) still reaches main as one it can read:
  // before, main dropped it as malformed and the agent waited for an answer that never came.
  const odd = await runtime.call('runtime:start', payload(layout, 'ASK_ODD_APPROVAL for a command', { chatId: 'chat-odd' }))
  const oddQuestion = await runtime.waitFor((message) => message.t === 'approval' && message.request.runId === odd, 'the approval with a null tool id')
  assert.equal('toolUseId' in oddQuestion.request, false, 'a tool id that is not text is left out')
  assert.equal(protocol.parseFromChild(oddQuestion)?.request.tool, 'run_command', 'main reads the question')
  runtime.send({ t: 'approval-result', id: oddQuestion.id, approved: true })
  await runtime.event((event) => event.type === 'run.finished' && event.runId === odd, 'the odd approval run finished')
  assert.ok((await runtime.call('runtime:get', odd)).messages.some((message) => message.text === 'approval: yes'))

  // A run stopped while its question is open withdraws it: main gets approval-cancel for the same id.
  const withdrawn = await runtime.call('runtime:start', payload(layout, 'ASK_APPROVAL and then stop', { chatId: 'chat-cancel' }))
  const open = await runtime.waitFor((message) => message.t === 'approval' && message.request.runId === withdrawn, 'second approval')
  assert.equal(await runtime.call('runtime:stop', withdrawn), true)
  await runtime.waitFor((message) => message.t === 'approval-cancel' && message.id === open.id, 'approval-cancel')
  await runtime.event((event) => event.type === 'run.cancelled' && event.runId === withdrawn, 'run.cancelled')

  // Shutdown: stops what runs (the provider's own process included), saves, answers, exits. Main learns the processes
  // the runtime started while they run, each with the time its spawn began, and the set that is left just before
  // shutdown-done.
  const holdAsked = Date.now()
  const holding = await runtime.call('runtime:start', payload(layout, 'HOLD until shutdown', { chatId: 'chat-hold' }))
  await runtime.event((event) => event.type === 'agent.updated' && event.runId === holding && event.agent?.status === 'working', 'holding agent working')
  // The set may also name short-lived helpers (Git for the project index) that have exited by the time it is read;
  // the provider process holds until shutdown, so wait for a report that names a live one.
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const report = await runtime.waitFor((message) => message.t === 'processes' && message.processes.some((entry) => alive(entry.pid)), 'the provider process')
  assert.ok(protocol.parseFromChild(report), 'a message main reads')
  const cli = report.processes.find((entry) => alive(entry.pid))
  assert.doesNotThrow(() => process.kill(cli.pid, 0), 'the reported process is running')
  assert.ok(cli.startedAt >= holdAsked - 50 && cli.startedAt <= Date.now(), `its spawn began after the run was asked for: ${cli.startedAt - holdAsked} ms`)
  runtime.send({ t: 'shutdown', mode: 'quit' })
  const done = await runtime.waitFor((message) => message.t === 'shutdown-done', 'shutdown-done')
  assert.deepEqual(done.marked, [])
  const doneAt = runtime.messages.indexOf(done)
  assert.deepEqual(runtime.messages.slice(0, doneAt).filter((message) => message.t === 'processes').at(-1).processes, [], 'nothing the runtime started outlives its shutdown')
  assert.ok(!runtime.messages.some((message) => message.t === 'pids'), 'the bare pids of protocol 2 are gone')
  assert.throws(() => process.kill(cli.pid, 0), /ESRCH/)
  assert.deepEqual(await runtime.exited, { code: 0, signal: null })
  const saved = JSON.parse(fs.readFileSync(path.join(layout.userData, 'run-history', `${holding}.json`), 'utf8'))
  assert.equal(saved.status, 'cancelled', 'the run that was still working was stopped and saved before the exit')
  assert.ok(JSON.parse(fs.readFileSync(path.join(layout.userData, 'memory.json'), 'utf8')).some((entry) => entry.id === note.id))
})

test('a failure before ready is reported as fatal and ends the child with exit code 1', async (t) => {
  const layout = temporary(t)
  const broken = path.join(layout.root, 'broken-fixtures.cjs')
  fs.writeFileSync(broken, 'throw new Error("fixture exploded while loading")\n')
  const runtime = startChild(layout, { fixtures: broken })
  await assert.rejects(runtime.ready, /fixture exploded while loading/)
  const fatal = runtime.messages.find((message) => message.t === 'fatal')
  assert.match(fatal.error.stack, /broken-fixtures\.cjs/)
  assert.ok(!runtime.messages.some((message) => message.t === 'ready'))
  assert.deepEqual(await runtime.exited, { code: 1, signal: null })

  const noProfile = startChild(layout, { env: { ORBIT_USER_DATA_DIR: '' } })
  await assert.rejects(noProfile.ready, /needs a profile folder/)
  assert.equal((await noProfile.exited).code, 1)
})

test('a smoke (ORBIT_SMOKE=1) never starts a runtime without fixtures for every provider-facing function', async (t) => {
  const layout = temporary(t)
  const bare = startChild(layout, { env: { ORBIT_SMOKE: '1' }, fixtures: '' })
  await assert.rejects(bare.ready, /ORBIT_SMOKE=1: the runtime refuses to start without fixtures for runProvider, inspectProviders, patchQuotaReaders/)
  assert.equal((await bare.exited).code, 1)
  const partial = path.join(layout.root, 'partial-fixtures.cjs')
  fs.writeFileSync(partial, 'exports.runProvider = async () => ({ text: "x" })\nexports.inspectProviders = async () => []\n')
  const incomplete = startChild(layout, { env: { ORBIT_SMOKE: '1' }, fixtures: partial })
  await assert.rejects(incomplete.ready, /without fixtures for patchQuotaReaders/)
  assert.equal((await incomplete.exited).code, 1)
  const fixtured = startChild(layout, { env: { ORBIT_SMOKE: '1' } })
  await fixtured.ready
  fixtured.send({ t: 'shutdown', mode: 'quit' })
  assert.equal((await fixtured.exited).code, 0)
})

// Only a child_process.fork parent (these tests, a Node host) leaves the runtime running when it goes away: under
// utilityProcess Chromium terminates the runtime together with main (measured: gone within 50 ms, no exit handlers),
// so a crash of main never gets the graceful shutdown of the next two tests.
test('a runtime whose parent channel closes stops its runs, saves and exits', async (t) => {
  const layout = temporary(t)
  const runtime = startChild(layout)
  await runtime.ready
  const runId = await runtime.call('runtime:start', payload(layout, 'HOLD until the parent is gone'))
  await runtime.event((event) => event.type === 'agent.updated' && event.runId === runId && event.agent?.status === 'working', 'agent working')
  runtime.child.disconnect()
  assert.deepEqual(await runtime.exited, { code: 0, signal: null })
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.userData, 'run-history', `${runId}.json`), 'utf8')).status, 'cancelled')
})

test('a runtime forked by a Node parent that is gone (ORBIT_PARENT_PID, the channel still open) shuts down on its own', async (t) => {
  const layout = temporary(t)
  const { spawnSync } = require('node:child_process')
  const pid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { cwd: os.tmpdir(), encoding: 'utf8' }).stdout)
  try { process.kill(pid, 0); t.skip('the pid of the exited process was reused at once'); return } catch { /* Gone, as wanted. */ }
  const runtime = startChild(layout, { env: { ORBIT_PARENT_PID: String(pid) } })
  assert.deepEqual(await runtime.exited, { code: 0, signal: null })
  assert.ok(!runtime.messages.some((message) => message.t === 'fatal'))
})

// P1 (electron/resume.mts, restart_orbit): a shutdown for a restart ends the run the intent names as 'restarting', and
// the next runtime continues it once main reports the renderer healthy.
const restartSupport = (() => {
  try {
    const resume = require('../electron/resume.mts')
    const { OrbitRuntime } = require('../electron/runtime.mts')
    return typeof resume.markRestartingRuns === 'function' && typeof OrbitRuntime.prototype.markRestarting === 'function' && typeof OrbitRuntime.prototype.setRestartHost === 'function'
  } catch { return false }
})()

test('shutdown for a restart marks the requesting run restarting, and the next runtime continues it', { skip: restartSupport ? false : 'electron/resume.mts (P1) is not in place yet' }, async (t) => {
  const layout = temporary(t)
  const first = startChild(layout)
  await first.ready
  const runId = await first.call('runtime:start', payload(layout, 'HOLD until Orbit restarts', { chatId: 'chat-restart' }))
  const bystander = await first.call('runtime:start', payload(layout, 'HOLD in another chat', { chatId: 'chat-other' }))
  for (const id of [runId, bystander]) await first.event((event) => event.type === 'agent.updated' && event.runId === id && event.agent?.status === 'working', `agent of ${id} working`)
  fs.writeFileSync(path.join(layout.userData, 'pending-resume.json'), JSON.stringify({
    version: 1, id: 'upgrade-1', createdAt: new Date().toISOString(), source: 'tool', reason: 'new tool', continueWith: 'Continue with the new tool', verify: true,
    runId, chatId: 'chat-restart', projectId: 'project', agentId: 'root', level: 'runtime', state: 'relaunching', commit: null, outcome: null, error: null, patch: null,
  }))
  first.send({ t: 'shutdown', mode: 'restart' })
  assert.deepEqual((await first.waitFor((message) => message.t === 'shutdown-done', 'shutdown-done')).marked, [runId])
  assert.deepEqual(await first.exited, { code: 0, signal: null })
  const history = (id) => JSON.parse(fs.readFileSync(path.join(layout.userData, 'run-history', `${id}.json`), 'utf8'))
  assert.equal(history(runId).status, 'restarting')
  assert.equal(history(runId).restart.intentId, 'upgrade-1', 'the mark names the intent that alone continues the run')
  assert.equal(history(bystander).status, 'cancelled')

  const second = startChild(layout)
  await second.ready
  assert.equal((await second.call('runtime:get', runId)).status, 'restarting', 'a restarting run is not turned into an interrupted one on load')
  // What the self-upgrade watcher adds once it has seen the new runtime's healthy report; the continuation waits for it.
  const intentFile = path.join(layout.userData, 'pending-resume.json')
  fs.writeFileSync(intentFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(intentFile, 'utf8')), verdict: 'relaunched', verdictAt: new Date().toISOString() }))
  second.send({ t: 'renderer-healthy', info: { level: 'runtime', commit: null } })
  const notice = await second.waitFor((message) => message.t === 'event' && message.channel === 'restart:notice', 'restart notice').then((message) => message.payload)
  assert.equal(notice.kind, 'resumed', JSON.stringify(notice))
  assert.equal(notice.runId, runId)
  const continued = await second.event((event) => event.type === 'run.finished' && event.runId === notice.resumedRunId, 'the continuation finished')
  assert.equal(continued.status, 'completed')
  const resumed = await second.call('runtime:get', notice.resumedRunId)
  assert.equal(resumed.chatId, 'chat-restart')
  assert.match(resumed.prompt, /^Continue with the new tool/)
  assert.ok(!fs.existsSync(path.join(layout.userData, 'pending-resume.json')), 'the intent is consumed')
  second.send({ t: 'renderer-healthy', info: { level: 'runtime', commit: null } })
  second.send({ t: 'shutdown', mode: 'quit' })
  await second.waitFor((message) => message.t === 'shutdown-done', 'second shutdown-done')
  assert.equal((await second.exited).code, 0)
  assert.equal(second.messages.filter((message) => message.t === 'event' && message.channel === 'restart:notice').length, 1, 'a pending restart is continued once per runtime')
})

test('in process: createRuntimeService serves the same channels, bridges approvals and refuses new runs once shutting down', async (t) => {
  const layout = temporary(t)
  const { createRuntimeService } = require('../electron/runtime-host.mts')
  const fixtures = require(layout.fixtures)
  const quiet = { userData: layout.userData, repoRoot: repo, emit: () => {}, requestApproval: async () => false, log: () => {} }
  process.env.ORBIT_SMOKE = '1'
  try { assert.throws(() => createRuntimeService(quiet), /ORBIT_SMOKE=1: the runtime refuses to start without fixtures/) } finally { delete process.env.ORBIT_SMOKE }
  const events = [], asked = [], cancelled = []
  let answer = true
  const service = createRuntimeService({
    userData: layout.userData, repoRoot: repo,
    emit: (channel, payload) => events.push({ channel, payload }),
    requestApproval: async (request) => { asked.push(request); return answer },
    cancelApproval: (id) => cancelled.push(id),
    log: () => {},
    overrides: fixtures,
  })
  assert.deepEqual([...service.channels].sort(), [...protocol.RUNTIME_CHANNELS].sort())
  assert.equal(await service.call('memory:sharing', [layout.workspace, true]), true)
  await assert.rejects(service.call('workspace:pick', []), (error) => error.code === protocol.ERROR_CODES.unknownChannel)

  const finished = (runId) => new Promise((resolve) => {
    const check = () => { const event = events.find((item) => item.channel === 'runtime:event' && item.payload.runId === runId && ['run.finished', 'run.failed', 'run.cancelled'].includes(item.payload.type)); if (event) resolve(event.payload); else setTimeout(check, 20) }
    check()
  })
  const runId = await service.call('runtime:start', [payload(layout, 'ASK_APPROVAL in process')])
  assert.equal((await finished(runId)).type, 'run.finished')
  assert.equal(asked.length, 1)
  assert.deepEqual(Object.keys(asked[0]).sort(), ['agentId', 'agentName', 'arguments', 'id', 'runId', 'tool', 'workspace'])
  assert.ok(service.runtime.getRun(runId).messages.some((message) => message.text === 'approval: yes'))
  answer = false
  const declined = await service.call('runtime:start', [payload(layout, 'ASK_APPROVAL again', { chatId: 'chat-2' })])
  await finished(declined)
  assert.ok(service.runtime.getRun(declined).messages.some((message) => message.text === 'approval: no'))
  assert.deepEqual(cancelled, [])

  const holdAsked = Date.now()
  const holding = await service.call('runtime:start', [payload(layout, 'HOLD in process', { chatId: 'chat-3' })])
  const deadline = Date.now() + 10000
  while (!service.processes().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(service.processes().length, 1, 'the provider\'s own process is known while it runs')
  const [provider] = service.processes()
  assert.deepEqual(Object.keys(provider).sort(), ['pid', 'startedAt'])
  assert.ok(provider.startedAt >= holdAsked && provider.startedAt <= Date.now(), 'with the time its spawn began')
  const result = await service.shutdown('quit')
  assert.deepEqual(result, { marked: [] })
  assert.deepEqual(service.processes(), [], 'and forgotten once the shutdown stopped it')
  assert.equal(service.shutdown('restart'), service.shutdown('quit'), 'one shutdown per service')
  assert.equal(service.runtime.getRun(holding).status, 'cancelled')
  await assert.rejects(service.call('runtime:start', [payload(layout, 'too late', { chatId: 'chat-4' })]), (error) => error.code === protocol.ERROR_CODES.stopping)
  assert.equal(await service.call('state:save', [{ version: 3 }]), true, 'a store call during or after a shutdown is still answered')
})

test('in process: while restart_orbit runs the script, another chat waits; the shutdown for that restart does not wait for the call', { skip: restartSupport ? false : 'electron/resume.mts (P1) is not in place yet' }, async (t) => {
  const layout = temporary(t)
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const { createRuntimeService } = require('../electron/runtime-host.mts')
  const resume = require('../electron/resume.mts')
  const service = createRuntimeService({ userData: layout.userData, repoRoot: repo, emit: () => {}, requestApproval: async () => true, log: () => {}, overrides: require(layout.fixtures) })
  // An Orbit repository of its own whose self-upgrade is scripted here and runs until the test ends it: the real script
  // never runs, and nothing is ever killed for real.
  const orbit = path.join(layout.root, 'orbit')
  fs.mkdirSync(path.join(orbit, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(orbit, '.git'))
  fs.writeFileSync(path.join(orbit, 'scripts', 'self-upgrade.cjs'), "'use strict'\n")
  const scripts = [], killed = []
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    child.exit = (code) => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code, null)) }
    scripts.push(child)
    return child
  }
  const host = resume.createRestartHost({ repoRoot: orbit, userData: layout.userData, spawn, kill: (child) => { killed.push(child); child.exit(null) } })
  service.runtime.setRestartHost(host)
  t.after(() => { for (const script of scripts) script.exit(0) })
  const start = (prompt, chatId, workspace = layout.workspace) => service.call('runtime:start', [payload(layout, prompt, { chatId, workspace })])

  const runId = await start('HOLD while Orbit restarts', 'chat-restart', orbit)
  const run = service.runtime.runs.get(runId), root = run.agentNodes.get('root')
  // As a provider's call reaches the runtime (dispatchMcp): an operation of the run, which a shutdown waits for.
  const call = service.runtime.trackOperation(run, service.runtime.executeTool(run, root, 'restart_orbit', { reason: 'New tool', continueWith: 'Use it' }), root)
  call.catch(() => {})
  const deadline = Date.now() + 10000
  while (!host.inFlight() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(host.inFlight()?.runId, runId)
  await assert.rejects(start('Hello from another chat', 'chat-other'), /^Error: Orbit сейчас применяет изменения своего кода и перезапустится; отправьте сообщение после перезапуска\.$/)

  // The script wrote the intent and signalled a runtime restart: the runtime shuts down for it. The call, which only ends
  // once this runtime is gone, must not hold the shutdown for the whole settle time.
  fs.writeFileSync(path.join(layout.userData, 'pending-resume.json'), JSON.stringify({
    version: 1, id: 'upgrade-9', createdAt: new Date().toISOString(), source: 'tool', reason: 'New tool', continueWith: 'Use it', verify: true,
    runId, chatId: 'chat-restart', projectId: 'project', agentId: 'root', level: 'runtime', state: 'relaunching', commit: null, outcome: null, error: null, patch: null,
  }))
  // (The shutdown's settle timer is unref'd, as in Orbit, whose window keeps the process alive; here this does.)
  const alive = setInterval(() => {}, 50)
  const began = Date.now()
  const { marked } = await service.shutdown('restart').finally(() => clearInterval(alive))
  const took = Date.now() - began
  assert.deepEqual(marked, [runId])
  assert.equal(run.operations.size, 0, 'the restart_orbit call ended with its run instead of being left pending')
  assert.ok(took < 2000, `the restart shutdown took ${took} ms: it waited for the restart_orbit call`)
  await assert.rejects(call, /Run cancelled/)
  assert.deepEqual(killed, [], 'the script restarting Orbit was left alone')
  assert.equal(host.inFlight()?.runId, runId, 'and it still runs')
  assert.deepEqual([service.runtime.getRun(runId).status, service.runtime.getRun(runId).restart.intentId], ['restarting', 'upgrade-9'])
})
