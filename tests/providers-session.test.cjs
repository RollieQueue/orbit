const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, transportFor, mcpCallLimit, closeSession, _testing, terminateProcess } = require('../electron/providers.mts')
const { buildClaudeSessionArgs, buildCodexSessionArgs, buildClaudeArgs, normalizeSession, inactivityValue, runCli } = _testing
const codexServer = require('../electron/codex-server.mts')
const { classifyQuotaError } = require('../electron/quota.mts')

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

// A fake CLI that appends one record per invocation: arguments, stdin, working folder, the environment variables Orbit
// sets, and the MCP configuration files Cursor (--plugin-dir) or Antigravity (.agents/plugins/orbit in its cwd) would read.
function recordingCli(t, envKey, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-fixture-'))
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }) })
  const records = path.join(directory, 'records.jsonl')
  fs.writeFileSync(path.join(directory, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  fs.writeFileSync(path.join(directory, 'cli.cjs'), `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const out = message => console.log(JSON.stringify(message));
    const read = file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } };
    let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { input += part });
    process.stdin.on('end', () => {
      const pluginDir = args.includes('--plugin-dir') ? args[args.indexOf('--plugin-dir') + 1] : null;
      const agy = path.join(process.cwd(), '.agents', 'plugins', 'orbit');
      const record = { args, input, cwd: process.cwd(), pluginDir,
        env: { token: process.env.ORBIT_MCP_TOKEN, noProxy: process.env.NO_PROXY, runId: process.env.ORBIT_RUN_ID, extra: process.env.ORBIT_TEST_EXTRA, idle: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT },
        cursorPlugin: pluginDir && read(path.join(pluginDir, '.cursor-plugin', 'plugin.json')), cursorMcp: pluginDir && read(path.join(pluginDir, 'mcp.json')),
        agyPlugin: read(path.join(agy, 'plugin.json')), agyMcp: read(path.join(agy, 'mcp_config.json')), agyRules: read(path.join(agy, 'rules', 'AGENTS.md')) };
      fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify(record) + '\\n');
      ${body}
    });
  `)
  withEnv(t, { [envKey]: path.join(directory, 'cli.cmd') })
  return { directory, records: () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
}
function workspaceFolder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-ws-'))
  fs.writeFileSync(path.join(directory, 'README.md'), 'hello\n')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const samePath = (left, right) => fs.realpathSync(left).toLowerCase() === fs.realpathSync(right).toLowerCase()
async function until(check, ms = 5000) {
  const started = Date.now()
  while (!check()) { if (Date.now() - started > ms) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 20)) }
}

test('transportFor: Antigravity keeps a session in Full access without on-request approvals, Cursor only when opted in; the call limits', t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined, ORBIT_MCP_CALL_LIMIT_MS: undefined, ORBIT_CURSOR_SESSION: undefined })
  const full = { accessMode: 'danger-full-access', approvalPolicy: 'never', model: 'm' }
  assert.equal(transportFor('antigravity', full), 'session')
  assert.equal(transportFor('antigravity', { accessMode: 'danger-full-access' }), 'session')
  // Cursor's session path is not verified live yet: Full access alone keeps the envelope.
  assert.equal(transportFor('cursor', full), 'envelope')
  assert.equal(transportFor('cursor', { accessMode: 'danger-full-access' }), 'envelope')
  // The opt-in: the Cursor provider option as decideTransport spreads it, as runProvider passes it, or the environment.
  assert.equal(transportFor('cursor', { ...full, transport: 'session' }), 'session')
  assert.equal(transportFor('cursor', { ...full, providerOptions: { transport: 'session' } }), 'session')
  for (const [id, optIn] of [['cursor', { transport: 'session' }], ['antigravity', {}]]) {
    assert.equal(transportFor(id), 'envelope')
    assert.equal(transportFor(id, { ...optIn, accessMode: 'danger-full-access', approvalPolicy: 'on-request' }), 'envelope')
    for (const accessMode of ['read-only', 'workspace-write']) for (const approvalPolicy of ['never', 'on-request']) assert.equal(transportFor(id, { ...optIn, accessMode, approvalPolicy }), 'envelope', `${id} ${accessMode} ${approvalPolicy}`)
    assert.equal(transportFor(id, { ...full, transport: 'envelope' }), 'envelope', 'per-provider option as decideTransport spreads it')
    assert.equal(transportFor(id, { ...full, ...optIn, providerOptions: { transport: 'envelope' } }), 'envelope')
    assert.equal(transportFor(id, { ...full, ...optIn, legacyEnvelope: true }), 'envelope')
  }
  process.env.ORBIT_CURSOR_SESSION = '1'
  assert.equal(transportFor('cursor', full), 'session')
  assert.equal(transportFor('cursor', { accessMode: 'workspace-write', approvalPolicy: 'never' }), 'envelope', 'the opt-in never widens access')
  assert.equal(transportFor('cursor', { ...full, approvalPolicy: 'on-request' }), 'envelope')
  delete process.env.ORBIT_CURSOR_SESSION
  for (const id of ['ollama', 'custom']) assert.equal(transportFor(id, { ...full, transport: 'session' }), 'envelope')
  assert.equal(mcpCallLimit('cursor'), 50000, 'below Cursor\'s 60 s MCP call timeout')
  assert.ok(mcpCallLimit('antigravity') > 0 && mcpCallLimit('antigravity') < 3600000, 'below the plugin\'s timeoutSeconds')
  assert.equal(mcpCallLimit('codex'), 3540000, 'below the tool_timeout_sec=3600 Orbit gives Codex')
  assert.equal(mcpCallLimit('claude'), 0); assert.equal(mcpCallLimit('ollama'), 0)
  process.env.ORBIT_MCP_CALL_LIMIT_MS = '300'
  assert.equal(mcpCallLimit('cursor'), 300); assert.equal(mcpCallLimit('claude'), 0)
  process.env.ORBIT_MCP_CALL_LIMIT_MS = '900000'
  assert.equal(mcpCallLimit('cursor'), 50000, 'the override never raises the limit')
  process.env.ORBIT_LEGACY_ENVELOPE = '1'
  for (const id of ['cursor', 'antigravity']) assert.equal(transportFor(id, { ...full, transport: 'session' }), 'envelope')
})

const CURSOR_FIXTURE = `
  if (!args.includes('--approve-mcps')) { out({ type: 'result', subtype: 'success', result: 'envelope answer' }); return; }
  const resumed = args.includes('--resume');
  const id = resumed ? args[args.indexOf('--resume') + 1] : 'chat-7f3a';
  if (input.includes('hang')) { out({ type: 'system', subtype: 'init', session_id: id }); setInterval(() => {}, 1000); return; }
  if (input.includes('anonymous')) {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Streamed only' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: '' }); return;
  }
  if (input.includes('quota')) {
    out({ type: 'system', subtype: 'init', session_id: id, model: 'Auto' });
    process.stderr.write("ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.\\n");
    process.exitCode = input.includes('quietly') ? 0 : 1; return;
  }
  const answer = 'Done: ' + (resumed ? input : 'first');
  out({ type: 'system', subtype: 'init', session_id: id, model: 'Auto', permissionMode: 'default' });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input }] }, session_id: id });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] }, session_id: id });
  const mcp = { name: 'memory_search', args: { query: 'x' }, toolCallId: 'c1', providerIdentifier: 'plugin-orbit-orbit', toolName: 'memory_search' };
  out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { mcpToolCall: { args: mcp } }, session_id: id });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { mcpToolCall: { args: mcp, result: { success: { content: [{ text: '[]' }] } } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { readToolCall: { args: { path: 'README.md' } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { readToolCall: { args: { path: 'README.md' }, result: { success: { content: 'hello' } } } }, session_id: id });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, session_id: id });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: id, usage: { input_tokens: 4, output_tokens: 1 } });
`

test('Cursor session: token only by variable, plugin folder per turn, Full-access flags, chat id from system/init, resume by id, Orbit MCP events', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined, ORBIT_CURSOR_SESSION: undefined, NO_PROXY: undefined, no_proxy: undefined })
  const cli = recordingCli(t, 'ORBIT_CURSOR_COMMAND', CURSOR_FIXTURE)
  const workspace = workspaceFolder(t)
  const events = []
  // Cursor's session is opt-in (`transport: 'session'` in its provider options) until a live check passes.
  const base = { providerId: 'cursor', workspace, accessMode: 'danger-full-access', approvalPolicy: 'never', model: 'auto', providerOptions: { transport: 'session' }, onEvent: event => events.push(event), extraEnv: { ORBIT_RUN_ID: 'run-1', ORBIT_TEST_EXTRA: 'yes' } }
  const session = { token: 'tok-secret', mcpUrl: 'http://127.0.0.1:4321/mcp', systemAppend: 'STABLE ORBIT BLOCK' }
  const first = await runProvider({ ...base, prompt: 'First task', session: { ...session, id: '11111111-2222-4333-8444-555555555555' } })
  assert.deepEqual([first.transport, first.sessionId, first.text, first.client], ['session', 'chat-7f3a', 'Done: first', 'Cursor CLI'])
  let record = cli.records()[0]
  for (const flag of ['--print', '--trust', '--approve-mcps', '--force']) assert.ok(record.args.includes(flag), flag)
  assert.equal(after(record.args, '--output-format'), 'stream-json'); assert.equal(after(record.args, '--sandbox'), 'disabled'); assert.equal(after(record.args, '--model'), 'auto')
  assert.ok(!record.args.includes('--mode') && !record.args.includes('--resume'))
  assert.equal(after(record.args, '--plugin-dir'), record.pluginDir)
  assert.ok(record.args.every(arg => !arg.includes('tok-secret')), 'the token never reaches the command line')
  assert.deepEqual([record.env.token, record.env.runId, record.env.extra], ['tok-secret', 'run-1', 'yes'], 'the token and extraEnv in the environment')
  assert.match(record.env.noProxy, /(^|,)127\.0\.0\.1(,|$)/, 'loopback MCP calls bypass HTTP(S)_PROXY')
  assert.ok(samePath(record.cwd, workspace), 'Cursor keys its chats by the working folder: always the workspace')
  assert.equal(record.input, 'STABLE ORBIT BLOCK\n\n---\n\nFirst task', 'no system-prompt option: the stable block opens the first message')
  const plugin = JSON.parse(record.cursorPlugin)
  assert.equal(plugin.name, 'orbit'); assert.match(plugin.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)
  assert.deepEqual(JSON.parse(record.cursorMcp), { mcpServers: { orbit: { url: 'http://127.0.0.1:4321/mcp', headers: { Authorization: 'Bearer ${env:ORBIT_MCP_TOKEN}' } } } })
  assert.ok(!record.cursorMcp.includes('tok-secret'))
  assert.equal(path.basename(record.pluginDir).startsWith('orbit-cursor-mcp-'), true)
  assert.equal(fs.existsSync(record.pluginDir), false, 'the plugin folder is removed after the turn')
  const orbit = events.filter(event => event.kind === 'tool' && event.toolId === 'c1')
  assert.deepEqual(orbit.map(event => [event.status, event.tool, event.orbitTool, event.native, event.mcp, event.server]), [['started', 'mcp__orbit__memory_search', 'memory_search', false, true, 'orbit'], ['completed', 'mcp__orbit__memory_search', 'memory_search', false, true, 'orbit']])
  assert.deepEqual(orbit[0].input, { query: 'x' })
  const native = events.find(event => event.kind === 'tool' && event.toolId === 'c2' && event.status === 'completed')
  assert.ok(native.native === true && native.tool === 'read' && native.input.path === 'README.md' && native.orbitTool === undefined)
  const outputs = events.filter(event => event.kind === 'output')
  assert.deepEqual(outputs.map(event => event.text), ['Looking.', 'Done: first'])
  assert.notEqual(outputs[0].messageId, outputs[1].messageId, 'text on both sides of a tool call is two messages')
  assert.ok(events.some(event => event.kind === 'observation' && event.status === 'completed' && event.usage?.input_tokens === 4))
  const second = await runProvider({ ...base, prompt: 'Second', session: { ...session, id: first.sessionId, resume: true } })
  assert.deepEqual([second.sessionId, second.text], ['chat-7f3a', 'Done: Second'])
  record = cli.records()[1]
  assert.equal(after(record.args, '--resume'), 'chat-7f3a')
  assert.equal(record.input, 'Second', 'a resume carries only the new message')
  assert.ok(samePath(record.cwd, workspace))
  assert.notEqual(record.pluginDir, cli.records()[0].pluginDir); assert.equal(fs.existsSync(record.pluginDir), false)
  // Not Full access: the envelope invocation, even when the runtime passed session options.
  const envelope = await runProvider({ ...base, accessMode: 'workspace-write', prompt: 'Plain', session })
  assert.equal(envelope.transport, undefined); assert.equal(envelope.text, 'envelope answer')
  record = cli.records()[2]
  assert.equal(after(record.args, '--mode'), 'ask'); assert.ok(!record.args.includes('--plugin-dir') && record.env.token === undefined)
  assert.equal(record.env.runId, 'run-1', 'extraEnv reaches the envelope process too')
  // Full access without the opt-in: the envelope invocation as before.
  const plain = await runProvider({ ...base, providerOptions: {}, prompt: 'Plain', session })
  assert.equal(plain.transport, undefined); assert.equal(plain.text, 'envelope answer')
  record = cli.records()[3]
  assert.ok(record.args.includes('--force') && !record.args.includes('--mode') && !record.args.includes('--plugin-dir') && record.env.token === undefined, record.args.join(' '))
  await assert.rejects(runProvider({ ...base, prompt: 'x', session: { ...session, id: '--force', resume: true } }), /Unexpected cursor session id/)
})

test('Cursor session: a used-up plan is a tagged quota refusal; the plugin folder goes after a failure and after cancellation', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const cli = recordingCli(t, 'ORBIT_CURSOR_COMMAND', CURSOR_FIXTURE)
  const workspace = workspaceFolder(t)
  withEnv(t, { ORBIT_CURSOR_SESSION: '1' }) // the opt-in through the environment
  const base = { providerId: 'cursor', workspace, accessMode: 'danger-full-access', approvalPolicy: 'never', session: { token: 'tok', mcpUrl: 'http://127.0.0.1:4321/mcp' } }
  for (const prompt of ['quota', 'quota quietly']) {
    await assert.rejects(runProvider({ ...base, prompt }), error => {
      const refusal = classifyQuotaError(error, 'cursor')
      assert.ok(refusal && refusal.providerId === 'cursor', `${prompt}: ${error.message}`)
      assert.equal(error.quota.providerId, 'cursor')
      assert.match(error.message, /usage limit/)
      return true
    })
    assert.equal(fs.existsSync(cli.records().at(-1).pluginDir), false, `${prompt}: plugin folder removed after the failure`)
  }
  const controller = new AbortController()
  const pending = runProvider({ ...base, prompt: 'hang', signal: controller.signal })
  await until(() => cli.records().length === 3)
  assert.equal(fs.existsSync(cli.records()[2].pluginDir), true, 'the folder exists while the turn runs')
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(fs.existsSync(cli.records()[2].pluginDir), false, 'plugin folder removed after cancellation')
})

test('Cursor session: a stream without a chat id reports none, so the next turn starts fresh; an empty result falls back to the streamed text', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined, ORBIT_CURSOR_SESSION: '1' })
  const cli = recordingCli(t, 'ORBIT_CURSOR_COMMAND', CURSOR_FIXTURE)
  const workspace = workspaceFolder(t)
  const result = await runProvider({ providerId: 'cursor', workspace, accessMode: 'danger-full-access', approvalPolicy: 'never', prompt: 'anonymous', session: { id: '11111111-2222-4333-8444-555555555555', token: 'tok', mcpUrl: 'http://127.0.0.1:4321/mcp' } })
  assert.deepEqual([result.transport, result.sessionId, result.text], ['session', null, 'Streamed only'], 'never the id Orbit proposed: Cursor did not take it')
  assert.ok(!cli.records()[0].args.includes('--resume'))
})

test('session ids: stream parsers take only plain ids, and normalizeSession refuses a malformed one with a code the runtime recognises', () => {
  const codex = id => {
    const parser = _testing.createCodexParser(null)
    for (const event of [{ type: 'thread.started', thread_id: id }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]) parser.line(JSON.stringify(event))
    return parser.finish().sessionId
  }
  assert.equal(codex('0199a3c4-thread'), '0199a3c4-thread')
  for (const bad of ['--config=evil', ' spaced', 'x'.repeat(200), '']) assert.equal(codex(bad), undefined, JSON.stringify(bad))
  for (const id of ['cursor', 'antigravity', 'codex']) {
    assert.throws(() => normalizeSession(id, { id: '--help', resume: true }), error => error.code === 'ORBIT_SESSION_ID' && error.message === `Unexpected ${id} session id`)
    assert.equal(normalizeSession(id, { id: 'chat-1.2:3', resume: true }).id, 'chat-1.2:3')
  }
  assert.throws(() => normalizeSession('claude', { id: 'thread-1', resume: true }), { code: 'ORBIT_SESSION_ID', message: 'Claude session ids must be UUIDs' })
  assert.throws(() => normalizeSession('cursor', { resume: true }), error => error.code === undefined && /needs its id/.test(error.message))
})

const AGY_FIXTURE = `
  const resumed = args.includes('--conversation');
  const id = resumed ? args[args.indexOf('--conversation') + 1] : 'conv-1234';
  const message = JSON.parse(input.trim()).message.content;
  const step = (index, extra) => out({ event: 'step_update', step_update: { conversation_id: id, step_index: index, ...extra } });
  out({ event: 'init', conversation_id: id, init: { model: 'claude-sonnet-4-6', cwd: process.cwd(), tools: ['call_mcp_tool', 'view_file'], permission_mode: 'always-proceed' } });
  step(0, { state: 'DONE', step_type: 'user_input' });
  if (message === 'fail') { out({ event: 'result', result: { conversation_id: id, status: 'ERROR', response: '', error: 'boom from agy' } }); return; }
  step(1, { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10 } });
  const parameters = { Arguments: { title: 't', content: 'c' }, ServerName: 'orbit_orbit', ToolName: 'memory_save' };
  step(2, { state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters } });
  step(2, { state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters, output: 'saved' } });
  step(3, { state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: path.join(args[args.indexOf('--add-dir') + 1], 'README.md') }, output: '1 line' } });
  step(4, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Saved ' });
  step(4, { state: 'DONE', step_type: 'agent_response', text_delta: 'it: ' + message, usage: { output_tokens: 2 } });
  out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', num_turns: 1, usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 100 }, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
`

test('Antigravity session: a folder per conversation with the plugin, rules and bearer header, Full-access flags, id from init, resume in the same folder, closeSession', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined, HTTP_PROXY: undefined, HTTPS_PROXY: undefined, NO_PROXY: undefined, no_proxy: undefined })
  const cli = recordingCli(t, 'ORBIT_ANTIGRAVITY_COMMAND', AGY_FIXTURE)
  const workspace = workspaceFolder(t)
  const events = []
  const base = { providerId: 'antigravity', workspace, model: 'claude-sonnet-4-6', accessMode: 'danger-full-access', approvalPolicy: 'never', providerOptions: { proxyMode: 'inherit' }, onEvent: event => events.push(event), extraEnv: { ORBIT_RUN_ID: 'run-9' } }
  const session = { token: 'tok-agy', mcpUrl: 'http://127.0.0.1:4555/mcp', systemAppend: 'STABLE ORBIT BLOCK' }
  const first = await runProvider({ ...base, prompt: 'First', session: { ...session, id: '11111111-2222-4333-8444-555555555555' } })
  assert.deepEqual([first.transport, first.sessionId, first.model, first.client], ['session', 'conv-1234', 'claude-sonnet-4-6', 'Antigravity CLI'])
  assert.equal(first.text, 'Saved it: First', 'an empty response falls back to the streamed text')
  let record = cli.records()[0]
  assert.deepEqual(record.args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json'])
  assert.equal(after(record.args, '--model'), 'claude-sonnet-4-6'); assert.equal(after(record.args, '--add-dir'), workspace)
  assert.ok(record.args.includes('--dangerously-skip-permissions'))
  assert.ok(!record.args.includes('--json-schema') && !record.args.includes('orbit-transport') && !record.args.includes('--agent') && !record.args.includes('--conversation'))
  assert.ok(record.args.every(arg => !arg.includes('tok-agy')), 'the token never reaches the command line')
  assert.deepEqual(JSON.parse(record.input), { event: 'user', message: { content: 'First' } })
  assert.equal(path.dirname(record.cwd).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert.match(path.basename(record.cwd), /^orbit-agy-session-/)
  assert.deepEqual(JSON.parse(record.agyPlugin), { name: 'orbit' })
  assert.deepEqual(JSON.parse(record.agyMcp), { mcpServers: { orbit: { serverUrl: 'http://127.0.0.1:4555/mcp', headers: { Authorization: 'Bearer tok-agy' }, timeoutSeconds: 3600 } } })
  assert.ok(record.agyRules.startsWith('STABLE ORBIT BLOCK\n\n') && record.agyRules.includes(workspace) && record.agyRules.includes('orbit_orbit'), record.agyRules)
  assert.match(record.env.noProxy, /(^|,)127\.0\.0\.1(,|$)/); assert.equal(record.env.runId, 'run-9'); assert.equal(record.env.token, undefined)
  const orbit = events.filter(event => event.kind === 'tool' && event.toolId === 'step-2')
  assert.deepEqual(orbit.map(event => [event.status, event.tool, event.orbitTool, event.native, event.mcp]), [['started', 'mcp__orbit__memory_save', 'memory_save', false, true], ['completed', 'mcp__orbit__memory_save', 'memory_save', false, true]])
  assert.deepEqual(orbit[0].input, { title: 't', content: 'c' })
  const view = events.find(event => event.kind === 'tool' && event.toolId === 'step-3')
  assert.ok(view.native && view.tool === 'read' && view.input.path === path.join(workspace, 'README.md'))
  assert.ok(events.some(event => event.kind === 'observation' && event.status === 'denied' && /RunCommand/.test(event.text)), 'denied_actions is a diagnostic, not a failure')
  assert.ok(events.some(event => event.kind === 'observation' && event.status === 'completed' && event.usage?.cache_read_tokens === 100))
  assert.equal(fs.existsSync(record.cwd), true, 'the conversation keeps its folder between turns')
  const second = await runProvider({ ...base, prompt: 'Again', session: { ...session, id: first.sessionId, resume: true, mcpUrl: 'http://127.0.0.1:4666/mcp', token: 'tok-2' } })
  assert.deepEqual([second.sessionId, second.text], ['conv-1234', 'Saved it: Again'])
  const resumed = cli.records()[1]
  assert.equal(after(resumed.args, '--conversation'), 'conv-1234')
  assert.equal(resumed.cwd, record.cwd, 'a resume runs in the folder its conversation started in')
  assert.equal(JSON.parse(resumed.agyMcp).mcpServers.orbit.serverUrl, 'http://127.0.0.1:4666/mcp', 'the plugin is rewritten for every turn')
  assert.equal(await closeSession('conv-1234'), true)
  assert.equal(fs.existsSync(record.cwd), false, 'closeSession removes the folder')
  assert.equal(await closeSession('conv-1234'), false)
  // A failed first turn leaves nothing to resume: its folder goes at once.
  await assert.rejects(runProvider({ ...base, prompt: 'fail', session }), /boom from agy/)
  assert.equal(fs.existsSync(cli.records()[2].cwd), false)
})

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
  assert.equal(after(first, 'mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"'), '-c')
  assert.ok(first.includes('mcp_servers.orbit.tool_timeout_sec=3600'), 'Codex would end an Orbit tool call after 60 s by default')
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
  assert.ok(resumed.includes('mcp_servers.orbit.tool_timeout_sec=3600'), 'every process gets the tool timeout, a resume included')
  assert.ok(!buildCodexSessionArgs({ workspace: '.', accessMode: 'read-only' }, { id: null, resume: false, mcpUrl: null, token: null }).some(arg => arg.startsWith('mcp_servers.')), 'no MCP server, no overrides')
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
  assert.ok(record.args.includes('mcp_servers.orbit.url="http://127.0.0.1:9/mcp"') && record.args.includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"') && record.args.includes('mcp_servers.orbit.tool_timeout_sec=3600'))
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

test('extraEnv reaches every CLI process Orbit starts, and Orbit\'s own transport variables win over it', async t => {
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const extraEnv = { ORBIT_RUN_ID: 'run-x', ORBIT_TEST_EXTRA: 'extra', ORBIT_MCP_TOKEN: 'must-not-win', 'BAD=KEY': 'dropped', ORBIT_NOT_TEXT: 5 }
  const claude = recordingCli(t, 'ORBIT_CLAUDE_COMMAND', `out({ type: 'system', subtype: 'init', session_id: args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : 's' }); out({ type: 'result', subtype: 'success', result: 'ok' });`)
  await runProvider({ providerId: 'claude', workspace: claude.directory, accessMode: 'read-only', prompt: 'envelope', extraEnv })
  await runProvider({ providerId: 'claude', workspace: claude.directory, accessMode: 'read-only', prompt: 'session', extraEnv, session: { token: 'claude-token', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  const codex = recordingCli(t, 'ORBIT_CODEX_COMMAND', `out({ type: 'thread.started', thread_id: 't1' }); out({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'ok' } }); out({ type: 'turn.completed' });`)
  await runProvider({ providerId: 'codex', workspace: codex.directory, accessMode: 'read-only', prompt: 'envelope', extraEnv })
  await runProvider({ providerId: 'codex', workspace: codex.directory, accessMode: 'read-only', prompt: 'session', extraEnv, session: { token: 'codex-token', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  const [claudeEnvelope, claudeSession] = claude.records().map(record => record.env)
  const [codexEnvelope, codexSession] = codex.records().map(record => record.env)
  for (const env of [claudeEnvelope, claudeSession, codexEnvelope, codexSession]) assert.deepEqual([env.runId, env.extra], ['run-x', 'extra'])
  assert.equal(claudeEnvelope.token, 'must-not-win', 'an envelope process has no token of its own; the variable is passed as given')
  assert.equal(codexSession.token, 'codex-token', 'the session token wins over extraEnv')
  // The Codex App Server is spawned by codex-server.mts itself; the variables ride on the launch it resolves.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-fixture-'))
  const workspace = workspaceFolder(t)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const record = path.join(directory, 'env.json')
  fs.writeFileSync(path.join(directory, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  fs.writeFileSync(path.join(directory, 'cli.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ runId: process.env.ORBIT_RUN_ID, token: process.env.ORBIT_MCP_TOKEN, bad: process.env['BAD=KEY'] ?? null, notText: process.env.ORBIT_NOT_TEXT ?? null }));\n${appServerFixture}`)
  process.env.ORBIT_CODEX_COMMAND = path.join(directory, 'cli.cmd')
  const app = await runProvider({ providerId: 'codex', workspace, accessMode: 'workspace-write', approvalPolicy: 'on-request', prompt: 'app', extraEnv, session: { token: 'app-token', mcpUrl: 'http://127.0.0.1:9/mcp' } })
  try {
    assert.equal(app.text, 'Turn 1: app')
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { runId: 'run-x', token: 'app-token', bad: null, notText: null })
  } finally { await codexServer.closeSession(app.sessionId) }
})
