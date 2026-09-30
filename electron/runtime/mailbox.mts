// Team correspondence: the durable mailbox of each agent (send, read, wait, delivery marks), waking finished agents,
// the router-addressed ask_team, and the correspondence block a turn's prompt carries.
import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { ROUTER } from '../router.mts'
import type { AgentRecord, AgentRef, AskTeamResult, Communication, CommunicationDelivery, CommunicationStatus, MailboxContext, OrbitRuntimeLike, ReadMessagesResult, RunRecord, SendResult, ToolArgs } from '../types.mts'
import { ceiling, bounded, clip, abortError, abortable } from './util.mts'

type RoutedTo = AskTeamResult['routedTo'][number]

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
  if (run.communications.filter(message => message.kind === 'message').length >= ceiling(run.limits, 'maxMessages')) throw new Error('User-configured message limit reached')
  if (args.replyTo && !run.communications.some(message => message.id === args.replyTo)) throw new Error('replyTo must reference an existing conversation message')
  run.router.pass(sender, target, text)
  const communication = runtime.recordCommunication(run, sender, target, text, { kind: 'message', via: 'router', route: args.route || { via: 'direct', reasons: [] }, ...(args.replyTo ? { replyTo: args.replyTo } : {}), ...(args.discussionId ? { discussionId: args.discussionId } : {}) })
  if (target.status === 'done') {
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
  runtime.trace(run, sender.id, 'message', `To ${target.name}: ${text}`)
  runtime.trace(run, target.id, 'message', `From ${sender.name}: ${text}`)
  for (const wake of run.messageWaiters.get(target.id) || []) wake()
  return { ok: true, communicationId: communication.id, agentId: target.id, status: communication.status, delivery: communication.delivery }
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
async function waitForTeam(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, participants: { id: string }[], timeout = 0): Promise<string> {
  if (runtime.pendingMail(run, agent).length) return 'message'
  // Assigned by the Promise executor, which runs synchronously.
  let wake!: () => void
  const incoming = new Promise<string>(resolve => { wake = () => resolve('message') })
  if (!run.messageWaiters.has(agent.id)) run.messageWaiters.set(agent.id, new Set())
  // Created on the line above when missing.
  run.messageWaiters.get(agent.id)!.add(wake)
  try {
    return await abortable(Promise.race([incoming, Promise.all(participants.map(member => run.tasks.get(member.id))).then(() => 'results')]), runtime.agentSignal(run, agent), timeout, 'wait_timeout')
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
async function waitAgentMessage(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs): Promise<ReadMessagesResult> {
  if (runtime.pendingMail(run, agent).length) return { ...runtime.readAgentMessages(run, agent), timedOut: false }
  const signal = runtime.agentSignal(run, agent)
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
    return { ...runtime.readAgentMessages(run, agent), timedOut: false }
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
function mailboxContext(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): MailboxContext {
  const incoming = runtime.communicationsFor(run, agent).filter(message => !message.kind || message.kind === 'message' || message.kind === 'notice')
  const introductions = runtime.communicationsFor(run, agent, true).filter(message => message.kind === 'spawn' || message.kind === 'followup')
  const unread = incoming.filter((message) => !message.readAt)
  const ids = new Set(unread.map((message) => message.id))
  const recent = run.communications.filter((message) => (!message.kind || message.kind === 'message') && (message.toAgentId === agent.id || message.fromAgentId === agent.id) && !ids.has(message.id)).slice(-4)
  // Excerpts of unread mail, then whole recent records: only serialised into the prompt.
  const selected: object[] = [], delivered: string[] = []
  let remaining = 6000
  for (const message of unread) {
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
  return { text: selected.length ? `TEAM CORRESPONDENCE (durable records; excerpts can be retrieved using read_messages unread_only=false):\n${JSON.stringify(selected)}` : '', deliveredIds: [...delivered, ...introductions.map(message => message.id)] }
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

export { communicationsFor, pendingMail, markCommunications, sendAgentMessage, recordCommunication, readAgentMessages, waitForTeam, waitAgentMessage, mailboxContext, askTeam }
