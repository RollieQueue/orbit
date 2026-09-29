const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('./runtime.cjs')
const { OrbitMemoryStore } = require('./memory.cjs')
const { ProjectContextStore } = require('./project-context.cjs')
const { CapabilityStore } = require('./capabilities.cjs')
const { RunStore, StateStore } = require('./run-store.cjs')
const { workspaceKey } = require('./storage.cjs')
const { inspectProviders } = require('./providers.cjs')
const { applyPatch, removeWorktree } = require('./worktree.cjs')
const { guardIpc } = require('./ipc-guard.cjs')

const isDev = process.env.ORBIT_DEV === '1'
/** Captured before single-instance lock so a losing relaunch still records the handoff. */
const startupSelfUpgradeHandoff = process.env.ORBIT_SELF_UPGRADE === '1'
  ? {
      acceptedAt: new Date().toISOString(),
      pid: process.pid,
      bundle: process.env.ORBIT_SELF_UPGRADE_BUNDLE || null,
      execPath: process.execPath,
      cwd: process.cwd(),
      // Only an explicit loop request (--loop / ORBIT_UPGRADE_LOOP) may start another cycle.
      loop: /^(1|true|yes)$/i.test(String(process.env.ORBIT_UPGRADE_LOOP || '').trim()),
      // How many relaunch cycles this chain has run; the script stops a chain that reaches its cap.
      cycle: Math.max(0, Math.floor(Number(process.env.ORBIT_UPGRADE_CYCLE) || 0)),
    }
  : null
// These variables describe how THIS process was started. Left in process.env they are inherited by
// every command an agent runs from inside Orbit, so a nested `npm run self-upgrade` would relaunch
// with the handoff set again and keep chaining builds.
delete process.env.ORBIT_SELF_UPGRADE
delete process.env.ORBIT_SELF_UPGRADE_BUNDLE
delete process.env.ORBIT_UPGRADE_LOOP
delete process.env.ORBIT_UPGRADE_CYCLE
let selfUpgradeContinueStarted = false
const guard = (handler) => guardIpc(handler, { isDev })
// Every channel goes through the sender check; only Orbit's own window may call the main process.
const handle = (channel, handler) => ipcMain.handle(channel, guard(handler))
let approvalQueue = Promise.resolve()
const runtime = new OrbitRuntime({ requestApproval: request => {
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
let memoryStore
let projectContextStore
let capabilityStore
let runStore
let stateStore

if (process.env.ORBIT_USER_DATA) app.setPath('userData', path.resolve(process.env.ORBIT_USER_DATA))
if (!app.requestSingleInstanceLock()) {
  if (startupSelfUpgradeHandoff) {
    const projectRoot = resolveOrbitProjectRoot()
    recordSelfUpgradeHandoff(startupSelfUpgradeHandoff, projectRoot)
    if (startupSelfUpgradeHandoff.loop) startSelfUpgradeContinue(projectRoot, startupSelfUpgradeHandoff.cycle)
  }
  app.quit()
  return
}
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
})

function validateWorkspace(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Choose an absolute project folder')
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Project folder does not exist')
  return fs.realpathSync.native(workspace)
}

function isOrbitProjectRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, 'scripts', 'self-upgrade.cjs')) && fs.existsSync(path.join(dir, 'package.json'))
  } catch {
    return false
  }
}

function walkForProjectRoot(start) {
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i++) {
    if (isOrbitProjectRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Resolve source project root that owns scripts/self-upgrade.cjs (parent of Orbit-standalone-* for packaged exe). */
function resolveOrbitProjectRoot() {
  if (process.env.ORBIT_PROJECT_ROOT) {
    const forced = path.resolve(process.env.ORBIT_PROJECT_ROOT)
    if (isOrbitProjectRoot(forced)) return forced
  }
  const starts = []
  const exeDir = path.dirname(process.execPath)
  if (/^Orbit-standalone-/i.test(path.basename(exeDir))) starts.push(path.dirname(exeDir))
  starts.push(process.cwd(), path.join(__dirname, '..'), exeDir)
  for (const start of starts) {
    const found = walkForProjectRoot(start)
    if (found) return found
  }
  return null
}

function recordSelfUpgradeHandoff(handoff, projectRoot) {
  const payload = {
    ok: true,
    accepted: true,
    ...handoff,
    projectRoot,
    next: projectRoot ? 'scripts/self-upgrade.cjs' : null,
  }
  console.log(`[orbit] self-upgrade handoff accepted bundle=${handoff.bundle || '(none)'} root=${projectRoot || '(unresolved)'}`)
  if (!projectRoot) return null
  try {
    const dir = path.join(projectRoot, 'artifacts')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'self-upgrade-handoff.json')
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    console.log(`[orbit] self-upgrade handoff recorded: ${file}`)
    return file
  } catch (error) {
    console.error(`[orbit] failed to write self-upgrade handoff artifact: ${error.message}`)
    return null
  }
}

function resolveNodeExecutable() {
  return process.env.ORBIT_NODE || process.env.npm_node_execpath || 'node'
}

/** Spawn the next verify→package→relaunch cycle without quitting this process. */
function startSelfUpgradeContinue(projectRoot, cycle = 0) {
  if (selfUpgradeContinueStarted) return
  selfUpgradeContinueStarted = true
  if (!projectRoot || !isOrbitProjectRoot(projectRoot)) {
    console.error('[orbit] self-upgrade continue skipped: project root with scripts/self-upgrade.cjs not found')
    return
  }
  const script = path.join(projectRoot, 'scripts', 'self-upgrade.cjs')
  const env = { ...process.env }
  delete env.ORBIT_SELF_UPGRADE
  delete env.ORBIT_SELF_UPGRADE_BUNDLE
  delete env.ELECTRON_RUN_AS_NODE
  env.ORBIT_UPGRADE_CYCLE = String(cycle)
  console.log(`[orbit] starting next self-upgrade cycle: ${resolveNodeExecutable()} ${script} --loop`)
  try {
    // --loop keeps the handoff chain explicit; the script itself stops when nothing changed.
    const child = spawn(resolveNodeExecutable(), [script, '--loop'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
      shell: false,
    })
    child.on('error', (error) => {
      console.error(`[orbit] self-upgrade continue failed to spawn: ${error.message}`)
    })
    child.unref()
  } catch (error) {
    console.error(`[orbit] self-upgrade continue spawn error: ${error.message}`)
  }
}

function scheduleSelfUpgradeContinue(projectRoot, cycle = 0) {
  const kick = () => {
    // Brief settle so the relaunched UI can show before verify/package load begins.
    setTimeout(() => startSelfUpgradeContinue(projectRoot, cycle), 1500)
  }
  const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  if (win && !win.isVisible()) win.once('ready-to-show', kick)
  else kick()
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, value: (stdout || stderr || '').trim() })
    })
  })
}

function runProcess(file, args, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, value: (stdout || stderr || '').trim() })
    })
  })
}

function repositoryName(remote) {
  const normalized = remote.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repository'
  return normalized.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'repository'
}

async function cloneGitWorkspace(remote) {
  remote = String(remote || '').trim()
  if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(remote)) return { error: 'Only HTTPS, SSH and git@ remotes are supported' }
  const parent = await dialog.showOpenDialog({ title: 'Choose a parent folder for the Git project', properties: ['openDirectory', 'createDirectory'] })
  if (parent.canceled || !parent.filePaths[0]) return null
  const target = path.join(parent.filePaths[0], repositoryName(remote))
  try {
    const fs = require('node:fs')
    if (fs.existsSync(target)) return { error: `Destination already exists: ${target}` }
  } catch {
    return { error: 'Could not inspect the destination folder' }
  }
  const result = await runProcess('git', ['clone', '--', remote, target], parent.filePaths[0])
  if (!result.ok) return { error: result.value || 'git clone failed' }
  return getGitContext(target)
}

async function getGitContext(workspace) {
  workspace = validateWorkspace(workspace)
  const root = await runGit(['rev-parse', '--show-toplevel'], workspace)
  if (!root.ok) return { connected: false, path: workspace, workspaceMode: 'folder', branch: 'folder workspace', changedFiles: 0 }
  const fs = require('node:fs')
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

  if (isDev) win.loadURL('http://127.0.0.1:5173')
  else win.loadFile(path.join(__dirname, '../dist/index.html'))

  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    win.show()
    console.error(`Orbit renderer failed to load (${errorCode}): ${errorDescription} — ${validatedURL}`)
  })
  // A crashed renderer leaves a blank window while agents keep running and Stop is unreachable. Reloading
  // restores the chats and runs from saved state; a crash loop gives up after three reloads per minute.
  let reloads = []
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Orbit renderer exited: ${details.reason}`)
    const moment = Date.now()
    reloads = reloads.filter(time => moment - time < 60000)
    if (details.reason === 'clean-exit' || reloads.length >= 3 || win.isDestroyed()) return
    reloads.push(moment)
    win.webContents.reload()
  })
}

handle('workspace:pick', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  return getGitContext(result.filePaths[0])
})

handle('workspace:inspect', (_event, workspace) => getGitContext(workspace))
handle('workspace:clone', (_event, remote) => cloneGitWorkspace(remote))
handle('shell:open', (_event, target) => {
  if (!/^https?:\/\//i.test(String(target || ''))) throw new Error('Only http(s) links can be opened externally')
  return shell.openExternal(target)
})
handle('runtime:start', (_event, payload) => {
  const workspace = validateWorkspace(payload?.workspace)
  if (!payload?.projectId || !payload?.chatId) throw new Error('Project and chat are required')
  return runtime.start({
    ...payload, workspace,
    memoryContext: payload.memoryEnabled ? memoryStore.search(payload.prompt, workspace, 6, payload.globalMemoryEnabled !== false) : [],
    artifactRoot: path.join(app.getPath('userData'), 'runs'),
  })
})
handle('runtime:route-message', (_event, payload) => runtime.routeMessage({
  ...payload,
  memoryContext: payload.memoryEnabled ? memoryStore.search(payload.prompt, payload.workspace, 6, payload.globalMemoryEnabled !== false) : [],
}))
handle('runtime:stop', (_event, runId) => runtime.stop(runId))
handle('runtime:spawn-subagent', (_event, payload) => runtime.spawnSubAgent(payload.runId, payload.parentId, payload))
handle('runtime:list', () => {
  const records = new Map((runStore?.list() || []).map(run => [run.runId, run]))
  for (const run of runtime.getRuns()) records.set(run.runId, run)
  return [...records.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
})
handle('runtime:get', (_event, runId) => runtime.getRun(runId) || runStore?.get(runId) || null)
handle('state:load', () => stateStore.load())
handle('state:save', (_event, state) => stateStore.save(state))
handle('project-context:get', (_event, workspace) => projectContextStore?.getLatest(workspace) || null)
handle('memory:list', (_event, workspace) => memoryStore.list(workspace))
handle('memory:search', (_event, query, workspace) => memoryStore.search(query, workspace))
handle('memory:save', (_event, entry) => memoryStore.upsert(entry))
handle('memory:remove', (_event, id, workspace) => memoryStore.remove(id, workspace))
handle('capabilities:list', (_event, workspace) => capabilityStore.list(workspace))
handle('capabilities:read', (_event, id, workspace) => capabilityStore.read(id, workspace))
handle('capabilities:install', (_event, entry) => capabilityStore.install(entry))
handle('capabilities:remove', (_event, id, workspace) => capabilityStore.remove(id, workspace))
handle('capabilities:restore', (_event, id, version, workspace) => capabilityStore.restore(id, version, workspace))
handle('providers:health', (_event, options) => inspectProviders(options))
handle('artifact:apply', async (_event, payload) => {
  const context = await getGitContext(payload.workspace)
  if (!context.connected) return { ok: false, reason: 'workspace_not_root', detail: 'Apply requires the exact Git repository root that produced this artifact.' }
  const result = await applyPatch({ ...payload, artifactRoot: path.join(app.getPath('userData'), 'runs') })
  if (result.ok && payload.worktreePath) await removeWorktree(payload.workspace, payload.worktreePath)
  return result
})

runtime.onEvent((event) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('runtime:event', event)
})

app.whenReady().then(() => {
  memoryStore = new OrbitMemoryStore(app.getPath('userData'))
  projectContextStore = new ProjectContextStore(app.getPath('userData'))
  runtime.setContextStore(projectContextStore)
  capabilityStore = new CapabilityStore(app.getPath('userData'))
  runStore = new RunStore(app.getPath('userData'))
  stateStore = new StateStore(app.getPath('userData'))
  runtime.setMemoryStore(memoryStore)
  runtime.setCapabilityStore(capabilityStore)
  runtime.setRunStore(runStore)
  createWindow()

  if (startupSelfUpgradeHandoff) {
    const projectRoot = resolveOrbitProjectRoot()
    recordSelfUpgradeHandoff(startupSelfUpgradeHandoff, projectRoot)
    if (startupSelfUpgradeHandoff.loop) scheduleSelfUpgradeContinue(projectRoot, startupSelfUpgradeHandoff.cycle)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const run of runtime.getRuns()) {
    if (['running', 'working', 'waiting', 'queued'].includes(run.status)) runtime.stop(run.runId)
  }
  runStore?.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
