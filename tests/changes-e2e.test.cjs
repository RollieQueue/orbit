const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { RunStore } = require('../electron/run-store.mts')
const { nativeChange, commandChange } = require('../electron/change-log.mts')

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

// ---- the vendors' own event streams, as their CLIs emit them ----------------------------------------------

const { _testing: { createClaudeParser, createCodexParser } } = require('../electron/providers.mts')
// Claude Code 2.1.284, `--print --output-format stream-json --verbose --include-partial-messages`: a tool call is a
// content_block_start (name only), input_json_delta pieces, then the complete `assistant` message with the tool_use input,
// and its `user` tool_result. Texts as the owner's saved runs show them ("The file … has been updated successfully.").
function claudeToolCall(id, name, input, result, isError = false) {
  const partial = JSON.stringify(input)
  return [
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } }, session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial.slice(0, 20) } }, session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial.slice(20) } }, session_id: 's1' },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, session_id: 's1' },
    { type: 'assistant', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' }, parent_tool_use_id: null, session_id: 's1' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] }, parent_tool_use_id: null, session_id: 's1' },
  ]
}

test('Claude Code stream-json and Codex exec events, fed through the real parsers, become diffs that survive a restart', async t => {
  const workspace = repo(t, { 'src/FilesTab.tsx': 'import x\nconst a = 1\nconst b = 2\nexport {}\n', 'README.md': 'title\nbody\n', 'lib/gone.txt': 'bye\n' })
  if (!workspace) return
  const userData = folder(t, 'orbit-e2e-store-')
  const runStore = new RunStore(userData)
  const abs = rel => path.join(workspace, ...rel.split('/'))
  const outside = path.join(os.tmpdir(), 'orbit-memory-cleanup.cjs') // the Write of run 9dd5e233: a file outside the workspace
  let turn = 0
  const { runtime, runId, events, snapshot } = await run(t, { workspace, runStore, provider: async ({ onEvent, events }) => {
    turn++
    if (turn === 1) {
      const claude = createClaudeParser(onEvent, 'claude-opus-5-5')
      const feed = lines => { for (const line of lines) claude.line(JSON.stringify(line)) }
      feed([{ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's1', tools: ['Bash', 'Edit', 'Write'], permissionMode: 'bypassPermissions' }])
      feed([{ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }, session_id: 's1' }])
      // Edit: the file already holds the result when the tool_result arrives.
      write(workspace, 'src/FilesTab.tsx', 'import x\nconst a = 1\nconst b = 22\nexport {}\n')
      feed(claudeToolCall('toolu_01Edit', 'Edit', { file_path: abs('src/FilesTab.tsx'), old_string: 'const b = 2', new_string: 'const b = 22' }, `The file ${abs('src/FilesTab.tsx')} has been updated successfully.`))
      // Edit with replace_all and a failed Edit (old_string not found): the failure is no change.
      feed(claudeToolCall('toolu_02Fail', 'Edit', { file_path: abs('README.md'), old_string: 'nope', new_string: 'x' }, '<tool_use_error>String to replace not found in file.\nString: nope</tool_use_error>', true))
      // Write of a new file, Write over a tracked file, Write outside the workspace.
      write(workspace, 'docs/notes.md', '# notes\nfirst\n')
      feed(claudeToolCall('toolu_03Write', 'Write', { file_path: abs('docs/notes.md'), content: '# notes\nfirst\n' }, `File created successfully at: ${abs('docs/notes.md')} (file state is current in your context — no need to Read it back)`))
      write(workspace, 'README.md', 'title\nBODY\n')
      feed(claudeToolCall('toolu_04Write', 'Write', { file_path: abs('README.md'), content: 'title\nBODY\n' }, `The file ${abs('README.md')} has been updated successfully.`))
      feed(claudeToolCall('toolu_05Temp', 'Write', { file_path: outside, content: 'x' }, `File created successfully at: ${outside}`))
      feed(claudeToolCall('toolu_06Bash', 'Bash', { command: 'git status', description: 'Show status' }, 'clean'))
      feed([{ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Готово.' }] }, parent_tool_use_id: null, session_id: 's1' }])
      feed([{ type: 'result', subtype: 'success', is_error: false, result: 'Готово.', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } }])
      await waitFor(() => events.length >= 3, 'the Claude changes')
      // Codex 0.155 `exec --json`: a file_change item announced, then completed, with `changes: [{ path, kind }]` and no diff.
      const codex = createCodexParser(onEvent, 'gpt-5-codex')
      fs.rmSync(abs('lib/gone.txt')); write(workspace, 'lib/added.txt', 'x\ny\n')
      const changes = [{ path: abs('lib/added.txt'), kind: 'add' }, { path: abs('lib/gone.txt'), kind: 'delete' }]
      for (const line of [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.started', item: { id: 'item_1', type: 'file_change', changes, status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes, status: 'completed' } },
        { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: abs('never.txt'), kind: 'add' }], status: 'declined' } },
        { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Готово.' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]) codex.line(JSON.stringify(line))
      assert.equal(codex.finish().text, 'Готово.')
      await waitFor(() => events.length >= 5, 'the Codex changes')
      return claude.finish()
    }
    return { text: 'done' }
  } })

  const by = rel => events.find(change => change.path === rel)
  assert.deepEqual(events.map(change => `${change.tool}:${change.path}`), ['Edit:src/FilesTab.tsx', 'Write:docs/notes.md', 'Write:README.md', 'file_change:lib/added.txt', 'file_change:lib/gone.txt'], 'a failed Edit, a Write outside the workspace and a declined Codex change are no changes')
  const edit = by('src/FilesTab.tsx')
  assert.deepEqual([edit.kind, edit.source, edit.hasDiff, edit.added, edit.removed], ['modify', 'event', true, 1, 1])
  assert.equal(edit.diff, '--- a/src/FilesTab.tsx\n+++ b/src/FilesTab.tsx\n@@ -3 +3 @@\n-const b = 2\n+const b = 22', 'the Edit input gives the exact fragment, the file its line number')
  assert.deepEqual([by('docs/notes.md').kind, by('docs/notes.md').source, by('docs/notes.md').hasDiff], ['create', 'event', true])
  assert.deepEqual([by('README.md').kind, by('README.md').source, by('README.md').hasDiff], ['modify', 'git', true])
  assert.match(by('README.md').diff, /\n-body\n\+BODY$/)
  assert.deepEqual([by('lib/added.txt').kind, by('lib/added.txt').hasDiff, by('lib/gone.txt').kind, by('lib/gone.txt').hasDiff], ['create', true, 'delete', true])
  assert.ok(events.every(change => !('reason' in change)), 'a change with a diff needs no reason')

  // What the window gets: the live snapshot, the change events, then (after a restart) the saved run and its texts.
  assert.deepEqual(plain(snapshot.changes), plain(events))
  assert.ok(snapshot.changes.every(change => change.hasDiff && change.diff))
  runStore.flush()
  const reopened = new RunStore(userData)
  const saved = reopened.getChanges(runId)
  assert.deepEqual(saved.map(change => [change.id, change.diff]), events.map(change => [change.id, change.diff]), 'the diff text survives RunStore.save → a new RunStore → getChanges')
  const listed = reopened.list().find(item => item.runId === runId)
  assert.deepEqual(listed.changes.map(change => [change.hasDiff, 'diff' in change]), events.map(() => [true, false]), 'the list marks hasDiff and carries no text')
  assert.deepEqual(listed.agents[0].files.wrote, ['src/FilesTab.tsx', 'docs/notes.md', 'README.md', 'lib/added.txt', 'lib/gone.txt'])
  assert.deepEqual(await reopened.recoverChanges(runId, runtime.getRunChanges(runId)), [], 'every reported write has its record: nothing to recover')
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
  assert.deepEqual(await commandChange(workspace, 'huge.txt', 'create'), { kind: 'create', source: 'git', reason: 'unreadable' })
  assert.deepEqual(await commandChange(workspace, 'missing.txt', 'create'), { kind: 'create', source: 'git', reason: 'unreadable' })
  assert.deepEqual(await commandChange(workspace, 'missing.txt', 'modify'), { kind: 'modify', source: 'git', reason: 'no-git' })
  assert.deepEqual(await nativeChange(workspace, 'missing.txt', { tool: 'Write', input: {} }, true, 0), { kind: 'unknown', source: 'event', reason: 'no-baseline' })
  // An untracked file is a creation only when it was born after the run began; one that was already there is not guessed at.
  write(workspace, 'untracked.txt', 'here\n')
  const entry = { tool: 'Write', input: { file_path: 'untracked.txt', content: 'here\n' } }
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, true, Date.now() + 60000), { kind: 'unknown', source: 'event', reason: 'no-baseline' })
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, true, Date.now() - 60000), { kind: 'create', source: 'event', before: null, after: 'here\n' })
  assert.deepEqual(await nativeChange(workspace, 'untracked.txt', entry, false, Date.now() - 60000), { kind: 'unknown', source: 'event', reason: 'later-write' }, 'a later write of the run has no known starting point, and the record says so')
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
