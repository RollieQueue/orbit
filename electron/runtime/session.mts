// The session transport's plumbing: which transport an agent gets, the in-process MCP server and its tokens, the
// tools/list, approve and tools/call handlers the server calls back into, and closing sessions when a run ends.
import { randomUUID } from 'node:crypto'
import { pausedBy } from './pause.mts'
import { publishProgress } from './turn.mts'
import type { ActiveTurn, AgentRecord, CloseSession, McpApproveRequest, McpDispatchResult, McpServerLike, Observation, OrbitRuntimeLike, RunRecord, SessionRef, ToolCall, ToolRegistryLike, ToolSpec, Transport } from '../types.mts'
// A token as the MCP server hands it back, or the { runId, agentId } it resolved itself.
type SessionToken = string | SessionRef | null | undefined
// The module object is kept: `transportFor` and `closeSession` are looked up at call time, so a providers build
// without them still works; `runProvider` is captured at load, as the facade captures its default.
import * as providers from '../providers.mts'
// Used only for an identity check against the runtime's runProvider.
const defaultRunProvider: unknown = providers.runProvider
import { TERMINAL, AGENT_TERMINAL, WORK_TOOLS, MUTATING_TOOLS, SKILL_READ_CHARS, abortable, bounded, clip, diagnostics } from './util.mts'
import { describeCall } from './ledger.mts'
import { restartOffered } from './restart.mts'
// Type only: the module itself (with the MCP SDK and zod, most of the runtime's load time) is imported by ensureMcp on
// the first session, so a runtime that never opens one never loads it.
import type { createMcpServer } from '../mcp-server.mts'
import * as toolRegistry from '../tool-registry.mts'
// Session mode: tools that block on the team release the agent's model slot while they wait.
const WAIT_TOOLS = new Set(['wait_agent', 'wait_message', 'followup_agent'])
// A wait serves the turn that called it: it ends with that turn (finished, cut off, failed), and takes what it found
// (mail marked read, helper results marked seen) only while that turn still runs and has its model slot back (a provider
// whose client ends calls on its own clock goes on without it once the grace runs out, see slotBack). A wait the turn
// left behind takes nothing: the next turn gets that mail and those results.
const TURN_WAITS = new Set(['wait_agent', 'wait_message'])
const TURN_ENDED = 'Your turn ended before this wait could answer (it was interrupted or failed): the wait took nothing. Unread mail comes with your next prompt; call wait_agent again for helpers\' results.'
// Some providers' MCP clients end a tool call on their own clock (Cursor: 60 s, without a progress token), so a session
// agent of such a provider is answered before that (providers.mcpCallLimit): a wait is cut at the limit and answers
// "still running, call again"; any other call that outlives it keeps running and the agent's next identical call
// collects its result instead of starting it again.
const TIMED_WAITS: Record<string, number> = { wait_agent: Infinity, wait_message: 30000 } // their wait without timeout_ms
const STILL_RUNNING = Symbol('still-running')
// A result nobody came back for is not handed to a much later identical call.
const PARKED_KEEP_MS = 2 * 60 * 1000
// Orbit's file writes: a result begun before one of them is stale for a later identical call.
const FILE_WRITES = new Set(['write_file', 'edit_file'])
// One call of such an agent, registered when it starts (an identical call made meanwhile joins it) and kept until its
// result is delivered, it goes stale or the agent's session ends. It runs under its own controller, linked to the
// agent's signal, so ending the session kills a command nobody came back for. `epoch` is the agent's count of Orbit file
// writes when it started; `work` its count of changed files (workDone without delegations: native edits, Orbit writes,
// a command's attributed changes) when it started, then when it finished (its own command's changes are not a reason).
interface ParkedCall { operation: Promise<Observation>; startedAt: number; finishedAt?: number; controller: AbortController; epoch: number; work: number }
// Per agent: its calls by callKey, the write count, delegations counted in workDone, and its recent settled commands.
interface AgentCalls { calls: Map<string, ParkedCall>; epoch: number; spawns: number; commands: ParkedCall[] }
const parkedCalls = new WeakMap<AgentRecord, AgentCalls>()
// A slot a wait gave away is taken back once per turn, however many waits ran side by side.
const retaking = new WeakMap<ActiveTurn, Promise<void>>()
function callLimit(agent: AgentRecord): number {
  if (agent.transport !== 'session' || typeof providers.mcpCallLimit !== 'function') return 0
  const limit = Number(providers.mcpCallLimit(agent.providerId))
  return Number.isFinite(limit) && limit > 0 ? limit : 0
}
// "The same call again": the tool and its arguments in a stable order, whatever timeout it asks for.
function callKey(call: ToolCall): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])])) : value
  const args = { ...call.arguments }
  delete args.timeout_ms
  return `${call.name}\0${JSON.stringify(stable(args))}`
}
function withinLimit<T>(operation: Promise<T>, limit: number): Promise<T | typeof STILL_RUNNING> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof STILL_RUNNING>(resolve => { timer = setTimeout(() => resolve(STILL_RUNNING), limit) })
  return Promise.race([operation, expiry]).finally(() => clearTimeout(timer))
}
const span = (ms: number): string => ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
function agentCalls(agent: AgentRecord): AgentCalls {
  let state = parkedCalls.get(agent)
  if (!state) { state = { calls: new Map(), epoch: 0, spawns: 0, commands: [] }; parkedCalls.set(agent, state) }
  return state
}
const filesChanged = (agent: AgentRecord, state: AgentCalls): number => agent.workDone - state.spawns
// Stale: an Orbit write since the call started, files changed since it started (still running) or finished, or no
// taker for long. Other commands do not make it stale by running (two commands would restart each other forever), only
// by changes Orbit could attribute; and when another command ended since, the change count says nothing (that command
// may have counted this call's own changes as its own, runTrackedCommand), so only the writes count.
function staleCall(call: ParkedCall, state: AgentCalls, agent: AgentRecord): boolean {
  if (call.epoch !== state.epoch || (call.finishedAt !== undefined && Date.now() - call.finishedAt > PARKED_KEEP_MS)) return true
  const since = call.finishedAt ?? call.startedAt
  const blurred = state.commands.some(other => other !== call && (other.finishedAt ?? 0) >= since && (call.finishedAt === undefined || other.startedAt < call.finishedAt))
  return !blurred && filesChanged(agent, state) !== call.work
}
function startCall(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, call: ToolCall, state: AgentCalls): ParkedCall {
  const signal = runtime.agentSignal(run, agent), controller = new AbortController(), abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()
  const work = filesChanged(agent, state)
  const started: ParkedCall = { operation: runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments, controller.signal), agent), startedAt: Date.now(), controller, epoch: state.epoch, work }
  // A command's own attributed changes are counted just before it settles, so they are part of the reference from then on.
  const settle = (fulfilled: boolean) => {
    started.finishedAt = Date.now(); started.work = filesChanged(agent, state); signal.removeEventListener('abort', abort)
    if (fulfilled && call.name === 'run_command') { state.commands.push(started); if (state.commands.length > 16) state.commands.shift() }
  }
  started.operation.then(() => settle(true), () => settle(false))
  return started
}
// A result the call did not start itself says so, and when the run it comes from began.
function collectedResult(observation: Observation, startedAt: number): Observation {
  const mark = { collected: true, startedAt: new Date(startedAt).toISOString() }
  return observation && typeof observation === 'object' && !Array.isArray(observation) ? { ...observation, ...mark } : { ok: true, ...mark, result: observation }
}
// The agent's session is over: its calls nobody came back for are stopped (a command is killed) and their results dropped.
function abandonCalls(agent: AgentRecord): void {
  const state = parkedCalls.get(agent)
  parkedCalls.delete(agent)
  for (const call of state?.calls.values() ?? []) call.controller.abort()
}
// Takes back the slot a wait gave away; a turn that ended meanwhile (or already holds one again) does not keep it.
function retakeSlot(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, turn: ActiveTurn): Promise<void> {
  let pending = retaking.get(turn)
  if (!pending) {
    pending = runtime.acquireTurn(run, agent).then(() => {
      if (agent.activeTurn === turn && !turn.slot.held) { turn.slot.held = true; runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing' }) }
      else runtime.releaseTurn(run)
    }, () => {}).finally(() => retaking.delete(turn))
    retaking.set(turn, pending)
  }
  return pending
}

// Session mode set-up for one execution of an agent: the MCP server must be up and the agent needs a token. Without a
// server (module missing, port refused) the agent falls back to the envelope loop, once, with a trace.
async function prepareSession(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<boolean> {
  const mcp = await runtime.ensureMcp()
  if (!mcp) {
    runtime.trace(run, agent.id, 'transport', `Session transport unavailable (${runtime.mcpError?.message || 'no MCP server'}); using the envelope protocol`)
    runtime.updateAgent(run, agent, { transport: 'envelope' }, false)
    return false
  }
  if (!agent.sessionToken) {
    agent.sessionToken = mcp.issueToken({ runId: run.runId, agentId: agent.id })
    runtime.sessions.set(agent.sessionToken, { runId: run.runId, agentId: agent.id })
  }
  return true
}
function releaseSession(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): void {
  abandonCalls(agent)
  if (!agent.sessionToken) return
  runtime.sessions.delete(agent.sessionToken)
  // `false` (a server that failed) has no revoke: `?.` reads undefined from it and nothing is called.
  try { (runtime.mcp as McpServerLike | null)?.revoke?.(agent.sessionToken) } catch (error) { diagnostics(runtime, run, 'mcp.revoke', error, agent.id) /* A token the server no longer knows is already gone. */ }
  agent.sessionToken = null
}
// What closes a provider's session: the injected `closeSession` when present, else the providers module's, only for its
// own runProvider. Closing is best effort.
function sessionCloser(runtime: OrbitRuntimeLike): CloseSession | null {
  return runtime.closeSession || (runtime.runProvider === defaultRunProvider && typeof providers.closeSession === 'function' ? providers.closeSession : null)
}
function closeId(close: CloseSession, sessionId: string): void {
  try { Promise.resolve(close(sessionId)).catch(() => {}) } catch { /* Closing is best effort. */ }
}
// When a run ends nothing will resume its sessions: whatever a provider keeps alive between turns (a Codex App Server
// thread, an Antigravity conversation's folder) is closed, and calls nobody came back for are stopped.
function closeSessions(runtime: OrbitRuntimeLike, run: RunRecord): void {
  for (const agent of run.agentNodes.values()) abandonCalls(agent)
  const close = sessionCloser(runtime)
  if (!close) return
  for (const agent of run.agentNodes.values()) if (agent.sessionId) closeId(close, agent.sessionId)
}
// A handover ends the agent's session for good (the newcomer starts a fresh one): its calls nobody came back for are
// stopped, and what the provider keeps for it (the Antigravity folder holding the MCP token, a Codex App Server) is
// closed now rather than left until the process exits.
function closeAgentSession(runtime: OrbitRuntimeLike, agent: AgentRecord): void {
  abandonCalls(agent)
  const close = agent.sessionId ? sessionCloser(runtime) : null
  if (close && agent.sessionId) closeId(close, agent.sessionId)
}
// Which provider transport an agent gets: the injected decision, else providers.transportFor when that build has it
// and the providers module's own runProvider is in use (it describes what that runProvider does; a custom runProvider,
// a test's fake or an embedder's adapter, speaks the envelope unless it injects its own decision), else the envelope.
// The escape hatch forces the envelope everywhere; an MCP server that failed to start does too.
function decideTransport(runtime: OrbitRuntimeLike, run: RunRecord, providerId: string, model: string): Transport {
  if (process.env.ORBIT_LEGACY_ENVELOPE === '1' || runtime.mcp === false) return 'envelope'
  const builtIn = runtime.runProvider === defaultRunProvider && typeof providers.transportFor === 'function' ? providers.transportFor : null
  const decide = runtime.transportFor || builtIn
  if (!decide) return 'envelope'
  try { return decide(providerId, { ...(run.providerOptions[providerId] || {}), accessMode: run.accessMode, approvalPolicy: run.approvalPolicy, model: model || '' }) === 'session' ? 'session' : 'envelope' }
  catch (error) { diagnostics(runtime, run, `transportFor ${providerId}`, error); return 'envelope' }
}
// The in-process MCP server, created on the first session and started once; `false` after a failure. Its module is
// loaded here, on first use (an injected server, a test's fake, needs no module at all).
async function ensureMcp(runtime: OrbitRuntimeLike): Promise<McpServerLike | null> {
  if (runtime.mcp === false) return null
  if (!runtime.mcp) {
    let create: typeof createMcpServer
    try { ({ createMcpServer: create } = await import('../mcp-server.mts')) }
    catch (error) { runtime.mcpError = error as Error; runtime.mcp = false; return null }
    // Another agent's first session may have created the server, or failed to, while the module loaded.
    const current = runtime.mcp as McpServerLike | null | false
    if (current === false) return null
    if (!current) {
      try { runtime.mcp = create({ dispatch: (token, name, args) => runtime.dispatchMcp(token, name, args), approve: (token, request) => runtime.approveMcp(token, request), listTools: token => runtime.listToolsMcp(token) }) }
      catch (error) { runtime.mcpError = error as Error; runtime.mcp = false; return null }
    }
  }
  if (!runtime.mcpStarted) {
    // Set by the block above or before it.
    const server = runtime.mcp as McpServerLike
    runtime.mcpStarted = Promise.resolve().then(() => server.start?.()).then(() => server, error => { runtime.mcpError = error; runtime.mcp = false; runtime.mcpStarted = null; return null })
  }
  return runtime.mcpStarted
}
// (`runtime.mcp &&` already rules out `false`; the explicit test is kept, hence the widening casts.)
function mcpUrl(runtime: OrbitRuntimeLike): string | null { const url = runtime.mcp && (runtime.mcp as McpServerLike | false) !== false ? runtime.mcp.url : null; return typeof url === 'function' ? url.call(runtime.mcp) : url || null }
// The run and agent behind a session token (or a {runId, agentId} the server resolved itself); null when unknown.
function sessionFor(runtime: OrbitRuntimeLike, token: SessionToken): { run: RunRecord; agent: AgentRecord } | null {
  const known = token && typeof token === 'object' ? token : runtime.sessions.get(String(token || ''))
  const run = known && runtime.runs.get(known.runId)
  const agent = run && run.agentNodes.get(known!.agentId) // `run` is found only through `known`.
  return run && agent ? { run, agent } : null
}
// The tool registry (electron/tool-registry.mts) unless one was injected (null disables it); looked up once.
function registry(runtime: OrbitRuntimeLike): ToolRegistryLike | null {
  if (runtime.toolRegistry === undefined) runtime.toolRegistry = toolRegistry
  return runtime.toolRegistry || null
}
// tools/list for one session: the registry's tools without root-only ones for workers and without writes in read-only
// mode; restart_orbit only where the envelope guide offers it too (the root agent of a writable run on any project).
function listToolsMcp(runtime: OrbitRuntimeLike, token: SessionToken): ToolSpec[] {
  const session = runtime.sessionFor(token)
  const registry = runtime.registry()
  if (!session || !registry) return []
  const { run, agent } = session
  const context = { root: agent.id === 'root', accessMode: run.accessMode }
  const rank: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
  const tools = typeof registry.toolsFor === 'function' ? registry.toolsFor(context) : (Array.isArray(registry.TOOLS) ? registry.TOOLS : []).filter(tool => !tool.internal && (!tool.rootOnly || context.root) && (rank[tool.minAccess] ?? 0) <= (rank[run.accessMode] ?? 0))
  return restartOffered(runtime, run, agent) ? tools : tools.filter(tool => tool.name !== 'restart_orbit')
}
// The MCP approve tool: the same user prompt as an envelope-mode approval; true allows.
async function approveMcp(runtime: OrbitRuntimeLike, token: SessionToken, request: McpApproveRequest = {}): Promise<boolean> {
  const session = runtime.sessionFor(token)
  if (!session) return false
  const { run, agent } = session
  try { return await runtime.approve(run, agent, { tool: request.tool_name || request.tool || '', arguments: request.input ?? request.arguments ?? {}, toolUseId: request.tool_use_id }) }
  catch (error) { diagnostics(runtime, run, 'approveMcp', error, agent.id); return false }
}
// One Orbit tool call arriving over MCP while the agent's provider turn runs. Executed exactly as an envelope call
// (ledger, work log, file activity, change capture, traces, transcript), with the model slot released around a
// waiting tool. Never throws: the result carries `ok`, the observation text (followed by the user's messages that came
// in during the turn) and the agent's unread-mail count, which the server appends as a suffix.
async function dispatchMcp(runtime: OrbitRuntimeLike, token: SessionToken, name: string, args: unknown = {}): Promise<McpDispatchResult> {
  const session = runtime.sessionFor(token)
  if (!session) return { ok: false, error: 'Unknown or expired Orbit session token', text: JSON.stringify({ ok: false, error: 'Unknown or expired Orbit session token' }), unread: 0 }
  const { run, agent } = session
  const refuse = (error: string): McpDispatchResult => ({ ok: false, error, observation: { ok: false, error }, text: JSON.stringify({ ok: false, error }), unread: runtime.pendingMail(run, agent).length })
  if (TERMINAL.has(run.status) || AGENT_TERMINAL.has(agent.status)) return refuse('This agent is no longer active')
  if (pausedBy(run, agent)) return refuse('Paused by the user')
  const signal = runtime.agentSignal(run, agent)
  if (signal.aborted) return refuse('Run cancelled')
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : null
  const call: ToolCall = { id: randomUUID(), name: String(name || ''), arguments: raw ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) : { __invalidArguments: true } }
  const turn = agent.activeTurn
  // Without a running turn no model would read a wait's answer.
  if (!turn && TURN_WAITS.has(call.name)) return refuse(TURN_ENDED)
  if (turn) { turn.timing.orbitToolCalls++; publishProgress(runtime, run, agent) }
  runtime.trace(run, agent.id, 'tool', `${call.name} ${bounded(call.arguments, 1200)}`)
  const waits = WAIT_TOOLS.has(call.name)
  const limit = callLimit(agent), calledAt = Date.now()
  if (waits && turn?.slot.held) { turn.slot.held = false; runtime.releaseTurn(run) }
  // The slot is taken back before the result goes to the model, once: by a wait before it takes what it found (`ready`),
  // else after the call. A provider whose client ends a call on its own clock is not kept waiting past it for a busy
  // slot: the slot comes back in the background, the turn goes on meanwhile. A turn that ended takes no slot back.
  let back: Promise<void> | undefined
  const slotBack = (): Promise<void> => back ??= (async () => {
    if (!waits || !turn || turn.slot.held || turn.signal.aborted) return
    const retake = abortable(retakeSlot(runtime, run, agent, turn), turn.signal)
    // What is left of the limit, or a tenth of it (at most 5 s) when the wait used it all: Cursor's 60 s outlast 50 s + 5 s.
    const grace = Math.max(Math.min(5000, Math.ceil(limit / 10)), limit - (Date.now() - calledAt))
    if (!limit) await retake
    else if (await withinLimit(retake, grace) === STILL_RUNNING && agent.activeTurn === turn) runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing' })
  })()
  const turnWait = turn && TURN_WAITS.has(call.name) ? turn : null
  const bound = turnWait ? turnWait.signal : signal
  const ready = turnWait ? async (): Promise<void> => {
    await slotBack().catch(() => {})
    if (agent.activeTurn !== turnWait || turnWait.signal.aborted) throw new Error(TURN_ENDED)
  } : undefined
  // `joined`: when the call found its own run under way (or finished), the time that run started.
  let observation: Observation, failure: string | null = null, cut = false, parked = 0, joined: number | null = null
  try {
    if (call.arguments.__invalidArguments) throw new Error('Tool arguments must be a JSON object')
    const check = runtime.registry()?.validate?.(call.name, call.arguments)
    if (check && check.ok === false) throw new Error(check.error || 'Invalid tool arguments')
    if (limit && Object.hasOwn(TIMED_WAITS, call.name)) {
      const asked = call.arguments.timeout_ms === undefined ? TIMED_WAITS[call.name] : Number(call.arguments.timeout_ms) || 30000
      cut = asked > limit
      observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, cut ? { ...call.arguments, timeout_ms: limit } : call.arguments, bound, ready), agent)
    } else if (limit && !waits) {
      // The call is registered before anything is awaited, so an identical one made meanwhile joins it. A run begun
      // before files changed is not handed out: it is stopped and the call starts afresh.
      const key = callKey(call), state = agentCalls(agent)
      let current = state.calls.get(key)
      if (current && staleCall(current, state, agent)) { state.calls.delete(key); current.controller.abort(); current = undefined }
      if (current) joined = current.startedAt
      else {
        if (FILE_WRITES.has(call.name)) state.epoch++
        current = startCall(runtime, run, agent, call, state)
        state.calls.set(key, current)
      }
      const entry = current
      // Settled within the limit: the result is delivered here and nobody else collects it (a failure included).
      const forget = () => { if (state.calls.get(key) === entry) state.calls.delete(key) }
      const outcome = await withinLimit(entry.operation, limit).catch(error => { forget(); throw error })
      if (outcome === STILL_RUNNING) {
        parked = Math.max(1, Date.now() - entry.startedAt)
        observation = { ok: true, stillRunning: true, tool: call.name, runningForMs: parked, hint: `Still running after ${span(parked)}: one Orbit tool call may take at most ${span(limit)} here. Repeat exactly the same call to wait for its result; it is not started again unless files were changed meanwhile.` }
      } else {
        forget()
        observation = joined === null ? outcome : collectedResult(outcome, joined)
      }
    } else observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments, bound, ready), agent)
  } catch (error) {
    // A wait its turn left behind was aborted with the turn (abortable says "Run cancelled"), the run itself goes on.
    failure = turnWait?.signal.aborted && !signal.aborted ? TURN_ENDED : (error as Error).message
    observation = joined === null ? { ok: false, error: failure } : collectedResult({ ok: false, error: failure }, joined)
  } finally {
    await slotBack().catch(() => {})
  }
  if (!failure && !parked && (observation as { ok?: unknown } | null | undefined)?.ok !== false && MUTATING_TOOLS.has(call.name)) {
    if (turn) turn.changed = true
    if (WORK_TOOLS.has(call.name)) agent.workDone++
    // Delegating is work that changes no file: the agent's parked results do not go stale for it.
    const calls = parkedCalls.get(agent)
    if (calls && WORK_TOOLS.has(call.name) && !FILE_WRITES.has(call.name)) calls.spawns++
  }
  // A wait cut at the provider's limit says so when there is still something to wait for.
  let answer = observation
  if (cut && !failure) {
    const again = `one Orbit tool call may take at most ${span(limit)} here. Call ${call.name} again to keep waiting.`
    // wait_agent may have returned before the limit (a helper finished, or its progress check came first).
    const waited = Math.min(limit, Date.now() - calledAt)
    if (call.name === 'wait_agent' && Array.isArray(observation) && observation.some(child => !AGENT_TERMINAL.has(String((child as { status?: unknown } | null)?.status)))) answer = { ok: true, stillRunning: true, waitedMs: waited, agents: observation, hint: `Helpers are still running after ${span(waited)}: ${again}` }
    else if (call.name === 'wait_message' && (observation as { timedOut?: unknown } | null)?.timedOut === true) answer = { ...(observation as object), stillWaiting: true, hint: `No message within ${span(limit)}: ${again}` }
  }
  // describeCall reads the observation's fields defensively, whatever the tool returned.
  const logged = parked
    ? `${call.name} ${clip(call.name === 'run_command' ? [call.arguments.command, ...(Array.isArray(call.arguments.args) ? call.arguments.args : [])].join(' ') : JSON.stringify(call.arguments), 110)} → still running after ${span(parked)} (the same call again collects the result)`
    : `${describeCall(call, observation as Record<string, unknown>, failure, id => run.agentNodes.get(id)?.name || id)}${answer !== observation ? ` (cut at ${span(limit)}, still running)` : ''}`
  runtime.recordLedger(agent, call.name, `#${agent.turns} ${logged}`)
  // What the user wrote to the agent during this turn rides on the result, whole (userMail marks it read).
  const text = bounded(answer, call.name === 'capability_read' ? Math.max(run.limits.maxOutputChars, SKILL_READ_CHARS) : run.limits.maxOutputChars)
    + (turn && agent.activeTurn === turn && !signal.aborted ? runtime.userMail(run, agent) : '')
  runtime.remember(agent, { type: 'tool_result', tool_call_id: call.id, name: call.name, result: text, via: 'mcp' })
  runtime.trimTranscript(run, agent)
  runtime.trace(run, agent.id, 'observation', `${call.name}: ${bounded(answer, 4000)}`)
  return { ok: !failure, observation: answer, error: failure, text, unread: TERMINAL.has(run.status) ? 0 : runtime.pendingMail(run, agent).length }
}
// Stops the MCP server (if one was started) so the app can quit without an open port; pending session tokens are dropped.
async function shutdown(runtime: OrbitRuntimeLike): Promise<void> {
  const server = runtime.mcp && (runtime.mcp as McpServerLike | false) !== false ? runtime.mcp : null
  runtime.sessions.clear()
  runtime.mcpStarted = null
  if (!server) return
  try { await server.stop?.() } catch { /* Quitting anyway. */ }
}

export { prepareSession, releaseSession, closeSessions, closeAgentSession, decideTransport, ensureMcp, mcpUrl, sessionFor, registry, listToolsMcp, approveMcp, dispatchMcp, shutdown }
