'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRuntimeClient, nodeFork } = require('../electron/runtime-client.cjs')
const { until } = require('./helpers-runtime-client.cjs')

// The real runtime child (electron/runtime-child.cjs) over Node IPC: its life from the first start to the shutdown, and its
// stray errors. The state machine against fake children is in runtime-client.test.cjs.

test('the real runtime child starts, answers, restarts with its fixtures, and shuts down', { timeout: 120000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-client-'))
  const statuses = []
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'),
    fork: nodeFork({ cwd: os.tmpdir() }),
    env: { ORBIT_RUNTIME_FIXTURES: path.join(__dirname, '..', 'scripts', 'smoke-fixtures.cjs'), ORBIT_SMOKE_FIXTURE_DIR: profile },
    onStatus: status => statuses.push(status.state),
    log: (level, text) => logs.push(`${level}: ${text}`),
  })
  try {
    const ready = await client.ready
    t.diagnostic(`first start: ready ${ready.ms} ms after the fork (pid ${ready.pid})`)
    assert.notEqual(ready.pid, process.pid)
    assert.equal(await client.call('state:load', []), null, 'a new profile has no saved state')
    assert.deepEqual(await client.call('runtime:list', []), [])
    const health = await client.call('providers:health', [{}])
    assert.deepEqual(health.map(entry => entry.detail), ['fixture', 'fixture', 'fixture endpoint'], 'the fixtures module replaced the provider check')
    await assert.rejects(client.call('no:such-channel', []), (error) => error.code === 'ORBIT_UNKNOWN_CHANNEL')
    await assert.rejects(client.call('runtime:start', [{ workspace: 'relative/path' }]), /absolute project folder/)
    const saved = { version: 3, projects: [], activeProjectId: null, settings: {} }
    await client.call('state:save', [saved])
    const restarted = await client.restart('test')
    t.diagnostic(`runtime restart: ${restarted.ms} ms (pid ${ready.pid} -> ${restarted.pid})`)
    assert.notEqual(restarted.pid, ready.pid)
    assert.throws(() => process.kill(ready.pid, 0), /ESRCH/, 'the old runtime process is gone')
    assert.deepEqual(await client.call('state:load', []), saved, 'what the old runtime saved, the new one reads')
    assert.deepEqual(statuses.slice(0, 2), ['starting', 'ready'])
    assert.ok(statuses.includes('restarting') && statuses.at(-1) === 'ready')
    assert.deepEqual(await client.shutdown('quit'), { marked: [] })
    assert.equal(client.status().state, 'stopped')
    assert.throws(() => process.kill(restarted.pid, 0), /ESRCH/, 'the runtime exited after shutdown-done')
  } finally {
    await client.kill()
    fs.rmSync(profile, { recursive: true, force: true })
  }
  assert.ok(!logs.some(line => /stopped unexpectedly|fatal/.test(line)), logs.join('\n'))
})

test('the real runtime child reports uncaught errors at most once a second and keeps running', { timeout: 120000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-uncaught-'))
  // The provider check throws five errors nothing catches, right after it answered.
  const fixtures = path.join(profile, 'throwing-fixtures.cjs')
  fs.writeFileSync(fixtures, `'use strict'
exports.inspectProviders = async () => {
  for (let index = 0; index < 5; index++) setImmediate(() => { throw new Error('stray ' + index) })
  return [{ id: 'probe', detail: 'answered' }]
}
`)
  const statuses = []
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'), fork: nodeFork({ cwd: os.tmpdir() }), env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    onStatus: status => statuses.push(status), log: (level, text) => logs.push(`${level}: ${text}`),
  })
  try {
    await client.ready
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: 'answered' }])
    await until(() => client.status().lastError?.count === 5, 'all five counted', 10000)
    const reports = statuses.filter(status => status.lastError).map(status => [status.lastError.message, status.lastError.count])
    assert.deepEqual(reports, [['stray 0', 1], ['stray 4', 5]], 'the first at once, the other four as one report a second later')
    const [first, second] = statuses.filter(status => status.lastError).map(status => status.lastError.at)
    assert.ok(second - first >= 900, `a second apart: ${second - first} ms`)
    assert.equal(client.status().state, 'ready')
    assert.deepEqual(await client.call('providers:health', [{}]), [{ id: 'probe', detail: 'answered' }], 'the runtime still answers')
    assert.ok(logs.some(line => /^error: uncaught error in the runtime \(pid \d+\): Error: stray 0/.test(line)), logs.join('\n'))
    await client.shutdown('quit')
  } finally {
    await client.kill()
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
