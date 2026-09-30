import fs from 'node:fs'
import path from 'node:path'
import { readJSON, writeJSON, clone } from './storage.mts'
import { recoverChanges } from './change-log.mts'
import type { ReportedWrite } from './change-log.mts'
import type { FileChange, StoredAgent, StoredRun } from './types.mts'

// A record without a status is not active. `restarting` is terminal: a run Orbit ended to restart with new code is kept
// as it is on load (never turned into `interrupted`), and the continuation after the restart links back to it.
const activeStatuses = new Set<string | undefined>(['running', 'working', 'waiting', 'queued', 'stopping'])

// The fields of a saved run this store reads (StoredRun, StoredAgent in types.mts). A snapshot carries much more
// (traces, messages, settings, timings); all of it is kept exactly as the runtime produced it.
// A saved run is any JSON object with a truthy `runId`, as every version of Orbit wrote them.
const isStoredRun = (value: unknown): value is StoredRun => Boolean((value as { runId?: unknown } | null | undefined)?.runId)

// A copy of a run record whose file changes carry no diff text, only `hasDiff`, so lists stay small. The text is
// served by RunStore.getChanges / the runtime on demand. The copy is shallow: everything but `changes` is shared.
function stripDiffs(record: StoredRun): StoredRun {
  if (!record || !Array.isArray(record.changes)) return record
  return {
    ...record,
    changes: record.changes.map(change => {
      const { diff, ...rest } = change
      return { ...rest, hasDiff: Boolean(diff) || change.hasDiff === true }
    }),
  }
}

class RunStore {
  declare root: string
  declare records: Map<string, StoredRun>
  declare dirty: Set<string>
  declare timer: ReturnType<typeof setTimeout> | null
  declare lastError: unknown
  constructor(userDataPath: string) {
    this.root = path.join(userDataPath, 'run-history')
    this.records = new Map()
    this.dirty = new Set()
    this.timer = null
    this.lastError = null
    fs.mkdirSync(this.root, { recursive: true })
    const recentFiles = fs.readdirSync(this.root).filter(name => /^[\w-]+\.json$/.test(name))
      .map(name => ({ name, modified: fs.statSync(path.join(this.root, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified).slice(0, 200)
    for (const { name: file } of recentFiles) {
      const record = readJSON(path.join(this.root, file), null)
      if (!isStoredRun(record)) continue
      if (activeStatuses.has(record.status)) {
        record.status = 'interrupted'
        record.error = 'Orbit was closed before this run completed. Send a message to continue with the saved conversation.'
        record.finishedAt = new Date().toISOString()
        record.agents = (record.agents || []).map(agent => activeStatuses.has(agent.status)
          ? { ...agent, status: 'cancelled', detail: 'Interrupted when Orbit stopped' } : agent)
        writeJSON(path.join(this.root, file), record)
      }
      this.records.set(record.runId, record)
    }
  }

  save(snapshot: StoredRun): void {
    if (!snapshot?.runId || !/^[\w-]+$/.test(snapshot.runId)) throw new Error('Invalid run identifier')
    const previousError = this.lastError
    this.lastError = null
    this.records.set(snapshot.runId, clone({ ...snapshot, updatedAt: new Date().toISOString() }))
    this.dirty.add(snapshot.runId)
    if (!activeStatuses.has(snapshot.status)) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        try { this.flush() } catch (error) { this.lastError = error }
      }, 250)
      this.timer.unref?.()
    }
    // Preserve the current (especially terminal) snapshot before surfacing an earlier flush failure.
    if (previousError) throw previousError
  }

  flush(): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    for (const id of this.dirty) {
      writeJSON(path.join(this.root, `${id}.json`), this.records.get(id))
      this.dirty.delete(id)
    }
    if (this.records.size > 200) {
      const oldest = [...this.records.values()].filter(record => !activeStatuses.has(record.status))
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
      for (const record of oldest.slice(0, this.records.size - 200)) this.records.delete(record.runId)
    }
  }

  get(id: unknown): StoredRun | null {
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null
    // A file this store did not load (older than the newest 200) is served as it was written.
    return this.records.has(id) ? clone(this.records.get(id)!) : readJSON(path.join(this.root, `${id}.json`), null) as StoredRun | null
  }

  // The full file changes (with diff text) of one run, for the renderer to ask for on demand.
  getChanges(id: unknown): FileChange[] {
    const changes = this.get(id)?.changes
    return Array.isArray(changes) ? changes : []
  }

  // Files the agents reported writing that no change record covers: every file of a run saved before Orbit
  // recorded changes, or a write whose record was lost. Each comes back as a change whose diff, when Git still
  // shows one relative to the commit the run started from, is labelled `git` with that commit in `base`; otherwise
  // `reason` says why there is none. `known` adds the live records of a run that is still in memory.
  async recoverChanges(id: unknown, known: FileChange[] = []): Promise<FileChange[]> {
    const record = this.get(id)
    if (!record?.workspace) return []
    const covered = new Set([...(Array.isArray(known) ? known : []), ...(Array.isArray(record.changes) ? record.changes : [])].map(change => `${change.agentId}:${change.path}`))
    const writes: ReportedWrite[] = []
    for (const agent of record.agents || []) {
      for (const file of agent.files?.wrote || []) if (!covered.has(`${agent.id}:${file}`)) writes.push({ agentId: agent.id, path: file, time: agent.finishedAt || record.finishedAt || record.startedAt })
    }
    return writes.length ? recoverChanges(record.workspace, record.startedAt, writes) : []
  }

  // Only the runs of one chat are copied: the whole history can be many megabytes.
  forChat(projectId: unknown, chatId: unknown, limit = 8): StoredRun[] {
    const matching = [...this.records.values()].filter(record => record.projectId === projectId && record.chatId === chatId)
    return clone(matching.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit).map(stripDiffs))
  }

  list(): StoredRun[] {
    return clone([...this.records.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 200).map(stripDiffs))
  }
}

class StateStore {
  declare file: string
  constructor(userDataPath: string) { this.file = path.join(userDataPath, 'workspace-state.json') }
  // The renderer's state as it saved it; the main process never looks inside.
  load(): unknown { return readJSON(this.file, null) }
  save(state: unknown): true {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid workspace state')
    if (Buffer.byteLength(JSON.stringify(state)) > 20 * 1024 * 1024) throw new Error('Workspace state exceeds 20 MB')
    writeJSON(this.file, state)
    return true
  }
}

export { RunStore, StateStore, stripDiffs }
export type { StoredRun, StoredAgent }
