'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const upgrade = require('../scripts/self-upgrade.cjs')
const { snapshotTree, upgradePaths, runWatcher } = upgrade
const { fingerprints, rendererHash } = require('../electron/fingerprint.cjs')
const { write, writeHealth, gitRepository } = require('./helpers-upgrade.cjs')

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
