// Orbit tool execution, one entry point for both transports: the user approval gate, shared project notes and the
// improvement plan, workspace and index tools, and the team tools; memory, skills and model assessments are in
// knowledge.mts. The registry (tool-registry.mts) validates MCP arguments before a call gets here.
import { randomUUID } from 'node:crypto'
import { executeWorkspaceTool, WORKSPACE_TOOLS } from '../runtime-tools.mts'
import { projectPacket, saveNote } from '../shared-context.mts'
import * as chatMemory from '../chat-memory.mts'
import { ceiling, bounded, clip, abortable } from './util.mts'
import { noteIndex } from './prompts.mts'
import { ranOnFields } from './agents.mts'
import * as knowledge from './knowledge.mts'
import * as restart from './restart.mts'
import * as improvement from './improvement.mts'
import type { AgentRecord, ApprovalRequest, Communication, Observation, OrbitRuntimeLike, RunRecord, ToolArgs, WorkspaceContext } from '../types.mts'

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
    return { key: note.key, summary: note.summary, stale: note.stale, files: Object.keys(note.files || {}), updatedAt: note.updatedAt }
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
  if (name === 'model_evaluate' || name === 'memory_search' || name === 'memory_save' || name === 'memory_forget' || name.startsWith('capability_')) return knowledge.executeKnowledgeTool(runtime, run, agent, name, args)
  if (name === 'restart_orbit') return restart.executeRestart(runtime, run, agent, args)
  if (run.approvalPolicy === 'on-request' && ['write_file', 'edit_file', 'run_command'].includes(name) && run.accessMode !== 'read-only') {
    if (!await runtime.approve(run, agent, { tool: name, arguments: args }, signal)) throw new Error('User declined this operation')
  }
  if (WORKSPACE_TOOLS.has(name)) {
    const context: WorkspaceContext = { workspace: run.workspace, accessMode: run.accessMode, signal, maxOutputChars: run.limits.maxOutputChars, onFileChange: change => runtime.reportWrite(run, agent, name, change), env: restart.agentEnv(runtime, run, agent) }
    const result = name === 'run_command' ? await runtime.runTrackedCommand(run, agent, args, context) : await executeWorkspaceTool(name, args, context)
    return runtime.trackWorkspaceTool(run, agent, name, args, result)
  }
  if (name === 'index_search' || name === 'index_outline') {
    if (!runtime.projectIndex) throw new Error('The project index is unavailable')
    await runtime.awaitIndex(run, { refresh: true })
    const touchedBy = (file: string) => run.fileActivity.peers(file, '').slice(0, 4).map(item => ({ agent: run.agentNodes.get(item.agentId)?.name || item.agentId, how: item.how }))
    if (name === 'index_search') {
      if (!String(args.query || '').trim()) throw new Error('A search query is required')
      // A nonempty query, checked just above.
      const found = runtime.projectIndex.search(run.workspace, args.query as string, { limit: Number(args.limit) || 10 })
      return { ...found, results: found.results.map(hit => { const touched = touchedBy(hit.path); return touched.length ? { ...hit, touchedBy: touched } : hit }) }
    }
    const outline = runtime.projectIndex.outline(run.workspace, args.path)
    if (!outline) throw new Error('That file is not in the index (missing, ignored by Git, generated or outside the project); list_files shows what exists')
    const touched = touchedBy(outline.path)
    return touched.length ? { ...outline, touchedBy: touched } : outline
  }
  if (name === 'team_history') return chatMemory.history(run.priorRuns, args, Math.max(4000, run.limits.maxOutputChars - 1000))
  if (name === 'spawn_agent') return runtime.spawnSubAgent(run.runId, agent.id, args)
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
  if (name === 'wait_agent') {
    const target = args.agentId ? runtime.resolveAgent(run, args.agentId) : null
    const children = [...run.agentNodes.values()].filter((child) => child.parentId === agent.id && (!target || child.id === target.id))
    if (args.agentId && !children.length) throw new Error('Only direct children may be waited on; ancestor waits would deadlock')
    const timeout = args.timeout_ms === undefined ? 0 : Math.max(10, Math.min(Number(args.timeout_ms) || 30000, ceiling(run.limits, 'runTimeoutMs')))
    runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for delegated results' })
    await runtime.waitForTeam(run, agent, children, timeout, signal)
    await ready?.()
    return children.map((child) => {
      if (['done', 'error', 'cancelled'].includes(child.status)) agent.seenChildren.add(runtime.resultKey(child))
      // The model fields come before the result: a long result is cut at its end.
      return { agentId: child.id, generation: child.generation, status: child.status, providerId: child.providerId, model: child.model, ...ranOnFields(child), result: child.result, error: child.error }
    })
  }
  throw new Error(`Unknown tool: ${name}`)
}

export { approve, executeTool }
