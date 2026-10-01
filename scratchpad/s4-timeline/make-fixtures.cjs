'use strict'
// Fixtures for the run-timeline screenshot harness. Run: node scratchpad/s4-timeline/make-fixtures.cjs [--refresh-live]
//   e765, restart, live  - trimmed copies of REAL saved runs (%APPDATA%\orbit-ide\run-history\<runId>.json, read-only). live.json is
//                          the run that was working when it was first snapshotted; it is kept as it is (the run changes while it
//                          works, and one day it ends) unless --refresh-live is given. The harness shifts its clock (main.tsx).
//   restart-long         - the real restart run with a 1000-character reason (the longest one Orbit accepts).
//   synthetic            - built here: one live run that shows every state and colour of the chart.
//   synthetic-restart    - the same run ended by a restart_orbit restart (the restart marker, `restarting` bars, a cut turn).
//   synthetic-solo / -empty - live edge cases: the root alone with one open turn; a run that has just been created (no turns at all).
// Only what the chart draws is kept: no prompts, replies, traces or message texts.
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, 'fixtures')
const HISTORY = path.join(process.env.APPDATA || '', 'orbit-ide', 'run-history')
const REAL = { e765: 'e765fbc0', restart: '4cbc9c41', live: '9ce70454' }
const refreshLive = process.argv.includes('--refresh-live')

const pick = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
const AGENT_KEYS = ['id', 'parentId', 'depth', 'name', 'role', 'status', 'providerId', 'model', 'startedAt', 'finishedAt', 'turns', 'generation', 'paused', 'pausedAt', 'stoppedByUser']
const TIMING_KEYS = ['turn', 'transport', 'startedAt', 'firstEventAt', 'endedAt', 'promptChars', 'nativeToolCalls', 'orbitToolCalls', 'thinking']
const HANDOVER_KEYS = ['id', 'time', 'reason', 'from', 'to', 'fresh', 'interrupted', 'usedPercent', 'resetsAt', 'turn']
const SPAWN_KEYS = ['id', 'kind', 'fromAgentId', 'toAgentId', 'fromAgentName', 'toAgentName', 'time', 'status', 'delivery']
const NEUTRAL_PROMPT = 'Пример запуска'

function trimAgent(agent) {
  const out = pick(agent, AGENT_KEYS)
  // The root's task is the user's own message and a helper's task is the orchestrator's brief (it can name local paths): both are replaced.
  out.task = agent.id === 'root' ? NEUTRAL_PROMPT : 'Задача помощника'
  if (agent.handovers) out.handovers = agent.handovers.map(item => pick(item, HANDOVER_KEYS))
  // An older record has no turn timings: keep it that way, the chart draws such an agent from its start and finish.
  if (agent.turnTimings) out.turnTimings = agent.turnTimings.map(timing => pick(timing, TIMING_KEYS))
  return out
}
function trimRun(raw) {
  const out = pick(raw, ['runId', 'projectId', 'chatId', 'status', 'startedAt', 'finishedAt', 'updatedAt', 'resumedFrom', 'providerId', 'model'])
  if (raw.restart) out.restart = pick(raw.restart, ['reason', 'requestedAt', 'source'])
  return {
    ...out, workspace: '.', prompt: NEUTRAL_PROMPT,
    agents: (raw.agents || []).map(trimAgent),
    communications: (raw.communications || []).filter(item => item.kind === 'spawn').map(item => ({ ...pick(item, SPAWN_KEYS), text: '' })),
    traces: [], messages: [],
  }
}

const sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
function readRun(prefix) {
  const file = fs.readdirSync(HISTORY).find(name => name.startsWith(prefix) && name.endsWith('.json'))
  if (!file) throw new Error(`no saved run starts with ${prefix} in ${HISTORY}`)
  // A running run is rewritten all the time: a read that meets a half-written file simply reads again.
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(fs.readFileSync(path.join(HISTORY, file), 'utf8')) } catch (error) {
      if (attempt >= 8) throw error
      sleep(250)
    }
  }
}

// ---- the synthetic run: every state, colour and marker of the chart in one run (minutes from the run's start) ----
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const at = minutes => new Date(T0 + Math.round(minutes * 60000)).toISOString()
// [start, end (null = still running), CLI tool calls, Orbit tool calls, turn number (default: its position)]
const timing = ([from, to, native = 0, orbit = 0, turn], index) => ({
  turn: turn ?? index + 1, transport: 'session', startedAt: at(from), firstEventAt: at(from + 0.1), endedAt: to === null ? null : at(to),
  promptChars: 9000 + 1500 * index, nativeToolCalls: native, orbitToolCalls: orbit,
})
const HANDOVER = {
  id: 'handover-1', time: at(26.6), reason: 'exhausted', from: { providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' },
  to: { providerId: 'antigravity', model: 'gemini-3.1-pro-high', reasoningEffort: '' }, fresh: false, interrupted: true, usedPercent: 100, resetsAt: null, turn: 0,
}
const SPECS = [
  { id: 'root', name: 'Orbit', parent: null, status: 'waiting', provider: 'claude', model: 'opus', turns: [[0.1, 12, 61, 9], [20, 21.5, 8, 3], [34, null, 14, 2]] },
  { id: 'h-done', name: 'implement-tokens', status: 'done', provider: 'claude', model: 'claude-sonnet-5-5', spawn: 3, turns: [[3.05, 16.7, 52, 1]], finished: 16.7 },
  { id: 'h-error', name: 'fix-flaky-test', status: 'error', provider: 'codex', model: 'gpt-6-astra', spawn: 4.2, turns: [[4.25, 9.75, 33, 0], [10.3, 11.1, 4, 0]], finished: 11.1 },
  { id: 'h-cancelled', name: 'review-docs', status: 'cancelled', stoppedByUser: true, provider: 'antigravity', model: 'gemini-3.1-pro-high', spawn: 6, turns: [[6.05, 15.5, 40, 2]], finished: 15.5 },
  { id: 'h-queued', name: 'queued-lint-check', status: 'waiting', provider: 'codex', model: 'gpt-6-luna', spawn: 36, turns: [] },
  { id: 'h-paused', name: 'migrate-settings', status: 'paused', paused: true, pausedAt: at(30), provider: 'claude', model: 'claude-sonnet-5-5', spawn: 8, turns: [[8.05, 19, 21, 2], [27, null, 3, 0]] },
  { id: 'h-legacy', name: 'legacy-record', status: 'done', provider: 'codex', model: 'gpt-6-luna', spawn: 2.3, legacy: [2.33, 8.5] },
  { id: 'h-nest', name: 'orchestrate-refactor', status: 'working', provider: 'claude', model: 'claude-opus-5-5', spawn: 12.5, turns: [[12.55, 22.2, 30, 8], [30.2, 33, 6, 1], [38, null, 9, 2]] },
  { id: 'h-nest-sub', name: 'refactor-store', parent: 'h-nest', status: 'done', provider: 'claude', model: 'claude-sonnet-5-5', spawn: 13, turns: [[13.05, 24, 61, 0]], finished: 24 },
  { id: 'h-nest-subsub', name: 'refactor-store-tests', parent: 'h-nest-sub', status: 'done', provider: 'codex', model: 'gpt-6-luna', spawn: 15, turns: [[15.05, 21.8, 18, 0]], finished: 21.8 },
  { id: 'h-long', name: 'review-isolation-of-the-parallel-helpers-and-merge-back', status: 'done', provider: 'claude', model: 'claude-opus-5-5', spawn: 21, turns: [[21.05, 29.7, 44, 3]], finished: 29.7 },
  { id: 'h-handover', name: 'tests-for-timeline', status: 'done', provider: 'antigravity', model: 'gemini-3.1-pro-high', spawn: 23, turns: [[23.05, 26.5, 20, 1, 1], [26.67, 35.2, 41, 1, 1]], finished: 35.2, handovers: [HANDOVER] },
  { id: 'h-live', name: 'live-worker', status: 'working', provider: 'claude', model: 'claude-sonnet-5-5', spawn: 28, turns: [[28.05, 31, 22, 1], [36.5, null, 7, 0]] },
  { id: 'h-crashed', name: 'crashed-helper', status: 'interrupted', provider: 'claude', model: 'claude-sonnet-5-5', spawn: 14, turns: [[14.05, null, 12, 0]], finished: 18 },
]
function buildSyntheticAgent(spec) {
  const parentId = spec.id === 'root' ? null : spec.parent ?? 'root'
  const timings = (spec.turns || []).map(timing)
  const startedAt = spec.legacy ? at(spec.legacy[0]) : timings.length ? timings[0].startedAt : undefined
  const finishedAt = spec.legacy ? at(spec.legacy[1]) : spec.finished === undefined ? undefined : at(spec.finished)
  const agent = {
    id: spec.id, parentId, depth: 0, name: spec.name, role: 'Agent', status: spec.status, providerId: spec.provider, model: spec.model,
    task: spec.id === 'root' ? NEUTRAL_PROMPT : `Synthetic helper ${spec.name}`, startedAt, finishedAt,
    turns: spec.legacy ? 1 : timings.length, generation: spec.handovers ? spec.handovers.length : 0,
  }
  if (spec.paused) { agent.paused = true; agent.pausedAt = spec.pausedAt }
  if (spec.stoppedByUser) agent.stoppedByUser = true
  if (spec.handovers) agent.handovers = spec.handovers
  if (!spec.legacy) agent.turnTimings = timings
  return agent
}
function buildSynthetic() {
  const agents = SPECS.map(buildSyntheticAgent)
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  for (const agent of agents) if (agent.parentId) agent.depth = byId.get(agent.parentId).depth + 1
  const communications = [{
    id: 'spawn-user', kind: 'spawn', fromAgentId: 'user', toAgentId: 'root', fromAgentName: 'Вы', toAgentName: 'Orbit', time: at(0),
    status: 'read', delivery: 'mailbox', text: '',
  }]
  for (const spec of SPECS) {
    if (spec.id === 'root') continue
    const parent = byId.get(spec.parent ?? 'root')
    communications.push({
      id: `spawn-${spec.id}`, kind: 'spawn', fromAgentId: parent.id, toAgentId: spec.id, fromAgentName: parent.name, toAgentName: spec.name,
      time: at(spec.spawn), status: 'read', delivery: 'next-turn', text: '',
    })
  }
  return {
    runId: 'synthetic-run', projectId: 'project-local', chatId: 'synthetic-chat', status: 'working', startedAt: at(0), updatedAt: at(42),
    providerId: 'claude', model: 'opus', workspace: '.', prompt: NEUTRAL_PROMPT, agents, communications, traces: [], messages: [],
  }
}
// The same run, ended at minute 40 because the root asked for a restart: its last turn closes as `restarting`, the other open turns
// close as `interrupted` (live-worker's turn never reports its end: a cut bar), the queued helper is cancelled.
function buildSyntheticRestart(run) {
  const copy = JSON.parse(JSON.stringify(run))
  const stop = at(40)
  copy.runId = 'synthetic-restart-run'
  copy.status = 'restarting'
  copy.finishedAt = stop
  copy.updatedAt = stop
  copy.restart = {
    reason: 'Apply S4: the run timeline in the agents panel (view switch, bars per turn, parallelism strip), its tests and docs; Orbit restarts so that the new renderer and the runtime load together.',
    requestedAt: stop, source: 'tool',
  }
  for (const agent of copy.agents) {
    const open = (agent.turnTimings || []).find(timing => !timing.endedAt)
    if (agent.id === 'root') agent.status = 'restarting'
    else if (agent.status === 'waiting' || agent.status === 'working' || agent.status === 'paused') agent.status = open ? 'interrupted' : 'cancelled'
    else continue
    agent.paused = false
    agent.pausedAt = null
    agent.finishedAt = stop
    if (open && agent.id !== 'h-live') open.endedAt = stop
  }
  return copy
}

// Two small edge cases of a live run: the root alone with one open turn (no helpers: no parallelism strip), and a run that has just
// been created (no turn timings anywhere: the chart's empty state).
const userSpawn = { id: 'spawn-user', kind: 'spawn', fromAgentId: 'user', toAgentId: 'root', fromAgentName: 'Вы', toAgentName: 'Orbit', time: at(0), status: 'read', delivery: 'mailbox', text: '' }
const soloRoot = { id: 'root', parentId: null, depth: 0, name: 'Orbit', role: 'Agent', status: 'working', providerId: 'claude', model: 'opus', task: NEUTRAL_PROMPT, startedAt: at(0.1), turns: 1, generation: 0 }
const liveRun = (runId, agents, updatedAt) => ({
  runId, projectId: 'project-local', chatId: 'synthetic-chat', status: 'working', startedAt: at(0), updatedAt, providerId: 'claude', model: 'opus', workspace: '.',
  prompt: NEUTRAL_PROMPT, agents, communications: [userSpawn], traces: [], messages: [],
})
const buildSolo = () => liveRun('synthetic-solo-run', [{ ...soloRoot, turnTimings: [timing([0.1, null, 23, 4], 0)] }], at(3))
const buildEmpty = () => liveRun('synthetic-empty-run', [{ id: 'root', parentId: null, depth: 0, name: 'Orbit', role: 'Agent', status: 'waiting', providerId: 'claude', model: 'opus', task: NEUTRAL_PROMPT }], at(0))

function write(name, run) {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(run, null, 1)}\n`)
  const turns = run.agents.reduce((sum, agent) => sum + (agent.turnTimings || []).length, 0)
  console.log(`${name}.json: ${run.status}, ${run.agents.length} agents, ${turns} turns, ${run.communications.length} spawn messages`)
}
for (const [name, prefix] of Object.entries(REAL)) {
  if (name === 'live' && !refreshLive && fs.existsSync(path.join(OUT, 'live.json'))) { console.log('live.json: kept (pass --refresh-live to snapshot the running run again)'); continue }
  write(name, trimRun(readRun(prefix)))
}
// The longest restart reason Orbit accepts (REASON_CHARS = 1000 in electron/runtime/restart.mts): how its tooltip copes.
const longRestart = trimRun(readRun(REAL.restart))
longRestart.runId = 'restart-long-run'
longRestart.restart.reason = 'Apply the planned change, restart Orbit so that the new renderer and the runtime load together, and go on with the task in the new run under the same plan. '.repeat(7).slice(0, 1000)
write('restart-long', longRestart)
const synthetic = buildSynthetic()
write('synthetic', synthetic)
write('synthetic-restart', buildSyntheticRestart(synthetic))
write('synthetic-solo', buildSolo())
write('synthetic-empty', buildEmpty())
