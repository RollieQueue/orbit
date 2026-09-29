'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { findNewestStandalone, listStandaloneBundles } = require('../scripts/standalone-resolve.cjs')
const upgrade = require('../scripts/self-upgrade.cjs')
const cleaner = require('../scripts/clean-bundles.cjs')

const { newestSourceChange, readBuildMarker, writeBuildMarker, toolPath, toolchain, planSteps, isFreshHealth, waitForHealth, snapshotTree, restoreTree, readRef, saveDistPrev, restoreDistPrev, orbitLaunch, matchesOrbitProcess, readCycles, recordCycle, cycleLimitReached, acquireLock, createTimer } = upgrade

function temporary(t, prefix = 'orbit-self-upgrade-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('findNewestStandalone prefers highest numeric v* over lexical v9 (distribution path stays)', (t) => {
  const root = temporary(t)
  assert.equal(findNewestStandalone(root), null)
  const legacy = path.join(root, 'Orbit-standalone-v9')
  const stamped = path.join(root, 'Orbit-standalone-v1790563080601')
  const incomplete = path.join(root, 'Orbit-standalone-v1790999999999')
  fs.mkdirSync(legacy); fs.mkdirSync(stamped); fs.mkdirSync(incomplete)
  fs.writeFileSync(path.join(legacy, 'Orbit.exe'), 'legacy')
  fs.writeFileSync(path.join(stamped, 'Orbit.exe'), 'stamped')
  for (const bundle of [legacy, stamped]) {
    fs.mkdirSync(path.join(bundle, 'resources'))
    fs.writeFileSync(path.join(bundle, 'resources', 'app.asar'), 'packaged application')
  }
  const bundles = listStandaloneBundles(root)
  assert.equal(bundles.length, 2)
  assert.equal(bundles[0].name, 'Orbit-standalone-v1790563080601')
  assert.equal(findNewestStandalone(root).exe, path.join(stamped, 'Orbit.exe'))
})

test('the upgrade toolchain is tsc, vite, the Electron binary Orbit.cmd starts and git', () => {
  const tools = toolchain()
  for (const file of [tools.tsc, tools.vite, tools.electron]) assert.ok(fs.existsSync(file), `${file} must exist`)
  assert.equal(tools.tsc.split(path.sep).slice(-3).join('/'), 'typescript/bin/tsc')
  assert.equal(tools.vite.split(path.sep).slice(-3).join('/'), 'vite/bin/vite.js')
  assert.ok(/[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron(\.exe)?$/.test(tools.electron), 'the app runs from node_modules/electron, not from a packaged copy')
  assert.match(tools.git, /^git version/)
  assert.throws(() => toolPath('typescript', 'no-such-binary'), /does not declare/)
})

test('dist/ is up to date only relative to the sources recorded when it was built and verified', (t) => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'electron')); fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'node_modules')); fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'electron', 'main.cjs'), 'main')
  fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'app')
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'dependency noise')
  const at = (file, seconds) => { const time = new Date(Date.now() + seconds * 1000); fs.utimesSync(file, time, time) }
  for (const file of ['electron/main.cjs', 'src/App.tsx', 'package.json']) at(path.join(root, file), -60)
  at(path.join(root, 'node_modules', 'ignored.js'), 600)
  const dist = path.join(root, 'dist')
  assert.equal(readBuildMarker(dist), null, 'a dist made by npm run build alone has unknown provenance')
  const built = newestSourceChange(root)
  assert.ok(built.time > 0 && built.file !== path.join('node_modules', 'ignored.js'), 'node_modules is not a source')
  writeBuildMarker(dist, { builtAt: new Date().toISOString(), sourceNewest: built.time, sourceFile: built.file })
  assert.equal(readBuildMarker(dist).sourceNewest, built.time)
  assert.ok(newestSourceChange(root).time <= readBuildMarker(dist).sourceNewest, 'nothing changed since the recorded build')
  at(path.join(root, 'src', 'App.tsx'), 30)
  const changed = newestSourceChange(root)
  assert.equal(changed.file, path.join('src', 'App.tsx'))
  assert.ok(changed.time > readBuildMarker(dist).sourceNewest, 'an edit after the recorded sources requires a new build')
})

test('the plan has no packaging step and ends with the relaunch and its health check', () => {
  assert.deepEqual(planSteps(), ['typecheck', 'test', 'smoke', 'main-load', 'save-previous', 'build', 'relaunch', 'health'])
  assert.deepEqual(planSteps({ noRelaunch: true, desktop: true }), ['typecheck', 'test', 'smoke', 'main-load', 'smoke:desktop', 'save-previous', 'build'])
  assert.deepEqual(planSteps({ verifyOnly: true }), ['typecheck', 'test', 'smoke', 'main-load'])
  assert.ok(!planSteps().some((step) => /package|standalone|builder/.test(step)))
})

test('the relaunch is the same command Orbit.cmd runs, without ELECTRON_RUN_AS_NODE', () => {
  const spec = orbitLaunch({ electron: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', base: 'C:\\repo', args: ['--relaunch'], env: { ELECTRON_RUN_AS_NODE: '1', ORBIT_USER_DATA: 'C:\\profile' } })
  assert.deepEqual(spec.args, ['C:\\repo', '--relaunch'])
  assert.equal(spec.cwd, 'C:\\repo')
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(spec.env.ORBIT_USER_DATA, 'C:\\profile', 'the profile of the caller is passed on to a freshly started Orbit')
})

test('only a fresh health report counts, and waiting for it stops at the deadline', async (t) => {
  const since = Date.now()
  assert.equal(isFreshHealth(null, since), false)
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since - 10, writtenAt: since + 5 }, since), false, 'a report from a process that started before the signal is stale')
  assert.equal(isFreshHealth({ ok: false, pid: 1, startedAt: since + 1, writtenAt: since + 2 }, since), true, 'a fresh failure is still a fresh report')
  const dir = temporary(t)
  const file = path.join(dir, 'health.json')
  fs.writeFileSync(file, JSON.stringify({ ok: true, pid: 7, startedAt: since - 1000, writtenAt: since - 900 }))
  assert.equal(await waitForHealth({ file, since, timeoutMs: 250, poll: 20 }), null, 'the stale file left by the previous instance does not satisfy the wait')
  setTimeout(() => fs.writeFileSync(file, JSON.stringify({ ok: true, pid: 8, startedAt: since + 50, writtenAt: since + 60 })), 120)
  const health = await waitForHealth({ file, since, timeoutMs: 2000, poll: 20 })
  assert.equal(health?.pid, 8)
})

test('Orbit processes of this repository are told apart from helpers, the smoke and the dev server', () => {
  const root = 'C:\\Users\\Roman Andreevich\\Desktop\\smth'
  const electron = `"${root}\\node_modules\\electron\\dist\\electron.exe"`
  assert.equal(matchesOrbitProcess(`${electron} "${root}"`, root), true)
  assert.equal(matchesOrbitProcess(`${electron} "${root}" --relaunch`, root), true)
  assert.equal(matchesOrbitProcess(`${electron} --type=renderer "${root}"`, root), false, 'Chromium helpers die with their browser process')
  assert.equal(matchesOrbitProcess(`${electron} scripts\\smoke-desktop.cjs`, root), false, 'the desktop smoke is not the app')
  assert.equal(matchesOrbitProcess(`${electron} "${root}\\scripts\\smoke-desktop.cjs"`, root), false)
  assert.equal(matchesOrbitProcess(`${electron} electron/main.cjs`, root), false, 'npm run dev is not the app')
  assert.equal(matchesOrbitProcess(`${electron} "C:\\elsewhere\\project"`, root), false, 'the executable path alone does not make it ours')
  assert.equal(matchesOrbitProcess(`${electron} "${root}\\scripts\\self-upgrade.cjs" --watch x`, root), false, 'the script under Electron-as-Node is not the app')
})

test('the working tree of electron/ and src/ is snapshotted with new files and restored, leaving the index alone', (t) => {
  const repo = temporary(t, 'orbit-upgrade-repo-')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  fs.mkdirSync(path.join(repo, 'electron')); fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'docs'))
  fs.writeFileSync(path.join(repo, 'electron', 'main.cjs'), 'v1')
  fs.writeFileSync(path.join(repo, 'src', 'App.tsx'), 'v1')
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), 'docs')
  git('add', '.'); git('commit', '-q', '-m', 'base')
  const head = git('rev-parse', 'HEAD')

  // The verified state: a modified file, a new untracked module, a deleted file, an untouched docs/ change.
  fs.writeFileSync(path.join(repo, 'electron', 'main.cjs'), 'v2')
  fs.writeFileSync(path.join(repo, 'electron', 'mcp-server.cjs'), 'new module')
  fs.unlinkSync(path.join(repo, 'src', 'App.tsx'))
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), 'docs edited')
  const candidate = snapshotTree({ cwd: repo, label: 'candidate' })
  assert.equal(candidate.head, head)
  assert.equal(readRef('candidate', repo), candidate.commit)
  assert.equal(git('status', '--porcelain', '--', 'electron', 'src').split('\n').filter(Boolean).length, 3, 'the real index and worktree are untouched by the snapshot')
  assert.equal(git('diff', '--cached', '--name-only'), '', 'nothing was staged')
  const tracked = git('ls-tree', '-r', '--name-only', candidate.commit).split('\n')
  assert.ok(tracked.includes('electron/mcp-server.cjs'), 'a new untracked file is part of the snapshot (git stash create would miss it)')
  assert.ok(!tracked.includes('src/App.tsx'), 'a deleted file is gone from the snapshot')
  assert.ok(tracked.includes('docs/note.md'), 'paths outside the snapshot keep their HEAD content')
  assert.equal(git('show', `${candidate.commit}:docs/note.md`), 'docs')

  // The broken state after it, then the rollback.
  fs.writeFileSync(path.join(repo, 'electron', 'main.cjs'), 'v3 broken')
  fs.writeFileSync(path.join(repo, 'electron', 'mcp-server.cjs'), 'broken too')
  fs.writeFileSync(path.join(repo, 'src', 'App.tsx'), 'resurrected')
  fs.writeFileSync(path.join(repo, 'electron', 'later.cjs'), 'created after the snapshot')
  const failed = snapshotTree({ cwd: repo, label: 'failed' })
  assert.notEqual(failed.commit, candidate.commit)
  restoreTree({ cwd: repo, commit: candidate.commit })
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'main.cjs'), 'utf8'), 'v2')
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'mcp-server.cjs'), 'utf8'), 'new module')
  assert.equal(fs.existsSync(path.join(repo, 'src', 'App.tsx')), false, 'a tracked file absent from the snapshot is removed again')
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'later.cjs'), 'utf8'), 'created after the snapshot', 'untracked files made after the snapshot are never deleted')
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'note.md'), 'utf8'), 'docs edited', 'paths outside electron/ and src/ are not restored')
  assert.equal(git('diff', '--cached', '--name-only'), '', 'the restore did not stage anything')
  assert.equal(git('show', `${failed.commit}:electron/main.cjs`), 'v3 broken', 'the failed state stays reachable for inspection')
})

test('dist-prev/ keeps the previous build and brings it back', (t) => {
  const root = temporary(t)
  const dist = path.join(root, 'dist'), prev = path.join(root, 'dist-prev')
  assert.equal(saveDistPrev({ dist, prev }), false, 'nothing to save before the first build')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), 'good')
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'good js')
  assert.equal(saveDistPrev({ dist, prev }), true)
  fs.writeFileSync(path.join(dist, 'index.html'), 'broken')
  fs.rmSync(path.join(dist, 'assets'), { recursive: true })
  assert.equal(fs.readFileSync(path.join(prev, 'index.html'), 'utf8'), 'good')
  assert.equal(restoreDistPrev({ dist, prev }), true)
  assert.equal(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), 'good')
  assert.equal(fs.readFileSync(path.join(dist, 'assets', 'app.js'), 'utf8'), 'good js')
  assert.ok(fs.existsSync(path.join(prev, 'index.html')), 'the previous build stays available after a restore')
  assert.ok(!fs.readdirSync(root).some((name) => /\.old-/.test(name)), 'the parked copy is removed')
  fs.rmSync(prev, { recursive: true })
  assert.throws(() => restoreDistPrev({ dist, prev }), /has no build to restore/)
})

test('the relaunch cap counts restarts inside a rolling window', (t) => {
  const file = path.join(temporary(t), 'cycles.json')
  const now = 1_000_000_000
  const windowMs = 30 * 60 * 1000
  assert.equal(cycleLimitReached({ file, now, limit: 3, windowMs }), false)
  for (let i = 0; i < 3; i++) recordCycle({ file, now: now + i * 60000, windowMs })
  assert.equal(readCycles({ file, now: now + 180000, windowMs }).length, 3)
  assert.equal(cycleLimitReached({ file, now: now + 180000, limit: 3, windowMs }), true)
  assert.equal(cycleLimitReached({ file, now: now + windowMs + 60000, limit: 3, windowMs }), false, 'old restarts fall out of the window')
  assert.equal(cycleLimitReached({ file, now: now + 180000, limit: 4, windowMs }), false, 'ORBIT_UPGRADE_MAX_CYCLES raises the cap')
})

test('one upgrade at a time: the lock refuses a second run while its holder is alive', (t) => {
  const base = temporary(t)
  const file = acquireLock(base)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid)
  assert.throws(() => acquireLock(base), /already running/)
  fs.writeFileSync(file, JSON.stringify({ pid: 999999999, startedAt: Date.now() }))
  assert.equal(acquireLock(base), file, 'a lock left by a dead process is taken over')
})

test('step timings record what ran, how long and which step failed', async () => {
  const lines = []
  const { timings, step } = createTimer((line) => lines.push(line))
  assert.equal(await step('one', () => 1), 1)
  await assert.rejects(step('two', async () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(timings.map((entry) => [entry.step, entry.ok, entry.error]), [['one', true, undefined], ['two', false, 'boom']])
  assert.ok(timings.every((entry) => Number.isInteger(entry.ms) && entry.ms >= 0))
  assert.deepEqual(lines, ['\n==> one', '\n==> two'])
})

test('clean:bundles lists packaged copies with sizes, deletes only with --yes and keeps the newest bundle unless --all', (t) => {
  const root = temporary(t)
  const make = (name, files) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name, file)), { recursive: true })
      fs.writeFileSync(path.join(root, name, file), content)
    }
  }
  make('Orbit-standalone-v100', { 'Orbit.exe': 'exe', 'resources/app.asar': 'x'.repeat(2048) })
  make('Orbit-standalone-v200', { 'Orbit.exe': 'exe', 'resources/app.asar': 'y'.repeat(1024) })
  make('Orbit-standalone-v300', { 'Orbit.exe': 'exe' }) // incomplete: newest by number but not a valid bundle
  make('release-orbit-v2', { 'win-unpacked/Orbit.exe': 'exe' })
  make('.orbit-partial-v150', { 'Orbit.exe': 'half' })
  make('notes', { 'a.txt': 'never touched' })
  fs.writeFileSync(path.join(root, 'Orbit-standalone-file'), 'a file, not a folder')
  const entries = cleaner.listBundles(root)
  assert.deepEqual(entries.map((entry) => entry.name), ['Orbit-standalone-v300', 'Orbit-standalone-v200', 'Orbit-standalone-v100', '.orbit-partial-v150', 'release-orbit-v2'])
  assert.equal(entries.find((entry) => entry.name === 'Orbit-standalone-v100').bytes, 2048 + 3)
  assert.equal(entries.find((entry) => entry.name === 'Orbit-standalone-v100').files, 2)
  assert.equal(cleaner.newestStandalone(entries).name, 'Orbit-standalone-v200', 'an incomplete newer folder is not the bundle to keep')
  const doomed = cleaner.selectForDeletion(entries)
  assert.deepEqual(doomed.map((entry) => entry.name).sort(), ['.orbit-partial-v150', 'Orbit-standalone-v100', 'Orbit-standalone-v300', 'release-orbit-v2'])
  assert.equal(cleaner.selectForDeletion(entries, { all: true }).length, 5)
  const dry = cleaner.removeBundles(doomed, { yes: false, base: root })
  assert.equal(dry.removed.length, 0)
  assert.equal(dry.skipped.length, 4)
  assert.ok(fs.existsSync(path.join(root, 'Orbit-standalone-v100')), 'nothing is deleted without --yes')
  const outside = { name: 'Orbit-standalone-v1', dir: path.join(os.tmpdir(), 'Orbit-standalone-v1') }
  assert.equal(cleaner.removeBundles([outside], { yes: true, base: root }).errors.length, 1, 'a folder outside the root is refused')
  const done = cleaner.removeBundles(doomed, { yes: true, base: root })
  assert.equal(done.removed.length, 4)
  assert.deepEqual(fs.readdirSync(root).sort(), ['Orbit-standalone-file', 'Orbit-standalone-v200', 'notes'])
})
