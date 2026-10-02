// The runtime's side of electron/ipc-contract.cjs: one handler per call channel the runtime serves (RUNTIME_CHANNELS of
// runtime-protocol.mts), keyed by channel. The bodies are the ones electron/ipc-handlers.cjs had while main.cjs hosted
// the runtime, with the same argument checks and the same results. The renderer's arguments arrive untyped, so each
// handler narrows what it relies on and hands the rest to the runtime or the store, which check it themselves as
// before. Main keeps the dialogs, `shell`, `app`, the workspace picker and the restarts (SHELL_CHANNELS).
import fs from 'node:fs'
import path from 'node:path'
import { stripDiffs } from './run-store.mts'
import { PROVIDER_IDS } from './quota.mts'
import { applyPatch, removeWorktree } from './worktree.mts'
import { runGit } from './git.mts'
import { workspaceKey } from './storage.mts'
import { MAX_RUN_FILES, discardAttachments, readAttachmentImage, saveAttachments, trustedAttachments } from './attachments.mts'
import { RUNTIME_CHANNELS } from './runtime-protocol.mts'
import { projectStats } from './project-stats.mts'
import type { OrbitRuntime } from './runtime.mts'
import type { QuotaMonitor, QuotaReaderOptions } from './quota.mts'
import type { OrbitMemoryStore, MemoryInput } from './memory.mts'
import type { ProjectContextStore } from './project-context.mts'
import type { CapabilityStore, SkillInput } from './capabilities.mts'
import { testConnector } from './connectors.mts'
import type { ConnectorScope, ConnectorStore } from './connectors.mts'
import type { ProjectIndex } from './project-index.mts'
import type { RunStore, StateStore } from './run-store.mts'
import type { InspectOptions, ProviderHealth } from './providers.mts'
import type { FileChange, StartPayload, StoredRun } from './types.mts'

// Every store of the runtime, created by createRuntimeService before any call can arrive.
interface RuntimeStores {
  memoryStore: OrbitMemoryStore; projectContextStore: ProjectContextStore; capabilityStore: CapabilityStore; connectorStore: ConnectorStore
  projectIndex: ProjectIndex; runStore: RunStore; stateStore: StateStore
}
// What the handlers need: the runtime, the quota monitor, the stores, the profile folder (run artifacts live in
// `<userData>/runs`) and the provider inspection in use (the providers module's, or a smoke fixture).
interface RuntimeApiContext {
  runtime: OrbitRuntime
  quota: QuotaMonitor
  stores: RuntimeStores
  userData: string
  inspectProviders(options?: InspectOptions): Promise<ProviderHealth[]>
}
// One call channel's handler: the arguments the renderer sent, unchecked.
type RuntimeHandler = (...args: unknown[]) => unknown
// What artifact:apply is sent (ApplyArtifactPayload of ipc-contract.cjs); applyPatch checks the paths itself.
interface ApplyArtifactPayload { workspace: string; patchPath: string; worktreePath?: string }

// A string argument as it was sent; anything else becomes undefined, which the stores treat exactly as they treat a
// value that is not a string (no workspace key, no chat), so the results are those of passing it on unchanged.
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

// Throws unless `workspace` is an existing absolute folder; returns its real path (main.cjs's check, unchanged).
function validateWorkspace(workspace: unknown): string {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('Choose an absolute project folder')
  if (!fs.statSync(workspace).isDirectory()) throw new Error('Project folder does not exist')
  return fs.realpathSync.native(workspace)
}

// Whether `workspace` is the root of a Git repository whose branch and status Git can read: `connected` of main.cjs's
// getGitContext, which is what artifact:apply requires. Git runs as it does there (electron/git.mts, 5 s per call).
async function isRepositoryRoot(workspace: unknown): Promise<boolean> {
  const folder = validateWorkspace(workspace)
  const git = (args: string[]) => runGit(folder, args, { timeoutMs: 5000 })
  const root = await git(['rev-parse', '--show-toplevel'])
  if (!root.ok) return false
  if (workspaceKey(fs.realpathSync.native(folder)) !== workspaceKey(fs.realpathSync.native(root.value || root.stderr))) return false
  const [branch, status] = await Promise.all([git(['branch', '--show-current']), git(['status', '--porcelain'])])
  return branch.ok && status.ok
}

// Every runtime channel has a handler and every handler is a runtime channel; a mismatch is a start-up error.
function assertRuntimeChannels(handlers: Map<string, RuntimeHandler>, expected: readonly string[] = RUNTIME_CHANNELS): void {
  const wanted = new Set(expected)
  const missing = [...wanted].filter(channel => !handlers.has(channel))
  const extra = [...handlers.keys()].filter(channel => !wanted.has(channel))
  if (!missing.length && !extra.length) return
  const problems = [...(missing.length ? [`no handler for ${missing.join(', ')}`] : []), ...(extra.length ? [`handler without a channel entry: ${extra.join(', ')}`] : [])]
  throw new Error(`Runtime channel mismatch (electron/runtime-protocol.mts vs electron/runtime-api.mts): ${problems.join('; ')}`)
}

function createRuntimeApi(ctx: RuntimeApiContext): Map<string, RuntimeHandler> {
  const { runtime, quota, stores, userData, inspectProviders } = ctx
  const artifactRoot = path.join(userData, 'runs')
  const handlers = new Map<string, RuntimeHandler>()
  const handle = (channel: string, handler: RuntimeHandler): void => {
    if (handlers.has(channel)) throw new Error(`Runtime handler for ${channel} is defined twice`)
    handlers.set(channel, handler)
  }

  handle('runtime:start', (value) => {
    // The renderer's StartTaskPayload, unchecked beyond this: lifecycle.start validates what a run relies on.
    const payload = value as StartPayload | null | undefined
    const workspace = validateWorkspace(payload?.workspace)
    if (!payload?.projectId || !payload?.chatId) throw new Error('Project and chat are required')
    const request: StartPayload & { artifactRoot: string } = {
      ...payload, workspace, attachments: trustedAttachments(userData, payload.attachments), resumeAttachments: trustedAttachments(userData, payload.resumeAttachments, MAX_RUN_FILES),
      memoryContext: payload.memoryEnabled ? stores.memoryStore.search(payload.prompt, workspace, 6, payload.globalMemoryEnabled !== false, payload.chatId) : [],
      artifactRoot,
    }
    return runtime.start(request)
  })
  // A run id that is not a string names no run: stop answers false and get null, as the runtime and the store did.
  handle('runtime:stop', (runId) => typeof runId === 'string' ? runtime.stop(runId) : false)
  // The user's message to an agent of a working run; the runtime checks the run, the agent and the text.
  handle('runtime:message', (runId, agentId, message, attachments) => runtime.postUserMessage(text(runId) ?? '', text(agentId) ?? '', message, trustedAttachments(userData, attachments)))
  // Attached files: saved under <userData>/attachments and handed back as paths; the window's own paths are trusted only there.
  handle('attachments:save', (chatId, files) => saveAttachments(userData, text(chatId) ?? '', files))
  handle('attachments:image', (file) => readAttachmentImage(userData, file))
  // Saved files no message will carry: those of a refused send (the window names them) or a deleted chat's whole folder.
  handle('attachments:discard', (chatId, paths) => discardAttachments(userData, text(chatId) ?? '', paths))
  handle('runtime:pause', (runId, agentId) => runtime.pauseAgent(text(runId) ?? '', text(agentId) ?? ''))
  handle('runtime:resume', (runId, agentId) => runtime.resumeAgent(text(runId) ?? '', text(agentId) ?? ''))
  handle('runtime:stop-agent', (runId, agentId) => runtime.stopAgent(text(runId) ?? '', text(agentId) ?? ''))
  handle('runtime:list', () => {
    const records = new Map<string, StoredRun>(stores.runStore.list().map(run => [run.runId, run]))
    for (const run of runtime.getRuns()) records.set(run.runId, stripDiffs(run))
    return [...records.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  })
  handle('runtime:get', (runId) => typeof runId === 'string' ? runtime.getRun(runId) || stores.runStore.get(runId) || null : null)
  // Diff texts are not part of run lists; the inspector asks for one run's changes when the user opens them.
  handle('runtime:changes', async (runId) => {
    if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId)) return []
    const known: FileChange[] = runtime.getRunChanges(runId) || stores.runStore.getChanges(runId) || []
    // Files written by agents that no record covers (runs saved before changes were tracked): Git may still show their diff.
    const recovered = await stores.runStore.recoverChanges(runId, known).catch((): FileChange[] => [])
    return recovered.length ? known.concat(recovered) : known
  })
  // The images a trace names (tool results an agent looked at), one at a time as the window shows them.
  handle('runtime:image', (runId, imageId) => stores.runStore.readImage(runId, imageId))
  handle('state:load', () => stores.stateStore.load())
  handle('state:save', (state) => stores.stateStore.save(state))
  // Building the index is the same scan a task starts with; asking for it first just makes the first task faster.
  handle('project-index:status', async (workspace, rebuild) => {
    const folder = validateWorkspace(workspace)
    await stores.projectIndex.refresh(folder, { force: rebuild === true })
    return stores.projectIndex.stats(folder)
  })
  // The stores check an entry themselves (save/install throw on a missing or malformed one), as they did before.
  handle('memory:list', (workspace, chatId) => stores.memoryStore.list(text(workspace), true, text(chatId)))
  handle('memory:save', (entry) => stores.memoryStore.upsert(entry as MemoryInput))
  handle('memory:remove', (id, workspace, chatId) => stores.memoryStore.remove(id, text(workspace), text(chatId)))
  handle('memory:pin', (id, pinned, workspace, chatId) => stores.memoryStore.pin(id, pinned === true, text(workspace), text(chatId)))
  // The renderer owns the per-project switch for shared memory; the runtime needs it to know which projects may contribute.
  handle('memory:sharing', (workspace, enabled) => { runtime.setSharing(workspace, enabled === true); return true })
  handle('memory:forget-chat', (workspace, chatId) => stores.memoryStore.forgetChat(text(workspace), text(chatId)))
  // How full each tier of memory and each skill library is, for the panels.
  handle('memory:stats', (workspace, chatId) => ({ memory: stores.memoryStore.stats(text(workspace), text(chatId)), skills: stores.capabilityStore.stats(text(workspace)) }))
  handle('capabilities:list', (workspace) => stores.capabilityStore.list(text(workspace)))
  handle('capabilities:pin', (id, pinned, workspace) => stores.capabilityStore.pin(id, pinned === true, text(workspace)))
  handle('capabilities:enable', (id, enabled, workspace) => stores.capabilityStore.setEnabled(id, enabled === true, text(workspace)))
  handle('capabilities:params', (id, values, workspace) => stores.capabilityStore.setParams(id, values, text(workspace)))
  handle('capabilities:read', (id, workspace) => stores.capabilityStore.read(id, text(workspace)))
  handle('capabilities:install', (entry) => stores.capabilityStore.install(entry as SkillInput))
  handle('capabilities:remove', (id, workspace) => stores.capabilityStore.remove(id, text(workspace)))
  handle('capabilities:restore', (id, version, workspace) => stores.capabilityStore.restore(id, version, text(workspace)))
  // Connectors, for the Skills panel: the project's and the global ones, secrets masked (the store's views). A name and a scope
  // address one; a missing one is an error the panel shows.
  const connectorScope = (value: unknown): ConnectorScope => {
    if (value !== 'global' && value !== 'project') throw new Error('scope must be "project" or "global"')
    return value
  }
  const missing = (name: unknown) => new Error(`No connector named "${String(name).slice(0, 60)}"`)
  handle('connectors:list', (workspace) => stores.connectorStore.list(text(workspace) ?? ''))
  handle('connectors:enable', (name, enabled, scope, workspace) => stores.connectorStore.setEnabled(String(name), enabled === true, { scope: connectorScope(scope), workspace: text(workspace) ?? '' }) ?? (() => { throw missing(name) })())
  handle('connectors:remove', (name, scope, workspace) => stores.connectorStore.remove(String(name), { scope: connectorScope(scope), workspace: text(workspace) ?? '' }) ?? (() => { throw missing(name) })())
  handle('connectors:test', async (name, scope, workspace) => {
    const found = stores.connectorStore.find(String(name), text(workspace) ?? '', connectorScope(scope))
    if (!found) throw missing(name)
    return testConnector(found, { cwd: text(workspace) || undefined })
  })
  // The inspection in use: a fixture installed before start-up (smoke:desktop) answers instead of the CLIs.
  handle('providers:health', (options) => inspectProviders(options as InspectOptions | undefined))
  handle('quota:get', (providerOptions, force) => quota.all(PROVIDER_IDS, {
    options: providerOptions && typeof providerOptions === 'object' ? providerOptions as Record<string, QuotaReaderOptions | undefined> : {},
    force: force === true,
  }))
  // Lines of code and spent tokens of a project over time, for skill pages in the quota window.
  handle('stats:project', (workspace) => projectStats(userData, text(workspace) ?? ''))
  // The only path into electron/worktree.mts; unused by the renderer today, kept for the write-lane flow.
  handle('artifact:apply', async (value) => {
    const payload = value as ApplyArtifactPayload
    if (!await isRepositoryRoot(payload.workspace)) return { ok: false, reason: 'workspace_not_root', detail: 'Apply requires the exact Git repository root that produced this artifact.' }
    const result = await applyPatch({ ...payload, artifactRoot })
    if (result.ok && payload.worktreePath) await removeWorktree(payload.workspace, payload.worktreePath)
    return result
  })
  assertRuntimeChannels(handlers)
  return handlers
}

export { createRuntimeApi, assertRuntimeChannels, validateWorkspace, isRepositoryRoot }
export type { RuntimeStores, RuntimeApiContext, RuntimeHandler, ApplyArtifactPayload }
