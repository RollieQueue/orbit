// The whole path of a file change (see changes-e2e.test.cjs) while something else is going on: a change still being made
// when the agent answers is part of the finished run, and a command does not claim a file another agent wrote while it ran.
// The second test lets a command run for a second and a half, which is most of this file's time and why these two are not
// with the others.
const test = require('node:test')
const assert = require('node:assert/strict')
const { folder, write, repo, call, envelope, native, run } = require('./helpers-changes-e2e.cjs')

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
