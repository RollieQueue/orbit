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
}
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
export type MemoryEntry = {
  id: string
  title: string
  content: string
  type: 'decision' | 'pattern' | 'preference' | 'fact'
  scope: 'project' | 'global'
  workspace?: string
  updated: string
  confidence?: number
}
export type Capability = {
  id: string
  name: string
  description: string
  instructions: string
  scope: 'project' | 'global'
  workspace?: string
  version?: number | string
  updatedAt?: string
  source?: string
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
  kind?: 'spawn' | 'followup' | 'message'
  reason?: string
  replyTo?: string
  discussionId?: string
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
  providerOptions?: Record<string, ProviderOption>
  providerPool?: PoolMember[]
}
export type AppState = { version: number; projects: Project[]; activeProjectId: string; settings: Settings; savedAt?: number }
