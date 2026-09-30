const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { CapabilityStore } = require('../electron/capabilities.mts')
const quota = require('../electron/quota.mts')
const providers = require('../electron/providers.mts')

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
    TOOLS: [{ name: 'model_evaluate', rootOnly: true, minAccess: 'read-only' }, { name: 'write_file', minAccess: 'workspace-write' }, { name: 'run_command', minAccess: 'workspace-write' }, { name: 'list_agents', minAccess: 'read-only' }, { name: 'restart_orbit', rootOnly: true, minAccess: 'workspace-write' }],
    validate: (name, args) => name === 'list_files' && args.limit === 'many' ? { ok: false, error: 'limit must be a number' } : { ok: true },
    describeForPrompt: () => 'REGISTRY GUIDE',
  }
  const runtime = new OrbitRuntime({ ...session(), registry, requestApproval: async request => { approvals.push(request); return true }, runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') {
      assert.deepEqual(runtime.listToolsMcp(token).map(tool => tool.name), ['write_file', 'run_command', 'list_agents'], 'no root-only tools for a worker')
      return { text: 'helper done' }
    }
    assert.deepEqual(runtime.listToolsMcp(token).map(tool => tool.name), ['model_evaluate', 'write_file', 'run_command', 'list_agents'], 'no restart_orbit outside Orbit\'s own repository')
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
  // The root agent of a run on the repository Orbit runs from is offered restart_orbit, as its envelope guide is.
  const repo = folder(t)
  fs.mkdirSync(path.join(repo, 'scripts')); fs.mkdirSync(path.join(repo, '.git')); fs.writeFileSync(path.join(repo, 'scripts', 'self-upgrade.cjs'), '')
  const restartHost = require('../electron/resume.mts').createRestartHost({ repoRoot: repo, userData: folder(t), spawn: () => { throw new Error('no restart in this test') } })
  assert.equal(restartHost.available, true)
  const inRepository = new OrbitRuntime({ ...session(), registry, restartHost, runProvider: async options => {
    assert.deepEqual(inRepository.listToolsMcp(options.session.token).map(tool => tool.name), ['model_evaluate', 'write_file', 'run_command', 'list_agents', 'restart_orbit'])
    return { text: 'ok' }
  } })
  assert.equal((await finished(inRepository, payload(repo, { accessMode: 'workspace-write' }))).snapshot.status, 'completed')
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

test('Antigravity agents in Full access (Cursor ones when opted in) run the session loop by the providers\' own decision, resumed by the id the CLI reported', async t => {
  const previous = process.env.ORBIT_CURSOR_SESSION
  delete process.env.ORBIT_CURSOR_SESSION
  t.after(() => { if (previous !== undefined) process.env.ORBIT_CURSOR_SESSION = previous })
  for (const [providerId, providerOptions] of [['antigravity', {}], ['cursor', { cursor: { transport: 'session' } }]]) {
    const workspace = folder(t), calls = []
    const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: providers.transportFor, runProvider: async options => {
      calls.push(options)
      const [, name] = agentOf(options), token = options.session.token
      if (name === 'Helper') return { text: 'HELPER_RESULT', sessionId: `${providerId}-helper` }
      if (!options.session.resume) {
        const saved = await runtime.dispatchMcp(token, 'context_save', { key: 'probe', summary: 'Seen through MCP' })
        assert.equal(saved.ok, true)
        await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Look around', reason: 'Independent check' })
        return { text: 'Premature answer', sessionId: `${providerId}-conv-1` }
      }
      assert.match(options.prompt, /HELPER_RESULT/)
      return { text: 'FINAL' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, { providerId, providerOptions, accessMode: 'danger-full-access', approvalPolicy: 'never' }))
    assert.equal(snapshot.status, 'completed', snapshot.error)
    const root = snapshot.agents.find(agent => agent.id === 'root')
    assert.deepEqual([root.transport, root.sessionId], ['session', `${providerId}-conv-1`])
    const rootCalls = calls.filter(options => agentOf(options)[1] === 'Orbit')
    assert.deepEqual(rootCalls.map(options => [options.providerId, options.session.resume, options.session.id]), [[providerId, false, rootCalls[0].session.id], [providerId, true, `${providerId}-conv-1`]])
    assert.equal(rootCalls[0].responseSchema, undefined)
    const ledger = runtime.runs.get(snapshot.runId).agentNodes.get('root').ledger.map(entry => entry.text)
    assert.ok(ledger.some(text => /context_save/.test(text)) && ledger.some(text => /spawn_agent Helper → started/.test(text)), ledger.join('\n'))
    assert.equal(snapshot.agents.find(agent => agent.name === 'Helper').transport, 'session')
  }
})

test('Antigravity and Cursor agents outside Full access, and Cursor ones without the opt-in, stay on the envelope loop', async t => {
  const previous = process.env.ORBIT_CURSOR_SESSION
  delete process.env.ORBIT_CURSOR_SESSION
  t.after(() => { if (previous !== undefined) process.env.ORBIT_CURSOR_SESSION = previous })
  for (const [providerId, accessMode, approvalPolicy] of [['antigravity', 'workspace-write', 'never'], ['cursor', 'read-only', 'never'], ['antigravity', 'danger-full-access', 'on-request'], ['cursor', 'danger-full-access', 'never']]) {
    const workspace = folder(t), mcp = fakeMcp()
    const runtime = new OrbitRuntime({ mcp, transportFor: providers.transportFor, runProvider: async options => {
      assert.equal(options.session, undefined); assert.ok(options.responseSchema)
      return { text: 'envelope answer' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, { providerId, accessMode, approvalPolicy }))
    assert.equal(snapshot.status, 'completed', snapshot.error)
    assert.equal(snapshot.agents[0].transport, 'envelope', `${providerId} ${accessMode} ${approvalPolicy}`)
    assert.equal(mcp.started, 0)
  }
})

test('a Cursor session agent is answered within its MCP call limit: waits are cut with "still running", a slow call is collected by repeating it', async t => {
  const previous = process.env.ORBIT_MCP_CALL_LIMIT_MS
  process.env.ORBIT_MCP_CALL_LIMIT_MS = '300'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_MCP_CALL_LIMIT_MS; else process.env.ORBIT_MCP_CALL_LIMIT_MS = previous })
  const workspace = folder(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') { await gate; return { text: 'HELPER_DONE' } }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Slow work', reason: 'Independent' })
    let started = Date.now()
    const waited = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    assert.ok(Date.now() - started < 3000, 'an unbounded wait is cut at the limit')
    assert.equal(waited.stillRunning, true); assert.match(waited.hint, /Call wait_agent again/)
    assert.equal(waited.agents.length, 1); assert.notEqual(waited.agents[0].status, 'done')
    started = Date.now()
    const mail = JSON.parse((await runtime.dispatchMcp(token, 'wait_message', { timeout_ms: 60000 })).text)
    assert.ok(Date.now() - started < 3000)
    assert.deepEqual([mail.timedOut, mail.stillWaiting], [true, true]); assert.match(mail.hint, /Call wait_message again/)
    const quick = JSON.parse((await runtime.dispatchMcp(token, 'wait_message', { timeout_ms: 50 })).text)
    assert.deepEqual([quick.timedOut, quick.stillWaiting], [true, undefined], 'a wait shorter than the limit is untouched')
    // A command slower than the limit keeps running; repeating the call collects its one result.
    const command = { command: process.execPath, args: ['-e', 'setTimeout(() => { require("fs").appendFileSync("ran.txt", "x"); console.log("slow done") }, 900)'] }
    const answers = []
    for (let attempt = 0; attempt < 30; attempt++) {
      const answer = JSON.parse((await runtime.dispatchMcp(token, 'run_command', { ...command, timeout_ms: 120000 + attempt })).text)
      answers.push(answer)
      if (!answer.stillRunning) break
    }
    assert.ok(answers.length >= 2 && answers[0].stillRunning === true && /Repeat exactly the same call/.test(answers[0].hint), JSON.stringify(answers[0]))
    assert.match(answers.at(-1).stdout, /slow done/)
    assert.equal(answers.at(-1).collected, true, 'the collected result says it comes from the run started earlier')
    assert.ok(Date.parse(answers.at(-1).startedAt) <= Date.now() - 300, answers.at(-1).startedAt)
    assert.equal(fs.readFileSync(path.join(workspace, 'ran.txt'), 'utf8'), 'x', 'the repeats waited for the running command instead of starting it again')
    release()
    const done = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    assert.ok(Array.isArray(done) && done[0].status === 'done' && done[0].result === 'HELPER_DONE', JSON.stringify(done))
    return { text: 'ok' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, { providerId: 'cursor', accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const ledger = runtime.runs.get(runId).agentNodes.get('root').ledger.map(entry => entry.text)
  assert.ok(ledger.some(text => /^#1 wait_agent → .*\(cut at 300 ms, still running\)$/.test(text)), ledger.join('\n'))
  assert.ok(ledger.some(text => /^#1 run_command .* → still running after/.test(text)), ledger.join('\n'))
  assert.equal(ledger.filter(text => /^#1 run_command .* → exit 0/.test(text)).length, 1, 'one command, collected once')
})

test('the call limit belongs to the provider: a Claude session agent\'s waits are not cut', async t => {
  const previous = process.env.ORBIT_MCP_CALL_LIMIT_MS
  process.env.ORBIT_MCP_CALL_LIMIT_MS = '100'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_MCP_CALL_LIMIT_MS; else process.env.ORBIT_MCP_CALL_LIMIT_MS = previous })
  const workspace = folder(t)
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const started = Date.now()
    const mail = JSON.parse((await runtime.dispatchMcp(options.session.token, 'wait_message', { timeout_ms: 600 })).text)
    assert.ok(Date.now() - started >= 550, 'the full wait')
    assert.deepEqual([mail.timedOut, mail.stillWaiting], [true, undefined])
    return { text: 'ok' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
})

test('the MCP server module is loaded on the first session; concurrent first sessions share one real server', async t => {
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'ok' }) })
  t.after(() => runtime.shutdown())
  const [first, second] = await Promise.all([runtime.ensureMcp(), runtime.ensureMcp()])
  assert.ok(first && first === second, 'one server for both callers')
  assert.match(runtime.mcpUrl(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const token = first.issueToken({ runId: 'run', agentId: 'root' })
  const response = await fetch(runtime.mcpUrl(), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /"serverInfo":\{"name":"orbit"/)
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

// ---- Calls of a provider with an MCP call limit (Cursor), parked and collected ------------------------------------
function callLimit(t, ms) {
  const previous = process.env.ORBIT_MCP_CALL_LIMIT_MS
  process.env.ORBIT_MCP_CALL_LIMIT_MS = String(ms)
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_MCP_CALL_LIMIT_MS; else process.env.ORBIT_MCP_CALL_LIMIT_MS = previous })
}
async function until(check, ms = 5000) {
  const started = Date.now()
  while (!check()) { if (Date.now() - started > ms) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
const cursorFull = { providerId: 'cursor', accessMode: 'danger-full-access', approvalPolicy: 'never' }
const commandAnswer = (runtime, token, args) => runtime.dispatchMcp(token, 'run_command', args).then(answer => JSON.parse(answer.text))

test('parked calls made side by side each run once, an identical call joins the run under way, and each result is collected once', async t => {
  callLimit(t, 300)
  const workspace = folder(t)
  const slow = tag => ({ command: process.execPath, args: ['-e', `require("fs").appendFileSync("${tag}.txt", "x"); setTimeout(() => console.log("${tag} done"), 900)`] })
  let first, collected = []
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const token = options.session.token
    // A client that sends its tool calls in parallel, one of them twice.
    first = await Promise.all([commandAnswer(runtime, token, slow('A')), commandAnswer(runtime, token, slow('B')), commandAnswer(runtime, token, slow('A'))])
    // Collected in the other order: A ends while B is waited for, and B's end may count A's file as its own change.
    for (const tag of ['B', 'A']) {
      for (let attempt = 0; attempt < 30; attempt++) { const answer = await commandAnswer(runtime, token, slow(tag)); if (!answer.stillRunning) { collected.push(answer); break } }
    }
    return { text: 'ok', sessionId: 'cursor-chat' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(first.every(answer => answer.stillRunning === true), JSON.stringify(first))
  assert.deepEqual(collected.map(answer => [answer.stdout.trim(), answer.collected]), [['B done', true], ['A done', true]])
  assert.ok(collected.every(answer => !Number.isNaN(Date.parse(answer.startedAt))), JSON.stringify(collected))
  assert.deepEqual(['A', 'B'].map(tag => fs.readFileSync(path.join(workspace, `${tag}.txt`), 'utf8')), ['x', 'x'], 'every command ran exactly once')
})

test('a parked call nobody collects is stopped when its agent ends: the command is killed, the operations drain, the chat takes the next message', async t => {
  callLimit(t, 300)
  const workspace = folder(t)
  const late = tag => ({ command: process.execPath, args: ['-e', `setTimeout(() => require("fs").writeFileSync("${tag}-late.txt", "x"), 2000)`] })
  let lastCommandAt = 0
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (options.prompt.includes('Next message')) return { text: 'next answer' }
    const park = async tag => { lastCommandAt = Date.now(); assert.equal((await commandAnswer(runtime, token, late(tag))).stillRunning, true) }
    if (name === 'Helper') { await park('helper'); return { text: 'Helper answered without waiting for its build' } }
    const { run } = runtime.sessionFor(token)
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Start a build', reason: 'Independent' })
    await park('root')
    let helper
    for (let attempt = 0; attempt < 40 && !Array.isArray(helper); attempt++) helper = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    // The helper ended: its build was stopped while the run goes on (a follow-up would be refused otherwise).
    await until(() => run.agentOperations.get(helper[0].agentId).size === 0, 3000)
    return { text: 'Root answered; its build still runs', sessionId: 'cursor-chat' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const run = runtime.runs.get(runId)
  await until(() => run.operations.size === 0, 3000)
  const next = await finished(runtime, payload(workspace, { ...cursorFull, prompt: 'Next message' }))
  assert.equal(next.snapshot.status, 'completed', next.snapshot.error)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, lastCommandAt + 3500 - Date.now())))
  assert.deepEqual(['root', 'helper'].map(tag => fs.existsSync(path.join(workspace, `${tag}-late.txt`))), [false, false], 'the stopped commands never finished')
})

test('a parked result is not handed out once files changed: after an Orbit write or a native edit the repeat runs the command again', async t => {
  callLimit(t, 300)
  for (const how of ['write_file', 'native edit']) {
    const workspace = folder(t)
    fs.writeFileSync(path.join(workspace, 'f.txt'), 'BEFORE')
    // Reads the file when it starts and answers 900 ms later, like a test run that loads the sources first.
    const command = { command: process.execPath, args: ['-e', 'const fs = require("fs"); const seen = fs.readFileSync("f.txt", "utf8"); fs.appendFileSync("starts.txt", "s"); setTimeout(() => { fs.appendFileSync("ends.txt", "e"); console.log("SAW:" + seen) }, 900)'] }
    const answers = []
    const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
      const token = options.session.token
      answers.push(await commandAnswer(runtime, token, command))
      if (how === 'write_file') {
        assert.equal(JSON.parse((await runtime.dispatchMcp(token, 'write_file', { path: 'f.txt', content: 'AFTER' })).text).ok, true)
        await new Promise(resolve => setTimeout(resolve, 1200)) // the first run finishes meanwhile, uncollected
      } else {
        // Cursor's own edit tool, reported in the stream while the first run is still going.
        fs.writeFileSync(path.join(workspace, 'f.txt'), 'AFTER')
        options.onEvent({ kind: 'tool', native: true, tool: 'write', toolId: 'edit-1', status: 'completed', input: { path: 'f.txt' } })
      }
      for (let attempt = 0; attempt < 30 && !answers.at(-1).stdout; attempt++) answers.push(await commandAnswer(runtime, token, command))
      return { text: 'done', sessionId: 'cursor-chat' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
    assert.equal(snapshot.status, 'completed', snapshot.error)
    assert.equal(answers[0].stillRunning, true)
    assert.equal(answers[1].stillRunning, true, `${how}: the repeat started a fresh run`)
    assert.match(answers.at(-1).stdout, /SAW:AFTER/, `${how}: the result is from after the change`)
    assert.equal(answers.at(-1).collected, true)
    assert.equal(fs.readFileSync(path.join(workspace, 'starts.txt'), 'utf8'), 'ss', how)
    // The first run had ended before the write was followed up; the one a native edit overtook was stopped instead.
    assert.equal(fs.readFileSync(path.join(workspace, 'ends.txt'), 'utf8'), how === 'write_file' ? 'ee' : 'e', how)
  }
})

test('a command that changed files after a parked one finished makes it stale; one that ran alongside it does not', async t => {
  callLimit(t, 300)
  const workspace = folder(t)
  // Every command that runs alone is seen to change one file (runTrackedCommand then counts it as the agent's work).
  let changes = 0
  const projectIndex = { refresh: async (_, options) => ({ added: options?.force ? [`generated-${++changes}.txt`] : [], changed: [], removed: [] }), search: () => ({ results: [] }), outline: () => null, overview: () => '', touch: async () => {} }
  const sleeper = (tag, ms) => ({ command: process.execPath, args: ['-e', `require("fs").appendFileSync("${tag}.txt", "x"); setTimeout(() => console.log("${tag} done"), ${ms})`] })
  const results = {}
  const runtime = new OrbitRuntime({ ...session(), projectIndex, runProvider: async options => {
    const token = options.session.token
    const collect = async args => { for (let attempt = 0; attempt < 30; attempt++) { const answer = await commandAnswer(runtime, token, args); if (!answer.stillRunning) return answer } }
    // A and B side by side: B ends last, alone, and the change it is credited with is counted after A ended.
    await Promise.all([commandAnswer(runtime, token, sleeper('A', 400)), commandAnswer(runtime, token, sleeper('B', 700))])
    await new Promise(resolve => setTimeout(resolve, 1000))
    results.B = await collect(sleeper('B', 700))
    results.A = await collect(sleeper('A', 400))
    // C ends; then D runs on its own and changes a file: C's result predates that change.
    assert.equal((await commandAnswer(runtime, token, sleeper('C', 400))).stillRunning, true)
    await new Promise(resolve => setTimeout(resolve, 800))
    results.D = await collect(sleeper('D', 10))
    results.C = await collect(sleeper('C', 400))
    return { text: 'ok', sessionId: 'cursor-chat' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(['A', 'B', 'C', 'D'].map(tag => fs.readFileSync(path.join(workspace, `${tag}.txt`), 'utf8')), ['x', 'x', 'xx', 'x'], 'only C ran again')
  assert.deepEqual(['A', 'B', 'C'].map(tag => [results[tag].stdout.trim(), results[tag].collected]), [['A done', true], ['B done', true], ['C done', true]])
  assert.match(results.D.stdout, /D done/)
})

test('a cut wait does not hold its answer for a busy slot: it returns within the call limit, and the slot comes back once one frees', async t => {
  callLimit(t, 300)
  const workspace = folder(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  // Without the bound the answer would wait for the helper's slot, and the helper for this gate.
  const fallback = setTimeout(() => release(), 4000)
  t.after(() => clearTimeout(fallback))
  let waited, elapsed
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') { await gate; return { text: 'HELPER_DONE' } }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Hold the only slot', reason: 'Independent' })
    const started = Date.now()
    waited = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    elapsed = Date.now() - started
    release()
    let done
    for (let attempt = 0; attempt < 40 && !Array.isArray(done); attempt++) done = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    assert.equal(done[0].result, 'HELPER_DONE')
    return { text: 'ok', sessionId: 'cursor-chat' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, { ...cursorFull, limits: { maxConcurrent: 1 } }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(waited.stillRunning, true)
  assert.ok(elapsed < 1500, `the cut wait answered after ${elapsed} ms`)
  const run = runtime.runs.get(runId)
  assert.deepEqual([run.activeTurns, run.turnQueue.length], [0, 0], 'every slot taken back was given back')
})

test('a handover closes the old provider session at once instead of leaving it to the end of the run', async t => {
  const workspace = folder(t), closed = []
  const original = { ...quota.readers }
  t.after(() => Object.assign(quota.readers, original))
  const window = used => ({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null }], plan: 'test' })
  quota.readers.claude = async () => window(20)
  quota.readers.codex = async () => window(10)
  const catalog = [{ id: 'claude', available: true, models: ['opus'] }, { id: 'codex', available: true, models: ['gpt-6-astra'] }]
  const OLD = '11111111-2222-4333-8444-555555555555', HELPER = '22222222-3333-4444-8555-666666666666'
  let closedAtHandover
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), quota: new quota.QuotaMonitor(), catalog: async () => catalog, closeSession: id => { closed.push(id) }, transportFor: id => id === 'claude' ? 'session' : 'envelope', runProvider: async options => {
    if (options.providerId === 'codex') { closedAtHandover = [...closed]; return { text: 'Codex finished the job' } }
    const [, name] = agentOf(options)
    if (name === 'Helper') return { text: 'HELPER_RESULT', sessionId: HELPER }
    if (options.session.resume) throw new Error("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")
    await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R' })
    return { text: 'premature', sessionId: OLD }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude', model: 'opus' }), 8000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(closedAtHandover, [OLD], 'closed when the agent moved, before its replacement ran')
  assert.deepEqual(closed, [OLD, HELPER], 'the helper\'s session is closed when the run ends, the old one only once')
  assert.deepEqual([snapshot.agents[0].transport, snapshot.agents[0].sessionId], ['envelope', null])
})

test('session ids: a provider that reported none is not "resumed" with the id Orbit proposed, and an id the provider refuses is dropped once', async t => {
  for (const scenario of ['no id', 'refused id']) {
    const workspace = folder(t), turns = []
    const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
      const [, name] = agentOf(options), token = options.session.token
      if (name === 'Helper') return { text: 'HELPER_RESULT', sessionId: 'helper-chat' }
      turns.push({ id: options.session.id, resume: options.session.resume, full: options.prompt.includes('YOUR CURRENT TASK') })
      // The real check a Cursor or Antigravity turn makes before it starts the CLI.
      providers._testing.normalizeSession(options.providerId, options.session)
      if (turns.length > 1) return { text: 'FINAL', sessionId: 'chat-2' }
      await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Look', reason: 'Independent' })
      // No id in the CLI's stream; or one from an older build (or a file) that could pass for a flag.
      return { text: 'premature', sessionId: scenario === 'no id' ? null : '--resume-me' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, { ...cursorFull, providerId: scenario === 'no id' ? 'antigravity' : 'cursor' }))
    assert.equal(snapshot.status, 'completed', `${scenario}: ${snapshot.error}`)
    const expected = scenario === 'no id'
      ? [[false, true], [false, true]]
      : [[false, true], [true, false], [false, true]]
    assert.deepEqual(turns.map(turn => [turn.resume, turn.full]), expected, scenario)
    assert.notEqual(turns.at(-1).id, turns[0].id, `${scenario}: a fresh session`)
    if (scenario === 'refused id') {
      assert.equal(turns[1].id, '--resume-me')
      assert.ok(snapshot.traces.some(trace => trace.kind === 'transport' && /could not be resumed \(Unexpected cursor session id\); starting a fresh session/.test(trace.text)))
    }
    assert.equal(snapshot.agents[0].sessionId, 'chat-2')
    assert.equal(snapshot.summary.text, 'FINAL')
  }
})
