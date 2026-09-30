const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { ChangeLog, recoverChanges, gitBaseCommit, MAX_DIFF_CHARS, MAX_CHANGES, MAX_TOTAL_CHARS, MAX_RECOVERED } = require('../electron/change-log.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-changes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return directory
}
const write = (workspace, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true })
  fs.writeFileSync(path.join(workspace, rel), text)
}
const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const waitFor = async (predicate, what) => {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
// Runs one root agent and collects the change events it produces.
async function run(t, { workspace, provider, runStore }) {
  const events = []
  const runtime = new OrbitRuntime({ runProvider: args => provider({ ...args, events }), ...(runStore ? { runStore } : {}) })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  runtime.onEvent(event => {
    if (event.type === 'change.added') events.push(event.change)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) finished(event)
  })
  const runId = await runtime.start({ providerId: 'test', prompt: 'Change files', projectId: 'p', chatId: 'c', accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(runId), 15000)
  t.after(() => clearTimeout(timer))
  const event = await done
  assert.equal(event.type, 'run.finished')
  return { runtime, runId, events, snapshot: runtime.getRun(runId) }
}
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
function repo(t, files) {
  const workspace = folder(t)
  try { git(workspace, 'init', '-q') } catch { t.skip('git is not available'); return null }
  for (const [rel, text] of Object.entries(files)) write(workspace, rel, text)
  git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'base')
  return workspace
}

// ---- the record --------------------------------------------------------------------------------------

test('a change gets an id, a workspace-relative path and its diff', t => {
  const workspace = folder(t)
  const log = new ChangeLog(workspace)
  const change = log.add({ agentId: 'a', path: path.join(workspace, 'src', 'x.ts'), tool: 'edit_file', source: 'exact', before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
  assert.equal(change.path, 'src/x.ts')
  assert.equal(change.kind, 'modify')
  assert.deepEqual([change.added, change.removed, change.hasDiff], [1, 1, true])
  assert.match(change.diff, /^--- a\/src\/x\.ts\n\+\+\+ b\/src\/x\.ts\n@@ /)
  assert.match(change.diff, /\n-b\n\+B\n/)
  assert.ok(change.id && change.time)
  assert.equal(log.add({ agentId: 'a', path: path.join(workspace, '..', 'outside.txt'), tool: 'x', source: 'exact', before: null, after: 'x' }), null)
  assert.equal(log.add({ agentId: 'a', path: 'node_modules/p/index.js', tool: 'x', source: 'exact', before: null, after: 'x' }), null)
  const created = log.add({ agentId: 'a', path: 'new.txt', tool: 'write_file', source: 'exact', before: null, after: 'one\ntwo\n' })
  assert.deepEqual([created.kind, created.added, created.removed], ['create', 2, 0])
  const listed = log.add({ agentId: 'a', path: 'known.txt', tool: 'Write', source: 'event', reason: 'later-write' })
  assert.deepEqual([listed.kind, listed.hasDiff, 'diff' in listed, listed.reason], ['unknown', false, false, 'later-write'], 'without text there is no diff, none is invented, and the record says why')
  assert.equal(log.snapshot().length, 3)
  assert.equal('reason' in created, false, 'a change with a diff carries no reason')
  const binary = log.add({ agentId: 'a', path: 'pic.bin', tool: 'write_file', source: 'exact', before: 'a\0', after: 'b\0', reason: 'unreadable' })
  assert.deepEqual([binary.binary, binary.hasDiff, 'reason' in binary], [true, false, false], 'a binary file is explained by its flag, not a reason')
})

test('one diff is cut on a line boundary, and old diffs give way to new ones', t => {
  const log = new ChangeLog(folder(t))
  const body = count => `--- a/f.txt\n+++ b/f.txt\n@@ -0,0 +1,${count} @@\n${'+line of a diff\n'.repeat(count)}`
  const big = log.add({ agentId: 'a', path: 'big.txt', tool: 'Write', source: 'event', diff: body(20000) })
  assert.ok(big.diff.length <= MAX_DIFF_CHARS && big.diff.endsWith('\n'))
  assert.equal(big.truncated, true)
  assert.equal(big.added, 20000, 'the counts describe the whole change, not the part that is kept')
  assert.ok(big.diff.split('\n').filter(line => line.startsWith('+')).length < big.added)
  const each = Math.floor(MAX_TOTAL_CHARS / MAX_DIFF_CHARS) + 3
  for (let index = 0; index < each; index++) log.add({ agentId: 'a', path: `f${index}.txt`, tool: 'Write', source: 'event', diff: body(3700) })
  const all = log.snapshot()
  assert.equal(all.length, each + 1, 'the records stay')
  assert.ok(all.reduce((sum, change) => sum + (change.diff?.length || 0), 0) <= MAX_TOTAL_CHARS)
  assert.equal(all[0].hasDiff, false, 'the oldest text goes first')
  assert.equal(all[0].reason, 'trimmed', 'and the record says where the text went')
  assert.equal(all[0].added, big.added, 'but its counts stay')
  assert.ok(!('diff' in all[0]))
  assert.equal(all.at(-1).hasDiff, true)
})

test('a run keeps at most 400 changes, the newest ones', t => {
  const log = new ChangeLog(folder(t))
  for (let index = 0; index < MAX_CHANGES + 25; index++) log.add({ agentId: 'a', path: `f${index}.txt`, tool: 'Write', source: 'event' })
  const all = log.snapshot()
  assert.equal(all.length, MAX_CHANGES)
  assert.equal(all[0].path, 'f25.txt')
  assert.equal(all.at(-1).path, `f${MAX_CHANGES + 24}.txt`)
})

test('only the first write of a file in a run may start from its committed version', t => {
  const log = new ChangeLog(folder(t))
  assert.equal(log.claim('a.txt'), true)
  assert.equal(log.claim('a.txt'), false)
  assert.equal(log.claim('b.txt'), true)
})

// ---- runs saved before changes were tracked -------------------------------------------------------------

// Commits at chosen times: the run below starts between the two, as the owner's runs did between f036f27 and ee8458c.
const gitAt = (workspace, when, ...args) => execFileSync('git', ['-C', workspace, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
function history(t) {
  const workspace = folder(t)
  try { gitAt(workspace, '2026-09-29T10:00:00Z', 'init', '-q') } catch { t.skip('git is not available'); return null }
  write(workspace, 'src/a.ts', 'one\ntwo\n'); write(workspace, 'same.txt', 'still\n'); write(workspace, 'gone.txt', 'bye\n')
  gitAt(workspace, '2026-09-29T10:00:00Z', 'add', '-A'); gitAt(workspace, '2026-09-29T10:00:00Z', 'commit', '-q', '-m', 'before the run')
  // The run (11:00–11:30) edits, creates and deletes; the agent commits afterwards, as the owner's agents do.
  write(workspace, 'src/a.ts', 'one\nTWO\n'); write(workspace, 'new.md', '# new\n'); fs.rmSync(path.join(workspace, 'gone.txt'))
  gitAt(workspace, '2026-09-29T12:00:00Z', 'add', '-A'); gitAt(workspace, '2026-09-29T12:00:00Z', 'commit', '-q', '-m', 'after the run')
  write(workspace, 'later.txt', 'uncommitted\n') // a file changed after the run and never committed
  return workspace
}

test('a run saved without change records gets its diffs from Git relative to the last commit before it started', async t => {
  const workspace = history(t)
  if (!workspace) return
  const base = await gitBaseCommit(workspace, '2026-09-29T11:00:00.918Z')
  assert.match(base, /^[0-9a-f]{40}$/)
  assert.equal(await gitBaseCommit(workspace, '2026-09-29T12:00:00Z'), execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD']).toString().trim(), 'a commit made in the very second the run began counts as before it')
  assert.equal(await gitBaseCommit(workspace, '2026-09-29T09:00:00Z'), null, 'nothing before the first commit')
  assert.equal(await gitBaseCommit(workspace, 'not a time'), undefined)
  assert.equal(await gitBaseCommit(folder(t), '2026-09-29T11:00:00Z'), undefined, 'no repository')

  const time = '2026-09-29T11:30:00.000Z'
  const writes = [{ agentId: 'root', path: 'src/a.ts', time }, { agentId: 'w1', path: 'new.md', time }, { agentId: 'w1', path: 'gone.txt', time }, { agentId: 'w2', path: 'same.txt', time }, { agentId: 'w2', path: 'later.txt', time }, { agentId: 'w2', path: '../outside.txt', time }, { agentId: '', path: 'src/a.ts', time }]
  const recovered = await recoverChanges(workspace, '2026-09-29T11:00:00.918Z', writes)
  const by = rel => recovered.find(change => change.path === rel)
  assert.deepEqual(recovered.map(change => change.id), ['legacy:root:src/a.ts', 'legacy:w1:new.md', 'legacy:w1:gone.txt', 'legacy:w2:same.txt', 'legacy:w2:later.txt'], 'one entry per reported write inside the workspace, with the id the renderer expects')
  assert.deepEqual([by('src/a.ts').kind, by('src/a.ts').source, by('src/a.ts').hasDiff, by('src/a.ts').base, by('src/a.ts').added, by('src/a.ts').removed, by('src/a.ts').tool, by('src/a.ts').time], ['modify', 'git', true, base.slice(0, 7), 1, 1, '', time])
  assert.match(by('src/a.ts').diff, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,2 \+1,2 @@\n one\n-two\n\+TWO$/, 'the diff is against the commit before the run, although the file was committed since')
  assert.deepEqual([by('new.md').kind, by('new.md').added], ['create', 1]); assert.match(by('new.md').diff, /^--- \/dev\/null\n/)
  assert.deepEqual([by('gone.txt').kind, by('gone.txt').removed], ['delete', 1]); assert.match(by('gone.txt').diff, /\+\+\+ \/dev\/null/)
  assert.deepEqual([by('same.txt').hasDiff, by('same.txt').reason, by('same.txt').kind, 'diff' in by('same.txt')], [false, 'git-same', 'unknown', false], 'an unchanged file is listed with the reason, never with an invented diff')
  assert.deepEqual([by('later.txt').hasDiff, by('later.txt').reason], [false, 'git-same'], 'an untracked file is nothing Git can compare')
  assert.ok(recovered.every(change => change.agentId && change.path && change.time && change.source === 'git'))

  assert.deepEqual((await recoverChanges(workspace, '2026-09-29T09:00:00Z', writes.slice(0, 2))).map(change => [change.hasDiff, change.reason, change.base]), [[false, 'no-base-commit', undefined], [false, 'no-base-commit', undefined]])
  assert.deepEqual((await recoverChanges(folder(t), '2026-09-29T11:00:00Z', writes.slice(0, 1))).map(change => [change.hasDiff, change.reason]), [[false, 'no-repo']])
  assert.deepEqual(await recoverChanges(workspace, '2026-09-29T11:00:00Z', []), [])
  const many = await recoverChanges(workspace, '2026-09-29T11:00:00Z', Array.from({ length: MAX_RECOVERED + 2 }, (_, index) => ({ agentId: 'a', path: `f${index}.txt`, time })))
  assert.deepEqual([many.length, many[MAX_RECOVERED - 1].reason, many[MAX_RECOVERED].reason, many[MAX_RECOVERED + 1].reason], [MAX_RECOVERED + 2, 'git-same', 'too-many', 'too-many'], 'Git is asked about a bounded number of files')
})

// ---- Orbit's own tools ---------------------------------------------------------------------------------

test('write_file and edit_file give exact diffs, and the model never sees them', async t => {
  const workspace = folder(t)
  write(workspace, 'old.txt', 'x\ny\n')
  const saved = []
  let turn = 0
  const { runtime, runId, events, snapshot } = await run(t, { workspace, runStore: { save: item => saved.push(item) }, provider: async () => {
    turn++
    if (turn === 1) return envelope(call('write_file', { path: 'src/new.txt', content: 'one\ntwo\n' }), call('write_file', { path: 'old.txt', content: 'x\nz\n' }))
    if (turn === 2) return envelope(call('edit_file', { path: 'src/new.txt', old_text: 'two', new_text: 'three' }))
    return { text: 'done' }
  } })
  assert.deepEqual(events.map(change => [change.path, change.kind, change.source, change.tool, change.added, change.removed]), [
    ['src/new.txt', 'create', 'exact', 'write_file', 2, 0],
    ['old.txt', 'modify', 'exact', 'write_file', 1, 1],
    ['src/new.txt', 'modify', 'exact', 'edit_file', 1, 1],
  ])
  assert.match(events[0].diff, /^--- \/dev\/null\n\+\+\+ b\/src\/new\.txt\n/)
  assert.match(events[1].diff, /\n x\n-y\n\+z$/)
  assert.match(events[2].diff, /\n one\n-two\n\+three$/, 'the second write is diffed against what its own call saw')
  assert.equal(new Set(events.map(change => change.id)).size, 3)
  assert.deepEqual(events.map(change => change.agentId), Array(3).fill(snapshot.agents[0].id))
  assert.deepEqual(snapshot.changes.map(change => change.id), events.map(change => change.id))
  assert.ok(snapshot.changes.every(change => change.diff), 'the snapshot carries the text')
  assert.deepEqual(saved.at(-1).changes.map(change => change.id), events.map(change => change.id), 'the persisted run holds the changes')
  const seen = snapshot.traces.map(trace => trace.text).join('\n')
  assert.doesNotMatch(seen, /@@ -/, 'tool results stay as small as before')
  assert.deepEqual(runtime.getRunChanges(runId).map(change => change.id), events.map(change => change.id))
})

test('a saved run answers getRunChanges when it is no longer live', () => {
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: '' }), runStore: { get: id => id === 'old' ? { changes: [{ id: 'c1', path: 'a.txt' }] } : null } })
  assert.deepEqual(runtime.getRunChanges('old'), [{ id: 'c1', path: 'a.txt' }])
  assert.deepEqual(runtime.getRunChanges('unknown'), [])
})

test('a failing change listener does not fail the write', async t => {
  const workspace = folder(t)
  const { executeWorkspaceTool } = require('../electron/runtime-tools.mts')
  const context = { workspace, accessMode: 'workspace-write', maxOutputChars: 1000, onFileChange: () => { throw new Error('boom') } }
  assert.deepEqual(await executeWorkspaceTool('write_file', { path: 'a.txt', content: 'x' }, context), { ok: true, path: 'a.txt', bytes: 1 })
  assert.deepEqual(await executeWorkspaceTool('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' }, context), { ok: true, path: 'a.txt' })
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'y')
})

test('edit_file matches LF old_text in a CRLF file and keeps the file CRLF; a mixed file is edited verbatim', async t => {
  const workspace = folder(t)
  const { executeWorkspaceTool } = require('../electron/runtime-tools.mts')
  const context = { workspace, accessMode: 'workspace-write', maxOutputChars: 1000 }
  const file = (name) => fs.readFileSync(path.join(workspace, name), 'utf8')
  fs.writeFileSync(path.join(workspace, 'crlf.ts'), 'const a = 1\r\nconst b = 2\r\n')
  await executeWorkspaceTool('edit_file', { path: 'crlf.ts', old_text: 'const a = 1\nconst b = 2\n', new_text: 'const a = 1\nconst b = 3\n// added\n' }, context)
  assert.equal(file('crlf.ts'), 'const a = 1\r\nconst b = 3\r\n// added\r\n', 'found through CRLF, written with CRLF')
  await executeWorkspaceTool('edit_file', { path: 'crlf.ts', old_text: '// added', new_text: '// added\n// appended' }, context)
  assert.equal(file('crlf.ts'), 'const a = 1\r\nconst b = 3\r\n// added\r\n// appended\r\n', 'a one-line match still inserts CRLF lines')
  fs.writeFileSync(path.join(workspace, 'mixed.ts'), 'x\r\ny\nz\n')
  await assert.rejects(executeWorkspaceTool('edit_file', { path: 'mixed.ts', old_text: 'x\ny', new_text: 'X' }, context), /old_text was not found/)
  await executeWorkspaceTool('edit_file', { path: 'mixed.ts', old_text: 'y\nz', new_text: 'Y\nZ' }, context)
  assert.equal(file('mixed.ts'), 'x\r\nY\nZ\n', 'a mixed file is edited verbatim')
  fs.writeFileSync(path.join(workspace, 'lf.ts'), 'p\nq\n')
  await executeWorkspaceTool('edit_file', { path: 'lf.ts', old_text: 'p\nq', new_text: 'P\nQ' }, context)
  assert.equal(file('lf.ts'), 'P\nQ\n', 'an LF file stays LF')
})

// ---- a vendor's native tools ----------------------------------------------------------------------------

const native = (tool, toolId, status, extra = {}) => ({ kind: 'tool', native: true, tool, toolId, status, text: tool, ...extra })

test('a Claude Edit becomes one change with the line numbers of the file', async t => {
  const workspace = folder(t)
  write(workspace, 'src/x.ts', 'one\ntwo\nTHREE\nfour\n')
  write(workspace, 'src/y.ts', 'a\nB\nc\nd\nE\n')
  const { events } = await run(t, { workspace, provider: async ({ onEvent, events }) => {
    onEvent(native('Edit', 'e1', 'started'))
    onEvent(native('Edit', 'e1', 'running', { input: { file_path: path.join(workspace, 'src', 'x.ts'), old_string: 'three', new_string: 'THREE' } }))
    onEvent({ kind: 'tool', native: true, toolId: 'e1', status: 'completed', text: 'ok' })
    onEvent(native('MultiEdit', 'm1', 'running', { input: { file_path: 'src/y.ts', edits: [{ old_string: 'b', new_string: 'B' }, { old_string: 'e', new_string: 'E' }] } }))
    onEvent({ kind: 'tool', native: true, toolId: 'm1', status: 'completed', text: 'ok' })
    await waitFor(() => events.length >= 2, 'both changes')
    return { text: 'done' }
  } })
  assert.equal(events.length, 2)
  const [edit, multi] = events
  assert.deepEqual([edit.path, edit.tool, edit.kind, edit.source, edit.added, edit.removed, edit.hasDiff], ['src/x.ts', 'Edit', 'modify', 'event', 1, 1, true])
  assert.match(edit.diff, /^--- a\/src\/x\.ts\n\+\+\+ b\/src\/x\.ts\n@@ -3(?:,1)? \+3(?:,1)? @@/)
  assert.match(edit.diff, /\n-three\n\+THREE$/)
  assert.deepEqual([multi.path, multi.tool, multi.added, multi.removed], ['src/y.ts', 'MultiEdit', 2, 2])
  assert.equal(multi.diff.match(/^--- /gm).length, 1, 'one file header for all its edits')
  assert.match(multi.diff, /@@ -2(?:,1)? \+2(?:,1)? @@[^]*@@ -5(?:,1)? \+5(?:,1)? @@/)
})

test('failed or declined native edits produce no change', async t => {
  const workspace = folder(t)
  write(workspace, 'ok.txt', 'a\nb\n')
  const { events } = await run(t, { workspace, provider: async ({ onEvent, events }) => {
    onEvent(native('Edit', 'f1', 'running', { input: { file_path: 'blocked.txt', old_string: 'a', new_string: 'b' } }))
    onEvent({ kind: 'tool', native: true, toolId: 'f1', status: 'failed', text: 'denied' })
    onEvent(native('file_change', 'f2', 'declined', { changes: [{ path: 'declined.txt', kind: 'add' }] }))
    onEvent(native('Write', 'f3', 'running', { input: { file_path: 'refused.txt', content: 'x' } }))
    onEvent({ kind: 'tool', native: true, toolId: 'f3', status: 'failed', text: 'permission' })
    // Changes are made in order, so once this one is there the failed ones would have been.
    onEvent(native('Edit', 'f4', 'completed', { input: { file_path: 'ok.txt', old_string: 'a', new_string: 'a' } }))
    await waitFor(() => events.length >= 1, 'the last change')
    return { text: 'done' }
  } })
  assert.deepEqual(events.map(change => change.path), ['ok.txt'])
})

test('native writes are diffed against Git only for the first write, and never invented', async t => {
  const workspace = repo(t, { 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'bye\n', 'b.txt': 'p\nq\n' })
  if (!workspace) return
  write(workspace, 'a.txt', 'one\n2\nthree\n')
  write(workspace, 'added.txt', 'brand\nnew\n')
  fs.rmSync(path.join(workspace, 'gone.txt'))
  write(workspace, 'untracked.txt', 'hello\n')
  const { events } = await run(t, { workspace, provider: async ({ onEvent, events }) => {
    onEvent(native('Write', 'w1', 'running', { input: { file_path: 'a.txt', content: 'one\n2\nthree\n' } }))
    onEvent({ kind: 'tool', native: true, toolId: 'w1', status: 'completed', text: 'ok' })
    onEvent(native('Write', 'w2', 'completed', { input: { file_path: 'a.txt', content: 'one\n2\nthree\n' } }))
    onEvent(native('fileChange', 'c1', 'completed', { changes: [{ path: 'added.txt', kind: 'add' }, { path: 'gone.txt', kind: 'delete' }] }))
    onEvent(native('Write', 'w3', 'completed', { input: { file_path: 'untracked.txt', content: 'hello\n' } }))
    await waitFor(() => events.length >= 5, 'five changes')
    return { text: 'done' }
  } })
  const by = (rel, index = 0) => events.filter(change => change.path === rel)[index]
  assert.deepEqual([by('a.txt').source, by('a.txt').kind, by('a.txt').added, by('a.txt').removed], ['git', 'modify', 1, 1])
  assert.match(by('a.txt').diff, /\n one\n-two\n\+2\n three$/)
  assert.deepEqual([by('a.txt', 1).hasDiff, by('a.txt', 1).kind], [false, 'unknown'], 'a second write has no known starting point')
  assert.deepEqual([by('added.txt').kind, by('added.txt').source, by('added.txt').added], ['create', 'event', 2])
  assert.match(by('added.txt').diff, /^--- \/dev\/null/)
  assert.deepEqual([by('gone.txt').kind, by('gone.txt').source, by('gone.txt').removed], ['delete', 'git', 1])
  assert.match(by('gone.txt').diff, /\+\+\+ \/dev\/null/)
  assert.deepEqual([by('untracked.txt').hasDiff, by('untracked.txt').kind], [false, 'unknown'])
})

test('a file a command changed gets its diff from Git', async t => {
  const workspace = repo(t, { 'tracked.txt': 'before\n' })
  if (!workspace) return
  const script = "require('fs').writeFileSync('tracked.txt', 'after\\n'); require('fs').writeFileSync('fresh.txt', 'x')"
  const { events } = await run(t, { workspace, provider: async () => envelope(call('run_command', { command: process.execPath, args: ['-e', script] })) })
  await waitFor(() => events.length >= 2, 'the command changes')
  const tracked = events.find(change => change.path === 'tracked.txt')
  assert.deepEqual([tracked.tool, tracked.source, tracked.kind, tracked.added, tracked.removed], ['run_command', 'git', 'modify', 1, 1])
  assert.match(tracked.diff, /^--- a\/tracked\.txt\n\+\+\+ b\/tracked\.txt\n@@ /)
  const fresh = events.find(change => change.path === 'fresh.txt')
  assert.deepEqual([fresh.kind, fresh.source, fresh.hasDiff, fresh.added], ['create', 'exact', true, 1], 'Git knows nothing of an untracked file, so the new text is the diff')
  assert.match(fresh.diff, /^--- \/dev\/null\n\+\+\+ b\/fresh\.txt\n@@ -0,0 \+1 @@\n\+x\n\\ No newline at end of file$/)
})
