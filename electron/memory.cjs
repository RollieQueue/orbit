const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { readJSON, writeJSON, workspaceKey, redact, clone } = require('./storage.cjs')

// These four fabricated entries were shipped by the old demo. They are not user memory.
const demoTitles = new Map([
  ['m1', 'Local-first by default'], ['m2', 'Agent-centric interface'],
  ['m3', 'Provider adapters stay replaceable'], ['m4', 'Every write needs verification'],
])

class OrbitMemoryStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'memory.json')
    const data = readJSON(this.file, [])
    this.entries = (Array.isArray(data) ? data : []).filter(entry => entry && typeof entry === 'object')
      .filter(entry => demoTitles.get(entry.id) !== entry.title)
      // Unscoped legacy project records remain on disk, but never leak into another project.
      .map(entry => ({ ...entry, title: redact(entry.title), content: redact(entry.content) }))
  }

  list(workspace, includeGlobal = true) {
    const key = workspaceKey(workspace)
    return clone(this.entries.filter(entry => (includeGlobal && entry.scope === 'global') ||
      (entry.scope === 'project' && key && workspaceKey(entry.workspace) === key)))
  }

  search(query, workspace, limit = 6, includeGlobal = true) {
    const words = [...new Set(String(query || '').toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])]
    return this.list(workspace, includeGlobal)
      .map(entry => {
        const title = entry.title.toLocaleLowerCase()
        const body = entry.content.toLocaleLowerCase()
        const matches = words.reduce((score, word) => score + (title.includes(word) ? 3 : body.includes(word) ? 1 : 0), 0)
        return { entry, score: matches + (entry.type === 'preference' ? 0.5 : 0) }
      })
      .filter(item => !words.length || item.score > 0)
      .sort((a, b) => b.score - a.score || String(b.entry.updated).localeCompare(String(a.entry.updated)))
      .slice(0, Math.max(1, Math.min(30, Number(limit) || 6)))
      .map(item => item.entry)
  }

  upsert(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('Memory entry is required')
    const scope = entry.scope === 'global' ? 'global' : 'project'
    const workspace = scope === 'project' ? workspaceKey(entry.workspace) : undefined
    if (scope === 'project' && !workspace) throw new Error('Project memory requires a workspace')
    const title = redact(entry.title).trim().slice(0, 200)
    const content = redact(entry.content).trim().slice(0, 16000)
    if (!title || !content) throw new Error('Memory title and content are required')
    const existing = this.entries.find(item => item.id === entry.id)
    if (existing && (existing.scope !== scope || workspaceKey(existing.workspace) !== workspaceKey(workspace))) {
      throw new Error('Memory belongs to a different scope or project')
    }
    const normalized = {
      id: existing?.id || (typeof entry.id === 'string' && entry.id.trim() ? entry.id.slice(0, 120) : randomUUID()), title, content, scope,
      ...(workspace ? { workspace } : {}),
      type: ['decision', 'pattern', 'preference', 'fact'].includes(entry.type) ? entry.type : 'fact',
      confidence: Math.max(0, Math.min(100, Number.isFinite(entry.confidence) ? entry.confidence : 80)),
      updated: new Date().toISOString(),
    }
    const entries = existing ? this.entries.map(item => item === existing ? normalized : item) : [normalized, ...this.entries]
    writeJSON(this.file, entries)
    this.entries = entries
    return clone(normalized)
  }

  remove(id, workspace) {
    if (!this.list(workspace).some(entry => entry.id === id)) return false
    const entries = this.entries.filter(entry => entry.id !== id)
    writeJSON(this.file, entries)
    this.entries = entries
    return true
  }
}

module.exports = { OrbitMemoryStore }
