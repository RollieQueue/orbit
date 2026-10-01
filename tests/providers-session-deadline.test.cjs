const test = require('node:test')
const assert = require('node:assert/strict')
const { runProvider } = require('../electron/providers.mts')
const { withEnv, fakeCli } = require('./helpers-providers-session.cjs')

// Real inactivity and deadline timers of a Claude session run, shortened; the last case streams for longer than its window.

test('Claude session run: an explicit total deadline still applies; without one only inactivity does', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const cli = fakeCli(t, 'ORBIT_CLAUDE_COMMAND', `
    out({ type: 'system', subtype: 'init', session_id: 's' });
    if (input === 'hang') setInterval(() => {}, 1000); else { const i = setInterval(() => out({ type: 'stream_event', event: {} }), 50); setTimeout(() => { clearInterval(i); out({ type: 'result', subtype: 'success', result: 'late but fine', session_id: 's' }) }, 1100) }
  `)
  const session = { token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp' }
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session, inactivityMs: 200 }), /no output for 200 ms/)
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session, inactivityMs: 5000, timeoutMs: 150 }), /timed out after 150 ms/)
  let busy = 0
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session: { ...session, activity: () => ({ pending: ++busy <= 2 ? 1 : 0, lastAt: Date.now() }) }, inactivityMs: 200 }), /no output for 200 ms/)
  assert.equal(busy, 3, 'an Orbit tool call in flight defers the inactivity verdict')
  // Streaming for 1.1 s with a 700 ms window: every chunk resets the clock (Node itself needs a few hundred ms to start).
  const slow = await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'stream', session, inactivityMs: 700 })
  assert.equal(slow.text, 'late but fine')
})
