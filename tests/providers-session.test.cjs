const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, transportFor, mcpCallLimit, closeSession, _testing } = require('../electron/providers.mts')
const codexServer = require('../electron/codex-server.mts')
const { classifyQuotaError } = require('../electron/quota.mts')
const { UUID, SESSION, after, withEnv, fakeCli, recordingCli, workspaceFolder, samePath, until, appServerFixture } = require('./helpers-providers-session.cjs')
const { buildClaudeSessionArgs, buildCodexSessionArgs, buildClaudeArgs, normalizeSession, inactivityValue } = _testing

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
    const named = []
    const parser = _testing.createCodexParser(event => { if (event.kind === 'session') named.push(event.sessionId) })
    for (const event of [{ type: 'thread.started', thread_id: id }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]) parser.line(JSON.stringify(event))
    const { sessionId } = parser.finish()
    assert.deepEqual(named, sessionId ? [sessionId] : [], 'the thread is announced as the stream names it, only a plain id')
    return sessionId
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
  // The stable Orbit block is the thread's developer instructions, on a new thread and on a resume alike.
  for (const args of [first, resumed]) assert.equal(args[args.indexOf(`developer_instructions="${SESSION.systemAppend}"`) - 1], '-c')
  assert.ok(!buildCodexSessionArgs({ workspace: '.', accessMode: 'read-only' }, { ...SESSION, resume: false, systemAppend: '' }).some(arg => arg.startsWith('developer_instructions=')), 'no block, no override')
  // A TOML basic string: JSON's escapes, but no escaped lone surrogate and no raw DEL, which TOML refuses (Codex would then
  // take the value as raw text, escapes and all).
  const text = 'say "hi" C:\\x\\\nnext\tline\x7f lone\ud800 low\udc00 pair\ud83d\ude00'
  const encoded = buildCodexSessionArgs({ workspace: '.', accessMode: 'read-only' }, { ...SESSION, resume: false, systemAppend: text }).find(arg => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length)
  assert.equal(JSON.parse(encoded), text.replace('\ud800', '\ufffd').replace('\udc00', '\ufffd'))
  assert.ok(!/[\x00-\x08\x0a-\x1f\x7f]/.test(encoded) && !/\\ud[89a-f]/i.test(encoded), encoded)
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
  // The turn's figures reach the runtime as one usage event (a result nothing else reported), not on the completion note.
  assert.deepEqual(events.filter(event => event.kind === 'usage').map(event => event.usage.input_tokens + event.usage.output_tokens), [5])
  assert.equal(events.find(event => event.kind === 'observation' && event.status === 'completed').usage, undefined)
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
  const first = await runProvider({ providerId: 'codex', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'hello', onEvent: event => events.push(event), session: { token: 'codex-token', mcpUrl: 'http://127.0.0.1:9/mcp', systemAppend: 'STABLE ORBIT BLOCK' } })
  assert.equal(first.transport, 'session'); assert.equal(first.sessionId, 'thread-fixture-1'); assert.equal(first.text, 'Answer: hello'); assert.equal(first.client, 'Codex CLI')
  let record = cli.read()
  assert.equal(record.args[record.args.indexOf('developer_instructions="STABLE ORBIT BLOCK"') - 1], '-c', 'the stable Orbit block is the thread\'s developer instructions')
  assert.equal(record.env.token, 'codex-token')
  assert.match(String(record.env.noProxy), /127.0.0.1/, 'loopback MCP calls bypass HTTP(S)_PROXY')
  assert.ok(record.args.includes('mcp_servers.orbit.url="http://127.0.0.1:9/mcp"') && record.args.includes('mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"') && record.args.includes('mcp_servers.orbit.tool_timeout_sec=3600'))
  assert.ok(!record.args.includes('--ephemeral') && !record.args.includes('--output-schema'))
  assert.equal(record.input, 'hello')
  const orbitCall = events.find(event => event.kind === 'tool' && event.toolId === 'mcp1')
  assert.ok(orbitCall.orbitTool === 'list_agents' && orbitCall.native === false && orbitCall.text === 'orbit/list_agents')
  const second = await runProvider({ providerId: 'codex', workspace: cli.directory, accessMode: 'workspace-write', prompt: 'again', session: { id: 'thread-fixture-1', resume: true, token: 'codex-token', mcpUrl: 'http://127.0.0.1:9/mcp', systemAppend: 'STABLE ORBIT BLOCK' } })
  record = cli.read()
  assert.deepEqual(record.args.slice(0, 2), ['exec', 'resume'])
  assert.ok(record.args.includes('developer_instructions="STABLE ORBIT BLOCK"'), 'a resume passes the block too')
  assert.deepEqual(record.args.slice(-2), ['thread-fixture-1', '-'])
  assert.equal(record.cwd.toLowerCase(), fs.realpathSync(cli.directory).toLowerCase(), 'resume has no -C: the process cwd is the workspace')
  assert.equal(second.sessionId, 'thread-fixture-1'); assert.equal(second.text, 'Answer: again')
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
