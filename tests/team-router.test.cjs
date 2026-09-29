const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FileActivity } = require('../electron/file-activity.cjs')
const { TeamRouter, MAX_EXCHANGE } = require('../electron/router.cjs')
const { OrbitRuntime } = require('../electron/runtime.cjs')

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-router-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

// ---- who touched which file ---------------------------------------------------------------------------

test('file activity tells who read and who changed a file', t => {
  const workspace = folder(t)
  const activity = new FileActivity(workspace)
  assert.deepEqual(activity.record('a', 'src/one.ts', 'write'), { path: 'src/one.ts', action: 'write', isNew: true })
  assert.equal(activity.record('a', 'src/one.ts', 'write').isNew, false)
  activity.record('a', 'src/two.ts', 'read')
  activity.record('a', 'src/one.ts', 'read')
  activity.record('b', path.join(workspace, 'src', 'one.ts'), 'read')
  assert.deepEqual(activity.forAgent('a'), { read: ['src/two.ts'], wrote: ['src/one.ts'] }, 'a file an agent also changed is listed once, as changed')
  assert.deepEqual(activity.peers('src/one.ts', 'a'), [{ agentId: 'b', how: 'read' }])
  assert.deepEqual(activity.peers('src/one.ts', 'b'), [{ agentId: 'a', how: 'wrote' }])
  assert.deepEqual(activity.owners('src'), [{ agentId: 'a', how: 'wrote' }, { agentId: 'b', how: 'read' }], 'a folder matches the files under it')
  assert.deepEqual(activity.owners('src/two.ts'), [{ agentId: 'a', how: 'read' }])
  assert.equal(activity.shared().length, 1)
  assert.equal(activity.record('a', path.join(workspace, '..', 'elsewhere.txt'), 'write'), null, 'files outside the project are not tracked')
  assert.equal(activity.record('a', 'node_modules/pkg/index.js', 'write'), null)
})

test('native tool events count only when they succeeded', t => {
  const workspace = folder(t)
  const activity = new FileActivity(workspace)
  const codex = (status, extra = {}) => ({ kind: 'tool', native: true, tool: 'file_change', toolId: 'c1', status, ...extra })
  assert.deepEqual(activity.nativeEvent('a', codex('completed', { changes: [{ path: 'a.txt', kind: 'update' }, { path: 'b.txt', kind: 'add' }] })).map(item => item.path), ['a.txt', 'b.txt'])
  // An edit that is still running is remembered, and counts when its completion arrives.
  const claude = (status, extra = {}) => ({ kind: 'tool', native: true, toolId: 'u1', status, ...extra })
  assert.deepEqual(activity.nativeEvent('b', claude('started', { tool: 'Edit', input: { file_path: path.join(workspace, 'src', 'x.ts') } })), [])
  assert.deepEqual(activity.nativeEvent('b', claude('completed')).map(item => `${item.action}:${item.path}`), ['write:src/x.ts'])
  // A refused or failed edit never counts.
  activity.nativeEvent('c', { kind: 'tool', native: true, tool: 'Write', toolId: 'u2', status: 'started', input: { file_path: 'denied.txt' } })
  assert.deepEqual(activity.nativeEvent('c', { kind: 'tool', native: true, toolId: 'u2', status: 'failed' }), [])
  assert.deepEqual(activity.forAgent('c'), { read: [], wrote: [] })
  // Reads count at once.
  assert.deepEqual(activity.nativeEvent('c', claude('started', { toolId: 'u3', tool: 'Read', input: { file_path: 'docs/guide.md' } })).map(item => `${item.action}:${item.path}`), ['read:docs/guide.md'])
  assert.deepEqual(activity.nativeEvent('c', { kind: 'tool', native: true, tool: 'Bash', toolId: 'u4', status: 'started', input: { command: 'ls' } }), [], 'commands name no files')
  assert.deepEqual(activity.nativeEvent('c', codex('completed', { toolId: 'c9', changes: [{ path: path.join(workspace, '..', 'outside.txt') }] })), [])
})

// ---- the router ----------------------------------------------------------------------------------------

function team(t) {
  const workspace = folder(t)
  const agents = new Map()
  const run = { communications: [], agentNodes: agents, fileActivity: new FileActivity(workspace) }
  const announced = []
  const router = new TeamRouter(run, {
    record: (sender, target, text, extra) => { const item = { id: `c${run.communications.length}`, fromAgentId: sender.id, toAgentId: target.id, fromAgentName: sender.name, toAgentName: target.name, text, status: 'queued', ...extra }; run.communications.push(item); return item },
    announce: (item, persist) => announced.push([item.id, persist]),
  })
  const add = (id, extra = {}) => { const agent = { id, name: id, status: 'working', parentId: 'root', task: '', turns: 0, workDone: 0, ...extra }; agents.set(id, agent); return agent }
  const resolve = reference => { const found = agents.get(reference) || [...agents.values()].find(agent => agent.name === reference); if (!found) throw new Error('Agent not found in this run'); return found }
  return { run, router, add, resolve, announced }
}
const ids = result => result.recipients.map(item => item.agent.id)

test('the router finds teammates by the files they touched, then by topic', t => {
  const { run, router, add, resolve } = team(t)
  const root = add('root', { parentId: null, name: 'Orbit' })
  const backend = add('backend', { name: 'Backend API', task: 'Implement the endpoints' })
  const docs = add('docs', { name: 'Docs', task: 'Write the user guide' })
  const asker = add('asker', { name: 'Asker' })
  run.fileActivity.record('backend', 'src/api.ts', 'write')
  run.fileActivity.record('docs', 'src/api.ts', 'read')
  const byFile = router.audience(asker, { files: ['src/api.ts'] }, resolve)
  assert.deepEqual(ids(byFile), ['backend', 'docs'], 'the agent that changed it comes before the one that only read it')
  assert.match(byFile.recipients[0].reasons.join(), /changed src\/api\.ts/)
  assert.deepEqual(ids(router.audience(asker, { files: ['src/'] }, resolve)), ['backend', 'docs'], 'a folder matches everything under it')
  assert.deepEqual(ids(router.audience(asker, { topic: 'the backend contract' }, resolve)), ['backend'], 'a topic matches names and tasks')
  assert.deepEqual(ids(router.audience(asker, { topic: 'user guide' }, resolve)), ['docs'])
  assert.equal(router.audience(asker, { topic: 'guide' }, resolve).via, 'escalation', 'one weak word in a task is not a match, so the question goes up')
  assert.deepEqual(ids(router.audience(asker, { agentIds: ['Docs', 'backend'] }, resolve)), ['docs', 'backend'])
  backend.status = 'error'
  assert.deepEqual(ids(router.audience(asker, { files: ['src/api.ts'] }, resolve)), ['docs'], 'failed agents are skipped')
  backend.status = 'done'
  assert.deepEqual(ids(router.audience(asker, { files: ['src/api.ts'] }, resolve)), ['docs', 'backend'], 'a finished author can still be asked, after the active ones')
  assert.ok(root)
})

test('replies go back to the author and unmatched questions go up, never nowhere', t => {
  const { run, router, add, resolve } = team(t)
  const root = add('root', { parentId: null, name: 'Orbit' })
  const lead = add('lead', { name: 'Lead' })
  const worker = add('worker', { name: 'Worker', parentId: 'lead' })
  const peer = add('peer', { name: 'Peer', parentId: 'lead' })
  run.communications.push({ id: 'question', fromAgentId: 'peer', toAgentId: 'worker', kind: 'message', text: 'q' })
  assert.deepEqual(ids(router.audience(worker, { replyTo: 'question' }, resolve)), ['peer'])
  assert.deepEqual(ids(router.audience(peer, { replyTo: 'question' }, resolve)), ['worker'], 'the author of the question replying to their own message reaches the other party')
  assert.throws(() => router.audience(worker, { replyTo: 'missing' }, resolve), /existing conversation message/)
  const escalated = router.audience(worker, { topic: 'something nobody works on' }, resolve)
  assert.deepEqual([escalated.via, ...ids(escalated)], ['escalation', 'lead'])
  assert.throws(() => router.audience(root, { topic: 'something nobody works on' }, resolve), /found no teammate/)
  assert.deepEqual(ids(router.audience(lead, {}, resolve)), ['root'], 'with nothing to route by, a worker still reaches its parent')
  assert.throws(() => router.audience(root, {}, resolve), /found no teammate/, 'the root has no parent, so it must say whom it means')
})

test('a discussion that changes nothing is closed after six messages, and work reopens it', t => {
  const { router, add } = team(t)
  const first = add('first'), second = add('second')
  for (let index = 1; index <= MAX_EXCHANGE; index++) router.pass(index % 2 ? first : second, index % 2 ? second : first, `message ${index}`)
  assert.throws(() => router.pass(first, second, 'message 7'), new RegExp(`exchanged ${MAX_EXCHANGE} messages`))
  assert.throws(() => router.pass(second, first, 'message 8'), /neither of you changed a file/, 'the limit is for the pair, in both directions')
  assert.equal(router.stats.refused, 2)
  first.workDone++
  router.pass(first, second, 'message 9')
  const third = add('third')
  router.pass(first, third, 'a different pair is unaffected')
})

test('an identical message to the same agent is refused', t => {
  const { run, router, add } = team(t)
  const first = add('first'), second = add('second')
  router.pass(first, second, 'Please review the API')
  run.communications.push({ id: 'm1', kind: 'message', fromAgentId: 'first', toAgentId: 'second', text: 'Please review the API' })
  assert.throws(() => router.pass(first, second, '  please   review the api '), /exact message/)
  router.pass(first, second, 'Please review the API, now with the new fields')
})

test('a change is announced to the agents that use the file, once and without waking finished ones', t => {
  const { run, router, add, announced } = team(t)
  const writer = add('writer', { name: 'Writer' }), reader = add('reader', { name: 'Reader' }), other = add('other', { name: 'Other' }), finished = add('finished', { name: 'Finished', status: 'done' })
  for (const id of ['reader', 'other', 'finished']) run.fileActivity.record(id, 'src/a.ts', 'read')
  run.fileActivity.record('writer', 'src/a.ts', 'write')
  run.fileActivity.record('other', 'src/b.ts', 'read'); run.fileActivity.record('writer', 'src/b.ts', 'write')
  assert.deepEqual(router.notifyWrite(writer, 'src/a.ts').map(item => item.agent), ['Reader', 'Other', 'Finished'])
  const notices = run.communications.filter(item => item.kind === 'notice')
  assert.deepEqual(notices.map(item => item.toAgentName).sort(), ['Other', 'Reader'], 'the finished agent is told nothing')
  assert.match(notices[0].text, /«Writer» changed src\/a\.ts/)
  router.notifyWrite(writer, 'src/a.ts')
  assert.equal(run.communications.length, 2, 'the same change is not announced twice while the reader has not moved on')
  router.notifyWrite(writer, 'src/b.ts')
  assert.equal(run.communications.length, 2, 'a second file joins the unread notice')
  const merged = run.communications.find(item => item.toAgentId === 'other')
  assert.deepEqual(merged.paths, ['src/a.ts', 'src/b.ts'])
  assert.match(merged.text, /src\/a\.ts, src\/b\.ts/)
  assert.deepEqual(announced.at(-1), [merged.id, false], 'an update to an unread notice is published without rewriting the whole run')
  // Two agents changing the same file is a conflict, said plainly to both sides.
  run.fileActivity.record('reader', 'src/a.ts', 'write')
  reader.turns++
  router.notifyWrite(writer, 'src/a.ts')
  const conflict = run.communications.filter(item => item.toAgentId === 'reader').at(-1)
  assert.equal(conflict.conflict, true)
  assert.match(conflict.text, /EDIT CONFLICT/)
  assert.ok(finished)
})

// ---- inside a run --------------------------------------------------------------------------------------

const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+);/).slice(1)
// Each agent follows its own script, one step per model turn; anything after that is a plain final answer.
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
  const runId = await runtime.start({ providerId: 'test', prompt: 'Coordinate the change', projectId: 'p', chatId: 'c', accessMode: 'workspace-write', ...payload })
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await done; clearTimeout(timer); off()
  assert.notEqual(event.type, 'test.timeout', 'the run must end without deadlock')
  return { run: runtime.getRun(runId), runId, event }
}
const spawn = (name, task) => call('spawn_agent', { name, task, reason: 'Independent work' })
const observations = (run, tool) => run.traces.filter(item => item.kind === 'observation' && item.text.startsWith(`${tool}:`)).map(item => item.text)

test('agents that read or changed a file are recorded, and the others are told about the change', async t => {
  const workspace = folder(t)
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one')
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: scripted({
    Orbit: [() => envelope(spawn('Reader', 'Read a.txt'), spawn('Writer', 'Change a.txt'), call('wait_agent'))],
    Reader: [() => envelope(call('read_file', { path: 'a.txt' }), call('send_message', { agentId: 'Writer', message: 'go ahead' })), () => envelope(call('wait_message', { timeout_ms: 4000 }))],
    Writer: [() => envelope(call('wait_message', { timeout_ms: 4000 })), () => envelope(call('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' }), call('send_message', { agentId: 'Reader', message: 'edited it' }))],
  }, seen) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const byName = Object.fromEntries(run.agents.map(agent => [agent.name, agent]))
  assert.deepEqual(byName.Reader.files, { read: ['a.txt'], wrote: [] })
  assert.deepEqual(byName.Writer.files, { read: [], wrote: ['a.txt'] })
  assert.deepEqual(run.files, [{ path: 'a.txt', readers: [byName.Reader.id], writers: [byName.Writer.id] }])
  const notice = run.communications.find(item => item.kind === 'notice')
  assert.equal(notice.toAgentName, 'Reader')
  assert.equal(notice.fromAgentName, 'Маршрутизатор')
  assert.equal(notice.aboutName, 'Writer')
  assert.equal(run.router.notices, 1)
  const readerPrompts = seen.filter(item => item.name === 'Reader').map(item => item.prompt).join('\n')
  assert.match(readerPrompts, /«Writer» changed a\.txt/, 'the reader was told, in its mailbox or by reading it')
  const writerPrompts = seen.filter(item => item.name === 'Writer').map(item => item.prompt)
  assert.match(writerPrompts.at(-1), /FILE MAP/)
  assert.equal(run.communications.filter(item => item.kind === 'message').length, 2, 'a notice is not counted as a message')
})

test('ask_team reaches the agent that changed a file, and its reply comes back without anyone knowing ids', async t => {
  const workspace = folder(t)
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one')
  const seen = []
  let runtime
  const questionId = () => runtime.getRuns()[0].communications.find(item => item.kind === 'message' && item.fromAgentName === 'Asker').id
  runtime = new OrbitRuntime({ runProvider: scripted({
    Orbit: [() => envelope(spawn('Writer', 'Change a.txt'), spawn('Asker', 'Understand a.txt'), call('wait_agent'))],
    Writer: [
      () => envelope(call('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' }), call('send_message', { agentId: 'Asker', message: 'a.txt is written' })),
      () => envelope(call('wait_message', { timeout_ms: 4000 })),
      () => envelope(call('ask_team', { message: 'I renamed one to two', replyTo: questionId() })),
    ],
    Asker: [
      () => envelope(call('wait_message', { timeout_ms: 4000 })),
      () => envelope(call('ask_team', { message: 'What changed in a.txt?', files: ['a.txt'] })),
      () => envelope(call('wait_message', { timeout_ms: 4000 })),
    ],
  }, seen) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const dialogue = run.communications.filter(item => item.kind === 'message')
  const question = dialogue.find(item => item.fromAgentName === 'Asker')
  assert.equal(question.toAgentName, 'Writer')
  assert.equal(question.via, 'router')
  assert.deepEqual([question.route.via, question.route.reasons], ['match', ['changed a.txt']])
  const answer = dialogue.find(item => item.fromAgentName === 'Writer' && item.replyTo === question.id)
  assert.equal(answer.toAgentName, 'Asker')
  assert.equal(answer.route.via, 'reply')
  assert.equal(answer.discussionId, question.discussionId, 'the answer stays in the same discussion')
  assert.match(seen.filter(item => item.name === 'Asker').at(-1).prompt, /I renamed one to two/)
  assert.ok(run.router.routed >= 2)
  assert.ok(run.traces.some(item => item.agentId === 'router' && item.kind === 'route' && /Asker → Writer/.test(item.text)), 'the routing decision is traced under the router')
  assert.ok(observations(run, 'ask_team').some(text => /routedTo/.test(text)))
})

test('the router closes a discussion nobody acts on and ignores repeats', async t => {
  const workspace = folder(t)
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one')
  const talk = Array.from({ length: MAX_EXCHANGE + 1 }, (_, index) => call('send_message', { agentId: 'Listener', message: `point ${index + 1}` }))
  const runtime = new OrbitRuntime({ runProvider: scripted({
    Orbit: [() => envelope(spawn('Talker', 'Argue'), spawn('Listener', 'Listen'), call('wait_agent'))],
    Talker: [
      () => envelope(...talk, call('send_message', { agentId: 'Listener', message: 'point 1' })),
      () => envelope(call('edit_file', { path: 'a.txt', old_text: 'one', new_text: 'two' }), call('send_message', { agentId: 'Listener', message: 'point 8, after doing something' })),
    ],
    Listener: [() => envelope(call('wait_message', { timeout_ms: 4000 }))],
  }) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const sent = observations(run, 'send_message')
  assert.equal(sent.filter(text => /exchanged 6 messages/.test(text)).length, 1, 'point 7 is refused')
  assert.equal(sent.filter(text => /exact message/.test(text)).length, 1, 'the repeat of point 1 is refused')
  const delivered = run.communications.filter(item => item.kind === 'message').map(item => item.text)
  assert.deepEqual(delivered, ['point 1', 'point 2', 'point 3', 'point 4', 'point 5', 'point 6', 'point 8, after doing something'])
  assert.equal(run.router.refused, 2)
})

test('an unread notice never keeps an agent from finishing or ends a wait', () => {
  const runtime = new OrbitRuntime()
  const run = { communications: [
    { id: '1', toAgentId: 'a', kind: 'notice', text: 'a file changed' },
    { id: '2', toAgentId: 'a', kind: 'message', text: 'question' },
    { id: '3', toAgentId: 'a', kind: 'message', text: 'old', readAt: 'x' },
  ] }
  assert.deepEqual(runtime.pendingMail(run, { id: 'a' }).map(item => item.id), ['2'])
  assert.deepEqual(runtime.pendingMail({ communications: run.communications.slice(0, 1) }, { id: 'a' }), [])
})

test('files a command created are attributed to the agent that ran it, when nothing else could have', async t => {
  const workspace = folder(t)
  const script = "require('fs').writeFileSync('made.txt', 'x')"
  const runtime = new OrbitRuntime({ runProvider: scripted({ Orbit: [() => envelope(call('run_command', { command: process.execPath, args: ['-e', script] }))] }) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  assert.deepEqual(run.agents[0].files, { read: [], wrote: ['made.txt'] })
})

test('files a vendor\'s native tools changed are recorded from provider events', async t => {
  const workspace = folder(t)
  const runtime = new OrbitRuntime({ runProvider: async ({ onEvent }) => {
    onEvent({ kind: 'tool', native: true, tool: 'file_change', toolId: 'f1', status: 'completed', changes: [{ path: 'src/native.ts', kind: 'update' }], text: 'update src/native.ts' })
    onEvent({ kind: 'tool', native: true, tool: 'Read', toolId: 'r1', status: 'started', input: { file_path: path.join(workspace, 'README.md') }, text: 'Read' })
    onEvent({ kind: 'tool', native: true, tool: 'Edit', toolId: 'e1', status: 'failed', input: { file_path: 'blocked.ts' }, text: 'Edit' })
    return { text: 'done' }
  } })
  const { run } = await finish(runtime, { workspace })
  assert.deepEqual(run.agents[0].files, { read: ['README.md'], wrote: ['src/native.ts'] })
})

test('the index tools answer from the local index and mention who touched the file', async t => {
  const workspace = folder(t)
  fs.mkdirSync(path.join(workspace, 'src'))
  fs.writeFileSync(path.join(workspace, 'src', 'login.ts'), "import { hash } from './crypto'\nexport function verifyPassword() { return hash }\n")
  fs.writeFileSync(path.join(workspace, 'src', 'crypto.ts'), 'export const hash = 1\n')
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: scripted({ Orbit: [
    () => envelope(call('edit_file', { path: 'src/crypto.ts', old_text: 'hash = 1', new_text: 'hash = 2' })),
    () => envelope(call('index_search', { query: 'verify password' }), call('index_outline', { path: 'src/crypto.ts' }), call('index_outline', { path: 'missing.ts' })),
  ] }, seen) })
  const { run } = await finish(runtime, { workspace })
  assert.equal(run.status, 'completed')
  const first = seen[0].prompt
  assert.match(first, /PROJECT INDEX/)
  assert.match(first, /2 files/)
  const last = seen.at(-1).prompt
  assert.match(last, /src\/login\.ts/)
  assert.match(last, /importedBy/)
  assert.match(last, /touchedBy/, 'the file the agent edited says so')
  assert.match(last, /not in the index/, 'a missing file is an error the agent can act on, not an empty answer')
})

test('the index tools work in a read-only project and need no files to have been touched', async t => {
  const workspace = folder(t)
  fs.writeFileSync(path.join(workspace, 'notes.md'), '# Release checklist\n\nTag the build.\n')
  const seen = []
  const runtime = new OrbitRuntime({ runProvider: scripted({ Orbit: [() => envelope(call('index_search', { query: 'release checklist' }))] }, seen) })
  const { run } = await finish(runtime, { workspace, accessMode: 'read-only' })
  assert.equal(run.status, 'completed')
  assert.match(seen.at(-1).prompt, /notes\.md/)
  assert.doesNotMatch(seen.at(-1).prompt, /touchedBy/)
})

test('a finished run receives no late notices from a provider that is still unwinding', t => {
  const { run, router, add } = team(t)
  const writer = add('writer'), reader = add('reader')
  run.fileActivity.record('reader', 'src/a.ts', 'read')
  run.status = 'cancelled'
  assert.deepEqual(router.notifyWrite(writer, 'src/a.ts'), [{ agent: 'reader', how: 'read' }], 'who shares the file is still reported')
  assert.equal(run.communications.length, 0)
  assert.equal(router.stats.notices, 0)
  assert.ok(reader)
})

test('a command run while another chat works in the same folder is attributed to nobody', async t => {
  const workspace = folder(t)
  let release
  const held = new Promise(resolve => { release = resolve })
  const script = "require('fs').writeFileSync('shared-made.txt', 'x')"
  let secondTurn = false
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    // Chat B's prompt mentions "Task A" as neighbouring work, so only the task block identifies chat A itself.
    if (/YOUR CURRENT TASK:\nTask A/.test(prompt)) { await held; return { text: 'A finished' } }
    if (secondTurn) return { text: 'B finished' }
    secondTurn = true
    return envelope(call('run_command', { command: process.execPath, args: ['-e', script] }))
  } })
  const first = await runtime.start({ workspace, providerId: 'test', projectId: 'p', chatId: 'chat-a', prompt: 'Task A', accessMode: 'workspace-write' })
  await new Promise(resolve => setTimeout(resolve, 100))
  const { run } = await finish(runtime, { workspace, chatId: 'chat-b', prompt: 'Task B' })
  release()
  assert.equal(run.status, 'completed')
  assert.ok(fs.existsSync(path.join(workspace, 'shared-made.txt')))
  assert.deepEqual(run.agents[0].files, { read: [], wrote: [] }, 'the other chat could just as well have made the change')
  runtime.stop(first)
})
