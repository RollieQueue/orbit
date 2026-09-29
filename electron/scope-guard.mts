import fs from 'node:fs'
import path from 'node:path'

// Global memory and global skills are read by every project. What only makes sense inside one project has to
// stay in that project, so an agent's request to share something is checked for what pins the text to a
// workspace: its absolute path, its folder name, a relative path that exists in it, its git remote. The model
// picks the scope, but it cannot leak a project into the shared library by picking the wrong one.
// A false alarm costs little (the note stays in the project), a miss puts a project into every other one, so the
// checks lean towards raising the alarm. Paths with spaces in a segment are not recognised.
const GENERIC_NAMES = new Set(['project', 'projects', 'app', 'apps', 'src', 'code', 'repo', 'test', 'tests', 'work', 'main', 'home', 'docs', 'doc',
  'temp', 'tmp', 'demo', 'sandbox', 'workspace', 'desktop', 'documents', 'downloads', 'new-project', 'lib', 'bin', 'web', 'api', 'ui', 'sdk', 'dev',
  'env', 'pkg', 'cmd', 'www', 'git', 'npm', 'out', 'build', 'dist', 'core', 'util', 'utils', 'common', 'shared', 'tools', 'scripts', 'examples', 'sample', 'samples'])
// These exist in nearly every project, so naming them says nothing about which one.
const COMMON_ROOTS = new Set(['node_modules', '.git'])
const PATH_TOKEN = /(?:[\p{L}\p{N}_.@~-]+\/)+[\p{L}\p{N}_.@-]+/gu
const MAX_PATHS = 200
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (name: string): string => `(^|[^\\p{L}\\p{N}_-])${escape(name)}(?![\\p{L}\\p{N}_-])`
const usableName = (name: string): boolean => name.length >= 3 && !GENERIC_NAMES.has(name.toLowerCase())

// What ties a text to the workspace: its absolute path, its folder name, a file that exists in it, or its repository.
interface ProjectReference { kind: 'path' | 'name' | 'file' | 'remote'; value: string }

function gitConfig(root: string): string {
  let folder = root
  for (let depth = 0; depth < 6; depth++) {
    const dot = path.join(folder, '.git')
    try {
      const stat = fs.statSync(dot)
      if (stat.isDirectory()) return fs.readFileSync(path.join(dot, 'config'), 'utf8').slice(0, 65536)
      // A worktree or submodule: `.git` is a file pointing at its git directory, whose `commondir` holds the shared config.
      const gitdir = path.resolve(folder, fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1].trim() || '.')
      let common = gitdir
      try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()) } catch { /* not a linked worktree */ }
      return fs.readFileSync(path.join(common, 'config'), 'utf8').slice(0, 65536)
    } catch { /* look one folder up: a workspace can be inside a repository */ }
    const parent = path.dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return ''
}
// `github.com/owner/repo`, and the bare `owner/repo` people write.
function remotes(root: string): string[] {
  const found: string[] = []
  for (const match of gitConfig(root).matchAll(/^\s*url\s*=\s*(\S+)/gm)) {
    const core = match[1].replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '').replace(':', '/').replace(/\.git$/i, '').toLowerCase()
    if (core.length >= 8) found.push(core)
    const tail = core.split('/').slice(-2).join('/')
    if (tail.includes('/') && tail.length >= 8) found.push(tail)
  }
  return [...new Set(found)]
}

// Relative paths in `flat` (forward slashes) that exist in the workspace, however they are written: `src/a.js`, `./src/a.js`,
// `@/src/a.js`, followed by a full stop. A single bare file name such as package.json is too common to count.
function existingFiles(flat: string, root: string): string[] {
  const found = new Set<string>()
  for (const token of [...new Set(flat.match(PATH_TOKEN) || [])].slice(0, MAX_PATHS)) {
    if (/^(?:https?|www\.)/i.test(token)) continue
    const segments = token.replace(/[.,;:]+$/, '').split('/')
    while (segments.length && ['.', '@', '~'].includes(segments[0])) segments.shift()
    if (segments.length < 2 || segments.includes('..') || COMMON_ROOTS.has(segments[0].toLowerCase())) continue
    const candidate = segments.join('/')
    try { if (fs.existsSync(path.join(root, candidate))) found.add(candidate) } catch { /* unreadable: not evidence */ }
  }
  return [...found]
}

// A folder can be written as given, resolved through links, or (on Windows) in its long form instead of its 8.3 short form:
// text may use any of them, and a stored workspace key is always the long, lower-case one.
function spellings(workspace: string): string[] {
  const found = [path.resolve(workspace)]
  for (const resolve of [fs.realpathSync, fs.realpathSync.native]) {
    try { const real = resolve(workspace); if (!found.some(candidate => candidate.toLowerCase() === real.toLowerCase())) found.push(real) } catch { /* the folder may be gone */ }
  }
  return found
}

// Returns [{ kind: 'path' | 'name' | 'file' | 'remote', value }], at most `limit`; empty when nothing ties the text to the workspace.
function projectReferences(text: unknown, workspace: string | null | undefined, limit = 5): ProjectReference[] {
  const body = String(text ?? '')
  if (!workspace || !body.trim()) return []
  const hits: ProjectReference[] = []
  const add = (kind: ProjectReference['kind'], value: string): void => { if (hits.length < limit && !hits.some(hit => hit.value === value)) hits.push({ kind, value }) }
  const spelled = spellings(workspace), root = spelled.find(candidate => fs.existsSync(candidate)) || spelled[0]
  const flat = body.replace(/\\/g, '/')
  const lower = flat.toLowerCase()
  for (const candidate of spelled) if (lower.includes(candidate.replace(/\\/g, '/').toLowerCase())) add('path', candidate)
  for (const name of new Set(spelled.map(candidate => path.basename(candidate)))) if (usableName(name) && new RegExp(bounded(name), 'iu').test(body)) add('name', name)
  for (const file of existingFiles(flat, root)) add('file', file)
  for (const remote of remotes(root)) if (new RegExp(bounded(remote), 'iu').test(lower)) add('remote', remote)
  return hits
}

const describe = (hits: ReadonlyArray<ProjectReference>): string => hits.map(hit => `${hit.kind} ${hit.value}`).join(', ')

// Removes what names the workspace (its absolute path, the files that exist in it, its folder name, its repository)
// from text that has to stay shared, such as the evidence attached to a model assessment.
function scrub(text: unknown, workspace: string | null | undefined, { pathsOnly = false }: { pathsOnly?: boolean } = {}): string {
  let value = String(text ?? '')
  if (!workspace) return value
  const spelled = spellings(workspace), root = spelled.find(candidate => fs.existsSync(candidate)) || spelled[0]
  for (const candidate of spelled) {
    const parts = candidate.split(/[\\/]+/).filter(Boolean)
    if (parts.length) value = value.replace(new RegExp(`[\\\\/]*${parts.map(escape).join('[\\\\/]+')}`, 'gi'), '<project>')
  }
  if (pathsOnly) return value
  for (const file of existingFiles(value.replace(/<project>/g, ' ').replace(/\\/g, '/'), root)) {
    value = value.split(file).join('<file>').split(file.replace(/\//g, '\\')).join('<file>')
  }
  for (const name of new Set(spelled.map(candidate => path.basename(candidate)))) if (usableName(name)) value = value.replace(new RegExp(bounded(name), 'giu'), '$1<project>')
  for (const remote of remotes(root)) value = value.replace(new RegExp(bounded(remote), 'giu'), '$1<repo>')
  return value
}

export { projectReferences, describe, scrub, existingFiles }
export type { ProjectReference }
