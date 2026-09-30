// @ts-check
'use strict'

const { guardIpc } = require('./ipc-guard.cjs')
const { CALLS } = require('./ipc-contract.cjs')
const { RUNTIME_CHANNELS, SHELL_CHANNELS } = require('./runtime-protocol.mts')

/** @typedef {import('./ipc-contract.cjs').IpcEntry} IpcEntry */
/** @typedef {import('./runtime-client.cjs').RuntimeStatus} RuntimeStatus */

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
 * What `runtime:restart` answers (RuntimeRestartResult of ipc-contract.cjs): the new runtime's pid and how long the
 * restart took, or why it failed.
 * @typedef {{ ok: boolean, ms: number, pid: number | null, error?: string }} RuntimeRestartResult
 */

/**
 * What the handlers need from main.cjs: Electron's dialog and shell, the workspace helpers, the lifecycle hooks, and
 * the way to the runtime process.
 * @typedef {object} IpcContext
 * @property {import('electron').Dialog} dialog
 * @property {import('electron').Shell} shell
 * @property {(workspace: unknown) => Promise<GitContext>} getGitContext Throws unless `workspace` is an existing absolute folder.
 * @property {(remote: unknown) => Promise<GitContext | { error: string } | null>} cloneGitWorkspace
 * @property {(reason: string) => unknown} relaunchApp
 * @property {(sender: import('electron').WebContents, on: boolean) => boolean} setFullScreen Puts the sender's window in or
 *   out of full screen; returns whether it was full screen before.
 * @property {(target: string) => Promise<string>} [openPath] Opens a file or folder of Orbit's attachments or skills with
 *   the system's default app; answers the error text (empty on success) and throws for any other path.
 * @property {(reason: string) => Promise<RuntimeRestartResult>} restartRuntime
 * @property {() => Promise<unknown>} [whenStarted] settles once the start of this process has its health report; the
 *   window's runtime restart waits for it, as the --restart-runtime signal does
 * @property {() => RuntimeStatus} runtimeStatus
 * @property {(channel: string, args: unknown[]) => Promise<unknown>} callRuntime Sends a call channel to the runtime (runtime-client.cjs), which answers it.
 * @property {number} startedAt
 * @property {() => boolean} isHealthy Whether the last health report of this process says ok.
 */

/** How long the window's runtime restart waits for the start of Orbit to be reported before it gives up. */
const STARTING_WAIT_MS = 60000

/**
 * Whether `promise` settles within `ms`; the timer is cleared either way.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    const done = () => { clearTimeout(timer); resolve(true) }
    promise.then(done, done)
  })
}

/**
 * One call channel's handler. The arguments are what the renderer sent, untyped: the contract's type strings describe
 * the renderer's view, the main process gets whatever crossed the IPC, so each handler (or the runtime, for a
 * forwarded channel) validates what it relies on.
 * @typedef {(event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown} IpcHandler
 */

/**
 * The main-process side of electron/ipc-contract.cjs: one handler per call channel, keyed by channel. Main answers
 * SHELL_CHANNELS itself (dialogs, `shell`, health, restarts); every channel of RUNTIME_CHANNELS
 * (electron/runtime-protocol.mts) goes to the runtime with its arguments as the window sent them. `ctx` is read at call
 * time, so the handlers can be registered before the runtime exists.
 * @param {IpcContext} ctx
 * @returns {Map<string, IpcHandler>} keyed by channel
 */
function createIpcHandlers(ctx) {
  /** @type {Map<string, IpcHandler>} */
  const handlers = new Map()
  /** @param {string} channel @param {IpcHandler} handler */
  const handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error(`IPC handler for ${channel} is defined twice`)
    handlers.set(channel, handler)
  }

  handle('workspace:pick', async () => {
    const result = await ctx.dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return ctx.getGitContext(result.filePaths[0])
  })
  handle('workspace:inspect', (_event, workspace) => ctx.getGitContext(workspace))
  handle('workspace:clone', (_event, remote) => ctx.cloneGitWorkspace(remote))
  handle('shell:open', (_event, target) => {
    if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) throw new Error('Only http(s) links can be opened externally')
    return ctx.shell.openExternal(target)
  })
  handle('shell:open-path', (_event, target) => {
    if (!ctx.openPath) throw new Error('Opening files is not available here')
    return ctx.openPath(typeof target === 'string' ? target : '')
  })
  // Liveness for the self-upgrade health check (one round trip renderer → main → renderer) and the restart the upgrade
  // script or the window can ask for; the reply leaves before the process restarts.
  handle('app:ping', () => ({ pid: process.pid, startedAt: ctx.startedAt, healthy: ctx.isHealthy() }))
  handle('app:relaunch', () => { setImmediate(() => ctx.relaunchApp('ipc')); return { ok: true, pid: process.pid } })
  handle('app:fullscreen', (event, on) => ctx.setFullScreen(event.sender, on === true))
  // A new runtime process with the code on disk; the window stays. The reply comes once the new runtime is ready. While
  // Orbit is still starting it waits for that start's report first: a restart on top of it would end a start that may
  // be about to work, and its own report would come before the start's.
  handle('runtime:restart', async () => {
    if (ctx.whenStarted && !(await settlesWithin(Promise.resolve().then(ctx.whenStarted), STARTING_WAIT_MS))) {
      /** @type {RuntimeRestartResult} */
      const refused = { ok: false, ms: 0, pid: null, error: 'Orbit is still starting; restart the runtime once it has started' }
      return refused
    }
    return ctx.restartRuntime('window')
  })
  handle('runtime:status', () => ctx.runtimeStatus())

  const own = [...handlers.keys()]
  if (own.length !== SHELL_CHANNELS.length || own.some(channel => !SHELL_CHANNELS.includes(channel))) {
    throw new Error(`main's own IPC channels (${own.join(', ')}) differ from SHELL_CHANNELS of electron/runtime-protocol.mts`)
  }
  for (const channel of RUNTIME_CHANNELS) handle(channel, (_event, ...args) => ctx.callRuntime(channel, args))
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
