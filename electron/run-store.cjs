const fs = require('node:fs')
const path = require('node:path')
const { readJSON, writeJSON, clone } = require('./storage.cjs')

const activeStatuses = new Set(['running', 'working', 'waiting', 'queued', 'stopping'])

class RunStore {
  constructor(userDataPath) {
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
      if (!record?.runId) continue
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

  save(snapshot) {
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

  flush() {
    clearTimeout(this.timer)
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

  get(id) {
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null
    return this.records.has(id) ? clone(this.records.get(id)) : readJSON(path.join(this.root, `${id}.json`), null)
  }

  list() {
    return clone([...this.records.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 200))
  }
}

class StateStore {
  constructor(userDataPath) { this.file = path.join(userDataPath, 'workspace-state.json') }
  load() { return readJSON(this.file, null) }
  save(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid workspace state')
    if (Buffer.byteLength(JSON.stringify(state)) > 20 * 1024 * 1024) throw new Error('Workspace state exceeds 20 MB')
    writeJSON(this.file, state)
    return true
  }
}

module.exports = { RunStore, StateStore }
