import type { AccessMode, AppState, ChatThread, Message, Project, RunSnapshot, Settings, Workspace } from './types'
import { mergeMessage } from './run-events'
import { providers } from './providers'

// The renderer's persistent state (projects, chats, settings) and everything that restores or transforms it.
//
// Persistence has one source of truth: the main process (window.orbit.saveState / loadState, a file in the user data
// directory). localStorage keeps a mirror of the last save under STATE_KEY for one purpose: the first render, before
// the desktop answer arrives, already shows the last known state instead of an empty window. When the desktop copy
// arrives, reconcileSaved picks the newer of the two by `savedAt`, the timestamp stamped on every save.
//
// Everything here is pure. useOrbitState is the only place that touches the browser or the desktop bridge.

export const STATE_KEY = 'orbit:state:v3'
export const NEW_CHAT_TITLE = 'Новый чат'
export type RestoredMessage = { projectId: string; chatId: string; message: Message }

export const defaults: Settings = {
  providerId: 'codex', models: {}, limitVersion: 2, improvementMode: false, skillLearning: true, providerPool: [], providerOptions: {},
  quotaFailover: { enabled: true, switchAtPercent: 90, allowWeaker: false }, memoryEnabled: true, accessMode: 'workspace-write',
  approvalPolicy: 'on-request', reasoningEffort: '', agentInstructions: '',
  limits: { maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null },
}
// Limits an older version wrote as defaults; a saved value equal to one of them means "never chosen" and becomes unlimited.
const legacyLimits = { maxAgents: 12, maxDepth: 3, maxConcurrent: 3, maxTurns: 12, maxTotalTurns: 48 }

export const uid = () => crypto.randomUUID()
export const now = () => new Date().toISOString()
const trimSlashes = (path: string) => path.replace(/[\\/]+$/, '')
export const nameOf = (path: string) => trimSlashes(path).split(/[\\/]/).pop() || 'Проект'
export function newChat(): ChatThread { return { id: uid(), title: NEW_CHAT_TITLE, messages: [], updated: now() } }

// ---- Loading ----

type Reader = (key: string) => string | null
function stored<T>(read: Reader, key: string, fallback: T): T {
  try { return JSON.parse(read(key) || 'null') ?? fallback } catch { return fallback }
}

// A saved state of any earlier version, made valid for this one.
export function normalize(value: Partial<AppState>): AppState {
  const savedProjects = Array.isArray(value.projects) ? value.projects : []
  const messagesOf = (c: ChatThread) => (Array.isArray(c.messages) ? c.messages : []).filter(m => m.id !== 'welcome')
  const projects = savedProjects.filter(p => p?.id && p.workspace?.path).map(p => ({
    ...p, chats: (Array.isArray(p.chats) ? p.chats : []).map(c => ({ ...c, messages: messagesOf(c) })),
  }))
  const settings = { ...defaults, ...value.settings, models: { ...value.settings?.models }, limits: { ...defaults.limits, ...value.settings?.limits } }
  if (!value.settings?.limitVersion) {
    for (const key of Object.keys(legacyLimits) as (keyof typeof legacyLimits)[]) if (settings.limits[key] === legacyLimits[key]) settings.limits[key] = null
    settings.limitVersion = 2
  }
  if (!providers.some(p => p.id === settings.providerId)) settings.providerId = 'codex'
  if (!['never', 'on-request', 'auto-review'].includes(settings.approvalPolicy)) settings.approvalPolicy = 'on-request'
  const savedFailover = value.settings?.quotaFailover, savedPercent = Number(savedFailover?.switchAtPercent)
  settings.quotaFailover = {
    enabled: savedFailover?.enabled !== false,
    switchAtPercent: Number.isFinite(savedPercent) ? Math.max(50, Math.min(99, Math.round(savedPercent))) : 90,
    allowWeaker: savedFailover?.allowWeaker === true,
  }
  settings.providerOptions = { ...settings.providerOptions }
  if (settings.reasoningEffort && settings.providerOptions[settings.providerId]?.reasoningEffort === undefined) {
    settings.providerOptions[settings.providerId] = { ...settings.providerOptions[settings.providerId], reasoningEffort: settings.reasoningEffort }
  }
  settings.reasoningEffort = ''
  // Google models have reasoning built in; values saved by older versions must not linger or be resent.
  const google = settings.providerOptions.antigravity
  if (google?.reasoningEffort) settings.providerOptions.antigravity = { ...google, reasoningEffort: '' }
  settings.providerPool = (settings.providerPool || []).map(member =>
    member.providerId === 'antigravity' && member.reasoningEffort ? { ...member, reasoningEffort: '' } : member)
  const activeProjectId = projects.some(p => p.id === value.activeProjectId) ? value.activeProjectId! : projects[0]?.id || ''
  return { version: 3, projects, activeProjectId, settings, savedAt: value.savedAt }
}

// The state for the first render: the mirror of the last save, or the separate keys versions before v3 used.
export function initialState(read: Reader): AppState {
  const saved = stored<AppState | null>(read, STATE_KEY, null)
  if (saved) return normalize(saved)
  return normalize({
    projects: stored<Project[]>(read, 'orbit:projects', []),
    activeProjectId: stored(read, 'orbit:active-project', ''),
    settings: {
      ...defaults,
      providerId: stored(read, 'orbit:preferred-provider', 'codex'),
      memoryEnabled: stored(read, 'orbit:memory-enabled', true),
      agentInstructions: stored(read, 'orbit:agent-instructions', ''),
    },
  })
}

// The desktop copy wins unless the mirror was stamped later: the renderer saved after the desktop's last write landed.
export function reconcileSaved(local: AppState, durable: AppState | null): AppState {
  return durable && (durable.savedAt || 0) >= (local.savedAt || 0) ? durable : local
}

// Runs the desktop kept for chats this state does not know (a chat deleted here stays deleted): each gets its project,
// its chat, its prompt as the user's message and the root agent's replies. Messages end up in time order.
export function reconcileRuns(state: AppState, snapshots: RunSnapshot[]): AppState {
  let next = state
  for (const run of [...snapshots].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))) {
    if (!run.runId || !run.projectId || !run.chatId || !run.workspace) continue
    if (next.projects.find(p => p.id === run.projectId)?.deletedChatIds?.includes(run.chatId)) continue
    if (!next.projects.some(p => p.id === run.projectId)) {
      const workspace: Workspace = { path: run.workspace, name: nameOf(run.workspace), connected: false, branch: '', changedFiles: 0 }
      next = { ...next, projects: [...next.projects, { id: run.projectId, workspace, chats: [] }] }
    }
    next = updateProject(next, run.projectId, p => p.chats.some(c => c.id === run.chatId) ? p : {
      ...p, chats: [...p.chats, { id: run.chatId, title: run.prompt?.slice(0, 52) || 'Восстановленный чат', messages: [], updated: run.startedAt }],
    })
    const chat = next.projects.find(p => p.id === run.projectId)!.chats.find(c => c.id === run.chatId)!
    if (run.prompt && !chat.messages.some(m => m.author === 'user' && m.runId === run.runId)) {
      const legacyMessage = chat.messages.find(m => m.author === 'user' && !m.runId && m.text === run.prompt)
      const message: Message = legacyMessage ? { ...legacyMessage, runId: run.runId }
        : { id: `prompt-${run.runId}`, author: 'user', text: run.prompt, time: run.startedAt, runId: run.runId }
      next = addChatMessage(next, run.projectId, run.chatId, message)
    }
    for (const message of run.messages || []) {
      if (!message.agentId || message.agentId === 'root') next = addChatMessage(next, run.projectId, run.chatId, { ...message, runId: run.runId })
    }
  }
  const byTime = (a: Message, b: Message) => {
    const left = Date.parse(a.time), right = Date.parse(b.time)
    return Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right
  }
  return { ...next, projects: next.projects.map(p => ({ ...p, chats: p.chats.map(c => ({ ...c, messages: [...c.messages].sort(byTime) })) })) }
}

// What the start-up load does to the state, in one step: pick the newer copy, fold in the saved runs, then re-apply
// the root messages that arrived as live events while the load was in flight.
export function restoreState(local: AppState, saved: AppState | null, snapshots: RunSnapshot[], restoredDuringLoad: RestoredMessage[]): AppState {
  const durable = saved ? normalize(saved) : null
  const merged = reconcileRuns(reconcileSaved(local, durable), snapshots)
  return restoredDuringLoad.reduce((result, item) => addChatMessage(result, item.projectId, item.chatId, item.message), merged)
}

// ---- Saving ----

export const stampSaved = (state: AppState, at: number): AppState => ({ ...state, savedAt: at })
export function mirrorState(snapshot: AppState) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snapshot)) } catch { /* Desktop also persists in its data directory. */ }
}
// One string per project switch of the shared memory; the runtime learns each project's choice when it changes.
export const sharingKey = (state: AppState) =>
  state.projects.map(p => `${p.workspace.path}\u0000${p.globalMemoryEnabled ?? state.settings.memoryEnabled ? 1 : 0}`).join('\u0001')
export function sharingEntries(key: string): { workspace: string; enabled: boolean }[] {
  return (key ? key.split('\u0001') : []).map(entry => { const [workspace, flag] = entry.split('\u0000'); return { workspace, enabled: flag === '1' } })
}

// ---- Transitions ----

export const updateProject = (state: AppState, projectId: string, update: (project: Project) => Project): AppState =>
  ({ ...state, projects: state.projects.map(p => p.id === projectId ? update(p) : p) })
const updateChat = (state: AppState, projectId: string, chatId: string, update: (chat: ChatThread) => ChatThread) =>
  updateProject(state, projectId, p => ({ ...p, chats: p.chats.map(c => c.id === chatId ? update(c) : c) }))
export const withSettings = (state: AppState, patch: Partial<Settings>): AppState => ({ ...state, settings: { ...state.settings, ...patch } })
export const selectProject = (state: AppState, projectId: string): AppState => ({ ...state, activeProjectId: projectId })
export const selectChat = (state: AppState, projectId: string, chatId: string) => updateProject(state, projectId, p => ({ ...p, activeChatId: chatId }))
export const setGlobalMemory = (state: AppState, projectId: string, enabled: boolean) =>
  updateProject(state, projectId, p => ({ ...p, globalMemoryEnabled: enabled }))
export const openChat = (state: AppState, projectId: string, chat: ChatThread) =>
  updateProject(state, projectId, p => ({ ...p, activeChatId: chat.id, chats: [chat, ...p.chats] }))

export function addChatMessage(state: AppState, projectId: string, chatId: string, message: Message): AppState {
  return updateChat(state, projectId, chatId, c => ({ ...c, updated: now(), messages: mergeMessage(c.messages, message) }))
}
export const dropMessage = (state: AppState, projectId: string, chatId: string, messageId: string) =>
  updateChat(state, projectId, chatId, c => ({ ...c, messages: c.messages.filter(m => m.id !== messageId) }))
// The first prompt names a chat that still has the default title.
export const titleChat = (state: AppState, projectId: string, chatId: string, prompt: string) =>
  updateProject(state, projectId, p => ({
    ...p, chats: p.chats.map(c => c.id === chatId && c.title === NEW_CHAT_TITLE ? { ...c, title: prompt.replace(/\s+/g, ' ').slice(0, 54) } : c),
  }))

// The deleted chat's id is remembered so a run the desktop still has for it is not restored as a chat again.
export function removeChat(state: AppState, projectId: string, chatId: string, replacement: () => ChatThread = newChat): AppState {
  return updateProject(state, projectId, p => {
    const remaining = p.chats.filter(c => c.id !== chatId)
    const chats = remaining.length ? remaining : [replacement()]
    return {
      ...p, chats, activeChatId: chats.some(c => c.id === p.activeChatId) ? p.activeChatId : chats[0].id,
      deletedChatIds: [...new Set([...(p.deletedChatIds || []), chatId])],
    }
  })
}
// A workspace already open (same path, any case, with or without a trailing slash) is selected instead of added twice.
export function addWorkspace(state: AppState, workspace: Workspace, chat: () => ChatThread = newChat): AppState {
  const existing = state.projects.find(p => trimSlashes(p.workspace.path).toLowerCase() === trimSlashes(workspace.path).toLowerCase())
  if (existing) return { ...state, activeProjectId: existing.id }
  const first = chat()
  const next: Project = { id: uid(), workspace, chats: [first], activeChatId: first.id }
  return { ...state, projects: [...state.projects, next], activeProjectId: next.id }
}

// ---- Views of the settings the composer and the settings panel share ----

export const chatHistory = (chat: ChatThread) => chat.messages.filter(m => m.author === 'user' || m.author === 'orbit').slice(-40)
  .map(m => ({ role: m.author === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
// Ask mode is on-request approval over workspace-write; every other choice is an access mode with no approval prompts.
export const accessChoice = (settings: Settings) => settings.approvalPolicy === 'on-request' ? 'ask' : settings.accessMode
export const accessPatch = (value: string): Partial<Settings> =>
  ({ accessMode: value === 'ask' ? 'workspace-write' : value as AccessMode, approvalPolicy: value === 'ask' ? 'on-request' : 'never' })
export const modelPatch = (settings: Settings, model: string): Partial<Settings> => ({ models: { ...settings.models, [settings.providerId]: model } })
export const reasoningPatch = (settings: Settings, reasoningEffort: string): Partial<Settings> =>
  ({ providerOptions: { ...settings.providerOptions, [settings.providerId]: { ...settings.providerOptions?.[settings.providerId], reasoningEffort } } })
