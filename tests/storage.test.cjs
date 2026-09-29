const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitMemoryStore } = require('../electron/memory.cjs')
const { CapabilityStore } = require('../electron/capabilities.cjs')
const { RunStore, StateStore } = require('../electron/run-store.cjs')
const { writeJSON } = require('../electron/storage.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-store-test-'))
  const a = path.join(root, 'project-a')
  const b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, a, b }
}

test('memory persists global preferences and isolates project records in retrieval and mutation', t => {
  const { root, a, b } = fixture(t)
  const memory = new OrbitMemoryStore(root)
  assert.deepEqual(memory.list(a), [])
  memory.upsert({ id: 'global', scope: 'global', title: 'Language', content: 'Отвечай по-русски', type: 'preference' })
  memory.upsert({ id: 'a', scope: 'project', workspace: a, title: 'Database', content: 'Project A uses sqlite' })
  memory.upsert({ id: 'b', scope: 'project', workspace: b, title: 'Database', content: 'Project B uses postgres' })
  assert.deepEqual(memory.list(a).map(entry => entry.id).sort(), ['a', 'global'])
  assert.ok(!memory.search('Database sqlite', b).some(entry => entry.id === 'a'))
  assert.throws(() => memory.upsert({ id: 'a', scope: 'project', workspace: b, title: 'Override', content: 'bad' }), /different scope/)
  assert.throws(() => memory.upsert({ scope: 'project', title: 'Missing', content: 'workspace' }), /requires a workspace/)
  assert.equal(memory.remove('a', b), false)
  assert.equal(new OrbitMemoryStore(root).search('sqlite', a)[0].id, 'a')
  assert.deepEqual(memory.list().map(entry => entry.id), ['global'])
})

test('unscoped legacy project memory never becomes global; fabricated demo entries disappear', t => {
  const { root, a } = fixture(t)
  writeJSON(path.join(root, 'memory.json'), [
    { id: 'legacy', title: 'Private project', content: 'do not share', scope: 'project' },
    { id: 'm4', title: 'Every write needs verification', content: 'fake policy', scope: 'global' },
    { id: 'user', title: 'User preference', content: 'keep me', scope: 'global' },
  ])
  assert.deepEqual(new OrbitMemoryStore(root).list(a).map(entry => entry.id), ['user'])
})

test('memory redacts common credentials and recovers valid backup after corruption', t => {
  const { root, a } = fixture(t)
  const memory = new OrbitMemoryStore(root)
  memory.upsert({ id: 'secret', scope: 'global', title: 'No secrets', content: 'api_key=sk-test-123456789012345 ghp_123456789012345678' })
  assert.ok(!memory.list(a)[0].content.includes('123456789'))
  memory.upsert({ id: 'second', scope: 'global', title: 'Another', content: 'entry' })
  fs.writeFileSync(memory.file, '{invalid')
  const recovered = new OrbitMemoryStore(root)
  assert.ok(recovered.list(a).some(entry => entry.id === 'secret'))
  recovered.upsert({ scope: 'global', title: 'Recovery', content: 'works' })
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(`${memory.file}.bak`, 'utf8')))
})

test('capabilities evolve persistently with bounded revisions, project scope, and restore', t => {
  const { root, a, b } = fixture(t)
  const library = new CapabilityStore(root)
  const entry = library.install({ id: 'checks', scope: 'project', workspace: a, name: 'Checks', instructions: 'Run npm test' })
  assert.equal(entry.version, 1)
  assert.equal(library.list(a)[0].instructions, undefined)
  assert.throws(() => library.read(entry.id, b), /not found/)
  assert.throws(() => library.install({ ...entry, workspace: b }), /another project/)
  library.install({ ...entry, instructions: 'Run npm run build and npm test' })
  const reloaded = new CapabilityStore(root)
  assert.equal(reloaded.read(entry.id, a).version, 2)
  const restored = reloaded.restore(entry.id, 1, a)
  assert.equal(restored.version, 3)
  assert.equal(restored.instructions, 'Run npm test')
  assert.equal(reloaded.remove(entry.id, b), false)
  assert.equal(reloaded.remove(entry.id, a), true)
})

test('durable runs preserve event attribution and mark unfinished processes interrupted on restart', t => {
  const { root } = fixture(t)
  const runs = new RunStore(root)
  runs.save({ runId: 'one', projectId: 'a', chatId: 'a-chat', status: 'working', agents: [{ id: 'root', status: 'working' }], traces: [{ text: 'running' }] })
  runs.save({ runId: 'two', projectId: 'b', chatId: 'b-chat', status: 'done', agents: [], messages: [{ text: 'finished' }] })
  runs.flush()
  const reloaded = new RunStore(root)
  assert.equal(reloaded.get('one').status, 'interrupted')
  assert.equal(reloaded.get('one').agents[0].status, 'cancelled')
  assert.equal(reloaded.get('one').chatId, 'a-chat')
  assert.equal(reloaded.get('two').messages[0].text, 'finished')
  assert.equal(reloaded.get('two').status, 'done')
  assert.throws(() => runs.save({ runId: '../escape' }), /identifier/)
})

test('UI state and chats survive reload without coupling to runtime snapshots', t => {
  const { root } = fixture(t)
  const state = { projects: [{ id: 'a', chats: [{ id: 'task', messages: [{ author: 'user', text: 'Build it' }] }] }], activeProjectId: 'a' }
  const store = new StateStore(root)
  assert.equal(store.load(), null)
  store.save(state)
  assert.deepEqual(new StateStore(root).load(), state)
})

test('failed memory and skill disk mutations do not commit invisible in-memory changes', t => {
  const { root, a } = fixture(t)
  const blocker = path.join(root, 'not-a-directory')
  fs.writeFileSync(blocker, 'blocked')
  const memory = new OrbitMemoryStore(root)
  const fact = memory.upsert({ title: 'Stable fact', content: 'original', scope: 'project', workspace: a })
  const originalMemoryFile = memory.file
  memory.file = path.join(blocker, 'memory.json')
  assert.throws(() => memory.upsert({ ...fact, content: 'failed update' }))
  assert.equal(memory.list(a)[0].content, 'original')
  assert.throws(() => memory.remove(fact.id, a))
  assert.equal(memory.list(a).length, 1)
  memory.file = originalMemoryFile
  const skills = new CapabilityStore(root)
  const skill = skills.install({ name: 'Stable skill', instructions: 'original', scope: 'project', workspace: a })
  skills.file = path.join(blocker, 'capabilities.json')
  assert.throws(() => skills.install({ ...skill, instructions: 'failed update' }))
  assert.equal(skills.read(skill.id, a).instructions, 'original')
  assert.equal(skills.read(skill.id, a).version, 1)
  assert.throws(() => skills.remove(skill.id, a))
  assert.equal(skills.list(a).length, 1)
})

test('a previous background flush error cannot discard a later terminal run snapshot', t => {
  const { root } = fixture(t)
  const runs = new RunStore(root)
  runs.save({ runId: 'recovering', status: 'working', agents: [] })
  runs.lastError = new Error('Earlier disk error')
  assert.throws(() => runs.save({ runId: 'recovering', status: 'completed', agents: [], summary: { text: 'done' } }), /Earlier disk error/)
  assert.equal(new RunStore(root).get('recovering').status, 'completed')
})

test('a temporary directory a process still holds is retried, never throws, and other paths are refused', async () => {
  const { removeTemporaryDirectory } = require('../electron/storage.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-probe-'))
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { cwd: directory, stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 250))
  // Windows keeps the folder locked (EBUSY) while the process runs; that must not surface as an error.
  assert.doesNotThrow(() => removeTemporaryDirectory(directory, 'orbit-probe-', 100))
  await new Promise(resolve => child.once('close', resolve))
  for (let attempt = 0; attempt < 40 && fs.existsSync(directory); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fs.existsSync(directory), false, 'removed once the process exited')
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-other-'))
  removeTemporaryDirectory(other, 'orbit-probe-')
  removeTemporaryDirectory(os.tmpdir(), 'orbit-probe-')
  assert.ok(fs.existsSync(other), 'a directory without the expected prefix is never removed')
  fs.rmSync(other, { recursive: true, force: true })
})
