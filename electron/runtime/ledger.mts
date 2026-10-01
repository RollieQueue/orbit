// An agent's own memory of what it did: the transcript (with tracked sizes and trimming), the work log of executed
// calls (one line each, kept for the agent's life) and the collection of finished helpers' results into both.
import type { AgentRecord, OrbitRuntimeLike, RunRecord, ToolCall, TranscriptEntry } from '../types.mts'
import { AGENT_TERMINAL, clip } from './util.mts'

// The observation is whatever JSON the tool returned; its fields are read by tool name on the same line, so a loose
// record is the honest type here (one `any`, shared with the argument bag it is described next to).
type Loose = Record<string, any>

const LEDGER_LIMIT = 60
// JSON size of each transcript entry, computed once, so trimming never re-serialises the whole transcript.
const ENTRY_SIZES = new WeakMap<TranscriptEntry, number>()
const entrySize = (entry: TranscriptEntry): number => { let size = ENTRY_SIZES.get(entry); if (size === undefined) { size = JSON.stringify(entry).length; ENTRY_SIZES.set(entry, size) } return size }
// One line per executed call: what was asked and what came back, small enough to keep forever.
function describeCall(call: ToolCall, observation: Loose, failure: string | null, nameOf: (id: string) => string = id => id): string {
  const args: Loose = call.arguments || {}
  let subject = args.path ? ` ${clip(args.path, 90)}` : ''
  let outcome: string | undefined
  if (failure) outcome = `ERROR ${clip(failure, 140)}`
  else if (call.name === 'read_file') {
    const start = observation.startLine || 1
    // A split always yields at least one line.
    const last = String(observation.content || '').split('\n').at(-1)!.match(/^(\d+): /)
    outcome = `lines ${start}-${last ? last[1] : start} of ${observation.totalLines}${observation.truncated ? ', more remain' : ''}`
  } else if (call.name === 'list_files') outcome = `${observation.files?.length ?? 0} entries`
  else if (call.name === 'write_file') outcome = `wrote ${observation.bytes} bytes`
  else if (call.name === 'edit_file') outcome = `edited (-${String(args.old_text || '').length}/+${String(args.new_text || '').length} chars: "${clip(args.new_text, 60)}")`
  else if (call.name === 'run_command') {
    subject = ` ${clip([args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' '), 110)}`
    const tail = clip(String(observation.stderr || observation.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1), 110)
    outcome = `${observation.timedOut ? 'timed out' : `exit ${observation.exitCode ?? '?'}`}${tail ? ` — ${tail}` : ''}`
  } else if (call.name === 'spawn_agent') {
    subject = ` ${clip(args.name, 60)}`
    outcome = observation.ok ? `${observation.reused ? 'reused' : 'started'} ${observation.agentId}` : `refused: ${observation.reason}`
  } else if (['followup_agent', 'send_message'].includes(call.name)) subject = ` ${clip(nameOf(args.agentId), 60)}`
  else if (call.name === 'ask_team') outcome = `routed to ${(observation.routedTo || []).map((item: Loose) => clip(item.name, 40)).join(', ') || 'nobody'}`
  else if (call.name === 'index_search') { subject = ` "${clip(args.query, 60)}"`; outcome = `${observation.results?.length ?? 0} hits` }
  else if (call.name === 'index_outline') outcome = `${observation.symbols?.length ?? 0} symbols, ${observation.importedBy?.length ?? 0} importers`
  else if (call.name === 'team_history') outcome = `${Array.isArray(observation) ? observation.length : 0} earlier turns`
  else if (call.name === 'list_agents') outcome = `${observation.length} participants`
  else if (call.name === 'context_read') outcome = observation.notes ? `${observation.notes.length} notes listed` : `note ${observation.key}`
  else if (['read_messages', 'wait_message'].includes(call.name)) outcome = `${observation.messages?.length ?? 0} messages${observation.timedOut ? ', timed out' : ''}${observation.stopped?.length ? `, stopped by the user: ${observation.stopped.map((item: Loose) => clip(item.name, 40)).join(', ')}` : ''}`
  else if (call.name === 'wait_agent' && Array.isArray(observation)) outcome = observation.map((item: Loose) => `${clip(nameOf(item.agentId), 40)}: ${item.status}`).join(', ') || 'no children'
  else if (call.name === 'memory_search') outcome = `${Array.isArray(observation) ? observation.length : 0} entries`
  else if (call.name === 'memory_save') outcome = `${observation.merged ? 'updated' : 'saved'} ${observation.scope || ''} note "${clip(observation.title, 60)}"${observation.demoted ? ' (kept in the project)' : ''}`
  else if (call.name === 'memory_forget') outcome = `removed ${observation.scope || ''} note "${clip(observation.title, 60)}"`
  else if (call.name === 'capability_search') outcome = `${Array.isArray(observation) ? observation.length : 0} skills`
  else if (call.name === 'capability_read') { subject = ` ${clip(observation.name, 60)}`; outcome = `loaded v${observation.version}` }
  else if (call.name === 'capability_install') { subject = ` ${clip(observation.name, 60)}`; outcome = `${observation.merged ? 'improved' : 'saved'} as ${observation.scope} v${observation.version}${observation.demoted ? ' (kept in the project)' : ''}` }
  else if (call.name === 'capability_feedback') { subject = ` ${clip(observation.name, 60)}`; outcome = `${args.outcome}, now ${Math.round((observation.reliability ?? 0) * 100)}% reliable` }
  if (outcome === undefined) outcome = observation?.ok === false ? `not ok: ${clip(observation.error || observation.reason, 100)}` : 'ok'
  return `${call.name}${subject} → ${outcome}`
}

function recordLedger(runtime: OrbitRuntimeLike, agent: AgentRecord, name: string, text: string): void {
  agent.ledger.push({ name, text })
  while (agent.ledger.length > LEDGER_LIMIT) {
    // The loop condition guarantees an entry to drop.
    const dropped = agent.ledger.shift()!
    agent.ledgerDropped[dropped.name] = (agent.ledgerDropped[dropped.name] || 0) + 1
  }
}
// The transcript window forgets old observations; the work log never forgets what was done.
function workLog(runtime: OrbitRuntimeLike, agent: AgentRecord): string {
  if (!agent.ledger.length) return ''
  const lines: string[] = []
  let remaining = 7000
  for (let index = agent.ledger.length - 1; index >= 0; index--) {
    const size = agent.ledger[index].text.length + 1
    if (size > remaining) break
    lines.unshift(agent.ledger[index].text); remaining -= size
  }
  const dropped = Object.entries(agent.ledgerDropped)
  const hidden = agent.ledger.length - lines.length
  const earlier = dropped.length || hidden ? `(${hidden + dropped.reduce((sum, [, count]) => sum + count, 0)} earlier calls not listed${dropped.length ? `: ${dropped.map(([name, count]) => `${name}×${count}`).join(', ')}` : ''})\n` : ''
  return `WORK LOG (your own completed calls, oldest first; authoritative even when the transcript omits their results. Do not repeat a call to re-check unchanged state; re-read a file range only when you need its exact text and it is no longer visible below):\n${earlier}${lines.join('\n')}\n\n`
}
function collectChildren(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, transcript: TranscriptEntry[]): number {
  let collected = 0
  for (const child of run.agentNodes.values()) {
    if (child.id === agent.id || (agent.id !== 'root' && child.parentId !== agent.id) || agent.seenChildren.has(runtime.resultKey(child)) || !AGENT_TERMINAL.has(child.status)) continue
    agent.seenChildren.add(runtime.resultKey(child))
    runtime.remember(agent, { type: 'child_result', agentId: child.id, generation: child.generation, status: child.status, result: child.result, error: child.error, budgetLimited: !!child.budgetLimited })
    // The full result may scroll out of the window; the log keeps the fact and the gist.
    runtime.recordLedger(agent, 'child_result', `#${agent.turns} result from ${child.name} (${child.status}${child.budgetLimited ? ', limit reached' : ''}): ${clip(child.result || child.error, 160)}`)
    collected++
  }
  return collected
}
// ---- Transcript bookkeeping ----------------------------------------------------------------------------------------
// Every entry is appended here so its serialised size is known; trimming then compares tracked sizes instead of
// re-serialising the whole transcript after every observation.
function remember(runtime: OrbitRuntimeLike, agent: AgentRecord, entry: TranscriptEntry): void {
  agent.transcriptChars += entrySize(entry)
  agent.transcript.push(entry)
}
// The same rule as before: the transcript's JSON (entries plus separators and brackets) stays within twice the context budget.
function trimTranscript(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): void {
  const transcript = agent.transcript
  while (transcript.length > 2 && agent.transcriptChars + transcript.length + 1 > run.limits.maxContextChars * 2) {
    // The loop condition guarantees an entry to drop.
    const dropped = transcript.shift()!
    agent.transcriptChars -= entrySize(dropped)
    if (agent.sessionCursor > 0) agent.sessionCursor--
  }
}

export { describeCall, recordLedger, workLog, collectChildren, remember, trimTranscript }
