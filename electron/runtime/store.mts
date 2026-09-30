// A run as others see it: snapshots, coalesced persistence, events to listeners, traces, agent updates and chat
// messages. Nothing here decides what an agent does; it records and publishes what the other modules did.
import { randomUUID } from 'node:crypto'
import { ROUTER } from '../router.mts'
import type { AgentRecord, FileChange, Message, OrbitRuntimeLike, RunRecord, RunSnapshot, RuntimeEvent, RuntimeEventData, StoredRun, Trace } from '../types.mts'
import { TERMINAL, answerLimit, publicAgent, bounded } from './util.mts'

// The inspector keeps this many traces per run; the run file is written at most this often while a run is active.
const TRACE_LIMIT = 2000
const PERSIST_DELAY_MS = 1000

function getRun(runtime: OrbitRuntimeLike, id: string): RunSnapshot | StoredRun | null { const run = runtime.runs.get(id); return run ? runtime.snapshot(run) : (runtime.runStore?.get?.(id) || null) }
function getRuns(runtime: OrbitRuntimeLike): RunSnapshot[] { return [...runtime.runs.values()].map((run) => runtime.snapshot(run)) }
function snapshot(runtime: OrbitRuntimeLike, run: RunRecord): RunSnapshot {
  return structuredClone({
    runId: run.runId, projectId: run.projectId, chatId: run.chatId, prompt: run.prompt,
    workspace: run.workspace, status: run.status, providerId: run.providerId, model: run.model,
    accessMode: run.accessMode, approvalPolicy: run.approvalPolicy, reasoningEffort: run.reasoningEffort, memoryEnabled: run.memoryEnabled, improvementMode: run.improvementMode, improvements: run.improvements, improvementStatus: run.improvementStatus,
    startedAt: run.startedAt, finishedAt: run.finishedAt, limits: run.limits, usage: run.usage,
    agents: [...run.agentNodes.values()].map(publicAgent),
    traces: run.traces, messages: run.messages, communications: run.communications, summary: run.summary, error: run.error,
    files: run.fileActivity.snapshot(), changes: run.changes.snapshot(), router: { ...run.router.stats },
    // Restarts: what a continuation starts again from, the link to the run a continuation continues, and the restart mark.
    ...(run.startPayload ? { startPayload: run.startPayload } : {}),
    ...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}), ...(run.resumeChain !== undefined ? { resumeChain: run.resumeChain } : {}),
    ...(run.restart ? { restart: run.restart } : {}),
  })
}
// A run's file changes with their diff text: the live run first, then the saved one.
function getRunChanges(runtime: OrbitRuntimeLike, runId: string): FileChange[] {
  const run = runtime.runs.get(runId)
  return run ? run.changes.snapshot() : (runtime.runStore?.get?.(runId)?.changes || [])
}
function persist(runtime: OrbitRuntimeLike, run: RunRecord): void {
  clearTimeout(run.persistTimer ?? undefined); run.persistTimer = null
  if (!runtime.runStore?.save) return
  try { const result = runtime.runStore.save(runtime.snapshot(run)); result?.catch?.((error) => runtime.persistenceError(run, error)) }
  catch (error) { runtime.persistenceError(run, error as Error) }
}
function persistenceError(runtime: OrbitRuntimeLike, run: RunRecord, error: Error): void {
  if (run.persistenceError) return
  run.persistenceError = true
  runtime.emit(run, 'run.info', { warning: `Run history could not be saved: ${error.message}` }, false)
}
// One write of the run file for a burst of events: the whole run is cloned for persistence only when the timer fires.
function schedulePersist(runtime: OrbitRuntimeLike, run: RunRecord, delay = PERSIST_DELAY_MS): void {
  if (run.persistTimer) return
  run.persistTimer = setTimeout(() => runtime.persist(run), delay)
  run.persistTimer.unref?.()
}
function emit(runtime: OrbitRuntimeLike, run: RunRecord, type: string, data: RuntimeEventData = {}, persist = true): void {
  // Listeners share one detached copy: they never see live runtime state, and the event is cloned once, not per listener.
  const event: RuntimeEvent = structuredClone({ ...data, type, runId: run.runId, projectId: run.projectId, chatId: run.chatId })
  for (const listener of runtime.listeners) { try { listener(event) } catch { /* A closed UI cannot stop the run. */ } }
  if (!persist) return
  // The terminal event is written at once. Everything else (agent updates, messages, correspondence) is coalesced:
  // after a run ends, agents still unwinding report their cancellation one by one, and each would otherwise rewrite
  // the whole run file (a multi-megabyte, synchronous clone and write).
  if (['run.finished', 'run.failed', 'run.cancelled'].includes(type)) runtime.persist(run)
  else runtime.schedulePersist(run, TERMINAL.has(run.status) ? 100 : PERSIST_DELAY_MS)
}
function trace(runtime: OrbitRuntimeLike, run: RunRecord, agentId: string, kind: string, text: string, id?: string): void {
  if (TERMINAL.has(run.status)) return
  const previous: Trace | undefined = id ? run.traces.find(trace => trace.id === id) : undefined
  const trace: Trace = { id: id || randomUUID(), agentId, agentName: agentId === ROUTER.id ? ROUTER.name : run.agentNodes.get(agentId)?.name || 'Orbit', kind, text: bounded(text, ['output', 'reasoning', 'assistant_update'].includes(kind) ? 32 * 1024 * 1024 : 6000), time: previous?.time || new Date().toISOString() }
  if (previous) Object.assign(previous, trace)
  else run.traces.push(trace)
  if (run.traces.length > TRACE_LIMIT) run.traces.splice(0, run.traces.length - TRACE_LIMIT)
  runtime.emit(run, 'trace.added', { trace }, false)
  runtime.schedulePersist(run)
}
// persist=false lets a batch of updates (cancelling a whole swarm) write the run file once, not once per agent.
function updateAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, patch: Partial<AgentRecord>, persist = true): void {
  Object.assign(agent, patch)
  runtime.emit(run, 'agent.updated', { agent: publicAgent(agent) }, persist)
}
function message(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, text: string, kind = 'answer'): void {
  if (!text || TERMINAL.has(run.status)) return
  // The root's answer was streamed under an id while it was written; the final message carries the same id.
  const streamed = agent.stream
  agent.stream = null
  if (streamed) runtime.flushStream(run, agent, streamed)
  const message: Message = { id: streamed?.messageId || randomUUID(), agentId: agent.id, generation: agent.generation, author: 'orbit', text: bounded(text, answerLimit(run, agent)), kind, model: agent.model, client: agent.providerId, lane: agent.name, time: new Date().toISOString() }
  run.messages.push(message)
  runtime.emit(run, 'message.added', { message })
}
function pruneRuns(runtime: OrbitRuntimeLike): void {
  const finished = [...runtime.runs.values()].filter((run) => TERMINAL.has(run.status) && !run.operations.size)
  for (const run of finished.slice(0, Math.max(0, runtime.runs.size - 100))) runtime.runs.delete(run.runId)
}

export { getRun, getRuns, snapshot, getRunChanges, persist, persistenceError, schedulePersist, emit, trace, updateAgent, message, pruneRuns }
