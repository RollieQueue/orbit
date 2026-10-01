const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { buildArgs, createParser, parseModels, run, inspect, cursorEffortModel, cursorReasoningModels, cursorLaunch, buildCursorSessionArgs, buildAntigravitySessionArgs, writeCursorPlugin, writeAntigravityPlugin, createSessionParser, runSession, closeSession, sweepSessionDirectories } = require('../electron/subscription-providers.mts')
const { ORBIT_RESPONSE_SCHEMA } = require('../electron/tool-schema.mts')
const { TOOL_HANDOFF } = require('../electron/tool-schema.mts')

for (const calls of [[], [{ id: 'read', name: 'context_read', arguments: {} }]]) test(`Antigravity hands off the first completed schema response (${calls.length} calls)`, () => {
  const events = [], parser = createParser('antigravity', event => events.push(event), 'fixture', ORBIT_RESPONSE_SCHEMA)
  const text = JSON.stringify({ content: 'Привет, мир', tool_calls: calls })
  const step = (index, state, delta) => JSON.stringify({ event: 'step_update', step_update: { step_index: index, step_type: 'agent_response', state, text_delta: delta, ...(state === 'DONE' ? { usage: { input_tokens: 3 } } : {}) } })
  parser.line(step(1, 'ACTIVE', 'progress'))
  parser.line(step(1, 'DONE', ''))
  assert.equal(parser.line(step(3, 'ACTIVE', text)), undefined, 'valid JSON is insufficient until the step is done')
  assert.equal(parser.line(step(3, 'DONE', '\n')), TOOL_HANDOFF)
  parser.line(step(5, 'DONE', JSON.stringify({ content: 'must not replace', tool_calls: [] })))
  assert.equal(parser.finish().text, text + '\n')
  assert.equal(parser.finish().usage.input_tokens, 6)
  assert.deepEqual([...new Set(events.map(event => event.messageId))], ['1', '3'])
})

test('Antigravity ignores repeated step completion and never hands off tools, malformed JSON or a failed result', () => {
  const events = [], parser = createParser('antigravity', event => events.push(event), '', ORBIT_RESPONSE_SCHEMA)
  const send = step_update => parser.line(JSON.stringify({ event: 'step_update', step_update }))
  const text = JSON.stringify({ content: 'bad', tool_calls: [{ id: 'x', name: 'unknown', arguments: {} }] })
  const invalid = { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: text }
  assert.equal(send(invalid), undefined)
  send(invalid)
  assert.equal(events.length, 1)
  assert.equal(send({ ...invalid, step_index: 2, step_type: 'tool', text_delta: '{"content":"tool text","tool_calls":[]}' }), undefined)
  assert.equal(send({ ...invalid, step_index: 3, text_delta: '{"content":' }), undefined)
  parser.line(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'failed' } }))
  assert.throws(() => parser.finish(), /failed/)
})

test('subscription arguments respect full access and retain restrictions for Ask and read-only', () => {
  const cursor = buildArgs('cursor', { model: 'composer-fixture', accessMode: 'danger-full-access' })
  assert.ok(!cursor.includes('--mode')); assert.ok(cursor.includes('--force'))
  assert.equal(cursor[cursor.indexOf('--sandbox') + 1], 'disabled')
  for (const options of [{ accessMode: 'read-only' }, { accessMode: 'workspace-write' }, { accessMode: 'danger-full-access', approvalPolicy: 'on-request' }, { accessMode: 'danger-full-access', approvalPolicy: 'auto-review' }]) {
    const args = buildArgs('cursor', options)
    assert.equal(args[args.indexOf('--mode') + 1], 'ask'); assert.ok(!args.includes('--force'))
  }
  const agy = buildArgs('antigravity', { model: 'gemini-fixture', reasoningEffort: 'low' })
  assert.ok(agy.includes('orbit-transport')); assert.ok(agy.includes('gemini-fixture')); assert.ok(!agy.includes('--dangerously-skip-permissions'))
  assert.ok(!agy.includes('--effort'), 'Google models must not receive a reasoning CLI flag')
  assert.doesNotThrow(() => buildArgs('antigravity', { reasoningEffort: 'xhigh' }))
})

test('Cursor reasoning selects only advertised variants, preserving fast/thinking suffixes', () => {
  const models = ['fixture-high', 'fixture-low', 'fixture-high-fast', 'fixture-low-fast', 'legacy-extra-high', 'legacy-low', 'auto']
  assert.equal(cursorEffortModel('fixture-high-fast', 'low', models), 'fixture-low-fast')
  assert.equal(cursorEffortModel('legacy-low', 'xhigh', models), 'legacy-extra-high')
  assert.deepEqual(cursorReasoningModels(models).auto, {})
  assert.throws(() => cursorEffortModel('fixture-high', 'max', models), /Cursor/)
  const args = buildArgs('cursor', { model: 'fixture-high', reasoningEffort: 'low', availableModels: models })
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-low')
  assert.deepEqual(parseModels('gemini-fixture\tGemini fixture'), ['gemini-fixture'])
})

test('a saved Cursor level is dropped for a model without variants and still refused where variants exist', () => {
  const models = ['auto', 'fixture-high', 'fixture-low']
  assert.deepEqual(cursorLaunch('auto', 'high', models), { model: 'auto', dropped: 'high' })
  assert.deepEqual(cursorLaunch('', 'high', models), { model: '', dropped: 'high' }, 'the CLI default model has no variants either')
  assert.deepEqual(cursorLaunch('auto', '', models), { model: 'auto' })
  assert.deepEqual(cursorLaunch('fixture-high', 'low', models), { model: 'fixture-low' })
  assert.throws(() => cursorLaunch('fixture-high', 'max', models), /Cursor: уровень max недоступен для fixture-high/)
  assert.deepEqual(buildArgs('cursor', { model: 'auto', reasoningEffort: 'high', availableModels: models }).slice(-2), ['--model', 'auto'])
})

test('Cursor run on a model without variants ignores the saved level, reports it and keeps the run alive', async () => {
  const providerOptions = { command: 'cursor-level-fixture' }
  const turn = async (model, reasoningEffort) => {
    const events = []; let launched
    const result = await run('cursor', { prompt: 'Hi', workspace: process.cwd(), model, reasoningEffort, providerOptions, onEvent: event => events.push(event) }, { runCli: async (_, args, options) => {
      if (args[0] === '--list-models') { for (const line of ['auto - Automatic', 'fixture-high  Fixture', 'fixture-low  Fixture']) options.onLine(line); return { stdout: '' } }
      launched = args
      options.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }))
    } })
    return { result, events, model: launched[launched.indexOf('--model') + 1] }
  }
  const auto = await turn('auto', 'high')
  assert.equal(auto.model, 'auto')
  assert.equal(auto.result.reasoningEffort, '', 'the level that really ran is reported')
  assert.ok(auto.events.some(event => event.kind === 'observation' && /уровень high не применён/.test(event.text)), 'the dropped level is visible in the trace')
  const chosen = await turn('fixture-high', 'low')
  assert.equal(chosen.model, 'fixture-low')
  assert.equal(chosen.result.reasoningEffort, undefined, 'an applied level is not restated')
  assert.ok(!chosen.events.some(event => event.kind === 'observation'))
  await assert.rejects(turn('fixture-high', 'max'), /Cursor: уровень max недоступен для fixture-high/)
})

test('Google discovery and inference receive the same explicit proxy without changing process environment', async () => {
  const previous = process.env.HTTPS_PROXY
  const providerOptions = { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:12334' }
  const runCli = async (_, args, options) => {
    assert.equal(options.env.HTTPS_PROXY, providerOptions.proxyUrl)
    assert.ok(!args.includes('--effort'), 'Google inference must not receive a reasoning CLI flag')
    if (args[0] === 'models') { assert.deepEqual(args, ['models']); return { stdout: 'fixture-model\tFixture' } }
    if (args[0] !== '--version') options.onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }))
    return { stdout: 'version' }
  }
  const health = await inspect('antigravity', { runCli }, providerOptions)
  assert.deepEqual(health.models, ['fixture-model'])
  assert.deepEqual(health.reasoningLevels, {}, 'Google discovery must not advertise reasoning choices')
  await run('antigravity', { prompt: 'test', providerOptions, reasoningEffort: 'max' }, { runCli })
  assert.equal(process.env.HTTPS_PROXY, previous)
})
for (const id of ['cursor', 'antigravity']) test(`${id} parser accepts only successful terminal output and records usage`, () => {
  const parser = createParser(id, () => {}, 'fixture')
  const result = { content: 'Finished', tool_calls: [] }
  parser.line(JSON.stringify(id === 'cursor' ? { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result), usage: { input_tokens: 10 } } : { event: 'result', result: { status: 'SUCCESS', structured_output: result, usage: { input_tokens: 10 } } }))
  assert.deepEqual(JSON.parse(parser.finish().text), result); assert.equal(parser.finish().usage.input_tokens, 10)
  assert.throws(() => createParser(id).finish(), /without a successful result/)
  const failed = createParser(id)
  failed.line(JSON.stringify(id === 'cursor' ? { type: 'result', subtype: 'error', is_error: true, result: 'quota exhausted' } : { event: 'result', result: { status: 'ERROR', error: 'quota exhausted' } }))
  assert.throws(() => failed.finish(), /quota exhausted/)
})
test('Antigravity transport supplies schema, tool-free agent and literal stdin, then cleans up', async () => {
  let directory
  const prompt = 'Literal Unicode: Привет. $() ` & < > '.repeat(1000)
  const result = await run('antigravity', { prompt, model: 'fixture', responseSchema: ORBIT_RESPONSE_SCHEMA, providerOptions: { command: 'custom-agy' }, timeoutMs: null }, { runCli: async (command, args, options) => {
    assert.equal(command, 'custom-agy'); directory = options.cwd
    assert.equal(JSON.parse(options.input).message.content, prompt)
    assert.match(fs.readFileSync(path.join(directory, '.agents', 'agents', 'orbit-transport.md'), 'utf8'), /tools: \[\]/)
    assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8')), ORBIT_RESPONSE_SCHEMA)
    options.onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"content":"Done","tool_calls":[]}' } }))
  } })
  assert.equal(result.providerId, 'antigravity'); assert.equal(fs.existsSync(directory), false)
})
test('Cursor transport sends long prompts through stdin and configured executable', async () => {
  const prompt = 'literal '.repeat(10000)
  await run('cursor', { prompt, workspace: process.cwd(), providerOptions: { command: 'custom-cursor' } }, { runCli: async (command, args, options) => {
    assert.equal(command, 'custom-cursor'); assert.equal(options.input, prompt); assert.ok(!args.includes(prompt))
    options.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }))
  } })
})
test('model discovery parses machine output and text slugs without invented defaults', async () => {
  assert.deepEqual(parseModels('{"models":[{"id":"gemini-fixture"},{"slug":"claude-fixture"}]}'), ['gemini-fixture', 'claude-fixture'])
  assert.deepEqual(parseModels('Available models\nauto - Automatic\ncomposer-fixture  Composer\n'), ['auto', 'composer-fixture'])
  const health = await inspect('cursor', { runCli: async (_, args, options) => {
    if (args[0] === 'status') return { stdout: '{"authenticated":false}' }
    if (args[0] === '--list-models') options.onLine('composer-fixture  Composer')
    return { stdout: 'version' }
  } })
  assert.equal(health.available, false); assert.deepEqual(health.models, ['composer-fixture'])
})

test('missing Cursor CLI explains the separate installation; launch errors keep their cause', async () => {
  const missing = await inspect('cursor', { runCli: async () => { throw Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' }) } })
  assert.equal(missing.installed, false)
  assert.equal(missing.available, false)
  assert.match(missing.detail, /Cursor IDE и Cursor CLI устанавливаются отдельно/)
  const broken = await inspect('cursor', { runCli: async () => { throw new Error('Cannot safely launch custom-agent') } })
  assert.equal(broken.available, false)
  assert.match(broken.detail, /Cannot safely launch custom-agent/)
  assert.doesNotMatch(broken.detail, /не найден/)
})

const regionError = 'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.'
for (const isAuthenticated of [false, true]) test(`Cursor reads the official isAuthenticated status: ${isAuthenticated}`, async () => {
  const health = await inspect('cursor', { runCli: async (_, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify({ isAuthenticated }) }
    if (args[0] === '--list-models') return { stdout: 'composer-fixture  Composer' }
    return { stdout: '2026.09.26-dd393fe' }
  } })
  assert.equal(health.authenticated, isAuthenticated)
  assert.equal(health.available, isAuthenticated)
  assert.deepEqual(health.models, ['composer-fixture'])
})

for (const source of ['version', 'models', 'stderr']) test(`Antigravity regional refusal from ${source} is unavailable`, async () => {
  const health = await inspect('antigravity', { runCli: async (_, args) => {
    if (source === 'version' || (source === 'models' && args[0] === 'models')) throw new Error(regionError)
    return { stdout: '', stderr: args[0] === 'models' ? regionError : '' }
  } })
  assert.equal(health.installed, true)
  assert.equal(health.available, false)
  assert.match(health.detail, /Google отклонил доступ.*по региону/)
  assert.match(health.detail, /country-association-form/)
})

test('ordinary model discovery failures still allow manual model selection', async () => {
  const health = await inspect('antigravity', { runCli: async (_, args) => {
    if (args[0] === 'models') throw new Error('Unknown option --json')
    return { stdout: '1.0' }
  } })
  assert.equal(health.available, true)
  assert.deepEqual(health.models, [])
})

test('session arguments: Full-access flags, the plugin folder, resume by id, never a schema, a transport agent or a token', () => {
  const session = { id: 'chat-1', resume: false }
  const cursor = buildCursorSessionArgs({ model: 'fixture-high', reasoningEffort: 'low', availableModels: ['fixture-high', 'fixture-low'] }, session, { pluginDir: 'C:\\tmp\\orbit-cursor-mcp-x' })
  assert.deepEqual(cursor, ['--print', '--output-format', 'stream-json', '--trust', '--approve-mcps', '--plugin-dir', 'C:\\tmp\\orbit-cursor-mcp-x', '--force', '--sandbox', 'disabled', '--model', 'fixture-low'])
  assert.deepEqual(buildCursorSessionArgs({}, { id: 'chat-1', resume: true }).slice(-2), ['--resume', 'chat-1'])
  assert.ok(!buildCursorSessionArgs({}, session).includes('--approve-mcps'), 'no MCP server, nothing to approve')
  const agy = buildAntigravitySessionArgs({ model: 'claude-sonnet-4-6', reasoningEffort: 'high', schemaPath: 'x.json' }, session, 'C:\\ws')
  assert.deepEqual(agy, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-6', '--add-dir', 'C:\\ws', '--dangerously-skip-permissions'])
  assert.deepEqual(buildAntigravitySessionArgs({}, { id: 'conv-9', resume: true }, 'C:\\ws').slice(-2), ['--conversation', 'conv-9'])
})

test('session plugin files: Cursor names the token by variable, Antigravity gets the header, the rules and the workspace', t => {
  const cursor = writeCursorPlugin('http://127.0.0.1:1/mcp')
  t.after(() => fs.rmSync(cursor, { recursive: true, force: true }))
  assert.equal(path.dirname(cursor), os.tmpdir()); assert.match(path.basename(cursor), /^orbit-cursor-mcp-/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cursor, '.cursor-plugin', 'plugin.json'), 'utf8')).name, 'orbit')
  assert.equal(fs.readFileSync(path.join(cursor, 'mcp.json'), 'utf8'), '{"mcpServers":{"orbit":{"url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer ${env:ORBIT_MCP_TOKEN}"}}}}')
  const agy = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-session-'))
  t.after(() => fs.rmSync(agy, { recursive: true, force: true }))
  writeAntigravityPlugin(agy, { mcpUrl: 'http://127.0.0.1:2/mcp', token: 'tok', systemAppend: 'ORBIT BLOCK' }, 'D:\\project')
  const plugin = path.join(agy, '.agents', 'plugins', 'orbit')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')), { mcpServers: { orbit: { serverUrl: 'http://127.0.0.1:2/mcp', headers: { Authorization: 'Bearer tok' }, timeoutSeconds: 3600 } } })
  const rules = fs.readFileSync(path.join(plugin, 'rules', 'AGENTS.md'), 'utf8')
  assert.ok(rules.startsWith('ORBIT BLOCK\n\n') && rules.includes('D:\\project') && rules.includes('ServerName "orbit_orbit"'), rules)
  writeAntigravityPlugin(agy, { mcpUrl: null, token: null, systemAppend: '' }, 'D:\\project')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')), { mcpServers: {} }, 'rewritten per turn')
})

test('Cursor session parser: chat id, Orbit MCP calls apart from native tools, messages per segment, usage once, in-band failures', () => {
  const events = [], parser = createSessionParser('cursor', event => events.push(event), 'auto')
  const send = event => parser.line(JSON.stringify({ session_id: 'chat-1', ...event }))
  send({ type: 'system', subtype: 'init', model: 'Auto' })
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Plan' }] } })
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Plan: read' }] } })
  send({ type: 'tool_call', subtype: 'started', call_id: 'm', tool_call: { mcpToolCall: { args: { toolName: 'spawn_agent', providerIdentifier: 'plugin-orbit-orbit', args: { name: 'H' } } } } })
  send({ type: 'tool_call', subtype: 'completed', call_id: 'm', tool_call: { mcpToolCall: { args: { toolName: 'spawn_agent', providerIdentifier: 'plugin-orbit-orbit' }, result: { error: { message: 'nope' } } } } })
  send({ type: 'tool_call', subtype: 'started', call_id: 'o', tool_call: { mcpToolCall: { args: { toolName: 'search', providerIdentifier: 'plugin-other-docs' } } } })
  send({ type: 'tool_call', subtype: 'started', call_id: 's', tool_call: { shellToolCall: { args: { command: 'npm test' } } } })
  send({ type: 'tool_call', subtype: 'started', call_id: 'w', tool_call: { writeToolCall: { args: { path: 'a.txt', fileText: 'x' } } } })
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }] } })
  send({ type: 'result', subtype: 'success', is_error: false, result: 'Answer', usage: { input_tokens: 7 } })
  assert.deepEqual(parser.finish(), { text: 'Answer', model: 'Auto', sessionId: 'chat-1' })
  const tools = events.filter(event => event.kind === 'tool')
  assert.deepEqual(tools.map(event => [event.toolId, event.tool, event.status, event.native, event.orbitTool]), [
    ['m', 'mcp__orbit__spawn_agent', 'started', false, 'spawn_agent'], ['m', 'mcp__orbit__spawn_agent', 'failed', false, 'spawn_agent'],
    ['o', 'mcpToolCall', 'started', true, undefined], ['s', 'shellToolCall', 'started', true, undefined], ['w', 'write', 'started', true, undefined],
  ])
  assert.equal(tools[3].text, 'npm test'); assert.deepEqual(tools[4].input, { path: 'a.txt' })
  const outputs = events.filter(event => event.kind === 'output')
  assert.deepEqual(outputs.map(event => [event.messageId, event.text]), [['cursor-0', 'Plan'], ['cursor-0', ': read'], ['cursor-4', 'Answer']])
  assert.equal(events.filter(event => event.usage).length, 1)
  const failed = createSessionParser('cursor')
  failed.line(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Model refused' }))
  assert.throws(() => failed.finish(), /Model refused/)
  assert.throws(() => createSessionParser('cursor').finish(), /Cursor CLI ended without a successful result/)
  // An error whose message is not text is described, never "[object Object]".
  const odd = createSessionParser('cursor')
  odd.line(JSON.stringify({ type: 'error', error: { message: { code: 5 } } }))
  assert.throws(() => odd.finish(), (error) => error.message === '{"code":5}')
  const empty = createSessionParser('cursor')
  empty.line(JSON.stringify({ type: 'result', subtype: 'success', result: '' }))
  assert.throws(() => empty.finish(), /completed without an assistant response/)
  // An empty result after streamed text falls back to the last message the turn streamed, as for Antigravity.
  const streamed = createSessionParser('cursor')
  const line = event => streamed.line(JSON.stringify({ session_id: 'chat-2', ...event }))
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } })
  line({ type: 'tool_call', subtype: 'started', call_id: 's', tool_call: { shellToolCall: { args: { command: 'npm test' } } } })
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } })
  line({ type: 'result', subtype: 'success', result: '' })
  assert.deepEqual(streamed.finish(), { text: 'All tests pass.', model: '', sessionId: 'chat-2' })
})

// Shaped like Cursor CLI 2026.09.26 output (run records of 2026-09-28): the call carries its own `toolCallId`, and its
// end repeats the arguments and adds `result` and `completedAtMs`. That CLI also sends `call_id`; the first two calls
// leave it out on purpose, to check the fallbacks.
test('Cursor envelope parser names tool calls as the session parser does: start and end share a key, a failed edit is no write', () => {
  const { watchTurn } = require('../electron/runtime/watchdog.mts')
  const { FileActivity } = require('../electron/file-activity.mts')
  const events = [], parser = createParser('cursor', event => events.push(event), 'auto', ORBIT_RESPONSE_SCHEMA)
  const call = (subtype, toolCall, extra = {}) => parser.line(JSON.stringify({ type: 'tool_call', subtype, ...extra, tool_call: toolCall, session_id: 'chat-1' }))
  const shell = { args: { command: 'npm test', toolCallId: 'call-1\nfc_1' } }
  call('started', { shellToolCall: shell, hookAdditionalContexts: [], toolCallId: 'call-1\nfc_1', startedAtMs: '1' })
  call('completed', { shellToolCall: { ...shell, result: { success: { exitCode: 0, stdout: 'ok' } } }, hookAdditionalContexts: [], toolCallId: 'call-1\nfc_1', startedAtMs: '1', completedAtMs: '2' })
  // Without either id the arguments key the call; `call_id` comes before the call's own id.
  call('started', { readToolCall: { args: { path: 'README.md' } } })
  call('completed', { readToolCall: { args: { path: 'README.md' }, result: { success: { content: 'hello' } } } })
  call('started', { editToolCall: { args: { path: 'a.txt' } }, toolCallId: 'inner' }, { call_id: 'c3' })
  call('completed', { editToolCall: { args: { path: 'a.txt' }, result: { writePermissionDenied: { path: 'a.txt' } } }, toolCallId: 'inner' }, { call_id: 'c3' })
  call('started', { editToolCall: { args: { path: 'b.txt' } } }, { call_id: 'c4' })
  call('completed', { editToolCall: { args: { path: 'b.txt' }, result: { success: { path: 'b.txt', linesAdded: 1 } } } }, { call_id: 'c4' })
  call('started', { grepToolCall: { args: { pattern: 'TODO', path: 'D:\\project' } } }, { call_id: 'g' })
  call('completed', { grepToolCall: { args: { pattern: 'TODO', path: 'D:\\project' }, result: { success: {} } } }, { call_id: 'g' })
  // Orbit gives Cursor no MCP server in the envelope transport: a server of the user's that ends in "orbit" is not Orbit's.
  const mcp = { args: { toolName: 'list_agents', providerIdentifier: 'plugin-orbit-orbit' } }
  call('started', { mcpToolCall: mcp }, { call_id: 'm' })
  call('completed', { mcpToolCall: { ...mcp, result: { success: { content: [] } } } }, { call_id: 'm' })
  const tools = events.filter(event => event.kind === 'tool')
  assert.deepEqual(tools.map(event => [event.toolId, event.tool, event.status, event.text, event.native]), [
    ['call-1\nfc_1', 'shellToolCall', 'started', 'npm test', true], ['call-1\nfc_1', 'shellToolCall', 'completed', 'npm test', true],
    [undefined, 'read', 'started', 'README.md', true], [undefined, 'read', 'completed', 'README.md', true],
    ['c3', 'edit', 'started', 'a.txt', true], ['c3', 'edit', 'failed', 'a.txt', true],
    ['c4', 'edit', 'started', 'b.txt', true], ['c4', 'edit', 'completed', 'b.txt', true],
    ['g', 'grepToolCall', 'started', 'TODO', true], ['g', 'grepToolCall', 'completed', 'TODO', true],
    ['m', 'mcpToolCall', 'started', 'list_agents', true], ['m', 'mcpToolCall', 'completed', 'list_agents', true],
  ])
  assert.match(tools[1].output, /"stdout":"ok"/)
  // A call that ended no longer holds the turn: the watchdog counts silence again and steering may cut between steps.
  const watch = watchTurn({ providerId: 'cursor', model: 'auto' }, null, () => {})
  try {
    tools.forEach((event, index) => { watch.note(event); assert.equal(watch.busy(), index % 2 === 0, `busy after event ${index}`) })
    assert.equal(watch.calling(), false)
  } finally { watch.stop() }
  // The file record takes the read and the edit that succeeded, not the one Cursor could not write.
  const activity = new FileActivity(os.tmpdir())
  for (const event of tools) activity.nativeEvent('cursor-agent', event)
  assert.deepEqual(activity.forAgent('cursor-agent'), { read: ['README.md'], wrote: ['b.txt'] })
})

test('session parsers take a session id only as a plain token: an object, a number or a flag-like string is ignored and reported once', () => {
  const shapes = { antigravity: value => ({ event: 'init', conversation_id: value }), cursor: value => ({ type: 'system', subtype: 'init', session_id: value }) }
  const done = { antigravity: { event: 'result', result: { status: 'SUCCESS', response: 'hi' } }, cursor: { type: 'result', subtype: 'success', result: 'hi' } }
  for (const [id, shape] of Object.entries(shapes)) {
    const events = [], parser = createSessionParser(id, event => events.push(event))
    for (const value of [{ evil: 1 }, 42, '--help', 'x'.repeat(200), 'has space']) parser.line(JSON.stringify(shape(value)))
    parser.line(JSON.stringify(done[id]))
    assert.deepEqual(parser.finish(), { text: 'hi', model: '', sessionId: undefined }, id)
    assert.equal(events.filter(event => event.source === 'diagnostic' && /malformed session id/.test(event.text)).length, 1, id)
    assert.equal(events.filter(event => event.kind === 'session').length, 0, `${id}: a malformed id is never announced`)
    const named = [], valid = createSessionParser(id, event => { if (event.kind === 'session') named.push(event) })
    for (const value of ['conv-1.2:3', '--later-junk', 'conv-1.2:3']) valid.line(JSON.stringify(shape(value)))
    assert.deepEqual(named, [{ providerId: id, kind: 'session', sessionId: 'conv-1.2:3' }], `${id}: the session is announced once, as the stream names it`)
    valid.line(JSON.stringify(done[id]))
    assert.equal(valid.finish().sessionId, 'conv-1.2:3', `${id}: a valid id is kept when junk follows`)
  }
  // Antigravity's id inside a step and in the result object obey the same rule.
  const steps = createSessionParser('antigravity')
  steps.line(JSON.stringify({ event: 'step_update', step_update: { conversation_id: { nested: true }, step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'ok' } }))
  steps.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', conversation_id: 'conv-9' } }))
  assert.deepEqual(steps.finish(), { text: 'ok', model: '', sessionId: 'conv-9' })
})

test('Antigravity session parser: conversation id, call_mcp_tool as an Orbit call, denied actions as a diagnostic, streamed text when the response is empty', () => {
  const events = [], parser = createSessionParser('antigravity', event => events.push(event))
  parser.line(JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: { model: 'claude-sonnet-4-6' } }))
  const step = update => parser.line(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', ...update } }))
  step({ step_index: 1, step_type: 'tool', tool_name: 'call_mcp_tool', state: 'ERROR', tool_info: { parameters: { ServerName: 'orbit_orbit', ToolName: 'memory_search', Arguments: { query: 'q' } }, error: { type: 'TOOL_ERROR', message: 'denied' } } })
  step({ step_index: 2, step_type: 'tool', tool_name: 'call_mcp_tool', state: 'DONE', tool_info: { parameters: { ServerName: 'github', ToolName: 'search' } } })
  step({ step_index: 3, step_type: 'tool', tool_name: 'replace_file_content', state: 'DONE', tool_info: { parameters: { TargetFile: 'C:\\ws\\a.txt' } } })
  step({ step_index: 4, step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE', tool_info: { parameters: { CommandLine: 'npm test' } } })
  step({ step_index: 5, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' })
  step({ step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: ' there' })
  step({ step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: ' again' })
  parser.line(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: '', usage: { input_tokens: 3 }, denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }] } }))
  assert.deepEqual(parser.finish(), { text: 'Hello there', model: 'claude-sonnet-4-6', sessionId: 'conv-1' })
  const tools = events.filter(event => event.kind === 'tool')
  assert.deepEqual(tools.map(event => [event.toolId, event.tool, event.status, event.native]), [['step-1', 'mcp__orbit__memory_search', 'failed', false], ['step-2', 'call_mcp_tool', 'completed', true], ['step-3', 'edit', 'completed', true], ['step-4', 'run_command', 'started', true]])
  assert.equal(tools[0].output, 'denied'); assert.deepEqual(tools[0].input, { query: 'q' }); assert.deepEqual(tools[2].input, { path: 'C:\\ws\\a.txt' }); assert.equal(tools[3].text, 'npm test')
  assert.ok(events.some(event => event.kind === 'observation' && event.status === 'denied'))
  assert.equal(events.filter(event => event.usage).length, 1)
  const answered = createSessionParser('antigravity')
  answered.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Final text', conversation_id: 'conv-2' } }))
  assert.deepEqual(answered.finish(), { text: 'Final text', model: '', sessionId: 'conv-2' })
  const failed = createSessionParser('antigravity')
  failed.line(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.' } }))
  assert.throws(() => failed.finish(), /User location is not supported/)
})

test('Antigravity session parser: a response that joins every message of the turn gives only the last message; any other response is kept whole', () => {
  const turn = (response, messages) => {
    const parser = createSessionParser('antigravity')
    messages.forEach((text, index) => {
      parser.line(JSON.stringify({ event: 'step_update', step_update: { step_index: 2 * index + 1, step_type: 'agent_response', state: 'DONE', text_delta: text } }))
      parser.line(JSON.stringify({ event: 'step_update', step_update: { step_index: 2 * index + 2, step_type: 'tool', tool_name: 'view_file', state: 'DONE', tool_info: { parameters: { AbsolutePath: 'C:\\ws\\a.txt' } } } }))
    })
    parser.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response, conversation_id: 'conv-1' } }))
    return parser.finish().text
  }
  const messages = ['Let me read the files first.\n', 'Now let me run the tests.\n', 'All 4 tests pass.\n\n{"answer": 42}\n']
  // As the CLI reported the model audit's turns: every message in order, the trailing newline trimmed.
  assert.equal(turn(messages.join('').trim(), messages), messages[2])
  // Separators between the messages and an empty last message change nothing.
  assert.equal(turn(messages.join('\n\n'), [...messages, '  ']), messages[2])
  // A response that does not end with the last message is the CLI's own text and stays; so does one without messages.
  assert.equal(turn('Summary written by the CLI', messages), 'Summary written by the CLI')
  assert.equal(turn('Final text', []), 'Final text')
})

test('the session transport refuses anything but Full access; envelope runs pass extraEnv; closeSession of an unknown id is false', async () => {
  const helpers = { runCli: async () => { throw new Error('must not run') }, busyCheck: () => () => false, loopbackNoProxy: () => ({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }) }
  for (const [id, accessMode, approvalPolicy] of [['cursor', 'workspace-write', 'never'], ['antigravity', 'danger-full-access', 'on-request']]) {
    await assert.rejects(runSession(id, { prompt: 'x', workspace: process.cwd(), accessMode, approvalPolicy }, { id: null, resume: false, mcpUrl: null, token: null, systemAppend: '', activity: null }, helpers), /only with Full access/)
  }
  for (const id of ['cursor', 'antigravity']) {
    let env
    await run(id, { prompt: 'x', workspace: process.cwd(), providerOptions: { proxyMode: 'inherit' }, extraEnv: { ORBIT_RUN_ID: 'r1', NUMBER: 1 } }, { runCli: async (_, args, options) => {
      env = options.env
      options.onLine(JSON.stringify(id === 'cursor' ? { type: 'result', subtype: 'success', result: 'ok' } : { event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
    } })
    assert.deepEqual(env, { ORBIT_RUN_ID: 'r1' }, id)
  }
  assert.equal(closeSession('never-seen'), false)
})

test('leftover session folders of an earlier Orbit are swept once they are old; fresh ones and other folders stay', t => {
  const make = prefix => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return folder }
  const old = make('orbit-agy-session-'), fresh = make('orbit-agy-session-'), plugin = make('orbit-cursor-mcp-'), other = make('orbit-agy-')
  const long = (Date.now() - 7 * 60 * 60 * 1000) / 1000
  for (const folder of [old, plugin, other]) fs.utimesSync(folder, long, long)
  const removed = sweepSessionDirectories()
  assert.ok(removed.includes(old) && removed.includes(plugin), JSON.stringify(removed))
  assert.ok(!removed.includes(fresh) && !removed.includes(other))
  assert.deepEqual([fs.existsSync(old), fs.existsSync(plugin), fs.existsSync(fresh), fs.existsSync(other)], [false, false, true, true])
})

test('session folders carry their process id: the sweep removes one at once when that process is gone, never one of a live process', t => {
  const make = prefix => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return folder }
  const plugin = writeCursorPlugin('http://127.0.0.1:1/mcp')
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }))
  assert.match(path.basename(plugin), new RegExp(`^orbit-cursor-mcp-${process.pid}-`))
  // A process that has exited: "no such process" is the only proof of a gone owner.
  let gonePid
  for (let attempt = 0; attempt < 5 && !gonePid; attempt++) {
    const pid = spawnSync(process.execPath, ['-e', '']).pid
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') gonePid = pid }
  }
  assert.ok(gonePid, 'an exited child process id')
  const gone = [make(`orbit-agy-session-${gonePid}-`), make(`orbit-cursor-mcp-${gonePid}-`)]
  const alive = [make(`orbit-agy-session-${process.pid}-`), make(`orbit-agy-session-${process.ppid}-`), make('orbit-agy-session-')]
  const removed = sweepSessionDirectories()
  assert.ok(gone.every(folder => removed.includes(folder) && !fs.existsSync(folder)), JSON.stringify(removed))
  assert.ok(alive.every(folder => !removed.includes(folder) && fs.existsSync(folder)) && fs.existsSync(plugin), 'this process, a live parent and an unnamed fresh folder stay')
})

test('Antigravity runtime explains regional rejection and cleans its temporary workspace', async () => {
  let directory
  await assert.rejects(run('antigravity', { prompt: 'Hello' }, { runCli: async (_, args, options) => {
    directory = options.cwd
    throw new Error(regionError)
  } }), error => error.message.includes('по региону') && error.message.includes(regionError))
  assert.equal(fs.existsSync(directory), false)
})
