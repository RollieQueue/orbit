// Steering: what the user or an agent above in the team writes to a working agent reaches it within its turn, not when
// the turn ends. Such mail rides whole on the agent's next Orbit tool result (mailbox.userMail); a turn that makes no
// Orbit call meanwhile (native tools and thinking only) is cut off at the start of its next step, when no native tool,
// Orbit call (announced or running) or approval is under way and the model has only just got the last tool result, and
// repeated at once with the message: the same session goes on (providerTurn throws PauseInterrupt with messageNote,
// loops.mts and pause.interruptedSession take it up). A command is never cut in the middle, nor a step the model is
// thinking or writing, and the turn is first given a moment (ORBIT_STEER_GRACE_MS) in which an Orbit call can deliver
// the mail.
import { TERMINAL, USER, clip } from './util.mts'
import { pausedBy } from './pause.mts'
import type { ActiveTurn, AgentRecord, Communication, OrbitRuntimeLike, RunRecord } from '../types.mts'

const DEFAULT_GRACE_MS = 2000
// A step younger than this is cut for a message; an older one is let finish (steer).
const DEFAULT_STEP_MS = 3000
// While the turn is busy (a command runs, an Orbit call is under way), the step boundary is looked for this often.
const POLL_MS = 250
// The pending check of each running turn (one per turn, however many messages arrive).
const checks = new WeakMap<ActiveTurn, ReturnType<typeof setTimeout>>()

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 2147483647) : fallback
}
// How long a running turn is given before it is cut for a message: ORBIT_STEER_GRACE_MS (0: at the first check), else 2 s.
const steerGrace = (): number => envMs('ORBIT_STEER_GRACE_MS', DEFAULT_GRACE_MS)
// How old the model's current step may be for a cut: ORBIT_STEER_STEP_MS, else 3 s.
const steerStep = (): number => envMs('ORBIT_STEER_STEP_MS', DEFAULT_STEP_MS)
// An agent above `agent` in the team: its parent, the parent's parent, up to the root.
function supervises(run: RunRecord, id: string, agent: AgentRecord): boolean {
  const seen = new Set<string>()
  let current = agent.parentId ? run.agentNodes.get(agent.parentId) : undefined
  while (current && !seen.has(current.id)) {
    if (current.id === id) return true
    seen.add(current.id)
    current = current.parentId ? run.agentNodes.get(current.parentId) : undefined
  }
  return false
}
// Mail that steers its recipient: a message from the user, or from an agent above the recipient in the team.
function steering(run: RunRecord, message: Communication): boolean {
  if (message.kind !== 'message') return false
  if (message.fromAgentId === USER.id) return true
  const recipient = run.agentNodes.get(message.toAgentId)
  return !!recipient && supervises(run, message.fromAgentId, recipient)
}
// A steering message reached `agent`: while its provider turn runs, the turn is checked until the mail is delivered (an
// Orbit tool result carried it), the turn ends, or the turn reaches a step boundary and is cut off for the mail.
function steer(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): void {
  const turn = agent.activeTurn
  if (!turn || checks.has(turn)) return
  let told = false
  const check = (): void => {
    checks.delete(turn)
    if (agent.activeTurn !== turn || TERMINAL.has(run.status) || runtime.agentSignal(run, agent).aborted || pausedBy(run, agent)) return
    const waiting = runtime.pendingMail(run, agent).filter(message => steering(run, message))
    if (!waiting.length) return
    const age = turn.watch ? turn.watch.stepAge() : turn.timing.firstEventAt ? 0 : Infinity
    // A model that has not spoken yet is still starting (cutting it would only repeat the launch).
    if (age === Infinity || turn.watch?.busy() || turn.watch?.calling()) { later(POLL_MS); return }
    const senders = [...new Set(waiting.map(message => message.fromAgentId === USER.id ? 'вас' : message.fromAgentName))].join(', ')
    // A model in the middle of a step (thinking or writing since the last tool result) finishes it first: a cut loses
    // what it has thought so far, and the repeat thinks it all over again. A flagship at a high effort thinks minutes per
    // step (2026-09-30: 134 s), so two messages and a pause cut such steps one after another and it never answered. The
    // message goes out right after the step's tool call, or with the next turn when the step ends the turn.
    if (age > steerStep()) {
      if (!told) { told = true; runtime.trace(run, agent.id, 'steer', `${agent.name} заканчивает текущий шаг и прочитает сообщение от ${senders} сразу после него`) }
      later(POLL_MS); return
    }
    runtime.trace(run, agent.id, 'steer', `Ход прерван между шагами, чтобы ${agent.name} сразу прочитал сообщение от ${senders}`)
    turn.interrupt('message')
  }
  const later = (ms: number): void => { const timer = setTimeout(check, ms); timer.unref?.(); checks.set(turn, timer) }
  later(steerGrace())
}
// The turn ended: its pending check is dropped.
function stopSteer(turn: ActiveTurn | null | undefined): void {
  const timer = turn ? checks.get(turn) : undefined
  if (!turn || timer === undefined) return
  clearTimeout(timer)
  checks.delete(turn)
}
// What the repeated turn is told (the model reads it; Orbit's own notes to models are in English).
function messageNote(agent: AgentRecord): string {
  const lines = ['INTERRUPTED FOR A MESSAGE: Orbit stopped your turn between two steps so that you read the new message in this prompt now rather than when the turn ends. What your tools already did stands; only the unfinished reasoning of that turn is lost.']
  const partial = agent.partialTurn
  const text = partial ? [...partial.messages.values()].at(-1) || '' : ''
  const actions = partial ? [...partial.tools.values()] : []
  if (text) lines.push(`Text you had streamed (may be incomplete): ${JSON.stringify(clip(text, 1200))}`)
  if (actions.length) lines.push(`Native tool actions of that turn:\n${actions.map(action => `- ${action}`).join('\n')}`)
  lines.push('Read the message and adjust your work to it: it may change, narrow or cancel your task. Check the real state (files, command results) before repeating a write or a command.')
  return lines.join('\n')
}

export { steer, stopSteer, steering, supervises, steerGrace, steerStep, messageNote, DEFAULT_GRACE_MS, DEFAULT_STEP_MS }
