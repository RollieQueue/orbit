// Where the wall-clock time of a run went, read from the run's own records: how long it took, when the first helper started
// and how long its spawn_agent call took, how many helpers worked at once, how much of the run the root sat in a wait tool,
// how long restart_orbit took, and where the tokens went (the usage Orbit records per agent). Pure functions over a run as the runtime holds it (agents in a Map) or as the run store
// saved it (agents in an array), so one profile serves the run_profile tool, the previous-run paragraph of the improvement
// loop (chat-memory.mts keeps one text per earlier run) and the tests. A run that has not finished is profiled up to `now`,
// a saved one that never finished up to its last save.
import { ellipsis } from '../text.mts'
import { TOOLS } from '../tool-registry.mts'
import { AGENT_TERMINAL, TERMINAL } from './util.mts'

// ---- What a profile reads: the fields a live run and a saved one have in common ---------------------------------------
interface TurnLike { startedAt?: string | null; endedAt?: string | null; nativeToolCalls?: number; orbitToolCalls?: number }
interface ModelLike { providerId?: string; model?: string }
interface ProfileAgent {
  id: string; name?: string; parentId?: string | null; status?: string; providerId?: string; model?: string; reasoningEffort?: string
  startedAt?: string | null; finishedAt?: string | null; turnTimings?: TurnLike[]; handovers?: Array<{ from?: ModelLike; to?: ModelLike }>; isolation?: unknown
  // What the agent used over its whole life (AgentUsage); null or missing when its provider reported none.
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | null
}
interface ProfileTrace { agentId?: string; kind?: string; text?: string; time?: string }
interface ProfileSource {
  runId: string; status?: string; startedAt?: string; finishedAt?: string | null; updatedAt?: string
  agentNodes?: Map<string, ProfileAgent> | null; agents?: ProfileAgent[]
  traces?: ProfileTrace[]; communications?: Array<{ kind?: string; toAgentId?: string; time?: string }>
  restart?: { requestedAt?: string } | null
}

// ---- What a profile says -----------------------------------------------------------------------------------------------
// Times are milliseconds. `startedMs`: when the helper began, counted from the run's start; `workMs`: how long it worked
// (its turns, nearby ones joined); `spawnMs`: how long its spawn_agent call took, from the call to the agent's creation
// (null when the call is not in the traces).
interface HelperProfile { id: string; name: string; kind: string | null; model: string; status: string; startedMs: number | null; workMs: number; spawnMs: number | null; isolated: boolean }
// `waitMs`: the root's time inside wait_agent and wait_message (null without traces to tell it from).
interface RootProfile { turns: number; turnMs: number; waitMs: number | null; waitCalls: number }
// How long the run had no helper, one helper and two or more working, and the most at one time.
interface Parallelism { noneMs: number; oneMs: number; manyMs: number; max: number }
interface SpawnProfile { calls: number; totalMs: number; slowestMs: number }
interface StepTiming { step: string; ms: number }
interface RestartProfile { calls: number; failed: number; totalMs: number; medianMs: number; longestMs: number; applied: boolean; steps: StepTiming[] }
// `open`: the run had not finished; `tracesFromMs`: set when the run's trace history lost its beginning (the waits and
// restarts of that part are not counted).
interface RunProfile {
  runId: string; status: string; open: boolean; startedAt: string; endedAt: string; wallMs: number; tracesFromMs: number | null
  root: RootProfile | null; helpers: HelperProfile[]; firstHelperMs: number | null; parallel: Parallelism
  spawns: SpawnProfile | null; restart: RestartProfile | null; tokens: TokenProfile | null
  tools:{ native: number; orbit: number; rootNative: number; rootOrbit: number }
  hints: string[]
}
// The tokens agents used, from the usage Orbit recorded per agent. `input` is everything the model was sent, the cached part
// (`cached`) included. Every model step re-reads the whole context, so `perStep`, input over `steps` (tool calls plus one per
// turn), is an ESTIMATE of the context an agent carried; null without steps. `sharePct`: its part of the run's input.
// `unknown`: agents whose provider reported no usage (they are not counted as zero). The whole is null when none reported.
interface AgentTokens { id: string; name: string; model: string; effort: string | null; input: number; cached: number; output: number; steps: number; perStep: number | null; sharePct: number }
interface TokenProfile { input: number; cached: number; output: number; agents: AgentTokens[]; unknown: string[]; agentsOmitted?: number }
// What the history of a chat needs to choose the previous run: an earlier run as chat-memory.mts views it.
interface PriorRun { runId: string; status?: string; resumedFrom?: string; profile?: string | null }

type Span = [number, number]
const ROOT = 'root'
const MINUTE = 60_000
// Two turns of one agent this close are one stretch of work: its tool calls run between the turns.
const JOIN_MS = 2 * MINUTE
// The run store keeps this many traces per run (runtime/store.mts): a run that has that many has lost its beginning.
const TRACES_KEPT = 2000
// A run this short without helpers has nothing to teach: the chat history keeps no profile of it.
const TRIVIAL_MS = 90_000
const SHOWN_HELPERS = 8
const SHOWN_TOKEN_AGENTS = 3
const SUMMARY_CHARS = 1200
const SLOW_SPAWN_MS = 8000
const SLOW_SPAWNS_MS = 15_000
const WAIT_TOOLS: ReadonlySet<string> = new Set(TOOLS.filter(tool => tool.waits).map(tool => tool.name))
const CALL_TOOLS: ReadonlySet<string> = new Set([...WAIT_TOOLS, 'spawn_agent', 'restart_orbit'])

const timeOf = (value: unknown): number | null => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null }
// The spans merged where they overlap or lie `join` apart at most.
function union(spans: readonly Span[], join = 0): Span[] {
  const merged: Span[] = []
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && from - last[1] <= join) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}
const lengthOf = (spans: readonly Span[]): number => spans.reduce((total, [from, to]) => total + (to - from), 0)

// ---- Orbit tool calls in the traces ------------------------------------------------------------------------------------
// `start`/`end`: when Orbit began the call and when it answered (null: it had not answered when the record was taken, or the
// run ended first); `args` is the dispatch trace, `result` the observation trace.
interface Call { agentId: string; name: string; start: number; end: number | null; args: string; result: string }
const DISPATCH = /^([a-z_]+) \{/
const RESULT = /^([a-z_]+): /
// Every wait, spawn_agent and restart_orbit call: the dispatch trace ("name {arguments}", written when Orbit starts the call)
// paired with the observation trace ("name: result", written when it ends), first come first served per agent and tool.
// The provider's own stream of a call ("name {…}" ending in a "status=running" line) is not the call and is skipped.
function pairCalls(traces: readonly ProfileTrace[]): Call[] {
  const calls: Call[] = []
  const waiting = new Map<string, Call[]>()
  for (const trace of traces) {
    const at = timeOf(trace.time), text = trace.text ?? ''
    if (at === null || !trace.agentId) continue
    if (trace.kind === 'tool') {
      const name = DISPATCH.exec(text)?.[1]
      if (!name || !CALL_TOOLS.has(name) || /\nstatus=\w+$/.test(text)) continue
      const call: Call = { agentId: trace.agentId, name, start: at, end: null, args: text, result: '' }
      calls.push(call)
      const key = `${trace.agentId}\0${name}`
      waiting.set(key, [...(waiting.get(key) ?? []), call])
    } else if (trace.kind === 'observation') {
      const name = RESULT.exec(text)?.[1]
      const call = name && CALL_TOOLS.has(name) ? waiting.get(`${trace.agentId}\0${name}`)?.shift() : undefined
      if (call) { call.end = at; call.result = text }
    }
  }
  return calls
}

// A list field of a saved record as written by whichever Orbit saved it: entries that are not objects are skipped.
const items = <T,>(value: T[] | undefined | null): T[] => Array.isArray(value) ? value.filter(item => !!item && typeof item === 'object') : []

// ---- Agents ------------------------------------------------------------------------------------------------------------
// When an agent worked: its turns, nearby ones joined, inside the run. A turn still open ends with the agent, or with the
// run when the agent has not finished.
function workSpans(agent: ProfileAgent, start: number, end: number): Span[] {
  const inside = (ms: number): number => Math.min(Math.max(ms, start), end)
  const last = AGENT_TERMINAL.has(agent.status ?? '') ? inside(timeOf(agent.finishedAt) ?? end) : end
  const spans: Span[] = []
  for (const turn of items(agent.turnTimings)) {
    const from = timeOf(turn.startedAt)
    if (from !== null) spans.push([inside(from), Math.max(inside(from), inside(timeOf(turn.endedAt) ?? last))])
  }
  const began = timeOf(agent.startedAt)
  // A record saved before turn timings were kept.
  if (!spans.length && began !== null) spans.push([inside(began), Math.max(inside(began), last)])
  return union(spans, JOIN_MS)
}
const modelLabel = ({ providerId, model }: ModelLike): string => model ? (providerId && !model.startsWith(providerId) ? `${providerId}/${model}` : model) : providerId || 'unknown'
// The model the agent ran on; after a switch of subscription, the models in order ("claude-opus-5-5 → codex/gpt-6").
function ranOn(agent: ProfileAgent): string {
  const handovers = items(agent.handovers)
  if (!handovers.length) return modelLabel(agent)
  const labels = [handovers[0].from ?? agent, ...handovers.map(handover => handover.to ?? agent)].map(modelLabel)
  return labels.filter((label, index) => label !== labels[index - 1]).join(' → ')
}
const callsOf = (agent: ProfileAgent | null, field: 'nativeToolCalls' | 'orbitToolCalls'): number => items(agent?.turnTimings).reduce((total, turn) => total + (turn[field] ?? 0), 0)

// ---- Tokens ------------------------------------------------------------------------------------------------------------
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const tokenText = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))
// An agent that ran but whose provider reported nothing is `unknown`, never 0; one that never ran says nothing at all.
function tokensOf(agents: readonly ProfileAgent[]): TokenProfile | null {
  const agentsTokens: AgentTokens[] = [], unknown: string[] = []
  for (const agent of agents) {
    const name = agent.id === ROOT ? 'root' : agent.name || agent.id
    const input = count(agent.usage?.inputTokens) ?? 0, output = count(agent.usage?.outputTokens) ?? 0
    if (input + output === 0) { if (items(agent.turnTimings).length) unknown.push(name); continue }
    const steps = callsOf(agent, 'nativeToolCalls') + callsOf(agent, 'orbitToolCalls') + items(agent.turnTimings).length
    agentsTokens.push({ id: agent.id, name, model: ranOn(agent), effort: agent.reasoningEffort || null, input, cached: Math.min(count(agent.usage?.cachedInputTokens) ?? 0, input), output, steps, perStep: steps > 0 && input > 0 ? Math.round(input / steps) : null, sharePct: 0 })
  }
  if (!agentsTokens.length) return null
  const input = agentsTokens.reduce((total, item) => total + item.input, 0)
  for (const item of agentsTokens) item.sharePct = share(item.input, input)
  agentsTokens.sort((a, b) => b.input - a.input)
  return { input, cached: agentsTokens.reduce((total, item) => total + item.cached, 0), output: agentsTokens.reduce((total, item) => total + item.output, 0), agents: agentsTokens, unknown }
}
// At most two hints at the agents that dominate the run's tokens, the biggest first: a context that grew large (every step
// pays for all of it), or an output that is mostly thinking.
const BIG_STEP = 150_000
const BIG_INPUT = 500_000
const BIG_OUTPUT = 100_000
const HIGH_EFFORT = /^(?:high|xhigh|max|ultra)$/
function tokenHintsOf(tokens: TokenProfile | null): string[] {
  const found: string[] = []
  for (const agent of tokens?.agents ?? []) {
    if (agent.perStep !== null && agent.perStep >= BIG_STEP && agent.sharePct >= 10 && agent.input >= BIG_INPUT) {
      const lead = `${agent.name}: ${agent.sharePct}% of the run's input tokens, ~${tokenText(agent.perStep)} tokens per step`
      found.push(agent.id === ROOT ? `${lead}: what it reads stays in its context and is paid again at every step; keep results and tool output short, delegate reading` : `${lead}: its context grew; give such work as smaller tasks or lower its effort`)
    } else if (agent.effort && HIGH_EFFORT.test(agent.effort) && agent.output >= BIG_OUTPUT) found.push(`${agent.name}: ${tokenText(agent.output)} output tokens at ${agent.effort} effort, mostly thinking: a lower effort for simple work saves them`)
  }
  return found.slice(0, 2)
}

// ---- Parallelism -------------------------------------------------------------------------------------------------------
function parallelism(all: readonly (readonly Span[])[], start: number, end: number): Parallelism {
  const edges: Array<[number, number]> = []
  for (const spans of all) for (const [from, to] of spans) if (to > from) edges.push([from, 1], [to, -1])
  // An end before a start at the same instant: two helpers that follow each other never count as two at once.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const result: Parallelism = { noneMs: 0, oneMs: 0, manyMs: 0, max: 0 }
  let at = start, count = 0
  const until = (time: number): void => {
    const ms = Math.max(0, time - at)
    if (count === 0) result.noneMs += ms
    else if (count === 1) result.oneMs += ms
    else result.manyMs += ms
    at = Math.max(at, time)
  }
  for (const [time, step] of edges) { until(time); count += step; result.max = Math.max(result.max, count) }
  until(end)
  return result
}

// ---- restart_orbit -----------------------------------------------------------------------------------------------------
// The step timings the self-upgrade script printed ("  ok   typecheck      1500 ms") when its output reached the traces, from
// the last restart_orbit output that has any (each attempt starts over). A test report's own "duration_ms" is not a step: the
// tail of the output may belong to any of the several test runs of one upgrade.
const STEP_LINE = /^[ \t]*(?:ok|FAIL)[ \t]+([\w:.-]+)[ \t]+(\d+) ms[ \t]*$/gm
function stepTimings(texts: readonly string[]): StepTiming[] {
  let steps: StepTiming[] = []
  for (const text of texts) {
    const listed = [...text.matchAll(STEP_LINE)].map((match): StepTiming => ({ step: match[1], ms: Number(match[2]) }))
    if (listed.length) steps = listed
  }
  return steps
}
const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// ---- The profile -------------------------------------------------------------------------------------------------------
const span = (ms: number): string => ms < MINUTE ? `${Math.round(ms / 1000)} s` : ms < 100 * MINUTE ? `${(ms / MINUTE).toFixed(1)} min` : `${Math.round(ms / MINUTE)} min`
const share = (ms: number, whole: number): number => Math.round(100 * ms / Math.max(1, whole))
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

// The one to three things that cost the most, most expensive first. The impact is a rough count of the milliseconds the
// run could have saved: it only orders the hints.
function hintsOf(profile: Omit<RunProfile, 'hints'>): string[] {
  const { wallMs, helpers, root, parallel, restart, spawns, firstHelperMs } = profile
  const found: Array<{ impactMs: number; text: string }> = []
  if (firstHelperMs !== null && firstHelperMs >= 3 * MINUTE && firstHelperMs >= wallMs * 0.15) found.push({ impactMs: firstHelperMs, text: `first helper started ${span(firstHelperMs)} in: delegate right after a short look` })
  if (!helpers.length && wallMs >= 10 * MINUTE) found.push({ impactMs: wallMs / 2, text: `no helper was used in ${span(wallMs)}: independent parts could run in parallel` })
  const worked = helpers.reduce((total, helper) => total + helper.workMs, 0)
  if (helpers.length >= 2 && parallel.manyMs === 0 && worked >= 2 * MINUTE) found.push({ impactMs: worked - helpers[0].workMs, text: `never two helpers at once: ${helpers.length} helpers worked one after another (${span(worked)}); start independent ones together` })
  // Without helpers the waits are for messages (the user's), and there is nothing to take in or to do meanwhile.
  if (helpers.length && root?.waitMs && root.waitMs >= 3 * MINUTE && root.waitMs >= wallMs * 0.2) found.push({ impactMs: root.waitMs / 2, text: `root waited ${share(root.waitMs, wallMs)}% of the run (${span(root.waitMs)}) in wait_agent/wait_message: take finished results at once and work meanwhile` })
  if (restart && restart.totalMs >= 40_000) found.push({ impactMs: restart.totalMs, text: `restart_orbit took ${span(restart.totalMs)} in ${plural(restart.calls, 'call')} (median ${span(restart.medianMs)})` })
  if (spawns && (spawns.slowestMs >= SLOW_SPAWN_MS || spawns.totalMs >= SLOW_SPAWNS_MS)) {
    found.push({ impactMs: spawns.totalMs, text: `spawn_agent calls took ${span(spawns.totalMs)} in all, up to ${span(spawns.slowestMs)} for one${helpers.some(helper => helper.isolated) ? ' (an isolated copy is made inside the call)' : ''}` })
  }
  return [...found.sort((a, b) => b.impactMs - a.impactMs).slice(0, 3).map(hint => hint.text), ...tokenHintsOf(profile.tokens)]
}

function profileRun(source: ProfileSource, now: number = Date.now()): RunProfile {
  const agents = source.agentNodes ? [...source.agentNodes.values()] : source.agents ?? []
  const traces = source.traces ?? []
  // Every time the record names (to bound a run that has no start or end of its own), and the traces' times apart.
  const stamps: number[] = [], traced: number[] = []
  const note = (value: unknown): void => { const ms = timeOf(value); if (ms !== null) stamps.push(ms) }
  for (const trace of traces) { const ms = timeOf(trace.time); if (ms !== null) { stamps.push(ms); traced.push(ms) } }
  for (const agent of agents) { note(agent.finishedAt); for (const turn of items(agent.turnTimings)) { note(turn.startedAt); note(turn.endedAt) } }
  const earliest = stamps.length ? Math.min(...stamps) : null, latest = stamps.length ? Math.max(...stamps) : null
  const start = timeOf(source.startedAt) ?? earliest ?? now
  const finished = timeOf(source.finishedAt)
  const open = finished === null && !TERMINAL.has(source.status ?? '')
  // A live run is measured up to now, a saved one that never finished up to its last save.
  const end = Math.max(start, finished ?? (source.agentNodes && open ? now : Math.min(now, timeOf(source.updatedAt) ?? latest ?? now)))
  const inside = (ms: number): number => Math.min(Math.max(ms, start), end)
  const calls = pairCalls(traces)
  const rootAgent = agents.find(agent => agent.id === ROOT) ?? null
  const others = agents.filter(agent => agent !== rootAgent)

  // Helpers: when each was made (its spawn message, else its first turn), which spawn_agent call made it, what it did.
  const spawned = new Map<string, number>()
  for (const message of source.communications ?? []) {
    const at = timeOf(message.time)
    if (message.kind === 'spawn' && message.toAgentId && message.toAgentId !== ROOT && at !== null) spawned.set(message.toAgentId, at)
  }
  const spawnCalls = calls.filter(call => call.name === 'spawn_agent')
  const callOf = new Map<string, Call>()
  for (const call of spawnCalls) {
    const made = /^spawn_agent: \{"ok":true\b/.test(call.result) && !/"reused":true/.test(call.result.slice(0, 300)) ? /"agentId":"([^"]+)"/.exec(call.result)?.[1] : undefined
    if (made) callOf.set(made, call)
  }
  const delegations = traces.filter(trace => trace.kind === 'delegation')
  // The kind of work a spawn named: Orbit's routing note on the delegation, else the call's own arguments.
  const kindOf = (agent: ProfileAgent): string | null => {
    const note = delegations.find(trace => trace.text?.startsWith(`${agent.name}: `))?.text ?? ''
    return /\nModel for (code|review|lookup|text) work:/.exec(note)?.[1] ?? /"kind":"(code|review|lookup|text)"/.exec(callOf.get(agent.id)?.args ?? '')?.[1] ?? null
  }
  const helperSpans = others.map(agent => workSpans(agent, start, end))
  const helpers = others.map((agent, index): HelperProfile => {
    const call = callOf.get(agent.id)
    const created = spawned.get(agent.id) ?? call?.end ?? helperSpans[index][0]?.[0] ?? timeOf(agent.startedAt)
    return {
      id: agent.id, name: agent.name || agent.id, kind: kindOf(agent), model: ranOn(agent), status: agent.status || 'unknown',
      startedMs: created === null ? null : Math.max(0, created - start), workMs: lengthOf(helperSpans[index]),
      spawnMs: call && created !== null ? Math.max(0, created - call.start) : null, isolated: !!agent.isolation,
    }
  }).sort((a, b) => b.workMs - a.workMs)
  const starts = helpers.map(helper => helper.startedMs).filter((ms): ms is number => ms !== null)

  // The root: its turns, and the time it sat in a wait tool (clamped to the run, an unanswered wait ends with it).
  const rootWaits = calls.filter(call => call.agentId === ROOT && WAIT_TOOLS.has(call.name))
  const root: RootProfile | null = rootAgent ? {
    turns: items(rootAgent.turnTimings).length, turnMs: lengthOf(workSpans(rootAgent, start, end)), waitCalls: rootWaits.length,
    waitMs: traces.length ? lengthOf(union(rootWaits.map((call): Span => [inside(call.start), Math.max(inside(call.start), inside(call.end ?? end))]))) : null,
  } : null

  // restart_orbit: from the call to its answer, or, for the call that ended the run, to the restart request.
  const restartedAt = timeOf(source.restart?.requestedAt)
  const restarts = calls.filter(call => call.agentId === ROOT && call.name === 'restart_orbit')
  const lengths = restarts.map(call => Math.max(0, inside(call.end ?? restartedAt ?? end) - inside(call.start)))
  const restart: RestartProfile | null = restarts.length ? {
    calls: restarts.length, failed: restarts.filter(call => /"ok":false/.test(call.result)).length, totalMs: lengths.reduce((total, ms) => total + ms, 0),
    medianMs: medianOf(lengths), longestMs: Math.max(...lengths), applied: restartedAt !== null,
    steps: stepTimings([...traces.filter(trace => trace.kind === 'restart' && trace.agentId === ROOT).map(trace => trace.text ?? ''), ...restarts.map(call => call.result)].filter(Boolean)),
  } : null
  const spawnLengths = spawnCalls.map(call => Math.max(0, inside(call.end ?? end) - inside(call.start)))
  const spawns: SpawnProfile | null = spawnCalls.length ? { calls: spawnCalls.length, totalMs: spawnLengths.reduce((total, ms) => total + ms, 0), slowestMs: Math.max(...spawnLengths) } : null

  const cutAt = traces.length >= TRACES_KEPT && traced.length ? Math.min(...traced) - start : null
  const profile: Omit<RunProfile, 'hints'> = {
    runId: source.runId, status: source.status || 'unknown', open, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), wallMs: end - start,
    tracesFromMs: cutAt !== null && cutAt >= 30_000 ? cutAt : null,
    root, helpers, firstHelperMs: starts.length ? Math.min(...starts) : null, parallel: parallelism(helperSpans, start, end), spawns, restart, tokens: tokensOf(agents),
    tools: { native: agents.reduce((total, agent) => total + callsOf(agent, 'nativeToolCalls'), 0), orbit: agents.reduce((total, agent) => total + callsOf(agent, 'orbitToolCalls'), 0), rootNative: callsOf(rootAgent, 'nativeToolCalls'), rootOrbit: callsOf(rootAgent, 'orbitToolCalls') },
  }
  return { ...profile, hints: hintsOf(profile) }
}

// ---- Text --------------------------------------------------------------------------------------------------------------
function describeHelper(helper: HelperProfile): string {
  const what = [helper.kind, helper.model].filter(Boolean).join(', ')
  return `${helper.name} (${what}) ${span(helper.workMs)} ${helper.status}${helper.spawnMs !== null && helper.spawnMs >= 5000 ? `, spawn ${span(helper.spawnMs)}` : ''}`
}
function tokenLine(tokens: TokenProfile, shown: number): string {
  const { input, cached, output, agents, unknown } = tokens
  const steps = agents.reduce((total, item) => total + item.steps, 0)
  const average = steps > 0 ? ` (average context ~${tokenText(input / steps)} per step over ~${steps} steps, an estimate: input / steps)` : ''
  const list = agents.slice(0, shown).map(item => `${item.name} ${tokenText(item.input)} (${item.sharePct}%${item.perStep === null ? '' : `, ~${tokenText(item.perStep)}/step`}, out ${tokenText(item.output)})`)
  const by = list.length ? `. By input: ${list.join('; ')}${agents.length > shown ? `; ${agents.length - shown} more` : ''}` : ''
  const none = unknown.length ? `. Usage unknown (not reported): ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ` and ${unknown.length - 3} more` : ''}` : ''
  return `Tokens: input ${tokenText(input)}${cached > 0 ? ` (${share(cached, input)}% cached)` : ''}, output ${tokenText(output)}${average}${by}${none}.`
}
function render(profile: RunProfile, shown: number, tokensShown: number): string {
  const { root, helpers, parallel, restart, tools, hints, wallMs } = profile
  const lines = [`Run ${profile.runId.slice(0, 8)} (${profile.status}${profile.open ? ', unfinished' : ''}): ${span(wallMs)} wall-clock${profile.tracesFromMs === null ? '' : `; its trace history starts ${span(profile.tracesFromMs)} in, so waits, spawn calls and restarts before that are not counted`}.`]
  if (root) lines.push(`Root: ${plural(root.turns, 'turn')}, ${span(root.turnMs)} of turn time${root.waitMs === null ? '' : `; blocked in wait_agent/wait_message ${span(root.waitMs)} (${share(root.waitMs, wallMs)}% of the run)`}. Tool calls: native ${tools.rootNative}, Orbit ${tools.rootOrbit}${helpers.length ? `; all agents: native ${tools.native}, Orbit ${tools.orbit}` : ''}.`)
  if (!helpers.length) lines.push('Helpers: none.')
  else {
    const first = profile.firstHelperMs === null ? '' : `, the first started ${span(profile.firstHelperMs)} in`
    lines.push(`Helpers: ${helpers.length}${first}. With 0 / 1 / 2+ helpers working: ${span(parallel.noneMs)} / ${span(parallel.oneMs)} / ${span(parallel.manyMs)} (at most ${parallel.max} at once).`)
  }
  if (shown > 0) lines.push(`${helpers.length > shown ? `Longest ${shown} of ${helpers.length}` : 'By time'}: ${helpers.slice(0, shown).map(describeHelper).join('; ')}.`)
  if (profile.tokens) lines.push(tokenLine(profile.tokens, tokensShown))
  if (restart) {
    const steps = restart.steps.length ? `; ${restart.steps.map(step => `${step.step} ${span(step.ms)}`).join(', ')}` : ''
    lines.push(`restart_orbit: ${plural(restart.calls, 'call')}, ${span(restart.totalMs)} in all (median ${span(restart.medianMs)}${restart.failed ? `, ${restart.failed} failed` : ''}${restart.applied ? ', the last one applied the change' : ''}${steps}).`)
  }
  if (hints.length) lines.push(`Hints: ${hints.join('; ')}.`)
  return lines.join('\n')
}
// The profile as compact English text of at most `maxChars` characters: the list of helpers shrinks first, then the list of
// agents in the tokens line.
function formatProfile(profile: RunProfile, maxChars: number = SUMMARY_CHARS): string {
  const listed = Math.min(SHOWN_TOKEN_AGENTS, profile.tokens?.agents.length ?? 0)
  for (let shown = Math.min(SHOWN_HELPERS, profile.helpers.length); shown >= 0; shown--) {
    const text = render(profile, shown, listed)
    if (text.length <= maxChars) return text
  }
  for (let tokensShown = listed - 1; tokensShown >= 0; tokensShown--) {
    const text = render(profile, 0, tokensShown)
    if (text.length <= maxChars) return text
  }
  return ellipsis(render(profile, 0, 0), maxChars)
}

// The profile of a run as text for the history of its chat, or null when it is not worth reading (a run of a minute and a
// half without helpers) or cannot be profiled: a history never breaks a prompt.
function profileSummary(source: ProfileSource, now: number = Date.now()): string | null {
  try {
    const profile = profileRun(source, now)
    return profile.wallMs < TRIVIAL_MS && !profile.helpers.length ? null : formatProfile(profile)
  } catch { return null }
}
// The paragraph the improvement loop shows the root: the profile of this chat's latest finished run. A continuation after
// restart_orbit only confirms the change, so the run it continues stands for the task; a run without a profile is skipped,
// and with none at all the paragraph is left out. `prior`: the chat's earlier runs, oldest first.
function previousRunProfile(prior: readonly PriorRun[] | null | undefined): string {
  if (!Array.isArray(prior)) return ''
  const byId = new Map(prior.map(run => [run.runId, run]))
  for (let index = prior.length - 1; index >= 0; index--) {
    let pick = prior[index]
    if (!TERMINAL.has(pick.status ?? '')) continue
    for (let hops = 0; pick.resumedFrom && hops < 4; hops++) {
      const head = byId.get(pick.resumedFrom)
      if (!head) break
      pick = head
    }
    if (pick.profile) return `\nPREVIOUS RUN PROFILE (the latest finished run of this chat; run_profile {runId} has the detail):\n${pick.profile}`
  }
  return ''
}

export { profileRun, formatProfile, profileSummary, previousRunProfile, span }
export type { ProfileSource, ProfileAgent, ProfileTrace, RunProfile, HelperProfile, RootProfile, RestartProfile, SpawnProfile, Parallelism, StepTiming, PriorRun, TokenProfile, AgentTokens }
