// @ts-nocheck
// OrbitRuntime: the facade over electron/runtime/*. It owns the runtime's state (runs, listeners, stores, the MCP
// server) and keeps the public surface (constructor options, methods, events) that main.cjs, the scripts and the tests
// use; every method delegates to a module function that receives this instance first and calls back only through
// these public methods. The module map:
//   util       shared helpers and constants, the `diagnostic` trace
//   envelope   the JSON tool envelope: parsing a model response into content and tool calls
//   prompts    every text an agent is told (tool guide, session block, reminders) and the per-turn prompt assembly
//   ledger     transcript, work log and the collection of helper results
//   store      snapshots, coalesced persistence, events, traces, agent updates, chat messages
//   lifecycle  start, finish, fail, stop, earlier turns of the chat, knowledge housekeeping
//   agents     the agent tree: creation, scheduling, follow-ups, signals, slots, completion, cancellation
//   mailbox    team correspondence: send, read, wait, notices, ask_team, the prompt's mail block
//   changes    file activity, change capture, attributed commands, index readiness
//   turn       one provider turn and its event stream (buffers, streaming, usage, timings)
//   handover   subscription failover as applied to an agent (preflight, handover, recovery)
//   loops      executeAgent, the envelope loop (loop guard, poll budget) and the session loop (post-answer checks)
//   session    transport choice, the MCP server, tokens, tools/list, approve and tools/call handlers
//   tools      executeTool: approval gate, shared notes, improvement plan, workspace, index and team tools
//   knowledge  memory, skills and model-assessment tools, memory usage marks
import * as providers from './providers.mts'
import { ProjectIndex } from './project-index.mts'
import { parseResponse } from './runtime/envelope.mts'
import * as store from './runtime/store.mts'
import * as lifecycle from './runtime/lifecycle.mts'
import * as agents from './runtime/agents.mts'
import * as mailbox from './runtime/mailbox.mts'
import * as changes from './runtime/changes.mts'
import * as prompts from './runtime/prompts.mts'
import * as ledger from './runtime/ledger.mts'
import * as turn from './runtime/turn.mts'
import * as handovers from './runtime/handover.mts'
import * as loops from './runtime/loops.mts'
import * as session from './runtime/session.mts'
import * as tools from './runtime/tools.mts'
import * as knowledge from './runtime/knowledge.mts'
const { DEFAULT_LIMITS, normalizeLimits } = lifecycle
// Captured at load; session.mts compares an instance's runProvider against the same value. main.cjs passes the providers
// module's runProvider explicitly, so a smoke can substitute what main.cjs requires (scripts/smoke-desktop.cjs).
const defaultRunProvider = providers.runProvider

class OrbitRuntime {
  // `clock` is injectable so tests can exercise time-dependent rules without real sleeping.
  // `quota` (a QuotaMonitor) enables subscription failover; `catalog(providerOptions)` lists the providers a replacement may come from.
  // `mcp` (an MCP server: start/url/issueToken/revoke), `transportFor(providerId, options)` and `registry` (the tool
  // registry) are injectable for tests; by default they come from electron/mcp-server.mts, providers.mts and
  // electron/tool-registry.mts (the server is created on the first session); without a server every agent uses the envelope loop.
  constructor({ runProvider = defaultRunProvider, memoryStore = null, capabilityStore = null, runStore = null, requestApproval = null as null | ((request: any) => Promise<boolean> | boolean), clock = Date.now, projectIndex = new ProjectIndex({ clock }), quota = null, catalog = null, mcp = null, transportFor = null, closeSession = null, registry = undefined } = {}) {
    Object.assign(this, { runProvider, memoryStore, capabilityStore, runStore, requestApproval, clock, projectIndex, quota, catalog, contextStore: null, sharing: new Map(), lastShare: -Infinity })
    Object.assign(this, { mcp, mcpStarted: null, mcpError: null, transportFor, closeSession, toolRegistry: registry, sessions: new Map() })
    this.runs = new Map(); this.listeners = new Set()
  }
  setQuota(monitor) { this.quota = monitor }
  setCatalog(catalog) { this.catalog = catalog }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setProjectIndex(index) { this.projectIndex = index }
  setMemoryStore(store) { this.memoryStore = store }
  setCapabilityStore(store) { this.capabilityStore = store }
  setRunStore(store) { this.runStore = store }
  setContextStore(store) { this.contextStore = store }
  // Compatibility for old IPC callers; every message now enters the same agent loop.
  async routeMessage() { return { kind: 'task', reply: '' } }
  // ---- store: snapshots, persistence, events, traces, messages ----
  getRun(id) { return store.getRun(this, id) }
  getRuns() { return store.getRuns(this) }
  snapshot(run) { return store.snapshot(this, run) }
  getRunChanges(runId) { return store.getRunChanges(this, runId) }
  persist(run) { return store.persist(this, run) }
  persistenceError(run, error) { return store.persistenceError(this, run, error) }
  schedulePersist(run, delay) { return store.schedulePersist(this, run, delay) }
  emit(run, type, data, persist) { return store.emit(this, run, type, data, persist) }
  trace(run, agentId, kind, text, id) { return store.trace(this, run, agentId, kind, text, id) }
  updateAgent(run, agent, patch, persist) { return store.updateAgent(this, run, agent, patch, persist) }
  message(run, agent, text, kind) { return store.message(this, run, agent, text, kind) }
  pruneRuns() { return store.pruneRuns(this) }
  // ---- lifecycle: a run from start to end ----
  start(payload) { return lifecycle.start(this, payload) }
  previousRuns(run) { return lifecycle.previousRuns(this, run) }
  finishRun(run, result) { return lifecycle.finishRun(this, run, result) }
  setSharing(workspace, enabled) { return lifecycle.setSharing(this, workspace, enabled) }
  maintainKnowledge(run) { return lifecycle.maintainKnowledge(this, run) }
  failRun(run, error) { return lifecycle.failRun(this, run, error) }
  cancelAgents(run, detail) { return lifecycle.cancelAgents(this, run, detail) }
  stop(runId) { return lifecycle.stop(this, runId) }
  // ---- agents: the tree, scheduling, slots, completion ----
  createAgent(run, parent, spec) { return agents.createAgent(this, run, parent, spec) }
  scheduleAgent(run, agent) { return agents.scheduleAgent(this, run, agent) }
  spawnSubAgent(runId, parentId, spec) { return agents.spawnSubAgent(this, runId, parentId, spec) }
  resolveAgent(run, reference) { return agents.resolveAgent(this, run, reference) }
  resultKey(agent) { return agents.resultKey(this, agent) }
  followupAgent(run, sender, args) { return agents.followupAgent(this, run, sender, args) }
  acquireTurn(run, agent) { return agents.acquireTurn(this, run, agent) }
  releaseTurn(run) { return agents.releaseTurn(this, run) }
  agentSignal(run, agent) { return agents.agentSignal(this, run, agent) }
  teamDigest(run, agent) { return agents.teamDigest(this, run, agent) }
  agentDirectory(run) { return agents.agentDirectory(this, run) }
  cancelDescendants(run, agent, detail) { return agents.cancelDescendants(this, run, agent, detail) }
  completeAgent(run, agent, content, budgetLimited, detail, extra) { return agents.completeAgent(this, run, agent, content, budgetLimited, detail, extra) }
  budgetHandoff(run, agent) { return agents.budgetHandoff(this, run, agent) }
  stallHandoff(run, agent, turns) { return agents.stallHandoff(this, run, agent, turns) }
  // ---- mailbox: team correspondence ----
  communicationsFor(run, agent, unreadOnly) { return mailbox.communicationsFor(this, run, agent, unreadOnly) }
  pendingMail(run, agent) { return mailbox.pendingMail(this, run, agent) }
  markCommunications(run, ids, status, delivery) { return mailbox.markCommunications(this, run, ids, status, delivery) }
  sendAgentMessage(run, sender, args) { return mailbox.sendAgentMessage(this, run, sender, args) }
  recordCommunication(run, sender, target, text, extra) { return mailbox.recordCommunication(this, run, sender, target, text, extra) }
  readAgentMessages(run, agent, args) { return mailbox.readAgentMessages(this, run, agent, args) }
  waitForTeam(run, agent, participants, timeout) { return mailbox.waitForTeam(this, run, agent, participants, timeout) }
  waitAgentMessage(run, agent, args) { return mailbox.waitAgentMessage(this, run, agent, args) }
  mailboxContext(run, agent) { return mailbox.mailboxContext(this, run, agent) }
  askTeam(run, sender, args) { return mailbox.askTeam(this, run, sender, args) }
  // ---- prompts: what an agent is told ----
  teamContext(run, agent) { return prompts.teamContext(this, run, agent) }
  fileMapContext(run) { return prompts.fileMapContext(this, run) }
  context(run, agent) { return prompts.context(this, run, agent) }
  promptForTurn(base, transcript, run, mailboxText, agent) { return prompts.promptForTurn(this, base, transcript, run, mailboxText, agent) }
  resumePrompt(run, agent, instruction, entries, mailboxText, lastWorkerTurn) { return prompts.resumePrompt(this, run, agent, instruction, entries, mailboxText, lastWorkerTurn) }
  toolGuide(run, agent) { return prompts.toolGuide(this, run, agent) }
  // ---- changes: file activity, change capture, index readiness ----
  awaitIndex(run, options) { return changes.awaitIndex(this, run, options) }
  publishFiles(run, agent) { return changes.publishFiles(this, run, agent) }
  touchFile(run, agent, target, action) { return changes.touchFile(this, run, agent, target, action) }
  trackNativeFiles(run, agent, event) { return changes.trackNativeFiles(this, run, agent, event) }
  captureChange(run, agent, target, tool, describe) { return changes.captureChange(this, run, agent, target, tool, describe) }
  drainChanges(run, ms) { return changes.drainChanges(this, run, ms) }
  recordChange(run, agent, input) { return changes.recordChange(this, run, agent, input) }
  reportWrite(run, agent, tool, change) { return changes.reportWrite(this, run, agent, tool, change) }
  trackWorkspaceTool(run, agent, name, args, result) { return changes.trackWorkspaceTool(this, run, agent, name, args, result) }
  runTrackedCommand(run, agent, args, context) { return changes.runTrackedCommand(this, run, agent, args, context) }
  // ---- tools and knowledge: Orbit tool execution ----
  approve(run, agent, request, signal) { return tools.approve(this, run, agent, request, signal) }
  executeTool(run, agent, name, args) { return tools.executeTool(this, run, agent, name, args) }
  markMemoryUse(run, entries) { return knowledge.markMemoryUse(this, run, entries) }
  // ---- ledger: transcript and work log ----
  recordLedger(agent, name, text) { return ledger.recordLedger(this, agent, name, text) }
  workLog(agent) { return ledger.workLog(this, agent) }
  collectChildren(run, agent, transcript) { return ledger.collectChildren(this, run, agent, transcript) }
  remember(agent, entry) { return ledger.remember(this, agent, entry) }
  trimTranscript(run, agent) { return ledger.trimTranscript(this, run, agent) }
  // ---- turn: one provider turn and its events ----
  notePartialTurn(agent, event) { return turn.notePartialTurn(this, agent, event) }
  providerEvent(run, agent, event) { return turn.providerEvent(this, run, agent, event) }
  flushProviderBuffer(run, key) { return turn.flushProviderBuffer(this, run, key) }
  noteTurnEvent(agent, event) { return turn.noteTurnEvent(this, agent, event) }
  streamOutput(run, agent, event) { return turn.streamOutput(this, run, agent, event) }
  flushStream(run, agent, stream) { return turn.flushStream(this, run, agent, stream) }
  recordUsage(run, usage) { return turn.recordUsage(this, run, usage) }
  trackOperation(run, operation, agent) { return turn.trackOperation(this, run, operation, agent) }
  providerTurn(run, agent, prompt, sessionOptions) { return turn.providerTurn(this, run, agent, prompt, sessionOptions) }
  // ---- handover: subscription failover ----
  failoverActive(run) { return handovers.failoverActive(this, run) }
  providerCatalog(run) { return handovers.providerCatalog(this, run) }
  preflightQuota(run, agent) { return handovers.preflightQuota(this, run, agent) }
  handover(run, agent, request) { return handovers.handover(this, run, agent, request) }
  recoverProvider(run, agent, error) { return handovers.recoverProvider(this, run, agent, error) }
  // ---- loops: running an agent to its result ----
  executeAgent(run, agent) { return loops.executeAgent(this, run, agent) }
  envelopeLoop(run, agent, signal) { return loops.envelopeLoop(this, run, agent, signal) }
  sessionLoop(run, agent, signal) { return loops.sessionLoop(this, run, agent, signal) }
  wakeInstruction(pending, mailboxText) { return loops.wakeInstruction(this, pending, mailboxText) }
  // ---- session: transport, MCP server, tokens, MCP handlers ----
  prepareSession(run, agent) { return session.prepareSession(this, run, agent) }
  releaseSession(run, agent) { return session.releaseSession(this, run, agent) }
  closeSessions(run) { return session.closeSessions(this, run) }
  decideTransport(run, providerId, model) { return session.decideTransport(this, run, providerId, model) }
  ensureMcp() { return session.ensureMcp(this) }
  mcpUrl() { return session.mcpUrl(this) }
  sessionFor(token) { return session.sessionFor(this, token) }
  registry() { return session.registry(this) }
  listToolsMcp(token) { return session.listToolsMcp(this, token) }
  approveMcp(token, request) { return session.approveMcp(this, token, request) }
  dispatchMcp(token, name, args) { return session.dispatchMcp(this, token, name, args) }
  shutdown() { return session.shutdown(this) }
}
export { OrbitRuntime, DEFAULT_LIMITS, normalizeLimits, parseResponse }
