const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { OrbitRuntime } = require('../electron/runtime.cjs')
const { RunStore } = require('../electron/run-store.cjs')
const { nativeChange, commandChange } = require('../electron/change-log.cjs')

// The whole path of a file change: an agent's tool → the runtime → the events, the snapshot and the saved run.
// Real Git repository, real RunStore, only the provider is fake.

function folder(t, prefix = 'orbit-e2e-') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }))
  return directory
}
const write = (workspace, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true })
  fs.writeFileSync(path.join(workspace, rel), text)
}
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
// A repository whose committed files have LF while the working copy has CRLF (core.autocrlf=true), as on this project's machine.
function repo(t, files) {
  const workspace = folder(t)
  try { git(workspace, 'init', '-q') } catch { t.skip('git is not available'); return null }
  git(workspace, 'config', 'core.autocrlf', 'true')
  for (const [rel, text] of Object.entries(files)) write(workspace, rel, text)
  git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'base')
  return workspace
}
const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const waitFor = async (predicate, what) => {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const native = (tool, toolId, status, extra = {}) => ({ kind: 'tool', native: true, tool, toolId, status, text: tool, ...extra })

// Runs one root agent. `seen` is what was known the moment the terminal event arrived.
async function run(t, { workspace, provider, runStore, onEvent }) {
  const events = [], seen = {}
  const runtime = new OrbitRuntime({ runProvider: args => provider({ ...args, runtime, events }), runStore })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  runtime.onEvent(event => {
    if (event.type === 'change.added') events.push(event.change)
    onEvent?.(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) { seen.changes = events.length; finished(event) }
  })
  const runId = await runtime.start({ providerId: 'test', prompt: 'Change files', projectId: 'p', chatId: 'c', accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(runId), 20000)
  t.after(() => clearTimeout(timer))
  const terminal = await done
  assert.equal(terminal.type, 'run.finished')
  return { runtime, runId, events, seen, snapshot: runtime.getRun(runId) }
}
const plain = list => list.map(change => ({ ...change, id: undefined, time: undefined }))

test('every kind of change reaches the events, the snapshot, the saved run and the lists', async t => {
  const workspace = repo(t, {
    'src/app.ts': 'one\ntwo\nthree\nfour\n',
    'README.md': 'title\r\nbody\r\nend\r\n',
    'lib/gone.txt': 'bye\n',
    'data.txt': 'a\nb\nc\n',
    'other.txt': 'keep\nme\n',
  })
  if (!workspace) return
  const userData = folder(t, 'orbit-e2e-store-')
  const runStore = new RunStore(userData)
  let turn = 0
  const script = "require('fs').writeFileSync('made.txt', 'fresh\\n'); require('fs').writeFileSync('other.txt', 'keep\\nyou\\n')"
  const { runtime, runId, events, seen, snapshot } = await run(t, { workspace, runStore, provider: async ({ onEvent, events }) => {
    turn++
    if (turn === 1) {
      // Claude: an Edit (the file already holds the result), a Write of a new file, a Write over a CRLF working copy.
      write(workspace, 'src/app.ts', 'one\ntwo\nTHREE\nfour\n')
      onEvent(native('Edit', 'e1', 'started'))
      onEvent(native('Edit', 'e1', 'running', { input: { file_path: path.join(workspace, 'src', 'app.ts'), old_string: 'three', new_string: 'THREE' } }))
      onEvent({ kind: 'tool', native: true, toolId: 'e1', status: 'completed', text: 'ok' })
      write(workspace, 'notes.md', '# notes\nfirst\n')
      onEvent(native('Write', 'w1', 'running', { input: { file_path: path.join(workspace, 'notes.md'), content: '# notes\nfirst\n' } }))
      onEvent({ kind: 'tool', native: true, toolId: 'w1', status: 'completed', text: 'ok' })
      write(workspace, 'README.md', 'title\r\nBODY\r\nend\r\n')
      onEvent(native('Write', 'w2', 'running', { input: { file_path: 'README.md', content: 'title\r\nBODY\r\nend\r\n' } }))
      onEvent({ kind: 'tool', native: true, toolId: 'w2', status: 'completed', text: 'ok' })
      // Codex: a file_change item that is announced and then completed, and one that is declined.
      fs.rmSync(path.join(workspace, 'lib', 'gone.txt'))
      write(workspace, 'lib/added.txt', 'x\ny\n')
      const changes = [{ path: path.join(workspace, 'lib', 'added.txt'), kind: 'add' }, { path: 'lib/gone.txt', kind: 'delete' }]
      onEvent(native('file_change', 'c1', 'started', { changes }))
      onEvent(native('file_change', 'c1', 'completed', { changes }))
      onEvent(native('file_change', 'c2', 'declined', { changes: [{ path: 'never.txt', kind: 'add' }] }))
      await waitFor(() => events.length >= 5, 'the native changes')
      // Orbit's own tools and a command, in the next turn.
      return envelope(
        call('write_file', { path: 'data.txt', content: 'a\nB\nc\n' }),
        call('edit_file', { path: 'data.txt', old_text: 'c', new_text: 'C' }),
        call('run_command', { command: process.execPath, args: ['-e', script] }),
      )
    }
    return { text: 'done' }
  } })

  const by = (rel, index = 0) => events.filter(change => change.path === rel)[index]
  assert.equal(events.length, 9, events.map(change => `${change.tool}:${change.path}`).join(', '))
  assert.equal(new Set(events.map(change => change.id)).size, events.length, 'no change twice')
  assert.equal(events.filter(change => change.path === 'never.txt').length, 0, 'a declined change is no change')
  assert.equal(seen.changes, events.length, 'the run does not end before its last change record is made')

  const edit = by('src/app.ts')
  assert.deepEqual([edit.tool, edit.kind, edit.source, edit.added, edit.removed], ['Edit', 'modify', 'event', 1, 1])
  assert.match(edit.diff, /^--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n@@ -3(?:,1)? \+3(?:,1)? @@\n-three\n\+THREE$/)
  const notes = by('notes.md')
  assert.deepEqual([notes.tool, notes.kind, notes.source, notes.added, notes.removed], ['Write', 'create', 'event', 2, 0], 'a file born during the run is a creation, in a repository or not')
  assert.match(notes.diff, /^--- \/dev\/null\n\+\+\+ b\/notes\.md\n@@ -0,0 \+1,2 @@\n\+# notes\n\+first$/)
  const readme = by('README.md')
  assert.deepEqual([readme.source, readme.kind, readme.added, readme.removed], ['git', 'modify', 1, 1], 'CRLF working copy against LF blob: one line changed, not all')
  assert.match(readme.diff, /\n title\n-body\n\+BODY\n end$/)
  const added = by('lib/added.txt'), gone = by('lib/gone.txt')
  assert.deepEqual([added.tool, added.kind, added.added], ['file_change', 'create', 2])
  assert.deepEqual([gone.tool, gone.kind, gone.source, gone.removed], ['file_change', 'delete', 'git', 1])
  assert.match(gone.diff, /\+\+\+ \/dev\/null/)

  const written = by('data.txt'), edited = by('data.txt', 1)
  assert.deepEqual([written.tool, written.source, written.kind, written.added, written.removed], ['write_file', 'exact', 'modify', 1, 1])
  assert.deepEqual([edited.tool, edited.source], ['edit_file', 'exact'])
  assert.match(edited.diff, /\n B\n-c\n\+C$/)
  const made = by('made.txt'), other = by('other.txt')
  assert.deepEqual([made.tool, made.kind, made.source, made.hasDiff, made.added], ['run_command', 'create', 'exact', true, 1], 'a file a command created has an exact diff')
  assert.match(made.diff, /^--- \/dev\/null\n\+\+\+ b\/made\.txt\n@@ -0,0 \+1 @@\n\+fresh$/)
  assert.deepEqual([other.tool, other.kind, other.source, other.added, other.removed], ['run_command', 'modify', 'git', 1, 1])
  const rootId = snapshot.agents[0].id
  assert.ok(events.every(change => change.agentId === rootId))

  // The same records everywhere.
  const full = runtime.getRunChanges(runId)
  assert.deepEqual(full.map(change => change.id), events.map(change => change.id))
  assert.deepEqual(plain(snapshot.changes), plain(events))
  assert.ok(full.filter(change => change.hasDiff).every(change => change.diff), 'the live run serves diff text')

  const saved = runStore.get(runId)
  assert.equal(saved.status, 'completed')
  assert.deepEqual(plain(saved.changes), plain(events), 'the saved run holds every change with its text')
  const listed = runStore.list().find(run => run.runId === runId)
  assert.equal(listed.changes.length, events.length)
  assert.ok(listed.changes.every(change => !('diff' in change)), 'lists carry no diff text')
  assert.deepEqual(listed.changes.map(change => change.hasDiff), events.map(change => change.hasDiff))
  assert.deepEqual(runStore.getChanges(runId).map(change => change.diff), events.map(change => change.diff))
  runStore.flush()
  const reopened = new RunStore(userData)
  assert.deepEqual(reopened.getChanges(runId).map(change => change.diff), events.map(change => change.diff), 'and so does a store opened later')
  assert.deepEqual(plain(runtime.getRunChanges('unknown-run')), [])
})

test('a change still being made when the agent answers is part of the finished run', async t => {
  const workspace = folder(t)
  const saved = []
  const { events, seen, snapshot } = await run(t, { workspace, runStore: { save: item => saved.push(item) }, provider: async ({ onEvent }) => {
    write(workspace, 'late.txt', 'a\nb\n')
    onEvent(native('Write', 'late', 'running', { input: { file_path: 'late.txt', content: 'a\nb\n' } }))
    onEvent({ kind: 'tool', native: true, toolId: 'late', status: 'completed', text: 'ok' })
    return { text: 'done' } // no waiting: the record is made in the background
  } })
  assert.equal(seen.changes, 1, 'it was there when run.finished was announced')
  assert.deepEqual(events.map(change => [change.path, change.kind, change.added]), [['late.txt', 'create', 2]])
  assert.equal(snapshot.changes.length, 1)
  assert.equal(saved.at(-1).status, 'completed')
  assert.equal(saved.at(-1).changes.length, 1, 'and in the record saved with the terminal event')
})

test('a command does not claim a file another agent wrote while it ran', async t => {
  const workspace = repo(t, { 'shared.txt': 'one\n', 'quiet.txt': 'q\n' })
  if (!workspace) return
  let turned = false
  const { events } = await run(t, {
    workspace,
    provider: async ({ runtime }) => {
      if (!turned) {
        turned = true
        // Another agent's write_file lands while the command below is running.
        setTimeout(() => {
          const live = [...runtime.runs.values()][0]
          write(workspace, 'shared.txt', 'one\ntwo\n')
          runtime.reportWrite(live, live.agentNodes.get('root'), 'edit_file', { path: 'shared.txt', before: 'one\n', after: 'one\ntwo\n' })
        }, 600)
        return envelope(call('run_command', { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'] }))
      }
      return { text: 'done' }
    },
  })
  assert.deepEqual(events.map(change => [change.path, change.tool, change.source]), [['shared.txt', 'edit_file', 'exact']], 'one change, made by the tool that made it')
})

test('a path that leads out of the workspace through a link reads nothing from outside', async t => {
  const workspace = folder(t)
  const outside = folder(t, 'orbit-e2e-outside-')
  write(outside, 'secret.txt', 'TOP-SECRET\n')
  try { fs.symlinkSync(outside, path.join(workspace, 'link'), 'junction') } catch { t.skip('links are not available'); return }
  const since = Date.now() - 60000
  for (const [tool, entry] of [
    ['a Codex add', { tool: 'file_change', changes: [{ path: 'link/secret.txt', kind: 'add' }] }],
    ['a Claude Write without its text', { tool: 'Write', input: { file_path: 'link/secret.txt' } }],
  ]) {
    const change = await nativeChange(workspace, 'link/secret.txt', entry, true, since)
    assert.doesNotMatch(JSON.stringify(change), /TOP-SECRET\\n|"after"/, tool)
    assert.ok(!change.after && !(change.diff || '').includes('secret'), tool)
  }
  assert.doesNotMatch(JSON.stringify(await commandChange(workspace, 'link/secret.txt', 'create')), /TOP-SECRET/)
})

test('file names are names for Git, not patterns, and an oversize or vanished file does not break a change', async t => {
  const workspace = repo(t, { '[id]/page.tsx': 'a\nb\n', 'x.txt': 'x\n', 'y.txt': 'y\n', '[xy].txt': 'v\n' })
  if (!workspace) return
  write(workspace, '[id]/page.tsx', 'a\nB\n')
  write(workspace, '[xy].txt', 'V\n')
  write(workspace, 'x.txt', 'X\n'); write(workspace, 'y.txt', 'Y\n')
  const page = await commandChange(workspace, '[id]/page.tsx', 'modify')
  assert.match(page.diff, /^--- a\/\[id\]\/page\.tsx\n\+\+\+ b\/\[id\]\/page\.tsx\n/)
  const bracket = await commandChange(workspace, '[xy].txt', 'modify')
  assert.equal(bracket.diff.match(/^--- /gm).length, 1, '[xy].txt names one file, not x.txt and y.txt')
  assert.match(bracket.diff, /^--- a\/\[xy\]\.txt\n/)
  write(workspace, 'huge.txt', 'x'.repeat(3 * 1024 * 1024))
  assert.deepEqual(await commandChange(workspace, 'huge.txt', 'create'), { kind: 'create', source: 'git' })
  assert.deepEqual(await commandChange(workspace, 'missing.txt', 'create'), { kind: 'create', source: 'git' })
  assert.deepEqual(await nativeChange(workspace, 'missing.txt', { tool: 'Write', input: {} }, true, 0), { kind: 'unknown', source: 'event' })
  // An untracked file is a creation only when it was born after the run began; one that was already there is not guessed at.
  write(workspace, 'untracked.txt', 'here\n')
  const entry = { tool: 'Write', input: { file_path: 'untracked.txt', content: 'here\n' } }
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, true, Date.now() + 60000), { kind: 'unknown', source: 'event' })
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, true, Date.now() - 60000), { kind: 'create', source: 'event', before: null, after: 'here\n' })
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, false, Date.now() - 60000), { kind: 'unknown', source: 'event' }, 'a later write of the run has no known starting point')
})

test('a workspace that is a folder of a repository gets the same diffs as a repository of its own', async t => {
  const root = repo(t, { 'pkg/a.txt': 'one\ntwo\n', 'pkg/dir/b.txt': 'b\n', 'top.txt': 't\n' })
  if (!root) return
  const workspace = path.join(root, 'pkg')
  write(workspace, 'a.txt', 'one\nTWO\n')
  fs.rmSync(path.join(workspace, 'dir', 'b.txt'))
  write(workspace, 'fresh.txt', 'new\n')
  const changed = await commandChange(workspace, 'a.txt', 'modify')
  assert.match(changed.diff, /^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1,2 \+1,2 @@\n one\n-two\n\+TWO$/, 'paths are relative to the workspace, not the repository')
  const deleted = await commandChange(workspace, 'dir/b.txt', 'delete')
  assert.deepEqual([deleted.source, deleted.diff.includes('+++ /dev/null')], ['git', true])
  const native = await nativeChange(workspace, 'a.txt', { tool: 'Write', input: { file_path: 'a.txt', content: 'one\nTWO\n' } }, true, 0)
  assert.deepEqual([native.source, native.kind], ['git', 'modify'])
  const fresh = await commandChange(workspace, 'fresh.txt', 'create')
  assert.deepEqual([fresh.source, fresh.after], ['exact', 'new\n'])
})
