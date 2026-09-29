const fs = require('node:fs')
const path = require('node:path')
const { readJSON, writeJSON, workspaceKey } = require('./storage.cjs')

function keyFor(value) {
  return workspaceKey(value)
}

class ProjectContextStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'project-context.json')
    this.entries = this.load()
  }

  load() {
    try {
      const parsed = readJSON(this.file, {})
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  persist() {
    writeJSON(this.file, this.entries)
  }

  get(workspace, fingerprint) {
    const entry = this.entries[keyFor(workspace)]
    return entry && entry.fingerprint === fingerprint ? entry : null
  }

  getLatest(workspace) {
    return this.entries[keyFor(workspace)] || null
  }

  set(workspace, snapshot) {
    const key = keyFor(workspace)
    if (!key) return snapshot
    this.entries[key] = { ...snapshot, workspace: key, updatedAt: new Date().toISOString() }
    this.persist()
    return this.entries[key]
  }
}

module.exports = { ProjectContextStore }
