const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// scripts/test-reporter.mjs is what `npm test` prints with: one line for a passing run, every failure in full. These
// tests run it for real (node --test over small sample files in a temp folder) and read what comes out.
const repo = path.resolve(__dirname, '..')
const REPORTER = require('node:url').pathToFileURL(path.join(repo, 'scripts', 'test-reporter.mjs')).href

function sampleFolder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-reporter-'))
  // Windows can keep the folder locked for a moment after the child runner exits (EBUSY, measured 2026-10-02 under load):
  // the cleanup retries longer and never fails the test, since a leftover temp folder is harmless.
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
    catch (error) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error }
  })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return dir
}

function run(dir, env = {}, reporter = REPORTER) {
  // Under node --test this process carries NODE_TEST_CONTEXT, which would make the inner run a child that speaks TAP.
  const clean = { ...process.env }
  delete clean.NODE_TEST_CONTEXT
  const result = childProcess.spawnSync(process.execPath, [`--test-reporter=${reporter}`, '--test',
    ...fs.readdirSync(dir).filter((name) => name.endsWith('.test.cjs')).map((name) => path.join(dir, name))], {
    cwd: dir, encoding: 'utf8', env: { ...clean, ORBIT_TEST_REPORTER: '', ...env }, timeout: 60000,
  })
  return { status: result.status, out: result.stdout + result.stderr }
}

const PASSING = `const test = require('node:test')
test('passes', () => { console.error('noise that a passing file must not echo') })
test('also passes', () => {})
test.skip('skipped', () => {})
`

test('a passing run is one summary line and exits 0', (t) => {
  const dir = sampleFolder(t, { 'a.test.cjs': PASSING, 'b.test.cjs': PASSING })
  const { status, out } = run(dir)
  assert.equal(status, 0)
  assert.equal(out.trim().split('\n').length, 1, out)
  assert.match(out, /^tests 6 \| pass 4 \| fail 0 \| cancelled 0 \| skipped 2 \| todo 0 \| files 2 \| [\d.]+s$/m)
})

test('every failure is printed in full: assertion diff, nested name path, timeout, file that does not load, syntax error', (t) => {
  const dir = sampleFolder(t, {
    'pass.test.cjs': PASSING,
    'fail.test.cjs': `const { test, describe, it } = require('node:test')
const assert = require('node:assert')
describe('suite', () => {
  it('compares objects', () => { assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }) })
  it('fine', () => {})
})
test('slow one', { timeout: 100 }, async () => { await new Promise((resolve) => setTimeout(resolve, 3000)) })
`,
    'load.test.cjs': `require('./does-not-exist.cjs')\n`,
    'syntax.test.cjs': `const x = (\n`,
  })
  const { status, out } = run(dir)
  assert.notEqual(status, 0)
  assert.match(out, /FAIL fail\.test\.cjs:4:3\n {2}suite > compares objects\n/)
  assert.match(out, /Expected values to be strictly deep-equal/)
  assert.match(out, /^ {4}\+ {5}2$/m)
  assert.match(out, /^ {4}- {5}3$/m)
  assert.match(out, /FAIL fail\.test\.cjs:7:1 \[testTimeoutFailure\]\n {2}slow one\n {4}test timed out after 100ms/)
  assert.match(out, /FAIL load\.test\.cjs:\d+:\d+ \(the file as a whole\)/)
  assert.match(out, /stderr of load\.test\.cjs:[\s\S]*Cannot find module '\.\/does-not-exist\.cjs'/)
  assert.match(out, /FAIL syntax\.test\.cjs:\d+:\d+ \(the file as a whole\)/)
  assert.match(out, /stderr of syntax\.test\.cjs:[\s\S]*SyntaxError: Unexpected end of input/)
  assert.doesNotMatch(out, /noise that a passing file must not echo/)
  assert.doesNotMatch(out, /^\s+at .*node:internal\//m, 'node-internal stack frames are cut')
  assert.match(out, /^tests \d+ \| pass \d+ \| fail [1-9]\d* \|.* files 4 \| [\d.]+s\n$/m)
})

test('ORBIT_TEST_REPORTER=spec gives the full per-test output, an unknown name is an error', (t) => {
  const dir = sampleFolder(t, { 'a.test.cjs': PASSING })
  const spec = run(dir, { ORBIT_TEST_REPORTER: 'spec' })
  assert.equal(spec.status, 0)
  assert.match(spec.out, /passes/)
  assert.match(spec.out, /also passes/)
  assert.ok(spec.out.trim().split('\n').length > 3, spec.out)
  const unknown = run(dir, { ORBIT_TEST_REPORTER: 'nope' })
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.out, /ORBIT_TEST_REPORTER=nope: expected compact, spec, tap, dot or junit/)
})

test('a failure that only node explains (unhandled rejection after the test ended) is printed with its notes', (t) => {
  const dir = sampleFolder(t, {
    'late.test.cjs': `const test = require('node:test')
test('leaky', () => { setTimeout(() => { Promise.reject(new Error('late boom')) }, 30) })
test('slow', async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
`,
    'pass.test.cjs': PASSING,
  })
  const { status, out } = run(dir)
  assert.notEqual(status, 0)
  assert.match(out, /FAIL late\.test\.cjs:\d+:\d+ \(the file as a whole\)/)
  assert.match(out, /node's notes on late\.test\.cjs:[\s\S]*Test "leaky"[\s\S]*unhandledRejection/)
  assert.match(out, /late boom/)
  assert.doesNotMatch(out, /node's notes on pass\.test\.cjs/)
})

test('a failure is yielded the moment it arrives, before the stream ends', async (t) => {
  const { default: reporter } = await import(REPORTER)
  const saved = process.env.ORBIT_TEST_REPORTER
  delete process.env.ORBIT_TEST_REPORTER
  t.after(() => { if (saved !== undefined) process.env.ORBIT_TEST_REPORTER = saved })
  let release
  const hang = new Promise((resolve) => { release = resolve })
  const file = path.join(repo, 'tests', 'hangs.test.cjs')
  async function* source() {
    yield { type: 'test:fail', data: { name: 'broken one', nesting: 0, file, line: 3, column: 1,
      details: { error: { failureType: 'testCodeFailure', cause: new Error('early failure') } } } }
    await hang // the next file hangs: nothing else arrives until the test lets it go
    yield { type: 'test:summary', data: { success: false, duration_ms: 5,
      counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 } } }
  }
  const iterator = reporter(source())
  t.after(() => release())
  const first = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve('not yielded'), 5000)),
  ])
  assert.notEqual(first, 'not yielded', 'the FAIL block must not wait for the end of the stream')
  assert.match(first.value, /^FAIL tests\/hangs\.test\.cjs:3:1\n {2}broken one\n {4}Error: early failure/)
  release()
  const last = await iterator.next()
  assert.match(last.value, /^tests 1 \| pass 0 \| fail 1 \|/)
  assert.equal((await iterator.next()).done, true)
})

test('a failing todo test is not a failure: one summary line, exit 0', (t) => {
  const dir = sampleFolder(t, {
    'todo.test.cjs': `const test = require('node:test')
test('not done yet', { todo: true }, () => { throw new Error('expected to fail') })
test('fine', () => {})
`,
  })
  const { status, out } = run(dir)
  assert.equal(status, 0, out)
  assert.equal(out.trim().split('\n').length, 1, out)
  assert.match(out, /fail 0 .*todo 1 /)
})

test('a file whose process dies shows its exit code; causes and AggregateError members are kept', (t) => {
  const dir = sampleFolder(t, {
    'exit.test.cjs': `require('node:test')('ok', () => {}); process.exit(3)\n`,
    'agg.test.cjs': `const test = require('node:test')
test('many', () => {
  throw new AggregateError([new Error('member one'), new Error('member two')], 'several went wrong',
    { cause: new Error('root cause', { cause: new Error('deepest cause') }) })
})
`,
  })
  const { status, out } = run(dir)
  assert.notEqual(status, 0)
  assert.match(out, /FAIL exit\.test\.cjs:\d+:\d+ \(the file as a whole\)\n {4}test failed\n {4}\[the test process ended: exit code 3\]/)
  assert.match(out, /AggregateError[^\n]*several went wrong/)
  assert.match(out, /\[errors\]\[0\]: Error: member one/)
  assert.match(out, /\[errors\]\[1\]: Error: member two/)
  assert.match(out, /\[cause\]: Error: root cause/)
  assert.match(out, /\[cause\]: Error: deepest cause/)
  assert.doesNotMatch(out, /^\s+at .*node:internal\//m)
})
