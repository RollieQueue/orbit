const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RunStore } = require('../electron/run-store.mts')

// A profile whose run-history holds `count` finished runs, run-0 the oldest, written one minute apart.
function history(t, count) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-retention-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const root = path.join(userData, 'run-history')
  fs.mkdirSync(root)
  const start = Date.now() - (count + 60) * 60_000
  for (let index = 0; index < count; index++) write(root, `run-${index}`, start + index * 60_000)
  return { userData, root, at: name => path.join(root, name) }
}

function write(root, id, time, fields = { status: 'completed' }) {
  const file = path.join(root, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ runId: id, projectId: 'p', chatId: 'c', startedAt: new Date(time).toISOString(), ...fields }))
  fs.utimesSync(file, new Date(time), new Date(time))
}

function image(root, id) {
  fs.mkdirSync(path.join(root, 'images', id), { recursive: true })
  fs.writeFileSync(path.join(root, 'images', id, 'shot.png'), 'png')
}

test('opening the store deletes the oldest runs beyond the limit with their backups, leftovers and images', t => {
  const { userData, root, at } = history(t, 6)
  // The newest run, whose id starts with the id of a deleted one.
  write(root, 'run-10', Date.now() - 60_000)
  for (const id of ['run-0', 'run-4']) { fs.writeFileSync(at(`${id}.json.bak`), '{}'); image(root, id) }
  fs.writeFileSync(at('run-1.json.1234.5678-abcd.tmp'), 'partial')
  fs.writeFileSync(at('notes.txt'), 'not a run')

  const store = new RunStore(userData, { keep: 5 })

  for (const gone of ['run-0.json', 'run-0.json.bak', 'run-1.json', 'run-1.json.1234.5678-abcd.tmp', 'images/run-0']) assert.equal(fs.existsSync(at(gone)), false, `${gone} deleted`)
  for (const kept of ['run-2.json', 'run-5.json', 'run-10.json', 'run-4.json.bak', 'images/run-4/shot.png', 'notes.txt']) assert.ok(fs.existsSync(at(kept)), `${kept} kept`)
  assert.deepEqual(store.list().map(run => run.runId), ['run-10', 'run-5', 'run-4', 'run-3', 'run-2'], 'what was deleted is not served either')
  assert.equal(store.get('run-0'), null)
})

test('a long session prunes once `slack` more run files were written, never a run that is still active', t => {
  const { userData, at } = history(t, 3)
  const store = new RunStore(userData, { keep: 3, slack: 2 })
  store.save({ runId: 'live', status: 'working', agents: [] })
  store.flush()
  assert.ok(fs.existsSync(at('run-0.json')), 'no prune before `slack` new files')
  const old = new Date(Date.now() - 24 * 60 * 60_000)
  fs.utimesSync(at('live.json'), old, old)

  store.save({ runId: 'done', status: 'completed', agents: [] })
  assert.equal(fs.existsSync(at('run-0.json')), false, 'the oldest finished run is deleted')
  for (const kept of ['run-1', 'run-2', 'done', 'live']) assert.ok(fs.existsSync(at(`${kept}.json`)), `${kept} kept`)
  assert.equal(store.get('live').status, 'working', 'the active run stays although its file is the oldest')
})

test('a run a prune cannot delete stays for the next one, and opening the store never throws', t => {
  const { userData, root, at } = history(t, 3)
  fs.mkdirSync(at('run-0.json.bak'))
  fs.writeFileSync(path.join(root, 'run-0.json.bak', 'inside'), 'x')

  const store = new RunStore(userData, { keep: 1 })

  assert.ok(fs.existsSync(at('run-0.json')), 'kept while a file of it cannot be deleted')
  assert.equal(fs.existsSync(at('run-1.json')), false)
  fs.rmSync(at('run-0.json.bak'), { recursive: true })
  assert.deepEqual(store.prune(), ['run-0'])
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.json')), ['run-2.json'])
})
