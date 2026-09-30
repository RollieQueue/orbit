const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')

// The user writes to an agent of a working run (runtime:message → runtime.postUserMessage): the message waits in the
// agent's mailbox and reaches the model at its next step as the user's own words, on both transports.

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-user-messages-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function fakeMcp() {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {} }
}
async function finished(runtime, payload) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 5000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete without deadlock')
  return { snapshot: runtime.getRun(runId), runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Current task', ...extra })
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const runIdOf = runtime => [...runtime.runs.keys()][0]
const fromUser = snapshot => snapshot.communications.filter(message => message.fromAgentId === 'user' && message.kind === 'message')

test('envelope: a message the user sends during a turn leads the next prompt and keeps the agent from finishing', async t => {
  const workspace = folder(t)
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    prompts.push(options.prompt)
    if (prompts.length === 1) {
      const sent = runtime.postUserMessage(runIdOf(runtime), 'root', '  USER_STEER: use the other file  ')
      assert.equal(sent.ok, true); assert.equal(sent.agentId, 'root'); assert.equal(sent.status, 'queued')
      return { text: 'Premature answer' }
    }
    return { text: 'FINAL_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(prompts.length, 2, 'the answer written before the message is not accepted')
  assert.doesNotMatch(prompts[0], /MESSAGE FROM THE USER/)
  assert.match(prompts[1], /MESSAGE FROM THE USER \(written to you while you work[^\n]*:\n\[[^\]]+\] USER_STEER: use the other file/)
  assert.doesNotMatch(prompts[1], /TEAM CORRESPONDENCE[^\n]*\n[^\n]*USER_STEER/, 'the user is not quoted as team mail')
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
  const [message] = fromUser(snapshot)
  assert.deepEqual({ from: message.fromAgentName, to: message.toAgentId, via: message.via, status: message.status, text: message.text }, { from: 'Вы', to: 'root', via: 'user', status: 'read', text: 'USER_STEER: use the other file' })
  assert.ok(snapshot.traces.some(trace => trace.agentId === 'root' && trace.kind === 'message' && trace.text === 'From the user: USER_STEER: use the other file'))
})

test('session: the message rides on the next Orbit tool result, whole, and is not delivered twice', async t => {
  const workspace = folder(t)
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    runtime.postUserMessage(runIdOf(runtime), 'root', 'USER_STEER')
    const listed = await runtime.dispatchMcp(options.session.token, 'list_agents', {})
    assert.equal(listed.ok, true)
    assert.match(listed.text, /\n\n\[orbit\] MESSAGE FROM THE USER \([^\n]*\):\n\[[^\]]+\] USER_STEER$/)
    assert.equal(listed.unread, 0, 'the delivered message is not also reported as unread mail')
    const again = await runtime.dispatchMcp(options.session.token, 'list_agents', {})
    assert.doesNotMatch(again.text, /USER_STEER/)
    return { text: 'FINAL_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(calls.length, 1, 'no extra turn for a message the model already saw')
  assert.match(calls[0].session.systemAppend, /The user can write to you while you work/)
  assert.ok(calls[0].session.systemAppend.length <= 6000)
  const [message] = fromUser(snapshot)
  assert.equal(message.status, 'read'); assert.equal(message.delivery, 'tool-result')
})

test('session: a message after the last Orbit call resumes the session with it before the answer is accepted', async t => {
  const workspace = folder(t)
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { runtime.postUserMessage(runIdOf(runtime), 'root', 'USER_STEER'); return { text: 'Premature answer', sessionId: options.session.id } }
    return { text: 'FINAL_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].session.resume, true)
  assert.match(calls[1].prompt, /^The user wrote to you while you were working \(below\)\. Act on it, then give your final answer\./)
  assert.match(calls[1].prompt, /MESSAGE FROM THE USER[^\n]*:\n\[[^\]]+\] USER_STEER/)
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
  assert.equal(fromUser(snapshot)[0].status, 'read')
})

test('a finished helper the user writes to works again, and its parent gets the new result', async t => {
  const workspace = folder(t)
  const helperPrompts = []
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (/Agent: Helper;/.test(options.prompt)) {
      helperPrompts.push(options.prompt)
      return { text: helperPrompts.length === 1 ? 'HELPER_V1' : 'HELPER_V2' }
    }
    rootTurns++
    if (rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check one thing', reason: 'Independent check' }), tool('wait_agent'))
    if (rootTurns === 2) {
      assert.match(options.prompt, /HELPER_V1/)
      const run = runtime.runs.get(runIdOf(runtime))
      const helper = [...run.agentNodes.values()].find(agent => agent.name === 'Helper')
      assert.equal(helper.status, 'done')
      const sent = runtime.postUserMessage(run.runId, helper.id, 'REDO_WITH_TESTS')
      assert.equal(sent.agentId, helper.id)
      assert.equal(helper.status, 'waiting'); assert.equal(helper.generation, 1)
      return response(tool('wait_agent'))
    }
    assert.match(options.prompt, /HELPER_V2/)
    return { text: 'FINAL_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(helperPrompts.length, 2)
  assert.match(helperPrompts[1], /MESSAGE FROM THE USER[^\n]*:\n\[[^\]]+\] REDO_WITH_TESTS/)
  assert.equal(snapshot.agents.find(agent => agent.name === 'Helper').result, 'HELPER_V2')
})

test('refusals name the reason: finished run, unknown agent, empty text', async t => {
  const workspace = folder(t)
  let runId
  const runtime = new OrbitRuntime({ runProvider: async () => {
    runId = runIdOf(runtime)
    assert.throws(() => runtime.postUserMessage(runId, 'agent-nope', 'hello'), /нет такого агента/)
    assert.throws(() => runtime.postUserMessage(runId, 'root', '   '), /пустое/)
    assert.throws(() => runtime.postUserMessage('no-such-run', 'root', 'hello'), /завершён/)
    return { text: 'Done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.throws(() => runtime.postUserMessage(runId, 'root', 'too late'), /завершён/)
  assert.equal(fromUser(snapshot).length, 0)
})
