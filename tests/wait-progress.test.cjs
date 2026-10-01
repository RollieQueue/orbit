// wait_agent wakes its caller at the first helper to finish, not the last, and at the latest after ORBIT_WAIT_CHECK_MS
// with the progress of the helpers still at work; stop_agent lets a parent end a stuck helper (2026-10-01: the root sat
// 20 minutes in one wait, took two finished results 8 and 19 minutes late and never looked at the third helper's work).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
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

test('wait_agent wakes at the first helper to finish, then shows a working one\'s progress, and stop_agent ends that one', async t => {
  const saved = process.env.ORBIT_WAIT_CHECK_MS
  t.after(() => { if (saved === undefined) delete process.env.ORBIT_WAIT_CHECK_MS; else process.env.ORBIT_WAIT_CHECK_MS = saved })
  // Far beyond `until`'s 4 s: only the first helper's finish can end the first wait in time.
  process.env.ORBIT_WAIT_CHECK_MS = '60000'
  const prompts = []
  let slow = null, stepped
  const slowStepped = new Promise(resolve => { stepped = resolve })
  const runtime = new OrbitRuntime({ runProvider: async options => {
    // Fast finishes once Slow has made a step, so the first wait sees Slow at work.
    if (/Agent: Fast;/.test(options.prompt)) { await slowStepped; return { text: 'FAST_DONE' } }
    if (/Agent: Slow;/.test(options.prompt)) {
      slow = options
      options.onEvent({ kind: 'output', text: 'SLOW_STEP_ONE' })
      stepped()
      return aborts(options)
    }
    prompts.push(options.prompt)
    if (prompts.length === 1) return response(tool('spawn_agent', { name: 'Fast', task: 'Quick check', reason: 'Independent' }), tool('spawn_agent', { name: 'Slow', task: 'Long job', reason: 'Independent' }), tool('wait_agent'))
    if (prompts.length === 2) { process.env.ORBIT_WAIT_CHECK_MS = '150'; return response(tool('wait_agent')) }
    if (prompts.length === 3) return response(tool('stop_agent', { agentId: 'Slow', reason: 'no progress in the test' }))
    return { text: 'ROOT_DONE' }
  } })
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wait-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  const run = runtime.runs.get(runId)
  await until(() => prompts.length >= 2, 'the first wait ends when Fast finishes, while Slow still works')
  const first = prompts[1]
  assert.ok(first.includes('FAST_DONE'), 'the finished helper\'s result')
  assert.match(first, /SLOW_STEP_ONE/, 'the working helper\'s last step')
  assert.match(first, /workingFor/)
  assert.match(first, /quietFor/)
  await until(() => prompts.length >= 3, 'the second wait returns after ORBIT_WAIT_CHECK_MS with Slow still at work')
  assert.match(prompts[2], /SLOW_STEP_ONE/)
  assert.doesNotMatch(prompts[2], /"status":"cancelled"/)
  await until(() => run.status !== 'working', 'the run finishes after the stop')
  assert.equal(run.status, 'completed', run.error)
  assert.equal(slow.signal.aborted, true, 'the stopped helper\'s provider call is aborted')
  const stopped = [...run.agentNodes.values()].find(agent => agent.name === 'Slow')
  assert.equal(stopped.status, 'cancelled')
  assert.match(stopped.error, /^Stopped by Orbit, the agent it worked for: no progress in the test\./)
  assert.match(prompts[3], /"status":"cancelled"/, 'stop_agent answers with the helper\'s end')
  assert.equal(runtime.getRun(runId).messages.at(-1).text, 'ROOT_DONE')
})

test('stop_agent stops only the caller\'s own direct helpers', async t => {
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (/Agent: Helper;/.test(options.prompt)) return { text: 'HELPER_DONE' }
    prompts.push(options.prompt)
    if (prompts.length === 1) return response(tool('stop_agent', { agentId: 'root', reason: 'not a helper' }))
    return { text: 'ROOT_DONE' }
  } })
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wait-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  const run = runtime.runs.get(runId)
  await until(() => run.status !== 'working')
  assert.equal(run.status, 'completed', run.error)
  assert.match(prompts[1], /stop_agent stops only your own direct helpers/)
})
