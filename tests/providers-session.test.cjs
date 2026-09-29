const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, transportFor, closeSession, _testing, terminateProcess } = require('../electron/providers.mts')
const { buildClaudeSessionArgs, buildCodexSessionArgs, buildClaudeArgs, normalizeSession, inactivityValue, runCli } = _testing
const codexServer = require('../electron/codex-server.mts')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION = { id: '11111111-2222-4333-8444-555555555555', token: 'tok-secret', mcpUrl: 'http://127.0.0.1:4321/mcp', systemAppend: 'You are an Orbit agent.' }
const after = (values, flag) => values[values.indexOf(flag) + 1]
const count = (values, flag) => values.filter(item => item === flag).length

function withEnv(t, changes) {
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
}
// A fake CLI: a .cmd shim resolveLaunch turns into `node cli.cjs …`, a script that records what it was given.
function fakeCli(t, envKey, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-fixture-'))
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }) })
  const record = path.join(directory, 'record.json')
  fs.writeFileSync(path.join(directory, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  fs.writeFileSync(path.join(directory, 'cli.cjs'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const out = message => console.log(JSON.stringify(message));
    let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { input += part });
    process.stdin.on('end', () => {
      const appendAt = args.indexOf('--append-system-prompt-file');
      const appendFile = appendAt >= 0 ? args[appendAt + 1] : null;
      const record = { args, input, appendFile, appendText: appendFile ? fs.readFileSync(appendFile, 'utf8') : null, env: { idle: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, token: process.env.ORBIT_MCP_TOKEN, noProxy: process.env.NO_PROXY }, cwd: process.cwd() };
      fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(record));
      ${body}
    });
  `)
  withEnv(t, { [envKey]: path.join(directory, 'cli.cmd') })
  return { directory, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) }
}

test('transportFor: the CLIs keep sessions, everything else stays on the envelope, and the escape hatch forces it', t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  assert.equal(transportFor('claude'), 'session')
  assert.equal(transportFor('codex'), 'session')
  for (const id of ['cursor', 'antigravity', 'ollama', 'custom']) assert.equal(transportFor(id), 'envelope')
  assert.equal(transportFor('claude', { transport: 'envelope' }), 'envelope')
  assert.equal(transportFor('claude', { providerOptions: { transport: 'envelope' } }), 'envelope')
  process.env.ORBIT_LEGACY_ENVELOPE = '1'
  assert.equal(transportFor('claude'), 'envelope')
  assert.equal(transportFor('codex'), 'envelope')
})

test('Claude session invocation: chosen session id, inline MCP config, strict tools, temp system prompt, no persistence flag', () => {
  const first = buildClaudeSessionArgs({ accessMode: 'workspace-write', approvalPolicy: 'never', model: 'sonnet', reasoningEffort: 'high' }, { ...SESSION, resume: false }, { appendFile: 'C:\\tmp\\orbit-append.md' })
  assert.deepEqual(first.slice(0, 5), ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
  assert.equal(after(first, '--session-id'), SESSION.id)
  assert.equal(first.includes('--resume'), false)
  assert.deepEqual(JSON.parse(after(first, '--mcp-config')), { mcpServers: { orbit: { type: 'http', url: SESSION.mcpUrl, headers: { Authorization: `Bearer ${SESSION.token}` } } } })
  assert.ok(first.includes('--strict-mcp-config'))
  assert.equal(after(first, '--allowedTools'), 'mcp__orbit__*')
  assert.equal(after(first, '--tools'), 'Read,Glob,Grep')
  assert.equal(after(first, '--append-system-prompt-file'), 'C:\\tmp\\orbit-append.md')
  assert.equal(after(first, '--permission-mode'), 'default')
  assert.equal(first.includes('--permission-prompt-tool'), false, 'only Ask mode routes prompts to Orbit')
  assert.equal(first.includes('--no-session-persistence'), false, 'resume needs the session file')
  assert.equal(first.includes('--max-turns'), false)
  assert.equal(after(first, '--model'), 'sonnet'); assert.equal(after(first, '--effort'), 'high')
  assert.equal(first.includes(SESSION.systemAppend), false, 'the system block travels in the file, not on the command line')
  const ask = buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'on-request' }, { ...SESSION, resume: false })
  assert.equal(after(ask, '--permission-prompt-tool'), 'mcp__orbit__approve')
  assert.equal(after(ask, '--permission-mode'), 'default')
  assert.equal(after(ask, '--tools'), 'Read,Glob,Grep')
  assert.equal(ask.includes('--append-system-prompt-file'), false)
  const full = buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'never' }, { ...SESSION, resume: false })
  assert.equal(after(full, '--permission-mode'), 'bypassPermissions')
  assert.equal(full.includes('--tools'), false)
  assert.equal(after(full, '--allowedTools'), 'mcp__orbit__*')
  const resumed = buildClaudeSessionArgs({ accessMode: 'read-only' }, { ...SESSION, resume: true })
  assert.equal(after(resumed, '--resume'), SESSION.id)
  assert.equal(resumed.includes('--session-id'), false)
  assert.ok(resumed.includes('--mcp-config'), 'every process needs the MCP config, a resume starts a new one')
  const bare = buildClaudeSessionArgs({ accessMode: 'read-only' }, { id: SESSION.id, resume: false, mcpUrl: null, token: null })
  assert.ok(bare.includes('--strict-mcp-config') && !bare.includes('--mcp-config') && !bare.includes('--allowedTools'))
  assert.throws(() => buildClaudeSessionArgs({ accessMode: 'read-only', reasoningEffort: 'ultra' }, { ...SESSION, resume: false }), /Unsupported Claude reasoning effort/)
  // The envelope invocation is untouched.
  const envelope = buildClaudeArgs({ accessMode: 'workspace-write' })
  assert.ok(envelope.includes('--no-session-persistence') && !envelope.includes('--mcp-config') && !envelope.includes('--session-id'))
})

test('Codex session invocation: exec without --ephemeral, MCP config overrides, resume without -C/--sandbox', () => {
  const first = buildCodexSessionArgs({ workspace: 'C:\\ws', accessMode: 'workspace-write', model: 'gpt-5', reasoningEffort: 'high' }, { ...SESSION, id: null, resume: false })
  assert.deepEqual(first.slice(0, 7), ['exec', '--json', '--skip-git-repo-check', '-C', 'C:\\ws', '--sandbox', 'workspace-write'])
  assert.equal(first.includes('--ephemeral'), false)
  assert.ok(first.includes('features.multi_agent=false'))
  assert.ok(first.includes(`mcp_servers.orbit.url="${SESSION.mcpUrl}"`))
  assert.ok(first.includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"'))
  assert.equal(first.includes(SESSION.token), false, 'the token travels in the environment, never on the command line')
  assert.ok(first.includes('approval_policy="never"'))
  assert.equal(after(first, '--model'), 'gpt-5'); assert.ok(first.includes('model_reasoning_effort="high"'))
  assert.equal(first.at(-1), '-')
  const review = buildCodexSessionArgs({ workspace: '.', accessMode: 'workspace-write', approvalPolicy: 'auto-review' }, { ...SESSION, id: null, resume: false })
  assert.ok(review.includes('--approve-for-me') && !review.includes('approval_policy="never"'))
  const resumed = buildCodexSessionArgs({ workspace: 'C:\\ws', accessMode: 'workspace-write' }, { ...SESSION, id: 'thread-abc', resume: true })
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', '--json', '--skip-git-repo-check'])
  assert.ok(!resumed.includes('-C') && !resumed.includes('--sandbox') && !resumed.includes('--approve-for-me') && !resumed.includes('--ephemeral'))
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'))
  assert.ok(resumed.includes(`mcp_servers.orbit.url="${SESSION.mcpUrl}"`))
  assert.deepEqual(resumed.slice(-2), ['thread-abc', '-'])
  const reviewResume = buildCodexSessionArgs({ workspace: '.', accessMode: 'workspace-write', approvalPolicy: 'auto-review' }, { ...SESSION, id: 't', resume: true })
  assert.ok(!reviewResume.includes('--approve-for-me') && !reviewResume.includes('approval_policy="never"'), 'resume keeps the thread\'s own approval policy')
  assert.throws(() => buildCodexSessionArgs({ workspace: '.', accessMode: 'nope' }, { ...SESSION, resume: false }), /Unsupported access mode/)
})

test('normalizeSession chooses a UUID for Claude, keeps ids, and refuses half-configured MCP access', () => {
  const chosen = normalizeSession('claude', { token: 't', mcpUrl: 'http://127.0.0.1:1/mcp' })
  assert.match(chosen.id, UUID); assert.equal(chosen.resume, false); assert.equal(chosen.systemAppend, '')
  assert.equal(normalizeSession('claude', { ...SESSION, resume: true }).id, SESSION.id)
  assert.equal(normalizeSession('codex', { token: 't', mcpUrl: 'u' }).id, null, 'Codex names its own thread')
  assert.throws(() => normalizeSession('claude', { id: 'thread-1', token: 't', mcpUrl: 'u' }), /UUID/)
  assert.throws(() => normalizeSession('claude', { resume: true, token: 't', mcpUrl: 'u' }), /needs its id/)
  assert.throws(() => normalizeSession('claude', { token: 't' }), /both the Orbit MCP url and its token/)
  assert.throws(() => normalizeSession('claude', null), /session options/)
  assert.equal(inactivityValue(undefined) > 0, true); assert.equal(inactivityValue(null), 0); assert.equal(inactivityValue(0), 0)
  assert.throws(() => inactivityValue(-5), /inactivity timeout/)
})

test('runCli inactivity: a silent process is killed, output resets the clock, isBusy defers the verdict, null disables it', async t => {
  withEnv(t, { ORBIT_PROVIDER_INACTIVITY_MS: undefined })
  const silent = runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: 600, timeoutMs: null })
  await assert.rejects(silent, error => error.name === 'TimeoutError' && /no output for 600 ms/.test(error.message))
  const chatty = await runCli(process.execPath, ['-e', 'let n = 0; const i = setInterval(() => { console.log(n++); if (n > 6) { clearInterval(i) } }, 60)'], { inactivityMs: 1000, timeoutMs: null })
  assert.match(chatty.stdout, /6/)
  let checks = 0
  const started = Date.now()
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: 400, timeoutMs: null, isBusy: () => ++checks <= 2 }), { name: 'TimeoutError' })
  assert.equal(checks, 3)
  assert.ok(Date.now() - started >= 1120, 'two busy verdicts each bought another window')
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { inactivityMs: null, timeoutMs: 800 }), error => error.name === 'TimeoutError' && /timed out after 800 ms/.test(error.message))
  process.env.ORBIT_PROVIDER_INACTIVITY_MS = '480'
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: null }), /no output for 480 ms/)
})

test('Claude session run: fixture CLI receives the session flags, the prompt on stdin and the temp system file; ids and MCP tool events come back', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: undefined })
  const cli = fakeCli(t, 'ORBIT_CLAUDE_COMMAND', `
    const sessionId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args[args.indexOf('--resume') + 1];
    out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fixture' });
    out({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'mcp__orbit__memory_save' } } });
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__orbit__memory_save', input: { title: 'x', content: 'y' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }, { type: 'tool_result', tool_use_id: 't2', content: 'file text' }] } });
    out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done: ' + input.trim() }] } });
    out({ type: 'result', subtype: 'success', result: 'Done: ' + input.trim(), session_id: sessionId, usage: { input_tokens: 3, output_tokens: 2 } });
  `)
  const events = []
  const first = await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'workspace-write', approvalPolicy: 'on-request', prompt: 'Первый ход', onEvent: event => events.push(event), session: { token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp', systemAppend: 'STABLE ORBIT BLOCK' } })
  assert.equal(first.transport, 'session'); assert.match(first.sessionId, UUID); assert.equal(first.text, 'Done: Первый ход'); assert.equal(first.model, 'claude-fixture'); assert.equal(first.client, 'Claude Code')
  assert.equal(first.usage, undefined, 'usage reaches the runtime once, through the completion event')
  let record = cli.read()
  assert.equal(after(record.args, '--session-id'), first.sessionId)
  assert.equal(record.input, 'Первый ход')
  assert.equal(record.appendText, 'STABLE ORBIT BLOCK')
  assert.equal(fs.existsSync(record.appendFile), false, 'the temp system file is removed after the run')
  assert.equal(fs.existsSync(path.dirname(record.appendFile)), false)
  assert.ok(Number(record.env.idle) > 5 * 60000, 'Claude Code\'s 5-minute MCP idle limit is raised for long waits')
  assert.match(String(record.env.noProxy), /127.0.0.1/, 'loopback MCP calls bypass HTTP(S)_PROXY')
  assert.equal(after(record.args, '--permission-prompt-tool'), 'mcp__orbit__approve')
  assert.equal(record.args.includes('--no-session-persistence'), false)
  const orbitCall = events.find(event => event.kind === 'tool' && event.orbitTool === 'memory_save' && event.input)
  assert.ok(orbitCall && orbitCall.native === false && orbitCall.mcp === true && orbitCall.tool === 'mcp__orbit__memory_save')
  assert.match(orbitCall.text, /^memory_save \{"title":"x"/)
  const orbitResult = events.find(event => event.kind === 'tool' && event.toolId === 't1' && event.status === 'completed')
  assert.ok(orbitResult && orbitResult.orbitTool === 'memory_save' && orbitResult.native === false && orbitResult.output === '{"ok":true}')
  const nativeCall = events.find(event => event.kind === 'tool' && event.toolId === 't2' && event.input)
  assert.ok(nativeCall.native === true && nativeCall.orbitTool === undefined)
  assert.equal(events.find(event => event.toolId === 't2' && event.status === 'completed').native, true)
  assert.ok(events.some(event => event.kind === 'observation' && event.status === 'completed' && event.usage?.input_tokens === 3))
  const second = await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'Second', session: { id: first.sessionId, resume: true, token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  assert.equal(second.sessionId, first.sessionId); assert.equal(second.text, 'Done: Second')
  record = cli.read()
  assert.equal(after(record.args, '--resume'), first.sessionId)
  assert.equal(record.args.includes('--session-id'), false)
  assert.equal(record.appendFile, null)
  // The escape hatch and a call without session options both keep the envelope invocation.
  process.env.ORBIT_LEGACY_ENVELOPE = '1'
  const legacy = await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'Legacy', session: { token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  assert.equal(legacy.transport, undefined); assert.equal(legacy.sessionId, undefined)
  record = cli.read()
  assert.ok(record.args.includes('--no-session-persistence') && !record.args.includes('--mcp-config') && !record.args.includes('--session-id'))
  delete process.env.ORBIT_LEGACY_ENVELOPE
  await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'Plain' })
  assert.ok(cli.read().args.includes('--no-session-persistence'))
})

test('Claude session run: an explicit total deadline still applies; without one only inactivity does', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const cli = fakeCli(t, 'ORBIT_CLAUDE_COMMAND', `
    out({ type: 'system', subtype: 'init', session_id: 's' });
    if (input === 'hang') setInterval(() => {}, 1000); else { const i = setInterval(() => out({ type: 'stream_event', event: {} }), 50); setTimeout(() => { clearInterval(i); out({ type: 'result', subtype: 'success', result: 'late but fine', session_id: 's' }) }, 1500) }
  `)
  const session = { token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp' }
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session, inactivityMs: 400 }), /no output for 400 ms/)
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session, inactivityMs: 5000, timeoutMs: 150 }), /timed out after 150 ms/)
  let busy = 0
  await assert.rejects(runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'hang', session: { ...session, activity: () => ({ pending: ++busy <= 2 ? 1 : 0, lastAt: Date.now() }) }, inactivityMs: 400 }), /no output for 400 ms/)
  assert.equal(busy, 3, 'an Orbit tool call in flight defers the inactivity verdict')
  // Streaming for 1.5 s with a 700 ms window: every chunk resets the clock (Node itself needs a few hundred ms to start).
  const slow = await runProvider({ providerId: 'claude', workspace: cli.directory, accessMode: 'read-only', prompt: 'stream', session, inactivityMs: 700 })
  assert.equal(slow.text, 'late but fine')
})

test('Codex exec session run: config overrides and token in the environment, thread id from thread.started, resume by id', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const cli = fakeCli(t, 'ORBIT_CODEX_COMMAND', `
    out({ type: 'thread.started', thread_id: args.includes('resume') ? args[args.indexOf('resume') + 1 + args.slice(args.indexOf('resume') + 1).findIndex(a => !a.startsWith('-') && a !== '-' && !/[=]/.test(a) && a !== 'read-only' && a !== 'workspace-write')] : 'thread-fixture-1' });
    out({ type: 'item.started', item: { id: 'mcp1', type: 'mcp_tool_call', server: 'orbit', tool: 'list_agents', status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'mcp1', type: 'mcp_tool_call', server: 'orbit', tool: 'list_agents', status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'a', type: 'agent_message', phase: 'final_answer', text: 'Answer: ' + input } });
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  `)
  const events = []
  const first = await runProvider({ providerId: 'codex', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'hello', onEvent: event => events.push(event), session: { token: 'codex-token', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  assert.equal(first.transport, 'session'); assert.equal(first.sessionId, 'thread-fixture-1'); assert.equal(first.text, 'Answer: hello'); assert.equal(first.client, 'Codex CLI')
  let record = cli.read()
  assert.equal(record.env.token, 'codex-token')
  assert.match(String(record.env.noProxy), /127.0.0.1/, 'loopback MCP calls bypass HTTP(S)_PROXY')
  assert.ok(record.args.includes('mcp_servers.orbit.url="http://127.0.0.1:9/mcp"') && record.args.includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"'))
  assert.ok(!record.args.includes('--ephemeral') && !record.args.includes('--output-schema'))
  assert.equal(record.input, 'hello')
  const orbitCall = events.find(event => event.kind === 'tool' && event.toolId === 'mcp1')
  assert.ok(orbitCall.orbitTool === 'list_agents' && orbitCall.native === false && orbitCall.text === 'orbit/list_agents')
  const second = await runProvider({ providerId: 'codex', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'again', session: { id: 'thread-fixture-1', resume: true, token: 'codex-token', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  record = cli.read()
  assert.deepEqual(record.args.slice(0, 2), ['exec', 'resume'])
  assert.deepEqual(record.args.slice(-2), ['thread-fixture-1', '-'])
  assert.equal(record.cwd.toLowerCase(), fs.realpathSync(cli.directory).toLowerCase(), 'resume has no -C: the process cwd is the workspace')
  assert.equal(second.sessionId, 'thread-fixture-1'); assert.equal(second.text, 'Answer: again')
})

const appServerFixture = `
  const send = message => console.log(JSON.stringify(message));
  let turns = 0;
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'thread/resume') return send({ id: m.id, error: { code: -32602, message: 'unknown thread' } });
    if (m.method === 'thread/start') {
      if (m.params.ephemeral !== false || m.params.approvalPolicy !== 'on-request') throw new Error('session threads persist and ask');
      return send({ id: m.id, result: { thread: { id: 'thread-' + process.pid }, model: 'fixture-model' } });
    }
    if (m.method === 'turn/start') {
      turns++;
      send({ id: m.id, result: { turn: { id: 'turn-' + turns } } });
      const text = m.params.input[0].text;
      if (text === 'crash') return process.exit(3);
      if (text === 'hang') return;
      if (turns === 2) return send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: m.params.threadId, itemId: 'cmd', command: 'npm test' } });
      send({ method: 'item/started', params: { threadId: m.params.threadId, item: { id: 'mcp', type: 'mcpToolCall', server: 'orbit', tool: 'memory_search', arguments: { query: 'q' } } } });
      send({ method: 'item/completed', params: { threadId: m.params.threadId, item: { id: 'msg' + turns, type: 'agentMessage', phase: 'final_answer', text: 'Turn ' + turns + ': ' + text } } });
      send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { status: 'completed' } } });
    }
    if (m.id === 900) {
      send({ method: 'item/completed', params: { item: { id: 'msg2', type: 'agentMessage', text: 'Decision: ' + m.result.decision } } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  });
`
const helpers = launches => ({
  resolveLaunch: (_command, args) => { launches.push(args); return { executable: process.execPath, args: ['-e', appServerFixture], env: process.env } },
  terminateProcess, createLineReader: _testing.createLineReader, busyCheck: () => () => false,
})

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
  assert.ok(launches[0].includes('mcp_servers.orbit.url="http://127.0.0.1:9/mcp"') && launches[0].includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"') && launches[0].includes('features.multi_agent=false'))
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
