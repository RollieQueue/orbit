/// <reference types="vite/client" />
// BEGIN generated from electron/ipc-contract.cjs by scripts/gen-ipc-types.cjs; do not edit between the markers.
type StartTaskPayload = { projectId: string; chatId: string; prompt: string; history: { role: 'user' | 'assistant'; content: string }[]; workspace: string; memoryEnabled: boolean; globalMemoryEnabled?: boolean; reasoningEffort?: string; providerId: string; model?: string; models?: Record<string, string>; quotaFailover?: import('./types').QuotaFailover; providerPool?: import('./types').PoolMember[]; providerOptions?: Record<string, import('./types').ProviderOption>; agentInstructions: string; accessMode: import('./types').AccessMode; approvalPolicy: import('./types').ApprovalPolicy; limits: import('./types').RunLimits; improvementMode?: boolean; skillLearning?: boolean; loopTask?: number; wakeups?: import('./types').Wakeup[]; attachments?: import('./types').Attachment[] }
type ApplyArtifactPayload = { workspace: string; patchPath: string; worktreePath?: string }
type ApplyArtifactResult = { ok: boolean; reason?: string; detail?: string }
type QuotaUpdate = { providerId: string; snapshot: import('./types').QuotaSnapshot | null }
type RuntimeRestartResult = { ok: boolean; ms: number; pid: number | null; error?: string }
type AccountLoginRequest = { id: string; base: string; dir: string; command?: string }
type AccountRemoveRequest = { id: string; dir: string; deleteFiles: boolean }
type AccountRemoveResult = { deleted: boolean; reason?: 'not-requested' | 'declined' | 'unmanaged' | 'missing' | 'failed'; error?: string }
// The preload bridge (electron/preload.cjs) to Orbit's main process; absent when the renderer runs in a plain browser.
interface OrbitBridge {
  pickWorkspace: () => Promise<GitContext | null>
  inspectWorkspace: (workspace: string) => Promise<GitContext>
  cloneWorkspace: (remote: string) => Promise<(GitContext & { error?: string }) | null>
  startTask: (payload: StartTaskPayload) => Promise<string>
  stopTask: (runId: string) => Promise<boolean>
  pauseAgent: (runId: string, agentId: string) => Promise<import('./types').AgentControlResult>
  resumeAgent: (runId: string, agentId: string) => Promise<import('./types').AgentControlResult>
  stopAgent: (runId: string, agentId: string) => Promise<import('./types').AgentControlResult>
  listRuns: () => Promise<import('./types').RunSnapshot[]>
  getRun: (runId: string) => Promise<import('./types').RunSnapshot | null>
  getRunChanges: (runId: string) => Promise<import('./types').FileChange[]>
  readTraceImage: (runId: string, imageId: string) => Promise<string | null>
  messageAgent: (runId: string, agentId: string, text: string, attachments?: import('./types').Attachment[]) => Promise<import('./types').AgentMessageResult>
  saveAttachments: (chatId: string, files: import('./types').AttachmentUpload[]) => Promise<import('./types').Attachment[]>
  readAttachmentImage: (path: string) => Promise<string | null>
  discardAttachments: (chatId: string, paths?: string[]) => Promise<number>
  loadState: () => Promise<import('./types').AppState | null>
  saveState: (state: import('./types').AppState) => Promise<unknown>
  projectIndexStatus: (workspace: string, rebuild?: boolean) => Promise<ProjectIndexStatus | null>
  listMemory: (workspace: string, chatId?: string) => Promise<import('./types').MemoryEntry[]>
  saveMemory: (entry: Partial<import('./types').MemoryEntry>) => Promise<import('./types').MemoryEntry>
  removeMemory: (id: string, workspace: string, chatId?: string) => Promise<unknown>
  pinMemory: (id: string, pinned: boolean, workspace: string, chatId?: string) => Promise<import('./types').MemoryEntry>
  setMemorySharing: (workspace: string, enabled: boolean) => Promise<boolean>
  forgetChatMemory: (workspace: string, chatId: string) => Promise<number>
  memoryStats: (workspace: string, chatId?: string) => Promise<import('./types').LibraryStats>
  listCapabilities: (workspace: string) => Promise<import('./types').Capability[]>
  pinCapability: (id: string, pinned: boolean, workspace: string) => Promise<import('./types').Capability>
  setCapabilityEnabled: (id: string, enabled: boolean, workspace: string) => Promise<import('./types').Capability>
  setCapabilityParams: (id: string, values: Record<string, import('./types').SkillParamValue>, workspace: string) => Promise<import('./types').Capability>
  readCapability: (id: string, workspace: string) => Promise<import('./types').Capability>
  installCapability: (entry: Partial<import('./types').Capability>) => Promise<import('./types').Capability>
  removeCapability: (id: string, workspace: string) => Promise<unknown>
  restoreCapability: (id: string, version: number, workspace: string) => Promise<import('./types').Capability>
  listConnectors: (workspace: string) => Promise<import('./types').ConnectorView[]>
  setConnectorEnabled: (name: string, enabled: boolean, scope: import('./types').ConnectorView['scope'], workspace: string) => Promise<import('./types').ConnectorView>
  removeConnector: (name: string, scope: import('./types').ConnectorView['scope'], workspace: string) => Promise<unknown>
  testConnector: (name: string, scope: import('./types').ConnectorView['scope'], workspace: string) => Promise<import('./types').ConnectorTestResult>
  checkProviders: (options?: Record<string, import('./types').ProviderOption>) => Promise<ProviderHealth[]>
  getQuotas: (options?: Record<string, import('./types').ProviderOption>, force?: boolean) => Promise<Record<string, import('./types').QuotaSnapshot>>
  projectStats: (workspace: string) => Promise<import('./types').ProjectStats>
  applyArtifact: (payload: ApplyArtifactPayload) => Promise<ApplyArtifactResult>
  openExternal: (target: string) => Promise<void>
  openPath: (target: string) => Promise<string>
  ping: () => Promise<{ pid: number; startedAt: number; healthy: boolean }>
  relaunch: () => Promise<{ ok: boolean; pid: number }>
  setFullScreen: (on: boolean) => Promise<boolean>
  restartRuntime: () => Promise<RuntimeRestartResult>
  getRuntimeStatus: () => Promise<import('./types').RuntimeStatus>
  prepareAccount: (base: string, taken: string[]) => Promise<{ id: string; dir: string }>
  loginAccount: (request: AccountLoginRequest) => Promise<{ ok: boolean; error?: string }>
  removeAccount: (request: AccountRemoveRequest) => Promise<AccountRemoveResult>
  onQuotaUpdate: (handler: (update: QuotaUpdate) => void) => () => void
  onRuntimeEvent: (handler: (event: RuntimeEvent) => void) => () => void
  onRestartNotice: (handler: (notice: import('./types').RestartNotice) => void) => () => void
  onRuntimeStatus: (handler: (status: import('./types').RuntimeStatus) => void) => () => void
}
interface Window { orbit?: OrbitBridge }
// END generated from electron/ipc-contract.cjs
interface GitContext {
  connected: boolean
  path: string
  gitRoot?: string
  workspaceMode?: 'git-root' | 'folder'
  branch: string
  changedFiles: number
  lastCommit?: string
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
  // Set for an extra subscription (id 'claude-2'): the provider whose CLI runs it, and the owner's name for it.
  base?: string
  label?: string
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
  type: 'run.started' | 'run.info' | 'agent.created' | 'agent.updated' | 'agent.handover' | 'trace.added' | 'message.streaming' | 'message.added' | 'communication.added' | 'change.added' | 'run.finished' | 'run.cancelled' | 'run.failed' | 'wakeup.scheduled' | 'wakeup.cancelled'
  runId: string
  projectId: string
  chatId: string
  workspace?: string
  prompt?: string
  providerId?: string
  model?: string
  agentId?: string
  // message.streaming: the root agent's answer so far (the whole text, not a delta); the final message.added reuses messageId.
  messageId?: string
  content?: string
  status?: import('./types').RunStatus
  agent?: import('./types').Agent
  handover?: import('./types').Handover
  trace?: import('./types').TraceItem
  message?: import('./types').Message
  communication?: import('./types').Communication
  change?: import('./types').FileChange
  summary?: string | { text: string; agentCount: number; providerTurns: number }
  error?: string
  warning?: string
  limits?: import('./types').RunLimits
  improvements?: import('./types').ImprovementTask[]
  improvementStatus?: string
  // An endless-improvement loop task's number (run.started) and the handoff its plan leaves the next task (null: none).
  loopTask?: number
  improvementHandoff?: string | null
  usage?: import('./types').RunUsage
  router?: { routed: number; notices: number; refused: number }
  // run.started of a continuation after a restart; the terminal event of a run that ended 'restarting' carries `restart`.
  resumedFrom?: string
  resumeChain?: number
  restart?: import('./types').RunRestart
  // wakeup.scheduled carries the new wake-up, wakeup.cancelled the id of the one the agent cancelled (the chat keeps the list).
  wakeup?: import('./types').Wakeup
  wakeupId?: string
}
