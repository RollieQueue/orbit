// The runtime as a service: everything of Orbit that is not the shell (OrbitRuntime, every store, the quota monitor,
// the Orbit MCP server, the provider CLIs, the restart host), built as main.cjs built it in app.whenReady, answering
// the runtime's call channels (electron/runtime-api.mts) and pushing its events through `emit`. The runtime child
// process (electron/runtime-child.cjs) hosts one; in `inprocess` mode main creates one itself. Nothing here imports
// Electron, and everything that crosses `options` is plain data (runtime-protocol.mts).
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import type { ChildProcess } from 'node:child_process'
import { OrbitRuntime } from './runtime.mts'
import { OrbitMemoryStore } from './memory.mts'
import { ProjectContextStore } from './project-context.mts'
import { CapabilityStore } from './capabilities.mts'
import { ConnectorStore } from './connectors.mts'
import { ProjectIndex } from './project-index.mts'
import { RunStore, StateStore } from './run-store.mts'
import * as providers from './providers.mts'
import { QuotaMonitor, readers as quotaReaders } from './quota.mts'
import { createRuntimeApi } from './runtime-api.mts'
import { configureAttachments, sweepDiscarded } from './attachments.mts'
import { createRestartHost, markRestartingRuns, resumePending } from './resume.mts'
import { processWatch } from './process-reaper.mts'
import { codedError, ERROR_CODES } from './runtime-protocol.mts'
import type { ApprovalWire, LogLevel, RendererHealthyInfo, ShutdownMode, SpawnedProcess } from './runtime-protocol.mts'
import type { RuntimeHandler, RuntimeStores } from './runtime-api.mts'
import type { InspectOptions, ProviderHealth } from './providers.mts'
import type { QuotaReader } from './quota.mts'
import type { ApprovalPrompt, ProviderOptions, RunProvider } from './types.mts'

// What a smoke or a test substitutes before the runtime exists (scripts/smoke-fixtures.cjs through
// ORBIT_RUNTIME_FIXTURES in the child, or passed directly in `inprocess` mode).
interface RuntimeOverrides {
  runProvider?: RunProvider
  inspectProviders?: (options?: InspectOptions) => Promise<ProviderHealth[]>
  // Patches quota.mts's reader table in place (a plain object) before the monitor reads it.
  patchQuotaReaders?(readers: Record<string, QuotaReader>): void
}
interface RuntimeServiceOptions {
  userData: string
  repoRoot: string
  // 'runtime:event', 'quota:update' and 'restart:notice' with their payloads, for main to pass on to the window.
  emit(channel: string, payload: unknown): void
  // Main shows the approval dialog and answers; `cancelApproval(id)` closes it when the run stopped meanwhile.
  requestApproval(request: ApprovalWire): Promise<boolean>
  cancelApproval?(id: string): void
  log?(level: LogLevel, text: string): void
  // The processes the runtime started that still run, with their start times, whenever that set changes (coalesced).
  onProcesses?(processes: SpawnedProcess[]): void
  overrides?: RuntimeOverrides
}
interface RuntimeService {
  // The call channels `call` serves (RUNTIME_CHANNELS of runtime-protocol.mts).
  channels: string[]
  call(channel: string, args: unknown[]): Promise<unknown>
  // The processes this process started that still run (provider CLIs, commands, Git): what a crash could orphan.
  processes(): SpawnedProcess[]
  // Main saw the renderer healthy after a start or a restart; the first call continues a pending restart_orbit task.
  rendererHealthy(info: RendererHealthyInfo): Promise<void>
  // 'quit': stop every active run, stop the MCP server, flush the stores (main.cjs's flushBeforeQuit). 'restart' also
  // ends the run whose agent asked for the restart as 'restarting' first; `marked` lists such runs.
  shutdown(mode: ShutdownMode): Promise<{ marked: string[] }>
  runtime: OrbitRuntime
  stores: RuntimeStores
  quota: QuotaMonitor
}

// The run statuses that still hold agents or processes: what a shutdown stops (main.cjs's flushBeforeQuit list).
const ACTIVE = new Set<string>(['running', 'working', 'waiting', 'queued'])
// How long a shutdown waits for the MCP server to close and for the stopped runs' processes (CLI trees, commands)
// to be killed and settle. The runtime child exits right after, and on Windows only its direct children die with it.
const SETTLE_MS = 2000
// How long it waits for what the stopped CLIs left running to be stopped (process-reaper.mts): two table reads and the kills.
const CLEANUP_MS = 4000

// The provider-facing functions a smoke must replace (ORBIT_SMOKE=1): turns, CLI inspection and quota readers.
const SMOKE_FIXTURES = ['runProvider', 'inspectProviders', 'patchQuotaReaders'] as const
// The set of running child processes is reported at most this often.
const PIDS_EVERY_MS = 200

// Every child process this Node process starts (provider CLIs, the Codex App Server, quota readers, run_command, Git),
// seen through Node's `child_process` diagnostics channel: recorded once it has spawned, forgotten when it exits.
// `onChange` hears the whole set, coalesced, whenever it changed.
// The channel publishes before the spawn (the pid is not known yet; measured on Node 22 and on Electron 44's Node 24), so
// the time taken then precedes the OS's creation time of the process by a few ms: after a crash main tells the process,
// and its orphans, from a later one with the same pid by that time (orphansOf of runtime-client.cjs).
function watchChildProcesses(onChange?: (processes: SpawnedProcess[]) => void): { processes(): SpawnedProcess[]; stop(): void } {
  // pid → startedAt
  const live = new Map<number, number>()
  const list = (): SpawnedProcess[] => [...live].map(([pid, startedAt]) => ({ pid, startedAt }))
  let timer: ReturnType<typeof setTimeout> | null = null
  const report = (): void => { timer = null; try { onChange?.(list()) } catch { /* A closed receiver learns the set next time. */ } }
  const changed = (): void => { if (onChange && !timer) { timer = setTimeout(report, PIDS_EVERY_MS); timer.unref?.() } }
  const created = (message: unknown): void => {
    const startedAt = Date.now()
    const child = (message as { process?: ChildProcess } | null)?.process
    if (!child || typeof child.once !== 'function') return
    child.once('spawn', () => {
      const pid = child.pid
      if (!pid) return
      live.set(pid, startedAt); changed()
      // A later process that got the same pid meanwhile keeps its own entry.
      child.once('exit', () => { if (live.get(pid) === startedAt) live.delete(pid); changed() })
    })
  }
  subscribe('child_process', created)
  return { processes: list, stop: () => { unsubscribe('child_process', created); if (timer) clearTimeout(timer); timer = null } }
}

// The runtime's ApprovalPrompt as data main can read (runtime-protocol.mts's parseFromChild): a field a provider left
// null or gave another type (the Claude session's tool_use_id may be null) would make main refuse the question unasked.
const approvalText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
function approvalWire(id: string, prompt: ApprovalPrompt): ApprovalWire {
  const toolUseId: unknown = prompt.toolUseId
  return {
    id, tool: approvalText(prompt.tool), arguments: prompt.arguments, ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
    runId: approvalText(prompt.runId), agentId: approvalText(prompt.agentId), agentName: approvalText(prompt.agentName), workspace: approvalText(prompt.workspace),
  }
}

// Waits for `work` to settle, at most `ms`; never rejects.
async function settle(work: unknown, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bounded = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref?.() })
  try { await Promise.race([Promise.resolve(work).then(() => undefined, () => undefined), bounded]) } finally { clearTimeout(timer) }
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function createRuntimeService(options: RuntimeServiceOptions): RuntimeService {
  const { userData, repoRoot, emit, overrides = {} } = options
  // Claude may read the attachments folder outside the workspace (providers.mts asks attachments.mts for it). Folders of
  // deleted chats that a program still held open then go now.
  configureAttachments(userData)
  void sweepDiscarded(userData)
  const log = (level: LogLevel, text: string): void => {
    try { if (options.log) options.log(level, text); else console[level](`[orbit] ${text}`) } catch { /* Logging never breaks the runtime. */ }
  }
  // Events keep flowing while a shutdown stops the runs (the window shows them stop); a closed receiver is not an error.
  const forward = (channel: string, payload: unknown): void => {
    try { emit(channel, payload) } catch (error) { log('warn', `could not forward ${channel}: ${messageOf(error)}`) }
  }

  // A smoke never reaches a real provider CLI or subscription: without its fixtures the runtime does not start.
  if (process.env.ORBIT_SMOKE === '1') {
    const missing = SMOKE_FIXTURES.filter(name => typeof overrides[name] !== 'function')
    if (missing.length) throw new Error(`ORBIT_SMOKE=1: the runtime refuses to start without fixtures for ${missing.join(', ')} (ORBIT_RUNTIME_FIXTURES), so a smoke never runs a real provider CLI or reads a real subscription`)
  }
  // Hermetic subscriptions for the desktop smoke: the readers are patched before anything reads a quota.
  overrides.patchQuotaReaders?.(quotaReaders)
  // The providers module's own functions unless a fixture replaces them (main.cjs passed runProvider explicitly too).
  const runProvider = overrides.runProvider ?? providers.runProvider
  const inspectProviders = overrides.inspectProviders ?? providers.inspectProviders

  // Approvals: main shows the dialog; a run that stops meanwhile withdraws its question (the dialog closes, "no").
  const approvals = new Map<string, () => void>()
  const requestApproval = (prompt: ApprovalPrompt): boolean | Promise<boolean> => {
    const { signal } = prompt
    if (signal.aborted) return false
    const id = randomUUID()
    const wire = approvalWire(id, prompt)
    return new Promise<boolean>((resolve, reject) => {
      const done = (): boolean => {
        if (!approvals.has(id)) return false
        approvals.delete(id); signal.removeEventListener('abort', withdraw)
        return true
      }
      const withdraw = (): void => {
        if (!done()) return
        try { options.cancelApproval?.(id) } catch (error) { log('warn', `could not withdraw approval ${id}: ${messageOf(error)}`) }
        resolve(false)
      }
      approvals.set(id, withdraw)
      signal.addEventListener('abort', withdraw, { once: true })
      let answer: Promise<boolean>
      try { answer = Promise.resolve(options.requestApproval(wire)) } catch (error) { if (done()) reject(error); return }
      answer.then(approved => { if (done()) resolve(approved === true && !signal.aborted) }, error => { if (done()) reject(error) })
    })
  }

  // Isolated helpers' git copies live under <userData>/worktrees; those of runs a crash or a restart cut short are removed
  // now (unmerged changes are saved as patches first).
  const runtime = new OrbitRuntime({ runProvider, requestApproval, worktreeRoot: path.join(userData, 'worktrees') })
  void runtime.sweepIsolation().then(swept => { if (swept.removed || swept.patches.length) log('info', `isolated copies from earlier runs: ${swept.removed} removed${swept.patches.length ? `, unmerged changes saved as ${swept.patches.join(', ')}` : ''}`) })
  // Subscription quotas belong to the account, not to a run: one monitor serves the window and every running agent.
  const quota = new QuotaMonitor()
  runtime.setQuota(quota)
  runtime.setCatalog((providerOptions: Record<string, ProviderOptions>) => inspectProviders(providerOptions))
  const memoryStore = new OrbitMemoryStore(userData)
  const projectContextStore = new ProjectContextStore(userData)
  runtime.setContextStore(projectContextStore)
  const capabilityStore = new CapabilityStore(userData)
  const projectIndex = new ProjectIndex({ directory: path.join(userData, 'project-index') })
  runtime.setProjectIndex(projectIndex)
  const runStore = new RunStore(userData)
  const stateStore = new StateStore(userData)
  runtime.setMemoryStore(memoryStore)
  runtime.setCapabilityStore(capabilityStore)
  const connectorStore = new ConnectorStore(userData)
  runtime.setConnectorStore(connectorStore)
  runtime.setRunStore(runStore)
  const stores: RuntimeStores = { memoryStore, projectContextStore, capabilityStore, connectorStore, projectIndex, runStore, stateStore }
  // Housekeeping on start (expiry, duplicates, caps). Nothing is shared between projects here: which projects allow it is known only once they run.
  try { memoryStore.maintain({ crossProject: true, projects: [] }); capabilityStore.maintain({ crossProject: true, projects: [] }) } catch (error) { log('error', `Memory housekeeping failed: ${messageOf(error)}`) }

  const unsubscribe = [
    runtime.onEvent(event => forward('runtime:event', event)),
    quota.onUpdate(update => forward('quota:update', update)),
  ]
  // restart_orbit runs scripts/self-upgrade.cjs of this repository; each line it prints also reaches the agent's trace.
  runtime.setRestartHost(createRestartHost({ repoRoot, userData, onLine: line => log('info', `restart_orbit: ${line}`) }))
  const children = watchChildProcesses(options.onProcesses)
  const handlers: Map<string, RuntimeHandler> = createRuntimeApi({ runtime, quota, stores, userData, inspectProviders })

  let stopping: ShutdownMode | null = null
  async function call(channel: string, args: unknown[]): Promise<unknown> {
    const handler = handlers.get(channel)
    if (!handler) throw codedError(`No runtime handler for ${channel}`, ERROR_CODES.unknownChannel)
    // A run started after the stop loop would outlive the shutdown unmarked; main's client queues it for the next runtime.
    if (stopping && channel === 'runtime:start') throw codedError('The Orbit runtime is shutting down; send the message again when it is back', ERROR_CODES.stopping)
    return handler(...(Array.isArray(args) ? args : []))
  }

  // After the first healthy report of this runtime: a task an agent interrupted with restart_orbit goes on in its chat
  // (or the renderer hears why not). Later reports (renderer reloads) find nothing to continue.
  let resumed: Promise<void> | null = null
  function rendererHealthy(info: RendererHealthyInfo): Promise<void> {
    if (stopping) return Promise.resolve()
    resumed ??= resumePending({ runtime, userData, info, notify: notice => forward('restart:notice', notice) })
      .then(() => undefined, error => log('error', `Continuing the task after the restart failed: ${messageOf(error)}`))
    return resumed
  }

  let finished: Promise<{ marked: string[] }> | null = null
  function shutdown(mode: ShutdownMode): Promise<{ marked: string[] }> {
    finished ??= (async () => {
      stopping = mode
      let marked: string[] = []
      // The run whose agent asked for this restart (pending-resume.json names it) ends as 'restarting', to be continued.
      if (mode === 'restart') {
        try { marked = markRestartingRuns({ runtime, userData }) } catch (error) { log('error', `Marking the restarting run failed: ${messageOf(error)}`) }
      }
      // Every other active run stops as when Orbit quits; its CLI trees and commands are killed.
      for (const run of runtime.runs.values()) if (ACTIVE.has(run.status)) runtime.stop(run.runId)
      // The Orbit MCP server (session transport) listens on a loopback port and goes down with the runtime; meanwhile the
      // stopped runs' provider turns and commands finish unwinding, and what their CLIs left running is stopped
      // (process-reaper.mts): once the runtime is gone nobody else knows which process belonged to which CLI.
      const operations = [...runtime.runs.values()].flatMap(run => [...run.operations])
      await Promise.all([settle(runtime.shutdown(), SETTLE_MS), settle(Promise.allSettled(operations), SETTLE_MS), settle(processWatch.idle(), CLEANUP_MS)])
      for (const withdraw of [...approvals.values()]) withdraw()
      // A run file still waiting for its coalesced write (agents that reported their cancellation) is written now.
      for (const run of runtime.runs.values()) if (run.persistTimer) runtime.persist(run)
      const flushes: Array<[string, () => void]> = [['run history', () => runStore.flush()], ['project index', () => projectIndex.flush()], ['memory', () => memoryStore.flush()], ['skills', () => capabilityStore.flush()]]
      for (const [name, flush] of flushes) {
        try { flush() } catch (error) { log('error', `Saving ${name} failed: ${messageOf(error)}`) }
      }
      for (const off of unsubscribe) off()
      // processes() keeps following the processes already known until they exit; new ones are no longer this service's.
      children.stop()
      return { marked }
    })()
    return finished
  }

  return { channels: [...handlers.keys()], call, processes: children.processes, rendererHealthy, shutdown, runtime, stores, quota }
}

export { createRuntimeService, watchChildProcesses }
export type { RuntimeService, RuntimeServiceOptions, RuntimeOverrides }
