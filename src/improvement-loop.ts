import type { ChatThread, ImprovementLoop, ImprovementTask, LoopStopReason, Message, RunSnapshot, Wakeup } from './types'

// The endless improvement loop, renderer side: pure decisions only. useOrbitState runs nextLoopStep for every chat with an
// active loop and carries the step out (start the next task as a new run with a fresh context, schedule a retry, stop).
// One task = one run; the runtime keeps the plan between the runs of the chat (artifacts/improvement-loop-contract.md).

// A loop start whose run never showed up (the window reloaded before startTask answered) is repeated after this long.
export const LOOP_START_TIMEOUT_MS = 60_000
export const CLOSED_KEYS_LIMIT = 200
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000]
// A start refused only because Orbit is busy (the previous run's processes are still ending, a restart is being applied)
// is retried after 5, 10, then every 30 seconds, and is no failure.
export const BUSY_RETRY_MS = [5_000, 10_000, 30_000]
const LATER_MESSAGES = 5
const LATER_MESSAGE_CHARS = 600

const delayOf = (delays: number[], count: number) => delays[Math.min(Math.max(1, count), delays.length) - 1]
// The pause before the n-th failure in a row is retried: 1, 3, 10, then 30 minutes.
export const retryDelay = (failures: number) => delayOf(RETRY_DELAYS_MS, failures)
export const busyRetryDelay = (refusals: number) => delayOf(BUSY_RETRY_MS, refusals)
// The runtime's "wait and retry" start refusals (START_REFUSALS in electron/runtime/lifecycle.mts), also when the IPC
// wraps them ("Error invoking remote method …: Error: <text>").
const BUSY_REFUSALS = [
  'В этом чате ещё выполняется задача или завершаются её процессы',
  'Orbit сейчас применяет изменения своего кода и перезапустится',
  'Завершается остановка процессов в этом проекте',
]
export const isBusyRefusal = (error: string) => BUSY_REFUSALS.some(text => error.includes(text))
const clip = (text: string, max: number) => { const flat = text.trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat }
const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, ' '), max)
// HH:MM in local time.
export const clockOf = (ms: number) => { const date = new Date(ms); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` }

// ---- Closed plan tasks: `id|title` of every done task, `id|title|blocked` of every blocked one ----

// A blocked task done later (the user answered) is a newly closed task, so the two states have different keys.
export const taskKey = (task: Pick<ImprovementTask, 'id' | 'title' | 'status'>) => `${task.id}|${task.title}${task.status === 'blocked' ? '|blocked' : ''}`
export const closedKeysOf = (tasks?: ImprovementTask[]) =>
  (Array.isArray(tasks) ? tasks : []).filter(task => task.status === 'done' || task.status === 'blocked').map(taskKey)
// Keys the loop has not seen closed yet.
export const newClosedKeys = (known: string[], tasks?: ImprovementTask[]) => closedKeysOf(tasks).filter(key => !known.includes(key))
// The known keys plus the new ones, the newest CLOSED_KEYS_LIMIT kept.
export function mergeClosedKeys(known: string[], added: string[]) {
  const merged = [...known]
  for (const key of added) if (!merged.includes(key)) merged.push(key)
  return merged.slice(-CLOSED_KEYS_LIMIT)
}

// ---- The chat's runs ----

const isActive = (run: RunSnapshot) => run.status === 'working' || run.status === 'waiting'
const byStart = (a: RunSnapshot, b: RunSnapshot) => String(a.startedAt || '').localeCompare(String(b.startedAt || ''))
export const latestRun = (runs: RunSnapshot[]) => [...runs].sort(byStart).pop()
// The newest run that has a plan: its closed tasks are the baseline of a new loop.
export const newestPlanRun = (runs: RunSnapshot[]) => [...runs].sort(byStart).reverse().find(run => !!run.improvements?.length)

// ---- One step of the driver ----

export type LoopStepOptions = {
  // settings.improvementMode
  enabled: boolean
  // The chat has an active run, a pending start or a restart wait.
  busy: boolean
  now: number
  // The chat's settling restart note for a run (a restart that started no continuation), when there is one.
  restartNoteText?: (runId: string) => string | undefined
}
export type LoopStep =
  // Nothing to do now; wakeAt = when the answer may change without any event (a retry or a lost start is due).
  | { kind: 'idle'; wakeAt?: number }
  | { kind: 'stop'; reason: LoopStopReason; loop: ImprovementLoop; note: string }
  // A retry is scheduled: the loop to save and the note for the chat.
  | { kind: 'retry'; loop: ImprovementLoop; note: string; runId: string }
  // Start task `task` now. `loop` is saved before the start (lastRunId, startingAt, iteration = task); outcome = how the
  // previous attempt ended when that was not a normal completion. `wakeups`: the due scheduled wake-ups this task
  // consumes (holdLoopStep in src/wakeups.ts adds them).
  | { kind: 'start'; loop: ImprovementLoop; task: number; outcome?: string; wakeups?: Wakeup[] }

export const NO_PROGRESS_TEXT = 'Предыдущая задача завершилась, но не закрыла ни одной задачи плана.'
// How the latest run ended, for the next task's prompt; undefined for a completion that moved the plan.
export function outcomeText(run: RunSnapshot, loop: ImprovementLoop, options: Pick<LoopStepOptions, 'restartNoteText'> = {}): string | undefined {
  switch (run.status) {
    // A handled completion that moved the plan reset the failures; one that moved nothing counted as a failure.
    case 'completed': case 'done':
      return loop.failures > 0 ? NO_PROGRESS_TEXT : undefined
    case 'failed': case 'error':
      return `Предыдущая попытка завершилась ошибкой${run.error ? `: ${oneLine(run.error, 400)}` : ''}.`
    case 'interrupted':
      return 'Предыдущая попытка прервалась: Orbit закрылся или его процесс перезапустился.'
    // The user's Stop ends the loop itself (useOrbitState stop); what is left is Orbit quitting or its runtime restarting.
    case 'cancelled':
      return 'Предыдущая попытка остановлена: Orbit закрылся или его runtime перезапустили.'
    case 'restarting':
      return options.restartNoteText?.(run.runId) || 'Предыдущая попытка перезапустила Orbit, но продолжение не началось.'
    default:
      return undefined
  }
}

const STOP_NOTES: Record<LoopStopReason, string> = {
  user: '∞ Цикл остановлен: задача прервана.',
  switch: '∞ Цикл остановлен: бесконечное улучшение выключено.',
  blocked: '∞ Цикл на паузе: цель достигнута или нужен ваш ответ — напишите сообщение, чтобы продолжить.',
  manual: '∞ Цикл остановлен.',
  moved: '∞ Цикл остановлен: бесконечное улучшение запущено в другом чате.',
}
export const stopNote = (reason: LoopStopReason) => STOP_NOTES[reason]
export function stoppedLoop(loop: ImprovementLoop, reason: LoopStopReason, at: string): ImprovementLoop {
  const next: ImprovementLoop = { ...loop, active: false, stopped: { reason, at } }
  delete next.retryAt
  delete next.startingAt
  return next
}

// The first handling of a failed-like outcome: one more failure, the next attempt after the backoff.
function scheduleRetry(loop: ImprovementLoop, run: RunSnapshot, outcome: string, now: number, closedKeys = loop.closedKeys): LoopStep {
  const failures = loop.failures + 1
  const retryAt = now + retryDelay(failures)
  const next: ImprovementLoop = { ...loop, failures, retryAt, lastRunId: run.runId, closedKeys }
  delete next.startingAt
  return { kind: 'retry', loop: next, runId: run.runId, note: `∞ ${outcome} Следующая попытка в ${clockOf(retryAt)}.` }
}
function startStep(loop: ImprovementLoop, run: RunSnapshot, task: number, now: number, outcome?: string, patch: Partial<ImprovementLoop> = {}): LoopStep {
  const next: ImprovementLoop = { ...loop, ...patch, iteration: task, lastRunId: run.runId, startingAt: now }
  delete next.retryAt
  return { kind: 'start', loop: next, task, outcome }
}

// What the loop of `chat` does now, given its runs. Each run's outcome is handled once (loop.lastRunId): a completion that
// closed a plan task starts the next task at once; a failure, an interruption (a cancel the user did not ask for included),
// a restart without continuation or a completion that moved nothing is retried after a backoff; a blocked plan pauses the
// loop. The user's Stop ends the loop directly (useOrbitState).
export function nextLoopStep(chat: ChatThread, chatRuns: RunSnapshot[], options: LoopStepOptions): LoopStep {
  const loop = chat.loop
  if (!loop?.active) return { kind: 'idle' }
  const at = new Date(options.now).toISOString()
  if (!options.enabled) return { kind: 'stop', reason: 'switch', loop: stoppedLoop(loop, 'switch', at), note: stopNote('switch') }
  if (options.busy) return { kind: 'idle' }
  const latest = latestRun(chatRuns)
  if (!latest || isActive(latest)) return { kind: 'idle' }
  if (latest.runId !== loop.lastRunId) {
    // A new run means its start worked: the counts of refused starts end here.
    const handled: ImprovementLoop = { ...loop }
    delete handled.startFailures
    delete handled.busyStarts
    switch (latest.status) {
      case 'completed': case 'done': {
        const added = newClosedKeys(handled.closedKeys, latest.improvements)
        const closedKeys = mergeClosedKeys(handled.closedKeys, added)
        if (latest.improvementStatus === 'blocked') {
          return { kind: 'stop', reason: 'blocked', loop: stoppedLoop({ ...handled, lastRunId: latest.runId, closedKeys }, 'blocked', at), note: stopNote('blocked') }
        }
        if (added.length) return startStep(handled, latest, handled.iteration + 1, options.now, undefined, { failures: 0, closedKeys })
        return scheduleRetry(handled, latest, NO_PROGRESS_TEXT, options.now, closedKeys)
      }
      // A cancelled run the loop still sees was not stopped by the user (that stops the loop at once): Orbit quit, or its
      // runtime was restarted from Settings. Like an interruption, it is retried.
      case 'failed': case 'error': case 'interrupted': case 'restarting': case 'cancelled':
        return scheduleRetry(handled, latest, outcomeText(latest, handled, options)!, options.now)
      default:
        return { kind: 'idle' }
    }
  }
  // The latest run's outcome is handled: a retry is due, or a start whose run never came is repeated.
  if (loop.retryAt !== undefined) {
    if (options.now < loop.retryAt) return { kind: 'idle', wakeAt: loop.retryAt }
    return startStep(loop, latest, loop.iteration + 1, options.now, outcomeText(latest, loop, options))
  }
  if (loop.startingAt !== undefined) {
    const due = loop.startingAt + LOOP_START_TIMEOUT_MS
    if (options.now < due) return { kind: 'idle', wakeAt: due }
    return startStep(loop, latest, Math.max(1, loop.iteration), options.now, outcomeText(latest, loop, options))
  }
  return { kind: 'idle' }
}

// A loop start that startTask refused: the task number goes back and the same start is repeated later. No run was made,
// so `failures` (how the previous run ended) stays as it is. Orbit being busy is waited out in seconds without a note;
// any other refusal backs off 1, 3, 10, 30 minutes on its own count and is shown in the chat.
// `started` is the saved loop of the refused start, its iteration the refused task (startStep): one back, the due retry
// (iteration + 1) repeats that task, also for a repeated lost start, whose loop already had the number before it.
export function loopStartFailed(started: ImprovementLoop, error: string, now: number): { loop: ImprovementLoop; note?: string } {
  const loop: ImprovementLoop = { ...started, iteration: started.iteration - 1 }
  delete loop.startingAt
  if (isBusyRefusal(error)) {
    loop.busyStarts = (started.busyStarts ?? 0) + 1
    loop.retryAt = now + busyRetryDelay(loop.busyStarts)
    return { loop }
  }
  delete loop.busyStarts
  loop.startFailures = (started.startFailures ?? 0) + 1
  loop.retryAt = now + retryDelay(loop.startFailures)
  return { loop, note: `∞ Не удалось запустить задачу: ${oneLine(error, 300)}. Следующая попытка в ${clockOf(loop.retryAt)}.` }
}

// ---- Texts ----

// The prompt of loop task `task`: the goal, what the user wrote in the chat since the loop started, how the previous
// attempt ended when it did not complete normally, the scheduled wake-ups that fell due (`wakeupsText` = wakeupPrompt of
// src/wakeups.ts, passed as text so this file stays loadable on its own), and the one rule of the run.
export function loopPrompt(loop: ImprovementLoop, messages: Message[], task: number, outcome?: string, wakeupsText?: string): string {
  const since = Date.parse(loop.startedAt)
  const later = messages
    .filter(m => m.author === 'user' && m.text.trim() && (Number.isNaN(since) || Date.parse(m.time) > since))
    .slice(-LATER_MESSAGES)
    .map(m => `- ${clip(m.text, LATER_MESSAGE_CHARS)}`)
  const lines = [`∞ Бесконечное улучшение — задача №${task}.`, `Цель цикла: ${clip(loop.goal, 4000)}`]
  if (later.length) lines.push('', 'Сообщения пользователя в этом чате после запуска цикла (учти их):', ...later)
  if (outcome) lines.push('', `Итог предыдущей попытки: ${outcome}`)
  if (wakeupsText) lines.push('', 'Запланированные пробуждения (их срок наступил):', wakeupsText)
  lines.push('', 'Возьми из плана пачку независимых задач (до 4; или найди новые задачи для цели цикла), выполни их параллельно и доведи до конца по правилам цикла. Следующую пачку Orbit запустит сам.')
  return lines.join('\n')
}
// The chat entry that stands for a loop task's run (instead of its generated prompt as a user message).
export const loopNoteId = (runId: string) => `loop-${runId}`
export function loopNote(runId: string, task: number, time: string, outcome?: string): Message {
  const text = `∞ Задача ${task}: ${outcome ? `новая попытка. ${outcome}` : 'следующая задача плана'}`
  return { id: loopNoteId(runId), author: 'system', kind: 'loop', runId, text, time }
}

// ---- What the chat shows about its loop ----

// waiting: a start was refused because Orbit is busy and is repeated in seconds; retry: a backoff after a failure.
export type LoopPhase = 'running' | 'restarting' | 'waiting' | 'retry' | 'starting'
export type LoopView = { task: number; phase: LoopPhase; retryAt?: number }
export function loopView(loop: ImprovementLoop | undefined, state: { running: boolean; restartWait: boolean }): LoopView | undefined {
  if (!loop?.active) return undefined
  const task = Math.max(1, loop.iteration)
  if (state.running) return { task, phase: 'running' }
  if (state.restartWait) return { task, phase: 'restarting' }
  if (loop.retryAt !== undefined) return { task, phase: loop.busyStarts ? 'waiting' : 'retry', retryAt: loop.retryAt }
  return { task, phase: 'starting' }
}
export function loopPhaseText(view: LoopView): string {
  if (view.phase === 'running') return 'выполняется'
  if (view.phase === 'restarting') return 'перезапуск Orbit…'
  if (view.phase === 'waiting') return 'ждёт, пока Orbit освободится…'
  if (view.phase === 'retry' && view.retryAt !== undefined) return `следующая попытка в ${clockOf(view.retryAt)}`
  return 'запускается…'
}
