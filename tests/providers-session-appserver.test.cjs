const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { closeSession } = require('../electron/providers.mts')
const codexServer = require('../electron/codex-server.mts')
const { until, helpers } = require('./helpers-providers-session.cjs')

test('Codex App Server session: one process and thread across turns, MCP overrides, approvals, close kills the process', async t => {
  const launches = []
  const events = []
  const session = { id: null, resume: false, token: 'app-token', mcpUrl: 'http://127.0.0.1:9/mcp' }
  const base = { workspace: process.cwd(), accessMode: 'workspace-write', approvalPolicy: 'on-request', onEvent: event => events.push(event), onApproval: async () => true, inactivityMs: 3000 }
  const first = await codexServer.runCodexSessionTurn({ ...base, prompt: 'one' }, session, helpers(launches))
  assert.equal(first.transport, 'session'); assert.equal(first.client, 'Codex App Server'); assert.equal(first.text, 'Turn 1: one'); assert.equal(first.model, 'fixture-model')
  const pid = Number(first.sessionId.replace('thread-', ''))
  assert.ok(pid > 0)
  t.after(async () => { await codexServer.closeSession(first.sessionId) })
  assert.deepEqual(events.filter(event => event.kind === 'session').map(event => event.sessionId), [first.sessionId], 'the thread is named before the turn runs')
  assert.ok(events.findIndex(event => event.kind === 'session') < events.findIndex(event => event.kind === 'tool'))
  assert.ok(launches[0].includes('mcp_servers.orbit.url="http://127.0.0.1:9/mcp"') && launches[0].includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"') && launches[0].includes('features.multi_agent=false'))
  assert.equal(launches[0][launches[0].indexOf('mcp_servers.orbit.tool_timeout_sec=3600') - 1], '-c', 'the App Server gets the same per-call tool timeout as exec')
  const orbitCall = events.find(event => event.kind === 'tool' && event.toolId === 'mcp')
  assert.ok(orbitCall.orbitTool === 'memory_search' && orbitCall.native === false)
  let approvals = 0
  const second = await codexServer.runCodexSessionTurn({ ...base, prompt: 'two', onApproval: async request => { approvals++; assert.equal(request.arguments.command, 'npm test'); return false } }, { ...session, id: first.sessionId, resume: true }, helpers(launches))
  assert.equal(second.sessionId, first.sessionId, 'the same thread'); assert.equal(second.text, 'Decision: decline'); assert.equal(approvals, 1)
  assert.equal(launches.length, 1, 'a resume reuses the live process instead of spawning one')
  assert.doesNotThrow(() => process.kill(pid, 0), 'the App Server stays alive between turns')
  const live = codexServer.sessions.get(first.sessionId)
  const concurrent = live.turn('three')
  await assert.rejects(live.turn('four'), /already running/)
  assert.equal((await concurrent).text, 'Turn 3: three')
  assert.equal(await codexServer.closeSession(first.sessionId), true)
  assert.equal(codexServer.sessions.has(first.sessionId), false)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'closeSession resolves once the process tree is gone')
  assert.equal(await codexServer.closeSession(first.sessionId), false)
  assert.equal(await closeSession('never-existed'), false)
  // A resume whose process is gone starts a new one; the fixture cannot resume the recorded thread, so a fresh thread answers.
  const revived = await codexServer.runCodexSessionTurn({ ...base, prompt: 'five' }, { ...session, id: first.sessionId, resume: true }, helpers(launches))
  assert.equal(launches.length, 2)
  assert.notEqual(revived.sessionId, first.sessionId); assert.equal(revived.text, 'Turn 1: five')
  await codexServer.closeSession(revived.sessionId)
})

test('Codex App Server session: the stable Orbit block is the thread\'s developer instructions, on thread/start and thread/resume', async t => {
  const launches = []
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-threads-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const fixture = helpers(launches, { FIXTURE_LOG: path.join(folder, 'requests.jsonl') })
  const requests = prefix => fs.readFileSync(path.join(folder, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.method.startsWith(prefix))
  const base = { workspace: process.cwd(), accessMode: 'workspace-write', approvalPolicy: 'on-request', inactivityMs: 3000 }
  const session = { id: null, resume: false, token: 't', mcpUrl: 'http://127.0.0.1:9/mcp', systemAppend: 'STABLE ORBIT BLOCK "quoted"\nline two' }
  const first = await codexServer.runCodexSessionTurn({ ...base, prompt: 'one' }, session, fixture)
  await codexServer.closeSession(first.sessionId)
  // The process is gone: the resume asks thread/resume (the fixture refuses it) and then starts a thread, both with the block.
  const revived = await codexServer.runCodexSessionTurn({ ...base, prompt: 'two' }, { ...session, id: first.sessionId, resume: true }, fixture)
  await codexServer.closeSession(revived.sessionId)
  const plain = await codexServer.runCodexSessionTurn({ ...base, prompt: 'three' }, { ...session, systemAppend: '' }, fixture)
  await codexServer.closeSession(plain.sessionId)
  assert.deepEqual(requests('thread/').map(entry => [entry.method, entry.params.developerInstructions]), [
    ['thread/start', session.systemAppend], ['thread/resume', session.systemAppend], ['thread/start', session.systemAppend], ['thread/start', undefined],
  ])
  assert.ok(launches.flat().every(arg => !arg.includes('developer_instructions')), 'the App Server gets the block in its requests, not on its command line')
  // A string bounded inside an emoji (an agent's name, a chat message) goes out well-formed: Codex drops a JSON-RPC line
  // with an escaped lone surrogate and never answers it.
  const cut = await codexServer.runCodexSessionTurn({ ...base, prompt: 'cut \ud83d' }, { ...session, systemAppend: 'name \ud83d' }, fixture)
  await codexServer.closeSession(cut.sessionId)
  assert.equal(requests('thread/').at(-1).params.developerInstructions, 'name �')
  assert.equal(requests('turn/').at(-1).params.input[0].text, 'cut �')
})

test('Codex App Server session: a dying process fails the turn and forgets the session; cancellation kills it', async () => {
  const launches = []
  const base = { workspace: process.cwd(), accessMode: 'workspace-write', approvalPolicy: 'on-request', inactivityMs: 3000 }
  const session = { id: null, resume: false, token: 't', mcpUrl: 'http://127.0.0.1:9/mcp' }
  await assert.rejects(codexServer.runCodexSessionTurn({ ...base, prompt: 'crash' }, session, helpers(launches)), /closed/)
  assert.equal(codexServer.sessions.size, 0)
  const controller = new AbortController()
  const first = await codexServer.runCodexSessionTurn({ ...base, prompt: 'one' }, session, helpers(launches))
  const pid = Number(first.sessionId.replace('thread-', ''))
  const pending = codexServer.runCodexSessionTurn({ ...base, prompt: 'two', signal: controller.signal, onApproval: () => { controller.abort(); return new Promise(() => {}) } }, { ...session, id: first.sessionId, resume: true }, helpers(launches))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'cancellation settles after the process tree is gone')
  assert.equal(codexServer.sessions.has(first.sessionId), false)
  // A turn the server never answers is ended by the inactivity guard, which also ends the session.
  const silent = await codexServer.runCodexSessionTurn({ ...base, prompt: 'one' }, session, helpers(launches))
  const silentPid = Number(silent.sessionId.replace('thread-', ''))
  await assert.rejects(codexServer.runCodexSessionTurn({ ...base, prompt: 'hang', inactivityMs: 300 }, { ...session, id: silent.sessionId, resume: true }, helpers(launches)), error => error.name === 'TimeoutError' && /no output for 300 ms/.test(error.message))
  assert.throws(() => process.kill(silentPid, 0), { code: 'ESRCH' })
  assert.equal(codexServer.sessions.size, 0)
})

test('Codex App Server session: a cancellation while the session opens kills the process and keeps no session; one at the thread\'s event closes only a session the call opened', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-open-cancel-'))
  // Fixture processes not yet shown to be gone: a failed assertion leaves none running. One shown gone is dropped, as
  // Windows reuses pids.
  const unproven = new Set()
  t.after(async () => {
    for (const pid of unproven) { try { process.kill(pid) } catch { /* Already gone. */ } }
    for (const id of [...codexServer.sessions.keys()]) await codexServer.closeSession(id)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const gone = (pid, message) => { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, message); unproven.delete(pid) }
  const launches = []
  const base = { workspace: process.cwd(), accessMode: 'workspace-write', approvalPolicy: 'on-request', inactivityMs: 3000 }
  const session = { id: null, resume: false, token: 't', mcpUrl: 'http://127.0.0.1:9/mcp' }
  const pidIn = file => { try { return Number(fs.readFileSync(file, 'utf8')) } catch { return 0 } }
  for (const [hold, opening] of [['initialize', session], ['thread/start', session], ['thread/resume', { ...session, id: 'thread-gone', resume: true }]]) {
    const mark = path.join(directory, hold.replace('/', '-'))
    const controller = new AbortController(), events = []
    const pending = codexServer.runCodexSessionTurn({ ...base, prompt: 'one', signal: controller.signal, onEvent: event => events.push(event) }, opening, helpers(launches, { FIXTURE_HOLD: hold, FIXTURE_MARK: mark }))
    await until(() => pidIn(mark) > 0)
    const pid = pidIn(mark); unproven.add(pid)
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' }, `cancelled during ${hold}`)
    gone(pid, `the open fails once the process tree is gone (${hold})`)
    assert.equal(codexServer.sessions.size, 0, `no session is kept (${hold})`)
    assert.ok(!events.some(event => event.kind === 'session'), `no thread is named (${hold})`)
  }
  const started = launches.length
  await assert.rejects(codexServer.openCodexSession({ ...base, signal: AbortSignal.abort() }, session, helpers(launches)), { name: 'AbortError' })
  assert.equal(launches.length, started, 'a cancelled open starts nothing')
  // Cancelled in the same read as the thread's answer (by the rate-limit notice that follows it): nothing is kept either.
  const sameRead = new AbortController()
  await assert.rejects(codexServer.runCodexSessionTurn({ ...base, prompt: 'one', signal: sameRead.signal, onEvent: event => { if (event.kind === 'quota') sameRead.abort() } }, session, helpers(launches, { FIXTURE_TRAIL: '1' })), { name: 'AbortError' })
  assert.equal(codexServer.sessions.size, 0, 'no session is kept after a cancellation in the same read')
  // The runtime stops the turn on the thread's event when the server opened another thread than the one to resume: the
  // session this call opened is closed; a live session the call reused stays for the next turn.
  const stray = new AbortController()
  let strayPid = 0
  const strayed = codexServer.runCodexSessionTurn({ ...base, prompt: 'one', signal: stray.signal, onEvent: event => { if (event.kind === 'session') { strayPid = Number(event.sessionId.replace('thread-', '')); unproven.add(strayPid); stray.abort() } } }, { ...session, id: 'thread-gone', resume: true }, helpers(launches))
  await assert.rejects(strayed, { name: 'AbortError' })
  gone(strayPid, 'the opened session is closed')
  assert.equal(codexServer.sessions.size, 0)
  const live = await codexServer.runCodexSessionTurn({ ...base, prompt: 'one' }, session, helpers(launches))
  const livePid = Number(live.sessionId.replace('thread-', ''))
  const reused = new AbortController()
  await assert.rejects(codexServer.runCodexSessionTurn({ ...base, prompt: 'two', signal: reused.signal, onEvent: event => { if (event.kind === 'session') reused.abort() } }, { ...session, id: live.sessionId, resume: true }, helpers(launches)), { name: 'AbortError' })
  assert.ok(codexServer.sessions.has(live.sessionId), 'the reused session stays')
  assert.doesNotThrow(() => process.kill(livePid, 0))
})
