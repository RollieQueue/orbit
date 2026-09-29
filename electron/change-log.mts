import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGit } from './git.mts'
import { normalizeRel } from './file-activity.mts'
import type { NativeToolEvent } from './file-activity.mts'
import { unifiedDiff, fragmentDiff, lineOf } from './diff.mts'

// Every file change of one run with its unified diff. Orbit's own file tools report exact before/after text;
// vendor tools only tell what they did, so their diffs come from the event, from the file and from Git, and
// when none of that is enough the change is listed without a diff. A diff is never guessed; a change without one
// carries a `reason` code (see REASONS) so the interface can say why.
const MAX_DIFF_CHARS = 60000
const MAX_CHANGES = 400
const MAX_TOTAL_CHARS = 1.5 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_CALLS = 500
const GIT_TIMEOUT_MS = 5000
const MAX_RECOVERED = 120   // files Git is asked about for one run saved without change records
const RECOVER_PARALLEL = 4
// Why a change has no diff text. The renderer turns these into sentences; the codes are the contract.
const REASONS = {
  LATER_WRITE: 'later-write',       // not the first write of the file in this run: the starting text is unknown
  NO_BASELINE: 'no-baseline',       // neither the event nor Git knows the text before the write
  UNREADABLE: 'unreadable',         // the file is missing, too large, binary or outside the workspace
  NO_GIT: 'no-git',                 // Git has nothing to show for a file a command changed
  TRIMMED: 'trimmed',               // the text gave way to newer changes (MAX_TOTAL_CHARS)
  UNTRACKED_RUN: 'untracked-run',   // the run was saved before Orbit recorded changes
  NO_REPO: 'no-repo',               // Git cannot answer for this workspace
  NO_BASE_COMMIT: 'no-base-commit', // no commit precedes the run
  GIT_SAME: 'git-same',             // Git sees no difference against the commit the run started from
  TOO_MANY: 'too-many',             // beyond MAX_RECOVERED
} as const
type ChangeReason = (typeof REASONS)[keyof typeof REASONS]
type ChangeKind = 'create' | 'modify' | 'delete' | 'unknown'
// Where a diff came from: Orbit's own file tools ('exact'), a vendor tool's events ('event') or Git ('git').
type ChangeSource = 'exact' | 'event' | 'git'

// One file change of a run, as the run snapshot persists it and the Changes tab shows it.
interface FileChange {
  id: string; agentId: string; path: string; kind: ChangeKind; tool: string; time: string; added: number; removed: number
  source: ChangeSource; hasDiff: boolean; diff?: string; truncated?: boolean; binary?: boolean
  // Why there is no diff text (a REASONS value); for a recovered change, the short commit the diff is relative to.
  reason?: string; base?: string
}
// What `ChangeLog.add` takes: the change with either its before/after text, a ready diff, or a reason for having none.
interface ChangeInput {
  agentId: string; path: unknown; kind?: ChangeKind; tool?: unknown; source: ChangeSource
  before?: string | null; after?: string | null; diff?: string; added?: number; removed?: number; truncated?: boolean; binary?: boolean; reason?: string
}
// A change as `nativeChange` and `commandChange` describe it: everything of ChangeInput but who and which file.
type ChangeDraft = Omit<ChangeInput, 'agentId' | 'path'> & { kind: ChangeKind }
// The input of a Claude Write/Edit/MultiEdit call as the stream reports it; any field may be missing.
interface CallInput { content?: unknown; edits?: unknown; old_string?: unknown; new_string?: unknown }
// One entry of a Codex `changes` list.
interface ReportedChange { path?: unknown; kind?: unknown; diff?: unknown }
// What the events of one native tool call said about the edit so far.
interface CallRecord { tool: string; input: CallInput | undefined; changes: ReportedChange[] | undefined }
// A Claude edit: the text replaced and its replacement.
interface EditFragment { old_string: string; new_string: string }
// Git's answer about one file: a text diff, or only that the blob is binary.
type GitDiffResult = { binary: true; diff?: undefined } | { binary?: undefined; diff: string }
// A write an agent reported, for `recoverChanges`.
interface ReportedWrite { agentId?: unknown; path?: unknown; time?: string }

const SETTLED =/^(?:completed|complete|success|succeeded|done|failed|declined|denied|error|cancelled|canceled|rejected)$/i
const insensitive = process.platform === 'win32'
const keyOf = (rel: string): string => insensitive ? rel.toLowerCase() : rel
// The `code` of a thrown value ('ENOENT', …) as text, '' when it has none.
const errorCode = (error: unknown): string => String((error as { code?: unknown } | null | undefined)?.code ?? '')
const isEdit = (edit: unknown): edit is EditFragment => {
  const value = edit as { old_string?: unknown; new_string?: unknown } | null | undefined
  return typeof value?.old_string === 'string' && typeof value?.new_string === 'string'
}

function clipDiff(text: string): { diff: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARS) return { diff: text, truncated: false }
  return { diff: text.slice(0, text.lastIndexOf('\n', MAX_DIFF_CHARS) + 1), truncated: true }
}
// Only lines inside hunks count: a removed line that reads "-- note" is "--- note" in the diff, not a file header.
function countLines(diff: string): { added: number; removed: number } {
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
  declare workspace: string
  declare startedAt: number
  declare items: FileChange[]
  declare chars: number
  declare written: Set<string>
  declare calls: Map<string, CallRecord>
  constructor(workspace: string) {
    this.workspace = workspace
    this.startedAt = Date.now() // a file born after this did not exist when the run began
    this.items = []
    this.chars = 0
    this.written = new Set() // files some write of this run has already touched
    this.calls = new Map()   // native tool call → what its events said about the edit
  }
  // True for the first write to a file in this run: only then is the file's HEAD version what the write started from.
  claim(rel: string): boolean {
    const key = keyOf(rel), first = !this.written.has(key)
    this.written.add(key)
    return first
  }
  // What the events of one native tool call said so far. The input arrives before the completion, which names nothing.
  remember(agentId: string, event: NativeToolEvent | null | undefined): CallRecord | null {
    const callId = event?.toolId ? `${agentId}:${event.toolId}` : null
    let entry: CallRecord | null = null
    if (event?.input || event?.changes) {
      // The vendor's payload is kept as it came; every field is checked where it is read.
      entry = { tool: String(event.tool || ''), input: event.input as CallInput | undefined, changes: event.changes as ReportedChange[] | undefined }
      if (callId) { this.calls.set(callId, entry); if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!) }
    } else if (callId) entry = this.calls.get(callId) || null
    if (callId && SETTLED.test(String(event?.status || ''))) this.calls.delete(callId)
    return entry
  }
  add({ agentId, path: target, kind, tool, source, before, after, diff, added, removed, truncated, binary, reason }: ChangeInput): FileChange | null {
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
    const change: FileChange = { id: randomUUID(), agentId, path: rel, kind, tool: String(tool || ''), time: new Date().toISOString(), added: added || 0, removed: removed || 0, source, hasDiff }
    if (hasDiff) { change.diff = diff!; this.chars += diff!.length }
    if (truncated) change.truncated = true
    if (binary) change.binary = true
    else if (!hasDiff && reason) change.reason = String(reason)
    this.items.push(change)
    this.trim()
    return { ...change }
  }
  // Old changes give up their diff text first; the record of what changed stays until the run holds too many.
  trim(): void {
    if (this.items.length > MAX_CHANGES) for (const old of this.items.splice(0, this.items.length - MAX_CHANGES)) this.chars -= old.diff?.length || 0
    for (let index = 0; this.chars > MAX_TOTAL_CHARS && index < this.items.length - 1; index++) {
      const item = this.items[index]
      if (!item.diff) continue
      this.chars -= item.diff.length
      delete item.diff; item.hasDiff = false; item.reason = REASONS.TRIMMED
    }
  }
  snapshot(): FileChange[] { return this.items.map(change => ({ ...change })) }
}

// Git's answer as bytes (a blob may be binary); null when Git has none. Flags and the neutral cwd come from git.mts.
async function git(workspace: string, args: readonly string[]): Promise<Buffer | null> {
  const result = await runGit(workspace, args, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES + 1024 * 1024, encoding: 'buffer' })
  return result.ok ? result.stdout : null
}
// The text of a file: null when it does not exist, undefined when it cannot serve as text (too large, binary, unreadable).
async function readText(file: string): Promise<string | null | undefined> {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
    const text = await fs.promises.readFile(file, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch (error) { return errorCode(error) === 'ENOENT' ? null : undefined }
}
// Like readText, but only for a file that really lives inside the workspace: a symlink or junction that leads out of it reads as unknown.
async function workspaceText(workspace: string, file: string): Promise<string | null | undefined> {
  try {
    const [real, root] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(workspace)])
    const relative = path.relative(root, real)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  } catch (error) { return errorCode(error) === 'ENOENT' ? null : undefined }
  return readText(file)
}
// Whether the file came into being after the run began (a file born in the very millisecond the run began counts as older).
async function createdSince(file: string, since: number): Promise<boolean> {
  try { return since > 0 && Math.floor((await fs.promises.stat(file)).birthtimeMs) > since } catch { return false }
}
// The committed version of a file; undefined when the workspace is no repository, the file is untracked or it is no text.
async function gitShow(workspace: string, rel: string): Promise<string | undefined> {
  const out = await git(workspace, ['show', `HEAD:./${rel}`])
  return out && out.length <= MAX_FILE_BYTES && !out.includes(0) ? out.toString('utf8') : undefined
}
// What `git diff <ref>` (HEAD by default) says about one file, in the contract's shape; null when Git has nothing to show.
async function gitDiff(workspace: string, rel: string, ref = 'HEAD'): Promise<GitDiffResult | null> {
  // Git alone knows the line endings it stores: a CRLF working copy of an LF blob is not a change of every line.
  const out = await git(workspace, ['diff', '--relative', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3', '--src-prefix=a/', '--dst-prefix=b/', ref, '--', rel])
  if (!out || !out.length) return null
  const text = out.toString('utf8')
  if (/^Binary files .* differ$/m.test(text) && !text.includes('\n@@ ')) return { binary: true }
  const marker = text.startsWith('--- ') ? 0 : text.indexOf('\n--- ')
  return marker < 0 ? null : { diff: text.slice(marker ? marker + 1 : 0).replace(/\n$/, '') }
}
// The last commit of HEAD's history made at or before `at` (an ISO time): the version a run started from.
// null when no commit precedes that time, undefined when Git cannot answer (no repository, no history).
async function gitBaseCommit(workspace: string, at: string | undefined): Promise<string | null | undefined> {
  // A run saved without `startedAt` makes an invalid date, which the check below turns into "cannot answer".
  const time = new Date(at as string)
  if (Number.isNaN(time.valueOf())) return undefined
  const out = await git(workspace, ['rev-list', '-1', `--before=${time.toISOString().replace(/\.\d{3}Z$/, 'Z')}`, 'HEAD'])
  if (!out) return undefined
  const hash = out.toString('utf8').trim()
  return /^[0-9a-f]{40}$/.test(hash) ? hash : null
}

const KINDS: Record<string, ChangeKind> = { add: 'create', create: 'create', delete: 'delete', remove: 'delete', update: 'modify', modify: 'modify' }
// A Codex change kind: a string, or an object whose `type` names it.
const kindOf = (value: unknown): ChangeKind => KINDS[String((value as { type?: unknown } | null | undefined)?.type || value || '').toLowerCase()] || 'unknown'
const HUNKS = /^@@ /m

function fragments(input: CallInput, tool: string): unknown[] {
  if (tool === 'multiedit') return Array.isArray(input.edits) ? input.edits : []
  return [{ old_string: input.old_string, new_string: input.new_string }]
}
// An Edit or MultiEdit gives the replaced text itself; where it now sits in the file supplies the line numbers.
async function editChange(workspace: string, rel: string, entry: CallRecord): Promise<ChangeDraft | null> {
  const tool = entry.tool.toLowerCase()
  // Reached only for a call whose input arrived (`nativeChange` checks before asking).
  const edits = fragments(entry.input as CallInput, tool).filter(isEdit)
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
const kindOfDiff = (diff: string): ChangeKind => /^--- \/dev\/null$/m.test(diff) ? 'create' : /^\+\+\+ \/dev\/null$/m.test(diff) ? 'delete' : 'modify'
// The change a vendor's native tool made to `rel`, as arguments for ChangeLog.add. `first` says no other write of this
// run touched the file before, so its HEAD version is what the write started from; `since` (ms) is when the run began.
async function nativeChange(workspace: string, rel: string, entry: CallRecord | null | undefined, first: boolean, since = 0): Promise<ChangeDraft> {
  const tool = entry?.tool.toLowerCase() || ''
  if ((tool === 'edit' || tool === 'multiedit') && entry?.input) {
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
    return typeof after === 'string' ? { kind, source: 'event', before: null, after } : { kind, source: 'event', reason: REASONS.UNREADABLE }
  }
  if (!first) return { kind, source: 'event', reason: REASONS.LATER_WRITE }
  // The first write of the run: Git says what the file was, and a file born during the run was created by it.
  const found = await gitDiff(workspace, rel)
  if (found) return { kind: kind === 'unknown' && found.diff ? kindOfDiff(found.diff) : kind, source: 'git', ...found }
  if (kind !== 'delete' && await createdSince(file, since)) {
    const after = typeof entry?.input?.content === 'string' ? entry.input.content : await workspaceText(workspace, file)
    return typeof after === 'string' ? { kind: 'create', source: 'event', before: null, after } : { kind: 'create', source: 'event', reason: REASONS.UNREADABLE }
  }
  return { kind, source: 'event', reason: REASONS.NO_BASELINE }
}
// A file a command changed. A file it created is exactly its current text; for the rest Git says what it can.
async function commandChange(workspace: string, rel: string, kind: ChangeKind): Promise<ChangeDraft> {
  if (kind === 'create') {
    const after = await workspaceText(workspace, path.join(workspace, rel))
    if (typeof after === 'string') return { kind, source: 'exact', before: null, after }
  }
  const found = await gitDiff(workspace, rel)
  return found ? { kind, source: 'git', ...found } : { kind, source: 'git', reason: kind === 'create' ? REASONS.UNREADABLE : REASONS.NO_GIT }
}
// Files agents reported writing in a run that has no change record for them: a run saved before Orbit recorded
// changes, or a write whose record was lost. Git is asked for each file's diff relative to the last commit before
// the run began (accumulated: it may include other agents' and later edits, which the `base` field lets the
// interface say). Without that, the file is listed with the reason. `writes` are { agentId, path, time }.
async function recoverChanges(workspace: string, startedAt: string | undefined, writes: ReadonlyArray<ReportedWrite> | null | undefined): Promise<FileChange[]> {
  const entries: FileChange[] = []
  for (const write of writes || []) {
    const rel = normalizeRel(workspace, write?.path)
    if (!rel || !write.agentId) continue
    // The renderer builds the same id for its placeholders, so a recovered entry replaces the right one.
    entries.push({ id: `legacy:${write.agentId}:${rel}`, agentId: String(write.agentId), path: rel, kind: 'unknown', tool: '', time: write.time || new Date(0).toISOString(), added: 0, removed: 0, source: 'git', hasDiff: false })
  }
  if (!entries.length) return []
  const base = await gitBaseCommit(workspace, startedAt)
  if (!base) { for (const entry of entries) entry.reason = base === undefined ? REASONS.NO_REPO : REASONS.NO_BASE_COMMIT; return entries }
  const short = base.slice(0, 7)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < entries.length; index = next++) {
      const entry = entries[index]
      if (index >= MAX_RECOVERED) { entry.reason = REASONS.TOO_MANY; continue }
      entry.base = short
      const found = await gitDiff(workspace, entry.path, base)
      if (!found) { entry.reason = REASONS.GIT_SAME; continue }
      if (found.binary) { entry.binary = true; continue }
      const clipped = clipDiff(found.diff)
      Object.assign(entry, { kind: kindOfDiff(found.diff), ...countLines(found.diff), diff: clipped.diff, hasDiff: true })
      if (clipped.truncated) entry.truncated = true
    }
  }
  await Promise.all(Array.from({ length: Math.min(RECOVER_PARALLEL, entries.length) }, worker))
  return entries
}

export { ChangeLog, nativeChange, commandChange, recoverChanges, gitShow, gitDiff, gitBaseCommit, readText, REASONS, MAX_DIFF_CHARS, MAX_CHANGES, MAX_TOTAL_CHARS, MAX_RECOVERED }
export type { FileChange, ChangeInput, ChangeDraft, ChangeKind, ChangeSource, ChangeReason, CallRecord, ReportedWrite }
