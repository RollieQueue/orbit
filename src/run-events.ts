import type { Agent, AgentStatus, AgentUsage, HandoverTarget, Message, RestartNotice, RunSnapshot, RunStatus, TurnTiming } from './types'

// The renderer's view of runs: one snapshot per run id, updated by runtime events (applyRunEvent) and by the saved
// run list on start-up (restoreRuns). Pure functions with an injectable clock, so tests can replay recorded sequences.

export type RunMap = Record<string, RunSnapshot>
// 'restarting' ends a run whose agent restarted Orbit (restart_orbit); the task goes on in a run whose resumedFrom points back.
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted', 'restarting']
// 'paused' is an agent's status only (a run whose agents are paused stays 'working'); it counts as alive, not finished.
export const isActiveStatus = (status?: RunStatus) => status === 'working' || status === 'waiting' || status === 'paused'
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
  if (event.loopTask) run.loopTask = event.loopTask
  // run.info sends null once the plan has no handoff.
  if (typeof event.improvementHandoff === 'string') run.improvementHandoff = event.improvementHandoff
  else if (event.improvementHandoff === null) delete run.improvementHandoff
  if (event.usage) run.usage = event.usage
  if (event.router) run.router = event.router
  if (event.resumedFrom) run.resumedFrom = event.resumedFrom
  if (event.resumeChain) run.resumeChain = event.resumeChain
  if (event.restart) run.restart = event.restart
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
  const ended = event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled'
  // A run stopped for an Orbit restart ends 'restarting', whichever terminal event carries that status.
  if (ended && event.status === 'restarting') run.status = 'restarting'
  if (ended) delete run.streaming
  return { ...previous, [event.runId]: run }
}

// Ends a run whose terminal event will never come (it died with a runtime process): its working agents stop with it, as
// the runtime's own cancelAgents stops them, and no answer stub survives.
function endRun(run: RunSnapshot, status: RunStatus, at: string, detail: string, patch: Partial<RunSnapshot> = {}): RunSnapshot {
  const finishedAt = run.finishedAt || at
  const agents = run.agents.map(agent => isActiveStatus(agent.status) ? { ...agent, status: 'cancelled' as const, detail, finishedAt: agent.finishedAt || finishedAt } : agent)
  const ended: RunSnapshot = { ...run, ...patch, status, finishedAt, agents }
  delete ended.streaming
  return ended
}
// The texts the runtime would have written: electron/runtime/lifecycle.mts RESTART_DETAIL, and the renderer's own for a
// run no saved list knows.
const RESTART_DETAIL = 'Orbit перезапускается по запросу агента'
const LOST_DETAIL = 'Прерван: процесс runtime завершился'
export const LOST_RUN_ERROR = 'Процесс runtime завершился раньше, чем сохранил этот запуск. Можно продолжить новым сообщением.'

// Merges the saved run list into the live map (on start-up, and again when the runtime process came back after a restart
// or a crash). Live events that arrived while the list was loading win for every field of a run that is still active; a
// saved terminal status is final. A live copy still active while the saved run has ended lost its end together with the
// runtime process that ran it: there the saved agents' final states win. A streaming stub never survives a run's end.
export function restoreRuns(previous: RunMap, snapshots: RunSnapshot[]): RunMap {
  const restored = { ...previous }
  for (const snapshot of snapshots) {
    const live = previous[snapshot.runId]
    const terminal = TERMINAL_STATUSES.includes(snapshot.status)
    const stale = terminal && isActiveStatus(live?.status)
    const run: RunSnapshot = {
      ...snapshot, ...live, startedAt: snapshot.startedAt,
      status: terminal ? snapshot.status : live?.status ?? snapshot.status,
      providerId: live?.providerId ?? snapshot.providerId, model: live?.model || snapshot.model,
      prompt: live?.prompt || snapshot.prompt, workspace: live?.workspace || snapshot.workspace,
      agents: stale ? mergeById(live?.agents || [], snapshot.agents || []) : mergeById(snapshot.agents || [], live?.agents || []),
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

// The runs a runtime process is running, as this window knows them: taken when that process goes down.
export const activeRunIds = (runs: RunMap) => Object.values(runs).filter(run => isActiveStatus(run.status)).map(run => run.runId)

// After the runtime came back: a run the old process was running (`lost`) that the list read from the new process does
// not have died before its first save reached the disk (a crash within about a second of its start). No event will end
// it any more and nothing else would free its chat, so it ends here: interrupted, its working agents cancelled.
export function interruptLost(previous: RunMap, lost: readonly string[], snapshots: RunSnapshot[], at = nowIso()): RunMap {
  const listed = new Set(snapshots.map(snapshot => snapshot.runId))
  const gone = lost.filter(runId => !listed.has(runId) && isActiveStatus(previous[runId]?.status))
  if (!gone.length) return previous
  const next: RunMap = { ...previous }
  for (const runId of gone) next[runId] = endRun(previous[runId], 'interrupted', at, LOST_DETAIL, { error: previous[runId].error || LOST_RUN_ERROR })
  return next
}

// ---- Restarts: the run an agent ended by restarting Orbit, and the run Orbit started to continue it ----

export const shortRunId = (runId: string) => runId.slice(0, 8)

// A 'resumed' restart notice ties the continuation to the run it continues, whether or not the runtime's events said so:
// the continuation gets resumedFrom (a run this renderer has not seen yet is placed in the notice's chat), and the old run,
// if its end was lost with the previous runtime process, ends 'restarting' with its working agents cancelled (as the
// runtime's markRestarting leaves them; a saved list read later would otherwise keep them working).
export function linkResumed(previous: RunMap, notice: RestartNotice, at = nowIso()): RunMap {
  const runId = notice.resumedRunId
  if (notice.kind !== 'resumed' || !runId) return previous
  const known = previous[runId]
  if (!known && (!notice.projectId || !notice.chatId)) return previous
  const next: RunMap = { ...previous }
  const base = known || snapshotBase({ runId, projectId: notice.projectId!, chatId: notice.chatId! }, at)
  next[runId] = { ...base, resumedFrom: base.resumedFrom || notice.runId || undefined }
  const old = notice.runId ? previous[notice.runId] : undefined
  if (old && isActiveStatus(old.status)) next[old.runId] = endRun(old, 'restarting', notice.time || at, RESTART_DETAIL)
  return next
}

// Both ends of a restart around one run: the run it continues (`from`; `previous` only when that run is loaded) and the
// run that continued it (the earliest run whose resumedFrom points here).
export function resumeLinks(runs: RunMap | RunSnapshot[], run?: RunSnapshot): { from?: string; previous?: RunSnapshot; next?: RunSnapshot } {
  if (!run) return {}
  const list = Array.isArray(runs) ? runs : Object.values(runs)
  const previous = run.resumedFrom ? list.find(item => item.runId === run.resumedFrom) : undefined
  const next = list.filter(item => item.resumedFrom === run.runId && item.runId !== run.runId)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0]
  return { from: run.resumedFrom || undefined, previous, next }
}

// Where each run's team strip and history hang in the chat: under its answer. A finished run that never answered (failed,
// stopped) keeps them under the entry that opened it: the user's message, the restart note of a continuation Orbit
// started by itself, or the note of an endless-improvement loop task.
export function historyAnchors(messages: Message[], runs: RunMap): Map<string, string> {
  const anchors = new Map<string, string>()
  for (const message of messages) if (message.author === 'orbit' && message.runId) anchors.set(message.runId, message.id)
  for (const message of messages) {
    const opener = message.author === 'user' || (message.author === 'system' && (message.kind === 'restart' || message.kind === 'loop'))
    if (!opener || !message.runId || anchors.has(message.runId)) continue
    if (runs[message.runId] && !isActiveStatus(runs[message.runId].status)) anchors.set(message.runId, message.id)
  }
  return anchors
}

// ---- Derived views for the chat: what the team did, and how long the current turn has been running ----

export type RunNoticeKind = 'spawned' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'restarting' | 'handover'
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
    else if (agent.status === 'restarting') ending('restarting', `«${name}» остановлен перезапуском Orbit`)
  }
  return notices.sort((a, b) => String(a.time).localeCompare(String(b.time)))
}

// The agent that holds `agent` at the pause gate: itself, or its nearest ancestor, whose own pause flag is set; null when
// nothing holds it. The runtime walks parentId the same way; the visited set guards against a broken cycle.
export function pauseHolder(agents: Agent[], agent: Agent): Agent | null {
  const seen = new Set<string>()
  for (let current: Agent | undefined = agent; current && !seen.has(current.id); current = agents.find(a => a.id === current!.parentId)) {
    if (current.paused) return current
    seen.add(current.id)
  }
  return null
}
// The status to show: the user's own pause reads as paused at once, before the agent's turn is cut off and it reaches the gate.
export const shownStatus = (agent: Agent): AgentStatus => agent.paused && isActiveStatus(agent.status) ? 'paused' : agent.status

// The turn an agent is in now: the latest timing without an end.
export function openTurn(agent?: Agent): TurnTiming | undefined {
  const timings = agent?.turnTimings || []
  for (let index = timings.length - 1; index >= 0; index--) if (!timings[index].endedAt) return timings[index]
  return undefined
}
// Everything an agent did across its turns: native tool calls (commands, edits) plus Orbit tool calls.
export function actionCount(agent?: Agent): number {
  return (agent?.turnTimings || []).reduce((sum, timing) => sum + (timing.nativeToolCalls ?? 0) + (timing.orbitToolCalls ?? 0), 0)
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
// The model's thinking in progress, from the provider's estimate of the thinking block so far: «думает» until the first
// estimate, then a rounded figure («думает · ~220 токенов», «~4,2 тыс. токенов», «~18 тыс. токенов»); '' — not thinking.
export function thinkingText(tokens?: number | null): string {
  if (typeof tokens !== 'number' || !(tokens >= 0)) return ''
  if (tokens < 5) return 'думает'
  const tens = Math.round(tokens / 10) * 10
  const amount = tens < 1000 ? `${tens} токенов` : `${tokens < 9950 ? String(Math.round(tokens / 100) / 10).replace('.', ',') : Math.round(tokens / 1000)} тыс. токенов`
  return `думает · ~${amount}`
}
export const transportLabel = (transport?: string) => transport === 'session' ? 'сессия' : transport === 'envelope' ? 'конверт' : transport || ''

// ---- Tokens: what an agent has used, and the run's sum ----

// Input + output tokens of an agent; undefined while no provider has reported any (a zero is not shown either).
export const agentTokens = (agent?: Agent): number | undefined => {
  const tokens = agent?.usage ? agent.usage.inputTokens + agent.usage.outputTokens : 0
  return tokens > 0 ? tokens : undefined
}
// A count for a line of the window, short, with the Russian decimal comma: «850», «1,2 тыс.», «48 тыс.», «1,2 млн», «12 млрд».
export function tokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return String(n)
  const [unit, divisor] = n < 999_500 ? ['тыс.', 1e3] as const : n < 999_500_000 ? ['млн', 1e6] as const : ['млрд', 1e9] as const
  // Tenths as an integer, so that 1 150 000 reads «1,2 млн» whatever the floating point does.
  const tenths = Math.round(n / (divisor / 10))
  const amount = tenths < 100 ? `${Math.floor(tenths / 10)}${tenths % 10 ? `,${tenths % 10}` : ''}` : String(Math.round(n / divisor))
  return `${amount} ${unit}`
}
const exactCount = (tokens: number) => Math.round(tokens).toLocaleString('ru-RU')
// The exact figures behind a count, for a tooltip: «Вход 1 150 000 (из кэша 1 020 000) · выход 48 000».
export function usageTitle(usage?: AgentUsage | null): string {
  if (!usage) return ''
  return `Вход ${exactCount(usage.inputTokens)}${usage.cachedInputTokens ? ` (из кэша ${exactCount(usage.cachedInputTokens)})` : ''} · выход ${exactCount(usage.outputTokens)}`
}
// The same breakdown in short counts, beside a total: «вход 1,2 млн (из кэша 1 млн) · выход 48 тыс.».
export function usageBreakdown(usage: AgentUsage): string {
  return `вход ${tokenCount(usage.inputTokens)}${usage.cachedInputTokens ? ` (из кэша ${tokenCount(usage.cachedInputTokens)})` : ''} · выход ${tokenCount(usage.outputTokens)}`
}
// The run's tokens as the sum of its agents', which is live (the run's own figures only arrive with a turn's end); null when
// no agent has reported any.
export function runUsage(agents: Agent[]): AgentUsage | null {
  const total: AgentUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  for (const { usage } of agents) {
    if (!usage) continue
    total.inputTokens += usage.inputTokens; total.outputTokens += usage.outputTokens; total.cachedInputTokens += usage.cachedInputTokens
  }
  return total.inputTokens + total.outputTokens > 0 ? total : null
}
