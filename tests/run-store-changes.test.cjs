const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { RunStore, stripDiffs } = require('../electron/run-store.mts')

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

// A run saved before Orbit recorded changes, in the shape of the owner's run 7e8cdcb2: no `changes` key, every worker
// with `files.wrote`, the files committed after the run. Git still tells what changed relative to the run's start commit.
const { execFileSync } = require('node:child_process')
const gitAt = (workspace, when, ...args) => execFileSync('git', ['-C', workspace, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
const write = (workspace, rel, text) => { fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true }); fs.writeFileSync(path.join(workspace, rel), text) }
function legacyWorkspace(t) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-legacy-ws-')))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }))
  try { gitAt(workspace, '2026-09-29T13:25:47Z', 'init', '-q') } catch { t.skip('git is not available'); return null }
  write(workspace, 'src/App.tsx', 'a\nb\n'); write(workspace, 'README.md', '# Orbit\n')
  gitAt(workspace, '2026-09-29T13:25:47Z', 'add', '-A'); gitAt(workspace, '2026-09-29T13:25:47Z', 'commit', '-q', '-m', 'f036f27')
  write(workspace, 'src/App.tsx', 'a\nB\n'); write(workspace, 'src/ChangesTab.tsx', 'export {}\n'); write(workspace, 'README.md', '# Orbit\nchanges\n')
  gitAt(workspace, '2026-09-29T15:04:06Z', 'add', '-A'); gitAt(workspace, '2026-09-29T15:04:06Z', 'commit', '-q', '-m', 'ee8458c')
  return workspace
}
const legacyRecord = (workspace, extra = {}) => ({
  runId: 'legacy-run', projectId: 'p1', chatId: 'c1', status: 'cancelled', startedAt: '2026-09-29T14:15:56.918Z', finishedAt: '2026-09-29T15:10:57.049Z', workspace,
  agents: [
    { id: 'root', name: 'Orbit', status: 'cancelled', files: { read: ['electron/main.cjs'], wrote: ['README.md', 'src/App.tsx'] } },
    { id: 'agent-396b', name: 'changes-ui', status: 'done', finishedAt: '2026-09-29T14:40:00.000Z', files: { read: ['src/types.ts'], wrote: ['src/ChangesTab.tsx', 'src/App.tsx'] } },
    { id: 'agent-f51f', name: 'visual-check', status: 'done', files: { read: ['src/ChangesTab.tsx'], wrote: [] } },
  ],
  ...extra,
})

test('recoverChanges lists every reported write of a run without records, with a git diff where Git still shows one', async (t) => {
  const workspace = legacyWorkspace(t)
  if (!workspace) return
  const { store } = tempStore(t)
  store.save(legacyRecord(workspace))
  assert.deepEqual(store.getChanges('legacy-run'), [], 'nothing was recorded at the time')
  const recovered = await store.recoverChanges('legacy-run')
  assert.deepEqual(recovered.map(change => [change.id, change.agentId, change.path, change.time]), [
    ['legacy:root:README.md', 'root', 'README.md', '2026-09-29T15:10:57.049Z'],
    ['legacy:root:src/App.tsx', 'root', 'src/App.tsx', '2026-09-29T15:10:57.049Z'],
    ['legacy:agent-396b:src/ChangesTab.tsx', 'agent-396b', 'src/ChangesTab.tsx', '2026-09-29T14:40:00.000Z'],
    ['legacy:agent-396b:src/App.tsx', 'agent-396b', 'src/App.tsx', '2026-09-29T14:40:00.000Z'],
  ], 'one entry per agent and file, timed by the agent when it recorded a finish, else by the run')
  const base = execFileSync('git', ['-C', workspace, 'rev-list', '-1', '--before=2026-09-29T14:15:56Z', 'HEAD']).toString().trim().slice(0, 7)
  assert.ok(recovered.every(change => change.source === 'git' && change.hasDiff && change.base === base && change.diff.includes('@@ ')), JSON.stringify(recovered.map(change => [change.path, change.hasDiff, change.reason])))
  assert.deepEqual(recovered.map(change => change.kind), ['modify', 'modify', 'create', 'modify'])
  assert.match(recovered[1].diff, /^--- a\/src\/App\.tsx\n\+\+\+ b\/src\/App\.tsx\n@@ -1,2 \+1,2 @@\n a\n-b\n\+B$/)
  assert.match(recovered[2].diff, /^--- \/dev\/null\n\+\+\+ b\/src\/ChangesTab\.tsx\n/)
  // A live run's records and the saved ones both count as covered; a covered pair is not recovered again.
  const partial = await store.recoverChanges('legacy-run', [{ agentId: 'root', path: 'README.md' }])
  assert.deepEqual(partial.map(change => change.id), ['legacy:root:src/App.tsx', 'legacy:agent-396b:src/ChangesTab.tsx', 'legacy:agent-396b:src/App.tsx'])
  store.save(legacyRecord(workspace, { changes: [change('c-1', { agentId: 'agent-396b', path: 'src/App.tsx' })] }))
  assert.deepEqual((await store.recoverChanges('legacy-run')).map(change => change.id), ['legacy:root:README.md', 'legacy:root:src/App.tsx', 'legacy:agent-396b:src/ChangesTab.tsx'], 'a run that has records recovers only the writes they miss')
  store.save(record('tracked'))
  assert.deepEqual(await store.recoverChanges('tracked'), [], 'a run whose writes are all recorded has nothing to recover')
  assert.deepEqual(await store.recoverChanges('missing'), [])
  assert.deepEqual(await store.recoverChanges('../x'), [])
})

test('recoverChanges says why when Git cannot help, and never invents a diff', async (t) => {
  const { store } = tempStore(t)
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-legacy-plain-'))
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }))
  write(plain, 'note.txt', 'x\n')
  store.save(legacyRecord(plain, { runId: 'no-repo', agents: [{ id: 'root', name: 'Orbit', files: { read: [], wrote: ['note.txt'] } }] }))
  assert.deepEqual((await store.recoverChanges('no-repo')).map(change => [change.path, change.hasDiff, change.reason, 'diff' in change]), [['note.txt', false, 'no-repo', false]])
  const workspace = legacyWorkspace(t)
  if (!workspace) return
  store.save(legacyRecord(workspace, { runId: 'too-early', startedAt: '2026-09-27T11:34:27.454Z', agents: [{ id: 'root', name: 'Orbit', files: { read: [], wrote: ['README.md'] } }] }))
  assert.deepEqual((await store.recoverChanges('too-early')).map(change => [change.hasDiff, change.reason]), [[false, 'no-base-commit']], 'a run older than the first commit has nothing to compare with')
  store.save(legacyRecord(workspace, { runId: 'gone-workspace', workspace: path.join(workspace, 'nowhere') }))
  assert.ok((await store.recoverChanges('gone-workspace')).every(change => change.reason === 'no-repo' && !change.hasDiff))
  store.save({ runId: 'no-workspace', status: 'done', startedAt: '2026-09-29T10:00:00Z', agents: [{ id: 'root', files: { read: [], wrote: ['a.txt'] } }] })
  assert.deepEqual(await store.recoverChanges('no-workspace'), [])
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
