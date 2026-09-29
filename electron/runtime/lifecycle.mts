// @ts-nocheck — typing of this module was interrupted mid-way (see docs/TYPESCRIPT-MAIN.md, "Remaining work"); annotations already present are kept.
// A run from start to end: payload validation and limits, the run record and its root agent, earlier turns of the
// chat, finishing, failing and stopping, and the knowledge housekeeping that follows a finished run.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { setMaxListeners } from 'node:events'
import { FileActivity } from '../file-activity.mts'
import { ChangeLog } from '../change-log.mts'
import { TeamRouter } from '../router.mts'
import * as chatMemory from '../chat-memory.mts'
import { workspaceKey } from '../storage.mts'
import { normalizeFailover } from '../failover.mts'
import type { AgentResult, ChatRunView, HistoryEntry, HistoryInput, LimitsInput, OrbitRuntimeLike, RunLimits, RunRecord, RunSnapshot, StartPayload } from '../types.mts'
import { TERMINAL, bounded, oneOf, withoutGoogleReasoning, overlappingWorkspaces, diagnostics } from './util.mts'
import { ToolProtocolError, parseResponse } from './envelope.mts'
import { TOOL_GUIDE } from './prompts.mts'

const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({ maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null, maxMessages: null, maxToolCalls: null, maxOutputChars: 12000, maxContextChars: 120000, timeoutMs: null, runTimeoutMs: null })
// Shared (cross-project) housekeeping looks at every project, so it runs at most this often.
const SHARE_EVERY_MS = 6 * 3600000
function normalizeLimits(input: LimitsInput = {}): RunLimits {
  const limits: RunLimits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(limits) as (keyof RunLimits)[]) {
    const raw = input[key] === undefined ? (key === 'maxConcurrent' ? input.maxConcurrency : key === 'timeoutMs' ? process.env.ORBIT_PROVIDER_TIMEOUT_MS : undefined) : input[key]
    if (raw === undefined) continue
    if (raw === null || raw === '') { if (!['maxOutputChars', 'maxContextChars'].includes(key)) limits[key] = null; continue }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) throw new Error(`Invalid limit: ${key}`)
    if (key.endsWith('Ms') && value > 2147483647) throw new Error(`${key} exceeds the platform timer range`)
    limits[key] = value
  }
  return limits
}
function conversationHistory(entries: HistoryInput[]): HistoryEntry[] {
  return entries.flatMap((entry): HistoryEntry[] => {
    const role = entry.role === 'assistant' || entry.author === 'orbit' ? 'assistant' : 'user'
    const content = entry.content ?? entry.text
    if (role === 'assistant' && /^\s*(?:```(?:json)?\s*)?\{/.test(String(content || ''))) {
      // Old versions accidentally published protocol turns as chat answers. Keep
      // the original history on disk, but never teach the model from those calls.
      try { if (parseResponse(content).calls.length) return [] }
      catch (error) { if (error instanceof ToolProtocolError) return []; throw error }
    }
    return [{ role, content: bounded(content, 8000) }]
  }).slice(-24)
}

async function start(runtime: OrbitRuntimeLike, payload: StartPayload = {}): Promise<string> {
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) throw new Error('A message is required')
  if (!payload.providerId) throw new Error('Select a configured provider before sending a message')
  if (!payload.workspace || !fs.statSync(payload.workspace).isDirectory()) throw new Error('Select an existing project folder')
  const accessMode = payload.accessMode || (payload.mode === 'build' ? 'workspace-write' : 'read-only')
  if (!oneOf(['read-only', 'workspace-write', 'danger-full-access'], accessMode)) throw new Error('Unknown workspace access mode')
  if (payload.approvalPolicy && !oneOf(['never', 'on-request', 'auto-review'], payload.approvalPolicy)) throw new Error('Unknown approval policy')
  // Google models ignore effort entirely, so a stale value saved for them must never block a start.
  const efforts = [
    payload.providerId === 'antigravity' ? '' : payload.reasoningEffort,
    ...Object.entries(payload.providerOptions || {}).map(([id, item]) => id === 'antigravity' ? '' : item?.reasoningEffort),
    ...(payload.providerPool || []).map(item => item?.providerId === 'antigravity' ? '' : item?.reasoningEffort),
  ]
  for (const effort of efforts) {
    if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled'].includes(effort)) throw new Error('Unknown reasoning effort')
  }
  const workspace = fs.realpathSync(payload.workspace)
  const existingRuns = [...runtime.runs.values()]
  if (payload.chatId && existingRuns.some(run => run.projectId === (payload.projectId || workspace) && run.chatId === payload.chatId && (!TERMINAL.has(run.status) || run.operations.size > 0))) throw new Error('В этом чате ещё выполняется задача или завершаются её процессы. Дождитесь остановки; другой диалог можно вести в новом чате.')
  if (accessMode !== 'read-only' && existingRuns.some(run => TERMINAL.has(run.status) && run.operations.size > 0 && run.accessMode !== 'read-only' && overlappingWorkspaces(run.workspace, workspace))) throw new Error('Завершается остановка процессов в этом проекте. Повторите запуск после завершения очистки (process cleanup).')
  const run: RunRecord = {
    runId: randomUUID(), projectId: payload.projectId || workspace, chatId: payload.chatId || randomUUID(),
    prompt, workspace, providerId: payload.providerId, model: payload.model || '',
    memoryEnabled: payload.memoryEnabled !== false, globalMemoryEnabled: payload.globalMemoryEnabled !== false, memoryContext: (payload.memoryContext || []).filter(entry => payload.globalMemoryEnabled !== false || entry.scope !== 'global'),
    improvementMode: payload.improvementMode === true, improvements: [], improvementStatus: 'planning',
    providerOptions: payload.providerOptions || {}, providerPool: payload.providerPool || [], sharedContext: {}, evaluations: new Set(),
    failover: normalizeFailover(payload.quotaFailover), models: payload.models && typeof payload.models === 'object' ? payload.models : {}, catalogCache: null, brokenProviders: new Map(),
    history: Array.isArray(payload.history) ? conversationHistory(payload.history) : [],
    agentInstructions: bounded(payload.agentInstructions || '', 10000), accessMode, reasoningEffort: withoutGoogleReasoning(payload.providerId, payload.reasoningEffort ?? payload.providerOptions?.[payload.providerId]?.reasoningEffort ?? ''),
    approvalPolicy: payload.approvalPolicy || 'never', status: 'working', startedAt: new Date().toISOString(),
    limits: normalizeLimits(payload.limits), contextExplicit: Number(payload.limits?.maxContextChars) > 0,
    usage: { providerTurns: 0, workerTurns: 0, inputTokens: null, outputTokens: null },
    agentNodes: new Map(), agentControllers: new Map(), agentOperations: new Map(), tasks: new Map(), traces: [], messages: [], communications: [], messageWaiters: new Map(), controller: new AbortController(),
    activeTurns: 0, turnQueue: [], operations: new Set(), providerBuffers: new Map(), finishedAt: null, summary: null, error: null,
    fileActivity: new FileActivity(workspace), changes: new ChangeLog(workspace), changeQueue: Promise.resolve(), changePending: 0, commands: { running: 0, serial: 0, writes: 0 }, priorRuns: [], priorDigest: null,
    memoryTouched: new Set(), skillUse: new Map(), skillLearning: payload.skillLearning !== false, skillReminded: false, skillSaved: false,
    // The router needs the record it serves, so it is made right below.
    router: null!,
  }
  run.router = new TeamRouter(run, {
    record: (sender, target, text, extra) => runtime.recordCommunication(run, sender, target, text, extra),
    announce: (communication, persist) => runtime.emit(run, 'communication.added', { communication }, persist),
    changed: router => runtime.emit(run, 'run.info', { router }, false),
  })
  run.priorRuns = runtime.previousRuns(run)
  runtime.setSharing(workspace, run.globalMemoryEnabled)
  // The scan runs while the root agent starts; the first prompt waits for it only briefly.
  run.indexReady = Promise.resolve().then(() => runtime.projectIndex?.refresh(workspace)).catch(error => { diagnostics(runtime, run, 'projectIndex.refresh', error); return null })
  // Context limits bound optional evidence, never remove the user's actual task.
  run.limits.maxContextChars = Math.max(run.limits.maxContextChars, run.prompt.length + run.agentInstructions.length + TOOL_GUIDE.length + 7000)
  setMaxListeners(0, run.controller.signal)
  runtime.runs.set(run.runId, run)
  const root = runtime.createAgent(run, null, { id: 'root', name: 'Orbit', task: run.prompt, reason: 'User message', providerId: run.providerId, model: run.model })
  runtime.emit(run, 'run.started', { prompt: run.prompt, workspace: run.workspace, providerId: run.providerId, model: run.model, accessMode, access: accessMode, approvalPolicy: run.approvalPolicy, memoryEnabled: run.memoryEnabled, limits: run.limits, status: run.status })
  if (run.limits.runTimeoutMs) {
    run.timer = setTimeout(() => runtime.failRun(run, new Error('Run time budget exhausted')), run.limits.runTimeoutMs)
    run.timer.unref?.()
  }
  setImmediate(() => {
    if (TERMINAL.has(run.status)) return
    const task = runtime.executeAgent(run, root)
    run.tasks.set(root.id, task)
    task.then((result) => run.changePending ? runtime.drainChanges(run).then(() => runtime.finishRun(run, result)) : runtime.finishRun(run, result), (error) => runtime.failRun(run, error))
  })
  runtime.pruneRuns()
  return run.runId
}
// Earlier turns of this chat, oldest first: the running ones in memory and the saved ones on disk.
function previousRuns(runtime: OrbitRuntimeLike, run: RunRecord): ChatRunView[] {
  const found = new Map<string, RunRecord | RunSnapshot>()
  const sameChat = (item: RunRecord | RunSnapshot) => item.projectId === run.projectId && item.chatId === run.chatId && item.runId !== run.runId && String(item.startedAt) <= String(run.startedAt)
  try {
    const stored = runtime.runStore?.forChat ? runtime.runStore.forChat(run.projectId, run.chatId, 12) : (runtime.runStore?.list?.() || [])
    for (const item of stored) if (sameChat(item)) found.set(item.runId, item)
  } catch (error) { diagnostics(runtime, run, 'previousRuns', error) /* Saved history is a convenience; a damaged file must not block a new task. */ }
  for (const live of runtime.runs.values()) if (sameChat(live)) found.set(live.runId, live)
  return [...found.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).slice(-8).map(chatMemory.view)
}
function finishRun(runtime: OrbitRuntimeLike, run: RunRecord, result: AgentResult): void {
  if (TERMINAL.has(run.status)) return
  clearTimeout(run.timer); run.status = 'completed'; run.finishedAt = new Date().toISOString()
  run.summary = { text: result.result, agentCount: run.agentNodes.size, providerTurns: run.usage.providerTurns, limitedAgents: [...run.agentNodes.values()].filter(agent => agent.budgetLimited).map(agent => agent.id) }
  runtime.emit(run, 'run.finished', { status: run.status, summary: run.summary })
  runtime.closeSessions(run)
  runtime.maintainKnowledge(run)
}
// Whether a project lets its knowledge be shared. The UI reports it when it changes, a run reports it when it starts; a project
// nothing has reported is treated as not sharing.
function setSharing(runtime: OrbitRuntimeLike, workspace: unknown, enabled: unknown): void { if (typeof workspace === 'string' && workspace.trim()) runtime.sharing.set(workspaceKey(workspace), enabled === true) }
// After a finished run the stores tidy themselves, without a model: stale notes expire, chat notes that proved durable move up
// to the project, duplicates merge, caps hold. What several projects know moves to the shared tier, but only from projects
// that allow sharing (as last reported), and at most every few hours because it looks across all of them.
function maintainKnowledge(runtime: OrbitRuntimeLike, run: RunRecord): void {
  if (!run.memoryEnabled) return
  try {
    const now = runtime.clock()
    const crossProject = now - runtime.lastShare >= SHARE_EVERY_MS
    const projects = [...runtime.sharing].filter(([, on]) => on).map(([workspace]) => workspace)
    runtime.memoryStore?.maintain?.({ workspace: run.workspace, chatId: run.chatId, crossProject, projects })
    runtime.capabilityStore?.maintain?.({ workspace: run.workspace, crossProject, projects })
    if (crossProject) runtime.lastShare = now
    runtime.memoryStore?.flush?.(); runtime.capabilityStore?.flush?.()
  } catch (error) { runtime.emit(run, 'run.info', { warning: `Memory housekeeping failed: ${(error as Error).message}` }, false) }
}
function failRun(runtime: OrbitRuntimeLike, run: RunRecord, error: Error): void {
  if (TERMINAL.has(run.status)) return
  clearTimeout(run.timer); run.status = 'failed'; run.error = error.message || String(error); run.finishedAt = new Date().toISOString()
  run.controller.abort(); runtime.cancelAgents(run, run.error)
  runtime.emit(run, 'run.failed', { status: run.status, error: run.error })
  runtime.closeSessions(run)
}
function cancelAgents(runtime: OrbitRuntimeLike, run: RunRecord, detail: string): void {
  for (const agent of run.agentNodes.values()) {
    if (!['done', 'error', 'cancelled'].includes(agent.status)) runtime.updateAgent(run, agent, { status: 'cancelled', detail, finishedAt: new Date().toISOString() }, false)
  }
}
function stop(runtime: OrbitRuntimeLike, runId: string): boolean {
  const run = runtime.runs.get(runId)
  if (!run || TERMINAL.has(run.status)) return false
  clearTimeout(run.timer); run.status = 'cancelled'; run.finishedAt = new Date().toISOString()
  run.controller.abort(); runtime.cancelAgents(run, 'Stopped by the user')
  runtime.emit(run, 'run.cancelled', { status: run.status })
  runtime.closeSessions(run)
  return true
}

export { DEFAULT_LIMITS, normalizeLimits, start, previousRuns, finishRun, setSharing, maintainKnowledge, failRun, cancelAgents, stop }
