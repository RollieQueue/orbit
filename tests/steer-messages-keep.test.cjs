const test = require('node:test')
const assert = require('node:assert/strict')
const { OrbitRuntime, sleep, deferred, until, aborts, fakeMcp, start, completed, callerName, steerTraces, helperNamed, userMessages } = require('./helpers-steer-messages.cjs')

// Mail that does not cut the turn: a running native tool, an Orbit call the stream announced or one in flight (its result
// carries the mail), a message from a peer.

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
  assert.match(listed.text, /\n\n\[orbit:[0-9a-f]{10}\] MESSAGE FROM THE USER \([^\n]*\):\n\[[^\]]+\] STEER_NOW$/)
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
