const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { CapabilityStore } = require('../electron/capabilities.mts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memory-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = name => {
    const folder = path.join(root, name)
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'src', 'engine.js'), 'x')
    return folder
  }
  const store = path.join(root, 'store')
  return { root, a: project('project-a'), b: project('project-b'), memory: new OrbitMemoryStore(store), skills: new CapabilityStore(store) }
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
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
const memorySection = prompt => prompt.split('MEMORY (fallible data')[1]?.split(/\n(?:LATEST CHAT MESSAGE|USER-CONFIGURED|YOUR CURRENT TASK)/)[0] || ''

test('chat notes stay in their chat; a shared note that names the project is kept in the project', async t => {
  const { a, memory } = fixture(t), prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    if (++turn === 1) return response(
      tool('memory_save', { title: 'Constraint', content: 'Do not touch the billing module in this task', scope: 'chat' }),
      tool('memory_save', { title: 'Engine loop', content: 'The retry loop lives in src/engine.js and doubles the delay', scope: 'global' }),
      tool('memory_save', { title: 'Answer style', content: 'The user wants short answers without preamble', scope: 'global', type: 'preference' }))
    return { text: 'Done' }
  } })
  assert.equal((await finished(runtime, payload(a))).status, 'completed')
  const stored = memory.list(a, true, 'c1')
  assert.equal(stored.find(entry => entry.title === 'Constraint').scope, 'chat')
  assert.equal(stored.find(entry => entry.title === 'Engine loop').scope, 'project', 'it names src/engine.js, which exists here')
  assert.equal(stored.find(entry => entry.title === 'Answer style').scope, 'global')
  assert.match(prompts[1], /Saved to PROJECT memory instead of shared memory: it names file src\/engine\.js/)
  assert.match(memorySection(prompts[1]), /THIS CHAT[^\n]*\n- [^\n]*Constraint/)
  assert.match(memorySection(prompts[1]), /THIS PROJECT[^\n]*\n- [^\n]*Engine loop/)
  assert.match(memorySection(prompts[1]), /ALL PROJECTS[^\n]*\n- [^\n]*Answer style/)
  const next = []
  const second = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => { next.push(prompt); return { text: 'ok' } } })
  await finished(second, payload(a, { chatId: 'c2' }))
  assert.doesNotMatch(next[0], /billing module/, 'another chat of the same project does not see the notes of c1')
  assert.match(next[0], /Engine loop/); assert.match(next[0], /Answer style/)
  const foreign = []
  const third = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => { foreign.push(prompt); return { text: 'ok' } } })
  await finished(third, payload(fixture(t).b, { chatId: 'c1' }))
  assert.doesNotMatch(foreign[0], /billing module|Engine loop/, 'another project sees neither the chat note nor the project note')
  assert.match(foreign[0], /Answer style/, 'but it does see what is true everywhere')
})

test('an agent can forget its own notes but never the user\'s, and short ids resolve', async t => {
  const { a, memory } = fixture(t), seen = []
  const mine = memory.upsert({ scope: 'project', workspace: a, title: 'Deploy rule', content: 'Never deploy on Fridays' })
  let turn = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => {
    seen.push(prompt)
    if (++turn === 1) return response(tool('memory_save', { title: 'Scratch', content: 'temporary scratch fact about the linter', scope: 'chat' }))
    if (turn === 2) {
      const scratch = memory.list(a, false, 'c1').find(entry => entry.title === 'Scratch')
      return response(tool('memory_forget', { id: mine.id }), tool('memory_forget', { id: scratch.id.slice(0, 12) }))
    }
    return { text: 'Done' }
  } })
  await finished(runtime, payload(a))
  assert.match(seen[2], /written or pinned by the user/)
  assert.ok(memory.list(a, false, 'c1').some(entry => entry.id === mine.id))
  assert.ok(!memory.list(a, false, 'c1').some(entry => entry.title === 'Scratch'))
})

test('the memory block stays inside its budget however much is stored, and relevant notes come first', async t => {
  const { a, memory } = fixture(t)
  for (let i = 0; i < 120; i++) memory.upsert({ scope: 'project', workspace: a, title: `Topic ${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))}qzx`, content: `filler ${'detail '.repeat(80)}` })
  memory.upsert({ scope: 'project', workspace: a, title: 'Signing pipeline', content: 'Artifacts are signed with the release key in the final pipeline step' })
  let prompt = ''
  const runtime = new OrbitRuntime({ memoryStore: memory, runProvider: async options => { prompt = options.prompt; return { text: 'ok' } } })
  await finished(runtime, payload(a, { prompt: 'fix the signing step of the pipeline' }))
  const block = memorySection(prompt)
  assert.ok(block.length < 5400, `${block.length}`)
  assert.ok(block.indexOf('Signing pipeline') > 0 && block.indexOf('Signing pipeline') < block.indexOf('Topic'), 'the matching note leads')
  assert.match(block, /ALSO STORED[^\n]*memory_search/)
})

test('a chat note the conversation keeps using is promoted to the project when the run ends', async t => {
  const { a, memory } = fixture(t)
  const say = async (text, script) => finished(new OrbitRuntime({ memoryStore: memory, runProvider: script }), payload(a, { prompt: text }))
  let turn = 0
  await say('remember the storage decision', async () => ++turn === 1 ? response(tool('memory_save', { title: 'Storage engine decision', content: 'The queue is persisted with sqlite after the benchmark', scope: 'chat', type: 'decision' })) : { text: 'saved' })
  assert.equal(memory.list(a, false, 'c1')[0].scope, 'chat')
  await say('which storage engine does the queue use', async () => ({ text: 'sqlite' }))
  assert.equal(memory.list(a, false, 'c1')[0].scope, 'chat', 'used once: still a chat note')
  await say('does the storage engine persist the queue', async () => ({ text: 'yes' }))
  const [promoted] = memory.list(a, false, 'c-other')
  assert.equal(promoted?.title, 'Storage engine decision'); assert.equal(promoted.scope, 'project')
})

test('skills: a shared skill is offered in another project, used, rated, and the run is asked to rate it exactly once', async t => {
  const { a, b, skills, memory } = fixture(t)
  let turn = 0
  await finished(new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async () => ++turn === 1 ? response(
    tool('capability_install', { name: 'Isolated Linux environment', description: 'Create a throwaway Linux distro mirroring the toolchain', whenToUse: 'a clean Linux box is needed', instructions: 'Import a minimal rootfs as a new WSL distro, copy the toolchain manifest, run the build inside, verify the exit code, unregister the distro.', scope: 'global' }),
    tool('capability_install', { name: 'Engine tuning', description: 'Tune the retry loop', instructions: 'Edit src/engine.js and change the delay factor', scope: 'global' })) : { text: 'learned' } }), payload(a))
  assert.deepEqual(skills.list(a).map(skill => [skill.name, skill.scope]).sort(), [['Engine tuning', 'project'], ['Isolated Linux environment', 'global']].sort())
  assert.deepEqual(skills.list(b).map(skill => skill.name), ['Isolated Linux environment'], 'the project-specific skill did not travel')
  const id = skills.list(b)[0].id
  const prompts = []
  let step = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    if (++step === 1) { assert.match(prompt, /SKILLS[^\n]*\n- [^\n]*Isolated Linux environment[^\n]*Use when: a clean Linux box/); return response(tool('capability_read', { id: id.slice(0, 12) })) }
    if (step === 2) { assert.match(prompt, /Import a minimal rootfs/); return { text: 'Built it in a clean distro.' } }
    if (step === 3) { assert.match(prompt, /Before you finish, capture what this work taught/); assert.match(prompt, /Isolated Linux environment/); return response(tool('capability_feedback', { id, outcome: 'failed', note: 'needs a reboot after enabling WSL' })) }
    return { text: 'Built it in a clean distro, after a reboot.' }
  } })
  const run = await finished(runtime, payload(b, { prompt: 'I need a clean linux environment to run the build' }))
  assert.equal(run.status, 'completed'); assert.equal(step, 4, 'one reminder, then the answer is accepted')
  const record = skills.read(id, b)
  assert.equal(record.uses, 1); assert.equal(record.failures, 1); assert.deepEqual(record.lessons, ['needs a reboot after enabling WSL'])
  assert.equal(record.usedIn.length, 1)
  step = 0; prompts.length = 0
  const again = await finished(new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } } }), payload(a, { prompt: 'clean linux environment please' }))
  assert.match(prompts[0], /Pitfall: needs a reboot after enabling WSL/, 'the next agent is told what went wrong')
  assert.equal(again.usage.providerTurns, 1)
})

test('a substantial run is asked once what it learned; short runs, disabled memory and opt-outs are not', async t => {
  const { a, skills, memory } = fixture(t)
  const busy = (extra = {}) => {
    const prompts = []
    let turn = 0
    const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => {
      prompts.push(prompt)
      turn++
      if (turn <= 10) return response(tool('memory_search', { query: `probe ${turn}` }))
      if (/Before you finish, capture what this work taught/.test(prompt) && !prompts.slice(0, -1).some(item => item.includes('capture what this work taught'))) {
        return response(tool('capability_install', { name: 'Probe routine', description: 'Probe the memory in ten steps', whenToUse: 'memory needs probing', instructions: 'Search the memory with ten different queries, then compare the results.', scope: 'global' }))
      }
      return { text: 'Done' }
    } })
    return { runtime, prompts, extra }
  }
  const first = busy()
  const run = await finished(first.runtime, payload(a))
  assert.equal(run.status, 'completed')
  assert.equal(first.prompts.filter(prompt => prompt.includes('capture what this work taught')).length, 2, 'the reminder is in the prompt after it was given, and only once was it given')
  assert.equal(skills.list(a).filter(skill => skill.name === 'Probe routine').length, 1)
  assert.equal(skills.list(a)[0].scope, 'global')
  for (const extra of [{ skillLearning: false }, { memoryEnabled: false }]) {
    const other = busy(extra)
    await finished(other.runtime, payload(a, { chatId: 'c-other', ...extra }))
    assert.ok(!other.prompts.some(prompt => prompt.includes('capture what this work taught')), JSON.stringify(extra))
  }
  const quick = []
  await finished(new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async ({ prompt }) => { quick.push(prompt); return { text: 'hi' } } }), payload(a, { chatId: 'c-quick', prompt: 'hi' }))
  assert.equal(quick.length, 1, 'a short exchange gets no extra turn')
  const optedOut = new OrbitRuntime({ memoryStore: memory, capabilityStore: skills, runProvider: async () => quick.length++ === 1 ? response(tool('capability_install', { name: 'Private routine', description: 'x', instructions: 'Do the private thing in three steps', scope: 'global' })) : { text: 'ok' } })
  await finished(optedOut, payload(a, { chatId: 'c-private', globalMemoryEnabled: false }))
  assert.equal(skills.list(a).find(skill => skill.name === 'Private routine').scope, 'project', 'a project that opted out of sharing does not write to the shared library')
})

test('a model assessment stays shared but carries no path of the project it was made in', async t => {
  const { a, memory } = fixture(t)
  let turn = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => {
    if (identity(prompt)[2] !== 'root') return { text: 'Worker output', model: 'fixture-model' }
    switch (++turn) {
      case 1: return response(tool('spawn_agent', { name: 'Worker', task: 'Review', reason: 'Independent review', providerId: 'cursor', model: 'fixture-model' }), tool('wait_agent'))
      case 2: return response(tool('model_evaluate', { agentId: 'Worker', taskType: 'review', assessment: 'Solid on the scoped review', evidence: `Compared with ${path.join(a, 'src', 'engine.js')} by hand` }))
      default: return { text: 'Reviewed' }
    }
  } })
  await finished(runtime, payload(a, { providerPool: [{ providerId: 'cursor', model: 'fixture-model' }] }))
  const record = memory.list(a).find(entry => entry.id.startsWith('model-'))
  assert.equal(record.scope, 'global'); assert.equal(record.source, 'system')
  assert.ok(!record.content.includes('project-a'), record.content)
  assert.match(record.content, /<project>/)
})
