'use strict'
const path = require('node:path')

// Who touched which file during one run. Sources: Orbit's own file tools (exact), events from a vendor's
// native tools (Codex file changes, Claude Read/Edit/Write) and, best effort, files a command changed.
// The router uses this to find the right teammate and to warn agents about each other's edits.
const PER_AGENT_LIMIT = 200
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'file_change', 'filechange', 'apply_patch', 'str_replace_editor', 'create_file'])
const READ_TOOLS = new Set(['read', 'view', 'read_file'])
const FAILED = /^(?:failed|declined|denied|error|cancelled|canceled|rejected)$/i
const COMPLETED = /^(?:completed|complete|success|succeeded|done)$/i

const insensitive = process.platform === 'win32'
const keyOf = rel => insensitive ? rel.toLowerCase() : rel
function normalizeRel(workspace, value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const resolved = path.resolve(workspace, value.trim())
  const rel = path.relative(workspace, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  const posix = rel.split(path.sep).join('/')
  return /(?:^|\/)(?:\.git|node_modules)(?:\/|$)/.test(posix) ? null : posix
}
// Paths a vendor tool event refers to, and whether it reads or changes them.
function touchesOf(event) {
  const tool = String(event?.tool || '').toLowerCase()
  const found = []
  if (Array.isArray(event?.changes)) for (const change of event.changes) if (typeof change?.path === 'string') found.push({ path: change.path, action: 'write' })
  const input = event?.input
  if (input && typeof input === 'object') {
    const target = input.file_path || input.notebook_path || input.path
    if (typeof target === 'string') {
      if (WRITE_TOOLS.has(tool)) found.push({ path: target, action: 'write' })
      else if (READ_TOOLS.has(tool)) found.push({ path: target, action: 'read' })
    }
  }
  return found
}

class FileActivity {
  constructor(workspace) {
    this.workspace = workspace
    this.files = new Map()   // key → { path, readers: Set, writers: Set, at }
    this.agents = new Map()  // agentId → { read: Set(path), wrote: Set(path) }
    this.pending = new Map() // native tool call → writes that only count once the call completed
  }
  record(agentId, target, action, at = new Date().toISOString()) {
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
    if (list.size > PER_AGENT_LIMIT) list.delete(list.values().next().value)
    return { path: rel, action, isNew }
  }
  // Folds one provider event into the record and returns what became known. Failed or declined native
  // edits never count, and an edit that is still running counts only when its completion arrives.
  nativeEvent(agentId, event) {
    const callId = event?.toolId ? `${agentId}:${event.toolId}` : null
    const status = String(event?.status || '')
    const touches = touchesOf(event)
    const recorded = []
    const commit = list => { for (const touch of list) { const result = this.record(agentId, touch.path, touch.action); if (result) recorded.push(result) } }
    if (FAILED.test(status)) { if (callId) this.pending.delete(callId); return recorded }
    if (touches.length) {
      const settled = COMPLETED.test(status) || !callId
      commit(touches.filter(touch => touch.action === 'read' || settled))
      if (callId && !settled) this.pending.set(callId, touches.filter(touch => touch.action === 'write'))
      else if (callId) this.pending.delete(callId)
    } else if (callId && this.pending.has(callId) && COMPLETED.test(status)) {
      commit(this.pending.get(callId)); this.pending.delete(callId)
    }
    if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value)
    return recorded
  }
  forAgent(agentId) {
    const mine = this.agents.get(agentId)
    return { read: mine ? [...mine.read].filter(file => !mine.wrote.has(file)) : [], wrote: mine ? [...mine.wrote] : [] }
  }
  // Other agents that read or changed this file, strongest relation first.
  peers(rel, exceptAgentId) {
    const file = this.files.get(keyOf(rel))
    if (!file) return []
    return [...file.writers].filter(id => id !== exceptAgentId).map(agentId => ({ agentId, how: 'wrote' }))
      .concat([...file.readers].filter(id => id !== exceptAgentId && !file.writers.has(id)).map(agentId => ({ agentId, how: 'read' })))
  }
  // Agents whose files match a path or, for a trailing slash, sit under a folder.
  owners(target) {
    const rel = normalizeRel(this.workspace, String(target).replace(/[\\/]+$/, ''))
    if (!rel) return []
    const wanted = keyOf(rel)
    const result = new Map()
    for (const [key, file] of this.files) {
      if (key !== wanted && !key.startsWith(`${wanted}/`)) continue
      for (const id of file.writers) result.set(id, 'wrote')
      for (const id of file.readers) if (!result.has(id)) result.set(id, 'read')
    }
    return [...result].map(([agentId, how]) => ({ agentId, how }))
  }
  shared() {
    return [...this.files.values()].filter(file => file.writers.size && new Set([...file.writers, ...file.readers]).size > 1)
  }
  snapshot(limit = 400) {
    return [...this.files.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
      .map(file => ({ path: file.path, readers: [...file.readers], writers: [...file.writers] }))
  }
}

module.exports = { FileActivity, normalizeRel, touchesOf }
