const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function readJSON(file, fallback) {
  for (const candidate of [file, `${file}.bak`]) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')) } catch { /* Try the last good copy. */ }
  }
  return typeof fallback === 'function' ? fallback() : fallback
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// Windows briefly locks a just-written file (antivirus, indexers). A rename that loses that race fails
// with EPERM/EBUSY/EACCES although the same rename succeeds a few milliseconds later.
function renameReliably(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to) }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error
      pause(15 * (attempt + 1))
    }
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    if (fs.existsSync(file)) {
      // Never replace a valid backup with an unreadable primary file.
      try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, `${file}.bak`) } catch { /* Keep backup. */ }
    }
    renameReliably(temporary, file)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* A locked leftover must not mask the write result. */ }
  }
}

// A CLI's working directory or files stay locked on Windows (EBUSY/EPERM) until its process tree has fully
// exited, which can be after its answer was already read. Removing a temporary directory is housekeeping:
// retry later, and never let its error replace the real outcome of a turn.
function removeTemporaryDirectory(directory, prefix, delayMs = 1500) {
  if (!directory || path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(prefix)) return
  const attempt = remaining => {
    try { fs.rmSync(directory, { recursive: true, force: true }) }
    catch { if (remaining > 0) setTimeout(() => attempt(remaining - 1), delayMs).unref?.() }
  }
  attempt(8)
}

function workspaceKey(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  let resolved
  try { resolved = fs.realpathSync.native(value) } catch { resolved = path.resolve(value) }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// workspaceKey touches the disk (realpath); stores compare thousands of stored keys, so they resolve each path once.
function keyCache(limit = 200) {
  const keys = new Map()
  return workspace => {
    if (typeof workspace !== 'string' || !workspace.trim()) return ''
    let key = keys.get(workspace)
    if (key === undefined) {
      key = workspaceKey(workspace)
      if (keys.size >= limit) keys.clear()
      keys.set(workspace, key)
    }
    return key
  }
}

function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:sk-|pk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s,;"']+["']?/gi, '$1=[redacted]')
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }

module.exports = { readJSON, writeJSON, workspaceKey, keyCache, redact, clone, removeTemporaryDirectory }
