const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { CapabilityStore } = require('../electron/capabilities.mts')
const quota = require('../electron/quota.mts')

// The session transport is driven here with a fake provider that records the `session` options it is given and plays
// the model: it makes Orbit tool calls the way the MCP server would, through runtime.dispatchMcp, in the middle of a
// "turn", then returns its answer text. A fake MCP server issues and revokes tokens. No CLI is ever started.

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function fakeMcp() {
  const issued = [], revoked = []
  return {
    issued, revoked, started: 0, url: 'http://127.0.0.1:65500/mcp',
    async start() { this.started++ },
    issueToken({ runId, agentId }) { const token = `token-${agentId}-${issued.length}`; issued.push({ token, runId, agentId }); return token },
    revoke(token) { revoked.push(token) },
    stop() {},
  }
}
async function finished(runtime, payload, wait = 5000) {
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, wait)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete without deadlock')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'claude', prompt: 'Current task', ...extra })
// Which agent a session turn belongs to: the identity is in the stable system block, not in the user prompt.
const agentOf = options => options.session.systemAppend.match(/running as agent "([^"]+)" \(id=([^;]+); parent=([^;]+); depth=(\d+)\)/)
const session = (extra = {}) => ({ mcp: fakeMcp(), transportFor: () => 'session', ...extra })

test('the first turn opens a session with a stable system block and the full task prompt; later turns resume it with what is new', async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const memoryStore = new OrbitMemoryStore(path.join(root, 'store'))
  memoryStore.upsert({ title: 'Current task', content: 'MEMORY_MARKER', scope: 'project', workspace })
  const calls = [], mcp = fakeMcp()
  const runtime = new OrbitRuntime({ memoryStore, mcp, transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    const [, name] = agentOf(options)
    if (name === 'Helper') return { text: 'HELPER_RESULT' }
    if (!options.session.resume) {
      const spawned = await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'Look around', reason: 'Independent check' })
      assert.equal(spawned.ok, true)
      return { text: 'Premature answer', sessionId: options.session.id }
    }
    assert.match(options.prompt, /HELPER RESULT — Helper \(done\):\nHELPER_RESULT/)
    assert.match(options.prompt, /Helpers you delegated to have finished/)
    return { text: 'FINAL_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { history: [{ role: 'user', content: 'LATEST_MESSAGE' }] }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const rootCalls = calls.filter(options => agentOf(options)[1] === 'Orbit')
  assert.equal(rootCalls.length, 2)
  const [first, second] = rootCalls
  assert.equal(first.responseSchema, undefined, 'session mode sends no envelope schema')
  assert.match(first.session.id, /^[0-9a-f-]{36}$/)
  assert.equal(first.session.resume, false)
  assert.equal(first.session.mcpUrl, mcp.url)
  assert.equal(first.session.token, mcp.issued[0].token)
  assert.deepEqual(mcp.issued[0], { token: first.session.token, runId: snapshot.runId, agentId: 'root' })
  assert.ok(first.session.systemAppend.length <= 6000, `system block is ${first.session.systemAppend.length} chars`)
  assert.match(first.session.systemAppend, /running as agent "Orbit" \(id=root; parent=none; depth=0\)/)
  assert.ok(first.session.systemAppend.includes(`workspace=${workspace}`))
  assert.doesNotMatch(first.session.systemAppend, /tool_calls|Orbit tool protocol|inputSchema|LIVE TURN BUDGET|turn \d/)
  assert.doesNotMatch(first.prompt, /tool_calls|Orbit tool protocol|AGENT TRANSCRIPT/)
  for (const part of ['YOUR CURRENT TASK:\nCurrent task', 'MEMORY_MARKER', 'LATEST_MESSAGE', 'TEAM DIRECTORY', 'SKILLS', 'SHARED PROJECT CONTEXT', 'LIVE TURN BUDGET', 'RECENT CHAT']) assert.ok(first.prompt.includes(part), `first prompt carries ${part}`)
  assert.equal(second.session.resume, true)
  assert.equal(second.session.id, first.session.id)
  assert.equal(second.session.systemAppend, first.session.systemAppend, 'the system block is stable across turns')
  assert.ok(second.prompt.length < first.prompt.length / 3, 'a resume carries only the instruction and the new results')
  assert.doesNotMatch(second.prompt, /YOUR CURRENT TASK/)
  const rootAgent = snapshot.agents.find(agent => agent.id === 'root')
  assert.equal(rootAgent.transport, 'session')
  assert.equal(rootAgent.sessionId, first.session.id, 'the session id is persisted with the agent')
  assert.equal(rootAgent.sessionToken, undefined, 'the bearer token never leaves the runtime')
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['FINAL_ANSWER'])
  assert.equal(mcp.started, 1, 'the server is started once')
  assert.deepEqual(new Set(mcp.revoked), new Set(mcp.issued.map(item => item.token)), 'every token is revoked when its agent ends')
})

test('MCP tool calls run through executeTool with the envelope side effects: ledger, file activity, change capture, traces', async t => {
  const workspace = folder(t)
  fs.mkdirSync(path.join(workspace, 'notes')); fs.writeFileSync(path.join(workspace, 'notes', 'a.txt'), 'hello'); fs.writeFileSync(path.join(workspace, 'notes', 'b.txt'), 'other')
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const token = options.session.token
    const edited = await runtime.dispatchMcp(token, 'edit_file', { path: 'notes/a.txt', old_text: 'hello', new_text: 'hello world' })
    assert.equal(edited.ok, true); assert.equal(edited.unread, 0); assert.equal(JSON.parse(edited.text).ok, true)
    const read = await runtime.dispatchMcp(token, 'read_file', { path: 'notes/b.txt', limit: null })
    assert.match(read.text, /1: other/)
    const unknown = await runtime.dispatchMcp(token, 'unknown_tool', {})
    assert.equal(unknown.ok, false); assert.match(unknown.error, /Unknown tool: unknown_tool/); assert.match(unknown.text, /Unknown tool/)
    const badToken = await runtime.dispatchMcp('no-such-token', 'list_files', {})
    assert.equal(badToken.ok, false); assert.match(badToken.error, /session token/)
    const invalid = await runtime.dispatchMcp(token, 'list_files', 'nope')
    assert.equal(invalid.ok, false); assert.match(invalid.error, /JSON object/)
    const byIds = await runtime.dispatchMcp({ runId: [...runtime.runs.keys()][0], agentId: 'root' }, 'list_agents', {})
    assert.equal(byIds.ok, true); assert.match(byIds.text, /"name":"Orbit"/)
    return { text: 'Edited and read the file.' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, { accessMode: 'workspace-write' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(fs.readFileSync(path.join(workspace, 'notes', 'a.txt'), 'utf8'), 'hello world')
  const root = runtime.runs.get(runId).agentNodes.get('root')
  const log = root.ledger.map(entry => entry.text)
  assert.match(log[0], /^#1 edit_file notes\/a\.txt → edited \(-5\/\+11 chars/)
  assert.match(log[1], /^#1 read_file notes\/b\.txt → lines 1-1 of 1/)
  assert.match(log[2], /^#1 unknown_tool → ERROR Unknown tool/)
  assert.match(log[3], /^#1 list_files → ERROR Tool arguments must be a JSON object/)
  assert.match(log[4], /^#1 list_agents → 1 participants/)
  assert.equal(root.workDone, 1, 'an edit counts as work done')
  const files = snapshot.agents[0].files
  assert.ok(files.wrote.some(item => /a\.txt$/.test(item)) && files.read.some(item => /b\.txt$/.test(item)), JSON.stringify(files))
  assert.ok(snapshot.changes.some(change => /a\.txt$/.test(change.path) && change.tool === 'edit_file'), 'the change log recorded the edit')
  assert.ok(snapshot.traces.some(trace => trace.kind === 'tool' && /^edit_file /.test(trace.text)))
  assert.ok(snapshot.traces.some(trace => trace.kind === 'observation' && /^read_file: /.test(trace.text)))
  assert.equal(root.transcript.filter(entry => entry.type === 'tool_result' && entry.via === 'mcp').length, 5)
  assert.equal(snapshot.agents[0].turnTimings[0].orbitToolCalls, 5)
})

test('a tool result reports the unread mail that arrived during the turn, and read_messages clears it', async t => {
  const workspace = folder(t)
  let helperSent
  const sent = new Promise(resolve => { helperSent = resolve })
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') {
      const result = await runtime.dispatchMcp(token, 'send_message', { agentId: 'root', message: 'HELPER_QUESTION' })
      assert.equal(result.ok, true)
      helperSent()
      return { text: 'helper done' }
    }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Ask something', reason: 'Independent' })
    await sent
    const listed = await runtime.dispatchMcp(token, 'list_agents', {})
    assert.equal(listed.unread, 1, 'the count the server appends as a suffix')
    const mail = await runtime.dispatchMcp(token, 'read_messages', {})
    assert.match(mail.text, /HELPER_QUESTION/); assert.equal(mail.unread, 0)
    const waited = await runtime.dispatchMcp(token, 'wait_agent', {})
    assert.match(waited.text, /helper done/)
    return { text: 'Answered after reading mail' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.summary.text, 'Answered after reading mail')
  assert.equal(snapshot.agents[0].turnTimings.length, 1, 'mail read within the turn needs no extra turn')
  assert.ok(snapshot.communications.some(item => item.text === 'HELPER_QUESTION' && item.status === 'read'))
})

test('a waiting tool releases the provider slot so the helper it waits for can run, and takes it back', async t => {
  const workspace = folder(t)
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: 'HELPER_DONE' }
    const live = [...runtime.runs.values()][0]
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
    assert.equal(live.activeTurns, 1)
    const waited = await runtime.dispatchMcp(token, 'wait_agent', { timeout_ms: 2000 })
    assert.match(waited.text, /HELPER_DONE/, 'with one slot the helper can only have run if the wait released it')
    assert.equal(live.activeTurns, 1, 'the slot is held again after the wait')
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.agents.find(agent => agent.name === 'Helper').status, 'done')
  assert.equal(runtime.runs.get(snapshot.runId).activeTurns, 0)
  assert.equal(runtime.runs.get(snapshot.runId).turnQueue.length, 0)
})

test('completed workers with a known model get one combined model_evaluate reminder, not one per worker or three in a row', async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const memoryStore = new OrbitMemoryStore(path.join(root, 'store'))
  const prompts = []
  const runtime = new OrbitRuntime({ memoryStore, ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name !== 'Orbit') return { text: `${name} done`, model: 'worker-model' }
    prompts.push(options.prompt)
    if (!options.session.resume) {
      for (const member of ['A', 'B']) await runtime.dispatchMcp(token, 'spawn_agent', { name: member, task: `Task ${member}`, reason: 'Independent' })
      await runtime.dispatchMcp(token, 'wait_agent', {})
      return { text: 'Answer without evaluation' }
    }
    return { text: 'Still no evaluation' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(prompts.length, 2, prompts.map(prompt => prompt.slice(0, 300)).join('\n---\n'))
  assert.match(prompts[1], /model_evaluate/)
  assert.equal(prompts[1].match(/worker-model/g).length, 2, 'both workers in one reminder')
  assert.equal(snapshot.summary.text, 'Still no evaluation')
})

for (const failing of [false, true]) test(`the skill reminder is a single resume; ${failing ? 'when it fails the drafted answer is delivered' : 'the answer it brings back is final'}`, async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const capabilities = new CapabilityStore(path.join(root, 'store'))
  const skill = capabilities.save({ name: 'Release routine', description: 'How to release', instructions: 'Step 1. Step 2.', scope: 'project', workspace })
  const calls = []
  const runtime = new OrbitRuntime({ capabilityStore: capabilities, ...session(), runProvider: async options => {
    calls.push(options)
    if (options.session.resume) {
      if (failing) throw new Error('resume exploded')
      return { text: 'FINAL_AFTER_REMINDER' }
    }
    const read = await runtime.dispatchMcp(options.session.token, 'capability_read', { id: skill.entry.id })
    assert.match(read.text, /Step 1/)
    return { text: 'DRAFT_ANSWER' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /capability_feedback/)
  assert.equal(calls[1].session.resume, true)
  assert.equal(snapshot.summary.text, failing ? 'DRAFT_ANSWER' : 'FINAL_AFTER_REMINDER')
  assert.deepEqual(snapshot.messages.map(message => message.text), [failing ? 'DRAFT_ANSWER' : 'FINAL_AFTER_REMINDER'])
  if (failing) assert.ok(snapshot.traces.some(trace => trace.kind === 'budget' && /drafted answer is delivered/.test(trace.text)))
})

test('a quota refusal mid-session hands over to an envelope provider: the note carries the MCP calls, the envelope loop takes over', async t => {
  const workspace = folder(t), calls = []
  const original = { ...quota.readers }
  t.after(() => Object.assign(quota.readers, original))
  const window = used => ({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null }], plan: 'test' })
  quota.readers.claude = async () => window(20)
  quota.readers.codex = async () => window(10)
  const catalog = [{ id: 'claude', available: true, models: ['opus'] }, { id: 'codex', available: true, models: ['gpt-6-astra'] }]
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), quota: new quota.QuotaMonitor(), catalog: async () => catalog, transportFor: id => id === 'claude' ? 'session' : 'envelope', runProvider: async options => {
    calls.push(options)
    if (options.providerId === 'claude') {
      const written = await runtime.dispatchMcp(options.session.token, 'write_file', { path: 'done.txt', content: 'x' })
      assert.equal(written.ok, true)
      throw new Error("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")
    }
    assert.equal(options.session, undefined)
    assert.ok(options.responseSchema)
    return { text: 'Codex finished the job' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude', model: 'opus', accessMode: 'workspace-write' }), 8000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(calls.map(options => [options.providerId, options.session ? 'session' : 'envelope']), [['claude', 'session'], ['codex', 'envelope']])
  const second = calls[1].prompt
  assert.match(second, /HANDOVER: your model changed mid-task because of subscription quota/)
  assert.match(second, /Before: claude \/ opus\. Now: codex \/ gpt-6-astra/)
  assert.match(second, /write_file done\.txt → wrote 1 bytes/, 'the work done over MCP is in the note and the work log')
  assert.match(second, /Agent: Orbit; id=root/, 'the envelope prompt for the same agent')
  const root = snapshot.agents[0]
  assert.equal(root.transport, 'envelope')
  assert.equal(root.sessionId, null)
  assert.equal(root.handovers.length, 1)
  assert.equal(root.handovers[0].fresh, false, 'an agent that made tool calls has done something')
  assert.equal(root.turns, 1, 'the refused attempt is not a turn')
  assert.equal(snapshot.summary.text, 'Codex finished the job')
  assert.ok(snapshot.traces.some(trace => trace.kind === 'transport' && /envelope transport/.test(trace.text)))
})

test('cancellation aborts the session turn, revokes the token and refuses later tool calls', async t => {
  const workspace = folder(t), mcp = fakeMcp()
  let token, started
  const running = new Promise(resolve => { started = resolve })
  const runtime = new OrbitRuntime({ mcp, transportFor: () => 'session', runProvider: ({ session: options, signal }) => {
    token = options.token; started()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Provider was cancelled')), { once: true }))
  } })
  const runId = await runtime.start(payload(workspace))
  await running
  assert.equal(runtime.stop(runId), true)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(runtime.getRun(runId).status, 'cancelled')
  assert.equal(runtime.getRun(runId).agents[0].status, 'cancelled')
  assert.deepEqual(mcp.revoked, [token])
  const refused = await runtime.dispatchMcp(token, 'list_agents', {})
  assert.equal(refused.ok, false)
  assert.equal(runtime.runs.get(runId).activeTurns, 0)
})

test('every provider turn leaves a timing record that is persisted with the run', async t => {
  const workspace = folder(t), saved = []
  const runtime = new OrbitRuntime({ ...session(), runStore: { save: snapshot => saved.push(snapshot) }, runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: 'helper done' }
    options.onEvent({ kind: 'tool', native: true, tool: 'Read', toolId: 't1', status: 'started', input: { file_path: path.join(workspace, 'x.txt') } })
    options.onEvent({ kind: 'tool', native: true, tool: 'Read', toolId: 't1', status: 'completed' })
    options.onEvent({ kind: 'tool', native: true, tool: 'mcp__orbit__list_agents', toolId: 't2', status: 'started' })
    if (options.session.resume) return { text: 'final' }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
    await runtime.dispatchMcp(token, 'list_agents', {})
    return { text: 'first' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const timings = snapshot.agents[0].turnTimings
  assert.equal(timings.length, 2)
  assert.deepEqual(Object.keys(timings[0]).sort(), ['endedAt', 'firstEventAt', 'nativeToolCalls', 'orbitToolCalls', 'promptChars', 'sessionId', 'startedAt', 'transport', 'turn'])
  assert.equal(timings[0].turn, 1); assert.equal(timings[0].transport, 'session')
  assert.equal(timings[0].orbitToolCalls, 2, 'Orbit calls are counted where they are dispatched')
  assert.equal(timings[0].nativeToolCalls, 1, 'one native call however many status events; MCP events are not native calls')
  assert.ok(timings[0].promptChars > 1000)
  assert.ok(timings[0].firstEventAt >= timings[0].startedAt && timings[0].endedAt >= timings[0].firstEventAt)
  assert.equal(timings[0].sessionId, snapshot.agents[0].sessionId)
  assert.equal(timings[1].turn, 2); assert.ok(timings[1].promptChars < timings[0].promptChars)
  assert.deepEqual(saved.at(-1).agents[0].turnTimings, timings)
  assert.equal(snapshot.agents.find(agent => agent.name === 'Helper').turnTimings.length, 1)
})

test('the root answer streams as message.streaming at most four times a second and the final message reuses its id', async t => {
  const workspace = folder(t)
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options)
    if (name === 'Helper') { options.onEvent({ kind: 'output', text: 'helper words', messageId: 'h', partial: true }); return { text: 'helper words' } }
    if (options.session.resume) return { text: `${'word '.repeat(40)}${'more '.repeat(40)}END` }
    await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
    for (let index = 0; index < 40; index++) options.onEvent({ kind: 'output', text: 'word ', messageId: 'm1', partial: true })
    await new Promise(resolve => setTimeout(resolve, 300))
    for (let index = 0; index < 40; index++) options.onEvent({ kind: 'output', text: 'more ', messageId: 'm1', partial: true })
    options.onEvent({ kind: 'output', text: 'END', messageId: 'm1', partial: false })
    return { text: `${'word '.repeat(40)}${'more '.repeat(40)}END` }
  } })
  const { snapshot, events } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const streaming = events.filter(event => event.type === 'message.streaming')
  assert.ok(streaming.length >= 2 && streaming.length <= 4, `${streaming.length} events for 80 deltas over 300 ms`)
  assert.ok(streaming.every(event => event.agentId === 'root' && event.runId === snapshot.runId && event.chatId === 'chat-1' && event.projectId === 'project-1'))
  assert.equal(new Set(streaming.map(event => event.messageId)).size, 1)
  assert.ok(streaming[0].content.length < streaming.at(-1).content.length, 'the whole text so far, growing')
  assert.ok(streaming.at(-1).content.endsWith('END'))
  const final = events.find(event => event.type === 'message.added' && event.message.agentId === 'root')
  assert.equal(final.message.id, streaming[0].messageId)
  assert.equal(snapshot.messages.find(message => message.agentId === 'root').id, streaming[0].messageId)
  assert.ok(!events.some(event => event.type === 'message.streaming' && event.content.includes('helper words')), 'helpers never stream to the chat')
})

test('a finished session agent woken by a message resumes its own session with the mail', async t => {
  const workspace = folder(t), helperCalls = []
  let rootTurn = 0
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') {
      helperCalls.push(options)
      if (!options.session.resume) return { text: 'HELPER_FIRST' }
      assert.match(options.prompt, /New messages arrived/); assert.match(options.prompt, /ROOT_QUESTION/)
      await runtime.dispatchMcp(token, 'send_message', { agentId: 'root', message: 'HELPER_REPLY' })
      return { text: 'HELPER_SECOND' }
    }
    if (++rootTurn === 1) {
      await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
      const waited = await runtime.dispatchMcp(token, 'wait_agent', {})
      assert.match(waited.text, /HELPER_FIRST/)
      await runtime.dispatchMcp(token, 'send_message', { agentId: 'Helper', message: 'ROOT_QUESTION' })
      const mail = await runtime.dispatchMcp(token, 'wait_message', { timeout_ms: 2000 })
      assert.match(mail.text, /HELPER_REPLY/)
      return { text: 'Root done' }
    }
    return { text: 'Root done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(helperCalls.length, 2)
  assert.equal(helperCalls[1].session.resume, true)
  assert.equal(helperCalls[1].session.id, helperCalls[0].session.id)
  const helper = snapshot.agents.find(agent => agent.name === 'Helper')
  assert.equal(helper.generation, 1); assert.equal(helper.result, 'HELPER_SECOND'); assert.equal(helper.sessionId, helperCalls[0].session.id)
})

test('without an MCP server a session agent falls back to the envelope loop, with a trace, and helpers follow', async t => {
  const workspace = folder(t), calls = []
  let rootTurn = 0
  const runtime = new OrbitRuntime({ mcp: { async start() { throw new Error('port refused') }, issueToken: () => 'never', revoke() {} }, transportFor: () => 'session', runProvider: async options => {
    calls.push(options)
    const [, name] = options.prompt.match(/Agent: ([^;]+); id=/)
    if (name !== 'Orbit') return { text: 'helper done' }
    if (++rootTurn === 1) return { text: JSON.stringify({ tool_calls: [{ id: 's', name: 'spawn_agent', arguments: { name: 'Helper', task: 'T', reason: 'R' } }, { id: 'w', name: 'wait_agent', arguments: {} }] }) }
    return { text: 'done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(calls.every(options => options.session === undefined && options.responseSchema))
  assert.ok(snapshot.agents.every(agent => agent.transport === 'envelope'))
  assert.equal(snapshot.traces.filter(trace => trace.kind === 'transport' && /port refused/.test(trace.text)).length, 1, 'the fallback is traced once; later agents are created as envelope agents')
})

test('ORBIT_LEGACY_ENVELOPE=1 forces the envelope loop whatever the provider transport', async t => {
  const workspace = folder(t)
  const previous = process.env.ORBIT_LEGACY_ENVELOPE
  process.env.ORBIT_LEGACY_ENVELOPE = '1'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_LEGACY_ENVELOPE; else process.env.ORBIT_LEGACY_ENVELOPE = previous })
  const mcp = fakeMcp()
  const runtime = new OrbitRuntime({ mcp, transportFor: () => 'session', runProvider: async options => { assert.equal(options.session, undefined); return { text: 'ok' } } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.agents[0].transport, 'envelope')
  assert.equal(mcp.started, 0)
})

test('tools/list is filtered by role and access, arguments are validated by the registry, and approve reaches the user', async t => {
  const workspace = folder(t), approvals = []
  const registry = {
    TOOLS: [{ name: 'model_evaluate', rootOnly: true, minAccess: 'read-only' }, { name: 'write_file', minAccess: 'workspace-write' }, { name: 'run_command', minAccess: 'workspace-write' }, { name: 'list_agents', minAccess: 'read-only' }],
    validate: (name, args) => name === 'list_files' && args.limit === 'many' ? { ok: false, error: 'limit must be a number' } : { ok: true },
    describeForPrompt: () => 'REGISTRY GUIDE',
  }
  const runtime = new OrbitRuntime({ ...session(), registry, requestApproval: async request => { approvals.push(request); return true }, runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') {
      assert.deepEqual(runtime.listToolsMcp(token).map(tool => tool.name), ['write_file', 'run_command', 'list_agents'], 'no root-only tools for a worker')
      return { text: 'helper done' }
    }
    assert.deepEqual(runtime.listToolsMcp(token).map(tool => tool.name), ['model_evaluate', 'write_file', 'run_command', 'list_agents'])
    assert.deepEqual(runtime.listToolsMcp('unknown'), [])
    const invalid = await runtime.dispatchMcp(token, 'list_files', { limit: 'many' })
    assert.equal(invalid.ok, false); assert.match(invalid.error, /limit must be a number/)
    assert.equal(await runtime.approveMcp(token, { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }), true)
    assert.equal(await runtime.approveMcp('unknown', { tool_name: 'Bash' }), false)
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
    await runtime.dispatchMcp(token, 'wait_agent', {})
    return { text: 'done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'workspace-write', approvalPolicy: 'on-request' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(approvals.length, 1)
  assert.deepEqual([approvals[0].tool, approvals[0].arguments, approvals[0].agentName, approvals[0].runId], ['Bash', { command: 'ls' }, 'Orbit', snapshot.runId])
  const readOnly = new OrbitRuntime({ ...session(), registry, runProvider: async options => {
    assert.deepEqual(runtime.listToolsMcp(options.session.token), [], 'another runtime does not know this token')
    assert.deepEqual(readOnly.listToolsMcp(options.session.token).map(tool => tool.name), ['model_evaluate', 'list_agents'], 'no write tools in read-only mode')
    return { text: 'ok' }
  } })
  assert.equal((await finished(readOnly, payload(workspace, { accessMode: 'read-only' }))).snapshot.status, 'completed')
})

test('a worker on its final turn returns its findings from the session without an extra resume', async t => {
  const workspace = folder(t), calls = []
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    calls.push(name)
    if (name === 'Orbit') {
      if (!options.session.resume) { await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Worker', task: 'Bounded', reason: 'R' }); return { text: 'waiting' } }
      assert.match(options.prompt, /PRESERVED_FINDING/)
      return { text: 'Root integrated' }
    }
    if (!options.session.resume) { await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Grandchild', task: 'Leaf', reason: 'R' }); return { text: 'Worker first' } }
    assert.match(options.prompt, /FINAL WORKER TURN/)
    return { text: 'PRESERVED_FINDING; further checks remain.' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { limits: { maxTurns: 2 } }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const worker = snapshot.agents.find(agent => agent.name === 'Worker')
  assert.equal(worker.turns, 2); assert.equal(worker.budgetLimited, true); assert.equal(worker.result, 'PRESERVED_FINDING; further checks remain.')
  assert.equal(calls.filter(name => name === 'Worker').length, 2)
  assert.equal(snapshot.summary.text, 'Root integrated')
})

test('runtime.shutdown stops the MCP server and forgets the tokens', async t => {
  const workspace = folder(t)
  const mcp = fakeMcp()
  let stopped = 0
  mcp.stop = () => { stopped++ }
  const runtime = new OrbitRuntime({ mcp, transportFor: () => 'session', runProvider: async () => ({ text: 'ok' }) })
  await finished(runtime, payload(workspace))
  await runtime.shutdown()
  assert.equal(stopped, 1)
  assert.equal(runtime.sessions.size, 0)
})
