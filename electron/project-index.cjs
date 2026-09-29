'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { BUILD_OUTPUT } = require('./runtime-tools.cjs')
const { readJSON, writeJSON, workspaceKey } = require('./storage.cjs')

// Local, model-free index of one workspace: paths, symbols, imports and the most telling terms per file.
// It answers "where is X" without an agent listing folders and reading files one by one, and it is
// refreshed incrementally by size+mtime, so a second scan only reads what actually changed.
const ANALYZER_VERSION = 1
const MAX_FILES = 5000
const MAX_CONTENT_BYTES = 512 * 1024
const MAX_WALK_DEPTH = 12
const TERMS_PER_FILE = 40
const SYMBOLS_PER_FILE = 60
const FRESH_MS = 2500
const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.turbo', '.gradle', 'target', 'build', 'coverage', '.idea', 'out'])
const LANGUAGES = {
  '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.cts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.kt': 'kt', '.cs': 'cs', '.rb': 'rb', '.php': 'php', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.css': 'css', '.scss': 'css', '.html': 'html', '.json': 'json', '.md': 'md',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sh': 'sh', '.ps1': 'ps1', '.cmd': 'cmd', '.bat': 'cmd', '.sql': 'sql', '.txt': 'txt',
}
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.class', '.jar', '.pyc', '.node', '.asar', '.map'])
const NOT_CONTENT = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$/i
// Their words would end up in an index file on disk and in search results: listed by name only.
const SECRETS = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|credentials(?:\.[^/]*)?)$/i
const JS_FAMILY = new Set(['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte'])
const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.cts', '.mts', '.json']
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'finally', 'with', 'typeof', 'await', 'yield', 'new', 'delete', 'void', 'function'])
const STOPWORDS = new Set(('the and for with this that from have not are was but you all can any use its into out one new get set let var const function return true false null undefined else then when what which while will would should could there their them they than also only just each other some such been being does did our has had his her via per etc typeof import export default class extends static async await switch case break continue throw try catch finally void delete instanceof interface type enum public private protected string number boolean object array length value values index item items name data result results error errors text file files path line lines args arg options option').split(/\s+/))

const posix = value => String(value).split(path.sep).join('/')
async function mapLimit(items, limit, work) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await work(items[index], index)
  }))
  return out
}
function words(text) {
  const out = []
  for (const token of String(text).match(/[\p{L}_][\p{L}\p{N}_]{1,}/gu) || []) {
    const lower = token.toLowerCase()
    out.push(lower)
    const parts = token.split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).map(part => part.toLowerCase()).filter(part => part.length > 1)
    if (parts.length > 1) out.push(...parts)
  }
  return out
}

function extractSymbols(lines, lang) {
  const found = []
  const add = (name, kind, line) => { if (name && found.length < SYMBOLS_PER_FILE) found.push([name, kind, line]) }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length > 400) continue
    let m
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
function extractImports(content, lang) {
  const found = new Set()
  if (JS_FAMILY.has(lang)) {
    const pattern = /(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]|import\s*['"]([^'"\n]+)['"]|require\(\s*['"]([^'"\n]+)['"]\s*\)|import\(\s*['"]([^'"\n]+)['"]\s*\)/g
    for (let m = pattern.exec(content); m && found.size < 60; m = pattern.exec(content)) found.add(m[1] || m[2] || m[3] || m[4])
  } else if (lang === 'py') {
    for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) { found.add(m[1] || m[2]); if (found.size >= 60) break }
  }
  return [...found]
}
function firstDocLine(lines, lang) {
  if (lang === 'md') return (lines.find(line => /^#\s+\S/.test(line)) || '').replace(/^#\s+/, '').slice(0, 140)
  for (const line of lines.slice(0, 25)) {
    const m = line.match(/^\s*(?:\/\/|#|\/\*\*?|\*)\s*(.{10,160})/)
    if (m && !/^(?:use strict|eslint|@ts-|prettier|copyright|license|-\*-|!\/)/i.test(m[1]) && !/^\*\/?$/.test(m[1])) return m[1].replace(/\*\/\s*$/, '').trim().slice(0, 140)
  }
  return ''
}
function analyze(content, lang) {
  const lines = content.split(/\r?\n/)
  const symbols = extractSymbols(lines, lang)
  const counts = new Map()
  for (const word of words(content.length > 200000 ? content.slice(0, 200000) : content)) if (word.length > 2 && !STOPWORDS.has(word) && !/^\d/.test(word)) counts.set(word, (counts.get(word) || 0) + 1)
  for (const [name] of symbols) for (const word of words(name)) counts.set(word, (counts.get(word) || 0) + 3)
  const terms = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, TERMS_PER_FILE).map(([word, count]) => `${word}:${Math.min(count, 99)}`).join(' ')
  return { lines: lines.length, sym: symbols, imp: extractImports(content, lang), t: terms, d: firstDocLine(lines, lang) }
}
function languageOf(rel) {
  const base = path.posix.basename(rel)
  if (/^(?:dockerfile|makefile|gemfile|rakefile)$/i.test(base)) return 'txt'
  return LANGUAGES[path.posix.extname(base).toLowerCase()] || ''
}

function insideGitRepository(workspace) {
  for (let directory = path.resolve(workspace); ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) return true
    if (path.dirname(directory) === directory) return false
  }
}
// Git knows what is ignored, which no folder walk can match. It runs from a neutral folder: on Windows a
// process keeps its working directory locked, and that must never be a project the user wants to delete.
function listWithGit(workspace) {
  return new Promise(resolve => {
    if (!insideGitRepository(workspace)) return resolve(null)
    execFile('git', ['-C', workspace, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: os.tmpdir(), timeout: 8000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      const files = String(stdout).split('\0').filter(Boolean).filter(rel => {
        const parts = rel.split('/')
        return !parts.some(part => part === '.git' || part === 'node_modules') && !(parts.length > 1 && BUILD_OUTPUT.test(parts[0]))
      })
      resolve(files)
    })
  })
}
async function walk(workspace) {
  const files = []
  const visit = async (directory, depth) => {
    let entries
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
  // `directory` makes the index survive restarts; without it the index lives for the process only.
  constructor({ directory = null, clock = Date.now, lister = listWithGit } = {}) {
    Object.assign(this, { directory, clock, lister })
    this.states = new Map()
  }
  state(workspace) {
    const key = workspaceKey(workspace)
    let state = this.states.get(key)
    if (!state) {
      state = { key, workspace, files: new Map(), updatedAt: 0, scannedAt: 0, omitted: 0, inflight: null, again: false, graph: null, postings: null, overview: null, persistTimer: null, loaded: false }
      this.states.set(key, state)
    }
    return state
  }
  file(state) { return path.join(this.directory, `${createHash('sha1').update(state.key).digest('hex').slice(0, 24)}.json`) }
  load(state) {
    if (state.loaded) return
    state.loaded = true
    if (!this.directory) return
    try {
      const saved = readJSON(this.file(state), null)
      if (saved?.analyzer !== ANALYZER_VERSION || saved.workspace !== state.key || !Array.isArray(saved.files)) return
      for (const entry of saved.files) if (entry?.p && entry.v) state.files.set(entry.p, entry)
      state.updatedAt = saved.updatedAt || 0; state.omitted = saved.omitted || 0
    } catch { /* A damaged index is simply rebuilt. */ }
  }
  schedulePersist(state) {
    if (!this.directory || state.persistTimer) return
    state.persistTimer = setTimeout(() => { state.persistTimer = null; this.persistNow(state) }, 2000)
    state.persistTimer.unref?.()
  }
  flush() {
    for (const state of this.states.values()) if (state.persistTimer) { clearTimeout(state.persistTimer); state.persistTimer = null; this.persistNow(state) }
  }
  persistNow(state) {
    if (!this.directory) return
    try { writeJSON(this.file(state), { analyzer: ANALYZER_VERSION, workspace: state.key, updatedAt: state.updatedAt, omitted: state.omitted, files: [...state.files.values()] }) } catch { /* Persistence is an optimisation. */ }
  }

  async readEntry(workspace, rel, stat, previous) {
    const lang = languageOf(rel)
    const version = `${stat.mtimeMs}:${stat.size}`
    if (previous?.v === version) return previous
    const entry = { p: rel, v: version, size: stat.size, lang, lines: 0, sym: [], imp: [], t: '', d: '' }
    const ext = path.posix.extname(rel).toLowerCase()
    if (SECRETS.test(rel)) return { ...entry, skip: 'may hold secrets' }
    if (BINARY.has(ext) || NOT_CONTENT.test(rel)) return { ...entry, skip: 'binary-or-generated' }
    if (stat.size > MAX_CONTENT_BYTES) return { ...entry, skip: 'large' }
    let content
    try { content = await fs.promises.readFile(path.join(workspace, rel), 'utf8') } catch { return null }
    if (content.includes('\0')) return { ...entry, skip: 'binary-or-generated' }
    return { ...entry, ...analyze(content, lang) }
  }

  // Brings the index up to date and reports which paths were added, changed or removed.
  async refresh(workspace, { force = false } = {}) {
    const state = this.state(workspace)
    this.load(state)
    if (state.inflight) { state.again = true; return state.inflight }
    // Freshness is about a scan made by this process: an index loaded from disk may be arbitrarily old.
    if (!force && state.scannedAt && this.clock() - state.scannedAt < FRESH_MS) return { total: state.files.size, added: [], changed: [], removed: [], fresh: true }
    state.inflight = (async () => {
      const summary = { total: 0, added: [], changed: [], removed: [] }
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
  async scan(state) {
    const started = this.clock()
    const workspace = state.workspace
    let listed = await this.lister(workspace)
    if (!listed) listed = await walk(workspace)
    const omitted = Math.max(0, listed.length - MAX_FILES)
    const stats = await mapLimit(listed.slice(0, MAX_FILES), 48, async rel => {
      try { const stat = await fs.promises.lstat(path.join(workspace, rel)); return stat.isFile() ? { rel, stat } : null } catch { return null }
    })
    const present = stats.filter(Boolean)
    const seen = new Set(present.map(item => item.rel))
    const added = [], changed = [], removed = []
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
    state.omitted = omitted; state.updatedAt = state.scannedAt = this.clock()
    if (added.length || changed.length || removed.length) { state.graph = state.postings = state.overview = null; this.schedulePersist(state) }
    state.lastScanMs = this.clock() - started
    return { added, changed, removed }
  }
  // Re-reads specific files right away, so an agent's own edit is searchable before the next full scan.
  async touch(workspace, relPaths) {
    const state = this.state(workspace)
    this.load(state)
    const touched = []
    for (const raw of relPaths) {
      const rel = posix(path.relative(workspace, path.resolve(workspace, raw)))
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      let stat
      try { stat = await fs.promises.lstat(path.join(workspace, rel)) } catch { if (state.files.delete(rel)) touched.push(rel); continue }
      if (!stat.isFile()) continue
      const entry = await this.readEntry(workspace, rel, stat, state.files.get(rel))
      if (entry && entry !== state.files.get(rel)) { state.files.set(rel, entry); touched.push(rel) }
    }
    if (touched.length) { state.graph = state.postings = state.overview = null; this.schedulePersist(state) }
    return touched
  }

  stats(workspace) {
    const state = this.state(workspace)
    this.load(state)
    const languages = {}
    let lines = 0
    for (const entry of state.files.values()) { if (entry.lang) languages[entry.lang] = (languages[entry.lang] || 0) + 1; lines += entry.lines }
    return { files: state.files.size, lines, languages, omitted: state.omitted, updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null, indexing: !!state.inflight }
  }
  overview(workspace, maxChars = 1600) {
    const state = this.state(workspace)
    this.load(state)
    if (!state.files.size) return ''
    // Every agent turn asks for this; it only changes when files do.
    if (state.overview?.maxChars === maxChars) return state.overview.text
    const { files, lines, languages, omitted } = this.stats(workspace)
    const top = new Map(), root = []
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
    const fitted = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
    state.overview = { maxChars, text: fitted }
    return fitted
  }

  buildGraph(state) {
    if (state.graph) return state.graph
    const known = new Set(state.files.keys())
    const imports = new Map(), dependents = new Map()
    for (const entry of state.files.values()) {
      if (!JS_FAMILY.has(entry.lang) && entry.lang !== 'json') continue
      const resolved = []
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
  outline(workspace, requested) {
    const state = this.state(workspace)
    this.load(state)
    const rel = posix(path.relative(workspace, path.resolve(workspace, String(requested || ''))))
    const entry = state.files.get(rel)
    if (!entry) return null
    const graph = this.buildGraph(state)
    return {
      path: entry.p, language: entry.lang || null, lines: entry.lines, size: entry.size, ...(entry.d ? { summary: entry.d } : {}), ...(entry.skip ? { note: `content not indexed (${entry.skip})` } : {}),
      symbols: entry.sym.map(([name, kind, line]) => ({ name, kind, line })),
      imports: graph.imports.get(rel) || [], externalImports: entry.imp.filter(spec => !spec.startsWith('.')).slice(0, 20), importedBy: (graph.dependents.get(rel) || []).slice(0, 30),
    }
  }

  buildPostings(state) {
    if (state.postings) return state.postings
    const postings = new Map()
    for (const entry of state.files.values()) {
      if (!entry.t) continue
      for (const pair of entry.t.split(' ')) {
        const split = pair.lastIndexOf(':')
        const term = pair.slice(0, split), count = Number(pair.slice(split + 1)) || 1
        const list = postings.get(term)
        if (list) list.push([entry, count]); else postings.set(term, [[entry, count]])
      }
    }
    state.postings = postings
    return postings
  }
  // Ranked lexical search: path and symbol matches count most, then terms weighted by how rare they are.
  search(workspace, query, { limit = 10 } = {}) {
    const state = this.state(workspace)
    this.load(state)
    const wanted = [...new Set(words(query).filter(word => word.length > 1 && !STOPWORDS.has(word)))].slice(0, 12)
    const whole = String(query || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_.$/-]+/gu, '')
    if (!wanted.length && !whole) return { indexed: state.files.size, results: [] }
    const postings = this.buildPostings(state)
    const scores = new Map()
    const bump = (entry, points, why) => { const item = scores.get(entry) || { score: 0, why: new Set(), symbols: new Set() }; item.score += points; item.why.add(why); scores.set(entry, item); return item }
    const total = Math.max(1, state.files.size)
    for (const word of wanted) {
      for (const [entry, count] of postings.get(word) || []) {
        const idf = Math.log(1 + total / (1 + (postings.get(word)?.length || 0)))
        bump(entry, idf * (count / (count + 1.5)) * 2, 'content')
      }
    }
    for (const entry of state.files.values()) {
      const lowerPath = entry.p.toLowerCase(), base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
      if (whole.length > 2 && lowerPath.includes(whole)) bump(entry, whole === base ? 14 : 9, 'path')
      else for (const word of wanted) { if (base.includes(word)) bump(entry, 6, 'path'); else if (lowerPath.includes(word)) bump(entry, 2, 'path') }
      for (const [name, kind, line] of entry.sym) {
        const lower = name.toLowerCase()
        if (whole.length > 2 && lower === whole) bump(entry, 12, 'symbol').symbols.add(`${name}|${kind}|${line}`)
        else {
          const hits = wanted.filter(word => word.length > 3 ? lower.includes(word) : lower === word)
          if (hits.length) bump(entry, 4 * hits.length, 'symbol').symbols.add(`${name}|${kind}|${line}`)
        }
      }
      if (entry.d && wanted.some(word => entry.d.toLowerCase().includes(word))) bump(entry, 1.5, 'summary')
    }
    const results = [...scores].sort((a, b) => b[1].score - a[1].score || a[0].p.localeCompare(b[0].p)).slice(0, Math.max(1, Math.min(limit, 30))).map(([entry, item]) => ({
      path: entry.p, score: Math.round(item.score * 10) / 10, language: entry.lang || null, lines: entry.lines,
      ...(entry.d ? { summary: entry.d } : {}), matched: [...item.why],
      symbols: [...item.symbols].slice(0, 5).map(text => { const [name, kind, line] = text.split('|'); return { name, kind, line: Number(line) } }),
    }))
    return { indexed: state.files.size, results }
  }
}

module.exports = { ProjectIndex, analyze, extractSymbols, extractImports, languageOf }
