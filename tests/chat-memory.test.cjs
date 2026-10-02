const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { RunStore } = require('../electron/run-store.mts')
const chatMemory = require('../electron/chat-memory.mts')

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-chat-memory-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+);/).slice(1)
function scripted(script, seen = []) {
  const turns = new Map()
  return async ({ prompt }) => {
    const [name] = identity(prompt)
    const turn = turns.get(name) || 0
    turns.set(name, turn + 1)
    seen.push({ name, turn, prompt })
    const step = script[name]?.[turn]
    return step ? step({ prompt, turn }) : { text: `${name} finished` }
  }
}
async function finish(runtime, payload) {
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start({ providerId: 'test', projectId: 'project', chatId: 'chat', accessMode: 'workspace-write', prompt: 'Do the work', ...payload })
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await done; clearTimeout(timer); off()
  assert.notEqual(event.type, 'test.timeout', 'the run must end without deadlock')
  return { run: runtime.getRun(runId), runId }
}
// The first turn of a chat: an orchestrator, one helper that edits a file, a final answer.
const firstTurn = (extra = {}) => ({
  Orbit: [() => envelope(call('spawn_agent', { name: 'Backend', task: 'Implement the endpoint', reason: 'Own the API code' }), call('wait_agent')), () => ({ text: 'ANSWER_ONE: the endpoint exists' })],
  Backend: [() => envelope(call('write_file', { path: 'api.txt', content: 'endpoint' })), () => ({ text: 'BACKEND_RESULT_MARKER: added the endpoint in api.txt' })],
  ...extra,
})

test('the next turn of a chat is told what the helpers of the earlier turns did and which files they changed', async t => {
  const workspace = folder(t)
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: scripted(firstTurn(), seen) })
  await finish(runtime, { workspace, prompt: 'Build the endpoint' })
  seen.length = 0
  const second = await finish(runtime, { workspace, prompt: 'Now add tests for it' })
  assert.equal(second.run.status, 'completed')
  const digest = seen[0].prompt
  assert.match(digest, /EARLIER TURNS IN THIS CHAT/)
  assert.match(digest, /User: "Build the endpoint"/)
  assert.match(digest, /Orbit answered: "ANSWER_ONE: the endpoint exists"/)
  assert.match(digest, /- Backend \[done\]: task "Implement the endpoint" → "BACKEND_RESULT_MARKER/)
  assert.match(digest, /wrote api\.txt/)
})

test('helpers do not carry the digest, and another chat does not see it', async t => {
  const workspace = folder(t)
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: scripted({ ...firstTurn(), Orbit: [() => envelope(call('spawn_agent', { name: 'Backend', task: 'Implement the endpoint', reason: 'Own the API code' }), call('wait_agent')), () => ({ text: 'ANSWER_ONE' })] }, seen) })
  await finish(runtime, { workspace })
  seen.length = 0
  await finish(runtime, { workspace, prompt: 'Follow up' })
  assert.match(seen[0].prompt, /EARLIER TURNS IN THIS CHAT/)
  for (const item of seen.filter(entry => entry.name === 'Backend')) assert.doesNotMatch(item.prompt, /EARLIER TURNS IN THIS CHAT/, 'a helper works from its own task')
  seen.length = 0
  await finish(runtime, { workspace, chatId: 'another-chat', prompt: 'Unrelated' })
  assert.doesNotMatch(seen[0].prompt, /EARLIER TURNS IN THIS CHAT/)
  assert.doesNotMatch(seen[0].prompt, /BACKEND_RESULT_MARKER/)
})

test('the earlier team is still known after Orbit restarts', async t => {
  const workspace = folder(t), store = folder(t)
  const first = new OrbitRuntime({ runStore: new RunStore(store), runProvider: scripted(firstTurn()) })
  await finish(first, { workspace, prompt: 'Build the endpoint' })
  const seen = []
  const restarted = new OrbitRuntime({ runStore: new RunStore(store), runProvider: scripted({}, seen) })
  await finish(restarted, { workspace, prompt: 'Continue' })
  assert.match(seen[0].prompt, /Backend \[done\]: task "Implement the endpoint" → "BACKEND_RESULT_MARKER/)
  assert.match(seen[0].prompt, /wrote api\.txt/, 'the touched files were saved with the run')
})

test('team_history returns full reports, and continueFrom hands the work of an earlier agent to a new helper', async t => {
  const workspace = folder(t)
  const seen = []
  let current = scripted(firstTurn(), seen)
  const runtime = new OrbitRuntime({ runProvider: options => current(options) })
  const first = await finish(runtime, { workspace, prompt: 'Build the endpoint' })
  current = scripted({
    Orbit: [
      () => envelope(call('team_history', { agent: 'backend' }), call('spawn_agent', { task: 'Add tests for the endpoint', reason: 'Follow up on the earlier work', continueFrom: 'backend' }), call('spawn_agent', { name: 'Ghost', task: 'x', reason: 'y', continueFrom: 'Nobody' }), call('wait_agent')),
      () => ({ text: 'ANSWER_TWO' }),
    ],
    Backend: [() => ({ text: 'Tests added' })],
  }, seen)
  seen.length = 0
  const { run } = await finish(runtime, { workspace, prompt: 'Add tests' })
  assert.equal(run.status, 'completed')
  const orbit = seen.filter(item => item.name === 'Orbit')
  assert.match(orbit[1].prompt, /BACKEND_RESULT_MARKER: added the endpoint in api\.txt/, 'the full report, not the digest excerpt')
  assert.match(orbit[1].prompt, /wrote.{1,6}api\.txt/)
  assert.match(orbit[1].prompt, /continue_from_not_found/, 'an unknown agent is refused with a pointer to team_history')
  const helper = seen.find(item => item.name === 'Backend')
  assert.match(helper.prompt, /YOUR PREVIOUS WORK/)
  assert.match(helper.prompt, /BACKEND_RESULT_MARKER/)
  assert.deepEqual(run.agents.map(agent => agent.name), ['Orbit', 'Backend'], 'the refused spawn created nobody')
  assert.notEqual(run.agents.find(agent => agent.name === 'Backend').id, first.run.agents.find(agent => agent.name === 'Backend').id, 'it is a new agent that picks up the old one work')
})

const record = (index, extra = {}) => chatMemory.view({
  runId: `r${index}`, prompt: `request ${index}`, status: 'completed', startedAt: `2026-09-2${index}T10:00:00.000Z`, messages: [{ agentId: 'root', text: `answer ${index}` }],
  agents: [{ id: 'root', name: 'Orbit' }, { id: `a${index}`, name: `Helper ${index}`, status: 'done', task: `task ${index}`, result: `result ${index}`, files: { wrote: [`f${index}.ts`], read: [] } }], communications: [], ...extra,
})

test('the digest keeps the newest turns detailed, compacts older ones and stays within its budget', () => {
  const runs = [1, 2, 3, 4, 5].map(index => record(index))
  const text = chatMemory.digest(runs)
  assert.match(text, /\[turn 5 .*\] User: "request 5"\n  Orbit answered: "answer 5"\n  Team:\n  - Helper 5 \[done\]: task "task 5" → "result 5" \| wrote f5\.ts/)
  assert.match(text, /Helper 4 \[done\]: task "task 4" → "result 4"/)
  assert.match(text, /\[turn 3 .*\] User: "request 3"\n  Team: Helper 3 ✓; changed 1 file\(s\): f3\.ts/)
  assert.doesNotMatch(text, /result 3|result 2|result 1/, 'older turns are one line each')
  assert.ok(text.indexOf('turn 5') < text.indexOf('turn 4') && text.indexOf('turn 4') < text.indexOf('turn 1'), 'newest first')
  assert.ok(chatMemory.digest(runs, 400).length <= 400)
  assert.equal(chatMemory.digest([]), '')
})

test('earlier agents can be looked up by name or id, newest turn first', () => {
  const runs = [record(1), record(2, { agents: [{ id: 'a9', name: 'HELPER 1', status: 'done', task: 'again', result: 'newer' }] })]
  assert.equal(chatMemory.findAgent(runs, 'helper 1').result, 'newer')
  assert.equal(chatMemory.findAgent(runs, 'a1').name, 'Helper 1')
  assert.equal(chatMemory.findAgent(runs, 'missing'), null)
  assert.equal(chatMemory.findAgent(runs, ''), null)
})

test('a history request stays within one observation however many agents ran', () => {
  const agents = Array.from({ length: 30 }, (_, index) => ({ id: `a${index}`, name: `Helper ${index}`, status: 'done', task: 'task '.repeat(200), result: 'long result '.repeat(500) }))
  const runs = [record(1, { agents }), record(2, { agents })]
  const asked = chatMemory.history(runs, { limit: 2 }, 12000)
  assert.equal(asked.length, 2)
  assert.ok(JSON.stringify(asked).length < 16000, String(JSON.stringify(asked).length))
  const one = chatMemory.history(runs, { runId: 'r1', agent: 'helper 7' }, 12000)
  assert.deepEqual([one.length, one[0].agents.length, one[0].agents[0].name], [1, 1, 'Helper 7'])
})

// A long report: numbered lines with blank lines, so that a page which collapsed or trimmed whitespace would not rejoin to the original.
const LONG_REPORT = Array.from({ length: 700 }, (_, index) => `ITEM_${index + 1}: ${'detail '.repeat(3)}ok`).join('\n\n')
const pagesOf = async read => {
  const pages = []
  let offset = 0
  for (let guard = 0; guard < 50 && offset !== null; guard++) { const page = await read(offset); pages.push(page); offset = page.nextOffset }
  return pages
}

test('team_history pages a long report: the default stays compact, the pages rejoin to the exact text', async t => {
  assert.ok(LONG_REPORT.length > 20000)
  const workspace = folder(t), store = folder(t)
  const first = new OrbitRuntime({ runStore: new RunStore(store), runProvider: scripted({ ...firstTurn(), Backend: [() => ({ text: LONG_REPORT })] }) })
  await finish(first, { workspace, prompt: 'Write the report' })
  const runtime = new OrbitRuntime({ runStore: new RunStore(store), runProvider: scripted({}) })
  const { run, runId } = await finish(runtime, { workspace, prompt: 'Read it back' })
  const live = runtime.runs.get(runId), root = live.agentNodes.get('root')
  const read = args => runtime.executeTool(live, root, 'team_history', { agent: 'backend', ...args }).then(records => records[0].agents[0])
  assert.equal(run.status, 'completed')

  const preview = await runtime.executeTool(live, root, 'team_history', {})
  assert.ok(JSON.stringify(preview).length < 12000, 'without an agent the output stays a bounded preview')
  assert.equal(preview[0].agents[0].totalChars, LONG_REPORT.length, 'the preview says how long the report really is')

  const initial = await read({})
  assert.ok(initial.result.length <= 6000, 'the default page is as small as before')
  assert.equal(initial.totalChars, LONG_REPORT.length)
  assert.equal(initial.offset, 0)
  assert.equal(initial.nextOffset, initial.result.length)

  const pages = await pagesOf(offset => read({ offset, maxChars: 5000 }))
  assert.ok(pages.length > 3 && pages.every(page => page.result.length <= 5000))
  assert.equal(pages.map(page => page.result).join(''), LONG_REPORT, 'concatenated pages equal the full report')
  assert.equal(pages.at(-1).nextOffset, null)

  assert.ok((await read({ maxChars: 500000 })).result.length <= 20000, 'a page is never larger than 20000 characters')
  const past = await read({ offset: LONG_REPORT.length + 100 })
  assert.deepEqual([past.result, past.nextOffset, past.totalChars], ['', null, LONG_REPORT.length])
  const exact = await read({ offset: LONG_REPORT.length })
  assert.deepEqual([exact.result, exact.nextOffset], ['', null])
})

test('context_read pages the whole report behind a helper note, and a plain or old note still reads as before', async t => {
  const workspace = folder(t), root = folder(t)
  const { ProjectContextStore } = require('../electron/project-context.mts')
  const { saveNote } = require('../electron/shared-context.mts')
  const contextStore = new ProjectContextStore(root)
  const first = new OrbitRuntime({ runStore: new RunStore(root), runProvider: scripted({ ...firstTurn(), Backend: [() => ({ text: LONG_REPORT })] }) })
  first.setContextStore(contextStore)
  await finish(first, { workspace, prompt: 'Write the report' })
  const old = JSON.stringify({ result: 'OLD_NOTE_RESULT', task: 'x', runId: 'a-run-that-is-gone', state: 'reported complete; verify before reuse' })
  saveNote(contextStore, workspace, {}, { key: 'agent:chat:Gone', summary: old })
  saveNote(contextStore, workspace, {}, { key: 'plain', summary: 'PLAIN_NOTE '.repeat(300) })

  const runtime = new OrbitRuntime({ runStore: new RunStore(root), runProvider: scripted({}) })
  runtime.setContextStore(contextStore)
  const { runId } = await finish(runtime, { workspace, prompt: 'Read it back' })
  const live = runtime.runs.get(runId), orbit = live.agentNodes.get('root')
  const read = args => runtime.executeTool(live, orbit, 'context_read', { key: 'agent:chat:Backend', ...args })

  const compact = await read({})
  assert.ok(compact.summary.length < 2200, 'the default is the compact note, as before')
  assert.equal(compact.fullReportChars, LONG_REPORT.length, 'it says that a longer report exists')
  assert.equal(compact.nextOffset, null)

  const pages = await pagesOf(offset => read({ offset }))
  assert.ok(pages.length > 3 && pages.every(page => page.summary.length <= 6000 && page.source === 'full report' && page.totalChars === LONG_REPORT.length))
  assert.equal(pages.map(page => page.summary).join(''), LONG_REPORT, 'concatenated pages equal the full report')
  const past = await read({ offset: LONG_REPORT.length + 5 })
  assert.deepEqual([past.summary, past.nextOffset], ['', null])

  const gone = await runtime.executeTool(live, orbit, 'context_read', { key: 'agent:chat:Gone', offset: 0 })
  assert.equal(gone.summary, old, 'a note whose run is gone pages its own text')
  assert.equal(gone.nextOffset, null)
  const plain = await runtime.executeTool(live, orbit, 'context_read', { key: 'plain', offset: 1000, maxChars: 1500 })
  assert.equal(plain.summary, ('PLAIN_NOTE '.repeat(300)).slice(1000, 2500))
  assert.equal(plain.nextOffset, 2500)
  assert.equal((await runtime.executeTool(live, orbit, 'context_read', { key: 'plain' })).summary, 'PLAIN_NOTE '.repeat(300), 'a plain note is returned whole by default')
})

test('team_history pages the result of an old record that has no report field', () => {
  const text = 'old result '.repeat(900)
  const runs = [{ runId: 'r1', prompt: 'p', status: 'completed', startedAt: '2026-01-01T00:00:00Z', answer: 'a', communications: [], agents: [{ id: 'a1', name: 'Writer', status: 'done', task: 't', result: text }] }]
  const first = chatMemory.history(runs, { agent: 'writer', maxChars: 4000 })[0].agents[0]
  const second = chatMemory.history(runs, { agent: 'writer', offset: first.nextOffset, maxChars: 4000 })[0].agents[0]
  const third = chatMemory.history(runs, { agent: 'writer', offset: second.nextOffset, maxChars: 4000 })[0].agents[0]
  assert.equal(first.result + second.result + third.result, text)
  assert.deepEqual([first.totalChars, third.nextOffset], [text.length, null])
  assert.equal(chatMemory.history(runs, {})[0].agents[0].totalChars, text.length, 'no paging fields without an agent')
})
