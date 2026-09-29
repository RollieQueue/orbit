const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ProjectIndex, extractSymbols, extractImports } = require('../electron/project-index.cjs')

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-index-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  return root
}
const sample = {
  'src/auth/login.ts': "import { hash } from './crypto'\nimport type { User } from '../types'\n// Verifies a login attempt against the stored credentials\nexport async function verifyPassword(user: User, attempt: string) {\n  return hash(attempt) === user.hash\n}\nexport class SessionStore {\n  create(userId: string) { return userId }\n}\n",
  'src/auth/crypto.ts': 'export const hash = (value: string) => value.split("").reverse().join("")\n',
  'src/types.ts': 'export interface User { hash: string }\nexport type Role = "admin" | "guest"\n',
  'src/ui/Button.tsx': "import React from 'react'\nexport default function Button() { return null }\n",
  'docs/notes.md': '# Deployment notes\n\nHow the release pipeline publishes builds.\n',
}

test('symbols and imports are read from the languages a project is likely to contain', () => {
  const js = extractSymbols(['export async function load() {', 'class Store {', '  save(item) {', '  }', '}', 'const RETRIES = 3', 'const run = async (x) => x', 'module.exports = { load, Store }'], 'js')
  assert.deepEqual(js.map(([name, kind]) => `${kind}:${name}`), ['function:load', 'class:Store', 'method:save', 'const:RETRIES', 'function:run'], 'exports that repeat a definition are not listed twice')
  assert.deepEqual(extractSymbols(['def parse(x):', 'class Node:', '    def visit(self):'], 'py').map(([name, kind]) => `${kind}:${name}`), ['function:parse', 'class:Node', 'method:visit'])
  assert.deepEqual(extractSymbols(['func (s *Server) Start() error {', 'type Config struct {'], 'go').map(([name]) => name), ['Start', 'Config'])
  assert.deepEqual(extractSymbols(['# Title', 'text', '## Section'], 'md').map(([name]) => name), ['Title', 'Section'])
  assert.deepEqual(extractImports("import a from './a'\nimport './side'\nconst b = require('./b')\nconst c = await import('./c')\nexport { d } from './d'", 'ts').sort(), ['./a', './b', './c', './d', './side'])
})

test('search ranks paths, symbols and topics, and outline shows the dependency graph', async t => {
  const workspace = project(t, sample)
  const index = new ProjectIndex()
  const scan = await index.refresh(workspace)
  assert.equal(scan.total, 5)
  const hit = index.search(workspace, 'verify password')
  assert.equal(hit.results[0].path, 'src/auth/login.ts')
  assert.ok(hit.results[0].symbols.some(symbol => symbol.name === 'verifyPassword' && symbol.line === 4))
  assert.equal(index.search(workspace, 'Button').results[0].path, 'src/ui/Button.tsx')
  assert.equal(index.search(workspace, 'release pipeline').results[0].path, 'docs/notes.md')
  assert.equal(index.search(workspace, 'zzzunknownterm').results.length, 0)
  const outline = index.outline(workspace, 'src/types.ts')
  assert.deepEqual(outline.symbols.map(symbol => symbol.name), ['User', 'Role'])
  assert.deepEqual(outline.importedBy, ['src/auth/login.ts'])
  assert.deepEqual(index.outline(workspace, 'src/auth/login.ts').imports.sort(), ['src/auth/crypto.ts', 'src/types.ts'])
  assert.equal(index.outline(workspace, 'nope.ts'), null)
})

test('a second scan reads only what changed, and removed files disappear', async t => {
  const workspace = project(t, sample)
  const index = new ProjectIndex()
  await index.refresh(workspace)
  fs.appendFileSync(path.join(workspace, 'src/types.ts'), 'export type Extra = string\n')
  fs.writeFileSync(path.join(workspace, 'src/new.ts'), 'export const fresh = 1\n')
  fs.rmSync(path.join(workspace, 'docs/notes.md'))
  const scan = await index.refresh(workspace, { force: true })
  assert.deepEqual([scan.added, scan.changed, scan.removed], [['src/new.ts'], ['src/types.ts'], ['docs/notes.md']])
  assert.equal(index.search(workspace, 'Extra').results[0].path, 'src/types.ts')
  assert.equal(index.search(workspace, 'release pipeline').results.length, 0)
  const again = await index.refresh(workspace, { force: true })
  assert.deepEqual([again.added, again.changed, again.removed], [[], [], []])
})

test('an agent\'s own edit is searchable at once, without waiting for a scan', async t => {
  const workspace = project(t, sample)
  const index = new ProjectIndex()
  await index.refresh(workspace)
  fs.writeFileSync(path.join(workspace, 'src/late.ts'), 'export function lateArrival() {}\n')
  assert.equal(index.search(workspace, 'lateArrival').results.length, 0)
  assert.deepEqual(await index.touch(workspace, ['src/late.ts']), ['src/late.ts'])
  assert.equal(index.search(workspace, 'lateArrival').results[0].path, 'src/late.ts')
  fs.rmSync(path.join(workspace, 'src/late.ts'))
  assert.deepEqual(await index.touch(workspace, ['src/late.ts']), ['src/late.ts'])
  assert.equal(index.search(workspace, 'lateArrival').results.length, 0)
  assert.deepEqual(await index.touch(workspace, ['../outside.txt']), [], 'paths outside the project are ignored')
})

test('dependencies, build output, binaries and huge files stay out of the content index', async t => {
  const workspace = project(t, { ...sample, 'node_modules/pkg/index.js': 'export function hidden() {}', 'dist/bundle.js': 'function bundled() {}', 'Orbit-standalone-v1/app.js': 'function copy() {}', 'big.txt': 'x'.repeat(600 * 1024), 'image.png': 'PNG' })
  fs.writeFileSync(path.join(workspace, 'blob.dat'), Buffer.from([65, 0, 66, 0]))
  const index = new ProjectIndex()
  await index.refresh(workspace)
  const paths = [...index.state(workspace).files.keys()]
  assert.ok(!paths.some(item => /node_modules|dist\/|Orbit-standalone/.test(item)), paths.join())
  assert.match(index.outline(workspace, 'big.txt').note, /large/)
  assert.match(index.outline(workspace, 'blob.dat').note, /binary/)
  assert.match(index.outline(workspace, 'image.png').note, /binary/)
  assert.equal(index.search(workspace, 'hidden bundled copy').results.length, 0)
})

test('inside a Git repository the ignore rules decide what is indexed', async t => {
  const workspace = project(t, { ...sample, '.gitignore': 'secret.txt\ngenerated/\n', 'secret.txt': 'token', 'generated/out.js': 'function out() {}' })
  try { execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' }) } catch { t.skip('git is not installed'); return }
  const index = new ProjectIndex()
  await index.refresh(workspace)
  const paths = [...index.state(workspace).files.keys()]
  assert.ok(paths.includes('src/auth/login.ts') && paths.includes('.gitignore'), 'untracked files that are not ignored are indexed')
  assert.ok(!paths.includes('secret.txt') && !paths.some(item => item.startsWith('generated/')), paths.join())
  assert.ok(!paths.some(item => item.startsWith('.git/')))
})

test('the index survives a restart and only re-reads what changed meanwhile', async t => {
  const workspace = project(t, sample)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-index-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = new ProjectIndex({ directory })
  await first.refresh(workspace)
  first.flush()
  fs.appendFileSync(path.join(workspace, 'src/types.ts'), 'export type More = number\n')
  const second = new ProjectIndex({ directory })
  assert.equal(second.stats(workspace).files, 5, 'loaded from disk before any scan')
  assert.equal(second.search(workspace, 'verifyPassword').results[0].path, 'src/auth/login.ts')
  const scan = await second.refresh(workspace)
  assert.deepEqual([scan.added, scan.changed, scan.removed], [[], ['src/types.ts'], []])
  fs.writeFileSync(path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))), '{ broken')
  const third = new ProjectIndex({ directory })
  assert.equal(third.stats(workspace).files, 0, 'a damaged index file is ignored and rebuilt')
  assert.equal((await third.refresh(workspace)).total, 5)
})

test('the overview is a compact map of the project', async t => {
  const workspace = project(t, sample)
  const index = new ProjectIndex()
  assert.equal(index.overview(workspace), '', 'nothing to say before a scan')
  await index.refresh(workspace)
  const overview = index.overview(workspace)
  assert.match(overview, /5 files/)
  assert.match(overview, /src\/ 4/)
  assert.match(overview, /index_search/)
  assert.ok(overview.length < 1600)
})

test('files that usually hold secrets are listed by name and their words are never indexed', async t => {
  const workspace = project(t, { ...sample, '.env': 'STRIPE_SECRET=sk_live_hunter2hunter2\n', '.env.local': 'DB_PASSWORD=topsecretvalue\n', 'certs/server.pem': 'MIICsecretmaterial\n', 'config/credentials.json': '{"token":"abcdef123456"}\n' })
  const index = new ProjectIndex({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-index-secret-')) })
  t.after(() => fs.rmSync(index.directory, { recursive: true, force: true }))
  await index.refresh(workspace)
  for (const file of ['.env', '.env.local', 'certs/server.pem', 'config/credentials.json']) assert.match(index.outline(workspace, file).note, /secrets/, file)
  for (const word of ['hunter2hunter2', 'topsecretvalue', 'MIICsecretmaterial', 'abcdef123456']) assert.equal(index.search(workspace, word).results.length, 0, word)
  index.flush()
  for (const name of fs.readdirSync(index.directory)) assert.doesNotMatch(fs.readFileSync(path.join(index.directory, name), 'utf8'), /hunter2|topsecretvalue|MIICsecret|abcdef123456/, 'nothing secret reaches the index file on disk')
})
