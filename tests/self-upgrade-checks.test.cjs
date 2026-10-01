'use strict'

// The checks of scripts/self-upgrade.cjs run side by side (runChecks): they really overlap, each one's output is its own
// section, the first failure or the user's stop ends all the others (their process trees too), and the report keeps the
// step names. The checks here are small `node -e` scripts; the barrier ones only pass when their partner runs at the same time.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const upgrade = require('../scripts/self-upgrade.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-checks-'))
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    // A hanging check that a failed test left running must not outlive it.
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
      try { for (const pid of Object.values(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))) process.kill(pid) } catch { /* Gone already. */ }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return dir
}

/** Where a check's output goes: the console (one sink for stdout and stderr, and the heading lines) and what it said. */
function console_() {
  const text = []
  const sink = { write: (chunk) => { text.push(String(chunk)) } }
  return { stdout: sink, stderr: sink, say: (line) => { text.push(`${line}\n`) }, lines: () => text.join('').split('\n') }
}

/** A check that starts, waits for the file of its partner (so it passes only when the partner runs at the same time) and prints. */
function barrier(dir, mine, other, prefix) {
  return `
    const fs = require('fs'), wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    fs.writeFileSync(${JSON.stringify(path.join(dir, mine))}, '1')
    const end = Date.now() + 15000
    while (!fs.existsSync(${JSON.stringify(path.join(dir, other))})) { if (Date.now() > end) { console.error('no partner ran at the same time'); process.exit(3) } wait(10) }
    for (let index = 0; index < 6; index++) { console.log('${prefix} line ' + index); wait(25) }`
}

/** A check that records its pid and the pid of a process it started, then never ends by itself. */
function hanging(dir, name) {
  return `
    const fs = require('fs'), { spawn } = require('child_process')
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync(${JSON.stringify(path.join(dir, name))}, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }))
    setInterval(() => {}, 1000)`
}

/** Waits for a file the hanging check writes: the pids of its tree. */
async function pidsOf(dir, name) {
  const file = path.join(dir, name)
  for (let waited = 0; waited < 15000; waited += 25) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { await sleep(25) }
  }
  throw new Error(`${name} never started`)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
async function allGone(pids, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (pids.every((pid) => !alive(pid))) return true
    await sleep(50)
  }
  return false
}
/** What must be gone after a stop: the check itself and, where the whole tree is ended (Windows), what it started. */
const treeOf = (pids) => (process.platform === 'win32' ? [pids.pid, pids.grandchild] : [pids.pid])

test('the checks are the report\'s steps, typecheck covering both tsconfig files, and the full test run is every tests/*.test.cjs', () => {
  const steps = upgrade.checkSteps({ tools: { tsc: 'tsc.js' } })
  assert.deepEqual(steps.map((step) => step.name), [...upgrade.CHECKS_TOGETHER])
  assert.deepEqual(upgrade.planSteps({ verify: true, build: false, noRelaunch: true }).slice(0, steps.length), steps.map((step) => step.name), 'the plan lists them in the same order')
  assert.deepEqual(steps[0].commands.map((item) => [item.label, item.args]), [['typecheck', ['tsc.js', '--noEmit']], ['typecheck:main', ['tsc.js', '-p', 'tsconfig.main.json']]])
  const byName = Object.fromEntries(steps.map((step) => [step.name, step.commands.map((item) => item.args)]))
  assert.deepEqual(byName.test[0].slice(0, 3), ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test'])
  assert.deepEqual(byName.test[0].slice(3), upgrade.testFiles(), 'every test file, main-load included')
  assert.deepEqual(byName.smoke[0].slice(2), [path.join('scripts', 'smoke-runtime.cjs')])
  assert.deepEqual(byName['main-load'][0].slice(2), ['--test', path.join('tests', 'main-load.test.cjs')])
  assert.deepEqual(upgrade.planSteps({ verify: true, desktop: true, build: false, noRelaunch: true }), [...upgrade.CHECKS_TOGETHER, 'smoke:desktop'], 'smoke:desktop is not one of the checks that run at once: it comes after them')
})

test('checks run at the same time, each output is its own section in the console and the log, and the timings keep the step order', async (t) => {
  const dir = temporary(t)
  const out = console_()
  const log = path.join(dir, 'checks.log')
  const timings = []
  const result = await upgrade.runChecks([
    { name: 'first', commands: [{ label: 'first', args: ['-e', barrier(dir, 'first.flag', 'second.flag', 'first')] }] },
    { name: 'second', commands: [{ label: 'second', args: ['-e', barrier(dir, 'second.flag', 'first.flag', 'second')] }, { label: 'second:more', args: ['-e', 'console.log("more output")'] }] },
  ], { timings, log, cwd: os.tmpdir(), ...out, heartbeatMs: 0 })
  assert.ok(result.wallMs > 0)
  // Neither barrier passes unless the other runs meanwhile; and the lines of a check are never mixed with another's.
  for (const text of [out.lines().join('\n'), fs.readFileSync(log, 'utf8')]) {
    const order = text.split('\n').filter((line) => /^(first|second) line \d$/.test(line)).map((line) => line.split(' ')[0])
    assert.equal(order.length, 12)
    assert.match(order.join(','), /^(first,){5}first,(second,){5}second$|^(second,){5}second,(first,){5}first$/, 'one section after the other')
    for (const label of ['first', 'second', 'second:more']) assert.equal(text.split('\n').filter((line) => line === `==> ${label}`).length, 1, `${label} has one section`)
  }
  assert.match(fs.readFileSync(log, 'utf8'), /\n==> first\nfirst line 0\n[\s\S]*first line 5\n\(first ok, [\d.]+ s\)\n/)
  assert.match(out.lines().join('\n'), /==> first, second: side by side\n[\s\S]*Checks done in [\d.]+ s \(one after another: [\d.]+ s\)/)
  assert.deepEqual(timings.map((entry) => [entry.step, entry.ok]), [['first', true], ['second', true]], 'in the order of the steps, whichever ended first')
  assert.ok(timings.every((entry) => Number.isInteger(entry.ms) && entry.ms >= 0 && !('stopped' in entry) && !('error' in entry)))
})

test('a failing check fails the run with what failed, stops the checks still running — their process trees too — and marks them stopped', async (t) => {
  const dir = temporary(t)
  const out = console_()
  const log = path.join(dir, 'checks.log')
  const timings = []
  const failing = `
    const fs = require('fs')
    const end = Date.now() + 15000
    const started = () => ['slow.json', 'fine.json'].every((name) => fs.existsSync(require('path').join(${JSON.stringify(dir)}, name)))
    while (!started()) { if (Date.now() > end) process.exit(3); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
    console.log('TAP version 13')
    console.log('not ok 1 - boom')
    console.log('  ---')
    console.log("  error: 'it broke'")
    console.log("  failureType: 'testCodeFailure'")
    console.log('  ...')
    process.exitCode = 1`
  const began = Date.now()
  await assert.rejects(upgrade.runChecks([
    { name: 'slow', commands: [{ label: 'slow', args: ['-e', hanging(dir, 'slow.json')] }] },
    { name: 'bad', commands: [{ label: 'bad', args: ['-e', failing] }] },
    { name: 'fine', commands: [{ label: 'fine', args: ['-e', hanging(dir, 'fine.json')] }] },
  ], { timings, log, cwd: os.tmpdir(), ...out, heartbeatMs: 0 }), (error) => {
    assert.equal(error.message, 'bad exited with 1 (1 failed: boom)')
    assert.equal(error.failuresTotal, 1)
    assert.deepEqual(error.failures, [{ name: 'boom', error: 'it broke' }])
    return true
  })
  assert.ok(Date.now() - began < 15000, 'the others were stopped, not waited for')
  const trees = [treeOf(await pidsOf(dir, 'slow.json')), treeOf(await pidsOf(dir, 'fine.json'))].flat()
  assert.equal(await allGone(trees), true, 'no process of a stopped check is left running')
  assert.deepEqual(timings.map((entry) => [entry.step, entry.ok, entry.stopped === true]), [['slow', false, true], ['bad', false, false], ['fine', false, true]])
  assert.equal(timings[1].error, 'bad exited with 1 (1 failed: boom)')
  assert.equal(timings[0].error, 'stopped: bad exited with 1 (1 failed: boom)')
  // The failed check's section is on the console; a stopped one's is kept in the log only, marked as stopped.
  const shown = out.lines().join('\n')
  assert.match(shown, /==> bad\nTAP version 13\nnot ok 1 - boom[\s\S]*\(bad FAILED, [\d.]+ s\)/)
  assert.doesNotMatch(shown, /^==> (slow|fine)$/m)
  const written = fs.readFileSync(log, 'utf8')
  assert.match(written, /\n==> bad\n[\s\S]*\(bad FAILED, [\d.]+ s\)\n/)
  assert.match(written, /\n==> slow\n\(slow stopped, [\d.]+ s\)\n/)
  assert.match(written, /\n==> fine\n\(fine stopped, [\d.]+ s\)\n/)
  assert.match(upgrade.summarize({ status: 'failed', timings, ok: false, error: 'x', nextAction: 'fix' }), /stop slow\s+\d+ ms\n  FAIL bad\s+\d+ ms\n  stop fine/, 'the summary tells a stopped step from a failed one')
})

test('the user\'s stop is looked for while the checks run: it ends every one of them, process trees too, and is what the run fails with', async (t) => {
  const dir = temporary(t)
  const out = console_()
  const timings = []
  const stop = { reason: 'user-stop', requestedAt: Date.now() }
  let polls = 0
  const shouldStop = () => {
    polls++
    if (fs.existsSync(path.join(dir, 'one.json')) && fs.existsSync(path.join(dir, 'two.json'))) throw new upgrade.CancelledError(stop, 'while the checks were running')
  }
  const began = Date.now()
  await assert.rejects(upgrade.runChecks([
    { name: 'one', commands: [{ label: 'one', args: ['-e', hanging(dir, 'one.json')] }] },
    { name: 'two', commands: [{ label: 'two', args: ['-e', hanging(dir, 'two.json')] }] },
  ], { timings, cwd: os.tmpdir(), ...out, shouldStop, pollMs: 20, heartbeatMs: 0 }), (error) => {
    assert.ok(error instanceof upgrade.CancelledError)
    assert.equal(error.message, 'cancelled (user-stop) while the checks were running: nothing was restarted')
    assert.equal(error.stop, stop)
    return true
  })
  assert.ok(polls >= 2 && Date.now() - began < 15000)
  assert.equal(await allGone([...treeOf(await pidsOf(dir, 'one.json')), ...treeOf(await pidsOf(dir, 'two.json'))]), true, 'nothing keeps running after the stop')
  assert.deepEqual(timings.map((entry) => [entry.step, entry.ok, entry.stopped]), [['one', false, true], ['two', false, true]])
  assert.match(timings[0].error, /^stopped: cancelled \(user-stop\) while the checks were running/)
  assert.doesNotMatch(out.lines().join('\n'), /^==> (one|two)$/m, 'a stopped check prints no section')
})

test('a check that cannot start fails the run like any other and stops the rest; a stop before a check starts spawns nothing', async (t) => {
  const dir = temporary(t)
  const out = console_()
  const timings = []
  await assert.rejects(upgrade.runChecks([
    { name: 'hung', commands: [{ label: 'hung', args: ['-e', hanging(dir, 'hung.json')] }] },
    { name: 'missing', commands: [{ label: 'missing', command: path.join(dir, 'no-such-program'), args: [] }] },
  ], { timings, cwd: os.tmpdir(), ...out, heartbeatMs: 0 }), { code: 'ENOENT' })
  assert.deepEqual(timings.map((entry) => [entry.step, entry.ok, entry.stopped === true]), [['hung', false, true], ['missing', false, false]])
  assert.match(timings[1].error, /ENOENT/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(upgrade.run('late', path.join(dir, 'no-such-program'), [], { signal: aborted.signal, stdout: out.stdout, stderr: out.stderr }), { stopped: true, message: 'late stopped' }, 'an aborted signal stops it before a process is spawned (a spawn would fail with ENOENT)')
})

test('while checks run the console hears of the ones still running; a check that is done is left out', async (t) => {
  const dir = temporary(t)
  const out = console_()
  await upgrade.runChecks([
    { name: 'long', commands: [{ label: 'long', args: ['-e', 'setTimeout(() => {}, 900)'] }] },
    { name: 'short', commands: [{ label: 'short', args: ['-e', ''] }] },
  ], { cwd: os.tmpdir(), ...out, heartbeatMs: 150 })
  const beats = out.lines().filter((line) => line.startsWith('  … still running: '))
  assert.ok(beats.length >= 2, beats.join('\n'))
  assert.ok(beats.every((line) => /^  … still running: (long|short) \d+ s(, (long|short) \d+ s)?$/.test(line) && line.includes('long')), beats.join(' | '))
  assert.match(beats.at(-1), /^  … still running: long \d+ s$/, 'a check that is done is left out')
})
