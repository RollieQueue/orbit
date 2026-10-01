const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime, parseResponse } = require('../electron/runtime.mts')
const { executeWorkspaceTool, workspacePath } = require('../electron/runtime-tools.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { CapabilityStore } = require('../electron/capabilities.mts')

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-test-'))
  // Only this fixture's securely generated temporary directory is removed.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = (prompt) => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
async function finished(runtime, payload) {
  const events = []
  let resolve
  const terminal = new Promise((done) => { resolve = done })
  const unsub = runtime.onEvent((event) => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 5000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'Runtime must complete without deadlock')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Current task', ...extra })
const dialogue = snapshot => snapshot.communications.filter(message => !message.kind || message.kind === 'message')

test('recursive listings show but do not enter generated build folders', async t => {
  const workspace = folder(t)
  for (const dir of ['src', 'Orbit-standalone-v1790669728816', 'release-orbit-v2', 'dist']) {
    fs.mkdirSync(path.join(workspace, dir, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(workspace, dir, 'inner', 'file.txt'), 'x')
  }
  const listed = await executeWorkspaceTool('list_files', { recursive: true }, { workspace, accessMode: 'read-only', maxOutputChars: 8000 })
  const paths = listed.files.map(entry => entry.path)
  assert.ok(paths.includes(path.join('src', 'inner', 'file.txt')), 'source folders are searched')
  for (const dir of ['Orbit-standalone-v1790669728816', 'release-orbit-v2', 'dist']) {
    assert.ok(paths.includes(dir), 'the build folder itself is listed')
    assert.ok(!paths.some(item => item.startsWith(`${dir}${path.sep}`)), `${dir} is not entered`)
  }
  const direct = await executeWorkspaceTool('list_files', { path: 'dist', recursive: true }, { workspace, accessMode: 'read-only', maxOutputChars: 8000 })
  assert.ok(direct.files.some(entry => entry.path === path.join('dist', 'inner', 'file.txt')), 'an explicitly requested build folder can still be listed')
})

test('Google/Antigravity runs do not forward persisted reasoning effort', async t => {
  const workspace = folder(t)
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    seen.push({ providerId: options.providerId, reasoningEffort: options.reasoningEffort })
    return { text: 'Finished' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, {
    providerId: 'antigravity',
    model: 'gemini-fixture',
    reasoningEffort: 'max',
  }))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(seen, [{ providerId: 'antigravity', reasoningEffort: '' }])
})

test('provider streams update one trace per message across flushes, replacements and turns', async t => {
  const workspace = folder(t)
  const long = 'Длинный ответ '.repeat(800)
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ onEvent }) => {
    turn++
    onEvent({ kind: 'output', messageId: 'same-id', text: 'old', partial: true })
    await new Promise(resolve => setTimeout(resolve, 280))
    onEvent({ kind: 'output', messageId: 'another-id', text: 'Separate message', partial: true })
    onEvent({ kind: 'output', messageId: 'same-id', text: long, replace: true, partial: true })
    await new Promise(resolve => setTimeout(resolve, 280))
    onEvent({ kind: 'output', messageId: 'same-id', text: ' END', partial: false })
    return turn === 1 ? response(tool('list_files')) : { text: 'Final answer' }
  } })
  const { snapshot, events } = await finished(runtime, payload(workspace))
  const traces = snapshot.traces.filter(trace => trace.kind === 'output')
  assert.equal(traces.length, 4)
  assert.deepEqual(traces.map(trace => trace.text), [long + ' END', 'Separate message', long + ' END', 'Separate message'])
  const updates = events.filter(event => event.trace?.id === traces[0].id)
  assert.ok(updates.length >= 3)
  assert.equal(snapshot.messages.at(-1).text, 'Final answer')
  assert.equal(runtime.runs.get(snapshot.runId).providerBuffers.size, 0)
})

for (const mode of ['ask-allow', 'ask-deny', 'full']) test(`access and reasoning are inherited by children: ${mode}`, async t => {
  const workspace = folder(t), turns = new Map(), approvals = []
  const full = mode === 'full'
  const runtime = new OrbitRuntime({ requestApproval: async request => { approvals.push(request); return mode === 'ask-allow' }, runProvider: async options => {
    assert.equal(options.reasoningEffort, 'high')
    assert.equal(options.accessMode, full ? 'danger-full-access' : 'workspace-write')
    assert.equal(options.approvalPolicy, full ? 'never' : 'on-request')
    const [, name, id] = identity(options.prompt)
    const turn = (turns.get(id) || 0) + 1; turns.set(id, turn)
    if (name === 'Orbit' && turn === 1) return response(tool('spawn_agent', { name: 'Child', task: 'Write result', reason: 'Separate work', accessMode: 'danger-full-access', approvalPolicy: 'never' }), tool('wait_agent'))
    if (name === 'Child' && turn === 1) return response(tool('write_file', { path: 'child.txt', content: 'approved content' }))
    return { text: 'Finished' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: full ? 'danger-full-access' : 'workspace-write', approvalPolicy: full ? 'never' : 'on-request', reasoningEffort: 'high' }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(fs.existsSync(path.join(workspace, 'child.txt')), mode !== 'ask-deny')
  assert.equal(approvals.length, full ? 0 : 1)
  if (!full) assert.equal(approvals[0].agentName, 'Child')
})

test('per-agent effort obeys root, pool and explicit child selection without widening access', async t => {
  const workspace = folder(t), calls = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    const [, name] = identity(options.prompt)
    calls.push({ name, effort: options.reasoningEffort, access: options.accessMode })
    if (name === 'Orbit' && calls.filter(call => call.name === 'Orbit').length === 1) return response(
      tool('spawn_agent', { name: 'Pool', providerId: 'other', model: 'worker', reasoningEffort: 'high', task: 'Pool task', reason: 'Independent task' }),
      tool('spawn_agent', { name: 'Variant', providerId: 'other', model: 'variant', reasoningEffort: 'high', task: 'Variant task', reason: 'Independent task' }),
      tool('spawn_agent', { name: 'Explicit', reasoningEffort: 'low', task: 'Explicit task', reason: 'Independent task' }),
      tool('spawn_agent', { name: 'Default', model: 'different', task: 'Default task', reason: 'Independent task' }),
      tool('wait_agent'))
    return { text: 'Finished' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { model: 'root-model', accessMode: 'read-only', reasoningEffort: 'high', providerOptions: { test: { reasoningEffort: 'medium' } }, providerPool: [{ providerId: 'other', model: 'worker', reasoningEffort: 'low' }, { providerId: 'other', model: 'variant', reasoningEffort: 'low' }, { providerId: 'other', model: 'variant', reasoningEffort: 'high' }] }))
  assert.equal(snapshot.status, 'completed')
  assert.ok(calls.every(call => call.access === 'read-only'))
  assert.equal(calls.find(call => call.name === 'Orbit').effort, 'high')
  assert.equal(calls.find(call => call.name === 'Pool').effort, 'low')
  assert.equal(calls.find(call => call.name === 'Variant').effort, 'high')
  assert.equal(calls.find(call => call.name === 'Explicit').effort, 'low')
  assert.equal(calls.find(call => call.name === 'Default').effort, 'medium')
  assert.equal(snapshot.agents.find(agent => agent.name === 'Pool').reasoningEffort, 'low')
})

test('explicit auto effort stays auto for children despite a saved provider default', async t => {
  const workspace = folder(t)
  let rootCalls = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    assert.equal(options.reasoningEffort, '')
    const [, name] = identity(options.prompt)
    if (name === 'Orbit' && ++rootCalls === 1) return response(tool('spawn_agent', { name: 'Auto child', task: 'Check', reason: 'Independent check' }), tool('wait_agent'))
    return { text: 'Done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { reasoningEffort: '', providerOptions: { test: { reasoningEffort: 'high' } } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents.length, 2)
})

test('an agent adopts the level its provider reports as the one that ran', async t => {
  const workspace = folder(t), seen = []
  let rootCalls = 0, childCalls = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    const [, name] = identity(options.prompt)
    seen.push({ name, providerId: options.providerId, effort: options.reasoningEffort })
    if (name === 'Orbit') return ++rootCalls === 1 ? response(tool('spawn_agent', { name: 'Auto child', task: 'Check', reason: 'Independent check', providerId: 'cursor', model: 'auto' }), tool('wait_agent')) : { text: 'Done' }
    // The saved level cannot apply to `auto`: the provider says so on the first answer, and the agent stops asking for it.
    return ++childCalls === 1 ? { ...response(tool('list_files')), reasoningEffort: '' } : { text: 'Child done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerOptions: { cursor: { reasoningEffort: 'high' } } }))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(seen.filter(item => item.name === 'Auto child').map(item => [item.providerId, item.effort]), [['cursor', 'high'], ['cursor', '']])
  assert.equal(snapshot.agents.find(agent => agent.name === 'Auto child').reasoningEffort, '')
})

test('cancelling an approval does not write the proposed file', async t => {
  const workspace = folder(t)
  let runtime
  runtime = new OrbitRuntime({ requestApproval: request => { runtime.stop(request.runId); return new Promise(() => {}) }, runProvider: async () => response(tool('write_file', { path: 'blocked.txt', content: 'must not exist' })) })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'workspace-write', approvalPolicy: 'on-request' }))
  assert.equal(snapshot.status, 'cancelled')
  assert.equal(fs.existsSync(path.join(workspace, 'blocked.txt')), false)
})

test('project can disable global memory while retaining project recall and writes', async t => {
  const workspace = folder(t)
  const memoryStore = new OrbitMemoryStore(workspace)
  memoryStore.upsert({ title: 'Current task', content: 'GLOBAL_SECRET_MARKER', scope: 'global' })
  memoryStore.upsert({ title: 'Current task', content: 'PROJECT_FACT_MARKER', scope: 'project', workspace })
  let turn = 0
  const runtime = new OrbitRuntime({ memoryStore, runProvider: async ({ prompt }) => {
    assert.doesNotMatch(prompt, /GLOBAL_SECRET_MARKER/)
    assert.match(prompt, /PROJECT_FACT_MARKER/)
    if (++turn === 1) return response(tool('memory_search', { query: 'Current task' }), tool('memory_save', { title: 'Allowed', content: 'PROJECT_SAVED' }), tool('memory_save', { title: 'Blocked', content: 'GLOBAL_BLOCKED', scope: 'global' }))
    assert.match(prompt, /Global memory is disabled for this project/)
    return { text: 'Done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { globalMemoryEnabled: false }))
  assert.equal(snapshot.status, 'completed')
  assert.ok(memoryStore.list(workspace).some(entry => entry.content === 'PROJECT_SAVED'))
  assert.ok(!memoryStore.list(workspace).some(entry => entry.content === 'GLOBAL_BLOCKED'))
  const enabled = new OrbitRuntime({ memoryStore, runProvider: async ({ prompt }) => {
    assert.match(prompt, /GLOBAL_SECRET_MARKER/)
    return { text: 'Global memory available' }
  } })
  assert.equal((await finished(enabled, payload(workspace, { globalMemoryEnabled: true }))).snapshot.status, 'completed')
})

test('a greeting goes through one real provider turn without fixed roles or repository theater', async (t) => {
  let calls = 0
  const saved = []
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    calls++; assert.match(prompt, /YOUR CURRENT TASK:\nПривет/)
    return { text: 'Привет. Что будем делать?', model: 'test-model' }
  }, runStore: { save: (snapshot) => saved.push(snapshot) } })
  const { snapshot, events } = await finished(runtime, payload(folder(t), { prompt: 'Привет' }))
  assert.equal(calls, 1)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents.length, 1)
  assert.equal(snapshot.messages[0].text, 'Привет. Что будем делать?')
  assert.equal(snapshot.usage.inputTokens, null)
  assert.equal(saved.at(-1).status, 'completed')
  for (const event of events) { assert.equal(event.projectId, 'project-1'); assert.equal(event.chatId, 'chat-1') }
  assert.equal(events.filter((event) => event.type === 'run.finished').length, 1)
  const copy = runtime.getRun(snapshot.runId); copy.agents[0].name = 'mutated'
  assert.equal(runtime.getRun(snapshot.runId).agents[0].name, 'Orbit')
})

test('recursive children execute and return evidence with concurrency one, without parent deadlock', async (t) => {
  const turns = new Map()
  let active = 0, peak = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name, id] = identity(prompt), turn = (turns.get(id) || 0) + 1
    turns.set(id, turn); active++; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2)); active--
    if (name === 'Orbit' && turn === 1) return response(tool('spawn_agent', { name: 'Child', task: 'Inspect independent component', reason: 'Parallel component analysis' }), tool('wait_agent'))
    if (name === 'Child' && turn === 1) return response(tool('spawn_agent', { name: 'Grandchild', task: 'Check leaf implementation', reason: 'Bounded leaf evidence' }), tool('wait_agent'))
    if (name === 'Grandchild') return { text: 'Leaf evidence: actual result 42' }
    if (name === 'Child') { assert.match(prompt, /actual result 42/); return { text: 'Child integrated leaf 42' } }
    assert.match(prompt, /Child integrated leaf 42/)
    return { text: 'Root integrated both levels: 42' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(peak, 1)
  assert.equal(snapshot.agents.length, 3)
  assert.deepEqual(snapshot.agents.map((agent) => agent.depth), [0, 1, 2])
  assert.ok(snapshot.agents.every((agent) => agent.status === 'done'))
  assert.equal(snapshot.messages.at(-1).text, 'Root integrated both levels: 42')
})

test('a parent final answer waits for unconsumed child results and integrates them', async (t) => {
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Child') { await new Promise((resolve) => setTimeout(resolve, 20)); return { text: 'CHILD_FINDING' } }
    rootTurns++
    if (rootTurns === 1) return response(tool('spawn_agent', { name: 'Child', task: 'A bounded task', reason: 'Independent evidence' }))
    if (rootTurns === 2) return { text: 'Premature final must not be published' }
    assert.match(prompt, /CHILD_FINDING/)
    return { text: 'Integrated CHILD_FINDING' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(rootTurns, 3)
  assert.equal(snapshot.messages.some((message) => /Premature/.test(message.text)), false)
})

test('harness tools write/edit actual files, feed command results and report errors back to the model', async (t) => {
  const workspace = folder(t)
  let turns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    turns++
    if (turns === 1) return response(tool('write_file', { path: 'lib/value.txt', content: 'first' }), tool('edit_file', { path: 'lib/value.txt', old_text: 'first', new_text: 'second' }), tool('read_file', { path: 'lib/value.txt' }), tool('run_command', { command: process.execPath, args: ['-e', 'process.stdout.write("CHECK_OK")'] }), tool('unknown_tool'))
    assert.match(prompt, /second/); assert.match(prompt, /CHECK_OK/); assert.match(prompt, /Unknown tool: unknown_tool/)
    return { text: 'Changed file and checked it.' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'workspace-write' }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(fs.readFileSync(path.join(workspace, 'lib/value.txt'), 'utf8'), 'second')
})

test('read-only and canonical paths block write/command/traversal/symlink escapes', async (t) => {
  const root = folder(t), workspace = path.join(root, 'project'), outside = path.join(root, 'outside')
  fs.mkdirSync(workspace); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside')
  const context = { workspace, accessMode: 'read-only', maxOutputChars: 8000 }
  await assert.rejects(executeWorkspaceTool('write_file', { path: 'new.txt', content: 'bad' }, context), /read-only/)
  await assert.rejects(executeWorkspaceTool('run_command', { command: process.execPath, args: ['-e', ''] }, context), /read-only/)
  assert.throws(() => workspacePath(workspace, '../outside/private.txt'), /outside/)
  assert.throws(() => workspacePath(workspace, '.git/config', true), /Git internals/)
  fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => workspacePath(workspace, 'escape/private.txt'), /outside/)
  await assert.rejects(executeWorkspaceTool('write_file', { path: 'escape/new.txt', content: 'bad' }, { ...context, accessMode: 'workspace-write' }), /outside/)
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false)
})

test('model memory and capability learning persists, defaults to selected project and respects disabled memory', async (t) => {
  const root = folder(t), workspace = path.join(root, 'project'), other = path.join(root, 'other')
  fs.mkdirSync(workspace); fs.mkdirSync(other)
  const memory = new OrbitMemoryStore(path.join(root, 'store'))
  const capabilities = new CapabilityStore(path.join(root, 'store'))
  let turns = 0
  const runtime = new OrbitRuntime({ memoryStore: memory, capabilityStore: capabilities, runProvider: async ({ prompt }) => {
    if (++turns === 1) return response(tool('memory_save', { title: 'Project fact', content: 'Verified fixture fact', workspace: other }), tool('capability_install', { name: 'Project check', description: 'Verified helper', instructions: 'Read package.json and use the verified project test command.', workspace: other }))
    assert.match(prompt, /Verified fixture fact/)
    return { text: 'Learned from verified work.' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.equal(memory.list(workspace).length, 1); assert.equal(memory.list(other).length, 0)
  assert.equal(capabilities.list(workspace).length, 1); assert.equal(capabilities.list(other).length, 0)
  assert.equal(new OrbitMemoryStore(path.join(root, 'store')).list(workspace).length, 1)
  let disabledTurns = 0
  const disabled = new OrbitRuntime({ memoryStore: memory, runProvider: async ({ prompt }) => {
    if (++disabledTurns === 1) { assert.doesNotMatch(prompt, /Verified fixture fact/); return response(tool('memory_save', { title: 'No', content: 'No' })) }
    assert.match(prompt, /Durable memory is disabled/)
    return { text: 'Memory was disabled.' }
  } })
  await finished(disabled, payload(workspace, { memoryEnabled: false }))
  assert.equal(memory.list(workspace).length, 1)
})

test('delegation requires a reason and enforces depth, count and shared turn budgets', async (t) => {
  let turns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (++turns === 1) return response(tool('spawn_agent', { task: 'No reason' }), tool('spawn_agent', { task: 'Beyond limit', reason: 'Useful' }))
    assert.match(prompt, /task_and_delegation_reason_required/); assert.match(prompt, /depth_limit/)
    return { text: 'Completed without unnecessary children.' }
  } })
  const result = await finished(runtime, payload(folder(t), { limits: { maxDepth: 0 } }))
  assert.equal(result.snapshot.agents.length, 1)
  let rootTurns = 0
  const exhausted = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (identity(prompt)[1] !== 'Orbit') return response(tool('list_agents'))
    if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'Inspect', reason: 'Independent check' }), tool('wait_agent'))
    assert.match(prompt, /budgetLimited/)
    return { text: 'Available findings preserved; worker reached its limit.' }
  } })
  const limited = await finished(exhausted, payload(folder(t), { limits: { maxTotalTurns: 2, maxTurns: 10 } }))
  assert.equal(limited.snapshot.status, 'completed')
  assert.equal(limited.snapshot.usage.workerTurns, 2)
  assert.equal(limited.snapshot.agents[1].budgetLimited, true)
})

test('cancellation cascades to active and queued agents and retains terminal snapshots', async (t) => {
  let first = true, started
  const activeStarted = new Promise((resolve) => { started = resolve })
  let aborted = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ signal }) => {
    if (first) { first = false; return response(...[1, 2, 3].map((number) => tool('spawn_agent', { name: `Child${number}`, task: `Bounded task ${number}`, reason: 'Independent work' })), tool('wait_agent')) }
    started()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('Provider was cancelled')) }, { once: true }))
  } })
  const runId = await runtime.start(payload(folder(t), { limits: { maxConcurrent: 1 } }))
  await activeStarted
  assert.equal(runtime.stop(runId), true)
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = runtime.getRun(runId)
  assert.equal(snapshot.status, 'cancelled')
  assert.equal(snapshot.agents.length, 4)
  assert.ok(snapshot.agents.every((agent) => agent.status === 'cancelled'))
  assert.equal(aborted, 1)
  assert.equal(runtime.stop(runId), false)
})

test('provider failures and timeouts fail truthfully without synthetic fallback success', async (t) => {
  const failed = await finished(new OrbitRuntime({ runProvider: async () => { throw new Error('Provider unavailable') } }), payload(folder(t)))
  assert.equal(failed.snapshot.status, 'failed'); assert.equal(failed.snapshot.messages.length, 0)
  assert.match(failed.snapshot.error, /Provider unavailable/)
  let aborted = false
  const timed = await finished(new OrbitRuntime({ runProvider: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {})
  } }), payload(folder(t), { limits: { timeoutMs: 25 } }))
  assert.equal(timed.snapshot.status, 'failed'); assert.match(timed.snapshot.error, /time budget/); assert.equal(aborted, true)
})

test('long optional context cannot remove the task or latest chat; requested model survives display aliases', async (t) => {
  const task = `TASK_START_${'u'.repeat(22000)}_TASK_END`
  const history = Array.from({ length: 24 }, (_, index) => ({ role: 'user', content: `${index === 23 ? 'LATEST_MESSAGE' : `old${index}`} ${'x'.repeat(5000)}` }))
  let turns = 0
  const runtime = new OrbitRuntime({ memoryStore: { search: () => [{ content: 'm'.repeat(30000) }] }, runProvider: async ({ prompt, model }) => {
    assert.match(prompt, /TASK_START_/); assert.match(prompt, /_TASK_END/); assert.match(prompt, /LATEST_MESSAGE/)
    assert.equal(model, 'requested-alias')
    if (++turns === 1) return { ...response(tool('list_agents')), model: 'resolved-model-name' }
    return { text: 'Handled the complete task', model: 'resolved-model-name' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { prompt: task, history, model: 'requested-alias' }))
  assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.model, 'resolved-model-name')
})

test('streaming deltas coalesce, preserve native evidence and do not persist per token', async (t) => {
  let saves = 0
  const runtime = new OrbitRuntime({ runStore: { save: () => { saves++ } }, runProvider: async ({ onEvent }) => {
    for (let index = 0; index < 500; index++) onEvent({ kind: 'output', text: 'a', partial: true, messageId: 'msg' })
    onEvent({ kind: 'tool', text: 'Test command', output: 'REAL_OUTPUT', exitCode: 7, status: 'failed' })
    return { text: 'The check failed.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.traces.filter((trace) => trace.kind === 'output').length, 1)
  assert.match(snapshot.traces.find((trace) => trace.kind === 'tool').text, /REAL_OUTPUT[\s\S]*exitCode=7/)
  assert.ok(saves < 20, `${saves} snapshots should not scale with token count`)
})

test('different chats can write concurrently in one project; duplicate turns in one chat are rejected', async (t) => {
  const workspace = folder(t)
  const runtime = new OrbitRuntime({ runProvider: () => new Promise(() => {}) })
  const runId = await runtime.start(payload(workspace, { accessMode: 'workspace-write' }))
  const second = await runtime.start(payload(workspace, { accessMode: 'workspace-write', chatId: 'chat-2' }))
  await assert.rejects(runtime.start(payload(workspace, { accessMode: 'read-only' })), /В этом чате/)
  assert.equal(runtime.getRuns().filter(run => run.status === 'working').length, 2)
  runtime.stop(runId); runtime.stop(second)
})

test('tool envelopes are explicit and natural JSON/text is not interpreted as routing intent', () => {
  assert.deepEqual(parseResponse('Привет!'), { content: 'Привет!', calls: [] })
  assert.equal(parseResponse('{"kind":"task","reply":"hello"}').calls.length, 0)
  assert.equal(parseResponse('```json\n{"tool_calls":[{"name":"list_files","arguments":{}}]}\n```').calls[0].name, 'list_files')
  assert.equal(parseResponse('Prefix.\n```json\n{"tool_calls":[{"name":"list_agents","arguments":{}}]}\n```\nSuffix.').calls[0].name, 'list_agents')
  assert.equal(parseResponse('\uFEFF{"tool_calls":[{"name":"list_agents","arguments":{}}]}').calls[0].name, 'list_agents')
  assert.equal(parseResponse('{"content":"Final","tool_calls":[]}').content, 'Final')
  assert.equal(parseResponse(JSON.stringify({ tool_calls: Array.from({ length: 100 }, () => tool('list_agents')) })).calls.length, 100)
})

test('broken tool envelopes cannot fall back to a final answer or execute a partial call', () => {
  const valid = JSON.stringify({ content: 'Starting council.', tool_calls: [tool('spawn_agent', { name: 'Product', task: 'Prioritize', reason: 'Independent review' })] })
  for (const broken of [
    valid.replace(/\]\}$/, '}]}'), // Extra closing brace, as in the reported council response.
    valid.slice(0, -2),
    valid.replace(/\]\}$/, ',]}'),
    valid.replace('"Starting council."', '"Starting\ncouncil."'),
    '{"tool_calls":null}', '{"tool_calls":{}}', '{"tool_calls":[null]}',
    '{"tool_calls":[{"arguments":{"tool_calls":[{"name":"write_file"}]}}',
    '{"tool_\\u0063alls":[',
  ]) {
    for (const wrapped of [broken, `\uFEFF${broken}`, `Prefix.\n\x60\x60\x60json\n${broken}\n\x60\x60\x60\nSuffix.`]) {
      assert.throws(() => parseResponse(wrapped), { name: 'ToolProtocolError' }, wrapped)
    }
  }
  assert.throws(() => parseResponse({ content: 'Update', tool_calls: {} }), /tool_calls must be an array/)
  for (const ordinary of ['The field "tool_calls": contains requests.', '{"example":"tool_calls", broken}', '{"content":"Example: \\"tool_calls\\": []"}', JSON.stringify({ example: { tool_calls: [] } })]) {
    assert.equal(parseResponse(ordinary).calls.length, 0)
  }
})

test('a malformed council response is repaired before spawning and is never published', async t => {
  const names = ['Product', 'Architecture', 'Reliability']
  const council = JSON.stringify({ content: 'Internal council progress.', tool_calls: [
    ...names.map(name => tool('spawn_agent', { name, task: 'Independent priority review', reason: 'Different review perspective' })),
    tool('wait_agent'),
  ] })
  const broken = council.replace(/\]\}$/, '}]}')
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name !== 'Orbit') return { text: `${name}_RESULT` }
    if (++rootTurns === 1) return { text: broken }
    if (rootTurns === 2) {
      assert.match(prompt, /No Orbit tools from that response were executed/)
      assert.equal(runtime.getRuns()[0].agents.length, 1)
      assert.equal(runtime.getRuns()[0].messages.length, 0)
      return { text: council }
    }
    for (const name of names) assert.ok(prompt.includes(`${name}_RESULT`))
    return { text: 'COUNCIL_FINAL' }
  } })
  const { snapshot, events } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(rootTurns, 3)
  assert.equal(snapshot.agents.length, 4)
  assert.equal(events.filter(event => event.type === 'agent.created').length, 4)
  assert.deepEqual(snapshot.messages.filter(message => message.agentId === 'root').map(message => message.text), ['COUNCIL_FINAL'])
  assert.equal(snapshot.traces.filter(trace => trace.kind === 'protocol_error').length, 1)
  assert.ok(events.every(event => !event.message || !event.message.text.includes('tool_calls')))
})

test('persistent malformed envelopes fail after bounded repairs without publishing an answer', async t => {
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: '{"content":"Internal","tool_calls":[' }) })
  const { snapshot, events } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'failed')
  assert.match(snapshot.error, /protocol failed after 2 repair attempts/)
  assert.equal(snapshot.usage.providerTurns, 3)
  assert.equal(snapshot.agents.length, 1)
  assert.deepEqual(snapshot.messages, [])
  assert.ok(events.every(event => !event.message))
})

test('tool-envelope progress is not published as a user answer', async (t) => {
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Child') return { text: 'CHILD_RESULT' }
    if (++rootTurns === 1) return { text: JSON.stringify({ content: 'Internal progress note.', tool_calls: [tool('spawn_agent', { name: 'Child', task: 'Bounded check', reason: 'Independent evidence' }), tool('wait_agent')] }) }
    assert.match(prompt, /CHILD_RESULT/)
    return { text: 'ROOT_FINAL' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(snapshot.messages.map((message) => message.text), ['CHILD_RESULT', 'ROOT_FINAL'])
  assert.ok(snapshot.traces.some((trace) => trace.kind === 'assistant_update' && trace.text === 'Internal progress note.'))
})

test('cancelled write operations block overlapping folders until native cleanup settles', async (t) => {
  const workspace = folder(t), nested = path.join(workspace, 'nested')
  fs.mkdirSync(nested)
  let releaseCleanup, providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const runtime = new OrbitRuntime({ runProvider: ({ signal }) => {
    providerStarted()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { releaseCleanup = () => reject(new Error('Native process tree exited')) }, { once: true }))
  } })
  const runId = await runtime.start(payload(workspace, { accessMode: 'workspace-write' }))
  await started
  runtime.stop(runId)
  await assert.rejects(runtime.start(payload(nested, { accessMode: 'workspace-write', chatId: 'chat-2' })), /process cleanup/)
  releaseCleanup()
  await new Promise((resolve) => setImmediate(resolve))
  const next = await runtime.start(payload(nested, { accessMode: 'workspace-write' }))
  runtime.stop(next)
})

test('a child provider failure cancels its descendants while its parent can handle the real failure', async (t) => {
  let rootTurns = 0, childTurns = 0, grandchildStarted, aborted = false
  const started = new Promise((resolve) => { grandchildStarted = resolve })
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt, signal }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Child', task: 'Independent task', reason: 'Independent component' }), tool('wait_agent'))
      assert.match(prompt, /Child provider failed/)
      return { text: 'The delegated provider failed; no success is claimed.' }
    }
    if (name === 'Child') {
      if (++childTurns === 1) return response(tool('spawn_agent', { name: 'Grandchild', task: 'Long-running leaf task', reason: 'Independent leaf' }))
      await started
      throw new Error('Child provider failed')
    }
    grandchildStarted()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Leaf cancelled')) }, { once: true }))
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(aborted, true)
  assert.equal(snapshot.agents.find((agent) => agent.name === 'Child').status, 'error')
  assert.equal(snapshot.agents.find((agent) => agent.name === 'Grandchild').status, 'cancelled')
})

test('harness command timeout waits for process termination', async (t) => {
  const workspace = folder(t)
  const marker = path.join(workspace, 'late-write.txt')
  const pidFile = path.join(workspace, 'pid.txt')
  // The command records its pid at once and would write the marker 2 s later, so even a taskkill that starts slowly
  // under the load of the whole suite ends it first.
  const script = 'const fs = require("node:fs"); fs.writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => fs.writeFileSync(process.argv[1], "late"), 2000)'
  const result = await executeWorkspaceTool('run_command', { command: process.execPath, args: ['-e', script, marker, pidFile], timeout_ms: 40 }, { workspace, accessMode: 'workspace-write', maxOutputChars: 2000 })
  assert.equal(result.timedOut, true)
  // The tool answers only after the process ended: if it got far enough to record its pid, that process is gone now.
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0
  if (pid > 0) assert.throws(() => process.kill(pid, 0), /ESRCH/)
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(fs.existsSync(marker), false)
})

test('parent and child exchange durable messages through mailboxes at concurrency one', async (t) => {
  let rootTurns = 0, replied = false
  const saved = []
  const runtime = new OrbitRuntime({ runStore: { save: (snapshot) => saved.push(snapshot) }, runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Проверка', task: 'Coordinate a bounded check', reason: 'Independent check' }), tool('send_message', { agentId: 'Проверка', message: 'ROOT_GREETING' }), tool('wait_message', { timeout_ms: 1000 }))
      if (rootTurns === 2) {
        assert.match(prompt, /CHILD_REPLY/)
        return response(tool('send_message', { agentId: 'Проверка', message: 'ROOT_ACK' }), tool('wait_agent'))
      }
      return { text: 'Root integrated child findings.' }
    }
    if (!prompt.includes('ROOT_GREETING')) return response(tool('wait_message', { timeout_ms: 1000 }))
    if (!replied) { replied = true; return response(tool('send_message', { agentId: 'root', message: 'CHILD_REPLY' }), tool('wait_message', { timeout_ms: 1000 })) }
    assert.match(prompt, /ROOT_ACK/)
    return { text: 'Child check completed.' }
  } })
  const { snapshot, events } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(dialogue(snapshot).length, 3)
  assert.deepEqual(dialogue(snapshot).map((message) => message.text), ['ROOT_GREETING', 'CHILD_REPLY', 'ROOT_ACK'])
  assert.ok(dialogue(snapshot).every((message) => message.status === 'read' && message.deliveredAt && message.readAt))
  assert.equal(new Set(dialogue(snapshot).map((message) => message.id)).size, 3)
  assert.equal(dialogue(saved.at(-1)).length, 3)
  assert.equal(snapshot.messages.some((message) => ['ROOT_GREETING', 'CHILD_REPLY', 'ROOT_ACK'].includes(message.text)), false)
  assert.ok(events.some((event) => event.type === 'communication.added'))
  assert.equal(runtime.runs.get(snapshot.runId).messageWaiters.size, 0)
})

test('siblings communicate by unique name and mailbox waits do not occupy provider capacity', async (t) => {
  let rootTurns = 0, sent = false, replied = false
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Consumer', task: 'Receive sibling finding', reason: 'Separate component' }), tool('spawn_agent', { name: 'Producer', task: 'Send sibling finding', reason: 'Independent evidence' }), tool('wait_agent'))
      return { text: 'Both siblings coordinated.' }
    }
    if (name === 'Consumer') {
      if (!prompt.includes('SIBLING_FINDING')) return response(tool('wait_message', { timeout_ms: 1000 }))
      if (!replied) { replied = true; return response(tool('send_message', { agentId: 'Producer', message: 'SIBLING_ACK' })) }
      return { text: 'Consumer integrated finding.' }
    }
    if (!sent) { sent = true; return response(tool('send_message', { agentId: 'Consumer', message: 'SIBLING_FINDING' }), tool('wait_message', { timeout_ms: 1000 })) }
    assert.match(prompt, /SIBLING_ACK/)
    return { text: 'Producer completed handoff.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(dialogue(snapshot).length, 2)
  assert.ok(dialogue(snapshot).every((message) => message.fromAgentId !== 'root' && message.toAgentId !== 'root' && message.status === 'read'))
})

test('follow-up resumes the same finished node, preserves context and requires new result integration', async (t) => {
  let rootTurns = 0, childTurns = 0, childId
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name, id] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'First bounded task', reason: 'Independent task' }), tool('wait_agent'))
      if (rootTurns === 2) {
        assert.match(prompt, /FIRST_RESULT/)
        return response(tool('followup_agent', { agentId: 'Worker', task: 'SECOND_TASK', reason: 'Verify the prior result' }), tool('wait_agent'))
      }
      assert.match(prompt, /SECOND_RESULT/)
      return { text: 'Integrated the follow-up result.' }
    }
    if (++childTurns === 1) { childId = id; return { text: 'FIRST_RESULT' } }
    assert.equal(id, childId); assert.match(prompt, /FIRST_RESULT/); assert.match(prompt, /SECOND_TASK/)
    return { text: 'SECOND_RESULT' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents.length, 2)
  const child = snapshot.agents.find((agent) => agent.id === childId)
  assert.equal(child.generation, 1); assert.equal(child.turns, 2); assert.equal(child.result, 'SECOND_RESULT')
  assert.equal(snapshot.usage.providerTurns, 5)
  assert.equal(dialogue(snapshot).length, 0)
})

test('failed agents can be explicitly retried while turn budgets cannot be reset by follow-up', async (t) => {
  let rootTurns = 0, childTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'Bounded task', reason: 'Independent task' }), tool('wait_agent'))
      if (rootTurns === 2) return response(tool('followup_agent', { agentId: 'Worker', task: 'Retry using prior failure' }), tool('wait_agent'))
      assert.match(prompt, /RECOVERED/)
      return { text: 'Recovery complete.' }
    }
    if (++childTurns === 1) throw new Error('FIRST_FAILURE')
    assert.match(prompt, /FIRST_FAILURE/)
    return { text: 'RECOVERED' }
  } })
  assert.equal((await finished(runtime, payload(folder(t)))).snapshot.status, 'completed')
  rootTurns = 0; childTurns = 0
  const exhausted = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'Consume bounded budget', reason: 'Independent task' }), tool('wait_agent'))
      if (rootTurns === 2) return response(tool('followup_agent', { agentId: 'Worker', task: 'Cannot reset budget' }))
      assert.match(prompt, /follow-up cannot reset budgets/)
      return { text: 'Budget boundary respected.' }
    }
    return ++childTurns < 3 ? response(tool('list_agents')) : { text: 'Worker finished its three turns.' }
  } })
  const result = await finished(exhausted, payload(folder(t), { limits: { maxTurns: 3 } }))
  assert.equal(result.snapshot.status, 'completed')
  assert.equal(result.snapshot.agents[1].turns, 3); assert.equal(result.snapshot.agents[1].generation, 0)
})

test('mailbox timeout and cancellation clean up pending waits without phantom messages', async (t) => {
  let turns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (++turns === 1) return response(tool('wait_message', { timeout_ms: 10 }), tool('read_messages'))
    assert.match(prompt, /timedOut/); assert.match(prompt, /remainingUnread/)
    return { text: 'No messages arrived.' }
  } })
  const result = await finished(runtime, payload(folder(t)))
  assert.equal(result.snapshot.status, 'completed'); assert.equal(runtime.runs.get(result.runId).messageWaiters.size, 0)
  const waiting = new OrbitRuntime({ runProvider: async () => response(tool('wait_message', { timeout_ms: 60000 })) })
  let wake
  const started = new Promise((resolve) => { wake = resolve })
  waiting.onEvent((event) => { if (event.type === 'agent.updated' && event.agent.detail === 'Waiting for a message') wake() })
  const runId = await waiting.start(payload(folder(t)))
  await started
  waiting.stop(runId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(waiting.getRun(runId).status, 'cancelled')
  assert.equal(waiting.runs.get(runId).messageWaiters.size, 0)
})

test('changing a child provider does not inherit an incompatible parent model', async (t) => {
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ providerId, model }) => {
    if (providerId === 'second-provider') { assert.equal(model, ''); return { text: 'Other provider used its default.' } }
    assert.equal(model, 'parent-only-model')
    if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'Independent check', reason: 'Second provider evidence', providerId: 'second-provider' }), tool('wait_agent'))
    return { text: 'Integrated other provider.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { model: 'parent-only-model' }))
  assert.equal(snapshot.status, 'completed')
})

test('model-supplied ids cannot overwrite root and repeated names reuse the existing participant', async (t) => {
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name !== 'Orbit') return { text: 'Child result' }
    if (++rootTurns === 1) return response(tool('spawn_agent', { id: 'root', name: 'Worker', task: 'Independent1', reason: 'Bounded1' }), tool('spawn_agent', { id: 'root', name: 'Worker', task: 'Independent2', reason: 'Bounded2' }), tool('send_message', { agentId: 'Worker', message: 'Ambiguous destination' }), tool('wait_agent'))
    assert.match(prompt, /reused/)
    return { text: 'Root identity retained.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents.length, 2)
  assert.equal(snapshot.agents[0].id, 'root'); assert.equal(snapshot.agents[0].name, 'Orbit')
  assert.equal(new Set(snapshot.agents.map((agent) => agent.id)).size, 2)
})

test('root inference has no turn count limit even when worker budgets are tiny', async t => {
  let turns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    assert.match(prompt, /"rootTurns":"unlimited"/)
    // Each turn makes real progress; only identical repeated calls are stopped (see loop-guard tests).
    return ++turns <= 15 ? response(tool('context_save', { key: `turn-${turns}`, summary: `progress ${turns}` })) : { text: 'Sixteen root turns completed.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxTurns: 1, maxTotalTurns: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents[0].turns, 16)
  assert.equal(snapshot.usage.workerTurns, 0)
})

test('spawn batches start concurrently and interleaved waits cannot serialize them', async t => {
  let rootTurns = 0, active = 0, peak = 0, release
  const allStarted = new Promise(resolve => { release = resolve })
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'A', task: 'Check A', reason: 'A' }), tool('wait_agent'), tool('spawn_agent', { name: 'B', task: 'Check B', reason: 'B' }), tool('spawn_agent', { name: 'C', task: 'Check C', reason: 'C' }))
      return { text: 'All concurrent findings integrated.' }
    }
    for (const member of ['A', 'B', 'C']) assert.ok(prompt.includes(`"name":"${member}"`))
    active++; peak = Math.max(peak, active)
    if (active === 3) release()
    await allStarted
    active--
    return { text: `${name}_RESULT` }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 3 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(peak, 3)
  assert.equal(snapshot.usage.providerTurns, 5)
  const introductions = snapshot.communications.filter(message => message.kind === 'spawn')
  assert.equal(introductions.length, 4)
  assert.equal(introductions[0].fromAgentId, 'user')
  assert.ok(introductions.slice(1).every(message => message.fromAgentId === 'root' && message.status === 'read'))
})

test('a sibling can continue a finished participants conversation without changing its task or identity', async t => {
  let rootTurns = 0, aTurns = 0, bTurns = 0, aId
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name, id] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'A', task: 'ORIGINAL_A_TASK', reason: 'Specialized perspective' }), tool('wait_agent'))
      if (rootTurns === 2) return response(tool('spawn_agent', { name: 'B', task: 'Compare with existing A', reason: 'Second perspective' }), tool('wait_agent'))
      assert.match(prompt, /A_REVISED/); assert.match(prompt, /B_CONSENSUS/)
      return { text: 'Discussion integrated.' }
    }
    if (name === 'A') {
      if (++aTurns === 1) { aId = id; return { text: 'A_INITIAL' } }
      assert.equal(id, aId); assert.match(prompt, /ORIGINAL_A_TASK/); assert.match(prompt, /A_INITIAL/); assert.match(prompt, /B_QUESTION/)
      if (aTurns === 2) return response(tool('send_message', { agentId: 'B', message: 'A_RESPONSE' }))
      return { text: 'A_REVISED' }
    }
    if (++bTurns === 1) return response(tool('send_message', { agentId: 'A', message: 'B_QUESTION' }), tool('wait_message', { timeout_ms: 1000 }))
    assert.match(prompt, /A_RESPONSE/)
    if (bTurns === 2) return response(tool('read_conversation', { limit: 20 }))
    assert.ok(prompt.includes('\\"kind\\":\\"spawn\\"'))
    return { text: 'B_CONSENSUS' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.agents.length, 3)
  assert.equal(snapshot.agents.find(agent => agent.id === aId).task, 'ORIGINAL_A_TASK')
  assert.equal(snapshot.agents.find(agent => agent.id === aId).generation, 1)
  assert.deepEqual(dialogue(snapshot).map(message => message.text), ['B_QUESTION', 'A_RESPONSE'])
})

test('waiting for child results wakes on a question instead of deadlocking the discussion', async t => {
  let rootTurns = 0, childTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (identity(prompt)[1] === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Questioner', task: 'Ask before completing', reason: 'Evidence needed' }), tool('wait_agent'))
      if (rootTurns === 2) { assert.match(prompt, /QUESTION/); return response(tool('send_message', { agentId: 'Questioner', message: 'ANSWER' }), tool('wait_agent')) }
      return { text: 'Question resolved.' }
    }
    if (++childTurns === 1) return response(tool('send_message', { agentId: 'root', message: 'QUESTION' }), tool('wait_message', { timeout_ms: 1000 }))
    assert.match(prompt, /ANSWER/)
    return { text: 'Child finished with answer.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(rootTurns, 3)
  assert.ok(dialogue(snapshot).every(message => message.status === 'read'))
})

test('workers get a final handoff turn and their limit cannot discard the root result', async t => {
  let rootTurns = 0, childTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (identity(prompt)[1] === 'Orbit') {
      if (++rootTurns === 1) return response(tool('spawn_agent', { name: 'Worker', task: 'Bounded inspection', reason: 'Evidence' }), tool('wait_agent'))
      assert.match(prompt, /PRESERVED_FINDING/)
      return { text: 'Useful summary with remaining questions.' }
    }
    if (++childTurns === 1) return response(tool('list_files'))
    assert.match(prompt, /FINAL WORKER TURN/)
    return { text: 'PRESERVED_FINDING; further checks remain.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxTurns: 2 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.agents[1].budgetLimited, true)
  assert.deepEqual(snapshot.summary.limitedAgents, [snapshot.agents[1].id])
  assert.match(snapshot.summary.text, /Useful summary/)
})

test('broadcast wakes existing participants once and preserves a shared reply reference', async t => {
  const turns = new Map()
  let rootTurns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++rootTurns === 1) return response(...['A', 'B'].map(name => tool('spawn_agent', { name, task: `Initial ${name}`, reason: 'Perspective' })), tool('wait_agent'))
      if (rootTurns === 2) return response(tool('broadcast_message', { message: 'GROUP_QUESTION', replyTo: runtime.getRuns()[0].communications[0].id }), tool('wait_agent'))
      assert.match(prompt, /A_UPDATED/); assert.match(prompt, /B_UPDATED/)
      return { text: 'Shared discussion complete.' }
    }
    const turn = (turns.get(name) || 0) + 1; turns.set(name, turn)
    if (turn === 1) return { text: `${name}_INITIAL` }
    assert.match(prompt, /GROUP_QUESTION/); assert.ok(prompt.includes(`${name}_INITIAL`))
    return { text: `${name}_UPDATED` }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(snapshot.agents.length, 3)
  const messages = dialogue(snapshot)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].discussionId, messages[1].discussionId)
  assert.ok(messages[0].discussionId)
  assert.ok(messages.every(message => message.replyTo === snapshot.communications[0].id && message.status === 'read'))
})

test('parallel workers respect their shared budget while root remains available to summarize', async t => {
  let roots = 0, workerCalls = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (identity(prompt)[1] !== 'Orbit') { workerCalls++; return { text: 'ONE_CONFIRMED_FINDING' } }
    if (++roots === 1) return response(...['A', 'B', 'C'].map(name => tool('spawn_agent', { name, task: name, reason: 'Independent' })), tool('wait_agent'))
    assert.match(prompt, /ONE_CONFIRMED_FINDING/)
    return { text: 'Partial result, remaining checks need more worker budget.' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { limits: { maxConcurrent: 3, maxTotalTurns: 1 } }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(workerCalls, 1)
  assert.equal(snapshot.usage.workerTurns, 1)
  assert.equal(snapshot.agents.length, 4)
  assert.ok(snapshot.agents.every(agent => agent.status === 'done'))
})

test('old protocol answers and malformed repair examples never enter model conversation history', async t => {
  const broken = '{"content":"BAD_PROTOCOL_MARKER","tool_calls":[{"id":"spawn-broken","name":"Specialist","task":"Inspect","reason":"Review"}}]}'
  const valid = JSON.stringify({ content: 'OLD_PROTOCOL_MARKER', tool_calls: [tool('list_agents')] })
  const history = [{ role: 'assistant', content: broken }, { role: 'assistant', content: valid }, { role: 'assistant', content: 'KEEP_NORMAL_ANSWER' }, { role: 'user', content: 'KEEP_USER_MESSAGE' }]
  let turns = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt, responseSchema }) => {
    assert.ok(responseSchema.properties.tool_calls)
    assert.doesNotMatch(prompt, /BAD_PROTOCOL_MARKER|OLD_PROTOCOL_MARKER/)
    assert.match(prompt, /KEEP_NORMAL_ANSWER/); assert.match(prompt, /KEEP_USER_MESSAGE/)
    if (++turns === 1) return { text: broken }
    assert.match(prompt, /No Orbit tools from that response were executed/)
    return { text: 'RECOVERED' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t), { history }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(history[0].content, broken, 'Saved user history is not mutated')
})

test('six consecutive polling turns get one nudge to wait, and the agent is not stopped for it', async t => {
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    turn++
    // Every poll differs (a new key each time), so the loop guard sees no repeats; only the poll budget can notice.
    return turn <= 9 ? response(tool('context_read', { key: `note-${turn}` })) : { text: 'polled enough' }
  } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.summary.text, 'polled enough')
  assert.equal(snapshot.agents[0].turns, 10)
  assert.doesNotMatch(prompts[5], /POLL BUDGET/)
  assert.match(prompts[6], /POLL BUDGET: your last 6 turns only polled/)
  assert.match(prompts[6], /wait_agent \{timeout_ms\}/)
  assert.equal(prompts.filter(prompt => /POLL BUDGET/.test(prompt)).length, 4, 'one instruction, kept in the transcript window from then on')
  assert.ok(snapshot.traces.some(trace => trace.kind === 'budget' && /Poll budget/.test(trace.text)))
})

test('the inspector keeps the newest 2000 traces', async t => {
  const runtime = new OrbitRuntime({ runProvider: () => new Promise(() => {}) })
  const runId = await runtime.start(payload(folder(t)))
  const run = runtime.runs.get(runId)
  for (let index = 0; index < 2100; index++) runtime.trace(run, 'root', 'note', `trace ${index}`)
  // The run's own background work (index refresh diagnostics, transport notes) may add a trace of another kind at any
  // moment, so the cap is checked on the whole list and the order on the notes alone.
  const others = run.traces.filter(trace => trace.kind !== 'note').map(trace => `${trace.kind}: ${trace.text}`)
  assert.equal(run.traces.length, 2000, `unrelated traces: ${JSON.stringify(others)}`)
  const notes = run.traces.filter(trace => trace.kind === 'note')
  assert.equal(notes.at(-1).text, 'trace 2099')
  assert.ok(Number(notes[0].text.slice('trace '.length)) >= 100, `oldest kept note is ${notes[0].text}; unrelated traces: ${JSON.stringify(others)}`)
  assert.equal(notes.length, 2000 - others.length)
  runtime.stop(runId)
})

test('run files are written in coalesced batches, not once per agent update, and the terminal write is immediate', async t => {
  const saves = []
  let turn = 0
  const runtime = new OrbitRuntime({ runStore: { save: snapshot => saves.push(snapshot.status) }, runProvider: async () => ++turn <= 20 ? response(tool('context_save', { key: `k${turn}`, summary: `s${turn}` })) : { text: 'done' } })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.status, 'completed')
  assert.ok(saves.length <= 4, `${saves.length} writes for 21 turns`)
  assert.equal(saves.at(-1), 'completed')
})

test('listeners get one detached copy of each event: mutating it changes neither the run nor other listeners', async t => {
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'answer' }) })
  runtime.onEvent(event => { if (event.agent) event.agent.name = 'mutated' })
  runtime.onEvent(event => { if (event.agent) seen.push(event.agent.name) })
  const { snapshot } = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.agents[0].name, 'Orbit')
  assert.ok(seen.length > 0 && seen.every(name => name === 'mutated'), 'the copy is shared by the listeners of one emit')
})

test('tracked transcript sizes stay equal to the serialised transcript through trimming', async t => {
  const workspace = folder(t)
  for (let index = 1; index <= 30; index++) fs.writeFileSync(path.join(workspace, `big-${index}.txt`), `${`BODY_${index} `.padEnd(100, '.')}\n`.repeat(100))
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async () => ++turn <= 30 ? response(tool('read_file', { path: `big-${turn}.txt`, limit: 100 })) : { text: 'done' } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, { limits: { maxContextChars: 40000 } }))
  assert.equal(snapshot.status, 'completed')
  const root = runtime.runs.get(runId).agentNodes.get('root')
  assert.ok(root.transcript.length < 60, 'old observations were trimmed')
  assert.equal(root.transcriptChars, JSON.stringify(root.transcript).length - root.transcript.length - 1)
  assert.ok(root.transcript.length <= 2 || JSON.stringify(root.transcript).length <= 40000 * 2)
})

test('the envelope prompt takes its tool guide from the tool registry when one is present', async t => {
  const prompts = []
  const runtime = new OrbitRuntime({ registry: { describeForPrompt: (agent, run) => `REGISTRY GUIDE for ${agent.name} in ${run.workspace}` }, runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } } })
  const workspace = folder(t)
  await finished(runtime, payload(workspace))
  assert.ok(prompts[0].startsWith(`REGISTRY GUIDE for Orbit in ${fs.realpathSync(workspace)}`))
  assert.doesNotMatch(prompts[0], /Orbit tool protocol:/)
  const plain = new OrbitRuntime({ registry: null, runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } } })
  await finished(plain, payload(workspace))
  assert.ok(prompts[1].startsWith('Orbit tool protocol:'), 'without a registry the inline text is used unchanged')
})

test('in envelope mode a tool envelope being typed never streams to the chat, a plain answer does under the final message id', async t => {
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ onEvent }) => {
    // A session the stream names (Codex does in envelope mode too) is no session of the envelope transport.
    if (++turn === 1) { onEvent({ kind: 'session', sessionId: 'envelope-thread' }); onEvent({ kind: 'output', text: '{"content":"x","tool_calls":[', messageId: 'a', partial: true }); return response(tool('list_agents')) }
    onEvent({ kind: 'output', text: 'Final ', messageId: 'b', partial: true }); onEvent({ kind: 'output', text: 'answer', messageId: 'b', partial: false })
    return { text: 'Final answer' }
  } })
  const { snapshot, events } = await finished(runtime, payload(folder(t)))
  const streaming = events.filter(event => event.type === 'message.streaming')
  assert.ok(streaming.length >= 1)
  assert.ok(streaming.every(event => !event.content.startsWith('{')))
  assert.equal(streaming.at(-1).content, 'Final answer')
  assert.equal(events.find(event => event.type === 'message.added').message.id, streaming[0].messageId)
  const timings = snapshot.agents[0].turnTimings
  assert.equal(timings.length, 2)
  assert.deepEqual([timings[0].transport, timings[0].orbitToolCalls, timings[1].orbitToolCalls, timings[0].sessionId], ['envelope', 1, 0, null])
  assert.ok(!snapshot.traces.some(trace => trace.kind === 'session' || trace.text.includes('envelope-thread')), 'nor a trace')
  assert.ok(timings.every(timing => timing.startedAt && timing.endedAt && timing.firstEventAt && timing.promptChars > 0))
})

test('nullable schema arguments retain optional tool semantics', () => {
  const parsed = parseResponse(JSON.stringify({ content: '', tool_calls: [
    tool('spawn_agent', { name: 'Worker', task: 'Check', reason: 'Independent', providerId: null, model: null }),
    tool('broadcast_message', { message: 'Hello', agentIds: null, replyTo: null }),
    tool('wait_agent', { agentId: null, timeout_ms: null }),
  ] }))
  assert.deepEqual(parsed.calls[0].arguments, { name: 'Worker', task: 'Check', reason: 'Independent' })
  assert.deepEqual(parsed.calls[1].arguments, { message: 'Hello' })
  assert.deepEqual(parsed.calls[2].arguments, {})
})
