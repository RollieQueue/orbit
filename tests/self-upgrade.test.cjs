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
const { LEVEL_FLAGS, RENDERER_INPUTS, DEFAULT_REASON, DEFAULT_CONTINUE_WITH, parseArgs, upgradePaths, rendererState, buildDecision, verifyDecision, nextBuildMarker, decideLevel, resolveIntent, writeIntent, runtimeRestorePaths, runWatcher } = upgrade
const { fingerprints, rendererHash } = require('../electron/fingerprint.cjs')

function temporary(t, prefix = 'orbit-self-upgrade-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeHealth = (file, health) => write(path.dirname(file), { [path.basename(file)]: JSON.stringify(health) })

/** A temporary git repository with its own identity and LF endings. */
function gitRepository(t) {
  const repo = temporary(t, 'orbit-upgrade-repo-')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  return { repo, git }
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
  assert.deepEqual(planSteps({ build: false }), ['typecheck', 'test', 'smoke', 'main-load', 'relaunch', 'health'], 'a runtime-only change: checks, no build')
  assert.deepEqual(planSteps({ verify: false, build: false }), ['relaunch', 'health'], '--no-verify, or sources verified before')
})

test('the relaunch is the same command Orbit.cmd runs, without ELECTRON_RUN_AS_NODE', () => {
  const spec = orbitLaunch({ electron: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', base: 'C:\\repo', args: ['--relaunch'], env: { ELECTRON_RUN_AS_NODE: '1', ORBIT_USER_DATA: 'C:\\profile' } })
  assert.deepEqual(spec.args, ['C:\\repo', '--relaunch'])
  assert.equal(spec.cwd, 'C:\\repo')
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(spec.env.ORBIT_USER_DATA, 'C:\\profile', 'the profile of the caller is passed on to a freshly started Orbit')
  assert.deepEqual({ ...LEVEL_FLAGS }, { full: '--relaunch', runtime: '--restart-runtime', renderer: '--reload-renderer' }, 'the second-instance flags main.cjs handles')
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
  // Relative to the snapshot both new files count as added; the rollback names only those of the change that went
  // live (the candidate), here src/App.tsx.
  assert.deepEqual(upgrade.addedFiles({ cwd: repo, from: candidate.commit, to: failed.commit }), ['electron/later.cjs', 'src/App.tsx'])
  const restored = restoreTree({ cwd: repo, commit: candidate.commit, remove: ['src/App.tsx'] })
  assert.deepEqual([restored.removed, restored.notRemoved, restored.attempts], [['src/App.tsx'], [], 1])
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'main.cjs'), 'utf8'), 'v2')
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'mcp-server.cjs'), 'utf8'), 'new module')
  assert.equal(fs.existsSync(path.join(repo, 'src', 'App.tsx')), false, 'a file the rollback names is removed')
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'later.cjs'), 'utf8'), 'created after the snapshot', 'overlay: files made after the snapshot stay unless named')
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

test('arguments: value flags take the next argument or =value, everything else starting with -- is a switch', () => {
  const parsed = parseArgs(['--no-verify', '--reason', 'new tool', '--continue-with=run the tests', '--level', 'runtime', '--intent-file', 'C:\\data\\pending-resume.json', '--desktop'])
  assert.deepEqual([...parsed.flags].sort(), ['--desktop', '--no-verify'])
  assert.deepEqual(parsed.values, { '--reason': 'new tool', '--continue-with': 'run the tests', '--level': 'runtime', '--intent-file': 'C:\\data\\pending-resume.json' })
  assert.deepEqual(parsed.errors, [])
  assert.equal(parseArgs(['--reason', '--force']).values['--reason'], '--force', 'a reason that starts with dashes is still the reason')
  assert.equal(parseArgs(['--reason', '--force']).flags.has('--force'), false)
  assert.deepEqual(parseArgs(['--level']).errors, ['--level needs a value'])
  assert.deepEqual(parseArgs(['--watch', 'C:\\repo\\artifacts\\self-upgrade-plan.json']).values, { '--watch': 'C:\\repo\\artifacts\\self-upgrade-plan.json' })
})

test('the restart level: full for the shell or without a running Orbit, runtime for runtime files, renderer for a new build, else none', () => {
  const fingerprint = { shell: 'S1', runtime: 'R1' }
  const health = { ok: true, pid: 10, startedAt: 1, writtenAt: 2, shellHash: 'S1', runtimeHash: 'R1', distMtime: 500, level: 'full', generation: 1, runtime: { mode: 'child', ready: true, pid: 11, ms: 300 } }
  const decide = (overrides = {}) => decideLevel({ forced: 'auto', running: true, health, fingerprint, distMtime: 500, willBuild: false, ...overrides })
  const level = (overrides) => decide(overrides).level
  assert.equal(level({}), 'none', 'the running Orbit runs exactly these files and this build')
  assert.match(decide().reason, /already runs/)
  assert.equal(level({ running: false, health: null }), 'full', 'nothing runs: start one')
  assert.equal(level({ health: null }), 'full', 'an Orbit runs, but the health report is another process\'s')
  assert.equal(level({ health: { ...health, ok: false, error: 'renderer failed' } }), 'full', 'the running Orbit is not healthy')
  assert.equal(level({ health: { ...health, shellHash: undefined, runtimeHash: undefined } }), 'full', 'an Orbit that predates restart levels')
  assert.equal(level({ fingerprint: { shell: 'S2', runtime: 'R1' } }), 'full', 'a shell file changed')
  assert.match(decide({ fingerprint: { shell: 'S2', runtime: 'R1' } }).reason, /shell/)
  assert.equal(level({ fingerprint: { shell: 'S2', runtime: 'R2' } }), 'full', 'shell and runtime changed')
  assert.equal(level({ fingerprint: { shell: 'S1', runtime: 'R2' } }), 'runtime', 'only runtime files changed')
  assert.equal(level({ fingerprint: { shell: 'S1', runtime: 'R2' }, willBuild: true }), 'full', 'runtime and renderer changed: a runtime restart keeps the old window')
  assert.equal(level({ fingerprint: { shell: 'S1', runtime: 'R2' }, distMtime: 600 }), 'full', 'runtime changed and dist/ is newer than the window')
  assert.equal(level({ fingerprint: { shell: 'S1', runtime: 'R2' }, health: { ...health, runtime: { mode: 'inprocess' } } }), 'full', 'the runtime runs inside main')
  assert.equal(level({ willBuild: true }), 'renderer', 'a new build of the renderer only')
  assert.equal(level({ distMtime: 600 }), 'renderer', 'dist/ is newer than what the window shows')
  // --level forces, but only a running Orbit can restart a part of itself.
  assert.equal(level({ forced: 'runtime' }), 'runtime')
  assert.equal(level({ forced: 'renderer', fingerprint: { shell: 'S2', runtime: 'R2' } }), 'renderer')
  assert.equal(level({ forced: 'full' }), 'full')
  assert.equal(level({ forced: 'runtime', running: false, health: null }), 'full')
  assert.equal(level({ forced: 'renderer', running: false, health: null }), 'full')
  assert.equal(level({ forced: 'runtime', health: { ...health, runtime: { mode: 'inprocess' } } }), 'full')
})

test('freshness: a report of the start, runtime restart or reload that began after the signal and was written after it', () => {
  const since = 1_000_000
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since - 60000, restartedAt: since + 10, writtenAt: since + 20 }, since), true, 'a runtime restart or reload of a process that started long before')
  assert.equal(isFreshHealth({ ok: false, pid: 1, startedAt: since - 60000, restartedAt: since + 10, writtenAt: since + 20, error: 'x' }, since), true, 'a fresh failure is a fresh report')
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since - 60000, restartedAt: since - 10, writtenAt: since + 20 }, since), false, 'a generation that began before the signal, written after it')
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since - 60000, writtenAt: since + 20 }, since), false, 'an old process that wrote again')
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since + 5, restartedAt: null, writtenAt: since + 20 }, since), true, 'no restartedAt: the start counts')
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since + 5, restartedAt: since + 5, writtenAt: since - 1 }, since), false, 'written before the signal')
  assert.equal(isFreshHealth({ ok: true, pid: 1, startedAt: since + 5 }, since), false, 'no writtenAt')
  assert.equal(isFreshHealth('ok', since), false)
})

test('a runtime-only change costs no renderer build: dist/ is rebuilt for renderer inputs only, compared by content', (t) => {
  const root = write(temporary(t), { 'src/App.tsx': 'app\n', 'src/styles.css': 'css\n', 'index.html': '<div id="root"></div>\n', 'vite.config.ts': 'config\n', 'tsconfig.json': '{}\n', 'package.json': '{}\n', 'electron/runtime.mts': 'runtime 1\n', 'dist/index.html': 'built\n' })
  const dist = path.join(root, 'dist')
  const state = rendererState(root)
  assert.match(state.hash, /^[0-9a-f]{40}$/)
  assert.equal(buildDecision({ marker: readBuildMarker(dist), renderer: state }).needed, true, 'a dist/ without a record (npm run build alone) is rebuilt')
  writeBuildMarker(dist, nextBuildMarker({ built: true, verified: true, renderer: state, fingerprint: fingerprints(root), source: newestSourceChange(root), candidate: { head: 'h', commit: 'c' } }))
  const marker = readBuildMarker(dist)
  assert.equal(marker.version, 2)
  assert.deepEqual(marker.covers, RENDERER_INPUTS, 'the record says what the build covers')
  assert.deepEqual([marker.rendererHash, marker.commit, marker.candidate], [state.hash, 'h', 'c'])
  const needed = () => buildDecision({ marker, renderer: rendererState(root) }).needed
  assert.equal(needed(), false)
  write(root, { 'electron/runtime.mts': 'runtime 2\n', 'electron/runtime/new-tool.mts': 'tool\n', 'docs/notes.md': 'notes\n', 'tests/x.test.cjs': 'test\n' })
  assert.equal(needed(), false, 'electron/, docs/ and tests/ are not renderer inputs')
  write(root, { 'src/App.tsx': 'app\r\n' })
  assert.equal(needed(), false, 'the same file with CRLF endings')
  const later = new Date(Date.now() + 120000)
  fs.utimesSync(path.join(root, 'index.html'), later, later)
  assert.equal(needed(), false, 'a touched but unchanged file')
  for (const [file, content] of [['src/App.tsx', 'app 2\n'], ['src/new.ts', 'new\n'], ['index.html', 'changed\n'], ['vite.config.ts', 'config 2\n'], ['tsconfig.json', '{ "strict": true }\n'], ['package.json', '{ "version": "2" }\n']]) {
    const target = path.join(root, file)
    const before = fs.existsSync(target) ? fs.readFileSync(target) : null
    write(root, { [file]: content })
    assert.equal(needed(), true, `${file} is a renderer input`)
    if (before) fs.writeFileSync(target, before)
    else fs.rmSync(target)
    assert.equal(needed(), false, `${file} as built again`)
  }
  assert.equal(buildDecision({ marker, renderer: state, force: true }).needed, true, '--force')
  assert.equal(buildDecision({ marker, renderer: state, distPresent: false }).needed, true, 'no dist/index.html')
  // A record from before restart levels (one mtime over every source) still decides by time.
  const old = { builtAt: 'then', sourceNewest: state.newest }
  assert.equal(buildDecision({ marker: old, renderer: state }).needed, false)
  assert.equal(buildDecision({ marker: old, renderer: { ...state, newest: state.newest + 1000, file: 'src/App.tsx' } }).needed, true)
})

test('the checks are skipped only for exactly the sources that passed them, never for a build made with --no-verify', (t) => {
  const root = write(temporary(t), { 'src/App.tsx': 'app\n', 'package.json': '{}\n', 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime 1\n' })
  const current = () => ({ fingerprint: fingerprints(root), renderer: rendererState(root), source: newestSourceChange(root) })
  const needed = (marker, extra = {}) => { const now = current(); return verifyDecision({ marker, fingerprint: now.fingerprint, renderer: now.renderer, sourceNewest: now.source.time, ...extra }).needed }
  const verified = nextBuildMarker({ built: true, verified: true, ...current() })
  assert.deepEqual(Object.keys(verified.verified).sort(), ['at', 'covers', 'renderer', 'runtime', 'shell'])
  assert.equal(needed(verified), false, 'nothing changed since the checks passed')
  assert.equal(needed(verified, { force: true }), true, '--force')
  assert.equal(needed(verified, { noVerify: true }), false, '--no-verify')
  assert.equal(needed(null), true, 'no record')
  write(root, { 'electron/runtime.mts': 'runtime 2\n' })
  assert.equal(needed(verified), true, 'a runtime edit')
  const unverified = nextBuildMarker({ previous: verified, built: true, verified: false, ...current() })
  assert.equal(needed(unverified), true, 'a --no-verify build does not vouch for its sources')
  assert.equal(unverified.verified.runtime, verified.verified.runtime, 'the older claim stays and names the older sources')
  const checked = nextBuildMarker({ previous: unverified, built: false, verified: true, ...current() })
  assert.equal(needed(checked), false, 'verified without a build (runtime-only change)')
  assert.equal(checked.builtAt, unverified.builtAt, 'the build it records is still the earlier one')
  write(root, { 'electron/runtime.mts': 'runtime 1\r\n' })
  assert.equal(needed(verified), false, 'back to the verified content, whatever the line endings')
  // A record from before restart levels: its mtime claim counts until a run replaces it.
  const old = { builtAt: 'then', sourceNewest: current().source.time }
  assert.equal(needed(old), false)
  assert.equal(needed(old, { sourceNewest: old.sourceNewest + 1 }), true)
  const upgraded = nextBuildMarker({ previous: old, built: false, verified: true, ...current() })
  assert.deepEqual([upgraded.version, needed(upgraded), buildDecision({ marker: upgraded, renderer: rendererState(root) }).needed], [2, false, false])
})

test('the intent: only for a runtime or full restart of an Orbit run with a known resume file, from the tool or a script', (t) => {
  const dir = temporary(t)
  const file = path.join(dir, 'profile', 'pending-resume.json')
  const env = { ORBIT_RUN_ID: 'run-1', ORBIT_CHAT_ID: 'chat-1', ORBIT_PROJECT_ID: 'project-1', ORBIT_AGENT_ID: 'root', ORBIT_RESUME_FILE: file }
  const script = resolveIntent({ env, level: 'runtime', id: 'up-1', commit: 'abc123', snapshot: 'def456' })
  assert.equal(script.file, file)
  assert.deepEqual(script.intent, {
    version: 1, id: 'up-1', createdAt: null, source: 'script', reason: DEFAULT_REASON, continueWith: DEFAULT_CONTINUE_WITH, verify: true,
    runId: 'run-1', chatId: 'chat-1', projectId: 'project-1', agentId: 'root', level: 'runtime', state: 'relaunching', commit: 'abc123',
    snapshot: 'def456', outcome: null, error: null, patch: null, verdict: null, verdictAt: null,
  }, 'commit: the HEAD the code was taken on; snapshot: the candidate snapshot (HEAD plus the uncommitted code that went live)')
  assert.equal(resolveIntent({ env, level: 'full', id: 'x' }).intent.snapshot, null, 'no candidate snapshot (git missing)')
  assert.equal(DEFAULT_CONTINUE_WITH, 'Продолжи задачу с того места, где остановился перед перезапуском Orbit.')
  const tool = resolveIntent({ env: { ...env, ORBIT_RESTART_SOURCE: 'tool' }, level: 'full', reason: ' new skill ', continueWith: 'run the new skill', verify: false, id: 'up-2' }).intent
  assert.deepEqual([tool.source, tool.reason, tool.continueWith, tool.verify, tool.level, tool.commit], ['tool', 'new skill', 'run the new skill', false, 'full', null])
  assert.equal(resolveIntent({ env: { ...env, ORBIT_RESTART_SOURCE: 'something' }, level: 'full', id: 'x' }).intent.source, 'script')
  assert.equal(resolveIntent({ env, level: 'full', continueWith: '   ', id: 'x' }).intent.continueWith, DEFAULT_CONTINUE_WITH, 'a blank continuation is the default')
  for (const level of ['renderer', 'none']) assert.equal(resolveIntent({ env, level, id: 'x' }).intent, null, `${level}: the runtime keeps its runs`)
  const { ORBIT_RUN_ID: _run, ...noRun } = env
  const terminal = resolveIntent({ env: noRun, level: 'runtime', id: 'x' })
  assert.equal(terminal.intent, null, 'a person running the script from a terminal has no run to continue')
  assert.match(terminal.note, /ORBIT_RUN_ID/)
  const { ORBIT_RESUME_FILE: _file, ...noFile } = env
  assert.deepEqual(resolveIntent({ env: noFile, level: 'runtime', id: 'x' }), { file: null, intent: null, note: 'no resume file: pass --intent-file or set ORBIT_RESUME_FILE' })
  assert.equal(resolveIntent({ env, intentFile: path.join(dir, 'other.json'), level: 'runtime', id: 'x' }).file, path.join(dir, 'other.json'), '--intent-file wins over ORBIT_RESUME_FILE')
  assert.equal(resolveIntent({ env: noFile, intentFile: 'relative.json', level: 'full', id: 'x' }).file, path.resolve('relative.json'))
  assert.equal(fs.existsSync(file), false, 'deciding writes nothing')
})

test('the intent is written atomically: a complete temporary file is renamed over the target, never written in place', (t) => {
  const file = path.join(temporary(t), 'profile', 'pending-resume.json')
  const writes = []
  const renames = []
  const { writeFileSync, renameSync } = fs
  fs.writeFileSync = function (target, ...rest) { writes.push(String(target)); return writeFileSync.call(this, target, ...rest) }
  fs.renameSync = function (from, to) { renames.push([String(from), String(to), fs.readFileSync(from, 'utf8')]); return renameSync.call(this, from, to) }
  try {
    writeIntent(file, { version: 1, runId: 'run-1' })
    writeIntent(file, { version: 1, runId: 'run-2' })
  } finally {
    fs.writeFileSync = writeFileSync
    fs.renameSync = renameSync
  }
  assert.ok(writes.length === 2 && !writes.includes(file), 'only temporary files are written')
  assert.deepEqual(renames.map(([from, to]) => [path.dirname(from), to]), [[path.dirname(file), file], [path.dirname(file), file]], 'next to the target, so the rename stays on one volume')
  assert.deepEqual(renames.map(([, , content]) => JSON.parse(content).runId), ['run-1', 'run-2'], 'the renamed file is already complete')
  assert.equal(readJsonFile(file).runId, 'run-2', 'the second write replaces the first')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['pending-resume.json'], 'no temporary file is left behind')
})

test('a full relaunch: the intent goes to disk right before the signal, only a report of a new process counts, the restart is counted', async (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  const intentFile = path.join(base, 'profile', 'pending-resume.json')
  const record = resolveIntent({ env: { ORBIT_RUN_ID: 'run-9', ORBIT_RESUME_FILE: intentFile }, level: 'full', id: 'up-9', commit: 'c0ffee' }).intent
  writeHealth(paths.health, { ok: true, pid: 50, startedAt: 1, writtenAt: 2 })
  const signals = []
  const system = {
    findOrbitProcesses: () => [{ pid: 50 }],
    killProcess: () => assert.fail('a healthy relaunch stops nothing'),
    launch: (spec) => {
      signals.push({ args: spec.args.slice(1), intent: readJsonFile(intentFile), userData: spec.env.ORBIT_USER_DATA, parked: fs.existsSync(paths.healthPrev) && !fs.existsSync(paths.health) })
      // The old process writes one more report while it shuts down; the new process follows.
      setTimeout(() => writeHealth(paths.health, { ok: true, pid: 50, startedAt: 1, restartedAt: Date.now(), writtenAt: Date.now() }), 10)
      setTimeout(() => writeHealth(paths.health, { ok: true, pid: 51, startedAt: Date.now(), writtenAt: Date.now(), level: 'full', generation: 1 }), 350)
      return 1234
    },
  }
  const plan = { runId: 'up-9', level: 'full', candidate: null, lastGood: null, healthTimeoutMs: 5000, electron: 'electron.exe', running: [50], userData: 'C:\\orbit-profile', intent: { file: intentFile, record }, report: { runId: 'up-9' } }
  const report = await runWatcher(plan, { paths, system })
  assert.deepEqual(signals.map((signal) => signal.args), [['--relaunch']])
  assert.equal(signals[0].parked, true, 'the previous report is moved aside before the signal')
  const written = signals[0].intent
  assert.deepEqual([written.runId, written.id, written.source, written.level, written.state, written.commit, written.outcome, written.continueWith], ['run-9', 'up-9', 'script', 'full', 'relaunching', 'c0ffee', null, DEFAULT_CONTINUE_WITH])
  assert.ok(Number.isFinite(Date.parse(written.createdAt)), 'createdAt is set when it is written')
  if (!process.env.ORBIT_USER_DATA) assert.equal(signals[0].userData, 'C:\\orbit-profile', 'the signal comes from the running instance\'s profile, where its single-instance lock is')
  assert.deepEqual([report.ok, report.status, report.level, report.phase, report.intentWritten], [true, 'relaunched', 'full', 'done', true])
  assert.equal(report.health.pid, 51, 'the late report of the old process is not the relaunch')
  assert.equal(readCycles({ file: paths.cycles }).length, 1, 'a relaunch counts toward the cycle limit')
  const settled = readJsonFile(intentFile)
  assert.deepEqual([written.verdict, written.verdictAt], [null, null], 'no word yet when the signal goes out')
  assert.equal(settled.verdict, 'relaunched', 'the new runtime waits for this word before it continues the run')
  assert.ok(Date.parse(settled.verdictAt) >= Date.parse(written.createdAt))
  assert.deepEqual(settled, { ...written, verdict: 'relaunched', verdictAt: settled.verdictAt }, 'the rest of the intent is untouched')
  assert.equal(report.verdictWritten, true)
  assert.equal(readJsonFile(paths.report).status, 'relaunched')
})

test('the verdict goes only to the intent this restart wrote: a consumed or replaced intent stays as it is', (t) => {
  const file = path.join(temporary(t), 'pending-resume.json')
  const record = { version: 1, id: 'up-1', runId: 'run-1', outcome: null }
  assert.equal(upgrade.markIntentRelaunched(file, record), false, 'consumed by the new runtime: not written again')
  assert.equal(fs.existsSync(file), false)
  writeIntent(file, { ...record, id: 'up-2' })
  assert.equal(upgrade.markIntentRelaunched(file, record), false, 'another restart\'s intent')
  assert.equal(readJsonFile(file).verdict, undefined)
  assert.equal(upgrade.markIntentRolledBack(file, record, { error: 'boom', patch: 'C:\\p.patch' }), true, 'a rollback always leaves its mark')
  assert.deepEqual([readJsonFile(file).id, readJsonFile(file).outcome, readJsonFile(file).error, readJsonFile(file).patch], ['up-1', 'rolled-back', 'boom', 'C:\\p.patch'])
})

test('a runtime restart that fails: the intent is marked rolled-back before the retry, and only runtime files come back', async (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { 'electron/main.cjs': 'shell v1\n', 'electron/runtime.mts': 'runtime v1\n', 'src/App.tsx': 'app v1\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  // Orbit runs this code (its health report gives these hashes); the last upgrade left it as last-good.
  const runningCode = fingerprints(repo)
  const lastGood = snapshotTree({ cwd: repo, label: 'last-good', fingerprint: runningCode }).commit
  // The agent changed the runtime and added a tool.
  write(repo, { 'electron/runtime.mts': 'runtime v2 (broken)\n', 'electron/runtime/new-tool.mts': 'new tool\n' })
  const candidate = snapshotTree({ cwd: repo, label: 'candidate' })
  const paths = upgradePaths(repo)
  const markerBefore = { version: 2, sourceNewest: 1, rendererHash: 'r', verified: { at: 'before', shell: 's', runtime: 'r1', renderer: 'r' } }
  writeBuildMarker(paths.dist, { ...markerBefore, verified: { at: 'this run', shell: 's', runtime: 'broken', renderer: 'r' } })
  const intentFile = path.join(repo, 'profile', 'pending-resume.json')
  const env = { ORBIT_RUN_ID: 'run-1', ORBIT_CHAT_ID: 'chat-1', ORBIT_RESUME_FILE: intentFile, ORBIT_RESTART_SOURCE: 'tool' }
  const record = resolveIntent({ env, level: 'runtime', reason: 'new tool', continueWith: 'use the tool', id: 'up-1', commit: candidate.head }).intent
  const signals = []
  const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8')
  const system = {
    findOrbitProcesses: () => [{ pid: 100 }],
    killProcess: () => assert.fail('a runtime rollback that works keeps the main process'),
    launch: (spec) => {
      signals.push({ args: spec.args.slice(1), intent: readJsonFile(intentFile), runtime: read('electron/runtime.mts'), shell: read('electron/main.cjs'), newTool: fs.existsSync(path.join(repo, 'electron', 'runtime', 'new-tool.mts')), later: fs.existsSync(path.join(repo, 'electron', 'runtime', 'later.mts')) })
      // While the broken runtime starts, someone adds another module: not part of the change that went live.
      if (signals.length === 1) write(repo, { 'electron/runtime/later.mts': 'created after the candidate\n' })
      const ok = signals.length > 1
      setTimeout(() => writeHealth(paths.health, { ok, pid: 100, startedAt: 1, restartedAt: Date.now(), writtenAt: Date.now(), level: 'runtime', ...(ok ? {} : { error: 'runtime crashed on start' }) }), 20)
      return 1
    },
  }
  const previous = { pid: 100, startedAt: 1, shellHash: runningCode.shell, runtimeHash: runningCode.runtime }
  const plan = { runId: 'up-1', level: 'runtime', candidate, lastGood, previous, distPrevSaved: false, built: false, markerWritten: true, markerBefore, healthTimeoutMs: 5000, electron: 'electron.exe', running: [100], intent: { file: intentFile, record }, report: { runId: 'up-1' } }
  // The main process file was edited after the restart was planned: a runtime rollback must not touch it.
  write(repo, { 'electron/main.cjs': 'shell v2 (edited meanwhile)\n' })
  const report = await runWatcher(plan, { paths, system })

  assert.deepEqual(signals.map((signal) => signal.args), [['--restart-runtime'], ['--restart-runtime']])
  const [first, retry] = signals
  assert.deepEqual([first.intent.runId, first.intent.chatId, first.intent.source, first.intent.level, first.intent.state, first.intent.outcome], ['run-1', 'chat-1', 'tool', 'runtime', 'relaunching', null], 'written before the first signal')
  assert.equal(first.runtime, 'runtime v2 (broken)\n')
  assert.deepEqual([retry.intent.outcome, retry.intent.patch, retry.intent.createdAt], ['rolled-back', paths.failedPatch, first.intent.createdAt], 'the same intent, marked before the old code starts')
  assert.match(retry.intent.error, /runtime crashed on start/)
  assert.doesNotMatch(retry.intent.error, /no trustworthy rollback base/)
  assert.equal(report.rollback.base.source, 'last-good', 'last-good is the code that ran (same fingerprints)')
  assert.equal(retry.runtime, 'runtime v1\n', 'the runtime file is back from last-good')
  assert.equal(retry.shell, 'shell v2 (edited meanwhile)\n', 'the main process file stays')
  assert.equal(retry.newTool, false, 'a module the failed change added goes with it (it is in the failed ref and the patch)')
  assert.equal(retry.later, true, 'a file created after the change went live stays')
  assert.deepEqual(report.rollback.deleted, ['electron/runtime/new-tool.mts'], 'the report lists what the rollback removed')
  assert.deepEqual([report.ok, report.status, report.level, report.intentWritten], [false, 'rolled-back', 'runtime', true])
  assert.deepEqual([report.rollback.intentMarked, report.rollback.recovered, report.rollback.treeRestored, report.rollback.fallback, report.rollback.killed], [true, true, true, undefined, []])
  assert.deepEqual(report.rollback.treePaths, runtimeRestorePaths())
  assert.ok(runtimeRestorePaths().includes(':(exclude)electron/main.cjs') && runtimeRestorePaths()[0] === 'electron')
  assert.match(fs.readFileSync(paths.failedPatch, 'utf8'), /runtime v2 \(broken\)/)
  assert.equal(readRef('failed', repo), report.rollback.failed.commit)
  assert.equal(readRef('last-good', repo), lastGood, 'a failed restart does not move last-good')
  assert.deepEqual(readBuildMarker(paths.dist), markerBefore, 'the record that vouched for the failed sources is withdrawn')
  assert.equal(readCycles({ file: paths.cycles }).length, 1, 'a runtime restart counts toward the cycle limit')
  assert.equal(readJsonFile(intentFile).outcome, 'rolled-back')
})

test('a full relaunch that fails: Orbit is stopped, dist-prev/ comes back and the intent is marked, all before the fresh start', async (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  write(base, { 'dist/index.html': 'broken build\n', 'dist-prev/index.html': 'good build\n' })
  const intentFile = path.join(base, 'pending-resume.json')
  const record = resolveIntent({ env: { ORBIT_RUN_ID: 'run-2', ORBIT_RESUME_FILE: intentFile }, level: 'full', id: 'up-2' }).intent
  const events = []
  let alive = [70]
  const system = {
    findOrbitProcesses: () => alive.map((pid) => ({ pid })),
    killProcess: (pid) => { events.push(`kill ${pid}`); alive = alive.filter((other) => other !== pid); return true },
    launch: (spec) => {
      events.push(`${spec.args[1]} ${fs.readFileSync(path.join(paths.dist, 'index.html'), 'utf8').trim()}, intent ${readJsonFile(intentFile).outcome || 'open'}`)
      const pid = 71 + events.length
      const ok = events.length > 2
      setTimeout(() => { alive = [pid]; writeHealth(paths.health, { ok, pid, startedAt: Date.now(), writtenAt: Date.now(), ...(ok ? {} : { error: 'renderer failed to load' }) }) }, 20)
      return 1
    },
  }
  const plan = { runId: 'up-2', level: 'full', candidate: null, lastGood: null, distPrevSaved: true, built: true, markerWritten: true, markerBefore: null, healthTimeoutMs: 5000, electron: 'electron.exe', intent: { file: intentFile, record }, report: {} }
  const report = await runWatcher(plan, { paths, system })
  assert.deepEqual(events, ['--relaunch broken build, intent open', 'kill 72', '--relaunch good build, intent rolled-back'])
  assert.deepEqual([report.status, report.rollback.distRestored, report.rollback.recovered, report.rollback.killed], ['rolled-back', true, true, [72]])
  // No Orbit ran before (no code is known to work): only dist/ comes back, and both the report and the intent say so.
  assert.equal(report.rollback.base.source, null)
  assert.equal(report.rollback.treeRestored, false)
  assert.deepEqual([readJsonFile(intentFile).error, readJsonFile(intentFile).patch], [`the new Orbit reported a failure: renderer failed to load; ${upgrade.NO_BASE_NOTE}`, null])
  assert.equal(report.error, `the new Orbit reported a failure: renderer failed to load; ${upgrade.NO_BASE_NOTE}`)
  assert.equal(upgrade.NO_BASE_NOTE, 'sources left as they are (no trustworthy rollback base)')
  assert.equal(readCycles({ file: paths.cycles }).length, 1)
})

test('the rollback base is only ever the code that ran before the restart', () => {
  const previous = { pid: 10, startedAt: 1000, shellHash: 'S', runtimeHash: 'R' }
  const running = { commit: 'run1', pid: 10, startedAt: 1000, shellHash: 'S', runtimeHash: 'R', recordedAt: 'then' }
  const lastGood = { commit: 'lg1', base: 'head', shellHash: 'S', runtimeHash: 'R' }
  const base = (input) => { const result = upgrade.rollbackBase(input); return [result.source, result.commit] }
  assert.deepEqual(base({ running, previous, lastGood }), ['running', 'run1'], 'the record of the instance that ran comes first')
  assert.deepEqual(base({ running: { ...running, pid: 11 }, previous, lastGood }), ['last-good', 'lg1'], 'a record of another process does not count')
  assert.deepEqual(base({ running: { ...running, startedAt: 999 }, previous, lastGood }), ['last-good', 'lg1'], 'nor one of an earlier process with the same pid')
  assert.deepEqual(base({ running: { ...running, runtimeHash: 'R0' }, previous, lastGood }), ['last-good', 'lg1'], 'nor one made before a runtime restart of that process')
  assert.deepEqual(base({ running: null, previous, lastGood: { ...lastGood, runtimeHash: 'R-older' } }), [null, null], 'a last-good that is not the running code (taken long ago) is never used')
  assert.deepEqual(base({ running: null, previous, lastGood: { ...lastGood, shellHash: null, runtimeHash: null } }), [null, null], 'nor one without fingerprints')
  assert.deepEqual(base({ running: null, previous, lastGood: null }), [null, null])
  assert.deepEqual(base({ running, previous: null, lastGood }), [null, null], 'no Orbit ran before: no state is known to work')
  assert.match(upgrade.rollbackBase({ running, previous: null, lastGood }).reason, /no Orbit ran/)
  assert.deepEqual(base({ running, previous: { pid: 10, startedAt: 1000 }, lastGood }), ['running', 'run1'], 'an instance without hashes is still identified by its own record')
  assert.deepEqual(base({ running: null, previous: { pid: 10, startedAt: 1000 }, lastGood }), [null, null], 'without hashes nothing shows that last-good ran, even when it was taken on HEAD')
})

test('--record-running snapshots the running code with a temporary index and records it only when it is that code', (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { '.gitignore': 'artifacts/\n', 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime\n', 'src/App.tsx': 'app\n', 'package.json': '{}\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  write(repo, { 'electron/runtime.mts': 'runtime (uncommitted, running)\n', 'electron/new.mts': 'new untracked module\n' })
  git('add', 'electron/runtime.mts')
  const staged = git('diff', '--cached', '--name-only')
  const status = git('status', '--porcelain')
  const paths = upgradePaths(repo)
  const code = fingerprints(repo)
  const instance = { pid: 4242, startedAt: 1_790_000_000_000, shellHash: code.shell, runtimeHash: code.runtime }
  const result = upgrade.recordRunning({ paths, instance, now: () => '2026-09-30T08:00:00.000Z' })
  assert.equal(result.recorded, true, result.reason)
  const record = readJsonFile(paths.running)
  assert.deepEqual(record, result.record)
  assert.deepEqual([record.pid, record.startedAt, record.recordedAt, record.shellHash, record.runtimeHash], [4242, 1_790_000_000_000, '2026-09-30T08:00:00.000Z', code.shell, code.runtime])
  assert.equal(readRef('running', repo), record.commit)
  assert.equal(git('show', `${record.commit}:electron/runtime.mts`), 'runtime (uncommitted, running)')
  assert.equal(git('show', `${record.commit}:electron/new.mts`), 'new untracked module', 'untracked files are part of the record')
  assert.deepEqual(upgrade.snapshotInfo(record.commit, repo), { commit: record.commit, base: git('rev-parse', 'HEAD'), shellHash: code.shell, runtimeHash: code.runtime, rendererHash: rendererHash(repo) }, 'the snapshot carries its fingerprints')
  assert.deepEqual([record.version, record.rendererHash], [2, null], 'an instance that reported no renderer hash: src/ is recorded without one')
  assert.match(result.note, /no renderer hash/)
  assert.equal(git('diff', '--cached', '--name-only'), staged, 'the real index is untouched')
  assert.equal(git('status', '--porcelain'), status)
  assert.equal(git('stash', 'list'), '')
  // Files changed after the instance started are not its code: nothing is recorded, the earlier record stays.
  write(repo, { 'electron/runtime.mts': 'edited after the start\n' })
  const refused = upgrade.recordRunning({ paths, instance: { ...instance, startedAt: instance.startedAt + 1 } })
  assert.equal(refused.recorded, false)
  assert.match(refused.reason, /not the code the instance loaded/)
  assert.deepEqual(readJsonFile(paths.running), record)
  assert.equal(upgrade.recordRunning({ paths, instance: { pid: 0 } }).recorded, false, 'no instance, no record')
  assert.equal(upgrade.chooseRollbackBase({ previous: instance, lastGood: null }, paths).commit, record.commit, 'the next rollback of that instance starts from here')
})

test('a rollback takes the sources from the record of the running code, and never from a last-good older than that code', async (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime v1 (old last-good)\n', 'src/App.tsx': 'app\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const lastGood = snapshotTree({ cwd: repo, label: 'last-good', fingerprint: fingerprints(repo) }).commit
  // Later work went live by hand; the instance that runs it recorded its code.
  write(repo, { 'electron/runtime.mts': 'runtime v2 (running)\n' })
  git('commit', '-q', '-am', 'later work')
  const paths = upgradePaths(repo)
  const code = fingerprints(repo)
  const previous = { pid: 300, startedAt: 5000, shellHash: code.shell, runtimeHash: code.runtime }
  assert.equal(upgrade.recordRunning({ paths, instance: previous }).recorded, true)
  const restart = async () => {
    write(repo, { 'electron/runtime.mts': 'runtime v3 (broken)\n' })
    const candidate = snapshotTree({ cwd: repo, label: 'candidate', fingerprint: fingerprints(repo) })
    const seen = []
    const system = {
      findOrbitProcesses: () => [{ pid: 300 }],
      killProcess: () => assert.fail('the retry works: nothing is stopped'),
      launch: () => {
        seen.push(fs.readFileSync(path.join(repo, 'electron', 'runtime.mts'), 'utf8'))
        const ok = seen.length > 1
        setTimeout(() => writeHealth(paths.health, { ok, pid: 300, startedAt: 5000, restartedAt: Date.now(), writtenAt: Date.now(), ...(ok ? {} : { error: 'crash' }) }), 20)
        return 1
      },
    }
    const report = await runWatcher({ runId: 'up', level: 'runtime', candidate, lastGood, previous, healthTimeoutMs: 5000, electron: 'electron.exe', running: [300], report: {} }, { paths, system })
    return { report, seen }
  }
  const trusted = await restart()
  assert.equal(trusted.report.rollback.base.source, 'running')
  assert.deepEqual(trusted.seen, ['runtime v3 (broken)\n', 'runtime v2 (running)\n'], 'back to the code that ran, not to the older last-good')
  assert.doesNotMatch(trusted.report.error, /no trustworthy rollback base/)
  // Without the record, the older last-good is not the running code: the sources stay, and the report says so.
  fs.rmSync(paths.running)
  const untrusted = await restart()
  assert.equal(untrusted.report.rollback.base.source, null)
  assert.deepEqual(untrusted.seen, ['runtime v3 (broken)\n', 'runtime v3 (broken)\n'], 'sources left as they are')
  assert.equal(untrusted.report.rollback.treeRestored, false)
  assert.match(untrusted.report.error, /; sources left as they are \(no trustworthy rollback base\)$/)
  assert.match(untrusted.report.rollback.treeNote, /last-good is not that code/)
})

test('a renderer reload: no intent even when the plan carries one, not counted toward the cycle limit', async (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  const intentFile = path.join(base, 'pending-resume.json')
  const signals = []
  const system = {
    findOrbitProcesses: () => [{ pid: 7 }],
    killProcess: () => assert.fail('a reload stops nothing'),
    launch: (spec) => {
      signals.push(spec.args.slice(1))
      setTimeout(() => writeHealth(paths.health, { ok: true, pid: 7, startedAt: 1, restartedAt: Date.now(), writtenAt: Date.now(), level: 'renderer', generation: 2 }), 20)
      return 1
    },
  }
  const plan = { runId: 'up-3', level: 'renderer', candidate: null, lastGood: null, healthTimeoutMs: 5000, electron: 'electron.exe', running: [7], intent: { file: intentFile, record: { version: 1, id: 'up-3', runId: 'run-3' } }, report: { runId: 'up-3' } }
  const report = await runWatcher(plan, { paths, system })
  assert.deepEqual(signals, [['--reload-renderer']])
  assert.deepEqual([report.ok, report.status, report.level, report.intentWritten, report.health.generation], [true, 'relaunched', 'renderer', false, 2])
  assert.equal(fs.existsSync(intentFile), false)
  assert.equal(readCycles({ file: paths.cycles }).length, 0)
})

test('a renderer rollback puts src/ back only to what the window was running: the record of the healthy reload, never an older one', async (t) => {
  // Orbit (pid 300) starts healthy with src v0 (recorded); the agent's UI change v1 goes live by a healthy renderer
  // reload; the next change (v2, with a new component) fails the renderer check.
  const setup = () => {
    const { repo, git } = gitRepository(t)
    write(repo, { '.gitignore': 'artifacts/\ndist/\ndist-prev/\n', 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime\n', 'src/App.tsx': 'app v0\n', 'dist/index.html': 'build v0\n' })
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const paths = upgradePaths(repo)
    const code = fingerprints(repo)
    const instance = (renderer) => ({ pid: 300, startedAt: 5000, shellHash: code.shell, runtimeHash: code.runtime, rendererHash: renderer })
    assert.equal(upgrade.recordRunning({ paths, instance: instance(rendererHash(repo)) }).recorded, true, 'the start is recorded')
    write(repo, { 'src/App.tsx': 'app v1 (live, healthy)\n', 'dist/index.html': 'build v1\n' })
    // The health report of the reload: what the window runs now.
    return { repo, paths, live: instance(rendererHash(repo)) }
  }
  const failReload = async ({ repo, paths, live }) => {
    upgrade.saveDistPrev({ dist: paths.dist, prev: paths.distPrev })
    write(repo, { 'src/App.tsx': 'app v2 (broken)\n', 'src/Broken.tsx': 'a new broken component\n', 'dist/index.html': 'build v2\n' })
    const candidate = snapshotTree({ cwd: repo, label: 'candidate', fingerprint: { ...fingerprints(repo), renderer: rendererHash(repo) } })
    let launches = 0
    const system = {
      findOrbitProcesses: () => [{ pid: 300 }],
      killProcess: () => assert.fail('the reload of the previous build works: nothing is stopped'),
      launch: () => {
        launches++
        const ok = launches > 1
        setTimeout(() => writeHealth(paths.health, { ok, pid: 300, startedAt: 5000, restartedAt: Date.now(), writtenAt: Date.now(), level: 'renderer', ...(ok ? {} : { error: 'renderer did not mount' }) }), 20)
        return 1
      },
    }
    const plan = { runId: 'up', level: 'renderer', candidate, lastGood: null, previous: live, distPrevSaved: true, built: true, healthTimeoutMs: 5000, electron: 'electron.exe', running: [300], report: {} }
    const report = await runWatcher(plan, { paths, system })
    const read = (file) => (fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file), 'utf8').trim() : null)
    return { report, src: read('src/App.tsx'), component: read('src/Broken.tsx'), dist: read('dist/index.html') }
  }

  // Main records the healthy reload too: the rollback goes back to v1, the build and the sources of the live window.
  const recorded = setup()
  assert.equal(upgrade.recordRunning({ paths: recorded.paths, instance: recorded.live }).record.rendererHash, recorded.live.rendererHash)
  const back = await failReload(recorded)
  assert.deepEqual([back.report.status, back.report.rollback.base.source, back.report.rollback.treePaths], ['rolled-back', 'running', ['src']])
  assert.deepEqual([back.src, back.component, back.dist], ['app v1 (live, healthy)', null, 'build v1'], 'src/ and dist/ of the live window; the component the failed change added goes')
  assert.deepEqual(back.report.rollback.deleted, ['src/Broken.tsx'])
  assert.equal(back.report.error, 'the new Orbit reported a failure: renderer did not mount')
  assert.match(upgrade.summarize(back.report), /removed 1 file\(s\) the failed change added: src\/Broken\.tsx/)

  // Only the start was recorded, an older src/ than the window ran: src/ stays, only dist/ comes back — never v0.
  const stale = setup()
  const kept = await failReload(stale)
  assert.deepEqual([kept.src, kept.dist], ['app v2 (broken)', 'build v1'], 'never the src/ of the start (app v0)')
  assert.equal(kept.report.rollback.treeRestored, false)
  assert.equal(kept.report.error, `the new Orbit reported a failure: renderer did not mount; ${upgrade.NO_BASE_NOTE}`)
  assert.match(kept.report.rollback.treeNote, /the record of pid 300 is not the code it runs now/)

  // A window that reported no renderer hash (an Orbit that predates it): which src/ it ran is unknown, so src/ stays.
  const old = setup()
  assert.equal(upgrade.recordRunning({ paths: old.paths, instance: old.live }).recorded, true)
  const unknown = await failReload({ ...old, live: { ...old.live, rendererHash: null } })
  assert.deepEqual([unknown.src, unknown.dist, unknown.report.rollback.treeRestored], ['app v2 (broken)', 'build v1', false])
  assert.match(unknown.report.rollback.treeNote, /reported no renderer hash/)
})

test('a full rollback puts electron/ back from the record but leaves src/ when the window ran other renderer inputs, and the intent says so', async (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { '.gitignore': 'artifacts/\nprofile/\n', 'electron/main.cjs': 'shell v1\n', 'electron/runtime.mts': 'runtime v1\n', 'src/App.tsx': 'app v0\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const paths = upgradePaths(repo)
  const code = fingerprints(repo)
  const start = { pid: 400, startedAt: 7000, shellHash: code.shell, runtimeHash: code.runtime, rendererHash: rendererHash(repo) }
  assert.equal(upgrade.recordRunning({ paths, instance: start }).recorded, true)
  // A renderer reload made v1 live, and its record did not happen: the record still has v0.
  write(repo, { 'src/App.tsx': 'app v1\n' })
  const previous = { ...start, rendererHash: rendererHash(repo) }
  // The change that fails: the shell and the UI.
  write(repo, { 'electron/main.cjs': 'shell v2 (broken)\n', 'src/App.tsx': 'app v2\n' })
  const candidate = snapshotTree({ cwd: repo, label: 'candidate', fingerprint: { ...fingerprints(repo), renderer: rendererHash(repo) } })
  const intentFile = path.join(repo, 'profile', 'pending-resume.json')
  const record = resolveIntent({ env: { ORBIT_RUN_ID: 'run-7', ORBIT_RESUME_FILE: intentFile }, level: 'full', id: 'up-7' }).intent
  const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8').trim()
  let alive = [400]
  const seen = []
  const system = {
    findOrbitProcesses: () => alive.map((pid) => ({ pid })),
    killProcess: (pid) => { alive = alive.filter((other) => other !== pid); return true },
    launch: () => {
      seen.push({ shell: read('electron/main.cjs'), app: read('src/App.tsx') })
      const pid = 400 + seen.length
      const ok = seen.length > 1
      setTimeout(() => { alive = [pid]; writeHealth(paths.health, { ok, pid, startedAt: Date.now(), writtenAt: Date.now(), ...(ok ? {} : { error: 'main crashed' }) }) }, 20)
      return 1
    },
  }
  const report = await runWatcher({ runId: 'up-7', level: 'full', candidate, lastGood: null, previous, healthTimeoutMs: 5000, electron: 'electron.exe', intent: { file: intentFile, record }, report: {} }, { paths, system })
  assert.deepEqual(seen, [{ shell: 'shell v2 (broken)', app: 'app v2' }, { shell: 'shell v1', app: 'app v2' }], 'electron/ comes back, src/ stays')
  assert.deepEqual([report.rollback.base.source, report.rollback.treePaths, report.rollback.recovered], ['running', ['electron'], true])
  const note = 'src/ left as it is (no trustworthy rollback base)'
  assert.equal(report.error, `the new Orbit reported a failure: main crashed; ${note}`)
  assert.equal(readJsonFile(intentFile).error, report.error, 'the continuation hears it too')
  assert.match(report.rollback.treeNote, /a renderer reload since was not recorded/)
  assert.match(upgrade.summarize(report), /sources restored from running \(electron\); src\/ left as it is/)
})

test('restoreTree works in overlay mode: files created after the snapshot stay, whether untracked, staged or committed', (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime v1\n', 'src/App.tsx': 'app\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const base = snapshotTree({ cwd: repo, label: 'running' })
  // After the snapshot the user commits a module, stages another and leaves a third untracked; the runtime breaks.
  write(repo, { 'electron/committed.mts': 'user work, committed\n' })
  git('add', 'electron/committed.mts')
  git('commit', '-q', '-m', 'user work')
  write(repo, { 'electron/staged.mts': 'user work, staged\n', 'electron/untracked.mts': 'untracked\n', 'electron/runtime.mts': 'runtime v2 (broken)\n' })
  git('add', 'electron/staged.mts')
  const index = fs.readFileSync(path.join(repo, '.git', 'index'))
  const restored = restoreTree({ cwd: repo, commit: base.commit, paths: runtimeRestorePaths() })
  assert.equal(fs.readFileSync(path.join(repo, 'electron', 'runtime.mts'), 'utf8'), 'runtime v1\n')
  for (const file of ['committed.mts', 'staged.mts', 'untracked.mts']) assert.ok(fs.existsSync(path.join(repo, 'electron', file)), `${file} stays`)
  assert.deepEqual(restored.removed, [])
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index, 'the real index is not even rewritten')
  assert.equal(git('diff', '--cached', '--name-only'), 'electron/staged.mts', 'what the user staged stays staged')
})

test('the source restore never uses the real index: a held .git/index.lock does not stop it, and a failed attempt is retried', (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { 'electron/runtime.mts': 'runtime v1\n', 'src/App.tsx': 'app\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const base = snapshotTree({ cwd: repo, label: 'running' })
  const runtime = () => fs.readFileSync(path.join(repo, 'electron', 'runtime.mts'), 'utf8')
  write(repo, { 'electron/runtime.mts': 'runtime v2 (broken)\n' })
  // VS Code's git extension, or an agent's `git status`, holds the index lock (git restore failed with exit 128).
  const lock = path.join(repo, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  assert.equal(restoreTree({ cwd: repo, commit: base.commit, paths: ['electron'] }).attempts, 1)
  assert.equal(runtime(), 'runtime v1\n')
  assert.ok(fs.existsSync(lock), 'the other process\'s lock is left alone')
  // A file held open for a moment: the first attempt fails, the next one works.
  write(repo, { 'electron/runtime.mts': 'runtime v3 (broken)\n' })
  const failing = (times) => {
    let left = times
    return (args, options) => {
      if (args[0] === 'checkout-index' && left-- > 0) throw new Error('git checkout-index failed: error: unable to create file electron/runtime.mts: Permission denied')
      return upgrade.git(args, options)
    }
  }
  assert.equal(restoreTree({ cwd: repo, commit: base.commit, paths: ['electron'], retryMs: 10, runGit: failing(1) }).attempts, 2)
  assert.equal(runtime(), 'runtime v1\n')
  // One that keeps failing: its error, after the last attempt.
  write(repo, { 'electron/runtime.mts': 'runtime v4 (broken)\n' })
  assert.throws(() => restoreTree({ cwd: repo, commit: base.commit, paths: ['electron'], attempts: 2, retryMs: 10, runGit: failing(2) }), /Permission denied/)
  assert.equal(runtime(), 'runtime v4 (broken)\n')
})

test('a restore that fails is named in the report and in the intent\'s error: sources not restored', async (t) => {
  const { repo, git } = gitRepository(t)
  write(repo, { '.gitignore': 'profile/\n', 'electron/main.cjs': 'shell\n', 'electron/runtime.mts': 'runtime v1\n', 'src/App.tsx': 'app\n' })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const code = fingerprints(repo)
  const lastGood = snapshotTree({ cwd: repo, label: 'last-good', fingerprint: code }).commit
  write(repo, { 'electron/runtime.mts': 'runtime v2 (broken)\n' })
  const candidate = snapshotTree({ cwd: repo, label: 'candidate' })
  const paths = upgradePaths(repo)
  const intentFile = path.join(repo, 'profile', 'pending-resume.json')
  const record = resolveIntent({ env: { ORBIT_RUN_ID: 'run-5', ORBIT_RESUME_FILE: intentFile }, level: 'runtime', id: 'up-5' }).intent
  let signals = 0
  const system = {
    findOrbitProcesses: () => [{ pid: 500 }],
    killProcess: () => true,
    launch: () => {
      signals++
      const ok = signals > 1
      setTimeout(() => writeHealth(paths.health, { ok, pid: 500, startedAt: 1, restartedAt: Date.now(), writtenAt: Date.now(), ...(ok ? {} : { error: 'crash' }) }), 20)
      return 1
    },
    restoreTree: () => { throw new Error('git checkout-index failed: error: unable to create file electron/runtime.mts: Permission denied') },
  }
  const previous = { pid: 500, startedAt: 1, shellHash: code.shell, runtimeHash: code.runtime }
  const report = await runWatcher({ runId: 'up-5', level: 'runtime', candidate, lastGood, previous, healthTimeoutMs: 5000, electron: 'electron.exe', running: [500], intent: { file: intentFile, record }, report: {} }, { paths, system })
  const note = 'sources not restored (the restore of electron/ (runtime files) from last-good failed)'
  assert.equal(report.error, `the new Orbit reported a failure: crash; ${note}`)
  assert.equal(readJsonFile(intentFile).error, report.error)
  assert.deepEqual([report.rollback.treeRestored, report.rollback.sourcesNote], [false, note])
  assert.match(report.rollback.treeNote, /Permission denied/)
})

test('under npm run dev (ORBIT_DEV=1) the script restarts nothing: status dev-mode, exit 2; checks without a restart still run', (t) => {
  // A copy of the script in a temporary folder, so that its report never touches the repository's artifacts/.
  const copy = temporary(t, 'orbit-upgrade-dev-')
  for (const file of ['scripts/self-upgrade.cjs', 'electron/fingerprint.cjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(copy, file))
  }
  const script = (...args) => spawnSync(process.execPath, [path.join(copy, 'scripts', 'self-upgrade.cjs'), ...args], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, env: { ...process.env, ORBIT_DEV: '1' } })
  const refused = script('--no-verify')
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /restarting it would stop npm run dev/)
  const report = readJsonFile(path.join(copy, 'artifacts', 'self-upgrade-last.json'))
  assert.deepEqual([report.ok, report.status, report.nextAction, report.error], [false, 'dev-mode', 'restart-orbit-by-hand', upgrade.DEV_MODE_MESSAGE])
  assert.equal(fs.existsSync(path.join(copy, 'artifacts', 'self-upgrade.lock')), false, 'refused before the lock')
  // --verify-only restarts nothing: it goes past that check (and stops here only for want of the build tools).
  const checks = script('--verify-only')
  assert.notEqual(readJsonFile(path.join(copy, 'artifacts', 'self-upgrade-last.json')).status, 'dev-mode', checks.stderr)
})

test('the lock is kept fresh by its holder; one whose heartbeat stopped is stale whatever its pid; the restart host removes a killed script\'s lock', async (t) => {
  const base = temporary(t)
  const file = upgrade.lockFile(base)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const old = new Date(Date.now() - upgrade.LOCK_STALE_MS - 5000)
  // A holder killed with taskkill /f (its exit handler never ran) whose pid Windows gave to another process since.
  fs.writeFileSync(file, JSON.stringify({ version: 2, pid: process.pid, nonce: 'killed', role: 'upgrade', startedAt: Date.now() - 120000 }))
  fs.utimesSync(file, old, old)
  assert.equal(acquireLock(base, { heartbeatMs: 30 }), file, 'no heartbeat for over a minute: taken over although the pid lives')
  const mine = readJsonFile(file)
  assert.deepEqual([mine.version, mine.pid, mine.role, typeof mine.nonce, mine.nonce === 'killed'], [2, process.pid, 'upgrade', 'string', false])
  // The holder touches its lock: an old mtime is fresh again after a beat, and a second upgrade is refused.
  fs.utimesSync(file, old, old)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 5000, 'the heartbeat touched the lock')
  assert.throws(() => acquireLock(base), /already running/)
  // The foreground hands it over; the watcher takes over only the lock its plan names.
  const nonce = upgrade.heldLockNonce()
  assert.equal(nonce, mine.nonce)
  upgrade.handOverLock()
  assert.equal(upgrade.heldLockNonce(), null)
  assert.equal(upgrade.takeOverLock(base, { nonce: 'another', heartbeatMs: 30 }), false, 'not the lock of its plan')
  assert.equal(readJsonFile(file).nonce, nonce, 'left as it was')
  assert.equal(upgrade.takeOverLock(base, { nonce, heartbeatMs: 30 }), true)
  assert.deepEqual([readJsonFile(file).role, readJsonFile(file).pid], ['watcher', process.pid])
  assert.equal(upgrade.releaseLock(), true)
  assert.equal(fs.existsSync(file), false, 'released at the end')
  // The restart host, after it killed a script: only that script's lock goes.
  fs.writeFileSync(file, JSON.stringify({ version: 2, pid: 424242, nonce: 'n', role: 'upgrade', startedAt: Date.now() }))
  assert.equal(upgrade.releaseLockOf(111, base), false)
  assert.equal(fs.existsSync(file), true)
  assert.equal(upgrade.releaseLockOf(424242, base), true)
  assert.equal(fs.existsSync(file), false)
  assert.equal(upgrade.releaseLockOf(424242, base), false, 'nothing left to remove')
  // An older script's lock (no nonce, no heartbeat) counts while its process lives, for up to 45 minutes.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60000, role: 'upgrade' }))
  fs.utimesSync(file, old, old)
  assert.throws(() => acquireLock(base), /already running/)
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60 * 60 * 1000, role: 'upgrade' }))
  assert.equal(acquireLock(base, { heartbeatMs: 30 }), file, 'an hour old: stale')
  assert.equal(upgrade.releaseLock(), true)
})

test('a stop the user asked for calls the restart off right before the intent and the signal: status cancelled, no intent, nothing parked or counted', async (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  const intentFile = path.join(base, 'profile', 'pending-resume.json')
  const record = resolveIntent({ env: { ORBIT_RUN_ID: 'run-c', ORBIT_RESUME_FILE: intentFile }, level: 'runtime', id: 'up-c' }).intent
  writeHealth(paths.health, { ok: true, pid: 60, startedAt: 1, writtenAt: 2 })
  const system = { findOrbitProcesses: () => [{ pid: 60 }], killProcess: () => assert.fail('nothing is stopped'), launch: () => assert.fail('no signal after a stop') }
  const startedMs = Date.now()
  const plan = { runId: 'up-c', startedMs, level: 'runtime', candidate: null, lastGood: null, healthTimeoutMs: 2000, electron: 'electron.exe', running: [60], intent: { file: intentFile, record }, report: { runId: 'up-c' } }
  // The marker the restart host writes; one from before this run (the stop of an earlier one) does not count.
  assert.equal(upgrade.cancelRequested(paths, startedMs), null)
  upgrade.requestCancel('user-stop', base, startedMs - 1)
  assert.equal(upgrade.cancelRequested(paths, startedMs), null, 'an older stop')
  assert.deepEqual(readJsonFile(paths.cancel), { requestedAt: startedMs - 1, reason: 'user-stop' }, 'the marker format')
  upgrade.requestCancel('user-stop', base, startedMs + 5)
  assert.deepEqual(upgrade.cancelRequested(paths, startedMs), { requestedAt: startedMs + 5, reason: 'user-stop' })
  const report = await runWatcher(plan, { paths, system })
  assert.deepEqual([report.ok, report.status, report.nextAction, report.phase, report.intentWritten], [false, 'cancelled', 'none', 'done', false])
  assert.equal(report.error, 'cancelled (user-stop) before the restart: nothing was restarted')
  assert.equal(fs.existsSync(intentFile), false, 'no intent')
  assert.equal(fs.existsSync(paths.health), true, 'the health report is not parked')
  assert.equal(readCycles({ file: paths.cycles }).length, 0)
  assert.equal(readJsonFile(paths.report).status, 'cancelled')
  // A stop that lands between the intent and the signal: the intent written a moment before goes again.
  upgrade.clearCancel(base)
  assert.equal(fs.existsSync(paths.cancel), false)
  const { renameSync } = fs
  fs.renameSync = function (from, to) {
    const result = renameSync.call(this, from, to)
    if (to === intentFile) upgrade.requestCancel('user-stop', base)
    return result
  }
  let late
  try { late = await runWatcher(plan, { paths, system }) } finally { fs.renameSync = renameSync }
  assert.deepEqual([late.status, late.intentWritten, late.intentWithdrawn], ['cancelled', false, true])
  assert.equal(fs.existsSync(intentFile), false, 'withdrawn')
  // The foreground looks at every step boundary: a stop ends the run before the next step starts.
  const ran = []
  let stop = null
  const { timings, step } = createTimer(() => {}, (name) => { if (stop) throw new upgrade.CancelledError(stop, `before the step ${name}`) })
  await step('typecheck', () => ran.push('typecheck'))
  stop = { requestedAt: Date.now(), reason: 'user-stop' }
  await assert.rejects(step('test', () => ran.push('test')), /^CancelledError: cancelled \(user-stop\) before the step test: nothing was restarted$/)
  assert.deepEqual([ran, timings.map((entry) => entry.step)], [['typecheck'], ['typecheck']])
})

test('the watcher takes over only the lock its plan names: a lock the restart host released after a stop means nothing restarts', async (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  const planFile = path.join(paths.artifacts, 'self-upgrade-plan.json')
  const signals = []
  const system = {
    findOrbitProcesses: () => [{ pid: 70 }],
    killProcess: () => assert.fail('nothing is stopped'),
    launch: () => {
      signals.push(readJsonFile(upgrade.lockFile(base)).role)
      setTimeout(() => writeHealth(paths.health, { ok: true, pid: 70, startedAt: 1, restartedAt: Date.now(), writtenAt: Date.now(), level: 'renderer' }), 20)
      return 1
    },
  }
  const plan = { runId: 'up-w', startedMs: Date.now(), level: 'renderer', candidate: null, lastGood: null, healthTimeoutMs: 3000, electron: 'electron.exe', running: [70], lockNonce: 'handed-over', report: { runId: 'up-w' } }
  write(paths.artifacts, { 'self-upgrade-plan.json': JSON.stringify(plan) })
  // The foreground was stopped and its lock released (releaseLockOf): nothing to take over.
  assert.equal(await upgrade.watch(planFile, { paths, system }), null)
  assert.deepEqual(signals, [])
  assert.deepEqual([readJsonFile(paths.report).status, readJsonFile(paths.report).runId], ['cancelled', 'up-w'])
  // The lock the foreground handed over: taken, held while the watcher works, released at the end.
  write(paths.artifacts, { 'self-upgrade.lock': JSON.stringify({ version: 2, pid: 1, nonce: 'handed-over', role: 'upgrade', startedAt: Date.now() }) })
  const report = await upgrade.watch(planFile, { paths, system })
  assert.deepEqual([report.status, signals], ['relaunched', ['watcher']])
  assert.equal(fs.existsSync(upgrade.lockFile(base)), false, 'released at the end')
  assert.match(fs.readFileSync(paths.watchLog, 'utf8'), /watcher \d+ started for run up-w/)
})

test('two Orbit instances of one repository: ORBIT_USER_DATA names the instance, a health report of another profile does not decide the level', (t) => {
  const base = temporary(t)
  const paths = upgradePaths(base)
  const [profileA, profileB] = [path.join(base, 'profile-a'), path.join(base, 'profile-b')]
  const health = { ok: true, pid: 80, startedAt: 1, writtenAt: 2, shellHash: 'S', runtimeHash: 'R', rendererHash: 'H', distMtime: 5, userData: profileB }
  writeHealth(paths.health, health)
  const system = { findOrbitProcesses: () => [{ pid: 80 }, { pid: 81 }] }
  const decide = (seen) => decideLevel({ running: true, health: seen.runningHealth, healthNote: seen.healthNote, fingerprint: { shell: 'S', runtime: 'R' }, rendererInputs: 'H', distMtime: 5 })
  const other = upgrade.observeOrbit({ paths, system, userData: profileA })
  assert.equal(other.runningHealth, null)
  assert.ok(other.healthNote.includes(profileB) && other.healthNote.includes(`ORBIT_USER_DATA ${profileA}`), other.healthNote)
  assert.deepEqual(decide(other), { level: 'full', reason: other.healthNote }, 'its hashes say nothing about the instance that asked: a full restart, and the report says why')
  assert.match(upgrade.rollbackBase({ previous: null, unknown: other.healthNote }).reason, /another Orbit instance/, 'nor does a rollback take it for the code that ran')
  // The instance's own report (the same folder, however it is spelled) counts, and so does any report without the variable.
  const spelled = process.platform === 'win32' ? `${profileB.toUpperCase()}\\` : `${profileB}/`
  const own = upgrade.observeOrbit({ paths, system, userData: spelled })
  assert.deepEqual([own.runningHealth, own.healthNote], [health, null])
  assert.equal(decide(own).level, 'none')
  assert.deepEqual(upgrade.observeOrbit({ paths, system }).runningHealth, health)
})

test('npm run build leaves a build record (--mark-build): the next self-upgrade skips the build, but still runs the checks', (t) => {
  const root = write(temporary(t), { 'src/App.tsx': 'app\n', 'index.html': '<div id="root"></div>\n', 'package.json': '{}\n', 'electron/main.cjs': 'shell\n' })
  const dist = path.join(root, 'dist')
  assert.deepEqual(upgrade.markBuild({ base: root }), { marked: false, reason: 'dist/index.html is missing: nothing was built' })
  const at = (file, seconds) => { const time = new Date(Date.now() + seconds * 1000); fs.utimesSync(path.join(root, file), time, time) }
  for (const file of ['src/App.tsx', 'index.html', 'package.json']) at(file, -60)
  write(root, { 'dist/index.html': 'built\n' })
  const result = upgrade.markBuild({ base: root, now: '2026-09-30T12:00:00.000Z' })
  assert.equal(result.marked, true, result.reason)
  const marker = readBuildMarker(dist)
  assert.deepEqual([marker.version, marker.rendererHash, marker.verified, marker.builtBy, marker.builtAt], [2, rendererHash(root), null, 'npm run build', '2026-09-30T12:00:00.000Z'])
  const renderer = rendererState(root)
  assert.equal(buildDecision({ marker, renderer }).needed, false, 'the build is up to date with its inputs')
  assert.equal(verifyDecision({ marker, fingerprint: fingerprints(root), renderer }).needed, true, 'a hand build vouches for no checks')
  // An input edited after the build: no record, so the next self-upgrade builds again.
  at('src/App.tsx', 60)
  assert.match(upgrade.markBuild({ base: root }).reason, /src[\\/]App\.tsx changed after dist\/ was built/)
  assert.equal(readBuildMarker(dist), null, 'the record is removed')
  assert.match(require('../package.json').scripts.build, /vite build && node scripts\/self-upgrade\.cjs --mark-build$/, 'npm run build runs it after vite build')
})

test('the level by renderer hash: dist/ rebuilt from the inputs the window already runs needs no reload, so a runtime change stays a runtime restart', () => {
  const fingerprint = { shell: 'S1', runtime: 'R1' }
  const health = { ok: true, pid: 10, startedAt: 1, writtenAt: 2, shellHash: 'S1', runtimeHash: 'R1', rendererHash: 'H1', distMtime: 500, runtime: { mode: 'child' } }
  const decide = (overrides = {}) => decideLevel({ forced: 'auto', running: true, health, fingerprint, rendererInputs: 'H1', distMtime: 500, willBuild: false, ...overrides })
  const runtimeChanged = { fingerprint: { shell: 'S1', runtime: 'R2' } }
  assert.deepEqual(decide({ ...runtimeChanged, willBuild: true }), { level: 'runtime', reason: 'runtime files changed' }, 'no build record (a dist/ of npm run build): rebuilt, but from what the window runs')
  assert.deepEqual(decide({ willBuild: true }), { level: 'none', reason: 'the running Orbit already runs these sources' }, 'nothing changed: nothing to apply, whatever the build record says')
  assert.equal(decide({ distMtime: 600 }).level, 'none', 'dist/ rebuilt from the same inputs')
  assert.deepEqual(decide({ rendererInputs: 'H2', willBuild: true }), { level: 'renderer', reason: 'the renderer inputs differ from the ones the window runs: the renderer is rebuilt' })
  assert.equal(decide({ rendererInputs: 'H2' }).level, 'renderer', 'dist/ already built from the new inputs (by hand, with its record)')
  assert.equal(decide({ ...runtimeChanged, rendererInputs: 'H2' }).level, 'full', 'runtime and renderer changed')
  // A report without the hash (an Orbit that predates it): the build record and dist/ decide, as before.
  const legacy = { ...health, rendererHash: undefined }
  assert.equal(decide({ ...runtimeChanged, health: legacy, willBuild: true }).level, 'full')
  assert.equal(decide({ health: legacy, willBuild: true }).level, 'renderer')
  assert.equal(decide({ health: legacy }).level, 'none')
})

test('the rollback base part by part: src/ only from a snapshot with the renderer hash the window reported', () => {
  const previous = { pid: 10, startedAt: 1000, shellHash: 'S', runtimeHash: 'R', rendererHash: 'H1' }
  const record = { commit: 'rec', pid: 10, startedAt: 1000, shellHash: 'S', runtimeHash: 'R', rendererHash: 'H1', recordedAt: 'then' }
  const lastGood = { commit: 'lg', shellHash: 'S', runtimeHash: 'R', rendererHash: 'H1' }
  const base = (input) => { const result = upgrade.rollbackBase(input); return [result.source, result.parts, result.skipped] }
  assert.deepEqual(base({ running: record, previous }), ['running', ['electron', 'src'], []])
  assert.deepEqual(base({ running: record, previous, parts: ['electron'] }), ['running', ['electron'], []], 'a runtime rollback asks for electron/ only')
  const beforeReload = { ...record, rendererHash: 'H0' }
  assert.deepEqual(base({ running: beforeReload, previous }), ['running', ['electron'], ['src']], 'a record from before a renderer reload: electron/ only')
  assert.match(upgrade.rollbackBase({ running: beforeReload, previous }).skippedReason, /a renderer reload since was not recorded/)
  assert.deepEqual(base({ running: beforeReload, previous, lastGood }), ['last-good', ['electron', 'src'], []], 'a last-good that is exactly the running code covers both')
  assert.deepEqual(base({ running: beforeReload, previous, lastGood: { ...lastGood, shellHash: 'S0' } }), ['running', ['electron'], ['src']], 'as many parts each: the record first')
  assert.deepEqual(base({ running: beforeReload, previous, parts: ['src'] }), [null, [], ['src']])
  assert.deepEqual(base({ running: { ...record, rendererHash: null }, previous, parts: ['src'] }), [null, [], ['src']], 'a record without a renderer hash never puts src/ back')
  assert.deepEqual(base({ running: record, previous: { ...previous, rendererHash: null }, parts: ['src'] }), [null, [], ['src']])
  assert.match(upgrade.rollbackBase({ running: record, previous: { ...previous, rendererHash: null }, parts: ['src'] }).reason, /reported no renderer hash/)
})
