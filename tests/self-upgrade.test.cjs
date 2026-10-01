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
const { newestSourceChange, readBuildMarker, writeBuildMarker, toolPath, toolchain, planSteps, snapshotTree, restoreTree, readRef, saveDistPrev, restoreDistPrev, orbitLaunch, matchesOrbitProcess, readCycles, recordCycle, cycleLimitReached, acquireLock, createTimer } = upgrade
const { LEVEL_FLAGS, RENDERER_INPUTS, parseArgs, upgradePaths, rendererState, buildDecision, verifyDecision, nextBuildMarker, decideLevel, runtimeRestorePaths } = upgrade
const { fingerprints, rendererHash } = require('../electron/fingerprint.cjs')
const { temporary, write, readJsonFile, writeHealth, gitRepository } = require('./helpers-upgrade.cjs')

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

test('the health report is read where main writes it: ORBIT_HEALTH_FILE names the file, and with "0" (no report) nothing restarts', (t) => {
  // A test's paths ignore the environment; the script's own follow ORBIT_HEALTH_FILE the way electron/main.cjs does.
  const base = temporary(t)
  const custom = path.join(base, 'elsewhere', 'health.json')
  const files = (env) => [upgradePaths(base, env).health, upgradePaths(base, env).healthPrev]
  const ambient = process.env.ORBIT_HEALTH_FILE
  process.env.ORBIT_HEALTH_FILE = '0' // as in the commands of an Orbit started with it
  try { assert.deepEqual(files(), [path.join(base, 'artifacts', 'self-upgrade-health.json'), path.join(base, 'artifacts', 'self-upgrade-health-prev.json')]) } finally {
    if (ambient === undefined) delete process.env.ORBIT_HEALTH_FILE
    else process.env.ORBIT_HEALTH_FILE = ambient
  }
  assert.deepEqual(files({ ORBIT_HEALTH_FILE: custom }), [custom, path.join(base, 'elsewhere', 'health-prev.json')])
  assert.deepEqual(files({ ORBIT_HEALTH_FILE: path.join('elsewhere', 'health.json') }), [custom, path.join(base, 'elsewhere', 'health-prev.json')], 'a relative path is from the repository, as main resolves it')
  for (const value of ['0', '']) assert.deepEqual(files({ ORBIT_HEALTH_FILE: value }), [null, null])
  const none = upgrade.observeOrbit({ paths: upgradePaths(base, { ORBIT_HEALTH_FILE: '0' }), system: { findOrbitProcesses: () => [{ pid: 80 }] } })
  assert.deepEqual([none.health, none.runningHealth, none.healthNote], [null, null, 'Orbit writes no health report (ORBIT_HEALTH_FILE=0)'])
  assert.deepEqual(decideLevel({ running: true, health: none.runningHealth, healthNote: none.healthNote, fingerprint: { shell: 'S', runtime: 'R' } }), { level: 'full', reason: none.healthNote })

  // The script itself, from a copy in a temporary folder (its report never touches the repository's artifacts/).
  const copy = temporary(t, 'orbit-upgrade-health-')
  for (const file of ['scripts/self-upgrade.cjs', 'electron/fingerprint.cjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(copy, file))
  }
  const script = (healthFile, ...args) => spawnSync(process.execPath, [path.join(copy, 'scripts', 'self-upgrade.cjs'), ...args], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, env: { ...process.env, ORBIT_DEV: '', ORBIT_HEALTH_FILE: healthFile } })
  const report = () => readJsonFile(path.join(copy, 'artifacts', 'self-upgrade-last.json'))
  const elsewhere = path.join(copy, 'profile', 'health.json')
  writeHealth(elsewhere, { ok: true, pid: 4242, startedAt: 1, writtenAt: 2 })
  writeHealth(path.join(copy, 'artifacts', 'self-upgrade-health.json'), { ok: true, pid: 1717, startedAt: 1, writtenAt: 2 })
  const planned = script(elsewhere, '--dry-run')
  assert.deepEqual([report().healthFile, report().health?.pid], [elsewhere, 4242], planned.stderr)
  const refused = script('0', '--no-verify')
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /ORBIT_HEALTH_FILE=0/)
  assert.deepEqual([report().ok, report().status, report().nextAction, report().error], [false, 'no-health-report', 'restart-orbit-by-hand', upgrade.NO_HEALTH_MESSAGE])
  assert.equal(fs.existsSync(path.join(copy, 'artifacts', 'self-upgrade.lock')), false, 'refused before the lock')
  // Runs that restart nothing go past that check (and stop here only for want of the build tools).
  const dry = script('0', '--dry-run')
  assert.deepEqual([report().mode, report().healthFile, report().health, report().healthNote], ['dry-run', null, null, none.healthNote], dry.stderr)
  for (const flag of ['--no-relaunch', '--verify-only']) {
    fs.rmSync(path.join(copy, 'artifacts', 'self-upgrade-last.json'))
    const checks = script('0', flag)
    assert.notEqual(checks.status, 2, `${flag}: ${checks.stderr}`)
    assert.notEqual(report().status, 'no-health-report', `${flag}: ${checks.stderr}`)
  }
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

// node:test's TAP as a check prints it: the YAML block quotes its values with util.inspect.
function tapFailures(base) {
  const { inspect } = require('node:util')
  const at = (file, line) => inspect(`${path.join(base, file)}:${line}:3`)
  return [
    'TAP version 13', '# Subtest: passes', 'ok 1 - passes', '  ---', '  duration_ms: 0.5', '  ...',
    '# Subtest: group', '    # Subtest: inner fails', '    not ok 1 - inner fails', '      ---',
    `      location: ${at(path.join('tests', 'a.test.cjs'), 5)}`, "      failureType: 'testCodeFailure'", `      error: ${inspect("it's 1, not 2")}`,
    '      stack: |-', '        TestContext.<anonymous> (a.test.cjs:5:46)', '      ...', '    1..1',
    'not ok 2 - group', '  ---', `  location: ${at(path.join('tests', 'a.test.cjs'), 4)}`, "  failureType: 'subtestsFailed'", "  error: '1 subtest failed'", '  ...',
    'not ok 3 - later # TODO', '  ---', "  failureType: 'testCodeFailure'", '  ...',
    'not ok 4 - multi-line error', '  ---', `  location: ${at(path.join('tests', 'b.test.cjs'), 9)}`, "  failureType: 'testCodeFailure'", '  error: |-', '    Expected values to be strictly equal:', '    ', '    1 !== 2', '  ...',
    '1..4', '# fail 2',
  ].join('\r\n')
}

test('a failed check names what failed: TAP not ok entries with error and place, and TypeScript errors', () => {
  const base = path.join(os.tmpdir(), 'orbit-repo')
  const collector = upgrade.failureCollector(base)
  const text = tapFailures(base)
  // Chunks cut through lines, a multi-byte character and a line ending.
  for (const chunk of [text.slice(0, 57), text.slice(57, 300), text.slice(300)]) collector.feed(Buffer.from(chunk))
  collector.feed(Buffer.from('\nsrc/App.tsx(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n'))
  collector.feed('error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline.\n')
  const split = Buffer.from('electron/x.mts:3:1 - error TS2304: Cannot find name \'é\'.')
  collector.feed(split.subarray(0, split.length - 3)); collector.feed(split.subarray(split.length - 3))
  const { failures, total } = collector.result()
  assert.equal(total, 5, 'a parent whose subtest failed and a TODO test do not count')
  assert.deepEqual(failures, [
    { name: 'inner fails', error: "it's 1, not 2", location: 'tests/a.test.cjs:5:3' },
    { name: 'multi-line error', error: 'Expected values to be strictly equal:', location: 'tests/b.test.cjs:9:3' },
    { name: 'src/App.tsx:12:5', error: "TS2322: Type 'string' is not assignable to type 'number'." },
    { name: 'tsc', error: 'TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline.' },
    { name: 'electron/x.mts:3:1', error: "TS2304: Cannot find name 'é'." },
  ])
  const limited = upgrade.failureCollector(base, 1)
  limited.feed(text)
  assert.deepEqual(limited.result(), { failures: [failures[0]], total: 2 })
  assert.deepEqual(upgrade.failureSummary({ failures: [failures[0]], failuresTotal: 2, checksLog: 'L' }), [
    'Failed: 2, the first 1:', "  - inner fails — it's 1, not 2 (tests/a.test.cjs:5:3)", 'Whole output of the checks: L',
  ])
  assert.deepEqual(upgrade.failureSummary({}), [])
})

test('a check passes its output through, appends it to the log and rejects with what failed', async (t) => {
  const dir = temporary(t)
  const log = upgrade.startChecksLog(path.join(dir, 'artifacts', 'checks.log'), 'run-1')
  const sink = () => { const seen = []; return { seen, write: (chunk) => { seen.push(String(chunk)) } } }
  const stdout = sink(), stderr = sink()
  const script = `process.stdout.write(${JSON.stringify(tapFailures(dir))}); process.stderr.write('some warning\\n'); process.exitCode = 1`
  await assert.rejects(upgrade.run('test', process.execPath, ['-e', script], { log, cwd: dir, stdout, stderr }), (error) => {
    assert.equal(error.message, 'test exited with 1 (2 failed: inner fails, multi-line error)')
    assert.equal(error.failuresTotal, 2)
    assert.deepEqual(error.failures.map((item) => item.location), ['tests/a.test.cjs:5:3', 'tests/b.test.cjs:9:3'])
    return true
  })
  await upgrade.run('smoke', process.execPath, ['-e', 'console.log("all good")'], { log, cwd: dir, stdout, stderr })
  assert.match(stdout.seen.join(''), /not ok 1 - inner fails[\s\S]*all good/)
  assert.equal(stderr.seen.join(''), 'some warning\n')
  const written = fs.readFileSync(log, 'utf8')
  assert.match(written, /^Orbit self-upgrade run-1: /)
  assert.match(written, /\n==> test\n[\s\S]*not ok 4 - multi-line error[\s\S]*some warning\n[\s\S]*\n==> smoke\nall good/)
  // Without a log the step still runs and reports.
  await assert.rejects(upgrade.run('typecheck', process.execPath, ['-e', 'process.exit(2)'], { cwd: dir, stdout, stderr }), { message: 'typecheck exited with 2', failuresTotal: 0 })
})
