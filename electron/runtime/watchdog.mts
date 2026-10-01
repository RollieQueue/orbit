// The turn watchdog: a provider turn that reports nothing for too long is stopped and recovered instead of holding the
// agent. "Nothing" is no provider event at all (text, reasoning, tool status, diagnostics) while no Orbit tool call of
// the agent runs (the MCP server's activity), no approval waits for the user and no native tool the provider started is
// unfinished: a long build or test run stays under the provider's own inactivity timeout (providers.runCli, 15 minutes
// without output). A stopped turn, like one that timeout ended, is repeated once on the same model in a fresh session;
// a second silent turn in a row hands the agent to another subscription (failover), and without one the agent stops
// with the reason (handover.recoverStall). Measured 2026-09-30 in the saved runs: honest silences (a flagship thinking
// before its next call) reached 4.4 minutes, and GPT-OSS 120B in Antigravity sat 7 minutes without an event.
import { targetLabel } from '../failover.mts'
import { clip } from './util.mts'
import type { AgentRecord, InterruptedTurn, ProviderEvent, SessionInfo } from '../types.mts'

const DEFAULT_STALL_MS = 10 * 60 * 1000
// Tool states that end a call; any other one (started, running, in_progress, active, pending…) leaves it running.
const FINISHED = /^(?:completed?|done|succeeded|success|failed|failure|errored|error|declined|denied|rejected|cancell?ed|aborted|interrupted|skipped|timed[_ ]?out|timeout)$/i
// Silent turns in a row per agent; a completed turn clears the count.
const silentTurns = new WeakMap<AgentRecord, number>()
// Events of the model itself; an observation can be a CLI's stderr line or a note from before the CLI started.
const MODEL_EVENTS = new Set<unknown>(['output', 'reasoning', 'thinking', 'tool'])

// The silence that stops a turn: ORBIT_STALL_MS (0 turns the watchdog off), else 10 minutes.
function stallLimit(): number {
  const raw = process.env.ORBIT_STALL_MS
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 2147483647) : DEFAULT_STALL_MS
}

class StallError extends Error {
  silentMs: number
  code = 'ORBIT_TURN_STALLED'
  constructor(silentMs: number, label: string) {
    super(`${label} reported nothing for ${minutes(silentMs)} min; Orbit's watchdog stopped the turn`)
    this.name = 'StallError'
    this.silentMs = silentMs
  }
}
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60000))
// The watchdog's stop, or the provider's own inactivity timeout (providers.runCli, the Codex App Server).
const isStall = (error: unknown): boolean => error instanceof StallError || (error as { code?: unknown } | null)?.code === 'ORBIT_PROVIDER_IDLE'
// How long the stopped turn was silent: the watchdog measured it; the provider timeout names its limit in its message.
function silentMinutes(error: unknown): number {
  if (error instanceof StallError) return minutes(error.silentMs)
  const named = /no output for (\d+) ms/.exec(String((error as Error | null)?.message || ''))
  return minutes(named ? Number(named[1]) : 0)
}

interface TurnWatch {
  // Every provider event of the turn; a native tool's state tells whether it is still running.
  note(event: ProviderEvent): void
  // Something the provider waits on legitimately (an approval the user answers): no silence is counted until it settles.
  hold<T>(pending: Promise<T>): Promise<T>
  // Something the turn legitimately waits on runs (a native tool, an Orbit call over MCP, an approval).
  busy(): boolean
  // An Orbit call the stream announced has not finished: its result will carry the mail (steer.mts waits for it, the
  // watchdog does not, since a call that never reaches the MCP server must not hold it off).
  calling(): boolean
  // How long the model's current step has run: since the last tool call (native or Orbit) ended, else since the model's
  // first event (text, reasoning or a tool; not a diagnostic such as a stderr line); Infinity while the model has not
  // spoken. steer.mts cuts a turn for a message only while its step has just begun.
  stepAge(): number
  stop(): void
  readonly stalled: StallError | null
}
// Watches one provider turn; `onStall` stops it (providerTurn aborts the provider and throws `stalled`).
function watchTurn(agent: AgentRecord, session: SessionInfo | null, onStall: () => void): TurnWatch {
  const limit = stallLimit()
  const running = new Set<string>(), calls = new Set<string>()
  let last = Date.now(), holds = 0, stalled: StallError | null = null, stepAt: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const busy = (): boolean => {
    if (holds > 0 || running.size > 0) return true
    try { return Number(session?.activity?.()?.pending) > 0 } catch { return false }
  }
  if (limit > 0) {
    timer = setInterval(() => {
      if (stalled) return
      const now = Date.now()
      // Silence counts from the end of the last thing the turn legitimately waited on.
      if (busy()) { last = now; return }
      if (now - last < limit) return
      stalled = new StallError(now - last, targetLabel({ providerId: agent.providerId, model: agent.model || agent.requestedModel }))
      onStall()
    }, Math.max(10, Math.min(30000, Math.floor(limit / 4))))
    timer.unref?.()
  }
  return {
    note(event) {
      last = Date.now()
      if (MODEL_EVENTS.has(event?.kind)) stepAt ??= last
      // A tool event without an id is keyed by its text: a start whose end never matches keeps the turn "busy", which
      // leaves it to the provider's own timeout rather than stopping a healthy command.
      const key = event?.kind === 'tool' && (event.native || event.mcp) ? event.toolId || event.text : ''
      if (!key) return
      const set = event.native ? running : calls
      if (event.status && !FINISHED.test(String(event.status))) set.add(key)
      // A finished call hands its result to the model, which begins its next step.
      else { set.delete(key); stepAt = last }
    },
    hold(pending) {
      holds++
      const release = () => { holds--; last = Date.now() }
      pending.then(release, release)
      return pending
    },
    busy,
    calling: () => calls.size > 0,
    stepAge: () => stepAt === null ? Infinity : Date.now() - stepAt,
    stop() { if (timer) clearInterval(timer); timer = null },
    get stalled() { return stalled },
  }
}
// A completed turn, or a handover to another model, starts the count of silent turns afresh.
const clearSilentTurns = (agent: AgentRecord): void => { silentTurns.delete(agent) }

// What the repeated turn is told (the model reads it; Orbit's own notes to models are in English).
function stallNote(silent: number, interrupted: InterruptedTurn | null, fresh: boolean): string {
  const lines = [`WATCHDOG: your previous turn reported nothing for ${silent} min (no text, no tool call), so Orbit stopped it and its result is lost.${fresh ? ' This is a fresh session: the WORK LOG, AGENT TRANSCRIPT and FILE MAP in this prompt are the record of your work so far.' : ''}`]
  if (interrupted?.text) lines.push(`Text you had streamed (may be incomplete): ${JSON.stringify(clip(interrupted.text, 1200))}`)
  if (interrupted?.actions.length) lines.push(`Native tool actions you had started (they may already have taken effect):\n${interrupted.actions.map(action => `- ${action}`).join('\n')}`)
  lines.push('Continue your task; check the real state (files, command results) before repeating a write or a command. Keep each step short: write a large file in parts and give a long command a timeout.')
  return lines.join('\n')
}

// One more silent turn in a row for the agent; returns the count (handover.recoverStall repeats the first, not the second).
function countSilentTurn(agent: AgentRecord): number {
  const count = (silentTurns.get(agent) || 0) + 1
  silentTurns.set(agent, count)
  return count
}

export type { TurnWatch }
export { StallError, isStall, stallLimit, silentMinutes, watchTurn, countSilentTurn, clearSilentTurns, stallNote, DEFAULT_STALL_MS }
