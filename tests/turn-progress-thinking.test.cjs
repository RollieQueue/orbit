const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('./helpers-runtime.cjs')
const { eventually } = require('./helpers-turn-progress.cjs')

// The model's thinking in progress reaches the window while the turn runs, at most once a second like the counted actions
// and the tokens in turn-progress.test.cjs, and is gone once the thinking or the turn ends.

test('thinking in progress reaches the window while the turn runs and is gone once the thinking or the turn ends', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-thinking-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const updates = [], traces = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const runtime = new OrbitRuntime({ runProvider: async options => {
    options.onEvent({ kind: 'thinking', tokens: 0 })
    options.onEvent({ kind: 'thinking', tokens: 4200 })
    // Each state reaches the window once the throttle (a second) has passed; the turn goes on until it has.
    await eventually(() => updates.some(update => !update.ended && update.thinking === 4200))
    options.onEvent({ kind: 'thinking', done: true })
    const sent = updates.length
    await eventually(() => updates.slice(sent).some(update => !update.ended))
    options.onEvent({ kind: 'thinking', tokens: 0 })
    options.onEvent({ kind: 'thinking', tokens: 300 })
    options.onEvent({ kind: 'output', text: 'Checking', messageId: 'm', partial: true })
    // The thinking is not sent this time, which only a whole throttle interval and a little more shows.
    await pause(1150)
    // The provider stops with a thinking block still open.
    options.onEvent({ kind: 'thinking', tokens: 900 })
    return { text: 'FINAL_ANSWER' }
  } })
  const unsub = runtime.onEvent(event => {
    const timing = event.type === 'agent.updated' && event.agent?.id === 'root' ? event.agent.turnTimings?.at(-1) : null
    if (timing) updates.push({ thinking: timing.thinking, ended: !!timing.endedAt })
    if (event.type === 'trace.added' && event.trace.kind === 'thinking') traces.push(event.trace)
  })
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) finish(event) })
  await runtime.start({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Task' })
  const event = await finished
  unsub(); off()
  assert.equal(event.type, 'run.finished')
  const running = updates.filter(update => !update.ended).map(update => update.thinking)
  const shown = running.indexOf(4200)
  assert.ok(shown >= 0, `the estimate is published during the turn: ${JSON.stringify(updates)}`)
  assert.ok(running.slice(shown + 1).includes(undefined), `the end of the thinking block is published during the turn: ${JSON.stringify(updates)}`)
  assert.ok(!running.includes(300), `a text of the agent ends its thinking: ${JSON.stringify(updates)}`)
  const closed = updates.filter(update => update.ended)
  assert.ok(closed.length && closed.every(update => update.thinking === undefined), `a closed turn shows no thinking: ${JSON.stringify(updates)}`)
  assert.equal(traces.length, 0, 'the estimate is not traced')
})
