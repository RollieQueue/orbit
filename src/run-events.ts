import type { Agent, HandoverTarget, Message, RunSnapshot, RunStatus, TurnTiming } from './types'

// The renderer's view of runs: one snapshot per run id, updated by runtime events (applyRunEvent) and by the saved
// run list on start-up (restoreRuns). Pure functions with an injectable clock, so tests can replay recorded sequences.

export type RunMap = Record<string, RunSnapshot>
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted']
export const isActiveStatus = (status?: RunStatus) => status === 'working' || status === 'waiting'
const nowIso = () => new Date().toISOString()
const isRoot = (agentId?: string) => !agentId || agentId === 'root'

export function mergeMessage(messages: Message[], message: Message) {
  const index = messages.findIndex(m => m.id === message.id)
  return index < 0 ? [...messages, message] : messages.map(m => m.id === message.id ? { ...m, ...message } : m)
}
export function mergeById<T extends { id: string }>(saved: T[], live: T[]) {
  const records = new Map(saved.map(item => [item.id, item]))
  for (const item of live) records.set(item.id, { ...records.get(item.id), ...item })
  return [...records.values()]
}
export function snapshotBase(event: Partial<RuntimeEvent>, at = nowIso()): RunSnapshot {
  return {
    runId: event.runId!, projectId: event.projectId!, chatId: event.chatId!, workspace: event.workspace || '', prompt: event.prompt || '',
    status: 'working', agents: [], traces: [], messages: [], communications: [], startedAt: at, providerId: event.providerId, model: event.model,
  }
}

// Folds one runtime event into the run map. Every event touches only its own run; unknown runs start from snapshotBase.
export function applyRunEvent(previous: RunMap, event: RuntimeEvent, at = nowIso()): RunMap {
  if (!event.runId) return previous
  const run: RunSnapshot = { ...(previous[event.runId] || snapshotBase(event, at)), updatedAt: at }
  if (event.providerId && isRoot(event.agentId)) run.providerId = event.providerId
  if (event.model && isRoot(event.agentId)) run.model = event.model
  if (event.prompt) run.prompt = event.prompt
  if (event.workspace) run.workspace = event.workspace
  if (event.limits) run.limits = event.limits
  if (event.improvements) run.improvements = event.improvements
  if (event.improvementStatus) run.improvementStatus = event.improvementStatus
  if (event.usage) run.usage = event.usage
  if (event.router) run.router = event.router
  if (event.type === 'run.started') run.status = 'working'
  if (event.agent) {
    const agent = event.agent
    run.agents = run.agents.some(a => a.id === agent.id) ? run.agents.map(a => a.id === agent.id ? { ...a, ...agent } : a) : [...run.agents, agent]
  }
  if (event.trace) {
    const trace = event.trace
    run.traces = (run.traces.some(t => t.id === trace.id) ? run.traces.map(t => t.id === trace.id ? trace : t) : [...run.traces, trace]).slice(-1500)
  }
  // The root agent's answer in progress: the whole text so far, replaced by the final message.added with the same id.
  if (event.type === 'message.streaming' && isRoot(event.agentId) && event.messageId && typeof event.content === 'string'
    && !TERMINAL_STATUSES.includes(run.status)) {
    const startedAt = run.streaming?.messageId === event.messageId ? run.streaming.startedAt : at
    run.streaming = { messageId: event.messageId, agentId: event.agentId || 'root', content: event.content, startedAt, updatedAt: at }
  }
  if (event.message) {
    run.messages = mergeMessage(run.messages, { ...event.message, runId: event.runId })
    if (isRoot(event.message.agentId)) delete run.streaming
  }
  if (event.communication) {
    const communication = event.communication
    const existing = run.communications || []
    run.communications = existing.some(item => item.id === communication.id)
      ? existing.map(item => item.id === communication.id ? { ...item, ...communication } : item)
      : [...existing, communication]
  }
  if (event.change) {
    const change = event.change
    const existing = run.changes || []
    run.changes = (existing.some(item => item.id === change.id)
      ? existing.map(item => item.id === change.id ? { ...item, ...change } : item)
      : [...existing, change]).slice(-500)
  }
  if (event.type === 'run.finished') { run.status = event.status || 'completed'; run.summary = event.summary; run.finishedAt = at }
  if (event.type === 'run.failed') { run.status = 'failed'; run.error = event.error; run.finishedAt = at }
  if (event.type === 'run.cancelled') { run.status = 'cancelled'; run.finishedAt = at }
  if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') delete run.streaming
  return { ...previous, [event.runId]: run }
}

// Merges the saved run list into the live map. Live events that arrived while the list was loading win for every
// field of a run that is still active; a saved terminal status is final. A streaming stub never survives a run's end.
export function restoreRuns(previous: RunMap, snapshots: RunSnapshot[]): RunMap {
  const restored = { ...previous }
  for (const snapshot of snapshots) {
    const live = previous[snapshot.runId]
    const terminal = TERMINAL_STATUSES.includes(snapshot.status)
    const run: RunSnapshot = {
      ...snapshot, ...live, startedAt: snapshot.startedAt,
      status: terminal ? snapshot.status : live?.status ?? snapshot.status,
      providerId: live?.providerId ?? snapshot.providerId, model: live?.model || snapshot.model,
      prompt: live?.prompt || snapshot.prompt, workspace: live?.workspace || snapshot.workspace,
      agents: mergeById(snapshot.agents || [], live?.agents || []),
      traces: mergeById(snapshot.traces || [], live?.traces || []),
      messages: mergeById(snapshot.messages || [], live?.messages || []),
      communications: mergeById(snapshot.communications || [], live?.communications || []),
    }
    // The saved list has no diff texts, the live events do: keep both, and keep the run without `changes` when neither has any.
    if (snapshot.changes || live?.changes) run.changes = mergeById(snapshot.changes || [], live?.changes || []).slice(-500)
    if (isActiveStatus(run.status) && live?.streaming) run.streaming = live.streaming
    else delete run.streaming
    restored[snapshot.runId] = run
  }
  return restored
}

// ---- Derived views for the chat: what the team did, and how long the current turn has been running ----

export type RunNoticeKind = 'spawned' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'handover'
export type RunNotice = { id: string; time: string; kind: RunNoticeKind; agentId: string; agentName: string; text: string }
const excerpt = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }

// Helper events of a run in time order, from the agents' own state: nothing is stored, so a restored run shows the same
// list as a live one. The root agent's subscription changes are already chat messages and are left out here.
export function runNotices(run: RunSnapshot | undefined, label: (target: HandoverTarget) => string = target => target.providerId): RunNotice[] {
  if (!run) return []
  const notices: RunNotice[] = []
  for (const agent of run.agents || []) {
    if (agent.id === 'root') continue
    const name = agent.name || agent.id
    const spawn = (run.communications || []).find(item => item.kind === 'spawn' && item.toAgentId === agent.id)
    const task = excerpt(agent.task || '', 90)
    notices.push({
      id: `${agent.id}:spawned`, time: spawn?.time || agent.startedAt || run.startedAt, kind: 'spawned', agentId: agent.id, agentName: name,
      text: `Подключён помощник «${name}»${task ? `: ${task}` : ''}`,
    })
    for (const item of agent.handovers || []) {
      notices.push({
        id: `${agent.id}:handover:${item.id}`, time: item.time, kind: 'handover', agentId: agent.id, agentName: name,
        text: `«${name}» перешёл на другую подписку: ${label(item.from)} → ${label(item.to)}`,
      })
    }
    const ended = agent.finishedAt || run.finishedAt || run.updatedAt || run.startedAt
    const ending = (kind: RunNoticeKind, text: string) =>
      notices.push({ id: `${agent.id}:${kind}`, time: ended, kind, agentId: agent.id, agentName: name, text })
    if (agent.status === 'done') ending('done', `«${name}» завершил работу`)
    else if (agent.status === 'error') ending('error', `«${name}» завершился с ошибкой${agent.error ? `: ${excerpt(agent.error, 120)}` : ''}`)
    else if (agent.status === 'cancelled') ending('cancelled', `«${name}» остановлен`)
    else if (agent.status === 'interrupted') ending('interrupted', `«${name}» прерван`)
  }
  return notices.sort((a, b) => String(a.time).localeCompare(String(b.time)))
}

// The turn an agent is in now: the latest timing without an end.
export function openTurn(agent?: Agent): TurnTiming | undefined {
  const timings = agent?.turnTimings || []
  for (let index = timings.length - 1; index >= 0; index--) if (!timings[index].endedAt) return timings[index]
  return undefined
}
export function durationMs(from?: string | null, to?: string | null, at = Date.now()): number | null {
  const start = Date.parse(from || '')
  if (Number.isNaN(start)) return null
  const end = to ? Date.parse(to) : at
  if (Number.isNaN(end) || end < start) return null
  return end - start
}
export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} с`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
  return `${Math.floor(seconds / 3600)} ч ${Math.floor(seconds % 3600 / 60)} мин`
}
export const transportLabel = (transport?: string) => transport === 'session' ? 'сессия' : transport === 'envelope' ? 'конверт' : transport || ''
