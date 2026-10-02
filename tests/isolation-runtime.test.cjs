// Isolated helpers through the runtime (spawn_agent {isolation}), with a fake provider on the envelope transport: the helper
// works in its own git copy, its changes merge into the parent's workspace before the parent is told it is done, the parent
// reads the merge report (conflicts included), nested and follow-up merges work, and the copies go with the run.
// The tests are spread over isolation-runtime*.test.cjs, which run side by side (the fixtures are in helpers-isolation.cjs).
// This part: the merge before the parent is told, a conflict and the patch that keeps the unmerged work, a helper that
// spawns an isolated helper of its own, and held merges (spawn_agent {merge: 'hold'}, merge_agent).
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

// ---- Held merges: spawn_agent {merge: 'hold'} and merge_agent ----------------------------------------------------------------
// The helper of these tests changes three files: it creates one, modifies one and deletes one (in its copy, directly).
const FILES = { 'a.txt': 'l1\nl2\nl3\n', 'gone.txt': 'x\ny\n' }
const EDITS = ({ turn, options }) => {
  if (turn !== 1) return { text: 'Holder done' }
  fs.rmSync(path.join(options.workspace, 'gone.txt'))
  return response(tool('write_file', { path: 'out/new.txt', content: 'n1\nn2\n' }), tool('write_file', { path: 'a.txt', content: 'l1\nCHANGED\nl3\nl4\n' }))
}
const ENDED = ['done', 'error', 'cancelled']
// A run whose root spawns the helper 'Holder' (its own copy, merge 'hold') and waits for it, then follows `script`: one
// function per later root turn, given the run's pieces (the target `workspace`, the `seen` ids and copy, the live `run`) and
// returning the root's tool calls or its answer. `work` is the helper's, `others` are more agents by name. Resolves with the
// finished run; `told(tool)` are what the tool results were, in order (the observation traces).
async function heldRun(t, { files = FILES, work = EDITS, script, others = {}, spawn = {} }) {
  const workspace = repo(t, files), root = folder(t, 'copies')
  const seen = { ids: {} }, turns = {}, events = []
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name, id] = identity(options.prompt)
    seen.ids[name] = id
    const turn = turns[name] = (turns[name] || 0) + 1
    const context = { runtime, workspace, root, seen, turn, options, run: [...runtime.runs.values()][0] }
    if (name === 'Orbit') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'Holder', task: 'Change files', reason: 'Edits files for a contest', isolation: 'worktree', merge: 'hold', ...spawn }), tool('wait_agent'))
      return script[turn - 2](context)
    }
    if (name === 'Holder') { if (turn === 1) Object.assign(seen, { copy: options.workspace, helperPrompt: options.prompt }); return work(context) }
    return others[name](context)
  } })
  runtime.onEvent(event => events.push(event))
  const { snapshot, runId } = await finished(runtime, payload(workspace))
  const told = name => snapshot.traces.filter(trace => trace.kind === 'observation' && trace.text.startsWith(`${name}: `)).map(trace => trace.text)
  return { runtime, runId, snapshot, workspace, root, seen, events, told, holder: snapshot.agents.find(agent => agent.name === 'Holder') }
}
const decide = (context, action) => response(tool('merge_agent', { agentId: context.seen.ids.Holder, action }))
const isolationOf = context => context.run.agentNodes.get(context.seen.ids.Holder).isolation

test('merge hold: nothing is merged, the result says what is held, and a patch keeps the changes when the run ends undecided', async t => {
  const state = {}
  const { snapshot, workspace, root, seen, holder, runId, runtime } = await heldRun(t, { script: [context => {
    state.out = present(context.workspace, 'out', 'new.txt')
    return { text: 'Left it undecided' }
  }] })
  assert.equal(snapshot.status, 'completed')
  assert.equal(state.out, false, 'the helper\'s new file is not in the target when the parent is told')
  assert.equal(read(workspace, 'a.txt'), 'l1\nl2\nl3\n')
  assert.equal(present(workspace, 'gone.txt'), true)
  assert.equal(present(workspace, 'out'), false)
  assert.deepEqual([holder.status, holder.isolation.held, holder.isolation.decided, holder.isolation.merged], ['done', true, undefined, undefined])
  assert.match(seen.helperPrompt, /ISOLATED COPY: .*Your parent decides whether your uncommitted changes are merged when you finish \(Orbit holds them until then\)\./, 'the helper is told its changes are held')
  assert.match(holder.result, /^HELD MERGE: the helper's changes are HELD and not merged into /)
  assert.match(holder.result, /Changes: 3 file\(s\) \(1 added, 1 deleted, 1 modified\), \+4 -3 lines\./, 'counted the way a merge counts: the new file included, with its lines')
  assert.match(holder.result, /added: out\/new\.txt; deleted: gone\.txt; modified: a\.txt\./)
  assert.ok(holder.result.includes(`Copy (a git worktree): ${seen.copy}; base commit ${holder.isolation.base.slice(0, 7)}.`))
  assert.ok(holder.result.includes(`git -C "${seen.copy}" diff ${holder.isolation.base.slice(0, 7)}`), 'the command that shows the diff')
  assert.ok(holder.result.includes(`merge_agent {agentId: "${holder.id}", action: "merge"}`))
  assert.deepEqual(snapshot.changes, [], 'no change record: nothing was written to the target')
  const note = await until(() => runtime.getRun(runId).traces.find(trace => trace.kind === 'isolation' && /^Changes of Holder that were never merged/.test(trace.text)))
  assert.match(note.text, /^Changes of Holder that were never merged into .* are saved as a patch: /)
  const patches = path.join(root, 'patches')
  const patch = read(patches, fs.readdirSync(patches)[0])
  assert.match(patch, /\+CHANGED/)
  assert.match(patch, /new file mode[\s\S]*\+n1/, 'the new file is in the patch')
  assert.match(patch, /deleted file mode/)
  await until(() => fs.readdirSync(root).join() === 'patches')
})

test('merge_agent merge: exactly the automatic merge: the files land, with change records, and the copy goes with the run', async t => {
  const state = {}
  const { snapshot, workspace, root, holder, events, told } = await heldRun(t, { script: [
    context => decide(context, 'merge'),
    context => { Object.assign(state, { out: present(context.workspace, 'out', 'new.txt'), decided: isolationOf(context).decided }); return decide(context, 'merge') },
    () => ({ text: 'Merged' }),
  ] })
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(state, { out: true, decided: 'merge' }, 'merged by the time the parent\'s next turn begins')
  assert.equal(read(workspace, 'out/new.txt'), 'n1\nn2\n')
  assert.equal(read(workspace, 'a.txt'), 'l1\nCHANGED\nl3\nl4\n')
  assert.equal(present(workspace, 'gone.txt'), false)
  assert.deepEqual(snapshot.changes.map(change => [change.path, change.kind, change.tool, change.agentId]).sort(), [['a.txt', 'modify', 'merge', holder.id], ['gone.txt', 'delete', 'merge', holder.id], ['out/new.txt', 'create', 'merge', holder.id]])
  assert.deepEqual([holder.isolation.held, holder.isolation.decided, holder.isolation.merged, holder.isolation.conflicts], [true, 'merge', 3, []])
  const reports = snapshot.traces.filter(trace => trace.kind === 'isolation' && trace.agentId === holder.id).map(trace => trace.text)
  assert.match(reports[0], /^HELD MERGE/)
  assert.match(reports[1], /^ISOLATED COPY MERGED into .*: 3 file\(s\) \(created: out\/new\.txt; modified: a\.txt; deleted: gone\.txt\)/)
  const [done, again] = told('merge_agent')
  assert.match(done, /^merge_agent: \{"ok":true,"agentId":".*","action":"merge","report":"ISOLATED COPY MERGED into/)
  assert.match(again, /merge was already decided \(merge\)/, 'a second decision is refused')
  assert.equal(events.some(event => event.type === 'agent.updated' && event.agent?.id === holder.id && event.agent.isolation?.decided === 'merge'), true, 'the decision is published (and saved with the run)')
  await until(() => fs.readdirSync(root).length === 0)
})

test('merge_agent discard: the target stays as it was, the copy is gone, a patch keeps the changes, and the helper cannot be continued', async t => {
  const state = {}
  const { snapshot, workspace, root, holder, told } = await heldRun(t, { script: [
    context => decide(context, 'discard'),
    context => { Object.assign(state, { copyThere: fs.existsSync(context.seen.copy), out: present(context.workspace, 'out', 'new.txt') }); return response(tool('followup_agent', { agentId: 'Holder', task: 'Try again', reason: 'Another go' }), tool('send_message', { agentId: 'Holder', message: 'Are you there?' })) },
    context => decide(context, 'merge'),
    () => ({ text: 'Discarded' }),
  ] })
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(state, { copyThere: false, out: false }, 'the copy was removed before the parent\'s next turn')
  assert.equal(read(workspace, 'a.txt'), 'l1\nl2\nl3\n')
  assert.equal(present(workspace, 'gone.txt'), true)
  assert.deepEqual(snapshot.changes, [])
  assert.deepEqual([holder.isolation.held, holder.isolation.decided, holder.isolation.merged], [true, 'discard', undefined])
  const patches = path.join(root, 'patches')
  assert.equal(fs.readdirSync(patches).length, 1)
  assert.match(read(patches, fs.readdirSync(patches)[0]), /\+CHANGED/)
  const [discard, merge] = told('merge_agent')
  assert.match(discard, /DISCARDED: the changes of Holder were dropped and not merged into /)
  assert.match(discard, /Its isolated copy was removed\./)
  assert.match(discard, /kept as a patch: .*\.patch \(apply it with: git -C/)
  assert.match(told('followup_agent')[0], /Holder was discarded with merge_agent and its isolated copy is gone, so it cannot continue/)
  assert.match(told('send_message')[0], /Holder was discarded with merge_agent and its isolated copy is gone, so it cannot be messaged/, 'a message would wake it in a folder that is gone')
  assert.match(merge, /merge was already decided \(discard\)/)
  await until(() => fs.readdirSync(root).join() === 'patches')
})

test('merge_agent refuses clearly: still working, not isolated, not held, unknown, a bad action, already decided, the run over', async t => {
  const workspace = repo(t, FILES), root = folder(t, 'copies')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const turns = {}
  let runtime, refused = false
  const settled = () => [...[...runtime.runs.values()][0].agentNodes.values()].filter(agent => agent.id !== 'root').every(agent => ENDED.includes(agent.status))
  runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    const turn = turns[name] = (turns[name] || 0) + 1
    if (name === 'Orbit') {
      if (turn === 1) return response(
        tool('spawn_agent', { name: 'Holder', task: 'Change files', reason: 'Contest', isolation: 'worktree', merge: 'hold' }),
        tool('spawn_agent', { name: 'Auto', task: 'Write auto.txt', reason: 'Edits', isolation: 'worktree' }),
        tool('spawn_agent', { name: 'Plain', task: 'Say hi', reason: 'No files' }),
        tool('merge_agent', { agentId: 'Holder', action: 'merge' }))
      if (turn === 2) { release(); return response(tool('wait_agent')) }
      if (!settled()) return response(tool('wait_agent'))
      if (refused) return { text: 'Refused' }
      refused = true
      return response(...[['Plain', 'merge'], ['Auto', 'merge'], ['nobody', 'merge'], ['Holder', 'bogus'], ['Holder', 'merge'], ['Holder', 'discard']].map(([agentId, action]) => tool('merge_agent', { agentId, action })))
    }
    if (name === 'Holder') { await gate; return EDITS({ turn, options }) }
    if (name === 'Auto') return turn === 1 ? response(tool('write_file', { path: 'auto.txt', content: 'auto\n' })) : { text: 'Auto done' }
    return { text: 'Hi' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  const told = snapshot.traces.filter(trace => trace.kind === 'observation' && trace.text.startsWith('merge_agent: ')).map(trace => trace.text)
  assert.equal(told.length, 7)
  assert.match(told[0], /"ok":false,"error":"Holder is still working: decide when it has finished/)
  assert.match(told[1], /Plain is not isolated: only a helper spawned with isolation and merge 'hold' has a merge to decide/)
  assert.match(told[2], /Auto's merge was not held \(spawned without merge 'hold'\): Orbit merges its changes by itself when it finishes/)
  assert.match(told[3], /Agent not found in this run/)
  assert.match(told[4], /merge_agent action is 'merge' or 'discard'/)
  assert.match(told[5], /^merge_agent: \{"ok":true,.*"action":"merge"/, 'the refused calls before it left the helper undecided: its merge went through')
  assert.match(told[6], /Holder's merge was already decided \(merge\)/)
  assert.equal(read(workspace, 'auto.txt'), 'auto\n', 'the helper that was not held merged by itself')
  assert.equal(read(workspace, 'out/new.txt'), 'n1\nn2\n')
  // The run is over: its copies are taken away already.
  const run = runtime.runs.get(runId)
  await assert.rejects(runtime.executeTool(run, run.agentNodes.get('root'), 'merge_agent', { agentId: 'Holder', action: 'merge' }), /The run has ended/)
  await until(() => fs.readdirSync(root).length === 0)
})

test('merge_agent is for the helper\'s parent or the root: a sibling is refused and changes nothing, the parent decides', async t => {
  const workspace = repo(t, FILES), root = folder(t, 'copies')
  const turns = {}, seen = { ids: {} }
  const later = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
  const childDone = later(), intruderDone = later()
  let runtime
  const settled = () => [...[...runtime.runs.values()][0].agentNodes.values()].filter(agent => agent.id !== 'root').every(agent => ENDED.includes(agent.status))
  runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name, id] = identity(options.prompt)
    seen.ids[name] = id
    const turn = turns[name] = (turns[name] || 0) + 1
    if (name === 'Orbit') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'Mid', task: 'Have a helper change files', reason: 'Delegates' }), tool('spawn_agent', { name: 'Intruder', task: 'Wait, then try', reason: 'A sibling' }), tool('wait_agent'))
      return settled() ? { text: 'All done' } : response(tool('wait_agent'))
    }
    if (name === 'Mid') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'Child', task: 'Change files', reason: 'Contest', isolation: 'worktree', merge: 'hold' }), tool('wait_agent'))
      if (turn === 2) {
        childDone.resolve()
        await intruderDone.promise
        seen.beforeParent = { out: fs.existsSync(path.join(workspace, 'out', 'new.txt')), decided: [...runtime.runs.values()][0].agentNodes.get(seen.ids.Child).isolation.decided }
        return response(tool('merge_agent', { agentId: seen.ids.Child, action: 'merge' }))
      }
      return { text: 'Mid merged its helper' }
    }
    if (name === 'Intruder') {
      if (turn === 1) { await childDone.promise; return response(tool('merge_agent', { agentId: seen.ids.Child, action: 'merge' })) }
      intruderDone.resolve()
      return { text: 'Tried' }
    }
    return EDITS({ turn, options })
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  const [mid, intruder, child] = ['Mid', 'Intruder', 'Child'].map(name => snapshot.agents.find(agent => agent.name === name))
  const told = agent => snapshot.traces.filter(trace => trace.kind === 'observation' && trace.agentId === agent.id && trace.text.startsWith('merge_agent: ')).map(trace => trace.text)
  assert.match(told(intruder)[0], /merge_agent decides only for your own direct helpers; Child is not one \(the root decides for any helper\)/)
  assert.deepEqual(seen.beforeParent, { out: false, decided: undefined }, 'the refused call changed nothing')
  assert.match(told(mid)[0], /^merge_agent: \{"ok":true,.*"action":"merge"/, 'the helper\'s own parent decides')
  assert.equal(read(workspace, 'out/new.txt'), 'n1\nn2\n')
  assert.deepEqual([child.parentId, child.isolation.decided, child.isolation.merged], [mid.id, 'merge', 3])
  await until(() => fs.readdirSync(root).length === 0)
})

test('followup of a held helper continues in its copy and stays held; the decision then merges everything it did', async t => {
  const state = {}
  const work = context => context.turn === 3 ? response(tool('write_file', { path: 'second.txt', content: 's\n' })) : EDITS(context)
  const { snapshot, workspace, holder } = await heldRun(t, { work, script: [
    () => response(tool('followup_agent', { agentId: 'Holder', task: 'Also write second.txt', reason: 'More' }), tool('wait_agent')),
    context => {
      const record = context.run.agentNodes.get(context.seen.ids.Holder)
      Object.assign(state, { second: present(context.workspace, 'second.txt'), out: present(context.workspace, 'out', 'new.txt'), result: record.result, held: record.isolation.held, decided: record.isolation.decided, generation: record.generation })
      return decide(context, 'merge')
    },
    () => ({ text: 'Merged both' }),
  ] })
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual([state.second, state.out, state.held, state.decided, state.generation], [false, false, true, undefined, 1], 'still held after the follow-up')
  assert.match(state.result, /^HELD MERGE: [\s\S]*Changes: 4 file\(s\) \(2 added, 1 deleted, 1 modified\)/, 'the second report counts the follow-up\'s file with the first work')
  assert.equal(read(workspace, 'second.txt'), 's\n')
  assert.equal(read(workspace, 'out/new.txt'), 'n1\nn2\n')
  assert.deepEqual([holder.isolation.decided, holder.isolation.merged], ['merge', 4])
})

test('two decisions at once: one goes through, the other is refused, and nothing is merged twice', async t => {
  const outcomes = {}
  const race = (context, actions) => {
    const root = context.run.agentNodes.get('root')
    return Promise.allSettled(actions.map(action => context.runtime.executeTool(context.run, root, 'merge_agent', { agentId: context.seen.ids.Holder, action })))
  }
  const twice = await heldRun(t, { script: [async context => { outcomes.twice = await race(context, ['merge', 'merge']); return { text: 'Raced' } }] })
  assert.deepEqual(outcomes.twice.map(item => item.status), ['fulfilled', 'rejected'])
  assert.match(outcomes.twice[1].reason.message, /already decided \(merge\)/)
  assert.equal(twice.snapshot.changes.filter(change => change.path === 'out/new.txt').length, 1, 'one change record for the file')
  assert.equal(twice.holder.isolation.merged, 3)
  const mixed = await heldRun(t, { script: [async context => { outcomes.mixed = await race(context, ['discard', 'merge']); return { text: 'Raced' } }] })
  assert.deepEqual(outcomes.mixed.map(item => item.status), ['fulfilled', 'rejected'])
  assert.match(outcomes.mixed[1].reason.message, /already decided \(discard\)/)
  assert.equal(present(mixed.workspace, 'out'), false, 'the losing merge wrote nothing')
  assert.deepEqual(mixed.snapshot.changes, [])
  assert.equal(mixed.holder.isolation.decided, 'discard')
})

test('a merge that fails outright is not a decision: the helper stays held and can still be discarded', async t => {
  const state = {}
  const { snapshot, holder, told } = await heldRun(t, { script: [
    context => { fs.rmSync(context.seen.copy, { recursive: true, force: true }); return decide(context, 'merge') },
    context => { Object.assign(state, { decided: isolationOf(context).decided, deciding: context.run.deciding.size }); return decide(context, 'discard') },
    () => ({ text: 'Gave up' }),
  ] })
  assert.equal(snapshot.status, 'completed')
  const [failed, discarded] = told('merge_agent')
  assert.match(failed, /ISOLATED COPY MERGE FAILED: the copy .* no longer exists/)
  assert.match(failed, /The merge is NOT decided: Holder is still held/)
  assert.equal(state.decided, undefined, 'a failed merge left no decision behind')
  assert.equal(state.deciding, 0, 'and no mark that a decision is under way')
  assert.match(discarded, /"ok":true,.*"action":"discard"/)
  assert.equal(holder.isolation.decided, 'discard')
})

// ---- A decision under way: nothing starts the helper in the copy the decision reads or removes -------------------------------------
// Makes the next operation Orbit tracks for `agentId` (the merge or the discard of a held helper) slow: `began` settles when it
// is under way and it ends only after `release()`, failing with `error` when one is given (the files are merged all the same).
function slowOperation(runtime, agentId, error) {
  const original = runtime.trackOperation
  let began, release
  const started = new Promise(resolve => { began = resolve }), gate = new Promise(resolve => { release = resolve })
  runtime.trackOperation = function (run, operation, agent) {
    if (agent.id !== agentId) return original.call(this, run, operation, agent)
    delete runtime.trackOperation
    began()
    return original.call(this, run, Promise.resolve(operation).then(async value => { await gate; if (error) throw error; return value }), agent)
  }
  return { began: started, release }
}
// What a call that is refused says (or 'accepted'), so that a test reads the reasons side by side.
const verdict = call => Promise.resolve().then(call).then(() => 'accepted', error => error.message)
const reach = ({ runtime, run, seen }) => {
  const root = run.agentNodes.get('root'), record = run.agentNodes.get(seen.ids.Holder)
  return {
    root, record,
    followup: () => verdict(() => runtime.executeTool(run, root, 'followup_agent', { agentId: 'Holder', task: 'Also write second.txt', reason: 'More' })),
    message: () => verdict(() => runtime.executeTool(run, root, 'send_message', { agentId: 'Holder', message: 'Are you there?' })),
    user: () => verdict(() => runtime.postUserMessage(run.runId, record.id, 'Привет')),
    decision: action => runtime.executeTool(run, root, 'merge_agent', { agentId: record.id, action }),
  }
}
const second = context => context.turn === 3 ? response(tool('write_file', { path: 'second.txt', content: 's\n' })) : EDITS(context)

test('while a merge decision is under way, followup_agent and messages do not start the helper in its copy; once it is over they do', async t => {
  const state = {}
  const { snapshot, workspace, holder } = await heldRun(t, { work: context => { state.turns = context.turn; return second(context) }, script: [
    async context => {
      const { runtime, run } = context
      const { record, root, followup, message, user, decision } = reach(context)
      const slow = slowOperation(runtime, record.id)
      const merging = decision('merge')
      await slow.began
      const broadcast = (await runtime.executeTool(run, root, 'broadcast_message', { message: 'Anybody?' })).deliveries.find(item => item.agentId === record.id)
      state.during = { marked: run.deciding.get(record.id), followup: await followup(), message: await message(), user: await user(), broadcast: broadcast.error,
        helper: [record.status, record.generation, state.turns], mail: run.communications.filter(item => item.toAgentId === record.id && item.kind === 'message').length }
      slow.release()
      state.merged = (await merging).report
      state.after = { marked: run.deciding.has(record.id), out: present(context.workspace, 'out', 'new.txt') }
      return response(tool('followup_agent', { agentId: 'Holder', task: 'Also write second.txt', reason: 'More' }), tool('wait_agent'))
    },
    context => {
      Object.assign(state, { second: present(context.workspace, 'second.txt'), generation: context.run.agentNodes.get(context.seen.ids.Holder).generation })
      return { text: 'Continued after the merge' }
    },
  ] })
  assert.equal(snapshot.status, 'completed')
  const { during } = state
  assert.equal(during.marked, 'merge')
  assert.match(during.followup, /^A merge decision for Holder is in progress \(merge_agent\) and it would work in the copy that decision uses; try again when it finishes$/, 'the old "still cleaning up" refusal would not name the decision')
  assert.match(during.message, /^A merge decision for Holder is in progress \(merge_agent\) and a message would wake it in the copy that decision uses; try again when it finishes$/)
  assert.match(during.user, /^Решение merge_agent \(слить\) для Holder ещё выполняется/)
  assert.match(during.broadcast, /^A merge decision for Holder is in progress/, 'broadcast_message and ask_team go through the same refusal')
  assert.deepEqual([during.helper, during.mail], [['done', 0, 2], 0], 'the helper did not work again, and no message was left in its mailbox')
  assert.match(state.merged, /^ISOLATED COPY MERGED into /)
  assert.deepEqual(state.after, { marked: false, out: true })
  assert.equal(state.generation, 1, 'after the decision the followup went through')
  assert.equal(state.second, true, 'the helper worked in its copy again, and its next result merged like any other')
  assert.equal(read(workspace, 'second.txt'), 's\n')
  assert.deepEqual([holder.isolation.decided, holder.isolation.merged], ['merge', 4])
})

test('while a discard decision is under way the helper is refused the same way; once discarded it still cannot be continued', async t => {
  const state = {}
  await heldRun(t, { script: [
    async context => {
      const { runtime, run } = context
      const { record, followup, message, user, decision } = reach(context)
      const slow = slowOperation(runtime, record.id)
      const discarding = decision('discard')
      await slow.began
      state.during = { marked: run.deciding.get(record.id), followup: await followup(), message: await message(), user: await user() }
      slow.release()
      await discarding
      state.after = { marked: run.deciding.has(record.id), followup: await followup(), message: await message(), user: await user() }
      return { text: 'Discarded' }
    },
  ] })
  assert.equal(state.during.marked, 'discard')
  assert.match(state.during.followup, /^A discard decision for Holder is in progress \(merge_agent\)/)
  assert.match(state.during.message, /^A discard decision for Holder is in progress \(merge_agent\)/)
  assert.match(state.during.user, /^Решение merge_agent \(отбросить\) для Holder ещё выполняется/)
  assert.equal(state.after.marked, false)
  assert.match(state.after.followup, /Holder was discarded with merge_agent and its isolated copy is gone, so it cannot continue/)
  assert.match(state.after.message, /Holder was discarded with merge_agent and its isolated copy is gone, so it cannot be messaged/)
  assert.match(state.after.user, /Holder отброшен \(merge_agent\)/)
})

test('a merge that throws does not leave the helper blocked: the mark is cleared and followup_agent works', async t => {
  const state = {}
  const { workspace } = await heldRun(t, { work: second, script: [
    async context => {
      const { run } = context
      const { record, followup, decision } = reach(context)
      const slow = slowOperation(context.runtime, record.id, new Error('the merge blew up'))
      const merging = decision('merge').then(() => 'merged', error => error.message)
      await slow.began
      state.during = { marked: run.deciding.get(record.id), followup: await followup() }
      slow.release()
      state.outcome = await merging
      state.after = { marked: run.deciding.has(record.id), generation: record.generation }
      return response(tool('followup_agent', { agentId: 'Holder', task: 'Also write second.txt', reason: 'More' }), tool('wait_agent'))
    },
    context => { state.generation = context.run.agentNodes.get(context.seen.ids.Holder).generation; return { text: 'Continued' } },
  ] })
  assert.equal(state.during.marked, 'merge')
  assert.match(state.during.followup, /^A merge decision for Holder is in progress/)
  assert.equal(state.outcome, 'the merge blew up')
  assert.deepEqual(state.after, { marked: false, generation: 0 })
  assert.equal(state.generation, 1, 'the followup was accepted and the helper ran again')
  assert.equal(read(workspace, 'second.txt'), 's\n', 'and its work merged')
})
