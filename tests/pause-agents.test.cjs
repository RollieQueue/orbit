const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { STOPPED_BY_USER, pausedBy } = require('../electron/runtime/pause.mts')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check, message) {
  const end = Date.now() + 4000
  while (!check()) { assert.ok(Date.now() < end, message || 'runtime did not reach the expected state'); await sleep(5) }
}
function aborts(options) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Provider interrupted'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
function fakeMcp() {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {} }
}
async function start(t, runtime, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pause-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false, ...extra })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  return runtime.runs.get(runId)
}
async function completed(runtime, run) {
  await until(() => run.status !== 'working', 'the run must finish without deadlock')
  assert.equal(run.status, 'completed', run.error)
  return runtime.getRun(run.runId)
}

test('envelope pause aborts immediately, retains its cleanup slot, and resumes with the cut-off note and queued mail', async t => {
  const calls = [], cleanup = deferred()
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      options.onEvent({ kind: 'output', text: 'PARTIAL_BEFORE_PAUSE', partial: true })
      options.onEvent({ kind: 'tool', native: true, toolId: 'native-write', tool: 'edit_file', text: 'changed a file' })
      return cleanup.promise
    }
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime, { limits: { maxConcurrent: 1 } })
  await until(() => calls.length === 1)
  const root = run.agentNodes.get('root')
  assert.equal(runtime.pauseAgent(run.runId, 'root').paused, true)
  const pausedAt = root.pausedAt
  runtime.pauseAgent(run.runId, 'root')
  assert.equal(root.pausedAt, pausedAt, 'pause is idempotent')
  assert.equal(calls[0].signal.aborted, true)
  await until(() => root.status === 'paused')
  assert.equal(root.paused, true)
  assert.equal(run.activeTurns, 1, 'the unsettled provider still owns its slot')
  assert.equal(run.status, 'working')
  runtime.postUserMessage(run.runId, 'root', 'QUEUED_WHILE_PAUSED')
  await sleep(150)
  assert.equal(calls.length, 1, 'neither pause nor a user message starts inference')
  runtime.resumeAgent(run.runId, 'root')
  runtime.resumeAgent(run.runId, 'root')
  await sleep(30)
  assert.equal(calls.length, 1, 'resuming cannot race provider cleanup for the slot')
  cleanup.resolve({ text: 'Discard this interrupted result' })
  const snapshot = await completed(runtime, run)
  assert.equal(calls.length, 2)
  for (const text of ['PAUSED BY THE USER', 'PARTIAL_BEFORE_PAUSE', 'they may already have taken effect', 'QUEUED_WHILE_PAUSED']) assert.ok(calls[1].prompt.includes(text), text)
  assert.equal(snapshot.agents.find(agent => agent.id === 'root').paused, false)
  assert.equal(root.pausedAt, null)
  assert.equal(root.turns, 1, 'a turn cut off by a pause is not counted: it is repeated after the resume')
  assert.equal(run.usage.providerTurns, 1)
  assert.equal(run.pauseWaiters.size, 0)
  assert.deepEqual(snapshot.messages.map(message => message.text), ['FINAL_ANSWER'])
})

test('a paused helper can be stopped permanently and its parent sees the user-stop explanation and last actions', async t => {
  let helperCall, rootTurns = 0
  const rootPrompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (/Agent: Helper;/.test(options.prompt)) { helperCall = options; return aborts(options) }
    rootPrompts.push(options.prompt)
    if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' }), tool('wait_agent'))
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await until(() => helperCall)
  const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  runtime.recordLedger(helper, 'read_file', 'READ_BEFORE_STOP')
  runtime.pauseAgent(run.runId, helper.id)
  await until(() => helper.status === 'paused')
  assert.equal(helperCall.signal.aborted, true)
  const stopped = runtime.stopAgent(run.runId, helper.id)
  assert.deepEqual(stopped, { ok: true, agentId: helper.id, status: 'cancelled', paused: false })
  await completed(runtime, run)
  assert.equal(helper.status, 'cancelled')
  assert.equal(helper.stoppedByUser, true)
  assert.equal(helper.error, STOPPED_BY_USER)
  assert.equal(helper.detail, 'Остановлен вами')
  assert.match(helper.result, /READ_BEFORE_STOP/)
  assert.ok(rootPrompts[1].includes(STOPPED_BY_USER))
  assert.match(rootPrompts[1], /READ_BEFORE_STOP/)
  assert.equal(run.pauseWaiters.size, 0)
})

test('helpers under a stopped helper keep the reason they were stopped with', async t => {
  let subCall, rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (/Agent: Sub;/.test(options.prompt)) { subCall = options; return aborts(options) }
    if (/Agent: Helper;/.test(options.prompt)) return response(tool('spawn_agent', { name: 'Sub', task: 'Look deeper', reason: 'Nested check' }), tool('wait_agent'))
    if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' }), tool('wait_agent'))
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await until(() => subCall)
  const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  const sub = [...run.agentNodes.values()].find(agent => agent.name === 'Sub')
  runtime.stopAgent(run.runId, helper.id)
  await run.tasks.get(sub.id)
  await completed(runtime, run)
  assert.equal(sub.status, 'cancelled')
  assert.equal(sub.detail, 'Остановлен вместе с руководителем')
  assert.equal(helper.detail, 'Остановлен вами')
})

test('stopping a helper wakes its supervisor waiting for a message; what the helper did comes with the next turn', async t => {
  let helperCall, rootTurns = 0
  const rootPrompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (/Agent: Helper;/.test(options.prompt)) { helperCall = options; return aborts(options) }
    rootPrompts.push(options.prompt)
    if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' }), tool('wait_message', { timeout_ms: 20000 }))
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => helperCall && root.detail === 'Waiting for a message')
  const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  runtime.recordLedger(helper, 'read_file', 'READ_BEFORE_STOP')
  runtime.stopAgent(run.runId, helper.id)
  // until() gives up after 4 s: without the wake the supervisor would wait the whole 20 s.
  await completed(runtime, run)
  const waited = JSON.parse(root.transcript.find(entry => entry.type === 'tool_result' && entry.name === 'wait_message').result)
  assert.equal(waited.timedOut, false)
  assert.deepEqual(waited.stopped, [{ agentId: helper.id, name: 'Helper', status: 'cancelled' }])
  assert.match(waited.note, /The user stopped these helpers/)
  assert.equal(rootPrompts.length, 2)
  assert.match(rootPrompts[1], /READ_BEFORE_STOP/)
  assert.ok(rootPrompts[1].includes(STOPPED_BY_USER))
  assert.equal(root.transcript.filter(entry => entry.type === 'child_result').length, 1)
})

test('in a session a stopped helper ends the wait for mail once, and its result comes once', async t => {
  const calls = [], waits = []
  let run, helperCall
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) { helperCall = options; return aborts(options) }
    calls.push(options)
    if (calls.length === 1) {
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
      waits.push(JSON.parse((await runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 20000 })).text))
      waits.push(JSON.parse((await runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 50 })).text))
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => helperCall && root.detail === 'Waiting for a message')
  const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  runtime.recordLedger(helper, 'read_file', 'READ_BEFORE_STOP')
  runtime.stopAgent(run.runId, helper.id)
  await completed(runtime, run)
  assert.deepEqual(waits[0].stopped, [{ agentId: helper.id, name: 'Helper', status: 'cancelled' }])
  assert.equal(waits[1].timedOut, true, 'a helper already named does not end the next wait')
  assert.equal(waits[1].stopped, undefined)
  assert.equal(calls.length, 2, 'the answer is resumed once with the helper result')
  assert.match(calls[1].prompt, /HELPER RESULT — Helper \(cancelled\)/)
  assert.match(calls[1].prompt, /READ_BEFORE_STOP/)
})

test('a wait for mail left behind by a pause names no helper stopped meanwhile; the resumed session gets its result', async t => {
  const calls = []
  let run, helperCall
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) { helperCall = options; return aborts(options) }
    calls.push(options)
    if (calls.length === 1) {
      runtime.postUserMessage(run.runId, 'root', 'KEEP_GOING')
      return { text: 'Premature answer', sessionId: 'kept-session-id' }
    }
    if (calls.length === 2) {
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
      void runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 20000 })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => helperCall && root.detail === 'Waiting for a message')
  runtime.pauseAgent(run.runId, 'root')
  await until(() => root.status === 'paused')
  const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  runtime.stopAgent(run.runId, helper.id)
  await until(() => root.transcript.some(entry => entry.type === 'tool_result' && entry.name === 'wait_message'))
  assert.equal(JSON.parse(root.transcript.find(entry => entry.name === 'wait_message').result).stopped, undefined, 'the cut-off turn takes no answer')
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.ok(calls.slice(2).some(call => call.prompt.includes(STOPPED_BY_USER)), 'the resumed session learns what the stopped helper did')
})

// The answer of a wait the test started without awaiting it; until() fails in 4 s if the wait outlives its turn.
async function settled(pending) {
  let answer
  pending.then(result => { answer = result })
  await until(() => answer, 'the wait ends with its turn')
  return answer
}

test('a session wait for mail cut off by a pause takes nothing: a message written during the pause comes as the user\'s words', async t => {
  const calls = []
  let run, wait
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      runtime.postUserMessage(run.runId, 'root', 'KEEP_GOING')
      return { text: 'Premature answer', sessionId: 'kept-session-id' }
    }
    if (calls.length === 2) {
      wait = runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 20000 })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => root.detail === 'Waiting for a message')
  runtime.pauseAgent(run.runId, 'root')
  const left = await settled(wait)
  assert.equal(left.ok, false)
  assert.match(left.error, /^Your turn ended before this wait could answer/)
  runtime.postUserMessage(run.runId, 'root', 'WRITTEN_DURING_PAUSE')
  await sleep(50)
  const message = run.communications.find(item => item.text === 'WRITTEN_DURING_PAUSE')
  assert.equal(message.readAt, undefined, 'no wait left behind takes it')
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.match(calls[2].prompt, /MESSAGE FROM THE USER/)
  assert.ok(calls[2].prompt.includes('] WRITTEN_DURING_PAUSE'), 'the resumed turn reads it as the user\'s words, not as a past record')
  assert.equal(message.delivery, 'next-turn')
})

test('a session wait for helpers cut off by a pause marks no result seen: a helper that finishes later comes as a helper result', async t => {
  const calls = [], helperCalls = [], finish = deferred()
  let wait
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) {
      helperCalls.push(options)
      if (helperCalls.length === 1) return aborts(options)
      await finish.promise
      return { text: 'HELPER_FINDINGS', sessionId: options.session.id }
    }
    calls.push(options)
    if (calls.length === 1) {
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
      wait = runtime.dispatchMcp(options.session.token, 'wait_agent', {})
      return aborts(options)
    }
    if (calls.length === 2) return { text: 'Answer before the helper', sessionId: options.session.id }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => helperCalls.length === 1 && root.detail === 'Waiting for delegated results')
  runtime.pauseAgent(run.runId, 'root')
  const left = await settled(wait)
  assert.equal(left.ok, false)
  assert.match(left.error, /^Your turn ended before this wait could answer/)
  runtime.resumeAgent(run.runId, 'root')
  await until(() => helperCalls.length === 2 && calls.length === 2)
  finish.resolve()
  await completed(runtime, run)
  assert.ok(calls.slice(2).some(call => call.prompt.includes('HELPER RESULT — Helper (done)') && call.prompt.includes('HELPER_FINDINGS')), 'the root gets the helper result')
})

test('a wait that found mail while its turn waited for the model slot takes nothing when a pause cuts the turn off first', async t => {
  const calls = [], helperCalls = []
  let run, wait
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) {
      helperCalls.push(options)
      // The helper holds the only slot until the pause cuts it off, then finishes at once.
      return helperCalls.length === 1 ? aborts(options) : { text: 'HELPER_DONE', sessionId: options.session.id }
    }
    calls.push(options)
    if (calls.length === 1) {
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
      wait = runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 20000 })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime, { limits: { maxConcurrent: 1 } })
  const root = run.agentNodes.get('root')
  await until(() => helperCalls.length === 1 && root.detail === 'Waiting for a message')
  runtime.postUserMessage(run.runId, 'root', 'WRITTEN_WHILE_WAITING')
  await until(() => run.turnQueue.length === 1, 'the woken wait waits for the slot the helper holds')
  runtime.pauseAgent(run.runId, 'root')
  const left = await settled(wait)
  assert.equal(left.ok, false)
  assert.match(left.error, /^Your turn ended before this wait could answer/)
  const message = run.communications.find(item => item.text === 'WRITTEN_WHILE_WAITING')
  assert.equal(message.readAt, undefined, 'the wait took nothing it could not hand over')
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.ok(calls.slice(1).some(call => call.prompt.includes('] WRITTEN_WHILE_WAITING')), 'a later turn reads it as the user\'s words')
  assert.equal(message.delivery, 'next-turn')
})

test('a wait for a helper that finished while its turn waited for the model slot marks nothing seen when a pause cuts the turn off', async t => {
  const calls = [], seconds = []
  let run, wait
  const nameOf = options => /running as agent "([^"]+)"/.exec(options.session.systemAppend)[1]
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (nameOf(options) === 'First') return { text: 'FIRST_FINDINGS', sessionId: options.session.id }
    // Second takes the only slot when First is done and holds it until the pause cuts it off.
    if (nameOf(options) === 'Second') { seconds.push(options); return seconds.length === 1 ? aborts(options) : { text: 'SECOND_DONE', sessionId: options.session.id } }
    calls.push(options)
    if (calls.length === 1) {
      // First queues for the slot ahead of Second, so it runs first when the wait gives the slot away.
      const first = JSON.parse((await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'First', task: 'Check one thing', reason: 'Independent check' })).text)
      await until(() => run.turnQueue.length === 1)
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Second', task: 'Check another thing', reason: 'Independent check' })
      await until(() => run.turnQueue.length === 2)
      wait = runtime.dispatchMcp(options.session.token, 'wait_agent', { agentId: first.agentId })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime, { limits: { maxConcurrent: 1 } })
  await until(() => seconds.length === 1 && run.turnQueue.length === 1, 'the woken wait waits for the slot Second holds')
  runtime.pauseAgent(run.runId, 'root')
  const left = await settled(wait)
  assert.equal(left.ok, false)
  assert.match(left.error, /^Your turn ended before this wait could answer/)
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  // A wait that took the result would have marked it seen: then no helper result would join the root's record.
  const root = run.agentNodes.get('root'), first = [...run.agentNodes.values()].find(agent => agent.name === 'First')
  assert.ok(root.transcript.some(entry => entry.type === 'child_result' && entry.agentId === first.id && entry.result === 'FIRST_FINDINGS'), 'the root gets the result the cut-off wait found')
})

test('a wait outside a running turn is refused: no model would read its answer', async t => {
  let token
  const helper = deferred()
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) { await helper.promise; return { text: 'HELPER_DONE', sessionId: options.session.id } }
    if (token) return { text: 'FINAL_ANSWER', sessionId: options.session.id }
    token = options.session.token
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
    return { text: 'Answer before the helper', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => root.detail === 'Waiting for delegated results' && !root.activeTurn)
  for (const name of ['wait_message', 'wait_agent']) {
    const refused = await runtime.dispatchMcp(token, name, { timeout_ms: 50 })
    assert.equal(refused.ok, false, name)
    assert.match(refused.error, /^Your turn ended before this wait could answer/, name)
  }
  helper.resolve()
  await completed(runtime, run)
})

test('a session turn cut off by a pause is repeated with the results of helpers that finished before the cut', async t => {
  const calls = []
  let run
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (!options.session.token.startsWith('token-root-')) return { text: 'HELPER_FINDINGS', sessionId: options.session.id }
    calls.push(options)
    if (calls.length === 1) {
      runtime.postUserMessage(run.runId, 'root', 'KEEP_GOING')
      return { text: 'Premature answer', sessionId: 'kept-session-id' }
    }
    if (calls.length === 2) {
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  await until(() => [...run.agentNodes.values()].some(agent => agent.name === 'Helper' && agent.status === 'done'))
  runtime.pauseAgent(run.runId, 'root')
  await until(() => run.agentNodes.get('root').status === 'paused')
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.match(calls[2].prompt, /^PAUSED BY THE USER/)
  assert.ok(calls[2].prompt.includes('HELPER RESULT — Helper (done)') && calls[2].prompt.includes('HELPER_FINDINGS'), 'the repeated turn gets the result at once')
  assert.equal(calls.length, 3, 'no extra turn just for the result')
})

test('a session wait that times out takes its model slot back before the turn goes on', async t => {
  let after
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    const live = [...runtime.runs.values()][0]
    const waited = JSON.parse((await runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 20 })).text)
    after = { timedOut: waited.timedOut, activeTurns: live.activeTurns, held: live.agentNodes.get('root').activeTurn.slot.held }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime)
  await completed(runtime, run)
  assert.deepEqual(after, { timedOut: true, activeTurns: 1, held: true })
})

test('pausing the root interrupts working descendants, while a direct helper pause survives root resume', async t => {
  const calls = { root: [], Helper: [] }
  const runtime = new OrbitRuntime({ runProvider: async options => {
    const name = /Agent: Helper;/.test(options.prompt) ? 'Helper' : 'root'
    calls[name].push(options)
    if (name === 'root' && calls.root.length === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' }))
    if ((name === 'root' && calls.root.length === 2) || (name === 'Helper' && calls.Helper.length === 1)) return aborts(options)
    return { text: name === 'root' ? 'FINAL_ANSWER' : 'HELPER_RESULT' }
  } })
  const run = await start(t, runtime)
  await until(() => calls.root.length === 2 && calls.Helper.length === 1)
  const root = run.agentNodes.get('root'), helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
  runtime.pauseAgent(run.runId, 'root')
  await until(() => root.status === 'paused' && helper.status === 'paused')
  assert.equal(calls.root[1].signal.aborted, true)
  assert.equal(calls.Helper[0].signal.aborted, true)
  assert.match(helper.detail, new RegExp(root.name))
  assert.equal(!!helper.paused, false, 'an inherited pause does not set the helper own flag')
  assert.equal(pausedBy(run, helper), root)
  await sleep(150)
  assert.equal(calls.root.length, 2); assert.equal(calls.Helper.length, 1)
  runtime.pauseAgent(run.runId, helper.id)
  runtime.resumeAgent(run.runId, 'root')
  await until(() => calls.root.length >= 3)
  await sleep(40)
  assert.equal(helper.status, 'paused'); assert.equal(helper.paused, true)
  assert.equal(calls.Helper.length, 1)
  assert.equal(runtime.agentDirectory(run).find(agent => agent.id === helper.id).paused, true)
  runtime.resumeAgent(run.runId, helper.id)
  await completed(runtime, run)
  assert.equal(calls.Helper.length, 2)
  assert.ok(calls.Helper[1].prompt.includes(`${root.name}, whom you work under`))
})

for (const failResume of [false, true]) test(`session pause preserves the session and interrupted input${failResume ? ', then drops an unusable resume once' : ''}`, async t => {
  const calls = []
  let run
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      runtime.postUserMessage(run.runId, 'root', 'INPUT_ON_INTERRUPTED_TURN')
      return { text: 'Premature answer', sessionId: 'kept-session-id' }
    }
    if (calls.length === 2) return aborts(options)
    if (failResume && calls.length === 3) throw new Error('The killed session is unreadable')
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  run = await start(t, runtime)
  await until(() => calls.length === 2)
  const root = run.agentNodes.get('root')
  runtime.pauseAgent(run.runId, 'root')
  await until(() => root.status === 'paused')
  assert.equal(calls[1].signal.aborted, true)
  const refused = await runtime.dispatchMcp(calls[1].session.token, 'list_agents')
  assert.equal(refused.ok, false); assert.equal(refused.error, 'Paused by the user')
  assert.equal(runtime.getRun(run.runId).agents[0].pausedSession, undefined, 'session fallback bookkeeping is internal')
  await sleep(150)
  assert.equal(calls.length, 2)
  runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.equal(calls.length, failResume ? 4 : 3)
  assert.equal(calls[2].session.id, 'kept-session-id'); assert.equal(calls[2].session.resume, true)
  assert.match(calls[2].prompt, /^PAUSED BY THE USER/)
  assert.match(calls[2].prompt, /INPUT_ON_INTERRUPTED_TURN/)
  assert.match(calls[2].prompt, /The user wrote to you while you were working/)
  assert.equal(root.pausedSession, null)
  if (failResume) {
    assert.equal(calls[3].session.resume, false)
    assert.notEqual(calls[3].session.id, 'kept-session-id')
    assert.equal(calls[3].prompt.split('PAUSED BY THE USER').length - 1, 1, 'the fresh session carries the pause note once')
    assert.match(calls[3].prompt, /INPUT_ON_INTERRUPTED_TURN/)
    assert.equal(run.traces.filter(trace => trace.kind === 'transport' && /before the pause/.test(trace.text)).length, 1)
  }
})

test('a paused first session turn starts fresh with the note, and a failed fresh start is not retried again', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) return aborts(options)
    throw new Error('Fresh session failed')
  } })
  const run = await start(t, runtime)
  await until(() => calls.length === 1)
  runtime.pauseAgent(run.runId, 'root')
  await until(() => run.agentNodes.get('root').status === 'paused')
  runtime.resumeAgent(run.runId, 'root')
  await until(() => run.status !== 'working')
  assert.equal(run.status, 'failed')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].session.resume, false)
  assert.match(calls[1].prompt, /PAUSED BY THE USER/)
})

test('pause gates the remaining envelope tool batch and whole-run stop clears the gate', async t => {
  let tools = 0
  const runtime = new OrbitRuntime({ runProvider: async () => response(tool('list_agents'), tool('list_agents')) })
  const execute = runtime.executeTool.bind(runtime)
  runtime.executeTool = async (run, agent, name, args) => {
    tools++
    const result = await execute(run, agent, name, args)
    if (tools === 1) runtime.pauseAgent(run.runId, agent.id)
    return result
  }
  const run = await start(t, runtime)
  await until(() => run.agentNodes.get('root').status === 'paused')
  await sleep(150)
  assert.equal(tools, 1)
  runtime.stop(run.runId)
  await until(() => run.pauseWaiters.size === 0)
  assert.equal(run.status, 'cancelled')
  assert.equal(tools, 1)
})

test('control refusals explain missing and finished agents and root stop; resume of a running agent is a no-op', async t => {
  let called = false
  const runtime = new OrbitRuntime({ runProvider: async options => { called = true; return aborts(options) } })
  const run = await start(t, runtime)
  await until(() => called)
  const root = run.agentNodes.get('root')
  const helper = runtime.createAgent(run, root, { name: 'Finished', task: 'Already done' })
  runtime.updateAgent(run, helper, { status: 'done' })
  assert.throws(() => runtime.stopAgent(run.runId, 'root'), { message: 'Основной агент останавливается кнопкой «Стоп» в чате: она останавливает весь запуск.' })
  assert.throws(() => runtime.pauseAgent(run.runId, helper.id), { message: 'Finished уже завершил работу.' })
  assert.throws(() => runtime.stopAgent(run.runId, helper.id), { message: 'Finished уже завершил работу.' })
  assert.throws(() => runtime.pauseAgent(run.runId, 'missing'), { message: 'В этом запуске нет такого агента.' })
  assert.throws(() => runtime.pauseAgent('missing', 'root'), { message: 'Этот запуск уже завершён.' })
  const traces = run.traces.length
  assert.deepEqual(runtime.resumeAgent(run.runId, 'root'), { ok: true, agentId: 'root', status: 'working', paused: false })
  assert.equal(run.traces.length, traces)
  runtime.updateAgent(run, root, { status: 'done' })
  assert.throws(() => runtime.pauseAgent(run.runId, 'root'), { message: 'Агент уже закончил ответ.' })
  runtime.stop(run.runId)
  assert.throws(() => runtime.resumeAgent(run.runId, 'root'), { message: 'Этот запуск уже завершён.' })
})
