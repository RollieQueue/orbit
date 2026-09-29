const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { ProjectContextStore } = require('../electron/project-context.mts')
const { saveNote } = require('../electron/shared-context.mts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-loop-guard-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace)
  return { root, workspace }
}
const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+);/).slice(1)
async function finish(runtime, payload) {
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start({ providerId: 'test', prompt: 'Change one thing', accessMode: 'workspace-write', ...payload })
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await done; clearTimeout(timer); off()
  assert.notEqual(event.type, 'test.timeout', 'the run must end by itself instead of looping')
  return { run: runtime.getRun(runId), runId }
}

test('the transcript window keeps a working set even with a small explicit context budget', async t => {
  const { workspace } = fixture(t)
  for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(workspace, `file-${i}.txt`), `MARKER_${i}\n${'filler line of source code\n'.repeat(100)}`)
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    return ++turn <= 8 ? envelope(call('read_file', { path: `file-${turn}.txt`, start_line: 1, limit: 100 })) : { text: 'done reading' }
  } })
  const { run } = await finish(runtime, { workspace, limits: { maxContextChars: 32000 } })
  assert.equal(run.status, 'completed')
  const last = prompts.at(-1)
  // Before the fix only the last two or three observations survived and the agent re-read forever.
  for (let i = 1; i <= 8; i++) assert.match(last, new RegExp(`MARKER_${i}\\b`), `file ${i} must still be visible`)
  assert.match(last, /WORK LOG/)
  for (let i = 1; i <= 8; i++) assert.match(last, new RegExp(`#${i} read_file file-${i}\\.txt → lines 1-100 of \\d+`))
})

for (const budget of [undefined, 32000]) test(`a model that only trusts what it can see finishes a six-file change (context budget ${budget ?? 'default'})`, async t => {
  // The reported failure: the task needs several large files at once. A model that decides only from the
  // visible prompt re-read them forever when the window held one or two observations.
  const { workspace } = fixture(t)
  // A larger budget can hold six full files at once; the explicit small one holds the floor (40 000 characters).
  const lines = budget ? 30 : 100
  const body = `const value = "${'x'.repeat(100)}"\n`.repeat(lines)
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(workspace, `module-${i}.js`), `// MARKER_${i}\n${body}`)
  const target = path.join(workspace, 'module-3.js')
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    const transcript = prompt.slice(prompt.indexOf('AGENT TRANSCRIPT ('))
    const missing = [1, 2, 3, 4, 5, 6].find(i => !transcript.includes(`MARKER_${i}`))
    if (missing) return envelope(call('read_file', { path: `module-${missing}.js`, start_line: 1, limit: lines }))
    if (!transcript.includes('"name":"edit_file"')) return envelope(call('edit_file', { path: 'module-3.js', old_text: '// MARKER_3', new_text: '// MARKER_3 (edited)' }))
    return { text: 'Read all six modules and edited module-3.' }
  } })
  const { run } = await finish(runtime, { workspace, ...(budget ? { limits: { maxContextChars: budget } } : {}) })
  assert.equal(run.status, 'completed')
  assert.equal(run.summary.text, 'Read all six modules and edited module-3.')
  assert.ok(fs.readFileSync(target, 'utf8').includes('// MARKER_3 (edited)'), 'the edit was applied')
  assert.ok(run.usage.providerTurns <= 9, `expected about 8 turns, used ${run.usage.providerTurns}`)
})

test('the work log outlives observations that scrolled out of the window', async t => {
  const { workspace } = fixture(t)
  for (let i = 1; i <= 30; i++) fs.writeFileSync(path.join(workspace, `big-${i}.txt`), `${`UNIQUE_BODY_OF_FILE_${i} `.padEnd(100, '.')}\n`.repeat(100))
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    return ++turn <= 30 ? envelope(call('read_file', { path: `big-${turn}.txt`, start_line: 1, limit: 100 })) : { text: 'done' }
  } })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const last = prompts.at(-1)
  assert.match(last, /older entries omitted/)
  assert.doesNotMatch(last, /UNIQUE_BODY_OF_FILE_1 /, 'the oldest observation has scrolled out')
  assert.match(last, /UNIQUE_BODY_OF_FILE_30 /, 'the newest observation is still there')
  assert.match(last, /#1 read_file big-1\.txt → lines 1-100/, 'the log still records that file 1 was read')
  assert.match(last, /#30 read_file big-30\.txt/)
})

test('identical repeated checks are warned about and then stopped instead of looping forever', async t => {
  const { workspace } = fixture(t)
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => { prompts.push(prompt); return envelope(call('context_read')) } })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.usage.providerTurns, 5, 'one new call, then four identical repeats')
  assert.doesNotMatch(prompts[2], /LOOP GUARD/)
  assert.match(prompts[3], /LOOP GUARD/, 'warned after the second identical turn')
  assert.match(prompts[3], /Identical repeat of the call from turn 1/)
  assert.match(run.summary.text, /Остановлено автоматически/)
  assert.deepEqual(run.summary.limitedAgents, ['root'])
  assert.equal(run.agents[0].detail, 'Stopped: repeated identical calls')
})

test('list_agents polling with unchanged results is recognised even though agent counters move', async t => {
  const { workspace } = fixture(t)
  const runtime = new OrbitRuntime({ runProvider: async () => envelope(call('list_agents')) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.usage.providerTurns, 5)
  assert.match(run.summary.text, /Остановлено автоматически/)
})

test('a correction that fails the same way every time is stopped', async t => {
  const { workspace } = fixture(t)
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'hello')
  const runtime = new OrbitRuntime({ runProvider: async () => envelope(call('edit_file', { path: 'a.txt', old_text: 'not present', new_text: 'x' })) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.usage.providerTurns, 5)
  assert.match(run.summary.text, /edit_file a\.txt → ERROR old_text was not found/)
})

test('re-running a command whose output only differs by timings is a repeat, not new information', async t => {
  const { workspace } = fixture(t)
  const script = "console.log('# tests 5\\n# pass 4\\n# fail 1\\n# duration_ms ' + (Math.random() * 1000) + '\\nfinished in ' + Math.floor(Math.random() * 9000) + 'ms at ' + new Date().toISOString())"
  const runtime = new OrbitRuntime({ runProvider: async () => envelope(call('run_command', { command: process.execPath, args: ['-e', script] })) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.usage.providerTurns, 5, 'one real run, then four identical-in-substance re-runs')
  assert.match(run.summary.text, /Остановлено автоматически/)
})

test('waits that really blocked are not repeats, but instant identical waits are', async t => {
  const { workspace } = fixture(t)
  // Instant identical waits are a busy loop and get stopped like any other repeat.
  const instant = new OrbitRuntime({ runProvider: async () => envelope(call('wait_message', { timeout_ms: 10 })) })
  const stopped = await finish(instant, { workspace })
  assert.match(stopped.run.summary.text, /Остановлено автоматически/)
  // The same calls that each took real time (a fake clock advances 1.5 s per reading) are legitimate polling.
  let turn = 0, tick = 0
  const patient = new OrbitRuntime({ clock: () => (tick += 1500), runProvider: async () => ++turn <= 8 ? envelope(call('wait_message', { timeout_ms: 10 })) : { text: 'finished polling' } })
  const { run } = await finish(patient, { workspace })
  assert.equal(run.summary.text, 'finished polling')
  assert.equal(run.usage.providerTurns, 9)
})

test('varied progress is never treated as a loop and resets the counter', async t => {
  const { workspace } = fixture(t)
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one')
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async () => {
    turn++
    // Two identical repeats, then a real edit, then two more repeats: never four in a row.
    if (turn <= 3) return envelope(call('read_file', { path: 'a.txt' }))
    if (turn === 4) return envelope(call('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' }))
    if (turn <= 7) return envelope(call('read_file', { path: 'a.txt' }))
    return { text: 'edited and verified' }
  } })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.summary.text, 'edited and verified')
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'two')
})

test('a long streak of read-only turns gets a nudge but is not stopped while it finds new information', async t => {
  const { workspace } = fixture(t)
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    return ++turn <= 10 ? envelope(call('list_files', { path: `missing-${turn}` })) : { text: 'audit finished' }
  } })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.summary.text, 'audit finished')
  assert.match(prompts[8], /only read or checked things/)
  assert.doesNotMatch(prompts[7], /only read or checked things/)
})

test('ignored harness reminders are bounded: the answer is accepted after three', async t => {
  const { workspace } = fixture(t)
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'I am done.' }) })
  const { run } = await finish(runtime, { workspace, improvementMode: true })
  assert.equal(run.status, 'completed')
  assert.equal(run.usage.providerTurns, 4, 'the answer plus three reminded retries')
  assert.match(run.summary.text, /I am done\./)
  assert.match(run.summary.text, /Режим улучшения/)
})

test('the root final answer is not cut at the size of a tool observation', async t => {
  const { workspace } = fixture(t)
  const answer = `START ${'A long, useful sentence. '.repeat(1600)} END`
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: answer }) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.equal(run.summary.text, answer)
  assert.equal(run.messages.at(-1).text, answer)
})

test('a stopped parent cancels the helpers it left running', async t => {
  const { workspace } = fixture(t)
  let rootTurn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt, signal }) => {
    if (identity(prompt)[0] === 'Orbit') {
      return ++rootTurn === 1 ? envelope(call('spawn_agent', { name: 'Slow', task: 'Takes forever', reason: 'Independent' })) : envelope(call('context_read'))
    }
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Run cancelled')), { once: true }) })
  } })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const slow = run.agents.find(agent => agent.name === 'Slow')
  assert.equal(slow.status, 'cancelled', 'the helper must not keep running after its parent was stopped')
})

test('context_read is a bounded index; one note can be read in full by key', async t => {
  const { root, workspace } = fixture(t), store = new ProjectContextStore(root)
  for (let i = 0; i < 40; i++) saveNote(store, workspace, {}, { key: `agent:chat:worker-${i}`, summary: 'S'.repeat(2000) })
  saveNote(store, workspace, {}, { key: 'architecture', summary: `FULL_ARCHITECTURE_NOTE ${'x'.repeat(3000)}` })
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'ok' }) })
  runtime.setContextStore(store)
  const { run, runId } = await finish(runtime, { workspace, chatId: 'chat' })
  const root0 = runtime.runs.get(runId).agentNodes.get('root'), live = runtime.runs.get(runId)
  const index = await runtime.executeTool(live, root0, 'context_read', {})
  assert.ok(JSON.stringify(index).length < 8000, 'the index must be small enough to stay in the window')
  assert.equal(index.notes.length, 10)
  assert.ok(index.notes.some(note => note.key === 'architecture'), 'the newest notes are listed')
  assert.ok(index.otherNotes.length > 0)
  const full = await runtime.executeTool(live, root0, 'context_read', { key: 'architecture' })
  assert.ok(full.summary.length > 3000 && full.summary.startsWith('FULL_ARCHITECTURE_NOTE'))
  await assert.rejects(runtime.executeTool(live, root0, 'context_read', { key: 'nope' }), /No shared note/)
  assert.equal(run.status, 'completed')
})

test('results auto-saved for other chats are listed by key, not injected into this chat prompt', async t => {
  const { root, workspace } = fixture(t), store = new ProjectContextStore(root)
  saveNote(store, workspace, {}, { key: 'agent:other-chat:Scout', summary: 'UNRELATED_EARLIER_ASSIGNMENT result' })
  saveNote(store, workspace, {}, { key: 'agent:this-chat:Helper', summary: 'CURRENT_CHAT_RESULT' })
  saveNote(store, workspace, {}, { key: 'architecture', summary: 'DELIBERATE_PROJECT_NOTE' })
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'ok' } } })
  runtime.setContextStore(store)
  await finish(runtime, { workspace, chatId: 'this-chat' })
  assert.match(prompts[0], /DELIBERATE_PROJECT_NOTE/)
  assert.match(prompts[0], /CURRENT_CHAT_RESULT/)
  assert.doesNotMatch(prompts[0], /UNRELATED_EARLIER_ASSIGNMENT/)
  assert.match(prompts[0], /agent:other-chat:Scout/, 'its key is still listed so it can be read on demand')
})

test('automatic agent notes are capped while deliberate notes are kept', t => {
  const { root, workspace } = fixture(t), store = new ProjectContextStore(root)
  saveNote(store, workspace, {}, { key: 'deliberate', summary: 'kept' })
  for (let i = 0; i < 45; i++) saveNote(store, workspace, {}, { key: `agent:chat:worker-${i}`, summary: `result ${i}` })
  const notes = store.getLatest(workspace).notes
  assert.equal(notes.filter(note => note.key.startsWith('agent:')).length, 30)
  assert.ok(notes.some(note => note.key === 'deliberate'))
  assert.ok(notes.some(note => note.key === 'agent:chat:worker-44'), 'the newest are kept')
  assert.ok(!notes.some(note => note.key === 'agent:chat:worker-0'), 'the oldest expire')
})

test('list_agents shows every participant within one observation', async t => {
  const { workspace } = fixture(t)
  let rootTurn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    if (identity(prompt)[0] !== 'Orbit') return { text: `RESULT ${'r'.repeat(3000)}` }
    if (++rootTurn === 1) return envelope(...Array.from({ length: 12 }, (_, i) => call('spawn_agent', { name: `Worker ${i}`, task: `Task ${i}`, reason: 'Independent' })), call('wait_agent'))
    return { text: 'integrated' }
  } })
  const { runId } = await finish(runtime, { workspace })
  const live = runtime.runs.get(runId)
  const directory = await runtime.executeTool(live, live.agentNodes.get('root'), 'list_agents', {})
  assert.equal(directory.length, 13)
  assert.ok(JSON.stringify(directory).length <= live.limits.maxOutputChars, 'one observation must show all participants')
  assert.ok(directory.filter(agent => agent.resultTruncated).length >= 12)
  assert.ok(directory.every(agent => !('promptChars' in agent) && !('turns' in agent)))
})

test('a stale unknown effort saved for a Google model does not block starting a run', async t => {
  const { workspace } = fixture(t)
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'ok' }) })
  const { run } = await finish(runtime, { workspace, providerId: 'antigravity', reasoningEffort: 'extra-high', providerOptions: { antigravity: { reasoningEffort: 'extra-high' } }, providerPool: [{ providerId: 'antigravity', model: 'g', reasoningEffort: 'extra-high' }] })
  assert.equal(run.status, 'completed')
  await assert.rejects(runtime.start({ workspace, providerId: 'test', prompt: 'x', reasoningEffort: 'extra-high' }), /Unknown reasoning effort/, 'other providers still validate')
})

test('stopping a swarm writes the run file once, not once per agent', async t => {
  const { workspace } = fixture(t)
  const saves = []
  const runStore = { save: snapshot => saves.push({ status: snapshot.status, agents: snapshot.agents.filter(agent => agent.status === 'cancelled').length }) }
  let rootTurn = 0
  const runtime = new OrbitRuntime({ runStore, runProvider: async ({ prompt, signal }) => {
    if (identity(prompt)[0] === 'Orbit') return ++rootTurn === 1 ? envelope(...Array.from({ length: 8 }, (_, i) => call('spawn_agent', { name: `Worker ${i}`, task: `Task ${i}`, reason: 'Independent' })), call('wait_agent')) : { text: 'unreachable' }
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Run cancelled')), { once: true }))
  } })
  let ready
  const allRunning = new Promise(resolve => { ready = resolve })
  runtime.onEvent(event => { if (event.type === 'agent.updated' && event.agent.detail === 'Provider is executing' && runtime.getRuns()[0].agents.filter(agent => agent.detail === 'Provider is executing').length >= 8) ready() })
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Swarm', accessMode: 'workspace-write' })
  await allRunning
  const before = saves.length
  runtime.stop(runId)
  await new Promise(resolve => setImmediate(resolve))
  const written = saves.slice(before).filter(save => save.status === 'cancelled')
  assert.ok(written.length <= 2, `expected one write for the whole cancellation, saw ${written.length}`)
  assert.equal(written.at(-1).agents, 9, 'the single snapshot already contains every cancelled agent')
})

test('Google workers never receive a reasoning effort from settings, the pool or a spawn request', async t => {
  const { workspace } = fixture(t)
  const seen = []
  let rootTurn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt, providerId, reasoningEffort }) => {
    seen.push({ providerId, reasoningEffort })
    if (identity(prompt)[0] !== 'Orbit') return { text: 'worker done' }
    if (++rootTurn === 1) return envelope(call('spawn_agent', { name: 'Gem', task: 'Check', reason: 'Independent', providerId: 'antigravity', model: 'gemini-fixture', reasoningEffort: 'high' }), call('wait_agent'))
    return { text: 'done' }
  } })
  const { run } = await finish(runtime, {
    workspace, reasoningEffort: 'xhigh', providerOptions: { antigravity: { reasoningEffort: 'max' } },
    providerPool: [{ providerId: 'antigravity', model: 'gemini-fixture', reasoningEffort: 'low' }],
  })
  assert.equal(run.status, 'completed')
  assert.deepEqual(seen.filter(item => item.providerId === 'antigravity'), [{ providerId: 'antigravity', reasoningEffort: '' }])
  assert.equal(seen.find(item => item.providerId === 'test').reasoningEffort, 'xhigh', 'other providers keep their effort')
})
