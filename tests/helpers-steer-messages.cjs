const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('./helpers-runtime.cjs')

// Shared by tests/steer-messages*.test.cjs (one file of 25 tests took 8 s on its own).

// Steering mail: what the user or an agent above the recipient writes while the recipient's turn runs. A session turn
// that makes no Orbit call is cut off at a step boundary and repeated at once (refunded), with the mail; an Orbit tool
// result carries the mail whole; a running native tool, an Orbit call in flight or a pause keep the turn as it is.
process.env.ORBIT_STEER_GRACE_MS = '20'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check, message) {
  const end = Date.now() + 4000
  while (!check()) { assert.ok(Date.now() < end, message || 'runtime did not reach the expected state'); await sleep(5) }
}
function aborts(options) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Provider interrupted'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
function fakeMcp(activity) {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {}, ...(activity ? { activity } : {}) }
}
async function start(t, runtime, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-steer-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false, ...extra })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  return runtime.runs.get(runId)
}
async function completed(runtime, run) {
  await until(() => run.status !== 'working', 'the run must finish without deadlock')
  assert.equal(run.status, 'completed', run.error)
  return runtime.getRun(run.runId)
}
// The agent a provider call serves: the fake MCP names its tokens `token-<agentId>-<n>` (a session prompt has no name).
const callerName = (runtime, options) => runtime.runs.values().next().value.agentNodes.get(options.session.token.replace(/^token-/, '').replace(/-\d+$/, ''))?.name
const steerTraces = (run, agentId) => run.traces.filter(trace => trace.agentId === agentId && trace.kind === 'steer')
const helperNamed = (run, name) => [...run.agentNodes.values()].find(agent => agent.name === name)
const userMessages = run => run.communications.filter(message => message.fromAgentId === 'user' && message.kind === 'message')
const withEnv = async (name, value, body) => {
  const before = process.env[name]
  process.env[name] = value
  try { await body() } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before }
}
const withGrace = (value, body) => withEnv('ORBIT_STEER_GRACE_MS', value, body)
// The block of a prompt that hands the model the user's messages as new words to act on ('' when there is none).
const userBlock = prompt => (prompt.match(/MESSAGE FROM THE USER \([^\n]*\):\n[\s\S]*?(?=\n\n(?!\[)|$)/) || [''])[0]

// A root (session transport) that spawned Helper; `helperBody` answers Helper's calls. Returns what the tests inspect.
function supervisedRun(t, helperBody, { providerId = 'claude' } = {}) {
  const calls = { root: [], helper: [] }
  const spawned = deferred(), finished = deferred()
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (callerName(runtime, options) === 'Helper') {
      calls.helper.push(options)
      return helperBody(options, calls.helper.length)
    }
    calls.root.push(options)
    if (calls.root.length === 1) {
      const spawnedResult = await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
      assert.equal(spawnedResult.ok, true, spawnedResult.text)
      spawned.resolve(options)
      const waited = await runtime.dispatchMcp(options.session.token, 'wait_agent', {})
      finished.resolve(waited)
      return { text: 'FINAL_ANSWER' }
    }
    return { text: 'FINAL_ANSWER' }
  } })
  return { runtime, calls, spawned: spawned.promise, finished: finished.promise, start: () => start(t, runtime, { providerId }) }
}

module.exports = { OrbitRuntime, sleep, deferred, until, aborts, fakeMcp, start, completed, callerName, steerTraces, helperNamed, userMessages, withEnv, withGrace, userBlock, supervisedRun }
