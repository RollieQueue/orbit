// Codex counts tokens per thread, not per turn. `codex exec --json` ends a turn with `turn.completed`, whose usage is the
// thread's running total (under `exec resume` too, so it holds every earlier turn of the thread), and the App Server's
// `thread/tokenUsage/updated` carries `total` (the thread so far) and `last` (the latest model call) and is sent once more
// right after `thread/resume` to replay the history (checked against codex-cli 0.155 with a stub Responses API; the App
// Server's `turn/completed` has no usage at all). Orbit wants what each turn used, so this keeps the last total seen per
// thread and counts the difference, in OpenAI's shape (`input_tokens` includes the cached part).

export interface CodexTokens { input_tokens: number; cached_input_tokens: number; output_tokens: number }

const ZERO: CodexTokens = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
// The last total seen of each thread this Orbit process has dealt with (an agent has one); the oldest go first.
const THREADS_LIMIT = 256
const totals = new Map<string, CodexTokens>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// exec spells the figures in snake_case, the App Server in camelCase; a field that is missing counts as zero.
function readTokens(value: unknown): CodexTokens | null {
  if (!isRecord(value)) return null
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) { const number = Number(value[key]); if (value[key] != null && Number.isFinite(number) && number >= 0) return number }
    return undefined
  }
  const input = pick('input_tokens', 'inputTokens'), output = pick('output_tokens', 'outputTokens')
  if (input === undefined && output === undefined) return null
  return { input_tokens: input ?? 0, cached_input_tokens: pick('cached_input_tokens', 'cachedInputTokens') ?? 0, output_tokens: output ?? 0 }
}
function remember(thread: string, total: CodexTokens): void {
  totals.delete(thread); totals.set(thread, total)
  if (totals.size > THREADS_LIMIT) totals.delete(totals.keys().next().value!)
}
// What `total` adds to `base`; a counter that went down adds nothing, and so does a repeated report (null: no event).
function growth(total: CodexTokens, base: CodexTokens): CodexTokens | null {
  const grown = {
    input_tokens: Math.max(0, total.input_tokens - base.input_tokens),
    cached_input_tokens: Math.max(0, total.cached_input_tokens - base.cached_input_tokens),
    output_tokens: Math.max(0, total.output_tokens - base.output_tokens),
  }
  return grown.input_tokens || grown.cached_input_tokens || grown.output_tokens ? grown : null
}

// `codex exec` began a new thread: it has used nothing yet, so even a first turn that is cut off before its total arrives
// leaves a known start for the turns that resume the thread.
export function startedThread(thread: string): void { remember(thread, ZERO) }

// `turn.completed` of exec: what the turn used. A thread this process never saw before the turn (resumed after an Orbit
// restart) has an unknown total before it, and counting the lifetime total would charge the agent for earlier work, so
// that one turn is left out (null) and the total becomes the start for the next.
export function execTurnUsage(thread: string | undefined, reported: unknown, resumed: boolean): CodexTokens | null {
  const total = readTokens(reported)
  if (!total) return null
  const base = (thread ? totals.get(thread) : undefined) ?? (resumed ? null : ZERO)
  if (thread) remember(thread, total)
  return base ? growth(total, base) : null
}

// `thread/tokenUsage/updated` of the App Server. `counts`: the notification belongs to a turn this process started; the
// replay of the history after `thread/resume` (an older turn's id, or one before any turn began) only sets the start.
// A thread not seen before counts its `last` (the latest model call), which is all that is certainly new.
export function serverUsage(thread: string, tokenUsage: unknown, counts: boolean): CodexTokens | null {
  const total = readTokens(isRecord(tokenUsage) ? tokenUsage.total : undefined)
  if (!total) return null
  const base = totals.get(thread)
  remember(thread, total)
  if (!counts) return null
  if (base) return growth(total, base)
  const last = readTokens(isRecord(tokenUsage) ? tokenUsage.last : undefined)
  return last ? growth(last, ZERO) : null
}
