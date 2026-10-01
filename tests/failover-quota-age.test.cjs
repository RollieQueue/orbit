const test = require('node:test')
const assert = require('node:assert/strict')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { w, CATALOG, folder, finished, payload } = require('./helpers-failover.cjs')

// Alone in its file: the cold case waits for the real 6 s quota probe limit (QUOTA_WAIT_MS in runtime/handover.mts).

test('a reading a few minutes old does not hold a turn back while it is refreshed', async t => {
  const workspace = folder(t)
  let offset = 0
  const clock = () => Date.now() + offset
  const original = { ...quota.readers }
  t.after(() => Object.assign(quota.readers, original))
  quota.readers.codex = () => new Promise(() => {}) // a probe that never answers
  const monitor = new quota.QuotaMonitor({ clock })
  monitor.ingest('codex', { windows: [w(40)] })
  offset = 2 * 60000
  const started = Date.now()
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'Готово' }), quota: monitor, catalog: async () => CATALOG, clock })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.ok(Date.now() - started < 3000, 'the turn did not wait for the six-second probe limit')
  assert.equal(monitor.peek('codex').windows[0].usedPercent, 40)
  offset = 30 * 60000
  const cold = Date.now()
  await finished(new OrbitRuntime({ runProvider: async () => ({ text: 'Готово' }), quota: monitor, catalog: async () => CATALOG, clock }), payload(workspace, { chatId: 'chat-2' }))
  assert.ok(Date.now() - cold >= 5500, 'a very old reading is waited for, up to the limit')
})
