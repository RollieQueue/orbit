import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { BUILD_OUTPUT } from './runtime-tools.mts'
import { readJSON, keyCache } from './storage.mts'
import { stem } from './text-index.mts'
import { runGit } from './git.mts'
import { ellipsis } from './text.mts'

// Local, model-free index of one workspace: paths, symbols, imports and the most telling terms per file.
// It answers "where is X" without an agent listing folders and reading files one by one, and it is
// refreshed incrementally by size+mtime, so a second scan only reads what actually changed.
const ANALYZER_VERSION = 2 // bump when the per-file record changes: an older index on disk is rebuilt once
const MAX_FILES = 5000
const MAX_CONTENT_BYTES = 512 * 1024
const MAX_WALK_DEPTH = 12
const TERMS_PER_FILE = 60
// A 1 600-line module has well over 60 definitions; a cap of 60 left every method after line ~200 unfindable.
const SYMBOLS_PER_FILE = 200
const FRESH_MS = 2500
const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.turbo', '.gradle', 'target', 'build', 'coverage', '.idea', 'out'])
const LANGUAGES: Record<string, string> = {
  '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.cts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.kt': 'kt', '.cs': 'cs', '.rb': 'rb', '.php': 'php', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.css': 'css', '.scss': 'css', '.html': 'html', '.json': 'json', '.md': 'md',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sh': 'sh', '.ps1': 'ps1', '.cmd': 'cmd', '.bat': 'cmd', '.sql': 'sql', '.txt': 'txt',
}
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.class', '.jar', '.pyc', '.node', '.asar', '.map'])
const NOT_CONTENT = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$/i
// Their words would end up in an index file on disk and in search results: listed by name only.
const SECRETS = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|credentials(?:\.[^/]*)?)$/i
// "Where is X" wants the module; its tests share the vocabulary and the file name, so they rank a little lower.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[^/]+$/i
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
const JS_FAMILY = new Set(['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte'])
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.cts', '.mts', '.json']
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'finally', 'with', 'typeof', 'await', 'yield', 'new', 'delete', 'void', 'function'])
const STOPWORDS = new Set(('the and for with this that from have not are was but you all can any use its into out one new get set let var const function return true false null undefined else then when what which while will would should could there their them they than also only just each other some such been being does did our has had his her via per etc typeof import export default class extends static async await switch case break continue throw try catch finally void delete instanceof interface type enum public private protected string number boolean object array length value values index item items name data result results error errors text file files path line lines args arg options option').split(/\s+/))

// A definition found in a file: [name, kind, line]. Kept as a triple so the index file stays small.
type SymbolTriple = [name: string, kind: string, line: number]
// One indexed file as persisted: `p` path, `v` size+mtime version, `sym` symbols, `imp` imports, `t` weighted
// terms ("word:count …"), `d` the first doc line; `skip` says why the content was not read.
interface IndexEntry { p: string; v: string; size: number; lang: string; lines: number; sym: SymbolTriple[]; imp: string[]; t: string; d: string; skip?: string }
// A file as the lister found it, with its stat.
interface Listed { rel: string; stat: fs.Stats }
// Relative imports resolved to indexed files, both ways.
interface Graph { imports: Map<string, string[]>; dependents: Map<string, string[]> }
// Inverted lists over content terms and over symbol names (whole, and split into their words).
interface Postings { terms: Map<string, Array<[IndexEntry, number]>>; parts: Map<string, Array<[IndexEntry, SymbolTriple]>>; whole: Map<string, Array<[IndexEntry, SymbolTriple]>>; partList: string[] }
interface RefreshSummary { total: number; added: string[]; changed: string[]; removed: string[]; fresh?: boolean }
// Everything the index holds for one workspace: the files, when they were scanned, the derived structures
// (dropped whenever a file changes) and the state of a running scan.
interface IndexState {
  key: string; workspace: string; files: Map<string, IndexEntry>; updatedAt: number; scannedAt: number; omitted: number
  inflight: Promise<RefreshSummary> | null; again: boolean; graph: Graph | null; postings: Postings | null
  overview: { maxChars: number; text: string } | null; persistTimer: ReturnType<typeof setTimeout> | null; loaded: boolean; lastScanMs?: number
}
interface IndexStats { files: number; lines: number; languages: Record<string, number>; omitted: number; updatedAt: string | null; indexing: boolean }
interface SymbolInfo { name: string; kind: string; line: number }
interface Outline { path: string; language: string | null; lines: number; size: number; summary?: string; note?: string; symbols: SymbolInfo[]; imports: string[]; externalImports: string[]; importedBy: string[] }
interface SearchHit { path: string; score: number; language: string | null; lines: number; summary?: string; matched: string[]; symbols: SymbolInfo[] }
// A file's score while a search runs: why it matched, which query words hit a symbol, and its best symbols.
interface Score { score: number; why: Set<string>; words: Set<string>; symbols: Map<string, number> }
// Lists the files of a workspace, or null to fall back to the walk.
type Lister = (workspace: string) => Promise<string[] | null>
// The persisted cache file, as this module wrote it; checked by analyzer version and workspace before use.
interface SavedIndex { analyzer?: unknown; workspace?: unknown; files?: unknown; updatedAt?: unknown; omitted?: unknown }

const posix = (value: string): string => String(value).split(path.sep).join('/')
const keyOf = keyCache(200)
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// The `code` of a thrown value ('EPERM', …) as text, '' when it has none.
const errorCode = (error: unknown): string => String((error as { code?: unknown } | null | undefined)?.code ?? '')
async function mapLimit<Item, Result>(items: Item[], limit: number, work: (item: Item, index: number) => Promise<Result>): Promise<Result[]> {
  const out = new Array<Result>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await work(items[index], index)
  }))
  return out
}
function words(text: unknown): string[] {
  const out: string[] = []
  for (const token of String(text).match(/[\p{L}_][\p{L}\p{N}_]{1,}/gu) || []) {
    const lower = token.toLowerCase()
    out.push(lower)
    const parts = token.split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).map(part => part.toLowerCase()).filter(part => part.length > 1)
    if (parts.length > 1) out.push(...parts)
  }
  return out
}
// Content terms are stemmed like memory notes are (plural s, then the first five letters), so "refreshing the
// indexes" meets "refresh index". Paths and symbols stay exact: they are matched as written.
const termsOf = (text: string): string[] => words(text).filter(word => word.length > 2 && !STOPWORDS.has(word) && !/^\d/.test(word)).map(stem)

function extractSymbols(lines: string[], lang: string): SymbolTriple[] {
  const found: SymbolTriple[] = []
  const add = (name: string, kind: string, line: number): void => { if (name && found.length < SYMBOLS_PER_FILE) found.push([name, kind, line]) }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length > 400) continue
    let m: RegExpMatchArray | null
    if (JS_FAMILY.has(lang)) {
      if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'function', i + 1)
      else if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'class', i + 1)
      else if ((m = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) add(m[2], m[1], i + 1)
      else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/))) add(m[1], 'function', i + 1)
      else if ((m = line.match(/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=/))) add(m[1], 'const', i + 1)
      else if ((m = line.match(/^\s*module\.exports\s*=\s*\{([^}]*)\}/))) for (const name of m[1].split(',')) add(name.split(':')[0].trim(), 'export', i + 1)
      else if ((m = line.match(/^\s{1,4}(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/)) && !NOT_A_METHOD.has(m[1])) add(m[1], 'method', i + 1)
    } else if (lang === 'py') {
      if ((m = line.match(/^(\s*)(?:async\s+)?def\s+(\w+)/))) add(m[2], m[1] ? 'method' : 'function', i + 1)
      else if ((m = line.match(/^class\s+(\w+)/))) add(m[1], 'class', i + 1)
    } else if (lang === 'go') {
      if ((m = line.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/))) add(m[1], 'function', i + 1)
      else if ((m = line.match(/^type\s+(\w+)\s+(struct|interface)/))) add(m[1], m[2], i + 1)
    } else if (lang === 'rs') {
      if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/))) add(m[1], 'function', i + 1)
      else if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait)\s+(\w+)/))) add(m[2], m[1], i + 1)
    } else if (['java', 'kt', 'cs', 'swift', 'php', 'cpp', 'c'].includes(lang)) {
      if ((m = line.match(/\b(class|interface|enum|record|struct|trait|object)\s+([A-Za-z_]\w*)/)) && !/^\s*(?:\/\/|\*|\/\*)/.test(line)) add(m[2], m[1], i + 1)
      else if (lang === 'php' && (m = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(\w+)/))) add(m[1], 'function', i + 1)
    } else if (lang === 'rb') {
      if ((m = line.match(/^\s*def\s+(?:self\.)?(\w+[?!]?)/))) add(m[1], 'function', i + 1)
      else if ((m = line.match(/^\s*(class|module)\s+([A-Z]\w*)/))) add(m[2], m[1], i + 1)
    } else if (lang === 'sh' || lang === 'ps1') {
      if ((m = line.match(/^\s*function\s+([\w-]+)/i)) || (m = line.match(/^\s*([\w-]+)\s*\(\)\s*\{/))) add(m[1], 'function', i + 1)
    } else if (lang === 'md') {
      if ((m = line.match(/^#{1,3}\s+(.{2,80})$/))) add(m[1].trim(), 'heading', i + 1)
    }
  }
  // `module.exports = { a, b }` repeats names already found as definitions.
  const defined = new Set(found.filter(item => item[1] !== 'export').map(item => item[0]))
  return found.filter(item => item[1] !== 'export' || !defined.has(item[0]))
}
function extractImports(content: string, lang: string): string[] {
  const found = new Set<string>()
  if (JS_FAMILY.has(lang)) {
    const pattern = /(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]|import\s*['"]([^'"\n]+)['"]|require\(\s*['"]([^'"\n]+)['"]\s*\)|import\(\s*['"]([^'"\n]+)['"]\s*\)/g
    for (let m = pattern.exec(content); m && found.size < 60; m = pattern.exec(content)) found.add(m[1] || m[2] || m[3] || m[4])
  } else if (lang === 'py') {
    for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) { found.add(m[1] || m[2]); if (found.size >= 60) break }
  }
  return [...found]
}
function firstDocLine(lines: string[], lang: string): string {
  if (lang === 'md') return (lines.find(line => /^#\s+\S/.test(line)) || '').replace(/^#\s+/, '').slice(0, 140)
  for (const line of lines.slice(0, 25)) {
    const m = line.match(/^\s*(?:\/\/|#|\/\*\*?|\*)\s*(.{10,160})/)
    if (m && !/^(?:use strict|eslint|@ts-|prettier|copyright|license|-\*-|!\/)/i.test(m[1]) && !/^\*\/?$/.test(m[1])) return m[1].replace(/\*\/\s*$/, '').trim().slice(0, 140)
  }
  return ''
}
function analyze(content: string, lang: string): Pick<IndexEntry, 'lines' | 'sym' | 'imp' | 't' | 'd'> {
  const lines = content.split(/\r?\n/)
  const symbols = extractSymbols(lines, lang)
  const doc = firstDocLine(lines, lang)
  const counts = new Map<string, number>()
  const bump = (term: string, by: number): Map<string, number> => counts.set(term, (counts.get(term) || 0) + by)
  for (const term of termsOf(content.length > 200000 ? content.slice(0, 200000) : content)) bump(term, 1)
  // What a file defines and what its first comment says describe it better than its most repeated identifiers.
  for (const [name] of symbols) for (const term of termsOf(name)) bump(term, 3)
  for (const term of termsOf(doc)) bump(term, 3)
  const terms = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, TERMS_PER_FILE).map(([word, count]) => `${word}:${Math.min(count, 99)}`).join(' ')
  return { lines: lines.length, sym: symbols, imp: extractImports(content, lang), t: terms, d: doc }
}
function languageOf(rel: string): string {
  const base = path.posix.basename(rel)
  if (/^(?:dockerfile|makefile|gemfile|rakefile)$/i.test(base)) return 'txt'
  return LANGUAGES[path.posix.extname(base).toLowerCase()] || ''
}

function insideGitRepository(workspace: string): boolean {
  for (let directory = path.resolve(workspace); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return true
    if (path.dirname(directory) === directory) return false
  }
}
// Git knows what is ignored, which no folder walk can match. It runs through git.mts, from a neutral folder (a
// process's cwd stays locked on Windows). An empty answer (a folder that its parent repository ignores) falls back
// to the walk like an error does.
async function listWithGit(workspace: string): Promise<string[] | null> {
  if (!insideGitRepository(workspace)) return null
  const result = await runGit(workspace, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 8000, maxBuffer: 64 * 1024 * 1024 })
  if (!result.ok) return null
  const files = result.stdout.split('\0').filter(Boolean).filter(rel => {
    const parts = rel.split('/')
    return !parts.some(part => part === '.git' || part === 'node_modules') && !(parts.length > 1 && BUILD_OUTPUT.test(parts[0]))
  })
  return files.length ? files : null
}
async function walk(workspace: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_FILES + 1) return
      const rel = posix(path.relative(workspace, path.join(directory, entry.name)))
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { if (depth < MAX_WALK_DEPTH && !WALK_SKIP.has(entry.name) && !BUILD_OUTPUT.test(entry.name)) await visit(path.join(directory, entry.name), depth + 1) }
      else if (entry.isFile()) files.push(rel)
    }
  }
  await visit(workspace, 0)
  return files
}

class ProjectIndex {
  declare directory: string | null
  declare clock: () => number
  declare lister: Lister
  declare states: Map<string, IndexState>
  // `directory` makes the index survive restarts; without it the index lives for the process only.
  constructor({ directory = null, clock = Date.now, lister = listWithGit }: { directory?: string | null; clock?: () => number; lister?: Lister } = {}) {
    Object.assign(this, { directory, clock, lister })
    this.states = new Map()
  }
  state(workspace: string): IndexState {
    const key = keyOf(workspace)
    let state = this.states.get(key)
    if (!state) {
      state = { key, workspace, files: new Map(), updatedAt: 0, scannedAt: 0, omitted: 0, inflight: null, again: false, graph: null, postings: null, overview: null, persistTimer: null, loaded: false }
      this.states.set(key, state)
    }
    return state
  }
  // Only asked once `directory` was checked.
  file(state: IndexState): string { return path.join(this.directory as string, `${createHash('sha1').update(state.key).digest('hex').slice(0, 24)}.json`) }
  load(state: IndexState): void {
    if (state.loaded) return
    state.loaded = true
    if (!this.directory) return
    try {
      const saved = readJSON(this.file(state), null) as SavedIndex | null
      if (saved?.analyzer !== ANALYZER_VERSION || saved.workspace !== state.key || !Array.isArray(saved.files)) return
      // Entries are trusted as this analyzer version wrote them; a path and a version are what a scan needs to compare.
      for (const entry of saved.files as Array<Partial<IndexEntry> | null>) if (entry?.p && entry.v) state.files.set(entry.p, entry as IndexEntry)
      state.updatedAt = typeof saved.updatedAt === 'number' ? saved.updatedAt : 0; state.omitted = typeof saved.omitted === 'number' ? saved.omitted : 0
    } catch { /* A damaged index is simply rebuilt. */ }
  }
  schedulePersist(state: IndexState): void {
    if (!this.directory || state.persistTimer) return
    state.persistTimer = setTimeout(() => { state.persistTimer = null; this.persistNow(state) }, 2000)
    state.persistTimer.unref?.()
  }
  flush(): void {
    for (const state of this.states.values()) if (state.persistTimer) { clearTimeout(state.persistTimer); state.persistTimer = null; this.persistNow(state) }
  }
  // A cache, not a record: written compact (pretty-printed symbol triples made the file 1.7× larger), replaced
  // atomically, and without a backup copy, because a damaged or missing file only costs one rescan.
  persistNow(state: IndexState): void {
    if (!this.directory) return
    const file = this.file(state), temporary = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(this.directory, { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify({ analyzer: ANALYZER_VERSION, workspace: state.key, updatedAt: state.updatedAt, omitted: state.omitted, files: [...state.files.values()] }), 'utf8')
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(temporary, file); break }
        catch (error) { if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error))) throw error; pause(20 * (attempt + 1)) } // Windows briefly locks just-written files
      }
    } catch { try { fs.unlinkSync(temporary) } catch { /* Persistence is an optimisation. */ } }
  }

  async readEntry(workspace: string, rel: string, stat: fs.Stats, previous: IndexEntry | undefined): Promise<IndexEntry | null> {
    const lang = languageOf(rel)
    const version = `${stat.mtimeMs}:${stat.size}`
    if (previous?.v === version) return previous
    const entry: IndexEntry = { p: rel, v: version, size: stat.size, lang, lines: 0, sym: [], imp: [], t: '', d: '' }
    const ext = path.posix.extname(rel).toLowerCase()
    if (SECRETS.test(rel)) return { ...entry, skip: 'may hold secrets' }
    if (BINARY.has(ext) || NOT_CONTENT.test(rel)) return { ...entry, skip: 'binary-or-generated' }
    if (stat.size > MAX_CONTENT_BYTES) return { ...entry, skip: 'large' }
    let content: string
    try { content = await fs.promises.readFile(path.join(workspace, rel), 'utf8') } catch { return null }
    if (content.includes('\0')) return { ...entry, skip: 'binary-or-generated' }
    return { ...entry, ...analyze(content, lang) }
  }

  // Brings the index up to date and reports which paths were added, changed or removed.
  async refresh(workspace: string, { force = false }: { force?: boolean } = {}): Promise<RefreshSummary> {
    const state = this.state(workspace)
    this.load(state)
    if (state.inflight) { state.again = true; return state.inflight }
    // Freshness is about a scan made by this process: an index loaded from disk may be arbitrarily old.
    if (!force && state.scannedAt && this.clock() - state.scannedAt < FRESH_MS) return { total: state.files.size, added: [], changed: [], removed: [], fresh: true }
    state.inflight = (async (): Promise<RefreshSummary> => {
      const summary: RefreshSummary = { total: 0, added: [], changed: [], removed: [] }
      let rounds = 0
      do {
        state.again = false
        const round = await this.scan(state)
        summary.added.push(...round.added); summary.changed.push(...round.changed); summary.removed.push(...round.removed)
      } while (state.again && ++rounds < 2)
      summary.total = state.files.size
      return summary
    })().finally(() => { state.inflight = null })
    return state.inflight
  }
  async scan(state: IndexState): Promise<{ added: string[]; changed: string[]; removed: string[] }> {
    const started = this.clock()
    const workspace = state.workspace
    let listed = await this.lister(workspace)
    if (!listed) listed = await walk(workspace)
    const omitted = Math.max(0, listed.length - MAX_FILES)
    const stats = await mapLimit(listed.slice(0, MAX_FILES), 48, async (rel): Promise<Listed | null> => {
      try { const stat = await fs.promises.lstat(path.join(workspace, rel)); return stat.isFile() ? { rel, stat } : null } catch { return null }
    })
    const present = stats.filter((item): item is Listed => Boolean(item))
    const seen = new Set(present.map(item => item.rel))
    const added: string[] = [], changed: string[] = [], removed: string[] = []
    for (const rel of state.files.keys()) if (!seen.has(rel)) removed.push(rel)
    const work = present.filter(({ rel, stat }) => state.files.get(rel)?.v !== `${stat.mtimeMs}:${stat.size}`)
    const entries = await mapLimit(work, 24, ({ rel, stat }) => this.readEntry(workspace, rel, stat, state.files.get(rel)))
    for (const gone of removed) state.files.delete(gone)
    entries.forEach((entry, index) => {
      if (!entry) return
      const rel = work[index].rel
      ;(state.files.has(rel) ? changed : added).push(rel)
      state.files.set(rel, entry)
    })
    state.omitted = omitted; state.scannedAt = this.clock()
    if (added.length || changed.length || removed.length) { state.updatedAt = state.scannedAt; this.invalidate(state) }
    state.lastScanMs = this.clock() - started
    return { added, changed, removed }
  }
  invalidate(state: IndexState): void { state.graph = state.postings = state.overview = null; this.schedulePersist(state) }
  // The path an agent wrote may differ in case from the one Git listed; on a case-insensitive disk it is the same file.
  knownPath(state: IndexState, rel: string): string {
    if (state.files.has(rel) || !CASE_INSENSITIVE_FS) return rel
    const lower = rel.toLowerCase()
    for (const key of state.files.keys()) if (key.toLowerCase() === lower) return key
    return rel
  }
  // Re-reads specific files right away, so an agent's own edit is searchable before the next full scan.
  async touch(workspace: string, relPaths: readonly string[]): Promise<string[]> {
    const state = this.state(workspace)
    this.load(state)
    const touched: string[] = []
    for (const raw of relPaths) {
      let rel = posix(path.relative(workspace, path.resolve(workspace, raw)))
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      rel = this.knownPath(state, rel)
      let stat: fs.Stats
      try { stat = await fs.promises.lstat(path.join(workspace, rel)) } catch { if (state.files.delete(rel)) touched.push(rel); continue }
      if (!stat.isFile()) continue
      const entry = await this.readEntry(workspace, rel, stat, state.files.get(rel))
      if (entry && entry !== state.files.get(rel)) { state.files.set(rel, entry); touched.push(rel) }
    }
    if (touched.length) { state.updatedAt = this.clock(); this.invalidate(state) }
    return touched
  }

  stats(workspace: string): IndexStats {
    const state = this.state(workspace)
    this.load(state)
    const languages: Record<string, number> = {}
    let lines = 0
    for (const entry of state.files.values()) { if (entry.lang) languages[entry.lang] = (languages[entry.lang] || 0) + 1; lines += entry.lines }
    return { files: state.files.size, lines, languages, omitted: state.omitted, updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null, indexing: !!state.inflight }
  }
  overview(workspace: string, maxChars = 1600): string {
    const state = this.state(workspace)
    this.load(state)
    if (!state.files.size) return ''
    // Every agent turn asks for this; it only changes when files do.
    if (state.overview?.maxChars === maxChars) return state.overview.text
    const { files, lines, languages, omitted } = this.stats(workspace)
    const top = new Map<string, { files: number; langs: Record<string, number> }>(), root: string[] = []
    for (const entry of state.files.values()) {
      const [head, ...rest] = entry.p.split('/')
      if (!rest.length) { root.push(head); continue }
      const bucket = top.get(head) || { files: 0, langs: {} }
      bucket.files++; if (entry.lang) bucket.langs[entry.lang] = (bucket.langs[entry.lang] || 0) + 1
      top.set(head, bucket)
    }
    const langs = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} ${count}`).join(', ')
    const dirs = [...top].sort((a, b) => b[1].files - a[1].files).slice(0, 14).map(([name, info]) => `${name}/ ${info.files} (${Object.entries(info.langs).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([lang]) => lang).join('/') || 'other'})`).join(' · ')
    const text = `${files} files, ${lines} lines${omitted ? `, ${omitted} more not indexed` : ''}; ${langs}.\nFolders: ${dirs || 'none'}.\nRoot files: ${root.sort().slice(0, 16).join(', ') || 'none'}.\nindex_search finds files and symbols by name or topic; index_outline lists one file's symbols with line numbers, imports and dependents. Use them before list_files or reading whole files.`
    const fitted = ellipsis(text, maxChars)
    state.overview = { maxChars, text: fitted }
    return fitted
  }

  buildGraph(state: IndexState): Graph {
    if (state.graph) return state.graph
    const known = new Set(state.files.keys())
    const imports = new Map<string, string[]>(), dependents = new Map<string, string[]>()
    for (const entry of state.files.values()) {
      if (!JS_FAMILY.has(entry.lang) && entry.lang !== 'json') continue
      const resolved: string[] = []
      for (const spec of entry.imp) {
        if (!spec.startsWith('.')) continue
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(entry.p), spec))
        const target = [base, ...JS_EXTENSIONS.map(ext => base + ext), ...JS_EXTENSIONS.map(ext => `${base}/index${ext}`)].find(candidate => known.has(candidate))
        if (target && target !== entry.p) resolved.push(target)
      }
      if (!resolved.length) continue
      imports.set(entry.p, [...new Set(resolved)])
      for (const target of new Set(resolved)) dependents.set(target, [...(dependents.get(target) || []), entry.p])
    }
    state.graph = { imports, dependents }
    return state.graph
  }
  outline(workspace: string, requested: unknown): Outline | null {
    const state = this.state(workspace)
    this.load(state)
    const rel = this.knownPath(state, posix(path.relative(workspace, path.resolve(workspace, String(requested || '')))))
    const entry = state.files.get(rel)
    if (!entry) return null
    const graph = this.buildGraph(state)
    return {
      path: entry.p, language: entry.lang || null, lines: entry.lines, size: entry.size, ...(entry.d ? { summary: entry.d } : {}), ...(entry.skip ? { note: `content not indexed (${entry.skip})` } : {}),
      symbols: entry.sym.map(([name, kind, line]) => ({ name, kind, line })),
      imports: graph.imports.get(rel) || [], externalImports: entry.imp.filter(spec => !spec.startsWith('.')).slice(0, 20), importedBy: (graph.dependents.get(rel) || []).slice(0, 30),
    }
  }

  // Inverted lists over content terms and over symbol names (whole, and split into their words), so a query
  // touches only the files that share a word with it instead of every symbol of every file.
  buildPostings(state: IndexState): Postings {
    if (state.postings) return state.postings
    const terms = new Map<string, Array<[IndexEntry, number]>>(), parts = new Map<string, Array<[IndexEntry, SymbolTriple]>>(), whole = new Map<string, Array<[IndexEntry, SymbolTriple]>>()
    const listed = <Item,>(map: Map<string, Item[]>, key: string, item: Item): void => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]) }
    for (const entry of state.files.values()) {
      if (entry.t) for (const pair of entry.t.split(' ')) {
        const split = pair.lastIndexOf(':')
        listed(terms, pair.slice(0, split), [entry, Number(pair.slice(split + 1)) || 1])
      }
      for (const symbol of entry.sym) {
        const hit: [IndexEntry, SymbolTriple] = [entry, symbol]
        listed(whole, symbol[0].toLowerCase(), hit)
        for (const part of new Set(words(symbol[0]))) listed(parts, part, hit)
      }
    }
    state.postings = { terms, parts, whole, partList: [...parts.keys()] }
    return state.postings
  }
  // Ranked lexical search: path and symbol matches count most, then terms weighted by how rare they are.
  search(workspace: string, query: unknown, { limit = 10 }: { limit?: number } = {}): { indexed: number; results: SearchHit[] } {
    const state = this.state(workspace)
    this.load(state)
    const wanted = [...new Set(words(query).filter(word => word.length > 1 && !STOPWORDS.has(word)))].slice(0, 12)
    const whole = String(query || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_.$/-]+/gu, '')
    if (!wanted.length && !whole) return { indexed: state.files.size, results: [] }
    const postings = this.buildPostings(state)
    const scores = new Map<IndexEntry, Score>()
    const bump = (entry: IndexEntry, points: number, why: string): Score => { const item = scores.get(entry) || { score: 0, why: new Set<string>(), words: new Set<string>(), symbols: new Map<string, number>() }; item.score += points; item.why.add(why); scores.set(entry, item); return item }
    const total = Math.max(1, state.files.size)
    for (const term of new Set(wanted.map(stem))) {
      const list = postings.terms.get(term) || []
      const idf = Math.log(1 + total / (1 + list.length))
      for (const [entry, count] of list) bump(entry, idf * (count / (count + 1.5)) * 2, 'content')
    }
    // A symbol hit counts once per query word, however many symbols of the file contain it: a module with forty
    // `addProject…` handlers is not forty times more relevant than the one that defines the project index.
    const symbolHit = (entry: IndexEntry, symbol: SymbolTriple, word: string | null, weight: number): void => {
      const item = bump(entry, 0, 'symbol')
      if (word) item.words.add(word)
      const key = symbol.join('|')
      item.symbols.set(key, Math.max(item.symbols.get(key) || 0, weight))
    }
    // "refreshing indexes" should reach `refreshIndex`: a word matches a symbol's part that contains it, or that it starts with.
    for (const word of wanted) {
      const matching = word.length > 3 ? postings.partList.filter(part => part.includes(word) || (part.length > 3 && word.startsWith(part))) : postings.parts.has(word) ? [word] : []
      for (const part of matching) for (const [entry, symbol] of postings.parts.get(part)!) symbolHit(entry, symbol, word, part === word ? 2 : 1)
    }
    if (whole.length > 2) for (const [entry, symbol] of postings.whole.get(whole) || []) { bump(entry, 12, 'symbol'); symbolHit(entry, symbol, null, 3) }
    for (const item of scores.values()) if (item.words.size) item.score += 4 * item.words.size
    for (const entry of state.files.values()) {
      const lowerPath = entry.p.toLowerCase(), base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
      if (whole.length > 2 && lowerPath.includes(whole)) bump(entry, whole === base ? 14 : 9, 'path')
      else for (const word of wanted) { if (base.includes(word)) bump(entry, 6, 'path'); else if (lowerPath.includes(word)) bump(entry, 2, 'path') }
      if (entry.d && wanted.some(word => entry.d.toLowerCase().includes(word))) bump(entry, 1.5, 'summary')
    }
    for (const [entry, item] of scores) if (TEST_PATH.test(entry.p)) item.score *= 0.85
    const results = [...scores].sort((a, b) => b[1].score - a[1].score || a[0].p.localeCompare(b[0].p)).slice(0, Math.max(1, Math.min(limit, 30))).map(([entry, item]): SearchHit => ({
      path: entry.p, score: Math.round(item.score * 10) / 10, language: entry.lang || null, lines: entry.lines,
      ...(entry.d ? { summary: entry.d } : {}), matched: [...item.why],
      symbols: [...item.symbols].sort((a, b) => b[1] - a[1] || Number(a[0].split('|')[2]) - Number(b[0].split('|')[2])).slice(0, 5).map(([text]) => { const [name, kind, line] = text.split('|'); return { name, kind, line: Number(line) } }),
    }))
    return { indexed: state.files.size, results }
  }
}

export { ProjectIndex, analyze, extractSymbols, extractImports, languageOf }
export type { IndexEntry, IndexStats, RefreshSummary, Outline, SearchHit, SymbolTriple, Lister }
