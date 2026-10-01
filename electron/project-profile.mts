import fs from 'node:fs'
import path from 'node:path'
import { redact } from './storage.mts'

// How a project is built, tested, linted and run, read from the manifests at its root (plus one level of the usual
// monorepo folders) so that an agent in ANY project knows what to run to check its work. No model and no tree walk:
// small files at known places only, and the result is cached while those files and the root listing stay the same.

type Purpose = 'install' | 'build' | 'test' | 'lint' | 'typecheck' | 'format' | 'run' | 'check'
interface ProjectProfile {
  ecosystems: string[]
  // Best guess per purpose as "<command> (<file it comes from>)". `check` is the project's own all-in-one gate (verify, ci…).
  commands: Partial<Record<Purpose, string>>
  // What the project's CI runs, as written there.
  ci: string[]
  notes: string[]
}
interface ProfileOptions { platform?: NodeJS.Platform }

// A command, the file it comes from and the ecosystem that found it.
interface Command { cmd: string; src: string; eco: string }
type Commands = Partial<Record<Purpose, Command>>
// What one detector found: `explicit` commands are the project's own (scripts, tasks, targets), `guess`ed ones follow
// from its tooling. Explicit beats a guess, and among equals the earlier detector wins.
interface Found { ecosystem: string; explicit: Commands; guess: Commands; notes: string[] }

const PROFILE_CHARS = 1200
const MAX_READ = 256 * 1024
const CI_COMMANDS = 8
const CI_FILES = 6
const ORDER: Purpose[] = ['install', 'build', 'test', 'lint', 'typecheck', 'format', 'run', 'check']
const MONOREPO_FOLDERS = ['packages', 'apps', 'crates', 'libs', 'services', 'modules', 'projects']
const CHILDREN_PER_FOLDER = 12
const CHILDREN_TOTAL = 24

// The rows of a text; a row is cut at ROW_CHARS, which bounds what the line patterns below can cost on a file of one huge line.
const ROW_CHARS = 1000
const lines = (text: string): string[] => text.split(/\r?\n/).map(row => row.length > ROW_CHARS ? row.slice(0, ROW_CHARS) : row)
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text
const unquote = (text: string): string => text.replace(/^(["'])(.*)\1$/, '$2')
// A row without its `# comment`. A `\s+#.*$` pattern does this too, but it is quadratic on a row of blanks.
const uncomment = (row: string): string => { const at = row.search(/\s#/); return at < 0 ? row : row.slice(0, at) }
// The names a project gives its scripts, tasks and targets go into commands as written, so only plain ones count: a name
// that is a sentence (a quoted YAML or TOML key can be anything) is text for the model to obey, not a name.
const NAME = /^[\w:.@/+-]{1,48}$/
const isName = (name: string): boolean => NAME.test(name)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

// ---- Small readers: JSON, TOML and YAML by line patterns, no dependencies ------------------------------------------
// JSON with comments and trailing commas (deno.jsonc) as plain JSON; strings stay untouched.
function withoutComments(text: string): string {
  let out = '', index = 0
  while (index < text.length) {
    const char = text[index], next = text[index + 1]
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      out += text.slice(index, end + 1); index = end + 1
    } else if (char === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index++ }
    else if (char === '/' && next === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2 }
    else { out += char; index++ }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
// The object a manifest holds, {} for anything else (a broken file costs the profile one source, never an exception).
function parseJson(text: string): Record<string, unknown> {
  for (const source of [text, withoutComments(text)]) {
    try { const value: unknown = JSON.parse(source); return isRecord(value) ? value : {} } catch { /* the tolerant reading is next */ }
  }
  return {}
}
// A TOML file as { section → its rows }; only headers and `key = value` rows matter here.
function tomlSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>([['', []]])
  let rows = sections.get('')!
  for (const row of lines(text)) {
    // `[ name ]` and `[[name]]`; the name is trimmed after the match, so that no part of the pattern can split a run of blanks two ways.
    const header = row.match(/^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/)?.[1].trim()
    if (header) { rows = sections.get(header) ?? []; sections.set(header, rows) }
    else rows.push(row)
  }
  return sections
}
const TOML_KEY = /^\s*(?:"([^"]+)"|'([^']+)'|([\w.:-]+))\s*=/
// The task names a TOML section defines, as `name = …` rows or as `[base.name]` sub-tables.
function tomlTasks(toml: Map<string, string[]>, base: string): string[] {
  const names: string[] = []
  for (const [section, rows] of toml) {
    if (section === base) { for (const row of rows) { const key = row.match(TOML_KEY); if (key) names.push(key[1] ?? key[2] ?? key[3]) } }
    else if (section.startsWith(`${base}.`)) names.push(section.slice(base.length + 1).split('.')[0])
  }
  return names
}
// The quoted entries of every `members = [...]` list in the text of a TOML section. The closing bracket is looked up from
// the opening one onward and the search goes on after it: a `[^\]]*` pattern would read to the end of the file for each
// `members = [` that is never closed.
function tomlMembers(text: string): string[] {
  const names: string[] = [], open = /members\s*=\s*\[/g
  for (let match = open.exec(text); match; match = open.exec(text)) {
    const end = text.indexOf(']', open.lastIndex)
    if (end < 0) break
    for (const item of text.slice(open.lastIndex, end).matchAll(/["']([^"']+)["']/g)) names.push(item[1])
    open.lastIndex = end + 1
  }
  return names
}
// The keys one level under a top-level YAML key (compose services, Taskfile tasks), read by indentation.
function yamlKeys(text: string, key: string): string[] {
  const rows = lines(text), start = rows.findIndex(row => uncomment(row).trimEnd() === `${key}:`)
  const names: string[] = []
  let indent = 0
  for (const row of rows.slice(start < 0 ? rows.length : start + 1)) {
    if (!row.trim() || row.trimStart().startsWith('#')) continue
    const lead = row.length - row.trimStart().length
    if (lead === 0) break
    indent ||= lead
    const name = lead === indent ? row.match(/^\s*(?:"([^"]+)"|'([^']+)'|([\w.-]+(?::[\w.-]+)*))\s*:(?:\s|$)/) : null
    const found = name && (name[1] ?? name[2] ?? name[3])
    if (found && isName(found)) names.push(found)
  }
  return names
}
// The `- item` rows under a top-level YAML key (pnpm-workspace.yaml packages).
function yamlItems(text: string, key: string): string[] {
  const rows = lines(text), start = rows.findIndex(row => row.trimEnd() === `${key}:`)
  const items: string[] = []
  for (const row of rows.slice(start < 0 ? rows.length : start + 1)) {
    if (!row.trim() || row.trimStart().startsWith('#')) continue
    const item = row.match(/^\s*-\s+(.+)$/)
    if (item) items.push(unquote(uncomment(item[1]).trim())); else if (!/^\s/.test(row)) break
  }
  return items
}

// ---- What a detector may look at ------------------------------------------------------------------------------------
// Everything it reads goes through here: one level of the root listing, small regular files (never links, which could
// lead out of the workspace) and a few subfolders. Each path touched leaves a stamp, which is what the cache compares.
interface Probe {
  platform: NodeJS.Platform
  // The root entry called `name` in any letter case, as spelled on disk.
  has(name: string): string | undefined
  // Root entries (files and folders) whose name matches, sorted.
  match(pattern: RegExp): string[]
  dir(name: string): boolean
  exists(rel: string): boolean
  read(rel: string): string
  // The text of a root file by name in any letter case, '' when absent.
  text(name: string): string
  list(rel: string): fs.Dirent[]
}
function look(workspace: string, rel: string): fs.Stats | null {
  try { const stat = fs.lstatSync(path.join(workspace, rel)); return stat.isSymbolicLink() ? null : stat }
  catch { return null }
}
const stampOf = (stat: fs.Stats | null): string => !stat ? '-' : stat.isDirectory() ? `d${stat.mtimeMs}` : `f${stat.mtimeMs}:${stat.size}`

function makeProbe(workspace: string, listing: fs.Dirent[], platform: NodeJS.Platform): { probe: Probe; stamps: Map<string, string> } {
  const stamps = new Map<string, string>(), texts = new Map<string, string>()
  // Links are invisible: a linked folder could lead out of the workspace, and so could everything read below it.
  const entries = listing.filter(entry => !entry.isSymbolicLink())
  const byName = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]))
  const touch = (rel: string): fs.Stats | null => { const stat = look(workspace, rel); stamps.set(rel, stampOf(stat)); return stat }
  const probe: Probe = {
    platform,
    has: name => byName.get(name.toLowerCase())?.name,
    match: pattern => entries.filter(entry => pattern.test(entry.name)).map(entry => entry.name).sort(),
    dir: name => byName.get(name.toLowerCase())?.isDirectory() === true,
    exists: rel => touch(rel) !== null,
    read: rel => {
      const known = texts.get(rel)
      if (known !== undefined) return known
      const stat = touch(rel)
      let text = ''
      if (stat?.isFile() && stat.size <= MAX_READ) { try { text = fs.readFileSync(path.join(workspace, rel), 'utf8').replace(/^\uFEFF/, '') } catch { /* unreadable reads as absent */ } }
      texts.set(rel, text)
      return text
    },
    text: name => { const actual = byName.get(name.toLowerCase())?.name; return actual ? probe.read(actual) : '' },
    list: rel => {
      if (!touch(rel)?.isDirectory()) return []
      try { return fs.readdirSync(path.join(workspace, rel), { withFileTypes: true }) } catch { return [] }
    },
  }
  return { probe, stamps }
}

// ---- Collecting commands --------------------------------------------------------------------------------------------
function collector(ecosystem: string) {
  const found: Found = { ecosystem, explicit: {}, guess: {}, notes: [] }
  const add = (kind: 'explicit' | 'guess') => (purpose: Purpose, cmd: string, src: string): void => { found[kind][purpose] ??= { cmd: clip(cmd, 80), src: clip(src, 40), eco: ecosystem } }
  return { found, explicit: add('explicit'), guess: add('guess'), note: (text: string): void => { found.notes.push(text) } }
}
type Collector = ReturnType<typeof collector>

// The names projects give their scripts, tasks and targets for each purpose, most canonical first.
const NAMES: Record<Purpose, string[]> = {
  install: ['setup', 'bootstrap', 'deps', 'dependencies', 'install-deps'],
  build: ['build', 'compile', 'dist', 'package'],
  test: ['test', 'tests', 'test:unit', 'test-unit', 'unit', 'test:ci', 'spec', 'specs'],
  lint: ['lint', 'lint:check', 'check:lint', 'eslint', 'flake8', 'pylint', 'ruff', 'clippy'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'check:types', 'mypy', 'pyright'],
  format: ['format', 'fmt', 'prettier'],
  run: ['dev', 'start', 'serve', 'run', 'watch'],
  check: ['verify', 'check', 'ci', 'validate', 'presubmit', 'checks', 'qa'],
}
const PREFIXED: Partial<Record<Purpose, RegExp>> = { test: /^test[:_-]/, lint: /^lint[:_-]/ }
// Variants that change files, wait, or need more than the plain command.
const NOISE = /fix|watch|write|e2e|integration|coverage|debug|update|snapshot|docker|deploy|publish|clean/i
function pick(purpose: Purpose, names: string[]): string | undefined {
  return NAMES[purpose].find(name => names.includes(name)) ?? names.find(name => PREFIXED[purpose]?.test(name) && !NOISE.test(name))
}
// The scripts, tasks or targets a project names itself, one per purpose. `install` is skipped unless asked for: a
// script called install (npm) or a target called install (make) does not install dependencies.
function fromNames(c: Collector, all: string[], command: (name: string) => string, src: string, skip: Purpose[] = ['install']): void {
  const names = all.filter(isName)
  for (const purpose of ORDER) {
    const name = skip.includes(purpose) ? undefined : pick(purpose, names)
    if (name) c.explicit(purpose, command(name), src)
  }
}
// gradlew / mvnw as the platform runs them, or the global tool when the project has no wrapper.
function wrapper(probe: Probe, unix: string, windows: string, global: string): string {
  if (probe.platform === 'win32') return probe.has(windows) ? windows : global
  return probe.has(unix) ? `./${unix}` : global
}

// ---- Detectors: one per ecosystem, each reads a few manifests of the root ------------------------------------------
const NODE_LOCKS: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']]
const NODE_EXEC: Record<string, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }

function nodeProject(probe: Probe): Found | null {
  const file = probe.has('package.json')
  if (!file) return null
  const c = collector('node'), manifest = parseJson(probe.read(file))
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
  // npm's placeholder (`echo "Error: no test specified" && exit 1`) is no test command.
  const names = Object.keys(scripts).filter(name => typeof scripts[name] === 'string' && !(name === 'test' && /no test specified/i.test(String(scripts[name]))))
  const lock = NODE_LOCKS.find(([name]) => probe.has(name))
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : ''
  const manager = Object.keys(NODE_EXEC).find(name => name === declared) ?? lock?.[1] ?? (probe.has('pnpm-workspace.yaml') ? 'pnpm' : 'npm')
  c.guess('install', `${manager} install`, lock?.[0] ?? file)
  // `bun test` is Bun's own runner, not the script, so bun always goes through `run`.
  const run = (name: string): string => manager === 'npm' ? (name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`) : manager === 'bun' ? `bun run ${name}` : `${manager} ${name}`
  fromNames(c, names, run, file)
  const dependencies = { ...(isRecord(manifest.dependencies) ? manifest.dependencies : {}), ...(isRecord(manifest.devDependencies) ? manifest.devDependencies : {}) }
  if ('typescript' in dependencies && probe.has('tsconfig.json')) c.guess('typecheck', `${NODE_EXEC[manager]} tsc --noEmit`, 'tsconfig.json')
  const globs = [...strings(manifest.workspaces), ...(isRecord(manifest.workspaces) ? strings(manifest.workspaces.packages) : []), ...yamlItems(probe.text('pnpm-workspace.yaml'), 'packages')]
  const tools = ['turbo.json', 'nx.json', 'lerna.json'].filter(name => probe.has(name)).map(name => name.split('.')[0])
  if (globs.length || tools.length) c.note(`monorepo: ${[...new Set([...globs, ...tools])].slice(0, 5).join(', ')}`)
  return c.found
}

function denoProject(probe: Probe): Found | null {
  const file = probe.has('deno.json') ?? probe.has('deno.jsonc')
  if (!file) return null
  const c = collector('deno'), manifest = parseJson(probe.read(file))
  fromNames(c, isRecord(manifest.tasks) ? Object.keys(manifest.tasks) : [], name => `deno task ${name}`, file)
  c.guess('test', 'deno test', file); c.guess('lint', 'deno lint', file); c.guess('format', 'deno fmt', file)
  return c.found
}

function pythonProject(probe: Probe): Found | null {
  const requirements = probe.match(/^requirements([-_.][\w.-]*)?\.txt$/i)
  const anchor = ['pyproject.toml', 'setup.cfg', 'setup.py', 'Pipfile', 'tox.ini', 'pytest.ini', 'noxfile.py', 'manage.py'].map(name => probe.has(name)).find(Boolean) ?? requirements[0]
  if (!anchor) return null
  const c = collector('python')
  const pyproject = probe.has('pyproject.toml') ?? 'pyproject.toml', toml = tomlSections(probe.text('pyproject.toml'))
  const documents = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'Pipfile', ...requirements.slice(0, 3)].map((name): [string, string] => [probe.has(name) ?? name, probe.text(name)])
  const under = (prefix: string): boolean => [...toml.keys()].some(key => key === prefix || key.startsWith(`${prefix}.`))
  // The file that shows a tool in use: pyproject.toml configures it, its own config file exists, a section of setup.cfg or
  // tox.ini is its, or a dependency list names it.
  const used = (header: string, name: string, files: string[] = [], section?: RegExp): string | undefined => {
    if (under(header)) return pyproject
    const own = files.map(file => probe.has(file)).find(Boolean)
    if (own) return own
    const dependency = new RegExp(`(?:["']|^[ \\t]*)${name}(?![\\w-])`, 'im')
    return documents.find(([, text]) => section?.test(text) || dependency.test(text))?.[0]
  }
  const where = (...files: string[]): string => files.map(file => probe.has(file)).find(Boolean) ?? anchor
  const manager = probe.has('uv.lock') || under('tool.uv') ? 'uv' : probe.has('poetry.lock') || under('tool.poetry') ? 'poetry' : probe.has('pdm.lock') || under('tool.pdm') ? 'pdm' : probe.has('Pipfile') ? 'pipenv' : ''
  const prefix = manager ? `${manager} run ` : ''
  // Tasks the project defines itself: pdm, hatch, poe and taskipy scripts, Pipfile scripts.
  const tasks: [string[], (name: string) => string][] = [
    [tomlTasks(toml, 'tool.pdm.scripts'), name => `pdm run ${name}`], [tomlTasks(toml, 'tool.hatch.envs.default.scripts'), name => `hatch run ${name}`],
    [tomlTasks(toml, 'tool.poe.tasks'), name => `poe ${name}`], [tomlTasks(toml, 'tool.taskipy.tasks'), name => `task ${name}`],
    [tomlTasks(tomlSections(probe.text('Pipfile')), 'scripts'), name => `pipenv run ${name}`],
  ]
  for (const [names, command] of tasks) fromNames(c, names, command, where('pyproject.toml', 'Pipfile'))
  if (manager === 'uv') c.guess('install', 'uv sync', where('uv.lock', 'pyproject.toml'))
  else if (manager === 'poetry') c.guess('install', 'poetry install', where('poetry.lock', 'pyproject.toml'))
  else if (manager === 'pdm') c.guess('install', 'pdm install', where('pdm.lock', 'pyproject.toml'))
  else if (manager === 'pipenv') c.guess('install', 'pipenv install --dev', 'Pipfile')
  else if (toml.has('project') || probe.has('setup.py') || probe.has('setup.cfg')) c.guess('install', 'pip install -e .', where('pyproject.toml', 'setup.py', 'setup.cfg'))
  else if (requirements.length) c.guess('install', `pip install -r ${requirements.find(name => name.toLowerCase() === 'requirements.txt') ?? requirements[0]}`, requirements.find(name => name.toLowerCase() === 'requirements.txt') ?? requirements[0])
  if (toml.has('build-system')) c.guess('build', manager === 'uv' || manager === 'poetry' || manager === 'pdm' ? `${manager} build` : under('tool.hatch') ? 'hatch build' : 'python -m build', 'pyproject.toml')
  const testDir = ['tests', 'test'].find(name => probe.dir(name))
  // Section patterns look at a whole file and so stay on one row: after `^` under the m flag a `\s*` would run over every blank line that follows.
  const pytest = used('tool.pytest', 'pytest', ['pytest.ini', 'conftest.py'], /^[ \t]*\[(?:tool:)?pytest\]/m)
  if (pytest) c.guess('test', `${prefix}pytest`, pytest)
  else if (probe.has('manage.py')) c.guess('test', 'python manage.py test', 'manage.py')
  else if (testDir) c.guess('test', `python -m unittest discover -s ${testDir}`, testDir)
  const ruff = used('tool.ruff', 'ruff', ['ruff.toml', '.ruff.toml']), flake8 = used('tool.flake8', 'flake8', ['.flake8'], /^[ \t]*\[flake8\]/m), pylint = used('tool.pylint', 'pylint', ['.pylintrc', 'pylintrc'])
  if (ruff) c.guess('lint', `${prefix}ruff check .`, ruff)
  else if (flake8) c.guess('lint', `${prefix}flake8`, flake8)
  else if (pylint) c.guess('lint', `${prefix}pylint --recursive=y .`, pylint)
  const mypy = used('tool.mypy', 'mypy', ['mypy.ini', '.mypy.ini'], /^[ \t]*\[mypy\]/m), pyright = used('tool.pyright', 'pyright', ['pyrightconfig.json']), black = used('tool.black', 'black')
  if (mypy) c.guess('typecheck', `${prefix}mypy .`, mypy)
  else if (pyright) c.guess('typecheck', `${prefix}pyright`, pyright)
  if (black) c.guess('format', `${prefix}black .`, black)
  else if (ruff) c.guess('format', `${prefix}ruff format .`, ruff)
  if (probe.has('manage.py')) c.guess('run', 'python manage.py runserver', 'manage.py')
  if (probe.has('tox.ini')) c.guess('check', 'tox', 'tox.ini'); else if (probe.has('noxfile.py')) c.guess('check', 'nox', 'noxfile.py')
  return c.found
}

function rustProject(probe: Probe): Found | null {
  const file = probe.has('Cargo.toml')
  if (!file) return null
  const c = collector('rust'), toml = tomlSections(probe.read(file))
  const workspace = toml.has('workspace'), all = workspace ? ' --workspace' : ''
  c.guess('build', `cargo build${all}`, file); c.guess('test', `cargo test${all}`, file); c.guess('lint', `cargo clippy${all}`, file)
  c.guess('typecheck', `cargo check${all}`, file); c.guess('format', workspace ? 'cargo fmt --all' : 'cargo fmt', file)
  if (!workspace && (toml.has('bin') || probe.exists('src/main.rs'))) c.guess('run', 'cargo run', file)
  const members = tomlMembers((toml.get('workspace') ?? []).join('\n'))
  if (members.length) c.note(`cargo workspace: ${members.slice(0, 4).join(', ')}${members.length > 4 ? ` +${members.length - 4}` : ''}`)
  return c.found
}

function goProject(probe: Probe): Found | null {
  const file = probe.has('go.mod')
  if (!file) return null
  const c = collector('go')
  c.guess('install', 'go mod download', file); c.guess('build', 'go build ./...', file); c.guess('test', 'go test ./...', file)
  const golangci = probe.match(/^\.golangci\.(?:ya?ml|toml|json)$/)[0]
  if (golangci) c.guess('lint', 'golangci-lint run', golangci)
  c.guess('lint', 'go vet ./...', file); c.guess('format', 'gofmt -l .', file)
  if (probe.has('main.go')) c.guess('run', 'go run .', 'main.go')
  if (probe.has('go.work')) c.note('go workspace: go.work')
  return c.found
}

function jvmProject(probe: Probe): Found | null {
  const gradle = probe.has('build.gradle.kts') ?? probe.has('build.gradle') ?? probe.has('settings.gradle.kts') ?? probe.has('settings.gradle')
  const pom = probe.has('pom.xml')
  const build = gradle ?? pom
  if (!build) return null
  const text = probe.read(build)
  const c = collector(/kotlin/i.test(text) ? 'kotlin' : 'java')
  if (gradle) {
    const tool = wrapper(probe, 'gradlew', 'gradlew.bat', 'gradle'), android = /com\.android\./.test(text)
    c.guess('build', `${tool} ${android ? 'assembleDebug' : 'build'}`, build); c.guess('test', `${tool} ${android ? 'testDebugUnitTest' : 'test'}`, build); c.guess('check', `${tool} check`, build)
    if (/spotless/i.test(text)) { c.guess('lint', `${tool} spotlessCheck`, build); c.guess('format', `${tool} spotlessApply`, build) }
    if (/detekt/i.test(text)) c.guess('lint', `${tool} detekt`, build)
    if (/ktlint/i.test(text)) { c.guess('lint', `${tool} ktlintCheck`, build); c.guess('format', `${tool} ktlintFormat`, build) }
    if (/checkstyle/i.test(text)) c.guess('lint', `${tool} checkstyleMain`, build)
    if (android) c.guess('lint', `${tool} lint`, build)
    if (/org\.springframework\.boot/.test(text)) c.guess('run', `${tool} bootRun`, build)
    else if (/["']application["']|^[ \t]*application[ \t]*(?:\{|$)/m.test(text)) c.guess('run', `${tool} run`, build)
    const settings = probe.text('settings.gradle.kts') || probe.text('settings.gradle')
    // `include(` may be followed by a line break (the Kotlin DSL list), `include` alone only by its arguments; each blank run has exactly one pattern to belong to.
    const modules = [...settings.matchAll(/include[ \t]*(?:\(\s*)?((?:["'][^"']+["']\s*(?:,\s*)?)+)/g)].flatMap(match => [...match[1].matchAll(/["']:?([^"']+)["']/g)].map(item => item[1]))
    if (modules.length) c.note(`gradle modules: ${modules.slice(0, 6).join(', ')}${modules.length > 6 ? ` +${modules.length - 6}` : ''}`)
  } else {
    const tool = wrapper(probe, 'mvnw', 'mvnw.cmd', 'mvn')
    c.guess('build', `${tool} package -DskipTests`, build); c.guess('test', `${tool} test`, build); c.guess('check', `${tool} verify`, build)
    if (/spotless/i.test(text)) { c.guess('lint', `${tool} spotless:check`, build); c.guess('format', `${tool} spotless:apply`, build) }
    if (/checkstyle/i.test(text)) c.guess('lint', `${tool} checkstyle:check`, build)
    if (/spring-boot/i.test(text)) c.guess('run', `${tool} spring-boot:run`, build)
  }
  return c.found
}

function dotnetProject(probe: Probe): Found | null {
  const solutions = probe.match(/\.(?:sln|slnx)$/i), projects = probe.match(/\.(?:cs|fs|vb)proj$/i)
  const targets = [...solutions, ...projects]
  if (!targets.length) return null
  const c = collector('dotnet'), src = targets[0]
  // One project or solution file builds as is; with several, dotnet needs to be told which.
  const target = targets.length > 1 ? ` ${src}` : ''
  c.guess('install', `dotnet restore${target}`, src); c.guess('build', `dotnet build${target}`, src); c.guess('test', `dotnet test${target}`, src); c.guess('format', `dotnet format${target}`, src)
  const project = projects[0] ? probe.read(projects[0]) : ''
  if (/<OutputType>\s*(?:Win)?Exe\s*<|Sdk="Microsoft\.NET\.Sdk\.(?:Web|Worker)"/i.test(project)) c.guess('run', `dotnet run${solutions.length ? ` --project ${projects[0]}` : target}`, projects[0])
  return c.found
}

function rubyProject(probe: Probe): Found | null {
  const gemfile = probe.has('Gemfile'), rakefile = probe.has('Rakefile'), gemspec = probe.match(/\.gemspec$/i)[0]
  const anchor = gemfile ?? rakefile ?? gemspec
  if (!anchor) return null
  const c = collector('ruby'), text = gemfile ? probe.read(gemfile) : ''
  const bundle = gemfile ? 'bundle exec ' : '', rails = /^[ \t]*gem[ \t]+["']rails["']/m.test(text) && probe.exists('bin/rails')
  if (gemfile) c.guess('install', 'bundle install', gemfile)
  if (probe.has('.rspec') || probe.dir('spec') || /rspec/i.test(text)) c.guess('test', `${bundle}rspec`, probe.has('.rspec') ?? anchor)
  else if (rails && probe.dir('test')) c.guess('test', 'bin/rails test', 'bin/rails')
  else if (rakefile && probe.dir('test')) c.guess('test', `${bundle}rake test`, rakefile)
  if (probe.has('.rubocop.yml') || /rubocop/i.test(text)) c.guess('lint', `${bundle}rubocop`, probe.has('.rubocop.yml') ?? anchor)
  if (rails) c.guess('run', 'bin/rails server', 'bin/rails')
  if (rakefile) c.guess('check', `${bundle}rake`, rakefile)
  return c.found
}

function phpProject(probe: Probe): Found | null {
  const composer = probe.has('composer.json'), phpunit = probe.has('phpunit.xml') ?? probe.has('phpunit.xml.dist') ?? probe.has('phpunit.dist.xml')
  if (!composer && !phpunit) return null
  const c = collector('php'), manifest = composer ? parseJson(probe.read(composer)) : {}
  const dependencies = { ...(isRecord(manifest.require) ? manifest.require : {}), ...(isRecord(manifest['require-dev']) ? manifest['require-dev'] : {}) }
  const has = (name: string): boolean => name in dependencies
  if (composer) { fromNames(c, isRecord(manifest.scripts) ? Object.keys(manifest.scripts) : [], name => `composer run ${name}`, composer); c.guess('install', 'composer install', composer) }
  const laravel = probe.has('artisan')
  if (has('pestphp/pest')) c.guess('test', 'vendor/bin/pest', composer ?? 'composer.json')
  else if (laravel) c.guess('test', 'php artisan test', 'artisan')
  else if (phpunit || has('phpunit/phpunit')) c.guess('test', 'vendor/bin/phpunit', phpunit ?? composer ?? 'composer.json')
  if (has('laravel/pint')) { c.guess('lint', 'vendor/bin/pint --test', composer ?? 'composer.json'); c.guess('format', 'vendor/bin/pint', composer ?? 'composer.json') }
  const phpcs = probe.has('phpcs.xml') ?? probe.has('phpcs.xml.dist')
  if (phpcs || has('squizlabs/php_codesniffer')) { c.guess('lint', 'vendor/bin/phpcs', phpcs ?? 'composer.json'); c.guess('format', 'vendor/bin/phpcbf', phpcs ?? 'composer.json') }
  if (has('friendsofphp/php-cs-fixer')) { c.guess('lint', 'vendor/bin/php-cs-fixer fix --dry-run', 'composer.json'); c.guess('format', 'vendor/bin/php-cs-fixer fix', 'composer.json') }
  const phpstan = probe.has('phpstan.neon') ?? probe.has('phpstan.neon.dist'), psalm = probe.has('psalm.xml') ?? probe.has('psalm.xml.dist')
  if (phpstan || has('phpstan/phpstan')) c.guess('typecheck', 'vendor/bin/phpstan analyse', phpstan ?? 'composer.json')
  else if (psalm || has('vimeo/psalm')) c.guess('typecheck', 'vendor/bin/psalm', psalm ?? 'composer.json')
  if (laravel) c.guess('run', 'php artisan serve', 'artisan')
  return c.found
}

function cmakeProject(probe: Probe): Found | null {
  const file = probe.has('CMakeLists.txt')
  if (!file) return null
  const c = collector('cmake')
  // Configuring is the setup step; the build directory is `build`.
  c.guess('install', 'cmake -S . -B build', file); c.guess('build', 'cmake --build build', file)
  if (/\b(?:enable_testing|add_test|include\s*\(\s*CTest)\b/i.test(probe.read(file))) c.guess('test', 'ctest --test-dir build', file)
  if (probe.has('CMakePresets.json')) c.note('cmake presets: CMakePresets.json')
  return c.found
}

function elixirProject(probe: Probe): Found | null {
  const file = probe.has('mix.exs')
  if (!file) return null
  const c = collector('elixir'), text = probe.read(file)
  c.guess('install', 'mix deps.get', file); c.guess('build', 'mix compile', file); c.guess('test', 'mix test', file); c.guess('format', 'mix format', file)
  if (/:credo\b/.test(text)) c.guess('lint', 'mix credo', file)
  if (/:dialyxir\b/.test(text)) c.guess('typecheck', 'mix dialyzer', file)
  if (/:phoenix\b/.test(text)) c.guess('run', 'mix phx.server', file)
  return c.found
}

function dartProject(probe: Probe): Found | null {
  const file = probe.has('pubspec.yaml')
  if (!file) return null
  const flutter = /^[ \t]*flutter[ \t]*:|sdk:[ \t]*flutter/m.test(probe.read(file)), tool = flutter ? 'flutter' : 'dart'
  const c = collector(flutter ? 'flutter' : 'dart')
  c.guess('install', `${tool} pub get`, file); c.guess('test', `${tool} test`, file); c.guess('lint', `${tool} analyze`, file); c.guess('format', 'dart format .', file); c.guess('run', `${tool} run`, file)
  return c.found
}

function swiftProject(probe: Probe): Found | null {
  const file = probe.has('Package.swift')
  if (!file) return null
  const c = collector('swift')
  c.guess('build', 'swift build', file); c.guess('test', 'swift test', file); c.guess('run', 'swift run', file)
  if (probe.has('.swiftlint.yml')) c.guess('lint', 'swiftlint', '.swiftlint.yml')
  if (probe.has('.swiftformat')) c.guess('format', 'swiftformat .', '.swiftformat')
  return c.found
}

// Ecosystems that are a marker file and a fixed set of commands.
const SIMPLE: { file: RegExp; ecosystem: string; commands: Partial<Record<Purpose, string>> }[] = [
  { file: /^build\.sbt$/, ecosystem: 'scala', commands: { build: 'sbt compile', test: 'sbt test', run: 'sbt run' } },
  { file: /^stack\.yaml$/, ecosystem: 'haskell', commands: { build: 'stack build', test: 'stack test' } },
  { file: /^(?:cabal\.project|.+\.cabal)$/i, ecosystem: 'haskell', commands: { build: 'cabal build', test: 'cabal test', run: 'cabal run' } },
  { file: /^build\.zig$/, ecosystem: 'zig', commands: { build: 'zig build', test: 'zig build test', format: 'zig fmt .' } },
  { file: /^(?:MODULE\.bazel|WORKSPACE(?:\.bazel)?)$/, ecosystem: 'bazel', commands: { build: 'bazel build //...', test: 'bazel test //...' } },
  { file: /^meson\.build$/, ecosystem: 'meson', commands: { install: 'meson setup build', build: 'meson compile -C build', test: 'meson test -C build' } },
  { file: /^gleam\.toml$/, ecosystem: 'gleam', commands: { build: 'gleam build', test: 'gleam test', format: 'gleam format', run: 'gleam run' } },
  { file: /^dune-project$/, ecosystem: 'ocaml', commands: { build: 'dune build', test: 'dune test', format: 'dune fmt' } },
]
const simpleProject = (row: typeof SIMPLE[number]) => (probe: Probe): Found | null => {
  const file = probe.match(row.file)[0]
  if (!file) return null
  const c = collector(row.ecosystem)
  for (const purpose of ORDER) { const cmd = row.commands[purpose]; if (cmd) c.guess(purpose, cmd, file) }
  return c.found
}

// Targets of a Makefile: `name:` rows at the start of a line, not assignments (`:=`), not pattern rules.
function makeNames(text: string): string[] {
  return lines(text).flatMap(row => row.match(/^([A-Za-z0-9_][\w.-]*(?:[ \t]+[\w.-]+)*)[ \t]*:(?![:=])/)?.[1].split(/\s+/) ?? [])
}
function makeProject(probe: Probe): Found | null {
  const file = probe.has('Makefile') ?? probe.has('GNUmakefile')
  if (!file) return null
  const c = collector('make'), names = makeNames(probe.read(file))
  fromNames(c, names, name => `make ${name}`, file, [])
  if (names.includes('all')) c.explicit('build', 'make all', file)
  return c.found
}
function justProject(probe: Probe): Found | null {
  const file = probe.has('justfile') ?? probe.has('.justfile')
  if (!file) return null
  const c = collector('just')
  fromNames(c, lines(probe.read(file)).flatMap(row => row.match(/^@?([A-Za-z][\w-]*)(?:[ \t]+[^:\s][^:]*|[ \t]*):(?!=)/)?.[1] ?? []), name => `just ${name}`, file, [])
  return c.found
}
function taskProject(probe: Probe): Found | null {
  const file = probe.has('Taskfile.yml') ?? probe.has('Taskfile.yaml')
  if (!file) return null
  const c = collector('task')
  fromNames(c, yamlKeys(probe.read(file), 'tasks'), name => `task ${name}`, file, [])
  return c.found
}

function dockerProject(probe: Probe): Found | null {
  const dockerfile = probe.match(/^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/i)[0]
  const compose = probe.match(/^(?:docker-)?compose(?:\..+)?\.ya?ml$/i).sort((left, right) => left.length - right.length)[0]
  if (!dockerfile && !compose) return null
  const c = collector('docker')
  if (dockerfile) c.guess('build', 'docker build .', dockerfile)
  if (compose) {
    c.guess('run', 'docker compose up', compose)
    const services = yamlKeys(probe.read(compose), 'services')
    if (services.length) c.note(`compose services: ${services.slice(0, 6).join(', ')}${services.length > 6 ? ` +${services.length - 6}` : ''}`)
  }
  return c.found
}

// Language ecosystems first, then the task runners and Docker, so a language's own commands win ties.
const DETECTORS: ((probe: Probe) => Found | null)[] = [nodeProject, denoProject, pythonProject, rustProject, goProject, jvmProject, dotnetProject, rubyProject, phpProject, cmakeProject, elixirProject, dartProject, swiftProject, ...SIMPLE.map(simpleProject), makeProject, justProject, taskProject, dockerProject]

// ---- Monorepos: the usual folders, one level, bounded --------------------------------------------------------------
const CHILD_MANIFESTS: [RegExp, string][] = [
  [/^package\.json$/, 'node'], [/^deno\.jsonc?$/, 'deno'], [/^(?:pyproject\.toml|setup\.py|requirements\.txt|Pipfile)$/i, 'python'], [/^Cargo\.toml$/, 'rust'], [/^go\.mod$/, 'go'],
  [/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/, 'java'], [/\.(?:cs|fs|vb)proj$/i, 'dotnet'], [/^composer\.json$/, 'php'], [/^Gemfile$/, 'ruby'], [/^mix\.exs$/, 'elixir'], [/^pubspec\.yaml$/, 'dart'],
  [/^Package\.swift$/, 'swift'], [/^CMakeLists\.txt$/, 'cmake'],
]
// For each monorepo folder at the root, how many of its subfolders hold a manifest of each ecosystem.
function members(probe: Probe): { folder: string; counts: Map<string, number> }[] {
  const result: { folder: string; counts: Map<string, number> }[] = []
  let budget = CHILDREN_TOTAL
  for (const name of MONOREPO_FOLDERS) {
    const folder = probe.has(name)
    if (!folder || !probe.dir(folder) || budget <= 0) continue
    const counts = new Map<string, number>()
    const children = probe.list(folder).filter(entry => entry.isDirectory() && !/^[._]|^node_modules$/.test(entry.name)).map(entry => entry.name).sort().slice(0, Math.min(CHILDREN_PER_FOLDER, budget))
    for (const child of children) {
      budget--
      const inside = probe.list(`${folder}/${child}`).map(entry => entry.name)
      for (const ecosystem of new Set(CHILD_MANIFESTS.filter(([pattern]) => inside.some(entry => pattern.test(entry))).map(([, eco]) => eco))) counts.set(ecosystem, (counts.get(ecosystem) ?? 0) + 1)
    }
    if (counts.size) result.push({ folder, counts })
  }
  return result
}

// ---- CI: the checks a project's pipeline runs -----------------------------------------------------------------------
// The commands in a CI file, read by line patterns: `run:`, `script:` or `command:` with an inline value, a block scalar
// or a list. That covers GitHub Actions, GitLab CI, CircleCI, Azure Pipelines, Travis and Bitbucket.
function ciRows(text: string): string[] {
  // Blank rows say nothing here, and every key above a long run of them would walk the whole run again.
  const rows = lines(text).filter(row => row.trim()), found: string[] = []
  const lead = (row: string): number => row.length - row.trimStart().length
  for (let index = 0; index < rows.length; index++) {
    const key = rows[index].match(/^(\s*)(-\s+)?(?:run|script|command)\s*:(.*)$/)
    if (!key) continue
    // A block or a list belongs to the key, so it is indented past the key's own column (past the dash when one precedes it).
    const column = key[1].length + (key[2]?.length ?? 0), value = uncomment(key[3]).trim()
    if (value && !/^[|>][+-]?\d*$/.test(value)) { found.push(unquote(value)); continue }
    const block = value !== ''
    let pending = ''
    for (let next = index + 1; next < rows.length; next++) {
      const row = rows[next]
      const depth = lead(row), item = row.trimStart().startsWith('- ')
      if (depth < column || (depth === column && (block || !item))) break
      if (block) {
        const piece = row.trim()
        if (piece.endsWith('\\')) pending += `${piece.slice(0, -1).trim()} `
        else { found.push(pending + piece); pending = '' }
      } else if (item) found.push(unquote(uncomment(row.trimStart().slice(2)).trim()))
    }
    if (pending) found.push(pending.trim())
  }
  return found
}
const CI_CHECK = /\b(?:test|tests|pytest|unittest|jest|vitest|mocha|spec|specs|lint|eslint|flake8|pylint|ruff|mypy|pyright|clippy|vet|fmt|format|prettier|tsc|typecheck|type-check|check|verify|validate|build|compile|smoke|e2e|integration|coverage|ctest|rspec|rubocop|phpunit|phpstan|psalm|tox|nox|spotless|checkstyle|detekt|analyze|ci)\b/i
// Setup, publishing and shell plumbing: not checks.
const CI_SKIP = /^(?:(?:echo|mkdir|cp|mv|rm|ls|cat|export|source|set|exit|chmod|touch|printf|curl|wget|git|gh|sudo|apt|apt-get|brew|choco|rustup|corepack|nvm|if|fi|then|else|for|do|done|while|write-\w+|new-item)\b|\.\s|\[|\{|\}|\$env:|cd\s+[^&;|]*$)|^(?:npm|pnpm|yarn|bun)\s+(?:ci|i|install|add|publish|login|config)\b|^(?:python3?\s+-m\s+)?pip3?\s+install\b|^(?:bundle|composer)\s+install\b|^dotnet\s+(?:restore|nuget|workload)\b|^go\s+mod\s+download\b|^cargo\s+(?:install|login|publish)\b|^docker\s+(?:login|logout|push|pull|build|tag|buildx)\b/i
// Deploying, publishing and syncing are not checks either, however a pipeline spells them (`aws s3 sync build/ …`,
// `npx netlify deploy --prod`, `kubectl apply -f k8s/`): an agent that reads them as "what CI runs" would run them. A
// `release` that names a build configuration (`--release`, `-c Release`, `Configuration=Release`) is still a build.
const CI_DEPLOY = new RegExp([
  String.raw`(?<![A-Za-z])(?:re|pre|post)?(?:deploy|publish|upload|rollout)`,
  String.raw`(?<!\S)(?:sync|apply)(?!\S)`,
  String.raw`semantic-release|(?<![\w=-])(?<!(?:^|\s)-\S*\s)release\b`,
  String.raw`(?<![\w.-])(?:(?:gcloud|helm|terraform|kubectl|firebase|netlify|vercel|heroku|flyctl|rsync)|(?:aws|az|ssh|scp)(?=\s|$))`,
  String.raw`--prod\b`,
].join('|'), 'i')
// Secrets reach a CI file as the environment a command runs in (`PGPASSWORD=… pytest`) or as an option's value
// (`--token=…`). Assignments in front of a command are dropped; of the others, a value whose name sounds like a secret is
// masked the way `redact` masks, and so is the value after an option named like one (`--token abc`, not `--passWithNoTests src`).
const CI_ENVIRONMENT = /(^|[;&|(]\s*)(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/g
const CI_ASSIGNMENT = /(?<![\w.-])([\w.-]+)=(?:"[^"]*"|'[^']*'|\S*)/g
const CI_OPTION = /(?<![\w.-])(--?[\w.-]*(?:token|password|passwd|secret|api-?key))( +)(?!-)(?:"[^"]*"|'[^']*'|\S+)/gi
const SECRET_NAME = /token|key|secret|pass|auth/i
// The password of a URL (`postgres://user:secret@db/test`) is masked too; the user name and the host stay readable.
const CI_URL_PASSWORD = /(\b[a-z][\w+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi
const withoutSecrets = (command: string): string => command
  .replace(CI_URL_PASSWORD, '$1[redacted]@')
  .replace(CI_ENVIRONMENT, '$1')
  .replace(CI_ASSIGNMENT, (whole, name: string) => SECRET_NAME.test(name) ? `${name}=[redacted]` : whole)
  .replace(CI_OPTION, '$1$2[redacted]')
// A bare build says less about correctness than a test or a lint, so it comes after them.
const CI_BUILD_ONLY = /\b(?:build|compile)\b/i
const CI_STRONG = /\b(?:test|tests|lint|check|verify|typecheck|clippy|vet|spec|ci)\b/i
function ciProfile(probe: Probe): string[] {
  const workflows = probe.has('.github') ? probe.list('.github/workflows').filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name)).map(entry => entry.name).sort((left, right) => Number(/^(?:ci|test|tests|build|check|lint|verify|main|pr|pull)/i.test(right)) - Number(/^(?:ci|test|tests|build|check|lint|verify|main|pr|pull)/i.test(left)) || left.localeCompare(right)) : []
  const files = [...workflows.slice(0, CI_FILES).map(name => `.github/workflows/${name}`), ...['.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'].flatMap(name => probe.has(name) ?? []), ...(probe.has('.circleci') ? ['.circleci/config.yml'] : [])]
  const rows = files.flatMap(file => ciRows(probe.read(file)))
  // Jenkins: `sh 'command'` lines.
  if (probe.has('Jenkinsfile')) rows.push(...lines(probe.read(probe.has('Jenkinsfile')!)).flatMap(row => row.match(/^\s*(?:sh|bat|powershell|pwsh)[ \t]*(?:\([ \t]*)?(?:script[ \t]*:[ \t]*)?(["'])(.+?)\1/)?.[2] ?? []))
  const seen = new Set<string>(), kept: string[] = []
  for (const raw of rows) {
    // A trailing shell comment and the secrets a command might carry are not part of what to run.
    const line = redact(withoutSecrets(uncomment(raw).replace(/\s+/g, ' ').trim()))
    if (!line || line.startsWith('#') || CI_SKIP.test(line) || CI_DEPLOY.test(line) || !CI_CHECK.test(line) || seen.has(line)) continue
    seen.add(line); kept.push(clip(line, 80))
  }
  const weak = (line: string): boolean => CI_BUILD_ONLY.test(line) && !CI_STRONG.test(line)
  return [...kept.filter(line => !weak(line)), ...kept.filter(weak)].slice(0, CI_COMMANDS)
}

// ---- Putting it together --------------------------------------------------------------------------------------------
// The best command per purpose: the first explicit one, else the first guess. When another language ecosystem has a
// different command for build, test or lint, it is named in the notes (a frontend and a backend share a repository).
function choose(found: Found[]): { commands: ProjectProfile['commands']; also: string[] } {
  const commands: ProjectProfile['commands'] = {}, also: string[] = []
  const runners = new Set(['make', 'just', 'task', 'docker'])
  for (const purpose of ORDER) {
    const options: Command[] = [...found.flatMap(item => item.explicit[purpose] ?? []), ...found.flatMap(item => item.guess[purpose] ?? [])]
    const best = options[0]
    if (!best) continue
    commands[purpose] = `${best.cmd} (${best.src})`
    if ((purpose === 'build' || purpose === 'test' || purpose === 'lint') && !runners.has(best.eco)) {
      const other = options.find(option => option.eco !== best.eco && !runners.has(option.eco))
      if (other) also.push(`also ${purpose}: ${other.cmd} (${other.src})`)
    }
  }
  return { commands, also: also.slice(0, 3) }
}
function detect(probe: Probe): ProjectProfile {
  const found = DETECTORS.flatMap(detector => detector(probe) ?? [])
  const { commands, also } = choose(found)
  const own = found.map(item => item.ecosystem), folders = members(probe)
  const notes = [...also]
  if (found.length && !commands.test) notes.push('no test command detected')
  notes.push(...found.flatMap(item => item.notes))
  // A folder whose manifests are all of ecosystems the root already covers adds nothing the commands do not say.
  for (const { folder, counts } of folders) {
    const extra = [...counts].filter(([ecosystem]) => !own.includes(ecosystem)).map(([ecosystem, count]) => count > 1 ? `${ecosystem} x${count}` : ecosystem)
    if (extra.length) notes.push(`in ${folder}/*: ${extra.join(', ')}`)
  }
  return { ecosystems: [...new Set([...own, ...folders.flatMap(({ counts }) => [...counts.keys()])])], commands, ci: ciProfile(probe), notes }
}
// The serialized profile goes into every agent's prompt: it is cut down, least useful first, to `limit` characters.
function fit(profile: ProjectProfile, limit = PROFILE_CHARS): ProjectProfile {
  const size = (): number => JSON.stringify(profile).length
  const drop = (list: unknown[], keep: number): boolean => list.length > keep && list.pop() !== undefined
  const steps: (() => boolean)[] = [() => drop(profile.notes, 2), () => drop(profile.ci, 5), () => drop(profile.notes, 0), () => drop(profile.ci, 3), () => drop(profile.ecosystems, 6), () => drop(profile.ci, 0)]
  for (const step of steps) while (size() > limit && step());
  // Only commands are left to cut: shorten them, then give up the purposes agents need least.
  const commands = profile.commands
  for (const purpose of ORDER) { const text = commands[purpose]; if (text && size() > limit) commands[purpose] = clip(text, 48) }
  for (const purpose of ['format', 'run', 'typecheck', 'install', 'lint', 'check'] as const) if (size() > limit) delete commands[purpose]
  return profile
}

const hasProfile = (profile: ProjectProfile): boolean => profile.ecosystems.length > 0 || profile.ci.length > 0 || Object.keys(profile.commands).length > 0
function listRoot(workspace: string): fs.Dirent[] {
  try { return fs.readdirSync(workspace, { withFileTypes: true }) } catch { return [] }
}
function build(workspace: string, entries: fs.Dirent[], platform: NodeJS.Platform): { profile: ProjectProfile; stamps: [string, string][] } {
  const { probe, stamps } = makeProbe(workspace, entries, platform)
  return { profile: fit(detect(probe)), stamps: [...stamps] }
}

// Uncached: the profile of a folder as it is now.
function detectProfile(workspace: string, options: ProfileOptions = {}): ProjectProfile {
  return build(workspace, listRoot(workspace), options.platform ?? process.platform).profile
}

// Cached by what the detection looked at: the root listing and the stamp (modification time and size) of every path it
// touched. The overview is rebuilt for every agent turn and context_read, so an unchanged project costs a few stats.
// `entries` is the root listing when the caller has it already. The result is shared: callers must not change it.
interface Cached { listing: string; stamps: [string, string][]; profile: ProjectProfile }
const cache = new Map<string, Cached>()
const CACHE_LIMIT = 16
function projectProfile(workspace: string, entries?: fs.Dirent[], options: ProfileOptions = {}): ProjectProfile {
  const platform = options.platform ?? process.platform, listed = entries ?? listRoot(workspace)
  const key = `${platform}|${workspace}`, listing = listed.map(entry => `${entry.isDirectory() ? 'd' : 'f'}${entry.name}`).join('\n')
  const hit = cache.get(key)
  cache.delete(key)
  if (hit && hit.listing === listing && hit.stamps.every(([rel, stamp]) => stampOf(look(workspace, rel)) === stamp)) { cache.set(key, hit); return hit.profile }
  const { profile, stamps } = build(workspace, listed, platform)
  cache.set(key, { listing, stamps, profile })
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return profile
}
function clearProfileCache(): void { cache.clear() }

export { detectProfile, projectProfile, hasProfile, clearProfileCache, fit as fitProfile, PROFILE_CHARS }
export type { ProjectProfile, ProfileOptions, Purpose }
