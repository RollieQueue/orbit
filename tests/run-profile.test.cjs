// The run profile (runtime/run-profile.mts): where the wall-clock time of a run went, on synthetic records (overlapping and
// sequential helpers, a run that has not finished, waits, spawn calls, restarts, a cut trace history), its text within a budget,
// the previous-run paragraph of the improvement loop, and the run_profile tool (who may call it, which runs it may profile).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { profileRun, formatProfile, profileSummary, previousRunProfile } = require('../electron/runtime/run-profile.mts')
const chatMemory = require('../electron/chat-memory.mts')
const improvement = require('../electron/runtime/improvement.mts')
const registry = require('../electron/tool-registry.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')

// ---- Synthetic records: times are seconds after the start of the run -------------------------------------------------
const T0 = Date.parse('2020-01-01T10:00:00.000Z')
const MIN = 60
const ms = seconds => seconds * 1000
const at = seconds => new Date(T0 + seconds * 1000).toISOString()
const turn = (from, to) => ({ turn: 1, transport: 'session', startedAt: at(from), firstEventAt: at(from), endedAt: to === null ? null : at(to), promptChars: 0, nativeToolCalls: 0, orbitToolCalls: 0, sessionId: null })
const agent = (id, turns, extra = {}) => ({
  id, name: id, parentId: id === 'root' ? null : 'root', providerId: 'claude', model: 'sonnet', status: 'done', startedAt: turns.length ? at(turns[0][0]) : null, finishedAt: null,
  turnTimings: turns.map(([from, to]) => turn(from, to)), handovers: [], ...extra,
})
let counter = 0
const trace = (seconds, agentId, kind, text) => ({ id: `t${++counter}`, agentId, agentName: agentId, kind, text, time: at(seconds) })
// What Orbit writes for an Orbit tool call: the dispatch when the call starts, the observation when it ends.
const dispatch = (seconds, agentId, name, args = {}) => trace(seconds, agentId, 'tool', `${name} ${JSON.stringify(args)}`)
const answer = (seconds, agentId, name, result) => trace(seconds, agentId, 'observation', `${name}: ${JSON.stringify(result)}`)
const spawnMessage = (seconds, id) => ({ kind: 'spawn', toAgentId: id, time: at(seconds) })
const record = (fields = {}) => ({ runId: 'aaaaaaaa-1111', projectId: 'p', chatId: 'c', status: 'completed', startedAt: at(0), finishedAt: at(30 * MIN), agents: [], traces: [], communications: [], ...fields })
// The same run as the runtime holds it: agents in a Map.
const live = saved => ({ ...saved, agents: undefined, agentNodes: new Map(saved.agents.map(item => [item.id, item])) })

test('a run without helpers is all time with no helper, and a long one is told to delegate', () => {
  const profile = profileRun(record({ agents: [agent('root', [[0, 30 * MIN]])] }))
  assert.equal(profile.wallMs, ms(30 * MIN))
  assert.equal(profile.open, false)
  assert.deepEqual(profile.helpers, [])
  assert.deepEqual(profile.parallel, { noneMs: ms(30 * MIN), oneMs: 0, manyMs: 0, max: 0 })
  assert.equal(profile.firstHelperMs, null)
  assert.deepEqual(profile.root, { turns: 1, turnMs: ms(30 * MIN), waitMs: null, waitCalls: 0 }, 'without traces the root\'s waits are unknown, not zero')
  assert.deepEqual(profile.hints, ['no helper was used in 30.0 min: independent parts could run in parallel'])
  assert.equal(formatProfile(profile), [
    'Run aaaaaaaa (completed): 30.0 min wall-clock.',
    'Root: 1 turn, 30.0 min of turn time. Tool calls: native 0, Orbit 0.',
    'Helpers: none.',
    'Hints: no helper was used in 30.0 min: independent parts could run in parallel.',
  ].join('\n'))
  // A run alone for less than ten minutes is no reason to ask for help; a trivial one says nothing, and the chat history keeps no text of it.
  assert.deepEqual(profileRun(record({ finishedAt: at(9 * MIN), agents: [agent('root', [[0, 9 * MIN]])] })).hints, [])
  const short = record({ finishedAt: at(60), agents: [agent('root', [[0, 60]])] })
  assert.deepEqual(profileRun(short).hints, [])
  assert.equal(profileSummary(short), null)
  assert.match(profileSummary(record({ agents: [agent('root', [[0, 30 * MIN]])] })), /^Run aaaaaaaa \(completed\): 30\.0 min/)
})

test('helpers working together: minutes with none, one and two or more at once, the first one\'s start, the longest first', () => {
  const saved = record({
    agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]]), agent('B', [[600, 1200]]), agent('C', [[1500, 1680]])],
    communications: [spawnMessage(300, 'A'), spawnMessage(600, 'B'), spawnMessage(1500, 'C')],
  })
  const profile = profileRun(saved)
  // 0-300 and 1200-1500 and 1680-1800 with none; 300-600, 900-1200 and 1500-1680 with one; 600-900 with two.
  assert.deepEqual(profile.parallel, { noneMs: ms(720), oneMs: ms(780), manyMs: ms(300), max: 2 })
  assert.equal(profile.parallel.noneMs + profile.parallel.oneMs + profile.parallel.manyMs, profile.wallMs)
  assert.equal(profile.firstHelperMs, ms(300))
  assert.deepEqual(profile.helpers.map(helper => [helper.name, helper.workMs, helper.startedMs]), [['A', ms(600), ms(300)], ['B', ms(600), ms(600)], ['C', ms(180), ms(1500)]])
  assert.deepEqual(profile.hints, ['first helper started 5.0 min in: delegate right after a short look'])
  const text = formatProfile(profile)
  assert.match(text, /\nHelpers: 3, the first started 5\.0 min in\. With 0 \/ 1 \/ 2\+ helpers working: 12\.0 min \/ 13\.0 min \/ 5\.0 min \(at most 2 at once\)\.\n/)
  assert.match(text, /\nRoot: 1 turn, 30\.0 min of turn time\. Tool calls: native 0, Orbit 0; all agents: native 0, Orbit 0\.\n/)
  assert.match(text, /\nBy time: A \(claude\/sonnet\) 10\.0 min done; B \(claude\/sonnet\) 10\.0 min done; C \(claude\/sonnet\) 3\.0 min done\.\n/)
  // One shape for a run the runtime holds (a Map of agents) and for a saved one.
  assert.deepEqual(profileRun(live(saved)), profile)
})

test('helpers that follow one another never count as two at once, and the profile says so', () => {
  const profile = profileRun(record({
    agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]]), agent('B', [[900, 1500]])],
    communications: [spawnMessage(300, 'A'), spawnMessage(900, 'B')],
  }))
  assert.deepEqual(profile.parallel, { noneMs: ms(600), oneMs: ms(1200), manyMs: 0, max: 1 })
  assert.match(profile.hints[0], /^never two helpers at once: 2 helpers worked one after another \(20\.0 min\)/)
  assert.match(profile.hints[1], /^first helper started 5\.0 min in/)
})

test('turns of one agent that are close are one stretch of work, and a long gap is not work', () => {
  const profile = profileRun(record({ agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 400], [430, 500], [900, 1000]])], communications: [spawnMessage(300, 'A')] }))
  assert.equal(profile.helpers[0].workMs, ms(200 + 100), '300-500 (the 30 s between turns is a tool call) and 900-1000')
})

test('a run that has not finished is measured up to now, a saved one that never finished up to its last save', () => {
  const unfinished = record({
    status: 'working', finishedAt: null,
    agents: [agent('root', [[0, null]], { status: 'working' }), agent('A', [[300, null]], { status: 'working' }), agent('D', [[300, null]], { status: 'done', finishedAt: at(400) })],
    communications: [spawnMessage(300, 'A'), spawnMessage(300, 'D')],
  })
  const now = T0 + ms(720)
  const profile = profileRun(live(unfinished), now)
  assert.equal(profile.open, true)
  assert.equal(profile.endedAt, at(720))
  assert.equal(profile.wallMs, ms(720))
  assert.equal(profile.root.turnMs, ms(720))
  assert.deepEqual(profile.helpers.map(helper => [helper.name, helper.workMs]), [['A', ms(420)], ['D', ms(100)]], 'a helper that finished ends its open turn with itself')
  assert.deepEqual(profile.parallel, { noneMs: ms(300), oneMs: ms(320), manyMs: ms(100), max: 2 })
  assert.match(formatProfile(profile), /^Run aaaaaaaa \(working, unfinished\): 12\.0 min wall-clock\./)
  // Saved: up to its last save, never past now, and without a save time up to the last thing it recorded.
  assert.equal(profileRun({ ...unfinished, updatedAt: at(540) }, T0 + ms(3600)).wallMs, ms(540))
  assert.equal(profileRun({ ...unfinished, updatedAt: at(540) }, T0 + ms(500)).wallMs, ms(500))
  assert.equal(profileRun(unfinished, T0 + ms(3600)).wallMs, ms(400), 'the last thing it recorded was helper D finishing')
  // An empty record is a run of no length, not an error.
  assert.equal(profileRun({ runId: 'empty' }, T0).wallMs, 0)
})

test('the root\'s waits are paired from the traces: the provider\'s own stream of a call and other agents\' calls do not count', () => {
  const saved = record({
    agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]])],
    communications: [spawnMessage(300, 'A')],
    traces: [
      trace(355, 'root', 'tool', 'mcp__orbit__wait_agent\nstatus=started'),
      dispatch(360, 'root', 'wait_agent', { agentId: 'A' }),
      trace(361, 'root', 'tool', 'wait_agent {"agentId":"A"}\nstatus=running'),
      dispatch(400, 'A', 'wait_agent', {}),
      answer(500, 'A', 'wait_agent', []),
      answer(700, 'root', 'context_read', { key: 'k' }),
      answer(960, 'root', 'wait_agent', [{ agentId: 'A', status: 'done' }]),
      dispatch(1200, 'root', 'wait_message', { timeout_ms: 1000 }),
      answer(1320, 'root', 'wait_message', { messages: [] }),
      trace(1740, 'root', 'tool', `wait_agent ${JSON.stringify({ agentId: 'A' })}\n[truncated]`),
    ],
  })
  const { root, hints } = profileRun(saved)
  // 360-960 and 1200-1320, and the wait nobody answered lasts as long as the run: 1740-1800.
  assert.equal(root.waitMs, ms(600 + 120 + 60))
  assert.equal(root.waitCalls, 3)
  assert.equal(hints.find(hint => /^root waited/.test(hint)), 'root waited 43% of the run (13.0 min) in wait_agent/wait_message: take finished results at once and work meanwhile')
  assert.match(formatProfile(profileRun(saved)), /Root: 1 turn, 30\.0 min of turn time; blocked in wait_agent\/wait_message 13\.0 min \(43% of the run\)\./)
  // Without helpers the waits are for messages: counted, but no advice to take results in.
  const alone = profileRun({ ...saved, agents: [agent('root', [[0, 30 * MIN]])], communications: [] })
  assert.equal(alone.root.waitMs, ms(780))
  assert.ok(!alone.hints.some(hint => /^root waited/.test(hint)))
})

test('a spawn_agent call is timed from its start to the agent\'s creation, and a slow one is flagged', () => {
  const saved = record({
    agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[280, 900]], { isolation: { kind: 'worktree', path: 'x', base: 'b', target: 't' } }), agent('B', [[301, 900]])],
    communications: [spawnMessage(280, 'A'), spawnMessage(301, 'B')],
    traces: [
      dispatch(240, 'root', 'spawn_agent', { name: 'A', kind: 'code', isolation: 'worktree' }),
      answer(280, 'root', 'spawn_agent', { ok: true, agentId: 'A', agent: { id: 'A' } }),
      trace(290, 'root', 'tool', `spawn_agent ${JSON.stringify({ task: 'x'.repeat(1300) })}\n[truncated]`),
      answer(291, 'root', 'spawn_agent', { ok: false, reason: 'agent_limit' }),
      dispatch(300, 'root', 'spawn_agent', { name: 'B' }),
      answer(301, 'root', 'spawn_agent', { ok: true, agentId: 'B', agent: { id: 'B' } }),
      trace(301, 'root', 'delegation', 'B: do the review\nReason: r\nModel for review work: claude/opus'),
      dispatch(310, 'root', 'spawn_agent', { name: 'A' }),
      answer(310, 'root', 'spawn_agent', { ok: true, reused: true, agentId: 'A', status: 'working' }),
    ],
  })
  const profile = profileRun(saved)
  const byName = Object.fromEntries(profile.helpers.map(helper => [helper.name, helper]))
  assert.deepEqual([byName.A.spawnMs, byName.A.kind, byName.A.isolated], [ms(40), 'code', true], 'the kind the call named')
  assert.deepEqual([byName.B.spawnMs, byName.B.kind, byName.B.isolated], [ms(1), 'review', false], 'the kind the routing note on the delegation names')
  assert.deepEqual(profile.spawns, { calls: 4, totalMs: ms(40 + 1 + 1 + 0), slowestMs: ms(40) }, 'a refused and a reused call are calls too, but make no helper')
  assert.ok(profile.hints.includes('spawn_agent calls took 42 s in all, up to 40 s for one (an isolated copy is made inside the call)'))
  assert.match(formatProfile(profile), /A \(code, claude\/sonnet\) 10\.3 min done, spawn 40 s; B \(review, claude\/sonnet\) 10\.0 min done\./)
})

test('restart_orbit: every call from its start to its answer, the last one to the restart request, the step lines the output has', () => {
  const profile = profileRun(record({
    status: 'restarting', finishedAt: at(1551), restart: { requestedAt: at(1550), reason: 'r', source: 'tool' },
    agents: [agent('root', [[0, 1551]], { status: 'cancelled', finishedAt: at(1551) })],
    traces: [
      dispatch(1200, 'root', 'restart_orbit', { reason: 'x', continueWith: 'y' }),
      trace(1210, 'root', 'restart', '# Subtest: …\nok 5 - something 12 ms\n  ok   typecheck      1400 ms\n  FAIL test           33000 ms'),
      answer(1240, 'root', 'restart_orbit', { ok: false, error: 'restart_orbit failed (self-upgrade status failed)' }),
      dispatch(1500, 'root', 'restart_orbit', { reason: 'x', continueWith: 'y' }),
    ],
  }))
  assert.deepEqual(profile.restart, { calls: 2, failed: 1, totalMs: ms(40 + 50), medianMs: ms(45), longestMs: ms(50), applied: true, steps: [{ step: 'typecheck', ms: 1400 }, { step: 'test', ms: 33000 }] })
  assert.ok(profile.hints.includes('restart_orbit took 1.5 min in 2 calls (median 45 s)'))
  assert.match(formatProfile(profile), /\nrestart_orbit: 2 calls, 1\.5 min in all \(median 45 s, 1 failed, the last one applied the change; typecheck 1 s, test 33 s\)\./)
  // A call still running when the record was taken lasts until then; without any restart call there is no line.
  assert.equal(profileRun(live(record({ status: 'working', finishedAt: null, agents: [agent('root', [[0, null]], { status: 'working' })], traces: [dispatch(100, 'root', 'restart_orbit', {})] })), T0 + ms(160)).restart.totalMs, ms(60))
  assert.equal(profileRun(record({ agents: [agent('root', [[0, 60]])] })).restart, null)
})

test('a run that lost the start of its trace history says what is not counted', () => {
  const traces = n => Array.from({ length: n }, (_, index) => trace(1200 + index % 500, 'root', 'output', 'x'))
  const agents = [agent('root', [[0, 30 * MIN]])]
  const cut = profileRun(record({ agents, traces: traces(2000) }))
  assert.equal(cut.tracesFromMs, ms(1200))
  assert.match(formatProfile(cut), /30\.0 min wall-clock; its trace history starts 20\.0 min in, so waits, spawn calls and restarts before that are not counted\./)
  assert.equal(profileRun(record({ agents, traces: traces(1999) })).tracesFromMs, null)
})

test('the text stays within its budget however many helpers there are, and lists the longest ones first', () => {
  const names = Array.from({ length: 30 }, (_, index) => `helper-number-${index}-with-a-long-name`)
  const helpers = names.map((name, index) => agent(name, [[300 + index, 300 + index + 30 * (index + 1)]], { model: 'a-model-with-a-rather-long-name-5-5', handovers: index === 3 ? [{ from: { providerId: 'codex', model: 'gpt-6' }, to: { providerId: 'antigravity', model: 'gemini-3.1-pro-high' } }] : [] }))
  const profile = profileRun(record({ agents: [agent('root', [[0, 30 * MIN]]), ...helpers], communications: names.map((name, index) => spawnMessage(300 + index, name)) }))
  assert.equal(profile.helpers.length, 30)
  assert.equal(profile.helpers[0].name, 'helper-number-29-with-a-long-name')
  assert.equal(profile.helpers.find(helper => helper.name.includes('number-3-')).model, 'codex/gpt-6 → antigravity/gemini-3.1-pro-high')
  const text = formatProfile(profile)
  assert.ok(text.length <= 1200, `${text.length}`)
  assert.match(text, /\nLongest \d of 30: helper-number-29-with-a-long-name \(claude\/a-model-with-a-rather-long-name-5-5\) 15\.0 min done; helper-number-28/)
  for (const budget of [900, 600, 400, 200, 80]) {
    const small = formatProfile(profile, budget)
    assert.ok(small.length <= budget, `${budget}: ${small.length}`)
    assert.match(small, /^Run aaaaaaaa/)
  }
  // The list of helpers shrinks first as the room does; what is left of the profile after that is cut at the end.
  const listed = size => (formatProfile(profile, size).match(/ \(claude\//g) || []).length
  const counts = [1200, 900, 600, 400].map(listed)
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a))
  assert.equal(counts[0], 8)
  assert.equal(counts.at(-1), 0)
  assert.match(formatProfile(profile, 400), /\nHints: first helper started/, 'the hints stay while a helper is listed or not')
  assert.match(formatProfile(profile, 80), /…$/)
})

// ---- The history of a chat ---------------------------------------------------------------------------------------------
const earlier = (fields = {}) => ({ runId: 'r', status: 'completed', profile: null, ...fields })

test('the previous run is the latest finished one, a continuation after restart_orbit stands for the run it continues', () => {
  assert.equal(previousRunProfile(undefined), '')
  assert.equal(previousRunProfile([]), '')
  assert.equal(previousRunProfile([earlier({ runId: 'a' })]), '', 'a run without a profile is skipped, and with none at all the paragraph is left out')
  const work = earlier({ runId: 'work', status: 'restarting', profile: 'Run work (restarting): 35.9 min wall-clock.' })
  const confirm = earlier({ runId: 'confirm', resumedFrom: 'work', profile: null })
  const running = earlier({ runId: 'now', status: 'working', profile: 'Run now (working, unfinished)' })
  const paragraph = previousRunProfile([earlier({ runId: 'old', profile: 'Run old (completed): 9 min' }), work, confirm, running])
  assert.equal(paragraph, '\nPREVIOUS RUN PROFILE (the latest finished run of this chat; run_profile {runId} has the detail):\nRun work (restarting): 35.9 min wall-clock.')
  // The newest finished run with a profile of its own, whatever it is, when it continues nothing that is known.
  assert.match(previousRunProfile([work, earlier({ runId: 'late', resumedFrom: 'gone', profile: 'Run late' })]), /\nRun late$/)
  // Loops in the links end.
  assert.doesNotThrow(() => previousRunProfile([earlier({ runId: 'a', resumedFrom: 'b', profile: 'A' }), earlier({ runId: 'b', resumedFrom: 'a', profile: 'B' })]))
})

test('the chat history keeps a profile of every earlier turn, and a record it cannot read costs no more than the profile', () => {
  const saved = record({ resumedFrom: 'zzzz', agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]])], communications: [spawnMessage(300, 'A')] })
  for (const source of [saved, live(saved)]) {
    const view = chatMemory.view(source)
    assert.equal(view.resumedFrom, 'zzzz')
    assert.match(view.profile, /^Run aaaaaaaa \(completed\): 30\.0 min wall-clock\.\nRoot:/)
    assert.deepEqual(view.agents.map(item => item.id), ['A'], 'the root is still left out of the view')
  }
  assert.equal(chatMemory.view(record({ finishedAt: at(30), agents: [agent('root', [[0, 30]])] })).profile, null, 'a trivial run has none')
  assert.equal(chatMemory.view({ runId: 'x', startedAt: at(0), agents: [], traces: 5 }).profile, null, 'unreadable traces')
  assert.ok(!('resumedFrom' in chatMemory.view(record())))
  // team_history and the digest show what they showed before.
  assert.ok(!JSON.stringify(chatMemory.history([chatMemory.view(saved)])).includes('PREVIOUS RUN'))
})

test('the improvement loop shows the profile of the chat\'s previous run after the handoff, and nothing when there is none', () => {
  const prior = [
    chatMemory.view(record({ runId: 'work0000-1', status: 'restarting', agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]])], communications: [spawnMessage(300, 'A')] })),
    chatMemory.view(record({ runId: 'confirm0-2', resumedFrom: 'work0000-1', finishedAt: at(60), agents: [agent('root', [[0, 60]])] })),
  ]
  const base = { improvementMode: true, improvements: [{ id: 'x', title: 'Task x', status: 'working', evidence: '' }], improvementStatus: 'implementing', improvementHandoff: 'next: check X' }
  const block = improvement.progressBlock({ ...base, priorRuns: prior })
  assert.match(block, /HANDOFF FROM THE PREVIOUS TASK: next: check X\nPREVIOUS RUN PROFILE \(the latest finished run of this chat; run_profile \{runId\} has the detail\):\nRun work0000 \(restarting\): 30\.0 min wall-clock\.\n/)
  assert.ok(block.length < 6500 + 1300, `${block.length}`)
  for (const priorRuns of [[], undefined]) assert.doesNotMatch(improvement.progressBlock({ ...base, priorRuns }), /PREVIOUS RUN PROFILE/)
  // Only the root plans the batch: a helper's progress block goes without the profile.
  assert.doesNotMatch(improvement.progressBlock({ ...base, priorRuns: prior }, false), /PREVIOUS RUN PROFILE/)
  assert.match(improvement.progressBlock({ ...base, priorRuns: prior }), /^CURRENT IMPROVEMENT PROGRESS:\nPlan status: implementing/)
})

test('an improvement-mode run is shown the profile of its own chat\'s previous run, and another chat is not', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-profile-run-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const previous = { ...record({ runId: 'prevrun01-aaaa', status: 'restarting', agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]])], communications: [spawnMessage(300, 'A')] }), projectId: 'project-1', chatId: 'chat-p' }
  const runStore = { forChat: () => [previous], get: () => null, save: () => {} }
  const firstPrompt = async chatId => {
    const prompts = []
    const runtime = new OrbitRuntime({ projectIndex: null, runStore, runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'Nothing to do' } } })
    let resolve
    const done = new Promise(r => { resolve = r })
    runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
    const runId = await runtime.start({ workspace, projectId: 'project-1', chatId, providerId: 'test', prompt: 'Improve the project', improvementMode: true, accessMode: 'workspace-write' })
    const timer = setTimeout(() => runtime.stop(runId), 5000)
    await done; clearTimeout(timer)
    return prompts[0]
  }
  assert.match(await firstPrompt('chat-p'), /\nPREVIOUS RUN PROFILE \(the latest finished run of this chat; run_profile \{runId\} has the detail\):\nRun prevrun0 \(restarting\): 30\.0 min wall-clock\.\nRoot: 1 turn/)
  assert.doesNotMatch(await firstPrompt('chat-q'), /PREVIOUS RUN PROFILE/)
})

// ---- The tool ----------------------------------------------------------------------------------------------------------
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+);/)
const blocking = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ text: 'stopped' }), { once: true }))
const payload = (chatId, extra = {}) => ({ workspace: process.cwd(), projectId: 'project-1', chatId, providerId: 'test', prompt: 'Work', accessMode: 'read-only', ...extra })
async function started(t, runtime, chatId, extra) {
  const runId = await runtime.start(payload(chatId, extra))
  t.after(() => runtime.stop(runId))
  const run = runtime.runs.get(runId)
  return { runId, run, root: run.agentNodes.get('root') }
}
async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('The awaited condition was not reached')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
// A run that has ended and let go of its operations: a new run in its chat may start.
const ended = async (runtime, runId) => {
  runtime.stop(runId)
  const run = runtime.runs.get(runId)
  await waitFor(() => run.status !== 'working' && run.operations.size === 0)
}

test('run_profile: the current run up to now, an earlier run of this chat, and no run of another chat', async t => {
  const saved = new Map()
  const runStore = { get: id => saved.get(id) || null, save: () => {}, forChat: () => [] }
  // The runtime's clock stands still ten minutes after the first run's start: the profile of a live run is up to it.
  let clock = Date.now()
  const runtime = new OrbitRuntime({ projectIndex: null, runProvider: blocking, runStore, clock: () => clock })
  const first = await started(t, runtime, 'chat-1')
  clock = Date.parse(first.run.startedAt) + ms(10 * MIN)
  await waitFor(() => first.root.turnTimings.length > 0)
  const own = await runtime.executeTool(first.run, first.root, 'run_profile', {})
  assert.equal(own.runId, first.runId)
  assert.equal(own.status, 'working')
  assert.equal(own.helpers, 0)
  assert.ok(own.profile.open)
  assert.equal(own.profile.wallMs, ms(10 * MIN))
  assert.equal(own.wallClock, '10.0 min')
  assert.match(own.text, /^Run [0-9a-f]{8} \(working, unfinished\): 10\.0 min wall-clock\.\nRoot: 1 turn/)
  assert.deepEqual(await runtime.executeTool(first.run, first.root, 'run_profile', { runId: first.runId }), own, 'the run\'s own id is the same as none')
  assert.equal((await runtime.executeTool(first.run, { ...first.root, id: 'helper-1', name: 'Helper' }, 'run_profile', {})).runId, first.runId, 'every agent may ask')
  await ended(runtime, first.runId)
  const second = await started(t, runtime, 'chat-1')
  const before = await runtime.executeTool(second.run, second.root, 'run_profile', { runId: first.runId })
  assert.equal(before.runId, first.runId)
  assert.equal(before.status, 'cancelled')
  assert.equal(before.profile.open, false)
  // A saved run of the chat, and one of another project with the same chat id.
  saved.set('stored-1', { ...record({ runId: 'stored-1', agents: [agent('root', [[0, 30 * MIN]])] }), projectId: 'project-1', chatId: 'chat-1' })
  saved.set('stored-2', { ...record({ runId: 'stored-2', agents: [agent('root', [[0, 30 * MIN]])] }), projectId: 'project-2', chatId: 'chat-1' })
  assert.match((await runtime.executeTool(second.run, second.root, 'run_profile', { runId: 'stored-1' })).text, /^Run stored-1 \(completed\): 30\.0 min wall-clock\./)
  const refused = /No run with that id in this chat/
  await assert.rejects(runtime.executeTool(second.run, second.root, 'run_profile', { runId: 'stored-2' }), refused)
  await assert.rejects(runtime.executeTool(second.run, second.root, 'run_profile', { runId: 'nope' }), refused)
  const other = await started(t, runtime, 'chat-2')
  await assert.rejects(runtime.executeTool(other.run, other.root, 'run_profile', { runId: first.runId }), refused, 'the live run of another chat')
  await assert.rejects(runtime.executeTool(other.run, other.root, 'run_profile', { runId: 'stored-1' }), refused, 'the saved run of another chat')
})

test('run_profile has an optional string runId, and its call is told in the work log', async t => {
  assert.deepEqual(registry.validate('run_profile', {}), { ok: true, args: {} })
  assert.deepEqual(registry.validate('run_profile', null), { ok: true, args: {} })
  assert.deepEqual(registry.validate('run_profile', { runId: null }), { ok: true, args: {} })
  assert.deepEqual(registry.validate('run_profile', { runId: 'abc' }), { ok: true, args: { runId: 'abc' } })
  assert.match(registry.validate('run_profile', { runId: 3 }).error, /runId must be a string/)
  assert.match(registry.validate('run_profile', { runId: 'abc', extra: 1 }).error, /unknown argument "extra"/)
  const prompts = []
  const runtime = new OrbitRuntime({ projectIndex: null, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    const [, name] = identity(prompt)
    return prompts.length === 1 && name === 'Orbit'
      ? { text: JSON.stringify({ content: '', tool_calls: [{ id: 'p1', name: 'run_profile', arguments: {} }] }) }
      : { text: `${name} finished` }
  } })
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload('chat-3', { accessMode: 'read-only' }))
  await done; off()
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /run_profile → \d+ s wall-clock, 0 helpers/)
  const observation = runtime.getRun(runId).traces.find(item => item.kind === 'observation' && item.text.startsWith('run_profile: '))
  assert.ok(observation, 'the answer is traced like any tool result')
  assert.equal(JSON.parse(observation.text.slice('run_profile: '.length)).runId, runId)
})

test('a damaged saved record (lists that are not lists, holes in them) gives a profile, not a TypeError', () => {
  const damaged = record({ agents: [
    { ...agent('root', [[0, 10 * MIN]]), handovers: [null] },
    { ...agent('A', []), turnTimings: {}, handovers: 'none' },
    { ...agent('B', [[60, 120]]), turnTimings: [null, turn(60, 120)] },
  ], communications: [spawnMessage(60, 'B')] })
  const profile = profileRun(damaged)
  assert.equal(profile.wallMs, ms(30 * MIN))
  assert.ok(formatProfile(profile, 1200).length > 0)
})

// ---- Tokens: the usage Orbit records per agent ------------------------------------------------------------------------
// An agent with `steps - 1` tool calls in one turn (a step is a tool call or an answer: the model reads its whole context at each).
const used = (input, output, cached, steps) => ({ usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached }, turnTimings: [{ ...turn(0, 30 * MIN), nativeToolCalls: Math.floor((steps - 1) / 2), orbitToolCalls: Math.ceil((steps - 1) / 2) }] })

test('tokens: each agent\'s input and output, its share and average context per step, run totals, and the dominating agents named in at most two hints', () => {
  const saved = record({
    agents: [
      agent('root', [[0, 30 * MIN]], used(45_000_000, 120_000, 41_000_000, 205)),
      agent('s1-fast-gate', [[300, 900]], used(8_000_000, 40_000, 7_000_000, 32)),
      agent('small', [[300, 600]], used(1_000_000, 9_000, 0, 20)),
    ],
    communications: [spawnMessage(300, 's1-fast-gate'), spawnMessage(300, 'small')],
  })
  const profile = profileRun(saved)
  assert.deepEqual([profile.tokens.input, profile.tokens.cached, profile.tokens.output], [54_000_000, 48_000_000, 169_000])
  assert.deepEqual(profile.tokens.agents.map(item => [item.name, item.sharePct, item.steps, item.perStep]), [['root', 83, 205, 219512], ['s1-fast-gate', 15, 32, 250000], ['small', 2, 20, 50000]])
  assert.deepEqual(profile.tokens.unknown, [])
  const tokenHints = profile.hints.filter(hint => /tokens per step/.test(hint))
  assert.equal(tokenHints.length, 2, 'at most two')
  assert.match(tokenHints[0], /^root: 83% of the run's input tokens, ~220k tokens per step: what it reads stays in its context/)
  assert.match(tokenHints[1], /^s1-fast-gate: 15% of the run's input tokens, ~250k tokens per step: its context grew; give such work as smaller tasks or lower its effort$/)
  const text = formatProfile(profile)
  assert.ok(text.length <= 1200, `${text.length}`)
  assert.match(text, /\nTokens: input 54M \(89% cached\), output 169k \(average context ~\d+k per step over ~257 steps, an estimate: input \/ steps\)\. By input: root 45M \(83%, ~220k\/step, out 120k\); s1-fast-gate 8\.0M \(15%, ~250k\/step, out 40k\); small 1\.0M \(2%, ~50k\/step, out 9k\)\.\n/)
  assert.deepEqual(profileRun(live(saved)), profile, 'the same for a run the runtime holds')
})

test('tokens: a provider that reported nothing is unknown, never 0, and a run without any usage has no token line', () => {
  const none = profileRun(record({ agents: [agent('root', [[0, 30 * MIN]]), agent('A', [[300, 900]])], communications: [spawnMessage(300, 'A')] }))
  assert.equal(none.tokens, null)
  assert.doesNotMatch(formatProfile(none), /Tokens/)
  const some = profileRun(record({
    agents: [agent('root', [[0, 30 * MIN]], used(2_000_000, 30_000, 0, 40)), agent('Silent', [[300, 900]]), agent('Zero', [[300, 900]], { usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } }), agent('Idle', []), agent('Odd', [[300, 900]], { usage: { inputTokens: 'x', outputTokens: -3 } })],
    communications: [spawnMessage(300, 'Silent'), spawnMessage(300, 'Zero'), spawnMessage(300, 'Odd')],
  }))
  assert.deepEqual(some.tokens.agents.map(item => item.name), ['root'])
  assert.deepEqual(some.tokens.unknown, ['Silent', 'Zero', 'Odd'], 'an agent that never ran says nothing')
  assert.match(formatProfile(some), /\nTokens: input 2\.0M, output 30k \(average context ~50k per step over ~40 steps, an estimate: input \/ steps\)\. By input: root 2\.0M \(100%, ~50k\/step, out 30k\)\. Usage unknown \(not reported\): Silent, Zero, Odd\.\n/)
  assert.deepEqual(some.hints.filter(hint => /token/.test(hint)), [], 'a small context is no reason for a hint')
})

test('tokens: output at a high effort is named as mostly thinking, and a long list of agents is cut in the tool\'s answer and in the text', async t => {
  const thinker = profileRun(record({ agents: [agent('root', [[0, 30 * MIN]]), agent('Thinker', [[300, 900]], { reasoningEffort: 'high', ...used(400_000, 150_000, 0, 10) }), agent('Quiet', [[300, 900]], { reasoningEffort: 'low', ...used(400_000, 150_000, 0, 10) })], communications: [spawnMessage(300, 'Thinker'), spawnMessage(300, 'Quiet')] }))
  assert.deepEqual(thinker.hints.filter(hint => /token/.test(hint)), ['Thinker: 150k output tokens at high effort, mostly thinking: a lower effort for simple work saves them'])
  const names = Array.from({ length: 30 }, (_, index) => `helper-number-${index}-with-a-long-name`)
  const crowd = record({ agents: [agent('root', [[0, 30 * MIN]], used(5_000_000, 50_000, 0, 60)), ...names.map((name, index) => agent(name, [[300 + index, 900]], used(1_000_000 + index, 10_000, 0, 30)))], communications: names.map((name, index) => spawnMessage(300 + index, name)) })
  const profile = profileRun(crowd)
  assert.equal(profile.tokens.agents.length, 31)
  for (const budget of [1200, 700, 400, 120]) {
    const text = formatProfile(profile, budget)
    assert.ok(text.length <= budget, `${budget}: ${text.length}`)
  }
  assert.match(formatProfile(profile, 1200), /By input: root 5\.0M \([^)]*\); helper-number-29[^;]*; helper-number-28[^;]*; \d+ more\./)
  const runtime = new OrbitRuntime({ projectIndex: null, runProvider: blocking, runStore: { get: id => id === 'crowd' ? { ...crowd, runId: 'crowd', projectId: 'project-1', chatId: 'chat-1' } : null, save: () => {}, forChat: () => [] } })
  const now = await started(t, runtime, 'chat-1')
  const answer = await runtime.executeTool(now.run, now.root, 'run_profile', { runId: 'crowd' })
  assert.equal(answer.profile.tokens.agents.length, 21)
  assert.equal(answer.profile.tokens.agentsOmitted, 10)
  assert.equal(answer.profile.tokens.input, profile.tokens.input, 'the totals still count every agent')
  await ended(runtime, now.runId)
})
