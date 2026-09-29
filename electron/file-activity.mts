import path from 'node:path'

// Who touched which file during one run. Sources: Orbit's own file tools (exact), events from a vendor's
// native tools (Codex file changes, Claude Read/Edit/Write) and, best effort, files a command changed.
// The router uses this to find the right teammate and to warn agents about each other's edits.
const PER_AGENT_LIMIT = 200
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'file_change', 'filechange', 'apply_patch', 'str_replace_editor', 'create_file'])
const READ_TOOLS = new Set(['read', 'view', 'read_file'])
const FAILED = /^(?:failed|declined|denied|error|cancelled|canceled|rejected)$/i
const COMPLETED = /^(?:completed|complete|success|succeeded|done)$/i

type FileAction = 'read' | 'write'
// A provider's native tool event as far as file activity reads it: every field comes from the vendor's stream and
// is checked before use. `changes` (Codex) lists the files a call changed; `input` (Claude) names the file.
interface NativeToolEvent { tool?: unknown; toolId?: unknown; status?: unknown; input?: unknown; changes?: unknown }
// One path an event refers to and what it did to it.
interface Touch { path: string; action: FileAction }
// What is known about one workspace path: who read it, who changed it, and when it was last touched.
interface FileRecord { path: string; readers: Set<string>; writers: Set<string>; at: string }
interface AgentFiles { read: Set<string>; wrote: Set<string> }
// What `record` answers: the normalised path and whether this agent is new to that side of it.
interface Recorded { path: string; action: FileAction; isNew: boolean }
interface Peer { agentId: string; how: 'wrote' | 'read' }

const insensitive = process.platform === 'win32'
const keyOf = (rel: string): string => insensitive ? rel.toLowerCase() : rel
// A field of a JSON-ish value: undefined unless `value` is an object that has it.
const field = (value: unknown, name: string): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined
function normalizeRel(workspace: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const resolved = path.resolve(workspace, value.trim())
  const rel = path.relative(workspace, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  const posix = rel.split(path.sep).join('/')
  return /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(posix) ? null : posix
}
// Paths a vendor tool event refers to, and whether it reads or changes them.
function touchesOf(event: NativeToolEvent | null | undefined): Touch[] {
  const tool = String(event?.tool || '').toLowerCase()
  const found: Touch[] = []
  if (Array.isArray(event?.changes)) for (const change of event.changes as unknown[]) { const target = field(change, 'path'); if (typeof target === 'string') found.push({ path: target, action: 'write' }) }
  const input = event?.input
  if (input && typeof input === 'object') {
    const target = field(input, 'file_path') || field(input, 'notebook_path') || field(input, 'path')
    if (typeof target === 'string') {
      if (WRITE_TOOLS.has(tool)) found.push({ path: target, action: 'write' })
      else if (READ_TOOLS.has(tool)) found.push({ path: target, action: 'read' })
    }
  }
  return found
}

class FileActivity {
  declare workspace: string
  declare files: Map<string, FileRecord>
  declare agents: Map<string, AgentFiles>
  declare pending: Map<string, Touch[]>
  constructor(workspace: string) {
    this.workspace = workspace
    this.files = new Map()   // key → { path, readers: Set, writers: Set, at }
    this.agents = new Map()  // agentId → { read: Set(path), wrote: Set(path) }
    this.pending = new Map() // native tool call → writes that only count once the call completed
  }
  record(agentId: string, target: unknown, action: FileAction, at = new Date().toISOString()): Recorded | null {
    const rel = normalizeRel(this.workspace, target)
    if (!rel || !['read', 'write'].includes(action)) return null
    const key = keyOf(rel)
    let file = this.files.get(key)
    if (!file) { file = { path: rel, readers: new Set(), writers: new Set(), at }; this.files.set(key, file) }
    const side = action === 'write' ? 'writers' : 'readers'
    const isNew = !file[side].has(agentId)
    file[side].add(agentId); file.at = at
    let mine = this.agents.get(agentId)
    if (!mine) { mine = { read: new Set(), wrote: new Set() }; this.agents.set(agentId, mine) }
    const list = action === 'write' ? mine.wrote : mine.read
    list.delete(rel); list.add(rel)
    if (list.size > PER_AGENT_LIMIT) list.delete(list.values().next().value!)
    return { path: rel, action, isNew }
  }
  // Folds one provider event into the record and returns what became known. Failed or declined native
  // edits never count, and an edit that is still running counts only when its completion arrives.
  nativeEvent(agentId: string, event: NativeToolEvent | null | undefined): Recorded[] {
    const callId = event?.toolId ? `${agentId}:${event.toolId}` : null
    const status = String(event?.status || '')
    const touches = touchesOf(event)
    const recorded: Recorded[] = []
    const commit = (list: Touch[]): void => { for (const touch of list) { const result = this.record(agentId, touch.path, touch.action); if (result) recorded.push(result) } }
    if (FAILED.test(status)) { if (callId) this.pending.delete(callId); return recorded }
    if (touches.length) {
      const settled = COMPLETED.test(status) || !callId
      commit(touches.filter(touch => touch.action === 'read' || settled))
      if (callId && !settled) this.pending.set(callId, touches.filter(touch => touch.action === 'write'))
      else if (callId) this.pending.delete(callId)
    } else if (callId && this.pending.has(callId) && COMPLETED.test(status)) {
      commit(this.pending.get(callId)!); this.pending.delete(callId)
    }
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!)
    return recorded
  }
  forAgent(agentId: string): { read: string[]; wrote: string[] } {
    const mine = this.agents.get(agentId)
    return { read: mine ? [...mine.read].filter(file => !mine.wrote.has(file)) : [], wrote: mine ? [...mine.wrote] : [] }
  }
  // Other agents that read or changed this file, strongest relation first.
  peers(rel: string, exceptAgentId?: string): Peer[] {
    const file = this.files.get(keyOf(rel))
    if (!file) return []
    return [...file.writers].filter(id => id !== exceptAgentId).map((agentId): Peer => ({ agentId, how: 'wrote' }))
      .concat([...file.readers].filter(id => id !== exceptAgentId && !file.writers.has(id)).map((agentId): Peer => ({ agentId, how: 'read' })))
  }
  // Agents whose files match a path or, for a trailing slash, sit under a folder.
  owners(target: unknown): Peer[] {
    const rel = normalizeRel(this.workspace, String(target).replace(/[\\/]+$/, ''))
    if (!rel) return []
    const wanted = keyOf(rel)
    const result = new Map<string, Peer['how']>()
    for (const [key, file] of this.files) {
      if (key !== wanted && !key.startsWith(`${wanted}/`)) continue
      for (const id of file.writers) result.set(id, 'wrote')
      for (const id of file.readers) if (!result.has(id)) result.set(id, 'read')
    }
    return [...result].map(([agentId, how]) => ({ agentId, how }))
  }
  shared(): FileRecord[] {
    return [...this.files.values()].filter(file => file.writers.size && new Set([...file.writers, ...file.readers]).size > 1)
  }
  snapshot(limit = 400): Array<{ path: string; readers: string[]; writers: string[] }> {
    return [...this.files.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
      .map(file => ({ path: file.path, readers: [...file.readers], writers: [...file.writers] }))
  }
}

export { FileActivity, normalizeRel, touchesOf }
export type { NativeToolEvent, FileAction, Touch, Recorded, Peer }
