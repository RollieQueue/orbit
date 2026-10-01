// Lines of code and spent tokens of a project over time, for the skill pages Orbit shows in the quota window
// (src/QuotaPanel.tsx sends them to a skill's quota-panel page). Lines come from git: for each commit of the first-parent
// history, the lines its code files gained minus the lines they lost, summed up, plus a last point for the working tree
// (uncommitted changes and new files). A folder without git is counted file by file, and each count is kept as a
// snapshot, so its history starts with the first look. Tokens are the input and output tokens of every run Orbit
// recorded for the workspace; they are kept in <userData>/project-stats.json, so a run whose record was pruned still counts.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { workspaceKey } from './storage.mts'

export interface StatPoint { at: number; value: number }
export interface ProjectStats {
  workspace: string
  // Lines of code after each commit (or count), oldest first; the last point is now.
  lines: StatPoint[]
  linesSource: 'git' | 'files' | 'none'
  // Tokens of each run (input + output) at the time it finished, or its last update while it works; oldest first.
  tokens: StatPoint[]
  updatedAt: number
}
interface CachedRun { ws: string; at: number; tokens: number; mtime: number }
interface Cache { runs: Record<string, CachedRun>; snapshots: Record<string, StatPoint[]> }

const STATS_FILE = 'project-stats.json'
const CODE = new Set([
  'js', 'cjs', 'mjs', 'jsx', 'ts', 'cts', 'mts', 'tsx', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less', 'html', 'htm',
  'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'groovy', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs',
  'vb', 'swift', 'm', 'mm', 'dart', 'lua', 'pl', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'elm', 'clj', 'sql', 'sh', 'bash', 'zsh', 'ps1',
  'psm1', 'bat', 'cmd', 'zig', 'nim', 'sol', 'glsl', 'hlsl', 'wgsl', 'proto', 'graphql', 'gql',
])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '.next', '.nuxt', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv'])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_POINTS = 4000
const SNAPSHOT_EVERY_MS = 6 * 3600_000

// A file of code: a known source extension, not minified, not under a dependency or build folder.
function isCode(file: string): boolean {
  const parts = file.replace(/\\/g, '/').split('/')
  const name = parts.pop() || ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || /\.min\.[a-z]+$/i.test(name) || parts.some(part => SKIP_DIRS.has(part.toLowerCase()))) return false
  return CODE.has(name.slice(dot + 1).toLowerCase())
}
async function countLines(file: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size === 0) return 0
    const data = await fs.promises.readFile(file)
    let lines = 0
    for (const byte of data) if (byte === 10) lines++
    return data[data.length - 1] === 10 ? lines : lines + 1
  } catch { return 0 }
}
const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: 60_000, maxBuffer: 512 * 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(String(stdout))))
// Lines a `--numstat` row adds to the code count: added minus removed, 0 for binary files and other files.
function numstatDelta(row: string): number {
  const match = /^(\d+)\t(\d+)\t(.+)$/.exec(row)
  return match && isCode(match[3]) ? Number(match[1]) - Number(match[2]) : 0
}

// The history is the same until HEAD moves, so it is computed once per HEAD.
const historyCache = new Map<string, { head: string; points: StatPoint[] }>()
async function gitLines(workspace: string): Promise<StatPoint[] | null> {
  let head: string
  try { head = (await git(workspace, ['rev-parse', 'HEAD'])).trim() } catch { return null }
  let points = historyCache.get(workspace)?.head === head ? historyCache.get(workspace)!.points : null
  if (!points) {
    const log = await git(workspace, ['log', '--first-parent', '-m', '--reverse', '--no-renames', '--numstat', '--format=@%ct', '--', '.'])
    points = []
    let total = 0, at = 0, open = false
    for (const row of log.split('\n')) {
      if (row.startsWith('@')) { if (open) points.push({ at, value: total }); at = Number(row.slice(1)) * 1000; open = true } else total += numstatDelta(row)
    }
    if (open) points.push({ at, value: total })
    historyCache.set(workspace, { head, points })
  }
  let now = points.length ? points[points.length - 1].value : 0
  try {
    for (const row of (await git(workspace, ['diff', '--numstat', '--no-renames', 'HEAD', '--', '.'])).split('\n')) now += numstatDelta(row)
    const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => file && isCode(file)).slice(0, MAX_FILES)
    for (const file of untracked) now += await countLines(path.join(workspace, file))
  } catch { /* the committed history still holds */ }
  return [...points, { at: Date.now(), value: Math.max(0, now) }]
}

// Without git: every code file under the folder, skipping dependency, build and hidden folders.
async function folderLines(root: string): Promise<number> {
  let total = 0, files = 0
  const queue = [root]
  while (queue.length && files < MAX_FILES) {
    const dir = queue.shift()!
    let entries: fs.Dirent[] = []
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase())) queue.push(full) } else if (entry.isFile() && isCode(entry.name) && files++ < MAX_FILES) total += await countLines(full)
    }
  }
  return total
}

function readCache(file: string): Cache {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Cache>
    return { runs: data.runs && typeof data.runs === 'object' ? data.runs : {}, snapshots: data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {} }
  } catch { return { runs: {}, snapshots: {} } }
}
function writeCache(file: string, cache: Cache) {
  try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(cache)); fs.renameSync(`${file}.tmp`, file) } catch { /* next call tries again */ }
}

// Reads the run records that changed since the last call (by mtime) into the cache; records that are gone stay there.
async function scanRuns(userData: string, cache: Cache): Promise<boolean> {
  const dir = path.join(userData, 'run-history')
  let names: string[] = []
  try { names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.json')) } catch { return false }
  let changed = false
  for (const name of names) {
    const runId = name.slice(0, -5), file = path.join(dir, name)
    let mtime = 0
    try { mtime = (await fs.promises.stat(file)).mtimeMs } catch { continue }
    if (cache.runs[runId]?.mtime === mtime) continue
    try {
      const run = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { workspace?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown }; startedAt?: string; finishedAt?: string; updatedAt?: string }
      const at = Date.parse(run.finishedAt || run.updatedAt || run.startedAt || '')
      if (!Number.isFinite(at)) continue
      const tokens = (Number(run.usage?.inputTokens) || 0) + (Number(run.usage?.outputTokens) || 0)
      cache.runs[runId] = { ws: workspaceKey(run.workspace), at, tokens, mtime }
      changed = true
    } catch { /* a record being written: read it next time */ }
  }
  return changed
}

// Keeps at most MAX_POINTS points: the last one of each day when there are more.
function thin(points: StatPoint[]): StatPoint[] {
  if (points.length <= MAX_POINTS) return points
  const days = new Map<number, StatPoint>()
  for (const point of points) days.set(Math.floor(point.at / 86_400_000), point)
  return [...days.values()]
}

let queue: Promise<unknown> = Promise.resolve()
// One call at a time, so two windows asking at once do not scan the run records twice or lose a cache write.
export function projectStats(userData: string, workspace: string): Promise<ProjectStats> {
  const next = queue.then(() => collect(userData, workspace))
  queue = next.catch(() => undefined)
  return next
}

async function collect(userData: string, workspace: string): Promise<ProjectStats> {
  const key = workspaceKey(workspace)
  const file = path.join(userData, STATS_FILE)
  const cache = readCache(file)
  let changed = await scanRuns(userData, cache)
  let lines: StatPoint[] = [], linesSource: ProjectStats['linesSource'] = 'none'
  if (key && fs.existsSync(workspace)) {
    const history = await gitLines(workspace).catch(() => null)
    if (history) { lines = history; linesSource = 'git' } else {
      const snapshots = cache.snapshots[key] ?? []
      const value = await folderLines(workspace), last = snapshots[snapshots.length - 1]
      if (!last || last.value !== value || Date.now() - last.at > SNAPSHOT_EVERY_MS) { cache.snapshots[key] = [...snapshots, { at: Date.now(), value }].slice(-MAX_POINTS); changed = true }
      lines = [...cache.snapshots[key]!]
      if (lines[lines.length - 1].at < Date.now()) lines.push({ at: Date.now(), value })
      linesSource = 'files'
    }
  }
  if (changed) writeCache(file, cache)
  const tokens = Object.values(cache.runs).filter(run => key && run.ws === key && run.tokens > 0).map(run => ({ at: run.at, value: run.tokens })).sort((a, b) => a.at - b.at)
  return { workspace, lines: thin(lines), linesSource, tokens, updatedAt: Date.now() }
}

export { isCode, numstatDelta }
