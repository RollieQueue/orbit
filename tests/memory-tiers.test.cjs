const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitMemoryStore, renderRecall, TIERS } = require('../electron/memory.cjs')
const { writeJSON } = require('../electron/storage.cjs')

const DAY = 86400000
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tiers-'))
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const time = { now: Date.parse('2026-03-01T10:00:00Z') }
  return { root, a, b, time, open: () => new OrbitMemoryStore(root, { clock: () => time.now }) }
}
// A word no other word shares a five-letter stem with, so filler entries never look like duplicates of each other.
const word = i => `${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}qzx${String.fromCharCode(97 + Math.floor(i / 676))}`
const agent = { origin: 'agent' }
const chatNote = (a, chatId, i, extra = {}) => ({ scope: 'chat', workspace: a, chatId, title: `note ${word(i)}`, content: `${word(i)} ${word(i + 300)} remark`, ...extra })

test('three tiers: chat notes belong to one chat, project notes to one project, global to everyone', t => {
  const { a, b, open } = fixture(t), memory = open()
  memory.upsert({ id: 'chat', scope: 'chat', workspace: a, chatId: 'c1', title: 'Plan', content: 'refactor the parser first' })
  memory.upsert({ id: 'project', scope: 'project', workspace: a, title: 'Runner', content: 'tests run with node --test' })
  memory.upsert({ id: 'global', scope: 'global', title: 'Style', content: 'answer briefly' })
  const ids = (...args) => memory.list(...args).map(entry => entry.id).sort()
  assert.deepEqual(ids(a, true, 'c1'), ['chat', 'global', 'project'])
  assert.deepEqual(ids(a, true, 'c2'), ['global', 'project'], 'another chat of the same project does not see the notes of c1')
  assert.deepEqual(ids(a, true), ['global', 'project'], 'without a chat there are no chat notes')
  assert.deepEqual(ids(b, true, 'c1'), ['global'], 'another project sees neither, even with the same chat id')
  assert.deepEqual(ids(a, false, 'c1'), ['chat', 'project'])
  assert.ok(memory.search('parser', a, 6, true, 'c1').some(entry => entry.id === 'chat'))
  assert.ok(!memory.search('parser', a, 6, true, 'c2').length)
  assert.ok(!memory.search('parser', b, 6, true, 'c1').length)
  assert.throws(() => memory.upsert({ scope: 'chat', workspace: a, title: 'x', content: 'y' }), /requires a workspace and a chat/)
  assert.throws(() => memory.upsert({ id: 'chat', scope: 'chat', workspace: a, chatId: 'c2', title: 'Plan', content: 'stolen' }), /different scope/)
  assert.equal(memory.remove('chat', a, 'c2'), false)
  assert.equal(memory.forgetChat(a, 'c2'), 0)
  assert.equal(memory.forgetChat(a, 'c1'), 1)
  assert.deepEqual(ids(a, true, 'c1'), ['global', 'project'])
  assert.deepEqual(ids(a, true), ['global', 'project'])
})

test('an agent note that restates an existing one updates it; the user\'s own notes are never overwritten or removed by an agent', t => {
  const { a, open } = fixture(t), memory = open()
  const first = memory.save({ scope: 'project', workspace: a, title: 'Build command', content: 'Run npm run build before tests' }, agent)
  const again = memory.save({ scope: 'project', workspace: a, title: 'Build command', content: 'Run npm run build before running the tests' }, agent)
  assert.equal(again.merged, true); assert.equal(again.entry.id, first.entry.id)
  assert.match(again.entry.content, /running the tests/)
  memory.save({ scope: 'project', workspace: a, title: 'Test command', content: 'Run npm test' }, agent)
  assert.equal(memory.list(a).length, 2, 'a different fact is a new entry')
  const mine = memory.upsert({ scope: 'project', workspace: a, title: 'Deploy', content: 'Never deploy on Friday' })
  assert.throws(() => memory.save({ id: mine.id, scope: 'project', workspace: a, title: 'Deploy', content: 'Deploy on Friday' }, agent), /written or pinned by the user/)
  const redundant = memory.save({ scope: 'project', workspace: a, title: 'Deploy', content: 'Never deploy on Fridays please' }, agent)
  assert.equal(redundant.unchanged, true); assert.equal(redundant.entry.id, mine.id)
  assert.equal(memory.list(a).find(entry => entry.id === mine.id).content, 'Never deploy on Friday')
  assert.throws(() => memory.remove(mine.id, a, undefined, { origin: 'agent' }), /only the user/)
  assert.equal(memory.remove(mine.id, a), true, 'the user can')
  assert.ok(memory.save({ scope: 'project', workspace: a, title: 'x', content: 'y'.repeat(9000) }, agent).entry.content.length <= TIERS.project.chars)
})

test('a full tier drops what is least worth keeping: unused and old first, used, pinned and the user\'s never', t => {
  const { a, time, open } = fixture(t), memory = open()
  const saved = Array.from({ length: TIERS.chat.entries }, (_, i) => memory.save(chatNote(a, 'c1', i), agent).entry)
  assert.equal(memory.list(a, false, 'c1').length, TIERS.chat.entries)
  time.now += 3 * DAY
  memory.touch(saved.slice(1).map(entry => entry.id))
  memory.pin(saved[1].id, true, a, 'c1')
  time.now += 20 * DAY
  const result = memory.save(chatNote(a, 'c1', 99), agent)
  assert.equal(result.evicted, 1)
  const left = memory.list(a, false, 'c1').map(entry => entry.id)
  assert.equal(left.length, TIERS.chat.entries)
  assert.ok(!left.includes(saved[0].id), 'the note nothing ever used went')
  assert.ok(left.includes(saved[1].id) && left.includes(result.entry.id))
  // Protected entries may exceed the cap rather than be lost.
  for (let i = 0; i < 3; i++) memory.upsert(chatNote(a, 'c1', 200 + i))
  assert.ok(memory.list(a, false, 'c1').length >= TIERS.chat.entries)
  assert.ok(memory.list(a, false, 'c1').filter(entry => entry.source === 'user').length === 3)
})

test('maintenance expires stale chat notes, promotes what a chat kept using, merges duplicates', t => {
  const { a, time, open } = fixture(t), memory = open()
  const keeper = memory.save({ scope: 'chat', workspace: a, chatId: 'c1', type: 'decision', title: 'Storage engine', content: 'The queue is persisted with sqlite, decided after the benchmark' }, agent).entry
  const idle = memory.save({ scope: 'chat', workspace: a, chatId: 'c1', title: 'Random remark', content: 'the sidebar flickers once on start' }, agent).entry
  memory.touch([keeper.id]); memory.touch([keeper.id])
  const report = memory.maintain({ workspace: a, chatId: 'c1' })
  assert.equal(report.promoted, 1)
  const promoted = memory.list(a, false, 'c2').find(entry => entry.id === keeper.id)
  assert.ok(promoted, 'now a project entry every chat of the project sees')
  assert.equal(promoted.scope, 'project'); assert.equal(promoted.chatId, undefined)
  assert.equal(memory.list(a, false, 'c1').find(entry => entry.id === idle.id).scope, 'chat', 'an unused note stays in its chat')
  time.now += 31 * DAY
  assert.equal(memory.maintain({ workspace: a, chatId: 'c1' }).expired, 1)
  assert.ok(!memory.list(a, false, 'c1').some(entry => entry.id === idle.id))
  assert.ok(memory.list(a, false, 'c1').some(entry => entry.id === keeper.id), 'promoted knowledge does not expire with the chat')
  // Two agents wrote the same thing at different times: maintenance keeps one.
  const one = memory.save({ scope: 'project', workspace: a, title: 'Lint rule', content: 'Lint runs through eslint before commit hooks fire and blocks the push' }, agent).entry
  memory.commit([{ ...memory.entries.find(entry => entry.id === one.id), id: 'twin', content: 'Lint runs through eslint before commit hooks fire and blocks the pushes', updated: new Date(time.now + 1000).toISOString() }, ...memory.entries], [], [])
  assert.equal(memory.list(a, false).filter(entry => /Lint rule/.test(entry.title)).length, 2)
  assert.equal(memory.maintain({ workspace: a }).merged, 1)
  assert.equal(memory.list(a, false).filter(entry => /Lint rule/.test(entry.title)).length, 1)
})

test('what several projects independently know moves to the shared tier, but a project detail never does', t => {
  const { root, a, b, open } = fixture(t), memory = open()
  const title = 'Windows keeps the working directory of a child process locked'
  const fact = 'A child process on Windows keeps its working directory locked, so removing the folder fails; run helpers with a neutral cwd'
  memory.save({ scope: 'project', workspace: a, type: 'pattern', title, content: fact }, agent)
  assert.equal(memory.maintain({ workspace: a, crossProject: true }).shared, 0, 'one project is not evidence')
  memory.save({ scope: 'project', workspace: b, type: 'pattern', title, content: fact }, agent)
  const report = memory.maintain({ workspace: a, crossProject: true })
  assert.equal(report.shared, 1)
  const shared = memory.list('', true).filter(entry => entry.scope === 'global')
  assert.equal(shared.length, 1); assert.equal(shared[0].source, 'promoted')
  assert.ok(!JSON.stringify(shared).includes('project-a') && !JSON.stringify(shared).includes('project-b'), 'no workspace path travels with it')
  const seen = scope => memory.recall({ query: 'cwd locked', workspace: a, includeGlobal: scope }).tiers
  assert.equal(seen(true).global.length, 1); assert.equal(seen(true).project.length, 0, 'shown once, from the shared tier')
  assert.equal(seen(false).global.length, 0); assert.equal(seen(false).project.length, 1, 'a project with shared memory off keeps its own copy')
  assert.equal(memory.maintain({ workspace: a, crossProject: true }).shared, 0, 'idempotent')
  assert.equal(new OrbitMemoryStore(root).list('', true).filter(entry => entry.scope === 'global').length, 1)
  // The same wording, but it names a file that exists only in project a: that stays in the projects.
  fs.mkdirSync(path.join(a, 'src')); fs.writeFileSync(path.join(a, 'src', 'queue.js'), 'x')
  const specific = 'The retry backoff lives in src/queue.js and doubles after every failed attempt up to a minute'
  memory.save({ scope: 'project', workspace: a, type: 'fact', title: 'Retry backoff behaviour', content: specific }, agent)
  memory.save({ scope: 'project', workspace: b, type: 'fact', title: 'Retry backoff behaviour', content: specific }, agent)
  assert.equal(memory.maintain({ workspace: a, crossProject: true }).shared, 0)
  assert.equal(memory.list('', true).filter(entry => entry.scope === 'global').length, 1)
})

test('recall puts pinned and matching notes first, fills with the most valuable, and the rendered block fits its budget', t => {
  const { a, open } = fixture(t), memory = open()
  for (let i = 0; i < 30; i++) memory.save({ scope: 'project', workspace: a, title: `Topic ${word(i)}`, content: `${word(i)} ${'detail '.repeat(40)}` }, agent)
  memory.save({ scope: 'project', workspace: a, title: 'Deployment pipeline', content: 'The pipeline publishes artifacts after the signing step' }, agent)
  memory.save({ scope: 'chat', workspace: a, chatId: 'c1', title: 'Constraint', content: 'do not touch the billing module in this task' }, agent)
  memory.save({ scope: 'global', title: 'Answer language', type: 'preference', content: 'Answer in Russian' }, agent)
  const recall = memory.recall({ query: 'fix the signing step of the pipeline', workspace: a, chatId: 'c1' })
  assert.equal(recall.tiers.project[0].entry.title, 'Deployment pipeline'); assert.equal(recall.tiers.project[0].relevant, true)
  assert.equal(recall.tiers.project[1].relevant, false)
  assert.equal(recall.tiers.chat.length, 1)
  const block = renderRecall(recall, 1800)
  assert.ok(block.length <= 1800, `${block.length}`)
  assert.match(block, /THIS CHAT[^\n]*\n- [^\n]*Constraint/)
  assert.match(block, /THIS PROJECT[^\n]*\n- [^\n]*Deployment pipeline/)
  assert.match(block, /ALL PROJECTS[^\n]*\n- [^\n]*Answer language/)
  assert.match(block, /ALSO STORED[^\n]*memory_search/)
  assert.equal(renderRecall({ tiers: { chat: [], project: [], global: [] } }), '')
  const small = renderRecall(memory.recall({ query: 'x', workspace: a }), 300)
  assert.ok(small.length > 0, 'a tiny budget still says something')
})

test('model assessments are shown to the orchestrator, and to others only when they match', t => {
  const { a, open } = fixture(t), memory = open()
  memory.save({ id: 'model-abc123def456', scope: 'global', title: 'Model: codex/gpt — review', content: '{"assessment":"good at review"}' }, { origin: 'system' })
  assert.equal(memory.list(a).find(entry => entry.id === 'model-abc123def456').source, 'system')
  assert.throws(() => memory.save({ id: 'model-abc123def456', scope: 'global', title: 'x', content: 'y' }, agent), /written or pinned/)
  assert.equal(memory.recall({ query: 'unrelated topic', workspace: a }).tiers.global.length, 0)
  assert.equal(memory.recall({ query: 'unrelated topic', workspace: a, models: true }).tiers.global[0].pinned, true)
  assert.equal(memory.recall({ query: 'review codex', workspace: a }).tiers.global.length, 1)
})

test('usage counters are batched to disk, and short ids resolve when they are unambiguous', t => {
  const { root, a, open } = fixture(t), memory = open()
  const one = memory.upsert({ scope: 'project', workspace: a, title: 'Alpha thing', content: 'first' })
  memory.upsert({ id: `${one.id.slice(0, 8)}-collide-0000`, scope: 'project', workspace: a, title: 'Beta thing', content: 'second' })
  memory.touch([one.id, one.id])
  assert.equal(new OrbitMemoryStore(root).list(a)[0].uses, 0, 'not written yet')
  memory.flush()
  assert.equal(new OrbitMemoryStore(root).list(a).find(entry => entry.id === one.id).uses, 1, 'one entry, counted once per call')
  assert.equal(memory.find(one.id.slice(0, 12), a).id, one.id)
  assert.equal(memory.find(one.id.slice(0, 8), a), null, 'ambiguous prefix')
  assert.equal(memory.find('abc', a), null, 'too short')
  assert.equal(memory.remove(one.id.slice(0, 12), a), true)
})

test('old memory files load with sane defaults, keep quarantined records on disk and survive stats', t => {
  const { root, a, open } = fixture(t)
  writeJSON(path.join(root, 'memory.json'), [
    { id: 'old', title: 'Old fact', content: 'from an earlier version', scope: 'project', workspace: a, type: 'fact', updated: '2025-01-01T00:00:00.000Z', confidence: 90 },
    { id: 'model-0123456789ab', title: 'Model: x/y', content: 'assessment', scope: 'global', updated: '2025-01-01T00:00:00.000Z' },
    { id: 'orphan', title: 'Unscoped', content: 'never visible', scope: 'project' },
  ])
  const memory = open()
  const [old] = memory.list(a).filter(entry => entry.id === 'old')
  assert.equal(old.uses, 0); assert.equal(old.source, 'legacy'); assert.equal(old.created, old.updated)
  assert.equal(memory.list(a).find(entry => entry.id.startsWith('model-')).source, 'system')
  assert.ok(!memory.list(a).some(entry => entry.id === 'orphan'))
  memory.upsert({ scope: 'global', title: 'New', content: 'entry' })
  assert.ok(fs.readFileSync(path.join(root, 'memory.json'), 'utf8').includes('orphan'), 'quarantined data is not destroyed')
  const stats = memory.stats(a, 'c1')
  assert.equal(stats.project.count, 1); assert.equal(stats.global.count, 2); assert.equal(stats.project.limit, TIERS.project.entries)
  assert.equal(memory.maintain({ workspace: a, chatId: 'c1', crossProject: true }).evicted, 0)
})

test('automatic notes of a chat are budgeted per chat; a busy chat cannot push out another, old chats and old notes expire', t => {
  const { saveNote, pruneAutomatic } = require('../electron/shared-context.cjs')
  const { ProjectContextStore } = require('../electron/project-context.cjs')
  const { root, a } = fixture(t), store = new ProjectContextStore(root)
  saveNote(store, a, {}, { key: 'deliberate', summary: 'kept on purpose' })
  saveNote(store, a, {}, { key: 'agent:quiet:Scout', summary: 'result of a quiet chat' })
  for (let i = 0; i < 45; i++) saveNote(store, a, {}, { key: `agent:busy:worker-${i}`, summary: `result ${i}` })
  let notes = store.getLatest(a).notes
  assert.ok(notes.some(note => note.key === 'agent:quiet:Scout'), 'the quiet chat keeps its note')
  assert.equal(notes.filter(note => note.key.startsWith('agent:busy:')).length, 30)
  for (const chat of ['c1', 'c2', 'c3']) saveNote(store, a, {}, { key: `progress:${chat}`, summary: chat })
  notes = store.getLatest(a).notes
  assert.ok(!notes.some(note => note.key === 'agent:quiet:Scout'), 'only the four most recent chats keep automatic notes')
  assert.ok(notes.some(note => note.key === 'agent:busy:worker-44') && notes.some(note => note.key === 'deliberate'))
  assert.deepEqual(pruneAutomatic(notes, Date.now() + 15 * DAY).map(note => note.key), ['deliberate'], 'automatic notes expire, deliberate ones never')
})
