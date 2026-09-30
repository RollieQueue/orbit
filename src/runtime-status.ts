import type { RuntimeState, RuntimeStatus } from './types'

// The runtime (agents, stores, providers) runs in a child process that main can restart without closing the window.
// Pure views of its status (runtime:status, runtime:status-changed) for the sidebar line and the settings panel.

// How long «runtime перезапущен за N мс» stays after a restart before it fades out (styles.css: .runtime-label.fading).
export const RESTARTED_SHOW_MS = 6000
// How long an error nothing caught in the running runtime stays in the sidebar line (the same fade).
export const ERROR_SHOW_MS = RESTARTED_SHOW_MS
// The sidebar line quotes this much of the error's message; its tooltip has all of it.
const ERROR_LINE_CHARS = 160

export type RuntimeIndicator = { text: string; tone: 'busy' | 'done' | 'error'; title?: string; until?: number }

type RuntimeError = NonNullable<RuntimeStatus['lastError']>
const shortened = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text)
const uncaughtLine = ({ message, count }: RuntimeError) => `ошибка в runtime${count > 1 ? ` (${count})` : ''}: ${shortened(message, ERROR_LINE_CHARS)}`

// The sidebar line: while the runtime starts, restarts or is down; for a moment after an error nothing caught in it (it
// keeps running) and after it came back.
export function runtimeIndicator(status: RuntimeStatus | null | undefined, at = Date.now()): RuntimeIndicator | null {
  if (!status) return null
  const { state, error, lastError } = status
  if (state === 'restarting' || (state === 'starting' && status.restarts > 0)) return { text: 'runtime перезапускается…', tone: 'busy' }
  if (state === 'starting') return { text: 'runtime запускается…', tone: 'busy' }
  // Main's client says whether an automatic restart follows (electron/runtime-client.cjs). Without one (a start that
  // failed, another protocol, changed shell files, too many crashes) the runtime stays down until it is asked for again.
  if (state === 'crashed' && status.retrying) return { text: 'runtime упал, перезапускается…', tone: 'busy', title: error }
  if (state === 'crashed') return { text: `runtime упал${error ? `: ${error}` : ''}`, tone: 'error', title: error }
  if (state === 'stopped') return { text: `runtime остановлен${error ? `: ${error}` : ''}`, tone: 'error', title: error }
  if (lastError && at - lastError.at < ERROR_SHOW_MS) {
    return { text: uncaughtLine(lastError), tone: 'error', title: lastError.message, until: lastError.at + ERROR_SHOW_MS }
  }
  if (status.restarts > 0 && status.lastRestartMs !== null && at - status.since < RESTARTED_SHOW_MS) {
    return { text: `runtime перезапущен за ${status.lastRestartMs} мс`, tone: 'done', until: status.since + RESTARTED_SHOW_MS }
  }
  return null
}

const stateNames: Record<RuntimeState, string> = {
  starting: 'запускается', ready: 'работает', restarting: 'перезапускается', crashed: 'упал', stopped: 'остановлен',
}
// One line for the settings panel: where the runtime runs, its state, process and restarts, why it is down, and the
// errors nothing caught in the process that runs now.
export function runtimeSummary(status: RuntimeStatus | null | undefined): string {
  if (!status) return 'Состояние runtime неизвестно.'
  const where = status.mode === 'child' ? 'Отдельный процесс' : 'В основном процессе'
  const pid = status.pid ? ` · pid ${status.pid}` : ''
  const restarts = status.restarts ? ` · перезапусков: ${status.restarts}` : ''
  const last = status.lastRestartMs !== null ? ` · последний за ${status.lastRestartMs} мс` : ''
  const uncaught = status.lastError ? ` · необработанных ошибок: ${status.lastError.count} (последняя: ${status.lastError.message})` : ''
  return `${where} · ${stateNames[status.state] || status.state}${pid}${restarts}${last}${status.error ? ` · ${status.error}` : ''}${uncaught}`
}

// Follows the runtime between status updates. `down`: a restart, crash or stop was seen since it was last ready. A ready
// status after one, or from another process than the last ready one, means the runtime came back: runs that ended with
// the old process are final only in the saved list, so the renderer reads the list again.
// Statuses arrive pushed on every change (runtime:status-changed, one ordered channel) and once as the reply to
// runtime:status at start-up. Pushes apply in arrival order (their `since` is main's wall clock, which may step back);
// the reply only until the first push, which may be newer than it (`ignored`).
// `wentDown`: the process that ran the runs so far is gone (it went down, or another process is ready without that being
// seen): the runs this window still thinks active are remembered now, and the list read after the comeback settles them.
export type RuntimeWatch = { down: boolean; readyPid: number | null; pushed: boolean }
export const initialWatch: RuntimeWatch = { down: false, readyPid: null, pushed: false }
export type RuntimeStep = { watch: RuntimeWatch; ignored: boolean; wentDown: boolean; cameBack: boolean }
export function watchRuntime(watch: RuntimeWatch, status: RuntimeStatus, pushed = true): RuntimeStep {
  if (!pushed && watch.pushed) return { watch, ignored: true, wentDown: false, cameBack: false }
  const seen = { ...watch, pushed: watch.pushed || pushed }
  if (status.state === 'ready') {
    const cameBack = watch.down || (watch.readyPid !== null && status.pid !== watch.readyPid)
    return { watch: { ...seen, down: false, readyPid: status.pid }, ignored: false, wentDown: cameBack && !watch.down, cameBack }
  }
  const down = status.state === 'restarting' || status.state === 'crashed' || status.state === 'stopped'
  return { watch: { ...seen, down: watch.down || down }, ignored: false, wentDown: down && !watch.down, cameBack: false }
}
