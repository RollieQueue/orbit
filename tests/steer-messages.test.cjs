const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const steer = require('../electron/runtime/steer.mts')

// Steering mail: what the user or an agent above the recipient writes while the recipient's turn runs. A session turn
// that makes no Orbit call is cut off at a step boundary and repeated at once (refunded), with the mail; an Orbit tool
// result carries the mail whole; a running native tool, an Orbit call in flight or a pause keep the turn as it is.
process.env.ORBIT_STEER_GRACE_MS = '20'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
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
function fakeMcp(activity) {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {}, ...(activity ? { activity } : {}) }
}
async function start(t, runtime, extra = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-steer-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false, ...extra })
  t.after(async () => { runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true }) })
  return runtime.runs.get(runId)
}
async function completed(runtime, run) {
  await until(() => run.status !== 'working', 'the run must finish without deadlock')
  assert.equal(run.status, 'completed', run.error)
  return runtime.getRun(run.runId)
}
// The agent a provider call serves: the fake MCP names its tokens `token-<agentId>-<n>` (a session prompt has no name).
const callerName = (runtime, options) => runtime.runs.values().next().value.agentNodes.get(options.session.token.replace(/^token-/, '').replace(/-\d+$/, ''))?.name
const steerTraces = (run, agentId) => run.traces.filter(trace => trace.agentId === agentId && trace.kind === 'steer')
const helperNamed = (run, name) => [...run.agentNodes.values()].find(agent => agent.name === name)
const userMessages = run => run.communications.filter(message => message.fromAgentId === 'user' && message.kind === 'message')
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const withEnv = async (name, value, body) => {
  const before = process.env[name]
  process.env[name] = value
  try { await body() } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before }
}
const withGrace = (value, body) => withEnv('ORBIT_STEER_GRACE_MS', value, body)

for (const claude of [true, false]) test(`session ${claude ? 'claude' : 'other provider'}: a user message cuts a turn without Orbit calls, and the refunded turn is repeated with it`, async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { options.onEvent({ kind: 'output', text: 'WORKING_TEXT', partial: true }); return aborts(options) }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: claude ? 'claude' : 'test' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await until(() => calls[0].signal.aborted, 'the turn is cut off for the message')
  const snapshot = await completed(runtime, run)
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, claude ? /^INTERRUPTED FOR A MESSAGE/ : /INTERRUPTED FOR A MESSAGE/)
  if (claude) {
    assert.equal(calls[1].session.resume, true)
    assert.equal(calls[1].session.id, calls[0].session.id)
    for (const text of ['MESSAGE FROM THE USER', 'STEER_NOW', 'WORKING_TEXT']) assert.ok(calls[1].prompt.includes(text), text)
    assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
  } else {
    assert.equal(calls[1].session.resume, false, 'a first turn of another provider has no session Orbit could resume')
    assert.ok(calls[1].prompt.includes('STEER_NOW'))
  }
  const root = run.agentNodes.get('root')
  assert.equal(root.turns, 1, 'the cut turn is refunded')
  assert.equal(run.usage.providerTurns, 1)
  assert.equal(steerTraces(run, 'root').length, 1)
  assert.match(steerTraces(run, 'root')[0].text, /^Ход прерван между шагами/)
  assert.equal(userMessages(run)[0].status, 'read')
})

test('session: a running native tool keeps the turn, and the turn is cut once the tool has finished', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) {
      options.onEvent({ kind: 'tool', native: true, toolId: 'bash-1', tool: 'Bash', text: 'npm test', status: 'started' })
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await sleep(300)
  assert.equal(calls[0].signal.aborted, false, 'a command is never cut in the middle')
  assert.equal(steerTraces(run, 'root').length, 0)
  calls[0].onEvent({ kind: 'tool', native: true, toolId: 'bash-1', tool: 'Bash', text: 'npm test', status: 'completed' })
  await until(() => calls[0].signal.aborted, 'the turn is cut after the tool ended')
  await completed(runtime, run)
  assert.equal(steerTraces(run, 'root').length, 1)
  assert.ok(calls[1].prompt.includes('STEER_NOW'))
})

test('session: an Orbit call the stream announced keeps the turn until its completion event arrives', async t => {
  const calls = []
  const orbitCall = status => ({ kind: 'tool', native: false, mcp: true, server: 'orbit', orbitTool: 'list_agents', tool: 'mcp__orbit__list_agents', toolId: 'mcp-1', text: 'list_agents {}', status })
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { options.onEvent(orbitCall('started')); return aborts(options) }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await sleep(300)
  assert.equal(calls[0].signal.aborted, false, 'an announced Orbit call is not cut')
  assert.equal(steerTraces(run, 'root').length, 0)
  calls[0].onEvent(orbitCall('completed'))
  await until(() => calls[0].signal.aborted, 'the turn is cut once the announced call has completed')
  await completed(runtime, run)
  assert.equal(steerTraces(run, 'root').length, 1)
  assert.ok(calls[1].prompt.includes('STEER_NOW'))
})

test('session: an Orbit call in flight keeps the turn, and the mail rides its result so no cut follows', async t => {
  const calls = []
  let pending = 1
  const done = deferred()
  const runtime = new OrbitRuntime({ mcp: fakeMcp(() => ({ pending, lastAt: Date.now() })), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    await done.promise
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await sleep(300)
  assert.equal(calls[0].signal.aborted, false, 'an Orbit call in flight is not cut')
  const listed = await runtime.dispatchMcp(calls[0].session.token, 'list_agents', {})
  assert.equal(listed.ok, true)
  assert.match(listed.text, /\n\n\[orbit\] MESSAGE FROM THE USER \([^\n]*\):\n\[[^\]]+\] STEER_NOW$/)
  pending = 0
  await sleep(300)
  assert.equal(calls[0].signal.aborted, false, 'the delivered mail no longer cuts the turn')
  done.resolve()
  await completed(runtime, run)
  assert.equal(calls.length, 1)
  assert.equal(steerTraces(run, 'root').length, 0)
  const [message] = userMessages(run)
  assert.equal(message.status, 'read'); assert.equal(message.delivery, 'tool-result')
})

// A root (session transport) that spawned Helper; `helperBody` answers Helper's calls. Returns what the tests inspect.
function supervisedRun(t, helperBody, { providerId = 'claude' } = {}) {
  const calls = { root: [], helper: [] }
  const spawned = deferred(), finished = deferred()
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    if (callerName(runtime, options) === 'Helper') {
      calls.helper.push(options)
      return helperBody(options, calls.helper.length)
    }
    calls.root.push(options)
    if (calls.root.length === 1) {
      const spawnedResult = await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
      assert.equal(spawnedResult.ok, true, spawnedResult.text)
      spawned.resolve(options)
      const waited = await runtime.dispatchMcp(options.session.token, 'wait_agent', {})
      finished.resolve(waited)
      return { text: 'FINAL_ANSWER' }
    }
    return { text: 'FINAL_ANSWER' }
  } })
  return { runtime, calls, spawned: spawned.promise, finished: finished.promise, start: () => start(t, runtime, { providerId }) }
}

test('session: a supervisor message cuts the helper turn, which resumes its session with the note and the message', async t => {
  const setup = supervisedRun(t, (options, count) => {
    if (count === 1) { options.onEvent({ kind: 'output', text: 'HELPER_TEXT', partial: true }); return aborts(options) }
    return { text: 'HELPER_RESULT', sessionId: options.session.id }
  })
  const run = await setup.start()
  const rootOptions = await setup.spawned
  await until(() => setup.calls.helper.length === 1)
  const sent = await setup.runtime.dispatchMcp(rootOptions.session.token, 'send_message', { agentId: 'Helper', message: 'CHANGE_PLAN' })
  assert.equal(sent.ok, true, sent.text)
  await until(() => setup.calls.helper[0].signal.aborted, 'the helper turn is cut for its supervisor')
  const waited = await setup.finished
  assert.equal(waited.ok, true)
  assert.match(waited.text, /HELPER_RESULT/)
  await completed(setup.runtime, run)
  const helper = helperNamed(run, 'Helper')
  assert.equal(setup.calls.helper.length, 2)
  assert.equal(setup.calls.helper[1].session.resume, true)
  assert.equal(setup.calls.helper[1].session.id, setup.calls.helper[0].session.id)
  assert.match(setup.calls.helper[1].prompt, /^INTERRUPTED FOR A MESSAGE/)
  assert.ok(setup.calls.helper[1].prompt.includes('CHANGE_PLAN'))
  assert.equal(steerTraces(run, helper.id).length, 1)
  assert.equal(helper.turns, 1, 'the cut turn is refunded')
})

test('session: supervisor mail rides the end of the helper Orbit tool result, whole, and does not cut the turn', async t => {
  const results = deferred(), go = deferred()
  const setup = supervisedRun(t, async options => {
    await go.promise
    const listed = await setup.runtime.dispatchMcp(options.session.token, 'list_agents', {})
    results.resolve(listed)
    return { text: 'HELPER_RESULT' }
  })
  const run = await setup.start()
  const rootOptions = await setup.spawned
  await until(() => setup.calls.helper.length === 1)
  const sent = await setup.runtime.dispatchMcp(rootOptions.session.token, 'send_message', { agentId: 'Helper', message: 'ROOT_NOTE' })
  assert.equal(sent.ok, true, sent.text)
  const communicationId = JSON.parse(sent.text).communicationId
  assert.ok(communicationId)
  go.resolve()
  const listed = await results.promise
  assert.ok(listed.text.includes('\n\n[orbit] MESSAGE FROM YOUR SUPERVISOR ('), listed.text)
  assert.ok(listed.text.includes(`Orbit (message ${communicationId}): ROOT_NOTE`), listed.text)
  assert.equal(listed.unread, 0)
  await completed(setup.runtime, run)
  const communication = run.communications.find(message => message.id === communicationId)
  assert.equal(communication.status, 'read'); assert.equal(communication.delivery, 'tool-result')
  assert.equal(setup.calls.helper.length, 1, 'the helper is not cut')
  assert.equal(steerTraces(run, helperNamed(run, 'Helper').id).length, 0)
})

test('session: a message from a peer never cuts a turn; it only shows as unread mail', async t => {
  const calls = { root: [], Alpha: [], Beta: [] }
  const betaDone = deferred()
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    const name = callerName(runtime, options) === 'Orbit' ? 'root' : callerName(runtime, options)
    calls[name].push(options)
    if (name === 'Alpha') {
      await until(() => calls.Beta.length === 1)
      const sent = await runtime.dispatchMcp(options.session.token, 'send_message', { agentId: 'Beta', message: 'PEER_HI' })
      assert.equal(sent.ok, true, sent.text)
      return { text: 'ALPHA_RESULT' }
    }
    if (name === 'Beta') { await betaDone.promise; return { text: 'BETA_RESULT' } }
    if (calls.root.length === 1) {
      for (const helper of ['Alpha', 'Beta']) assert.equal((await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: helper, task: 'T', reason: 'R' })).ok, true)
      await runtime.dispatchMcp(options.session.token, 'wait_agent', {})
    }
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.Alpha.length === 1 && calls.Beta.length === 1)
  const beta = helperNamed(run, 'Beta')
  await until(() => run.communications.some(message => message.toAgentId === beta.id && message.text === 'PEER_HI'), 'the peer message was sent')
  await sleep(300)
  assert.equal(calls.Beta[0].signal.aborted, false)
  assert.equal(steerTraces(run, beta.id).length, 0)
  const listed = await runtime.dispatchMcp(calls.Beta[0].session.token, 'list_agents', {})
  assert.equal(listed.unread, 1)
  assert.doesNotMatch(listed.text, /MESSAGE FROM YOUR SUPERVISOR/)
  assert.equal(calls.Beta.length, 1)
  betaDone.resolve()
  await completed(runtime, run)
})

test('envelope: a user message cuts the turn; the repeated prompt carries the note and the message', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { options.onEvent({ kind: 'output', text: 'WORKING_TEXT', partial: true }); return aborts(options) }
    return { text: 'FINAL_ANSWER' }
  } })
  const run = await start(t, runtime)
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await until(() => calls[0].signal.aborted)
  await completed(runtime, run)
  assert.equal(calls.length, 2)
  for (const text of ['INTERRUPTED FOR A MESSAGE', 'MESSAGE FROM THE USER', 'STEER_NOW']) assert.ok(calls[1].prompt.includes(text), text)
  assert.equal(run.agentNodes.get('root').turns, 1)
  assert.equal(steerTraces(run, 'root').length, 1)
})

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
  await withGrace('400', async () => {
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
    await sleep(450)
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
    await sleep(700)
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

test('session: a diagnostic from a CLI still starting is not the model speaking; the cut waits for the model', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { options.onEvent({ kind: 'observation', text: 'warning: config not found', source: 'stderr' }); return aborts(options) }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  await sleep(300)
  assert.equal(calls[0].signal.aborted, false, 'the CLI has only printed a diagnostic')
  assert.equal(steerTraces(run, 'root').length, 0)
  calls[0].onEvent({ kind: 'reasoning', text: '', messageId: 'thinking', partial: true })
  await until(() => calls[0].signal.aborted, 'the turn is cut once the model has begun its step')
  await completed(runtime, run)
  assert.equal(calls[1].session.resume, true, 'the model spoke, so the session Orbit opened is resumed')
  assert.ok(calls[1].prompt.includes('STEER_NOW'))
})

test('session: a resumed turn cut again carries one note, not the notes of the earlier cuts', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length <= 2) { options.onEvent({ kind: 'output', text: `WORKING_${calls.length}`, partial: true }); return aborts(options) }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'FIRST_MESSAGE')
  await until(() => calls.length === 2)
  runtime.postUserMessage(run.runId, 'root', 'SECOND_MESSAGE')
  await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].session.resume, true)
  assert.equal(calls[2].session.id, calls[0].session.id)
  assert.equal(calls[2].prompt.match(/INTERRUPTED FOR A MESSAGE/g).length, 1, calls[2].prompt)
  assert.ok(calls[2].prompt.includes('WORKING_2') && !calls[2].prompt.includes('WORKING_1'), 'the note is about the latest cut turn')
  for (const text of ['FIRST_MESSAGE', 'SECOND_MESSAGE']) assert.ok(calls[2].prompt.includes(text), text)
})

test('steer.supervises and steer.steering: who steers whom', () => {
  const node = (id, parentId) => ({ id, parentId, name: id })
  const run = { agentNodes: new Map([['root', node('root', null)], ['mid', node('mid', 'root')], ['leaf', node('leaf', 'mid')], ['other', node('other', 'root')]]) }
  const mail = (from, to, kind = 'message') => ({ kind, fromAgentId: from, toAgentId: to })
  assert.equal(steer.supervises(run, 'mid', run.agentNodes.get('leaf')), true, 'the parent')
  assert.equal(steer.supervises(run, 'root', run.agentNodes.get('leaf')), true, 'the grandparent')
  assert.equal(steer.supervises(run, 'other', run.agentNodes.get('leaf')), false, 'a sibling branch')
  assert.equal(steer.supervises(run, 'other', run.agentNodes.get('mid')), false, 'a sibling')
  assert.equal(steer.supervises(run, 'leaf', run.agentNodes.get('leaf')), false, 'the agent itself')
  assert.equal(steer.steering(run, mail('mid', 'leaf', 'notice')), false, 'a notice never steers')
  assert.equal(steer.steering(run, mail('leaf', 'mid')), false, 'a helper does not steer its parent')
  assert.equal(steer.steering(run, mail('user', 'leaf')), true)
  assert.equal(steer.steering(run, mail('user', 'root')), true)
  assert.equal(steer.steering(run, mail('root', 'leaf')), true)
})

test('a prompt carries a supervisor message whole, ahead of other unread team mail that would fill the excerpt budget', async t => {
  const runtime = new OrbitRuntime({ runProvider: async options => aborts(options) })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  const helper = runtime.createAgent(run, root, { name: 'Helper', task: 'Work' })
  const peer = runtime.createAgent(run, root, { name: 'Peer', task: 'Work' })
  for (let index = 0; index < 3; index++) runtime.recordCommunication(run, peer, helper, `PEER_${index} ${'p'.repeat(2500)}`, { kind: 'message' })
  const long = `NEW_TASK ${'x'.repeat(5000)} END_OF_TASK`
  const order = runtime.recordCommunication(run, root, helper, long, { kind: 'message' })
  const mailbox = runtime.mailboxContext(run, helper)
  assert.ok(mailbox.text.startsWith('MESSAGE FROM YOUR SUPERVISOR ('), mailbox.text.slice(0, 200))
  assert.ok(mailbox.text.includes(`Orbit (message ${order.id}): ${long}`), 'the whole message, with its sender and id')
  const team = mailbox.text.slice(mailbox.text.indexOf('TEAM CORRESPONDENCE'))
  assert.ok(team.includes('PEER_0') && !team.includes('NEW_TASK'), 'team excerpts follow, without the supervisor message')
  assert.ok(mailbox.deliveredIds.includes(order.id))
  assert.equal(mailbox.fromUser, 0)
})
