// @ts-nocheck — typing of this module was interrupted mid-way (see docs/TYPESCRIPT-MAIN.md, "Remaining work"); annotations already present are kept.
// The agent tree: creating, scheduling and resolving agents, follow-ups, cancellation signals and model slots, the
// directory, and the ways an agent ends (complete, budget reached, stopped by the loop guard, descendants cancelled).
import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { saveNote } from '../shared-context.mts'
import * as chatMemory from '../chat-memory.mts'
import type { AgentDirectoryEntry, AgentRecord, AgentResult, ChildResultEntry, FollowupResult, OrbitRuntimeLike, RunRecord, SpawnResult, TeamDigest, ToolArgs, TurnWaiter } from '../types.mts'
import { TERMINAL, AGENT_TERMINAL, ceiling, withoutGoogleReasoning, answerLimit, publicAgent, bounded, clip, abortError } from './util.mts'

function createAgent(runtime: OrbitRuntimeLike, run: RunRecord, parent: AgentRecord | null, spec: ToolArgs): AgentRecord {
  const sameProvider = !spec.providerId || spec.providerId === (parent?.providerId || run.providerId)
  const providerId = spec.providerId || parent?.providerId || run.providerId
  const model = spec.model || (sameProvider ? parent?.model || run.model : '')
  const selectedRequestModel = spec.model || (sameProvider ? parent?.requestedModel || (parent ? '' : run.model) : '') || ''
  const poolMatches = run.providerPool.filter(item => item.providerId === providerId && item.model === selectedRequestModel)
  const poolMember = poolMatches.find(item => item.reasoningEffort === spec.reasoningEffort) || poolMatches[0]
  const inheritedEffort = sameProvider && (!spec.model || spec.model === parent?.requestedModel || spec.model === parent?.model) ? parent?.reasoningEffort : undefined
  const agent: AgentRecord = {
    id: parent ? `agent-${randomUUID()}` : 'root', parentId: parent?.id || null, depth: parent ? parent.depth + 1 : 0,
    name: bounded(spec.name || 'Agent', 80), role: 'Agent', task: String(spec.task || ''), reason: bounded(spec.reason, 2000),
    providerId, model,
    memoryProfile: parent ? (spec.memoryProfile === 'project-global' ? 'project-global' : 'project') : 'project-global',
    reasoningEffort: withoutGoogleReasoning(providerId, parent ? poolMember?.reasoningEffort ?? spec.reasoningEffort ?? inheritedEffort ?? run.providerOptions[providerId]?.reasoningEffort ?? '' : run.reasoningEffort),
    requestedModel: selectedRequestModel,
    status: 'waiting', progress: 0, detail: 'Queued', startedAt: null, finishedAt: null, result: '', error: null,
    turns: 0, generation: 0, inbox: [], seenChildren: new Set(), transcript: [], transcriptChars: 0, previousWork: [], ledger: [], ledgerDropped: {},
    files: { read: [], wrote: [] }, workDone: 0,
    handovers: [], failedCandidates: new Set(), trial: null, partialTurn: null, quotaWarned: '',
    // session: one CLI process resumed turn after turn, Orbit tools over MCP; envelope: the JSON protocol, one process per turn.
    transport: runtime.decideTransport(run, providerId, model), sessionId: null, sessionToken: null, sessionCursor: 0, turnTimings: [], activeTurn: null, stream: null,
  }
  run.agentNodes.set(agent.id, agent)
  run.agentOperations.set(agent.id, new Set())
  const parentSignal = parent ? runtime.agentSignal(run, parent) : null
  const controller = parent ? new AbortController() : run.controller
  const abort = () => controller.abort()
  setMaxListeners(0, controller.signal)
  parentSignal?.addEventListener('abort', abort, { once: true })
  if (parentSignal?.aborted) controller.abort()
  run.agentControllers.set(agent.id, { controller, parentSignal, abort })
  runtime.emit(run, 'agent.created', { agent: publicAgent(agent) })
  runtime.recordCommunication(run, parent || { id: 'user', name: 'Вы' }, agent, agent.task, { kind: 'spawn', reason: agent.reason })
  return agent
}
function scheduleAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<AgentResult> {
  // Register the task immediately, but start inference after the whole tool batch
  // has registered its participants and initial messages.
  const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => runtime.executeAgent(run, agent))
    .catch((error): AgentResult => ({ agentId: agent.id, generation: agent.generation, status: agent.status, error: error.message }))
  run.tasks.set(agent.id, task)
  return task
}
function spawnSubAgent(runtime: OrbitRuntimeLike, runId: string, parentId: string, spec: ToolArgs = {}): SpawnResult {
  const run = runtime.runs.get(runId)
  if (!run || TERMINAL.has(run.status)) return { ok: false, reason: 'run_not_active' }
  const parent = run.agentNodes.get(parentId)
  if (!parent || ['done', 'error', 'cancelled'].includes(parent.status)) return { ok: false, reason: 'parent_not_active' }
  if (!String(spec.task || '').trim() || !String(spec.reason || '').trim()) return { ok: false, reason: 'task_and_delegation_reason_required' }
  if (spec.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled'].includes(spec.reasoningEffort)) return { ok: false, reason: 'invalid_reasoning_effort' }
  let prior = null
  if (spec.continueFrom) {
    prior = chatMemory.findAgent(run.priorRuns, spec.continueFrom)
    if (!prior) return { ok: false, reason: 'continue_from_not_found', instruction: 'No agent with that name ran in earlier turns of this chat; team_history lists them.' }
    if (!spec.name) spec = { ...spec, name: prior.name }
  }
  if (run.providerPool.length && spec.providerId && spec.providerId !== run.providerId && !run.providerPool.some(item => item.providerId === spec.providerId && (!spec.model || !item.model || item.model === spec.model))) return { ok: false, reason: 'provider_model_not_in_configured_pool' }
  if (spec.providerId && spec.providerId !== parent.providerId && !spec.model) spec = { ...spec, model: run.providerPool.find(item => item.providerId === spec.providerId)?.model || '' }
  const existing = spec.name && [...run.agentNodes.values()].find(agent => agent.name === bounded(spec.name, 80))
  if (existing) return { ok: true, reused: true, agentId: existing.id, status: existing.status, instruction: 'Participant already exists. Use send_message to continue its conversation, or choose a distinct name for different work.' }
  if (parent.depth >= ceiling(run.limits, 'maxDepth')) return { ok: false, reason: 'depth_limit' }
  if (run.agentNodes.size >= ceiling(run.limits, 'maxAgents')) return { ok: false, reason: 'agent_limit' }
  if (run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) return { ok: false, reason: 'worker_turn_budget_exhausted', instruction: 'Integrate the existing findings. The root agent has no turn limit.' }
  const agent = runtime.createAgent(run, parent, spec)
  if (prior) agent.previousWork.push({ generation: prior.generation ?? 0, task: prior.task, result: prior.result, error: prior.error, files: prior.files })
  runtime.trace(run, parent.id, 'delegation', `${agent.name}: ${agent.task}\nReason: ${agent.reason}`)
  runtime.scheduleAgent(run, agent)
  return { ok: true, agentId: agent.id, agent: runtime.snapshot(run).agents.find((item) => item.id === agent.id) }
}
function resolveAgent(runtime: OrbitRuntimeLike, run: RunRecord, reference: unknown): AgentRecord {
  const id = String(reference || '')
  // Checked on the line above.
  if (run.agentNodes.has(id)) return run.agentNodes.get(id)!
  const matches = [...run.agentNodes.values()].filter((agent) => agent.name === id)
  if (matches.length > 1) throw new Error('Agent name is ambiguous; use its exact id from list_agents')
  if (!matches.length) throw new Error('Agent not found in this run')
  return matches[0]
}
function resultKey(runtime: OrbitRuntimeLike, agent: { id: string; generation: number }): string { return `${agent.id}:${agent.generation}` }
function followupAgent(runtime: OrbitRuntimeLike, run: RunRecord, sender: AgentRecord, args: ToolArgs): FollowupResult {
  const target = runtime.resolveAgent(run, args.agentId)
  if (!['done', 'error'].includes(target.status)) throw new Error('Follow-up requires a done/error agent; message active agents with send_message')
  if (run.agentOperations.get(target.id)?.size) throw new Error('Previous agent operations are still cleaning up; wait before followup_agent')
  if (!String(args.task || '').trim()) throw new Error('A concrete follow-up task is required')
  if (target.turns >= ceiling(run.limits, 'maxTurns') || run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) throw new Error('Agent or shared worker turn budget exhausted; follow-up cannot reset budgets')
  if (target.id === 'root') throw new Error('Continue the root agent through the project chat')
  const parent = target.parentId === null ? undefined : run.agentNodes.get(target.parentId)
  if (!parent || !['working', 'waiting'].includes(parent.status) || runtime.agentSignal(run, parent).aborted) throw new Error('The original parent is no longer active')
  target.previousWork.push({ generation: target.generation, task: target.task, result: target.result, error: target.error })
  target.previousWork = target.previousWork.slice(-3)
  const old = run.agentControllers.get(target.id)
  old?.parentSignal?.removeEventListener('abort', old.abort)
  const controller = new AbortController(), parentSignal = runtime.agentSignal(run, parent), abort = () => controller.abort()
  setMaxListeners(0, controller.signal)
  parentSignal.addEventListener('abort', abort, { once: true })
  run.agentControllers.set(target.id, { controller, parentSignal, abort })
  target.generation++
  runtime.remember(target, { type: 'followup_task', generation: target.generation, task: bounded(args.task, 12000), from: sender.id })
  runtime.updateAgent(run, target, { task: bounded(args.task, 12000), reason: bounded(args.reason || `Follow-up from ${sender.name}`, 2000), status: 'waiting', detail: 'Queued follow-up', result: '', error: null, progress: 0, startedAt: null, finishedAt: null })
  runtime.trace(run, sender.id, 'delegation', `Follow-up for ${target.name}: ${target.task}`)
  runtime.recordCommunication(run, sender, target, target.task, { kind: 'followup', reason: target.reason })
  runtime.scheduleAgent(run, target)
  return { ok: true, agentId: target.id, generation: target.generation, status: target.status }
}
async function acquireTurn(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<void> {
  const signal = runtime.agentSignal(run, agent)
  if (signal.aborted) throw abortError()
  if (run.activeTurns < ceiling(run.limits, 'maxConcurrent')) { run.activeTurns++; return }
  runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for a provider slot' })
  await new Promise<void>((resolve, reject) => {
    const abort = () => { const index = run.turnQueue.indexOf(waiter); if (index >= 0) run.turnQueue.splice(index, 1); reject(abortError()) }
    const waiter: TurnWaiter = { resolve, reject, signal, abort }
    signal.addEventListener('abort', waiter.abort, { once: true })
    run.turnQueue.push(waiter)
  })
}
function releaseTurn(runtime: OrbitRuntimeLike, run: RunRecord): void {
  run.activeTurns--
  const waiter = run.turnQueue.shift()
  if (waiter) { waiter.signal.removeEventListener('abort', waiter.abort); run.activeTurns++; waiter.resolve() }
}
function agentSignal(runtime: OrbitRuntimeLike, run: RunRecord, agent: { id: string }): AbortSignal { return run.agentControllers.get(agent.id)?.controller.signal || run.controller.signal }
function teamDigest(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): TeamDigest {
  const team = [...run.agentNodes.values()].filter(other => other.id !== agent.id && (agent.id === 'root' || other.parentId === agent.id))
  return { running: team.filter(other => !AGENT_TERMINAL.has(other.status)).map(other => other.name), finished: team.filter(other => AGENT_TERMINAL.has(other.status)).map(other => other.name) }
}
// Compact directory: every participant fits one observation, results are excerpts.
function agentDirectory(runtime: OrbitRuntimeLike, run: RunRecord): AgentDirectoryEntry[] {
  const agents = [...run.agentNodes.values()]
  const share = Math.max(300, Math.floor((run.limits.maxOutputChars - 1000) / Math.max(1, agents.length)) - 280)
  return agents.map(agent => ({
    id: agent.id, name: agent.name, parentId: agent.parentId, status: agent.status, generation: agent.generation,
    providerId: agent.providerId, model: agent.model, task: clip(agent.task, 240),
    result: bounded(agent.result, share), ...(agent.result.length > share ? { resultTruncated: true, fullResult: 'wait_agent {agentId} returns a direct child result in full' } : {}),
    error: agent.error, budgetLimited: !!agent.budgetLimited,
  }))
}
function cancelDescendants(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, detail: string): void {
  const parents = [agent.id]
  while (parents.length) {
    const parentId = parents.pop()
    for (const child of run.agentNodes.values()) {
      if (child.parentId !== parentId) continue
      parents.push(child.id)
      if (AGENT_TERMINAL.has(child.status)) continue
      run.agentControllers.get(child.id)?.controller.abort()
      runtime.updateAgent(run, child, { status: 'cancelled', detail, finishedAt: new Date().toISOString() }, false)
    }
  }
}
function completeAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, content: string, budgetLimited = false, detail = '', extra: Partial<AgentRecord> = {}): AgentResult {
  agent.result = bounded(content, answerLimit(run, agent))
  try { run.sharedContext = saveNote(runtime.contextStore, run.workspace, run.sharedContext, { key: `agent:${run.chatId}:${agent.name}`, summary: JSON.stringify({ result: agent.result.slice(0, 1800), task: agent.task.slice(0, 200), runId: run.runId, state: budgetLimited ? 'partial' : 'reported complete; verify before reuse' }) }) }
  catch (error) { runtime.persistenceError(run, error as Error) }
  runtime.remember(agent, { type: 'assistant_final', generation: agent.generation, content: agent.result, budgetLimited })
  // The answer is delivered: a draft kept for an optional extra turn must not resurface if the agent is woken later.
  agent.draftAnswer = null
  agent.sessionCursor = agent.transcript.length
  runtime.message(run, agent, agent.result, budgetLimited ? 'partial' : 'answer')
  runtime.updateAgent(run, agent, { status: 'done', progress: 100, budgetLimited, detail: detail || (budgetLimited ? 'Worker limit reached; findings preserved' : 'Response complete'), finishedAt: new Date().toISOString(), ...extra })
  return { agentId: agent.id, generation: agent.generation, status: 'done', result: agent.result, budgetLimited }
}
function budgetHandoff(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): AgentResult {
  const evidence = agent.transcript.filter(entry => ['tool_result', 'child_result', 'assistant_final'].includes(entry.type)).slice(-5)
  const content = `Достигнут лимит работы помощника ${agent.name}. Задача может быть не завершена.\n${agent.result ? `Последний результат:\n${agent.result}\n` : ''}${evidence.length ? `Сохранённые результаты и наблюдения:\n${bounded(evidence, run.limits.maxOutputChars - 1000)}` : 'Подтверждённых результатов пока нет.'}`
  runtime.trace(run, agent.id, 'budget', 'Worker turn limit reached; handing available evidence to the team')
  return runtime.completeAgent(run, agent, content, true)
}
// Ends an agent that keeps repeating identical calls, reporting what really happened instead of looping.
function stallHandoff(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, turns: number): AgentResult {
  const actions = agent.ledger.slice(-12).map(entry => entry.text).join('\n')
  const results = agent.transcript.filter((entry): entry is ChildResultEntry => entry.type === 'child_result' && !!entry.result).slice(-6)
    .map(entry => `- ${run.agentNodes.get(entry.agentId)?.name || entry.agentId}: ${clip(entry.result, 300)}`).join('\n')
  const content = `Остановлено автоматически: ${agent.name} повторял одни и те же вызовы с одинаковым результатом и не продвигался (ходов подряд: ${turns}). Это защита от бесконечной проверки.\nПоследние действия:\n${actions || 'нет'}${results ? `\nРезультаты помощников:\n${results}` : ''}\nЧтобы продолжить, напишите, что довести до конца; журнал действий выше сохранён.`
  runtime.trace(run, agent.id, 'budget', `Loop guard: ${turns} consecutive turns of identical repeated calls; stopping ${agent.name}`)
  runtime.cancelDescendants(run, agent, 'Parent stopped by the loop guard')
  return runtime.completeAgent(run, agent, content, true, 'Stopped: repeated identical calls', { stalled: true })
}

export { createAgent, scheduleAgent, spawnSubAgent, resolveAgent, resultKey, followupAgent, acquireTurn, releaseTurn, agentSignal, teamDigest, agentDirectory, cancelDescendants, completeAgent, budgetHandoff, stallHandoff }
