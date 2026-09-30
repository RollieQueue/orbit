import { clip } from './text.mts'
import type { AgentRecord, AgentRef, Communication, NoticeCommunication, RouterAudience, RouterHost, RouterStats, RunRecord, TeamRouterLike, ToolArgs } from './types.mts'

// The router is the one place agent-to-agent traffic passes through. It is deliberately not a model call:
// a deterministic dispatcher costs no provider turn, adds no latency and cannot start a conversation
// loop of its own. It (1) finds the right teammates by touched files and topic when an agent does not
// know ids, (2) tells agents when a file they read or changed is edited by someone else, and (3) stops
// discussions that go around in circles without anyone changing anything.
const ROUTER = Object.freeze({ id: 'router', name: 'Маршрутизатор' })
// Messages between one pair before somebody must act (change a file, delegate) instead of talking.
const MAX_EXCHANGE = 6
const MAX_AUDIENCE = 3
const MIN_SCORE = 3
const DUPLICATE_WINDOW = 40
const NOTICE_PATHS = 12
const UNAVAILABLE = new Set(['error', 'cancelled'])
const RUN_OVER = new Set(['completed', 'failed', 'cancelled'])
const FILLER = new Set(('the and for with this that from have into about what when which where your their there would should could также этот эта это для что как при или его при над под без про').split(/\s+/))

const normalized = (text: unknown): string => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const topicWords = (text: unknown): string[] => [...new Set((String(text || '').toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || []).filter(word => !FILLER.has(word)))].slice(0, 12)
const active = (agent: AgentRecord): boolean => agent.status === 'working' || agent.status === 'waiting'

// How often two agents have written to each other since either of them last did work (workDone per agent).
interface PairState { count: number; work: Record<string, number> }
interface Candidate { agent: AgentRecord; score: number; reasons: string[] }

class TeamRouter implements TeamRouterLike {
  // Filled by Object.assign in the constructor and the assignments below it.
  declare run: RunRecord
  declare host: RouterHost
  declare pairs: Map<string, PairState>
  declare noticeMarks: Map<string, number>
  declare stats: RouterStats
  // `host.record(sender, target, text, extra)` stores a communication; `host.announce(communication, persist)` publishes a change to one;
  // `host.changed(stats)` tells the UI that the counters moved.
  constructor(run: RunRecord, host: RouterHost) {
    Object.assign(this, { run, host })
    this.pairs = new Map()
    this.noticeMarks = new Map()
    this.stats = { routed: 0, notices: 0, refused: 0 }
  }
  bump(key: keyof RouterStats, count = 1): void { this.stats[key] += count; this.host.changed?.({ ...this.stats }) }

  // Who should receive a message that names no exact recipient.
  audience(sender: AgentRecord, args: ToolArgs, resolveAgent: (reference: string) => AgentRecord): RouterAudience {
    const { run } = this
    const explicit = Array.isArray(args.agentIds) ? args.agentIds.filter(Boolean) : []
    if (explicit.length) {
      const agents = [...new Set(explicit.map(reference => resolveAgent(reference)))].filter(agent => agent.id !== sender.id).slice(0, 12)
      return { via: 'explicit', recipients: agents.map(agent => ({ agent, reasons: ['named by the sender'] })) }
    }
    if (args.replyTo) {
      const original = run.communications.find(message => message.id === args.replyTo)
      if (!original) throw new Error('replyTo must reference an existing conversation message')
      const other = run.agentNodes.get(original.fromAgentId === sender.id ? original.toAgentId : original.fromAgentId)
      if (other && other.id !== sender.id) return { via: 'reply', recipients: [{ agent: other, reasons: ['reply to the author of the message'] }] }
    }
    const files = (Array.isArray(args.files) ? args.files : []).map(String).filter(Boolean).slice(0, 12)
    const words = topicWords(args.topic)
    const candidates: Candidate[] = []
    if (files.length || words.length) {
      for (const agent of run.agentNodes.values()) {
        if (agent.id === sender.id || UNAVAILABLE.has(agent.status)) continue
        let score = 0
        const reasons: string[] = []
        for (const file of files) {
          const owner = run.fileActivity.owners(file).find(item => item.agentId === agent.id)
          if (owner) { score += owner.how === 'wrote' ? 10 : 4; reasons.push(`${owner.how === 'wrote' ? 'changed' : 'read'} ${clip(file, 80)}`) }
          else if (normalized(agent.task).includes(normalized(file))) { score += 3; reasons.push(`task mentions ${clip(file, 80)}`) }
        }
        const name = normalized(agent.name), task = normalized(agent.task), mine = run.fileActivity.forAgent(agent.id)
        const touched = normalized([...mine.wrote, ...mine.read].join(' '))
        const matched = words.filter(word => name.includes(word) || task.includes(word) || touched.includes(word))
        for (const word of matched) score += name.includes(word) ? 4 : task.includes(word) ? 2 : 1
        if (matched.length) reasons.push(`topic: ${matched.slice(0, 4).join(', ')}`)
        if (score >= MIN_SCORE) candidates.push({ agent, score, reasons })
      }
    }
    candidates.sort((a, b) => (+active(b.agent) - +active(a.agent)) || b.score - a.score)
    if (candidates.length) return { via: 'match', recipients: candidates.slice(0, MAX_AUDIENCE) }
    const parent = sender.parentId ? run.agentNodes.get(sender.parentId) : null
    if (parent && !UNAVAILABLE.has(parent.status)) return { via: 'escalation', recipients: [{ agent: parent, reasons: ['no teammate matched, so the question goes to the delegating agent'] }] }
    throw new Error('The router found no teammate for this request. Give files or a topic that match a participant, name agentIds, or reply with replyTo; the team directory shows who works on what.')
  }

  // Refuses a message that repeats an earlier one or continues a discussion in which nobody acted.
  pass(sender: AgentRecord, target: AgentRecord, text: string): void {
    const { run } = this
    const key = [sender.id, target.id].sort().join('|')
    const recent = run.communications.slice(-DUPLICATE_WINDOW)
    if (recent.some(message => message.kind === 'message' && message.fromAgentId === sender.id && message.toAgentId === target.id && normalized(message.text) === normalized(text))) {
      this.bump('refused')
      throw new Error(`You already sent «${target.name}» this exact message. Wait for the answer (wait_message) or say something new.`)
    }
    const pair: PairState = this.pairs.get(key) || { count: 0, work: {} }
    if (pair.work[sender.id] !== sender.workDone || pair.work[target.id] !== target.workDone) { pair.count = 0; pair.work = { [sender.id]: sender.workDone, [target.id]: target.workDone } }
    if (pair.count >= MAX_EXCHANGE) {
      this.bump('refused')
      throw new Error(`You and «${target.name}» have exchanged ${pair.count} messages while neither of you changed a file or delegated work. Decide now: make the change, delegate it, or report to your parent what is still disputed.`)
    }
    pair.count++
    this.pairs.set(key, pair)
  }

  // Called after `writer` changed `rel`. Everyone else who read or changed the file hears about it.
  notifyWrite(writer: AgentRecord, rel: string): { agent: string; how: string }[] {
    const shared: { agent: string; how: string }[] = []
    for (const { agentId, how } of this.run.fileActivity.peers(rel, writer.id)) {
      const reader = this.run.agentNodes.get(agentId)
      if (!reader) continue
      shared.push({ agent: reader.name, how })
      // A finished agent is not woken by a notice; it only matters to those still working on it.
      if (active(reader)) this.notice(writer, reader, rel, how === 'wrote')
    }
    return shared
  }
  notice(writer: AgentRecord, reader: AgentRecord, rel: string, conflict: boolean): void {
    // Late events from a provider that is still unwinding must not add mail to a finished run.
    if (RUN_OVER.has(this.run.status)) return
    const mark = `${writer.id}|${reader.id}|${rel}`
    if (this.noticeMarks.get(mark) === reader.turns) return
    this.noticeMarks.set(mark, reader.turns)
    if (this.noticeMarks.size > 2000) this.noticeMarks.delete(this.noticeMarks.keys().next().value as string) // the map is not empty here
    const pending = this.run.communications.find((message): message is NoticeCommunication => message.kind === 'notice' && message.toAgentId === reader.id && message.about === writer.id && !message.readAt && message.status !== 'read')
    if (pending) {
      if (!pending.paths.includes(rel) && pending.paths.length < NOTICE_PATHS) pending.paths.push(rel)
      pending.conflict = pending.conflict || conflict
      pending.text = this.noticeText(writer, pending.paths, pending.conflict)
      pending.time = new Date().toISOString()
      this.host.announce(pending, false)
      return
    }
    this.bump('notices')
    this.host.record(ROUTER, reader, this.noticeText(writer, [rel], conflict), { kind: 'notice', via: 'router', about: writer.id, aboutName: writer.name, paths: [rel], conflict })
  }
  noticeText(writer: AgentRef, paths: string[], conflict: boolean): string {
    const list = paths.join(', ')
    return conflict
      ? `EDIT CONFLICT: «${writer.name}» and you both changed ${list}. Agree through ask_team who owns it before you edit it again, and re-read it first.`
      : `«${writer.name}» changed ${list}, which you read. Re-read it before relying on or editing it; if it changes your plan, tell them through ask_team.`
  }
}

export { TeamRouter, ROUTER, MAX_EXCHANGE }
