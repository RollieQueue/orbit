const test = require('node:test')
const assert = require('node:assert/strict')
const steer = require('../electron/runtime/steer.mts')
const { OrbitRuntime, sleep, deferred, until, aborts, fakeMcp, start, completed, steerTraces, helperNamed, userMessages, userBlock, supervisedRun } = require('./helpers-steer-messages.cjs')

// Which messages cut a turn, and what the repeated turn is told: the note, the mail, the session. A turn that is kept for
// a running tool, a call in flight, a peer's message, a pause or a step under way is in steer-messages-keep.test.cjs and
// steer-messages-timing.test.cjs.

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

// Codex, Cursor and Antigravity name their sessions themselves, in the stream as the turn begins (a `session` event).
for (const spoke of [true, false]) test(`session other provider: a first turn cut ${spoke ? 'after its model spoke resumes the session its stream named' : 'before its model spoke starts fresh, whatever session its stream named'}`, async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length > 1) return { text: 'FINAL_ANSWER', sessionId: options.session.resume ? options.session.id : 'thread-fresh' }
    options.onEvent({ kind: 'session', sessionId: 'thread-named' })
    if (spoke) options.onEvent({ kind: 'output', text: 'WORKING_TEXT', partial: true })
    return aborts(options)
  } })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => calls.length === 1)
  assert.notEqual(calls[0].session.id, 'thread-named')
  assert.equal(root.turnTimings[0].sessionId, 'thread-named', 'the record of the turn names the real session, not the id Orbit proposed')
  // A message cuts a turn only once its model has spoken; a pause cuts it at once.
  if (spoke) runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  else { runtime.pauseAgent(run.runId, 'root'); await until(() => root.status === 'paused'); runtime.resumeAgent(run.runId, 'root') }
  await completed(runtime, run)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].session.resume, spoke)
  if (spoke) {
    assert.equal(calls[1].session.id, 'thread-named')
    assert.match(calls[1].prompt, /^INTERRUPTED FOR A MESSAGE/)
    for (const text of ['STEER_NOW', 'WORKING_TEXT']) assert.ok(calls[1].prompt.includes(text), text)
    assert.doesNotMatch(calls[1].prompt, /YOUR CURRENT TASK/, 'the resumed session holds the task')
  } else {
    assert.notEqual(calls[1].session.id, 'thread-named', 'the session may not hold the prompt yet')
    assert.match(calls[1].prompt, /YOUR CURRENT TASK/)
    assert.match(calls[1].prompt, /PAUSED BY THE USER/)
  }
  assert.equal(root.sessionId, spoke ? 'thread-named' : 'thread-fresh')
})

test('session other provider: a resume after a cut that the CLI answers in another session stops at once and starts afresh with the full prompt', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 3) return { text: 'FINAL_ANSWER', sessionId: 'thread-fresh' }
    // The first turn names its session and speaks; the resume finds nothing and silently opens another session.
    options.onEvent({ kind: 'session', sessionId: calls.length === 1 ? 'thread-named' : 'thread-stray' })
    options.onEvent({ kind: 'output', text: 'WORKING_TEXT', partial: true })
    return aborts(options)
  } })
  const run = await start(t, runtime)
  const root = run.agentNodes.get('root')
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'STEER_NOW')
  const snapshot = await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.deepEqual([calls[1].session.id, calls[1].session.resume], ['thread-named', true])
  assert.equal(calls[1].signal.aborted, true, 'the stray session is stopped before the model acts on a prompt without the task')
  assert.equal(calls[2].session.resume, false)
  for (const text of ['YOUR CURRENT TASK', 'STEER_NOW', 'INTERRUPTED FOR A MESSAGE']) assert.ok(calls[2].prompt.includes(text), text)
  assert.ok(run.traces.some(trace => trace.kind === 'transport' && /could not be resumed \(test opened session thread-stray instead of resuming thread-named\)/.test(trace.text)))
  assert.equal(root.turns, 1, 'the cut and the stray turn are refunded')
  assert.equal(root.sessionId, 'thread-fresh')
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
})

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
  // Under the helper's own secret mark, which its system block names; the root's mark is another.
  const markOf = options => options.session.systemAppend.match(/"\[orbit:([0-9a-f]{10})\] MESSAGE FROM YOUR SUPERVISOR"/)?.[1]
  const mark = markOf(setup.calls.helper[0])
  assert.ok(mark && markOf(rootOptions) && mark !== markOf(rootOptions), 'each agent has a mark of its own')
  assert.ok(listed.text.includes(`\n\n[orbit:${mark}] MESSAGE FROM YOUR SUPERVISOR (`), listed.text)
  assert.ok(listed.text.includes(`Orbit (message ${communicationId}): ROOT_NOTE`), listed.text)
  assert.equal(listed.unread, 0)
  await completed(setup.runtime, run)
  const communication = run.communications.find(message => message.id === communicationId)
  assert.equal(communication.status, 'read'); assert.equal(communication.delivery, 'tool-result')
  assert.equal(setup.calls.helper.length, 1, 'the helper is not cut')
  assert.equal(steerTraces(run, helperNamed(run, 'Helper').id).length, 0)
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
  let listed
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length <= 2) { options.onEvent({ kind: 'output', text: `WORKING_${calls.length}`, partial: true }); return aborts(options) }
    listed = await runtime.dispatchMcp(options.session.token, 'list_agents', {})
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
  // The second turn had spoken, so the session the third resumes holds its prompt: FIRST_MESSAGE is not handed over again.
  assert.ok(userBlock(calls[1].prompt).includes('FIRST_MESSAGE'), calls[1].prompt)
  assert.ok(userBlock(calls[2].prompt).includes('SECOND_MESSAGE') && !userBlock(calls[2].prompt).includes('FIRST_MESSAGE'), calls[2].prompt)
  assert.doesNotMatch(listed.text, /MESSAGE FROM THE USER/, 'nor at the end of an Orbit tool result')
  assert.deepEqual(userMessages(run).map(message => message.status), ['read', 'read'])
})

// Claude and Antigravity keep a cut turn's prompt in their session (checked live, pause.KEEPS_CUT_PROMPT); a CLI not
// known to keep it is given the mail again.
for (const [providerId, keeps] of [['antigravity', true], ['codex', false]]) test(`session ${providerId}: a resumed turn cut after it spoke ${keeps ? 'leaves its mail in the session, not handed over again' : 'is given its mail again (not known to keep a cut prompt)'}`, async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { runtime.postUserMessage(runtime.runs.keys().next().value, 'root', 'FIRST_MESSAGE'); return { text: 'Premature answer', sessionId: 'thread-1' } }
    if (calls.length === 2) { options.onEvent({ kind: 'output', text: 'WORKING_2', partial: true }); return aborts(options) }
    return { text: 'FINAL_ANSWER', sessionId: 'thread-1' }
  } })
  const run = await start(t, runtime, { providerId })
  await until(() => calls.length === 2)
  runtime.postUserMessage(run.runId, 'root', 'SECOND_MESSAGE')
  await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.equal(calls[2].session.resume, true)
  assert.equal(calls[2].session.id, 'thread-1')
  assert.ok(userBlock(calls[1].prompt).includes('FIRST_MESSAGE'), calls[1].prompt)
  assert.ok(userBlock(calls[2].prompt).includes('SECOND_MESSAGE'), calls[2].prompt)
  assert.equal(userBlock(calls[2].prompt).includes('FIRST_MESSAGE'), !keeps, calls[2].prompt)
  assert.deepEqual(userMessages(run).map(message => message.status), ['read', 'read'])
})

test('session antigravity: a resumed turn paused before its model spoke is given its mail again (its prompt may not be in the session)', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length === 1) { runtime.postUserMessage(runtime.runs.keys().next().value, 'root', 'FIRST_MESSAGE'); return { text: 'Premature answer', sessionId: 'thread-1' } }
    if (calls.length === 2) return aborts(options)
    return { text: 'FINAL_ANSWER', sessionId: 'thread-1' }
  } })
  const run = await start(t, runtime, { providerId: 'antigravity' })
  const root = run.agentNodes.get('root')
  await until(() => calls.length === 2)
  runtime.pauseAgent(run.runId, 'root'); await until(() => root.status === 'paused'); runtime.resumeAgent(run.runId, 'root')
  await completed(runtime, run)
  assert.equal(calls.length, 3)
  assert.deepEqual([calls[2].session.id, calls[2].session.resume], ['thread-1', true])
  assert.ok(userBlock(calls[1].prompt).includes('FIRST_MESSAGE'), calls[1].prompt)
  assert.ok(userBlock(calls[2].prompt).includes('FIRST_MESSAGE'), calls[2].prompt)
  assert.deepEqual(userMessages(run).map(message => message.status), ['read'])
})

test('session: mail a cut turn carried into its session reaches a fresh session again when that session cannot be resumed', async t => {
  const calls = []
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    if (calls.length <= 2) { options.onEvent({ kind: 'output', text: `WORKING_${calls.length}`, partial: true }); return aborts(options) }
    if (calls.length === 3) throw new Error('No conversation found with session ID')
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const run = await start(t, runtime, { providerId: 'claude' })
  await until(() => calls.length === 1)
  runtime.postUserMessage(run.runId, 'root', 'FIRST_MESSAGE')
  await until(() => calls.length === 2)
  runtime.postUserMessage(run.runId, 'root', 'SECOND_MESSAGE')
  await completed(runtime, run)
  assert.equal(calls.length, 4)
  assert.equal(calls[2].session.resume, true)
  assert.ok(!userBlock(calls[2].prompt).includes('FIRST_MESSAGE'), calls[2].prompt)
  assert.equal(calls[3].session.resume, false, 'the session that could not be resumed is dropped')
  for (const text of ['FIRST_MESSAGE', 'SECOND_MESSAGE']) assert.ok(userBlock(calls[3].prompt).includes(text), text)
  assert.deepEqual(userMessages(run).map(message => message.status), ['read', 'read'])
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

test('a helper that runs out of turns hands on the mail its results carried, without its secret mark', async t => {
  const runtime = new OrbitRuntime({ runProvider: async options => aborts(options) })
  const run = await start(t, runtime)
  const helper = runtime.createAgent(run, run.agentNodes.get('root'), { name: 'Helper', task: 'Work' })
  runtime.postUserMessage(run.runId, helper.id, 'KEEP_GOING')
  const mail = runtime.userMail(run, helper)
  assert.ok(mail.includes(`[orbit:${helper.mailMark}] MESSAGE FROM THE USER (`), mail)
  runtime.remember(helper, { type: 'tool_result', tool_call_id: 'call-1', name: 'list_agents', result: `[]${mail}`, via: 'mcp' })
  runtime.budgetHandoff(run, helper)
  assert.match(helper.result, /^Достигнут лимит работы помощника Helper[\s\S]*KEEP_GOING/)
  assert.ok(!helper.result.includes(helper.mailMark), helper.result)
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
  assert.ok(mailbox.text.startsWith(`[orbit:${helper.mailMark}] MESSAGE FROM YOUR SUPERVISOR (`), mailbox.text.slice(0, 200))
  assert.ok(mailbox.text.includes(`Orbit (message ${order.id}): ${long}`), 'the whole message, with its sender and id')
  const team = mailbox.text.slice(mailbox.text.indexOf('TEAM CORRESPONDENCE'))
  assert.ok(team.includes('PEER_0') && !team.includes('NEW_TASK'), 'team excerpts follow, without the supervisor message')
  assert.ok(mailbox.deliveredIds.includes(order.id))
  assert.equal(mailbox.fromUser, 0)
})
