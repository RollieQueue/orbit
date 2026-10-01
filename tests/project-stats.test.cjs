const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { projectStats, isCode, numstatDelta } = require('../electron/project-stats.mts')
const { panelPages, triggeredSkills } = require('../src/skill-triggers.ts')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stats-'))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })
const writeRun = (userData, runId, workspace, at, input, output) => {
  fs.mkdirSync(path.join(userData, 'run-history'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'run-history', `${runId}.json`), JSON.stringify({ runId, workspace, startedAt: at, finishedAt: at, usage: { inputTokens: input, outputTokens: output } }))
}

test('code files are told by extension, without dependency and build folders or minified files', () => {
  assert.equal(isCode('src/a.ts'), true)
  assert.equal(isCode('styles/site.CSS'), true)
  for (const file of ['README.md', 'package-lock.json', 'node_modules/x/index.js', 'dist/app.js', 'lib/x.min.js', 'Makefile']) assert.equal(isCode(file), false, file)
  assert.equal(numstatDelta('10\t3\tsrc/a.ts'), 7)
  assert.equal(numstatDelta('10\t3\tdocs/a.md'), 0)
  assert.equal(numstatDelta('-\t-\timg/logo.png'), 0)
})

test('lines follow the git history and the working tree; tokens are the runs of this workspace and outlive their records', async () => {
  const userData = tmp(), workspace = tmp(), other = tmp()
  t_after(userData, workspace, other)
  git(workspace, 'init', '-q')
  fs.writeFileSync(path.join(workspace, 'a.js'), 'one\ntwo\nthree\n')
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'not\ncode\n')
  git(workspace, 'add', '.'); git(workspace, 'commit', '-q', '-m', 'first')
  fs.writeFileSync(path.join(workspace, 'a.js'), 'one\n')
  fs.writeFileSync(path.join(workspace, 'b.ts'), 'x\ny\n')
  git(workspace, 'add', '.'); git(workspace, 'commit', '-q', '-m', 'second')
  fs.writeFileSync(path.join(workspace, 'c.py'), 'print(1)\nprint(2)')
  writeRun(userData, 'r1', workspace, '2026-10-01T10:00:00.000Z', 100, 20)
  writeRun(userData, 'r2', other, '2026-10-01T11:00:00.000Z', 999, 1)
  writeRun(userData, 'r3', workspace, '2026-10-01T12:00:00.000Z', null, null)

  const stats = await projectStats(userData, workspace)
  assert.equal(stats.linesSource, 'git')
  assert.deepEqual(stats.lines.map(point => point.value), [3, 3, 5])
  assert.deepEqual(stats.tokens, [{ at: Date.parse('2026-10-01T10:00:00.000Z'), value: 120 }])

  fs.rmSync(path.join(userData, 'run-history', 'r1.json'))
  writeRun(userData, 'r4', workspace, '2026-10-01T13:00:00.000Z', 5, 5)
  const later = await projectStats(userData, workspace)
  assert.deepEqual(later.tokens.map(point => point.value), [120, 10])
})

test('a folder without git is counted file by file and the count is kept as a snapshot', async () => {
  const userData = tmp(), workspace = tmp()
  t_after(userData, workspace)
  fs.mkdirSync(path.join(workspace, 'node_modules'))
  fs.writeFileSync(path.join(workspace, 'node_modules', 'dep.js'), 'a\nb\n')
  fs.writeFileSync(path.join(workspace, 'main.go'), 'package main\n\nfunc main() {}\n')
  const stats = await projectStats(userData, workspace)
  assert.equal(stats.linesSource, 'files')
  assert.equal(stats.lines[stats.lines.length - 1].value, 3)
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'project-stats.json'), 'utf8'))
  assert.equal(Object.values(saved.snapshots)[0].length, 1)
})

test('quota-panel pages come from enabled package skills only and never show full screen', () => {
  const skill = (id, extra) => ({ id, name: id, scope: 'global', package: { id }, triggers: [{ on: 'quota-panel', show: 'chart.html' }], ...extra })
  const skills = [skill('a'), skill('b', { enabled: false }), skill('c', { package: undefined }), skill('d', { scope: 'project' })]
  assert.deepEqual(panelPages(skills).map(page => page.skill.id), ['d', 'a'])
  assert.deepEqual(triggeredSkills(skills), [])
})

function t_after(...dirs) {
  test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) })
}
