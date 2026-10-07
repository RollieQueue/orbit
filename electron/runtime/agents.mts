// The agent tree: creating, scheduling and resolving agents, follow-ups, cancellation signals and model slots, the
// directory, and the ways an agent ends (complete, budget reached, stopped by the loop guard, descendants cancelled).
import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { saveNote } from '../shared-context.mts'
import * as chatMemory from '../chat-memory.mts'
import { ROUTING_KINDS } from '../model-routing.mts'
import { isPinned, poolAllows, poolMembers } from '../failover.mts'
import { baseOf, matchesProvider } from '../instances.mts'
import { RANK, offeredLevels, clampEffort } from '../reasoning-levels.mts'
import type { AgentDirectoryEntry, AgentRecord, FailedOver, HandoverReason, EffortSource, AgentResult, ChildResultEntry, FollowupResult, IsolationPrepared, ModelTarget, OrbitRuntimeLike, PublicAgent, RoutedSpawn, RunRecord, SpawnResult, TeamDigest, ToolArgs, TurnWaiter, WorkedModel } from '../types.mts'
import { TERMINAL, AGENT_TERMINAL, ceiling, USER, newMailMark, withoutGoogleReasoning, answerLimit, REPORT_CHARS, publicAgent, agentConnectors, agentTokens, bounded, clip, abortError, unknownSubscription, avoided } from './util.mts'
import { applyProfile, freeName, markAgentUse, profileResult } from './agent-tools.mts'

// The reasoning level of a helper and why. The first rule that names one wins: the level the caller passed to spawn_agent, the
// user's provider pool entry for the model (its empty level means "auto"), the routing table's level for the kind of work,
// the parent's level when the helper runs the parent's model, the provider's settings. Whatever won is moved to the nearest
// level the model offers (reasoning-levels.mts), never refused. `note` is the short reason spawn_agent reports.
interface EffortChoice { level: string; source: EffortSource; note: string }
function decideEffort(run: RunRecord, spec: ToolArgs, providerId: string, model: string, poolEffort: string | undefined, routedEffort: string | undefined, inheritedEffort: string | undefined): EffortChoice {
  const ranked: [EffortSource, string | undefined][] = [['caller', spec.reasoningEffort || undefined], ['pool', poolEffort], ['routing', routedEffort || undefined], ['parent', inheritedEffort || undefined], ['settings', run.providerOptions[providerId]?.reasoningEffort || undefined]]
  const [source, asked = ''] = ranked.find(([, level]) => level !== undefined) || ['', '']
  const entry = run.catalogCache?.list?.find(item => item.id === providerId)
  const offered = offeredLevels(providerId, model, entry)
  const why = { caller: 'as asked', pool: asked ? 'your provider pool setting' : 'your provider pool: the provider default', routing: `routing table for ${spec.kind || 'this kind of work'}`, parent: 'same level as the parent, same model', settings: 'provider settings', '': 'none set: the provider default' }[source]
  // A provider the catalog does not list and Orbit has no default levels for (Ollama, Cursor before the list is known) keeps what was asked: its own check decides.
  if (!asked || (!entry && !offered.length && baseOf(providerId) !== 'antigravity')) return { level: asked, source, note: why }
  const { level, clamped } = clampEffort(asked, offered)
  if (!clamped) return { level, source, note: why }
  const where = `${providerId}${model ? `/${model}` : ''}`
  const gives = !offered.length ? 'has no reasoning levels' : level && offered.includes(level) && rankOf(level) < rankOf(asked) && offered.every(item => rankOf(item) <= rankOf(level)) ? `offers up to ${level}` : `offers ${offered.join(', ')}`
  return { level, source, note: `asked ${asked}; ${where} ${gives}` }
}
// A level's step on the ladder, 'enabled' (Ollama's thinking switch) included.
const rankOf = (level: string): number => RANK[level] ?? -1
// `extra`: fields the record starts with beyond what the spec says (an isolated helper's id, workspace and isolation).
// `routedEffort`: the level of the routing table for the model Orbit chose for the helper's kind of work.
function createAgent(runtime: OrbitRuntimeLike, run: RunRecord, parent: AgentRecord | null, spec: ToolArgs, extra: Partial<AgentRecord> = {}, routedEffort?: string): AgentRecord {
  const sameProvider = !spec.providerId || spec.providerId === (parent?.providerId || run.providerId)
  const providerId = spec.providerId || parent?.providerId || run.providerId
  const model = spec.model || (sameProvider ? parent?.model || run.model : '')
  const selectedRequestModel = spec.model || (sameProvider ? parent?.requestedModel || (parent ? '' : run.model) : '') || ''
  const poolMatches = poolMembers(run.providerPool, providerId).filter(item => item.model === selectedRequestModel)
  const poolMember = poolMatches.find(item => item.reasoningEffort === spec.reasoningEffort) || poolMatches[0]
  const inheritedEffort = sameProvider && (!spec.model || spec.model === parent?.requestedModel || spec.model === parent?.model) ? parent?.reasoningEffort : undefined
  const effort: EffortChoice = parent ? decideEffort(run, spec, providerId, selectedRequestModel || model, poolMember?.reasoningEffort, routedEffort, inheritedEffort) : { level: withoutGoogleReasoning(providerId, run.reasoningEffort), source: run.reasoningEffort && baseOf(providerId) !== 'antigravity' ? 'settings' : '', note: 'the run level' }
  const agent: AgentRecord = {
    id: parent ? `agent-${randomUUID()}` : 'root', parentId: parent?.id || null, depth: parent ? parent.depth + 1 : 0,
    name: bounded(spec.name || 'Agent', 80), role: 'Agent', task: String(spec.task || ''), reason: bounded(spec.reason, 2000),
    providerId, model,
    memoryProfile: parent ? (spec.memoryProfile === 'project-global' ? 'project-global' : 'project') : 'project-global',
    reasoningEffort: effort.level, effortSource: effort.source, effortNote: effort.note,
    requestedModel: selectedRequestModel,
    status: 'waiting', progress: 0, detail: 'Queued', startedAt: null, finishedAt: null, result: '', error: null,
    turns: 0, generation: 0, inbox: [], seenChildren: new Set(), transcript: [], transcriptChars: 0, previousWork: [], ledger: [], ledgerDropped: {},
    files: { read: [], wrote: [] }, workDone: 0,
    handovers: [], failedCandidates: new Set(), trial: null, partialTurn: null, quotaWarned: '',
    // session: one CLI process resumed turn after turn, Orbit tools over MCP; envelope: the JSON protocol, one process per turn.
    transport: runtime.decideTransport(run, providerId, model), sessionId: null, sessionToken: null, sessionCursor: 0, turnTimings: [], activeTurn: null, stream: null,
    mailMark: newMailMark(), usage: null,
    // A helper works where its parent does (inside an isolated copy, when the parent has one); `extra` may give it its own.
    ...(parent?.workspace ? { workspace: parent.workspace } : {}), ...extra,
    // A helper started as a trained agent (spawn_agent {profile}): its playbook block leads its task in every prompt.
    ...(parent && spec.trained ? { profile: { id: spec.trained.id, name: spec.trained.name, role: spec.trained.role }, profilePrompt: spec.trained.prompt, profileReminder: spec.trained.reminder } : {}),
    ...(parent && isPinned(spec, parent.providerId) ? { failover: 'none' as const } : {}),
    ...(parent && avoided(spec).length ? { avoidProviders: avoided(spec) } : {}),
    ...(parent && connectorNames(spec).length ? { connectors: connectorNames(spec) } : {}),
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
  runtime.recordCommunication(run, parent || USER, agent, agent.task, { kind: 'spawn', reason: agent.reason })
  return agent
}
// The connector names a spawn passes to the helper (spawn_agent connectors, checked by vetSpawn), without repeats, in the order given.
const connectorNames = (spec: ToolArgs): string[] => Array.isArray(spec.connectors) ? [...new Set(spec.connectors.map(name => String(name).trim()).filter(Boolean))] : []
function scheduleAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<AgentResult> {
  // Register the task immediately, but start inference after the whole tool batch
  // has registered its participants and initial messages.
  const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => runtime.executeAgent(run, agent))
    .catch((error): AgentResult => ({ agentId: agent.id, generation: agent.generation, status: agent.status, error: error.message }))
  run.tasks.set(agent.id, task)
  return task
}
const ISOLATIONS = ['', 'worktree', 'orbit']
// spawn_agent. With a kind and no model Orbit first picks the model for that work (handover.mts routeSpawn); that waits
// for the provider list and the quotas, so a call refused for an ended run or parent or a missing task or reason, or one
// that reuses a helper by its name, skips it (registerSubAgent checks everything again afterwards). With isolation the
// helper's copy is made last, once nothing refuses the call any more, and thrown away again if the registration that
// follows still does.
async function spawnSubAgent(runtime: OrbitRuntimeLike, runId: string, parentId: string, spec: ToolArgs = {}): Promise<SpawnResult> {
  const run = runtime.runs.get(runId)
  const parent = run?.agentNodes.get(parentId)
  // spawn_agent {profile}: the helper runs as a trained agent. Its name, kind and level default to the agent's, and everything below
  // (routing, effort, vetting) sees the completed spec. `trained` is the runtime's own field: a caller's is dropped.
  let profiled: { entry: Parameters<typeof profileResult>[0] } | null = null
  if (spec.trained !== undefined) { const { trained: _caller, ...clean } = spec; spec = clean }
  if (run && parent && spec.profile !== undefined && spec.profile !== null && spec.profile !== '') {
    const applied = applyProfile(runtime, run, spec)
    if ('ok' in applied) return applied
    spec = applied.spec; profiled = { entry: applied.entry }
  }
  const isolation = spec.isolation === undefined || spec.isolation === null ? '' : String(spec.isolation)
  if (!ISOLATIONS.includes(isolation)) return { ok: false, reason: 'invalid_isolation', instruction: "isolation is one of '' (the helper shares your workspace), 'worktree' (its own git copy of your workspace) or 'orbit' (its own git copy of Orbit's repository)" }
  // A session call runs inside its caller's turn. A pause that cut the turn meanwhile lost this call's result for the
  // model, so no helper is made behind its back: the resumed model decides again.
  const turn = parent?.activeTurn
  let routedSpec = spec, routed: RoutedSpawn | null = null, listed = false
  const refused = run && parent ? unknownSubscription(run, parent, spec) : null; if (refused) return refused // before the routing waits for anything
  if (run && parent && ROUTING_KINDS.includes(String(spec.kind)) && !spec.model && !TERMINAL.has(run.status) && !['done', 'error', 'cancelled'].includes(parent.status)
    && String(spec.task || '').trim() && String(spec.reason || '').trim() && !(spec.name && [...run.agentNodes.values()].some(agent => agent.name === bounded(spec.name, 80)))) {
    ({ spec: routedSpec, routed } = await runtime.routeSpawn(run, parent, spec)); listed = true
    // Only a subscription the caller named pins a review: one the routing table chose may still move as usual.
    if (!spec.providerId && routedSpec.providerId && (routedSpec.failover === undefined || routedSpec.failover === null)) routedSpec = { ...routedSpec, failover: 'auto' }
    // A helper pinned to a subscription that has no usable model now is not started on it to fail or move: the caller decides.
    if (spec.providerId && !routed.model && routed.skipped?.length && isPinned(spec, parent.providerId)) return { ok: false, reason: 'provider_unavailable', routed, instruction: `Every ${spec.kind} model of ${spec.providerId} is unusable now (${routed.skipped.join('; ')}), and this helper must not change subscription (failover 'none', the default for a review on another subscription than yours), so it was not started. Wait for the reset, name another providerId, or pass failover 'auto' to let Orbit move it.` }
    if (turn && parent.activeTurn !== turn) return { ok: false, reason: 'turn_interrupted', instruction: 'Your turn was cut off (a pause) while the helper\'s model was being chosen, so no helper was created; spawn it again if it is still needed.' }
  }
  // A level the caller names is moved to what the model offers, which the provider list says (routing has waited for it already).
  if (run && !listed && spec.reasoningEffort) {
    await runtime.settleCatalog(run)
    if (turn && parent && parent.activeTurn !== turn) return { ok: false, reason: 'turn_interrupted', instruction: 'Your turn was cut off (a pause) while the provider list was being read, so no helper was created; spawn it again if it is still needed.' }
  }
  let prepared: Extract<IsolationPrepared, { ok: true }> | undefined, copyRun: RunRecord | undefined
  if (isolation) {
    const vetted = vetSpawn(runtime, runId, parentId, routedSpec)
    if (!('run' in vetted)) return vetted
    const made = await runtime.prepareIsolation(vetted.run, vetted.parent, isolation)
    if (!made.ok) return { ok: false, reason: made.reason, ...(made.instruction ? { instruction: made.instruction } : {}) }
    prepared = made; copyRun = vetted.run
    if (spec.merge === 'hold' && prepared.fields.isolation) prepared.fields.isolation.held = true
    if (turn && vetted.parent.activeTurn !== turn) {
      await runtime.discardIsolation(copyRun, made.id)
      return { ok: false, reason: 'turn_interrupted', instruction: 'Your turn was cut off (a pause) while the helper\'s isolated copy was being made, so no helper was created; spawn it again if it is still needed.' }
    }
  }
  const result = registerSubAgent(runtime, runId, parentId, routedSpec, routed, prepared)
  if (prepared && copyRun && (!result.ok || result.reused)) await runtime.discardIsolation(copyRun, prepared.id)
  // A helper that started as a trained agent counts as a use of it (once per run) and the result says how to rate it.
  const answer = profiled && result.ok && !result.reused ? { ...result, profile: profileResult(profiled.entry) } : result
  if (answer !== result) markAgentUse(runtime, run!, profiled!.entry.id)
  // `routed.reasoningEffort` is already in the result as the helper's level.
  if (!routed || !result.ok || result.reused) return answer
  const { reasoningEffort: _level, ...shown } = routed
  return { ...answer, routed: shown }
}
// "Model for review work: claude/opus (passed over codex/gpt-6-astra: quota 93% used)", for the delegation trace.
function routedLine({ kind, model, skipped }: RoutedSpawn): string {
  return `Model for ${kind} work: ${model || 'none of the routing table can take it now, so the usual one'}${skipped?.length ? ` (passed over ${skipped.join('; ')})` : ''}`
}
// What a spawn needs before any agent (or isolated copy) is made: the refusals, in the order they are told, and the reuse of
// a helper by its name. The call ends here with a result, or goes on with the live run and parent, the spec as completed
// (the name of the helper it continues, the model of the provider's pool entry) and the earlier agent it continues.
interface Vetted { run: RunRecord; parent: AgentRecord; spec: ToolArgs; prior: PublicAgent | null }
function vetSpawn(runtime: OrbitRuntimeLike, runId: string, parentId: string, spec: ToolArgs): SpawnResult | Vetted {
  const run = runtime.runs.get(runId)
  if (!run || TERMINAL.has(run.status)) return { ok: false, reason: 'run_not_active' }
  const parent = run.agentNodes.get(parentId)
  if (!parent || ['done', 'error', 'cancelled'].includes(parent.status)) return { ok: false, reason: 'parent_not_active' }
  if (!String(spec.task || '').trim() || !String(spec.reason || '').trim()) return { ok: false, reason: 'task_and_delegation_reason_required' }
  if (spec.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled'].includes(spec.reasoningEffort)) return { ok: false, reason: 'invalid_reasoning_effort' }
  if (spec.failover && !['auto', 'none'].includes(String(spec.failover))) return { ok: false, reason: 'invalid_failover', instruction: "failover is 'none' (the helper never changes subscription: when its own is out of quota or fails, it stops with an error you see in wait_agent) or 'auto' (Orbit may move it to another subscription; wait_agent then shows failedOver)" }
  if (spec.avoidProviders !== undefined && spec.avoidProviders !== null && (!Array.isArray(spec.avoidProviders) || spec.avoidProviders.some(id => typeof id !== 'string'))) return { ok: false, reason: 'invalid_avoid_providers', instruction: 'avoidProviders is a list of provider ids (for example ["claude"]) the helper must never run on or be moved to' }
  if (spec.providerId && avoided(spec).some(reference => matchesProvider(reference, spec.providerId!))) return { ok: false, reason: 'invalid_avoid_providers', instruction: `providerId ${spec.providerId} is also in avoidProviders` }
  if (spec.kind && !ROUTING_KINDS.includes(String(spec.kind))) return { ok: false, reason: 'unknown_kind', instruction: `kind is one of: ${ROUTING_KINDS.join(', ')}` }
  if (spec.merge && !['auto', 'hold'].includes(String(spec.merge))) return { ok: false, reason: 'invalid_merge', instruction: "merge is 'auto' (Orbit merges the helper's changes when it finishes) or 'hold' (it does not: you decide with merge_agent)" }
  if (spec.merge === 'hold' && !spec.isolation) return { ok: false, reason: 'invalid_merge', instruction: "merge 'hold' needs isolation ('worktree' or 'orbit'): without a copy of its own there is nothing to hold" }
  if (spec.connectors !== undefined && spec.connectors !== null && (!Array.isArray(spec.connectors) || spec.connectors.some(name => typeof name !== 'string'))) return { ok: false, reason: 'invalid_connectors', instruction: 'connectors is a list of connector names (for example ["playwright"]) that the helper gets; leave it out for none' }
  let prior: PublicAgent | null = null
  if (spec.continueFrom) {
    // priorRuns are chatMemory.view() results over live AgentRecords and saved snapshots, so a found agent is a
    // PublicAgent; chat-memory's AgentLike declares only the fields chat-memory itself reads (no `generation`).
    prior = chatMemory.findAgent(run.priorRuns, spec.continueFrom) as PublicAgent | null
    if (!prior) return { ok: false, reason: 'continue_from_not_found', instruction: 'No agent with that name ran in earlier turns of this chat; team_history lists them.' }
    if (!spec.name) spec = { ...spec, name: prior.name }
  }
  // Helpers get no connector unless the spawn names it, and never one their parent lacks. A helper that continues an earlier
  // one keeps the earlier names the parent can still pass on, unless the call names its own (also an empty list).
  const passable = agentConnectors(runtime, run, parent).map(item => item.name)
  const asked = connectorNames(spec)
  if (asked.length) {
    if (!passable.length) return { ok: false, reason: 'connectors_unavailable', instruction: run.accessMode !== 'danger-full-access' ? `This run has ${run.accessMode} access: connectors reach only runs with full access, so none can be passed to a helper.` : parent.parentId ? 'You have no connector to pass on: a helper gets only the connectors its own parent passed to it. Leave connectors out.' : 'No connector is enabled (connector_list shows them; connector_add registers one). Leave connectors out.' }
    const unknown = asked.filter(name => !passable.includes(name))
    if (unknown.length) return { ok: false, reason: 'unknown_connector', instruction: `${unknown.map(name => `"${bounded(name, 60)}"`).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a connector you can pass on. Available: ${passable.join(', ')}.` }
  }
  if (spec.connectors === undefined || spec.connectors === null) {
    const inherited = (prior?.connectors ?? []).filter(name => passable.includes(name))
    if (inherited.length) spec = { ...spec, connectors: inherited }
  } else spec = { ...spec, connectors: asked }
  if (spec.providerId && !poolAllows(run.providerPool, spec.providerId, spec.model, run.providerId)) return { ok: false, reason: 'provider_model_not_in_configured_pool' }
  if (spec.providerId && spec.providerId !== parent.providerId && !spec.model) spec = { ...spec, model: poolMembers(run.providerPool, spec.providerId)[0]?.model || '' }
  // A helper that runs as a trained agent with no name of its own takes a free one (never a reuse), chosen here, in the synchronous registration.
  if (!spec.name && spec.trained?.autoName) spec = { ...spec, name: freeName(run, spec.trained.name) }
  const existing = spec.name && [...run.agentNodes.values()].find(agent => agent.name === bounded(spec.name, 80))
  if (existing) return { ok: true, reused: true, agentId: existing.id, status: existing.status, instruction: 'Participant already exists. Use send_message to continue its conversation, or choose a distinct name for different work.' }
  if (parent.depth >= ceiling(run.limits, 'maxDepth')) return { ok: false, reason: 'depth_limit' }
  if (run.agentNodes.size >= ceiling(run.limits, 'maxAgents')) return { ok: false, reason: 'agent_limit' }
  if (run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) return { ok: false, reason: 'worker_turn_budget_exhausted', instruction: 'Integrate the existing findings. The root agent has no turn limit.' }
  return { run, parent, spec, prior }
}
// `prepared`: the isolated copy made for this helper (runtime/isolation.mts), whose fields its record starts with.
function registerSubAgent(runtime: OrbitRuntimeLike, runId: string, parentId: string, spec: ToolArgs, routed: RoutedSpawn | null = null, prepared?: Extract<IsolationPrepared, { ok: true }>): SpawnResult {
  const vetted = vetSpawn(runtime, runId, parentId, spec)
  if (!('run' in vetted)) return vetted
  const { run, parent, prior } = vetted
  const agent = runtime.createAgent(run, parent, vetted.spec, prepared?.fields, routed?.reasoningEffort)
  if (prior) agent.previousWork.push({ generation: prior.generation ?? 0, task: prior.task, result: prior.result, error: prior.error, files: prior.files })
  runtime.trace(run, parent.id, 'delegation', `${agent.name}: ${agent.task}\nReason: ${agent.reason}${routed ? `\n${routedLine(routed)}` : ''}${agent.isolation ? `\nIsolated copy: ${agent.isolation.path}; its changes merge into ${agent.isolation.target} when it finishes` : ''}`)
  runtime.scheduleAgent(run, agent)
  // Compact on purpose: the caller wrote the task itself, and the result and traces come through wait_agent.
  return { ok: true, agentId: agent.id, name: agent.name, status: agent.status, providerId: agent.providerId, model: agent.model, reasoningEffort: agent.reasoningEffort, effortSource: agent.effortSource ?? '', effort: `${agent.reasoningEffort || 'provider default'} (${agent.effortNote})`, ...(agent.failover ? { failover: agent.failover } : {}), ...(agent.avoidProviders ? { avoidProviders: agent.avoidProviders } : {}), ...(agent.isolation ? { isolation: { ...agent.isolation } } : {}) }
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
  const deciding = run.deciding?.get(target.id)
  if (deciding) throw new Error(`A ${deciding} decision for ${target.name} is in progress (merge_agent) and it would work in the copy that decision uses; try again when it finishes`)
  if (target.isolation?.decided === 'discard') throw new Error(`${target.name} was discarded with merge_agent and its isolated copy is gone, so it cannot continue; spawn a new helper`)
  if (run.agentOperations.get(target.id)?.size) throw new Error('Previous agent operations are still cleaning up; wait before followup_agent')
  if (!String(args.task || '').trim()) throw new Error('A concrete follow-up task is required')
  if (target.turns >= ceiling(run.limits, 'maxTurns') || run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) throw new Error('Agent or shared worker turn budget exhausted; follow-up cannot reset budgets')
  if (target.id === 'root') throw new Error('Continue the root agent through the project chat')
  const parent = target.parentId === null ? undefined : run.agentNodes.get(target.parentId)
  if (!parent || !['working', 'waiting', 'paused'].includes(parent.status) || runtime.agentSignal(run, parent).aborted) throw new Error('The original parent is no longer active')
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
const modelLabel = (target: Pick<ModelTarget, 'providerId' | 'model'>): string => target.model ? `${target.providerId}/${target.model}` : target.providerId
// The models that really did the agent's work, in order: the one it started on, each handover's target, the current one.
// A model whose segment ended in a `fresh` handover (no turn, no logged action) did nothing and is left out. `turns` is a
// human range when the handovers carry their turn number.
function modelsWorked(agent: Pick<AgentRecord, 'providerId' | 'model' | 'handovers'>): WorkedModel[] {
  const { handovers } = agent
  if (!handovers.length) return [{ label: modelLabel(agent), providerId: agent.providerId, model: agent.model }]
  const segments: { target: Pick<ModelTarget, 'providerId' | 'model'>; start?: number; end?: number | null; fresh: boolean }[] = []
  let start: number | undefined = 1
  let target: Pick<ModelTarget, 'providerId' | 'model'> = handovers[0]?.from || agent
  for (const handover of handovers) {
    segments.push({ target, start, end: handover.turn, fresh: handover.fresh })
    target = handover.to; start = handover.turn === undefined ? undefined : handover.turn + 1
  }
  segments.push({ target: handovers.length ? agent : target, start, end: null, fresh: false })
  const merged: typeof segments = []
  for (const segment of segments.filter(item => !item.fresh)) {
    const last = merged.at(-1)
    if (last && modelLabel(last.target) === modelLabel(segment.target)) { last.end = segment.end; if (last.start === undefined) last.start = segment.start } else merged.push({ ...segment })
  }
  return merged.map(({ target: { providerId, model }, start, end }): WorkedModel => {
    const known = start !== undefined && end !== undefined
    const turns = !known ? undefined : end === null ? `turns ${start}–` : end < start ? undefined : end === start ? `turn ${start}` : `turns ${start}–${end}`
    return { label: modelLabel({ providerId, model }), providerId, model, ...(turns ? { turns } : {}) }
  })
}
// "codex/gpt-6-astra → antigravity/gemini-3.1-pro-high after turn 3 (exhausted)", one clause per switch.
function handoverSummary(agent: Pick<AgentRecord, 'handovers'>): string {
  return clip(agent.handovers.map(({ from, to, turn, reason }) => `${modelLabel(from)} → ${modelLabel(to)}${turn === undefined ? '' : turn ? ` after turn ${turn}` : ' before any turn'} (${reason})`).join('; '), 400)
}
const WHY: Record<HandoverReason, string> = { approaching: 'quota nearly used up', exhausted: 'quota exhausted', 'replacement-failed': 'the replacement did not start', stalled: 'the model stopped responding', failed: 'provider error' }
// Every change of subscription, even one before the agent's first turn (which `ranOn` leaves out): a caller who chose a
// provider on purpose (a judge of another vendor) must never find the helper elsewhere without being told.
function failedOverFields(agent: Pick<AgentRecord, 'providerId' | 'model' | 'handovers'>, steps = false): { failedOver?: FailedOver } {
  const first = agent.handovers[0]
  if (!first) return {}
  return { failedOver: { from: modelLabel(first.from), to: modelLabel(agent), switches: agent.handovers.length, why: WHY[first.reason], ...(steps ? { steps: handoverSummary(agent) } : {}) } }
}
// What a caller needs to see when an agent moved between subscriptions: who worked, and where the switches were.
function ranOnFields(agent: Pick<AgentRecord, 'providerId' | 'model' | 'handovers'>): { ranOn?: string[]; switched?: string; failedOver?: FailedOver } {
  const worked = modelsWorked(agent)
  return { ...(worked.length > 1 ? { ranOn: worked.map(item => item.turns ? `${item.label} (${item.turns})` : item.label), switched: handoverSummary(agent) } : {}), ...failedOverFields(agent, true) }
}
// Compact directory: every participant fits one observation, results are excerpts.
function directoryRanOn(agent: AgentRecord): { ranOn?: string[] } { const worked = modelsWorked(agent); return worked.length > 1 ? { ranOn: worked.map(item => item.label) } : {} }
const tokensOf = (agent: AgentRecord): { tokens?: number } => { const tokens = agentTokens(agent); return tokens === undefined ? {} : { tokens } }
function agentDirectory(runtime: OrbitRuntimeLike, run: RunRecord): AgentDirectoryEntry[] {
  const agents = [...run.agentNodes.values()]
  const share = Math.max(300, Math.floor((run.limits.maxOutputChars - 1000) / Math.max(1, agents.length)) - 280)
  return agents.map(agent => ({
    paused: !!agent.paused,
    id: agent.id, name: agent.name, parentId: agent.parentId, status: agent.status, generation: agent.generation,
    providerId: agent.providerId, model: agent.model, ...directoryRanOn(agent), ...failedOverFields(agent), ...tokensOf(agent), task: clip(agent.task, 240),
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
// An isolated helper's changes are merged into their target BEFORE it counts as done, so that whoever waits for it (its
// parent's wait_agent, the next turn's helper results) gets the result after the merge. The merge report leads the
// result: a long answer is cut at its end, never at its start. Every other agent completes at once.
function completeAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, content: string, budgetLimited = false, detail = '', extra: Partial<AgentRecord> = {}): AgentResult | Promise<AgentResult> {
  if (!agent.isolation) return finishAgent(runtime, run, agent, content, budgetLimited, detail, extra)
  return runtime.mergeIsolated(run, agent).then(report => {
    // Stopped or cancelled meanwhile (the user stopped the helper, its parent failed, the run ended): the merge still
    // happened, so the cancelled helper's result says what it did (it is traced as well), and the agent ends cancelled the
    // way executeAgent ends one, never done.
    if (runtime.agentSignal(run, agent).aborted || agent.status === 'cancelled') {
      if (report) agent.result = bounded(`The helper was stopped while its changes were being merged; the merge had this outcome:\n${report}${agent.result ? `\n\n${agent.result}` : ''}`, answerLimit(run, agent))
      throw abortError()
    }
    return finishAgent(runtime, run, agent, report ? `${report}\n\n${content}` : content, budgetLimited, detail, extra)
  })
}
function finishAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, content: string, budgetLimited: boolean, detail: string, extra: Partial<AgentRecord>): AgentResult {
  agent.result = bounded(content, answerLimit(run, agent))
  // What `result` lost is kept for paging (team_history, context_read); a shorter report than before leaves no stale one.
  if (content.length > answerLimit(run, agent)) agent.report = bounded(content, REPORT_CHARS)
  else delete agent.report
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
function budgetHandoff(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): AgentResult | Promise<AgentResult> {
  const evidence = agent.transcript.filter(entry => ['tool_result', 'child_result', 'assistant_final'].includes(entry.type)).slice(-5)
  // Mail riding on a result carries the helper's secret mark (util.mailTag), which only its own prompts may show.
  const content = `Достигнут лимит работы помощника ${agent.name}. Задача может быть не завершена.\n${agent.result ? `Последний результат:\n${agent.result}\n` : ''}${evidence.length ? `Сохранённые результаты и наблюдения:\n${bounded(evidence, run.limits.maxOutputChars - 1000).replaceAll(agent.mailMark, 'mark')}` : 'Подтверждённых результатов пока нет.'}`
  runtime.trace(run, agent.id, 'budget', 'Worker turn limit reached; handing available evidence to the team')
  return runtime.completeAgent(run, agent, content, true)
}
// Ends an agent that keeps repeating identical calls, reporting what really happened instead of looping.
function stallHandoff(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, turns: number): AgentResult | Promise<AgentResult> {
  const actions = agent.ledger.slice(-12).map(entry => entry.text).join('\n')
  const results = agent.transcript.filter((entry): entry is ChildResultEntry => entry.type === 'child_result' && !!entry.result).slice(-6)
    .map(entry => `- ${run.agentNodes.get(entry.agentId)?.name || entry.agentId}: ${clip(entry.result, 300)}`).join('\n')
  const content = `Остановлено автоматически: ${agent.name} повторял одни и те же вызовы с одинаковым результатом и не продвигался (ходов подряд: ${turns}). Это защита от бесконечной проверки.\nПоследние действия:\n${actions || 'нет'}${results ? `\nРезультаты помощников:\n${results}` : ''}\nЧтобы продолжить, напишите, что довести до конца; журнал действий выше сохранён.`
  runtime.trace(run, agent.id, 'budget', `Loop guard: ${turns} consecutive turns of identical repeated calls; stopping ${agent.name}`)
  runtime.cancelDescendants(run, agent, 'Parent stopped by the loop guard')
  return runtime.completeAgent(run, agent, content, true, 'Stopped: repeated identical calls', { stalled: true })
}

export { failedOverFields, createAgent, scheduleAgent, spawnSubAgent, resolveAgent, resultKey, followupAgent, acquireTurn, releaseTurn, agentSignal, teamDigest, agentDirectory, modelsWorked, ranOnFields, cancelDescendants, completeAgent, budgetHandoff, stallHandoff }
