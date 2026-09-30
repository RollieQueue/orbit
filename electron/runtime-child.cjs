// @ts-check
'use strict'

// The runtime child process (docs/TECH-DEBT.md item 2). Main starts this file with Electron's utilityProcess.fork (or
// child_process.fork: tests on Node 22 and the `fork` fallback) and talks to it with the messages of
// electron/runtime-protocol.mts. It builds the runtime service (electron/runtime-host.mts) for the profile given by
// --user-data (or ORBIT_USER_DATA_DIR) and the repository given by --repo-root (or ORBIT_REPO_ROOT), posts `ready`,
// answers calls, forwards events and approval questions, and exits after `shutdown-done`. A failure before `ready` is
// reported as `fatal` and ends the process with exit code 1; an error nothing caught after `ready` is reported as
// `uncaught` (at most one a second) and the runtime keeps running.
// When main dies: under utilityProcess Chromium terminates this process right away (within ~50 ms, measured), so it
// neither stops its runs nor saves; what it wrote before stays. Only a child_process.fork parent (tests, a Node host)
// leaves it running with a closed channel, and then it shuts down on its own.
// ORBIT_RUNTIME_FIXTURES names a CommonJS module whose exports ({ runProvider, inspectProviders, patchQuotaReaders })
// replace the real providers and quota readers: smoke and test runs only.

const Module = require('node:module')
const path = require('node:path')

/** @typedef {import('./runtime-protocol.mts').WireError} WireError */
/** @typedef {import('./runtime-protocol.mts').FromChild} FromChild */
/** @typedef {import('./runtime-protocol.mts').ToChild} ToChild */
/** @typedef {import('./runtime-protocol.mts').ApprovalWire} ApprovalWire */
/** @typedef {import('./runtime-protocol.mts').LogLevel} LogLevel */
/** @typedef {import('./runtime-protocol.mts').ShutdownMode} ShutdownMode */
/** @typedef {import('./runtime-host.mts').RuntimeService} RuntimeService */
/** @typedef {import('./runtime-host.mts').RuntimeOverrides} RuntimeOverrides */
/**
 * Electron's side of a utilityProcess channel (process.parentPort): a message event's `data` is what the parent posted.
 * @typedef {{ postMessage(message: unknown): void, on(event: 'message', listener: (event: { data: unknown }) => void): unknown }} ParentPort
 */
/**
 * The channel to main. `post` throws when a message cannot be cloned; `done` runs once the message has left.
 * @typedef {object} Transport
 * @property {'utility' | 'fork'} kind
 * @property {(message: FromChild, done?: () => void) => void} post
 * @property {(listener: (message: unknown) => void) => void} listen
 */

// Milliseconds since this process started: what `ready` reports.
const sinceStart = () => Math.round(process.uptime() * 1000)

/**
 * A variable main set for this process, read once and removed: every process the runtime starts (provider CLIs, agents'
 * commands) inherits process.env, and these name Orbit's profile, its repository and main's pid.
 * @param {string} name
 * @returns {string | undefined}
 */
function takeFromEnv(name) {
  const value = process.env[name]
  delete process.env[name]
  return value || undefined
}
const fromMain = {
  userData: takeFromEnv('ORBIT_USER_DATA_DIR'),
  repoRoot: takeFromEnv('ORBIT_REPO_ROOT'),
  parentPid: takeFromEnv('ORBIT_PARENT_PID'),
}
// Opt-in: ORBIT_COMPILE_CACHE=<folder> (or 1: Node's default folder in os.tmpdir()) keeps the compiled runtime modules
// between starts. Measured on Windows with Electron 44: a warm cache saves ~100 ms of a ~300 ms start, but a cold one
// costs ~0.5 s at the exit that writes it and ~2 s at the next start (freshly written files are slow to read the
// first time), and on Node 22 it slows every start down. A restart follows a code change, so the cache is often cold.
const compileCache = process.env.ORBIT_COMPILE_CACHE
if (compileCache && compileCache !== '0' && typeof Module.enableCompileCache === 'function') {
  try { Module.enableCompileCache(compileCache === '1' ? undefined : compileCache) } catch { /* An optimisation only. */ }
}

/** @returns {Transport | null} */
function pickTransport() {
  const port = /** @type {{ parentPort?: ParentPort }} */ (/** @type {unknown} */ (process)).parentPort
  if (port) {
    return {
      kind: 'utility',
      // A utility process has no delivery callback; the short delay lets the message leave before an exit.
      post: (message, done) => { port.postMessage(message); if (done) setTimeout(done, 50) },
      listen: (listener) => { port.on('message', (event) => listener(event.data)) },
    }
  }
  const send = process.send
  if (typeof send !== 'function') return null
  return {
    kind: 'fork',
    // The callback also receives the error of a closed channel, which would otherwise be emitted as an uncaught 'error'.
    post: (message, done) => { send.call(process, message, () => { if (done) done() }) },
    listen: (listener) => { process.on('message', listener) },
  }
}

/**
 * The fallback form of an error, for a failure before runtime-protocol.mts itself could be loaded.
 * @param {unknown} error
 * @returns {WireError}
 */
function plainError(error) {
  const fields = /** @type {{ message?: unknown, stack?: unknown } | null} */ (error !== null && typeof error === 'object' ? error : null)
  let message = 'Unknown error'
  try { message = typeof fields?.message === 'string' ? fields.message : String(error) } catch { /* An object without a string form. */ }
  return { message, ...(typeof fields?.stack === 'string' ? { stack: fields.stack } : {}) }
}

/**
 * A --name value or --name=value argument.
 * @param {string} name
 * @returns {string | undefined}
 */
function argument(name) {
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name) return argv[index + 1]
    if (argv[index].startsWith(`${name}=`)) return argv[index].slice(name.length + 1)
  }
  return undefined
}

/**
 * The overrides a fixtures module exports; anything that is not a function is ignored.
 * @param {string | undefined} file
 * @returns {RuntimeOverrides | undefined}
 */
function loadFixtures(file) {
  if (!file) return undefined
  const loaded = /** @type {unknown} */ (require(path.resolve(file)))
  const exported = /** @type {Record<string, unknown>} */ (loaded !== null && typeof loaded === 'object' ? loaded : {})
  /** @type {RuntimeOverrides} */
  const overrides = {}
  if (typeof exported.runProvider === 'function') overrides.runProvider = /** @type {NonNullable<RuntimeOverrides['runProvider']>} */ (exported.runProvider)
  if (typeof exported.inspectProviders === 'function') overrides.inspectProviders = /** @type {NonNullable<RuntimeOverrides['inspectProviders']>} */ (exported.inspectProviders)
  if (typeof exported.patchQuotaReaders === 'function') overrides.patchQuotaReaders = /** @type {NonNullable<RuntimeOverrides['patchQuotaReaders']>} */ (exported.patchQuotaReaders)
  return overrides
}

const transport = pickTransport()
if (!transport) {
  console.error('[orbit runtime] started without a parent channel (process.parentPort or an IPC channel); exiting')
  process.exit(1)
}
const channel = /** @type {Transport} */ (transport)

/** @type {RuntimeService | null} */
let service = null
/** @type {typeof import('./runtime-protocol.mts') | null} */
let protocol = null
let exiting = false
/** @type {unknown[]} */
const early = []
/** @type {Map<string, (approved: boolean) => void>} */
const approvals = new Map()
/** @type {Map<string, (route: string | null) => void>} */
const proxyLookups = new Map()
let proxySerial = 0

/**
 * The system proxy route for `url` (provider-network.mts's systemProxy): Electron's session, which knows PAC files,
 * lives in main only, so main is asked; no answer within 3 s is null (the registry fallback follows).
 * @param {string} url
 * @returns {Promise<string | null>}
 */
function resolveProxy(url) {
  return new Promise((resolve) => {
    const id = `proxy-${++proxySerial}`
    /** @param {string | null} route */
    const answered = (route) => { clearTimeout(timer); proxyLookups.delete(id); resolve(route) }
    const timer = setTimeout(() => answered(null), 3000)
    timer.unref()
    proxyLookups.set(id, answered)
    if (!post({ t: 'resolve-proxy', id, url })) answered(null)
  })
}

/**
 * Posts a message; a message that cannot be sent is reported on stderr instead (the parent may be gone).
 * @param {FromChild} message
 * @param {() => void} [done]
 * @returns {boolean} whether it was handed to the channel
 */
function post(message, done) {
  try { channel.post(message, done); return true } catch (error) {
    console.error(`[orbit runtime] could not send ${message.t}: ${plainError(error).message}`)
    return false
  }
}

/** @param {LogLevel} level @param {string} text */
function log(level, text) {
  if (!post({ t: 'log', level, text })) console[level](`[orbit runtime] ${text}`)
}

/**
 * Sends the last message and ends the process; the exit also happens if the message never leaves.
 * @param {FromChild} message
 * @param {number} code
 */
function finish(message, code) {
  exiting = true
  const exit = () => process.exit(code)
  setTimeout(exit, 1000).unref()
  if (!post(message, exit)) exit()
}

/** @param {unknown} error */
function fatal(error) {
  if (exiting) return
  const wire = protocol ? protocol.serializeError(error) : plainError(error)
  console.error(`[orbit runtime] failed before it was ready: ${wire.stack || wire.message}`)
  finish({ t: 'fatal', error: wire }, 1)
}

// Uncaught errors after `ready` reach main (its log and the window's runtime status) at most once a second: the first
// at once, the ones after it within the second as one report of their number and the last of them.
const UNCAUGHT_EVERY_MS = 1000
/** @type {{ error: WireError, count: number } | null} */
let heldError = null
/** @type {NodeJS.Timeout | null} */
let uncaughtWindow = null

/** @param {WireError} error @param {number} count */
function sendUncaught(error, count) {
  if (!post({ t: 'uncaught', error, count })) console.error(`[orbit runtime] uncaught error${count > 1 ? ` (${count})` : ''}: ${error.stack || error.message}`)
  uncaughtWindow = setTimeout(() => {
    uncaughtWindow = null
    const held = heldError
    heldError = null
    if (held) sendUncaught(held.error, held.count)
  }, UNCAUGHT_EVERY_MS)
  uncaughtWindow.unref()
}

/** @param {unknown} error */
function crashed(error) {
  if (!service) return fatal(error)
  // After `ready` a stray error is reported, not fatal: the runs in progress keep going, as they did inside main.
  const wire = protocol ? protocol.serializeError(error) : plainError(error)
  if (uncaughtWindow) heldError = { error: wire, count: (heldError?.count ?? 0) + 1 }
  else sendUncaught(wire, 1)
}
process.on('uncaughtException', crashed)
process.on('unhandledRejection', crashed)

/**
 * @param {import('./runtime-protocol.mts').CallMessage} message
 * @param {RuntimeService} active
 */
async function answer(message, active) {
  const { id } = message
  const protocolModule = /** @type {typeof import('./runtime-protocol.mts')} */ (protocol)
  /** @type {FromChild} */
  let reply
  try { reply = { t: 'result', id, ok: true, value: await active.call(message.channel, message.args) } }
  catch (error) { reply = { t: 'result', id, ok: false, error: protocolModule.serializeError(error) } }
  try { channel.post(reply) } catch (error) {
    // A value the channel cannot clone (a function, a class instance) must not leave the caller waiting.
    post({ t: 'result', id, ok: false, error: protocolModule.serializeError(new Error(`The result of ${message.channel} could not be sent: ${plainError(error).message}`)) })
  }
}

let shuttingDown = false
/** @param {ShutdownMode} mode @param {RuntimeService} active */
function shutdown(mode, active) {
  if (shuttingDown || exiting) return
  shuttingDown = true
  // What still runs after the shutdown (a tree that would not die in time) is reported last, for main to kill.
  const done = (/** @type {string[]} */ marked) => { post({ t: 'processes', processes: active.processes() }); finish({ t: 'shutdown-done', marked }, 0) }
  active.shutdown(mode).then(
    ({ marked }) => done(marked),
    (error) => { log('error', `shutdown failed: ${plainError(error).message}`); done([]) },
  )
}

/** @param {unknown} value @returns {string} */
function describe(value) {
  try { return String(JSON.stringify(value)).slice(0, 200) } catch { return typeof value }
}

/** @param {unknown} raw */
function receive(raw) {
  const active = service
  if (!active || !protocol) { early.push(raw); return }
  const message = protocol.parseToChild(raw)
  if (!message) { log('warn', `ignored a message that is not a runtime message: ${describe(raw)}`); return }
  switch (message.t) {
    case 'call': void answer(message, active); break
    case 'approval-result': { const resolve = approvals.get(message.id); approvals.delete(message.id); resolve?.(message.approved); break }
    case 'renderer-healthy': void active.rendererHealthy(message.info); break
    case 'shutdown': shutdown(message.mode, active); break
    case 'proxy-result': proxyLookups.get(message.id)?.(message.route); break
  }
}

// The parent is gone (its process exited, or the IPC channel closed): stop the runs, save, exit. Only a
// child_process.fork parent gets here: under utilityProcess Chromium terminates this process when main dies, before the
// channel or the watchdog could tell, so a crash of main never gets this graceful shutdown.
function orphaned() {
  if (exiting) return
  exiting = true
  for (const resolve of approvals.values()) resolve(false)
  approvals.clear()
  const exit = () => process.exit(0)
  setTimeout(exit, 5000).unref()
  if (service) service.shutdown('quit').then(exit, exit)
  else exit()
}
if (channel.kind === 'fork') process.on('disconnect', orphaned)
const parentPid = Number(fromMain.parentPid) || process.ppid
const watchdog = setInterval(() => {
  try { process.kill(parentPid, 0) } catch (error) { if (/** @type {{ code?: unknown }} */ (error).code === 'ESRCH') orphaned() }
}, 1000)
watchdog.unref()
for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => { if (service) shutdown('quit', service); else process.exit(0) })
}

channel.listen(receive)

try {
  // The command line wins over the environment.
  const userData = argument('--user-data') || fromMain.userData
  if (!userData) throw new Error('The runtime needs a profile folder: set ORBIT_USER_DATA_DIR or pass --user-data <folder>')
  const repoRoot = argument('--repo-root') || fromMain.repoRoot || path.join(__dirname, '..')
  const overrides = loadFixtures(process.env.ORBIT_RUNTIME_FIXTURES)
  protocol = require('./runtime-protocol.mts')
  require('./provider-network.mts').setProxyResolver(resolveProxy)
  const { createRuntimeService } = require('./runtime-host.mts')
  service = createRuntimeService({
    userData: path.resolve(userData),
    repoRoot: path.resolve(repoRoot),
    emit: (channelName, payload) => { channel.post({ t: 'event', channel: channelName, payload }) },
    requestApproval: (/** @type {ApprovalWire} */ wire) => new Promise((resolve) => {
      const { id, ...request } = wire
      approvals.set(id, resolve)
      if (!post({ t: 'approval', id, request })) { approvals.delete(id); resolve(false) }
    }),
    cancelApproval: (id) => {
      const resolve = approvals.get(id)
      approvals.delete(id)
      resolve?.(false)
      post({ t: 'approval-cancel', id })
    },
    log,
    onProcesses: (processes) => { post({ t: 'processes', processes }) },
    ...(overrides ? { overrides } : {}),
  })
  post({ t: 'ready', pid: process.pid, ms: sinceStart(), protocol: protocol.PROTOCOL_VERSION })
  for (const raw of early.splice(0)) receive(raw)
} catch (error) {
  fatal(error)
}
