'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const upgrade = require('../scripts/self-upgrade.cjs')
const { readBuildMarker, writeBuildMarker, isFreshHealth, waitForHealth, snapshotTree, readRef, readCycles, createTimer } = upgrade
const { DEFAULT_REASON, DEFAULT_CONTINUE_WITH, upgradePaths, decideLevel, resolveIntent, writeIntent, runtimeRestorePaths, runWatcher } = upgrade
const { fingerprints, rendererHash } = require('../electron/fingerprint.cjs')
const { temporary, write, readJsonFile, writeHealth, gitRepository } = require('./helpers-upgrade.cjs')

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
