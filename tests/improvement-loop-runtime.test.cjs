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
  for (const [applies, elsewhere] of [[true, false], [true, true], [false, false]]) {
    const text = improvementModeText(applies, elsewhere)
    assert.ok(text.startsWith('IMPROVEMENT MODE ON'))
    assert.match(text, /one BATCH of tasks/); assert.match(text, /up to about 4 that are independent/); assert.match(text, /Orbit starts the next run itself/); assert.match(text, /marked working first/); assert.match(text, /Never start a second batch/); assert.match(text, /goal reached: <what was done>/)
    assert.match(text, /spawn_agent \{kind:'code', isolation:'worktree'/)
    // A pending task carries a ready brief, so the next run starts its helper without exploring again.
    assert.match(text, /Give every task you leave pending a ready brief in its evidence/)
    // Speed rules (from the audit of real loop runs): helpers at once, no idle waiting, and, where restart_orbit runs the
    // full checks itself, only targeted tests (no full suite, no mutation runs) before it.
    assert.match(text, /Within the first minutes, spawn one isolated helper per task, all in one turn/); assert.match(text, /While helpers or a reviewer run, continue independent work instead of waiting/)
    assert.equal(/targeted tests for its new logic only/.test(text), applies); assert.equal(/run no full suite and no mutation checks yourself first/.test(text), applies)
    assert.equal(/the checks its change needs/.test(text), !applies, 'without restart_orbit nobody else runs the full checks')
    assert.equal(/restart_orbit as the last step/.test(text), applies)
    assert.equal(/Apply the batch ONCE/.test(text), applies)
    // Another project's chat: only a change to Orbit's own code is applied, and its helpers may work on Orbit's copy.
    assert.equal(/isolation:'orbit'/.test(text), elsewhere); assert.equal(/when you changed Orbit's own code, call restart_orbit/.test(text), elsewhere)
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
  // A host that cannot tell what the running Orbit runs (no unapplied): the files the run wrote decide.
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

test('the code the running Orbit runs decides: a change no tool reported must be applied, an undone one need not be', async t => {
  const { workspace } = fixture(t)
  // A shell command changed the runtime code: no file activity, but the code on disk is not what runs.
  const host = fakeHost(fs.realpathSync(workspace))
  host.unapplied = () => ['runtime']
  let turn = 0, reminded = ''
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async ({ prompt }) => {
    switch (++turn) {
      case 1: return calls(['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }])
      case 2: return { text: 'Done' }
      case 3: reminded = prompt; return calls(['restart_orbit', { reason: 'apply t1', continueWith: 'Task t1 was applied: confirm the new code runs, then give the final answer' }])
      default: return { text: 'Applied' }
    }
  } })
  const shell = await run(runtime, { workspace, chatId: 'chat-shell' })
  assert.match(reminded, /Orbit's code on disk differs from the code the running Orbit runs \(runtime\), so a change is not applied yet\. Call restart_orbit now/)
  assert.equal(host.requests.length, 1)
  assert.equal(shell.result.summary.text, 'Applied')
  // A file written and undone: the tools saw a write, but the running Orbit runs the code on disk.
  const undone = fakeHost(fs.realpathSync(workspace))
  undone.unapplied = () => []
  let second = 0
  const quiet = new OrbitRuntime({ restartHost: undone, runProvider: async () => ++second === 1
    ? calls(['write_file', { path: 'fix.txt', content: 'fixed' }], ['improvement_plan', { status: 'implementing', tasks: [task('t2', 'done')] }])
    : { text: 'Undone, nothing to apply' } })
  const reverted = await run(quiet, { workspace, chatId: 'chat-undone' })
  assert.equal(reverted.result.usage.providerTurns, 2, 'no reminder')
  assert.equal(undone.requests.length, 0)
  assert.equal(reverted.result.summary.text, 'Undone, nothing to apply')
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

test('a restart refused because Orbit writes no health report (ORBIT_HEALTH_FILE=0) defers the change too: no retry, the user restarts Orbit', async t => {
  const { workspace } = fixture(t)
  const host = fakeHost(fs.realpathSync(workspace), { ok: false, status: 'no-health-report', exitCode: 2, output: '' })
  let turn = 0, observed = ''
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async ({ prompt }) => {
    switch (++turn) {
      case 1: return calls(['write_file', { path: 'fix.txt', content: 'fixed' }], ['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }], ['restart_orbit', { reason: 'apply', continueWith: 'confirm' }])
      default: observed = prompt; return { text: 'Not applied: restart Orbit by hand' }
    }
  } })
  const { result, live } = await run(runtime, { workspace })
  assert.match(observed, /ORBIT_HEALTH_FILE=0 and writes no health report/)
  assert.doesNotMatch(observed, /Fix what the output shows/)
  assert.equal(live.restartDeferred, true); assert.equal(live.restartApplied, undefined)
  assert.deepEqual([result.summary.text, host.requests.length], ['Not applied: restart Orbit by hand', 1], 'no reminder asks for another restart')
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

// A fake run for updatePlan/reminderFor: `baseline` is the plan as it stood when the run started (only closed tasks form the
// baseline), `current` the plan the run holds now (defaults to the baseline).
function planFixture(baseline, current = baseline, extra = {}) {
  const emitted = []
  const isClosed = item => item.status === 'done' || item.status === 'blocked'
  const run = {
    improvementMode: true, improvements: current.map(item => ({ ...item })), improvementStatus: 'implementing', prompt: 'P', chatId: 'c', workspace: os.tmpdir(), sharedContext: {},
    improvementBaseline: new Map(baseline.filter(isClosed).map(item => [item.id, { ...item }])),
    agentNodes: new Map(), fileActivity: { forAgent: () => ({ wrote: [] }) }, ...extra,
  }
  const runtime = { contextStore: null, emit: (_run, type, data) => emitted.push({ type, ...data }) }
  return { run, runtime, emitted }
}
const titled = (item, title) => ({ ...item, title })

test('improvement_plan keeps the baseline titles of tasks that are still closed and reports them', () => {
  const plan = [task('d', 'done'), task('k', 'blocked'), task('r', 'done'), task('u', 'done')]
  const { run, runtime } = planFixture(plan)
  const result = improvement.updatePlan(runtime, run, { status: 'implementing', tasks: [
    titled(plan[0], 'Renamed d'), titled(plan[1], 'Renamed k'), { id: 'r', title: 'Reopened r', status: 'pending', evidence: '' }, plan[3], task('n', 'pending'),
  ] })
  const title = id => run.improvements.find(item => item.id === id).title
  assert.equal(title('d'), 'Task d', 'a done baseline task keeps its baseline title')
  assert.equal(title('k'), 'Task k', 'a blocked baseline task keeps its baseline title')
  assert.equal(title('r'), 'Reopened r', 'a baseline task sent as pending was reopened and may take a new title')
  assert.equal(title('u'), 'Task u', 'an unchanged title stays')
  assert.deepEqual([...result.keptTitles].sort(), ['d', 'k'], 'only the ids whose sent title differed are reported')
  assert.match(result.note, /kept their original titles/, 'the note says titles were kept')
  assert.equal(result.tasks.find(item => item.id === 'd').title, 'Task d', 'the result shows the kept title too')
  // Sending the kept titles as they are reports nothing.
  const clean = improvement.updatePlan(runtime, run, { status: 'implementing', tasks: run.improvements })
  assert.equal('keptTitles' in clean, false, 'no keptTitles key when no title was reverted')
  assert.equal('note' in clean, false, 'no note when nothing was reverted or archived')
  // A reopened baseline task stays free to change its title while it is open.
  const reopened = improvement.updatePlan(runtime, run, { status: 'implementing', tasks: run.improvements.map(item => item.id === 'r' ? { ...item, title: 'Second try', status: 'working' } : item) })
  assert.equal('keptTitles' in reopened, false, 'a reopened baseline task is not reverted')
  assert.equal(run.improvements.find(item => item.id === 'r').title, 'Second try')
})

test('improvement_plan reports the archive note and the kept-titles note together', () => {
  const { run, runtime } = planFixture([task('b', 'done')])
  const many = Array.from({ length: 33 }, (_, i) => task(`d${i}`, 'done'))
  const result = improvement.updatePlan(runtime, run, { status: 'implementing', tasks: [...many, titled(task('b', 'done'), 'Something else')] })
  assert.equal(result.archived, 4, 'the 34 done tasks are cut to the 30 newest')
  assert.deepEqual(result.keptTitles, ['b'])
  assert.match(result.note, /archived/, 'the archive note stays')
  assert.match(result.note, /kept their original titles/, 'the kept-titles note is added')
  assert.doesNotMatch(result.note, /\n/, 'the two notes are joined by a space')
  assert.equal(run.improvements.find(item => item.id === 'b').title, 'Task b')
})

test('a blocked plan needs a blocker documented in this run, except in a continuation', () => {
  const old = task('g', 'blocked', 'goal reached: a')
  const base = [task('a', 'done'), old, task('x', 'pending')]
  const attempt = (tasks, extra) => {
    const { run, runtime, emitted } = planFixture(base, base, extra)
    const before = JSON.parse(JSON.stringify(run.improvements))
    let error = null, result = null
    try { result = improvement.updatePlan(runtime, run, { status: 'blocked', tasks }) } catch (e) { error = e }
    return { run, emitted, before, error, result }
  }
  const fine = (outcome, label) => { assert.equal(outcome.error, null, `${label}: ${outcome.error?.message}`); assert.equal(outcome.run.improvementStatus, 'blocked', label) }
  for (const [label, evidence] of [['the same evidence', 'goal reached: a'], ['the same evidence with surrounding whitespace', '  goal reached: a \n']]) {
    const refused = attempt([task('a', 'done'), { ...old, evidence }, task('x', 'pending')])
    assert.match(refused.error?.message || '', /blocker documented in this run/, `an old blocker with ${label} is refused`)
    assert.deepEqual(refused.run.improvements, refused.before, `a refused call leaves the plan unchanged (${label})`)
    assert.equal(refused.run.improvementStatus, 'implementing', `a refused call leaves the status unchanged (${label})`)
    assert.equal(refused.emitted.length, 0, `a refused call publishes nothing (${label})`)
  }
  assert.match(attempt([task('a', 'done'), task('x', 'pending')]).error?.message || '', /documented blocker/, 'no blocked task at all keeps the old error')
  fine(attempt([task('a', 'done'), { ...old, evidence: 'the user must confirm the goal' }, task('x', 'pending')]), 'the same id with new evidence')
  fine(attempt([task('a', 'done'), old, task('x', 'pending'), task('h', 'blocked', 'needs a token')]), 'a new blocked id')
  fine(attempt([task('a', 'blocked', 'cannot repeat the check'), old, task('x', 'pending')]), 'a baseline done task now blocked')
  const resumed = attempt([task('a', 'done'), old, task('x', 'pending')], { resumedFrom: 'earlier-run' })
  fine(resumed, 'a continuation may pause on the inherited blocker unchanged')
  assert.deepEqual(resumed.run.improvements.map(item => item.id), ['a', 'g', 'x'])
  // No baseline (no earlier plan): any blocked task is new.
  const empty = planFixture([], [])
  improvement.updatePlan(empty.runtime, empty.run, { status: 'blocked', tasks: [task('g', 'blocked', 'goal reached: a')] })
  assert.equal(empty.run.improvementStatus, 'blocked', 'a blocked task in a run without a baseline is new')
})

test('a re-sent baseline blocker counts as unchanged when its evidence is re-flowed or clipped, and the full evidence is restored', () => {
  const full = 'goal reached: a. Verified with the whole test suite, both typechecks and a live restart of the app.'
  const old = task('g', 'blocked', full)
  const send = evidence => {
    const { run, runtime } = planFixture([old, task('a', 'done')])
    const args = { status: 'blocked', tasks: [task('a', 'done'), { ...old, evidence }] }
    return { run, call: () => improvement.updatePlan(runtime, run, args) }
  }
  const clipped = `${full.slice(0, 40)}…`
  for (const [label, evidence] of [['re-flowed whitespace', full.replace(/ /g, '  \n')], ['a clip cut with an ellipsis', clipped], ['a clip cut with three dots', `${full.slice(0, 40)}...`]]) {
    assert.throws(send(evidence).call, /blocker documented in this run/, `${label} is the same blocker, not a new one`)
  }
  assert.doesNotThrow(send('goal reached: b, a different finding of this run').call, 'different evidence is a new blocker')
  assert.doesNotThrow(send('goal…').call, 'a copy shorter than 10 characters before the ellipsis is not treated as a clip')
  // With a continuation the clipped copy is accepted and the full evidence is restored (no report).
  const { run, runtime } = planFixture([old], [old], { resumedFrom: 'earlier-run' })
  const result = improvement.updatePlan(runtime, run, { status: 'blocked', tasks: [{ ...old, evidence: clipped }] })
  assert.equal(run.improvements[0].evidence, full, 'a clipped copy of the same-status baseline evidence is replaced by the full text')
  assert.equal('keptTitles' in result, false); assert.equal('note' in result, false, 'restoring the evidence is not reported')
})

test('a renamed old done task does not count as closed in this run, a task blocked before and done now does', () => {
  const { reminderFor, acceptedWithout } = improvement
  const notClosed = /has not closed a task yet/
  // Only a rename of an old done task, sent through updatePlan (the title is kept).
  const renamed = planFixture([task('a', 'done'), task('b', 'pending')])
  improvement.updatePlan(renamed.runtime, renamed.run, { status: 'implementing', tasks: [titled(task('a', 'done'), 'Renamed a'), task('b', 'pending')] })
  assert.equal(renamed.run.improvements[0].title, 'Task a', 'the rename was reverted')
  assert.match(reminderFor(renamed.runtime, renamed.run) || '', notClosed, 'a rename of an old done task closes nothing')
  assert.match(acceptedWithout(renamed.runtime, renamed.run, 3), /не закрыта ни одна задача плана/, 'the accepted-answer note agrees')
  // A task blocked at the start and done now is closed in this run.
  const unblocked = planFixture([task('a', 'done'), task('b', 'blocked')])
  improvement.updatePlan(unblocked.runtime, unblocked.run, { status: 'implementing', tasks: [task('a', 'done'), task('b', 'done', 'fixed and verified')] })
  assert.equal(reminderFor(unblocked.runtime, unblocked.run), null, 'blocked before, done now: closed in this run')
  // A new done task.
  const added = planFixture([task('a', 'done')])
  improvement.updatePlan(added.runtime, added.run, { status: 'implementing', tasks: [task('a', 'done'), task('c', 'done')] })
  assert.equal(reminderFor(added.runtime, added.run), null, 'a new done task is closed in this run')
  // A pause or a continuation is excused from closing a task.
  const paused = planFixture([task('a', 'done'), task('g', 'blocked')], undefined, { improvementStatus: 'blocked' })
  assert.equal(reminderFor(paused.runtime, paused.run), null, 'a blocked plan excuses the run')
  const resumed = planFixture([task('a', 'done')], undefined, { resumedFrom: 'earlier-run' })
  assert.equal(reminderFor(resumed.runtime, resumed.run), null, 'a continuation is not asked to close another task')
})

test('a plan paused with blocked stays blocked in a restart continuation only, and the refused repeat reaches the next prompt', async t => {
  const { workspace } = fixture(t)
  const prompts = []
  let script = () => ({ text: 'idle' })
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => { prompts.push(prompt); return script() } })
  const pausedPlan = () => calls(['improvement_plan', { status: 'blocked', tasks: [task('a', 'done'), task('g', 'blocked', 'goal reached: a')] }])
  const sequence = (...answers) => { let n = 0; return () => answers[Math.min(n++, answers.length - 1)] }

  // Run 1: task a done, the bounded goal reached (g blocked): the plan is paused.
  script = sequence(pausedPlan(), { text: 'Goal reached' })
  const first = await run(runtime, { workspace, chatId: 'chat-p', loopTask: 1 })
  assert.equal(first.result.improvementStatus, 'blocked')

  // The continuation after restart_orbit inherits the paused plan and may repeat the same blocker.
  let mark = prompts.length
  script = sequence(pausedPlan(), { text: 'Confirmed' })
  const continuation = await run(runtime, { ...first.result.startPayload, workspace, prompt: 'Task a was applied: confirm', resumedFrom: first.result.runId, resumeChain: 1 })
  assert.equal(continuation.events.find(event => event.type === 'run.started').improvementStatus, 'blocked', 'the continuation starts in the status the plan was paused with')
  assert.doesNotMatch(prompts.slice(mark)[1] || '', /blocker documented in this run/, 'the unchanged blocker is accepted in a continuation')
  assert.equal(continuation.result.improvementStatus, 'blocked')
  assert.equal(continuation.result.usage.providerTurns, 2, 'no reminder for the continuation')

  // A later ordinary run of the chat starts implementing, and repeating the old blocker is refused.
  mark = prompts.length
  script = sequence(pausedPlan(), { text: 'Still blocked' })
  const later = await run(runtime, { workspace, chatId: 'chat-p', loopTask: 2 })
  assert.equal(later.events.find(event => event.type === 'run.started').improvementStatus, 'implementing', 'an ordinary new run never inherits blocked')
  assert.match(prompts.slice(mark)[1] || '', /blocker documented in this run/, 'the refusal reaches the next provider prompt')
  assert.equal(later.live.improvementStatus, 'implementing', 'the refused status change did not apply')
})
