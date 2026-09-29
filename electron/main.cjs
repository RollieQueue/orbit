// @ts-check
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('./runtime.mts')
const { OrbitMemoryStore } = require('./memory.mts')
const { ProjectContextStore } = require('./project-context.mts')
const { CapabilityStore } = require('./capabilities.mts')
const { ProjectIndex } = require('./project-index.mts')
const { RunStore, StateStore } = require('./run-store.mts')
const { workspaceKey } = require('./storage.mts')
const { inspectProviders, runProvider } = require('./providers.mts')
const { QuotaMonitor } = require('./quota.mts')
const { createIpcHandlers, registerIpcHandlers } = require('./ipc-handlers.cjs')
const git = require('./git.mts')

/** @typedef {import('./ipc-handlers.cjs').Stores} Stores */
/** @typedef {import('./ipc-handlers.cjs').GitContext} GitContext */
/**
 * What one health report adds to the fixed fields of healthPayload: the verdict, the failure, or the timings of a
 * healthy start.
 * @typedef {object} HealthResult
 * @property {boolean} [ok] false unless given (healthPayload's default)
 * @property {string} [error]
 * @property {number} [ipcMs]
 * @property {number} [readyMs]
 * @property {string} [url]
 */
/** @typedef {{ ok: boolean, value: string }} CommandResult `value` is trimmed stdout, or stderr when stdout is empty. */
/**
 * What the runtime asks the user to approve (electron/runtime/tools.mts): the tool call, which agent of which run
 * wants it, and a signal that ends the dialog when the run stops.
 * @typedef {object} ApprovalRequest
 * @property {string} tool
 * @property {unknown} arguments
 * @property {string} [toolUseId]
 * @property {string} runId
 * @property {string} agentId
 * @property {string} agentName
 * @property {string} workspace
 * @property {AbortSignal} signal
 */

const isDev = process.env.ORBIT_DEV === '1'
const repoRoot = path.join(__dirname, '..')
const RELAUNCH_FLAG = '--relaunch'
// Shells started by Electron, a VS Code host or an agent command carry this variable, and app.relaunch() passes the
// environment on: with it set the next Orbit would start as a plain Node process without a window.
delete process.env.ELECTRON_RUN_AS_NODE
// Self-upgrade health report: written once per process, after the renderer loaded, answered one IPC call and mounted
// its UI, or at the first failure before that. ORBIT_HEALTH_FILE overrides the path; "0" (smoke, tests) disables it.
const healthFile = process.env.ORBIT_HEALTH_FILE === undefined
  ? path.join(repoRoot, 'artifacts', 'self-upgrade-health.json')
  : (process.env.ORBIT_HEALTH_FILE && process.env.ORBIT_HEALTH_FILE !== '0' ? path.resolve(process.env.ORBIT_HEALTH_FILE) : null)
const startedAt = Date.now()
let healthWritten = false
/** @type {Promise<void> | null} */
let relaunching = null
/** @type {Promise<unknown>} */
let approvalQueue = Promise.resolve()
// runProvider is the runtime's default as well; passing it explicitly lets the desktop smoke substitute what this file
// requires (an ES module namespace cannot be patched in place).
const runtime = new OrbitRuntime({ runProvider, requestApproval: (/** @type {ApprovalRequest} */ request) => {
  const pending = approvalQueue.then(async () => {
    if (request.signal.aborted) return false
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (!window) return false
    const result = await dialog.showMessageBox(window, {
      type: 'question', title: 'Orbit — разрешение на действие',
      message: `${request.agentName}: разрешить действие?`,
      detail: `Проект: ${request.workspace}\nДействие: ${request.tool}\n\n${JSON.stringify(request.arguments, null, 2)}`,
      buttons: ['Отклонить', 'Разрешить один раз'], defaultId: 0, cancelId: 0, noLink: true, signal: request.signal,
    })
    return !request.signal.aborted && result.response === 1
  })
  approvalQueue = pending.catch(() => false)
  return pending
} })
// Subscription quotas belong to the account, not to a run: one monitor serves the window and every running agent.
const quota = new QuotaMonitor()
runtime.setQuota(quota)
runtime.setCatalog((/** @type {Parameters<typeof inspectProviders>[0]} */ providerOptions) => inspectProviders(providerOptions))
// Created once Electron is ready (whenReady); the IPC handlers and flushBeforeQuit read them at call time.
/** @type {Stores} */
const stores = { memoryStore: null, projectContextStore: null, capabilityStore: null, projectIndex: null, runStore: null, stateStore: null }

if (process.env.ORBIT_USER_DATA) app.setPath('userData', path.resolve(process.env.ORBIT_USER_DATA))
const relaunchRequested = process.argv.includes(RELAUNCH_FLAG)
if (!app.requestSingleInstanceLock({ relaunch: relaunchRequested })) {
  // The running instance got the second-instance event: with --relaunch it restarts itself, otherwise it comes to the front.
  console.log(relaunchRequested ? '[orbit] relaunch signal delivered to the running Orbit' : '[orbit] Orbit is already running; bringing its window to the front')
  app.quit()
  // @ts-expect-error -- a top-level return is valid CommonJS (Node runs it), but TypeScript's grammar has no CommonJS exception (TS1108).
  return
}
app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  if (isRelaunchSignal(argv, /** @type {{ relaunch?: boolean } | undefined} */ (additionalData))) { relaunchApp('second-instance'); return }
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})

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

/** @param {HealthResult} extra */
function healthPayload(extra) {
  return {
    ok: false,
    pid: process.pid,
    startedAt,
    writtenAt: Date.now(),
    commit: readHeadCommit(),
    distMtime: distMtime(),
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
 * First result wins: a failure before the window was ready is not undone by a later reload that happens to work.
 * @param {HealthResult} extra
 * @returns {boolean} whether this call wrote the report
 */
function writeHealth(extra) {
  if (healthWritten || !healthFile) return false
  healthWritten = true
  const payload = healthPayload(extra)
  try {
    fs.mkdirSync(path.dirname(healthFile), { recursive: true })
    fs.writeFileSync(healthFile, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    console.error(`[orbit] could not write ${healthFile}: ${/** @type {Error} */ (error).message}`)
  }
  console.log(`[orbit] health ${payload.ok ? 'ok' : 'failed'}${payload.error ? `: ${payload.error}` : ''} (pid ${process.pid})`)
  return true
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

/** What before-quit does: stop the runs (and their CLI trees) and persist every store. A relaunch exits without before-quit, so it calls this itself. */
function flushBeforeQuit() {
  for (const run of runtime.getRuns()) {
    if (['running', 'working', 'waiting', 'queued'].includes(run.status)) runtime.stop(run.runId)
  }
  // The Orbit MCP server (session transport) listens on a loopback port; it goes down with the app.
  void runtime.shutdown?.()
  stores.runStore?.flush()
  stores.projectIndex?.flush()
  stores.memoryStore?.flush()
  stores.capabilityStore?.flush()
}

/**
 * Command line of the next instance: this one without the relaunch flag, so the new process is an ordinary start.
 * @param {string[]} [argv]
 * @returns {string[]}
 */
function relaunchArgs(argv = process.argv) {
  return argv.slice(1).filter(arg => arg !== RELAUNCH_FLAG)
}

/**
 * @param {unknown} argv
 * @param {{ relaunch?: boolean } | null | undefined} additionalData
 * @returns {boolean}
 */
function isRelaunchSignal(argv, additionalData) {
  return (Array.isArray(argv) && argv.includes(RELAUNCH_FLAG)) || additionalData?.relaunch === true
}

/**
 * Restart this process in place (self-upgrade, or `Orbit.cmd --relaunch` while Orbit runs). State is flushed first;
 * the short grace lets the process kills and store writes it started land before this process is gone.
 * @param {string} reason
 * @returns {Promise<void>}
 */
function relaunchApp(reason) {
  if (relaunching) return relaunching
  console.log(`[orbit] relaunch requested (${reason})`)
  relaunching = new Promise((resolve) => {
    try { flushBeforeQuit() } catch (error) { console.error(`[orbit] flush before relaunch failed: ${/** @type {Error} */ (error).message}`) }
    setTimeout(() => {
      app.relaunch({ args: relaunchArgs() })
      app.exit(0)
      resolve()
    }, 300)
  })
  return relaunching
}

/** @param {string} message @param {{ stack?: string, message?: string } | null | undefined} error */
function reportFatal(message, error) {
  console.error(`[orbit] ${message}: ${error?.stack || error}`)
  writeHealth({ ok: false, error: `${message}: ${error?.message || error}` })
  try { dialog.showErrorBox('Orbit — ошибка в главном процессе', `${message}\n\n${error?.stack || error}`) } catch { /* headless */ }
  app.exit(1)
}

if (healthFile) {
  // Without a handler Electron shows its own dialog and keeps a half-initialised process alive, and the upgrade loop
  // would wait for a health report that never comes. Before the first report a crash ends the process instead.
  process.on('uncaughtException', (error) => {
    if (healthWritten) {
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

/** @param {string} remote @returns {Promise<GitContext | { error: string } | null>} */
async function cloneGitWorkspace(remote) {
  remote = String(remote || '').trim()
  if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(remote)) return { error: 'Only HTTPS, SSH and git@ remotes are supported' }
  const parent = await dialog.showOpenDialog({ title: 'Choose a parent folder for the Git project', properties: ['openDirectory', 'createDirectory'] })
  if (parent.canceled || !parent.filePaths[0]) return null
  const target = path.join(parent.filePaths[0], repositoryName(remote))
  try {
    if (fs.existsSync(target)) return { error: `Destination already exists: ${target}` }
  } catch {
    return { error: 'Could not inspect the destination folder' }
  }
  const result = await runProcess('git', ['clone', '--', remote, target], parent.filePaths[0])
  if (!result.ok) return { error: result.value || 'git clone failed' }
  return getGitContext(target)
}

/** @param {string} workspace @returns {Promise<GitContext>} */
async function getGitContext(workspace) {
  workspace = validateWorkspace(workspace)
  const root = await runGit(['rev-parse', '--show-toplevel'], workspace)
  if (!root.ok) return { connected: false, path: workspace, workspaceMode: 'folder', branch: 'folder workspace', changedFiles: 0 }
  const selectedPath = fs.realpathSync.native(workspace)
  const gitRoot = fs.realpathSync.native(root.value)
  if (workspaceKey(selectedPath) !== workspaceKey(gitRoot)) {
    const relative = path.relative(gitRoot, selectedPath) || '.'
    const scopedStatus = await runGit(['status', '--porcelain', '--', relative], gitRoot)
    return { connected: false, path: selectedPath, gitRoot, workspaceMode: 'folder', branch: 'direct folder lane', changedFiles: scopedStatus.value ? scopedStatus.value.split(/\r?\n/).filter(Boolean).length : 0 }
  }

  const [branch, status, lastCommit] = await Promise.all([
    runGit(['branch', '--show-current'], workspace),
    runGit(['status', '--porcelain'], workspace),
    runGit(['log', '-1', '--format=%h|%s'], workspace),
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

function createWindow() {
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

  // Unpackaged, the renderer is ../dist/index.html of this repository (npm run build); packaged, the same path inside app.asar.
  const load = isDev ? win.loadURL('http://127.0.0.1:5173') : win.loadFile(path.join(__dirname, '../dist/index.html'))
  load.catch(() => { /* did-fail-load reports it */ })

  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    verifyRendererHealth(win).then(
      (result) => writeHealth({ ok: true, ...result, url: win.webContents.getURL() }),
      (error) => writeHealth({ ok: false, error: `renderer check failed: ${error.message}` }),
    )
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    win.show()
    console.error(`Orbit renderer failed to load (${errorCode}): ${errorDescription} — ${validatedURL}`)
    // -3 is ERR_ABORTED: a navigation replaced by another one, not a broken build.
    if (isMainFrame !== false && errorCode !== -3) writeHealth({ ok: false, error: `renderer failed to load (${errorCode}): ${errorDescription} — ${validatedURL}` })
  })
  // A crashed renderer leaves a blank window while agents keep running and Stop is unreachable. Reloading
  // restores the chats and runs from saved state; a crash loop gives up after three reloads per minute.
  /** @type {number[]} */
  let reloads = []
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Orbit renderer exited: ${details.reason}`)
    if (!healthWritten) writeHealth({ ok: false, error: `renderer exited before it was ready: ${details.reason}` })
    const moment = Date.now()
    reloads = reloads.filter(time => moment - time < 60000)
    if (details.reason === 'clean-exit' || reloads.length >= 3 || win.isDestroyed()) return
    reloads.push(moment)
    win.webContents.reload()
  })
}

// Renderer-callable channels: electron/ipc-contract.cjs lists them, electron/ipc-handlers.cjs implements them, and the
// registration throws before the window exists if the two disagree. Every handler runs behind the sender guard.
registerIpcHandlers(ipcMain, createIpcHandlers({
  app, dialog, shell, runtime, quota, stores, validateWorkspace, getGitContext, cloneGitWorkspace, relaunchApp, startedAt,
  isHealthy: () => healthWritten,
}), { isDev })

runtime.onEvent((/** @type {unknown} */ event) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('runtime:event', event)
})
quota.onUpdate((/** @type {unknown} */ update) => {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('quota:update', update)
})

app.whenReady().then(() => {
  stores.memoryStore = new OrbitMemoryStore(app.getPath('userData'))
  stores.projectContextStore = new ProjectContextStore(app.getPath('userData'))
  runtime.setContextStore(stores.projectContextStore)
  stores.capabilityStore = new CapabilityStore(app.getPath('userData'))
  stores.projectIndex = new ProjectIndex({ directory: path.join(app.getPath('userData'), 'project-index') })
  runtime.setProjectIndex(stores.projectIndex)
  stores.runStore = new RunStore(app.getPath('userData'))
  stores.stateStore = new StateStore(app.getPath('userData'))
  runtime.setMemoryStore(stores.memoryStore)
  runtime.setCapabilityStore(stores.capabilityStore)
  runtime.setRunStore(stores.runStore)
  // Housekeeping on start (expiry, duplicates, caps). Nothing is shared between projects here: which projects allow it is known only once they run.
  try { stores.memoryStore.maintain({ crossProject: true, projects: [] }); stores.capabilityStore.maintain({ crossProject: true, projects: [] }) } catch (error) { console.error(`Memory housekeeping failed: ${/** @type {Error} */ (error).message}`) }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => reportFatal('start-up failed', error))

app.on('before-quit', flushBeforeQuit)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

module.exports = { RELAUNCH_FLAG, readHeadCommit, relaunchArgs, isRelaunchSignal }
