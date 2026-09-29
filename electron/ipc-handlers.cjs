// @ts-check
'use strict'

const path = require('node:path')
const { stripDiffs } = require('./run-store.mts')
const providers = require('./providers.mts')
const { PROVIDER_IDS } = require('./quota.mts')
const { applyPatch, removeWorktree } = require('./worktree.mts')
const { guardIpc } = require('./ipc-guard.cjs')
const { CALLS } = require('./ipc-contract.cjs')

/** @typedef {import('./ipc-contract.cjs').IpcEntry} IpcEntry */
/** @typedef {import('./runtime.mts').OrbitRuntime} OrbitRuntime */
/** @typedef {import('./quota.mts').QuotaMonitor} QuotaMonitor */
/** @typedef {import('./memory.mts').OrbitMemoryStore} OrbitMemoryStore */
/** @typedef {import('./project-context.mts').ProjectContextStore} ProjectContextStore */
/** @typedef {import('./capabilities.mts').CapabilityStore} CapabilityStore */
/** @typedef {import('./project-index.mts').ProjectIndex} ProjectIndex */
/** @typedef {import('./run-store.mts').RunStore} RunStore */
/** @typedef {import('./run-store.mts').StateStore} StateStore */

/**
 * What main.cjs tells the window about a project folder (the renderer's `GitContext` in src/vite-env.d.ts).
 * @typedef {object} GitContext
 * @property {boolean} connected
 * @property {string} path
 * @property {string} [gitRoot]
 * @property {'git-root' | 'folder'} [workspaceMode]
 * @property {string} branch
 * @property {number} changedFiles
 * @property {string} [lastCommit]
 */

/**
 * The stores main.cjs creates once Electron is ready (app.whenReady); null until then.
 * @typedef {object} Stores
 * @property {OrbitMemoryStore | null} memoryStore
 * @property {ProjectContextStore | null} projectContextStore
 * @property {CapabilityStore | null} capabilityStore
 * @property {ProjectIndex | null} projectIndex
 * @property {RunStore | null} runStore
 * @property {StateStore | null} stateStore
 */
/**
 * The stores as a handler sees them: all created, because a window (and so a call) exists only after whenReady.
 * @typedef {{ [K in keyof Stores]: NonNullable<Stores[K]> }} ReadyStores
 */

/**
 * What the handlers need from main.cjs: Electron's singletons, the runtime and the quota monitor, the stores, and the
 * workspace helpers and lifecycle hooks main.cjs implements.
 * @typedef {object} IpcContext
 * @property {import('electron').App} app
 * @property {import('electron').Dialog} dialog
 * @property {import('electron').Shell} shell
 * @property {OrbitRuntime} runtime
 * @property {QuotaMonitor} quota
 * @property {Stores} stores
 * @property {(workspace: unknown) => string} validateWorkspace Throws unless `workspace` is an existing absolute folder; returns its real path.
 * @property {(workspace: string) => Promise<GitContext>} getGitContext
 * @property {(remote: string) => Promise<GitContext | { error: string } | null>} cloneGitWorkspace
 * @property {(reason: string) => unknown} relaunchApp
 * @property {number} startedAt
 * @property {() => boolean} isHealthy Whether this process has written a health report that says ok.
 */

/**
 * One call channel's handler. The arguments are what the renderer sent, untyped: the contract's type strings describe
 * the renderer's view, the main process gets whatever crossed the IPC, so each handler validates what it relies on.
 * @typedef {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => unknown} IpcHandler
 */

/**
 * The main-process side of electron/ipc-contract.cjs: one handler per call channel, keyed by channel.
 * `ctx` carries the app singletons and `stores`, which main.cjs fills once Electron is ready: the handlers read the
 * stores at call time, so they can be registered before the window exists (a call before then is a caller error).
 * @param {IpcContext} ctx
 * @returns {Map<string, IpcHandler>} keyed by channel
 */
function createIpcHandlers(ctx) {
  const { app, dialog, shell, runtime, quota, validateWorkspace, getGitContext, cloneGitWorkspace, relaunchApp, startedAt, isHealthy } = ctx
  // The same object as ctx.stores, read at call time; typed as filled because no call can arrive before whenReady.
  const stores = /** @type {ReadyStores} */ (ctx.stores)
  /** @type {Map<string, IpcHandler>} */
  const handlers = new Map()
  /** @param {string} channel @param {IpcHandler} handler */
  const handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error(`IPC handler for ${channel} is defined twice`)
    handlers.set(channel, handler)
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
  // Liveness for the self-upgrade health check (one round trip renderer → main → renderer) and the restart the upgrade
  // script or the window can ask for; the reply leaves before the process restarts.
  handle('app:ping', () => ({ pid: process.pid, startedAt, healthy: isHealthy() }))
  handle('app:relaunch', () => { setImmediate(() => relaunchApp('ipc')); return { ok: true, pid: process.pid } })
  handle('runtime:start', (_event, payload) => {
    const workspace = validateWorkspace(payload?.workspace)
    if (!payload?.projectId || !payload?.chatId) throw new Error('Project and chat are required')
    return runtime.start({
      ...payload, workspace,
      memoryContext: payload.memoryEnabled ? stores.memoryStore.search(payload.prompt, workspace, 6, payload.globalMemoryEnabled !== false, payload.chatId) : [],
      artifactRoot: path.join(app.getPath('userData'), 'runs'),
    })
  })
  handle('runtime:stop', (_event, runId) => runtime.stop(runId))
  handle('runtime:list', () => {
    const records = new Map((stores.runStore?.list() || []).map(run => [run.runId, run]))
    for (const run of runtime.getRuns()) records.set(run.runId, stripDiffs(/** @type {any} */ (run)))
    return [...records.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  })
  handle('runtime:get', (_event, runId) => runtime.getRun(runId) || stores.runStore?.get(runId) || null)
  // Diff texts are not part of run lists; the inspector asks for one run's changes when the user opens them.
  handle('runtime:changes', async (_event, runId) => {
    if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId)) return []
    const known = runtime.getRunChanges?.(runId) || stores.runStore?.getChanges(runId) || []
    // Files written by agents that no record covers (runs saved before changes were tracked): Git may still show their diff.
    const recovered = await (stores.runStore?.recoverChanges?.(runId, /** @type {any} */ (known)) || Promise.resolve([])).catch(() => [])
    return recovered.length ? known.concat(recovered) : known
  })
  handle('state:load', () => stores.stateStore.load())
  handle('state:save', (_event, state) => stores.stateStore.save(state))
  // Building the index is the same scan a task starts with; asking for it first just makes the first task faster.
  handle('project-index:status', async (_event, workspace, rebuild) => {
    const folder = validateWorkspace(workspace)
    if (!stores.projectIndex) return null
    await stores.projectIndex.refresh(folder, { force: rebuild === true })
    return stores.projectIndex.stats(folder)
  })
  handle('memory:list', (_event, workspace, chatId) => stores.memoryStore.list(workspace, true, chatId))
  handle('memory:save', (_event, entry) => stores.memoryStore.upsert(entry))
  handle('memory:remove', (_event, id, workspace, chatId) => stores.memoryStore.remove(id, workspace, chatId))
  handle('memory:pin', (_event, id, pinned, workspace, chatId) => stores.memoryStore.pin(id, pinned === true, workspace, chatId))
  // The renderer owns the per-project switch for shared memory; the runtime needs it to know which projects may contribute.
  handle('memory:sharing', (_event, workspace, enabled) => { runtime.setSharing(workspace, enabled === true); return true })
  handle('memory:forget-chat', (_event, workspace, chatId) => stores.memoryStore.forgetChat(workspace, chatId))
  // How full each tier of memory and each skill library is, for the panels.
  handle('memory:stats', (_event, workspace, chatId) => ({ memory: stores.memoryStore.stats(workspace, chatId), skills: stores.capabilityStore.stats(workspace) }))
  handle('capabilities:list', (_event, workspace) => stores.capabilityStore.list(workspace))
  handle('capabilities:pin', (_event, id, pinned, workspace) => stores.capabilityStore.pin(id, pinned === true, workspace))
  handle('capabilities:read', (_event, id, workspace) => stores.capabilityStore.read(id, workspace))
  handle('capabilities:install', (_event, entry) => stores.capabilityStore.install(entry))
  handle('capabilities:remove', (_event, id, workspace) => stores.capabilityStore.remove(id, workspace))
  handle('capabilities:restore', (_event, id, version, workspace) => stores.capabilityStore.restore(id, version, workspace))
  // Read through the module so a fixture installed before start-up (smoke:desktop) is the one that answers.
  handle('providers:health', (_event, options) => providers.inspectProviders(options))
  handle('quota:get', (_event, providerOptions, force) => quota.all(PROVIDER_IDS, { options: providerOptions && typeof providerOptions === 'object' ? providerOptions : {}, force: force === true }))
  handle('artifact:apply', async (_event, payload) => {
    const context = await getGitContext(payload.workspace)
    if (!context.connected) return { ok: false, reason: 'workspace_not_root', detail: 'Apply requires the exact Git repository root that produced this artifact.' }
    const result = await applyPatch({ ...payload, artifactRoot: path.join(app.getPath('userData'), 'runs') })
    if (result.ok && payload.worktreePath) await removeWorktree(payload.workspace, payload.worktreePath)
    return result
  })
  return handlers
}

/**
 * Every contract channel has a handler and every handler is in the contract; a mismatch is a start-up error, not a silent gap.
 * @param {Map<string, IpcHandler>} handlers
 * @param {IpcEntry[]} [contract]
 * @returns {void}
 */
function assertIpcContract(handlers, contract = CALLS) {
  const expected = new Set(contract.map(entry => entry.channel))
  const missing = [...expected].filter(channel => !handlers.has(channel))
  const extra = [...handlers.keys()].filter(channel => !expected.has(channel))
  if (!missing.length && !extra.length) return
  const problems = []
  if (missing.length) problems.push(`no handler for ${missing.join(', ')}`)
  if (extra.length) problems.push(`handler without a contract entry: ${extra.join(', ')}`)
  throw new Error(`IPC contract mismatch (electron/ipc-contract.cjs vs electron/ipc-handlers.cjs): ${problems.join('; ')}`)
}

/**
 * Registers the handlers with ipcMain. Every channel goes through the sender check: only Orbit's own window may call the main process.
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain
 * @param {Map<string, IpcHandler>} handlers
 * @param {{ isDev?: boolean }} [options]
 * @returns {Map<string, IpcHandler>} the same map
 */
function registerIpcHandlers(ipcMain, handlers, { isDev = false } = {}) {
  assertIpcContract(handlers)
  for (const [channel, handler] of handlers) ipcMain.handle(channel, guardIpc(handler, { isDev }))
  return handlers
}

module.exports = { createIpcHandlers, assertIpcContract, registerIpcHandlers }
