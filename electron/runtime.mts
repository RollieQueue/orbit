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
//   mailbox    team correspondence: send, read, wait, notices, ask_team, the user's messages, the prompt's mail block
//   changes    file activity, change capture, attributed commands, index readiness
//   turn       one provider turn and its event stream (buffers, streaming, usage, timings)
//   handover   subscription failover as applied to an agent (preflight, handover, recovery), a new helper's model by kind
//   isolation  helpers in their own git worktree copies: making the copy, merging it back, taking it away
//   loops      executeAgent, the envelope loop (loop guard, poll budget) and the session loop (post-answer checks)
//   session    transport choice, the MCP server, tokens, tools/list, approve and tools/call handlers
//   tools      executeTool: approval gate, shared notes, improvement plan, workspace, index and team tools
//   knowledge  memory, skills and model-assessment tools, memory usage marks
//   restart    restart_orbit (the restart host runs the self-upgrade script) and the environment that names an agent's run
import * as providers from './providers.mts'
import { ProjectIndex } from './project-index.mts'
import { parseResponse } from './runtime/envelope.mts'
import * as store from './runtime/store.mts'
import * as lifecycle from './runtime/lifecycle.mts'
import * as agents from './runtime/agents.mts'
import * as pause from './runtime/pause.mts'
import * as mailbox from './runtime/mailbox.mts'
import * as changes from './runtime/changes.mts'
import * as prompts from './runtime/prompts.mts'
import * as ledger from './runtime/ledger.mts'
import * as turn from './runtime/turn.mts'
import * as handovers from './runtime/handover.mts'
import * as isolation from './runtime/isolation.mts'
import * as loops from './runtime/loops.mts'
import * as session from './runtime/session.mts'
import * as tools from './runtime/tools.mts'
import * as knowledge from './runtime/knowledge.mts'
import * as restart from './runtime/restart.mts'
import type { RestartHost } from './resume.mts'
import type { MergedFile } from './agent-worktree.mts'
import type {
  AgentRecord, AgentRef, AgentResult, ApprovalHandler, Attachment, ApprovalRequest, CapabilityStoreLike, CatalogLike, ChangeDescription, ChangeInput,
  CloseSession, Communication, CommunicationDelivery, CommunicationStatus, ContextStoreLike, FileAction, FileWrite, HandoverRequest,
  McpApproveRequest, McpServerLike, MemoryEntry, MemoryStoreLike, OrbitRuntimeLike, OrbitRuntimeOptions, ProjectIndexLike, PromptBase,
  ProviderEvent, QuotaMonitorLike, RestartMark, RunProvider, RunRecord, RunStoreLike, RuntimeEventData, RuntimeListener, SessionInfo, SessionRef,
  StartPayload, StreamState, ToolArgs, ToolRegistryLike, TraceImage, TranscriptEntry, TransportFor, WorkspaceContext,
} from './types.mts'
const { DEFAULT_LIMITS, normalizeLimits } = lifecycle
// Captured at load; session.mts compares an instance's runProvider against the same value. main.cjs passes the providers
// module's runProvider explicitly, so a smoke can substitute what main.cjs requires (scripts/smoke-desktop.cjs).
const defaultRunProvider: RunProvider = providers.runProvider
// What a session token names: the token itself, or the run and agent it was issued for.
type TokenRef = string | SessionRef | null | undefined

class OrbitRuntime implements OrbitRuntimeLike {
  // Filled by the constructor through Object.assign, so declared rather than initialised (an initialiser would run first).
  declare runProvider: RunProvider
  declare memoryStore: MemoryStoreLike | null
  declare capabilityStore: CapabilityStoreLike | null
  declare runStore: RunStoreLike | null
  declare requestApproval: ApprovalHandler | null
  declare clock: () => number
  declare projectIndex: ProjectIndexLike | null
  declare quota: QuotaMonitorLike | null
  declare catalog: CatalogLike | null
  declare contextStore: ContextStoreLike | null
  declare sharing: Map<string, boolean>
  declare lastShare: number
  declare mcp: McpServerLike | null | false
  declare mcpStarted: Promise<McpServerLike | null> | null
  declare mcpError: Error | null
  declare transportFor: TransportFor | null
  declare closeSession: CloseSession | null
  declare toolRegistry: ToolRegistryLike | null | undefined
  declare sessions: Map<string, SessionRef>
  declare restartHost: RestartHost | null
  declare worktreeRoot: string | null
  declare runs: Map<string, RunRecord>
  declare listeners: Set<RuntimeListener>
  // `clock` is injectable so tests can exercise time-dependent rules without real sleeping.
  // `quota` (a QuotaMonitor) enables subscription failover; `catalog(providerOptions)` lists the providers a replacement may come from.
  // `mcp` (an MCP server: start/url/issueToken/revoke), `transportFor(providerId, options)` and `registry` (the tool
  // registry) are injectable for tests; by default they come from electron/mcp-server.mts, providers.mts and
  // electron/tool-registry.mts (the server is created on the first session); without a server every agent uses the envelope loop.
  // `restartHost` (resume.mts createRestartHost, or a test's fake) runs the self-upgrade script for restart_orbit.
  // `worktreeRoot` is the folder isolated helpers' git copies are made under (<userData>/worktrees from the runtime host).
  constructor({ runProvider = defaultRunProvider, memoryStore = null, capabilityStore = null, runStore = null, requestApproval = null, clock = Date.now, projectIndex = new ProjectIndex({ clock }), quota = null, catalog = null, mcp = null, transportFor = null, closeSession = null, registry = undefined, restartHost = null, worktreeRoot = null }: OrbitRuntimeOptions = {}) {
    Object.assign(this, { runProvider, memoryStore, capabilityStore, runStore, requestApproval, clock, projectIndex, quota, catalog, contextStore: null, sharing: new Map(), lastShare: -Infinity })
    Object.assign(this, { mcp, mcpStarted: null, mcpError: null, transportFor, closeSession, toolRegistry: registry, sessions: new Map(), restartHost, worktreeRoot })
    this.runs = new Map(); this.listeners = new Set()
  }
  setQuota(monitor: QuotaMonitorLike | null) { this.quota = monitor }
  setCatalog(catalog: CatalogLike | null) { this.catalog = catalog }
  onEvent(listener: RuntimeListener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setProjectIndex(index: ProjectIndexLike | null) { this.projectIndex = index }
  setMemoryStore(store: MemoryStoreLike | null) { this.memoryStore = store }
  setCapabilityStore(store: CapabilityStoreLike | null) { this.capabilityStore = store }
  setRunStore(store: RunStoreLike | null) { this.runStore = store }
  setContextStore(store: ContextStoreLike | null) { this.contextStore = store }
  // Compatibility for old IPC callers; every message now enters the same agent loop.
  async routeMessage() { return { kind: 'task', reply: '' } }
  // ---- store: snapshots, persistence, events, traces, messages ----
  getRun(id: string) { return store.getRun(this, id) }
  getRuns() { return store.getRuns(this) }
  snapshot(run: RunRecord) { return store.snapshot(this, run) }
  getRunChanges(runId: string) { return store.getRunChanges(this, runId) }
  persist(run: RunRecord) { return store.persist(this, run) }
  persistenceError(run: RunRecord, error: Error) { return store.persistenceError(this, run, error) }
  schedulePersist(run: RunRecord, delay?: number) { return store.schedulePersist(this, run, delay) }
  emit(run: RunRecord, type: string, data?: RuntimeEventData, persist?: boolean) { return store.emit(this, run, type, data, persist) }
  trace(run: RunRecord, agentId: string, kind: string, text: string, id?: string, images?: TraceImage[]) { return store.trace(this, run, agentId, kind, text, id, images) }
  updateAgent(run: RunRecord, agent: AgentRecord, patch: Partial<AgentRecord>, persist?: boolean) { return store.updateAgent(this, run, agent, patch, persist) }
  message(run: RunRecord, agent: AgentRecord, text: string, kind?: string) { return store.message(this, run, agent, text, kind) }
  pruneRuns() { return store.pruneRuns(this) }
  // ---- lifecycle: a run from start to end ----
  start(payload?: StartPayload) { return lifecycle.start(this, payload) }
  previousRuns(run: RunRecord) { return lifecycle.previousRuns(this, run) }
  finishRun(run: RunRecord, result: AgentResult) { return lifecycle.finishRun(this, run, result) }
  setSharing(workspace: unknown, enabled: unknown) { return lifecycle.setSharing(this, workspace, enabled) }
  maintainKnowledge(run: RunRecord) { return lifecycle.maintainKnowledge(this, run) }
  failRun(run: RunRecord, error: Error) { return lifecycle.failRun(this, run, error) }
  cancelAgents(run: RunRecord, detail: string) { return lifecycle.cancelAgents(this, run, detail) }
  stop(runId: string) { return lifecycle.stop(this, runId) }
  pauseAgent(runId: string, agentId: string) { return pause.pauseAgent(this, runId, agentId) }
  resumeAgent(runId: string, agentId: string) { return pause.resumeAgent(this, runId, agentId) }
  stopAgent(runId: string, agentId: string) { return pause.stopAgent(this, runId, agentId) }
  markRestarting(runId: string, mark?: RestartMark) { return lifecycle.markRestarting(this, runId, mark) }
  // ---- restart: restart_orbit's host ----
  setRestartHost(host: RestartHost | null) { return restart.setRestartHost(this, host) }
  // ---- agents: the tree, scheduling, slots, completion ----
  createAgent(run: RunRecord, parent: AgentRecord | null, spec: ToolArgs, extra?: Partial<AgentRecord>) { return agents.createAgent(this, run, parent, spec, extra) }
  scheduleAgent(run: RunRecord, agent: AgentRecord) { return agents.scheduleAgent(this, run, agent) }
  spawnSubAgent(runId: string, parentId: string, spec?: ToolArgs) { return agents.spawnSubAgent(this, runId, parentId, spec) }
  resolveAgent(run: RunRecord, reference: unknown) { return agents.resolveAgent(this, run, reference) }
  resultKey(agent: { id: string; generation: number }) { return agents.resultKey(this, agent) }
  followupAgent(run: RunRecord, sender: AgentRecord, args: ToolArgs) { return agents.followupAgent(this, run, sender, args) }
  acquireTurn(run: RunRecord, agent: AgentRecord) { return agents.acquireTurn(this, run, agent) }
  releaseTurn(run: RunRecord) { return agents.releaseTurn(this, run) }
  agentSignal(run: RunRecord, agent: { id: string }) { return agents.agentSignal(this, run, agent) }
  teamDigest(run: RunRecord, agent: AgentRecord) { return agents.teamDigest(this, run, agent) }
  agentDirectory(run: RunRecord) { return agents.agentDirectory(this, run) }
  cancelDescendants(run: RunRecord, agent: AgentRecord, detail: string) { return agents.cancelDescendants(this, run, agent, detail) }
  completeAgent(run: RunRecord, agent: AgentRecord, content: string, budgetLimited?: boolean, detail?: string, extra?: Partial<AgentRecord>) { return agents.completeAgent(this, run, agent, content, budgetLimited, detail, extra) }
  budgetHandoff(run: RunRecord, agent: AgentRecord) { return agents.budgetHandoff(this, run, agent) }
  stallHandoff(run: RunRecord, agent: AgentRecord, turns: number) { return agents.stallHandoff(this, run, agent, turns) }
  // ---- mailbox: team correspondence ----
  communicationsFor(run: RunRecord, agent: { id: string }, unreadOnly?: boolean) { return mailbox.communicationsFor(this, run, agent, unreadOnly) }
  pendingMail(run: RunRecord, agent: AgentRecord) { return mailbox.pendingMail(this, run, agent) }
  markCommunications(run: RunRecord, ids: string[], status: CommunicationStatus, delivery: CommunicationDelivery) { return mailbox.markCommunications(this, run, ids, status, delivery) }
  sendAgentMessage(run: RunRecord, sender: AgentRecord, args: ToolArgs) { return mailbox.sendAgentMessage(this, run, sender, args) }
  recordCommunication(run: RunRecord, sender: AgentRef, target: AgentRef, text: string, extra?: Partial<Communication>) { return mailbox.recordCommunication(this, run, sender, target, text, extra) }
  readAgentMessages(run: RunRecord, agent: AgentRecord, args?: ToolArgs) { return mailbox.readAgentMessages(this, run, agent, args) }
  waitForTeam(run: RunRecord, agent: AgentRecord, participants: { id: string }[], timeout?: number, signal?: AbortSignal, any?: boolean) { return mailbox.waitForTeam(this, run, agent, participants, timeout, signal, any) }
  waitAgentMessage(run: RunRecord, agent: AgentRecord, args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>) { return mailbox.waitAgentMessage(this, run, agent, args, signal, ready) }
  mailboxContext(run: RunRecord, agent: AgentRecord, held?: ReadonlySet<string>) { return mailbox.mailboxContext(this, run, agent, held) }
  askTeam(run: RunRecord, sender: AgentRecord, args: ToolArgs) { return mailbox.askTeam(this, run, sender, args) }
  postUserMessage(runId: string, agentId: string, text: unknown, attachments?: Attachment[]) { return mailbox.postUserMessage(this, runId, agentId, text, attachments) }
  userMail(run: RunRecord, agent: AgentRecord) { return mailbox.userMail(this, run, agent) }
  // ---- prompts: what an agent is told ----
  teamContext(run: RunRecord, agent: AgentRecord) { return prompts.teamContext(this, run, agent) }
  fileMapContext(run: RunRecord) { return prompts.fileMapContext(this, run) }
  context(run: RunRecord, agent: AgentRecord) { return prompts.context(this, run, agent) }
  promptForTurn(base: PromptBase, transcript: TranscriptEntry[], run: RunRecord, mailboxText?: string, agent?: AgentRecord | null) { return prompts.promptForTurn(this, base, transcript, run, mailboxText, agent) }
  resumePrompt(run: RunRecord, agent: AgentRecord, instruction: string, entries: TranscriptEntry[], mailboxText: string, lastWorkerTurn: boolean | undefined) { return prompts.resumePrompt(this, run, agent, instruction, entries, mailboxText, lastWorkerTurn) }
  toolGuide(run: RunRecord, agent: AgentRecord) { return prompts.toolGuide(this, run, agent) }
  // ---- changes: file activity, change capture, index readiness ----
  awaitIndex(run: RunRecord, options?: { refresh?: boolean; workspace?: string }) { return changes.awaitIndex(this, run, options) }
  publishFiles(run: RunRecord, agent: AgentRecord) { return changes.publishFiles(this, run, agent) }
  touchFile(run: RunRecord, agent: AgentRecord, target: string, action: FileAction) { return changes.touchFile(this, run, agent, target, action) }
  trackNativeFiles(run: RunRecord, agent: AgentRecord, event: ProviderEvent) { return changes.trackNativeFiles(this, run, agent, event) }
  captureChange(run: RunRecord, agent: AgentRecord, target: string, tool: string | undefined, describe: (first: boolean) => Promise<ChangeDescription>) { return changes.captureChange(this, run, agent, target, tool, describe) }
  drainChanges(run: RunRecord, ms?: number) { return changes.drainChanges(this, run, ms) }
  recordChange(run: RunRecord, agent: AgentRecord, input: ChangeInput) { return changes.recordChange(this, run, agent, input) }
  reportWrite(run: RunRecord, agent: AgentRecord, tool: string, change: FileWrite) { return changes.reportWrite(this, run, agent, tool, change) }
  reportMerge(run: RunRecord, agent: AgentRecord, file: MergedFile) { return changes.reportMerge(this, run, agent, file) }
  trackWorkspaceTool(run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, result: unknown) { return changes.trackWorkspaceTool(this, run, agent, name, args, result) }
  runTrackedCommand(run: RunRecord, agent: AgentRecord, args: ToolArgs, context: WorkspaceContext) { return changes.runTrackedCommand(this, run, agent, args, context) }
  // ---- tools and knowledge: Orbit tool execution ----
  approve(run: RunRecord, agent: AgentRecord, request: ApprovalRequest, signal?: AbortSignal) { return tools.approve(this, run, agent, request, signal) }
  executeTool(run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>) { return tools.executeTool(this, run, agent, name, args, signal, ready) }
  markMemoryUse(run: RunRecord, entries: MemoryEntry[]) { return knowledge.markMemoryUse(this, run, entries) }
  // ---- ledger: transcript and work log ----
  recordLedger(agent: AgentRecord, name: string, text: string) { return ledger.recordLedger(this, agent, name, text) }
  workLog(agent: AgentRecord) { return ledger.workLog(this, agent) }
  collectChildren(run: RunRecord, agent: AgentRecord, transcript: TranscriptEntry[]) { return ledger.collectChildren(this, run, agent, transcript) }
  remember(agent: AgentRecord, entry: TranscriptEntry) { return ledger.remember(this, agent, entry) }
  trimTranscript(run: RunRecord, agent: AgentRecord) { return ledger.trimTranscript(this, run, agent) }
  // ---- turn: one provider turn and its events ----
  notePartialTurn(agent: AgentRecord, event: ProviderEvent) { return turn.notePartialTurn(this, agent, event) }
  providerEvent(run: RunRecord, agent: AgentRecord, event: ProviderEvent) { return turn.providerEvent(this, run, agent, event) }
  flushProviderBuffer(run: RunRecord, key: string) { return turn.flushProviderBuffer(this, run, key) }
  noteTurnEvent(agent: AgentRecord, event: ProviderEvent) { return turn.noteTurnEvent(this, agent, event) }
  streamOutput(run: RunRecord, agent: AgentRecord, event: ProviderEvent) { return turn.streamOutput(this, run, agent, event) }
  flushStream(run: RunRecord, agent: AgentRecord, stream: StreamState) { return turn.flushStream(this, run, agent, stream) }
  recordUsage(run: RunRecord, agent: AgentRecord, usage: unknown) { return turn.recordUsage(this, run, agent, usage) }
  trackOperation<T>(run: RunRecord, operation: T | PromiseLike<T>, agent: { id: string }): Promise<Awaited<T>> { return turn.trackOperation(this, run, operation, agent) }
  providerTurn(run: RunRecord, agent: AgentRecord, prompt: string | (() => string), sessionOptions?: SessionInfo | null) { return turn.providerTurn(this, run, agent, prompt, sessionOptions) }
  // ---- handover: subscription failover, model routing ----
  failoverActive(run: RunRecord) { return handovers.failoverActive(this, run) }
  providerCatalog(run: RunRecord) { return handovers.providerCatalog(this, run) }
  preflightQuota(run: RunRecord, agent: AgentRecord) { return handovers.preflightQuota(this, run, agent) }
  handover(run: RunRecord, agent: AgentRecord, request: HandoverRequest) { return handovers.handover(this, run, agent, request) }
  recoverProvider(run: RunRecord, agent: AgentRecord, error: unknown) { return handovers.recoverProvider(this, run, agent, error) }
  routeSpawn(run: RunRecord, parent: AgentRecord, spec: ToolArgs) { return handovers.routeSpawn(this, run, parent, spec) }
  // ---- isolation: helpers in their own git worktree copies ----
  prepareIsolation(run: RunRecord, parent: AgentRecord, kind: string) { return isolation.prepareIsolation(this, run, parent, kind) }
  discardIsolation(run: RunRecord, agentId: string) { return isolation.discardIsolation(this, run, agentId) }
  mergeIsolated(run: RunRecord, agent: AgentRecord) { return isolation.mergeIsolated(this, run, agent) }
  cleanupIsolation(run: RunRecord) { return isolation.cleanupIsolation(this, run) }
  sweepIsolation() { return isolation.sweepIsolation(this) }
  // ---- loops: running an agent to its result ----
  executeAgent(run: RunRecord, agent: AgentRecord) { return loops.executeAgent(this, run, agent) }
  envelopeLoop(run: RunRecord, agent: AgentRecord, signal: AbortSignal) { return loops.envelopeLoop(this, run, agent, signal) }
  sessionLoop(run: RunRecord, agent: AgentRecord, signal: AbortSignal) { return loops.sessionLoop(this, run, agent, signal) }
  wakeInstruction(pending: TranscriptEntry[], mailboxText: string, fromUser?: boolean) { return loops.wakeInstruction(this, pending, mailboxText, fromUser) }
  // ---- session: transport, MCP server, tokens, MCP handlers ----
  prepareSession(run: RunRecord, agent: AgentRecord) { return session.prepareSession(this, run, agent) }
  releaseSession(run: RunRecord, agent: AgentRecord) { return session.releaseSession(this, run, agent) }
  closeSessions(run: RunRecord) { return session.closeSessions(this, run) }
  decideTransport(run: RunRecord, providerId: string, model: string) { return session.decideTransport(this, run, providerId, model) }
  ensureMcp() { return session.ensureMcp(this) }
  mcpUrl() { return session.mcpUrl(this) }
  sessionFor(token: TokenRef) { return session.sessionFor(this, token) }
  registry() { return session.registry(this) }
  listToolsMcp(token: TokenRef) { return session.listToolsMcp(this, token) }
  approveMcp(token: TokenRef, request?: McpApproveRequest) { return session.approveMcp(this, token, request) }
  dispatchMcp(token: TokenRef, name: string, args?: unknown) { return session.dispatchMcp(this, token, name, args) }
  shutdown() { return session.shutdown(this) }
}
export { OrbitRuntime, DEFAULT_LIMITS, normalizeLimits, parseResponse }
