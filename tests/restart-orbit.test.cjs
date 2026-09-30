// restart_orbit and the continuation after a restart (docs/TECH-DEBT.md item 1): the tool (root only, needs a restart
// host, refused while other chats work or under the dev server, turns the self-upgrade script's outcome into a result or
// an error), the run ended as `restarting` with its restart note when Orbit shuts down for the restart, the continuation
// in the same chat once the watcher confirmed the new code (resuming the old root session when it can), and the
// environment that names an agent's run for every command it runs.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { finished: streamFinished } = require('node:stream/promises')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { RunStore } = require('../electron/run-store.mts')
const resume = require('../electron/resume.mts')
const restart = require('../electron/runtime/restart.mts')
const registry = require('../electron/tool-registry.mts')

function folder(t, prefix = 'orbit-restart-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Only this fixture's securely generated temporary directory is removed (retried: Windows may still hold it a moment).
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return directory
}
// What the restart host needs to find in a repository: the script and a .git folder.
function repository(t) {
  const root = folder(t, 'orbit-restart-repo-')
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'scripts', 'self-upgrade.cjs'), "'use strict'\n")
  return root
}
function writeReport(root, report) {
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'artifacts', 'self-upgrade-last.json'), JSON.stringify(report))
}
// pending-resume.json as the self-upgrade script writes it, with the watcher's verdict unless a test says otherwise.
function writeIntent(userData, fields = {}) {
  const intent = {
    version: 1, id: 'upgrade-1', createdAt: new Date().toISOString(), source: 'tool', reason: 'New tool', continueWith: 'Finish the task with the new tool', verify: true,
    runId: 'missing-run', chatId: 'chat-1', projectId: 'project-1', agentId: 'root', level: 'runtime', state: 'relaunching', commit: '0123456789abcdef', outcome: null, error: null, patch: null,
    verdict: 'relaunched', verdictAt: new Date().toISOString(), ...fields,
  }
  fs.writeFileSync(path.join(userData, 'pending-resume.json'), JSON.stringify(intent))
  return intent
}
// The mark lifecycle.markRestarting leaves on a run the intent of writeIntent (id upgrade-1) ended: only that intent
// continues it.
const marked = (fields = {}) => ({ reason: 'New tool', requestedAt: new Date().toISOString(), source: 'tool', intentId: 'upgrade-1', ...fields })
// A scripted self-upgrade process: `script(child, call)` prints, writes the report and calls `child.exit(code)`.
function fakeSpawn(script) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => true
    child.exit = async (code, signal = null) => {
      child.stdout.end(); child.stderr.end()
      await Promise.all([streamFinished(child.stdout), streamFinished(child.stderr)]).catch(() => {})
      child.emit('close', code, signal)
    }
    const call = { command, args, options, child }
    calls.push(call)
    setImmediate(() => script(child, call))
    return child
  }
  return { spawn, calls }
}
// The session transport without a CLI: a fake MCP server that issues tokens (as in session-mode.test.cjs).
function fakeMcp() {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {} }
}
// No background scan of the temporary workspace (it could still hold the folder when the test removes it).
const runtimeWith = options => new OrbitRuntime({ projectIndex: null, ...options })
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Change Orbit and apply it', accessMode: 'workspace-write', ...extra })
// A provider turn that lasts until the run is stopped: the root agent sits in it while a test calls tools on it.
const blocking = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ text: 'stopped' }), { once: true }))
async function waitFor(check, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('The awaited condition was not reached')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function finished(runtime, start) {
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsubscribe = runtime.onEvent(event => { events.push(event); if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(start)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); unsubscribe()
  assert.notEqual(event.type, 'test.timeout', 'the run must end without a deadlock')
  return { snapshot: runtime.getRun(runId), events, runId }
}
async function liveRun(t, runtimeOptions = {}, extra = {}) {
  // restart_orbit serves runs on Orbit's own repository: with a usable host the run works in it.
  const workspace = runtimeOptions.restartHost?.available ? runtimeOptions.restartHost.repoRoot : folder(t)
  const runtime = runtimeWith({ runProvider: blocking, ...runtimeOptions })
  const runId = await runtime.start(payload(workspace, extra))
  t.after(() => runtime.stop(runId))
  const run = runtime.runs.get(runId)
  return { runtime, run, root: run.agentNodes.get('root'), workspace }
}
// A continuation's run, once it has ended.
async function continuationOf(runtime, notice) {
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(runtime.getRun(notice.resumedRunId)?.status))
  return runtime.getRun(notice.resumedRunId)
}

test('restart_orbit is refused to workers, without a usable restart host, in read-only runs and without its arguments', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(child => child.exit(0))
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn })
  assert.equal(host.available, true)
  assert.equal(host.resumeFile, path.join(userData, 'pending-resume.json'))
  const { runtime, run, root } = await liveRun(t, { restartHost: host })
  const call = (agent, args) => runtime.executeTool(run, agent, 'restart_orbit', args)
  await assert.rejects(call({ ...root, id: 'helper-1', name: 'Helper' }, { reason: 'r', continueWith: 'c' }), /Only the root agent/)
  await assert.rejects(call(root, { reason: '  ', continueWith: 'c' }), /needs a reason/)
  await assert.rejects(call(root, { reason: 'r' }), /needs continueWith/)
  await assert.rejects(call(root, { reason: 'r', continueWith: 'c', verify: 'yes' }), /verify must be a boolean/)
  await assert.rejects(call(root, { reason: 'r'.repeat(1001), continueWith: 'c' }), /longer than 1000/)
  assert.equal(calls.length, 0, 'no script was started')

  // No host (a packaged build, or a runtime without one) and a host outside a repository give the same clear error.
  const bare = await liveRun(t, {}, { chatId: 'chat-bare' })
  await assert.rejects(bare.runtime.executeTool(bare.run, bare.root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), /restart_orbit is available only when Orbit runs from its repository/)
  const packaged = resume.createRestartHost({ repoRoot: folder(t), userData, spawn })
  assert.equal(packaged.available, false)
  bare.runtime.setRestartHost(packaged)
  assert.equal(bare.runtime.restartHost, packaged)
  await assert.rejects(bare.runtime.executeTool(bare.run, bare.root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), /available only when Orbit runs from its repository/)
  assert.deepEqual(await packaged.request({ run: bare.run, agent: bare.root, reason: 'r', continueWith: 'c', verify: true }), { ok: false, status: 'unavailable', output: '', exitCode: null, error: 'restart_orbit is available only when Orbit runs from its repository' })

  const readOnly = await liveRun(t, { restartHost: host }, { accessMode: 'read-only', chatId: 'chat-read-only' })
  await assert.rejects(readOnly.runtime.executeTool(readOnly.run, readOnly.root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), /workspace-write or full access/)
  // Under the Vite dev server a relaunch would stop `npm run dev`.
  const dev = process.env.ORBIT_DEV
  process.env.ORBIT_DEV = '1'
  try { await assert.rejects(call(root, { reason: 'r', continueWith: 'c' }), /Vite dev server \(ORBIT_DEV=1\)/) }
  finally { if (dev === undefined) delete process.env.ORBIT_DEV; else process.env.ORBIT_DEV = dev }
  assert.equal(calls.length, 0)

  // The registry: root only, write access, and the arguments are checked before an MCP call reaches the runtime.
  const spec = registry.tool('restart_orbit')
  assert.equal(spec.rootOnly, true)
  assert.equal(spec.minAccess, 'workspace-write')
  assert.deepEqual(spec.inputSchema.required, ['reason', 'continueWith'])
  assert.deepEqual(Object.keys(spec.inputSchema.properties), ['reason', 'continueWith', 'verify'])
  assert.ok(!registry.toolsFor({ root: false, accessMode: 'danger-full-access' }).some(item => item.name === 'restart_orbit'))
  assert.ok(!registry.toolsFor({ root: true, accessMode: 'read-only' }).some(item => item.name === 'restart_orbit'))
  assert.ok(registry.toolsFor({ root: true, accessMode: 'workspace-write' }).some(item => item.name === 'restart_orbit'))
  assert.match(registry.validate('restart_orbit', { reason: 'r', continueWith: ' ' }).error, /continueWith/)
  assert.match(registry.validate('restart_orbit', { reason: 'r', continueWith: 'c', verify: 'no' }).error, /verify must be a boolean/)
  assert.deepEqual(registry.validate('restart_orbit', { reason: 'r', continueWith: 'c', verify: null }), { ok: true, args: { reason: 'r', continueWith: 'c' } })
})

test('restart_orbit waits for other chats: it is refused while they work, its own helpers do not count', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(async child => { writeReport(repo, { status: 'up-to-date' }); await child.exit(0) })
  const { runtime, run, root, workspace } = await liveRun(t, { restartHost: resume.createRestartHost({ repoRoot: repo, userData, spawn }) })
  runtime.createAgent(run, root, { name: 'Helper', task: 'Own helper', reason: 'Separate part' })
  const other = await runtime.start(payload(workspace, { chatId: 'chat-other', prompt: 'Refactor the settings panel of the other chat' }))
  await assert.rejects(runtime.executeTool(run, root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), error => {
    assert.match(error.message, /1 other chat\(s\) are still working/)
    assert.match(error.message, /chat chat-other \("Refactor the settings panel/)
    assert.match(error.message, /Wait for them to finish \(wait_message \{timeout_ms\}/)
    return true
  })
  assert.equal(calls.length, 0, 'nothing was started')
  runtime.stop(other)
  const result = await runtime.executeTool(run, root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  assert.deepEqual([result.level, result.restarted], ['none', false])
})

test('a failed verification is a tool error carrying the script output, and the run goes on', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(async child => {
    child.stdout.write('==> typecheck\n')
    child.stderr.write("electron/new-tool.mts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n")
    writeReport(repo, { ok: false, status: 'failed', error: 'typecheck exited with 2', phase: 'done' })
    await child.exit(1)
  })
  const { runtime, run, root } = await liveRun(t, { restartHost: resume.createRestartHost({ repoRoot: repo, userData, spawn }) })
  await assert.rejects(runtime.executeTool(run, root, 'restart_orbit', { reason: 'New tool', continueWith: 'Use the new tool' }), error => {
    assert.match(error.message, /self-upgrade status failed, exit code 1: typecheck exited with 2/)
    assert.match(error.message, /Nothing was restarted/)
    assert.match(error.message, /==> typecheck/)
    assert.match(error.message, /error TS2322/)
    return true
  })
  const [call] = calls
  assert.deepEqual(call.args, [path.join(repo, 'scripts', 'self-upgrade.cjs'), '--reason', 'New tool', '--continue-with', 'Use the new tool'])
  assert.equal(call.options.cwd, path.resolve(repo))
  const env = call.options.env
  assert.deepEqual([env.ORBIT_RUN_ID, env.ORBIT_CHAT_ID, env.ORBIT_PROJECT_ID, env.ORBIT_AGENT_ID, env.ORBIT_RESUME_FILE, env.ORBIT_RESTART_SOURCE], [run.runId, 'chat-1', 'project-1', 'root', path.join(userData, 'pending-resume.json'), 'tool'])
  assert.equal(env.ORBIT_USER_DATA, userData, 'the script signals the Orbit of this profile')
  // The script's output is one trace of the agent, rewritten in place.
  const traces = run.traces.filter(trace => trace.kind === 'restart')
  assert.equal(traces.length, 1)
  assert.ok(traces[0].text.startsWith('restart_orbit: checks, build and restart. Reason: New tool\n'))
  assert.match(traces[0].text, /\n==> typecheck(\n|$)/)
  assert.match(traces[0].text, /error TS2322/)
  assert.equal(run.status, 'working', 'the agent fixes the code and may call again')
})

test('an up-to-date tree applies nothing, and a renderer reload leaves the run going', async t => {
  const repo = repository(t), userData = folder(t), workspace = repo
  const outcomes = [{ status: 'up-to-date', phase: 'done' }, { ok: true, status: 'reloaded', level: 'renderer', phase: 'done' }]
  const { spawn, calls } = fakeSpawn(async child => { writeReport(repo, outcomes.shift()); child.stdout.write('done\n'); await child.exit(0) })
  let turn = 0
  const runtime = runtimeWith({ restartHost: resume.createRestartHost({ repoRoot: repo, userData, spawn }), runProvider: async () => {
    turn++
    if (turn === 1) return response(tool('restart_orbit', { reason: 'Nothing new', continueWith: 'Check the result' }))
    if (turn === 2) return response(tool('restart_orbit', { reason: 'New panel', continueWith: 'Check the panel', verify: false }))
    return { text: 'Done' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  const results = snapshot.traces.filter(trace => trace.kind === 'observation' && trace.text.startsWith('restart_orbit:')).map(trace => JSON.parse(trace.text.slice('restart_orbit: '.length)))
  assert.deepEqual(results.map(result => [result.ok, result.level, result.restarted, result.status]), [[true, 'none', false, 'up-to-date'], [true, 'renderer', true, 'reloaded']])
  assert.match(results[0].note, /Nothing to apply/)
  assert.ok(!calls[0].args.includes('--no-verify'), 'verify is on by default')
  assert.ok(calls[1].args.includes('--no-verify'))
})

test('shutting down for a restart ends exactly the run the intent names, as restarting with its note, and saves it at once', async t => {
  const userData = folder(t), workspace = folder(t)
  const runtime = runtimeWith({ runStore: new RunStore(userData), runProvider: blocking })
  const target = await runtime.start(payload(workspace, { chatId: 'chat-a', model: 'model-a', reasoningEffort: 'high', history: [{ role: 'user', content: 'An earlier message' }] }))
  const other = await runtime.start(payload(workspace, { chatId: 'chat-b' }))
  t.after(() => { runtime.stop(target); runtime.stop(other) })
  // What the note reports: the root's work log and files, a helper, and the turn the restart cuts off.
  const run = runtime.runs.get(target), root = run.agentNodes.get('root')
  await waitFor(() => root.activeTurn)
  runtime.recordLedger(root, 'edit_file', '#1 edit_file electron/new-tool.mts ok')
  root.files = { read: ['electron/tool-registry.mts'], wrote: ['electron/new-tool.mts'] }
  root.partialTurn.messages.set('m1', 'The tool is written; restarting to apply it')
  runtime.createAgent(run, root, { name: 'Checker', task: 'Run the tests of the new tool', reason: 'Separate check' })
  assert.deepEqual(resume.markRestartingRuns({ runtime, userData }), [], 'no intent, nothing is marked')
  writeIntent(userData, { runId: target, chatId: 'chat-a', outcome: 'rolled-back' })
  assert.deepEqual(resume.markRestartingRuns({ runtime, userData }), [], 'a rolled-back intent marks nothing')
  const intent = writeIntent(userData, { runId: target, chatId: 'chat-a', reason: 'New tool', source: 'script', verdict: null })
  const events = []
  runtime.onEvent(event => events.push(event))
  assert.deepEqual(resume.markRestartingRuns({ runtime, userData }), [target])
  const marked = runtime.getRun(target)
  assert.equal(marked.status, 'restarting')
  assert.ok(marked.finishedAt)
  assert.deepEqual({ ...marked.restart, note: undefined }, { reason: 'New tool', requestedAt: intent.createdAt, source: 'script', intentId: 'upgrade-1', note: undefined }, 'the mark keeps the id of the intent that made it')
  const note = marked.restart.note
  assert.match(note, new RegExp(`^RESTART NOTE: Orbit restarted with new code, and this run continues run ${target}`))
  assert.match(note, /files written: \["electron\/new-tool\.mts"\]; files read: \["electron\/tool-registry\.mts"\]/)
  assert.match(note, /Your last recorded actions:\n- #1 edit_file electron\/new-tool\.mts ok/)
  assert.match(note, /- Checker \[stopped while working\]: Run the tests of the new tool/)
  assert.match(note, /Your last turn was cut off by the restart[\s\S]*The tool is written; restarting to apply it/)
  assert.match(note, /Check the real state \(read the files, run the check\) before repeating any write or command/)
  assert.ok(marked.agents.every(agent => agent.status === 'cancelled' && agent.detail === 'Orbit перезапускается по запросу агента'))
  assert.equal(runtime.getRun(other).status, 'working', 'other runs are left to the shutdown')
  assert.ok(events.some(event => event.type === 'run.finished' && event.runId === target && event.status === 'restarting'))
  assert.ok(fs.existsSync(path.join(userData, 'pending-resume.json')), 'the intent stays for the new process')
  // The root agent unwinding after the abort must not turn the run into failed or cancelled; a second mark does nothing.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(runtime.getRun(target).status, 'restarting')
  assert.deepEqual(resume.markRestartingRuns({ runtime, userData }), [])
  runtime.stop(other)
  // Saved at once, with what a continuation needs, and kept as it is when a new process loads the history.
  const saved = new RunStore(userData).get(target)
  assert.equal(saved.status, 'restarting')
  assert.deepEqual(saved.restart, marked.restart)
  assert.equal(saved.startPayload.model, 'model-a')
  assert.equal(saved.startPayload.reasoningEffort, 'high')
  assert.equal(saved.startPayload.chatId, 'chat-a')
  assert.equal(saved.startPayload.prompt, undefined, 'the message is not part of the start payload')
  assert.equal(saved.startPayload.history, undefined, 'nor is the chat history')
})

test('restart_orbit end to end: the run ends as restarting and a new run in the same chat continues it', async t => {
  const repo = repository(t), userData = folder(t), workspace = repo
  // The script on the tool path: the checks pass, the intent is written from the environment the runtime gave it, the
  // restart is signalled, and this process is shut down before the script could report back.
  let signalled
  const restarted = new Promise(resolve => { signalled = resolve })
  const { spawn } = fakeSpawn((child, { args, options }) => {
    const env = options.env, flag = name => args[args.indexOf(name) + 1]
    fs.writeFileSync(env.ORBIT_RESUME_FILE, JSON.stringify({
      version: 1, id: 'upgrade-7', createdAt: new Date().toISOString(), source: env.ORBIT_RESTART_SOURCE, reason: flag('--reason'), continueWith: flag('--continue-with'),
      verify: !args.includes('--no-verify'), runId: env.ORBIT_RUN_ID, chatId: env.ORBIT_CHAT_ID, projectId: env.ORBIT_PROJECT_ID, agentId: env.ORBIT_AGENT_ID,
      level: 'runtime', state: 'relaunching', commit: 'abcdef0123456789', outcome: null, error: null, patch: null,
    }))
    child.stdout.write('==> relaunch (runtime)\n')
    signalled()
  })
  let beforeTurns = 0
  const before = runtimeWith({ runStore: new RunStore(userData), restartHost: resume.createRestartHost({ repoRoot: repo, userData, spawn }), runProvider: async () => {
    if (++beforeTurns === 1) return response(tool('write_file', { path: 'tool.txt', content: 'the new tool' }))
    return response(tool('restart_orbit', { reason: 'Added the tool', continueWith: 'Use the new tool on src/' }))
  } })
  const oldRunId = await before.start(payload(workspace, { chatId: 'chat-a', model: 'model-a', reasoningEffort: 'high', agentInstructions: 'Answer in English' }))
  await restarted
  assert.deepEqual(resume.markRestartingRuns({ runtime: before, userData }), [oldRunId])
  assert.equal(before.getRun(oldRunId).status, 'restarting')
  assert.equal(before.getRun(oldRunId).restart.source, 'tool')
  // The watcher confirms the new code.
  const file = path.join(userData, 'pending-resume.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), verdict: 'relaunched', verdictAt: new Date().toISOString() }))

  // The new process, after main reported a healthy start.
  const seen = []
  const after = runtimeWith({ runStore: new RunStore(userData), runProvider: async options => { seen.push(options); return { text: 'Continued with the new tool' } } })
  const start = after.start.bind(after)
  after.start = async request => { assert.equal(fs.existsSync(file), false, 'the intent is deleted before the continuation starts'); return start(request) }
  const events = []
  after.onEvent(event => events.push(event))
  const notices = []
  const notice = await resume.resumePending({ runtime: after, userData, notify: item => notices.push(item), info: { level: 'runtime', commit: null } })
  assert.deepEqual(notices, [notice])
  assert.equal(notice.kind, 'resumed')
  assert.deepEqual([notice.chatId, notice.projectId, notice.runId, notice.reason, notice.level], ['chat-a', 'project-1', oldRunId, 'Added the tool', 'runtime'])
  assert.equal(notice.text, 'Orbit перезапущен по запросу агента, задача продолжена (причина: Added the tool)')
  const continuation = await continuationOf(after, notice)
  assert.equal(continuation.status, 'completed')
  assert.deepEqual([continuation.chatId, continuation.projectId, continuation.model, continuation.reasoningEffort], ['chat-a', 'project-1', 'model-a', 'high'])
  assert.equal(continuation.resumedFrom, oldRunId)
  assert.equal(continuation.resumeChain, 1)
  assert.equal(continuation.startPayload.agentInstructions, 'Answer in English')
  assert.equal(continuation.startPayload.restartNote, undefined, 'a continuation does not pass its note on')
  const started = events.find(event => event.type === 'run.started' && event.runId === notice.resumedRunId)
  assert.deepEqual([started.resumedFrom, started.resumeChain], [oldRunId, 1])
  const prompt = seen[0].prompt
  assert.ok(continuation.prompt.startsWith('Use the new tool on src/\n\nOrbit перезапущен с новым кодом'))
  assert.ok(prompt.includes(`Use the new tool on src/\n\nOrbit перезапущен с новым кодом (коммит abcdef0, уровень runtime, причина: Added the tool); предыдущий запуск ${oldRunId} завершён перезапуском, его история — в дайджесте предыдущих ходов чата.`))
  assert.match(prompt, /Answer in English/)
  assert.match(prompt, /EARLIER TURNS IN THIS CHAT[\s\S]*· restarting\]/, 'the digest of earlier turns shows the restarted run')
  // An envelope root starts fresh, with the restart note written before the restart in its transcript.
  assert.match(prompt, /AGENT TRANSCRIPT[\s\S]*RESTART NOTE: Orbit restarted with new code[\s\S]*files written: \[\\"tool\.txt\\"\][\s\S]*#1 write_file/)
  assert.equal(await resume.resumePending({ runtime: after, userData }), null, 'an intent is acted on once')
})

test('a continuation resumes the old root session when it keeps the provider, and starts fresh once if that fails', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  const oldRun = (runId, sessionId, root = {}) => runStore.save({
    runId, status: 'restarting', projectId: 'project-1', chatId: `chat-${runId}`, workspace, startedAt: new Date().toISOString(),
    startPayload: { workspace, providerId: root.providerId || 'claude', projectId: 'project-1', chatId: `chat-${runId}`, accessMode: 'danger-full-access' },
    agents: [{ id: 'root', name: 'Orbit', status: 'cancelled', providerId: 'claude', transport: 'session', sessionId, files: { read: [], wrote: ['a.txt'] }, ...root }],
    restart: { reason: 'New tool', requestedAt: new Date().toISOString(), source: 'tool', note: `RESTART NOTE: saved for ${runId}`, intentId: 'upgrade-1' },
  })
  oldRun('resumable-run', 'old-session')
  oldRun('broken-run', 'broken-session')
  const calls = []
  const runtime = runtimeWith({ runStore, mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    calls.push({ id: options.session.id, resume: options.session.resume, prompt: options.prompt })
    if (options.session.resume && options.session.id === 'broken-session') throw new Error('No conversation found with session ID: broken-session')
    return { text: 'Continued', sessionId: options.session.id }
  } })
  writeIntent(userData, { runId: 'resumable-run', chatId: 'chat-resumable-run', continueWith: 'Wire the new tool in' })
  const resumed = await continuationOf(runtime, await resume.resumePending({ runtime, userData }))
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(calls.map(call => [call.id, call.resume]), [['old-session', true]], 'the first turn resumes the old session')
  assert.match(calls[0].prompt, /Wire the new tool in\n\nOrbit перезапущен с новым кодом[\s\S]*RESTART NOTE: saved for resumable-run/)
  assert.equal(resumed.agents.find(agent => agent.id === 'root').sessionId, 'old-session')
  assert.equal(runtime.runs.get(resumed.runId).resumeSession, undefined, 'once it answered, it is an ordinary session')

  calls.length = 0
  writeIntent(userData, { runId: 'broken-run', chatId: 'chat-broken-run', continueWith: 'Finish the migration' })
  const fresh = await continuationOf(runtime, await resume.resumePending({ runtime, userData }))
  assert.equal(fresh.status, 'completed')
  assert.deepEqual(calls.map(call => call.resume), [true, false], 'the failed resume is dropped once and a fresh session starts')
  assert.equal(calls[0].id, 'broken-session')
  assert.notEqual(calls[1].id, 'broken-session')
  assert.match(calls[1].prompt, /YOUR CURRENT TASK:\nFinish the migration/)
  assert.match(calls[1].prompt, /RESTART NOTE: saved for broken-run/)
  assert.ok(fresh.traces.some(trace => trace.kind === 'transport' && /could not be resumed \(No conversation found/.test(trace.text)))

  // A root cut off in its first Claude session turn has no sessionId yet (it is recorded when a turn returns): the
  // record of that turn names the session Orbit started, and the continuation resumes it.
  const turnStart = new Date(Date.now() - 60000).toISOString()
  const timing = sessionId => ({ turn: 1, transport: 'session', startedAt: turnStart, firstEventAt: null, endedAt: null, promptChars: 10, nativeToolCalls: 0, orbitToolCalls: 1, sessionId })
  oldRun('first-turn-run', null, { turnTimings: [timing('first-turn-session')] })
  calls.length = 0
  writeIntent(userData, { runId: 'first-turn-run', chatId: 'chat-first-turn-run', continueWith: 'Go on with the tool' })
  assert.equal((await continuationOf(runtime, await resume.resumePending({ runtime, userData }))).status, 'completed')
  assert.deepEqual(calls.map(call => [call.id, call.resume]), [['first-turn-session', true]], 'the cut-off first turn\'s session is resumed')
  // Not for a provider that names its own sessions (the id Orbit proposed is not Codex's thread), nor when the root
  // moved to Claude after that turn had started.
  oldRun('codex-run', null, { providerId: 'codex', turnTimings: [timing('proposed-by-orbit')] })
  oldRun('moved-run', null, { turnTimings: [timing('before-the-handover')], handovers: [{ id: 'h1', time: new Date(Date.now() - 30000).toISOString(), reason: 'exhausted', from: { providerId: 'codex', model: 'm' }, to: { providerId: 'claude', model: 'm' }, fresh: false }] })
  for (const runId of ['codex-run', 'moved-run']) {
    calls.length = 0
    writeIntent(userData, { runId, chatId: `chat-${runId}`, continueWith: 'Go on' })
    await continuationOf(runtime, await resume.resumePending({ runtime, userData }))
    assert.deepEqual(calls.map(call => call.resume), [false], `${runId}: a fresh session`)
    assert.ok(!['proposed-by-orbit', 'before-the-handover'].includes(calls[0].id), runId)
  }

  // Without a session transport for the new root (or another provider) nothing is resumed; the note still leads.
  oldRun('envelope-run', 'envelope-session')
  const envelope = runtimeWith({ runStore, runProvider: async options => { calls.push({ envelope: true, prompt: options.prompt, session: options.session }); return { text: 'Done' } } })
  calls.length = 0
  writeIntent(userData, { runId: 'envelope-run', chatId: 'chat-envelope-run', continueWith: 'Again' })
  await continuationOf(envelope, await resume.resumePending({ runtime: envelope, userData, maxChain: 5 }))
  assert.equal(calls[0].session, undefined)
  assert.match(calls[0].prompt, /AGENT TRANSCRIPT[\s\S]*RESTART NOTE: saved for envelope-run/)
})

test('the continuation waits for the watcher: a verdict continues, a rollback does not, an unconfirmed intent only while young', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  runStore.save({ runId: 'plain-run', status: 'restarting', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), startPayload: { workspace, providerId: 'test', projectId: 'project-1', chatId: 'chat-1' }, restart: marked() })
  const started = []
  const runtime = { runStore, start: async request => { started.push(request); return `new-run-${started.length}` } }
  const file = path.join(userData, 'pending-resume.json')
  const rewrite = fields => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...fields }))

  // The verdict arrives while the start waits for it: the continuation starts then, not at the end of the wait.
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null })
  setTimeout(() => rewrite({ verdict: 'relaunched', verdictAt: new Date().toISOString() }), 60)
  const began = Date.now()
  const confirmed = await resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 })
  assert.equal(confirmed.kind, 'resumed')
  assert.ok(Date.now() - began < 3000, 'the verdict ended the wait')
  // The watcher rolls back while the start waits: no continuation.
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null })
  setTimeout(() => rewrite({ outcome: 'rolled-back', error: 'no health report within 15000 ms', patch: 'failed.patch' }), 60)
  const rolledBack = await resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 })
  assert.deepEqual([rolledBack.kind, rolledBack.error, rolledBack.patch], ['rolled-back', 'no health report within 15000 ms', 'failed.patch'])
  // No verdict at all: a young intent is continued after the wait, an intent older than 10 minutes is not.
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null })
  assert.equal((await resume.resumePending({ runtime, userData, verdictWaitMs: 50, pollMs: 10 })).kind, 'resumed')
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null, createdAt: new Date(Date.now() - 11 * 60000).toISOString() })
  const stale = await resume.resumePending({ runtime, userData, verdictWaitMs: 50, pollMs: 10 })
  assert.deepEqual([stale.kind, stale.text], ['expired', 'Намерение продолжить устарело (> 10 мин, а перезапуск так и не подтверждён), продолжение не запущено'])
  // A healthy start reported twice while the verdict is awaited continues once.
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null })
  setTimeout(() => rewrite({ verdict: 'relaunched' }), 60)
  const [one, two] = await Promise.all([resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 }), resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 })])
  assert.equal(one, two)
  assert.equal(started.length, 3, 'three continuations in all: the confirmed one, the young unconfirmed one and one for the double report')
  assert.equal(fs.existsSync(file), false)
})

test('a rollback, an old intent, too many restarts in a row, a missing or stopped run: a notice and no continuation', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  const stored = (runId, fields = {}) => runStore.save({ runId, status: 'restarting', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), startPayload: { workspace, providerId: 'test', projectId: 'project-1', chatId: 'chat-1' }, restart: marked(), ...fields })
  stored('plain-run')
  // Links to an earlier run only for the chain: a run that already has a continuation is never continued again.
  stored('looping-run', { resumeChain: 3, resumedFrom: 'older-run' })
  stored('second-run', { resumeChain: 2, resumedFrom: 'older-run' })
  stored('bare-run', { startPayload: undefined })
  stored('stopped-run', { status: 'cancelled' })
  stored('finished-run', { status: 'completed' })
  const started = []
  const runtime = { runStore, start: async request => { started.push(request); return 'new-run' } }
  const file = path.join(userData, 'pending-resume.json')
  const patch = path.join('C:', 'repo', 'artifacts', 'self-upgrade-failed.patch')
  const cases = [
    [{ runId: 'plain-run', outcome: 'rolled-back', verdict: null, error: 'no health report within 15000 ms', patch }, 'rolled-back', `Перезапуск не удался и откатился: no health report within 15000 ms. Неудачное изменение: ${patch}`],
    [{ runId: 'plain-run', createdAt: new Date(Date.now() - 31 * 60000).toISOString() }, 'expired', 'Намерение продолжить устарело (> 30 мин), продолжение не запущено'],
    [{ runId: 'looping-run' }, 'loop-limit', 'Продолжение не запущено: 4 перезапуска подряд (предел ORBIT_UPGRADE_MAX_CYCLES)'],
    // The spec: the third restart in a row is not continued.
    [{ runId: 'second-run' }, 'loop-limit', 'Продолжение не запущено: 3 перезапуска подряд (предел ORBIT_UPGRADE_MAX_CYCLES)'],
    [{ runId: 'finished-run' }, 'failed', 'Продолжение не запущено: запуск уже завершился (completed)'],
    [{ runId: 'missing-run' }, 'failed', 'Продолжение не запущено: запись прерванного запуска не найдена'],
    [{ runId: 'bare-run' }, 'failed', 'Продолжение не запущено: у прерванного запуска нет сохранённых параметров запуска'],
    [{ runId: 'stopped-run' }, 'failed', 'Продолжение не запущено: запуск был остановлен до перезапуска'],
  ]
  for (const [fields, kind, text] of cases) {
    writeIntent(userData, fields)
    const notices = []
    const notice = await resume.resumePending({ runtime, userData, notify: item => notices.push(item), maxChain: 3 })
    assert.deepEqual(notices, [notice])
    assert.equal(notice.kind, kind)
    assert.equal(notice.text, text)
    assert.deepEqual([notice.chatId, notice.projectId, notice.runId], ['chat-1', 'project-1', fields.runId])
    assert.equal(fs.existsSync(file), false, `${kind}: the intent is deleted`)
  }
  assert.deepEqual(started, [], 'nothing was continued')
  writeIntent(userData, { runId: 'plain-run', outcome: 'rolled-back', error: 'boom', patch })
  const rolledBack = await resume.resumePending({ runtime, userData })
  assert.deepEqual([rolledBack.error, rolledBack.patch], ['boom', patch])
  // The limit is ORBIT_UPGRADE_MAX_CYCLES by default: a chain below it still continues.
  writeIntent(userData, { runId: 'looping-run' })
  assert.equal((await resume.resumePending({ runtime, userData, maxChain: 5 })).kind, 'resumed')
  assert.deepEqual([started.at(-1).resumeChain, started.at(-1).resumedFrom], [4, 'looping-run'])
  // A run whose restart note was never written (Orbit was killed, not shut down) gets one from its saved record.
  assert.match(started.at(-1).restartNote, /^RESTART NOTE: Orbit restarted with new code, and this run continues run looping-run, which the restart ended \(status restarting\)/)

  // A file that is not a version-1 intent is treated as absent, and deleted.
  for (const content of ['{ not json', JSON.stringify({ version: 2, runId: 'plain-run', createdAt: new Date().toISOString() }), JSON.stringify({ version: 1, runId: '../escape', createdAt: new Date().toISOString() })]) {
    fs.writeFileSync(file, content)
    assert.equal(await resume.resumePending({ runtime, userData }), null)
    assert.equal(fs.existsSync(file), false)
  }
  // A continuation that cannot start is a failed notice (the intent is already gone).
  writeIntent(userData, { runId: 'plain-run' })
  const failed = await resume.resumePending({ runtime: { runStore, start: async () => { throw new Error('Select an existing project folder') } }, userData })
  assert.deepEqual([failed.kind, failed.text, failed.error], ['failed', 'Продолжение не запущено: Select an existing project folder', 'Select an existing project folder'])
  assert.equal(fs.existsSync(file), false)
  // A blank continueWith gets the default; the prompt says what it does not know.
  writeIntent(userData, { runId: 'plain-run', continueWith: '  ', reason: '', commit: null, level: null })
  const intent = resume.readResumeIntent(file)
  assert.equal(intent.continueWith, 'Продолжи задачу с того места, где остановился перед перезапуском Orbit.')
  assert.equal(resume.continuationPrompt(intent), 'Продолжи задачу с того места, где остановился перед перезапуском Orbit.\n\nOrbit перезапущен с новым кодом (коммит неизвестен, уровень неизвестен, причина: не указана); предыдущий запуск plain-run завершён перезапуском, его история — в дайджесте предыдущих ходов чата.')
  assert.match(resume.continuationPrompt(intent, { level: 'full', commit: 'fedcba9876' }), /\(коммит fedcba9, уровень full, причина: не указана\)/)
  // The code that runs is the commit plus the uncommitted changes the self-upgrade snapshot recorded.
  assert.match(resume.continuationPrompt({ ...intent, commit: 'abcdef0123', snapshot: '0123456789abcdef0123456789abcdef01234567' }), /\(коммит abcdef0 \+ незакоммиченные изменения, снимок 0123456, уровень/)
})

test('the variables that name the run reach run_command and the provider CLI, and only with a restart host', async t => {
  // A run on Orbit's own repository: where restart_orbit is offered, the variables are given as well.
  const repo = repository(t), userData = folder(t), workspace = repo
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn: fakeSpawn(() => {}).spawn })
  const resumeFile = path.join(userData, 'pending-resume.json')
  const script = 'process.stdout.write(JSON.stringify(["ORBIT_RUN_ID", "ORBIT_CHAT_ID", "ORBIT_PROJECT_ID", "ORBIT_AGENT_ID", "ORBIT_RESUME_FILE", "ORBIT_USER_DATA"].map(name => process.env[name] || null)))'
  const seen = []
  let turn = 0
  const runtime = runtimeWith({ restartHost: host, runProvider: async options => {
    seen.push(options.extraEnv)
    return ++turn === 1 ? response(tool('run_command', { command: process.execPath, args: ['-e', script] })) : { text: 'Done' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  const observation = snapshot.traces.find(trace => trace.kind === 'observation' && trace.text.startsWith('run_command:'))
  const result = JSON.parse(observation.text.slice('run_command: '.length))
  assert.deepEqual(JSON.parse(result.stdout), [runId, 'chat-1', 'project-1', 'root', resumeFile, userData])
  assert.deepEqual(seen[0], { ORBIT_RUN_ID: runId, ORBIT_CHAT_ID: 'chat-1', ORBIT_PROJECT_ID: 'project-1', ORBIT_AGENT_ID: 'root', ORBIT_RESUME_FILE: resumeFile, ORBIT_USER_DATA: userData })
  assert.deepEqual(resume.restartEnv({ runId: 'r', chatId: 'c', projectId: 'p' }, { id: 'a' }, null), {}, 'no resume file, no variables')

  // The same host, a run on another project: restart_orbit is not offered there, and neither are the variables.
  const elsewhere = []
  const other = runtimeWith({ restartHost: host, runProvider: async options => { elsewhere.push(options.extraEnv); return { text: 'Done' } } })
  assert.equal((await finished(other, payload(folder(t), { chatId: 'chat-elsewhere' }))).snapshot.status, 'completed')
  assert.deepEqual(elsewhere.map(env => Object.keys(env || {})), [[]], 'a run on another project gets no restart variables')

  const plainSeen = []
  let plainTurn = 0
  const plain = runtimeWith({ runProvider: async options => {
    plainSeen.push('extraEnv' in options)
    return ++plainTurn === 1 ? response(tool('run_command', { command: process.execPath, args: ['-e', script] })) : { text: 'Done' }
  } })
  const bare = await finished(plain, payload(workspace, { chatId: 'chat-2' }))
  const bareResult = JSON.parse(bare.snapshot.traces.find(trace => trace.kind === 'observation' && trace.text.startsWith('run_command:')).text.slice('run_command: '.length))
  assert.deepEqual(JSON.parse(bareResult.stdout), [process.env.ORBIT_RUN_ID || null, process.env.ORBIT_CHAT_ID || null, process.env.ORBIT_PROJECT_ID || null, process.env.ORBIT_AGENT_ID || null, process.env.ORBIT_RESUME_FILE || null, process.env.ORBIT_USER_DATA || null], 'without a host nothing is added')
  assert.deepEqual(plainSeen, [false, false])
})

test('only the root agent of a writable run hears about restart_orbit, and only when Orbit can restart itself', async t => {
  const repo = repository(t), userData = folder(t), workspace = repo
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn: fakeSpawn(() => {}).spawn })
  const prompts = new Map()
  let rootTurns = 0
  const runtime = runtimeWith({ restartHost: host, runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    prompts.set(name, [...(prompts.get(name) || []), prompt])
    if (name === 'Orbit' && ++rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Check the change', reason: 'Separate check' }), tool('wait_agent'))
    return { text: 'Done' }
  } })
  assert.equal((await finished(runtime, payload(workspace))).snapshot.status, 'completed')
  assert.match(prompts.get('Orbit')[0], /\nrestart_orbit \{reason,continueWith,verify\?\}: root only; applies changes to Orbit's OWN code/)
  assert.doesNotMatch(prompts.get('Helper')[0], /restart_orbit/)
  for (const [options, extra] of [[{}, { chatId: 'chat-no-host' }], [{ restartHost: host }, { chatId: 'chat-read-only', accessMode: 'read-only' }], [{ restartHost: resume.createRestartHost({ repoRoot: folder(t), userData }) }, { chatId: 'chat-packaged' }]]) {
    const seen = []
    const other = runtimeWith({ ...options, runProvider: async ({ prompt }) => { seen.push(prompt); return { text: 'Done' } } })
    await finished(other, payload(workspace, extra))
    assert.doesNotMatch(seen[0], /restart_orbit/, extra.chatId)
  }
})

test('a stop cancels the running script, the shutdown for the restart does not; one restart at a time', async t => {
  const repo = repository(t), userData = folder(t)
  const killed = []
  const { spawn, calls } = fakeSpawn(child => child.stdout.write('==> test\n'))
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn, kill: child => { killed.push(child); child.exit(null, 'SIGTERM') } })
  // The user stops the run while the checks run: the script is stopped and the call ends as cancelled.
  const first = await liveRun(t, { restartHost: host })
  const stopped = first.runtime.executeTool(first.run, first.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => calls.length === 1)
  first.runtime.stop(first.run.runId)
  await assert.rejects(stopped, /Run cancelled/)
  assert.deepEqual(killed, [calls[0].child])

  // Orbit shuts down for this very restart: the run ends as restarting and the script, now restarting Orbit, is left
  // alone, while the call ends at once (the shutdown must not wait for a script that finishes only after it).
  const second = await liveRun(t, { restartHost: host }, { chatId: 'chat-2' })
  const pending = second.runtime.executeTool(second.run, second.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => calls.length === 2)
  writeIntent(userData, { runId: second.run.runId, chatId: 'chat-2' })
  const cutOff = assert.rejects(pending, /Run cancelled/)
  assert.deepEqual(resume.markRestartingRuns({ runtime: second.runtime, userData }), [second.run.runId])
  await cutOff
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(killed.length, 1, 'the script was not stopped')
  assert.equal(second.run.status, 'restarting')
  assert.equal(host.inFlight()?.runId, second.run.runId, 'the script still runs')
  calls[1].child.exit(0)
  await waitFor(() => host.inFlight() === null)

  // A second call of the same run (a model retrying after its MCP client stopped waiting) joins the script in flight;
  // a request for another run is refused while it runs.
  const third = await liveRun(t, { restartHost: host }, { chatId: 'chat-3' })
  const once = third.runtime.executeTool(third.run, third.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => calls.length === 3)
  const again = third.runtime.executeTool(third.run, third.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  const busy = await host.request({ run: { runId: 'another-run', chatId: 'x', projectId: 'y' }, agent: { id: 'root' }, reason: 'r', continueWith: 'c', verify: true })
  assert.deepEqual([busy.ok, busy.status], [false, 'busy'])
  writeReport(repo, { ok: true, status: 'reloaded', level: 'renderer' })
  calls[2].child.exit(0)
  const [a, b] = await Promise.all([once, again])
  assert.equal(a.level, 'renderer')
  assert.deepEqual(a, b)
  assert.equal(calls.length, 3, 'one script served both calls')
})

test('the host runs the script with Node in the repository, streams its lines and reads a fresh report', async t => {
  const repo = repository(t), userData = folder(t)
  const script = path.join(repo, 'scripts', 'self-upgrade.cjs')
  fs.writeFileSync(script, [
    "const fs = require('node:fs'), path = require('node:path')",
    "const root = path.resolve(__dirname, '..')",
    "console.log('args ' + JSON.stringify(process.argv.slice(2)))",
    "console.error('env ' + JSON.stringify([process.env.ORBIT_RUN_ID, process.env.ORBIT_RESTART_SOURCE, process.env.ORBIT_RESUME_FILE, process.cwd()]))",
    "fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })",
    "fs.writeFileSync(path.join(root, 'artifacts', 'self-upgrade-last.json'), JSON.stringify({ ok: true, status: 'reloaded', level: 'renderer' }))",
    "process.stdout.write('\\u001b[32mlast line\\u001b[39m without a newline')",
  ].join('\n'))
  const host = resume.createRestartHost({ repoRoot: repo, userData, nodeCommand: process.execPath })
  const request = { run: { runId: 'run-1', chatId: 'chat-1', projectId: 'project-1' }, agent: { id: 'root' }, reason: 'A reason with "quotes" and spaces', continueWith: 'Line one\nline two \\ end', verify: false }
  const lines = []
  const result = await host.request({ ...request, onLine: line => lines.push(line) })
  assert.deepEqual([result.ok, result.level, result.status, result.exitCode], [true, 'renderer', 'reloaded', 0])
  assert.deepEqual(JSON.parse(lines.find(line => line.startsWith('args ')).slice(5)), ['--no-verify', '--reason', 'A reason with "quotes" and spaces', '--continue-with', 'Line one\nline two \\ end'])
  const env = JSON.parse(lines.find(line => line.startsWith('env ')).slice(4))
  assert.deepEqual(env.slice(0, 3), ['run-1', 'tool', path.join(userData, 'pending-resume.json')])
  assert.equal(fs.realpathSync(env[3]), fs.realpathSync(repo), 'the script runs in the repository')
  assert.ok(lines.includes('last line without a newline'), 'colours are stripped and the unterminated last line is kept')

  // A failing script with only an old report: the exit code and the output, and no status taken from the stale report.
  const old = new Date(Date.now() - 60000)
  fs.utimesSync(path.join(repo, 'artifacts', 'self-upgrade-last.json'), old, old)
  fs.writeFileSync(script, "console.log('==> typecheck'); console.error('boom'); process.exitCode = 3")
  const failed = await host.request(request)
  assert.deepEqual([failed.ok, failed.status, failed.exitCode, failed.error], [false, 'failed', 3, null])
  assert.match(failed.output, /==> typecheck/)
  assert.match(failed.output, /boom/)
  // A binary that does not exist: the spawn error, not a hang.
  const missing = await resume.createRestartHost({ repoRoot: repo, userData, nodeCommand: path.join(repo, 'no-such-node.exe') }).request(request)
  assert.deepEqual([missing.ok, missing.status], [false, 'spawn-failed'])
})

test('while restart_orbit runs the script, a message in another chat waits until the script has finished', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(child => child.stdout.write('==> typecheck\n'))
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn })
  const { runtime, run, root } = await liveRun(t, { restartHost: host })
  assert.equal(host.inFlight(), null)
  const pending = runtime.executeTool(run, root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => calls.length === 1)
  assert.deepEqual(host.inFlight(), { runId: run.runId, chatId: 'chat-1', projectId: 'project-1' })
  // Another chat, a chat of another project, a new chat: each would be cut off by the restart.
  const elsewhere = folder(t)
  for (const extra of [{ chatId: 'chat-other' }, { projectId: 'project-2', chatId: 'chat-other' }, { chatId: undefined }]) {
    await assert.rejects(runtime.start(payload(elsewhere, { prompt: 'Something else', ...extra })), error => error.message === 'Orbit сейчас применяет изменения своего кода и перезапустится; отправьте сообщение после перезапуска.')
  }
  assert.deepEqual([...runtime.runs.keys()], [run.runId], 'nothing else started')
  writeReport(repo, { status: 'up-to-date' })
  await calls[0].child.exit(0)
  assert.equal((await pending).level, 'none')
  assert.equal(host.inFlight(), null)
  runtime.stop(await runtime.start(payload(elsewhere, { chatId: 'chat-other', prompt: 'Something else' })))
})

test('a chat started while the user is asked to approve restart_orbit makes the restart refuse', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(child => child.exit(0))
  let owner = null, other = null
  const requestApproval = async () => { other = await owner.start(payload(folder(t), { chatId: 'chat-other', prompt: 'Started while the dialog was open' })); return true }
  const { runtime, run, root } = await liveRun(t, { restartHost: resume.createRestartHost({ repoRoot: repo, userData, spawn }), requestApproval }, { approvalPolicy: 'on-request' })
  owner = runtime
  t.after(() => { if (other) runtime.stop(other) })
  await assert.rejects(runtime.executeTool(run, root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), /1 other chat\(s\) are still working[\s\S]*Started while the dialog was open/)
  assert.ok(other, 'the other chat started meanwhile')
  assert.equal(calls.length, 0, 'nothing was started')
})

test('only the root agent\'s commands carry the restart variables, with this Orbit\'s profile, and none under the dev server', async t => {
  const repo = repository(t), userData = folder(t), workspace = repo
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn: fakeSpawn(() => {}).spawn })
  const names = ['ORBIT_RUN_ID', 'ORBIT_RESUME_FILE', 'ORBIT_USER_DATA']
  const script = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map(name => process.env[name] || null)))`
  const envs = new Map()
  let rootTurns = 0, helperTurns = 0
  const runtime = runtimeWith({ restartHost: host, runProvider: async ({ prompt, extraEnv }) => {
    const [, name] = identity(prompt)
    envs.set(name, [...(envs.get(name) || []), extraEnv])
    if (name === 'Orbit' && ++rootTurns === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Print the environment', reason: 'Separate check' }), tool('wait_agent'))
    if (name === 'Helper' && ++helperTurns === 1) return response(tool('run_command', { command: process.execPath, args: ['-e', script] }))
    return { text: 'Done' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  const helper = snapshot.agents.find(agent => agent.name === 'Helper')
  const observation = snapshot.traces.find(trace => trace.kind === 'observation' && trace.agentId === helper.id && trace.text.startsWith('run_command:'))
  assert.deepEqual(JSON.parse(JSON.parse(observation.text.slice('run_command: '.length)).stdout), names.map(name => process.env[name] || null), 'a helper\'s command gets none of them')
  assert.ok(envs.get('Helper').every(env => env === undefined), 'nor does a helper\'s provider CLI')
  assert.deepEqual(envs.get('Orbit')[0], { ORBIT_RUN_ID: runId, ORBIT_CHAT_ID: 'chat-1', ORBIT_PROJECT_ID: 'project-1', ORBIT_AGENT_ID: 'root', ORBIT_RESUME_FILE: host.resumeFile, ORBIT_USER_DATA: userData })
  // Under the Vite dev server the script refuses to run: nothing names the run.
  const live = await liveRun(t, { restartHost: host }, { chatId: 'chat-dev' })
  assert.equal(restart.agentEnv(live.runtime, live.run, live.root).ORBIT_USER_DATA, userData)
  const dev = process.env.ORBIT_DEV
  process.env.ORBIT_DEV = '1'
  try { assert.deepEqual(restart.agentEnv(live.runtime, live.run, live.root), {}) }
  finally { if (dev === undefined) delete process.env.ORBIT_DEV; else process.env.ORBIT_DEV = dev }
})

test('a rolled-back restart names the rollback base and where the reverted change is kept, to be re-applied before fixing', async t => {
  const repo = repository(t), userData = folder(t)
  const patch = path.join(repo, 'artifacts', 'self-upgrade-failed.patch')
  const failed = { label: 'failed', ref: 'refs/orbit/self-upgrade/failed', commit: 'f'.repeat(40) }
  const restored = { ok: false, status: 'rolled-back', level: 'renderer', error: 'the new Orbit reported a failure: renderer did not mount', rollback: { level: 'renderer', base: { source: 'running', commit: '0123456789abcdef0123456789abcdef01234567', reason: 'the code pid 300 was running' }, treeRestored: true, treePaths: ['src'], failed, patch, distRestored: true, recovered: true } }
  const untouched = { ok: false, status: 'rolled-back', level: 'renderer', error: 'no health report within 15000 ms; sources left as they are (no trustworthy rollback base)', rollback: { level: 'renderer', base: { source: null, commit: null, reason: 'no Orbit ran before this restart, so no state is known to work' }, treeRestored: false, treePaths: [], treeNote: 'sources left as they are (no trustworthy rollback base)', failed, patch, distRestored: true, recovered: true } }
  const reports = [restored, untouched]
  const { spawn } = fakeSpawn(async child => { writeReport(repo, reports.shift()); await child.exit(1) })
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn })
  const { runtime, run, root } = await liveRun(t, { restartHost: host })
  const call = () => runtime.executeTool(run, root, 'restart_orbit', { reason: 'New panel', continueWith: 'Check the panel' })
  await assert.rejects(call(), error => {
    assert.match(error.message, /^restart_orbit failed \(self-upgrade status rolled-back, exit code 1: the new Orbit reported a failure: renderer did not mount\)\. The restarted Orbit failed its health check/)
    assert.match(error.message, /your changes to src\/ were reverted to the rollback base running 0123456789ab\. They are kept in artifacts\/self-upgrade-failed\.patch and refs\/orbit\/self-upgrade\/failed: re-apply them before fixing \(git restore --source=refs\/orbit\/self-upgrade\/failed --worktree -- src\)/)
    assert.doesNotMatch(error.message, /Nothing was restarted/)
    return true
  })
  await assert.rejects(call(), error => {
    assert.match(error.message, /your source files were left as they are \(no Orbit ran before this restart, so no state is known to work\), and the failed change is also kept in artifacts\/self-upgrade-failed\.patch and refs\/orbit\/self-upgrade\/failed/)
    assert.doesNotMatch(error.message, /Nothing was restarted|re-apply/)
    return true
  })
  assert.equal(run.status, 'working', 'the agent goes on')
  // What the host passes on: the base, the paths that came back (not the pathspecs that kept the shell files), the
  // patch relative to the repository, the ref.
  reports.push({ ...restored, level: 'runtime', rollback: { ...restored.rollback, level: 'runtime', treePaths: ['electron', ':(exclude)electron/main.cjs'] } })
  const result = await host.request({ run: { runId: 'run-x', chatId: 'chat-x', projectId: 'project-x' }, agent: { id: 'root' }, reason: 'r', continueWith: 'c', verify: true })
  assert.deepEqual(result.rollback, { base: 'running 0123456789ab', reason: 'the code pid 300 was running', restored: ['electron'], patch: 'artifacts/self-upgrade-failed.patch', failedRef: 'refs/orbit/self-upgrade/failed' })
})

test('a watcher that failed ends the wait at once with a failed notice carrying its error, and nothing is continued', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  runStore.save({ runId: 'plain-run', status: 'restarting', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), startPayload: { workspace, providerId: 'test', projectId: 'project-1', chatId: 'chat-1' }, restart: marked() })
  const started = []
  const runtime = { runStore, start: async request => { started.push(request); return 'new-run' } }
  const file = path.join(userData, 'pending-resume.json')
  // As the watcher's catch writes it (scripts/self-upgrade.cjs runWatcher).
  writeIntent(userData, { runId: 'plain-run', verdict: 'failed', verdictAt: new Date().toISOString(), error: 'watcher error: boom' })
  assert.equal(resume.readResumeIntent(file).verdict, 'failed')
  const began = Date.now()
  const notice = await resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 })
  assert.deepEqual([notice.kind, notice.text, notice.error], ['failed', 'Перезапуск не подтверждён: наблюдатель самообновления завершился с ошибкой (watcher error: boom), продолжение не запущено', 'watcher error: boom'])
  assert.ok(Date.now() - began < 2500, 'no wait for a verdict already given')
  assert.equal(fs.existsSync(file), false)
  // The watcher fails while the start waits for its verdict.
  writeIntent(userData, { runId: 'plain-run', verdict: null, verdictAt: null })
  setTimeout(() => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), verdict: 'failed', verdictAt: new Date().toISOString(), error: 'watcher error: late' })), 60)
  const late = await resume.resumePending({ runtime, userData, verdictWaitMs: 5000, pollMs: 10 })
  assert.deepEqual([late.kind, late.error], ['failed', 'watcher error: late'])
  assert.deepEqual(started, [], 'nothing was continued')
})

test('the intent is used once: a delete that keeps failing renames it, one that cannot be removed continues nothing, and a continued run is not continued again', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  const saveRun = (runId, fields = {}) => runStore.save({ runId, status: 'restarting', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), startPayload: { workspace, providerId: 'test', projectId: 'project-1', chatId: 'chat-1' }, restart: marked(), ...fields })
  const started = []
  const runtime = { runStore, start: async request => { started.push(request); return `new-run-${started.length}` } }
  const file = path.join(userData, 'pending-resume.json')
  const { rmSync, renameSync } = fs
  t.after(() => { fs.rmSync = rmSync; fs.renameSync = renameSync })
  const denied = (operation, original) => (target, ...rest) => {
    if (path.resolve(String(target)) === file) throw Object.assign(new Error(`EPERM: operation not permitted, ${operation} '${file}'`), { code: 'EPERM' })
    return original.call(fs, target, ...rest)
  }
  // Something holds the file and every delete fails: the intent becomes a tombstone nothing reads.
  fs.rmSync = denied('unlink', rmSync)
  saveRun('plain-run')
  writeIntent(userData, { runId: 'plain-run' })
  assert.equal((await resume.resumePending({ runtime, userData })).kind, 'resumed')
  assert.equal(fs.existsSync(file), false)
  assert.ok(fs.existsSync(`${file}.consumed`), 'renamed to a tombstone')
  // Neither a delete nor a rename works: the intent stays, so the run is not continued (it could be twice).
  fs.renameSync = denied('rename', renameSync)
  saveRun('stuck-run')
  writeIntent(userData, { runId: 'stuck-run' })
  const stuck = await resume.resumePending({ runtime, userData })
  assert.deepEqual([stuck.kind, stuck.text], ['failed', 'Продолжение не запущено: файл намерения не удалось удалить, и задача могла бы продолжиться дважды'])
  assert.equal(started.length, 1)
  fs.rmSync = rmSync; fs.renameSync = renameSync
  // A run that already has a continuation, in the run history or live in this runtime, is not continued again, and
  // nobody is told: that continuation was announced when it started.
  saveRun('continued-run')
  runStore.save({ runId: 'its-continuation', status: 'completed', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), resumedFrom: 'continued-run', resumeChain: 1 })
  saveRun('live-run')
  const notices = []
  writeIntent(userData, { runId: 'continued-run' })
  assert.equal(await resume.resumePending({ runtime, userData, notify: notice => notices.push(notice) }), null)
  writeIntent(userData, { runId: 'live-run' })
  const live = { ...runtime, runs: new Map([['live-continuation', { runId: 'live-continuation', resumedFrom: 'live-run' }]]) }
  assert.equal(await resume.resumePending({ runtime: live, userData, notify: notice => notices.push(notice) }), null)
  assert.deepEqual(notices, [])
  assert.equal(started.length, 1, 'nothing was continued twice')
  assert.equal(fs.existsSync(file), false, 'the used-up intent is removed')
})

test('a stop leaves the cancel marker for the script and its watcher and releases the killed script\'s lock; the next request clears the marker', async t => {
  const repo = repository(t), userData = folder(t)
  const artifacts = path.join(repo, 'artifacts'), lock = path.join(artifacts, 'self-upgrade.lock'), marker = path.join(artifacts, 'self-upgrade-cancel.json')
  fs.mkdirSync(artifacts)
  const killed = [], markerAtStart = []
  const fake = fakeSpawn(child => child.stdout.write('==> typecheck\n'))
  // Fake pids, stopped only by the fake kill below (never by taskkill).
  const spawn = (...args) => { markerAtStart.push(fs.existsSync(marker)); const child = fake.spawn(...args); child.pid = 64000 + fake.calls.length; return child }
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn, kill: child => { killed.push(child.pid); child.exit(null, 'SIGTERM') } })
  // The user stops the run during the checks, while the script holds the lock.
  const first = await liveRun(t, { restartHost: host })
  const stopped = first.runtime.executeTool(first.run, first.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => fake.calls.length === 1)
  const pid = fake.calls[0].child.pid
  fs.writeFileSync(lock, JSON.stringify({ pid, startedAt: Date.now(), role: 'upgrade' }))
  const before = Date.now()
  first.runtime.stop(first.run.runId)
  await assert.rejects(stopped, /Run cancelled/)
  assert.deepEqual(killed, [pid])
  assert.equal(fs.existsSync(lock), false, 'the lock of the killed script is released')
  const cancel = JSON.parse(fs.readFileSync(marker, 'utf8'))
  assert.deepEqual(Object.keys(cancel).sort(), ['reason', 'requestedAt'])
  assert.equal(cancel.reason, 'user-stop')
  assert.ok(cancel.requestedAt >= before && cancel.requestedAt <= Date.now())
  assert.deepEqual(fs.readdirSync(artifacts).filter(name => name.endsWith('.tmp')), [], 'written in one piece: no temporary file is left')
  // The next request removes the marker before its script starts. Stopped in the restart phase, when the detached
  // watcher holds the lock, that lock stays: the watcher sees the marker and releases it itself.
  const second = await liveRun(t, { restartHost: host }, { chatId: 'chat-2' })
  const again = second.runtime.executeTool(second.run, second.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => fake.calls.length === 2)
  assert.deepEqual(markerAtStart, [false, false], 'no marker when a script starts')
  const watcherLock = JSON.stringify({ pid: 999999, startedAt: Date.now(), role: 'watcher' })
  fs.writeFileSync(lock, watcherLock)
  second.runtime.stop(second.run.runId)
  await assert.rejects(again, /Run cancelled/)
  assert.deepEqual(killed, [pid, fake.calls[1].child.pid])
  assert.equal(fs.readFileSync(lock, 'utf8'), watcherLock, 'a lock the killed script did not hold stays')
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).reason, 'user-stop')
  // While that stopped upgrade's watcher is alive (a live pid, a fresh heartbeat), a new request leaves the marker for it:
  // clearing it would let the watcher restart after all. A stale lock no longer protects the marker.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), role: 'watcher' }))
  const third = await liveRun(t, { restartHost: host }, { chatId: 'chat-3' })
  const kept = third.runtime.executeTool(third.run, third.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => fake.calls.length === 3)
  assert.equal(markerAtStart[2], true, 'the marker stays while a live watcher holds the lock')
  third.runtime.stop(third.run.runId)
  await assert.rejects(kept, /Run cancelled/)
  const stale = (Date.now() - 120000) / 1000
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 120000, role: 'watcher' }))
  fs.utimesSync(lock, stale, stale)
  const fourth = await liveRun(t, { restartHost: host }, { chatId: 'chat-4' })
  const cleared = fourth.runtime.executeTool(fourth.run, fourth.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })
  await waitFor(() => fake.calls.length === 4)
  assert.equal(markerAtStart[3], false, 'a stale lock does not keep the marker')
  fourth.runtime.stop(fourth.run.runId)
  await assert.rejects(cleared, /Run cancelled/)
})

test('restart_orbit is offered and accepted only in runs on Orbit\'s own repository', async t => {
  const repo = repository(t), userData = folder(t)
  const { spawn, calls } = fakeSpawn(async child => { writeReport(repo, { status: 'up-to-date' }); await child.exit(0) })
  const host = resume.createRestartHost({ repoRoot: repo, userData, spawn })
  // Another project: its root never hears of the tool, and a call is refused.
  const prompts = []
  const elsewhere = runtimeWith({ restartHost: host, runProvider: async ({ prompt }) => { prompts.push(prompt); return { text: 'Done' } } })
  assert.equal((await finished(elsewhere, payload(folder(t), { chatId: 'chat-elsewhere' }))).snapshot.status, 'completed')
  assert.doesNotMatch(prompts[0], /restart_orbit/)
  const other = await liveRun(t, { restartHost: host }, { workspace: folder(t), chatId: 'chat-other-project' })
  assert.equal(restart.restartOffered(other.runtime, other.run, other.root), false)
  await assert.rejects(other.runtime.executeTool(other.run, other.root, 'restart_orbit', { reason: 'r', continueWith: 'c' }), /available only in a run whose workspace is Orbit's repository \(.+\), a folder in it or a folder that contains it; this run works in .+\. Nothing was restarted\./)
  assert.equal(calls.length, 0)
  // A folder inside the repository, a folder that contains it and, on Windows, the repository in other letter case.
  fs.mkdirSync(path.join(repo, 'src'))
  const inside = await liveRun(t, { restartHost: host }, { workspace: path.join(repo, 'src'), chatId: 'chat-inside' })
  assert.equal(restart.restartOffered(inside.runtime, inside.run, inside.root), true)
  assert.equal(restart.restartOffered(inside.runtime, { ...inside.run, workspace: path.dirname(repo) }, inside.root), true)
  if (process.platform === 'win32') assert.equal(restart.restartOffered(inside.runtime, { ...inside.run, workspace: repo.toUpperCase() }, inside.root), true)
  assert.equal(restart.restartOffered(inside.runtime, inside.run, { id: 'helper-1' }), false, 'root only')
  assert.equal((await inside.runtime.executeTool(inside.run, inside.root, 'restart_orbit', { reason: 'r', continueWith: 'c' })).level, 'none')
})

test('only the intent that marked the run continues it: another intent, or a run no shutdown marked, gets a failed notice', async t => {
  const userData = folder(t), workspace = folder(t)
  const runStore = new RunStore(userData)
  const saveRun = (runId, fields = {}) => runStore.save({ runId, status: 'restarting', projectId: 'project-1', chatId: 'chat-1', workspace, startedAt: new Date().toISOString(), startPayload: { workspace, providerId: 'test', projectId: 'project-1', chatId: 'chat-1' }, restart: marked(), ...fields })
  saveRun('marked-run')
  saveRun('unmarked-run', { restart: { reason: 'New tool', requestedAt: new Date().toISOString(), source: 'script' } })
  saveRun('interrupted-run', { status: 'interrupted', restart: undefined })
  const started = []
  const runtime = { runStore, start: async request => { started.push(request); return 'new-run' } }
  const refused = id => `Продолжение не запущено: запуск не был завершён этим перезапуском (намерение ${id})`
  for (const [fields, text] of [
    [{ runId: 'marked-run', id: 'forged-intent' }, refused('forged-intent')],
    [{ runId: 'marked-run', id: '' }, refused('без идентификатора')],
    [{ runId: 'unmarked-run' }, refused('upgrade-1')],
    [{ runId: 'interrupted-run' }, refused('upgrade-1')],
  ]) {
    writeIntent(userData, fields)
    const notice = await resume.resumePending({ runtime, userData })
    assert.deepEqual([notice.kind, notice.text], ['failed', text], `${fields.runId} ${fields.id ?? ''}`)
  }
  assert.deepEqual(started, [])
  writeIntent(userData, { runId: 'marked-run' })
  assert.equal((await resume.resumePending({ runtime, userData })).kind, 'resumed')
  assert.equal(started.length, 1)
})
