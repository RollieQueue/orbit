import type { Agent, AgentStatus, Handover, RunRestart, RunSnapshot } from './types'

// A run as a Gantt chart (src/RunTimeline.tsx draws it): one row per agent, one bar per provider turn, the time axis, markers
// and the numbers about parallelism. Pure: only type imports (tests/run-timeline.test.cjs loads this file on its own), the
// clock is a parameter. Times are epoch milliseconds; records with a missing or unreadable time are skipped, never guessed.

// The state a bar is drawn in: an open turn takes the agent's own state, a finished turn is `done`, and the agent's last turn
// takes the way the agent ended (error, cancelled, interrupted, restarting).
export type BarState = 'working' | 'waiting' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'restarting'
export type TimelineBar = {
  start: number
  // An open turn ends at the axis end (now) and `open` is true.
  end: number
  // The provider turn's number (it repeats after a subscription change); 0 for an estimated bar.
  turn: number
  state: BarState
  // The turn has no end yet and its agent is alive: the bar grows with the clock.
  open: boolean
  // The turn never reported its end although the run is over (the process died): drawn up to where the record stops.
  cut: boolean
  // The agent has no turn timings (an older record): one bar from its start to its finish, without the turn split.
  estimated: boolean
  nativeToolCalls: number
  orbitToolCalls: number
}
export type TimelineRow = {
  agentId: string
  name: string
  // Only a parent that is in the run; an agent whose parent is missing stands at the top level.
  parentId: string | null
  depth: number
  isRoot: boolean
  // The status to show (the user's own pause reads as paused at once).
  status: AgentStatus
  providerId: string | null
  model: string
  // When the helper was created (the spawn message, else its first turn); null for the root.
  spawnedAt: number | null
  // Created but not yet working: from creation to its first turn, or to the axis end while it has no turn at all.
  queue: { start: number; end: number } | null
  bars: TimelineBar[]
  // How long the agent worked: the bars without their overlaps.
  workMs: number
  // Tool calls of all its turns (the CLI's own plus Orbit's).
  actions: number
}
export type TimelineMarker = {
  // spawned: on the parent's row, when it created the helper. finished: on the helper's row, when it ended. handover: a change
  // of subscription of the agent. restart: the whole chart, when an agent asked Orbit to restart.
  kind: 'spawned' | 'finished' | 'handover' | 'restart'
  at: number
  // The row the marker sits on; null = the whole chart.
  rowId: string | null
  // Whom it is about (the helper for spawned and finished).
  agentId: string | null
  state?: BarState
  handover?: Handover
  restart?: RunRestart
}
// How many helpers (every agent but the root) had a turn running over a stretch of time. The stretches cover the whole axis
// without gaps, neighbours with the same count are merged.
export type ConcurrencySegment = { start: number; end: number; helpers: number }
export type TimelineSummary = {
  // The axis length.
  wallMs: number
  // Time with two or more helpers working at once / with no helper working (the root alone, or nobody).
  parallelMs: number
  noHelperMs: number
  maxHelpers: number
  // Working time of the root, and of all helpers added up (their overlaps count: it is agent time, not wall time).
  rootMs: number
  helpersMs: number
  // rootMs / (rootMs + helpersMs), 0..1; 0 while nothing has worked.
  rootShare: number
}
export type RunTimeline = {
  start: number
  end: number
  // The run is still going: `end` is the clock.
  live: boolean
  rows: TimelineRow[]
  markers: TimelineMarker[]
  concurrency: ConcurrencySegment[]
  summary: TimelineSummary
}

const ms = (time?: string | null): number | null => {
  const value = Date.parse(time || '')
  return Number.isNaN(value) ? null : value
}
const isActive = (status?: string) => status === 'working' || status === 'waiting' || status === 'paused'
const ENDED: readonly string[] = ['error', 'cancelled', 'interrupted', 'restarting']
const shown = (agent: Agent): AgentStatus => agent.paused && isActive(agent.status) ? 'paused' : agent.status
const LIVE_STATES: readonly string[] = ['working', 'waiting', 'paused']
// A run ended by an Orbit restart keeps its agents as 'cancelled'; on the chart they read as stopped by the restart, unless the
// user stopped them.
const endStatus = (run: RunSnapshot, agent: Agent): AgentStatus => run.status === 'restarting' && agent.status === 'cancelled' && !agent.stoppedByUser ? 'restarting' : agent.status

// Overlapping or touching stretches joined into one, in time order.
function merged(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}
const lengthOf = (spans: [number, number][]) => spans.reduce((sum, [from, to]) => sum + (to - from), 0)

// The agents of a run in drawing order, each parent followed by its helpers in the order they were created. The root comes
// first; an agent whose parent is missing counts as a top-level one; a broken parent loop cannot hang it.
function drawingOrder(agents: Agent[], spawnedAt: Map<string, number | null>): { agent: Agent; depth: number; parentId: string | null }[] {
  const ids = new Set(agents.map(agent => agent.id))
  const index = new Map(agents.map((agent, position): [string, number] => [agent.id, position]))
  const parentOf = (agent: Agent) => agent.parentId && agent.parentId !== agent.id && ids.has(agent.parentId) ? agent.parentId : null
  const earlier = (a: Agent, b: Agent) => (spawnedAt.get(a.id) ?? Infinity) - (spawnedAt.get(b.id) ?? Infinity) || index.get(a.id)! - index.get(b.id)!
  const out: { agent: Agent; depth: number; parentId: string | null }[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | null, depth: number) => {
    const children = agents.filter(agent => parentOf(agent) === parentId && !seen.has(agent.id))
      .sort((a, b) => parentId === null ? (+(b.id === 'root') - +(a.id === 'root')) || earlier(a, b) : earlier(a, b))
    for (const agent of children) {
      if (seen.has(agent.id)) continue
      seen.add(agent.id)
      out.push({ agent, depth, parentId })
      visit(agent.id, depth + 1)
    }
  }
  visit(null, 0)
  for (const agent of agents) if (!seen.has(agent.id)) { seen.add(agent.id); out.push({ agent, depth: 0, parentId: null }); visit(agent.id, 1) }
  return out
}

function concurrencyOf(spans: [number, number][][], start: number, end: number): ConcurrencySegment[] {
  const edges: [number, number][] = []
  for (const list of spans) for (const [from, to] of list) if (to > from) edges.push([from, 1], [to, -1])
  // Edges at one instant leave no stretch between them, so their order does not matter: back-to-back turns are no overlap.
  edges.sort((a, b) => a[0] - b[0])
  const segments: ConcurrencySegment[] = []
  const add = (from: number, to: number, helpers: number) => {
    const last = segments[segments.length - 1]
    if (last && last.helpers === helpers) last.end = to
    else segments.push({ start: from, end: to, helpers })
  }
  let at = start, count = 0
  for (const [time, delta] of edges) {
    const edge = Math.min(Math.max(time, start), end)
    if (edge > at) { add(at, edge, count); at = edge }
    count += delta
  }
  if (end > at) add(at, end, count)
  return segments
}

// Builds the chart's data from a run record (live or saved). `now` is where open turns end while the run works.
export function buildRunTimeline(run: RunSnapshot, now: number = Date.now()): RunTimeline {
  const agents = run.agents || []
  const live = isActive(run.status)
  const runStart = ms(run.startedAt)
  // Where the record of an ended run stops: what an unfinished turn is cut at. A run Orbit found still working at its next
  // start was ended then (finishedAt = that start, hours or days after the crash), so the last save is the earlier, truer end.
  const finished = ms(run.finishedAt), saved = ms(run.updatedAt)
  const runStop = finished !== null && saved !== null ? Math.min(finished, saved) : finished ?? saved
  const ids = new Set(agents.map(agent => agent.id))

  const spawnMessage = new Map<string, number>()
  for (const message of run.communications || []) {
    const at = message.kind === 'spawn' ? ms(message.time) : null
    if (at !== null && at < (spawnMessage.get(message.toAgentId) ?? Infinity)) spawnMessage.set(message.toAgentId, at)
  }

  type Draft = { agent: Agent; bars: TimelineBar[]; spawnedAt: number | null }
  const drafts = new Map<string, Draft>()
  for (const agent of agents) {
    const alive = LIVE_STATES.includes(agent.status)
    const closeAt = ms(agent.finishedAt) ?? runStop
    const bars: TimelineBar[] = []
    for (const timing of agent.turnTimings || []) {
      const start = ms(timing.startedAt)
      if (start === null) continue
      const endedAt = ms(timing.endedAt)
      const open = endedAt === null && live && alive
      const cut = endedAt === null && !open
      const end = endedAt !== null ? Math.max(endedAt, start) : open ? Math.max(now, start) : Math.max(closeAt ?? start, start)
      bars.push({
        start, end, turn: timing.turn, state: 'done', open, cut, estimated: false,
        nativeToolCalls: timing.nativeToolCalls ?? 0, orbitToolCalls: timing.orbitToolCalls ?? 0,
      })
    }
    // An older record has no turn timings: the agent's own start and finish are all there is to draw.
    const startedAt = ms(agent.startedAt)
    if (!bars.length && startedAt !== null) {
      const open = !ms(agent.finishedAt) && live && alive
      const end = ms(agent.finishedAt) ?? (open ? now : closeAt ?? startedAt)
      const cut = !open && alive && !ms(agent.finishedAt)
      bars.push({ start: startedAt, end: Math.max(end, startedAt), turn: 0, state: 'done', open, cut, estimated: true, nativeToolCalls: 0, orbitToolCalls: 0 })
    }
    bars.sort((a, b) => a.start - b.start || a.end - b.end)
    const status = shown(agent), ending = endStatus(run, agent)
    bars.forEach((bar, position) => {
      if (bar.open) bar.state = status === 'waiting' || status === 'paused' ? status : 'working'
      else if (position === bars.length - 1 && ENDED.includes(ending)) bar.state = ending as BarState
      else if (bar.cut && ending !== 'done') bar.state = 'interrupted'
    })
    const created = [spawnMessage.get(agent.id) ?? null, bars.length ? bars[0].start : null].filter((time): time is number => time !== null)
    drafts.set(agent.id, { agent, bars, spawnedAt: agent.id === 'root' ? null : created.length ? Math.min(...created) : null })
  }

  const barTimes = [...drafts.values()].flatMap(({ bars, spawnedAt }) => [...bars.flatMap(bar => [bar.start, bar.end]), ...(spawnedAt === null ? [] : [spawnedAt])])
  const known = [...(runStart === null ? [] : [runStart]), ...barTimes]
  const start = known.length ? Math.min(...known) : now
  const stop = live ? now : runStop ?? (barTimes.length ? Math.max(...barTimes) : start)
  const end = Math.max(stop, ...barTimes, start)
  const restartAt = run.restart || run.status === 'restarting' ? ms(run.restart?.requestedAt) ?? runStop ?? end : null

  const order = drawingOrder(agents, new Map([...drafts].map(([id, draft]): [string, number | null] => [id, draft.spawnedAt])))
  const spans = new Map<string, [number, number][]>()
  const rows: TimelineRow[] = order.map(({ agent, depth, parentId }) => {
    const { bars, spawnedAt } = drafts.get(agent.id)!
    const merge = merged(bars.map((bar): [number, number] => [bar.start, bar.end]))
    spans.set(agent.id, merge)
    const firstBar = bars.length ? bars[0].start : null
    const waitsEnd = firstBar ?? (LIVE_STATES.includes(agent.status) && live ? end : null)
    // An estimated bar of an agent that was given a follow-up starts at the follow-up (its own start was reset), not at its first turn.
    const restarted = bars.length > 0 && bars[0].estimated && (agent.generation ?? 0) > 0
    return {
      agentId: agent.id, name: agent.name || agent.id, parentId, depth, isRoot: agent.id === 'root', status: endStatus(run, agent) === 'restarting' ? 'restarting' : shown(agent),
      providerId: agent.providerId ?? null, model: agent.model || '', spawnedAt,
      queue: spawnedAt !== null && waitsEnd !== null && waitsEnd > spawnedAt && !restarted ? { start: spawnedAt, end: waitsEnd } : null,
      bars, workMs: lengthOf(merge), actions: bars.reduce((sum, bar) => sum + bar.nativeToolCalls + bar.orbitToolCalls, 0),
    }
  })

  const markers: TimelineMarker[] = []
  for (const row of rows) {
    const { agent, bars } = drafts.get(row.agentId)!
    if (!row.isRoot) {
      const rowId = row.parentId ?? (ids.has('root') ? 'root' : null)
      if (row.spawnedAt !== null) markers.push({ kind: 'spawned', at: row.spawnedAt, rowId, agentId: row.agentId })
      const ending = endStatus(run, agent)
      const finishedAt = ENDED.includes(ending) || ending === 'done' ? ms(agent.finishedAt) ?? (bars.length ? bars[bars.length - 1].end : null) : null
      if (finishedAt !== null) markers.push({ kind: 'finished', at: finishedAt, rowId: row.agentId, agentId: row.agentId, state: ending as BarState })
    }
    for (const handover of agent.handovers || []) {
      const at = ms(handover.time)
      if (at !== null) markers.push({ kind: 'handover', at, rowId: row.agentId, agentId: row.agentId, handover })
    }
  }
  if (restartAt !== null) markers.push({ kind: 'restart', at: restartAt, rowId: null, agentId: null, restart: run.restart })
  markers.sort((a, b) => a.at - b.at)

  const helperSpans = rows.filter(row => !row.isRoot).map(row => spans.get(row.agentId)!)
  const concurrency = concurrencyOf(helperSpans, start, end)
  const sumWhere = (test: (helpers: number) => boolean) => concurrency.reduce((sum, part) => test(part.helpers) ? sum + (part.end - part.start) : sum, 0)
  const rootMs = rows.filter(row => row.isRoot).reduce((sum, row) => sum + row.workMs, 0)
  const helpersMs = rows.filter(row => !row.isRoot).reduce((sum, row) => sum + row.workMs, 0)
  return {
    start, end, live, rows, markers, concurrency,
    summary: {
      wallMs: end - start, parallelMs: sumWhere(helpers => helpers >= 2), noHelperMs: sumWhere(helpers => helpers === 0),
      maxHelpers: concurrency.reduce((most, part) => Math.max(most, part.helpers), 0),
      rootMs, helpersMs, rootShare: rootMs + helpersMs > 0 ? rootMs / (rootMs + helpersMs) : 0,
    },
  }
}

// Offsets (ms from the axis start, the first is 0) of the axis labels: the smallest round step — seconds, minutes, hours —
// that keeps them within `maxTicks`.
const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE
const TICK_STEPS = [1, 2, 5, 10, 15, 30].map(n => n * SECOND).concat([1, 2, 5, 10, 15, 20, 30].map(n => n * MINUTE), [1, 2, 3, 6, 12, 24].map(n => n * HOUR))
export function tickOffsets(spanMs: number, maxTicks: number): number[] {
  if (!(spanMs > 0) || !(maxTicks >= 2)) return [0]
  const step = TICK_STEPS.find(candidate => Math.floor(spanMs / candidate) + 1 <= maxTicks)
    ?? Math.ceil(spanMs / (maxTicks - 1) / (24 * HOUR)) * 24 * HOUR
  const offsets: number[] = []
  for (let offset = 0; offset <= spanMs; offset += step) offsets.push(offset)
  return offsets
}
