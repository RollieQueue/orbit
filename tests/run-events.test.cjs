const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/diff-parse.test.cjs: vite's oxc transform, then an ES module from a data URL.
// run-events.ts only has type imports, which the transform erases.
let applyRunEvent, restoreRuns, snapshotBase, runNotices, openTurn, durationMs, formatDuration, activeRunIds, interruptLost, isActiveStatus, LOST_RUN_ERROR, historyAnchors, pauseHolder, shownStatus, actionCount, thinkingText, agentTokens, tokenCount, usageTitle, usageBreakdown, runUsage
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'run-events.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
  ;({ applyRunEvent, restoreRuns, snapshotBase, runNotices, openTurn, durationMs, formatDuration, activeRunIds, interruptLost, isActiveStatus, LOST_RUN_ERROR, historyAnchors, pauseHolder, shownStatus, actionCount, thinkingText, agentTokens, tokenCount, usageTitle, usageBreakdown, runUsage } = mod)
})

const AT = '2026-09-29T10:00:00.000Z'

// ---- The reducer exactly as App.tsx had it inline before the extraction, with the clock injected. The equivalence
// tests fold recorded event sequences through both and require identical results. ----
function legacyMergeMessage(messages, message) { const index = messages.findIndex(m => m.id === message.id); return index < 0 ? [...messages, message] : messages.map(m => m.id === message.id ? { ...m, ...message } : m) }
function legacyMergeById(saved, live) {
  const records = new Map(saved.map(item => [item.id, item]))
  for (const item of live) records.set(item.id, { ...records.get(item.id), ...item })
  return [...records.values()]
}
function legacyBase(event, now) { return { runId: event.runId, projectId: event.projectId, chatId: event.chatId, workspace: event.workspace || '', prompt: event.prompt || '', status: 'working', agents: [], traces: [], messages: [], communications: [], startedAt: now, providerId: event.providerId, model: event.model } }
function legacyApply(previous, event, now) {
  const run = { ...(previous[event.runId] || legacyBase(event, now)), updatedAt: now }
  if (event.providerId && (!event.agentId || event.agentId === 'root')) run.providerId = event.providerId
  if (event.model && (!event.agentId || event.agentId === 'root')) run.model = event.model
  if (event.prompt) run.prompt = event.prompt
  if (event.workspace) run.workspace = event.workspace
  if (event.limits) run.limits = event.limits
  if (event.improvements) run.improvements = event.improvements
  if (event.improvementStatus) run.improvementStatus = event.improvementStatus
  if (event.usage) run.usage = event.usage
  if (event.router) run.router = event.router
  if (event.type === 'run.started') run.status = 'working'
  if (event.agent) { const exists = run.agents.some(a => a.id === event.agent.id); run.agents = exists ? run.agents.map(a => a.id === event.agent.id ? { ...a, ...event.agent } : a) : [...run.agents, event.agent] }
  if (event.trace) run.traces = (run.traces.some(t => t.id === event.trace.id) ? run.traces.map(t => t.id === event.trace.id ? event.trace : t) : [...run.traces, event.trace]).slice(-1500)
  if (event.message) run.messages = legacyMergeMessage(run.messages, { ...event.message, runId: event.runId })
  if (event.communication) {
    const communication = event.communication
    const existing = run.communications || []
    run.communications = existing.some(item => item.id === communication.id) ? existing.map(item => item.id === communication.id ? { ...item, ...communication } : item) : [...existing, communication]
  }
  if (event.change) { const change = event.change; const existing = run.changes || []; run.changes = (existing.some(item => item.id === change.id) ? existing.map(item => item.id === change.id ? { ...item, ...change } : item) : [...existing, change]).slice(-500) }
  if (event.type === 'run.finished') { run.status = event.status || 'completed'; run.summary = event.summary; run.finishedAt = now }
  if (event.type === 'run.failed') { run.status = 'failed'; run.error = event.error; run.finishedAt = now }
  if (event.type === 'run.cancelled') { run.status = 'cancelled'; run.finishedAt = now }
  return { ...previous, [event.runId]: run }
}
function legacyRestore(previous, snapshots) {
  const restored = { ...previous }
  for (const snapshot of snapshots) {
    const live = previous[snapshot.runId]
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)
    restored[snapshot.runId] = {
      ...snapshot, ...live, startedAt: snapshot.startedAt,
      status: terminal ? snapshot.status : live?.status ?? snapshot.status,
      providerId: live?.providerId ?? snapshot.providerId, model: live?.model || snapshot.model,
      prompt: live?.prompt || snapshot.prompt, workspace: live?.workspace || snapshot.workspace,
      agents: legacyMergeById(snapshot.agents || [], live?.agents || []),
      traces: legacyMergeById(snapshot.traces || [], live?.traces || []),
      messages: legacyMergeById(snapshot.messages || [], live?.messages || []),
      communications: legacyMergeById(snapshot.communications || [], live?.communications || []),
    }
    if (snapshot.changes || live?.changes) restored[snapshot.runId].changes = legacyMergeById(snapshot.changes || [], live?.changes || []).slice(-500)
  }
  return restored
}

const fold = (reduce, events, initial = {}) => events.reduce((runs, event, index) => reduce(runs, event, `2026-09-29T10:00:${String(index % 60).padStart(2, '0')}.000Z`), initial)
const base = { runId: 'run-1', projectId: 'project', chatId: 'chat' }
const ev = (type, extra = {}) => ({ type, ...base, ...extra })
const agent = (id, extra = {}) => ({ id, name: id, parentId: id === 'root' ? null : 'root', status: 'waiting', turns: 0, ...extra })

// The event sequence the runtime emits for a run, rebuilt from its saved snapshot: creation, every trace, message and
// communication in order, the final agent states, run.info and the terminal event.
function eventsOf(snapshot) {
  const head = { runId: snapshot.runId, projectId: snapshot.projectId, chatId: snapshot.chatId }
  const events = [{ ...head, type: 'run.started', prompt: snapshot.prompt, workspace: snapshot.workspace, providerId: snapshot.providerId, model: snapshot.model, limits: snapshot.limits, status: 'working' }]
  for (const item of snapshot.agents || []) events.push({ ...head, type: 'agent.created', agent: { id: item.id, name: item.name, parentId: item.parentId, depth: item.depth, role: item.role, task: item.task, status: 'waiting', turns: 0, providerId: item.providerId, model: item.model } })
  const timed = [
    ...(snapshot.traces || []).map(trace => ({ time: trace.time, event: { ...head, type: 'trace.added', trace } })),
    ...(snapshot.messages || []).map(message => ({ time: message.time, event: { ...head, type: 'message.added', message } })),
    ...(snapshot.communications || []).map(communication => ({ time: communication.time, event: { ...head, type: 'communication.added', communication } })),
    ...(snapshot.changes || []).map(change => ({ time: change.time, event: { ...head, type: 'change.added', change } })),
  ].sort((a, b) => String(a.time).localeCompare(String(b.time)))
  events.push(...timed.map(item => item.event))
  for (const item of snapshot.agents || []) {
    events.push({ ...head, type: 'agent.updated', agent: item })
    for (const handover of item.handovers || []) events.push({ ...head, type: 'agent.handover', agentId: item.id, agent: item, handover })
  }
  events.push({ ...head, type: 'run.info', agentId: 'root', providerId: snapshot.providerId, model: snapshot.model, usage: snapshot.usage, router: snapshot.router, improvements: snapshot.improvements, improvementStatus: snapshot.improvementStatus })
  if (snapshot.status === 'completed') events.push({ ...head, type: 'run.finished', status: 'completed', summary: snapshot.summary })
  if (snapshot.status === 'failed') events.push({ ...head, type: 'run.failed', status: 'failed', error: snapshot.error })
  if (snapshot.status === 'cancelled') events.push({ ...head, type: 'run.cancelled', status: 'cancelled' })
  // A run its agent ended by restarting Orbit (restart_orbit): the terminal event carries the status.
  if (snapshot.status === 'restarting') events.push({ ...head, type: 'run.finished', status: 'restarting' })
  return events
}

const syntheticRun = () => ({
  runId: 'run-1', projectId: 'project', chatId: 'chat', prompt: 'Проверь проект', workspace: 'C:\\work\\demo', status: 'completed', providerId: 'claude', model: 'opus',
  startedAt: '2026-09-29T09:00:00.000Z', finishedAt: '2026-09-29T09:10:00.000Z', limits: { maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null },
  usage: { providerTurns: 5, workerTurns: 3 }, router: { routed: 1, notices: 0, refused: 0 },
  agents: [
    agent('root', { status: 'done', turns: 2, handovers: [], startedAt: '2026-09-29T09:00:01.000Z', finishedAt: '2026-09-29T09:10:00.000Z' }),
    agent('agent-a', { name: 'Проверка', status: 'done', turns: 3, task: 'Проверь тесты', startedAt: '2026-09-29T09:01:00.000Z', finishedAt: '2026-09-29T09:05:00.000Z', files: { read: ['a.ts'], wrote: [] } }),
    agent('agent-b', { name: 'Сборка', status: 'error', error: 'exit code 1', task: 'Собери проект', startedAt: '2026-09-29T09:01:10.000Z', finishedAt: '2026-09-29T09:04:00.000Z', handovers: [{ id: 'h1', time: '2026-09-29T09:02:00.000Z', reason: 'exhausted', from: { providerId: 'codex', model: 'gpt' }, to: { providerId: 'claude', model: 'sonnet' }, fresh: false, interrupted: true, usedPercent: 100, resetsAt: null }] }),
  ],
  traces: Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, agentId: index % 2 ? 'agent-a' : 'root', kind: index === 3 ? 'output' : 'tool', text: `trace ${index}`, time: `2026-09-29T09:0${index}:30.000Z` })),
  messages: [
    { id: 'm-a', agentId: 'agent-a', author: 'orbit', text: 'Тесты зелёные', kind: 'answer', time: '2026-09-29T09:05:00.000Z' },
    { id: 'm-root', agentId: 'root', author: 'orbit', text: 'Готово', kind: 'answer', time: '2026-09-29T09:10:00.000Z' },
  ],
  communications: [
    { id: 'c1', fromAgentId: 'user', toAgentId: 'root', fromAgentName: 'Вы', toAgentName: 'Orbit', text: 'Проверь проект', time: '2026-09-29T09:00:00.500Z', status: 'read', delivery: 'next-turn', kind: 'spawn' },
    { id: 'c2', fromAgentId: 'root', toAgentId: 'agent-a', fromAgentName: 'Orbit', toAgentName: 'Проверка', text: 'Проверь тесты', time: '2026-09-29T09:00:50.000Z', status: 'read', delivery: 'next-turn', kind: 'spawn' },
    { id: 'c3', fromAgentId: 'root', toAgentId: 'agent-b', fromAgentName: 'Orbit', toAgentName: 'Сборка', text: 'Собери проект', time: '2026-09-29T09:00:55.000Z', status: 'read', delivery: 'next-turn', kind: 'spawn' },
  ],
  changes: [{ id: 'ch1', agentId: 'agent-a', path: 'a.ts', kind: 'modify', tool: 'Edit', time: '2026-09-29T09:03:00.000Z', added: 1, removed: 1, source: 'event' }],
  summary: { text: 'Готово', agentCount: 3, providerTurns: 5 },
})

test('applyRunEvent matches the previous inline reducer on a synthetic run, event by event', () => {
  const events = eventsOf(syntheticRun())
  assert.ok(events.length > 20)
  let ours = {}, theirs = {}
  events.forEach((event, index) => {
    const at = `2026-09-29T10:00:${String(index % 60).padStart(2, '0')}.000Z`
    ours = applyRunEvent(ours, event, at); theirs = legacyApply(theirs, event, at)
    assert.deepEqual(ours, theirs, `after event ${index} (${event.type})`)
  })
  const run = ours['run-1']
  assert.equal(run.status, 'completed')
  assert.equal(run.agents.length, 3)
  assert.equal(run.traces.length, 7)
  assert.deepEqual(run.messages.map(message => message.runId), ['run-1', 'run-1'])
  assert.equal(run.changes.length, 1)
  assert.equal(run.finishedAt, `2026-09-29T10:00:${String((events.length - 1) % 60).padStart(2, '0')}.000Z`, 'finishedAt is the clock of the terminal event')
})

test('applyRunEvent matches the previous reducer for interleaved runs, updates by id and the trace cap', () => {
  const other = { runId: 'run-2', projectId: 'project', chatId: 'chat-2' }
  const events = [
    ev('run.started', { prompt: 'a', workspace: 'w', providerId: 'codex' }),
    { type: 'run.started', ...other, prompt: 'b', workspace: 'w' },
    ev('agent.created', { agent: agent('root') }),
    ev('agent.updated', { agent: { id: 'root', status: 'working', turns: 1 } }),
    { type: 'trace.added', ...other, trace: { id: 'x', agentId: 'root', kind: 'tool', text: 'first', time: AT } },
    { type: 'trace.added', ...other, trace: { id: 'x', agentId: 'root', kind: 'tool', text: 'replaced', time: AT } },
    ...Array.from({ length: 1600 }, (_, index) => ev('trace.added', { trace: { id: `t${index}`, agentId: 'root', kind: 'tool', text: String(index), time: AT } })),
    ev('run.info', { agentId: 'agent-x', providerId: 'ignored-for-run', model: 'ignored-too', usage: { providerTurns: 3 } }),
    ev('run.info', { warning: 'disk full' }),
    ev('communication.added', { communication: { id: 'c', fromAgentId: 'root', toAgentId: 'a', text: 'hi', time: AT, status: 'queued' } }),
    ev('communication.added', { communication: { id: 'c', status: 'read', readAt: AT } }),
    ev('change.added', { change: { id: 'ch', agentId: 'root', path: 'p', kind: 'modify', tool: 't', time: AT, added: 1, removed: 0, source: 'exact' } }),
    ev('change.added', { change: { id: 'ch', diff: '+x' } }),
    ev('message.added', { message: { id: 'm', agentId: 'root', author: 'orbit', text: 'answer', time: AT } }),
    ev('run.finished', { status: 'completed', summary: 'done' }),
    { type: 'run.failed', ...other, error: 'boom' },
    ev('agent.updated', { agent: { id: 'root', status: 'done' } }),
  ]
  const ours = fold(applyRunEvent, events), theirs = fold(legacyApply, events)
  assert.deepEqual(ours, theirs)
  assert.equal(ours['run-1'].traces.length, 1500)
  assert.equal(ours['run-1'].traces[0].id, 't100')
  assert.equal(ours['run-1'].providerId, 'codex', 'run.info from a helper does not change the run provider')
  assert.equal(ours['run-1'].usage.providerTurns, 3)
  assert.equal(ours['run-1'].communications[0].status, 'read')
  assert.equal(ours['run-1'].changes[0].diff, '+x')
  assert.equal(ours['run-2'].traces[0].text, 'replaced')
  assert.deepEqual([ours['run-2'].status, ours['run-2'].error], ['failed', 'boom'])
  assert.equal(ours['run-1'].agents[0].status, 'done', 'updates after the end still apply')
  assert.equal(applyRunEvent(ours, { type: 'run.info', projectId: 'p', chatId: 'c' }), ours, 'an event without a run id changes nothing')
})

const historyDir = process.env.ORBIT_RUN_HISTORY || path.join(process.env.APPDATA || '', 'orbit-ide', 'run-history')
const savedRuns = fs.existsSync(historyDir) ? fs.readdirSync(historyDir).filter(name => name.endsWith('.json')) : []
test('applyRunEvent matches the previous reducer on the runs saved on this machine', { skip: savedRuns.length ? false : 'no saved run history here' }, () => {
  // The biggest runs carry every event kind; reading is the only access.
  const snapshots = savedRuns.map(name => { try { return JSON.parse(fs.readFileSync(path.join(historyDir, name), 'utf8')) } catch { return null } }).filter(Boolean)
    .sort((a, b) => (b.traces?.length || 0) + (b.communications?.length || 0) - (a.traces?.length || 0) - (a.communications?.length || 0)).slice(0, 12)
  assert.ok(snapshots.length > 0)
  let total = 0
  for (const snapshot of snapshots) {
    const events = eventsOf(snapshot)
    total += events.length
    const ours = fold(applyRunEvent, events), theirs = fold(legacyApply, events)
    assert.deepEqual(ours, theirs, snapshot.runId)
    const run = ours[snapshot.runId]
    assert.deepEqual(run.agents, snapshot.agents)
    assert.deepEqual(run.traces, (snapshot.traces || []).slice(-1500))
    assert.deepEqual(run.messages, (snapshot.messages || []).map(message => ({ ...message, runId: snapshot.runId })))
    assert.equal(run.communications.length, (snapshot.communications || []).length)
    if (snapshot.status !== 'interrupted') assert.equal(run.status, snapshot.status)
    // Restoring the saved list over the live map gives the same run as the old merge did.
    assert.deepEqual(restoreRuns(ours, [snapshot]), legacyRestore(ours, [snapshot]))
  }
  assert.ok(total > 500, `replayed ${total} events`)
})

test('restoreRuns matches the previous merge: saved terminal status is final, live fields win for an active run', () => {
  const saved = { ...syntheticRun(), status: 'working', finishedAt: undefined }
  const live = fold(applyRunEvent, [ev('run.started', { prompt: 'live prompt', workspace: 'w2', providerId: 'codex', model: 'gpt' }), ev('agent.updated', { agent: { id: 'root', status: 'working', turns: 9 } }), ev('trace.added', { trace: { id: 'live', agentId: 'root', kind: 'tool', text: 'x', time: AT } }), ev('change.added', { change: { id: 'ch1', diff: '+live' } })])
  const ours = restoreRuns(live, [saved, { ...syntheticRun(), runId: 'run-9' }]), theirs = legacyRestore(live, [saved, { ...syntheticRun(), runId: 'run-9' }])
  assert.deepEqual(ours, theirs)
  const run = ours['run-1']
  assert.equal(run.startedAt, saved.startedAt)
  assert.deepEqual([run.prompt, run.workspace, run.providerId, run.model], ['live prompt', 'w2', 'codex', 'gpt'])
  assert.equal(run.agents.find(item => item.id === 'root').turns, 9)
  assert.equal(run.traces.length, 8)
  assert.equal(run.changes[0].diff, '+live')
  assert.equal(ours['run-9'].status, 'completed')
  const finishedMeanwhile = restoreRuns(fold(applyRunEvent, [ev('run.started'), ev('run.finished', { status: 'completed' })]), [saved])
  assert.equal(finishedMeanwhile['run-1'].status, 'completed', 'a run that ended while the list loaded stays ended')
  assert.equal(restoreRuns(fold(applyRunEvent, [ev('run.started')]), [{ ...saved, status: 'failed' }])['run-1'].status, 'failed', 'the saved terminal status wins over a stale live one')
})

test('a run the runtime process lost before its first save ends interrupted once the list read after the comeback lacks it', () => {
  // The runtime crashed within about a second of the run's start: the window saw it start, the saved list never had it.
  const LOST_AT = '2026-09-29T10:05:00.000Z'
  let runs = fold(applyRunEvent, [ev('run.started', { prompt: 'p', workspace: 'w' }), ev('agent.created', { agent: agent('root', { status: 'working' }) }),
    ev('agent.created', { agent: agent('agent-a') }), ev('agent.created', { agent: agent('agent-b', { status: 'done', finishedAt: AT }) }),
    ev('message.streaming', { agentId: 'root', messageId: 'm1', content: 'Смотрю' })])
  runs = applyRunEvent(runs, { type: 'run.started', runId: 'run-saved', projectId: 'project', chatId: 'chat-2' })
  runs = applyRunEvent(runs, { type: 'run.started', runId: 'run-done', projectId: 'project', chatId: 'chat-3' })
  runs = applyRunEvent(runs, { type: 'run.finished', runId: 'run-done', projectId: 'project', chatId: 'chat-3', status: 'completed' })
  // Taken when the runtime went down: the active runs only.
  const lost = activeRunIds(runs)
  assert.deepEqual(lost, ['run-1', 'run-saved'])
  // Before: the list alone left the run working for good (send blocked, the chat not deletable, Stop «уже завершён»).
  assert.equal(restoreRuns(runs, [])['run-1'].status, 'working')
  // After the comeback: a run of the new process starts before the list reply comes; the list has one of the lost runs.
  runs = applyRunEvent(runs, { type: 'run.started', runId: 'run-new', projectId: 'project', chatId: 'chat-4' })
  const snapshots = [{ ...syntheticRun(), runId: 'run-saved', chatId: 'chat-2', status: 'interrupted' }]
  const restored = interruptLost(restoreRuns(runs, snapshots), lost, snapshots, LOST_AT)
  const run = restored['run-1']
  assert.deepEqual([run.status, run.finishedAt, run.error, run.streaming], ['interrupted', LOST_AT, LOST_RUN_ERROR, undefined])
  assert.deepEqual(run.agents.map(item => [item.id, item.status, item.finishedAt]), [['root', 'cancelled', LOST_AT], ['agent-a', 'cancelled', LOST_AT], ['agent-b', 'done', AT]])
  assert.equal(isActiveStatus(run.status), false, 'nothing holds its chat any more')
  assert.equal(restored['run-saved'].status, 'interrupted', 'a lost run the list has follows the list')
  assert.equal(restored['run-new'].status, 'working', "the new process's run is not touched")
  assert.equal(restored['run-done'].status, 'completed')
  // Nothing to end: the same map, so React keeps its state.
  const settled = restoreRuns(runs, snapshots)
  assert.equal(interruptLost(settled, [], snapshots), settled)
  assert.equal(interruptLost(restored, lost, snapshots, AT), restored, 'a run already ended is left as it is')
  assert.equal(interruptLost(settled, ['unknown'], snapshots), settled)
})

test('a paused agent counts as alive: a run that ends cancels it like a working one', () => {
  assert.equal(isActiveStatus('paused'), true)
  const LOST_AT = '2026-09-30T10:05:00.000Z'
  const runs = fold(applyRunEvent, [ev('run.started', { prompt: 'p', workspace: 'w' }), ev('agent.created', { agent: agent('root', { status: 'working' }) }),
    ev('agent.created', { agent: agent('agent-a', { status: 'paused', paused: true, parentId: 'root' }) })])
  assert.equal(runs['run-1'].status, 'working', 'a paused agent does not end or pause the run')
  const ended = interruptLost(runs, ['run-1'], [], LOST_AT)['run-1']
  assert.deepEqual(ended.agents.map(item => [item.id, item.status, item.finishedAt]), [['root', 'cancelled', LOST_AT], ['agent-a', 'cancelled', LOST_AT]])
})

test('pauseHolder finds the agent whose own pause holds another one; shownStatus shows an own pause before the gate', () => {
  const root = { id: 'root', name: 'Orbit', status: 'working' }
  const lead = { id: 'lead', name: 'Lead', status: 'paused', parentId: 'root', paused: true }
  const helper = { id: 'helper', name: 'Helper', status: 'paused', parentId: 'lead' }
  const free = { id: 'free', name: 'Free', status: 'working', parentId: 'root' }
  const agents = [root, lead, helper, free]
  assert.equal(pauseHolder(agents, helper), lead, 'held by the nearest paused ancestor')
  assert.equal(pauseHolder(agents, lead), lead, 'its own pause')
  assert.equal(pauseHolder(agents, free), null)
  assert.equal(pauseHolder([{ id: 'a', name: 'A', status: 'working', parentId: 'b' }, { id: 'b', name: 'B', status: 'working', parentId: 'a' }], { id: 'a', name: 'A', status: 'working', parentId: 'b' }), null, 'a parent cycle ends')
  assert.equal(shownStatus({ ...lead, status: 'working' }), 'paused', 'the flag shows before the turn reaches the gate')
  assert.equal(shownStatus(free), 'working')
  assert.equal(shownStatus({ id: 'x', name: 'X', status: 'cancelled', paused: true }), 'cancelled', 'a finished agent keeps its end status')
})

test('actionCount sums native and Orbit tool calls over all turns', () => {
  assert.equal(actionCount(undefined), 0)
  assert.equal(actionCount({ id: 'a', name: 'A', status: 'working' }), 0)
  assert.equal(actionCount({ id: 'a', name: 'A', status: 'working', turnTimings: [{ turn: 1, nativeToolCalls: 75, orbitToolCalls: 41 }, { turn: 2, orbitToolCalls: 2 }, { turn: 3 }] }), 118)
})

test('message.streaming keeps the root answer in progress on the run; message.added with the same id replaces it', () => {
  let runs = fold(applyRunEvent, [ev('run.started', { prompt: 'p', workspace: 'w' }), ev('agent.created', { agent: agent('root') })])
  runs = applyRunEvent(runs, ev('message.streaming', { agentId: 'root', messageId: 'm1', content: 'Смотрю' }), '2026-09-29T10:01:00.000Z')
  assert.deepEqual(runs['run-1'].streaming, { messageId: 'm1', agentId: 'root', content: 'Смотрю', startedAt: '2026-09-29T10:01:00.000Z', updatedAt: '2026-09-29T10:01:00.000Z' })
  runs = applyRunEvent(runs, ev('message.streaming', { messageId: 'm1', content: 'Смотрю проект…' }), '2026-09-29T10:01:01.000Z')
  assert.equal(runs['run-1'].streaming.content, 'Смотрю проект…')
  assert.equal(runs['run-1'].streaming.startedAt, '2026-09-29T10:01:00.000Z', 'the stub keeps the time of its first chunk')
  assert.equal(runs['run-1'].streaming.updatedAt, '2026-09-29T10:01:01.000Z')
  assert.equal(runs['run-1'].messages.length, 0, 'a streaming chunk is not a message')
  // A new answer id starts a new stub.
  runs = applyRunEvent(runs, ev('message.streaming', { messageId: 'm2', content: 'Итог:' }), '2026-09-29T10:02:00.000Z')
  assert.deepEqual([runs['run-1'].streaming.messageId, runs['run-1'].streaming.startedAt], ['m2', '2026-09-29T10:02:00.000Z'])
  runs = applyRunEvent(runs, ev('message.added', { message: { id: 'm2', agentId: 'root', author: 'orbit', text: 'Итог: всё в порядке.', time: AT } }), AT)
  assert.equal(runs['run-1'].streaming, undefined)
  assert.deepEqual(runs['run-1'].messages.map(message => message.id), ['m2'])
  // Malformed chunks change nothing.
  const before = runs
  assert.equal(applyRunEvent(runs, ev('message.streaming', { messageId: 'm3' }))['run-1'].streaming, undefined)
  assert.equal(applyRunEvent(runs, ev('message.streaming', { content: 'no id' }))['run-1'].streaming, undefined)
  assert.equal(before, runs)
})

test('streaming from a helper is ignored, a helper answer keeps the root stub, and no stub survives the end of a run', () => {
  const start = [ev('run.started', { prompt: 'p', workspace: 'w' }), ev('agent.created', { agent: agent('root') }), ev('agent.created', { agent: agent('agent-a') })]
  let runs = fold(applyRunEvent, [...start, ev('message.streaming', { agentId: 'agent-a', messageId: 'h1', content: 'helper text' })])
  assert.equal(runs['run-1'].streaming, undefined)
  runs = fold(applyRunEvent, [...start, ev('message.streaming', { agentId: 'root', messageId: 'm1', content: 'root text' }), ev('message.added', { message: { id: 'h1', agentId: 'agent-a', author: 'orbit', text: 'helper answer', time: AT } })])
  assert.equal(runs['run-1'].streaming.content, 'root text', 'a helper answer does not end the root stub')
  for (const terminal of [ev('run.finished', { status: 'completed' }), ev('run.failed', { error: 'x' }), ev('run.cancelled')]) {
    const ended = applyRunEvent(runs, terminal)
    assert.equal(ended['run-1'].streaming, undefined, terminal.type)
    assert.equal(applyRunEvent(ended, ev('message.streaming', { messageId: 'late', content: 'late chunk' }))['run-1'].streaming, undefined, `${terminal.type}: a late chunk is dropped`)
  }
})

test('restoreRuns keeps a stub only for a run that is still active, and never takes one from the saved list', () => {
  const live = fold(applyRunEvent, [ev('run.started', { prompt: 'p', workspace: 'w' }), ev('message.streaming', { messageId: 'm1', content: 'typing' })])
  const saved = { ...syntheticRun(), status: 'working', finishedAt: undefined }
  assert.equal(restoreRuns(live, [saved])['run-1'].streaming.content, 'typing')
  assert.equal(restoreRuns(live, [{ ...saved, status: 'completed' }])['run-1'].streaming, undefined, 'the run ended meanwhile')
  assert.equal(restoreRuns({}, [{ ...saved, streaming: { messageId: 'x', agentId: 'root', content: 'stale', startedAt: AT, updatedAt: AT } }])['run-1'].streaming, undefined, 'a stub written into a run file is not restored')
  assert.equal(restoreRuns({}, [{ ...saved, status: 'interrupted', streaming: { messageId: 'x', agentId: 'root', content: 'stale', startedAt: AT, updatedAt: AT } }])['run-1'].streaming, undefined)
})

test('runNotices lists helper spawn, end, failure and handover in time order; the root is left to the chat', () => {
  const run = syntheticRun()
  const notices = runNotices(run, target => `${target.providerId}/${target.model}`)
  assert.deepEqual(notices.map(notice => [notice.kind, notice.agentId]), [['spawned', 'agent-a'], ['spawned', 'agent-b'], ['handover', 'agent-b'], ['error', 'agent-b'], ['done', 'agent-a']])
  assert.equal(notices[0].time, '2026-09-29T09:00:50.000Z', 'spawn time comes from the spawn communication')
  assert.match(notices[0].text, /Подключён помощник «Проверка»: Проверь тесты/)
  assert.equal(notices[2].text, '«Сборка» перешёл на другую подписку: codex/gpt → claude/sonnet')
  assert.equal(notices[3].text, '«Сборка» завершился с ошибкой: exit code 1')
  assert.equal(notices[4].text, '«Проверка» завершил работу')
  assert.ok(new Set(notices.map(notice => notice.id)).size === notices.length, 'ids are unique')
  // A live run with a helper that is still waiting: one notice, timed by the spawn message; without one, by the run start.
  const waiting = { ...run, status: 'working', agents: [run.agents[0], agent('agent-c', { name: 'Ожидание' })], communications: [] }
  assert.deepEqual(runNotices(waiting).map(notice => [notice.kind, notice.time]), [['spawned', run.startedAt]])
  assert.deepEqual(runNotices(undefined), [])
  assert.deepEqual(runNotices({ ...run, agents: [run.agents[0]] }), [], 'the root alone produces no notice')
})

test('openTurn, durationMs and formatDuration', () => {
  const timings = [{ turn: 1, transport: 'session', startedAt: '2026-09-29T09:00:00.000Z', endedAt: '2026-09-29T09:01:30.000Z' }, { turn: 2, transport: 'session', startedAt: '2026-09-29T09:02:00.000Z', endedAt: null }]
  assert.equal(openTurn({ id: 'root', name: 'r', status: 'working', turnTimings: timings }).turn, 2)
  assert.equal(openTurn({ id: 'root', name: 'r', status: 'done', turnTimings: [timings[0]] }), undefined)
  assert.equal(openTurn(undefined), undefined)
  assert.equal(durationMs(timings[0].startedAt, timings[0].endedAt), 90000)
  assert.equal(durationMs(timings[1].startedAt, null, Date.parse('2026-09-29T09:02:05.000Z')), 5000)
  assert.equal(durationMs('not a date', null), null)
  assert.equal(durationMs(timings[0].endedAt, timings[0].startedAt), null, 'an end before the start is not a duration')
  assert.equal(formatDuration(5000), '5 с')
  assert.equal(formatDuration(90000), '1 мин 30 с')
  assert.equal(formatDuration(3_720_000), '1 ч 2 мин')
  assert.equal(snapshotBase({ runId: 'r', projectId: 'p', chatId: 'c' }, AT).startedAt, AT)
})

test('thinkingText: «думает» with the rounded estimate of the thinking block, nothing when the model does not think', () => {
  assert.equal(thinkingText(undefined), '')
  assert.equal(thinkingText(null), '')
  assert.equal(thinkingText(Number.NaN), '')
  assert.equal(thinkingText(0), 'думает', 'a thinking block without an estimate yet')
  assert.equal(thinkingText(50), 'думает · ~50 токенов')
  assert.equal(thinkingText(219), 'думает · ~220 токенов')
  assert.equal(thinkingText(996), 'думает · ~1 тыс. токенов', 'a figure that rounds to a thousand is written in thousands')
  assert.equal(thinkingText(4240), 'думает · ~4,2 тыс. токенов')
  assert.equal(thinkingText(9960), 'думает · ~10 тыс. токенов')
  assert.equal(thinkingText(18_400), 'думает · ~18 тыс. токенов')
})

// Tokens as the window writes them: short counts with the Russian decimal comma, exact figures in the tooltip.
const plainSpaces = text => text.replace(/[  ]/g, ' ')
test('tokenCount: short counts with a decimal comma, in thousands, millions and billions', () => {
  assert.deepEqual([0, 7, 850, 999].map(tokenCount), ['0', '7', '850', '999'])
  assert.deepEqual([1000, 1234, 9949, 9950, 48_000, 999_499].map(tokenCount), ['1 тыс.', '1,2 тыс.', '9,9 тыс.', '10 тыс.', '48 тыс.', '999 тыс.'])
  assert.deepEqual([999_500, 1_198_000, 1_150_000, 12_345_678, 250_000_000].map(tokenCount), ['1 млн', '1,2 млн', '1,2 млн', '12 млн', '250 млн'])
  assert.deepEqual([1_200_000_000, 3_456_000_000].map(tokenCount), ['1,2 млрд', '3,5 млрд'])
  assert.equal(tokenCount(-5), '0')
})

test('usage views: an agent counts input plus output, the run is the sum of its agents, nothing without figures', () => {
  const usage = { inputTokens: 1_150_000, outputTokens: 48_000, cachedInputTokens: 1_020_000 }
  assert.equal(agentTokens({ id: 'a', name: 'A', status: 'done', usage }), 1_198_000)
  assert.equal(agentTokens({ id: 'a', name: 'A', status: 'done', usage: null }), undefined)
  assert.equal(agentTokens({ id: 'a', name: 'A', status: 'done', usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } }), undefined, 'a zero is not shown')
  assert.equal(agentTokens({ id: 'a', name: 'A', status: 'done' }), undefined)
  assert.equal(agentTokens(undefined), undefined)
  assert.equal(plainSpaces(usageTitle(usage)), 'Вход 1 150 000 (из кэша 1 020 000) · выход 48 000')
  assert.equal(plainSpaces(usageTitle({ inputTokens: 500, outputTokens: 20, cachedInputTokens: 0 })), 'Вход 500 · выход 20', 'no cached part to name')
  assert.equal(usageTitle(null), '')
  assert.equal(usageBreakdown(usage), 'вход 1,2 млн (из кэша 1 млн) · выход 48 тыс.')
  const agents = [{ id: 'a', name: 'A', status: 'done', usage }, { id: 'b', name: 'B', status: 'working', usage: null }, { id: 'c', name: 'C', status: 'working', usage: { inputTokens: 850_000, outputTokens: 2000, cachedInputTokens: 0 } }]
  assert.deepEqual(runUsage(agents), { inputTokens: 2_000_000, outputTokens: 50_000, cachedInputTokens: 1_020_000 })
  assert.equal(runUsage([agents[1]]), null)
  assert.equal(runUsage([]), null)
})

test('an agent update carries the tokens onto the run, replacing the earlier count, and a saved run keeps them', () => {
  const base = { runId: 'r', projectId: 'p', chatId: 'c' }
  let runs = applyRunEvent({}, { ...base, type: 'agent.created', agent: { id: 'root', name: 'Orbit', status: 'working', usage: null } }, AT)
  assert.equal(runs.r.agents[0].usage, null)
  runs = applyRunEvent(runs, { ...base, type: 'agent.updated', agent: { id: 'root', name: 'Orbit', status: 'working', usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50 } } }, AT)
  runs = applyRunEvent(runs, { ...base, type: 'agent.updated', agent: { id: 'root', name: 'Orbit', status: 'working', usage: { inputTokens: 300, outputTokens: 30, cachedInputTokens: 150 } } }, AT)
  assert.deepEqual(runs.r.agents[0].usage, { inputTokens: 300, outputTokens: 30, cachedInputTokens: 150 })
  runs = applyRunEvent(runs, { ...base, type: 'run.info', usage: { providerTurns: 1, workerTurns: 0, inputTokens: 300, outputTokens: 30, cachedInputTokens: 150 } }, AT)
  assert.equal(runs.r.usage.inputTokens, 300)
  const restored = restoreRuns({}, [{ ...runs.r, agents: [{ id: 'root', name: 'Orbit', status: 'done', usage: { inputTokens: 900, outputTokens: 90, cachedInputTokens: 450 } }] }])
  assert.deepEqual(agentTokens(restored.r.agents[0]), 990)
})

test('run.started and run.info carry the loop task and the plan handoff onto the run', () => {
  const base = { runId: 'r', projectId: 'p', chatId: 'c' }
  let runs = applyRunEvent({}, { ...base, type: 'run.started', loopTask: 4, improvements: [{ id: '1', title: 't', status: 'pending', evidence: '' }], improvementStatus: 'implementing' }, AT)
  assert.equal(runs.r.loopTask, 4)
  assert.equal(runs.r.improvementHandoff, undefined)
  runs = applyRunEvent(runs, { ...base, type: 'run.info', improvementHandoff: 'next: check the tests', improvementStatus: 'completed' }, AT)
  assert.equal(runs.r.improvementHandoff, 'next: check the tests')
  assert.equal(runs.r.loopTask, 4, 'kept by events without it')
  assert.equal(runs.r.improvementStatus, 'completed')
})

test('historyAnchors hangs a loop task run that never answered under its loop note', () => {
  const runs = { r: { runId: 'r', projectId: 'p', chatId: 'c', status: 'failed', agents: [], traces: [], messages: [], communications: [], startedAt: AT } }
  const messages = [{ id: 'loop-r', author: 'system', kind: 'loop', runId: 'r', text: '∞ Задача 2', time: AT }]
  assert.equal(historyAnchors(messages, runs).get('r'), 'loop-r')
})
