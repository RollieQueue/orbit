// Isolated helpers through the runtime (spawn_agent {isolation}), with a fake provider on the envelope transport: the helper
// works in its own git copy, its changes merge into the parent's workspace before the parent is told it is done, the parent
// reads the merge report (conflicts included), nested and follow-up merges work, and the copies go with the run.
// The tests are spread over isolation-runtime*.test.cjs, which run side by side (the fixtures are in helpers-isolation.cjs).
// This part: the merge before the parent is told, a conflict and the patch that keeps the unmerged work, and a helper that
// spawns an isolated helper of its own.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { git, folder, repo, tool, response, identity, payload, finished, until, read, present } = require('./helpers-isolation.cjs')

test('an isolated helper works in its own copy; its file lands in the parent\'s workspace before the parent is told it is done, with the merge report', async t => {
  const workspace = repo(t), root = folder(t, 'copies')
  const seen = {}
  let rootTurn = 0, helperTurn = 0
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Orbit') {
      if (++rootTurn === 1) return response(tool('spawn_agent', { name: 'Writer', task: 'Write out/result.txt', reason: 'Edits files while others work', isolation: 'worktree' }), tool('wait_agent'))
      Object.assign(seen, { rootPrompt: options.prompt, mergedWhenToldDone: present(workspace, 'out', 'result.txt') })
      return { text: 'All merged' }
    }
    if (++helperTurn === 1) {
      Object.assign(seen, { helperPrompt: options.prompt, helperWorkspace: options.workspace })
      return response(tool('write_file', { path: 'out/result.txt', content: 'from the helper\n' }))
    }
    seen.visibleWhileWorking = present(workspace, 'out', 'result.txt')
    return { text: 'Wrote out/result.txt' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.ok(seen.helperWorkspace.startsWith(`${root}${path.sep}`), 'the helper runs in a copy under the worktrees folder')
  assert.ok(seen.helperPrompt.includes(`workspace=${seen.helperWorkspace}`), 'its prompt names the copy as its workspace')
  assert.match(seen.helperPrompt, /ISOLATED COPY: your workspace is a git worktree copy of .*never commit, stash, checkout or reset/)
  assert.equal(seen.visibleWhileWorking, false, 'the helper\'s file is not in the parent\'s workspace while it works')
  assert.equal(seen.mergedWhenToldDone, true, 'it is there by the time the parent\'s wait_agent returns')
  assert.match(seen.rootPrompt, /ISOLATED COPY MERGED into/)
  assert.match(seen.rootPrompt, /created: out\/result\.txt/)
  assert.equal(read(workspace, 'out', 'result.txt'), 'from the helper\n')
  assert.equal(git(workspace, 'diff', '--cached', '--name-only'), '', 'nothing is staged in the parent\'s repository')
  const writer = snapshot.agents.find(agent => agent.name === 'Writer')
  assert.deepEqual({ ...writer.isolation, base: undefined }, { kind: 'worktree', path: seen.helperWorkspace, base: undefined, target: workspace, merged: 1, conflicts: [] })
  assert.match(writer.isolation.base, /^[0-9a-f]{40}$/)
  assert.match(writer.result, /^ISOLATED COPY MERGED into .*\n\nWrote out\/result\.txt$/, 'the report leads the helper\'s own answer')
  const change = snapshot.changes.find(item => item.path === 'out/result.txt')
  assert.deepEqual([change.agentId, change.tool, change.kind, change.added], [writer.id, 'merge', 'create', 1], 'the merged file is the helper\'s change in the Changes tab')
  assert.ok(writer.files.wrote.includes('out/result.txt'), 'and its write in the file map')
  await until(() => fs.readdirSync(root).length === 0)
  assert.equal(git(workspace, 'worktree', 'list').split('\n').length, 1, 'the copy is taken away when the run ends')
})

test('a conflict is reported to the parent, the parent\'s file stays, and the unmerged work is kept as a patch named in a trace', async t => {
  const workspace = repo(t), root = folder(t, 'copies')
  const seen = {}
  let rootTurn = 0, helperTurn = 0
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Orbit') {
      if (++rootTurn === 1) return response(tool('spawn_agent', { name: 'Writer', task: 'Change a.txt', reason: 'Edits a file', isolation: 'worktree' }), tool('wait_agent'))
      seen.rootPrompt = options.prompt
      return { text: 'Conflict seen' }
    }
    if (++helperTurn === 1) return response(tool('write_file', { path: 'a.txt', content: 'l1\nHELPER\nl3\n' }))
    // The parent edits the same line in its own workspace while the helper works.
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'l1\nPARENT\nl3\n')
    return { text: 'Edited a.txt' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.match(seen.rootPrompt, /CONFLICTS: 1 file\(s\) were NOT merged/)
  assert.match(seen.rootPrompt, /changed on both sides and the changes overlap/)
  assert.equal(read(workspace, 'a.txt'), 'l1\nPARENT\nl3\n', 'the parent\'s version is untouched')
  const writer = snapshot.agents.find(agent => agent.name === 'Writer')
  assert.equal(writer.status, 'done')
  assert.deepEqual([writer.isolation.merged, writer.isolation.conflicts], [0, ['a.txt']])
  assert.match(writer.result, /^CONFLICTS: 1 file\(s\)/)
  assert.deepEqual(snapshot.changes.filter(item => item.path === 'a.txt'), [], 'nothing was written, so there is no change to show')
  // The note is traced once the patch is complete (git is still writing the file before that).
  const note = await until(() => runtime.getRun(runId).traces.find(trace => trace.kind === 'isolation' && /saved as a patch/.test(trace.text)))
  // --3way: a plain apply fails as a whole exactly when the patch holds the conflicted files.
  assert.match(note.text, /git -C ".*" apply --3way ".*\.patch"/)
  const patches = path.join(root, 'patches')
  assert.equal(fs.readdirSync(patches).length, 1)
  assert.match(read(patches, fs.readdirSync(patches)[0]), /\+HELPER/, 'the helper\'s version is kept')
  await until(() => fs.readdirSync(root).join() === 'patches')
})

test('a helper that spawns an isolated helper of its own: the changes reach the original through two merges', async t => {
  const workspace = repo(t), root = folder(t, 'copies')
  const seen = {}, turns = {}
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    const turn = turns[name] = (turns[name] || 0) + 1
    if (name === 'Orbit') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'Child', task: 'Work with a helper', reason: 'Edits files', isolation: 'worktree' }), tool('wait_agent'))
      seen.original = { g: present(workspace, 'g.txt'), c: present(workspace, 'c.txt') }
      return { text: 'Done' }
    }
    if (name === 'Child') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'GrandChild', task: 'Write g.txt', reason: 'Edits a file', isolation: 'worktree' }), tool('wait_agent'))
      if (turn === 2) {
        Object.assign(seen, { childWorkspace: options.workspace, grandInChildCopy: present(options.workspace, 'g.txt'), grandInOriginal: present(workspace, 'g.txt') })
        return response(tool('write_file', { path: 'c.txt', content: 'child\n' }))
      }
      return { text: 'Child done' }
    }
    if (turn === 1) { seen.grandWorkspace = options.workspace; return response(tool('write_file', { path: 'g.txt', content: 'grandchild\n' })) }
    return { text: 'GrandChild done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual([seen.grandInChildCopy, seen.grandInOriginal], [true, false], 'the grandchild\'s file merged into the child\'s copy first')
  assert.deepEqual(seen.original, { g: true, c: true }, 'and both files reached the original by the time the root was told')
  assert.equal(read(workspace, 'g.txt'), 'grandchild\n')
  assert.notEqual(seen.grandWorkspace, seen.childWorkspace)
  const [child, grand] = ['Child', 'GrandChild'].map(name => snapshot.agents.find(agent => agent.name === name))
  assert.equal(child.isolation.target, workspace)
  assert.equal(grand.isolation.target, seen.childWorkspace, 'a nested copy merges into its parent\'s copy')
  assert.equal(grand.isolation.merged, 1)
  assert.equal(child.isolation.merged, 2, 'the child merged its own file and the grandchild\'s')
  await until(() => fs.readdirSync(root).length === 0)
  assert.equal(git(workspace, 'worktree', 'list').split('\n').length, 1)
})
