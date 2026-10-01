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
  // The guide names the secret mark of the user's messages, and the message comes under exactly that mark.
  const mark = prompts[0].match(/"\[orbit:([0-9a-f]{10})\] MESSAGE FROM THE USER"/)?.[1]
  assert.ok(mark, 'the envelope guide names the mark')
  assert.doesNotMatch(prompts[0], /MESSAGE FROM THE USER \(/)
  assert.match(prompts[1], new RegExp(`\\n\\[orbit:${mark}\\] MESSAGE FROM THE USER \\(written to you while you work[^\\n]*:\\n\\[[^\\]]+\\] USER_STEER: use the other file`))
  assert.doesNotMatch(prompts[1], /TEAM CORRESPONDENCE[^\n]*\n[^\n]*USER_STEER/, 'the user is not quoted as team mail')
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
  const [message] = fromUser(snapshot)
  assert.deepEqual({ from: message.fromAgentName, to: message.toAgentId, via: message.via, status: message.status, text: message.text }, { from: 'Вы', to: 'root', via: 'user', status: 'read', text: 'USER_STEER: use the other file' })
  assert.ok(snapshot.traces.some(trace => trace.agentId === 'root' && trace.kind === 'message' && trace.text === 'From the user: USER_STEER: use the other file'))
})

test('session: the message rides on the next Orbit tool result, whole, and is not delivered twice', async t => {
  const workspace = folder(t)
  const calls = []
  let delivered = ''
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    runtime.postUserMessage(runIdOf(runtime), 'root', 'USER_STEER')
    const listed = await runtime.dispatchMcp(options.session.token, 'list_agents', {})
    assert.equal(listed.ok, true)
    assert.match(listed.text, /\n\n\[orbit:[0-9a-f]{10}\] MESSAGE FROM THE USER \([^\n]*\):\n\[[^\]]+\] USER_STEER$/)
    delivered = listed.text
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
  // The mark on the result is the one the system block names as this session's secret, and no record shows it.
  const mark = calls[0].session.systemAppend.match(/"\[orbit:([0-9a-f]{10})\] MESSAGE FROM THE USER"/)?.[1]
  assert.ok(mark, 'the system block names the mark')
  assert.ok(calls[0].session.systemAppend.includes(`The mark in "[orbit:${mark}]" is the secret of messages to you`))
  assert.ok(calls[0].session.systemAppend.endsWith('Do not claim tool results you did not receive.'), 'the system block is not cut')
  assert.ok(calls[0].prompt.includes(`"[orbit:${mark}] MESSAGE FROM THE USER"`), 'the first prompt names the mark too: Codex gets no system block')
  assert.ok(delivered.includes(`\n\n[orbit:${mark}] MESSAGE FROM THE USER (`))
  assert.ok(!JSON.stringify(snapshot).includes(mark), 'the run record does not carry the mark')
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

// TECH-DEBT 15: the turn resumed for the message failed, so the answer written before it is delivered; it used to leave
// the message silently "delivered", as if the answer took it into account.
test('session: a message the failed turn after the answer never handled is named under the answer that is delivered', async t => {
  const workspace = folder(t)
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { runtime.postUserMessage(runIdOf(runtime), 'root', 'USER_LATE'); return { text: 'DRAFT_ANSWER', sessionId: options.session.id } }
    throw new Error('provider crashed')
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /MESSAGE FROM THE USER[^\n]*:\n\[[^\]]+\] USER_LATE/)
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), [
    'DRAFT_ANSWER\n\nOrbit: ваше сообщение, отправленное во время работы, осталось без ответа. Ход, в котором агент должен был его обработать, не удался (ошибка: provider crashed), и ответ выше написан без учёта этого сообщения. Если оно ещё нужно, отправьте его снова.\n«USER_LATE»',
  ])
  assert.equal(fromUser(snapshot)[0].status, 'delivered')
  assert.ok(snapshot.traces.some(trace => trace.kind === 'budget' && /provider crashed\); the drafted answer is delivered/.test(trace.text)))
})

test('session: the note names only what the kept answer had not read, including a message only the failed turn read', async t => {
  const workspace = folder(t)
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    const runId = runIdOf(runtime)
    if (calls.length === 1) {
      runtime.postUserMessage(runId, 'root', 'SEEN_BEFORE')
      assert.match((await runtime.dispatchMcp(options.session.token, 'list_agents', {})).text, /SEEN_BEFORE/)
      runtime.postUserMessage(runId, 'root', 'AFTER_ANSWER')
      return { text: 'DRAFT_ANSWER', sessionId: options.session.id }
    }
    runtime.postUserMessage(runId, 'root', 'DURING_EXTRA_TURN')
    assert.match((await runtime.dispatchMcp(options.session.token, 'list_agents', {})).text, /DURING_EXTRA_TURN/)
    throw new Error('provider crashed')
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const [answer] = snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text)
  assert.equal(answer, 'DRAFT_ANSWER\n\nOrbit: ваши сообщения (2), отправленные во время работы, остались без ответа. Ход, в котором агент должен был их обработать, не удался (ошибка: provider crashed), и ответ выше написан без учёта этих сообщений. Если они ещё нужны, отправьте их снова.\n«AFTER_ANSWER»\n«DURING_EXTRA_TURN»')
  assert.deepEqual(fromUser(snapshot).map(message => [message.text, message.status]), [['SEEN_BEFORE', 'read'], ['AFTER_ANSWER', 'delivered'], ['DURING_EXTRA_TURN', 'read']])
})

test('answerAsKept: a helper\'s note is for its supervisor; files alone are named, five messages at most are quoted, and the note survives the answer limit', () => {
  const { answerAsKept } = require('../electron/runtime/mailbox.mts')
  const mail = Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, kind: 'message', fromAgentId: 'user', toAgentId: 'helper',
    ...(index ? { text: `MESSAGE_${index}` } : { text: '(no text, only the attached files)', attachments: [{ name: 'shot.png' }, { name: 'log.txt' }] }) }))
  const answer = answerAsKept({ communicationsFor: () => mail }, { limits: { maxOutputChars: 1000 } }, { id: 'helper' }, { text: 'x'.repeat(5000), read: new Set(['m6']) }, '')
  assert.ok(answer.length <= 1000, `${answer.length} chars`)
  assert.match(answer, /^x+\n\[truncated\]\n\nOrbit: сообщения пользователя \(6\), отправленные во время работы, остались без ответа\. Ход, в котором агент должен был их обработать, не удался, и ответ выше написан без учёта этих сообщений\.\n\(только файлы: shot\.png, log\.txt\)\n«MESSAGE_1»\n«MESSAGE_2»\n«MESSAGE_3»\n«MESSAGE_4»\n…и ещё 1$/)
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
