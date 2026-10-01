// Isolated helpers through the runtime (spawn_agent {isolation}), with a fake provider on the envelope transport: the helper
// works in its own git copy, its changes merge into the parent's workspace before the parent is told it is done, the parent
// reads the merge report (conflicts included), nested and follow-up merges work, and the copies go with the run.
// The tests are spread over isolation-runtime*.test.cjs, which run side by side (the fixtures are in helpers-isolation.cjs).
// This part: a follow-up merge, isolation 'orbit', refused requests, a stopped run's cleanup, and the session block of an
// isolated helper.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { sessionGuide } = require('../electron/runtime/prompts.mts')
const { git, folder, repo, tool, response, identity, payload, finished, until, read, present } = require('./helpers-isolation.cjs')

test('a follow-up of an isolated helper merges again, and only what is new', async t => {
  const workspace = repo(t), root = folder(t, 'copies')
  const turns = {}
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    const turn = turns[name] = (turns[name] || 0) + 1
    if (name === 'Orbit') {
      if (turn === 1) return response(tool('spawn_agent', { name: 'Writer', task: 'Write f1.txt', reason: 'Edits files', isolation: 'worktree' }), tool('wait_agent'))
      if (turn === 2) return response(tool('followup_agent', { agentId: 'Writer', task: 'Also write f2.txt' }), tool('wait_agent'))
      return { text: 'Both merged' }
    }
    if (turn === 1) return response(tool('write_file', { path: 'f1.txt', content: 'one\n' }))
    if (turn === 3) return response(tool('write_file', { path: 'f2.txt', content: 'two\n' }))
    return { text: turn === 2 ? 'first done' : 'second done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual([read(workspace, 'f1.txt'), read(workspace, 'f2.txt')], ['one\n', 'two\n'])
  const writer = snapshot.agents.find(agent => agent.name === 'Writer')
  assert.deepEqual([writer.generation, writer.isolation.merged, writer.isolation.conflicts], [1, 2, []])
  const reports = snapshot.traces.filter(trace => trace.kind === 'isolation' && trace.agentId === writer.id)
  assert.equal(reports.length, 2)
  assert.match(reports[0].text, /created: f1\.txt/)
  assert.match(reports[1].text, /1 file\(s\) \(created: f2\.txt\)/)
  assert.doesNotMatch(reports[1].text, /f1\.txt/, 'the second merge does not apply the first one again')
  await until(() => fs.readdirSync(root).length === 0)
})

test('isolation orbit copies Orbit\'s own repository from any project and merges there, not into the project', async t => {
  const project = folder(t, 'project'), orbit = repo(t, { 'electron/main.txt': 'main\n' }), root = folder(t, 'copies')
  fs.writeFileSync(path.join(project, 'README.md'), 'a project that is no git repository')
  const host = { available: false, repoRoot: orbit, resumeFile: '', userData: '', request: async () => { throw new Error('unused') }, inFlight: () => null }
  const seen = {}
  let rootTurn = 0, helperTurn = 0
  const runtime = new OrbitRuntime({ worktreeRoot: root, restartHost: host, runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Orbit') {
      if (++rootTurn === 1) return response(tool('spawn_agent', { name: 'Improver', task: 'Add electron/new.txt', reason: 'Improves Orbit', isolation: 'orbit' }), tool('wait_agent'))
      return { text: 'Merged into Orbit' }
    }
    if (++helperTurn === 1) {
      Object.assign(seen, { helperPrompt: options.prompt, helperWorkspace: options.workspace })
      return response(tool('write_file', { path: 'electron/new.txt', content: 'improved\n' }))
    }
    return { text: 'Wrote it' }
  } })
  const { snapshot } = await finished(runtime, payload(project))
  assert.equal(snapshot.status, 'completed')
  assert.ok(seen.helperWorkspace.startsWith(`${root}${path.sep}`))
  assert.match(seen.helperPrompt, /ISOLATED COPY: your workspace is a git worktree copy of .* \(Orbit's own repository\)/)
  assert.equal(read(orbit, 'electron', 'new.txt'), 'improved\n', 'the change landed in Orbit\'s repository')
  assert.equal(present(project, 'electron'), false, 'and not in the project the chat belongs to')
  const improver = snapshot.agents.find(agent => agent.name === 'Improver')
  assert.deepEqual([improver.isolation.kind, improver.isolation.target, improver.isolation.merged], ['orbit', orbit, 1])
  assert.deepEqual(snapshot.changes, [], 'files of another tree are not changes of this project')
  assert.deepEqual(improver.files.wrote, [])
  await until(() => fs.readdirSync(root).length === 0)
})

test('a spawn that asks for isolation is refused with a reason when it cannot be had, and no helper or copy is made', async t => {
  const plain = folder(t, 'plain'), repository = repo(t)
  fs.writeFileSync(path.join(plain, 'f.txt'), 'x')
  const attempts = [
    ['a workspace that is no git work tree', plain, {}, 'worktree', /isolation_unavailable[\s\S]*is not inside a git work tree[\s\S]*Spawn the helper without isolation/],
    ['a read-only run', repository, { accessMode: 'read-only' }, 'worktree', /isolation_unavailable[\s\S]*read-only/],
    ['orbit without a restart host', repository, {}, 'orbit', /isolation_unavailable[\s\S]*Orbit to run from its own repository/],
    ['an unknown value', repository, {}, 'bogus', /invalid_isolation/],
  ]
  for (const [label, workspace, extra, isolation, expected] of attempts) {
    const root = folder(t, 'copies')
    let seen = '', turn = 0
    const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
      if (++turn === 1) return response(tool('spawn_agent', { name: 'Writer', task: 'Edit', reason: 'Edits files', isolation }))
      seen = options.prompt
      return { text: 'Refused' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, extra))
    assert.equal(snapshot.status, 'completed', label)
    assert.match(seen, expected, label)
    assert.equal(snapshot.agents.length, 1, `${label}: no helper was made`)
    assert.deepEqual(fs.readdirSync(root), [], `${label}: no copy was made`)
  }
})

test('stopping a run takes its copies away and keeps the unmerged work as a patch', async t => {
  const workspace = repo(t), root = folder(t, 'copies')
  let reached, wrote = false
  const hanging = new Promise(resolve => { reached = resolve })
  const runtime = new OrbitRuntime({ worktreeRoot: root, runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Orbit') return response(tool('spawn_agent', { name: 'Slow', task: 'Work', reason: 'Parallel work', isolation: 'worktree' }), tool('wait_agent'))
    if (!wrote) { wrote = true; return response(tool('write_file', { path: 'wip.txt', content: 'unfinished\n' })) }
    reached()
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }))
  } })
  const runId = await runtime.start(payload(workspace))
  await hanging
  assert.equal(runtime.stop(runId), true)
  await until(() => runtime.getRun(runId).traces.some(trace => trace.kind === 'isolation' && /saved as a patch/.test(trace.text)))
  const patches = path.join(root, 'patches')
  assert.equal(fs.readdirSync(patches).length, 1)
  assert.match(read(patches, fs.readdirSync(patches)[0]), /\+unfinished/)
  await until(() => fs.readdirSync(root).join() === 'patches')
  assert.equal(present(workspace, 'wip.txt'), false, 'nothing of it reached the workspace')
  assert.equal(git(workspace, 'worktree', 'list').split('\n').length, 1)
})

test('the session system block of an isolated helper names its copy, carries the delegation advice and stays within its 7500 characters', () => {
  const run = { projectId: path.join(os.tmpdir(), 'a project'), workspace: path.join(os.tmpdir(), 'a project'), accessMode: 'workspace-write', approvalPolicy: 'never' }
  const copy = path.join(os.tmpdir(), 'orbit-ide', 'worktrees', 'a1b2c3d4', 'e5f6a7b8')
  const helper = { id: `agent-${'1'.repeat(36)}`, name: 'x'.repeat(80), parentId: 'root', depth: 2, mailMark: '0123456789', workspace: copy, isolation: { kind: 'orbit', path: copy, base: 'a'.repeat(40), target: path.join(os.tmpdir(), 'a project folder with a rather long name', 'nested') } }
  const text = sessionGuide(run, helper)
  assert.ok(text.length <= 7500, `${text.length} characters`)
  assert.ok(text.includes(`workspace=${copy}`))
  assert.match(text, /ISOLATED COPY: your workspace is a git worktree copy of .* \(Orbit's own repository\); edit only there, never commit, stash, checkout or reset, and never install, prune or delete dependencies \(node_modules is the original's\): ask your parent\./)
  assert.ok(text.endsWith('Do not claim tool results you did not receive.'))
  for (const advice of [/Delegate in your first minutes/, /spawn all independent helpers in ONE turn/, /isolation:'worktree'/, /keep working meanwhile and call wait_agent only when you need their result/, /Helpers may delegate further the same way/]) assert.match(text, advice)
  const inheriting = sessionGuide(run, { ...helper, name: 'Grand', isolation: undefined })
  assert.match(inheriting, /Your workspace is your parent's isolated git copy/)
  const plain = sessionGuide(run, { ...helper, name: 'Plain', workspace: undefined, isolation: undefined })
  assert.doesNotMatch(plain, /ISOLATED COPY|isolated git copy: edit/)
  assert.ok(plain.includes(`workspace=${run.workspace}`))
})
