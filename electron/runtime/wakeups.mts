// Scheduled wake-ups, runtime side. The root agent of a chat schedules a LATER run of that chat with schedule_wakeup (wait
// for a quota reset, look at a long job, go on tomorrow) and withdraws one with cancel_wakeup. The window keeps the chat's
// list (it is saved with the workspace state, so a wake-up survives a restart) and starts the run when one is due and the
// chat is idle (src/wakeups.ts); this module validates, applies the limits and publishes `wakeup.scheduled` and
// `wakeup.cancelled`. The runtime learns the chat's pending wake-ups from the start payload (`wakeups`: the window sends
// the list that remains once the ones this run fires are taken out), and a continuation after restart_orbit, which main
// starts without the window, from the run it continues.
import { randomBytes } from 'node:crypto'
import { clip, ellipsis } from '../text.mts'
import { diagnostics } from './util.mts'
import type { AgentRecord, Observation, OrbitRuntimeLike, RunRecord, StartPayload, ToolArgs, Wakeup } from '../types.mts'

// Pending wake-ups a chat may hold, and how far ahead one may be due: a delay below a minute is a sleep, not a wake-up, and
// a goal further than a month away does not belong to a chat that Orbit keeps open.
const MAX_PENDING = 5
const MIN_AHEAD_MS = 60_000
const MAX_AHEAD_MS = 30 * 24 * 60 * 60_000
const TASK_CHARS = 4000
const REASON_CHARS = 300
// What a list from the window or a saved run may hold (the limit above is the tool's; the window may be older than the tool).
const LISTED = 20
// `at` has to name a time of day: a bare date would be read as midnight UTC.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

const pad = (value: number): string => String(value).padStart(2, '0')
// `2026-10-02 14:30 (UTC+03:00)` in this machine's time zone, the one the user reads in the window.
function localStamp(ms: number, zone = true): string {
  const date = new Date(ms), offset = -date.getTimezoneOffset(), minutes = Math.abs(offset)
  const clock = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return zone ? `${clock} (UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)})` : clock
}
const listed = (wakeups: readonly Wakeup[]): string => wakeups.map(wakeup => `${wakeup.id} ${localStamp(wakeup.dueAt, false)}`).join(', ')

// The wake-ups of a list the window or a saved run gave: well-formed ones only, each id once, text bounded.
function sanitizeWakeups(value: unknown): Wakeup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const wakeups: Wakeup[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, dueAt, task, reason, createdAt, runId } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || seen.has(id) || typeof dueAt !== 'number' || !Number.isFinite(dueAt)) continue
    if (typeof task !== 'string' || !task.trim() || typeof reason !== 'string' || typeof createdAt !== 'string') continue
    seen.add(id)
    wakeups.push({ id, dueAt, task: ellipsis(task, TASK_CHARS), reason: ellipsis(reason, REASON_CHARS), createdAt, ...(typeof runId === 'string' ? { runId } : {}) })
    if (wakeups.length >= LISTED) break
  }
  return wakeups
}

// The run's list at its start: the window's, else (a continuation after a restart, whose payload brings none: a stale one
// would be worse) the list of the run it continues, as that run ended with it.
function loadWakeups(runtime: OrbitRuntimeLike, run: RunRecord, payload: StartPayload): void {
  if (Array.isArray(payload.wakeups)) { run.wakeups = sanitizeWakeups(payload.wakeups); return }
  let earlier: unknown
  if (run.resumedFrom) {
    try { earlier = (runtime.runs.get(run.resumedFrom) ?? runtime.runStore?.get?.(run.resumedFrom))?.wakeups } catch (error) { diagnostics(runtime, run, 'wakeups.load', error) /* The list is a convenience: a damaged history must not block the task. */ }
  }
  run.wakeups = sanitizeWakeups(earlier)
}

// The time a call asks for, in ms, within the limits. The refusals name the current local time: an agent that does not know
// what time it is (it has no clock) can correct itself from the answer.
function dueTime(args: ToolArgs, now: number): number {
  const hasDelay = args.afterMinutes !== undefined, hasTime = args.at !== undefined
  if (hasDelay === hasTime) throw new Error('Give exactly one of afterMinutes (a delay) and at (an ISO 8601 time)')
  let due: number
  if (hasDelay) {
    if (typeof args.afterMinutes !== 'number' || !Number.isFinite(args.afterMinutes)) throw new Error('afterMinutes must be a number')
    due = now + Math.round(args.afterMinutes * 60_000)
  } else {
    const text = String(args.at).trim()
    due = ISO_TIME.test(text) ? Date.parse(text) : NaN
    if (Number.isNaN(due)) throw new Error(`at must be an ISO 8601 date and time such as 2026-10-02T09:30:00+03:00 (without an offset: this machine's local time); it is ${localStamp(now)} now`)
  }
  if (due - now < MIN_AHEAD_MS) throw new Error(`A wake-up must be at least 1 minute ahead; it is ${localStamp(now)} now`)
  if (due - now > MAX_AHEAD_MS) throw new Error(`A wake-up can be at most 30 days ahead (until ${localStamp(now + MAX_AHEAD_MS)}); it is ${localStamp(now)} now`)
  return due
}

// schedule_wakeup. Root only (the registry hides it from helpers; a helper that calls it through the envelope is refused here).
function schedule(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs): Observation {
  if (agent.id !== 'root') throw new Error('Only the orchestrator can schedule a wake-up')
  const task = typeof args.task === 'string' ? args.task.trim() : '', reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (!task || !reason) throw new Error('A task and a reason are required')
  if (task.length > TASK_CHARS) throw new Error(`task is longer than ${TASK_CHARS} characters; keep the brief the later run needs`)
  if (reason.length > REASON_CHARS) throw new Error(`reason is longer than ${REASON_CHARS} characters; say why in a few words`)
  const now = runtime.clock()
  const dueAt = dueTime(args, now)
  if (run.wakeups.length >= MAX_PENDING) throw new Error(`This chat already has ${run.wakeups.length} pending wake-ups (${listed(run.wakeups)}); cancel one with cancel_wakeup first`)
  let id: string
  do { id = `w-${randomBytes(3).toString('hex')}` } while (run.wakeups.some(wakeup => wakeup.id === id))
  const wakeup: Wakeup = { id, dueAt, task, reason, createdAt: new Date(now).toISOString(), runId: run.runId }
  run.wakeups.push(wakeup)
  runtime.emit(run, 'wakeup.scheduled', { wakeup })
  return {
    ok: true, id, dueAt: new Date(dueAt).toISOString(), dueLocal: localStamp(dueAt), pending: run.wakeups.length,
    note: 'When it is due and the chat is idle, Orbit starts a new run of this chat with your task (Orbit has to be open; after a closed Orbit or a busy chat it starts as soon as both hold, marked as late). You are not running while you wait: finish your turn normally. The user sees it in the chat and can cancel it or run it now.',
  }
}

// cancel_wakeup. The runtime's list is what this run knows: a wake-up the user cancelled or ran in the window since is no longer
// in the window's list, and cancelling it here only tells the window again.
function cancel(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs): Observation {
  if (agent.id !== 'root') throw new Error('Only the orchestrator can cancel a wake-up')
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  const at = run.wakeups.findIndex(wakeup => wakeup.id === id)
  if (at < 0) throw new Error(`No pending wake-up "${clip(id, 40)}" in this chat${run.wakeups.length ? `; pending: ${listed(run.wakeups)}` : ' (none is pending)'}`)
  const [removed] = run.wakeups.splice(at, 1)
  runtime.emit(run, 'wakeup.cancelled', { wakeupId: removed.id })
  return { ok: true, id: removed.id, pending: run.wakeups.length }
}

// What the root's prompt says about its chat's pending wake-ups, one short line (empty for a helper and when none is pending).
function pendingLine(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): string {
  if (agent.id !== 'root' || !run.wakeups.length) return ''
  const now = runtime.clock()
  const items = [...run.wakeups].sort((a, b) => a.dueAt - b.dueAt).map(wakeup => `${wakeup.id} due ${localStamp(wakeup.dueAt)}${wakeup.dueAt <= now ? ' (overdue)' : ''}: ${clip(wakeup.task, 70)}`)
  return `SCHEDULED WAKE-UPS of this chat (cancel_wakeup {id} withdraws one): ${items.join('; ')}.`
}
// What an envelope-transport root is told about the tools (an MCP client reads their descriptions in tools/list instead; the
// envelope guide itself is frozen, see tool-registry.mts).
const WAKEUP_GUIDE = 'schedule_wakeup {afterMinutes?,at?,task,reason}: root only; schedule a LATER run of this chat (wait for a quota reset, check a long job, continue a goal tomorrow): exactly one of afterMinutes or at (ISO 8601 with an offset), 1 minute to 30 days ahead, 5 pending at most. When it is due and the chat is idle, Orbit starts a run whose message begins with ⏰ and carries your task; you are not running in between. cancel_wakeup {id}.'

export { MAX_PENDING, sanitizeWakeups, loadWakeups, schedule, cancel, pendingLine, localStamp, WAKEUP_GUIDE }
