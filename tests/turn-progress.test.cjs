const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')

// A session turn can hold the whole task, so the window counts the agent's actions while the turn runs: a native tool
// call is published (throttled to once a second) before the turn ends, not only with its end.

test('an action counted during a turn reaches the window while the turn still runs', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-progress-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const live = []
  let turnEnded = false
  const runtime = new OrbitRuntime({ runProvider: async options => {
    options.onEvent({ kind: 'tool', native: true, tool: 'Bash', toolId: 'call-1', text: 'npm test' })
    options.onEvent({ kind: 'tool', native: true, tool: 'Bash', toolId: 'call-1', text: 'npm test', status: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 1300))
    turnEnded = true
    return { text: 'FINAL_ANSWER' }
  } })
  const unsub = runtime.onEvent(event => {
    const timing = event.type === 'agent.updated' && event.agent?.id === 'root' ? event.agent.turnTimings?.at(-1) : null
    if (timing && !turnEnded) live.push({ native: timing.nativeToolCalls, ended: timing.endedAt })
  })
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) finish(event) })
  await runtime.start({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Task' })
  const event = await finished
  unsub(); off()
  assert.equal(event.type, 'run.finished')
  assert.ok(live.some(update => update.native === 1 && !update.ended), `the counted call is published during the turn: ${JSON.stringify(live)}`)
})

test('thinking in progress reaches the window while the turn runs and is gone once the thinking or the turn ends', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-thinking-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const updates = [], traces = []
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const runtime = new OrbitRuntime({ runProvider: async options => {
    options.onEvent({ kind: 'thinking', tokens: 0 })
    options.onEvent({ kind: 'thinking', tokens: 4200 })
    await pause(1500)
    options.onEvent({ kind: 'thinking', done: true })
    await pause(1500)
    options.onEvent({ kind: 'thinking', tokens: 0 })
    options.onEvent({ kind: 'thinking', tokens: 300 })
    options.onEvent({ kind: 'output', text: 'Checking', messageId: 'm', partial: true })
    await pause(1500)
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

// Tokens: the provider reports them in its own spelling, often and in small steps; the window gets them while the turn runs,
// at most once a second, in one shape (input includes the cached part).
test('tokens reach the window while the turn runs, in one shape, at most once a second', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-tokens-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const live = [], traces = []
  let turnEnded = false
  const runtime = new OrbitRuntime({ runProvider: async options => {
    // Claude's spelling (the cache apart from the input), twenty reports within a moment.
    for (let call = 0; call < 20; call++) options.onEvent({ kind: 'usage', providerId: 'claude', usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } })
    // OpenAI's (Codex): the input includes the cached part.
    options.onEvent({ kind: 'usage', providerId: 'codex', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } })
    // The usage of an observation counts the same way: Chat Completions' names, and Cursor's, which keep the cache apart.
    options.onEvent({ kind: 'observation', text: 'endpoint', usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } })
    options.onEvent({ kind: 'observation', text: 'cursor', usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20 } })
    // Figures that hold no number change nothing.
    options.onEvent({ kind: 'observation', text: 'empty', usage: { input_tokens: undefined, output_tokens: null } })
    await new Promise(resolve => setTimeout(resolve, 1800))
    turnEnded = true
    return { text: 'FINAL_ANSWER' }
  } })
  const unsub = runtime.onEvent(event => {
    if (event.type === 'agent.updated' && event.agent?.id === 'root' && event.agent.usage && !turnEnded) live.push(event.agent.usage)
    if (event.type === 'trace.added' && event.trace.kind === 'usage') traces.push(event.trace)
  })
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) finish(event) })
  const runId = await runtime.start({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Task' })
  const event = await finished
  unsub(); off()
  assert.equal(event.type, 'run.finished')
  const total = { inputTokens: 3545, outputTokens: 177, cachedInputTokens: 2550 }
  assert.ok(live.length >= 1 && live.length <= 2, `a burst is published once, during the turn: ${JSON.stringify(live)}`)
  assert.deepEqual(live.at(-1), total)
  const snapshot = runtime.getRun(runId)
  assert.deepEqual(snapshot.agents[0].usage, total)
  assert.deepEqual({ inputTokens: snapshot.usage.inputTokens, outputTokens: snapshot.usage.outputTokens, cachedInputTokens: snapshot.usage.cachedInputTokens }, total, 'the run is the sum of its agents')
  assert.equal(traces.length, 0, 'a usage report is no trace')
})
