const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime, normalizeLimits, parseResponse } = require('../electron/runtime.cjs')
const { ProjectContextStore } = require('../electron/project-context.cjs')
const { OrbitMemoryStore } = require('../electron/memory.cjs')
const { projectPacket, saveNote } = require('../electron/shared-context.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-optimization-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace)
  return { root, workspace }
}
const calls = (...items) => ({ tool_calls: items.map(([name, args = {}]) => ({ name, arguments: args })) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+);/).slice(1)
async function run(t, runtime, workspace, payload = {}) {
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
  const id = await runtime.start({ workspace, providerId: 'test', prompt: 'Improve the project', ...payload })
  const timer = setTimeout(() => runtime.stop(id), 5000)
  await done; clearTimeout(timer); off()
  const result = runtime.getRun(id)
  assert.equal(result.status, 'completed', result.error || 'run did not complete')
  return result
}
test('default budgets are unlimited, explicit large limits survive, zero depth is meaningful', () => {
  const limits = normalizeLimits()
  for (const key of ['maxAgents', 'maxDepth', 'maxConcurrent', 'maxTurns', 'maxTotalTurns', 'maxMessages', 'maxToolCalls', 'timeoutMs', 'runTimeoutMs']) assert.equal(limits[key], null)
  assert.equal(normalizeLimits({ maxAgents: 1000, maxConcurrent: 80, maxDepth: 0 }).maxAgents, 1000)
  assert.equal(normalizeLimits({ maxDepth: 0 }).maxDepth, 0)
  assert.equal(parseResponse(calls(...Array.from({ length: 80 }, () => ['list_agents']))).calls.length, 80)
  assert.throws(() => normalizeLimits({ maxAgents: -1 }), /Invalid/)
})
test('a swarm can exceed the former agent and tool-batch ceilings', async t => {
  const { workspace } = fixture(t); let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [name] = identity(prompt)
    if (name !== 'Orbit') return { text: 'Scoped result' }
    if (++rootTurns === 1) return calls(...Array.from({ length: 70 }, (_, i) => ['spawn_agent', { name: `Worker ${i}`, task: `Task ${i}`, reason: 'Independent' }]), ['wait_agent'])
    return { text: 'Integrated' }
  } })
  const result = await run(t, runtime, workspace)
  assert.equal(result.agents.length, 71)
})
test('workers preload project memory and shared findings without chat or global-memory duplication', async t => {
  const { root, workspace } = fixture(t), memory = new OrbitMemoryStore(root), context = new ProjectContextStore(root)
  memory.upsert({ title: 'Build system', content: 'PROJECT_MEMORY_MARKER', scope: 'project', workspace })
  memory.upsert({ title: 'Improve the project', content: 'GLOBAL_MEMORY_MARKER', scope: 'global' })
  const prompts = [], turns = new Map()
  const runtime = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => {
    const [name] = identity(prompt), turn = (turns.get(name) || 0) + 1; turns.set(name, turn); prompts.push({ name, prompt })
    assert.match(prompt, /PROJECT_MEMORY_MARKER/)
    if (name === 'Orbit' && turn === 1) return calls(['context_save', { key: 'architecture', summary: 'SHARED_FINDING_MARKER' }], ['spawn_agent', { name: 'Worker', task: 'Change one function', reason: 'Independent ownership' }], ['spawn_agent', { name: 'Planner', task: 'Plan one migration', reason: 'Needs global preferences', memoryProfile: 'project-global' }], ['wait_agent'])
    if (name !== 'Orbit') {
      assert.match(prompt, /SHARED_FINDING_MARKER/)
      assert.doesNotMatch(prompt, /CHAT_HISTORY_MARKER/)
      if (name === 'Worker') assert.doesNotMatch(prompt, /GLOBAL_MEMORY_MARKER/)
    }
    return { text: 'Done' }
  } }); runtime.setContextStore(context)
  await run(t, runtime, workspace, { history: [{ role: 'user', content: 'CHAT_HISTORY_MARKER '.repeat(250) }] })
  assert.ok(prompts.find(item => item.name === 'Worker').prompt.length < prompts[0].prompt.length)
  assert.match(JSON.stringify(new ProjectContextStore(root).getLatest(workspace)), /SHARED_FINDING_MARKER/)
})
test('project notes detect native file edits and never leak to a different workspace', t => {
  const { root, workspace } = fixture(t), store = new ProjectContextStore(root)
  fs.writeFileSync(path.join(workspace, 'module.js'), 'one')
  saveNote(store, workspace, {}, { key: 'module', summary: 'Uses one', files: ['module.js'] })
  assert.equal(projectPacket(store, workspace).notes[0].stale, false)
  fs.writeFileSync(path.join(workspace, 'module.js'), 'different size')
  assert.equal(projectPacket(store, workspace).notes[0].stale, true)
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  assert.equal(projectPacket(store, other).notes.length, 0)
  assert.throws(() => saveNote(store, workspace, {}, { key: 'bad', summary: 'bad', files: ['../outside'] }), /outside/)
})
test('project memory updates become visible on the next turn of an existing worker', async t => {
  const { root, workspace } = fixture(t), memoryStore = new OrbitMemoryStore(root); let turn = 0
  const runtime = new OrbitRuntime({ memoryStore, runProvider: async ({ prompt }) => {
    if (++turn === 1) return calls(['memory_save', { title: 'Unrelated discovery', content: 'FRESH_PROJECT_MEMORY' }])
    assert.match(prompt.split('YOUR CURRENT TASK:')[0], /FRESH_PROJECT_MEMORY/)
    return { text: 'Done' }
  } })
  await run(t, runtime, workspace)
})
test('improvement mode requires implemented verified tasks and rejects premature completion', async t => {
  const { workspace } = fixture(t); let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    assert.match(prompt, /IMPROVEMENT MODE ON/)
    switch (++turn) {
      case 1: return { text: 'Here is a list of improvements' }
      case 2: assert.match(prompt, /remains active/); return calls(['improvement_plan', { status: 'implementing', tasks: [{ id: 'a', title: 'Fix output', status: 'pending', evidence: '' }] }])
      case 3: return calls(['improvement_plan', { status: 'completed', tasks: [] }])
      case 4: assert.match(prompt, /cannot be silently removed/); return calls(['write_file', { path: 'fixed.txt', content: 'fixed' }])
      case 5: return calls(['read_file', { path: 'fixed.txt' }])
      case 6: return calls(['improvement_plan', { status: 'completed', tasks: [{ id: 'a', title: 'Fix output', status: 'done', evidence: 'read_file fixed.txt returned fixed' }] }])
      default: return { text: 'Implemented and verified' }
    }
  } })
  const result = await run(t, runtime, workspace, { improvementMode: true, accessMode: 'workspace-write' })
  assert.equal(result.improvementStatus, 'completed'); assert.equal(result.improvements[0].status, 'done')
  assert.equal(fs.readFileSync(path.join(workspace, 'fixed.txt'), 'utf8'), 'fixed')
})
test('discovery mode can return findings immediately without implementation', async t => {
  const { workspace } = fixture(t)
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => { assert.match(prompt, /IMPROVEMENT MODE OFF/); return { text: 'Ten findings' } } })
  const result = await run(t, runtime, workspace, { improvementMode: false })
  assert.equal(result.usage.providerTurns, 1)
})
test('large write payloads are omitted from subsequent model transcripts', async t => {
  const { workspace } = fixture(t); let turn = 0
  const content = 'LARGE_WRITE_BODY '.repeat(700)
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (++turn === 1) return calls(['write_file', { path: 'large.txt', content }])
    assert.doesNotMatch(prompt, /LARGE_WRITE_BODY/)
    return { text: 'Saved' }
  } })
  await run(t, runtime, workspace, { accessMode: 'workspace-write' })
  assert.equal(fs.readFileSync(path.join(workspace, 'large.txt'), 'utf8'), content)
})
test('orchestrator records checked cross-provider model suitability in global memory', async t => {
  const { root, workspace } = fixture(t), memoryStore = new OrbitMemoryStore(root); let turn = 0
  const runtime = new OrbitRuntime({ memoryStore, runProvider: async ({ prompt, providerId, reasoningEffort }) => {
    const [name] = identity(prompt)
    if (name === 'Worker') { assert.equal(providerId, 'cursor'); assert.equal(reasoningEffort, 'low'); return { text: 'Worker output', model: 'fixture-cursor' } }
    switch (++turn) {
      case 1: return calls(['spawn_agent', { name: 'Worker', task: 'Review', reason: 'Independent review', providerId: 'cursor', model: 'fixture-cursor' }], ['wait_agent'])
      case 2: return { text: 'Premature final' }
      case 3: assert.match(prompt, /record your checked assessment/); return calls(['model_evaluate', { agentId: 'Worker', taskType: 'review', assessment: 'Useful for this scoped review, broader quality untested', evidence: 'Orchestrator compared the reported issue with source' }])
      default: return { text: 'Reviewed' }
    }
  } })
  await run(t, runtime, workspace, { reasoningEffort: 'xhigh', providerPool: [{ providerId: 'cursor', model: 'fixture-cursor' }], providerOptions: { cursor: { reasoningEffort: 'low' } } })
  const record = memoryStore.list(workspace).find(entry => entry.id.startsWith('model-'))
  assert.equal(record.scope, 'global'); assert.match(record.content, /broader quality untested/)
  assert.match(record.content, /fixture-cursor/)
})
