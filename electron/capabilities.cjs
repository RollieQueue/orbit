const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { readJSON, writeJSON, workspaceKey, redact, clone } = require('./storage.cjs')

class CapabilityStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'capabilities.json')
    const data = readJSON(this.file, [])
    this.entries = Array.isArray(data) ? data.filter(entry => entry && typeof entry.instructions === 'string') : []
  }

  visible(workspace) {
    const key = workspaceKey(workspace)
    return this.entries.filter(entry => entry.scope === 'global' || (key && workspaceKey(entry.workspace) === key))
  }

  list(workspace) {
    // Prompt assembly gets an index; instructions are loaded only when needed.
    return clone(this.visible(workspace).map(({ instructions, revisions, ...entry }) => entry))
  }

  read(id, workspace) {
    const entry = this.visible(workspace).find(item => item.id === id)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    return clone(entry)
  }

  install(input) {
    if (!input || typeof input !== 'object') throw new Error('Capability is required')
    const scope = input.scope === 'global' ? 'global' : 'project'
    const workspace = scope === 'project' ? workspaceKey(input.workspace) : undefined
    if (scope === 'project' && !workspace) throw new Error('Project capability requires a workspace')
    const name = redact(input.name || input.id).trim().slice(0, 120)
    const instructions = redact(input.instructions).trim().slice(0, 24000)
    if (!name || !instructions) throw new Error('Capability name and instructions are required')
    const existing = input.id ? this.entries.find(entry => entry.id === input.id) : this.visible(workspace).find(entry => entry.name === name && entry.scope === scope)
    if (existing && (existing.scope !== scope || workspaceKey(existing.workspace) !== workspaceKey(workspace))) {
      throw new Error('Cannot replace a capability from another project or scope')
    }
    const entry = {
      id: existing?.id || (typeof input.id === 'string' && input.id.trim() ? input.id.slice(0, 120) : randomUUID()), name,
      description: redact(input.description || '').slice(0, 600), instructions,
      scope, ...(workspace ? { workspace } : {}),
      source: redact(input.source || 'agent').slice(0, 300),
      version: (existing?.version || 0) + 1, updatedAt: new Date().toISOString(),
      revisions: existing ? [...(existing.revisions || []), {
        version: existing.version, name: existing.name, description: existing.description,
        instructions: existing.instructions, updatedAt: existing.updatedAt,
      }].slice(-10) : [],
    }
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    writeJSON(this.file, entries)
    this.entries = entries
    return clone(entry)
  }

  remove(id, workspace) {
    if (!this.visible(workspace).some(entry => entry.id === id)) return false
    const entries = this.entries.filter(entry => entry.id !== id)
    writeJSON(this.file, entries)
    this.entries = entries
    return true
  }

  restore(id, version, workspace) {
    const entry = this.read(id, workspace)
    const revision = entry.revisions.find(item => item.version === version)
    if (!revision) throw new Error('Capability revision was not found')
    return this.install({ ...entry, ...revision, id: entry.id })
  }
}

module.exports = { CapabilityStore }
