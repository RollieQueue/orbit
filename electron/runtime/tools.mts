// Orbit tool execution, one entry point for both transports: the user approval gate, shared project notes and the
// improvement plan and wake-ups, workspace and index tools, and the team tools (run_profile among them: run-profile.mts does the
// measuring); memory, skills and model assessments are in knowledge.mts. The registry (tool-registry.mts) validates MCP
// arguments before a call gets here.
import { createHash, randomUUID } from 'node:crypto'
import { executeWorkspaceTool, WORKSPACE_TOOLS } from '../runtime-tools.mts'
import { projectPacket, saveNote } from '../shared-context.mts'
import * as chatMemory from '../chat-memory.mts'
import { pageText } from '../text.mts'
import { AGENT_TERMINAL, ceiling, bounded, clip, abortable, agentWorkspace, logicalWorkspace } from './util.mts'
import { noteIndex } from './prompts.mts'
import { ranOnFields } from './agents.mts'
import { stopHelper } from './pause.mts'
import { decideHeld } from './isolation.mts'
import * as knowledge from './knowledge.mts'
import * as agentTools from './agent-tools.mts'
import { executeConnectorTool } from './connector-tools.mts'
import * as restart from './restart.mts'
import * as improvement from './improvement.mts'
import * as wakeups from './wakeups.mts'
import { profileRun, formatProfile, span } from './run-profile.mts'
import type { ProfileSource } from './run-profile.mts'
import type { AgentRecord, ApprovalRequest, Communication, Observation, OrbitRuntimeLike, RunRecord, ToolArgs, WorkspaceContext } from '../types.mts'

// wait_agent returns at least this often while helpers work: ORBIT_WAIT_CHECK_MS, else 5 minutes.
function checkEvery(): number {
  const value = Number(process.env.ORBIT_WAIT_CHECK_MS)
  return Number.isFinite(value) && value >= 10 ? value : 5 * 60 * 1000
}
// Trace kinds that show what a helper did, and the bare "Bash status=started" lines among them that say nothing.
const STEP_KINDS = new Set(['tool', 'output', 'message', 'steer', 'pause', 'watchdog', 'handover'])
const BARE_STATUS = /^[\w.:-]+ status=\w+$/
const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60000))} min`
// A helper still at work as its parent's wait_agent shows it: how long it has worked, how long since it or a helper of
// its own last did anything, and its last steps.
function progressOf(run: RunRecord, child: AgentRecord, now: number): { workingFor: string; quietFor: string; lastSteps: string[] } {
  const team = new Set([child.id])
  for (let grew = true; grew;) {
    grew = false
    for (const node of run.agentNodes.values()) if (node.parentId && team.has(node.parentId) && !team.has(node.id)) { team.add(node.id); grew = true }
  }
  const started = Date.parse(child.startedAt || '') || now
  let last = 0
  const steps: string[] = []
  for (let index = run.traces.length - 1; index >= 0 && steps.length < 4; index--) {
    const trace = run.traces[index]
    if (!team.has(trace.agentId)) continue
    last ||= Date.parse(trace.time) || 0
    const text = trace.text.replace(/\s+/g, ' ').trim()
    if (trace.agentId === child.id && STEP_KINDS.has(trace.kind) && text && !BARE_STATUS.test(text)) steps.unshift(clip(text, 160))
  }
  return { workingFor: minutes(now - started), quietFor: minutes(now - Math.max(last, started)), lastSteps: steps }
}

// A finished helper's full result goes to a wait_agent caller once per context: the same session of its model, which keeps
// what it read. Every later wait without agentId names the helper by status and an excerpt (the root's context is read
// again at every step, and a result repeated in it is paid for at each). What a context has not been shown in full is
// never cut: the record is the context's identity plus a fingerprint of the result, and a context that cannot be
// told (no running session turn, the envelope transport, which rebuilds its prompt from a trimmed transcript) is shown
// everything. A new session (a handover, a repeated or resumed run, a session started afresh after a failed resume) has
// another identity, a follow-up's result another generation, so each of them gets the full result. A result is recorded
// as shown only when the answer carried it whole: one that did not fit the answer's budget goes as an excerpt and stays new.
// Claude Code compacts a long session without changing its id and says so (`compact_boundary`): each compaction is another
// context, because the text may be gone. Codex compacts silently, which Orbit cannot see: the excerpt's note therefore never
// claims the text is still there.
const EXCERPT_CHARS = 300
// What an answer keeps free for what wraps it (session.mts: the stillRunning envelope).
const ANSWER_RESERVE = 400
// What the note on an answer that leaves results out takes.
const MORE_NOTE_ROOM = 150
const shownResults = new WeakMap<AgentRecord, Map<string, string>>()
const compactions = new WeakMap<AgentRecord, number>()
const turnNumbers = new WeakMap<object, number>()
let turnCount = 0
function noteCompaction(agent: AgentRecord): void { compactions.set(agent, (compactions.get(agent) ?? 0) + 1) }
function contextOf(agent: AgentRecord): string | null {
  const turn = agent.activeTurn
  if (!turn || agent.transport !== 'session') return null
  // The turn's session as its record names it (Claude's own from the start, Codex's, Cursor's and Antigravity's once their
  // stream says so); until then the turn alone: a cut turn that is repeated afresh is another context.
  let name = turn.timing.sessionId
  if (!name) { let number = turnNumbers.get(turn); if (!number) turnNumbers.set(turn, number = ++turnCount); name = `turn#${number}` }
  return `${agent.providerId}|${agent.handovers.length}|${name}|${compactions.get(agent) ?? 0}`
}
const jsonSize = (value: unknown): number => JSON.stringify(value).length
const excerptEntry = (head: Record<string, unknown>, child: AgentRecord, fullResult: string): Record<string, unknown> => ({ ...head, result: clip(child.result, EXCERPT_CHARS), resultTruncated: true, fullResult, error: child.error })
// A result asked for by id that one answer cannot hold: its beginning as far as `size` characters of JSON allow.
function headOfResult(head: Record<string, unknown>, child: AgentRecord, size: number): Record<string, unknown> {
  const note = `this result is ${child.result.length} characters, more than one answer holds: these are its first characters, the rest is not available through wait_agent`
  const build = (length: number) => ({ ...head, result: child.result.slice(0, length), resultTruncated: true, fullResult: note, error: child.error })
  let length = Math.min(child.result.length, Math.max(EXCERPT_CHARS, size - jsonSize(build(0))))
  while (length > EXCERPT_CHARS && jsonSize(build(length)) > size) length = Math.max(EXCERPT_CHARS, Math.floor(length * 0.9))
  return build(length)
}
// A finished helper's result that is new to the caller, and the forms it can take in the answer.
interface FreshResult { index: number; child: AgentRecord; key: string; head: Record<string, unknown>; whole: Record<string, unknown> }
const earlierNote = (id: unknown): string => `shown in full earlier in this conversation; if you no longer have it, wait_agent {agentId: "${id}"} returns it again`
// Puts the new results into `entries` (their places are null) within `budget` characters of JSON (`limit`: what the answer may
// not exceed at all), and returns those given whole. In order: a result is whole when it fits together with what is fixed and
// a stub for each one behind it (the excerpts of results the caller had before shrink to stubs for that), else an excerpt, else
// a stub; the first is never held back by the ones behind it (a result that fits alone must come at some call), and when even
// stubs do not fit, the last ones wait for the next call, which says so. By id the single result is given as far as the
// budget allows.
function fitResults(entries: (Record<string, unknown> | null)[], fresh: FreshResult[], budget: number, limit: number, byId: boolean): FreshResult[] {
  const given: FreshResult[] = []
  const stubs = fresh.map(({ child }) => ({ agentId: child.id, generation: child.generation, status: child.status, result: '', resultTruncated: true, fullResult: `this result did not fit this answer; wait_agent {agentId: "${child.id}"} returns it` }))
  // The excerpts of results shown before, and what each shrinks to.
  const shrinks = entries.flatMap((entry, index) => entry && entry.resultTruncated === true && entry.fullResult === earlierNote(entry.agentId) ? [{ index, stub: { agentId: entry.agentId, generation: entry.generation, status: entry.status, result: '', resultTruncated: true, fullResult: entry.fullResult } }] : [])
  let used = jsonSize(entries.filter(entry => entry !== null)) + fresh.length, tail = stubs.reduce((sum, stub) => sum + jsonSize(stub), 0), omitted = 0
  const shrunkSize = (): number => used - shrinks.reduce((sum, { index, stub }) => sum + jsonSize(entries[index]) - jsonSize(stub), 0)
  const shrink = (): void => { used = shrunkSize(); for (const { index, stub } of shrinks) entries[index] = stub; shrinks.length = 0 }
  fresh.forEach((item, at) => {
    tail -= jsonSize(stubs[at])
    const fits = (entry: unknown, slack: number, space = budget, taken = used): boolean => taken + jsonSize(entry) + slack <= space
    const excerpt = excerptEntry(item.head, item.child, `this result did not fit this answer together with the others; wait_agent {agentId: "${item.child.id}"} returns it`)
    let chosen: Record<string, unknown> | null = null
    if (fits(item.whole, tail)) chosen = item.whole
    else if (byId) chosen = headOfResult(item.head, item.child, budget - used)
    else if (fits(item.whole, tail, budget, shrunkSize())) { shrink(); chosen = item.whole }
    else if (at === 0 && fits(item.whole, MORE_NOTE_ROOM, limit, shrunkSize())) { shrink(); chosen = item.whole }
    else if (fits(excerpt, tail)) chosen = excerpt
    else if (fits(stubs[at], tail) || fits(stubs[at], 0)) chosen = stubs[at]
    if (chosen === null) { omitted++; return }
    entries[item.index] = chosen
    used += jsonSize(chosen)
    if (chosen === item.whole) given.push(item)
  })
  const first = entries.find(entry => entry !== null)
  if (omitted && first) first.moreResults = `${omitted} more finished result${omitted > 1 ? 's' : ''} did not fit this answer: call wait_agent again`
  return given
}
const fingerprint = (child: AgentRecord, context: string | null): string => `${context}|${child.status}|${createHash('sha1').update(child.result).update('\0').update(String(child.error ?? '')).digest('hex')}`
function resultShownBefore(agent: AgentRecord, key: string, child: AgentRecord, context: string | null): boolean {
  return context !== null && shownResults.get(agent)?.get(key) === fingerprint(child, context)
}
function noteShown(agent: AgentRecord, key: string, child: AgentRecord, context: string): void {
  let shown = shownResults.get(agent)
  if (!shown) shownResults.set(agent, shown = new Map())
  shown.set(key, fingerprint(child, context))
}

// run_profile: where the wall-clock time of this run, up to now, or of an earlier run of this chat went. Every agent may ask
// (it reads timings and names, like team_history); a run of another chat is refused as if it did not exist. The helpers in
// the structured profile are cut to the longest ones so that the answer fits an observation.
const PROFILED_HELPERS = 20
function profileOf(runtime: OrbitRuntimeLike, run: RunRecord, args: ToolArgs): Observation {
  const wanted = typeof args.runId === 'string' ? args.runId.trim() : ''
  let source: ProfileSource = run
  if (wanted && wanted !== run.runId) {
    const other = runtime.runs.get(wanted) ?? runtime.runStore?.get?.(wanted) ?? null
    if (!other || other.projectId !== run.projectId || other.chatId !== run.chatId) throw new Error('No run with that id in this chat; team_history lists the earlier turns of this chat')
    source = other
  }
  const profile = profileRun(source, runtime.clock())
  const { helpers } = profile
  return {
    runId: profile.runId, status: profile.status, wallClock: span(profile.wallMs), helpers: helpers.length, text: formatProfile(profile),
    profile: {
      ...profile, helpers: helpers.slice(0, PROFILED_HELPERS), ...(helpers.length > PROFILED_HELPERS ? { helpersOmitted: helpers.length - PROFILED_HELPERS } : {}),
      ...(profile.tokens && profile.tokens.agents.length > PROFILED_HELPERS + 1 ? { tokens: { ...profile.tokens, agents: profile.tokens.agents.slice(0, PROFILED_HELPERS + 1), agentsOmitted: profile.tokens.agents.length - PROFILED_HELPERS - 1 } } : {}),
    },
  }
}

async function approve(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, request: ApprovalRequest, signal: AbortSignal = runtime.agentSignal(run, agent)): Promise<boolean> {
  if (signal.aborted || !runtime.requestApproval) return false
  runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for your permission' })
  try {
    const approved = await abortable(Promise.resolve(runtime.requestApproval({ ...request, runId: run.runId, agentId: agent.id, agentName: agent.name, workspace: run.workspace, signal })), signal)
    runtime.trace(run, agent.id, 'observation', `${approved ? 'Approved' : 'Declined'}: ${request.tool}`)
    return approved === true
  } finally { if (!signal.aborted) runtime.updateAgent(run, agent, { status: 'working', detail: 'Resuming task' }) }
}
// `ready` (session.dispatchMcp, waits only): awaited before a wait takes what it found (mail read, helper results seen).
async function executeTool(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs, signal: AbortSignal = runtime.agentSignal(run, agent), ready?: () => Promise<void>): Promise<Observation> {
  if (name === 'context_read') {
    const packet = projectPacket(runtime.contextStore, run.workspace, run.sharedContext)
    if (args.key === undefined) {
      // The overview and the newest notes are already in every prompt; the tool lists keys and short summaries.
      const { overview, ...index } = noteIndex(packet, 10, 400, run.chatId)
      return { ...index, hint: 'Same data as SHARED PROJECT CONTEXT in your prompt; context_read {key} reads one note in full' }
    }
    const note = (packet.notes || []).find(item => item.key === String(args.key))
    if (!note) throw new Error(`No shared note has the key "${clip(args.key, 80)}"; call context_read without a key to list the keys`)
    // A helper's note keeps only the start of its report; offset or maxChars read the whole report from its run record, page by page.
    const report = chatMemory.fullReport(note.key, note.summary, run.chatId, { runId: run.runId, agents: run.agentNodes.values() }, run.priorRuns)
    const paged = args.offset !== undefined || args.maxChars !== undefined
    const shown = pageText(paged && report ? report : note.summary, args.offset, args.maxChars, 6000)
    const { text, ...position } = shown
    return {
      key: note.key, summary: text, ...position, ...(paged && report ? { source: 'full report' } : report ? { fullReportChars: report.length, hint: 'summary is the start of the report; repeat with offset 0 to read it whole, page by page' } : {}),
      stale: note.stale, files: Object.keys(note.files || {}), updatedAt: note.updatedAt,
    }
  }
  if (name === 'context_save') {
    run.sharedContext = saveNote(runtime.contextStore, run.workspace, run.sharedContext, args)
    return { ok: true, key: args.key }
  }
  if (name === 'improvement_plan') {
    if (agent.id !== 'root') throw new Error('Only the orchestrator can update the improvement plan')
    if (!run.improvementMode) throw new Error('Improvement mode is disabled')
    return improvement.updatePlan(runtime, run, args)
  }
  if (name === 'schedule_wakeup') return wakeups.schedule(runtime, run, agent, args)
  if (name === 'cancel_wakeup') return wakeups.cancel(runtime, run, agent, args)
  if (name === 'model_evaluate' || name === 'memory_search' || name === 'memory_save' || name === 'memory_forget' || name.startsWith('capability_')) return knowledge.executeKnowledgeTool(runtime, run, agent, name, args)
  if (name === 'agent_save' || name === 'agent_read') return agentTools.executeAgentTool(runtime, run, agent, name, args)
  if (name.startsWith('connector_')) return executeConnectorTool(runtime, run, agent, name, args, signal)
  if (name === 'restart_orbit') return restart.executeRestart(runtime, run, agent, args)
  if (run.approvalPolicy === 'on-request' && ['write_file', 'edit_file', 'run_command'].includes(name) && run.accessMode !== 'read-only') {
    if (!await runtime.approve(run, agent, { tool: name, arguments: args }, signal)) throw new Error('User declined this operation')
  }
  if (WORKSPACE_TOOLS.has(name)) {
    const context: WorkspaceContext = { workspace: agentWorkspace(run, agent), accessMode: run.accessMode, signal, maxOutputChars: run.limits.maxOutputChars, onFileChange: change => runtime.reportWrite(run, agent, name, change), env: restart.agentEnv(runtime, run, agent) }
    const result = name === 'run_command' ? await runtime.runTrackedCommand(run, agent, args, context) : await executeWorkspaceTool(name, args, context)
    return runtime.trackWorkspaceTool(run, agent, name, args, result)
  }
  if (name === 'index_search' || name === 'index_outline') {
    if (!runtime.projectIndex) throw new Error('The project index is unavailable')
    // The tree the agent's files belong to: the run's workspace, whatever isolated copy the agent works in (the copy itself
    // is never indexed), or Orbit's repository for a helper in an 'orbit' copy.
    const tree = logicalWorkspace(run, agent)
    await runtime.awaitIndex(run, { refresh: true, workspace: tree })
    const touchedBy = (file: string) => run.fileActivity.peers(file, '').slice(0, 4).map(item => ({ agent: run.agentNodes.get(item.agentId)?.name || item.agentId, how: item.how }))
    if (name === 'index_search') {
      if (!String(args.query || '').trim()) throw new Error('A search query is required')
      // A nonempty query, checked just above.
      const found = runtime.projectIndex.search(tree, args.query as string, { limit: Number(args.limit) || 10 })
      return { ...found, results: found.results.map(hit => { const touched = touchedBy(hit.path); return touched.length ? { ...hit, touchedBy: touched } : hit }) }
    }
    const outline = runtime.projectIndex.outline(tree, args.path)
    if (!outline) throw new Error('That file is not in the index (missing, ignored by Git, generated or outside the project); list_files shows what exists')
    const touched = touchedBy(outline.path)
    return touched.length ? { ...outline, touchedBy: touched } : outline
  }
  if (name === 'team_history') return chatMemory.history(run.priorRuns, args, Math.max(4000, run.limits.maxOutputChars - 1000))
  if (name === 'run_profile') return profileOf(runtime, run, args)
  if (name === 'spawn_agent') return runtime.spawnSubAgent(run.runId, agent.id, args)
  if (name === 'merge_agent') return decideHeld(runtime, run, agent, args)
  if (name === 'list_agents') return runtime.agentDirectory(run)
  if (name === 'ask_team') return runtime.askTeam(run, agent, args)
  if (name === 'send_message') return runtime.sendAgentMessage(run, agent, args)
  if (name === 'broadcast_message') {
    if (args.agentIds !== undefined && !Array.isArray(args.agentIds)) throw new Error('agentIds must be an array')
    const targets = args.agentIds ? [...new Set(args.agentIds.map(reference => runtime.resolveAgent(run, reference).id))] : [...run.agentNodes.keys()].filter(id => id !== agent.id)
    const discussionId = randomUUID()
    return { discussionId, deliveries: targets.map(agentId => {
      try { return runtime.sendAgentMessage(run, agent, { ...args, agentId, discussionId }) }
      catch (error) { return { ok: false, agentId, error: (error as Error).message } }
    }) }
  }
  if (name === 'read_conversation') {
    const index = args.afterId ? run.communications.findIndex(message => message.id === args.afterId) : -1
    if (args.afterId && index < 0) throw new Error('Conversation cursor is no longer available; read recent history without afterId')
    const limit = Math.max(1, Math.min(Number(args.limit) || 30, 100))
    const records = args.afterId ? run.communications.slice(index + 1) : run.communications.slice(-limit)
    const messages: Communication[] = []; let size = 0
    for (const message of records.slice(0, limit)) {
      const entry = { ...message, text: bounded(message.text, Math.max(200, run.limits.maxOutputChars - 1000)) }
      const length = JSON.stringify(entry).length
      if (messages.length && size + length > run.limits.maxOutputChars - 300) break
      messages.push(entry); size += length
    }
    return { messages, nextCursor: messages.at(-1)?.id || args.afterId || null, hasMore: records.length > messages.length }
  }
  if (name === 'read_messages') return runtime.readAgentMessages(run, agent, args)
  if (name === 'wait_message') return runtime.waitAgentMessage(run, agent, args, signal, ready)
  if (name === 'followup_agent') return runtime.followupAgent(run, agent, args)
  if (name === 'stop_agent') return stopHelper(runtime, run, agent, args)
  if (name === 'wait_agent') {
    const target = args.agentId ? runtime.resolveAgent(run, args.agentId) : null
    const children = [...run.agentNodes.values()].filter((child) => child.parentId === agent.id && (!target || child.id === target.id))
    if (args.agentId && !children.length) throw new Error('Only direct children may be waited on; ancestor waits would deadlock')
    const timeout = args.timeout_ms === undefined ? 0 : Math.max(10, Math.min(Number(args.timeout_ms) || 30000, ceiling(run.limits, 'runTimeoutMs')))
    runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for delegated results' })
    // The wait ends with the first helper to finish (at once when a finished one's result is new to the caller), and at
    // the latest after checkEvery() with the progress of those still at work: a parent never sits blind on a slow or
    // stuck helper while a finished one's result waits (2026-10-01: the root sat 20 minutes in one wait, the results of
    // two helpers ready 8 and 19 minutes before it took them, and never looked at the third one's work).
    const running = children.filter(child => !AGENT_TERMINAL.has(child.status))
    const fresh = children.some(child => AGENT_TERMINAL.has(child.status) && !agent.seenChildren.has(runtime.resultKey(child)))
    if (running.length && !fresh) await runtime.waitForTeam(run, agent, running, timeout ? Math.min(timeout, checkEvery()) : checkEvery(), signal, true)
    await ready?.()
    const now = Date.now()
    const context = contextOf(agent)
    const entries: (Record<string, unknown> | null)[] = []
    const unseen: FreshResult[] = []
    // A result counts as seen (the wait ends at once for what is new, the turn's end does not bring it again) only when the answer
    // carried it whole, or the caller had it whole before.
    const seen = (child: AgentRecord, key: string): void => { agent.seenChildren.add(key); if (context !== null) noteShown(agent, key, child, context) }
    for (const child of children) {
      const ended = AGENT_TERMINAL.has(child.status), key = runtime.resultKey(child)
      // The model fields come before the result: a long result is cut at its end.
      const head = { agentId: child.id, generation: child.generation, status: child.status, providerId: child.providerId, model: child.model, ...ranOnFields(child), ...(child.isolation ? { isolation: child.isolation } : {}) }
      if (!ended) { entries.push({ ...head, ...progressOf(run, child, now), result: child.result, error: child.error }); continue }
      const whole = { ...head, result: child.result, error: child.error }
      if (!target && child.result.length > EXCERPT_CHARS && resultShownBefore(agent, key, child, context)) {
        agent.seenChildren.add(key)
        entries.push(excerptEntry(head, child, earlierNote(child.id)))
      } else if (child.result.length <= EXCERPT_CHARS) { seen(child, key); entries.push(whole) }
      else { unseen.push({ index: entries.length, child, key, head, whole }); entries.push(null) }
    }
    // The answer is cut at the output limit, so it is assembled within it (what wraps it when helpers still work: session.mts).
    const waiting = children.some(child => !AGENT_TERMINAL.has(child.status))
    const limit = Math.max(1000, run.limits.maxOutputChars)
    for (const item of fitResults(entries, unseen, limit - (waiting ? ANSWER_RESERVE : 0), limit, !!target)) seen(item.child, item.key)
    return entries.filter(entry => entry !== null)
  }
  throw new Error(`Unknown tool: ${name}`)
}

export { approve, executeTool, noteCompaction }
