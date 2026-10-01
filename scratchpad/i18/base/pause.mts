// User controls hold an agent and its descendants without discarding their work or cancelling the run.
import { AGENT_TERMINAL, abortError, bounded, clip } from './util.mts'
import type { AgentControlResult, AgentRecord, OrbitRuntimeLike, RunRecord } from '../types.mts'

const STOPPED_BY_USER = 'Stopped by the user from the Orbit window. Not a failure of the task: do not start the same work again unless the user asks; continue with what you have and say what was left undone.'
// Why a turn was cut off in the middle: the user's pause, or a message the agent is to read at once (steer.mts).
type InterruptReason = 'pause' | 'message'
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
function stopAgent(runtime: OrbitRuntimeLike, runId: string, agentId: string): AgentControlResult {
  const { run, agent } = controlledAgent(runtime, runId, agentId)
  if (agent.id === 'root') throw new Error('Основной агент останавливается кнопкой «Стоп» в чате: она останавливает весь запуск.')
  if (AGENT_TERMINAL.has(agent.status)) throw new Error(`${agent.name} уже завершил работу.`)
  agent.stoppedByUser = true
  runtime.cancelDescendants(run, agent, 'Остановлен вместе с руководителем')
  run.agentControllers.get(agent.id)?.controller.abort()
  const actions = agent.ledger.slice(-10).map(entry => `- ${entry.text}`).join('\n')
  runtime.updateAgent(run, agent, { status: 'cancelled', paused: false, pausedAt: null, detail: 'Остановлен вами', error: STOPPED_BY_USER,
    result: actions ? bounded(`Последние действия до остановки:\n${actions}`, run.limits.maxOutputChars) : '', finishedAt: new Date().toISOString() })
  runtime.trace(run, agent.id, 'pause', STOPPED_BY_USER)
  // The supervisor learns at once: a wait for mail ends naming the helper (mailbox.waitAgentMessage), a wait for the team
  // with the helper's result.
  if (agent.parentId) for (const wake of run.messageWaiters.get(agent.parentId) || []) wake()
  return controlResult(agent)
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
// again, a fresh session does (loops.sessionLoop). Only Claude is known to keep a cut turn's prompt (its session log
// records it when the turn begins); another CLI's resumed session is given the mail again, as a copy costs less than a
// lost message. Returns the instruction the next turn resumes with.
function interruptedSession(runtime: OrbitRuntimeLike, agent: AgentRecord, error: PauseInterrupt, cursorBeforeTurn: number, delivered: string[] = [], held = new Set<string>()): string {
  if (!agent.sessionId && error.sessionId) agent.sessionId = error.sessionId
  else if (!error.spoke) agent.sessionCursor = cursorBeforeTurn
  agent.pausedSession = agent.sessionId
  if (!agent.sessionId) runtime.remember(agent, { type: 'instruction', content: error.note })
  else if (error.spoke && agent.providerId === 'claude') for (const id of delivered) held.add(id)
  return error.note
}
export type { InterruptReason }
export { STOPPED_BY_USER, PauseInterrupt, pausedBy, pauseGate, pauseAgent, resumeAgent, stopAgent, pauseNote, interruptedSession }
