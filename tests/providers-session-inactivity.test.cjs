const test = require('node:test')
const assert = require('node:assert/strict')
const { _testing } = require('../electron/providers.mts')
const { withEnv } = require('./helpers-providers-session.cjs')
const { runCli } = _testing

// Real inactivity and deadline timers of runCli, shortened to a few hundred milliseconds (the process is killed each time).

test('runCli inactivity: a silent process is killed, output resets the clock, isBusy defers the verdict, null disables it', async t => {
  withEnv(t, { ORBIT_PROVIDER_INACTIVITY_MS: undefined })
  const silent = runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: 300, timeoutMs: null })
  await assert.rejects(silent, error => error.name === 'TimeoutError' && /no output for 300 ms/.test(error.message))
  const chatty = await runCli(process.execPath, ['-e', 'let n = 0; const i = setInterval(() => { console.log(n++); if (n > 6) { clearInterval(i) } }, 60)'], { inactivityMs: 1000, timeoutMs: null })
  assert.match(chatty.stdout, /6/)
  let checks = 0
  const started = Date.now()
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: 200, timeoutMs: null, isBusy: () => ++checks <= 2 }), { name: 'TimeoutError' })
  assert.equal(checks, 3)
  assert.ok(Date.now() - started >= 520, 'two busy verdicts each bought another window')
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: null, timeoutMs: 400 }), error => error.name === 'TimeoutError' && /timed out after 400 ms/.test(error.message))
  process.env.ORBIT_PROVIDER_INACTIVITY_MS = '240'
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: null }), /no output for 240 ms/)
})
