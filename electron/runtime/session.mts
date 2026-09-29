// @ts-nocheck
// The session transport's plumbing: which transport an agent gets, the in-process MCP server and its tokens, the
// tools/list, approve and tools/call handlers the server calls back into, and closing sessions when a run ends.
import { randomUUID } from 'node:crypto'
// The module object is kept: `transportFor` and `closeSession` are looked up at call time, so a providers build
// without them still works; `runProvider` is captured at load, as the facade captures its default.
import * as providers from '../providers.mts'
const defaultRunProvider = providers.runProvider
import { TERMINAL, AGENT_TERMINAL, WORK_TOOLS, MUTATING_TOOLS, SKILL_READ_CHARS, bounded, diagnostics } from './util.mts'
import { describeCall } from './ledger.mts'
import { createMcpServer } from '../mcp-server.mts'
import * as toolRegistry from '../tool-registry.mts'
// Session mode: tools that block on the team release the agent's model slot while they wait.
const WAIT_TOOLS = new Set(['wait_agent', 'wait_message', 'followup_agent'])

// Session mode set-up for one execution of an agent: the MCP server must be up and the agent needs a token. Without a
// server (module missing, port refused) the agent falls back to the envelope loop, once, with a trace.
async function prepareSession(runtime, run, agent) {
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
function releaseSession(runtime, run, agent) {
  if (!agent.sessionToken) return
  runtime.sessions.delete(agent.sessionToken)
  try { runtime.mcp?.revoke?.(agent.sessionToken) } catch (error) { diagnostics(runtime, run, 'mcp.revoke', error, agent.id) /* A token the server no longer knows is already gone. */ }
  agent.sessionToken = null
}
// When a run ends nothing will resume its sessions: whatever a provider keeps alive between turns (a Codex App Server
// thread) is closed. The injected `closeSession` is used when present, else the providers module's, only for its own runProvider.
function closeSessions(runtime, run) {
  const close = runtime.closeSession || (runtime.runProvider === defaultRunProvider && typeof providers.closeSession === 'function' ? providers.closeSession : null)
  if (!close) return
  for (const agent of run.agentNodes.values()) {
    if (!agent.sessionId) continue
    try { Promise.resolve(close(agent.sessionId)).catch(() => {}) } catch { /* Closing is best effort. */ }
  }
}
// Which provider transport an agent gets: the injected decision, else providers.transportFor when that build has it
// and the providers module's own runProvider is in use (it describes what that runProvider does; a custom runProvider,
// a test's fake or an embedder's adapter, speaks the envelope unless it injects its own decision), else the envelope.
// The escape hatch forces the envelope everywhere; an MCP server that failed to start does too.
function decideTransport(runtime, run, providerId, model) {
  if (process.env.ORBIT_LEGACY_ENVELOPE === '1' || runtime.mcp === false) return 'envelope'
  const builtIn = runtime.runProvider === defaultRunProvider && typeof providers.transportFor === 'function' ? providers.transportFor : null
  const decide = runtime.transportFor || builtIn
  if (!decide) return 'envelope'
  try { return decide(providerId, { ...(run.providerOptions[providerId] || {}), accessMode: run.accessMode, approvalPolicy: run.approvalPolicy, model: model || '' }) === 'session' ? 'session' : 'envelope' }
  catch (error) { diagnostics(runtime, run, `transportFor ${providerId}`, error); return 'envelope' }
}
// The in-process MCP server, created on the first session and started once; `false` after a failure.
async function ensureMcp(runtime) {
  if (runtime.mcp === false) return null
  if (!runtime.mcp) {
    try { runtime.mcp = createMcpServer({ dispatch: (token, name, args) => runtime.dispatchMcp(token, name, args), approve: (token, request) => runtime.approveMcp(token, request), listTools: token => runtime.listToolsMcp(token) }) }
    catch (error) { runtime.mcpError = error; runtime.mcp = false; return null }
  }
  if (!runtime.mcpStarted) {
    const server = runtime.mcp
    runtime.mcpStarted = Promise.resolve().then(() => server.start?.()).then(() => server, error => { runtime.mcpError = error; runtime.mcp = false; runtime.mcpStarted = null; return null })
  }
  return runtime.mcpStarted
}
function mcpUrl(runtime) { const url = runtime.mcp && runtime.mcp !== false ? runtime.mcp.url : null; return typeof url === 'function' ? url.call(runtime.mcp) : url || null }
// The run and agent behind a session token (or a {runId, agentId} the server resolved itself); null when unknown.
function sessionFor(runtime, token) {
  const known = token && typeof token === 'object' ? token : runtime.sessions.get(String(token || ''))
  const run = known && runtime.runs.get(known.runId)
  const agent = run && run.agentNodes.get(known.agentId)
  return run && agent ? { run, agent } : null
}
// The tool registry (electron/tool-registry.mts) unless one was injected (null disables it); looked up once.
function registry(runtime) {
  if (runtime.toolRegistry === undefined) runtime.toolRegistry = toolRegistry
  return runtime.toolRegistry || null
}
// tools/list for one session: the registry's tools without root-only ones for workers and without writes in read-only mode.
function listToolsMcp(runtime, token) {
  const session = runtime.sessionFor(token)
  const registry = runtime.registry()
  if (!session || !registry) return []
  const { run, agent } = session
  const context = { root: agent.id === 'root', accessMode: run.accessMode }
  if (typeof registry.toolsFor === 'function') return registry.toolsFor(context)
  const rank = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
  return (Array.isArray(registry.TOOLS) ? registry.TOOLS : []).filter(tool => !tool.internal && (!tool.rootOnly || context.root) && (rank[tool.minAccess] ?? 0) <= (rank[run.accessMode] ?? 0))
}
// The MCP approve tool: the same user prompt as an envelope-mode approval; true allows.
async function approveMcp(runtime, token, request = {}) {
  const session = runtime.sessionFor(token)
  if (!session) return false
  const { run, agent } = session
  try { return await runtime.approve(run, agent, { tool: request.tool_name || request.tool || '', arguments: request.input ?? request.arguments ?? {}, toolUseId: request.tool_use_id }) }
  catch (error) { diagnostics(runtime, run, 'approveMcp', error, agent.id); return false }
}
// One Orbit tool call arriving over MCP while the agent's provider turn runs. Executed exactly as an envelope call
// (ledger, work log, file activity, change capture, traces, transcript), with the model slot released around a
// waiting tool. Never throws: the result carries `ok`, the observation text and the agent's unread-mail count, which
// the server appends as a suffix.
async function dispatchMcp(runtime, token, name, args = {}) {
  const session = runtime.sessionFor(token)
  if (!session) return { ok: false, error: 'Unknown or expired Orbit session token', text: JSON.stringify({ ok: false, error: 'Unknown or expired Orbit session token' }), unread: 0 }
  const { run, agent } = session
  const refuse = error => ({ ok: false, error, observation: { ok: false, error }, text: JSON.stringify({ ok: false, error }), unread: runtime.pendingMail(run, agent).length })
  if (TERMINAL.has(run.status) || AGENT_TERMINAL.has(agent.status)) return refuse('This agent is no longer active')
  const signal = runtime.agentSignal(run, agent)
  if (signal.aborted) return refuse('Run cancelled')
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : null
  const call = { id: randomUUID(), name: String(name || ''), arguments: raw ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null)) : { __invalidArguments: true } }
  const turn = agent.activeTurn
  if (turn) turn.timing.orbitToolCalls++
  runtime.trace(run, agent.id, 'tool', `${call.name} ${bounded(call.arguments, 1200)}`)
  const waits = WAIT_TOOLS.has(call.name)
  if (waits && turn?.slot.held) { turn.slot.held = false; runtime.releaseTurn(run) }
  let observation, failure = null
  try {
    if (call.arguments.__invalidArguments) throw new Error('Tool arguments must be a JSON object')
    const check = runtime.registry()?.validate?.(call.name, call.arguments)
    if (check && check.ok === false) throw new Error(check.error || 'Invalid tool arguments')
    observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments), agent)
  } catch (error) {
    failure = error.message
    observation = { ok: false, error: failure }
  } finally {
    if (waits && turn && !turn.slot.held && !signal.aborted) {
      // The slot is taken back before the result goes to the model; a turn that ended meanwhile does not keep it.
      await runtime.acquireTurn(run, agent).then(() => {
        if (agent.activeTurn === turn) { turn.slot.held = true; runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing' }) }
        else runtime.releaseTurn(run)
      }, () => {})
    }
  }
  if (!failure && observation?.ok !== false && MUTATING_TOOLS.has(call.name)) {
    if (turn) turn.changed = true
    if (WORK_TOOLS.has(call.name)) agent.workDone++
  }
  runtime.recordLedger(agent, call.name, `#${agent.turns} ${describeCall(call, observation, failure, id => run.agentNodes.get(id)?.name || id)}`)
  const text = bounded(observation, call.name === 'capability_read' ? Math.max(run.limits.maxOutputChars, SKILL_READ_CHARS) : run.limits.maxOutputChars)
  runtime.remember(agent, { type: 'tool_result', tool_call_id: call.id, name: call.name, result: text, via: 'mcp' })
  runtime.trimTranscript(run, agent)
  runtime.trace(run, agent.id, 'observation', `${call.name}: ${bounded(observation, 4000)}`)
  return { ok: !failure, observation, error: failure, text, unread: TERMINAL.has(run.status) ? 0 : runtime.pendingMail(run, agent).length }
}
// Stops the MCP server (if one was started) so the app can quit without an open port; pending session tokens are dropped.
async function shutdown(runtime) {
  const server = runtime.mcp && runtime.mcp !== false ? runtime.mcp : null
  runtime.sessions.clear()
  runtime.mcpStarted = null
  if (!server) return
  try { await server.stop?.() } catch { /* Quitting anyway. */ }
}

export { prepareSession, releaseSession, closeSessions, decideTransport, ensureMcp, mcpUrl, sessionFor, registry, listToolsMcp, approveMcp, dispatchMcp, shutdown }
