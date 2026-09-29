import path from 'node:path'
import { readJSON, writeJSON, keyCache } from './storage.mts'

const keyFor = keyCache(200)

// One shared note of a workspace as `shared-context.mts` saves it: a key, a summary, and the hash of each file it
// depends on (null when the file could not be hashed), so its staleness can be told later.
interface ContextNote { key: string; summary: string; files: Record<string, string | null>; updatedAt: string }
// What is stored per workspace: its notes, its key and when they last changed.
interface ContextRecord { notes: ContextNote[]; workspace: string; updatedAt?: string }
// What `set` accepts: the notes, and nothing else is kept.
interface ContextSnapshot { notes?: ContextNote[] | null }

// One record per workspace: its shared notes. Older versions also stored a Git fingerprint, folder counts and a
// `recent` list here; nothing reads them any more, so they are dropped on load and gone after the next save.
class ProjectContextStore {
  declare file: string
  declare entries: Record<string, ContextRecord>
  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, 'project-context.json')
    this.entries = this.load()
  }

  load(): Record<string, ContextRecord> {
    try {
      const parsed = readJSON(this.file, {})
      if (!parsed || typeof parsed !== 'object') return {}
      const entries: Record<string, ContextRecord> = {}
      for (const [workspace, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object') continue
        // The notes are taken as `saveNote` wrote them; their fields are read defensively where they are used.
        const record = entry as { notes?: unknown; updatedAt?: unknown }
        entries[workspace] = { notes: Array.isArray(record.notes) ? record.notes as ContextNote[] : [], workspace, ...(record.updatedAt ? { updatedAt: String(record.updatedAt) } : {}) }
      }
      return entries
    } catch { return {} }
  }

  persist(): void {
    writeJSON(this.file, this.entries)
  }

  getLatest(workspace: string | null | undefined): ContextRecord | null {
    return this.entries[keyFor(workspace)] || null
  }

  set(workspace: string | null | undefined, snapshot: ContextSnapshot | null | undefined): ContextRecord | ContextSnapshot | null | undefined {
    const key = keyFor(workspace)
    if (!key) return snapshot
    this.entries[key] = { notes: Array.isArray(snapshot?.notes) ? snapshot.notes : [], workspace: key, updatedAt: new Date().toISOString() }
    this.persist()
    return this.entries[key]
  }
}

export { ProjectContextStore }
export type { ContextNote, ContextRecord, ContextSnapshot }
