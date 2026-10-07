// User controls hold an agent and its descendants without discarding their work or cancelling the run.
import { AGENT_TERMINAL, abortError, bounded, clip } from './util.mts'
import { baseOf } from '../instances.mts'
import type { AgentControlResult, AgentRecord, AgentResult, OrbitRuntimeLike, RunRecord, ToolArgs } from '../types.mts'

const STOPPED_BY_USER = 'Stopped by the user from the Orbit window. Not a failure of the task: do not start the same work again unless the user asks; continue with what you have and say what was left undone.'
// Why a turn was cut off in the middle: the user's pause, or a message the agent is to read at once (steer.mts).
type InterruptReason = 'pause' | 'message'
// CLIs whose session keeps the prompt of a turn cut off after its model spoke. Claude's session log records it as the
// turn begins; Antigravity records the user input as the turn's first step, before any step of the model (checked live
// 2026-10-01 through Orbit's provider call: first and resumed turns cut 5-17 ms after the model's first text or the
// start of its command, resumed at once or 3 s later; all 6 resumed sessions named the code only the cut prompt carried).
// Codex and Cursor are not checked yet: both were out of quota.
const KEEPS_CUT_PROMPT = new Set(['claude', 'antigravity'])
class PauseInterrupt extends Error {
  note: string
  reason: InterruptReason
  // The session a cut-off first session turn's CLI opened after its model spoke (named by the stream, or Claude's under
  // Orbit's id), which the repeat resumes; else null.
  sessionId: string | null
  // The provider had spoken in the cut turn, so its session holds that turn's prompt.
  spoke: boolean
  constructor(note: string, reason: InterruptReason = 'pause', sessionId: string | null = null, spoke = false) { super(note); this.name = 'PauseInterrupt'; this.note = note; this.reason = reason; this.sessionId = sessionId; this.spoke = spoke }
}
function pausedBy(run: RunRecord, agent: AgentRecord): AgentRecord | null {
  const seen = new Set<string>()
  let current: AgentRecord | undefined = agent
  while (current && !seen.has(current.id)) {
    if (current.paused) return current
    seen.add(current.id)
    current = current.parentId ? run.agentNodes.get(current.parentId) : undefined
  }
  return null
}
async function pauseGate(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<boolean> {
  const signal = runtime.agentSignal(run, agent)
  let waited = false
  for (;;) {
    if (signal.aborted) throw abortError()
    const holder = pausedBy(run, agent)
    if (!holder) break
    waited = true
    runtime.updateAgent(run, agent, { status: 'paused', detail: holder.id === agent.id ? 'Пауза' : `Пауза: ${holder.name} на паузе` })
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { run.pauseWaiters.delete(wake); signal.removeEventListener('abort', abort) }
      const wake = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(abortError()) }
      run.pauseWaiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (!pausedBy(run, agent)) wake()
    })
  }
  if (waited) {
    runtime.trace(run, agent.id, 'pause', `Resumed ${agent.name}`)
    runtime.updateAgent(run, agent, { status: 'working', detail: 'Продолжает после паузы' })
  }
  return waited
}
function controlledAgent(runtime: OrbitRuntimeLike, runId: string, agentId: string): { run: RunRecord; agent: AgentRecord } {
  const run = runtime.runs.get(runId)
  if (!run || run.status !== 'working') throw new Error('Этот запуск уже завершён.')
  const agent = run.agentNodes.get(agentId)
  if (!agent) throw new Error('В этом запуске нет такого агента.')
  return { run, agent }
}
function controlResult(agent: AgentRecord): AgentControlResult { return { ok: true, agentId: agent.id, status: agent.status, paused: !!agent.paused } }
function pauseAgent(runtime: OrbitRuntimeLike, runId: string, agentId: string): AgentControlResult {
  const { run, agent } = controlledAgent(runtime, runId, agentId)
  if (agent.id === 'root' && agent.status === 'done') throw new Error('Агент уже закончил ответ.')
  if (AGENT_TERMINAL.has(agent.status)) throw new Error(`${agent.name} уже завершил работу.`)
  if (agent.paused) return controlResult(agent)
  runtime.updateAgent(run, agent, { paused: true, pausedAt: new Date().toISOString() })
  runtime.trace(run, agent.id, 'pause', 'Paused by the user')
  // Walk the subtree independently of pausedBy: a helper's own pause can hide this ancestor's pause.
  const parents = [agent.id], seen = new Set<string>()
  while (parents.length) {
    const id = parents.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    run.agentNodes.get(id)?.activeTurn?.interrupt()
    for (const child of run.agentNodes.values()) if (child.parentId === id) parents.push(child.id)
  }
  return controlResult(agent)
}
function resumeAgent(runtime: OrbitRuntimeLike, runId: string, agentId: string): AgentControlResult {
  const { run, agent } = controlledAgent(runtime, runId, agentId)
  if (!agent.paused) return controlResult(agent)
  runtime.updateAgent(run, agent, { paused: false, pausedAt: null })
  runtime.trace(run, agent.id, 'pause', 'Resumed by the user')
  const waiters = [...run.pauseWaiters]
  run.pauseWaiters.clear()
  for (const wake of waiters) wake()
  return controlResult(agent)
}
// Why a stopped agent ended, as its error says it: the user's Stop (which also sets stoppedByUser, so its parent is told,
// mailbox.stoppedHelpers) or its parent's stop_agent.
const stopNotes = new WeakMap<AgentRecord, string>()
const wasStopped = (agent: AgentRecord): boolean => !!agent.stoppedByUser || stopNotes.has(agent)
function halt(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, note: string, detail: string): void {
  stopNotes.set(agent, note)
  runtime.cancelDescendants(run, agent, 'Остановлен вместе с руководителем')
  run.agentControllers.get(agent.id)?.controller.abort()
  const actions = agent.ledger.slice(-10).map(entry => `- ${entry.text}`).join('\n')
  runtime.updateAgent(run, agent, { status: 'cancelled', paused: false, pausedAt: null, detail, error: note,
    result: actions ? bounded(`Последние действия до остановки:\n${actions}`, run.limits.maxOutputChars) : '', finishedAt: new Date().toISOString() })
  runtime.trace(run, agent.id, 'pause', note)
}
function stopAgent(runtime: OrbitRuntimeLike, runId: string, agentId: string): AgentControlResult {
  const { run, agent } = controlledAgent(runtime, runId, agentId)
  if (agent.id === 'root') throw new Error('Основной агент останавливается кнопкой «Стоп» в чате: она останавливает весь запуск.')
  if (AGENT_TERMINAL.has(agent.status)) throw new Error(`${agent.name} уже завершил работу.`)
  agent.stoppedByUser = true
  halt(runtime, run, agent, STOPPED_BY_USER, 'Остановлен вами')
  // The supervisor learns at once: a wait for mail ends naming the helper (mailbox.waitAgentMessage), a wait for the team
  // with the helper's result.
  if (agent.parentId) for (const wake of run.messageWaiters.get(agent.parentId) || []) wake()
  return controlResult(agent)
}
// stop_agent: a parent stops one of its direct helpers (stuck, off task, no longer needed) the way the user's Stop does,
// the helper's own helpers included; what it had done comes back as its result. Nothing wakes the parent: it asked.
function stopHelper(runtime: OrbitRuntimeLike, run: RunRecord, parent: AgentRecord, args: ToolArgs): AgentControlResult & { result: string } {
  const child = runtime.resolveAgent(run, args.agentId)
  if (child.parentId !== parent.id) throw new Error('stop_agent stops only your own direct helpers')
  if (!AGENT_TERMINAL.has(child.status)) {
    const reason = clip(String(args.reason || '').replace(/\s+/g, ' ').trim(), 300)
    halt(runtime, run, child, `Stopped by ${parent.name}, the agent it worked for${reason ? `: ${reason}` : ''}. Not a failure of the task.`, `Остановлен: ${parent.name}`)
  }
  parent.seenChildren.add(runtime.resultKey(child))
  return { ...controlResult(child), result: child.result }
}
function pauseNote(agent: AgentRecord, holder: AgentRecord | null): string {
  const lines = [`PAUSED BY THE USER: the user paused ${holder && holder.id !== agent.id ? `${holder.name}, whom you work under` : 'you'} in the middle of your turn and has now resumed you. That turn was cut off and its result is lost.`]
  const partial = agent.partialTurn
  const text = partial ? [...partial.messages.values()].at(-1) || '' : ''
  const actions = partial ? [...partial.tools.values()] : []
  if (text) lines.push(`Text you had streamed (may be incomplete): ${JSON.stringify(clip(text, 1200))}`)
  if (actions.length) lines.push(`Native tool actions you had started (they may already have taken effect):\n${actions.map(action => `- ${action}`).join('\n')}`)
  lines.push('Continue your task from where you stopped; check the real state (files, command results) before repeating a write or a command.')
  return lines.join('\n')
}
// A session turn cut off by a pause or a message goes on in the same session with the note: the session of a resumed turn
// (whose entries are carried again when it was cut before its provider spoke, as its prompt may not have reached the
// session; a turn that had spoken has them there, and carrying them again piled up the note of every earlier cut), or
// the one a first turn's CLI opened (PauseInterrupt.sessionId: named by its stream, or Claude's under Orbit's id; the
// cursor stays past the full prompt that turn carried). A first turn without one starts afresh, the note in its full prompt. The mail the cut turn's prompt
// carried (`delivered`) joins `held` when the session that goes on has it: resuming that session does not hand it over
// again, a fresh session does (loops.sessionLoop). Only a CLI known to keep a cut turn's prompt (KEEPS_CUT_PROMPT) holds
// it; another CLI's resumed session is given the mail again, as a copy costs less than a lost message. Returns the
// instruction the next turn resumes with.
function interruptedSession(runtime: OrbitRuntimeLike, agent: AgentRecord, error: PauseInterrupt, cursorBeforeTurn: number, delivered: string[] = [], held = new Set<string>()): string {
  if (!agent.sessionId && error.sessionId) agent.sessionId = error.sessionId
  else if (!error.spoke) agent.sessionCursor = cursorBeforeTurn
  agent.pausedSession = agent.sessionId
  if (!agent.sessionId) runtime.remember(agent, { type: 'instruction', content: error.note })
  else if (error.spoke && KEEPS_CUT_PROMPT.has(baseOf(agent.providerId))) for (const id of delivered) held.add(id)
  return error.note
}

// How an agent ends when its loop throws (loops.executeAgent): stopped by the user (its result says what it had done), or
// cancelled (an abort: the run was stopped, its parent failed) or failed. Its descendants are aborted with it: a failed
// parent must never leave them executing unowned work.
function endStopped(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): AgentResult {
  const note = stopNotes.get(agent) || STOPPED_BY_USER
  runtime.updateAgent(run, agent, { status: 'cancelled', error: note, detail: agent.stoppedByUser ? 'Остановлен вами' : agent.detail })
  return { agentId: agent.id, generation: agent.generation, status: 'cancelled', error: note, result: agent.result }
}
function markEnded(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, aborted: boolean, error: Error): void {
  // An agent already cancelled with a reason (its supervisor was stopped, the whole run was) keeps that reason.
  const marked = aborted && agent.status === 'cancelled'
  runtime.updateAgent(run, agent, { status: aborted ? 'cancelled' : 'error', error: error.message, detail: marked && agent.detail ? agent.detail : error.message, finishedAt: marked && agent.finishedAt ? agent.finishedAt : new Date().toISOString() })
  run.agentControllers.get(agent.id)?.controller.abort()
}
// An isolated helper's completion merges its changes first, so it is a promise; returned from executeAgent's catch, it is
// no longer behind the try there. A failure or an abort that reaches the merge (the run was stopped, the helper's parent
// failed) must still end the agent: left 'working', it would keep waking a parent that waits for it.
async function afterCompletion(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, signal: AbortSignal, completion: AgentResult | Promise<AgentResult>): Promise<AgentResult> {
  try { return await completion } catch (error) {
    if (wasStopped(agent)) return endStopped(runtime, run, agent)
    markEnded(runtime, run, agent, signal.aborted || agent.status === 'cancelled', error as Error)
    throw error
  }
}
export type { InterruptReason }
export { STOPPED_BY_USER, PauseInterrupt, pausedBy, pauseGate, pauseAgent, resumeAgent, stopAgent, stopHelper, wasStopped, pauseNote, interruptedSession, endStopped, markEnded, afterCompletion }
