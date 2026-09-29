const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { writeJSON } = require('../electron/storage.mts')

// Cases found by an independent review of the tiered memory: each one failed before it was fixed.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-review-'))
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, a, b, open: () => new OrbitMemoryStore(root) }
}
const agent = { origin: 'agent' }

test('the same words with a different value are not the same knowledge: nothing is shared and both project notes stay visible', t => {
  const { a, b, open } = fixture(t), memory = open()
  const title = 'Development server default port'
  memory.save({ scope: 'project', workspace: a, type: 'fact', title, content: 'The development server listens on port 3000 when started with the standard script' }, agent)
  memory.save({ scope: 'project', workspace: b, type: 'fact', title, content: 'The development server listens on port 8080 when started with the standard script' }, agent)
  assert.equal(memory.maintain({ workspace: a, crossProject: true }).shared, 0)
  assert.equal(memory.recall({ query: 'development server port', workspace: a }).tiers.project.length, 1)
  assert.match(memory.recall({ query: 'development server port', workspace: a }).tiers.project[0].entry.content, /3000/)
  assert.equal(memory.list('', true).filter(entry => entry.scope === 'global').length, 0)
})

test('a note the user wrote in a chat is never merged away or promoted by maintenance', t => {
  const { a, open } = fixture(t), memory = open()
  const mine = memory.upsert({ scope: 'chat', workspace: a, chatId: 'c1', type: 'decision', title: 'Storage engine choice', content: 'We keep the queue in sqlite because the benchmark showed it is fastest' })
  memory.save({ scope: 'project', workspace: a, type: 'decision', title: 'Storage engine choice', content: 'The queue is kept in sqlite because the benchmark showed it is fastest for us' }, agent)
  memory.touch([mine.id]); memory.touch([mine.id]); memory.touch([mine.id])
  const report = memory.maintain({ workspace: a, chatId: 'c1' })
  assert.equal(report.promoted, 0); assert.equal(report.merged, 0)
  const kept = memory.list(a, false, 'c1').find(entry => entry.id === mine.id)
  assert.equal(kept.scope, 'chat'); assert.match(kept.content, /^We keep the queue/)
})

test('model assessments are capped, cannot be overwritten by agents, and do not crowd out other shared notes', t => {
  const { a, open } = fixture(t), memory = open()
  for (let i = 0; i < 80; i++) memory.save({ id: `model-${String(i).padStart(24, '0')}`, scope: 'global', title: `Model: vendor/model-${i} — task ${i}`, content: `{"assessment":"result number ${i}"}` }, { origin: 'system' })
  assert.equal(memory.list(a).filter(entry => entry.source === 'system').length, 60, 'the oldest assessments went')
  assert.throws(() => memory.save({ id: 'model-000000000000000000000079', scope: 'global', title: 'x', content: 'y' }, agent), /harness record/)
  assert.throws(() => memory.remove('model-000000000000000000000079', a, undefined, { origin: 'agent' }), /harness record/)
  memory.save({ scope: 'global', type: 'preference', title: 'Answer language', content: 'Answer in Russian' }, agent)
  const shown = memory.recall({ query: 'answer language', workspace: a, models: true }).tiers.global
  assert.ok(shown.some(item => item.entry.title === 'Answer language'), 'a relevant shared note is not pushed out')
  assert.ok(shown.filter(item => item.pinned).length <= 6, 'only the newest few assessments are always shown')
  // Near-identical assessments of different tasks are separate records: maintenance does not merge them.
  assert.equal(memory.maintain({ workspace: a }).merged, 0)
})

test('notes an older version saved from the UI count as the user\'s; agent notes of that era do not', t => {
  const { root, a, open } = fixture(t)
  writeJSON(path.join(root, 'memory.json'), [
    { id: 'ui', title: 'Typed by the user', content: 'from the form', scope: 'project', workspace: a, confidence: 100, updated: '2025-01-01T00:00:00.000Z' },
    { id: 'agent', title: 'Saved by an agent', content: 'from a tool call', scope: 'project', workspace: a, confidence: 80, updated: '2025-01-01T00:00:00.000Z' },
  ])
  const memory = open()
  assert.throws(() => memory.save({ id: 'ui', scope: 'project', workspace: a, title: 'x', content: 'overwritten' }, agent), /written or pinned by the user/)
  assert.doesNotThrow(() => memory.save({ id: 'agent', scope: 'project', workspace: a, title: 'Saved by an agent', content: 'revised' }, agent))
})
