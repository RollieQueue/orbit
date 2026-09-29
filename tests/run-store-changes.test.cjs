const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RunStore, stripDiffs } = require('../electron/run-store.cjs')

const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const change = (id, extra = {}) => ({ id, agentId: 'agent-1', path: 'src/a.ts', kind: 'modify', tool: 'edit_file', time: '2026-09-29T10:00:00.000Z', added: 1, removed: 1, source: 'exact', ...extra })
const record = (runId, extra = {}) => ({
  runId, projectId: 'p1', chatId: 'c1', status: 'done', startedAt: `2026-09-29T10:00:0${runId.length}.000Z`,
  changes: [change('ch-1', { diff: DIFF }), change('ch-2', { kind: 'delete', binary: true })], ...extra,
})

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-run-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, store: new RunStore(dir) }
}

test('stripDiffs drops the text and marks where a diff existed, without touching the input', () => {
  const input = record('run-1')
  const stripped = stripDiffs(input)
  assert.equal(stripped.changes[0].diff, undefined)
  assert.equal(stripped.changes[0].hasDiff, true)
  assert.equal(stripped.changes[1].hasDiff, false, 'no diff text, no hasDiff')
  assert.equal(stripped.changes[1].binary, true, 'other fields are kept')
  assert.equal(input.changes[0].diff, DIFF, 'the original keeps its text')
  assert.equal(stripDiffs({ ...input, changes: [change('ch-3', { hasDiff: true })] }).changes[0].hasDiff, true, 'an existing hasDiff survives')
})

test('stripDiffs leaves records without changes as they are', () => {
  const plain = { runId: 'run-2', status: 'done' }
  assert.deepEqual(stripDiffs(plain), plain)
  assert.deepEqual(stripDiffs({ runId: 'run-3', changes: [] }).changes, [])
  assert.equal(stripDiffs(null), null)
  assert.equal(stripDiffs(undefined), undefined)
})

test('list and forChat are light while get and getChanges return the full diff text', (t) => {
  const { store } = tempStore(t)
  store.save(record('run-1'))
  for (const run of [...store.list(), ...store.forChat('p1', 'c1')]) {
    assert.equal(run.changes.length, 2)
    assert.ok(run.changes.every(item => item.diff === undefined))
    assert.deepEqual(run.changes.map(item => item.hasDiff), [true, false])
  }
  assert.equal(store.get('run-1').changes[0].diff, DIFF)
  const full = store.getChanges('run-1')
  assert.equal(full.length, 2)
  assert.equal(full[0].diff, DIFF)
  assert.equal(full[0].hasDiff, undefined, 'stored records are not modified by stripping')
  assert.equal(store.getChanges('run-1')[0].diff, DIFF, 'listing did not strip the stored record')
})

test('getChanges answers [] for unknown, invalid and change-less runs', (t) => {
  const { store } = tempStore(t)
  store.save({ runId: 'run-plain', status: 'done', startedAt: '2026-09-29T10:00:00.000Z' })
  assert.deepEqual(store.getChanges('run-missing'), [])
  assert.deepEqual(store.getChanges('run-plain'), [])
  for (const bad of ['../secret', 'a/b', '', null, undefined, 42, {}]) {
    assert.equal(store.get(bad), null)
    assert.deepEqual(store.getChanges(bad), [])
  }
})

test('the file on disk keeps the diff text and a new store serves it', (t) => {
  const { dir, store } = tempStore(t)
  store.save(record('run-1'))
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'run-history', 'run-1.json'), 'utf8'))
  assert.equal(onDisk.changes[0].diff, DIFF)
  const reopened = new RunStore(dir)
  assert.equal(reopened.getChanges('run-1')[0].diff, DIFF)
  assert.equal(reopened.list()[0].changes[0].diff, undefined)
  assert.equal(reopened.list()[0].changes[0].hasDiff, true)
})
