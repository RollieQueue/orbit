// Isolated helpers through the runtime (spawn_agent {isolation}), with a fake provider on the envelope transport: the helper
// works in its own git copy, its changes merge into the parent's workspace before the parent is told it is done, the parent
// reads the merge report (conflicts included), nested and follow-up merges work, and the copies go with the run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { sessionGuide } = require('../electron/runtime/prompts.mts')

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_OPTIONAL_LOCKS: '0' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
function folder(t, label) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `orbit-isolation-${label}-`)))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function repo(t, files = { 'a.txt': 'l1\nl2\nl3\n' }) {
  const directory = folder(t, 'repo')
  git(directory, 'init', '-q')
  git(directory, 'config', 'core.autocrlf', 'false')
  for (const [name, text] of Object.entries({ '.gitignore': 'node_modules/\n', ...files })) {
    const file = path.join(directory, ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'init')
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
let chats = 0
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: `chat-${++chats}`, providerId: 'test', prompt: 'Current task', accessMode: 'workspace-write', ...extra })
async function finished(runtime, start) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsubscribe = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(start)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 30000)
  const event = await terminal
  clearTimeout(timer); unsubscribe()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return { snapshot: runtime.getRun(runId), runId }
}
async function until(check, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting for the copies to be cleaned up')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8')
const present = (...parts) => fs.existsSync(path.join(...parts))

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

test('the session system block of an isolated helper names its copy, carries the delegation advice and stays within its 6000 characters', () => {
  const run = { projectId: path.join(os.tmpdir(), 'a project'), workspace: path.join(os.tmpdir(), 'a project'), accessMode: 'workspace-write', approvalPolicy: 'never' }
  const copy = path.join(os.tmpdir(), 'orbit-ide', 'worktrees', 'a1b2c3d4', 'e5f6a7b8')
  const helper = { id: `agent-${'1'.repeat(36)}`, name: 'x'.repeat(80), parentId: 'root', depth: 2, mailMark: '0123456789', workspace: copy, isolation: { kind: 'orbit', path: copy, base: 'a'.repeat(40), target: path.join(os.tmpdir(), 'a project folder with a rather long name', 'nested') } }
  const text = sessionGuide(run, helper)
  assert.ok(text.length <= 6000, `${text.length} characters`)
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
