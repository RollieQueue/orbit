const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.cjs')
const { RunStore } = require('../electron/run-store.cjs')
const chatMemory = require('../electron/chat-memory.cjs')

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
