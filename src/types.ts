export type AccessMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'never' | 'on-request' | 'auto-review'
// restarting = ended because Orbit restarts (restart_orbit); the task goes on in a new run whose resumedFrom points back.
// paused = an agent held at the pause gate (by the user, or because an agent it works under is paused). Runs never carry it.
export type AgentStatus = 'idle' | 'waiting' | 'working' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'restarting'
export type RunStatus = AgentStatus | 'completed' | 'failed'
export type Agent = {
  id: string
  name: string
  role?: string
  status: AgentStatus
  task?: string
  detail?: string
  model?: string
  reasoningEffort?: string
  // Who picked the reasoning level: 'caller' (the parent's spawn call: Orbit), 'routing', 'pool', 'parent', 'settings', or '' (unknown).
  effortSource?: string
  parentId?: string | null
  depth?: number
  providerId?: string | null
  result?: string
  output?: string
  reason?: string
  generation?: number
  turns?: number
  budgetLimited?: boolean
  stalled?: boolean
  files?: AgentFiles
  handovers?: Handover[]
  error?: string
  startedAt?: string
  finishedAt?: string
  // session = one CLI process resumed turn after turn; envelope = the JSON protocol with a fresh process per turn.
  transport?: AgentTransport
  sessionId?: string | null
  turnTimings?: TurnTiming[]
  // The user's own pause of this agent (an ancestor's pause holds it too, without this flag) and when it was set.
  paused?: boolean
  pausedAt?: string | null
  // Cancelled by the user's Stop on this helper, not by the run ending.
  stoppedByUser?: boolean
  // Tokens used so far over the agent's whole life, live during a turn; null (or absent) until a provider reports figures.
  usage?: AgentUsage | null
  // Set while the agent works in its own copy of the project (a git worktree or Orbit's own copy) instead of the shared folder.
  isolation?: AgentIsolation
}
// `inputTokens` is everything the model was sent, the cached part (`cachedInputTokens`) included: input + output is the count.
export type AgentUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number }
// What a run reports of tokens: the sum of its agents' (run.info events and the saved run), null until anything was reported.
export type RunUsage = { providerTurns: number; workerTurns?: number; inputTokens?: number | null; outputTokens?: number | null; cachedInputTokens?: number }
// `base`: what the copy was made from; `conflicts`: the files whose changes could not be merged back.
export type AgentIsolation = { kind: 'worktree' | 'orbit'; path: string; base: string; held?: boolean; decided?: 'merge' | 'discard'; conflicts?: string[] }
export type AgentFiles = { read: string[]; wrote: string[] }
export type AgentTransport = 'session' | 'envelope'
// One provider turn of one agent. `endedAt` is missing while the turn is still running.
export type TurnTiming = {
  turn: number
  transport: AgentTransport
  startedAt: string
  firstEventAt?: string | null
  endedAt?: string | null
  promptChars?: number
  nativeToolCalls?: number
  orbitToolCalls?: number
  sessionId?: string | null
  // While the model thinks (Claude): the CLI's estimate of the thinking block so far, in tokens; gone when it ends.
  thinking?: number
}
// The root agent's answer while it is still being written: kept in the live run only, never in the saved chat or run file.
export type StreamingMessage = { messageId: string; agentId: string; content: string; startedAt: string; updatedAt: string }
export type QuotaWindow = { kind: 'session' | 'week' | 'other'; usedPercent: number; resetsAt: number | null; scope: string; models?: string[] }
export type QuotaState = 'ok' | 'warning' | 'exhausted' | 'unknown' | 'unlimited' | 'unavailable'
export type QuotaSnapshot = {
  providerId: string
  state: QuotaState
  windows: QuotaWindow[]
  plan?: string | null
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  detail?: string
  stale?: boolean
  fetchedAt?: number | null
  exhaustedUntil?: number | null
}
export type QuotaFailover = { enabled: boolean; switchAtPercent: number; allowWeaker: boolean }
export type HandoverTarget = { providerId: string; model: string; reasoningEffort?: string }
export type Handover = {
  id: string
  time: string
  reason: 'approaching' | 'exhausted' | 'replacement-failed' | 'stalled' | 'failed'
  from: HandoverTarget
  to: HandoverTarget
  fresh: boolean
  interrupted: boolean
  usedPercent: number | null
  resetsAt: number | null
  note?: string
  turn?: number
}
export type FileTouch = { path: string; readers: string[]; writers: string[] }
// One edit of one file by one agent. `diff` is a git-style unified diff. Run lists (listRuns) carry `hasDiff` instead of the
// text to stay light; live `change.added` events and getRunChanges(runId) carry the text.
// source: exact = Orbit compared the file before and after; event = built from a provider's tool event (Claude Edit/Write, Codex
// file_change); git = `git diff HEAD` of the file, which can include edits that are not this agent's.
export type FileChange = {
  id: string
  agentId: string
  path: string
  kind: 'create' | 'modify' | 'delete' | 'unknown'
  tool: string
  time: string
  added: number
  removed: number
  source: 'exact' | 'event' | 'git'
  diff?: string
  hasDiff?: boolean
  truncated?: boolean
  binary?: boolean
  // Why there is no diff text (a code from electron/change-log.cjs REASONS); only set when hasDiff is false.
  reason?: string
  // Short commit a recovered `git` diff is relative to (the last commit before the run started).
  base?: string
}
export type InspectorTab = 'activity' | 'communications' | 'files' | 'changes' | 'graph'
export type Message = {
  id: string
  author: 'user' | 'orbit' | 'system'
  text: string
  time: string
  agentId?: string
  runId?: string
  kind?: string
  client?: string
  model?: string
  // Files the user attached to this message (saved by the runtime, electron/attachments.mts).
  attachments?: Attachment[]
}
// A file the user attached to a chat message: saved under Orbit's data folder, the model gets its path.
export type Attachment = { id: string; name: string; type: string; size: number; path: string }
// A file as the window sends it to be saved: name, MIME type and content as base64.
export type AttachmentUpload = { name: string; type: string; data: string }
// chat = working notes of one task thread, project = knowledge about one codebase, global = what holds in every project.
export type MemoryScope = 'chat' | 'project' | 'global'
export type MemoryEntry = {
  id: string
  title: string
  content: string
  type: 'decision' | 'pattern' | 'preference' | 'fact'
  scope: MemoryScope
  workspace?: string
  chatId?: string
  updated: string
  confidence?: number
  created?: string
  lastUsed?: string
  uses?: number
  pinned?: boolean
  source?: string
}
export type TierStats = { count: number; limit: number; pinned?: number; chars?: number }
export type LibraryStats = {
  memory: { chat: TierStats; project: TierStats; global: TierStats; stored: number }
  skills: { project: TierStats; global: TierStats; used: number }
}
// Skills are add-ons Orbit builds for itself, of any form (electron/capabilities.mts): instructions for agents, and
// optionally a package of files (pages, scripts, assets) with parameters the user sets, triggers Orbit runs on its own
// (task-completed → show one of the package's pages full screen; quota-panel → one of its pages inside the quota window)
// and commands agents run in the package folder.
export type SkillParamType = 'text' | 'url' | 'number' | 'seconds' | 'boolean'
export type SkillParamValue = string | number | boolean
export type SkillParam = { key: string; label: string; type: SkillParamType; default: SkillParamValue; value: SkillParamValue; hint?: string }
export type SkillTrigger = { on: 'task-completed' | 'quota-panel'; show: string }
// What a quota-panel page gets (electron/project-stats.mts): lines of code and run tokens over time, oldest first.
export type StatPoint = { at: number; value: number }
export type ProjectStats = { workspace: string; lines: StatPoint[]; linesSource: 'git' | 'files' | 'none'; tokens: StatPoint[]; updatedAt: number }
export type SkillCommand = { name: string; run: string; description?: string }
export type SkillFile = { path: string; size: number }
// `id` is the host of orbit-skill://<id>/<file> (electron/skill-files.mts), `dir` the package folder.
export type SkillPackage = { id: string; dir: string }
// A trained agent is a capability with an `agent` field (electron/trained-agents.mts): a specialist profile whose playbook is the
// capability's `instructions`, with a package folder (scripts, references, gallery images), a training record and the usual
// track record (uses, successes, failures, lessons). spawn_agent {profile} runs a helper as it.
export type AgentKind = 'code' | 'review' | 'lookup' | 'text'
// One training round: `score` is the judges' mean (0..10), `scores` the per-criterion marks (criterion -> 0..10).
export type TrainingRound = { at: string; round: number; concepts: string[]; score: number; scores?: Record<string, number>; judges?: string[]; notes?: string }
export type AgentGalleryItem = { file: string; caption?: string }
export type AgentProfile = {
  role: string; kind?: AgentKind; reasoningEffort?: string; status: 'training' | 'trained'
  rounds: TrainingRound[]; gallery: AgentGalleryItem[]; trainingMinutes?: number
}
export type Capability = {
  id: string
  name: string
  description: string
  instructions: string
  scope: 'project' | 'global'
  workspace?: string
  whenToUse?: string
  version?: number | string
  updatedAt?: string
  source?: string
  uses?: number
  successes?: number
  failures?: number
  reliability?: number
  lessons?: string[]
  usedIn?: string[]
  pinned?: boolean
  enabled?: boolean
  files?: SkillFile[]
  params?: SkillParam[]
  triggers?: SkillTrigger[]
  commands?: SkillCommand[]
  package?: SkillPackage
  agent?: AgentProfile
  lastUsed?: string
  editedBy?: string
  revisions?: { version: number; name: string; description: string; instructions: string; updatedAt: string }[]
}
// A connector (an external MCP server agents add with connector_add; electron/connectors.mts) as the window sees it: no env or
// header values, a url without its query values.
export type ConnectorView = {
  name: string; description: string; scope: 'global' | 'project'; enabled: boolean; addedAt: string; transport: 'stdio' | 'http'
  command?: string; args?: string[]; envKeys?: string[]; url?: string; headerNames?: string[]; shadowedBy?: 'global' | 'project'
}
export type ConnectorTestResult = { ok: boolean; name: string; transport: 'stdio' | 'http'; tools?: { name: string; description?: string }[]; server?: string; error?: string; elapsedMs: number }
export type Workspace = GitContext & { name: string; description?: string }
// The endless improvement loop of one chat (renderer-driven, saved with the chat): while active and the improvement switch
// is on, each ended run of the chat is followed by the next task as a new run with a fresh context (src/improvement-loop.ts).
// iteration = the task number of the latest loop start; lastRunId = the run whose outcome was handled last; startingAt = when
// the latest loop start was requested (ms); closedKeys = `id|title` of plan tasks already closed (`|blocked` added for a
// blocked one). failures = runs in a row that failed or moved nothing; startFailures / busyStarts = starts in a row the
// runtime refused (for another reason / because Orbit was busy), cleared once a started run is handled.
export type LoopStopReason = 'user' | 'switch' | 'blocked' | 'manual' | 'moved'
export type ImprovementLoop = {
  active: boolean; goal: string; startedAt: string; iteration: number; failures: number; retryAt?: number
  startFailures?: number; busyStarts?: number
  lastRunId?: string; startingAt?: number; closedKeys: string[]; stopped?: { reason: LoopStopReason; at: string }
}
// A later run of a chat that its root agent scheduled with schedule_wakeup (electron/runtime/wakeups.mts); the renderer keeps
// and fires it (src/wakeups.ts). dueAt = when it is due (ms); createdAt = when it was scheduled (ISO); runId = the run that
// scheduled it. manual = the user pressed «Сейчас». retryAt / failures = a start that was refused: not before retryAt (ms).
export type Wakeup = { id: string; dueAt: number; task: string; reason: string; createdAt: string; runId?: string; manual?: boolean; retryAt?: number; failures?: number }
export type ChatThread = { id: string; title: string; messages: Message[]; updated: string; loop?: ImprovementLoop; wakeups?: Wakeup[] }
export type Project = { id: string; workspace: Workspace; chats: ChatThread[]; activeChatId?: string; globalMemoryEnabled?: boolean; deletedChatIds?: string[] }
// An image a tool result showed the agent (a screenshot it read): the run store's file name, its type and size in bytes.
export type TraceImage = { id: string; mediaType: string; bytes: number }
export type TraceItem = { id: string; agentId?: string; agentName?: string; kind: string; text: string; time: string; images?: TraceImage[] }
export type Communication = {
  id: string
  fromAgentId: string
  toAgentId: string
  fromAgentName: string
  toAgentName: string
  text: string
  time: string
  status: 'queued' | 'delivered' | 'read'
  delivery: 'next-turn' | 'mailbox' | 'tool-result'
  deliveredAt?: string
  readAt?: string
  kind?: 'spawn' | 'followup' | 'message' | 'notice'
  reason?: string
  replyTo?: string
  discussionId?: string
  // 'user': a message the user sent an agent of a working run (fromAgentId 'user').
  via?: 'router' | 'user'
  route?: { via: 'direct' | 'explicit' | 'match' | 'reply' | 'escalation'; reasons: string[] }
  about?: string
  aboutName?: string
  paths?: string[]
  conflict?: boolean
}
// What window.orbit.messageAgent answers once the message is in the agent's mailbox; a refusal rejects with the reason.
export type AgentMessageResult = { ok: true; communicationId: string; agentId: string; status: Communication['status']; delivery: Communication['delivery'] }
// What window.orbit.pauseAgent / resumeAgent / stopAgent answer; a refusal rejects with the reason.
export type AgentControlResult = { ok: true; agentId: string; status: AgentStatus; paused: boolean }
export type RunSnapshot = {
  runId: string
  projectId: string
  chatId: string
  status: RunStatus
  prompt: string
  workspace: string
  agents: Agent[]
  traces: TraceItem[]
  messages: Message[]
  communications: Communication[]
  files?: FileTouch[]
  changes?: FileChange[]
  router?: { routed: number; notices: number; refused: number }
  startedAt: string
  updatedAt?: string
  finishedAt?: string
  providerId?: string
  model?: string
  summary?: string | { text: string; agentCount: number; providerTurns: number }
  error?: string
  improvements?: ImprovementTask[]
  improvementStatus?: string
  improvementMode?: boolean
  // An endless-improvement loop task: its number in the chat's loop, and what the plan hands to the next task's fresh context.
  loopTask?: number
  improvementHandoff?: string
  limits?: RunLimits
  usage?: RunUsage
  streaming?: StreamingMessage
  // A continuation Orbit started itself after a restart: the run it continues and how many restarts in a row led here.
  resumedFrom?: string
  resumeChain?: number
  // Set on a run that ended with status 'restarting': why and when its agent asked for the restart.
  restart?: RunRestart
}
export type RunRestart = { reason: string; requestedAt: string; source: 'tool' | 'script' }
// What the runtime reports after a restart_orbit restart (channel restart:notice): the continuation started, or why not.
export type RestartNoticeKind = 'resumed' | 'rolled-back' | 'loop-limit' | 'expired' | 'failed'
export type RestartNotice = {
  kind: RestartNoticeKind
  chatId: string | null
  projectId: string | null
  runId: string | null
  resumedRunId?: string
  text: string
  reason?: string
  level?: 'runtime' | 'full'
  patch?: string
  error?: string
  time: string
}
// The runtime child process as main's client sees it (runtime:status, runtime:status-changed). since = when this state
// began (ms), lastRestartMs = how long the last restart took. retrying: an automatic restart is scheduled (only after a
// crash of a runtime that had been ready; a start that failed, another protocol, changed shell files or too many crashes
// are not retried). lastError: the last error nothing caught in the running runtime process, which keeps running
// (count = how many so far; at = when main heard of it); a new process starts without it.
export type RuntimeState = 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'
export type RuntimeStatus = {
  state: RuntimeState
  mode: 'child' | 'inprocess'
  pid: number | null
  since: number
  lastRestartMs: number | null
  restarts: number
  retrying: boolean
  error?: string
  lastError?: { message: string; at: number; count: number }
}
export type RunLimits = {
  maxAgents: number | null; maxDepth: number | null; maxConcurrent: number | null; maxTurns: number | null; maxTotalTurns: number | null
  maxMessages?: number | null; maxToolCalls?: number | null; timeoutMs?: number | null; runTimeoutMs?: number | null
  maxContextChars?: number; maxOutputChars?: number
}
// base/label/accountDir are the identity fields of a subscription instance's entry (src/subscriptions.ts instanceOptions); the rest are CLI options.
export type ProviderOption = {
  command?: string; reasoningEffort?: string; proxyMode?: 'system' | 'inherit' | 'custom' | 'direct'; proxyUrl?: string
  base?: string; label?: string; accountDir?: string
}
// A second (third, ...) account of one provider: `id` is its provider id ("claude-2"), `base` the provider whose CLI runs it, `dir` its own configuration folder.
export type BaseProvider = 'claude' | 'codex' | 'antigravity' | 'cursor'
export type SubscriptionInstance = { id: string; base: BaseProvider; label: string; dir: string }
export type PoolMember = { providerId: string; model: string; purpose?: string; reasoningEffort?: string }
export type ImprovementTask = { id: string; title: string; status: 'pending' | 'working' | 'done' | 'blocked'; evidence: string }
export type Settings = {
  providerId: string
  models: Record<string, string>
  reasoningEffort?: string
  memoryEnabled: boolean
  accessMode: AccessMode
  approvalPolicy: ApprovalPolicy
  agentInstructions: string
  limits: RunLimits
  limitVersion?: number
  improvementMode?: boolean
  skillLearning?: boolean
  providerOptions?: Record<string, ProviderOption>
  providerPool?: PoolMember[]
  subscriptions?: SubscriptionInstance[]
  quotaFailover?: QuotaFailover
}
export type AppState = { version: number; projects: Project[]; activeProjectId: string; settings: Settings; savedAt?: number }
