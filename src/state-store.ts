import type { AccessMode, AppState, ChatThread, ImprovementLoop, LoopStopReason, Message, Project, RestartNotice, RestartNoticeKind, RunSnapshot, Settings, Wakeup, Workspace } from './types'
import { mergeMessage, type RunMap } from './run-events'
import { loopNote, loopNoteId, stopNote, stoppedLoop } from './improvement-loop'
import { sanitizeWakeups } from './wakeups'
import { providers } from './providers'
import { attachmentNote } from './attachments'

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
// A wake-up the runtime scheduled (added) or cancelled (removed) while the start-up load was in flight.
export type RestoredWakeup = { projectId: string; chatId: string; added?: Wakeup; removed?: string }

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
    ...p, chats: (Array.isArray(p.chats) ? p.chats : []).map(c => withWakeups(withLoop({ ...c, messages: messagesOf(c) }))),
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

// A saved loop that is not one any more is dropped; closedKeys is always a list.
function withLoop(chat: ChatThread): ChatThread {
  const loop = chat.loop
  if (loop === undefined) return chat
  if (!loop || typeof loop !== 'object' || typeof loop.goal !== 'string') { const { loop: _dropped, ...rest } = chat; return rest }
  const { startFailures, busyStarts, ...kept } = loop
  return {
    ...chat, loop: {
      ...kept, active: loop.active === true, iteration: Number.isFinite(loop.iteration) ? loop.iteration : 1,
      failures: Number.isFinite(loop.failures) ? loop.failures : 0, closedKeys: Array.isArray(loop.closedKeys) ? loop.closedKeys.filter(k => typeof k === 'string') : [],
      ...(Number.isFinite(startFailures) ? { startFailures } : {}), ...(Number.isFinite(busyStarts) ? { busyStarts } : {}),
    },
  }
}

// The saved wake-ups made valid (sanitizeWakeups); the key is dropped when none is left.
function withWakeups(chat: ChatThread): ChatThread {
  if (chat.wakeups === undefined) return chat
  const { wakeups, ...rest } = chat
  const kept = sanitizeWakeups(wakeups)
  return kept.length ? { ...rest, wakeups: kept } : rest
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
// its chat, its prompt as the user's message and the root agent's replies. A continuation Orbit started after a restart
// was not asked by the user: it gets the restart note instead of its prompt, and a task of an endless-improvement loop
// (loopTask) its loop note. Messages end up in time order.
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
    if (run.resumedFrom) {
      // The live notice's note, when it came, is kept: it says more than what the saved runs remember.
      const note = resumedNote(run, snapshots)
      if (!chat.messages.some(m => m.id === note.id)) next = addChatMessage(next, run.projectId, run.chatId, note)
    } else if (run.loopTask) {
      const known = chat.messages.some(m => m.id === loopNoteId(run.runId) || (m.kind === 'loop' && m.runId === run.runId))
      if (!known) next = addChatMessage(next, run.projectId, run.chatId, loopNote(run.runId, run.loopTask, run.startedAt))
    } else if (run.prompt && !chat.messages.some(m => m.author === 'user' && m.kind !== 'steer' && m.runId === run.runId)) {
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
// the root messages, the restart notices and the wake-up changes that arrived as live events while the load was in flight.
export function restoreState(
  local: AppState, saved: AppState | null, snapshots: RunSnapshot[], restoredDuringLoad: RestoredMessage[], noticesDuringLoad: RestartNotice[] = [], wakeupsDuringLoad: RestoredWakeup[] = [],
): AppState {
  const durable = saved ? normalize(saved) : null
  const merged = reconcileRuns(reconcileSaved(local, durable), snapshots)
  const restored = restoredDuringLoad.reduce((result, item) => addChatMessage(result, item.projectId, item.chatId, item.message), merged)
  const noted = noticesDuringLoad.reduce(addRestartNote, restored)
  return wakeupsDuringLoad.reduce((result, item) => item.added ? addWakeup(result, item.projectId, item.chatId, item.added) : removeWakeups(result, item.projectId, item.chatId, [item.removed!]), noted)
}

// ---- Restart notices: a system note in the chat whose run restarted Orbit, saved with the chat ----

const restartTexts: Record<RestartNoticeKind, string> = {
  resumed: 'Orbit перезапущен по запросу агента, задача продолжена',
  'rolled-back': 'Перезапуск не удался и откатился',
  'loop-limit': 'Продолжение не запущено: слишком много перезапусков подряд (предел ORBIT_UPGRADE_MAX_CYCLES)',
  expired: 'Намерение продолжить устарело (> 30 мин), продолжение не запущено',
  failed: 'Продолжение после перезапуска не запущено',
}
// One entry per notice. A 'resumed' note is keyed by the continuation, so the note rebuilt from the saved runs and the
// live notice are the same entry.
const restartNoteId = (notice: Pick<RestartNotice, 'kind' | 'runId' | 'resumedRunId' | 'time'>) =>
  `restart-${notice.kind}-${notice.kind === 'resumed' && notice.resumedRunId ? notice.resumedRunId : notice.runId || notice.time}`
// A 'resumed' note carries the continuation's run id: the chat has no user message for that run, the note stands for it.
export function restartNote(notice: RestartNotice): Message {
  const note: Message = {
    id: restartNoteId(notice), author: 'system', kind: 'restart', time: notice.time || now(),
    text: notice.text?.trim() || restartTexts[notice.kind] || 'Orbit перезапущен',
  }
  if (notice.kind === 'resumed' && notice.resumedRunId) note.runId = notice.resumedRunId
  return note
}
// The note of a restart about `runId` that started no continuation, when the chat has one: how it ended and its text.
export function settlingRestart(chat: ChatThread, runId: string): { kind: RestartNoticeKind; text: string } | undefined {
  for (const message of chat.messages) {
    const kind = settlingKinds.find(item => message.id === restartNoteId({ kind: item, runId, time: '' }))
    if (kind) return { kind, text: message.text }
  }
  return undefined
}
export const settlingRestartText = (chat: ChatThread, runId: string) => settlingRestart(chat, runId)?.text
// The chat card of a run that ended by restarting Orbit, after «Перезапуск Orbit»: why the agent restarted it and, once
// the chat has the note of a restart that started no continuation, how that ended. Under a rollback note the card no
// longer says the agent restarted Orbit.
export function restartCardDetail(run: Pick<RunSnapshot, 'restart'>, outcome?: RestartNoticeKind): string {
  const reason = run.restart?.reason ? `: ${run.restart.reason}` : ''
  if (outcome === 'rolled-back') return ` не удался и откатился, работает прежний код. Агент перезапускал Orbit${reason}.`
  return `. Агент перезапустил Orbit${reason}.${outcome && outcome !== 'resumed' ? ' Продолжение не запущено.' : ''}`
}
// The note a saved continuation gets when its live notice never reached this window (or before it does).
function resumedNote(run: RunSnapshot, snapshots: RunSnapshot[]): Message {
  const reason = snapshots.find(item => item.runId === run.resumedFrom)?.restart?.reason
  return restartNote({
    kind: 'resumed', projectId: run.projectId, chatId: run.chatId, runId: run.resumedFrom || null, resumedRunId: run.runId, time: run.startedAt,
    text: `${restartTexts.resumed}${reason ? ` (причина: ${reason})` : ''}`,
  })
}
// The chat a notice belongs to: its project and chat, or the project that holds its chat; null when this state has neither.
function restartTarget(state: AppState, notice: RestartNotice): { projectId: string; chatId: string } | null {
  if (!notice.chatId) return null
  const holds = (project: Project) => project.chats.some(c => c.id === notice.chatId)
  const project = state.projects.find(p => p.id === notice.projectId && holds(p)) || state.projects.find(holds)
  return project ? { projectId: project.id, chatId: notice.chatId } : null
}
export function addRestartNote(state: AppState, notice: RestartNotice): AppState {
  const target = restartTarget(state, notice)
  return target ? addChatMessage(state, target.projectId, target.chatId, restartNote(notice)) : state
}

// ---- The pause between a restart_orbit restart and its continuation ----

// The runtime restarts, then waits up to 30 s for the verdict on the new code before it starts the continuation
// (electron/resume.mts); a full restart also relaunches the window. Two minutes cover that with room to spare.
export const RESTART_WAIT_MS = 2 * 60 * 1000
export const RESTART_WAIT_TEXT = 'Orbit перезапускается, задача продолжится автоматически'
// Notices that start no continuation: their note, keyed by the run they are about, ends the wait for it.
const settlingKinds: RestartNoticeKind[] = ['rolled-back', 'loop-limit', 'expired', 'failed']

// Chats whose latest run ended 'restarting' (its agent restarted Orbit) and whose continuation has not come yet, as
// `${projectId}/${chatId}` keys with the time (ms) the wait ends. Such a chat is busy, not idle: the runtime starts the
// continuation in it and refuses to while another run of the chat is active (the user's message would win and the
// continuation be lost), and a deleted chat would hide it. The wait is over once the chat has a later run (the
// continuation), or the note of a restart notice that started none, and RESTART_WAIT_MS after the run ended at the latest
// (either way: a clock that stepped back does not hold the chat longer).
export function restartWaits(state: AppState, runs: RunMap, at = Date.now()): Map<string, number> {
  const waits = new Map<string, number>()
  const list = Object.values(runs)
  for (const run of list) {
    if (run.status !== 'restarting') continue
    const ended = Date.parse(run.finishedAt || run.updatedAt || run.startedAt)
    if (Number.isNaN(ended) || Math.abs(at - ended) >= RESTART_WAIT_MS) continue
    const chat = state.projects.find(p => p.id === run.projectId)?.chats.find(c => c.id === run.chatId)
    if (!chat) continue
    const later = list.some(other => other.runId !== run.runId && other.projectId === run.projectId && other.chatId === run.chatId
      && (other.resumedFrom === run.runId || String(other.startedAt) > String(run.startedAt)))
    if (!later && !settlingRestart(chat, run.runId)) waits.set(`${run.projectId}/${run.chatId}`, ended + RESTART_WAIT_MS)
  }
  return waits
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
// ---- The endless improvement loop of a chat (src/improvement-loop.ts decides, these transitions save) ----

export const setChatLoop = (state: AppState, projectId: string, chatId: string, loop: ImprovementLoop): AppState =>
  updateChat(state, projectId, chatId, c => ({ ...c, loop }))
// A note about the loop's state in its chat (a retry, a stop); not a loop task's note (kind 'loop').
export const loopStateNote = (text: string, at: string, id: string = uid()): Message => ({ id, author: 'system', kind: 'loop-state', text, time: at })
export function stopLoop(state: AppState, projectId: string, chatId: string, reason: LoopStopReason, at = now(), note = stopNote(reason)): AppState {
  const loop = state.projects.find(p => p.id === projectId)?.chats.find(c => c.id === chatId)?.loop
  if (!loop?.active) return state
  return addChatMessage(setChatLoop(state, projectId, chatId, stoppedLoop(loop, reason, at)), projectId, chatId, loopStateNote(note, at))
}
// A message sent with the improvement switch on started a run: the chat's loop begins (goal = the message, task 1, the
// closed tasks of the chat's newest plan as the baseline) or, when it has one, goes on (goal kept, failures and a pending
// retry cleared). One active loop in all of Orbit: the others stop ('moved'). A second loop would keep a chat working
// almost all the time, and restart_orbit refuses while other chats work, so Orbit's own changes would never be installed.
export function activateLoop(state: AppState, projectId: string, chatId: string, goal: string, closedKeys: string[], at = now()): AppState {
  const project = state.projects.find(p => p.id === projectId)
  const chat = project?.chats.find(c => c.id === chatId)
  if (!project || !chat) return state
  let next = state
  for (const otherProject of state.projects) {
    for (const other of otherProject.chats) {
      if ((otherProject.id !== projectId || other.id !== chatId) && other.loop?.active) next = stopLoop(next, otherProject.id, other.id, 'moved', at)
    }
  }
  const loop: ImprovementLoop = chat.loop
    ? { ...chat.loop, active: true, failures: 0 }
    : { active: true, goal, startedAt: at, iteration: 1, failures: 0, closedKeys }
  delete loop.retryAt
  delete loop.stopped
  delete loop.startingAt
  delete loop.startFailures
  delete loop.busyStarts
  return setChatLoop(next, projectId, chatId, loop)
}

// ---- Scheduled wake-ups of a chat (src/wakeups.ts decides, these transitions save) ----

const chatOf = (state: AppState, projectId: string, chatId: string) => state.projects.find(p => p.id === projectId)?.chats.find(c => c.id === chatId)
const withWakeupList = (chat: ChatThread, list: Wakeup[]): ChatThread => {
  const { wakeups: _old, ...rest } = chat
  return list.length ? { ...rest, wakeups: list } : rest
}
// A wake-up the runtime scheduled: one with the same id is replaced; the list stays sorted by due time and bounded.
export function addWakeup(state: AppState, projectId: string, chatId: string, wakeup: Wakeup): AppState {
  const chat = chatOf(state, projectId, chatId)
  if (!chat) return state
  return updateChat(state, projectId, chatId, c => withWakeupList(c, sanitizeWakeups([...(c.wakeups || []).filter(w => w.id !== wakeup.id), wakeup])))
}
export function removeWakeups(state: AppState, projectId: string, chatId: string, ids: string[]): AppState {
  const chat = chatOf(state, projectId, chatId)
  if (!chat?.wakeups?.some(w => ids.includes(w.id))) return state
  return updateChat(state, projectId, chatId, c => withWakeupList(c, (c.wakeups || []).filter(w => !ids.includes(w.id))))
}
// Changes fields of one wake-up (a patched field set to undefined is removed); an unknown id changes nothing.
export function patchWakeup(state: AppState, projectId: string, chatId: string, id: string, patch: Partial<Wakeup>): AppState {
  if (!chatOf(state, projectId, chatId)?.wakeups?.some(w => w.id === id)) return state
  const patched = (w: Wakeup): Wakeup => {
    const next: Record<string, unknown> = { ...w, ...patch, id: w.id }
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    return next as Wakeup
  }
  return updateChat(state, projectId, chatId, c => withWakeupList(c, sanitizeWakeups((c.wakeups || []).map(w => w.id === id ? patched(w) : w))))
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

// The paths of a message's files come before its text: the runtime and the prompt cut a long entry at its end.
export const chatHistory = (chat: ChatThread) => chat.messages.filter(m => m.author === 'user' || m.author === 'orbit').slice(-40)
  .map(m => ({ role: m.author === 'user' ? 'user' as const : 'assistant' as const, content: [attachmentNote(m.attachments), m.text].filter(Boolean).join('\n\n') }))
// Ask mode is on-request approval over workspace-write; every other choice is an access mode with no approval prompts.
export const accessChoice = (settings: Settings) => settings.approvalPolicy === 'on-request' ? 'ask' : settings.accessMode
export const accessPatch = (value: string): Partial<Settings> =>
  ({ accessMode: value === 'ask' ? 'workspace-write' : value as AccessMode, approvalPolicy: value === 'ask' ? 'on-request' : 'never' })
export const modelPatch = (settings: Settings, model: string): Partial<Settings> => ({ models: { ...settings.models, [settings.providerId]: model } })
export const reasoningPatch = (settings: Settings, reasoningEffort: string): Partial<Settings> =>
  ({ providerOptions: { ...settings.providerOptions, [settings.providerId]: { ...settings.providerOptions?.[settings.providerId], reasoningEffort } } })
