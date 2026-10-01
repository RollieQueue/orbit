const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { temporary, payload, startChild, restartSupport } = require('./helpers-runtime-host.cjs')

// What ends a runtime child: its parent going away, and a shutdown for a restart. The calls it serves are in
// runtime-host.test.cjs.

// Only a child_process.fork parent (these tests, a Node host) leaves the runtime running when it goes away: under
// utilityProcess Chromium terminates the runtime together with main (measured: gone within 50 ms, no exit handlers),
// so a crash of main never gets the graceful shutdown of the next two tests.
test('a runtime whose parent channel closes stops its runs, saves and exits', async (t) => {
  const layout = temporary(t)
  const runtime = startChild(layout)
  await runtime.ready
  const runId = await runtime.call('runtime:start', payload(layout, 'HOLD until the parent is gone'))
  await runtime.event((event) => event.type === 'agent.updated' && event.runId === runId && event.agent?.status === 'working', 'agent working')
  runtime.child.disconnect()
  assert.deepEqual(await runtime.exited, { code: 0, signal: null })
  assert.equal(JSON.parse(fs.readFileSync(path.join(layout.userData, 'run-history', `${runId}.json`), 'utf8')).status, 'cancelled')
})

test('a runtime forked by a Node parent that is gone (ORBIT_PARENT_PID, the channel still open) shuts down on its own', async (t) => {
  const layout = temporary(t)
  const { spawnSync } = require('node:child_process')
  const pid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { cwd: os.tmpdir(), encoding: 'utf8' }).stdout)
  try { process.kill(pid, 0); t.skip('the pid of the exited process was reused at once'); return } catch { /* Gone, as wanted. */ }
  const runtime = startChild(layout, { env: { ORBIT_PARENT_PID: String(pid) } })
  assert.deepEqual(await runtime.exited, { code: 0, signal: null })
  assert.ok(!runtime.messages.some((message) => message.t === 'fatal'))
})

test('shutdown for a restart marks the requesting run restarting, and the next runtime continues it', { skip: restartSupport ? false : 'electron/resume.mts (P1) is not in place yet' }, async (t) => {
  const layout = temporary(t)
  const first = startChild(layout)
  await first.ready
  const runId = await first.call('runtime:start', payload(layout, 'HOLD until Orbit restarts', { chatId: 'chat-restart' }))
  const bystander = await first.call('runtime:start', payload(layout, 'HOLD in another chat', { chatId: 'chat-other' }))
  for (const id of [runId, bystander]) await first.event((event) => event.type === 'agent.updated' && event.runId === id && event.agent?.status === 'working', `agent of ${id} working`)
  fs.writeFileSync(path.join(layout.userData, 'pending-resume.json'), JSON.stringify({
    version: 1, id: 'upgrade-1', createdAt: new Date().toISOString(), source: 'tool', reason: 'new tool', continueWith: 'Continue with the new tool', verify: true,
    runId, chatId: 'chat-restart', projectId: 'project', agentId: 'root', level: 'runtime', state: 'relaunching', commit: null, outcome: null, error: null, patch: null,
  }))
  first.send({ t: 'shutdown', mode: 'restart' })
  assert.deepEqual((await first.waitFor((message) => message.t === 'shutdown-done', 'shutdown-done')).marked, [runId])
  assert.deepEqual(await first.exited, { code: 0, signal: null })
  const history = (id) => JSON.parse(fs.readFileSync(path.join(layout.userData, 'run-history', `${id}.json`), 'utf8'))
  assert.equal(history(runId).status, 'restarting')
  assert.equal(history(runId).restart.intentId, 'upgrade-1', 'the mark names the intent that alone continues the run')
  assert.equal(history(bystander).status, 'cancelled')

  const second = startChild(layout)
  await second.ready
  assert.equal((await second.call('runtime:get', runId)).status, 'restarting', 'a restarting run is not turned into an interrupted one on load')
  // What the self-upgrade watcher adds once it has seen the new runtime's healthy report; the continuation waits for it.
  const intentFile = path.join(layout.userData, 'pending-resume.json')
  fs.writeFileSync(intentFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(intentFile, 'utf8')), verdict: 'relaunched', verdictAt: new Date().toISOString() }))
  second.send({ t: 'renderer-healthy', info: { level: 'runtime', commit: null } })
  const notice = await second.waitFor((message) => message.t === 'event' && message.channel === 'restart:notice', 'restart notice').then((message) => message.payload)
  assert.equal(notice.kind, 'resumed', JSON.stringify(notice))
  assert.equal(notice.runId, runId)
  const continued = await second.event((event) => event.type === 'run.finished' && event.runId === notice.resumedRunId, 'the continuation finished')
  assert.equal(continued.status, 'completed')
  const resumed = await second.call('runtime:get', notice.resumedRunId)
  assert.equal(resumed.chatId, 'chat-restart')
  assert.match(resumed.prompt, /^Continue with the new tool/)
  assert.ok(!fs.existsSync(path.join(layout.userData, 'pending-resume.json')), 'the intent is consumed')
  second.send({ t: 'renderer-healthy', info: { level: 'runtime', commit: null } })
  second.send({ t: 'shutdown', mode: 'quit' })
  await second.waitFor((message) => message.t === 'shutdown-done', 'second shutdown-done')
  assert.equal((await second.exited).code, 0)
  assert.equal(second.messages.filter((message) => message.t === 'event' && message.channel === 'restart:notice').length, 1, 'a pending restart is continued once per runtime')
})
