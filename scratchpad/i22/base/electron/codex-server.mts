import { spawn } from 'node:child_process'
import { isOrbitToolEnvelope } from './tool-schema.mts'
import { codexUpdateLimit } from './quota.mts'
import type { CodexRateLimitBucket, QuotaTaggedError } from './quota.mts'
// providers.mts imports this file as well; both sides use the other only inside functions, so the ESM cycle is harmless.
import { codexMcpArgs, loopbackNoProxy } from './providers.mts'
import type { ApprovalHandler, CliHelpers, NormalizedSession, ParserEvent, ProviderEventListener, ProviderResult, ProviderRunOptions } from './providers.mts'

// ---- App Server protocol (JSON-RPC over stdio) ------------------------------------------------------------------

interface JsonRpcError { code?: number; message?: string }
// One line of the server's stdout: a request to Orbit (method + id), a response (id, result | error) or a notification.
interface CodexServerMessage { id?: number | string; method?: string; params?: CodexServerParams; result?: unknown; error?: JsonRpcError }
// What Orbit writes: requests (id + method), the `initialized` notification, and answers to the server's requests.
interface CodexClientMessage { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: JsonRpcError }
interface CodexServerError { message?: string; codexErrorInfo?: unknown }
// An item of the thread as the server reports it in item/started and item/completed.
interface CodexServerItem { id?: string; type?: string; text?: string; phase?: string; command?: string; changes?: unknown; status?: string; server?: string; tool?: string; arguments?: unknown }
// The union of every notification's and request's params the client reads; each method uses its own subset.
interface CodexServerParams { threadId?: string; itemId?: string; delta?: string; summaryIndex?: number; rateLimits?: CodexRateLimitBucket; item?: CodexServerItem; turn?: { status?: string; error?: CodexServerError; usage?: unknown }; willRetry?: boolean; error?: CodexServerError; permissions?: unknown; [key: string]: unknown }
// Result of thread/start and thread/resume.
interface CodexThreadResult { thread: { id: string; model?: string }; model?: string }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void }
type TurnResult = { text: string; model: string; threadId: string | null }
interface TurnOptions { onEvent?: ProviderEventListener | null; onApproval?: ApprovalHandler | null; signal?: AbortSignal; timeoutMs?: number | null; inactivityMs?: number | null; isBusy?: (() => boolean) | null; reasoningEffort?: string }
// One Orbit turn on the thread while it runs.
interface TurnState { resolve(value: TurnResult): void; reject(error: Error): void; text: string; signal?: AbortSignal; deadline: NodeJS.Timeout | null; idle: NodeJS.Timeout | null; abort: () => void; armIdle: () => void }
interface CodexSessionApi { readonly threadId: string | null; readonly model: string; readonly closed: boolean; readonly busy: boolean; close(): Promise<void> | null; turn(prompt: string, turnOptions?: TurnOptions): Promise<TurnResult> }
type CodexServerOptions = Omit<ProviderRunOptions, 'providerId' | 'prompt'> & { prompt?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// A parsed line is taken as a JSON-RPC message once it is an object; the fields are checked where they are used.
const isServerMessage = (value: unknown): value is CodexServerMessage => isRecord(value)

// The server names a refused request by type; Orbit's failover relies on that rather than on the wording.
const LIMIT_REFUSALS = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'])
const refusal = (info: unknown, error: QuotaTaggedError): QuotaTaggedError => { if (typeof info === 'string' && LIMIT_REFUSALS.has(info)) error.quota = { providerId: 'codex' }; return error }
const APPROVAL_REQUESTS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']
// A session nobody has used for this long ends itself, so a forgotten agent cannot keep a Codex process forever.
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000
const DEFAULT_INACTIVITY_MS = 15 * 60 * 1000
const cancelledError = (): Error => { const error = new Error('Codex request cancelled'); error.name = 'AbortError'; return error }

// Codex exec cannot answer native approval requests; Ask uses the stdio App Server.
async function runCodexServer(options: CodexServerOptions, helpers: CliHelpers): Promise<ProviderResult> {
  const { resolveLaunch, terminateProcess, createLineReader } = helpers
  if (options.signal?.aborted) throw new Error('Codex request cancelled')
  const launch = resolveLaunch(options.providerOptions?.command || process.env.ORBIT_CODEX_COMMAND || 'codex', ['app-server', '-c', 'features.multi_agent=false'])
  const child = spawn(launch.executable, launch.args, { cwd: options.workspace, env: launch.env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  const requests = new Map<number | string, PendingRequest>(), items = new Map<string | undefined, CodexServerItem>()
  let sequence = 0, closed = false, stderr = '', bytes = 0, threadId: string | undefined, text = '', actualModel = options.model || ''
  let handedOff = false
  let resolveDone: (value: ProviderResult) => void, rejectDone: (error: Error) => void
  const done = new Promise<ProviderResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  // A process error can arrive while initialization is still pending.
  done.catch(() => {})
  const fail = (error: Error) => {
    if (closed) return
    closed = true
    for (const pending of requests.values()) pending.reject(error)
    requests.clear()
    rejectDone(error)
  }
  const send = (message: CodexClientMessage) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n') }
  const request = <T = unknown,>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {
    if (closed) return reject(new Error('Codex connection closed'))
    const id = ++sequence
    requests.set(id, { resolve, reject })
    send({ id, method, params })
  })
  const emit = (event: ParserEvent) => options.onEvent?.({ providerId: 'codex', ...event })
  const handle = async (message: CodexServerMessage) => {
    if (closed) return
    if (message.method && message.id !== undefined) {
      if (handedOff) { send({ id: message.id, error: { code: -32600, message: 'Control transferred to Orbit' } }); return }
      const params: CodexServerParams = message.params || {}
      if (threadId && params.threadId && params.threadId !== threadId) {
        send({ id: message.id, error: { code: -32602, message: 'Unknown thread' } }); return
      }
      if (APPROVAL_REQUESTS.includes(message.method)) {
        const approved = options.accessMode !== 'read-only' && !!(await options.onApproval?.({ tool: message.method, arguments: { ...params, item: items.get(params.itemId) } }))
        if (options.signal?.aborted || closed || handedOff) return
        const result = message.method === 'item/permissions/requestApproval'
          ? { permissions: approved ? params.permissions || {} : {}, scope: 'turn' }
          : { decision: approved ? 'accept' : 'decline' }
        send({ id: message.id, result })
      } else send({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } })
      return
    }
    if (!message.method && message.id !== undefined && requests.has(message.id)) {
      const pending = requests.get(message.id) as PendingRequest; requests.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    const params: CodexServerParams = message.params || {}
    // Rolling account figures belong to the subscription, not to this thread.
    if (message.method === 'account/rateLimits/updated' && params.rateLimits) emit({ kind: 'quota', quota: codexUpdateLimit(params.rateLimits) })
    if (handedOff) return
    if (threadId && params.threadId && params.threadId !== threadId) return
    if (message.method === 'item/agentMessage/delta') emit({ kind: 'output', text: params.delta || '', messageId: params.itemId, partial: true })
    if (message.method === 'item/reasoning/summaryTextDelta') emit({ kind: 'reasoning', text: params.delta || '', messageId: `${params.itemId}:${params.summaryIndex || 0}`, partial: true })
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item: CodexServerItem = params.item || {}
      items.set(item.id, item)
      if (item.type === 'agentMessage' && message.method === 'item/completed' && isOrbitToolEnvelope(item.text, options.responseSchema)) {
        handedOff = true
        text = item.text as string
        emit({ kind: 'observation', text: 'Codex handed control to Orbit tools', source: 'protocol' })
        resolveDone({ providerId: 'codex', client: 'Codex App Server', text, model: actualModel, access: options.accessMode })
        return
      }
      if (item.type === 'agentMessage' && message.method === 'item/completed' && item.phase !== 'commentary') text = item.text || text
      if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type as string)) emit({ kind: 'tool', native: true, tool: item.type, toolId: item.id, changes: item.changes, text: item.command || JSON.stringify(item.changes || item), status: message.method === 'item/started' ? 'started' : item.status || 'completed' })
    }
    if (message.method === 'turn/completed') {
      if (params.turn?.status !== 'completed') fail(refusal(params.turn?.error?.codexErrorInfo, new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status || 'incomplete'}`)))
      else if (!text.trim()) fail(new Error('Codex completed without a final response'))
      else resolveDone({ providerId: 'codex', client: 'Codex App Server', text, model: actualModel, access: options.accessMode })
    }
    if (message.method === 'error' && !params.willRetry) fail(refusal(params.error?.codexErrorInfo, new Error(params.error?.message || 'Codex server error')))
  }
  const reader = createLineReader(line => {
    if (!line.trim()) return
    try { const parsed: unknown = JSON.parse(line); if (isServerMessage(parsed)) Promise.resolve(handle(parsed)).catch(fail) } catch (error) { fail(error as Error) }
  })
  const abort = () => fail(new Error('Codex request cancelled'))
  const timer = options.timeoutMs === null ? null : setTimeout(() => fail(new Error('Codex App Server timed out')), options.timeoutMs || 1800000)
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 32 * 1024 * 1024) return fail(new Error('Codex output limit exceeded'))
    reader.write(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000) })
  child.on('close', () => { reader.end(); fail(new Error(stderr || 'Codex App Server closed before completion')) })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    await request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '0.2.0' } })
    send({ method: 'initialized', params: {} })
    const thread = await request<CodexThreadResult>('thread/start', { cwd: options.workspace, ...(options.model ? { model: options.model } : {}), approvalPolicy: 'on-request', sandbox: options.accessMode === 'read-only' ? 'read-only' : 'workspace-write', ephemeral: true })
    threadId = thread.thread.id
    actualModel = thread.model || actualModel
    await request('turn/start', { threadId, input: [{ type: 'text', text: options.prompt }], ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}), ...(options.responseSchema ? { outputSchema: options.responseSchema } : {}) })
    return await done
  } finally {
    closed = true
    clearTimeout(timer ?? undefined)
    options.signal?.removeEventListener('abort', abort)
    await terminateProcess(child)
    if (options.signal?.aborted) throw new Error('Codex request cancelled')
  }
}

// Session mode (Ask): one App Server process and one thread live for the whole agent; every Orbit turn is a
// `turn/start` on that thread. Orbit tools reach the process as an MCP server through config overrides on its
// command line, the bearer token through its environment. Nothing is killed at a tool call.
const sessions = new Map<string, CodexSessionApi>()

// The same overrides as `codex exec` gets (providers.codexMcpArgs), per-call tool timeout included.
function mcpOverrides(session: Pick<NormalizedSession, 'mcpUrl' | 'token'> | null | undefined): string[] {
  return codexMcpArgs(session)
}

async function openCodexSession(options: CodexServerOptions, session: NormalizedSession, helpers: CliHelpers): Promise<CodexSessionApi> {
  const { resolveLaunch, terminateProcess, createLineReader } = helpers
  if (options.signal?.aborted) throw cancelledError()
  const launch = resolveLaunch(options.providerOptions?.command || process.env.ORBIT_CODEX_COMMAND || 'codex', ['app-server', '-c', 'features.multi_agent=false', ...mcpOverrides(session)])
  const child = spawn(launch.executable, launch.args, { cwd: options.workspace, env: { ...launch.env, ...(session?.token ? { ORBIT_MCP_TOKEN: session.token, ...loopbackNoProxy() } : {}) }, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  const requests = new Map<number | string, PendingRequest>(), items = new Map<string | undefined, CodexServerItem>()
  let sequence = 0, closed = false, stderr = '', bytes = 0, threadId: string | null = null, actualModel = options.model || ''
  let turn: TurnState | null = null, idleTimer: NodeJS.Timeout | null = null, failure: Error | null = null
  let onEvent = options.onEvent, onApproval = options.onApproval
  const emit = (event: ParserEvent) => { try { onEvent?.({ providerId: 'codex', ...event }) } catch { /* UI observers do not control the provider. */ } }
  const send = (message: CodexClientMessage) => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n') }
  // A request after the connection closed fails with what closed it (the cancellation, the process's end).
  const request = <T = unknown,>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {
    if (closed) return reject(failure || new Error('Codex connection closed'))
    const id = ++sequence
    requests.set(id, { resolve, reject })
    send({ id, method, params })
  })
  const settleTurn = (error: Error | null, result?: TurnResult) => {
    const current = turn
    if (!current) return
    turn = null
    clearTimeout(current.deadline ?? undefined); clearTimeout(current.idle ?? undefined)
    current.signal?.removeEventListener('abort', current.abort)
    if (error) current.reject(error); else current.resolve(result as TurnResult)
    armSessionIdle()
  }
  // The process is gone or unusable: every pending request fails, the session is forgotten, and the running turn is
  // settled only once the process tree is really gone (cancellation means the tree is dead, as with runCli).
  let termination: Promise<void> | null = null
  const fail = (error: Error) => {
    if (closed) return termination
    closed = true
    failure = error
    clearTimeout(idleTimer ?? undefined)
    for (const pending of requests.values()) pending.reject(error)
    requests.clear()
    if (threadId) sessions.delete(threadId)
    termination = terminateProcess(child).catch(() => {}).then(() => settleTurn(error))
    return termination
  }
  const close = () => fail(new Error('Codex session closed'))
  const armSessionIdle = () => {
    clearTimeout(idleTimer ?? undefined)
    const limit = Number(process.env.ORBIT_SESSION_IDLE_MS) > 0 ? Number(process.env.ORBIT_SESSION_IDLE_MS) : DEFAULT_SESSION_IDLE_MS
    idleTimer = setTimeout(() => { if (!turn) close() }, limit)
    idleTimer.unref?.()
  }
  const touch = () => { if (turn?.armIdle) turn.armIdle() }
  const handle = async (message: CodexServerMessage) => {
    if (closed) return
    if (message.method && message.id !== undefined) {
      const params: CodexServerParams = message.params || {}
      if (threadId && params.threadId && params.threadId !== threadId) { send({ id: message.id, error: { code: -32602, message: 'Unknown thread' } }); return }
      if (APPROVAL_REQUESTS.includes(message.method)) {
        const ask = onApproval
        const approved = options.accessMode !== 'read-only' && !!(await ask?.({ tool: message.method, arguments: { ...params, item: items.get(params.itemId) } }))
        if (closed) return
        const result = message.method === 'item/permissions/requestApproval'
          ? { permissions: approved ? params.permissions || {} : {}, scope: 'turn' }
          : { decision: approved ? 'accept' : 'decline' }
        send({ id: message.id, result })
      } else send({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } })
      return
    }
    if (!message.method && message.id !== undefined && requests.has(message.id)) {
      const pending = requests.get(message.id) as PendingRequest; requests.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    const params: CodexServerParams = message.params || {}
    if (message.method === 'account/rateLimits/updated' && params.rateLimits) emit({ kind: 'quota', quota: codexUpdateLimit(params.rateLimits) })
    if (threadId && params.threadId && params.threadId !== threadId) return
    if (message.method === 'item/agentMessage/delta') emit({ kind: 'output', text: params.delta || '', messageId: params.itemId, partial: true })
    if (message.method === 'item/reasoning/summaryTextDelta') emit({ kind: 'reasoning', text: params.delta || '', messageId: `${params.itemId}:${params.summaryIndex || 0}`, partial: true })
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item: CodexServerItem = params.item || {}
      items.set(item.id, item)
      if (turn && item.type === 'agentMessage' && message.method === 'item/completed' && item.phase !== 'commentary') turn.text = item.text || turn.text
      if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type as string)) {
        const orbitTool = item.type === 'mcpToolCall' && item.server === 'orbit' && typeof item.tool === 'string' ? item.tool : undefined
        emit({ kind: 'tool', tool: item.type, toolId: item.id, changes: item.changes, text: item.command || (orbitTool ? `${orbitTool} ${JSON.stringify(item.arguments || {}).slice(0, 200)}` : JSON.stringify(item.changes || item)), status: message.method === 'item/started' ? 'started' : item.status || 'completed', ...(orbitTool ? { native: false, mcp: true, server: 'orbit', orbitTool } : { native: true }) })
      }
    }
    if (message.method === 'turn/completed' && turn) {
      if (params.turn?.status !== 'completed') settleTurn(refusal(params.turn?.error?.codexErrorInfo, new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status || 'incomplete'}`)))
      else if (!turn.text.trim()) settleTurn(new Error('Codex completed without a final response'))
      else { emit({ kind: 'observation', text: 'Codex turn completed', status: 'completed', usage: params.turn?.usage }); settleTurn(null, { text: turn.text, model: actualModel, threadId }) }
    }
    if (message.method === 'error' && !params.willRetry) settleTurn(refusal(params.error?.codexErrorInfo, new Error(params.error?.message || 'Codex server error')))
  }
  const reader = createLineReader(line => {
    if (!line.trim()) return
    touch()
    try { const parsed: unknown = JSON.parse(line); if (isServerMessage(parsed)) Promise.resolve(handle(parsed)).catch(fail) } catch (error) { fail(error as Error) }
  })
  child.on('error', fail)
  child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (!['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code ?? '')) fail(error) })
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 32 * 1024 * 1024) return fail(new Error('Codex output limit exceeded'))
    reader.write(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => { touch(); stderr = (stderr + chunk.toString()).slice(-16000) })
  child.on('close', () => { reader.end(); fail(new Error(stderr || 'Codex App Server closed before the turn completed')) })

  const api: CodexSessionApi = {
    get threadId() { return threadId },
    get model() { return actualModel },
    get closed() { return closed },
    get busy() { return !!turn },
    close,
    turn(prompt, turnOptions = {}) {
      return new Promise<TurnResult>((resolve, reject) => {
        if (closed) return reject(new Error('Codex session is closed'))
        if (turn) return reject(new Error('A Codex turn is already running in this session'))
        if (turnOptions.signal?.aborted) return reject(cancelledError())
        clearTimeout(idleTimer ?? undefined)
        if (turnOptions.onEvent) onEvent = turnOptions.onEvent
        if (turnOptions.onApproval) onApproval = turnOptions.onApproval
        // Cancellation kills the process tree, as everywhere else in Orbit.
        const current: TurnState = { resolve, reject, text: '', signal: turnOptions.signal, deadline: null, idle: null, abort: () => { fail(cancelledError()) }, armIdle: () => {} }
        const totalMs = Number(turnOptions.timeoutMs)
        if (Number.isFinite(totalMs) && totalMs > 0) current.deadline = setTimeout(() => { const error = new Error(`Codex App Server timed out after ${totalMs} ms`); error.name = 'TimeoutError'; fail(error) }, totalMs)
        const idleMs = turnOptions.inactivityMs === null || turnOptions.inactivityMs === 0 ? 0 : Number(turnOptions.inactivityMs ?? process.env.ORBIT_PROVIDER_INACTIVITY_MS ?? DEFAULT_INACTIVITY_MS)
        current.armIdle = () => {
          if (!idleMs || turn !== current) return
          clearTimeout(current.idle ?? undefined)
          current.idle = setTimeout(() => {
            let busy = false
            try { busy = !!turnOptions.isBusy?.() } catch { busy = false }
            if (busy) return current.armIdle()
            const error = Object.assign(new Error(`Codex App Server produced no output for ${idleMs} ms`), { code: 'ORBIT_PROVIDER_IDLE' }); error.name = 'TimeoutError'
            fail(error)
          }, idleMs)
        }
        turn = current
        turnOptions.signal?.addEventListener('abort', current.abort, { once: true })
        current.armIdle()
        request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...(turnOptions.reasoningEffort ? { effort: turnOptions.reasoningEffort } : {}) }).catch(error => settleTurn(error))
      })
    },
  }
  // Cancelled while the session opens (initialize, thread/resume or thread/start unanswered): the process is killed now,
  // not left to the idle timer or to a server that never answers, and the open fails once its tree is gone, as a turn does.
  const cancelOpen = () => { fail(cancelledError()) }
  options.signal?.addEventListener('abort', cancelOpen, { once: true })
  try {
    await request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '0.3.1' } })
    send({ method: 'initialized', params: {} })
    const sandbox = options.accessMode === 'read-only' ? 'read-only' : 'workspace-write'
    let thread: CodexThreadResult | null = null
    if (session?.resume && session.id) {
      // The earlier process is gone (a relaunch, an idle close); the recorded thread may still be resumable.
      try { thread = await request<CodexThreadResult>('thread/resume', { threadId: session.id, cwd: options.workspace, ...(options.model ? { model: options.model } : {}), approvalPolicy: 'on-request', sandbox }) } catch { thread = null }
    }
    if (!thread?.thread?.id) thread = await request<CodexThreadResult>('thread/start', { cwd: options.workspace, ...(options.model ? { model: options.model } : {}), approvalPolicy: 'on-request', sandbox, ephemeral: false })
    // The process can end, or the open be cancelled, between that answer and here: such a session is not kept, and the
    // open fails with what closed it (fail() has set `failure`).
    if (closed) throw failure
    threadId = thread.thread.id
    actualModel = thread.model || thread.thread?.model || actualModel
    sessions.set(threadId, api)
    armSessionIdle()
    return api
  } catch (error) {
    await fail(error as Error)
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancelOpen)
  }
}

// One Orbit turn on the agent's App Server session: reuse the live session for a resume, open one otherwise.
async function runCodexSessionTurn(options: CodexServerOptions & { prompt: string }, session: NormalizedSession, helpers: CliHelpers): Promise<ProviderResult> {
  if (options.signal?.aborted) throw cancelledError()
  let live = session.resume && session.id ? sessions.get(session.id) : null
  if (live?.closed) { sessions.delete(session.id as string); live = null }
  if (live?.busy) throw new Error('The Codex session is still running an earlier turn')
  const opened = !live
  if (!live) live = await openCodexSession(options, session, helpers)
  // The thread is known before the turn starts: a turn Orbit cuts off can still be resumed in it (runtime turn.mts).
  if (live.threadId) { try { options.onEvent?.({ providerId: 'codex', kind: 'session', sessionId: live.threadId }) } catch { /* UI observers do not control the provider. */ } }
  // Cancelled by now (the runtime stops a turn whose server opened another thread than the one to resume, on that event):
  // a session this call opened ends with it, since nothing reached its thread and nobody comes back to it.
  if (options.signal?.aborted) { if (opened) await live.close(); throw cancelledError() }
  const result = await live.turn(options.prompt, {
    onEvent: options.onEvent, onApproval: options.onApproval, signal: options.signal,
    timeoutMs: options.timeoutMs ?? null, inactivityMs: options.inactivityMs, isBusy: helpers.busyCheck?.(session), reasoningEffort: options.reasoningEffort,
  })
  return { providerId: 'codex', client: 'Codex App Server', transport: 'session', sessionId: live.threadId, text: result.text, model: result.model, access: options.accessMode }
}

async function closeSession(sessionId: string): Promise<boolean> {
  const live = sessions.get(sessionId)
  if (!live) return false
  await live.close()
  return true
}
async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map(live => live.close()))
}

export type { CodexServerMessage, CodexClientMessage, CodexServerParams, CodexServerItem, CodexThreadResult, CodexSessionApi, TurnOptions, TurnResult, CodexServerOptions }
export { runCodexServer, openCodexSession, runCodexSessionTurn, closeSession, closeAllSessions, sessions }
