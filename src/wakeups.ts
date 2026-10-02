import type { ChatThread, Message, Wakeup } from './types'
import type { LoopStep } from './improvement-loop'

// Scheduled wake-ups, renderer side: pure decisions only. The root agent of a chat schedules its own later run with
// schedule_wakeup (electron/runtime/wakeups.mts); the renderer keeps the list in chat.wakeups (saved with the workspace) and
// useOrbitState runs nextWakeupStep for every chat to start the run when one is due and the chat is free. This file has only
// type imports, so tests load it on its own (tests/wakeups.test.cjs) like src/improvement-loop.ts.

export const WAKEUP_LIMIT = 20
const TASK_MAX = 4000
const REASON_MAX = 300
const CHIP_TASK_CHARS = 80
// A wake-up that fires this much later than due says so in the prompt.
const LATE_MIN_MS = 2 * 60_000
const BUSY_RETRY_MS = 10_000
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000]
// The runtime's "wait and retry" start refusals. A copy of BUSY_REFUSALS in src/improvement-loop.ts (a value import would
// stop that file from loading on its own in tests); tests/wakeups.test.cjs checks the two agree.
const BUSY_REFUSALS = [
  'В этом чате ещё выполняется задача или завершаются её процессы',
  'Orbit сейчас применяет изменения своего кода и перезапустится',
  'Завершается остановка процессов в этом проекте',
]
const isBusyRefusal = (error: string) => BUSY_REFUSALS.some(text => error.includes(text))
const clip = (text: string, max: number) => { const flat = text.trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, ' '), max)
const pad = (n: number) => String(n).padStart(2, '0')
const clockOf = (ms: number) => { const date = new Date(ms); return `${pad(date.getHours())}:${pad(date.getMinutes())}` }
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
// HH:MM for a time on `now`'s day, else DD.MM HH:MM (local time).
export const wakeClock = (ms: number, now: number) => {
  if (!Number.isFinite(ms)) return '—'
  return sameDay(ms, now) ? clockOf(ms) : `${pad(new Date(ms).getDate())}.${pad(new Date(ms).getMonth() + 1)} ${clockOf(ms)}`
}

// ---- When a wake-up is due ----

// A refused start sets retryAt: the wake-up is due again only then.
export const effectiveDue = (w: Wakeup) => Math.max(w.dueAt, w.retryAt ?? 0)
const byDue = (a: Wakeup, b: Wakeup) => a.dueAt - b.dueAt || a.createdAt.localeCompare(b.createdAt)
const dueOf = (wakeups: Wakeup[], now: number) => wakeups.filter(w => effectiveDue(w) <= now).sort(byDue)
const earliestFuture = (wakeups: Wakeup[], now: number) => {
  const later = wakeups.map(effectiveDue).filter(at => at > now)
  return later.length ? Math.min(...later) : undefined
}

export type WakeupStepOptions = {
  now: number
  // The chat has an active run, a pending start or a restart wait.
  busy: boolean
}
export type WakeupStep =
  // Nothing to start now; wakeAt = the next time the answer changes without any event.
  | { kind: 'idle'; wakeAt?: number }
  // Start ONE run for all the due wake-ups (earliest first): after Orbit was closed for a day several can be due at once.
  | { kind: 'start'; wakeups: Wakeup[] }

// What a chat does about its wake-ups. A chat with an active improvement loop is left to the loop driver (holdLoopStep).
export function nextWakeupStep(chat: ChatThread, options: WakeupStepOptions): WakeupStep {
  const wakeups = chat.wakeups
  if (!wakeups?.length || chat.loop?.active) return { kind: 'idle' }
  const due = dueOf(wakeups, options.now)
  if (due.length && !options.busy) return { kind: 'start', wakeups: due }
  return { kind: 'idle', wakeAt: earliestFuture(wakeups, options.now) }
}

// A chat with an active loop: its wake-ups mean «not earlier than» for the loop's next task instead of a separate run. A
// start step waits (e.g. for a quota reset) until one is due, then carries all the due wake-ups, which that task consumes.
// Every other step (stop, retry, idle) passes through.
export function holdLoopStep(step: LoopStep, chat: ChatThread, now: number): LoopStep {
  if (step.kind !== 'start' || !chat.wakeups?.length) return step
  const due = dueOf(chat.wakeups, now)
  if (!due.length) return { kind: 'idle', wakeAt: earliestFuture(chat.wakeups, now) }
  return { ...step, wakeups: due }
}

// ---- Texts ----

// «5 мин»; from 60 minutes «2 ч 10 мин» (a round hour: «3 ч»).
export function lateText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} мин`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} ч ${rest} мин` : `${Math.floor(minutes / 60)} ч`
}
function wakeupHeader(w: Wakeup, now: number): string {
  const created = Date.parse(w.createdAt)
  let header = `⏰ Пробуждение по расписанию (назначено ${wakeClock(Number.isNaN(created) ? w.dueAt : created, now)}: ${oneLine(w.reason, REASON_MAX)})`
  if (w.manual) header += ' — запущено вручную'
  else if (now - w.dueAt >= LATE_MIN_MS) header += ` — опоздало на ${lateText(now - w.dueAt)}`
  return header
}
const CLOSING = 'Это запуск по расписанию, который агент назначил себе сам: пользователя может не быть на месте.'
// The text of the run that fires `wakeups`: per wake-up its header (when it was scheduled and why, how late it is) and the
// task the agent wrote for itself. Late = Orbit was closed, or the chat busy, when it fell due.
export function wakeupPrompt(wakeups: Wakeup[], now: number): string {
  const sections = wakeups.map((w, i) => `${wakeups.length > 1 ? `${i + 1}. ` : ''}${wakeupHeader(w, now)}\n${w.task.trim()}`)
  return [...sections.flatMap((section, i) => i ? ['', section] : [section]), '', CLOSING].join('\n')
}
// The chat entry of a wake-up's run: the user's own message (author 'user'), so that state-store reconcileRuns, which gives
// every run without a user message its prompt as one, does not add the same text twice.
export const wakeupMessage = (runId: string, text: string, time: string): Message => ({ id: `wakeup-${runId}`, author: 'user', kind: 'wakeup', text, time, runId })

// ---- A refused start ----

const delayOf = (failures: number) => RETRY_DELAYS_MS[Math.min(Math.max(1, failures), RETRY_DELAYS_MS.length) - 1]
// A wake-up whose start the runtime refused. Orbit being busy is waited out in seconds and is no failure; any other refusal
// counts, backs off 1, 3, 10, 30 minutes and is shown in the chat (`note`). The wake-up is kept either way.
export function wakeupFailed(w: Wakeup, error: string, now: number): { wakeup: Wakeup; note?: string } {
  if (isBusyRefusal(error)) return { wakeup: { ...w, retryAt: now + BUSY_RETRY_MS } }
  const failures = (w.failures ?? 0) + 1
  const retryAt = now + delayOf(failures)
  return {
    wakeup: { ...w, failures, retryAt },
    note: `⏰ Не удалось запустить пробуждение: ${oneLine(error, 300)}. Следующая попытка в ${clockOf(retryAt)}.`,
  }
}

// ---- What the chat shows ----

export type WakeupChip = { id: string; clock: string; text: string; overdue: boolean; held?: boolean }
// `held`: the chat's improvement loop waits for this wake-up (the caller knows the loop).
export const wakeupChip = (w: Wakeup, now: number, held = false): WakeupChip => ({
  id: w.id, clock: wakeClock(w.dueAt, now), text: oneLine(w.task, CHIP_TASK_CHARS), overdue: w.dueAt <= now, ...(held ? { held } : {}),
})

// ---- Saved state ----

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
// The saved wake-ups made valid: well-formed items only, no duplicate ids (the first wins), texts clipped, by due time, at most WAKEUP_LIMIT.
export function sanitizeWakeups(value: unknown): Wakeup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const kept: Wakeup[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const w = item as Record<string, unknown>
    if (typeof w.id !== 'string' || !w.id || typeof w.task !== 'string' || !w.task.trim() || typeof w.reason !== 'string'
      || typeof w.createdAt !== 'string' || !isNum(w.dueAt) || seen.has(w.id)) continue
    seen.add(w.id)
    kept.push({
      id: w.id, dueAt: w.dueAt, task: clip(w.task, TASK_MAX), reason: clip(w.reason, REASON_MAX), createdAt: w.createdAt,
      ...(typeof w.runId === 'string' ? { runId: w.runId } : {}), ...(w.manual === true ? { manual: true } : {}),
      ...(isNum(w.retryAt) ? { retryAt: w.retryAt } : {}), ...(isNum(w.failures) ? { failures: w.failures } : {}),
    })
  }
  return kept.sort(byDue).slice(0, WAKEUP_LIMIT)
}
