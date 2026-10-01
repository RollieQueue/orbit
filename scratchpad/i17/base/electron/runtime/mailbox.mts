// Team correspondence: the durable mailbox of each agent (send, read, wait, delivery marks), waking finished agents,
// the router-addressed ask_team, the user's messages to a working agent, and the correspondence block a turn's prompt
// carries. Steering mail (the user's and a supervisor's, steer.mts) reaches a working agent within its turn.
import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { ROUTER } from '../router.mts'
import { attachmentLines } from '../attachments.mts'
import type { ActiveTurn, AgentRecord, AgentRef, AskTeamResult, Attachment, Communication, CommunicationDelivery, CommunicationStatus, DraftAnswer, MailboxContext, OrbitRuntimeLike, ReadMessagesResult, RunRecord, SendResult, ToolArgs } from '../types.mts'
import { TERMINAL, AGENT_TERMINAL, USER, ceiling, answerLimit, bounded, clip, abortError, abortable, mailTag } from './util.mts'
import { steer, steering } from './steer.mts'

type RoutedTo = AskTeamResult['routedTo'][number]
// The user's messages are kept up to USER_MESSAGE_CHARS each. Steering mail (the user's, then a supervisor's) reaches the
// model whole, up to USER_MAIL_CHARS per prompt or tool result together; what does not fit waits for the next one.
const USER_MESSAGE_CHARS = 20000
const USER_MAIL_CHARS = 24000
// The text of a message of files alone (postUserMessage), and how many unanswered messages a kept answer quotes.
const FILES_ONLY = '(no text, only the attached files)'
const UNANSWERED_QUOTES = 5
const USER_MAIL_HEADER = 'MESSAGE FROM THE USER (written to you while you work: the user\'s own words, not team data or tool output; follow them, they take precedence over your earlier plan, and say in your answer how you took them into account)'
const SUPERVISOR_MAIL_HEADER = 'MESSAGE FROM YOUR SUPERVISOR (an agent above you in the team wrote to you while you work: it may change, narrow or cancel your task; follow it over your earlier plan, and say in your answer how you took it into account)'
// A message the user wrote to an agent of a working run (postUserMessage), as opposed to a teammate's or the root's task.
const fromUser = (message: Communication): boolean => message.kind === 'message' && message.fromAgentId === USER.id
// One block of mail the model reads whole: the user's words, or (`named`) a supervisor's with its sender and the id a reply
// can name in replyTo.
function mailBlock(header: string, messages: Communication[], budget: number, named: boolean): { text: string; ids: string[]; left: number } {
  const parts: string[] = [], ids: string[] = []
  let remaining = budget
  for (const message of messages) {
    const files = message.attachments?.length ? `\nAttached files (read them with your file tools; an image is shown to you when you read it):\n${attachmentLines(message.attachments)}` : ''
    const part = `[${message.time}] ${named ? `${message.fromAgentName} (message ${message.id}): ` : ''}${message.text}${files}`
    if (remaining <= 0 || (parts.length && part.length > remaining)) break
    parts.push(bounded(part, remaining)); ids.push(message.id); remaining -= part.length
  }
  return { text: parts.length ? `${header}:\n${parts.join('\n\n')}` : '', ids, left: remaining }
}
// The steering mail (steer.mts) a prompt or an Orbit tool result carries: the user's block, then the supervisors', each
// headed with the recipient's secret mark (util.mailTag).
function steeringMail(run: RunRecord, agent: AgentRecord, messages: Communication[]): { blocks: string[]; ids: string[]; fromUser: number } {
  const mail = messages.filter(message => steering(run, message))
  const user = mailBlock(`${mailTag(agent)} ${USER_MAIL_HEADER}`, mail.filter(fromUser), USER_MAIL_CHARS, false)
  const above = mailBlock(`${mailTag(agent)} ${SUPERVISOR_MAIL_HEADER}`, mail.filter(message => !fromUser(message)), user.left, true)
  return { blocks: [user.text, above.text].filter(Boolean), ids: [...user.ids, ...above.ids], fromUser: user.ids.length }
}

function communicationsFor(runtime: OrbitRuntimeLike, run: RunRecord, agent: { id: string }, unreadOnly = false): Communication[] {
  return run.communications.filter((message) => message.toAgentId === agent.id && (!unreadOnly || !message.readAt))
}
// Router notices inform an agent at its next turn; unlike a request they never keep it from finishing or wake a wait.
// Mail that the running turn's prompt already carried is not pending either: in session mode tools run inside the
// turn, and the model has just read that mail (the envelope path marks it read before its tools run).
function pendingMail(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Communication[] {
  const delivered = agent.activeTurn?.delivered
  return runtime.communicationsFor(run, agent, true).filter(message => message.kind !== 'notice' && !delivered?.has(message.id))
}
function markCommunications(runtime: OrbitRuntimeLike, run: RunRecord, ids: string[], status: CommunicationStatus, delivery: CommunicationDelivery): void {
  let changed = false
  for (const message of run.communications) {
    if (!ids.includes(message.id) || message.status === 'read' || (message.status === status && message.delivery === delivery)) continue
    message.status = status; message.delivery = delivery
    if (!message.deliveredAt) message.deliveredAt = new Date().toISOString()
    if (status === 'read') message.readAt = new Date().toISOString()
    changed = true
    runtime.emit(run, 'communication.added', { communication: message }, false)
  }
  if (changed) runtime.schedulePersist(run)
}
function sendAgentMessage(runtime: OrbitRuntimeLike, run: RunRecord, sender: AgentRecord, args: ToolArgs): SendResult {
  const target = runtime.resolveAgent(run, args.agentId)
  if (target.id === sender.id) throw new Error('Send messages to another agent, not yourself')
  if (['error', 'cancelled'].includes(target.status)) throw new Error('Agent is unavailable; failed agents can be retried with followup_agent')
  if (target.id !== 'root' && (target.turns >= ceiling(run.limits, 'maxTurns') || (target.status === 'done' && run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')))) throw new Error('Recipient has no remaining work turns; its existing findings are available in list_agents')
  const text = String(args.message || '').trim()
  if (!text) throw new Error('A message is required')
  // The limit is on the agents' own talk: what the user wrote does not use it up.
  if (run.communications.filter(message => message.kind === 'message' && !fromUser(message)).length >= ceiling(run.limits, 'maxMessages')) throw new Error('User-configured message limit reached')
  if (args.replyTo && !run.communications.some(message => message.id === args.replyTo)) throw new Error('replyTo must reference an existing conversation message')
  run.router.pass(sender, target, text)
  const communication = runtime.recordCommunication(run, sender, target, text, { kind: 'message', via: 'router', route: args.route || { via: 'direct', reasons: [] }, ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.discussionId ? { discussionId: args.discussionId } : {}) })
  if (target.status === 'done') wakeFinished(runtime, run, target)
  runtime.trace(run, sender.id, 'message', `To ${target.name}: ${text}`)
  runtime.trace(run, target.id, 'message', `From ${sender.name}: ${text}`)
  for (const wake of run.messageWaiters.get(target.id) || []) wake()
  // A supervisor's word does not wait for the end of the helper's turn.
  if (steering(run, communication)) steer(runtime, run, target)
  return { ok: true, communicationId: communication.id, agentId: target.id, status: communication.status, delivery: communication.delivery }
}
// A finished agent that is written to works again: the next generation, under a fresh controller of the run's own.
function wakeFinished(runtime: OrbitRuntimeLike, run: RunRecord, target: AgentRecord): void {
  const old = run.agentControllers.get(target.id)
  old?.parentSignal?.removeEventListener('abort', old.abort)
  const controller = new AbortController(), parentSignal = run.controller.signal, abort = () => controller.abort()
  setMaxListeners(0, controller.signal)
  parentSignal.addEventListener('abort', abort, { once: true })
  run.agentControllers.set(target.id, { controller, parentSignal, abort })
  target.generation++
  runtime.updateAgent(run, target, { status: 'waiting', detail: 'Continuing conversation', finishedAt: null, progress: 0 })
  runtime.scheduleAgent(run, target)
}
// The user writes to an agent of a working run (runtime:message): the root or any helper. The message waits in the
// agent's mailbox like a teammate's and reaches the model at its next step as the user's own words (mailboxContext, or
// userMail at the end of an Orbit tool result in a session turn; a turn that makes no Orbit call is cut off for it at its
// next step boundary, steer.mts). A waiting agent is woken, a finished helper works again. The reasons for a refusal are
// shown to the user as they are.
function postUserMessage(runtime: OrbitRuntimeLike, runId: string, agentId: string, value: unknown, attachments: Attachment[] = []): SendResult {
  const run = runtime.runs.get(runId)
  if (!run || TERMINAL.has(run.status)) throw new Error('Этот запуск уже завершён: напишите новое сообщение в чат.')
  const target = run.agentNodes.get(agentId)
  if (!target) throw new Error('В этом запуске нет такого агента.')
  // Files alone make a message: the model is told there is no text.
  const text = bounded(String(value ?? '').trim(), USER_MESSAGE_CHARS) || (attachments.length ? FILES_ONLY : '')
  if (!text) throw new Error('Сообщение пустое.')
  if (target.status === 'error' || target.status === 'cancelled') throw new Error(`${target.name} остановлен и сообщений больше не получает.`)
  // A root that has answered ends the run in a moment: nothing may start again in between.
  if (run.agentNodes.get('root')?.status === 'done') throw new Error('Агент уже закончил ответ: напишите новое сообщение в чат, когда он появится.')
  // A helper in (or past) its last allowed turn would never read the message: its last turn's prompt is already built.
  if (target.id !== 'root' && (target.turns >= ceiling(run.limits, 'maxTurns') || run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns'))) throw new Error(`У ${target.name} не осталось ходов: лимит задан в настройках запуска.`)
  const communication = runtime.recordCommunication(run, USER, target, text, { kind: 'message', via: 'user', ...(attachments.length ? { attachments } : {}) })
  if (target.status === 'done') wakeFinished(runtime, run, target)
  runtime.trace(run, target.id, 'message', `From the user: ${text}${attachments.length ? ` [${attachments.map(item => item.name).join(', ')}]` : ''}`)
  for (const wake of run.messageWaiters.get(target.id) || []) wake()
  steer(runtime, run, target)
  return { ok: true, communicationId: communication.id, agentId: target.id, status: communication.status, delivery: communication.delivery }
}
// Session transport: the steering mail (the user's and a supervisor's messages) that arrived after the agent's turn had
// begun goes out at the end of its next Orbit tool result, whole, and is marked read there. Empty when there is none.
function userMail(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): string {
  if (TERMINAL.has(run.status)) return ''
  const mail = steeringMail(run, agent, runtime.pendingMail(run, agent))
  if (!mail.ids.length) return ''
  runtime.markCommunications(run, mail.ids, 'read', 'tool-result')
  return mail.blocks.map(block => `\n\n${block}`).join('')
}
// The answer kept while an optional extra turn runs (a reminder, or a resume for mail that came after it; loops.mts), with
// the user's messages the model had read when it wrote it.
function keptAnswer(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, text: string): DraftAnswer {
  return { text, read: new Set(runtime.communicationsFor(run, agent).filter(message => fromUser(message) && message.readAt).map(message => message.id)) }
}
// What is delivered when the turn after a kept answer failed (`reason`): the answer, and under it the user's messages it
// does not answer (they came after it, or only the failed turn read them) instead of leaving them silently "delivered".
function answerAsKept(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, kept: DraftAnswer, reason: string): string {
  const missed = runtime.communicationsFor(run, agent).filter(message => fromUser(message) && !kept.read.has(message.id))
  if (!missed.length) return kept.text
  const one = missed.length === 1, root = agent.id === 'root', why = clip(reason, 200)
  const lead = root ? (one ? 'ваше сообщение, отправленное во время работы, осталось' : `ваши сообщения (${missed.length}), отправленные во время работы, остались`)
    : one ? 'сообщение пользователя, отправленное во время работы, осталось' : `сообщения пользователя (${missed.length}), отправленные во время работы, остались`
  const failed = `Ход, в котором агент должен был ${one ? 'его' : 'их'} обработать, не удался${why ? ` (ошибка: ${why})` : ''}, и ответ выше написан без учёта ${one ? 'этого сообщения' : 'этих сообщений'}.`
  const again = !root ? '' : one ? ' Если оно ещё нужно, отправьте его снова.' : ' Если они ещё нужны, отправьте их снова.'
  const quotes = missed.slice(0, UNANSWERED_QUOTES).map(message => message.text === FILES_ONLY && message.attachments?.length
    ? `(только файлы: ${clip(message.attachments.map(file => file.name).join(', '), 160)})` : `«${clip(message.text, 160)}»`)
  if (missed.length > UNANSWERED_QUOTES) quotes.push(`…и ещё ${missed.length - UNANSWERED_QUOTES}`)
  const note = `Orbit: ${lead} без ответа. ${failed}${again}\n${quotes.join('\n')}`
  // The note must survive the answer limit (completeAgent keeps the head of what is longer).
  return `${bounded(kept.text, Math.max(0, answerLimit(run, agent) - note.length - 20))}\n\n${note}`
}
function recordCommunication(runtime: OrbitRuntimeLike, run: RunRecord, sender: AgentRef, target: AgentRef, text: string, extra: Partial<Communication> = {}): Communication {
  const communication: Communication = { id: randomUUID(), fromAgentId: sender.id, toAgentId: target.id, fromAgentName: sender.name, toAgentName: target.name, text, time: new Date().toISOString(), status: 'queued', delivery: 'next-turn', ...extra }
  run.communications.push(communication)
  runtime.emit(run, 'communication.added', { communication })
  return communication
}
function readAgentMessages(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs = {}): ReadMessagesResult {
  const messages = runtime.communicationsFor(run, agent, args.unread_only !== false)
  const selected: Communication[] = []
  let remaining = Math.max(1000, run.limits.maxOutputChars - 1000)
  for (const message of args.unread_only === false ? messages.slice(-24) : messages) {
    const length = JSON.stringify(message).length
    if (selected.length && length > remaining) break
    selected.push(message); remaining -= length
  }
  runtime.markCommunications(run, selected.map((message) => message.id), 'read', 'mailbox')
  return { messages: structuredClone(selected), remainingUnread: runtime.communicationsFor(run, agent, true).length }
}
// `signal`: what ends the wait early; a session turn's wait ends with its turn (session.dispatchMcp).
async function waitForTeam(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, participants: { id: string }[], timeout = 0, signal = runtime.agentSignal(run, agent)): Promise<string> {
  if (runtime.pendingMail(run, agent).length) return 'message'
  // Assigned by the Promise executor, which runs synchronously.
  let wake!: () => void
  const incoming = new Promise<string>(resolve => { wake = () => resolve('message') })
  if (!run.messageWaiters.has(agent.id)) run.messageWaiters.set(agent.id, new Set())
  // Created on the line above when missing.
  run.messageWaiters.get(agent.id)!.add(wake)
  try {
    return await abortable(Promise.race([incoming, Promise.all(participants.map(member => run.tasks.get(member.id))).then(() => 'results')]), signal, timeout, 'wait_timeout')
  } catch (error) {
    // abortable rejects with Errors (a timeout, an abort, or a failed task).
    if ((error as Error).message === 'wait_timeout') return 'timeout'
    throw error
  } finally {
    const waiters = run.messageWaiters.get(agent.id)
    waiters?.delete(wake)
    if (!waiters?.size) run.messageWaiters.delete(agent.id)
  }
}
// Direct helpers the user stopped whose results this agent has not seen yet: nothing more will come from them, so a wait
// for mail ends on them (pause.stopAgent wakes it) and names each once. The results themselves travel the usual way
// (wait_agent, the next turn's helper results): a notice cut short, or lost with a turn a pause cut off, loses nothing.
const STOP_NOTE = 'The user stopped these helpers of yours: not a failure of the task, nothing more will come from them. What each did before the stop comes with wait_agent {agentId} or with your next turn.'
const stopsNamed = new WeakMap<AgentRecord, Set<string>>()
function stoppedHelpers(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): AgentRecord[] {
  const named = stopsNamed.get(agent)
  return [...run.agentNodes.values()].filter(child => child.parentId === agent.id && child.stoppedByUser && AGENT_TERMINAL.has(child.status) && !agent.seenChildren.has(runtime.resultKey(child)) && !named?.has(child.id))
}
// `turn`: the agent's session turn when the wait began. A wait that outlived it (a pause cut the turn off) answers no one,
// so it names no helper: the resumed turn's wait does. The notice leads, so a long message cannot cut it off.
function mailArrived(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, turn: ActiveTurn | null): ReadMessagesResult {
  const stopped = agent.activeTurn === turn ? stoppedHelpers(runtime, run, agent) : []
  if (stopped.length) stopsNamed.set(agent, new Set([...stopsNamed.get(agent) || [], ...stopped.map(child => child.id)]))
  return { ...(stopped.length ? { stopped: stopped.map(child => ({ agentId: child.id, name: child.name, status: child.status })), note: STOP_NOTE } : {}), ...runtime.readAgentMessages(run, agent), timedOut: false }
}
// `signal`: what ends the wait early (a session turn's wait ends with its turn). `ready`: awaited before the wait takes
// what it found from the mailbox; it rejects, and nothing is taken, when the result could no longer reach the model
// (session.dispatchMcp: the turn ended before it had its model slot back).
async function waitAgentMessage(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs, signal = runtime.agentSignal(run, agent), ready?: () => Promise<void>): Promise<ReadMessagesResult> {
  const turn = agent.activeTurn
  if (!runtime.pendingMail(run, agent).length && !stoppedHelpers(runtime, run, agent).length) {
    if (signal.aborted) throw abortError()
    const timeout = Math.max(10, Math.min(Number(args.timeout_ms) || 30000, 60000))
    // Assigned by the Promise executor, which runs synchronously.
    let wake!: () => void
    const incoming = new Promise<void>((resolve) => { wake = resolve })
    if (!run.messageWaiters.has(agent.id)) run.messageWaiters.set(agent.id, new Set())
    // Created on the line above when missing.
    run.messageWaiters.get(agent.id)!.add(wake)
    runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for a message' })
    try {
      await abortable(incoming, signal, timeout, 'mailbox_timeout')
    } catch (error) {
      // abortable rejects with Errors (a timeout or an abort).
      if ((error as Error).message === 'mailbox_timeout') return { messages: [], timedOut: true, remainingUnread: 0 }
      throw error
    } finally {
      const waiters = run.messageWaiters.get(agent.id)
      waiters?.delete(wake)
      if (!waiters?.size) run.messageWaiters.delete(agent.id)
    }
  }
  await ready?.()
  return mailArrived(runtime, run, agent, turn)
}
// `held`: unread mail the agent's session already holds (the prompt of a turn cut off after its provider spoke carried it,
// loops.sessionLoop); it is not carried again.
function mailboxContext(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, held: ReadonlySet<string> = new Set()): MailboxContext {
  const incoming = runtime.communicationsFor(run, agent).filter(message => (!message.kind || message.kind === 'message' || message.kind === 'notice') && !held.has(message.id))
  const introductions = runtime.communicationsFor(run, agent, true).filter(message => message.kind === 'spawn' || message.kind === 'followup')
  const unread = incoming.filter((message) => !message.readAt)
  const ids = new Set(unread.map((message) => message.id))
  const recent = run.communications.filter((message) => (!message.kind || message.kind === 'message') && (message.toAgentId === agent.id || message.fromAgentId === agent.id) && !ids.has(message.id)).slice(-4)
  // Steering mail leads, whole and apart from the team's (the user's words, then a supervisor's with its sender and id);
  // then excerpts of other unread team mail, then whole recent records: only serialised into the prompt.
  const lead = steeringMail(run, agent, unread)
  const selected: object[] = [], delivered: string[] = []
  let remaining = 6000
  for (const message of unread) {
    if (steering(run, message)) continue
    const entry = { id: message.id, from: message.fromAgentName, text: bounded(message.text, 2000), excerpt: message.text.length > 2000, ...(message.kind === 'notice' ? { notice: true } : {}) }
    const size = JSON.stringify(entry).length
    if (size > remaining) break
    selected.push(entry); delivered.push(message.id); remaining -= size
  }
  for (let index = recent.length - 1; index >= 0; index--) {
    const size = JSON.stringify(recent[index]).length
    if (size > remaining) break
    selected.push(recent[index]); remaining -= size
  }
  const team = selected.length ? `TEAM CORRESPONDENCE (durable records; excerpts can be retrieved using read_messages unread_only=false):\n${JSON.stringify(selected)}` : ''
  return { text: [...lead.blocks, team].filter(Boolean).join('\n\n'), deliveredIds: [...lead.ids, ...delivered, ...introductions.map(message => message.id)], fromUser: lead.fromUser }
}
function askTeam(runtime: OrbitRuntimeLike, run: RunRecord, sender: AgentRecord, args: ToolArgs): AskTeamResult {
  const text = String(args.message || '').trim()
  if (!text) throw new Error('A message is required')
  const { via, recipients } = run.router.audience(sender, args, reference => runtime.resolveAgent(run, reference))
  if (!recipients.length) throw new Error('No recipient: name agentIds, or give files or a topic that match a participant')
  const original = args.replyTo ? run.communications.find(message => message.id === args.replyTo) : undefined
  const discussionId = original?.discussionId || randomUUID()
  const routedTo = recipients.map(({ agent, reasons }): RoutedTo => {
    try {
      const sent = runtime.sendAgentMessage(run, sender, { agentId: agent.id, message: text, replyTo: args.replyTo, discussionId, route: { via, reasons } })
      return { agentId: agent.id, name: agent.name, reason: reasons.join('; '), status: sent.status }
    // sendAgentMessage and the router throw Errors.
    } catch (error) { return { agentId: agent.id, name: agent.name, error: (error as Error).message } }
  })
  const delivered = routedTo.filter(item => !item.error)
  if (!delivered.length) throw new Error(routedTo.map(item => `${item.name}: ${item.error}`).join('; '))
  run.router.bump('routed', delivered.length)
  runtime.trace(run, ROUTER.id, 'route', `${sender.name} → ${delivered.map(item => `${item.name} (${item.reason})`).join(', ')}: ${clip(text, 240)}`)
  return { ok: true, discussionId, via, routedTo }
}

export { communicationsFor, pendingMail, markCommunications, sendAgentMessage, recordCommunication, readAgentMessages, waitForTeam, waitAgentMessage, mailboxContext, askTeam, postUserMessage, userMail, keptAnswer, answerAsKept }
