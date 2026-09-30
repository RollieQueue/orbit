const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const improvement = require('../electron/runtime/improvement.mts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-loop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace)
  return { root, workspace }
}
const calls = (...items) => ({ tool_calls: items.map(([name, args = {}]) => ({ name, arguments: args })) })
const task = (id, status, evidence = status === 'done' || status === 'blocked' ? `evidence ${id}` : '') => ({ id, title: `Task ${id}`, status, evidence })
// A fake restart host for a run in `repoRoot` (Orbit's own repository): records the calls, answers with `result`.
function fakeHost(repoRoot, result = { ok: true, level: 'renderer', status: 'ok' }) {
  const requests = []
  return { requests, available: true, repoRoot, userData: repoRoot, resumeFile: path.join(repoRoot, 'resume.json'), inFlight: () => null, request: async request => { requests.push(request); return typeof result === 'function' ? result() : result } }
}
async function run(runtime, payload) {
  const events = []
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { events.push(event); if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
  const id = await runtime.start({ providerId: 'test', prompt: 'Improve the project', improvementMode: true, accessMode: 'workspace-write', ...payload })
  const timer = setTimeout(() => runtime.stop(id), 5000)
  await done; clearTimeout(timer); off()
  const result = runtime.getRun(id)
  assert.equal(result.status, 'completed', result.error || 'run did not complete')
  return { result, events, live: runtime.runs.get(id) }
}

test('the ON text states the loop rules and the OFF text is unchanged', () => {
  const { improvementModeText, IMPROVEMENT_OFF } = require('../electron/runtime/prompts.mts')
  assert.equal(IMPROVEMENT_OFF, 'IMPROVEMENT MODE OFF: discovery-only requests require findings, not automatic implementation. Explicit requests to fix or implement still authorize work.')
  for (const applies of [true, false]) {
    const text = improvementModeText(applies)
    assert.ok(text.startsWith('IMPROVEMENT MODE ON'))
    assert.match(text, /ONE task/); assert.match(text, /Orbit starts the next run itself/); assert.match(text, /marked working first/); assert.match(text, /Never start a second task/); assert.match(text, /goal reached: <what was done>/)
    assert.equal(/restart_orbit as the last step/.test(text), applies)
  }
})

test('a new run of the chat continues the plan and the handoff, and must close a task', async t => {
  const { workspace } = fixture(t)
  const prompts = []; let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    switch (++turn) {
      // Run 1: record the plan, close task a; b stays pending.
      case 1: return calls(['improvement_plan', { status: 'implementing', tasks: [task('a', 'done'), task('b', 'pending')], handoff: 'HANDOFF_ONE' }])
      case 2: return { text: 'Task a done' }
      // Run 2: an answer without closing a task is reminded, then b is closed.
      case 3: return { text: 'Nothing to do' }
      case 4: assert.match(prompt, /has not closed a task yet/); return calls(['improvement_plan', { status: 'completed', tasks: [task('a', 'done'), task('b', 'done')] }])
      // Run 3: marking the inherited, all-done plan completed again closes nothing.
      case 101: return calls(['improvement_plan', { status: 'completed', tasks: [task('a', 'done'), task('b', 'done')] }])
      default: return { text: 'Task b done' }
    }
  } })
  const first = await run(runtime, { workspace, chatId: 'chat-1', loopTask: 1 })
  assert.equal(first.result.loopTask, 1)
  assert.equal(first.result.improvementHandoff, 'HANDOFF_ONE')
  const info = first.events.find(event => event.type === 'run.info' && event.improvements)
  assert.deepEqual(Object.keys(info).filter(key => key.startsWith('improvement')).sort(), ['improvementHandoff', 'improvementStatus', 'improvements'])
  const second = await run(runtime, { workspace, chatId: 'chat-1', loopTask: 2, history: [] })
  const started = second.events.find(event => event.type === 'run.started')
  assert.equal(started.loopTask, 2)
  assert.equal(started.improvementStatus, 'implementing')
  assert.equal(started.improvementHandoff, 'HANDOFF_ONE')
  assert.deepEqual(started.improvements.map(item => `${item.id}:${item.status}`), ['a:done', 'b:pending'])
  assert.match(prompts[2], /IMPROVEMENT MODE ON/)
  assert.match(prompts[2], /HANDOFF FROM THE PREVIOUS TASK: HANDOFF_ONE/)
  assert.match(prompts[2], /\[pending\] b: Task b/)
  assert.equal(second.result.improvementStatus, 'completed')
  assert.equal(second.result.improvementHandoff, 'HANDOFF_ONE', 'an omitted handoff keeps the previous one')
  assert.doesNotMatch(second.result.summary.text, /Режим улучшения/)
  // A third run inherits the tasks, but never the stale completed status.
  turn = 100
  const third = await run(runtime, { workspace, chatId: 'chat-1', loopTask: 3 })
  assert.equal(third.events.find(event => event.type === 'run.started').improvementStatus, 'implementing')
  assert.match(prompts.at(-1), /has not closed a task yet/)
  assert.match(third.result.summary.text, /не закрыта ни одна задача плана/)
  // Other chats start empty.
  const other = await run(runtime, { workspace, chatId: 'chat-2' })
  assert.equal(other.events.find(event => event.type === 'run.started').improvements.length, 0)
})

test('the plan is loaded from saved runs, and a broken run store does not block the start', async t => {
  const { workspace } = fixture(t)
  let asked = null
  const saved = { runId: 'old', projectId: workspace, chatId: 'chat-s', startedAt: '2020-01-01T00:00:00.000Z', improvements: [task('x', 'pending'), { id: 'bad' }, task('y', 'done')], improvementHandoff: 'SAVED' }
  const runStore = { forChat: (projectId, chatId, limit) => { asked = { projectId, chatId, limit }; return [saved] }, save: () => {} }
  let turn = 0
  const runtime = new OrbitRuntime({ runStore, runProvider: async () => ++turn === 1 ? calls(['improvement_plan', { status: 'implementing', tasks: [task('x', 'done'), task('y', 'done')] }]) : { text: 'x done' } })
  const { events, live } = await run(runtime, { workspace: fs.realpathSync(workspace), projectId: workspace, chatId: 'chat-s' })
  assert.deepEqual(asked, { projectId: workspace, chatId: 'chat-s', limit: 12 })
  const started = events.find(event => event.type === 'run.started')
  assert.deepEqual(started.improvements.map(item => item.id), ['x', 'y'])
  assert.deepEqual([...live.improvementBaseline.keys()], ['y'])
  assert.equal(live.improvementBaseline.get('y').title, 'Task y')
  let brokenTurn = 0
  const broken = new OrbitRuntime({ runStore: { forChat: () => { throw new Error('damaged') }, save: () => {} }, runProvider: async () => ++brokenTurn === 1 ? calls(['improvement_plan', { status: 'implementing', tasks: [task('n', 'done')] }]) : { text: 'ok' } })
  const after = await run(broken, { workspace, chatId: 'chat-b' })
  assert.ok(after.result.traces.some(trace => trace.kind === 'diagnostic' && /improvement\.loadPlan: damaged/.test(trace.text)))
})

test('improvement_plan clips, archives old done tasks, keeps open ones and writes a compact note', () => {
  const emitted = []
  const run = { improvementMode: true, improvements: [task('p', 'pending'), task('k', 'blocked')], improvementStatus: 'implementing', prompt: 'P'.repeat(400), chatId: 'c', workspace: os.tmpdir(), sharedContext: {} }
  const runtime = { contextStore: null, emit: (_run, type, data) => emitted.push({ type, ...data }) }
  assert.throws(() => improvement.updatePlan(runtime, run, { status: 'implementing', tasks: [] }), /cannot be silently removed/)
  assert.throws(() => improvement.updatePlan(runtime, run, { status: 'implementing', tasks: [task('p', 'pending')], handoff: 'h'.repeat(2001) }), /longer than 2000/)
  const many = Array.from({ length: 33 }, (_, i) => ({ ...task(`d${i}`, 'done'), title: 'T'.repeat(400), evidence: 'E'.repeat(2000) }))
  // The blocked task k may be dropped; the pending one may not.
  const result = improvement.updatePlan(runtime, run, { status: 'implementing', tasks: [...many, task('p', 'working')], handoff: '  next: check X  ' })
  assert.equal(result.archived, 3); assert.match(result.note, /archived/)
  assert.equal(run.improvements.length, 31)
  assert.equal(run.improvements[0].id, 'd3', 'the oldest done tasks are archived')
  assert.equal(run.improvements[0].title.length, 300); assert.equal(run.improvements[0].evidence.length, 1500)
  assert.equal(run.improvementHandoff, 'next: check X')
  const info = emitted.at(-1)
  assert.equal(info.type, 'run.info'); assert.equal(info.improvementHandoff, 'next: check X'); assert.equal(info.improvements.length, 31)
  const note = JSON.parse(run.sharedContext.notes.find(item => item.key === 'progress:c').summary)
  assert.deepEqual(Object.keys(note), ['request', 'status', 'open', 'recentlyDone', 'handoff'])
  assert.ok(note.request.length <= 300)
  assert.deepEqual(note.open, [{ id: 'p', title: 'Task p', status: 'working' }])
  assert.equal(note.recentlyDone.length, 5)
  // The prompt block is bounded and lists open tasks first, then the last done ones, then the handoff.
  const block = improvement.progressBlock(run)
  assert.ok(block.length < 5200, `${block.length}`)
  assert.ok(block.indexOf('[working] p') < block.indexOf('[done] d32'))
  assert.equal((block.match(/\[done\]/g) || []).length, 8)
  assert.match(block, /HANDOFF FROM THE PREVIOUS TASK: next: check X$/)
})

test('a task left working is reminded, then the answer is accepted with a note naming it', async t => {
  const { workspace } = fixture(t)
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (++turn === 1) return calls(['improvement_plan', { status: 'implementing', tasks: [task('w', 'working')] }])
    if (turn > 2) assert.match(prompt, /task w .*still marked working/)
    return { text: 'Stopping here' }
  } })
  const { result } = await run(runtime, { workspace })
  assert.equal(result.usage.providerTurns, 5)
  assert.match(result.summary.text, /Stopping here\n\n\(Режим улучшения: задача w осталась в работе/)
})

test('in Orbit\'s own repository a written change must be applied with restart_orbit', async t => {
  const { workspace } = fixture(t)
  const host = fakeHost(fs.realpathSync(workspace))
  let turn = 0
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async ({ prompt }) => {
    switch (++turn) {
      case 1: assert.match(prompt, /restart_orbit as the last step/); return calls(['write_file', { path: 'fix.txt', content: 'fixed' }], ['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }])
      case 2: return { text: 'Done, not applied' }
      case 3: assert.match(prompt, /not applied yet\. Call restart_orbit now/); assert.match(prompt, /Task t1 was applied/); return calls(['restart_orbit', { reason: 'apply t1', continueWith: 'Task t1 was applied: confirm the new code runs, then give the final answer' }])
      default: return { text: 'Applied' }
    }
  } })
  const { result, live } = await run(runtime, { workspace })
  assert.equal(host.requests.length, 1)
  assert.equal(live.restartApplied, true)
  assert.equal(result.summary.text, 'Applied')
})

test('a restart refused for the cycle limit defers the change: the hint says so and the answer is accepted', async t => {
  const { workspace } = fixture(t)
  const host = fakeHost(fs.realpathSync(workspace), { ok: false, status: 'cycle-limit', exitCode: 3, output: '' })
  let turn = 0, observed = ''
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async ({ prompt }) => {
    switch (++turn) {
      case 1: return calls(['write_file', { path: 'fix.txt', content: 'fixed' }], ['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }], ['restart_orbit', { reason: 'apply', continueWith: 'confirm' }])
      default: observed = prompt; return { text: 'Verified, not applied yet' }
    }
  } })
  const { result, live } = await run(runtime, { workspace })
  assert.match(observed, /verified, not applied yet \(cycle limit\)/)
  assert.equal(live.restartDeferred, true); assert.equal(live.restartApplied, undefined)
  assert.equal(result.summary.text, 'Verified, not applied yet')
})

test('a restart continuation keeps loopTask and is not asked to close another task', async t => {
  const { workspace } = fixture(t)
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async () => ++turn === 1 ? calls(['improvement_plan', { status: 'implementing', tasks: [task('a', 'done'), task('b', 'pending')] }]) : { text: 'ok' } })
  const first = await run(runtime, { workspace, chatId: 'chat-r', loopTask: 4 })
  assert.equal(first.result.startPayload.loopTask, 4, 'what a continuation reuses keeps the task number')
  const continuation = await run(runtime, { ...first.result.startPayload, workspace, prompt: 'Task a was applied: confirm', resumedFrom: first.result.runId, resumeChain: 1 })
  assert.equal(continuation.result.loopTask, 4)
  assert.equal(continuation.result.usage.providerTurns, 1, 'no reminder: the task was closed before the restart')
  // An invalid loopTask is ignored.
  const invalid = await run(runtime, { workspace, chatId: 'chat-i', loopTask: 0, improvementMode: false })
  assert.equal(invalid.result.loopTask, undefined)
  assert.equal(invalid.events.find(event => event.type === 'run.started').improvements, undefined)
})
