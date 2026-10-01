// Isolated copies of a workspace for parallel helpers (docs/ARCHITECTURE.md, "Isolated helpers"). A helper that edits files
// while others do works in its own git worktree of the repository its parent works in: a copy of the parent's CURRENT
// state (uncommitted and untracked-but-not-ignored files included) made without touching the parent's index, HEAD or
// working tree. When the helper finishes, its changes are merged back file by file: a three-way merge against the snapshot
// the copy started from, written straight into the target's files (never through the target's index, which `git apply
// --3way` would stage). A conflict leaves the target's file alone and is reported. The copy lives until the run ends and
// is then removed; changes that never merged are kept as a patch. Git runs through electron/git.mts, and nothing here
// knows about agents or runs beyond the ids it is given.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { runGit } from './git.mts'
import type { GitOptions, GitResult } from './git.mts'

// A copy is a git worktree of `kind`: 'worktree' copies the parent's workspace, 'orbit' Orbit's own repository.
type CopyKind = 'worktree' | 'orbit'
interface AgentCopy {
  agentId: string
  kind: CopyKind
  // The copy's top-level folder (the worktree) and the helper's workspace inside it: the source workspace's place below
  // its repository's top (`relPrefix`, posix, '' when the workspace is the top) found again in the copy.
  dir: string
  workspace: string
  relPrefix: string
  // The top of the repository the copy was made from (where merges land), the workspace its changes merge into (what the
  // parent calls its workspace), and the top of the repository that owns the worktree (git's admin commands run there:
  // a copy of a copy is a worktree of the same repository).
  sourceTop: string
  target: string
  origin: string
  // The snapshot commit the copy started from, and the commit merges compare against: it moves up as changes merge.
  startBase: string
  base: string
  // The links into the source's node_modules made inside the copy (removed first, never followed), and the run's meta.json.
  links: string[]
  meta: string
}
interface CopyOptions {
  source: string
  kind: CopyKind
  root: string
  runId: string
  agentId: string
  // The repository that owns the worktree when the source is itself a copy; else the source's own.
  origin?: string
}
interface CopyRefusal { ok: false; detail: string }
// One file the merge wrote into the target; `before` and `after` are the texts for the change record (undefined: binary or
// too large, null: the file did not exist before / does not exist now).
interface MergedFile { path: string; kind: 'create' | 'modify' | 'delete'; before?: string | null; after?: string | null }
interface MergeConflict { path: string; reason: string }
// `outside`: files the helper changed beyond its own workspace (a workspace below the repository's top): never merged.
interface MergeResult { ok: boolean; error?: string; merged: MergedFile[]; conflicts: MergeConflict[]; identical: number; outside?: string[] }
// `kept`: the copy stays on purpose, because what it holds beyond the merges could not be saved as a patch.
interface RemoveResult { removed: boolean; patch: string | null; kept?: boolean; error?: string }
interface SweepResult { removed: number; patches: string[]; kept: string[] }
// A test seam: called right before a merged file is written or deleted, where a save by someone else would be overwritten.
interface MergeHooks { beforeWrite?: (rel: string) => void | Promise<void> }

// Snapshots, checkouts and diffs walk the whole working copy; a probe asks one question.
const PROBE_MS = 15000
const WALK_MS = 180000
const BIG_BUFFER = 64 * 1024 * 1024
// A file larger than this is merged only when the target did not change it; the change record keeps no text beyond this.
const TEXT_LIMIT = 4 * 1024 * 1024
const RECORD_LIMIT = 256 * 1024
const IDENTITY = { GIT_AUTHOR_NAME: 'Orbit', GIT_AUTHOR_EMAIL: 'orbit@localhost', GIT_COMMITTER_NAME: 'Orbit', GIT_COMMITTER_EMAIL: 'orbit@localhost' }
const REGULAR = new Set(['100644', '100755'])
const ZERO = /^0+$/
// A run's folder under the worktrees root is the first eight hex digits of a hash of its id; `patches` holds what was saved.
const RUN_FOLDER = /^[0-9a-f]{8}$/
const PATCHES = 'patches'
const KEEP_PATCHES = 40
// A run folder whose owner is not known to be gone is left alone until it is this old.
const LEFTOVER_MS = 7 * 24 * 3600 * 1000
// How many paths one git call gets on its command line.
const CHUNK = 40
const META = 'meta.json'

const keyOf = (folder: string): string => process.platform === 'win32' ? folder.toLowerCase() : folder
const posix = (value: string): string => value.split(path.sep).join('/')
const short = (id: string): string => id.slice(0, 7)
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const code = (error: unknown): string => String((error as { code?: unknown } | null | undefined)?.code ?? '')
const digest = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 8)
// A folder as the file system names it (8.3 short names expanded), or as given when it cannot be resolved.
function realFolder(folder: string): string {
  try { return fs.realpathSync.native(folder) } catch { return path.resolve(folder) }
}
// Strictly below `root`: never the root itself, never a sibling that merely shares its prefix.
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function git(cwd: string, args: string[], options: GitOptions & { encoding: 'buffer' }): Promise<GitResult<Buffer>>
function git(cwd: string, args: string[], options?: GitOptions & { encoding?: BufferEncoding }): Promise<GitResult<string>>
function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult<string | Buffer>> { return runGit(cwd, args, { timeoutMs: WALK_MS, ...options }) }

// One task at a time per key: merges into one target, and snapshots of it, must not see each other half done; git's
// worktree administration of one repository is serialized too. A failed task never blocks the next.
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}

// ---- meta.json: what a crash leaves behind is cleaned up from it -----------------------------------------------------
// One per run folder: the process that owns it (a sweep leaves a live owner's copies alone) and every copy still on disk.
interface Meta { version: 1; runId: string; pid: number; createdAt: string; copies: AgentCopy[] }
function readMeta(file: string): Meta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Meta>
    return meta && meta.version === 1 && Array.isArray(meta.copies) && typeof meta.pid === 'number' ? meta as Meta : null
  } catch { return null }
}
function writeMeta(file: string, meta: Meta): void {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(meta, null, 1))
  fs.renameSync(temporary, file)
}
// Changes the copies listed in a run's meta.json; a run folder left without any copy goes away with its meta.
function updateMeta(file: string, runId: string, change: (copies: AgentCopy[]) => AgentCopy[]): Promise<void> {
  return serialized(`meta:${keyOf(file)}`, async () => {
    try {
      const meta = readMeta(file) ?? { version: 1 as const, runId, pid: process.pid, createdAt: new Date().toISOString(), copies: [] }
      meta.copies = change(meta.copies)
      if (meta.copies.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); writeMeta(file, meta); return }
      fs.rmSync(file, { force: true })
      try { fs.rmdirSync(path.dirname(file)) } catch { /* Not empty: another copy of the run, or a folder that is not ours to remove. */ }
    } catch { /* A meta that cannot be written costs only the crash cleanup of this copy. */ }
  })
}

// ---- Creating a copy -------------------------------------------------------------------------------------------------
// The working tree as a commit, without touching the index, HEAD or files of the repository: a temporary index (a copy of
// the real one when it can be read, so that unchanged files are not hashed again; else HEAD's tree), `add -A`, `write-tree`,
// `commit-tree` on top of HEAD. Author and committer come from the environment, so no git configuration is needed.
async function snapshot(top: string): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeoutMs: PROBE_MS })
  const parent = head.ok ? head.value : ''
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-snapshot-'))
  try {
    let failure = 'git could not read the working tree'
    for (const seeded of [true, false]) {
      const index = path.join(folder, seeded ? 'seeded-index' : 'fresh-index')
      const env = { GIT_INDEX_FILE: index }
      if (seeded) {
        const own = await git(top, ['rev-parse', '--git-path', 'index'], { timeoutMs: PROBE_MS })
        try { fs.copyFileSync(path.resolve(top, own.value), index) } catch { continue }
      } else if (parent) {
        const read = await git(top, ['read-tree', parent], { env })
        if (!read.ok) return { ok: false, error: read.error }
      }
      const added = await git(top, ['-c', 'core.safecrlf=false', 'add', '-A'], { env })
      const tree = added.ok ? await git(top, ['write-tree'], { env }) : added
      if (!tree.ok) { failure = tree.error || failure; continue }
      const commit = await git(top, ['-c', 'commit.gpgsign=false', 'commit-tree', tree.value, ...(parent ? ['-p', parent] : []), '-m', 'Orbit: snapshot for an isolated helper'], { env: IDENTITY })
      return commit.ok ? { ok: true, commit: commit.value } : { ok: false, error: commit.error }
    }
    return { ok: false, error: failure }
  } finally { fs.rmSync(folder, { recursive: true, force: true }) }
}
// Links the source's ignored node_modules into the copy, so that tests and builds run there. A junction on Windows (no
// privilege needed), a directory symlink elsewhere. Only what git ignores is linked: anything else is in the snapshot.
async function linkModules(copy: Pick<AgentCopy, 'dir' | 'relPrefix' | 'sourceTop'>): Promise<string[]> {
  const links: string[] = []
  const places = [...new Set(['node_modules', ...(copy.relPrefix ? [`${copy.relPrefix}/node_modules`] : [])])]
  for (const place of places) {
    const from = path.join(copy.sourceTop, ...place.split('/')), to = path.join(copy.dir, ...place.split('/'))
    try {
      if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue
      const ignored = await git(copy.sourceTop, ['check-ignore', '-q', '--', place], { timeoutMs: PROBE_MS, literalPathspecs: false })
      if (!ignored.ok) continue
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.symlinkSync(realFolder(from), to, process.platform === 'win32' ? 'junction' : 'dir')
      links.push(to)
    } catch { /* No node_modules to link, or no right to link it: the helper runs without. */ }
  }
  return links
}
// A snapshot of `source` and a git worktree of it under `root/<run>/<agent>`, linked to the source's node_modules and
// recorded in the run's meta.json. Refused (with the reason in `detail`) when the source is not inside a git work tree.
async function createCopy({ source, kind, root, runId, agentId, origin }: CopyOptions): Promise<{ ok: true; copy: AgentCopy } | CopyRefusal> {
  let folder: string
  try { folder = fs.realpathSync.native(source); if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder') } catch { return { ok: false, detail: `${source} is not a folder that exists` } }
  const found = await git(folder, ['rev-parse', '--show-toplevel'], { timeoutMs: PROBE_MS })
  if (!found.ok || !found.value) return { ok: false, detail: `${source} is not inside a git work tree` }
  const top = realFolder(found.value)
  const relPrefix = posix(path.relative(top, folder))
  if (relPrefix === '..' || relPrefix.startsWith('../')) return { ok: false, detail: `${source} is not below the top of its git work tree` }
  const taken = await serialized(keyOf(top), () => snapshot(top))
  if (!taken.ok) return { ok: false, detail: `git could not snapshot ${top}: ${taken.error}` }
  const runFolder = path.join(root, digest(runId))
  let dir = path.join(runFolder, digest(agentId))
  for (let suffix = 2; fs.existsSync(dir); suffix++) dir = path.join(runFolder, `${digest(agentId)}-${suffix}`)
  const owner = origin ?? top
  fs.mkdirSync(runFolder, { recursive: true })
  // No hook of the user's repository (a post-checkout one may install packages) runs for a copy Orbit makes.
  const added = await serialized(`admin:${keyOf(owner)}`, () => git(owner, ['-c', `core.hooksPath=${os.devNull}`, 'worktree', 'add', '--detach', dir, taken.commit]))
  if (!added.ok) {
    // Nothing is linked yet, so the folder holds only what git wrote; a git that was killed may have left its entry behind.
    await fs.promises.rm(dir, { recursive: true, force: true })
    await serialized(`admin:${keyOf(owner)}`, () => git(owner, ['worktree', 'prune'], { timeoutMs: PROBE_MS }))
    return { ok: false, detail: `git could not make a worktree for the copy: ${added.error}` }
  }
  const workspace = relPrefix ? path.join(dir, ...relPrefix.split('/')) : dir
  fs.mkdirSync(workspace, { recursive: true })
  const meta = path.join(runFolder, META)
  const copy: AgentCopy = { agentId, kind, dir, workspace, relPrefix, sourceTop: top, target: source, origin: owner, startBase: taken.commit, base: taken.commit, links: [], meta }
  copy.links = await linkModules(copy)
  await updateMeta(meta, runId, copies => [...copies, copy])
  return { ok: true, copy }
}

// ---- Merging back ----------------------------------------------------------------------------------------------------
// A file the helper changed against the snapshot it started from, as `git diff --raw` reports it.
interface RawChange { path: string; oldMode: string; newMode: string; oldId: string; newId: string }
function parseRaw(output: Buffer): RawChange[] {
  const parts = output.toString('utf8').split('\0')
  const changes: RawChange[] = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]\d*$/.exec(parts[index])
    if (match && parts[index + 1]) changes.push({ path: parts[index + 1], oldMode: match[1], newMode: match[2], oldId: match[3], newId: match[4] })
  }
  return changes
}
// Everything the copy holds, staged in a TEMPORARY index (a copy of the worktree's own index when it can be read, so that
// unchanged files are not hashed again; else the base commit's tree). Reading the copy never writes its own index, so a
// stale index.lock that a killed git left there cannot make a merge or a patch fail.
async function staged<T>(copy: AgentCopy, use: (env: { GIT_INDEX_FILE: string }) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orbit-copy-index-'))
  try {
    let failure = 'git could not read the copy'
    for (const seeded of [true, false]) {
      const index = path.join(folder, seeded ? 'seeded-index' : 'fresh-index')
      const env = { GIT_INDEX_FILE: index }
      if (seeded) {
        const own = await git(copy.dir, ['rev-parse', '--git-path', 'index'], { timeoutMs: PROBE_MS })
        try { await fs.promises.copyFile(path.resolve(copy.dir, own.value), index) } catch { continue }
      } else {
        const read = await git(copy.dir, ['read-tree', copy.base], { env })
        if (!read.ok) return { ok: false, error: read.error || failure }
      }
      const added = await git(copy.dir, ['-c', 'core.safecrlf=false', 'add', '-A'], { env })
      if (!added.ok) { failure = added.error || failure; continue }
      return { ok: true, value: await use(env) }
    }
    return { ok: false, error: failure }
  } finally { await fs.promises.rm(folder, { recursive: true, force: true }) }
}
// The shallowest link (symlink or junction) of the copy that each path goes through. Git for Windows follows a junction and
// stages what it leads to as if it were the copy's own files, so what is reached that way is neither merged nor part of a
// patch (the helper made such a link itself: the links Orbit makes are ignored by git).
async function linkRoots(dir: string, paths: string[]): Promise<Set<string>> {
  const roots = new Set<string>(), known = new Map<string, boolean>()
  for (const file of paths) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/')
      let link = known.get(prefix)
      if (link === undefined) {
        try { link = (await fs.promises.lstat(path.join(dir, ...parts.slice(0, depth)))).isSymbolicLink() } catch { link = false }
        known.set(prefix, link)
      }
      if (link) { roots.add(prefix); break }
    }
  }
  return roots
}
// What the helper changed in the copy against the commit merges are measured against. `changes` are the files within its
// workspace; `outside` are the changes beyond it (the workspace is a folder below the repository's top) and `linked` the
// links of the copy whose files git staged (see linkRoots): none of those is merged.
interface Collected { changes: RawChange[]; outside: string[]; linked: string[] }
async function collect(copy: AgentCopy): Promise<({ ok: true } & Collected) | { ok: false; error: string }> {
  const read = await staged(copy, env => git(copy.dir, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', copy.base], { env, encoding: 'buffer', maxBuffer: BIG_BUFFER }))
  if (!read.ok) return { ok: false, error: `git could not read the copy: ${read.error}` }
  if (!read.value.ok) return { ok: false, error: `git could not compare the copy with its snapshot: ${read.value.error}` }
  const all = parseRaw(read.value.stdout)
  const roots = await linkRoots(copy.dir, all.map(change => change.path))
  const prefix = copy.relPrefix ? `${copy.relPrefix}/` : ''
  const collected: Collected = { changes: [], outside: [], linked: [] }
  for (const root of roots) (!prefix || `${root}/`.startsWith(prefix) ? collected.linked : collected.outside).push(root)
  for (const change of all) {
    if ([...roots].some(root => change.path.startsWith(`${root}/`))) continue
    if (!prefix || change.path.startsWith(prefix)) collected.changes.push(change)
    else collected.outside.push(change.path)
  }
  return { ok: true, ...collected }
}
// What git would store for each of the target's files (the clean filters and line-ending rules apply), so that a
// working file with CRLF endings equals the LF blob it was committed as.
async function hashFiles(top: string, files: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (let index = 0; index < files.length; index += CHUNK) {
    const chunk = files.slice(index, index + CHUNK)
    const batch = await git(top, ['-c', 'core.safecrlf=false', 'hash-object', '--', ...chunk], { timeoutMs: PROBE_MS })
    const lines = batch.value.split(/\r?\n/)
    if (batch.ok && lines.length === chunk.length) { chunk.forEach((file, at) => ids.set(file, lines[at])); continue }
    // One unreadable file fails the whole call: ask file by file.
    for (const file of chunk) {
      const one = await git(top, ['-c', 'core.safecrlf=false', 'hash-object', '--', file], { timeoutMs: PROBE_MS })
      if (one.ok && one.value) ids.set(file, one.value)
    }
  }
  return ids
}
// The path of a git file name inside a work tree; null for one that could leave it or reach git's own files.
function placeIn(top: string, rel: string): string | null {
  const parts = rel.split('/')
  if (!rel || parts.some(part => !part || part === '.' || part === '..') || parts[0].toLowerCase() === '.git') return null
  const target = path.join(top, ...parts)
  return inside(top, target) ? target : null
}
// Whether writing `target` would end up outside the work tree: the nearest folder of its path that exists must really lie
// inside it (a link in the target may lead elsewhere; git itself never writes beyond a link).
function leavesTree(top: string, target: string): boolean {
  let ancestor = path.dirname(target)
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return true
    ancestor = parent
  }
  const root = realFolder(top), real = realFolder(ancestor)
  return real !== root && !inside(root, real)
}
// Text for a change record: undefined for a binary or large file.
function textOf(file: string): string | undefined {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > RECORD_LIMIT) return undefined
    const text = fs.readFileSync(file, 'utf8')
    return text.includes('\0') ? undefined : text
  } catch { return undefined }
}
const hasNul = (buffer: Buffer): boolean => buffer.includes(0)
// Line endings are not a change: all three sides are compared with LF, and the result goes back to CRLF when the target's
// file has CRLF throughout (the rule edit_file follows). latin1 keeps every byte of a file that is not UTF-8.
const toLf = (buffer: Buffer): string => buffer.toString('latin1').replace(/\r\n/g, '\n')
async function blob(copy: AgentCopy, id: string): Promise<Buffer | null> {
  const result = await git(copy.dir, ['cat-file', 'blob', id], { encoding: 'buffer', maxBuffer: TEXT_LIMIT + 1024 })
  return result.ok ? result.stdout : null
}
// A three-way text merge of one file with `git merge-file`; `merged` is the new content only when it is clean.
async function mergeText(copy: AgentCopy, file: string, baseId: string, theirsId: string): Promise<{ merged: Buffer } | { reason: string }> {
  if ((await fs.promises.stat(file)).size > TEXT_LIMIT) return { reason: 'changed on both sides and too large to merge automatically' }
  const [base, theirs] = await Promise.all([blob(copy, baseId), blob(copy, theirsId)])
  const ours = await fs.promises.readFile(file)
  if (!base || !theirs) return { reason: 'changed on both sides and too large to merge automatically' }
  if (hasNul(ours) || hasNul(base) || hasNul(theirs)) return { reason: 'a binary file changed on both sides' }
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orbit-merge-'))
  try {
    const names = ['ours', 'base', 'theirs'].map(name => path.join(folder, name))
    await Promise.all([ours, base, theirs].map((buffer, index) => fs.promises.writeFile(names[index], toLf(buffer), 'latin1')))
    // Outside any repository: merge-file needs none. Its exit status is the number of conflicts (at most 127); anything
    // else non-zero is an error.
    const merged = await runGit(null, ['merge-file', '-p', '-L', 'target', '-L', 'snapshot', '-L', 'helper', ...names], { encoding: 'buffer', timeoutMs: PROBE_MS })
    if (!merged.ok) return { reason: typeof merged.code === 'number' && merged.code > 0 && merged.code < 128 ? 'changed on both sides and the changes overlap' : `the text merge failed: ${merged.error}` }
    const crlf = ours.includes('\r\n') && !/(^|[^\r])\n/.test(ours.toString('latin1'))
    const text = merged.stdout.toString('latin1')
    return { merged: Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'latin1') }
  } finally { await fs.promises.rm(folder, { recursive: true, force: true }) }
}
// The target's file at one path, looked at once: missing, a regular file or something else. `seen` identifies a file as it was
// when it was looked at (before it was hashed), `id` is what git would store for it (undefined: it could not be read).
type Ours = { state: 'absent' } | { state: 'file'; seen: string; id?: string } | { state: 'other' }
type Outcome = { kind: 'same' } | { kind: 'written'; file: MergedFile } | { kind: 'conflict'; conflict: MergeConflict }
const seenOf = (stat: fs.Stats): string => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
async function lookup(top: string, rel: string): Promise<Ours> {
  const place = placeIn(top, rel)
  if (!place) return { state: 'other' }
  try {
    const stat = await fs.promises.lstat(place)
    return stat.isFile() ? { state: 'file', seen: seenOf(stat) } : { state: 'other' }
  } catch (error) { return code(error) === 'ENOENT' ? { state: 'absent' } : { state: 'other' } }
}
// Whether the target's file is still as it was looked at: not saved over, deleted or created by anyone since.
async function unchanged(target: string, here: Ours): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target)
    return here.state === 'file' && stat.isFile() && seenOf(stat) === here.seen
  } catch (error) { return here.state === 'absent' && code(error) === 'ENOENT' }
}
// Writes new content beside the target and renames it over the target, after checking once more that nobody has saved the
// target meanwhile (false: someone has, and nothing was written). A file that is open elsewhere refuses the rename on
// Windows; the content then goes in place.
async function swapIn(target: string, here: Ours, fill: (temporary: string) => Promise<void>, mode?: number): Promise<boolean> {
  const temporary = path.join(path.dirname(target), `.orbit-merge-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await fill(temporary)
    if (mode !== undefined && process.platform !== 'win32') await fs.promises.chmod(temporary, mode)
    if (!(await unchanged(target, here))) return false
    try { await fs.promises.rename(temporary, target) } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(code(error))) throw error
      await fs.promises.copyFile(temporary, target)
    }
    return true
  } finally { await fs.promises.rm(temporary, { force: true }) }
}
// STALE: the target's file changed after it was looked at, so the decision about it is made again.
const STALE = Symbol('stale')
async function decide(copy: AgentCopy, change: RawChange, here: Ours, hooks: MergeHooks): Promise<Outcome | typeof STALE> {
  const rel = change.path
  const conflict = (reason: string): Outcome => ({ kind: 'conflict', conflict: { path: rel, reason } })
  const target = placeIn(copy.sourceTop, rel)
  if (!target || leavesTree(copy.sourceTop, target)) return conflict('the path may not be written')
  for (const mode of [change.oldMode, change.newMode]) if (!ZERO.test(mode) && !REGULAR.has(mode)) return conflict('not a regular file (a link or a submodule): apply it by hand')
  if (here.state === 'other') return conflict('the target has a folder or a link at this path')
  if (here.state === 'file' && !here.id) return conflict('the target file could not be read')
  const baseId = ZERO.test(change.oldId) ? null : change.oldId, theirsId = ZERO.test(change.newId) ? null : change.newId
  const oursId = here.state === 'file' ? here.id ?? null : null
  if (oursId === theirsId) return { kind: 'same' }
  const untouched = oursId === baseId
  const mine = path.join(copy.dir, ...rel.split('/'))
  try {
    if (!untouched) {
      if (theirsId === null) return conflict('deleted by the helper, but changed in the target')
      if (baseId === null) return conflict('created by the helper and, differently, in the target')
      if (oursId === null) return conflict('deleted in the target, but changed by the helper')
      const merged = await mergeText(copy, target, baseId, theirsId)
      if (!('merged' in merged)) return conflict(merged.reason)
      await hooks.beforeWrite?.(rel)
      const before = textOf(target)
      const ours = await fs.promises.stat(target).catch(() => null)
      const swapped = await swapIn(target, here, temporary => fs.promises.writeFile(temporary, merged.merged), ours ? ours.mode & 0o777 : undefined)
      return swapped ? { kind: 'written', file: { path: rel, kind: 'modify', before, after: textOf(target) } } : STALE
    }
    await hooks.beforeWrite?.(rel)
    const before = oursId === null ? null : textOf(target)
    if (theirsId === null) {
      if (!(await unchanged(target, here))) return STALE
      await fs.promises.rm(target, { force: true })
      return { kind: 'written', file: { path: rel, kind: 'delete', before, after: null } }
    }
    if (!(await fs.promises.stat(mine)).isFile()) return conflict('the helper\'s file is gone from the copy')
    // The executable bit follows the helper's version where the file system has one.
    const mode = REGULAR.has(change.newMode) ? (change.newMode === '100755' ? 0o755 : 0o644) : undefined
    if (oursId === null) {
      // A new file never replaces one that has appeared since: the copy fails when the target exists.
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      try { await fs.promises.copyFile(mine, target, fs.constants.COPYFILE_EXCL) } catch (error) { if (code(error) === 'EEXIST') return STALE; throw error }
      if (mode !== undefined && process.platform !== 'win32') await fs.promises.chmod(target, mode)
    } else if (!(await swapIn(target, here, temporary => fs.promises.copyFile(mine, temporary), mode))) return STALE
    return { kind: 'written', file: { path: rel, kind: oursId === null ? 'create' : 'modify', before, after: textOf(target) } }
  } catch (error) { return conflict(`could not be written (${code(error) || message(error)})`) }
}
// One file of the merge. The parent keeps working in the target while the merge runs: a file saved after it was looked at
// is looked at again, and decided about again, instead of being overwritten (or deleted) on the strength of the old look.
async function mergeFile(copy: AgentCopy, change: RawChange, first: Ours, hooks: MergeHooks): Promise<Outcome> {
  let here = first
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await decide(copy, change, here, hooks)
    if (outcome !== STALE) return outcome
    here = await lookup(copy.sourceTop, change.path)
    if (here.state === 'file') here.id = (await hashFiles(copy.sourceTop, [change.path])).get(change.path)
  }
  return { kind: 'conflict', conflict: { path: change.path, reason: 'the target file kept changing while it was being merged' } }
}
// The snapshot commit with the merged files at the helper's version: what the next merge of this copy compares against, so
// that a follow-up neither applies a change twice nor loses the target's own edits. Paths that conflicted stay as they were.
async function advance(copy: AgentCopy, handled: RawChange[]): Promise<string | null> {
  if (!handled.length) return null
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-base-'))
  try {
    const env = { GIT_INDEX_FILE: path.join(folder, 'index') }
    if (!(await git(copy.dir, ['read-tree', copy.base], { env })).ok) return null
    const removals = handled.filter(change => ZERO.test(change.newId)), upserts = handled.filter(change => !ZERO.test(change.newId))
    for (let index = 0; index < removals.length; index += CHUNK) {
      if (!(await git(copy.dir, ['update-index', '--force-remove', '--', ...removals.slice(index, index + CHUNK).map(change => change.path)], { env })).ok) return null
    }
    for (let index = 0; index < upserts.length; index += CHUNK) {
      const entries = upserts.slice(index, index + CHUNK).flatMap(change => ['--cacheinfo', `${change.newMode},${change.newId},${change.path}`])
      if (!(await git(copy.dir, ['update-index', '--add', '--replace', ...entries], { env })).ok) return null
    }
    const tree = await git(copy.dir, ['write-tree'], { env })
    if (!tree.ok) return null
    const commit = await git(copy.dir, ['-c', 'commit.gpgsign=false', 'commit-tree', tree.value, '-p', copy.base, '-m', 'Orbit: changes merged into the target'], { env: IDENTITY })
    return commit.ok ? commit.value : null
  } finally { fs.rmSync(folder, { recursive: true, force: true }) }
}
async function mergeNow(copy: AgentCopy, hooks: MergeHooks): Promise<MergeResult> {
  const result: MergeResult = { ok: true, merged: [], conflicts: [], identical: 0 }
  const fail = (error: string): MergeResult => ({ ...result, ok: false, error })
  if (!fs.existsSync(copy.dir)) return fail(`the copy ${copy.dir} no longer exists`)
  if (!fs.existsSync(copy.sourceTop)) return fail(`the target ${copy.sourceTop} no longer exists`)
  const collected = await collect(copy)
  if (!collected.ok) return fail(collected.error)
  const { changes } = collected
  result.outside = collected.outside
  for (const link of collected.linked) result.conflicts.push({ path: link, reason: 'a link made in the copy leads to files outside it, which git took for the copy\'s own: they are not merged' })
  // The target's files as they are now: each is looked at before it is hashed, and looked at again before it is written.
  const here = new Map<string, Ours>(), files: string[] = []
  for (const change of changes) {
    const state = await lookup(copy.sourceTop, change.path)
    if (state.state === 'file') files.push(change.path)
    here.set(change.path, state)
  }
  const ids = await hashFiles(copy.sourceTop, files)
  for (const file of files) { const state = here.get(file); if (state?.state === 'file') state.id = ids.get(file) }
  const handled: RawChange[] = []
  for (const change of changes) {
    const outcome = await mergeFile(copy, change, here.get(change.path) ?? { state: 'other' }, hooks)
    if (outcome.kind === 'conflict') { result.conflicts.push(outcome.conflict); continue }
    handled.push(change)
    if (outcome.kind === 'same') result.identical++
    else result.merged.push(outcome.file)
  }
  const base = await advance(copy, handled)
  if (base) {
    copy.base = base
    await updateMeta(copy.meta, '', copies => copies.map(item => item.agentId === copy.agentId ? { ...item, base } : item))
  }
  return result
}
// Merges the helper's changes into the target. Never throws: a failure is the result's `error`, and nothing merged is
// reported as merged.
function mergeCopy(copy: AgentCopy, hooks: MergeHooks = {}): Promise<MergeResult> {
  return serialized(keyOf(copy.sourceTop), () => mergeNow(copy, hooks)).catch((error): MergeResult => ({ ok: false, error: message(error), merged: [], conflicts: [], identical: 0 }))
}
const quoted = (value: string): string => `"${value}"`
// The merge as the helper's parent reads it, ahead of the helper's own answer: what landed, and for every conflict where
// both versions are and how to see what the helper changed.
function describeMerge(copy: AgentCopy, result: MergeResult): string {
  const lines: string[] = []
  const list = (files: MergedFile[], kind: MergedFile['kind']): string => {
    const names = files.filter(file => file.kind === kind).map(file => file.path)
    return names.length ? `${kind === 'create' ? 'created' : kind === 'delete' ? 'deleted' : 'modified'}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}` : ''
  }
  const outside = result.outside ?? []
  if (!result.ok) {
    lines.push(`ISOLATED COPY MERGE FAILED: ${result.error}. Nothing of it reached ${copy.target}. The helper's files stay in the copy ${copy.workspace} until the run ends, then unmerged changes are kept as a patch.`)
  } else if (!result.merged.length && !result.conflicts.length) {
    lines.push(`ISOLATED COPY: the helper changed no files that ${copy.target} lacks${result.identical ? ` (${result.identical} already there)` : ''}; nothing to merge.`)
  } else {
    if (result.merged.length) lines.push(`ISOLATED COPY MERGED into ${copy.target}: ${result.merged.length} file(s) (${['create', 'modify', 'delete'].map(kind => list(result.merged, kind as MergedFile['kind'])).filter(Boolean).join('; ')}).`)
    if (result.conflicts.length) {
      lines.push(`CONFLICTS: ${result.conflicts.length} file(s) were NOT merged, and ${copy.target} is untouched for them (the helper's version is in the copy, yours in the target):`)
      for (const conflict of result.conflicts.slice(0, 6)) {
        lines.push(`- ${conflict.path}: ${conflict.reason}. Helper's file: ${path.join(copy.dir, ...conflict.path.split('/'))}; target's file: ${path.join(copy.sourceTop, ...conflict.path.split('/'))}; what the helper changed: git -C ${quoted(copy.dir)} diff ${short(copy.base)} -- ${quoted(conflict.path)}; the version both started from: git -C ${quoted(copy.dir)} show ${short(copy.base)}:${conflict.path}`)
      }
      if (result.conflicts.length > 6) lines.push(`- and ${result.conflicts.length - 6} more: ${result.conflicts.slice(6, 20).map(conflict => conflict.path).join(', ')}`)
      lines.push(`The copy stays at ${copy.workspace} until the run ends. Apply the helper's change to the target by hand (or ask the helper with followup_agent); a later merge of this copy tries the conflicting files again, and counts the ones that now match as merged.`)
    }
  }
  // A workspace below the repository's top: what the helper changed beyond it is not part of the merge, and must not vanish unremarked.
  if (result.ok && outside.length) lines.push(`NOT MERGED: ${outside.length} file(s) changed outside the helper's workspace ${copy.workspace} (${outside.slice(0, 6).join(', ')}${outside.length > 6 ? `, and ${outside.length - 6} more` : ''}) stay in the copy and are saved as a patch when the run ends; apply them by hand if they matter.`)
  return lines.join('\n')
}

// ---- Removing a copy -------------------------------------------------------------------------------------------------
// A link made inside a copy is unlinked, never followed: removing the folder it points to would delete the source's
// node_modules. Only a real link is touched.
function removeLink(link: string): void {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return
    try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) }
  } catch { /* Already gone. */ }
}
function prunePatches(directory: string): void {
  try {
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.patch')).map(name => ({ name, at: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.at - a.at)
    for (const old of files.slice(KEEP_PATCHES)) fs.rmSync(path.join(directory, old.name), { force: true })
  } catch { /* Old patches stay a little longer. */ }
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
// Saves what the copy holds beyond what was merged (the diff against its current base) as `root/patches/<name>`: `file` is
// null when there is nothing to save, an `error` when there is something and it could not be saved. Staged through a
// temporary index (see `staged`), and without what git took from a link of the copy (see `linkRoots`).
async function savePatch(copy: AgentCopy, root: string, name: string): Promise<{ file: string | null } | { error: string }> {
  try {
    const read = await staged(copy, async (env): Promise<{ file: string | null } | { error: string }> => {
      const names = await git(copy.dir, ['diff', '--cached', '--name-only', '-z', '--no-renames', copy.base], { env, encoding: 'buffer', maxBuffer: BIG_BUFFER })
      if (!names.ok) return { error: names.error }
      const changed = names.stdout.toString('utf8').split('\0').filter(Boolean)
      if (!changed.length) return { file: null }
      const skip = [...await linkRoots(copy.dir, changed)].map(link => `:(exclude,literal)${link}`)
      const directory = path.join(root, PATCHES)
      await fs.promises.mkdir(directory, { recursive: true })
      const file = path.join(directory, name)
      // Pathspec magic needs the literal-pathspecs switch of electron/git.mts off; the links' names are made literal one by one.
      const written = await git(copy.dir, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', '--no-renames', `--output=${file}`, copy.base, ...(skip.length ? ['--', '.', ...skip] : [])], { env, literalPathspecs: false })
      if (!written.ok) return { error: written.error }
      // Everything staged came through links: nothing of the helper's is left to save.
      if ((await fs.promises.stat(file)).size === 0) { await fs.promises.rm(file, { force: true }); return { file: null } }
      return { file }
    })
    if (!read.ok) return { error: read.error }
    if ('file' in read.value && read.value.file) prunePatches(path.join(root, PATCHES))
    return read.value
  } catch (error) { return { error: message(error) } }
}
// The folder git keeps for the worktree (<git dir>/worktrees/<name>), found through the copy's .git file and accepted only
// when it points back at this copy: that entry, and no other, is what removing the copy takes out of git's list.
function adminDirOf(copy: AgentCopy): string | null {
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(copy.dir, '.git'), 'utf8'))?.[1]
    if (!pointer) return null
    const admin = path.resolve(copy.dir, pointer)
    const back = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()
    return path.basename(path.dirname(admin)) === 'worktrees' && keyOf(realFolder(path.dirname(back))) === keyOf(realFolder(copy.dir)) ? admin : null
  } catch { return null }
}
// Takes a removed copy out of git's list of worktrees: its own entry when it can be told, else `git worktree prune` (which
// also drops the entries of the user's own worktrees whose folders are missing at the moment, so it is the fallback).
async function forgetWorktree(copy: AgentCopy, admin: string | null): Promise<void> {
  if (admin) { try { await fs.promises.rm(admin, { recursive: true, force: true }); return } catch { /* prune below */ } }
  if (fs.existsSync(copy.origin)) await serialized(`admin:${keyOf(copy.origin)}`, () => git(copy.origin, ['worktree', 'prune'], { timeoutMs: PROBE_MS }))
}
// Takes a copy away: what was never merged is saved as a patch first, and a copy whose changes cannot be saved stays (the
// sweep at the next start tries again). The folder goes by Node's rm, which unlinks a junction or a symlink instead of
// following it (so also one the helper made itself), never by `git worktree remove`: git for Windows follows a junction and
// deletes what it leads to, the source's node_modules. The links Orbit made are unlinked first all the same. A folder a
// process still holds open (Windows keeps a working folder locked) is retried; if it stays, the meta.json keeps it for the
// sweep.
async function removeNow(copy: AgentCopy, root: string, runId: string): Promise<RemoveResult> {
  let patch: string | null = null
  if (fs.existsSync(copy.dir)) {
    const saved = await savePatch(copy, root, `${digest(runId || copy.meta)}-${digest(copy.agentId)}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.patch`)
    if ('error' in saved) return { removed: false, patch: null, kept: true, error: `what the copy holds beyond its merges could not be saved as a patch (${saved.error})` }
    patch = saved.file
  }
  const admin = adminDirOf(copy)
  for (const link of copy.links) if (inside(copy.dir, link)) removeLink(link)
  let error: string | undefined
  for (let attempt = 0; attempt < 4 && fs.existsSync(copy.dir); attempt++) {
    if (attempt) await pause(300 * attempt)
    try { await fs.promises.rm(copy.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch (failure) { error = message(failure) }
  }
  const gone = !fs.existsSync(copy.dir)
  if (gone) {
    await forgetWorktree(copy, admin)
    await updateMeta(copy.meta, '', copies => copies.filter(item => item.agentId !== copy.agentId))
  }
  return { removed: gone, patch, ...(gone ? {} : { error: error || 'the folder could not be removed' }) }
}
// Anything that is not below `root` is never touched. The removal waits behind the merges into the same target: a copy is
// never taken away while one of its merges runs.
function removeCopy(copy: AgentCopy, root: string, runId = ''): Promise<RemoveResult> {
  if (!inside(root, copy.dir)) return Promise.resolve({ removed: false, patch: null, error: `${copy.dir} is not below ${root}` })
  return serialized(keyOf(copy.sourceTop), () => removeNow(copy, root, runId))
}
const alive = (pid: number): boolean => {
  // Signal 0 only asks whether the process exists; pid 0 or below would address a group of processes, never one.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return code(error) === 'EPERM' }
}
// At start: the copies of runs that no longer exist (a crash, a restart that cut a cleanup short) are saved as patches where
// they hold unmerged changes, then removed. A folder whose owner process still lives (another Orbit with the same profile)
// is left alone, and so is anything whose meta.json cannot be read: it is not known to be ours.
async function sweepLeftovers(root: string): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, patches: [], kept: [] }
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_FOLDER.test(entry.name)) continue
    const folder = path.join(root, entry.name)
    const meta = readMeta(path.join(folder, META))
    if (!meta) { if (fs.readdirSync(folder).length) result.kept.push(folder); else try { fs.rmdirSync(folder) } catch { /* Gone or busy. */ } continue }
    const age = Date.now() - Date.parse(meta.createdAt)
    if (meta.pid !== process.pid && alive(meta.pid) && !(age > LEFTOVER_MS)) { result.kept.push(folder); continue }
    for (const copy of meta.copies) {
      const outcome = await removeCopy({ ...copy, meta: path.join(folder, META) }, root, meta.runId)
      if (outcome.patch) result.patches.push(outcome.patch)
      if (outcome.removed) result.removed++; else result.kept.push(copy.dir)
    }
  }
  return result
}

export { createCopy, mergeCopy, describeMerge, removeCopy, sweepLeftovers, inside, realFolder, RUN_FOLDER, PATCHES }
export type { AgentCopy, CopyKind, CopyOptions, CopyRefusal, MergedFile, MergeConflict, MergeResult, MergeHooks, RemoveResult, SweepResult }
