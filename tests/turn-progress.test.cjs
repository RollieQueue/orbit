const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { OrbitRuntime } = require('./helpers-runtime.cjs')
const { eventually } = require('./helpers-turn-progress.cjs')

// A session turn can hold the whole task, so the window counts the agent's actions while the turn runs: a native tool
// call is published (throttled to once a second) before the turn ends, not only with its end.
// The thinking in progress is in turn-progress-thinking.test.cjs.

test('an action counted during a turn reaches the window while the turn still runs', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-progress-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const live = []
  let turnEnded = false
  const runtime = new OrbitRuntime({ runProvider: async options => {
    options.onEvent({ kind: 'tool', native: true, tool: 'Bash', toolId: 'call-1', text: 'npm test' })
    options.onEvent({ kind: 'tool', native: true, tool: 'Bash', toolId: 'call-1', text: 'npm test', status: 'completed' })
    // The call reaches the window once the throttle (a second) has passed; the turn goes on until it has.
    await eventually(() => live.some(update => update.native === 1 && !update.ended))
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

// Tokens: the provider reports them in its own spelling, often and in small steps; the window gets them while the turn runs,
// at most once a second, in one shape (input includes the cached part).
test('tokens reach the window while the turn runs, in one shape, at most once a second', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-turn-tokens-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const live = [], traces = []
  let turnEnded = false
  const total = { inputTokens: 3545, outputTokens: 177, cachedInputTokens: 2550 }
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
    // The figures reach the window once the throttle (a second) has passed, all of them in one report; the turn goes on until they have.
    await eventually(() => isDeepStrictEqual(live.at(-1), total))
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
  assert.ok(live.length >= 1 && live.length <= 2, `a burst is published once, during the turn: ${JSON.stringify(live)}`)
  assert.deepEqual(live.at(-1), total)
  const snapshot = runtime.getRun(runId)
  assert.deepEqual(snapshot.agents[0].usage, total)
  assert.deepEqual({ inputTokens: snapshot.usage.inputTokens, outputTokens: snapshot.usage.outputTokens, cachedInputTokens: snapshot.usage.cachedInputTokens }, total, 'the run is the sum of its agents')
  assert.equal(traces.length, 0, 'a usage report is no trace')
})
