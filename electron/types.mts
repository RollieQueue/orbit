// Shared shapes of the main process: the run and agent records the runtime keeps, what a provider sends and returns,
// the stores the runtime consumes, the tool registry's entries and the runtime's own surface as its modules see it.
// Types only (every export is erased at load time), so any module can import from here at no cost. The shapes are
// the ones the code has today, derived from use; the store interfaces list exactly the methods the runtime calls, and
// the duck-typed alternatives the audit found (`recall` beside `list`/`search`, `save` beside `upsert`) are optional.
import type { SWITCH_TRANSPORT } from './runtime/loops.mts'

// ---- Enumerations -------------------------------------------------------------------------------------------------
export type AccessMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'never' | 'on-request' | 'auto-review'
export type Transport = 'session' | 'envelope'
// `restarting`: the run ended because Orbit restarted with new code at an agent's request; a new run continues it.
export type RunStatus = 'working' | 'completed' | 'failed' | 'cancelled' | 'restarting'
export type AgentStatus = 'waiting' | 'working' | 'paused' | 'done' | 'error' | 'cancelled'
export interface AgentControlResult { ok: true; agentId: string; status: AgentStatus; paused: boolean }
export type MemoryScope = 'chat' | 'project' | 'global'
export type MemoryProfile = 'project' | 'project-global'
export type SkillScope = 'project' | 'global'
export type ImprovementStatus = 'planning' | 'implementing' | 'completed' | 'blocked'
export type TaskStatus = 'pending' | 'working' | 'done' | 'blocked'
export type CommunicationKind = 'spawn' | 'followup' | 'message' | 'notice'
export type CommunicationStatus = 'queued' | 'delivered' | 'read'
// tool-result: the user's (or a supervisor's) message went to a session agent at the end of an Orbit tool result within its turn.
export type CommunicationDelivery = 'next-turn' | 'mailbox' | 'tool-result'
export type HandoverReason = 'exhausted' | 'approaching' | 'replacement-failed' | 'stalled' | 'failed'
export type FileAction = 'read' | 'write'

// ---- Limits, usage, timings ---------------------------------------------------------------------------------------
export interface RunLimits {
  maxAgents: number | null; maxDepth: number | null; maxConcurrent: number | null; maxTurns: number | null; maxTotalTurns: number | null
  maxMessages: number | null; maxToolCalls: number | null; maxOutputChars: number; maxContextChars: number; timeoutMs: number | null; runTimeoutMs: number | null
}
// What a start payload may say about the limits: raw values, normalised by `normalizeLimits`.
export type LimitsInput = Partial<Record<keyof RunLimits | 'maxConcurrency', unknown>>
export interface Usage { providerTurns: number; workerTurns: number; inputTokens: number | null; outputTokens: number | null; cachedInputTokens?: number; promptChars?: number }
// Token figures as vendors report them (several spellings), read by `recordUsage`.
export interface UsageFigures {
  input_tokens?: number; prompt_tokens?: number; output_tokens?: number; completion_tokens?: number
  cached_input_tokens?: number; cache_read_tokens?: number; cache_read_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }
  // No index signature: a provider's `usage` is unknown, and recordUsage takes it once narrowed to an object (every
  // field is optional and read through Number(), so any object is acceptable).
}
export interface TurnTiming {
  turn: number; transport: Transport; startedAt: string; firstEventAt: string | null; endedAt: string | null
  promptChars: number; nativeToolCalls: number; orbitToolCalls: number; sessionId: string | null
  // While the model thinks: the provider's estimate of the thinking block so far, in tokens (turn.mts noteThinking).
  // Live only: it goes when the thinking or the turn ends.
  thinking?: number
}

// ---- Records a run publishes --------------------------------------------------------------------------------------
// `images`: what a tool result showed the agent (a screenshot it read), saved by the run store; the trace names them.
export interface Trace { id: string; agentId: string; agentName: string; kind: string; text: string; time: string; images?: TraceImage[] }
// A saved image: its file name under the run's image folder (RunStore.saveImage), its type and size in bytes.
export interface TraceImage { id: string; mediaType: string; bytes: number }
// An image as a provider's tool result carried it: base64 bytes and the media type.
export interface ToolImage { mediaType: string; data: string }
export interface Message { id: string; agentId: string; generation: number; author: 'orbit'; text: string; kind: string; model: string; client: string; lane: string; time: string }
export interface MessageRoute { via: string; reasons: string[] }
export interface Communication {
  id: string; fromAgentId: string; toAgentId: string; fromAgentName: string; toAgentName: string; text: string; time: string
  status: CommunicationStatus; delivery: CommunicationDelivery; kind?: CommunicationKind; reason?: string; via?: string; route?: MessageRoute
  replyTo?: string; discussionId?: string; deliveredAt?: string; readAt?: string
  // Files the user attached to the message (electron/attachments.mts).
  attachments?: Attachment[]
  // Router notices: whose write it reports, which files, and whether the reader had changed them too.
  about?: string; aboutName?: string; paths?: string[]; conflict?: boolean
}
export interface NoticeCommunication extends Communication { kind: 'notice'; about: string; paths: string[]; conflict: boolean }
export interface RunSummary { text?: string; agentCount: number; providerTurns: number; limitedAgents: string[] }
export interface RouterStats { routed: number; notices: number; refused: number }
export interface ImprovementTask { id: string; title: string; status: TaskStatus; evidence: string }
export interface ImprovementTaskInput { id?: string; title?: string; status?: string; evidence?: string }
export interface HistoryEntry { role: 'user' | 'assistant'; content: string }
// A chat message as the renderer sends it: old records carry `author`/`text` instead of `role`/`content`.
export interface HistoryInput { role?: string; author?: string; content?: unknown; text?: unknown }

// ---- Files and changes --------------------------------------------------------------------------------------------
export interface AgentFiles { read: string[]; wrote: string[] }
export interface FileTouch { path: string; action: FileAction; isNew: boolean }
export interface FilePeer { agentId: string; how: string }
export interface SharedFile { path: string; readers: Set<string>; writers: Set<string>; at?: string }
export interface FileActivitySnapshot { path: string; readers: string[]; writers: string[] }
// `before` is null when the write created the file.
export interface FileWrite { path: string; before: string | null; after: string }
export type ChangeKind = 'create' | 'modify' | 'delete' | 'unknown'
// Where a diff came from: Orbit's own file tools ('exact'), a vendor tool's events ('event') or Git ('git').
export type ChangeSource = 'exact' | 'event' | 'git'
// One file change of a run, as the run snapshot persists it and the Changes tab shows it (change-log.mts makes them).
export interface FileChange {
  id: string; agentId: string; path: string; kind: ChangeKind; tool: string; time: string; added: number; removed: number
  source: ChangeSource; hasDiff: boolean; diff?: string; truncated?: boolean; binary?: boolean
  // Why there is no diff text (a change-log REASONS value); for a recovered change, the short commit the diff is relative to.
  reason?: string; base?: string
}
// What a change record is made from: a tool's exact texts, an event's diff, or Git's answer, plus the reason when none.
export interface ChangeDescription {
  kind?: ChangeKind; source: ChangeSource; before?: string | null; after?: string | null; diff?: string
  added?: number; removed?: number; truncated?: boolean; binary?: boolean; reason?: string
}
export interface ChangeInput extends ChangeDescription { path: string; tool?: string }
// A vendor file change inside a native tool event (Codex `changes`).
export interface NativeChange { path?: string; kind?: string; diff?: string; [extra: string]: unknown }
// What a native tool call's events said about the edit so far (ChangeLog.remember returns change-log's CallRecord).
export type NativeCallEntry = import('./change-log.mts').CallRecord
export interface IndexDiff { total?: number; added: string[]; changed: string[]; removed: string[]; fresh?: boolean }
// The index's own hit and outline (project-index.mts SearchHit, Outline): the runtime passes them on as they are.
export type IndexHit = import('./project-index.mts').SearchHit
export interface IndexSearchResult { indexed?: number; results: IndexHit[] }
export type IndexOutline = import('./project-index.mts').Outline

// ---- Tools: calls, arguments, observations ------------------------------------------------------------------------
// The arguments of any Orbit tool, as the registry schema declares them. One bag for every tool: the same name means
// the same thing everywhere (`limit`, `agentId`, `query`). MCP calls are validated by the registry before they get
// here; the envelope path is not, so every callee keeps its coercions. `route` and `discussionId` are added by the
// broadcast and ask_team paths; `__invalidArguments` marks a call whose arguments were not a JSON object.
export interface ToolArgs {
  task?: string; name?: string; reason?: string; kind?: string; providerId?: string; model?: string; reasoningEffort?: string; memoryProfile?: string; continueFrom?: string; id?: string
  agentId?: string; agentIds?: string[]; timeout_ms?: number; message?: string; replyTo?: string; discussionId?: string; route?: MessageRoute
  afterId?: string; limit?: number; unread_only?: boolean; topic?: string; files?: string[]; query?: string; path?: string; runId?: string; agent?: string
  start_line?: number; recursive?: boolean; content?: string; old_text?: string; new_text?: string; command?: string; args?: string[]; cwd?: string
  title?: string; scope?: string; type?: string; confidence?: number; outcome?: string; note?: string; description?: string; whenToUse?: string; instructions?: string; source?: string
  key?: string; summary?: string; status?: string; tasks?: ImprovementTaskInput[]; taskType?: string; assessment?: string; evidence?: string
  continueWith?: string; verify?: boolean; handoff?: string
  __invalidArguments?: boolean
  [extra: string]: unknown
}
export interface ToolCall { id: string; name: string; arguments: ToolArgs }
// A parsed envelope: the model's prose and the calls it made.
export interface ParsedResponse { content: string; calls: ToolCall[] }
// What a tool returned: JSON of a shape that depends on the tool, read only where the tool name is known.
export type Observation = unknown
// A tool result as the transcript keeps it (the observation, bounded, as text).
export interface ToolResultEntry { type: 'tool_result'; tool_call_id: string; name: string; result: string; note?: string; via?: 'mcp' }
export interface AssistantEntry { type: 'assistant'; content: string; tool_calls: ToolCall[]; via?: 'session' }
export interface InstructionEntry { type: 'instruction'; content: string; via?: 'session' }
export interface ChildResultEntry { type: 'child_result'; agentId: string; generation: number; status: AgentStatus; result: string; error: string | null; budgetLimited: boolean }
export interface FollowupTaskEntry { type: 'followup_task'; generation: number; task: string; from: string }
export interface AssistantFinalEntry { type: 'assistant_final'; generation: number; content: string; budgetLimited: boolean }
export interface HandoverEntry { type: 'handover'; content: string }
export type TranscriptEntry = ToolResultEntry | AssistantEntry | InstructionEntry | ChildResultEntry | FollowupTaskEntry | AssistantFinalEntry | HandoverEntry
export interface LedgerEntry { name: string; text: string }
export interface PreviousWork { generation: number; task: string; result: string; error: string | null; files?: AgentFiles }

// ---- Agents -------------------------------------------------------------------------------------------------------
// Whoever can send or receive a communication: an agent, the user, or the router.
export interface AgentRef { id: string; name: string }
export interface ModelTarget { providerId: string; model: string; reasoningEffort?: string }
export interface PoolMember { providerId: string; model: string; reasoningEffort?: string }
export interface HandoverRecord {
  id: string; time: string; reason: HandoverReason; from: ModelTarget; to: ModelTarget; fresh: boolean
  usedPercent: number | null; resetsAt: number | null; interrupted: boolean; note?: string
  // Turns the agent had completed when it switched (absent in records saved before this was kept).
  turn?: number
}
// One model that really worked for an agent (see agents.modelsWorked): `turns` is a human range such as 'turns 1–3'.
export interface WorkedModel { label: string; providerId: string; model: string; turns?: string }
export interface InterruptedTurn { text: string; actions: string[] }
export interface PartialTurn { messages: Map<string, string>; tools: Map<string, string> }
export interface StreamState { messageId: string; parts: Map<string, string>; lastAt: number; timer: ReturnType<typeof setTimeout> | null; dirty: boolean }
export interface TurnSlot { held: boolean }
export interface ActiveTurn { slot: TurnSlot; timing: TurnTiming; changed: boolean; nativeSeen: Set<string>; stream: StreamState | null; delivered: Set<string>; signal: AbortSignal; interrupt: (reason?: import('./runtime/pause.mts').InterruptReason) => void; watch?: import('./runtime/watchdog.mts').TurnWatch | null }
// An answer kept while an optional extra turn runs, and the ids of the user's messages the model had read when it wrote it.
export interface DraftAnswer { text: string; read: Set<string> }
export interface AgentRecord {
  paused?: boolean; pausedAt?: string | null; stoppedByUser?: boolean; pausedSession?: string | null
  id: string; parentId: string | null; depth: number; name: string; role: string; task: string; reason: string
  providerId: string; model: string; memoryProfile: MemoryProfile; reasoningEffort: string; requestedModel: string
  status: AgentStatus; progress: number; detail: string; startedAt: string | null; finishedAt: string | null; result: string; error: string | null
  turns: number; generation: number; inbox: unknown[]; seenChildren: Set<string>; transcript: TranscriptEntry[]; transcriptChars: number
  previousWork: PreviousWork[]; ledger: LedgerEntry[]; ledgerDropped: Record<string, number>
  files: AgentFiles; workDone: number
  handovers: HandoverRecord[]; failedCandidates: Set<string>; trial: { key: string } | null; partialTurn: PartialTurn | null; quotaWarned: string
  transport: Transport; sessionId: string | null; sessionToken: string | null; sessionCursor: number; turnTimings: TurnTiming[]; activeTurn: ActiveTurn | null; stream: StreamState | null
  // The secret mark of the user's and a supervisor's messages to this agent (util.mailTag).
  mailMark: string
  // Set later in an agent's life: the answer kept for an optional extra turn, the limit and loop-guard marks, prompt size.
  draftAnswer?: DraftAnswer | null; budgetLimited?: boolean; stalled?: boolean; promptChars?: number
}
// The fields that stay inside the runtime; snapshots and events carry the rest (util.INTERNAL_AGENT_FIELDS).
export type InternalAgentField = 'inbox' | 'seenChildren' | 'requestedModel' | 'transcript' | 'previousWork' | 'ledger' | 'ledgerDropped' | 'workDone' | 'failedCandidates' | 'trial' | 'partialTurn' | 'quotaWarned' | 'draftAnswer' | 'activeTurn' | 'stream' | 'sessionToken' | 'sessionCursor' | 'transcriptChars' | 'pausedSession' | 'mailMark'
export type PublicAgent = Omit<AgentRecord, InternalAgentField>
// What an agent's execution resolves to (completeAgent), or the error a scheduled agent ended with.
export interface AgentResult { agentId: string; generation: number; status: AgentStatus; result?: string; error?: string; budgetLimited?: boolean }
// spawn_agent {kind}: the model Orbit chose for that kind of work (`model` provider/model, null when none could take it)
// and the better candidates it passed over, with why.
export interface RoutedSpawn { kind: string; model: string | null; skipped?: string[]; note?: string }
export interface SpawnResult { ok: boolean; reason?: string; instruction?: string; reused?: boolean; agentId?: string; status?: AgentStatus; agent?: PublicAgent; routed?: RoutedSpawn }
export interface FollowupResult { ok: true; agentId: string; generation: number; status: AgentStatus }
export interface TeamDigest { running: string[]; finished: string[] }
export interface AgentDirectoryEntry {
  paused: boolean
  id: string; name: string; parentId: string | null; status: AgentStatus; generation: number; providerId: string; model: string; task: string
  result: string; resultTruncated?: boolean; fullResult?: string; error: string | null; budgetLimited: boolean
  ranOn?: string[]
}
export interface AgentController { controller: AbortController; parentSignal: AbortSignal | null; abort: () => void }
export interface TurnWaiter { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }
export interface ProviderBuffer { id: string; text: string; kind: string; agentId: string; timer: ReturnType<typeof setTimeout> | null; dirty: boolean }

// ---- Runs ---------------------------------------------------------------------------------------------------------
export interface FailoverConfig { enabled: boolean; switchAtPercent: number; allowWeaker: boolean }
export interface ProviderOptions { reasoningEffort?: string; command?: string; transport?: string; legacyEnvelope?: boolean; [extra: string]: unknown }
// A note as shared-context.mts writes it (project-context's ContextNote): `files` maps a path to its signature, null when missing.
export interface SharedNote { key: string; summary: string; files: Record<string, string | null>; updatedAt: string; stale?: boolean }
export interface SharedContext { notes?: SharedNote[]; updatedAt?: string }
export interface ProjectPacket { overview: unknown; notes: SharedNote[]; updatedAt?: string }
// No index signature: providers.mts ProviderHealth (an interface, the catalog main.cjs passes) must fit it.
export interface CatalogEntry { id: string; available?: boolean; models?: string[]; reasoningLevels?: Record<string, string[]> }
export interface RunRecord {
  pauseWaiters: Set<() => void>
  runId: string; projectId: string; chatId: string; prompt: string; workspace: string; providerId: string; model: string
  memoryEnabled: boolean; globalMemoryEnabled: boolean; memoryContext: MemoryEntry[]
  improvementMode: boolean; improvements: ImprovementTask[]; improvementStatus: ImprovementStatus
  providerOptions: Record<string, ProviderOptions>; providerPool: PoolMember[]; sharedContext: SharedContext; evaluations: Set<string>
  failover: FailoverConfig; models: Record<string, unknown>; catalogCache: { at: number; value: Promise<CatalogEntry[]> } | null; brokenProviders: Map<string, number>
  history: HistoryEntry[]; agentInstructions: string; accessMode: AccessMode; reasoningEffort: string; approvalPolicy: ApprovalPolicy
  status: RunStatus; startedAt: string; limits: RunLimits; contextExplicit: boolean; usage: Usage
  agentNodes: Map<string, AgentRecord>; agentControllers: Map<string, AgentController>; agentOperations: Map<string, Set<Promise<unknown>>>
  tasks: Map<string, Promise<AgentResult>>; traces: Trace[]; messages: Message[]; communications: Communication[]; messageWaiters: Map<string, Set<() => void>>; controller: AbortController
  activeTurns: number; turnQueue: TurnWaiter[]; operations: Set<Promise<unknown>>; providerBuffers: Map<string, ProviderBuffer>; finishedAt: string | null; summary: RunSummary | null; error: string | null
  fileActivity: FileActivityLike; changes: ChangeLogLike; changeQueue: Promise<void>; changePending: number; commands: { running: number; serial: number; writes: number }
  priorRuns: ChatRunView[]; priorDigest: string | null
  memoryTouched: Set<string>; skillUse: Map<string, { name: string; rated: boolean }>; skillLearning: boolean; skillReminded: boolean; skillSaved: boolean
  router: TeamRouterLike
  // Set after the record is made: the index scan, the run timer, the coalesced persistence timer and its failure mark.
  indexReady?: Promise<unknown>; indexSettled?: boolean; timer?: ReturnType<typeof setTimeout>; persistTimer?: ReturnType<typeof setTimeout> | null; persistenceError?: boolean
  // Restarts (resume.mts): what a continuation starts again from, the run this one continues and how many restarts in a
  // row led here, and for a run that ended `restarting`, why and when the restart was asked for. `resumeSession`: the
  // old root's provider session a continuation is resuming, until its first turn answers (runtime/restart.mts).
  // `attachments`: the files the user attached in this run (and in the runs it continues), named to its continuation.
  startPayload?: StartPayload; resumedFrom?: string; resumeChain?: number; restart?: RestartMark; resumeSession?: string; attachments?: Attachment[]
  // The improvement loop (runtime/improvement.mts): the loop's task number the renderer gave this run, what the next task
  // must know, the closed task keys (`id|title`) the run started with, and whether restart_orbit applied this run's change
  // or was refused in a way the next task's restart resolves (cycle limit, other chats working, declined).
  loopTask?: number; improvementHandoff?: string; improvementBaseline?: Map<string, ImprovementTask>; restartApplied?: boolean; restartDeferred?: boolean
}
// `note`: what the root of the continuation is told about the run the restart ended (work log, files, helpers, cut-off turn);
// `intentId`: the id of the intent (pending-resume.json) that marked it, the only one that continues it (resume.mts).
// `mailMark`: the root's (util.mailTag), for the continuation that resumes its session.
export interface RestartMark { reason: string; requestedAt: string; source: 'tool' | 'script'; note?: string; intentId?: string; mailMark?: string }
// A run as others see it: the snapshot the UI, the run store and the chat memory get.
export interface RunSnapshot {
  runId: string; projectId: string; chatId: string; prompt: string; workspace: string; status: RunStatus; providerId: string; model: string
  accessMode: AccessMode; approvalPolicy: ApprovalPolicy; reasoningEffort: string; memoryEnabled: boolean; improvementMode: boolean; improvements: ImprovementTask[]; improvementStatus: ImprovementStatus
  startedAt: string; finishedAt: string | null; limits: RunLimits; usage: Usage; agents: PublicAgent[]
  traces: Trace[]; messages: Message[]; communications: Communication[]; summary: RunSummary | null; error: string | null
  files: FileActivitySnapshot[]; changes: FileChange[]; router: RouterStats
  startPayload?: StartPayload; resumedFrom?: string; resumeChain?: number; restart?: RestartMark; attachments?: Attachment[]
  loopTask?: number; improvementHandoff?: string
}
// An earlier turn of the chat as chat-memory presents it (a live run or a saved snapshot): chat-memory's own RunView.
export type ChatRunView = import('./chat-memory.mts').RunView
// A run as the run store keeps it (run-store.mts): a snapshot saved by any version of Orbit. The store reads only
// these fields; everything else is kept exactly as the runtime produced it. A live RunSnapshot is one.
export interface StoredAgent { id: string; status?: string; detail?: string; finishedAt?: string | null; files?: { wrote?: string[]; read?: string[] } | null; [field: string]: unknown }
export interface StoredRun {
  runId: string; status?: string; projectId?: string; chatId?: string; workspace?: string
  startedAt?: string; finishedAt?: string | null; updatedAt?: string; error?: string | null
  agents?: StoredAgent[]; changes?: FileChange[]
  startPayload?: StartPayload; resumedFrom?: string; resumeChain?: number; restart?: RestartMark
  // The run's attached files as saved (checked again before a continuation names them: resume.mts).
  attachments?: unknown
  // The improvement plan an improvement-mode run left (read back by runtime/improvement.mts loadPlan).
  improvements?: unknown; improvementStatus?: unknown; improvementHandoff?: unknown; loopTask?: number
}
export interface StartPayload {
  prompt?: string; providerId?: string; workspace?: string; projectId?: string; chatId?: string; mode?: string; accessMode?: string; approvalPolicy?: string
  reasoningEffort?: string; model?: string; providerOptions?: Record<string, ProviderOptions>; providerPool?: PoolMember[]
  memoryEnabled?: boolean; globalMemoryEnabled?: boolean; memoryContext?: MemoryEntry[]; improvementMode?: boolean; quotaFailover?: unknown; models?: Record<string, unknown> | null
  history?: HistoryInput[]; agentInstructions?: string; limits?: LimitsInput; skillLearning?: boolean
  // The improvement loop's task number (the renderer starts one run per task); a safe integer ≥ 1, else ignored.
  loopTask?: number
  // Files the user attached to the message that starts the run (saved first with attachments:save).
  attachments?: Attachment[]
  // A continuation after a restart (resume.mts): the run it continues, how many restarts in a row led to it, the note its
  // root starts with, the old root's provider session (with the mark of its mail) to resume when the root keeps that
  // provider, and the files the user attached in the run it continues (the note names them).
  resumedFrom?: string; resumeChain?: number; restartNote?: string; resumeSession?: { id: string; providerId: string; mailMark?: string }
  resumeAttachments?: Attachment[]
}
export type RuntimeEventData = Record<string, unknown>
export interface RuntimeEvent { type: string; runId: string; projectId: string; chatId: string; [extra: string]: unknown }
export type RuntimeListener = (event: RuntimeEvent) => void

// ---- Providers ----------------------------------------------------------------------------------------------------
export interface SessionInfo { id: string; token: string | null; mcpUrl: string | null; systemAppend: string; resume: boolean; activity: () => { pending: number; lastAt: number } | null }
export interface ApprovalRequest { tool: string; arguments: unknown; toolUseId?: string }
// What the user is asked, from an envelope tool or a Claude Code permission prompt.
export interface ApprovalPrompt extends ApprovalRequest { runId: string; agentId: string; agentName: string; workspace: string; signal: AbortSignal }
export type ApprovalHandler = (prompt: ApprovalPrompt) => boolean | Promise<boolean>
export interface ProviderRunOptions {
  providerId: string; model: string; prompt: string; workspace: string
  mode: AccessMode; accessMode: AccessMode; approvalPolicy: ApprovalPolicy; reasoningEffort: string; providerOptions: ProviderOptions
  session?: SessionInfo; responseSchema?: JsonSchema
  onApproval: (request: ApprovalRequest) => Promise<boolean>; signal: AbortSignal; timeoutMs: number | null; inactivityMs?: number
  onEvent: (event: ProviderEvent) => void
  // Added to the environment of the provider's CLI process: the variables that name the agent's run (resume.mts restartEnv).
  extraEnv?: Record<string, string>
}
// One event of a provider's stream: streamed text and reasoning, native tool activity, observations, quota figures.
// `kind` is always present (output, reasoning, tool, observation, quota, provider, …); everything else depends on it.
export interface ProviderEvent {
  kind: string; providerId?: string; text?: string; message?: string; messageId?: string; partial?: boolean; replace?: boolean; parentToolId?: string | null
  native?: boolean; tool?: string; toolId?: string; status?: string; changes?: unknown; input?: unknown; output?: unknown; exitCode?: number | null
  mcp?: boolean; server?: string; orbitTool?: string; images?: ToolImage[]
  // kind thinking: the estimate of the thinking block so far, or `done` when it ends.
  tokens?: number; done?: boolean
  // kind session: the id the provider's CLI gave its session, named as the turn began (turn.mts providerTurn).
  sessionId?: string
  // `usage` is the vendor's figures, unchecked (providers.mts types it unknown): read it as UsageFigures only defensively.
  usage?: unknown; quota?: QuotaUpdate; source?: string
  // No index signature: every member of providers.mts's ProviderEvent union (interfaces) must fit this shape, since
  // providers call the runtime's listener with them. `changes` is the vendor's list (NativeChange items), unchecked.
}
// What a provider turn returns. The envelope transport returns the text (an envelope JSON or a prose answer); the
// session transport also names the session it kept (`sessionId`). `model` and `reasoningEffort` report what really ran.
export interface ProviderResult {
  text?: string; model?: string; sessionId?: string | null; usage?: unknown; reasoningEffort?: string
  providerId?: string; client?: string; transport?: Transport; access?: string
}
export type RunProvider = (options: ProviderRunOptions) => Promise<ProviderResult>
export interface TransportOptions extends ProviderOptions { accessMode: AccessMode; approvalPolicy: ApprovalPolicy; model: string }
export type TransportFor = (providerId: string, options: TransportOptions) => string
export type CloseSession = (sessionId: string) => unknown

// ---- Quota and failover -------------------------------------------------------------------------------------------
// No index signatures: quota.mts's QuotaWindow/QuotaSnapshot (interfaces, what QuotaMonitor returns) must fit them.
export interface QuotaWindow { usedPercent: number; resetsAt?: number | null; models?: string[] }
export interface QuotaSnapshot { providerId?: string; windows?: QuotaWindow[]; checkedAt?: number | null; fetchedAt?: number | null; state?: string; blocked?: boolean; exhaustedUntil?: number }
// Live figures from a running turn (Claude stream, Codex notifications).
export interface QuotaUpdate { windows?: QuotaWindow[]; blocked?: boolean; resetsAt?: number | null; source?: string }
// How close an account is to a refusal (quota.assess).
export interface QuotaLevel { usedPercent: number | null; window?: unknown; exhausted?: boolean; near?: boolean; resetsAt: number | null }
export interface QuotaRefusal { providerId: string; resetsAt: number | null; message: string }
export interface ReplacementChoice { providerId: string; model: string; reasoningEffort?: string; key: string }
// `level` is a quota assessment, or the synthetic `{ usedPercent: 100 }` after a refusal (failover.mts's HandoverLevel).
export interface HandoverRequest { reason: HandoverReason; level?: import('./failover.mts').HandoverLevel | null; error?: unknown; interrupted?: InterruptedTurn | null }

// ---- Memory and skills --------------------------------------------------------------------------------------------
export interface MemoryEntry {
  id: string; scope: MemoryScope; type: string; title: string; content: string; workspace?: string; chatId?: string; confidence?: number
  created?: string; updated?: string; lastUsed?: string; uses?: number; pinned?: boolean; source?: string; dupOf?: string
}
export interface MemorySaveInput { id?: string; title: string; content: string; scope: MemoryScope; type?: string; confidence?: number; workspace?: string; chatId?: string; pinned?: boolean }
export interface MemorySaveResult { entry: MemoryEntry; merged?: boolean; unchanged?: boolean; evicted?: number }
export interface RecallQuery { query: string; workspace: string; chatId: string; includeGlobal: boolean; models: boolean }
export interface RecallItem { entry: MemoryEntry; relevant: boolean; pinned: boolean }
export interface RecallResult { tiers: Record<MemoryScope, RecallItem[]>; totals?: Partial<Record<MemoryScope, number>> }
// Skills are add-ons Orbit builds for itself, of any form: instructions for agents, and optionally a package of files
// (pages, scripts, assets) with parameters the user sets, triggers Orbit runs on its own and commands agents run in the
// package folder (electron/capabilities.mts, electron/skill-files.mts). src/types.ts mirrors these.
export type SkillParamType = 'text' | 'url' | 'number' | 'seconds' | 'boolean'
export type SkillParamValue = string | number | boolean
export interface SkillParam { key: string; label: string; type: SkillParamType; default: SkillParamValue; value: SkillParamValue; hint?: string }
// task-completed: a run of the skill's project completed (after a restart_orbit restart, the continuation's completion).
export interface SkillTrigger { on: 'task-completed'; show: string }
export interface SkillCommand { name: string; run: string; description?: string }
export interface SkillFile { path: string; size: number }
export interface SkillPackage { id: string; dir: string }
// A file of a package as an install passes it: its path in the package and its text.
export interface SkillFileInput { path: string; content: string }
export interface SkillView {
  id: string; name: string; description?: string; whenToUse?: string; scope: SkillScope; version?: number; uses?: number; reliability?: number
  lessons?: string[]; successes?: number; failures?: number; workspace?: string; source?: string; relevant?: boolean
  enabled?: boolean; files?: SkillFile[]; params?: SkillParam[]; triggers?: SkillTrigger[]; commands?: SkillCommand[]; package?: SkillPackage
}
export interface SkillEntry extends SkillView { instructions: string }
export interface SkillSuggestion { skills: SkillView[]; total: number }
export interface SkillSaveInput {
  id?: string; name: string; description?: string; whenToUse?: string; instructions: string; scope: SkillScope; workspace?: string; source?: string
  files?: SkillFileInput[]; removeFiles?: string[]; fromDir?: string; params?: unknown[]; triggers?: unknown[]; commands?: unknown[]
}
// A file the user attached to a chat message (electron/attachments.mts) and the upload the window sends to save one.
export interface Attachment { id: string; name: string; type: string; size: number; path: string }
export interface AttachmentUpload { name: string; type: string; data: string }
export interface SkillSaveResult { entry: SkillEntry; merged?: boolean; improved?: string; evicted?: number }
export interface SkillFeedbackInput { outcome?: string; note?: string; includeGlobal?: boolean }
export interface MaintainOptions { workspace: string; chatId?: string; crossProject: boolean; projects: string[] }

// ---- Stores as the runtime consumes them ----------------------------------------------------------------------------
export interface MemoryStoreLike {
  list(workspace: string, includeGlobal?: boolean, chatId?: string): MemoryEntry[]
  search(query: string, workspace: string, limit: number, includeGlobal: boolean, chatId?: string): MemoryEntry[]
  remove(id: string, workspace: string, chatId: string, options: { origin: 'user' | 'agent' | 'system'; includeGlobal: boolean }): boolean
  upsert(entry: MemorySaveInput, options?: { origin?: string }): MemoryEntry
  // Optional: the tiered store has them, the fallback paths work without.
  recall?(query: RecallQuery): RecallResult
  find?(id: string, workspace: string, chatId: string, includeGlobal?: boolean): MemoryEntry | null
  save?(input: MemorySaveInput, options?: { origin?: string }): MemorySaveResult
  touch?(ids: string[]): void
  maintain?(options: MaintainOptions): unknown
  flush?(): void
}
export interface CapabilityStoreLike {
  list(workspace: string, includeGlobal?: boolean): SkillView[]
  search(query: string, workspace: string, limit: number, includeGlobal: boolean): SkillView[]
  read(id: string, workspace: string, includeGlobal: boolean): SkillEntry
  find(id: string, workspace: string, includeGlobal: boolean): SkillView | null
  feedback(id: string, workspace: string, input: SkillFeedbackInput): SkillView & { lessonDropped?: boolean }
  save(input: SkillSaveInput, options?: { origin?: string }): SkillSaveResult
  setEnabled?(id: string, enabled: boolean, workspace: string): SkillView
  suggest?(query: string, workspace: string, limit: number, includeGlobal: boolean): SkillSuggestion
  recordUse?(id: string, workspace: string, includeGlobal: boolean): string | null
  maintain?(options: Omit<MaintainOptions, 'chatId'>): unknown
  flush?(): void
}
export interface RunStoreLike {
  get?(id: string): StoredRun | null
  save?(snapshot: RunSnapshot): void | Promise<unknown>
  forChat?(projectId: string, chatId: string, limit: number): StoredRun[]
  list?(): StoredRun[]
  saveImage?(runId: string, image: ToolImage): TraceImage | null
}
export interface ProjectIndexLike {
  refresh(workspace: string, options?: { force?: boolean }): Promise<IndexDiff>
  search(workspace: string, query: string, options: { limit: number }): IndexSearchResult
  outline(workspace: string, requested: string | undefined): IndexOutline | null
  overview(workspace: string): string
  touch(workspace: string, relPaths: string[]): Promise<unknown>
}
export interface ContextStoreLike { getLatest(workspace: string): SharedContext | null; set(workspace: string, value: SharedContext): void }
export interface QuotaMonitorLike {
  // Readings as quota.mts's QuotaMonitor keeps them: what `assess` and failover's `replacements` read.
  peek(id: string): import('./quota.mts').QuotaSnapshot | null
  get(id: string, options: { maxAgeMs: number; waitMs: number; options: ProviderOptions }): Promise<import('./quota.mts').QuotaSnapshot | null>
  ingest?(id: string, partial: QuotaUpdate | null | undefined): void
  markExhausted?(id: string, mark: { resetsAt: number | null; reason: string }): void
}
export type CatalogLike = (providerOptions: Record<string, ProviderOptions>) => Promise<CatalogEntry[] | null | undefined> | CatalogEntry[] | null | undefined
export interface FileActivityLike {
  record(agentId: string, target: string, action: FileAction): FileTouch | null
  nativeEvent(agentId: string, event: ProviderEvent): FileTouch[]
  forAgent(agentId: string): AgentFiles
  peers(rel: string, exceptAgentId: string): FilePeer[]
  owners(target: string): FilePeer[]
  shared(): SharedFile[]
  snapshot(): FileActivitySnapshot[]
}
export interface ChangeLogLike {
  startedAt: number
  claim(rel: string): boolean
  remember(agentId: string, event: ProviderEvent): NativeCallEntry | null
  add(input: ChangeInput & { agentId: string }): FileChange | null
  snapshot(): FileChange[]
}
// The team router as the runtime uses it (electron/router.mts implements it).
export interface RouterAudience { via: string; recipients: { agent: AgentRecord; reasons: string[] }[] }
export interface RouterHost {
  record(sender: AgentRef, target: AgentRef, text: string, extra?: Partial<Communication>): Communication
  announce(communication: Communication, persist: boolean): void
  changed?(stats: RouterStats): void
}
export interface TeamRouterLike {
  stats: RouterStats
  bump(key: keyof RouterStats, count?: number): void
  audience(sender: AgentRecord, args: ToolArgs, resolveAgent: (reference: string) => AgentRecord): RouterAudience
  pass(sender: AgentRecord, target: AgentRecord, text: string): void
  notifyWrite(writer: AgentRecord, rel: string): { agent: string; how: string }[]
}
// The MCP server as the runtime drives it (electron/mcp-server.mts, or a test's fake).
export interface McpServerLike {
  start?(): Promise<unknown>
  stop?(): Promise<unknown> | void
  url: string | null | (() => string | null)
  issueToken(info: { runId: string; agentId: string }): string
  revoke?(token: string): unknown
  activity?(token: string | null): { pending: number; lastAt: number } | null
}
export interface SessionRef { runId: string; agentId: string }
export interface McpApproveRequest { tool_name?: string; tool?: string; input?: unknown; arguments?: unknown; tool_use_id?: string; [extra: string]: unknown }
export interface McpDispatchResult { ok: boolean; error: string | null; observation?: Observation; text: string; unread: number }

// ---- Tool registry ------------------------------------------------------------------------------------------------
// JSON Schema as the registry writes it: enough for the envelope schema and the argument checks, nothing more.
export interface JsonSchema {
  type?: string; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean
  items?: JsonSchema; enum?: readonly unknown[]; anyOf?: JsonSchema[]; maxItems?: number
}
export interface ObjectSchema extends JsonSchema { type: 'object'; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: boolean }
export interface ToolSpec {
  name: string; signature: string; blurb: string; description: string; inputSchema: ObjectSchema
  rootOnly: boolean; waits: boolean; mutating: boolean; minAccess: AccessMode; internal: boolean
}
export type ValidationResult = { ok: true; args: ToolArgs } | { ok: false; error: string }
export interface ToolAccessContext { root?: boolean; accessMode?: string }
export interface ToolPromptOptions { section?: 'guide' | 'context'; transport?: Transport }
// The registry as the runtime looks it up (the module, an injected one, or none).
export interface ToolRegistryLike {
  TOOLS?: ToolSpec[]
  toolsFor?(context: ToolAccessContext): ToolSpec[]
  validate?(name: string, args: unknown): ValidationResult
  describeForPrompt?(agent: unknown, run: unknown, options?: ToolPromptOptions): string
}

// ---- Workspace tools ----------------------------------------------------------------------------------------------
// `env` is added to the environment of run_command (the variables that name the agent's run, resume.mts restartEnv).
export interface WorkspaceContext { workspace: string; accessMode: string; signal?: AbortSignal | null; maxOutputChars: number; onFileChange?: (change: FileWrite) => void; env?: Record<string, string> }
export interface CommandResult { ok: boolean; exitCode?: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string; truncated?: boolean; timedOut?: boolean; error?: string }

// ---- Prompts and mail ---------------------------------------------------------------------------------------------
export interface PromptBase { required: string; optional: string }
// `fromUser`: how many of the delivered messages the user wrote (runtime:message); they lead the text as the user's own words.
export interface MailboxContext { text: string; deliveredIds: string[]; fromUser: number }
export interface StoppedHelper { agentId: string; name: string; status: AgentStatus }
export interface ReadMessagesResult { messages: Communication[]; remainingUnread: number; timedOut?: boolean; stopped?: StoppedHelper[]; note?: string }
export interface SendResult { ok: true; communicationId: string; agentId: string; status: CommunicationStatus; delivery: CommunicationDelivery }
export interface AskTeamResult { ok: true; discussionId: string; via: string; routedTo: { agentId: string; name: string; reason?: string; status?: CommunicationStatus; error?: string }[] }
export interface NoteSummary { key: string; summary: string; stale?: boolean; files: string[] }
export interface NoteIndex { overview: unknown; notes: NoteSummary[]; otherNotes: string[] }

// ---- The runtime as its modules see it -------------------------------------------------------------------------------
export interface OrbitRuntimeOptions {
  runProvider?: RunProvider; memoryStore?: MemoryStoreLike | null; capabilityStore?: CapabilityStoreLike | null; runStore?: RunStoreLike | null
  requestApproval?: ApprovalHandler | null; clock?: () => number; projectIndex?: ProjectIndexLike | null; quota?: QuotaMonitorLike | null; catalog?: CatalogLike | null
  mcp?: McpServerLike | null | false; transportFor?: TransportFor | null; closeSession?: CloseSession | null; registry?: ToolRegistryLike | null
  restartHost?: import('./resume.mts').RestartHost | null
}
// The facade's whole surface (electron/runtime.mts): state, the public methods main.cjs and the tests use, and the
// methods the modules call back through. Every module function takes this as its first argument; a module never
// imports the facade, so this interface is how they know it. `SWITCH_TRANSPORT` is the value a transport loop returns
// when a handover moved the agent to a provider of the other transport.
export interface OrbitRuntimeLike {
  runProvider: RunProvider; memoryStore: MemoryStoreLike | null; capabilityStore: CapabilityStoreLike | null; runStore: RunStoreLike | null
  requestApproval: ApprovalHandler | null; clock: () => number; projectIndex: ProjectIndexLike | null; quota: QuotaMonitorLike | null; catalog: CatalogLike | null
  contextStore: ContextStoreLike | null; sharing: Map<string, boolean>; lastShare: number
  mcp: McpServerLike | null | false; mcpStarted: Promise<McpServerLike | null> | null; mcpError: Error | null
  transportFor: TransportFor | null; closeSession: CloseSession | null; toolRegistry: ToolRegistryLike | null | undefined; sessions: Map<string, SessionRef>
  runs: Map<string, RunRecord>; listeners: Set<RuntimeListener>
  // Runs the self-upgrade script for restart_orbit (resume.mts createRestartHost); null when Orbit cannot restart itself.
  restartHost: import('./resume.mts').RestartHost | null
  setQuota(monitor: QuotaMonitorLike | null): void
  setCatalog(catalog: CatalogLike | null): void
  onEvent(listener: RuntimeListener): () => void
  setProjectIndex(index: ProjectIndexLike | null): void
  setMemoryStore(store: MemoryStoreLike | null): void
  setCapabilityStore(store: CapabilityStoreLike | null): void
  setRunStore(store: RunStoreLike | null): void
  setContextStore(store: ContextStoreLike | null): void
  routeMessage(): Promise<{ kind: string; reply: string }>
  // store
  getRun(id: string): RunSnapshot | StoredRun | null
  getRuns(): RunSnapshot[]
  snapshot(run: RunRecord): RunSnapshot
  getRunChanges(runId: string): FileChange[]
  persist(run: RunRecord): void
  persistenceError(run: RunRecord, error: Error): void
  schedulePersist(run: RunRecord, delay?: number): void
  emit(run: RunRecord, type: string, data?: RuntimeEventData, persist?: boolean): void
  trace(run: RunRecord, agentId: string, kind: string, text: string, id?: string, images?: TraceImage[]): void
  updateAgent(run: RunRecord, agent: AgentRecord, patch: Partial<AgentRecord>, persist?: boolean): void
  message(run: RunRecord, agent: AgentRecord, text: string, kind?: string): void
  pruneRuns(): void
  // lifecycle
  start(payload?: StartPayload): Promise<string>
  previousRuns(run: RunRecord): ChatRunView[]
  finishRun(run: RunRecord, result: AgentResult): void
  setSharing(workspace: unknown, enabled: unknown): void
  maintainKnowledge(run: RunRecord): void
  failRun(run: RunRecord, error: Error): void
  cancelAgents(run: RunRecord, detail: string): void
  stop(runId: string): boolean
  pauseAgent(runId: string, agentId: string): AgentControlResult
  resumeAgent(runId: string, agentId: string): AgentControlResult
  stopAgent(runId: string, agentId: string): AgentControlResult
  markRestarting(runId: string, mark?: RestartMark): boolean
  // restart
  setRestartHost(host: import('./resume.mts').RestartHost | null): void
  // agents
  createAgent(run: RunRecord, parent: AgentRecord | null, spec: ToolArgs): AgentRecord
  scheduleAgent(run: RunRecord, agent: AgentRecord): Promise<AgentResult>
  spawnSubAgent(runId: string, parentId: string, spec?: ToolArgs): Promise<SpawnResult>
  resolveAgent(run: RunRecord, reference: unknown): AgentRecord
  resultKey(agent: { id: string; generation: number }): string
  followupAgent(run: RunRecord, sender: AgentRecord, args: ToolArgs): FollowupResult
  acquireTurn(run: RunRecord, agent: AgentRecord): Promise<void>
  releaseTurn(run: RunRecord): void
  agentSignal(run: RunRecord, agent: { id: string }): AbortSignal
  teamDigest(run: RunRecord, agent: AgentRecord): TeamDigest
  agentDirectory(run: RunRecord): AgentDirectoryEntry[]
  cancelDescendants(run: RunRecord, agent: AgentRecord, detail: string): void
  completeAgent(run: RunRecord, agent: AgentRecord, content: string, budgetLimited?: boolean, detail?: string, extra?: Partial<AgentRecord>): AgentResult
  budgetHandoff(run: RunRecord, agent: AgentRecord): AgentResult
  stallHandoff(run: RunRecord, agent: AgentRecord, turns: number): AgentResult
  // mailbox
  communicationsFor(run: RunRecord, agent: { id: string }, unreadOnly?: boolean): Communication[]
  pendingMail(run: RunRecord, agent: AgentRecord): Communication[]
  markCommunications(run: RunRecord, ids: string[], status: CommunicationStatus, delivery: CommunicationDelivery): void
  sendAgentMessage(run: RunRecord, sender: AgentRecord, args: ToolArgs): SendResult
  recordCommunication(run: RunRecord, sender: AgentRef, target: AgentRef, text: string, extra?: Partial<Communication>): Communication
  readAgentMessages(run: RunRecord, agent: AgentRecord, args?: ToolArgs): ReadMessagesResult
  waitForTeam(run: RunRecord, agent: AgentRecord, participants: { id: string }[], timeout?: number, signal?: AbortSignal): Promise<string>
  waitAgentMessage(run: RunRecord, agent: AgentRecord, args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>): Promise<ReadMessagesResult>
  mailboxContext(run: RunRecord, agent: AgentRecord, held?: ReadonlySet<string>): MailboxContext
  askTeam(run: RunRecord, sender: AgentRecord, args: ToolArgs): AskTeamResult
  postUserMessage(runId: string, agentId: string, text: unknown): SendResult
  userMail(run: RunRecord, agent: AgentRecord): string
  // prompts
  teamContext(run: RunRecord, agent: AgentRecord): string
  fileMapContext(run: RunRecord): string
  context(run: RunRecord, agent: AgentRecord): Promise<PromptBase>
  promptForTurn(base: PromptBase, transcript: TranscriptEntry[], run: RunRecord, mailboxText?: string, agent?: AgentRecord | null): string
  resumePrompt(run: RunRecord, agent: AgentRecord, instruction: string, entries: TranscriptEntry[], mailboxText: string, lastWorkerTurn: boolean | undefined): string
  toolGuide(run: RunRecord, agent: AgentRecord): string
  // changes
  awaitIndex(run: RunRecord, options?: { refresh?: boolean }): Promise<void>
  publishFiles(run: RunRecord, agent: AgentRecord): void
  touchFile(run: RunRecord, agent: AgentRecord, target: string, action: FileAction): { touch?: FileTouch; shared: { agent: string; how: string }[] }
  trackNativeFiles(run: RunRecord, agent: AgentRecord, event: ProviderEvent): void
  captureChange(run: RunRecord, agent: AgentRecord, target: string, tool: string | undefined, describe: (first: boolean) => Promise<ChangeDescription>): void
  drainChanges(run: RunRecord, ms?: number): Promise<void>
  recordChange(run: RunRecord, agent: AgentRecord, input: ChangeInput): void
  reportWrite(run: RunRecord, agent: AgentRecord, tool: string, change: FileWrite): void
  trackWorkspaceTool(run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, result: unknown): Promise<unknown>
  runTrackedCommand(run: RunRecord, agent: AgentRecord, args: ToolArgs, context: WorkspaceContext): Promise<unknown>
  // tools and knowledge
  approve(run: RunRecord, agent: AgentRecord, request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>
  executeTool(run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>): Promise<Observation>
  markMemoryUse(run: RunRecord, entries: MemoryEntry[]): void
  // ledger
  recordLedger(agent: AgentRecord, name: string, text: string): void
  workLog(agent: AgentRecord): string
  collectChildren(run: RunRecord, agent: AgentRecord, transcript: TranscriptEntry[]): number
  remember(agent: AgentRecord, entry: TranscriptEntry): void
  trimTranscript(run: RunRecord, agent: AgentRecord): void
  // turn
  notePartialTurn(agent: AgentRecord, event: ProviderEvent): void
  providerEvent(run: RunRecord, agent: AgentRecord, event: ProviderEvent): void
  flushProviderBuffer(run: RunRecord, key: string): void
  noteTurnEvent(agent: AgentRecord, event: ProviderEvent): void
  streamOutput(run: RunRecord, agent: AgentRecord, event: ProviderEvent): void
  flushStream(run: RunRecord, agent: AgentRecord, stream: StreamState): void
  recordUsage(run: RunRecord, usage: UsageFigures): void
  trackOperation<T>(run: RunRecord, operation: T | PromiseLike<T>, agent: { id: string }): Promise<Awaited<T>>
  providerTurn(run: RunRecord, agent: AgentRecord, prompt: string | (() => string), sessionOptions?: SessionInfo | null): Promise<ProviderResult>
  // handover
  failoverActive(run: RunRecord): boolean
  providerCatalog(run: RunRecord): Promise<CatalogEntry[]>
  preflightQuota(run: RunRecord, agent: AgentRecord): Promise<void>
  handover(run: RunRecord, agent: AgentRecord, request: HandoverRequest): Promise<boolean>
  recoverProvider(run: RunRecord, agent: AgentRecord, error: unknown): Promise<boolean>
  routeSpawn(run: RunRecord, parent: AgentRecord, spec: ToolArgs): Promise<{ spec: ToolArgs; routed: RoutedSpawn }>
  // loops
  executeAgent(run: RunRecord, agent: AgentRecord): Promise<AgentResult>
  envelopeLoop(run: RunRecord, agent: AgentRecord, signal: AbortSignal): Promise<AgentResult | typeof SWITCH_TRANSPORT>
  sessionLoop(run: RunRecord, agent: AgentRecord, signal: AbortSignal): Promise<AgentResult | typeof SWITCH_TRANSPORT>
  wakeInstruction(pending: TranscriptEntry[], mailboxText: string, fromUser?: boolean): string
  // session
  prepareSession(run: RunRecord, agent: AgentRecord): Promise<boolean>
  releaseSession(run: RunRecord, agent: AgentRecord): void
  closeSessions(run: RunRecord): void
  decideTransport(run: RunRecord, providerId: string, model: string): Transport
  ensureMcp(): Promise<McpServerLike | null>
  mcpUrl(): string | null
  sessionFor(token: string | SessionRef | null | undefined): { run: RunRecord; agent: AgentRecord } | null
  registry(): ToolRegistryLike | null
  listToolsMcp(token: string | SessionRef | null | undefined): ToolSpec[]
  approveMcp(token: string | SessionRef | null | undefined, request?: McpApproveRequest): Promise<boolean>
  dispatchMcp(token: string | SessionRef | null | undefined, name: string, args?: unknown): Promise<McpDispatchResult>
  shutdown(): Promise<void>
}
