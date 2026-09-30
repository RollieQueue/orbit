// @ts-check
'use strict'

/**
 * The main process's handle on Orbit's runtime (docs/TECH-DEBT.md item 2).
 *
 * The runtime (OrbitRuntime, every store, the quota monitor, the Orbit MCP server, the provider CLIs) runs in a child
 * process, electron/runtime-child.cjs; main keeps the window. This client starts that process, forwards the window's
 * calls to it and its events back, lets main show the approval dialogs, and restarts it without closing the window:
 * `restart()` is the runtime-level upgrade, and a crash of a runtime that had been ready restarts it on its own (at most
 * three times a minute, then the state is `stopped` until a restart by hand); a start that fails is not retried on its
 * own. Calls made while the process starts or restarts wait in a queue (30 s). What a runtime that is gone left running
 * (the orphans of its CLIs) is found in the process table and stopped.
 *
 * Mode `inprocess` (ORBIT_RUNTIME_MODE=inprocess) builds the same service inside main through electron/runtime-host.mts:
 * the fallback and a test path, with the same interface except restart() (a new runtime there is a new process).
 *
 * The messages are those of electron/runtime-protocol.mts, which imports nothing and is loaded here. Both files belong
 * to the shell (SHELL_FILES of electron/fingerprint.cjs): a change to either takes a full relaunch.
 */

const childProcess = require('node:child_process')
const path = require('node:path')
const { parseFromChild, deserializeError, codedError, PROTOCOL_VERSION, ERROR_CODES } = require('./runtime-protocol.mts')

/** @typedef {import('./runtime-protocol.mts').LogLevel} LogLevel */
/** @typedef {import('./runtime-protocol.mts').ShutdownMode} ShutdownMode */
/** @typedef {import('./runtime-protocol.mts').RendererHealthyInfo} RendererHealthyInfo */
/** @typedef {import('./runtime-protocol.mts').ApprovalRequestWire} ApprovalRequestWire */
/** @typedef {import('./runtime-protocol.mts').ApprovalWire} ApprovalWire */
/** @typedef {import('./runtime-protocol.mts').SpawnedProcess} SpawnedProcess */
/** @typedef {import('./runtime-protocol.mts').ToChild} ToChild */
/** @typedef {import('./runtime-host.mts').RuntimeServiceOptions} RuntimeServiceOptions */
/** @typedef {import('./runtime-host.mts').RuntimeOverrides} RuntimeOverrides */

/** The child's entry: it picks its transport (utilityProcess's parentPort or Node IPC) and builds the service. */
const CHILD_ENTRY = path.join(__dirname, 'runtime-child.cjs')
/** What Node 22 needs to load the .mts runtime; Electron's Node 24 strips types by default. */
const NODE_EXEC_ARGV = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
/** Lines of the child's stderr kept for the error of a crash. */
const STDERR_TAIL = 20
/** How long a shutdown, or the next runtime's start, waits for the orphans of a runtime that is gone to be stopped. */
const REAP_WAIT_MS = 5000
/**
 * Calls that only read, or save the same thing again: when a restart ends the runtime before it answered one of them,
 * the new runtime answers it (ahead of the calls made meanwhile), so the window sees no error. Any other call in flight
 * (runtime:start, memory:save, …) fails, as does every call a crash or a shutdown interrupts.
 */
const REPEATABLE = new Set([
  'runtime:list', 'runtime:get', 'runtime:changes', 'runtime:image', 'state:load', 'state:save', 'project-index:status',
  'memory:list', 'memory:stats', 'capabilities:list', 'capabilities:read', 'providers:health', 'quota:get',
])

/** @typedef {'child' | 'inprocess'} RuntimeMode */
/** @typedef {'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'} RuntimeState */
/**
 * The last error nothing caught in the running runtime process (it keeps running).
 * @typedef {object} RuntimeErrorInfo
 * @property {string} message
 * @property {number} at when main heard of it (ms)
 * @property {number} count uncaught errors of this runtime process so far
 */
/**
 * What the window sees of the runtime (`runtime:status`, pushed on `runtime:status-changed`; RuntimeStatus of src/types.ts).
 * @typedef {object} RuntimeStatus
 * @property {RuntimeState} state
 * @property {RuntimeMode} mode
 * @property {number | null} pid the runtime process (main's own pid in inprocess mode); null while none runs
 * @property {number} since when `state` began (ms)
 * @property {number | null} lastRestartMs how long the last restart took, from its request to the new runtime's ready
 * @property {number} restarts restarts so far, by hand and after crashes
 * @property {string} [error] why the runtime last failed; cleared when it is ready again
 * @property {boolean} retrying true only while an automatic restart is scheduled (state `crashed` after a runtime that
 *   had been ready crashed); false for everything else: a start that failed, another protocol version, a fork main
 *   refused, the crash budget used up
 * @property {RuntimeErrorInfo} [lastError] set while the current runtime process runs after an uncaught error (at most
 *   one update a second); a new process starts without it
 */
/**
 * One process of the system's process table, as the orphan check reads it.
 * @typedef {object} ProcessRow
 * @property {number} pid
 * @property {number} ppid the pid of the process that created it (Windows keeps it after that process has exited)
 * @property {number | null} created when the OS created it (ms since the epoch); null when unknown
 */
/**
 * The runtime process as the client drives it. adaptUtilityProcess (Electron) and adaptChildProcess (Node) make one
 * from a real process; tests pass fakes.
 * @typedef {object} ChildHandle
 * @property {() => number | null} pid the OS pid once the process runs
 * @property {(message: ToChild) => void} post throws when the message cannot be sent
 * @property {(listener: (message: unknown) => void) => void} onMessage
 * @property {(listener: (code: number | null) => void) => void} onExit called once, also when the process never started
 * @property {(listener: (stream: 'stdout' | 'stderr', text: string) => void) => void} onOutput raw chunks
 * @property {() => void} kill the process itself; killProcessTree reaches what it started
 */
/**
 * @callback ForkFunction
 * @param {string} entry
 * @param {{ env: Record<string, string> }} options
 * @returns {ChildHandle}
 */
/**
 * The part of runtime-host.mts's RuntimeService the inprocess mode uses.
 * @typedef {object} RuntimeServiceLike
 * @property {(channel: string, args: unknown[]) => Promise<unknown>} call
 * @property {(info: RendererHealthyInfo) => Promise<void>} rendererHealthy
 * @property {(mode: ShutdownMode) => Promise<{ marked: string[] }>} shutdown
 */
/**
 * @typedef {object} ClientSettings
 * @property {number} queueTimeoutMs a call made while the runtime is not ready waits this long at most
 * @property {number} startTimeoutMs a process that has not reported `ready` by then is killed: a failed start
 * @property {number} shutdownTimeoutMs the default of shutdown(); restart() gives the old process as long
 * @property {number} exitGraceMs after `shutdown-done` the process has this long to exit before it is killed
 * @property {number} maxAutoRestarts automatic restarts within autoRestartWindowMs; the next crash stops the runtime
 * @property {number} autoRestartWindowMs
 * @property {number} autoRestartDelayMs pause between a crash and the automatic restart
 * @property {number} proxyTimeoutMs how long a proxy lookup for the runtime may take before it is answered with null
 */
/**
 * @typedef {object} RuntimeClientOptions
 * @property {RuntimeMode} [mode] default 'child'
 * @property {string} userData
 * @property {string} repoRoot
 * @property {ForkFunction} [fork] default: nodeFork() (main passes utilityFork(utilityProcess))
 * @property {string} [entry] default: electron/runtime-child.cjs
 * @property {Record<string, string | undefined>} [env] merged over process.env for the child (and read for the fixtures)
 * @property {(channel: string, payload: unknown) => void} [onEvent]
 * @property {(request: ApprovalRequestWire, signal: AbortSignal) => Promise<boolean> | boolean} [onApproval] the signal aborts when the runtime withdraws the request or exits
 * @property {(status: RuntimeStatus) => void} [onStatus]
 * @property {(level: LogLevel, text: string) => void} [log]
 * @property {() => void} [beforeFork] called right before each runtime process is forked (main hashes the runtime code
 *   there); when it throws, no process is forked: the runtime is stopped with its message and not restarted on its own
 * @property {(url: string) => Promise<string | null> | string | null} [resolveProxy] the system proxy route for a URL, which the runtime process cannot resolve itself (main: session.defaultSession.resolveProxy)
 * @property {(pid: number) => Promise<void>} [killTree] default: killProcessTree
 * @property {() => Promise<ProcessRow[] | null>} [listProcesses] the process table the orphans of a runtime that is gone
 *   are found in; null when it cannot be read (then nothing is stopped). Default: listProcessTable
 * @property {(options: RuntimeServiceOptions) => RuntimeServiceLike | Promise<RuntimeServiceLike>} [createService] inprocess mode; default: runtime-host.mts
 * @property {Partial<ClientSettings>} [settings]
 */
/**
 * @typedef {object} RuntimeClient
 * @property {RuntimeMode} mode
 * @property {Promise<{ pid: number, ms: number }>} ready the first start: resolves when the runtime is ready, rejects when
 *   it failed before that (code ERROR_CODES.shuttingDown when a quit or a relaunch ended it: not a failed start)
 * @property {(channel: string, args?: unknown[]) => Promise<unknown>} call
 * @property {(reason?: string) => Promise<{ ms: number, pid: number }>} restart shuts the runtime down for a restart and
 *   starts a new one (child mode only); during the first start it waits for that start to finish first. Rejects with
 *   code ERROR_CODES.shuttingDown when a quit or a relaunch ends it
 * @property {(mode?: ShutdownMode, timeoutMs?: number) => Promise<{ marked: string[] }>} shutdown the process tree is killed when it does not exit in time
 * @property {(info: RendererHealthyInfo) => void} rendererHealthy
 * @property {() => RuntimeStatus} status
 * @property {() => Promise<void>} kill no shutdown: the process tree is killed at once
 */

/** @type {Readonly<ClientSettings>} */
const DEFAULTS = Object.freeze({
  queueTimeoutMs: 30000, startTimeoutMs: 20000, shutdownTimeoutMs: 5000, exitGraceMs: 1000,
  maxAutoRestarts: 3, autoRestartWindowMs: 60000, autoRestartDelayMs: 250,
  // The runtime gives up on main after 3 s (runtime-child.cjs); main answers before that.
  proxyTimeoutMs: 2500,
})

/** @param {unknown} error @returns {string} */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A message as the log shows it, 200 characters at most; never throws (a structured clone may carry a BigInt or a cycle).
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  try { return String(JSON.stringify(value)).slice(0, 200) } catch { return typeof value }
}

/**
 * @template T
 * @typedef {{ promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void, settled: () => boolean }} Deferred
 */
/**
 * A promise with its settle functions; a rejection nobody waits for is not reported as unhandled.
 * @template T
 * @returns {Deferred<T>}
 */
function deferred() {
  let settled = false
  /** @type {(value: T) => void} */
  let resolvePromise = () => {}
  /** @type {(error: Error) => void} */
  let rejectPromise = () => {}
  /** @type {Promise<T>} */
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  promise.catch(() => {})
  return {
    promise,
    resolve: (value) => { if (!settled) { settled = true; resolvePromise(value) } },
    reject: (error) => { if (!settled) { settled = true; rejectPromise(error) } },
    settled: () => settled,
  }
}

/**
 * Waits for `promise` at most `ms`; true when it settled in time. The timer is cleared either way.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms))
    const done = () => { clearTimeout(timer); resolve(true) }
    promise.then(done, done)
  })
}

/**
 * Ends a process and everything it started (provider CLIs and their shells): `taskkill /t /f` on Windows. Errors (the
 * process is already gone) are ignored. Only for a pid known to be the process meant: the runtime process main holds,
 * or one orphansOf() checked against the process table.
 * @param {number} pid
 * @returns {Promise<void>}
 */
function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      childProcess.execFile('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 10000 }, () => resolve())
      return
    }
    try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
    resolve()
  })
}

/**
 * Prints the process table as JSON, `[{ p, pp, c }]`: pid, parent pid, creation time in ms since the epoch. Win32_Process
 * keeps the pid of a parent that has exited, which is how the orphans of a crashed runtime are found; run through
 * -EncodedCommand, so nothing in it needs quoting.
 */
const PROCESS_TABLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$rows = Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object {",
  '  $created = $null',
  '  if ($_.CreationDate) { $created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  '  [pscustomobject]@{ p = [long]$_.ProcessId; pp = [long]$_.ParentProcessId; c = $created }',
  '}',
  'ConvertTo-Json -InputObject @($rows) -Compress',
].join('\n')
/** How long the process table may take to read (PowerShell starts in ~0.5 s). */
const PROCESS_TABLE_TIMEOUT_MS = 15000

/**
 * PROCESS_TABLE_SCRIPT's output as rows; null when it is not that.
 * @param {string} text
 * @returns {ProcessRow[] | null}
 */
function parseProcessTable(text) {
  /** @type {unknown} */
  let parsed
  try { parsed = JSON.parse(text.trim()) } catch { return null }
  const list = Array.isArray(parsed) ? parsed : (parsed !== null && typeof parsed === 'object' ? [parsed] : null)
  if (!list) return null
  /** @type {ProcessRow[]} */
  const rows = []
  for (const item of list) {
    const fields = /** @type {{ p?: unknown, pp?: unknown, c?: unknown } | null} */ (item !== null && typeof item === 'object' ? item : null)
    if (!fields || !Number.isSafeInteger(fields.p) || !Number.isSafeInteger(fields.pp)) continue
    rows.push({ pid: Number(fields.p), ppid: Number(fields.pp), created: typeof fields.c === 'number' && Number.isFinite(fields.c) ? fields.c : null })
  }
  return rows
}

/**
 * The system's process table, read once: on Windows Win32_Process through PowerShell. Null elsewhere, or when it cannot
 * be read in time; the orphan check then leaves every process alone.
 * @param {number} [timeoutMs]
 * @returns {Promise<ProcessRow[] | null>}
 */
function listProcessTable(timeoutMs = PROCESS_TABLE_TIMEOUT_MS) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const systemRoot = process.env.SystemRoot
  const powershell = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const encoded = Buffer.from(PROCESS_TABLE_SCRIPT, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    childProcess.execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => resolve(error ? null : parseProcessTable(String(stdout))))
  })
}

/**
 * How the OS's creation time of a process may lie around the time the runtime recorded for it (SpawnedProcess.startedAt,
 * taken right before the spawn): the kernel dates a process by its tick-updated clock, up to a timer tick behind the
 * one the runtime read, and the spawn itself (path search, image checks) takes a few ms, more on a busy machine
 * (measured 1-11 ms on Windows 10, Node 22 and Electron 44). An orphan was created while its parent lived, and the
 * parent died with the runtime (EXIT_SLACK_MS after main heard of the exit at most).
 */
const START_SLACK = Object.freeze({ beforeMs: 100, afterMs: 2000 })
const EXIT_SLACK_MS = 1000

/**
 * What to stop once a runtime process is gone, from the processes it reported having started and the process table
 * read after its exit. A process the table still shows under a recorded pid is stopped (with its tree) only when its
 * creation time matches the recorded start, otherwise the pid is another process's now. A recorded process that is
 * gone leaves orphans: processes whose parent pid is its pid, created after its start and before it could no longer
 * have created anything (the runtime's exit, or the creation of the process that took over the pid). A pid is never
 * chosen on its number alone, and `keep` (main, the runtime process) never.
 * @param {readonly SpawnedProcess[]} spawned
 * @param {readonly ProcessRow[]} table
 * @param {{ exitedAt: number, keep?: readonly number[] }} options
 * @returns {number[]} pids to end with their trees
 */
function orphansOf(spawned, table, { exitedAt, keep = [] }) {
  /** @type {Map<number, ProcessRow>} */
  const byPid = new Map(table.map(row => [row.pid, row]))
  // 0 and 4: the idle process and the kernel's System process.
  const never = new Set([0, 4, ...keep])
  /** @type {Set<number>} */
  const targets = new Set()
  for (const { pid, startedAt } of spawned) {
    const holder = byPid.get(pid)
    const holderCreated = holder ? holder.created : undefined
    // Something runs under this pid, created at an unknown time: neither it nor its children can be told apart.
    if (holderCreated === null) continue
    const earliest = startedAt - START_SLACK.beforeMs
    if (holderCreated !== undefined && holderCreated >= earliest && holderCreated <= startedAt + START_SLACK.afterMs) {
      if (!never.has(pid)) targets.add(pid)
      continue
    }
    const latest = Math.min(exitedAt + EXIT_SLACK_MS, holderCreated ?? Infinity)
    for (const row of table) {
      if (row.ppid !== pid || row.pid === pid || row.created === null || never.has(row.pid)) continue
      if (row.created >= earliest && row.created < latest) targets.add(row.pid)
    }
  }
  return [...targets]
}

/**
 * Electron's UtilityProcess as a ChildHandle. Its pid is undefined before `spawn` and after `exit`, so it is kept.
 * @param {Pick<import('electron/main').UtilityProcess, 'pid' | 'postMessage' | 'kill' | 'on' | 'stdout' | 'stderr'>} child
 * @returns {ChildHandle}
 */
function adaptUtilityProcess(child) {
  let pid = child.pid ?? null
  /** @type {((stream: 'stdout' | 'stderr', text: string) => void)[]} */
  const outputListeners = []
  /** @param {'stdout' | 'stderr'} stream @param {string} text */
  const output = (stream, text) => { for (const listener of outputListeners) listener(stream, text) }
  child.on('spawn', () => { pid = child.pid ?? pid })
  child.stdout?.on('data', (/** @type {unknown} */ chunk) => output('stdout', String(chunk)))
  child.stderr?.on('data', (/** @type {unknown} */ chunk) => output('stderr', String(chunk)))
  // A V8 fatal error; `exit` follows it.
  child.on('error', (type, location) => output('stderr', `${type} at ${location}\n`))
  return {
    pid: () => child.pid ?? pid,
    post: (message) => child.postMessage(message),
    onMessage: (listener) => { child.on('message', (message) => listener(message)) },
    onExit: (listener) => { child.on('exit', (code) => listener(code)) },
    onOutput: (listener) => { outputListeners.push(listener) },
    kill: () => { child.kill() },
  }
}

/**
 * Node's ChildProcess (child_process.fork) as a ChildHandle.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {ChildHandle}
 */
function adaptChildProcess(child) {
  /** @type {((stream: 'stdout' | 'stderr', text: string) => void)[]} */
  const outputListeners = []
  /** @type {((code: number | null) => void)[]} */
  const exitListeners = []
  let exited = false
  /** @param {'stdout' | 'stderr'} stream @param {string} text */
  const output = (stream, text) => { for (const listener of outputListeners) listener(stream, text) }
  /** @param {number | null} code */
  const finish = (code) => {
    if (exited) return
    exited = true
    for (const listener of exitListeners) listener(code)
  }
  child.stdout?.on('data', (chunk) => output('stdout', String(chunk)))
  child.stderr?.on('data', (chunk) => output('stderr', String(chunk)))
  child.on('exit', (code) => finish(code))
  // A process that never started emits 'error' and no 'exit'; a send on a closed channel emits 'error' as well, and an
  // 'error' without a listener would throw in main.
  child.on('error', (error) => {
    output('stderr', `${error.message}\n`)
    if (child.pid === undefined) setImmediate(() => finish(null))
  })
  return {
    pid: () => child.pid ?? null,
    post: (message) => {
      if (!child.connected) throw new Error('the runtime process has no IPC channel any more')
      child.send(message)
    },
    onMessage: (listener) => { child.on('message', (message) => listener(message)) },
    onExit: (listener) => { exitListeners.push(listener) },
    onOutput: (listener) => { outputListeners.push(listener) },
    kill: () => { child.kill() },
  }
}

/**
 * Forks through Electron's utilityProcess, what main uses: a Node process of Electron's own ("Orbit runtime" in Task
 * Manager), stdout/stderr piped back to main's log.
 * @param {Pick<typeof import('electron').utilityProcess, 'fork'>} utilityProcess
 * @returns {ForkFunction}
 */
function utilityFork(utilityProcess) {
  return (entry, { env }) => adaptUtilityProcess(utilityProcess.fork(entry, [], { serviceName: 'Orbit runtime', env, stdio: 'pipe' }))
}

/**
 * Forks with Node's child_process (tests, or a host without Electron): the same entry and protocol over Node IPC with
 * structured-clone ("advanced") serialization, as utilityProcess has.
 * @param {{ execPath?: string, cwd?: string }} [options]
 * @returns {ForkFunction}
 */
function nodeFork(options = {}) {
  return (entry, { env }) => adaptChildProcess(childProcess.fork(entry, [], {
    execPath: options.execPath, execArgv: NODE_EXEC_ARGV, serialization: 'advanced', env, cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }))
}

/**
 * The exports of an ORBIT_RUNTIME_FIXTURES module that are functions, as the child reads them (smoke:desktop).
 * @param {string | undefined} file
 * @returns {RuntimeOverrides | undefined}
 */
function loadFixtures(file) {
  if (!file) return undefined
  const loaded = /** @type {unknown} */ (require(path.resolve(file)))
  const exported = /** @type {Record<string, unknown>} */ (loaded !== null && typeof loaded === 'object' ? loaded : {})
  /** @type {Record<string, unknown>} */
  const overrides = {}
  for (const name of ['runProvider', 'inspectProviders', 'patchQuotaReaders']) if (typeof exported[name] === 'function') overrides[name] = exported[name]
  return /** @type {RuntimeOverrides} */ (overrides)
}

/**
 * @param {RuntimeMode} mode
 * @param {(status: RuntimeStatus) => void} onStatus
 * @param {(level: LogLevel, text: string) => void} log
 */
function statusHolder(mode, onStatus, log) {
  /** @type {RuntimeStatus} */
  let status = { state: 'starting', mode, pid: mode === 'inprocess' ? process.pid : null, since: Date.now(), lastRestartMs: null, restarts: 0, retrying: false }
  return {
    /** @returns {RuntimeStatus} */
    get: () => ({ ...status }),
    /** @param {Partial<RuntimeStatus>} patch */
    update(patch) {
      /** @type {RuntimeStatus} */
      const next = { ...status, ...patch }
      if (patch.state && patch.state !== status.state) next.since = Date.now()
      if (next.state === 'ready' || next.error === undefined) delete next.error
      if (next.lastError === undefined) delete next.lastError
      // Only the report of a crash that schedules an automatic restart says so; any later change ends it.
      next.retrying = patch.retrying === true
      status = next
      try { onStatus({ ...status }) } catch (error) { log('warn', `runtime status listener failed: ${errorText(error)}`) }
    },
  }
}

/**
 * @param {RuntimeClientOptions} options
 * @returns {RuntimeClient}
 */
function createRuntimeClient(options) {
  const mode = options.mode === 'inprocess' ? 'inprocess' : 'child'
  /** @type {ClientSettings} */
  const settings = { ...DEFAULTS, ...options.settings }
  const log = options.log ?? (() => {})
  /** @type {(channel: string, payload: unknown) => void} */
  const onEvent = (channel, payload) => {
    try { options.onEvent?.(channel, payload) } catch (error) { log('warn', `runtime event ${channel} could not be delivered: ${errorText(error)}`) }
  }
  /** @type {(request: ApprovalRequestWire, signal: AbortSignal) => Promise<boolean>} */
  const askApproval = async (request, signal) => {
    if (!options.onApproval) return false
    try { return (await options.onApproval(request, signal)) === true } catch (error) {
      log('warn', `approval dialog failed: ${errorText(error)}`)
      return false
    }
  }
  const status = statusHolder(mode, options.onStatus ?? (() => {}), log)
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) if (typeof value === 'string') env[key] = value
  env.ORBIT_USER_DATA_DIR = options.userData
  env.ORBIT_REPO_ROOT = options.repoRoot
  // The child watches this process and shuts itself down when it is gone.
  env.ORBIT_PARENT_PID = String(process.pid)
  const context = { options, settings, log, onEvent, askApproval, status, env }
  return mode === 'inprocess' ? inprocessClient(context) : childClient(context)
}

/**
 * @typedef {object} ClientContext
 * @property {RuntimeClientOptions} options
 * @property {ClientSettings} settings
 * @property {(level: LogLevel, text: string) => void} log
 * @property {(channel: string, payload: unknown) => void} onEvent
 * @property {(request: ApprovalRequestWire, signal: AbortSignal) => Promise<boolean>} askApproval
 * @property {ReturnType<typeof statusHolder>} status
 * @property {Record<string, string>} env
 */
/**
 * @typedef {object} PendingCall
 * @property {number} id
 * @property {string} channel
 * @property {unknown[]} args
 * @property {(value: unknown) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {NodeJS.Timeout | null} timer the queue timeout while it waits for a ready runtime
 */
/**
 * One runtime process, from fork to exit.
 * @typedef {object} Session
 * @property {number} serial
 * @property {ChildHandle | null} child
 * @property {number | null} pid
 * @property {number} forkedAt
 * @property {number | null} restartBegan set when this process replaces another one (restart or crash)
 * @property {number | null} restartMs
 * @property {boolean} ready
 * @property {boolean} exited
 * @property {boolean} expectExit a shutdown or kill was asked for: the exit is not a crash
 * @property {ShutdownMode | null} stopMode what it was asked to stop for
 * @property {Promise<string[]> | null} stopping
 * @property {string | null} failure why it failed, when known better than its exit code (fatal message, start timeout,
 *   another protocol version, a fork main refused)
 * @property {Map<number, PendingCall>} pending
 * @property {Map<string, AbortController>} approvals
 * @property {SpawnedProcess[]} processes what it last reported running (provider CLIs, commands, Git)
 * @property {Promise<void>} reaped what is left of them once it exited is stopped (orphansOf)
 * @property {number} errors uncaught errors it reported after its start
 * @property {string[] | null} marked
 * @property {string[]} stderrTail
 * @property {{ stdout: string, stderr: string }} partial
 * @property {Deferred<{ pid: number, ms: number }>} started
 * @property {Deferred<number | null>} exit
 * @property {Deferred<string[]>} done `shutdown-done`
 * @property {NodeJS.Timeout | null} startTimer
 */

/**
 * @param {ClientContext} context
 * @returns {RuntimeClient}
 */
function childClient({ options, settings, log, onEvent, askApproval, status, env }) {
  const fork = options.fork ?? nodeFork()
  const entry = options.entry ?? CHILD_ENTRY
  const killTree = options.killTree ?? killProcessTree
  const listProcesses = options.listProcesses ?? (() => listProcessTable())
  let serial = 0
  let callSerial = 0
  /** @type {Session | null} */
  let current = null
  /** The first process: `ready` answers for its start, which a restart lets finish. */
  /** @type {Session | null} */
  let first = null
  /** @type {PendingCall[]} */
  const queue = []
  let closing = false
  /** @type {number[]} */
  let autoRestarts = []
  /** An automatic restart after a crash, waiting for its delay and for the crashed runtime's orphans to be stopped. */
  /** @type {{ cancel: () => void } | null} */
  let autoRestart = null
  /** The orphans of the runtime that exited last being stopped: no new runtime starts before that (or REAP_WAIT_MS). */
  /** @type {Promise<void>} */
  let reaping = Promise.resolve()
  /** @type {Promise<{ ms: number, pid: number }> | null} */
  let restarting = null
  /** @type {Promise<{ marked: string[] }> | null} */
  let stopping = null
  /** @type {RendererHealthyInfo | null} */
  let pendingHealthy = null
  /** @param {string} [message] */
  const shuttingDown = (message = 'Orbit is shutting down') => codedError(message, ERROR_CODES.shuttingDown)

  /** @param {Session} session @param {ToChild} message @returns {boolean} */
  const post = (session, message) => {
    if (!session.child || session.exited) return false
    try { session.child.post(message); return true } catch (error) {
      log('warn', `could not send ${message.t} to the runtime (pid ${session.pid}): ${errorText(error)}`)
      return false
    }
  }

  /** @param {Session} session */
  const usable = (session) => session === current && session.ready && !session.exited && !session.expectExit

  /** @param {Session} session @param {PendingCall} call */
  const dispatch = (session, call) => {
    if (call.timer) { clearTimeout(call.timer); call.timer = null }
    session.pending.set(call.id, call)
    try {
      if (!session.child) throw new Error('the runtime process is gone')
      session.child.post({ t: 'call', id: call.id, channel: call.channel, args: call.args })
    } catch (error) {
      session.pending.delete(call.id)
      call.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** @param {PendingCall} call @param {boolean} [first] ahead of the calls already waiting */
  const enqueue = (call, first = false) => {
    call.timer = setTimeout(() => {
      const index = queue.indexOf(call)
      if (index >= 0) queue.splice(index, 1)
      call.reject(new Error(`Orbit runtime was not ready within ${Math.round(settings.queueTimeoutMs / 1000)} s (${status.get().state}); ${call.channel} was not sent`))
    }, settings.queueTimeoutMs)
    if (first) queue.unshift(call)
    else queue.push(call)
  }

  /** @param {Error} error */
  const rejectQueue = (error) => {
    for (const call of queue.splice(0)) {
      if (call.timer) clearTimeout(call.timer)
      call.reject(error)
    }
  }

  /** @param {Session} session */
  const sessionReady = (session) => {
    if (!usable(session)) return
    /** @type {Partial<RuntimeStatus>} */
    const patch = { state: 'ready', pid: session.pid }
    if (session.restartBegan !== null) {
      session.restartMs = Date.now() - session.restartBegan
      patch.lastRestartMs = session.restartMs
      patch.restarts = status.get().restarts + 1
    }
    status.update(patch)
    for (const call of queue.splice(0)) dispatch(session, call)
    if (pendingHealthy && post(session, { t: 'renderer-healthy', info: pendingHealthy })) pendingHealthy = null
  }

  /** @param {Session} session @param {'stdout' | 'stderr'} stream @param {string} text @param {boolean} [flush] */
  const output = (session, stream, text, flush = false) => {
    const lines = (session.partial[stream] + text).split(/\r?\n/)
    session.partial[stream] = flush ? '' : lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      if (stream === 'stderr') {
        session.stderrTail.push(line)
        if (session.stderrTail.length > STDERR_TAIL) session.stderrTail.shift()
      }
      log(stream === 'stderr' ? 'warn' : 'info', `[runtime ${session.pid ?? '?'}] ${line}`)
    }
  }

  /** @param {Session} session @param {string} id @param {ApprovalRequestWire} request */
  const approve = (session, id, request) => {
    const controller = new AbortController()
    session.approvals.get(id)?.abort()
    session.approvals.set(id, controller)
    void askApproval(request, controller.signal).then((approved) => {
      // Withdrawn by the runtime, or the process is gone: nobody waits for the answer.
      if (session.approvals.get(id) !== controller) return
      session.approvals.delete(id)
      post(session, { t: 'approval-result', id, approved: approved && !controller.signal.aborted })
    })
  }

  /**
   * The runtime asked for the system proxy of `url`; any failure, or no answer in time, is null (the runtime then falls
   * back to the registry).
   * @param {Session} session @param {string} id @param {string} url
   */
  const answerProxy = (session, id, url) => {
    const resolver = options.resolveProxy
    /** @type {Promise<string | null>} */
    const lookup = resolver ? Promise.resolve().then(() => resolver(url)).then(route => (typeof route === 'string' ? route : null)) : Promise.resolve(null)
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    /** @type {Promise<null>} */
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), settings.proxyTimeoutMs) })
    void Promise.race([lookup, late]).catch((error) => {
      log('warn', `could not resolve the proxy for ${url}: ${errorText(error)}`)
      return null
    }).then((route) => {
      clearTimeout(timer)
      post(session, { t: 'proxy-result', id, route })
    })
  }

  /** @param {Session} session @param {unknown} raw */
  const handleMessage = (session, raw) => {
    const message = parseFromChild(raw)
    if (!message) {
      const fields = /** @type {{ t?: unknown, id?: unknown } | null} */ (raw !== null && typeof raw === 'object' ? raw : null)
      if (fields?.t === 'approval' && typeof fields.id === 'string') {
        // An agent waits for this answer: a question Orbit cannot show is a no, never silence.
        log('warn', `the runtime asked for an approval Orbit cannot read, answered no: ${describe(raw)}`)
        post(session, { t: 'approval-result', id: fields.id, approved: false })
        return
      }
      log('warn', `the runtime sent a message Orbit does not know: ${describe(raw)}`)
      return
    }
    switch (message.t) {
      case 'ready':
        if (session.ready || session.exited) return
        if (message.protocol !== PROTOCOL_VERSION) {
          // Its runtime-protocol.mts is not the one this main process loaded: only a full relaunch brings them together.
          session.failure = `the runtime process speaks protocol ${message.protocol || 'unknown'} and this Orbit window speaks ${PROTOCOL_VERSION}; relaunch Orbit (Orbit.cmd --relaunch) to load both from the same code`
          log('error', `refused the runtime (pid ${message.pid}): ${session.failure}`)
          void killSession(session)
          return
        }
        session.ready = true
        if (session.startTimer) { clearTimeout(session.startTimer); session.startTimer = null }
        session.pid = message.pid || session.child?.pid() || session.pid
        log('info', `runtime ready (pid ${session.pid}) ${Date.now() - session.forkedAt} ms after the fork (its own start ${message.ms} ms)`)
        session.started.resolve({ pid: session.pid ?? 0, ms: Date.now() - session.forkedAt })
        sessionReady(session)
        return
      case 'result': {
        const call = session.pending.get(message.id)
        if (!call) return
        session.pending.delete(message.id)
        if (message.ok) call.resolve(message.value)
        else call.reject(deserializeError(message.error))
        return
      }
      case 'event':
        onEvent(message.channel, message.payload)
        return
      case 'approval':
        approve(session, message.id, message.request)
        return
      case 'approval-cancel': {
        const controller = session.approvals.get(message.id)
        if (!controller) return
        session.approvals.delete(message.id)
        controller.abort()
        return
      }
      case 'shutdown-done':
        session.marked = message.marked
        session.done.resolve(message.marked)
        return
      case 'log':
        log(message.level, `[runtime] ${message.text}`)
        return
      case 'processes':
        session.processes = message.processes
        return
      case 'resolve-proxy':
        answerProxy(session, message.id, message.url)
        return
      case 'uncaught': {
        session.errors += message.count
        const burst = message.count > 1 ? ` (${message.count} since the last report; the last one)` : ''
        log('error', `uncaught error in the runtime (pid ${session.pid})${burst}: ${message.error.stack || message.error.message}`)
        // The window shows it; the runtime keeps running. The runtime sends at most one a second.
        if (session === current && !session.exited) status.update({ lastError: { message: message.error.message, at: Date.now(), count: session.errors } })
        return
      }
      case 'fatal':
        session.failure = message.error.message
        log('error', `runtime fatal error: ${message.error.stack || message.error.message}`)
    }
  }

  /** @param {string} reason */
  const stop = (reason) => {
    status.update({ state: 'stopped', pid: null, error: reason })
    rejectQueue(new Error(`Orbit runtime is stopped: ${reason}`))
  }

  /**
   * A runtime process ended that nobody asked to stop. One that had been ready crashed: a new one starts after a pause,
   * at most maxAutoRestarts times within autoRestartWindowMs. One that failed to start (fatal, an exit or the start
   * timeout before `ready`, another protocol version, a fork main refused) is not started again on its own: the same
   * code would fail the same way or race whoever is changing it (the self-upgrade watcher restoring electron/ after a
   * failed upgrade), and each try would use up the crash budget. The next start is asked for: a restart signal, the
   * window's button, a relaunch.
   * @param {Session} session
   * @param {string} reason
   */
  const failed = (session, reason) => {
    if (closing) { stop(reason); return }
    if (!session.ready) {
      log('error', `Orbit runtime failed to start: ${reason}`)
      stop(reason)
      return
    }
    log('error', `Orbit runtime stopped unexpectedly: ${reason}`)
    const now = Date.now()
    autoRestarts = autoRestarts.filter(time => now - time < settings.autoRestartWindowMs)
    if (autoRestarts.length >= settings.maxAutoRestarts) {
      stop(`${reason} (it crashed ${autoRestarts.length + 1} times within ${Math.round(settings.autoRestartWindowMs / 1000)} s; restart it by hand)`)
      return
    }
    autoRestarts.push(now)
    let cancelled = false
    const timer = setTimeout(() => {
      // What the crashed runtime left running is stopped first (REAP_WAIT_MS at most): the new one should not meet it.
      void settlesWithin(reaping, REAP_WAIT_MS).then(() => {
        if (cancelled) return
        autoRestart = null
        if (closing || current || restarting) return
        launch('starting', now)
      })
    }, settings.autoRestartDelayMs)
    autoRestart = { cancel: () => { cancelled = true; clearTimeout(timer); autoRestart = null } }
    status.update({ state: 'crashed', pid: null, error: reason, retrying: true })
  }

  /**
   * Stops what a runtime process that is gone left running (orphansOf); a process table that cannot be read stops nothing.
   * @param {Session} session
   * @param {number} exitedAt
   * @returns {Promise<void>}
   */
  const reap = async (session, exitedAt) => {
    const table = await Promise.resolve().then(listProcesses).catch(() => null)
    if (!table) {
      log('warn', `could not read the process table; what the runtime (pid ${session.pid}) started is left alone: ${session.processes.map(entry => entry.pid).join(', ')}`)
      return
    }
    const targets = orphansOf(session.processes, table, { exitedAt, keep: session.pid ? [process.pid, session.pid] : [process.pid] })
    if (!targets.length) return
    log('warn', `stopping ${targets.length} process(es) the runtime (pid ${session.pid}) left behind: ${targets.join(', ')}`)
    await Promise.all(targets.map(pid => killTree(pid).catch(() => {})))
  }

  /** @param {Session} session @param {number | null} code */
  const handleExit = (session, code) => {
    if (session.exited) return
    output(session, 'stdout', '', true)
    output(session, 'stderr', '', true)
    session.exited = true
    if (session.startTimer) { clearTimeout(session.startTimer); session.startTimer = null }
    const tail = session.stderrTail.slice(-3).join(' | ')
    const reason = session.failure || `the process exited with code ${code}${tail ? `: ${tail}` : ''}`
    const unanswered = session.expectExit
      ? new Error('Orbit runtime was restarted or stopped before it answered')
      : new Error(`Orbit runtime stopped unexpectedly: ${reason}`)
    const carried = [...session.pending.values()].filter(call => session.stopMode === 'restart' && !closing && REPEATABLE.has(call.channel))
    for (const call of session.pending.values()) if (!carried.includes(call)) call.reject(unanswered)
    session.pending.clear()
    for (const call of carried.reverse()) enqueue(call, true)
    for (const controller of session.approvals.values()) controller.abort()
    session.approvals.clear()
    // What the runtime started and did not stop (a crash, a tree that would not die in time) may be left: on Windows its
    // direct children die with it (libuv's kill-on-close job) but their own children do not, and taskkill /t cannot
    // reach those through a parent that is gone. They are looked up in the process table.
    if (session.processes.length) {
      session.reaped = reap(session, Date.now())
      reaping = Promise.all([reaping, session.reaped]).then(() => {})
    }
    session.done.resolve(session.marked ?? [])
    // A start that a quit or a relaunch ended did not fail.
    session.started.reject(closing && session.expectExit ? shuttingDown('the runtime was stopped before it was ready: Orbit is shutting down') : new Error(reason))
    session.exit.resolve(code)
    if (session !== current) return
    current = null
    if (!session.expectExit) failed(session, reason)
  }

  /**
   * @param {RuntimeState} state
   * @param {number | null} restartBegan
   * @returns {Session}
   */
  const launch = (state, restartBegan) => {
    // A new process starts without the uncaught errors of the one before.
    status.update({ state, pid: null, lastError: undefined })
    /** @type {Session} */
    const session = {
      serial: ++serial, child: null, pid: null, forkedAt: Date.now(), restartBegan, restartMs: null,
      ready: false, exited: false, expectExit: false, stopMode: null, stopping: null, failure: null,
      pending: new Map(), approvals: new Map(), processes: [], reaped: Promise.resolve(), errors: 0, marked: null,
      stderrTail: [], partial: { stdout: '', stderr: '' }, started: deferred(), exit: deferred(), done: deferred(), startTimer: null,
    }
    current = session
    try {
      options.beforeFork?.()
    } catch (error) {
      // Main refused the fork (the shell files changed since it started: only a relaunch loads them).
      session.failure = errorText(error)
      setImmediate(() => handleExit(session, null))
      return session
    }
    try {
      const child = fork(entry, { env })
      session.child = child
      session.pid = child.pid()
      child.onMessage((message) => handleMessage(session, message))
      child.onExit((code) => handleExit(session, code))
      child.onOutput((stream, text) => output(session, stream, text))
    } catch (error) {
      session.failure = `could not start the runtime process: ${errorText(error)}`
      setImmediate(() => handleExit(session, null))
      return session
    }
    session.startTimer = setTimeout(() => {
      session.startTimer = null
      if (session.ready || session.exited) return
      session.failure = `the runtime did not report ready within ${Math.round(settings.startTimeoutMs / 1000)} s`
      void killSession(session)
    }, settings.startTimeoutMs)
    return session
  }

  /** @param {Session} session @returns {Promise<void>} */
  const killSession = async (session) => {
    if (session.exited) return
    const pid = session.child?.pid() ?? session.pid
    // The tree first: once the runtime process is gone, the CLIs it started are orphans taskkill /t cannot reach.
    if (pid) await killTree(pid).catch(() => {})
    try { session.child?.kill() } catch { /* Already gone. */ }
    if (!(await settlesWithin(session.exit.promise, 3000))) {
      log('warn', `the runtime (pid ${pid}) did not report its exit after it was killed`)
      handleExit(session, null)
    }
  }

  /**
   * Asks the process to shut down (it stops its runs and flushes its stores), then kills its tree if it has not exited
   * in time. A process that is not ready yet has nothing to save and is killed at once. One stop per process.
   * @param {Session} session
   * @param {ShutdownMode} mode
   * @param {number} timeoutMs
   * @returns {Promise<string[]>} the runs it marked as restarting
   */
  const stopSession = (session, mode, timeoutMs) => {
    session.expectExit = true
    if (session.stopping) return session.stopping
    session.stopMode = mode
    session.stopping = (async () => {
      if (session.exited) return session.marked ?? []
      if (!session.ready || !post(session, { t: 'shutdown', mode })) {
        await killSession(session)
        await settlesWithin(session.reaped, REAP_WAIT_MS)
        return session.marked ?? []
      }
      const deadline = Date.now() + timeoutMs
      await settlesWithin(Promise.race([session.exit.promise, session.done.promise]), timeoutMs)
      if (!session.exited && session.done.settled()) {
        await settlesWithin(session.exit.promise, Math.max(0, Math.min(settings.exitGraceMs, deadline - Date.now())))
      }
      if (!session.exited) {
        log('warn', `the runtime (pid ${session.pid}) did not exit within ${timeoutMs} ms of the ${mode} request; killing its process tree`)
        await killSession(session)
      }
      await settlesWithin(session.reaped, REAP_WAIT_MS)
      return session.marked ?? []
    })()
    return session.stopping
  }

  /** @type {RuntimeClient['call']} */
  const call = (channel, args = []) => {
    if (typeof channel !== 'string' || !channel) return Promise.reject(new TypeError('A runtime call needs a channel'))
    if (closing) return Promise.reject(shuttingDown())
    // No process, none about to start: waiting in the queue would only delay the error.
    if (!current && !autoRestart && !restarting) {
      const state = status.get()
      return Promise.reject(new Error(`Orbit runtime is ${state.state === 'stopped' ? 'stopped' : 'not running'}: ${state.error ?? 'unknown reason'}`))
    }
    return new Promise((resolve, reject) => {
      /** @type {PendingCall} */
      const pending = { id: ++callSerial, channel, args: Array.isArray(args) ? args : [], resolve, reject, timer: null }
      if (current && usable(current)) dispatch(current, pending)
      else enqueue(pending)
    })
  }

  /** @type {RuntimeClient['restart']} */
  const restart = (reason = 'restart') => {
    if (closing) return Promise.reject(shuttingDown())
    if (restarting) return restarting
    autoRestart?.cancel()
    // A restart by hand starts the crash budget afresh.
    autoRestarts = []
    log('info', `restarting the runtime (${reason})`)
    const promise = (async () => {
      // The first start is let finish: `ready` answers for it, and cutting it short would make main report a start that
      // was about to work as a failed one. A start that hangs ends at the start timeout.
      if (first && current === first && !first.ready && !first.exited) {
        log('info', 'the restart waits for the first start of the runtime to finish')
        await first.started.promise.catch(() => {})
        if (closing) throw shuttingDown()
      }
      const began = Date.now()
      const previous = current
      status.update({ state: 'restarting', pid: previous?.pid ?? null })
      if (previous) await stopSession(previous, 'restart', settings.shutdownTimeoutMs)
      // After a crash as well: what the runtime that is gone left running is stopped before a new one starts.
      await settlesWithin(reaping, REAP_WAIT_MS)
      if (closing) throw shuttingDown()
      const session = launch('restarting', began)
      const { pid } = await session.started.promise
      return { ms: session.restartMs ?? Date.now() - began, pid }
    })()
    restarting = promise
    const clear = () => { if (restarting === promise) restarting = null }
    promise.then(clear, clear)
    return promise
  }

  /** @type {RuntimeClient['shutdown']} */
  const shutdown = (mode = 'quit', timeoutMs = settings.shutdownTimeoutMs) => {
    if (stopping) return stopping
    closing = true
    autoRestart?.cancel()
    rejectQueue(shuttingDown())
    stopping = (async () => {
      const session = current
      const marked = session ? await stopSession(session, mode, timeoutMs) : []
      status.update({ state: 'stopped', pid: null })
      return { marked }
    })()
    return stopping
  }

  /** @type {RuntimeClient['kill']} */
  const kill = async () => {
    closing = true
    autoRestart?.cancel()
    rejectQueue(shuttingDown('Orbit runtime was killed'))
    const session = current
    if (session) {
      session.expectExit = true
      await killSession(session)
      await settlesWithin(session.reaped, REAP_WAIT_MS)
    }
    status.update({ state: 'stopped', pid: null })
  }

  /** @type {RuntimeClient['rendererHealthy']} */
  const rendererHealthy = (info) => {
    /** @type {RendererHealthyInfo} */
    const clean = { level: info.level, commit: info.commit ?? null }
    if (current && usable(current) && post(current, { t: 'renderer-healthy', info: clean })) return
    // Delivered to the runtime that is starting now, once it is ready.
    pendingHealthy = clean
  }

  const initial = launch('starting', null)
  first = initial
  return { mode: 'child', ready: initial.started.promise, call, restart, shutdown, rendererHealthy, status: status.get, kill }
}

/**
 * The same service inside main (ORBIT_RUNTIME_MODE=inprocess): no process, no restart.
 * @param {ClientContext} context
 * @returns {RuntimeClient}
 */
function inprocessClient({ options, settings, log, onEvent, askApproval, status, env }) {
  /** @type {Map<string, AbortController>} */
  const approvals = new Map()
  let closing = false
  /** @type {Promise<{ marked: string[] }> | null} */
  let stopping = null
  const began = Date.now()

  /** @param {ApprovalWire} request @returns {Promise<boolean>} */
  const requestApproval = ({ id, ...request }) => {
    const controller = new AbortController()
    approvals.get(id)?.abort()
    approvals.set(id, controller)
    return askApproval(request, controller.signal).then((approved) => {
      if (approvals.get(id) === controller) approvals.delete(id)
      return approved && !controller.signal.aborted
    })
  }
  /** @param {string} id */
  const cancelApproval = (id) => {
    const controller = approvals.get(id)
    if (!controller) return
    approvals.delete(id)
    controller.abort()
  }

  /** @returns {Promise<RuntimeServiceLike>} */
  const build = async () => {
    // Loaded only in this mode: a child-mode main never loads the runtime's modules.
    const create = options.createService ?? require('./runtime-host.mts').createRuntimeService
    const overrides = loadFixtures(env.ORBIT_RUNTIME_FIXTURES)
    return create({
      userData: options.userData, repoRoot: options.repoRoot, emit: onEvent, requestApproval, cancelApproval, log,
      ...(overrides ? { overrides } : {}),
    })
  }
  const service = build()
  /** @type {Promise<{ pid: number, ms: number }>} */
  const ready = service.then(() => {
    const result = { pid: process.pid, ms: Date.now() - began }
    if (!closing) status.update({ state: 'ready', pid: process.pid })
    return result
  }, (error) => {
    const reason = `the runtime could not be built: ${errorText(error)}`
    status.update({ state: 'stopped', pid: null, error: reason })
    throw new Error(reason)
  })
  ready.catch(() => {})

  /** @type {RuntimeClient['call']} */
  const call = async (channel, args = []) => {
    if (closing) throw new Error('Orbit is shutting down')
    /** @type {NodeJS.Timeout | undefined} */
    let timeout
    /** @type {Promise<never>} */
    const late = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Orbit runtime was not ready within ${Math.round(settings.queueTimeoutMs / 1000)} s; ${channel} was not sent`)), settings.queueTimeoutMs)
    })
    try {
      const built = await Promise.race([service, late])
      return await built.call(channel, Array.isArray(args) ? args : [])
    } finally {
      clearTimeout(timeout)
    }
  }

  /** @type {RuntimeClient['shutdown']} */
  const shutdown = (mode = 'quit', timeoutMs = settings.shutdownTimeoutMs) => {
    if (stopping) return stopping
    closing = true
    stopping = (async () => {
      /** @type {{ marked: string[] }} */
      let result = { marked: [] }
      try {
        const built = await service
        const finished = built.shutdown(mode).then((value) => { result = { marked: Array.isArray(value?.marked) ? value.marked : [] } })
        if (!(await settlesWithin(finished, timeoutMs))) log('warn', `the runtime did not finish its ${mode} shutdown within ${timeoutMs} ms`)
        else await finished.catch((error) => log('error', `runtime shutdown failed: ${errorText(error)}`))
      } catch (error) {
        log('warn', `runtime shutdown skipped: ${errorText(error)}`)
      }
      for (const controller of approvals.values()) controller.abort()
      approvals.clear()
      status.update({ state: 'stopped', pid: null })
      return result
    })()
    return stopping
  }

  return {
    mode: 'inprocess',
    ready,
    call,
    restart: () => Promise.reject(new Error('The runtime runs inside the main process (ORBIT_RUNTIME_MODE=inprocess): only a relaunch of Orbit loads new runtime code')),
    shutdown,
    rendererHealthy: (info) => {
      void service.then(built => built.rendererHealthy({ level: info.level, commit: info.commit ?? null }))
        .catch((error) => log('warn', `renderer-healthy was not delivered: ${errorText(error)}`))
    },
    status: status.get,
    kill: async () => {
      closing = true
      for (const controller of approvals.values()) controller.abort()
      approvals.clear()
      status.update({ state: 'stopped', pid: null })
    },
  }
}

module.exports = {
  CHILD_ENTRY, NODE_EXEC_ARGV, DEFAULTS,
  createRuntimeClient, adaptUtilityProcess, adaptChildProcess, utilityFork, nodeFork, killProcessTree,
  listProcessTable, parseProcessTable, orphansOf,
}
