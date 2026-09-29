import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { workspacePath, BUILD_OUTPUT } from './runtime-tools.mts'
import { redact } from './storage.mts'
import type { ContextNote, ContextRecord } from './project-context.mts'
const fileHashes = new Map<string, { version: string; hash: string }>()

// Where the notes live: `ProjectContextStore`, or nothing (an embedder without one keeps them on the run).
interface NoteStore { getLatest(workspace: string): Partial<ContextRecord> | null; set(workspace: string, snapshot: { notes: ContextNote[] }): unknown }
// A note with whether the files it depends on still hash the same.
interface PacketNote extends ContextNote { stale: boolean }
interface ProjectPacket { updatedAt?: string; overview: { entries: string[]; scripts: Record<string, unknown> }; notes: PacketNote[] }
// The arguments of `context_save` after the tool registry validated them: `files` is checked again here.
interface NoteInput { key?: string | null; summary?: string | null; files?: unknown }

const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
function signatures(workspace: string, files: string[]): Record<string, string | null> {
  return Object.fromEntries(files.map((file): [string, string | null] => {
    try {
      const target = workspacePath(workspace, file), stat = fs.statSync(target)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Context dependencies must be text-sized files')
      const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      const cached = fileHashes.get(target)
      const hash = cached?.version === version ? cached.hash : digest(fs.readFileSync(target))
      fileHashes.set(target, { version, hash })
      if (fileHashes.size > 1000) fileHashes.delete(fileHashes.keys().next().value!)
      return [file, hash]
    }
    catch { return [file, null] }
  }))
}
// Local metadata only: no model call and no recursive repository exploration.
function bootstrap(workspace: string): ProjectPacket['overview'] {
  let all: fs.Dirent[] = []
  try { all = fs.readdirSync(workspace, { withFileTypes: true }).filter(entry => !['.git', 'node_modules'].includes(entry.name)) } catch { /* A folder that is gone lists nothing. */ }
  const source = all.filter(entry => !BUILD_OUTPUT.test(entry.name))
  const entries = source.slice(0, 120).map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort()
  if (all.length > source.length) entries.push(`(${all.length - source.length} generated build folders omitted)`)
  let scripts: Record<string, unknown> = {}
  // package.json is whatever the project wrote; its `scripts` is shown as found.
  try { scripts = (JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts || {} } catch {}
  return { entries, scripts }
}
// The notes with their staleness, plus the folder overview. Nothing else: an older version stored a Git fingerprint
// and file counts next to the notes, and they went out to every agent that asked without telling it anything.
function projectPacket(store: NoteStore | null | undefined, workspace: string, fallback?: Partial<ContextRecord> | null): ProjectPacket {
  const saved: Partial<ContextRecord> = store?.getLatest(workspace) || fallback || {}
  const notes = (saved.notes || []).map(note => ({ ...note,
    stale: JSON.stringify(signatures(workspace, Object.keys(note.files || {}))) !== JSON.stringify(note.files || {}) }))
  return { ...(saved.updatedAt ? { updatedAt: saved.updatedAt } : {}), overview: bootstrap(workspace), notes }
}
// Every finished agent leaves an `agent:<chat>:<name>` note, and an improvement plan leaves `progress:<chat>`. They are
// working state of one chat that happens to live in the project's file, so they are budgeted per chat: a busy chat cannot
// push another chat's notes out, only the most recent chats keep theirs, and they expire. Notes saved on purpose are never touched.
const AUTO_KEY = /^(?:agent|progress):([^:]+)/
const AUTO_NOTES_PER_CHAT = 30
const AUTO_CHATS = 4
const AUTO_NOTE_TTL_MS = 14 * 86400000
function pruneAutomatic(notes: ContextNote[], now = Date.now()): ContextNote[] {
  const chatOf = (note: ContextNote): string | undefined => note.key.match(AUTO_KEY)?.[1]
  const recent: string[] = []
  for (let index = notes.length - 1; index >= 0; index--) { const chat = chatOf(notes[index]); if (chat && !recent.includes(chat)) recent.push(chat) }
  const keptChats = new Set(recent.slice(0, AUTO_CHATS)), counts = new Map<string, number>(), drop = new Set<ContextNote>()
  for (let index = notes.length - 1; index >= 0; index--) {
    const chat = chatOf(notes[index])
    if (!chat) continue
    const rank = (counts.get(chat) || 0) + 1
    counts.set(chat, rank)
    if (!keptChats.has(chat) || rank > AUTO_NOTES_PER_CHAT || now - Date.parse(notes[index].updatedAt) > AUTO_NOTE_TTL_MS) drop.add(notes[index])
  }
  return notes.filter(note => !drop.has(note))
}
function saveNote(store: NoteStore | null | undefined, workspace: string, fallback: Partial<ContextRecord> | null | undefined, { key, summary, files = [] }: NoteInput): { notes: ContextNote[] } {
  if (!key?.trim() || !summary?.trim()) throw new Error('Context key and summary are required')
  const current: Partial<ContextRecord> = store?.getLatest(workspace) || fallback || {}
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('files must be an array of workspace paths')
  const names: string[] = files
  for (const file of names) workspacePath(workspace, file)
  const note: ContextNote = { key: redact(key), summary: redact(summary).slice(0, 6000), files: signatures(workspace, names), updatedAt: new Date().toISOString() }
  // The stored key is the redacted one: comparing against it keeps an upsert an upsert.
  const notes = [...(current.notes || []).filter(item => item.key !== note.key), note]
  const next = { notes: pruneAutomatic(notes) }
  store?.set(workspace, next)
  return next
}
export { projectPacket, saveNote, pruneAutomatic }
export type { NoteStore, ProjectPacket, PacketNote, NoteInput }
