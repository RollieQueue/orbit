const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { workspacePath, BUILD_OUTPUT } = require('./runtime-tools.cjs')
const { redact } = require('./storage.cjs')
const fileHashes = new Map()

const digest = text => createHash('sha256').update(text).digest('hex')
function signatures(workspace, files) {
  return Object.fromEntries(files.map(file => {
    try {
      const target = workspacePath(workspace, file), stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Context dependencies must be text-sized files')
      const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      const cached = fileHashes.get(target)
      const hash = cached?.version === version ? cached.hash : digest(fs.readFileSync(target))
      fileHashes.set(target, { version, hash })
      if (fileHashes.size > 1000) fileHashes.delete(fileHashes.keys().next().value)
      return [file, hash]
    }
    catch { return [file, null] }
  }))
}
// Local metadata only: no model call and no recursive repository exploration.
function bootstrap(workspace) {
  const all = fs.readdirSync(workspace, { withFileTypes: true }).filter(entry => !['.git', 'node_modules'].includes(entry.name))
  const source = all.filter(entry => !BUILD_OUTPUT.test(entry.name))
  const entries = source.slice(0, 120).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort()
  if (all.length > source.length) entries.push(`(${all.length - source.length} generated build folders omitted)`)
  let scripts = {}
  try { scripts = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')).scripts || {} } catch {}
  return { entries, scripts }
}
function projectPacket(store, workspace, fallback) {
  const saved = store?.getLatest(workspace) || fallback || {}
  const notes = (saved.notes || []).map(note => ({ ...note,
    stale: JSON.stringify(signatures(workspace, Object.keys(note.files || {}))) !== JSON.stringify(note.files || {}) }))
  return { ...saved, overview: bootstrap(workspace), notes }
}
// Every finished agent leaves an `agent:<chat>:<name>` note, and an improvement plan leaves `progress:<chat>`. They are
// working state of one chat that happens to live in the project's file, so they are budgeted per chat: a busy chat cannot
// push another chat's notes out, only the most recent chats keep theirs, and they expire. Notes saved on purpose are never touched.
const AUTO_KEY = /^(?:agent|progress):([^:]+)/
const AUTO_NOTES_PER_CHAT = 30
const AUTO_CHATS = 4
const AUTO_NOTE_TTL_MS = 14 * 86400000
function pruneAutomatic(notes, now = Date.now()) {
  const chatOf = note => note.key.match(AUTO_KEY)?.[1]
  const recent = []
  for (let index = notes.length - 1; index >= 0; index--) { const chat = chatOf(notes[index]); if (chat && !recent.includes(chat)) recent.push(chat) }
  const keptChats = new Set(recent.slice(0, AUTO_CHATS)), counts = new Map(), drop = new Set()
  for (let index = notes.length - 1; index >= 0; index--) {
    const chat = chatOf(notes[index])
    if (!chat) continue
    const rank = (counts.get(chat) || 0) + 1
    counts.set(chat, rank)
    if (!keptChats.has(chat) || rank > AUTO_NOTES_PER_CHAT || now - Date.parse(notes[index].updatedAt) > AUTO_NOTE_TTL_MS) drop.add(notes[index])
  }
  return notes.filter(note => !drop.has(note))
}
function saveNote(store, workspace, fallback, { key, summary, files = [] }) {
  if (!key?.trim() || !summary?.trim()) throw new Error('Context key and summary are required')
  const current = store?.getLatest(workspace) || fallback || {}
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('files must be an array of workspace paths')
  for (const file of files) workspacePath(workspace, file)
  const note = { key: redact(key), summary: redact(summary).slice(0, 6000), files: signatures(workspace, files), updatedAt: new Date().toISOString() }
  const notes = [...(current.notes || []).filter(item => item.key !== key), note]
  const next = { ...current, notes: pruneAutomatic(notes) }
  store?.set(workspace, next)
  return next
}
module.exports = { projectPacket, saveNote, pruneAutomatic }
