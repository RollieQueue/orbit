export type AccessMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type ApprovalPolicy = 'never' | 'on-request' | 'auto-review'
export type AgentStatus = 'idle' | 'waiting' | 'working' | 'done' | 'error' | 'cancelled' | 'interrupted'
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
}
export type AgentFiles = { read: string[]; wrote: string[] }
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
  reason: 'approaching' | 'exhausted' | 'replacement-failed'
  from: HandoverTarget
  to: HandoverTarget
  fresh: boolean
  interrupted: boolean
  usedPercent: number | null
  resetsAt: number | null
  note?: string
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
}
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
export type LibraryStats = { memory: { chat: TierStats; project: TierStats; global: TierStats; stored: number }; skills: { project: TierStats; global: TierStats; used: number } }
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
  lastUsed?: string
  editedBy?: string
  revisions?: { version: number; name: string; description: string; instructions: string; updatedAt: string }[]
}
export type Workspace = GitContext & { name: string; description?: string }
export type ChatThread = { id: string; title: string; messages: Message[]; updated: string }
export type Project = { id: string; workspace: Workspace; chats: ChatThread[]; activeChatId?: string; globalMemoryEnabled?: boolean; deletedChatIds?: string[] }
export type TraceItem = { id: string; agentId?: string; agentName?: string; kind: string; text: string; time: string }
export type Communication = {
  id: string
  fromAgentId: string
  toAgentId: string
  fromAgentName: string
  toAgentName: string
  text: string
  time: string
  status: 'queued' | 'delivered' | 'read'
  delivery: 'next-turn' | 'mailbox'
  deliveredAt?: string
  readAt?: string
  kind?: 'spawn' | 'followup' | 'message' | 'notice'
  reason?: string
  replyTo?: string
  discussionId?: string
  via?: 'router'
  route?: { via: 'direct' | 'explicit' | 'match' | 'reply' | 'escalation'; reasons: string[] }
  about?: string
  aboutName?: string
  paths?: string[]
  conflict?: boolean
}
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
  limits?: RunLimits
  usage?: { providerTurns: number; workerTurns?: number }
}
export type RunLimits = { maxAgents: number | null; maxDepth: number | null; maxConcurrent: number | null; maxTurns: number | null; maxTotalTurns: number | null; maxMessages?: number | null; maxToolCalls?: number | null; timeoutMs?: number | null; runTimeoutMs?: number | null; maxContextChars?: number; maxOutputChars?: number }
export type ProviderOption = { command?: string; reasoningEffort?: string; proxyMode?: 'system' | 'inherit' | 'custom' | 'direct'; proxyUrl?: string }
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
  quotaFailover?: QuotaFailover
}
export type AppState = { version: number; projects: Project[]; activeProjectId: string; settings: Settings; savedAt?: number }
