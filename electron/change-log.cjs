'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { normalizeRel } = require('./file-activity.cjs')
const { unifiedDiff, fragmentDiff, lineOf } = require('./diff.cjs')

// Every file change of one run with its unified diff. Orbit's own file tools report exact before/after text;
// vendor tools only tell what they did, so their diffs come from the event, from the file and from Git, and
// when none of that is enough the change is listed without a diff. A diff is never guessed.
const MAX_DIFF_CHARS = 60000
const MAX_CHANGES = 400
const MAX_TOTAL_CHARS = 1.5 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_CALLS = 500
const GIT_TIMEOUT_MS = 5000
const SETTLED = /^(?:completed|complete|success|succeeded|done|failed|declined|denied|error|cancelled|canceled|rejected)$/i
const insensitive = process.platform === 'win32'
const keyOf = rel => insensitive ? rel.toLowerCase() : rel

function clipDiff(text) {
  if (text.length <= MAX_DIFF_CHARS) return { diff: text, truncated: false }
  return { diff: text.slice(0, text.lastIndexOf('\n', MAX_DIFF_CHARS) + 1), truncated: true }
}
// Only lines inside hunks count: a removed line that reads "-- note" is "--- note" in the diff, not a file header.
function countLines(diff) {
  let added = 0, removed = 0, inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) inHunk = true
    else if (line.startsWith('--- ') && !inHunk) continue
    else if (line.startsWith('+')) { if (inHunk) added++ }
    else if (line.startsWith('-') && inHunk) removed++
  }
  return { added, removed }
}

class ChangeLog {
  constructor(workspace) {
    this.workspace = workspace
    this.startedAt = Date.now() // a file born after this did not exist when the run began
    this.items = []
    this.chars = 0
    this.written = new Set() // files some write of this run has already touched
    this.calls = new Map()   // native tool call → what its events said about the edit
  }
  // True for the first write to a file in this run: only then is the file's HEAD version what the write started from.
  claim(rel) {
    const key = keyOf(rel), first = !this.written.has(key)
    this.written.add(key)
    return first
  }
  // What the events of one native tool call said so far. The input arrives before the completion, which names nothing.
  remember(agentId, event) {
    const callId = event?.toolId ? `${agentId}:${event.toolId}` : null
    let entry = null
    if (event?.input || event?.changes) {
      entry = { tool: String(event.tool || ''), input: event.input, changes: event.changes }
      if (callId) { this.calls.set(callId, entry); if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value) }
    } else if (callId) entry = this.calls.get(callId) || null
    if (callId && SETTLED.test(String(event?.status || ''))) this.calls.delete(callId)
    return entry
  }
  add({ agentId, path: target, kind, tool, source, before, after, diff, added, removed, truncated, binary }) {
    const rel = normalizeRel(this.workspace, target)
    if (!rel) return null
    if (typeof diff !== 'string' && before !== undefined && after !== undefined) {
      ({ diff, added, removed, truncated, binary } = unifiedDiff(before, after, { path: rel, maxChars: MAX_DIFF_CHARS }))
    } else if (typeof diff === 'string') {
      // The counts describe the whole change, not the part that is kept.
      if (added === undefined || removed === undefined) ({ added, removed } = countLines(diff))
      const clipped = clipDiff(diff)
      diff = clipped.diff; truncated = truncated || clipped.truncated
    }
    if (!kind) kind = before === null ? 'create' : after === null ? 'delete' : before !== undefined && after !== undefined ? 'modify' : 'unknown'
    const hasDiff = typeof diff === 'string' && diff.length > 0 && !binary
    const change = { id: randomUUID(), agentId, path: rel, kind, tool: String(tool || ''), time: new Date().toISOString(), added: added || 0, removed: removed || 0, source, hasDiff }
    if (hasDiff) { change.diff = diff; this.chars += diff.length }
    if (truncated) change.truncated = true
    if (binary) change.binary = true
    this.items.push(change)
    this.trim()
    return { ...change }
  }
  // Old changes give up their diff text first; the record of what changed stays until the run holds too many.
  trim() {
    if (this.items.length > MAX_CHANGES) for (const old of this.items.splice(0, this.items.length - MAX_CHANGES)) this.chars -= old.diff?.length || 0
    for (let index = 0; this.chars > MAX_TOTAL_CHARS && index < this.items.length - 1; index++) {
      const item = this.items[index]
      if (!item.diff) continue
      this.chars -= item.diff.length
      delete item.diff; item.hasDiff = false
    }
  }
  snapshot() { return this.items.map(change => ({ ...change })) }
}

function git(workspace, args) {
  return new Promise(resolve => {
    try {
      // Paths are names, never patterns ("[id]", "*.ts"), and no configured fsmonitor hook runs for a read.
      execFile('git', ['-C', workspace, '--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], {
        cwd: os.tmpdir(), timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES + 1024 * 1024, encoding: 'buffer', windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout) => resolve(error ? null : stdout))
    } catch { resolve(null) }
  })
}
// The text of a file: null when it does not exist, undefined when it cannot serve as text (too large, binary, unreadable).
async function readText(file) {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    const text = await fs.promises.readFile(file, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch (error) { return error?.code === 'ENOENT' ? null : undefined }
}
// Like readText, but only for a file that really lives inside the workspace: a symlink or junction that leads out of it reads as unknown.
async function workspaceText(workspace, file) {
  try {
    const [real, root] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(workspace)])
    const relative = path.relative(root, real)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  } catch (error) { return error?.code === 'ENOENT' ? null : undefined }
  return readText(file)
}
// Whether the file came into being after the run began (a file born in the very millisecond the run began counts as older).
async function createdSince(file, since) {
  try { return since > 0 && Math.floor((await fs.promises.stat(file)).birthtimeMs) > since } catch { return false }
}
// The committed version of a file; undefined when the workspace is no repository, the file is untracked or it is no text.
async function gitShow(workspace, rel) {
  const out = await git(workspace, ['show', `HEAD:./${rel}`])
  return out && out.length <= MAX_FILE_BYTES && !out.includes(0) ? out.toString('utf8') : undefined
}
// What `git diff HEAD` says about one file, in the contract's shape; null when Git has nothing to show.
async function gitDiff(workspace, rel) {
  // Git alone knows the line endings it stores: a CRLF working copy of an LF blob is not a change of every line.
  const out = await git(workspace, ['diff', '--relative', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', rel])
  if (!out || !out.length) return null
  const text = out.toString('utf8')
  if (/^Binary files .* differ$/m.test(text) && !text.includes('\n@@ ')) return { binary: true }
  const marker = text.startsWith('--- ') ? 0 : text.indexOf('\n--- ')
  return marker < 0 ? null : { diff: text.slice(marker ? marker + 1 : 0).replace(/\n$/, '') }
}

const KINDS = { add: 'create', create: 'create', delete: 'delete', remove: 'delete', update: 'modify', modify: 'modify' }
const kindOf = value => KINDS[String(value?.type || value || '').toLowerCase()] || 'unknown'
const HUNKS = /^@@ /m

function fragments(input, tool) {
  if (tool === 'multiedit') return Array.isArray(input.edits) ? input.edits : []
  return [{ old_string: input.old_string, new_string: input.new_string }]
}
// An Edit or MultiEdit gives the replaced text itself; where it now sits in the file supplies the line numbers.
async function editChange(workspace, rel, entry) {
  const tool = entry.tool.toLowerCase()
  const edits = fragments(entry.input, tool).filter(edit => typeof edit?.old_string === 'string' && typeof edit?.new_string === 'string')
  if (!edits.length) return null
  const text = await workspaceText(workspace, path.join(workspace, rel))
  const parts = edits.map(edit => {
    const line = typeof text === 'string' && edit.new_string ? lineOf(text, edit.new_string) : 0
    return fragmentDiff(edit.old_string, edit.new_string, { path: rel, ...(line ? { startLine: line } : {}) })
  })
  // One change per file: the first part keeps the file header, the others add their hunks.
  const diff = parts.map((part, index) => index ? part.diff.replace(/^--- .*\n\+\+\+ .*\n/, '') : part.diff).join('\n')
  return {
    kind: edits[0].old_string === '' ? 'create' : 'modify', source: 'event', diff,
    added: parts.reduce((sum, part) => sum + part.added, 0), removed: parts.reduce((sum, part) => sum + part.removed, 0), truncated: parts.some(part => part.truncated),
  }
}
const kindOfDiff = diff => /^--- \/dev\/null$/m.test(diff) ? 'create' : /^\+\+\+ \/dev\/null$/m.test(diff) ? 'delete' : 'modify'
// The change a vendor's native tool made to `rel`, as arguments for ChangeLog.add. `first` says no other write of this
// run touched the file before, so its HEAD version is what the write started from; `since` (ms) is when the run began.
async function nativeChange(workspace, rel, entry, first, since = 0) {
  const tool = entry?.tool.toLowerCase() || ''
  if ((tool === 'edit' || tool === 'multiedit') && entry.input) {
    const edit = await editChange(workspace, rel, entry)
    if (edit) return edit
  }
  const target = entry?.changes?.find(change => normalizeRel(workspace, change?.path) === rel)
  let kind = kindOf(target?.kind)
  if (typeof target?.diff === 'string' && HUNKS.test(target.diff)) {
    const header = target.diff.startsWith('--- ') ? '' : `--- a/${rel}\n+++ b/${rel}\n`
    return { kind, source: 'event', diff: header + target.diff }
  }
  const file = path.join(workspace, rel)
  if (kind === 'create') {
    const after = typeof entry?.input?.content === 'string' ? entry.input.content : await workspaceText(workspace, file)
    return typeof after === 'string' ? { kind, source: 'event', before: null, after } : { kind, source: 'event' }
  }
  if (!first) return { kind, source: 'event' }
  // The first write of the run: Git says what the file was, and a file born during the run was created by it.
  const found = await gitDiff(workspace, rel)
  if (found) return { kind: kind === 'unknown' && found.diff ? kindOfDiff(found.diff) : kind, source: 'git', ...found }
  if (kind !== 'delete' && await createdSince(file, since)) {
    const after = typeof entry?.input?.content === 'string' ? entry.input.content : await workspaceText(workspace, file)
    if (typeof after === 'string') return { kind: 'create', source: 'event', before: null, after }
  }
  return { kind, source: 'event' }
}
// A file a command changed. A file it created is exactly its current text; for the rest Git says what it can.
async function commandChange(workspace, rel, kind) {
  if (kind === 'create') {
    const after = await workspaceText(workspace, path.join(workspace, rel))
    if (typeof after === 'string') return { kind, source: 'exact', before: null, after }
  }
  const found = await gitDiff(workspace, rel)
  return { kind, source: 'git', ...(found || {}) }
}

module.exports = { ChangeLog, nativeChange, commandChange, gitShow, gitDiff, readText, MAX_DIFF_CHARS, MAX_CHANGES, MAX_TOTAL_CHARS }
