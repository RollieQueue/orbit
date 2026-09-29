// @ts-check
'use strict'

/**
 * The IPC surface between Orbit's window and the main process, in one table.
 *
 * - electron/preload.cjs is GENERATED from it (`node scripts/gen-ipc-types.cjs`). The preload runs in Electron's renderer
 *   sandbox, whose require() only loads Electron's own modules, so the table is inlined there instead of required.
 * - src/vite-env.d.ts gets its `OrbitBridge` block (between the BEGIN/END markers) from the same script; the types below
 *   are TypeScript source as the renderer sees it: globals declared in vite-env.d.ts or `import('./types').X`.
 * - electron/ipc-handlers.cjs must implement exactly the call channels listed here; registerIpcHandlers checks it at start-up.
 * - tests/ipc-contract.test.cjs fails when the preload or the .d.ts drifts from this file.
 *
 * Entry: { method, channel, args: [{ name, type, optional? }], returns, push? }. A call is `window.orbit.method(...args)`
 * → ipcRenderer.invoke(channel, ...args) → Promise<returns>. A push entry (`push: true`) subscribes to main → renderer
 * messages on `channel`: its single argument is the handler and it returns the unsubscribe function.
 */

/**
 * One argument of a method: `type` is TypeScript source as the renderer sees it.
 * @typedef {{ name: string, type: string, optional?: boolean }} IpcArg
 */
/**
 * One row of the table: a call (`ipcRenderer.invoke(channel, ...args)` → `Promise<returns>`), or with `push: true` a
 * subscription whose one argument is the handler and whose `returns` is the unsubscribe function.
 * @typedef {{ method: string, channel: string, args: IpcArg[], returns: string, push?: boolean }} IpcEntry
 */

/** @param {string} name @returns {string} */
const T = (name) => `import('./types').${name}`

// Named helper types emitted before the bridge interface, in this order.
const TYPES = {
  StartTaskPayload: `{ projectId: string; chatId: string; prompt: string; history: { role: 'user' | 'assistant'; content: string }[]; workspace: string; memoryEnabled: boolean; globalMemoryEnabled?: boolean; reasoningEffort?: string; providerId: string; model?: string; models?: Record<string, string>; quotaFailover?: ${T('QuotaFailover')}; providerPool?: ${T('PoolMember')}[]; providerOptions?: Record<string, ${T('ProviderOption')}>; agentInstructions: string; accessMode: ${T('AccessMode')}; approvalPolicy: ${T('ApprovalPolicy')}; limits: ${T('RunLimits')} }`,
  ApplyArtifactPayload: '{ workspace: string; patchPath: string; worktreePath?: string }',
  ApplyArtifactResult: '{ ok: boolean; reason?: string; detail?: string }',
  QuotaUpdate: `{ providerId: string; snapshot: ${T('QuotaSnapshot')} | null }`,
}

const workspace = { name: 'workspace', type: 'string' }
const chatId = { name: 'chatId', type: 'string', optional: true }
const id = { name: 'id', type: 'string' }
const pinned = { name: 'pinned', type: 'boolean' }
const providerOptions = { name: 'options', type: `Record<string, ${T('ProviderOption')}>`, optional: true }

/** @type {IpcEntry[]} */
const CALLS = [
  { method: 'pickWorkspace', channel: 'workspace:pick', args: [], returns: 'GitContext | null' },
  { method: 'inspectWorkspace', channel: 'workspace:inspect', args: [workspace], returns: 'GitContext' },
  { method: 'cloneWorkspace', channel: 'workspace:clone', args: [{ name: 'remote', type: 'string' }], returns: '(GitContext & { error?: string }) | null' },
  { method: 'startTask', channel: 'runtime:start', args: [{ name: 'payload', type: 'StartTaskPayload' }], returns: 'string' },
  { method: 'stopTask', channel: 'runtime:stop', args: [{ name: 'runId', type: 'string' }], returns: 'boolean' },
  { method: 'listRuns', channel: 'runtime:list', args: [], returns: `${T('RunSnapshot')}[]` },
  { method: 'getRun', channel: 'runtime:get', args: [{ name: 'runId', type: 'string' }], returns: `${T('RunSnapshot')} | null` },
  { method: 'getRunChanges', channel: 'runtime:changes', args: [{ name: 'runId', type: 'string' }], returns: `${T('FileChange')}[]` },
  { method: 'loadState', channel: 'state:load', args: [], returns: `${T('AppState')} | null` },
  { method: 'saveState', channel: 'state:save', args: [{ name: 'state', type: T('AppState') }], returns: 'unknown' },
  { method: 'projectIndexStatus', channel: 'project-index:status', args: [workspace, { name: 'rebuild', type: 'boolean', optional: true }], returns: 'ProjectIndexStatus | null' },
  { method: 'listMemory', channel: 'memory:list', args: [workspace, chatId], returns: `${T('MemoryEntry')}[]` },
  { method: 'saveMemory', channel: 'memory:save', args: [{ name: 'entry', type: `Partial<${T('MemoryEntry')}>` }], returns: T('MemoryEntry') },
  { method: 'removeMemory', channel: 'memory:remove', args: [id, workspace, chatId], returns: 'unknown' },
  { method: 'pinMemory', channel: 'memory:pin', args: [id, pinned, workspace, chatId], returns: T('MemoryEntry') },
  { method: 'setMemorySharing', channel: 'memory:sharing', args: [workspace, { name: 'enabled', type: 'boolean' }], returns: 'boolean' },
  { method: 'forgetChatMemory', channel: 'memory:forget-chat', args: [workspace, { name: 'chatId', type: 'string' }], returns: 'number' },
  { method: 'memoryStats', channel: 'memory:stats', args: [workspace, chatId], returns: T('LibraryStats') },
  { method: 'listCapabilities', channel: 'capabilities:list', args: [workspace], returns: `${T('Capability')}[]` },
  { method: 'pinCapability', channel: 'capabilities:pin', args: [id, pinned, workspace], returns: T('Capability') },
  { method: 'readCapability', channel: 'capabilities:read', args: [id, workspace], returns: T('Capability') },
  { method: 'installCapability', channel: 'capabilities:install', args: [{ name: 'entry', type: `Partial<${T('Capability')}>` }], returns: T('Capability') },
  { method: 'removeCapability', channel: 'capabilities:remove', args: [id, workspace], returns: 'unknown' },
  { method: 'restoreCapability', channel: 'capabilities:restore', args: [id, { name: 'version', type: 'number' }, workspace], returns: T('Capability') },
  { method: 'checkProviders', channel: 'providers:health', args: [providerOptions], returns: 'ProviderHealth[]' },
  { method: 'getQuotas', channel: 'quota:get', args: [providerOptions, { name: 'force', type: 'boolean', optional: true }], returns: `Record<string, ${T('QuotaSnapshot')}>` },
  // The only path into electron/worktree.mts; unused by the renderer today, kept for the write-lane flow.
  { method: 'applyArtifact', channel: 'artifact:apply', args: [{ name: 'payload', type: 'ApplyArtifactPayload' }], returns: 'ApplyArtifactResult' },
  { method: 'openExternal', channel: 'shell:open', args: [{ name: 'target', type: 'string' }], returns: 'void' },
  // Liveness probe used by the self-upgrade health check, and the in-place restart it or the user can ask for.
  { method: 'ping', channel: 'app:ping', args: [], returns: '{ pid: number; startedAt: number; healthy: boolean }' },
  { method: 'relaunch', channel: 'app:relaunch', args: [], returns: '{ ok: boolean; pid: number }' },
]

// main → renderer messages (webContents.send(channel, payload)); the handler receives the payload.
/** @type {IpcEntry[]} */
const EVENTS = [
  { method: 'onQuotaUpdate', channel: 'quota:update', args: [{ name: 'handler', type: '(update: QuotaUpdate) => void' }], returns: '() => void', push: true },
  { method: 'onRuntimeEvent', channel: 'runtime:event', args: [{ name: 'handler', type: '(event: RuntimeEvent) => void' }], returns: '() => void', push: true },
]

/** @type {IpcEntry[]} */
const ENTRIES = [...CALLS, ...EVENTS]
/** @returns {string[]} */
const callChannels = () => CALLS.map(entry => entry.channel)
/** @returns {string[]} */
const pushChannels = () => EVENTS.map(entry => entry.channel)
/** @returns {string[]} */
const methods = () => ENTRIES.map(entry => entry.method)

module.exports = { TYPES, CALLS, EVENTS, ENTRIES, callChannels, pushChannels, methods }
