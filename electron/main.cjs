// @ts-check
const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, utilityProcess } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fingerprints, rendererHash } = require('./fingerprint.cjs')
const { createIpcHandlers, registerIpcHandlers } = require('./ipc-handlers.cjs')
const { createRuntimeClient, utilityFork } = require('./runtime-client.cjs')
const { ERROR_CODES } = require('./runtime-protocol.mts')
const git = require('./git.mts')
const { SKILL_SCHEME, SKILLS_DIR, resolvePackageFile, mimeType } = require('./skill-files.mts')

// The shell. Main keeps the window, the dialogs, `shell`, the health reports and the restarts; the runtime (agents,
// stores, providers, quotas, the Orbit MCP server) runs in a child process that electron/runtime-client.cjs drives
// (ORBIT_RUNTIME_MODE=inprocess builds it inside this process instead). In child mode main loads no runtime module:
// what it requires is SHELL_FILES of electron/fingerprint.cjs, and a change there is the only one that needs a full
// relaunch; a runtime change restarts the runtime process (`--restart-runtime`) with the window open.

/** @typedef {import('./ipc-handlers.cjs').GitContext} GitContext */
/** @typedef {import('./ipc-handlers.cjs').RuntimeRestartResult} RuntimeRestartResult */
/** @typedef {import('./runtime-client.cjs').RuntimeClient} RuntimeClient */
/** @typedef {import('./runtime-client.cjs').RuntimeStatus} RuntimeStatus */
/** @typedef {import('./runtime-protocol.mts').ApprovalRequestWire} ApprovalRequestWire */
/** @typedef {import('./runtime-protocol.mts').RestartLevel} RestartLevel */
/** @typedef {import('./runtime-protocol.mts').ShutdownMode} ShutdownMode */
/**
 * The runtime part of a health report: which process serves the runtime, whether it is ready, how long its start or
 * restart took.
 * @typedef {{ mode: 'child' | 'inprocess', ready: boolean, pid: number | null, ms: number | null }} RuntimeHealth
 */
/**
 * What one health report adds to the fixed fields of healthPayload: the verdict, the failure, or the timings of a
 * healthy start.
 * @typedef {object} HealthResult
 * @property {boolean} [ok] false unless given (healthPayload's default)
 * @property {string} [error]
 * @property {number} [ipcMs]
 * @property {number} [readyMs]
 * @property {string} [url]
 * @property {RuntimeHealth} [runtime]
 */
/**
 * One start, restart or reload of this process, each with its own health report: the first is the process start
 * (level full), then every runtime restart and renderer reload.
 * @typedef {{ generation: number, level: RestartLevel, restartedAt: number }} Generation
 */
/** @typedef {'relaunch' | 'restart-runtime' | 'reload-renderer'} RestartSignal */
/** @typedef {{ ok: boolean, value: string }} CommandResult `value` is trimmed stdout, or stderr when stdout is empty. */

const isDev = process.env.ORBIT_DEV === '1'
const repoRoot = path.join(__dirname, '..')
const RELAUNCH_FLAG = '--relaunch'
const RESTART_RUNTIME_FLAG = '--restart-runtime'
const RELOAD_RENDERER_FLAG = '--reload-renderer'
const SIGNAL_FLAGS = [RELAUNCH_FLAG, RESTART_RUNTIME_FLAG, RELOAD_RENDERER_FLAG]
// Run from the repository the runtime is a child process, so new runtime code loads without closing the window; a
// packaged build, which never upgrades itself, keeps it inside main unless ORBIT_RUNTIME_MODE=child asks otherwise.
const requestedMode = process.env.ORBIT_RUNTIME_MODE
/** @type {'child' | 'inprocess'} */
const runtimeMode = requestedMode === 'child' || requestedMode === 'inprocess' ? requestedMode : (app.isPackaged ? 'inprocess' : 'child')
if (requestedMode && requestedMode !== runtimeMode) {
  console.warn(`[orbit] ORBIT_RUNTIME_MODE=${requestedMode} is not a mode (child, inprocess); using ${runtimeMode}`)
}
// Shells started by Electron, a VS Code host or an agent command carry this variable, and app.relaunch() passes the
// environment on: with it set the next Orbit would start as a plain Node process without a window.
delete process.env.ELECTRON_RUN_AS_NODE
// The same for the names of an agent's run (electron/resume.mts restartEnv): an Orbit started by the self-upgrade
// watcher inherits them from the agent's command. They describe a run of an earlier process, never this one, and
// without a restart host nothing would override them in the next agents' shells.
for (const name of ['ORBIT_RUN_ID', 'ORBIT_CHAT_ID', 'ORBIT_PROJECT_ID', 'ORBIT_AGENT_ID', 'ORBIT_RESUME_FILE', 'ORBIT_RESTART_SOURCE']) delete process.env[name]
// Self-upgrade health report: one per generation (the start, then every runtime restart and renderer reload), written
// once that generation is healthy or at its first failure. ORBIT_HEALTH_FILE overrides the path; "0" (smoke, tests)
// disables the file (the checks still run: the runtime is told when a start was healthy either way).
const healthFile = process.env.ORBIT_HEALTH_FILE === undefined
  ? path.join(repoRoot, 'artifacts', 'self-upgrade-health.json')
  : (process.env.ORBIT_HEALTH_FILE && process.env.ORBIT_HEALTH_FILE !== '0' ? path.resolve(process.env.ORBIT_HEALTH_FILE) : null)
const startedAt = Date.now()

/** @param {unknown} error @returns {string} */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
/**
 * The runtime client's error when a quit or a relaunch ended a start, a restart or a call: not a failure of the runtime.
 * @param {unknown} error
 * @returns {boolean}
 */
const isShuttingDown = (error) => /** @type {{ code?: unknown } | null} */ (error !== null && typeof error === 'object' ? error : null)?.code === ERROR_CODES.shuttingDown
/** Why a runtime-only restart is refused once the shell files on disk are not those this process loaded. */
const SHELL_CHANGED = 'shell files changed — relaunch Orbit'

/**
 * The code this process runs, as fingerprint.cjs hashes it; null when the files cannot be read.
 * @returns {{ shell: string, runtime: string } | null}
 */
function codeHashes() {
  try { return fingerprints(repoRoot) } catch (error) {
    console.error(`[orbit] could not fingerprint the code: ${errorMessage(error)}`)
    return null
  }
}
/** @type {number | null} */
let runtimeMs = null

/** @type {RuntimeClient | null} */
let client = null
/** @type {Promise<void> | null} */
let relaunching = null
/** @type {Promise<RuntimeRestartResult> | null} */
let runtimeRestart = null
/** @type {Promise<RuntimeRestartResult> | null} */
let nextRuntimeRestart = null
/** @type {Promise<unknown>} */
let approvalQueue = Promise.resolve()

let generations = 0
/** @type {Set<number>} */
const reported = new Set()
let lastReportOk = false
/** @type {() => void} */
let firstReported = () => {}
/** Resolves once the start of this process has its report (healthy or not); restart signals wait for it. */
const started = new Promise((resolve) => { firstReported = () => resolve(undefined) })

/** @param {RestartLevel} level @returns {Generation} */
function beginGeneration(level) {
  generations += 1
  return { generation: generations, level, restartedAt: generations === 1 ? startedAt : Date.now() }
}
const startGeneration = beginGeneration('full')
/** The generation whose renderer check is pending: did-fail-load and a renderer crash are reported against it. */
let rendererGeneration = startGeneration

if (process.env.ORBIT_USER_DATA) app.setPath('userData', path.resolve(process.env.ORBIT_USER_DATA))
// A skill's pages load from orbit-skill://<package>/<file> (serveSkillPages): a standard, secure scheme of its own, so a
// page is an origin apart from the window's. Schemes are registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: SKILL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

/**
 * Which restart a second instance asks the running one for. additionalData is the reliable channel (Chromium may
 * rewrite argv); the strongest request wins.
 * @param {unknown} argv
 * @param {unknown} additionalData
 * @returns {RestartSignal | null}
 */
function restartSignal(argv, additionalData) {
  const data = /** @type {{ relaunch?: unknown, restartRuntime?: unknown, reloadRenderer?: unknown }} */ (additionalData && typeof additionalData === 'object' ? additionalData : {})
  /** @param {string} flag */
  const has = (flag) => Array.isArray(argv) && argv.includes(flag)
  if (has(RELAUNCH_FLAG) || data.relaunch === true) return 'relaunch'
  if (has(RESTART_RUNTIME_FLAG) || data.restartRuntime === true) return 'restart-runtime'
  if (has(RELOAD_RENDERER_FLAG) || data.reloadRenderer === true) return 'reload-renderer'
  return null
}

/**
 * @param {unknown} argv
 * @param {unknown} additionalData
 * @returns {boolean}
 */
function isRelaunchSignal(argv, additionalData) {
  return restartSignal(argv, additionalData) === 'relaunch'
}

const ownSignal = restartSignal(process.argv, null)
if (!app.requestSingleInstanceLock({ relaunch: ownSignal === 'relaunch', restartRuntime: ownSignal === 'restart-runtime', reloadRenderer: ownSignal === 'reload-renderer' })) {
  // The running instance got the second-instance event: it restarts what the flag asks for, or comes to the front.
  console.log(ownSignal ? `[orbit] ${ownSignal} signal delivered to the running Orbit` : '[orbit] Orbit is already running; bringing its window to the front')
  app.quit()
  // @ts-expect-error -- a top-level return is valid CommonJS (Node runs it), but TypeScript's grammar has no CommonJS exception (TS1108).
  return
}
app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  const signal = restartSignal(argv, additionalData)
  if (signal) { handleSignal(signal); return }
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})

// The shell's hash is that of the files this process loaded at start; the runtime's is taken again before each fork.
const bootHashes = codeHashes()
/** @type {string | null} */
let runtimeHash = bootHashes?.runtime ?? null

/**
 * Whether the shell files on disk differ from those this process loaded (fingerprint.cjs's SHELL_FILES: main, the
 * preload, the IPC contract, the runtime protocol, …). A runtime forked then would load the new ones next to the old
 * shell; only a relaunch loads both. Unknown hashes count as unchanged.
 * @param {{ shell: string } | null} [current] the hashes of the files on disk now
 * @returns {boolean}
 */
function shellChanged(current = codeHashes()) {
  return Boolean(current && bootHashes && current.shell !== bootHashes.shell)
}

/**
 * `--relaunch` restarts the process; `--restart-runtime` only the runtime process (a relaunch in inprocess mode);
 * `--reload-renderer` only the page. The last two wait for the start of this process to be reported, so their report
 * is a later generation.
 * @param {RestartSignal} signal
 */
function handleSignal(signal) {
  if (signal === 'relaunch') { void relaunchApp('second-instance'); return }
  if (signal === 'restart-runtime') {
    if (runtimeMode === 'inprocess') { void relaunchApp('second-instance: --restart-runtime with the runtime inside main'); return }
    void started.then(() => restartRuntime('second-instance'))
    return
  }
  void started.then(() => reloadRenderer('second-instance'))
}

/**
 * Throws unless `workspace` is an existing absolute folder; returns its real path.
 * @param {unknown} workspace
 * @returns {string}
 */
function validateWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Choose an absolute project folder')
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Project folder does not exist')
  return fs.realpathSync.native(workspace)
}

/**
 * Two real paths name the same folder; on Windows the case does not matter (workspaceKey of storage.mts, which the
 * shell does not load).
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameFolder(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Commit the repository is at, read from .git without spawning git; a worktree's .git file is followed.
 * @param {string} [root]
 * @returns {string | null}
 */
function readHeadCommit(root = repoRoot) {
  try {
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))
      if (!pointer) return null
      gitDir = path.resolve(root, pointer[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)
    if (!ref) return head
    const refName = ref[1].trim()
    const refFile = path.join(gitDir, ...refName.split('/'))
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim()
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split(/\r?\n/)
    const line = packed.find(entry => entry.endsWith(` ${refName}`))
    return line ? line.split(' ')[0] : null
  } catch {
    return null
  }
}

/**
 * Modification time of the renderer build this process serves; the upgrade script compares it with the build it made.
 * @param {string} [root]
 * @returns {number | null}
 */
function distMtime(root = repoRoot) {
  try { return Math.round(fs.statSync(path.join(root, 'dist', 'index.html')).mtimeMs) } catch { return null }
}

/** @returns {RuntimeHealth} */
function runtimeHealth() {
  const status = client?.status()
  return { mode: runtimeMode, ready: status?.state === 'ready', pid: status?.pid ?? null, ms: runtimeMs }
}

/**
 * The renderer inputs the window runs, as fingerprint.cjs hashes them: the hash dist/orbit-build.json records for the
 * build main serves (the self-upgrade script and `npm run build` write it), else — no record, or the Vite dev server —
 * the inputs on disk now. The self-upgrade script compares it with the inputs on disk to decide whether the window
 * needs a reload, and rolls src/ back only to a snapshot with this hash. Null when neither can be read.
 * @returns {{ hash: string | null, source: 'build' | 'files' | null }}
 */
function windowRenderer() {
  if (!isDev) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dist', 'orbit-build.json'), 'utf8'))
      if (record && Number(record.version) >= 2 && typeof record.rendererHash === 'string' && /^[0-9a-f]{40}$/.test(record.rendererHash)) return { hash: record.rendererHash, source: 'build' }
    } catch { /* No build record: the inputs on disk. */ }
  }
  try { return { hash: rendererHash(repoRoot), source: 'files' } } catch (error) {
    console.error(`[orbit] could not fingerprint the renderer inputs: ${errorMessage(error)}`)
    return { hash: null, source: null }
  }
}

/** @param {Generation} generation @param {HealthResult} extra */
function healthPayload(generation, extra) {
  const renderer = windowRenderer()
  return {
    ok: false,
    pid: process.pid,
    startedAt,
    writtenAt: Date.now(),
    level: generation.level,
    generation: generation.generation,
    restartedAt: generation.restartedAt,
    commit: readHeadCommit(),
    distMtime: distMtime(),
    shellHash: bootHashes?.shell ?? null,
    runtimeHash,
    rendererHash: renderer.hash,
    rendererSource: renderer.source,
    runtime: runtimeHealth(),
    version: app.getVersion(),
    electron: process.versions.electron,
    execPath: process.execPath,
    args: process.argv.slice(1),
    userData: app.getPath('userData'),
    dev: isDev,
    ...extra,
  }
}

/**
 * One report per generation, and the first result wins: a failure before the window was ready is not undone by a
 * later reload that happens to work.
 * @param {Generation} generation
 * @param {HealthResult} extra
 * @returns {boolean} whether this call reported the generation
 */
function writeHealth(generation, extra) {
  if (reported.has(generation.generation)) return false
  reported.add(generation.generation)
  const payload = healthPayload(generation, extra)
  lastReportOk = payload.ok === true
  if (healthFile) {
    try {
      fs.mkdirSync(path.dirname(healthFile), { recursive: true })
      fs.writeFileSync(healthFile, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      console.error(`[orbit] could not write ${healthFile}: ${errorMessage(error)}`)
    }
  }
  console.log(`[orbit] health ${payload.ok ? 'ok' : 'failed'} (${generation.level}, generation ${generation.generation})${payload.error ? `: ${payload.error}` : ''} (pid ${process.pid})`)
  if (payload.ok) recordRunning(payload.rendererHash)
  if (generation.generation === startGeneration.generation) firstReported()
  return true
}

/**
 * A healthy start, runtime restart or renderer reload from the repository: the self-upgrade script records the sources
 * that now run as the rollback base (`--record-running`, with this instance and the hashes of the code it runs — the
 * renderer hash of the report just written — since the health file may be elsewhere than the script reads by default).
 * A reload records too: a later rollback must not put src/ back to what an earlier start ran. Detached and
 * fire-and-forget; the script checks the files still are that code. The system's node runs it, or Electron's binary
 * as Node when there is none on PATH.
 * @param {string | null} renderer the rendererHash of the healthy report
 */
function recordRunning(renderer) {
  if (!healthFile || app.isPackaged) return
  const script = path.join(repoRoot, 'scripts', 'self-upgrade.cjs')
  if (!fs.existsSync(script)) return
  const args = [script, '--record-running', '--pid', String(process.pid), '--started-at', String(startedAt)]
  if (bootHashes?.shell) args.push('--shell-hash', bootHashes.shell)
  if (runtimeHash) args.push('--runtime-hash', runtimeHash)
  if (renderer) args.push('--renderer-hash', renderer)
  /** @param {string} file @param {NodeJS.ProcessEnv} env @param {(error: Error) => void} onError */
  const start = (file, env, onError) => {
    const child = spawn(file, args, { cwd: os.tmpdir(), env, detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', onError)
    child.unref()
  }
  /** @param {Error} error */
  const report = (error) => console.warn(`[orbit] could not record the running sources: ${error.message}`)
  try {
    start('node', { ...process.env }, (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') { report(error); return }
      try { start(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, report) } catch (fallback) { report(/** @type {Error} */ (fallback)) }
    })
  } catch (error) {
    report(/** @type {Error} */ (error))
  }
}

/**
 * The page loaded; now it must answer one IPC call through the preload bridge and mount its UI.
 * @param {import('electron').BrowserWindow} win
 * @returns {Promise<{ ipcMs: number, readyMs: number }>}
 */
async function verifyRendererHealth(win) {
  /** @param {string} code */
  const evaluate = (code) => win.webContents.executeJavaScript(code, true)
  const began = Date.now()
  const reply = await evaluate('window.orbit && typeof window.orbit.ping === "function" ? window.orbit.ping() : Promise.reject(new Error("preload bridge is missing"))')
  if (!reply || reply.pid !== process.pid) throw new Error('IPC round trip returned an unexpected reply')
  const ipcMs = Date.now() - began
  // React mounts asynchronously: a window that stays empty is a failed upgrade although the page "loaded".
  const deadline = Date.now() + 5000
  let mounted = false
  while (!mounted && Date.now() < deadline) {
    mounted = await evaluate('(document.getElementById("root") || {}).childElementCount > 0')
    if (!mounted) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!mounted) throw new Error('renderer did not mount within 5 s')
  return { ipcMs, readyMs: Date.now() - began }
}

/**
 * The report of this process's start: the renderer answered and mounted, AND the runtime reported ready. A healthy
 * start is told to the runtime, which then continues a task a restart interrupted.
 * @param {import('electron').BrowserWindow} win
 * @param {Generation} generation
 */
async function reportStart(win, generation) {
  const renderer = verifyRendererHealth(win).catch((error) => { throw new Error(`renderer check failed: ${errorMessage(error)}`) })
  const runtime = (client ? client.ready : Promise.reject(new Error('no runtime client'))).catch((error) => {
    throw isShuttingDown(error) ? error : new Error(`runtime failed to start: ${errorMessage(error)}`)
  })
  try {
    const [check, ready] = await Promise.all([renderer, runtime])
    runtimeMs = ready.ms
    const healthy = writeHealth(generation, { ok: true, ...check, url: win.webContents.getURL(), runtime: { mode: runtimeMode, ready: true, pid: ready.pid, ms: ready.ms } })
    if (healthy) client?.rendererHealthy({ level: 'full', commit: readHeadCommit() })
  } catch (error) {
    // A quit or a relaunch ended the start (and may be closing the window): that is no failed start, and a relaunch's
    // next process reports its own.
    if (isShuttingDown(error) || quitting || relaunching) {
      console.log(`[orbit] no health report for the start: Orbit is shutting down (${errorMessage(error)})`)
      return
    }
    writeHealth(generation, { ok: false, error: errorMessage(error) })
  }
}

/**
 * The report of a renderer reload: the new page answered and mounted; the runtime was not touched.
 * @param {import('electron').BrowserWindow} win
 * @param {Generation} generation
 */
async function reportRenderer(win, generation) {
  try {
    const check = await verifyRendererHealth(win)
    writeHealth(generation, { ok: true, ...check, url: win.webContents.getURL() })
  } catch (error) {
    writeHealth(generation, { ok: false, error: `renderer check failed: ${errorMessage(error)}` })
  }
}

/**
 * Stops the runtime: its runs end (a restart marks the run whose agent asked for it as `restarting`), its CLI trees
 * are killed and every store is saved; a runtime that does not finish in time has its process tree killed.
 * @param {ShutdownMode} mode
 * @returns {Promise<{ marked: string[] }>}
 */
function shutdownRuntime(mode) {
  return client ? client.shutdown(mode) : Promise.resolve({ marked: [] })
}

/**
 * Command line of the next instance: this one without the restart flags, so the new process is an ordinary start.
 * @param {string[]} [argv]
 * @returns {string[]}
 */
function relaunchArgs(argv = process.argv) {
  return argv.slice(1).filter(arg => !SIGNAL_FLAGS.includes(arg))
}

/**
 * Restart this process in place (self-upgrade of the shell, or `Orbit.cmd --relaunch` while Orbit runs). The runtime
 * shuts down for a restart first, so its state is saved and its processes are gone before the new instance starts.
 * @param {string} reason
 * @returns {Promise<void>}
 */
function relaunchApp(reason) {
  if (relaunching) return relaunching
  console.log(`[orbit] relaunch requested (${reason})`)
  relaunching = (async () => {
    try { await shutdownRuntime('restart') } catch (error) { console.error(`[orbit] runtime shutdown before relaunch failed: ${errorMessage(error)}`) }
    app.relaunch({ args: relaunchArgs() })
    app.exit(0)
  })()
  return relaunching
}

/**
 * Reloads a window's page and waits until it has loaded again.
 * @param {import('electron').BrowserWindow} win
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function reloadWindow(win, timeoutMs) {
  return new Promise((resolve, reject) => {
    const contents = win.webContents
    const loaded = () => finish(null)
    /** @param {unknown} _event @param {number} code @param {string} description @param {string} _url @param {boolean} isMainFrame */
    const failed = (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame !== false && code !== -3) finish(new Error(`the page failed to load (${code}): ${description}`))
    }
    const timer = setTimeout(() => finish(new Error(`the page did not load within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    /** @param {Error | null} error */
    function finish(error) {
      clearTimeout(timer)
      contents.removeListener('did-finish-load', loaded)
      contents.removeListener('did-fail-load', failed)
      if (error) reject(error); else resolve()
    }
    contents.on('did-finish-load', loaded)
    contents.on('did-fail-load', failed)
    contents.reloadIgnoringCache()
  })
}

/**
 * After a runtime restart the window must still answer and show its UI (its calls went to the old runtime); one reload
 * is allowed before that counts as a failed restart. Null when no window is open.
 * @returns {Promise<{ ipcMs: number, readyMs: number, url: string } | null>}
 */
async function checkRendererAfterRestart() {
  const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
  if (!win) return null
  try {
    return { ...(await verifyRendererHealth(win)), url: win.webContents.getURL() }
  } catch (error) {
    console.warn(`[orbit] the window did not pass its check after the runtime restart (${errorMessage(error)}); reloading it once`)
  }
  try {
    await reloadWindow(win, 15000)
    return { ...(await verifyRendererHealth(win)), url: win.webContents.getURL() }
  } catch (error) {
    throw new Error(`renderer check failed after the runtime restart and one reload: ${errorMessage(error)}`)
  }
}

/**
 * A new runtime process with the code on disk, the window stays (self-upgrade of runtime code, `--restart-runtime`, or
 * the window's own request). Its health report is a generation of level `runtime`: the new runtime is ready and the
 * window passes its check again (after one reload at most). A healthy one is told to the new runtime, which then
 * continues a task the restart interrupted.
 * @param {string} reason
 * @returns {Promise<RuntimeRestartResult>}
 */
function restartRuntime(reason) {
  if (runtimeMode === 'inprocess') {
    return Promise.resolve({ ok: false, ms: 0, pid: null, error: 'The runtime runs inside the main process (ORBIT_RUNTIME_MODE=inprocess): relaunch Orbit to load new runtime code' })
  }
  const active = client
  if (!active) return Promise.resolve({ ok: false, ms: 0, pid: null, error: 'The runtime has not started yet' })
  // A quit or a relaunch ends the runtime anyway, and a report of this restart would read as a failed upgrade.
  if (quitting || relaunching) return Promise.resolve({ ok: false, ms: 0, pid: null, error: 'Orbit is shutting down' })
  if (runtimeRestart) {
    // The restart under way may have loaded older code than this request is about, and its report would predate the
    // request: one more restart follows it, shared by every request that arrives meanwhile.
    nextRuntimeRestart ??= runtimeRestart.then(() => { nextRuntimeRestart = null; return restartRuntime(reason) })
    return nextRuntimeRestart
  }
  const generation = beginGeneration('runtime')
  // Refused before the running runtime is touched: it keeps serving the window. The report answers whoever asked for
  // the restart (the self-upgrade watcher waits for one).
  if (shellChanged()) {
    console.warn(`[orbit] runtime restart refused (${reason}): ${SHELL_CHANGED}`)
    writeHealth(generation, { ok: false, error: `runtime restart refused: ${SHELL_CHANGED}`, runtime: runtimeHealth() })
    return Promise.resolve({ ok: false, ms: 0, pid: null, error: SHELL_CHANGED })
  }
  console.log(`[orbit] runtime restart requested (${reason})`)
  const restart = active.restart(reason).then(async ({ ms, pid }) => {
    runtimeMs = ms
    const runtime = { mode: runtimeMode, ready: true, pid, ms }
    /** @type {RuntimeRestartResult} */
    let result = { ok: true, ms, pid }
    try {
      const check = await checkRendererAfterRestart()
      // The new runtime may have died while the window was checked: healthy means that very process is still ready.
      const now = active.status()
      if (now.state !== 'ready' || now.pid !== pid) throw new Error(`the new runtime (pid ${pid}) stopped while the window was checked${now.error ? `: ${now.error}` : ''}`)
      if (writeHealth(generation, { ok: true, ...check, runtime })) active.rendererHealthy({ level: 'runtime', commit: readHeadCommit() })
    } catch (error) {
      result = { ok: false, ms, pid, error: errorMessage(error) }
      if (quitting || relaunching) return result
      writeHealth(generation, { ok: false, error: errorMessage(error), runtime: runtimeHealth() })
    }
    return result
  }, (error) => {
    const ms = Date.now() - generation.restartedAt
    /** @type {RuntimeRestartResult} */
    const result = { ok: false, ms, pid: null, error: errorMessage(error) }
    // A quit or a relaunch ended the restart: no report, which the self-upgrade watcher would read as a failed upgrade.
    if (isShuttingDown(error) || quitting || relaunching) {
      console.log(`[orbit] runtime restart ended: Orbit is shutting down (${reason})`)
      return result
    }
    writeHealth(generation, { ok: false, error: `runtime restart failed: ${errorMessage(error)}`, runtime: { mode: runtimeMode, ready: false, pid: null, ms } })
    return result
  })
  runtimeRestart = restart
  void restart.then(() => { if (runtimeRestart === restart) runtimeRestart = null })
  return restart
}

/**
 * Reloads the page of every window with the renderer build on disk; the runtime keeps running. Its health report is a
 * generation of level `renderer`.
 * @param {string} reason
 */
function reloadRenderer(reason) {
  const generation = beginGeneration('renderer')
  console.log(`[orbit] renderer reload requested (${reason})`)
  const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed())
  if (!windows.length) { createWindow(generation); return }
  rendererGeneration = generation
  const [first] = windows
  first.webContents.once('did-finish-load', () => { void reportRenderer(first, generation) })
  for (const win of windows) win.webContents.reloadIgnoringCache()
}

/** @param {string} message @param {{ stack?: string, message?: string } | null | undefined} error */
function reportFatal(message, error) {
  console.error(`[orbit] ${message}: ${error?.stack || error}`)
  writeHealth(startGeneration, { ok: false, error: `${message}: ${error?.message || error}` })
  try { dialog.showErrorBox('Orbit — ошибка в главном процессе', `${message}\n\n${error?.stack || error}`) } catch { /* headless */ }
  void client?.kill()
  app.exit(1)
}

if (healthFile) {
  // Without a handler Electron shows its own dialog and keeps a half-initialised process alive, and the upgrade loop
  // would wait for a health report that never comes. Before the first report a crash ends the process instead.
  process.on('uncaughtException', (error) => {
    if (reported.has(startGeneration.generation)) {
      console.error(`[orbit] uncaught exception: ${error?.stack || error}`)
      try { dialog.showErrorBox('Orbit — ошибка в главном процессе', String(error?.stack || error)) } catch { /* headless */ }
      return
    }
    reportFatal('uncaught exception before the window was ready', error)
  })
}

// The `{ ok, value }` shape getGitContext reads (`value` is stdout, or stderr when stdout is empty, as before); the
// process itself runs through electron/git.mts: neutral cwd, literal pathspecs, 5 s.
/** @param {string[]} args @param {string} cwd @returns {Promise<CommandResult>} */
async function runGit(args, cwd) {
  const result = await git.runGit(cwd, args, { timeoutMs: 5000 })
  return { ok: result.ok, value: result.value || result.stderr }
}

/** @param {string} file @param {string[]} args @param {string} cwd @returns {Promise<CommandResult>} */
function runProcess(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, value: (stdout || stderr || '').trim() })
    })
  })
}

/** @param {string} remote @returns {string} */
function repositoryName(remote) {
  const normalized = remote.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repository'
  return normalized.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'repository'
}

/** @param {unknown} remote @returns {Promise<GitContext | { error: string } | null>} */
async function cloneGitWorkspace(remote) {
  const address = String(remote || '').trim()
  if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(address)) return { error: 'Only HTTPS, SSH and git@ remotes are supported' }
  const parent = await dialog.showOpenDialog({ title: 'Choose a parent folder for the Git project', properties: ['openDirectory', 'createDirectory'] })
  if (parent.canceled || !parent.filePaths[0]) return null
  const target = path.join(parent.filePaths[0], repositoryName(address))
  try {
    if (fs.existsSync(target)) return { error: `Destination already exists: ${target}` }
  } catch {
    return { error: 'Could not inspect the destination folder' }
  }
  const result = await runProcess('git', ['clone', '--', address, target], parent.filePaths[0])
  if (!result.ok) return { error: result.value || 'git clone failed' }
  return getGitContext(target)
}

/** @param {unknown} workspace @returns {Promise<GitContext>} */
async function getGitContext(workspace) {
  const folder = validateWorkspace(workspace)
  const root = await runGit(['rev-parse', '--show-toplevel'], folder)
  if (!root.ok) return { connected: false, path: folder, workspaceMode: 'folder', branch: 'folder workspace', changedFiles: 0 }
  const selectedPath = fs.realpathSync.native(folder)
  const gitRoot = fs.realpathSync.native(root.value)
  if (!sameFolder(selectedPath, gitRoot)) {
    const relative = path.relative(gitRoot, selectedPath) || '.'
    const scopedStatus = await runGit(['status', '--porcelain', '--', relative], gitRoot)
    return { connected: false, path: selectedPath, gitRoot, workspaceMode: 'folder', branch: 'direct folder lane', changedFiles: scopedStatus.value ? scopedStatus.value.split(/\r?\n/).filter(Boolean).length : 0 }
  }

  const [branch, status, lastCommit] = await Promise.all([
    runGit(['branch', '--show-current'], folder),
    runGit(['status', '--porcelain'], folder),
    runGit(['log', '-1', '--format=%h|%s'], folder),
  ])
  if (!branch.ok || !status.ok) return { connected: false, path: gitRoot, branch: 'Git inspection failed', changedFiles: 0, lastCommit: status.value || branch.value }

  return {
    connected: true,
    path: root.value,
    gitRoot,
    workspaceMode: 'git-root',
    branch: branch.value || 'detached HEAD',
    changedFiles: status.value ? status.value.split(/\r?\n/).filter(Boolean).length : 0,
    lastCommit: lastCommit.value || 'No commits yet',
  }
}

/**
 * Every live window's webContents.
 * @param {(webContents: import('electron').WebContents) => void} send
 */
function toWindows(send) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) send(win.webContents)
}

/**
 * What the runtime emits goes to the windows on the same channel; anything else is not a channel of the window.
 * @param {string} channel
 * @param {unknown} payload
 */
function forwardRuntimeEvent(channel, payload) {
  if (channel === 'runtime:event') toWindows(webContents => webContents.send('runtime:event', payload))
  else if (channel === 'quota:update') toWindows(webContents => webContents.send('quota:update', payload))
  else if (channel === 'restart:notice') toWindows(webContents => webContents.send('restart:notice', payload))
  else console.warn(`[orbit] ignored a runtime event on ${channel}: the window has no such channel`)
}

/**
 * The runtime asks before an agent's action (access mode "ask"): one dialog at a time; the signal closes it when the
 * runtime withdraws the question (the run stopped) or its process exits.
 * @param {ApprovalRequestWire} request
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
function showApprovalDialog(request, signal) {
  const pending = approvalQueue.then(async () => {
    if (signal.aborted) return false
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (!window) return false
    const result = await dialog.showMessageBox(window, {
      type: 'question', title: 'Orbit — разрешение на действие',
      message: `${request.agentName}: разрешить действие?`,
      detail: `Проект: ${request.workspace}\nДействие: ${request.tool}\n\n${JSON.stringify(request.arguments, null, 2)}`,
      buttons: ['Отклонить', 'Разрешить один раз'], defaultId: 0, cancelId: 0, noLink: true, signal,
    })
    return !signal.aborted && result.response === 1
  })
  approvalQueue = pending.catch(() => false)
  return pending
}

/** @returns {RuntimeClient} */
function startRuntime() {
  let forks = 0
  return createRuntimeClient({
    mode: runtimeMode,
    userData: app.getPath('userData'),
    repoRoot,
    fork: utilityFork(utilityProcess),
    // The hash of the runtime code a process is about to load: the boot hash for the first, the files on disk after.
    // A later fork (a restart, the automatic one after a crash) is refused once the shell files changed: the runtime
    // is then stopped with that error until Orbit is relaunched.
    beforeFork: () => {
      if (forks++ === 0) { runtimeHash = bootHashes?.runtime ?? null; return }
      const hashes = codeHashes()
      if (shellChanged(hashes)) throw new Error(SHELL_CHANGED)
      runtimeHash = hashes?.runtime ?? null
    },
    onEvent: forwardRuntimeEvent,
    onApproval: showApprovalDialog,
    // The system proxy (PAC included) for the runtime process, which has no Electron session of its own.
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    onStatus: (status) => toWindows(webContents => webContents.send('runtime:status-changed', status)),
    log: (level, text) => { if (level === 'info') console.log(`[orbit] ${text}`); else console[level](`[orbit] ${text}`) },
  })
}

/** @returns {RuntimeStatus} */
function runtimeStatus() {
  return client ? client.status() : { state: 'starting', mode: runtimeMode, pid: null, since: startedAt, lastRestartMs: null, restarts: 0, retrying: false }
}

/**
 * @param {Generation | null} generation the report this window's first page load gives, if any
 */
function createWindow(generation) {
  const win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0b0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // An action skill's celebration starts its video with sound, with no click first.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  // A skill page (orbit-skill://) stays in its own package: its frame may not be sent to another address, which could
  // carry data away in the URL (the page's CSP, serveSkillPages, already closes fetch, images, forms and other frames).
  win.webContents.on('will-frame-navigate', (details) => {
    const from = details.frame?.url
    if (details.isMainFrame || !from || !skillFrame(from)) return
    if (!sameSkillPackage(from, details.url)) details.preventDefault()
  })

  // Unpackaged, the renderer is ../dist/index.html of this repository (npm run build); packaged, the same path inside app.asar.
  const load = isDev ? win.loadURL('http://127.0.0.1:5173') : win.loadFile(path.join(__dirname, '../dist/index.html'))
  load.catch(() => { /* did-fail-load reports it */ })

  if (generation) rendererGeneration = generation
  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    if (!generation) return
    void (generation.generation === startGeneration.generation ? reportStart(win, generation) : reportRenderer(win, generation))
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    win.show()
    console.error(`Orbit renderer failed to load (${errorCode}): ${errorDescription} — ${validatedURL}`)
    // -3 is ERR_ABORTED: a navigation replaced by another one, not a broken build.
    if (isMainFrame !== false && errorCode !== -3) writeHealth(rendererGeneration, { ok: false, error: `renderer failed to load (${errorCode}): ${errorDescription} — ${validatedURL}` })
  })
  // A crashed renderer leaves a blank window while agents keep running and Stop is unreachable. Reloading
  // restores the chats and runs from saved state; a crash loop gives up after three reloads per minute.
  /** @type {number[]} */
  let reloads = []
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Orbit renderer exited: ${details.reason}`)
    writeHealth(rendererGeneration, { ok: false, error: `renderer exited before it was ready: ${details.reason}` })
    const moment = Date.now()
    reloads = reloads.filter(time => moment - time < 60000)
    if (details.reason === 'clean-exit' || reloads.length >= 3 || win.isDestroyed()) return
    reloads.push(moment)
    win.webContents.reload()
  })
}

// Renderer-callable channels: electron/ipc-contract.cjs lists them; main answers its own (ipc-handlers.cjs) and
// forwards the runtime's to the runtime process. The registration throws before the window exists if they disagree,
// and every handler runs behind the sender guard.
registerIpcHandlers(ipcMain, createIpcHandlers({
  dialog, shell, getGitContext, cloneGitWorkspace, relaunchApp, restartRuntime, runtimeStatus, startedAt,
  setFullScreen: (sender, on) => {
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed()) return false
    const was = win.isFullScreen()
    if (was !== on) win.setFullScreen(on)
    return was
  },
  // Only what Orbit keeps for the user: an attached file, a skill package (or those folders themselves).
  openPath: async (target) => {
    const resolved = path.resolve(String(target || ''))
    const inside = ['attachments', SKILLS_DIR].some((name) => {
      const relative = path.relative(path.join(app.getPath('userData'), name), resolved)
      return !relative.startsWith('..') && !path.isAbsolute(relative)
    })
    if (!target || !inside) throw new Error('Only Orbit attachments and skill packages can be opened')
    return shell.openPath(resolved)
  },
  // The window's runtime restart waits for the start's report, as the --restart-runtime signal does; there is nothing
  // to wait for when restartRuntime refuses anyway (no runtime yet, or it runs inside main).
  whenStarted: () => (client && runtimeMode === 'child' ? started : Promise.resolve()),
  callRuntime: (channel, args) => (client ? client.call(channel, args) : Promise.reject(new Error('The Orbit runtime has not started yet'))),
  isHealthy: () => lastReportOk,
}), { isDev })

// YouTube's embedded player refuses to play without a web Referer ("Video player configuration error", code 153), and a
// page loaded from file:// or orbit-skill:// sends none or its own scheme's: the embed request of a skill page gets one
// here. Requests that carry an http(s) Referer (the player's own ones) are left as they are.
const EMBED_REFERER = 'https://orbit.local/'
function allowVideoEmbeds() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    const referer = headers.Referer || headers.referer
    if (!referer || !/^https?:/i.test(referer)) { delete headers.referer; headers.Referer = EMBED_REFERER }
    callback({ requestHeaders: headers })
  })
}

// What a skill page may reach: its own package, inline code and styles, data: and blob: media, and the YouTube player
// frame; no other host, so a page an agent wrote cannot send what it read anywhere (fetch, images, forms, frames).
const SKILL_PAGE_CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "form-action 'none'", "base-uri 'none'", "object-src 'none'",
].join('; ')
/** @param {string | undefined} url */
const skillFrame = (url) => typeof url === 'string' && url.startsWith(`${SKILL_SCHEME}://`)
/** Whether `to` is a page of the same skill package as `from` (both orbit-skill:// URLs). @param {string} from @param {string} to */
function sameSkillPackage(from, to) {
  try { return skillFrame(to) && new URL(from).host === new URL(to).host } catch { return false }
}

// orbit-skill://<package>/<file>: the file of that skill package folder (electron/skill-files.mts keeps the path inside
// it), read-only and never cached; anything else is 404. The window shows such a page in a sandboxed frame.
function serveSkillPages() {
  const userData = app.getPath('userData')
  protocol.handle(SKILL_SCHEME, async (request) => {
    let file = null
    try {
      const url = new URL(request.url)
      file = resolvePackageFile(userData, url.hostname, decodeURIComponent(url.pathname.replace(/^\/+/, '')))
    } catch { /* A malformed URL is not found. */ }
    if (!file) return new Response('Not found', { status: 404 })
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'content-type': mimeType(file), 'cache-control': 'no-store', 'content-security-policy': SKILL_PAGE_CSP } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

app.whenReady().then(() => {
  allowVideoEmbeds()
  serveSkillPages()
  client = startRuntime()
  createWindow(startGeneration)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null)
  })
}).catch((error) => reportFatal('start-up failed', error))

// Quitting waits for the runtime once: it stops the runs (and their CLI trees) and saves every store, then Orbit quits.
// A relaunch exits without before-quit and shuts the runtime down itself.
let quitting = false
let quitReady = false
app.on('before-quit', (event) => {
  if (quitReady || !client) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  shutdownRuntime('quit')
    .catch((error) => console.error(`[orbit] runtime shutdown before quit failed: ${errorMessage(error)}`))
    .finally(() => { quitReady = true; app.quit() })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

module.exports = {
  RELAUNCH_FLAG, RESTART_RUNTIME_FLAG, RELOAD_RENDERER_FLAG, readHeadCommit, relaunchArgs, isRelaunchSignal, restartSignal,
  shutdownRuntime, restartRuntime, runtimeStatus,
}
