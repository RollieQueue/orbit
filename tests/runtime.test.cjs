const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { executeWorkspaceTool, workspacePath } = require('../electron/runtime-tools.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { CapabilityStore } = require('../electron/capabilities.mts')
const { OrbitRuntime, folder, tool, response, identity, finished, payload } = require('./helpers-runtime.cjs')

// The runs themselves: listings, streams, access and effort, memory, tools, delegation limits, cancellation and failures.
// The tool envelope, the team's mail and the counters are in runtime-agents.test.cjs.

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
      tool('spawn_agent', { name: 'Pool', providerId: 'other', model: 'worker', task: 'Pool task', reason: 'Independent task' }),
      tool('spawn_agent', { name: 'Asked', providerId: 'other', model: 'worker', reasoningEffort: 'high', task: 'Asked task', reason: 'Independent task' }),
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
  assert.equal(calls.find(call => call.name === 'Asked').effort, 'high', 'the level the caller names beats the pool entry')
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
