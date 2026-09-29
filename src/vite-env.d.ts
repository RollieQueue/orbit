/// <reference types="vite/client" />
interface GitContext {
  connected: boolean
  path: string
  gitRoot?: string
  workspaceMode?: 'git-root' | 'folder'
  branch: string
  changedFiles: number
  lastCommit?: string
}
interface Window {
  orbit?: {
    pickWorkspace: () => Promise<GitContext | null>
    inspectWorkspace: (workspace: string) => Promise<GitContext>
    cloneWorkspace: (remote: string) => Promise<(GitContext & { error?: string }) | null>
    startTask: (payload: { projectId: string; chatId: string; prompt: string; history: { role: 'user' | 'assistant'; content: string }[]; workspace: string; memoryEnabled: boolean; globalMemoryEnabled?: boolean; reasoningEffort?: string; providerId: string; model?: string; models?: Record<string, string>; quotaFailover?: import('./types').QuotaFailover; providerPool?: import('./types').PoolMember[]; providerOptions?: Record<string, import('./types').ProviderOption>; agentInstructions: string; accessMode: import('./types').AccessMode; approvalPolicy: import('./types').ApprovalPolicy; limits: import('./types').RunLimits }) => Promise<string>
    stopTask: (runId: string) => Promise<boolean>
    listRuns: () => Promise<import('./types').RunSnapshot[]>
    projectIndexStatus: (workspace: string, rebuild?: boolean) => Promise<ProjectIndexStatus | null>
    getRun: (runId: string) => Promise<import('./types').RunSnapshot | null>
    loadState: () => Promise<import('./types').AppState | null>
    saveState: (state: import('./types').AppState) => Promise<unknown>
    listMemory: (workspace: string, chatId?: string) => Promise<import('./types').MemoryEntry[]>
    saveMemory: (entry: Partial<import('./types').MemoryEntry>) => Promise<import('./types').MemoryEntry>
    removeMemory: (id: string, workspace: string, chatId?: string) => Promise<unknown>
    pinMemory: (id: string, pinned: boolean, workspace: string, chatId?: string) => Promise<import('./types').MemoryEntry>
    setMemorySharing: (workspace: string, enabled: boolean) => Promise<boolean>
    forgetChatMemory: (workspace: string, chatId: string) => Promise<number>
    memoryStats: (workspace: string, chatId?: string) => Promise<import('./types').LibraryStats>
    listCapabilities: (workspace: string) => Promise<import('./types').Capability[]>
    pinCapability: (id: string, pinned: boolean, workspace: string) => Promise<import('./types').Capability>
    readCapability: (id: string, workspace: string) => Promise<import('./types').Capability>
    installCapability: (entry: Partial<import('./types').Capability>) => Promise<import('./types').Capability>
    removeCapability: (id: string, workspace: string) => Promise<unknown>
    restoreCapability: (id: string, version: number, workspace: string) => Promise<import('./types').Capability>
    checkProviders: (options?: Record<string, import('./types').ProviderOption>) => Promise<ProviderHealth[]>
    getQuotas: (options?: Record<string, import('./types').ProviderOption>, force?: boolean) => Promise<Record<string, import('./types').QuotaSnapshot>>
    onQuotaUpdate: (handler: (update: { providerId: string; snapshot: import('./types').QuotaSnapshot | null }) => void) => () => void
    onRuntimeEvent: (handler: (event: RuntimeEvent) => void) => () => void
    openExternal: (target: string) => Promise<void>
    platform: string
  }
}
interface ProjectIndexStatus {
  files: number
  lines: number
  languages: Record<string, number>
  omitted: number
  updatedAt: string | null
  indexing: boolean
}
interface ProviderHealth {
  id: string
  reasoningLevels?: Record<string, string[]>
  models?: string[]
  model?: string
  available: boolean
  detail: string
  authenticated?: boolean
  authDetail?: string
  executable?: string
}
interface RuntimeEvent {
  type: 'run.started' | 'run.info' | 'agent.created' | 'agent.updated' | 'agent.handover' | 'trace.added' | 'message.added' | 'communication.added' | 'run.finished' | 'run.cancelled' | 'run.failed'
  runId: string
  projectId: string
  chatId: string
  workspace?: string
  prompt?: string
  providerId?: string
  model?: string
  agentId?: string
  status?: import('./types').RunStatus
  agent?: import('./types').Agent
  handover?: import('./types').Handover
  trace?: import('./types').TraceItem
  message?: import('./types').Message
  communication?: import('./types').Communication
  summary?: string | { text: string; agentCount: number; providerTurns: number }
  error?: string
  warning?: string
  limits?: import('./types').RunLimits
  improvements?: import('./types').ImprovementTask[]
  improvementStatus?: string
  usage?: { providerTurns: number; workerTurns?: number }
  router?: { routed: number; notices: number; refused: number }
}
