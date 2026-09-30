const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { _testing } = require('../electron/providers.mts')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const STALL_MS = 80
async function until(check, message) {
  const end = Date.now() + 6000
  while (!check()) { assert.ok(Date.now() < end, message || 'runtime did not reach the expected state'); await sleep(5) }
}
// A provider call that never answers until Orbit aborts it.
function aborts(options) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Provider interrupted'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
function stallLimit(t, value = String(STALL_MS)) {
  const previous = process.env.ORBIT_STALL_MS
  process.env.ORBIT_STALL_MS = value
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_STALL_MS; else process.env.ORBIT_STALL_MS = previous })
}
function fakeMcp(activity) {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {}, ...(activity ? { activity } : {}) }
}
async function start(t, runtime, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-watchdog-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false, ...extra })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  return runtime.runs.get(runId)
}
async function settled(run) {
  await until(() => run.status !== 'working', 'the run must finish')
}
async function completed(runtime, run) {
  await settled(run)
  assert.equal(run.status, 'completed', run.error)
  return runtime.getRun(run.runId)
}
const watchdogTraces = run => run.traces.filter(trace => trace.kind === 'watchdog')

test('a silent envelope turn is stopped, refunded and repeated with the cut-off note', async t => {
  stallLimit(t)
  const calls = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      options.onEvent({ kind: 'output', text: 'PARTIAL_BEFORE_STALL', partial: true })
      options.onEvent({ kind: 'tool', native: true, toolId: 'x1', tool: 'edit_file', text: 'wrote a file', status: 'completed' })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  const snapshot = await completed(runtime, run)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true, 'the watchdog aborted the silent call')
  assert.ok(calls[1].prompt.includes('WATCHDOG:'))
  assert.ok(calls[1].prompt.includes('PARTIAL_BEFORE_STALL'))
  assert.ok(calls[1].prompt.includes('edit_file: wrote a file'), 'the started native actions are named')
  assert.deepEqual(snapshot.messages.map(message => message.text), ['FINAL_ANSWER'])
  const root = run.agentNodes.get('root')
  assert.equal(root.turns, 1, 'the stalled turn was refunded')
  assert.equal(run.usage.providerTurns, 1)
  const traces = watchdogTraces(run)
  assert.equal(traces.length, 1)
  assert.match(traces[0].text, /не присылала событий/)
  assert.ok(!/в новой сессии/.test(traces[0].text), 'the envelope transport has no session to renew')
  assert.ok(root.ledger.some(entry => /WATCHDOG/.test(entry.text)))
})

test('a silent session turn is repeated in a fresh session', async t => {
  stallLimit(t)
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) return aborts(options)
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].session.resume, false)
  assert.notEqual(calls[1].session.id, calls[0].session.id)
  assert.ok(calls[1].prompt.includes('WATCHDOG:'))
  assert.ok(calls[1].prompt.includes('fresh session'))
  const traces = watchdogTraces(run)
  assert.equal(traces.length, 1)
  assert.match(traces[0].text, /не присылала событий 1 мин: ход остановлен и повторяется в новой сессии/)
  assert.equal(run.agentNodes.get('root').turns, 1)
})

test('a stall on a resumed session drops and closes that session, then repeats in a fresh one', async t => {
  stallLimit(t)
  const calls = [], closed = []
  let run
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', closeSession: id => { closed.push(id) }, runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      runtime.postUserMessage(run.runId, 'root', 'INPUT_DURING_FIRST_TURN')
      return { text: 'Premature answer', sessionId: 'kept-session-id' }
    }
    if (calls.length === 2) return aborts(options)
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.equal(calls[1].session.id, 'kept-session-id'); assert.equal(calls[1].session.resume, true, 'the stalled turn ran on the resumed session')
  assert.equal(calls[2].session.resume, false)
  assert.notEqual(calls[2].session.id, 'kept-session-id')
  assert.ok(calls[2].prompt.includes('WATCHDOG:'))
  assert.ok(closed.includes('kept-session-id'), 'the stuck provider session was closed')
  assert.match(watchdogTraces(run)[0].text, /в новой сессии/)
})

test('a native tool that is still running is not silence, however long it takes', async t => {
  stallLimit(t)
  let calls = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls++
    options.onEvent({ kind: 'tool', native: true, toolId: 'build-1', tool: 'commandExecution', text: 'npm run build', status: 'started' })
    await sleep(STALL_MS * 5)
    options.onEvent({ kind: 'tool', native: true, toolId: 'build-1', tool: 'commandExecution', text: 'npm run build', status: 'completed' })
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls, 1)
  assert.equal(watchdogTraces(run).length, 0)
})

test('a pending Orbit tool call over MCP is not silence', async t => {
  stallLimit(t)
  let calls = 0
  const runtime = new OrbitRuntime({ mcp: fakeMcp(() => ({ pending: 1, lastAt: Date.now() })), transportFor: () => 'session', runProvider: async options => {
    calls++
    await sleep(STALL_MS * 5)
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls, 1)
  assert.equal(watchdogTraces(run).length, 0)
})

test('ORBIT_STALL_MS=0 switches the watchdog off', async t => {
  stallLimit(t, '0')
  let calls = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls++
    await sleep(STALL_MS * 5)
    assert.equal(options.signal.aborted, false)
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls, 1)
  assert.equal(watchdogTraces(run).length, 0)
})

test('the provider own idle timeout is handled like a watchdog stop: one repeat, and the trace names its minutes', async t => {
  stallLimit(t)
  let calls = 0
  const runtime = new OrbitRuntime({ runProvider: async () => {
    if (++calls === 1) throw Object.assign(new Error('agy produced no output for 900000 ms'), { name: 'TimeoutError', code: 'ORBIT_PROVIDER_IDLE' })
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  const snapshot = await completed(runtime, run)
  assert.equal(calls, 2)
  assert.deepEqual(snapshot.messages.map(message => message.text), ['FINAL_ANSWER'])
  const traces = watchdogTraces(run)
  assert.equal(traces.length, 1)
  assert.match(traces[0].text, /15 мин/)
  assert.equal(run.agentNodes.get('root').turns, 1, 'a turn the provider timed out is refunded too')
})

test('a successful turn between two silent ones resets the count', async t => {
  stallLimit(t)
  const calls = []
  let runtime
  runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    // silent, answers (with mail queued so the loop takes another turn), silent again, then answers for good
    if (calls.length === 1 || calls.length === 3) return aborts(options)
    if (calls.length === 2) { runtime.postUserMessage(run.runId, 'root', 'MAIL'); return { text: 'Premature answer', sessionId: options.session.id } }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.equal(calls.length, 4, 'the second silence was a first one again: repeated, not stopped')
  assert.equal(watchdogTraces(run).length, 2)
})

// ---- Two silent turns in a row -------------------------------------------------------------------------------------

const w = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })
const CATALOG = [
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5'], reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'gpt-5.5': ['low', 'medium', 'high', 'xhigh'] } },
  { id: 'claude', available: true, models: ['sonnet', 'opus', 'haiku'] },
  { id: 'antigravity', available: true, models: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking'] },
  { id: 'cursor', available: true, models: ['auto', 'composer-2.5', 'claude-opus-5-5-high'] },
  { id: 'ollama', available: true, models: ['llama3'] },
]
function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-watchdog-failover-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
async function finished(runtime, payload) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return { snapshot: runtime.getRun(runId), runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'codex', model: 'gpt-6-sol', prompt: 'Current task', ...extra })
function world(t, usage = {}, catalog = CATALOG) {
  const original = { ...quota.readers }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: usage[id] || [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const monitor = new quota.QuotaMonitor()
  return { runtime: run => new OrbitRuntime({ runProvider: run, quota: monitor, catalog: async () => catalog }) }
}
const silentThenAnswer = (calls, silent) => async options => {
  calls.push({ providerId: options.providerId, prompt: options.prompt })
  if (silent(options)) return aborts(options)
  return { text: 'FINAL_ANSWER' }
}

test('two silent turns in a row hand the agent to another subscription', async t => {
  stallLimit(t)
  const calls = []
  const { runtime } = world(t, { codex: [w(10)], claude: [w(5)] })
  const { snapshot } = await finished(runtime(silentThenAnswer(calls, options => options.providerId === 'codex')), payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(calls.map(call => call.providerId), ['codex', 'codex', 'claude'])
  const root = snapshot.agents[0]
  assert.equal(root.handovers.length, 1)
  assert.equal(root.handovers[0].reason, 'stalled')
  assert.equal(root.handovers[0].from.providerId, 'codex'); assert.equal(root.handovers[0].to.providerId, 'claude')
  assert.match(calls[1].prompt, /WATCHDOG:/)
  assert.match(calls[2].prompt, /HANDOVER: your model changed mid-task because the previous one stopped responding/)
  assert.match(calls[2].prompt, /because the previous one stopped responding/)
  assert.equal(root.providerId, 'claude')
  assert.equal(root.turns, 1, 'neither silent turn counts')
  assert.equal(snapshot.usage.providerTurns, 1)
  assert.equal(snapshot.traces.filter(trace => trace.kind === 'watchdog').length, 1, 'only the first silence is a repeat; the second is a handover')
  assert.ok(snapshot.traces.some(trace => trace.kind === 'handover' && /модель перестала отвечать/.test(trace.text)))
})

for (const [label, extra, catalog, why] of [
  ['with failover disabled', { quotaFailover: { enabled: false } }, CATALOG, /автозамена подписок выключена/],
  ['without a replacement among the subscriptions', {}, [{ id: 'codex', available: true, models: ['gpt-6-sol'] }], /подходящей замены среди подключённых подписок нет/],
]) test(`two silent turns in a row stop the agent ${label}`, async t => {
  stallLimit(t)
  const calls = []
  const { runtime } = world(t, { codex: [w(10)] }, catalog)
  const { snapshot } = await finished(runtime(silentThenAnswer(calls, () => true)), payload(folder(t), extra))
  assert.equal(snapshot.status, 'failed')
  assert.equal(calls.length, 2, 'one repeat, then the stop')
  assert.match(snapshot.error, /два хода подряд/)
  assert.match(snapshot.error, why)
  assert.equal(snapshot.agents[0].handovers.length, 0)
})

// ---- The provider's own timeout ------------------------------------------------------------------------------------

test('runCli names its inactivity timeout with the code the runtime recovers from', async () => {
  // A portable child: node itself, idle for longer than the limit.
  await assert.rejects(
    _testing.runCli(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { inactivityMs: 150, timeoutMs: null }),
    error => { assert.equal(error.name, 'TimeoutError'); assert.equal(error.code, 'ORBIT_PROVIDER_IDLE'); assert.match(error.message, /produced no output for 150 ms/); return true },
  )
})
