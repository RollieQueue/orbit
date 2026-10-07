// The messages between the main process (the shell) and the runtime child (electron/runtime-child.cjs, which hosts
// electron/runtime-host.mts). Plain structured-clone data only: never a function, an AbortSignal or a class instance,
// and an Error crosses as a WireError (a structured clone keeps an Error's message but drops fields such as `code`).
// The same shapes carry the in-process mode, where main calls the service directly.
//
// This module imports nothing: the shell loads it in child mode without pulling in the runtime (fingerprint.cjs
// counts it among the shell files), so changing it means a full restart.

// ---- Vocabulary -------------------------------------------------------------------------------------------------------
// Sent in `ready`; main refuses a runtime that speaks another version (0: a runtime that predates the field).
// 2: the runtime asks main for the system proxy (`resolve-proxy` / `proxy-result`).
// 3: the processes the runtime started come with their start times (`processes`, which replaces the bare `pids`);
//    errors nothing caught after `ready` are reported (`uncaught`).
const PROTOCOL_VERSION = 3
type RestartLevel = 'full' | 'runtime' | 'renderer'
type ShutdownMode = 'quit' | 'restart'
type LogLevel = 'info' | 'warn' | 'error'
const RESTART_LEVELS: readonly RestartLevel[] = ['full', 'runtime', 'renderer']
const SHUTDOWN_MODES: readonly ShutdownMode[] = ['quit', 'restart']
const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']

// Call channels of electron/ipc-contract.cjs the runtime serves (electron/runtime-api.mts implements exactly these);
// main forwards them with `client.call(channel, args)`.
const RUNTIME_CHANNELS: readonly string[] = [
  'runtime:pause', 'runtime:resume', 'runtime:stop-agent',
  'runtime:start', 'runtime:stop', 'runtime:list', 'runtime:get', 'runtime:changes', 'runtime:image', 'runtime:message',
  'state:load', 'state:save', 'project-index:status',
  'memory:list', 'memory:save', 'memory:remove', 'memory:pin', 'memory:sharing', 'memory:forget-chat', 'memory:stats',
  'capabilities:list', 'capabilities:pin', 'capabilities:enable', 'capabilities:params', 'capabilities:read', 'capabilities:install', 'capabilities:remove', 'capabilities:restore',
  'connectors:list', 'connectors:enable', 'connectors:remove', 'connectors:test',
  'attachments:save', 'attachments:image', 'attachments:discard',
  'providers:health', 'quota:get', 'stats:project', 'artifact:apply',
]
// Call channels main answers itself: dialogs, `shell`, `app`, health and restarts.
const SHELL_CHANNELS: readonly string[] = [
  'workspace:pick', 'workspace:inspect', 'workspace:clone', 'shell:open', 'shell:open-path', 'app:ping', 'app:relaunch', 'app:fullscreen', 'runtime:restart', 'runtime:status',
  'accounts:prepare', 'accounts:login', 'accounts:remove',
]
// Push channels the runtime emits; main passes each on with `webContents.send(channel, payload)`.
const EVENT_CHANNELS: readonly string[] = ['runtime:event', 'quota:update', 'restart:notice']
// `code` of the errors the service itself raises (a handler's own errors keep theirs), and of main's client when Orbit
// quits or relaunches (a call, a restart or a start that the shutdown ended: not a failure of the runtime).
const ERROR_CODES = { unknownChannel: 'ORBIT_UNKNOWN_CHANNEL', stopping: 'ORBIT_RUNTIME_STOPPING', shuttingDown: 'ORBIT_SHUTTING_DOWN' } as const

// ---- Shapes -----------------------------------------------------------------------------------------------------------
interface WireError { message: string; stack?: string; code?: string }
// What main tells the runtime after the renderer checked healthy: which restart this was and the commit it runs.
interface RendererHealthyInfo { level: RestartLevel; commit: string | null }
// What the user is asked to approve (the runtime's ApprovalPrompt without its AbortSignal).
interface ApprovalRequestWire { tool: string; arguments: unknown; toolUseId?: string; runId: string; agentId: string; agentName: string; workspace: string }
// The same with the id main answers with (`approval-result`) and the runtime withdraws it by (`approval-cancel`).
interface ApprovalWire extends ApprovalRequestWire { id: string }
// A process the runtime started: its pid, and when the runtime began to start it (Date.now(), taken before the OS
// created the process, so the OS's creation time is a little later). After a crash main tells the process, or its
// orphans, from a later process that reuses the pid by these times.
interface SpawnedProcess { pid: number; startedAt: number }

type CallMessage = { t: 'call'; id: number; channel: string; args: unknown[] }
type ApprovalResultMessage = { t: 'approval-result'; id: string; approved: boolean }
type RendererHealthyMessage = { t: 'renderer-healthy'; info: RendererHealthyInfo }
type ShutdownMessage = { t: 'shutdown'; mode: ShutdownMode }
// The answer to `resolve-proxy`: Electron's route for the URL ("PROXY host:port; DIRECT"), or null when main could not
// tell (no session, an error, no answer in time).
type ProxyResultMessage = { t: 'proxy-result'; id: string; route: string | null }
// main → child
type ToChild = CallMessage | ApprovalResultMessage | RendererHealthyMessage | ShutdownMessage | ProxyResultMessage

// `ms`: from the child's process start to ready; `protocol`: its PROTOCOL_VERSION.
type ReadyMessage = { t: 'ready'; pid: number; ms: number; protocol: number }
type ResultMessage = { t: 'result'; id: number; ok: true; value: unknown } | { t: 'result'; id: number; ok: false; error: WireError }
type EventMessage = { t: 'event'; channel: string; payload: unknown }
type ApprovalMessage = { t: 'approval'; id: string; request: ApprovalRequestWire }
type ApprovalCancelMessage = { t: 'approval-cancel'; id: string }
type ShutdownDoneMessage = { t: 'shutdown-done'; marked: string[] }
type LogMessage = { t: 'log'; level: LogLevel; text: string }
type FatalMessage = { t: 'fatal'; error: WireError }
// An error nothing caught after `ready` (uncaughtException, unhandledRejection): the runtime keeps running and main
// shows it in the window. At most one per second; `count` errors are behind it (a burst sends its last one).
type UncaughtMessage = { t: 'uncaught'; error: WireError; count: number }
// The processes the runtime started that are still running (provider CLIs, commands, Git), sent whenever the set
// changes (coalesced) and once more before `shutdown-done`. Once the runtime is gone main stops what is left of them:
// on Windows its direct children die with it (libuv's kill-on-close job), their own children do not, and
// `taskkill /t` cannot reach those through a parent that is gone, so main finds them in the process table.
type ProcessesMessage = { t: 'processes'; processes: SpawnedProcess[] }
// The system proxy for a URL (provider-network.mts's systemProxy): Electron's session, which knows PAC files, exists in
// the main process only, so the runtime process asks main; main answers with `proxy-result` of the same id.
type ResolveProxyMessage = { t: 'resolve-proxy'; id: string; url: string }
// child → main
type FromChild = ReadyMessage | ResultMessage | EventMessage | ApprovalMessage | ApprovalCancelMessage | ShutdownDoneMessage | LogMessage | FatalMessage | UncaughtMessage | ProcessesMessage | ResolveProxyMessage

// ---- Errors -----------------------------------------------------------------------------------------------------------
// Whatever was thrown, as data: the message, the stack when there is one, and `code` when it is a string or a number.
function serializeError(error: unknown): WireError {
  const fields = error !== null && (typeof error === 'object' || typeof error === 'function') ? error as { message?: unknown; stack?: unknown; code?: unknown } : null
  let message: string
  try { message = fields && typeof fields.message === 'string' ? fields.message : String(error) } catch { message = 'Unknown error' }
  const wire: WireError = { message }
  if (typeof fields?.stack === 'string') wire.stack = fields.stack
  if (typeof fields?.code === 'string' || typeof fields?.code === 'number') wire.code = String(fields.code)
  return wire
}
// The receiving side's Error: the same message, the sender's stack and `code`.
function deserializeError(wire: WireError): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(wire.message)
  if (wire.stack) error.stack = wire.stack
  if (wire.code) error.code = wire.code
  return error
}
function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

// ---- Validation of what arrives ---------------------------------------------------------------------------------------
type Fields = Record<string, unknown>
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isId = (value: unknown): value is number => Number.isSafeInteger(value)
const isCount = (value: unknown): value is number => isId(value) && value >= 1
const member = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T)
const isSpawned = (value: unknown): value is SpawnedProcess => isFields(value) && isCount(value.pid) && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
function wireError(value: unknown): WireError | null {
  if (!isFields(value) || !isText(value.message)) return null
  return { message: value.message, ...(isText(value.stack) ? { stack: value.stack } : {}), ...(isText(value.code) ? { code: value.code } : {}) }
}
function approvalRequest(value: unknown): ApprovalRequestWire | null {
  if (!isFields(value) || !isText(value.tool) || !isText(value.runId) || !isText(value.agentId) || !isText(value.agentName) || !isText(value.workspace)) return null
  if (value.toolUseId !== undefined && !isText(value.toolUseId)) return null
  return { tool: value.tool, arguments: value.arguments, ...(isText(value.toolUseId) ? { toolUseId: value.toolUseId } : {}), runId: value.runId, agentId: value.agentId, agentName: value.agentName, workspace: value.workspace }
}

// A message from main, or null when it is not one (the child logs and ignores it).
function parseToChild(value: unknown): ToChild | null {
  if (!isFields(value)) return null
  switch (value.t) {
    case 'call': return isId(value.id) && isText(value.channel) && Array.isArray(value.args) ? { t: 'call', id: value.id, channel: value.channel, args: value.args } : null
    case 'approval-result': return isText(value.id) && typeof value.approved === 'boolean' ? { t: 'approval-result', id: value.id, approved: value.approved } : null
    case 'renderer-healthy': {
      const info = value.info
      return isFields(info) && member(RESTART_LEVELS, info.level) && (info.commit === null || isText(info.commit)) ? { t: 'renderer-healthy', info: { level: info.level, commit: info.commit } } : null
    }
    case 'shutdown': return member(SHUTDOWN_MODES, value.mode) ? { t: 'shutdown', mode: value.mode } : null
    case 'proxy-result': return isText(value.id) && (value.route === null || isText(value.route)) ? { t: 'proxy-result', id: value.id, route: value.route } : null
    default: return null
  }
}

// A message from the child, or null when it is not one (main logs and ignores it).
function parseFromChild(value: unknown): FromChild | null {
  if (!isFields(value)) return null
  switch (value.t) {
    case 'ready': return isId(value.pid) && typeof value.ms === 'number' ? { t: 'ready', pid: value.pid, ms: value.ms, protocol: isId(value.protocol) ? value.protocol : 0 } : null
    case 'result': {
      if (!isId(value.id)) return null
      if (value.ok === true) return { t: 'result', id: value.id, ok: true, value: value.value }
      const error = value.ok === false ? wireError(value.error) : null
      return error ? { t: 'result', id: value.id, ok: false, error } : null
    }
    case 'event': return isText(value.channel) ? { t: 'event', channel: value.channel, payload: value.payload } : null
    case 'approval': {
      const request = approvalRequest(value.request)
      return isText(value.id) && request ? { t: 'approval', id: value.id, request } : null
    }
    case 'approval-cancel': return isText(value.id) ? { t: 'approval-cancel', id: value.id } : null
    case 'shutdown-done': return Array.isArray(value.marked) && value.marked.every(isText) ? { t: 'shutdown-done', marked: value.marked } : null
    case 'log': return member(LOG_LEVELS, value.level) && isText(value.text) ? { t: 'log', level: value.level, text: value.text } : null
    case 'fatal': {
      const error = wireError(value.error)
      return error ? { t: 'fatal', error } : null
    }
    case 'uncaught': {
      const error = wireError(value.error)
      return error && isCount(value.count) ? { t: 'uncaught', error, count: value.count } : null
    }
    case 'processes': {
      const list: unknown = value.processes
      return Array.isArray(list) && list.every(isSpawned) ? { t: 'processes', processes: list.map(({ pid, startedAt }) => ({ pid, startedAt })) } : null
    }
    case 'resolve-proxy': return isText(value.id) && isText(value.url) ? { t: 'resolve-proxy', id: value.id, url: value.url } : null
    default: return null
  }
}

export type {
  RestartLevel, ShutdownMode, LogLevel, WireError, RendererHealthyInfo, ApprovalRequestWire, ApprovalWire, SpawnedProcess,
  CallMessage, ApprovalResultMessage, RendererHealthyMessage, ShutdownMessage, ProxyResultMessage, ToChild,
  ReadyMessage, ResultMessage, EventMessage, ApprovalMessage, ApprovalCancelMessage, ShutdownDoneMessage, LogMessage, FatalMessage,
  UncaughtMessage, ProcessesMessage, ResolveProxyMessage, FromChild,
}
export {
  PROTOCOL_VERSION, RESTART_LEVELS, SHUTDOWN_MODES, LOG_LEVELS, RUNTIME_CHANNELS, SHELL_CHANNELS, EVENT_CHANNELS, ERROR_CODES,
  serializeError, deserializeError, codedError, parseToChild, parseFromChild,
}
