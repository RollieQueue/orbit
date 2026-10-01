const test = require('node:test')
const assert = require('node:assert/strict')
const { OrbitRuntime, sleep, deferred, until, aborts, fakeMcp, start, completed, steerTraces, withEnv, withGrace } = require('./helpers-steer-messages.cjs')

// When a turn is cut for a message: a pause, the grace a turn is given, and the step the model is thinking.

test('a paused agent is not cut for a message; the message reaches it after the resume', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) return aborts(options)
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await until(() => calls.length === 1)
  runtime.pauseAgent(run.runId, 'root')
  await until(() => run.agentNodes.get('root').status === 'paused')
  const traces = steerTraces(run, 'root').length
  runtime.postUserMessage(run.runId, 'root', 'WHILE_PAUSED')
  await sleep(300)
  assert.equal(calls.length, 1)
  assert.equal(steerTraces(run, 'root').length, traces)
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].prompt.includes('PAUSED BY THE USER'))
  assert.ok(calls[1].prompt.includes('WHILE_PAUSED'))
  assert.equal(steerTraces(run, 'root').length, 0, 'a pause, not a steering cut, interrupted the turn')
})

test('a turn that ends by itself within the grace is not cut; the answer is followed by the usual resume', async t => {
  await withGrace('200', async () => {
    const calls = []
    let run, abortedAtReturn
    const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
      calls.push(options)
      if (calls.length === 1) {
        runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
        await sleep(30)
        abortedAtReturn = options.signal.aborted
        return { text: 'Premature answer', sessionId: options.session.id }
      }
      return { text: 'FINAL_ANSWER', sessionId: options.session.id }
    } })
    run = await start(t, runtime, { providerId: 'claude' })
    await completed(runtime, run)
    assert.equal(calls.length, 2)
    assert.equal(abortedAtReturn, false)
    assert.equal(steerTraces(run, 'root').length, 0)
    assert.match(calls[1].prompt, /^The user wrote to you while you were working/)
    assert.ok(calls[1].prompt.includes('STEER_NOW'))
    assert.equal(run.agentNodes.get('root').turns, 2)
    await sleep(250) // past the grace
    assert.equal(steerTraces(run, 'root').length, 0, 'the check of an ended turn is dropped')
  })
})

// 2026-09-30: messages cut a flagship's step while it was thinking; each repeat thought it all over again and it never
// answered. A step under way now finishes first.
for (const ending of ['tool', 'answer']) test(`session: a step the model is thinking is not cut; the message goes out ${ending === 'tool' ? 'right after its tool call' : 'with the next turn'}`, async t => {
  // The window outlasts the 250 ms poll, so the check after the tool call always lands within it.
  await withEnv('ORBIT_STEER_STEP_MS', '400', async () => {
    const calls = []
    const go = deferred()
    const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
      calls.push(options)
      if (calls.length > 1) return { text: 'FINAL_ANSWER', sessionId: options.session.id }
      options.onEvent({ kind: 'reasoning', text: '', messageId: 'thinking', partial: true })
      await go.promise
      if (ending === 'answer') return { text: 'STEP_ANSWER', sessionId: options.session.id }
      const read = status => ({ kind: 'tool', native: true, toolId: 'read-1', tool: 'Read', text: 'shot.png', status })
      options.onEvent(read('started')); options.onEvent(read('completed'))
      return aborts(options)
    } })
    const run = await start(t, runtime, { providerId: 'claude' })
    await until(() => calls.length === 1)
    await sleep(500) // older than the step window
    runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
    await sleep(400)
    assert.equal(calls[0].signal.aborted, false, 'a step older than ORBIT_STEER_STEP_MS is let finish')
    assert.deepEqual(steerTraces(run, 'root').map(trace => trace.text), ['Orbit заканчивает текущий шаг и прочитает сообщение от вас сразу после него'])
    go.resolve()
    if (ending === 'tool') await until(() => calls[0].signal.aborted, 'the turn is cut once the step\'s tool call has ended')
    await completed(runtime, run)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].session.resume, true)
    assert.ok(calls[1].prompt.includes('STEER_NOW'))
    const root = run.agentNodes.get('root')
    if (ending === 'tool') {
      assert.match(calls[1].prompt, /^INTERRUPTED FOR A MESSAGE/)
      assert.match(steerTraces(run, 'root')[1].text, /^Ход прерван между шагами/)
      assert.equal(root.turns, 1, 'the cut turn is refunded')
    } else {
      assert.match(calls[1].prompt, /^The user wrote to you while you were working/)
      assert.equal(steerTraces(run, 'root').length, 1, 'nothing was cut')
      assert.equal(root.turns, 2)
    }
  })
})
