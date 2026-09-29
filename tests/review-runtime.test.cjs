const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.cjs')
const { OrbitMemoryStore } = require('../electron/memory.cjs')
const { CapabilityStore } = require('../electron/capabilities.cjs')
const { workspaceKey } = require('../electron/storage.cjs')

// Cases found by an independent review of the memory and skill integration: each one failed before it was fixed.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-review-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = name => { const folder = path.join(root, name); fs.mkdirSync(folder, { recursive: true }); return folder }
  const store = path.join(root, 'store')
  return { a: project('project-a'), b: project('project-b'), memory: new OrbitMemoryStore(store), skills: new CapabilityStore(store) }
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
async function finished(runtime, payload) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); off()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return runtime.getRun(runId)
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: workspace, chatId: 'c1', providerId: 'test', prompt: 'Current task', ...extra })

for (const [label, ending] of [['throws', () => { throw new Error('provider exploded') }], ['comes back empty', () => ({ text: '' })]]) {
  test(`when the extra learning turn ${label}, the answer that was already complete is still delivered`, async t => {
    const { a, memory, skills } = fixture(t), prompts = []
    let turn = 0
    const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
      prompts.push(prompt)
      if (++turn <= 10) return response(tool('memory_search', { query: `probe ${turn}` }))
      if (turn === 11) return { text: 'THE REAL FINAL ANSWER' }
      return ending()
    } })
    const run = await finished(runtime, payload(a))
    assert.equal(run.status, 'completed', run.error)
    assert.ok(run.messages.some(message => message.text === 'THE REAL FINAL ANSWER'), 'the user gets the draft')
    assert.match(prompts[11], /THE REAL FINAL ANSWER/, 'the extra turn sees the draft it is asked to confirm')
    assert.equal(turn, 12)
  })
}

test('a project that switched shared memory off neither sees, loads nor rates shared skills', async t => {
  const { a, b, memory, skills } = fixture(t)
  const shared = skills.install({ name: 'Isolated Linux environment', description: 'Throwaway Linux distro mirroring the toolchain', instructions: 'Import a rootfs as a new distro and run the build inside', scope: 'global' })
  const prompts = []
  let turn = 0
  const off = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    return ++turn === 1 ? response(tool('capability_read', { id: shared.id }), tool('capability_feedback', { id: shared.id, outcome: 'failed', note: 'x' }), tool('capability_search', { query: 'linux distro' })) : { text: 'done' }
  } })
  const run = await finished(off, payload(a, { globalMemoryEnabled: false, prompt: 'I need a clean linux environment' }))
  assert.equal(run.status, 'completed')
  assert.doesNotMatch(prompts[0], /Isolated Linux environment/)
  assert.match(prompts[1], /Capability was not found/)
  const untouched = skills.read(shared.id, a)
  assert.equal(untouched.uses, 0); assert.equal(untouched.failures, 0); assert.deepEqual(untouched.usedIn, [])
  const on = []
  await finished(new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => { on.push(prompt); return { text: 'ok' } } }), payload(b, { prompt: 'I need a clean linux environment' }))
  assert.match(on[0], /Isolated Linux environment/)
})

test('loading a skill twice is one use; a long skill arrives whole; an agent cannot claim to be the user', async t => {
  const { a, memory, skills } = fixture(t)
  const long = `${'Step: verify the previous step and continue with the next one.\n'.repeat(180)}FINAL_STEP_MARKER unregister the distro`
  const big = skills.install({ name: 'Very long procedure', description: 'A procedure with many steps', instructions: long, scope: 'project', workspace: a, source: 'user' })
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    if (++turn === 1) return response(tool('capability_read', { id: big.id }), tool('capability_read', { id: big.id }))
    if (turn === 2) return response(tool('capability_install', { name: 'Claims', description: 'x', instructions: 'A plain three step procedure written by an agent', scope: 'project', source: 'user' }))
    return { text: 'done' }
  } })
  await finished(runtime, payload(a, { skillLearning: false }))
  assert.equal(skills.read(big.id, a).uses, 1)
  assert.match(prompts[1], /FINAL_STEP_MARKER/, 'the tail of a long skill is not cut')
  assert.ok(skills.list(a).find(skill => skill.name === 'Claims').source.startsWith('agent:'))
  assert.equal(skills.list(a).find(skill => skill.name === 'Claims').pinned, false)
})

test('only projects the UI reported as sharing take part in cross-project housekeeping', async t => {
  const { a, b } = fixture(t), calls = []
  const store = { search: () => [], maintain: options => { calls.push(options) }, flush() {} }
  const runtime = new OrbitRuntime({ memoryStore: store, runProvider: async () => ({ text: 'ok' }) })
  runtime.setSharing(b, true)
  await finished(runtime, payload(a, { globalMemoryEnabled: false }))
  assert.deepEqual(calls[0].projects, [workspaceKey(b)], 'a project that opted out (or was never reported) does not contribute')
  runtime.setSharing(b, false)
  runtime.setSharing(a, true)
  await finished(runtime, payload(a, { chatId: 'c2' }))
  assert.deepEqual(calls[1].projects, [workspaceKey(a)], 'a later switch takes effect, and a run reports its own project')
})

test('a note whose text was cut says so', async t => {
  const { a, memory, skills } = fixture(t)
  let turn = 0, seen = ''
  const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
    if (++turn === 1) return response(tool('memory_save', { title: 'Long', content: 'x'.repeat(2500), scope: 'chat' }), tool('capability_install', { name: 'Long skill', description: 'x', instructions: 'step '.repeat(3500), scope: 'project' }))
    seen = prompt
    return { text: 'done' }
  } })
  await finished(runtime, payload(a, { skillLearning: false }))
  assert.match(seen, /content was cut to 1500 characters/)
  assert.match(seen, /instructions were cut to 12000 characters/)
})
