const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, inspectProviders, transportFor, mcpCallLimit } = require('../electron/providers.mts')
const { _testing } = require('../electron/providers.mts')
const codexServer = require('../electron/codex-server.mts')
const { withEnv, workspaceFolder } = require('./helpers-providers-session.cjs')

// Subscription instances (electron/instances.mts): "claude-2" runs Claude Code's adapter with CLAUDE_CONFIG_DIR pointed at
// the account's folder, "codex-2" Codex with CODEX_HOME; the default ids run exactly as before, with no account variable.

const NO_ACCOUNT = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ORBIT_LEGACY_ENVELOPE: undefined }

// A fake CLI (a .cmd shim resolveLaunch turns into `node cli.cjs`) that appends one record per invocation: its arguments and
// the account variables it was started with. `body` is the CLI's answer, run once stdin has ended.
function accountCli(t, envKey, body = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-instance-fixture-'))
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }) })
  const records = path.join(directory, 'records.jsonl')
  fs.writeFileSync(path.join(directory, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  fs.writeFileSync(path.join(directory, 'cli.cjs'), `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const out = message => console.log(JSON.stringify(message));
    let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => { input += part });
    process.stdin.on('end', () => {
      const env = { claudeConfig: process.env.CLAUDE_CONFIG_DIR ?? null, codexHome: process.env.CODEX_HOME ?? null, token: process.env.ORBIT_MCP_TOKEN ?? null, extra: process.env.ORBIT_TEST_EXTRA ?? null };
      fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({ args, input, env }) + '\\n');
      ${body}
    });
  `)
  if (envKey) withEnv(t, { [envKey]: path.join(directory, 'cli.cmd') })
  return { directory, command: path.join(directory, 'cli.cmd'), records: () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] }
}
const accountFolder = (t, name) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `orbit-account-${name}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const CLAUDE_ANSWER = `
  out({ type: 'system', subtype: 'init', session_id: args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : 's1', model: 'claude-fixture' });
  process.stderr.write('a diagnostic line\\n');
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hi ' + input.trim() }] } });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1790687385 } });
  out({ type: 'result', subtype: 'success', result: 'Hi ' + input.trim() });
`
const CODEX_ANSWER = `
  out({ type: 'thread.started', thread_id: 'thread-x1' });
  out({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Codex ' + input.trim() } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`
const SESSION = { token: 'tok', mcpUrl: 'http://127.0.0.1:9/mcp' }

test('Claude: an instance runs the claude adapter with CLAUDE_CONFIG_DIR, in an envelope and in a session; events and result carry the instance id; the default does not', async t => {
  withEnv(t, NO_ACCOUNT)
  const cli = accountCli(t, 'ORBIT_CLAUDE_COMMAND', CLAUDE_ANSWER)
  const dir = accountFolder(t, 'claude-2')
  const providerOptions = { base: 'claude', label: 'Work', accountDir: dir }
  const workspace = workspaceFolder(t)
  const events = []
  const envelope = await runProvider({ providerId: 'claude-2', providerOptions, workspace, accessMode: 'read-only', prompt: 'one', onEvent: event => events.push(event) })
  assert.equal(envelope.providerId, 'claude-2'); assert.equal(envelope.client, 'Claude Code'); assert.equal(envelope.text, 'Hi one')
  const session = await runProvider({ providerId: 'claude-2', providerOptions, workspace, accessMode: 'workspace-write', prompt: 'two', onEvent: event => events.push(event), session: SESSION, extraEnv: { ORBIT_TEST_EXTRA: 'kept', CLAUDE_CONFIG_DIR: 'must-not-win' } })
  assert.equal(session.providerId, 'claude-2'); assert.equal(session.transport, 'session'); assert.equal(session.text, 'Hi two')
  const [first, second] = cli.records()
  assert.equal(first.env.claudeConfig, dir); assert.equal(second.env.claudeConfig, dir, 'the account folder wins over the caller\'s extra variables')
  assert.equal(second.env.extra, 'kept', 'the runtime\'s own extra variables still reach the CLI'); assert.equal(second.env.token, null)
  assert.ok(events.length > 3)
  assert.deepEqual([...new Set(events.map(event => event.providerId))], ['claude-2'], 'every event, the stderr diagnostic and the live quota figures included, names the instance')
  assert.ok(events.some(event => event.kind === 'quota') && events.some(event => event.kind === 'observation' && event.source === 'stderr'))

  const plain = []
  const normal = await runProvider({ providerId: 'claude', workspace, accessMode: 'read-only', prompt: 'three', onEvent: event => plain.push(event) })
  assert.equal(normal.providerId, 'claude')
  assert.equal(cli.records()[2].env.claudeConfig, null, 'the default account\'s run has no account variable')
  assert.deepEqual([...new Set(plain.map(event => event.providerId))], ['claude'])
  // Same arguments as the default account: the instance changes the environment, nothing else.
  const strip = args => args.filter(item => !/^[0-9a-f]{8}-/.test(item))
  assert.deepEqual(strip(cli.records()[0].args), strip(cli.records()[2].args))
})

test('Codex: exec (envelope and session) and both App Server transports get CODEX_HOME for an instance; the default does not', async t => {
  withEnv(t, NO_ACCOUNT)
  const cli = accountCli(t, 'ORBIT_CODEX_COMMAND', CODEX_ANSWER)
  const dir = accountFolder(t, 'codex-2')
  const providerOptions = { base: 'codex', label: 'Second', accountDir: dir }
  const workspace = workspaceFolder(t)
  const events = []
  const envelope = await runProvider({ providerId: 'codex-2', providerOptions, workspace, accessMode: 'read-only', prompt: 'one', onEvent: event => events.push(event) })
  const session = await runProvider({ providerId: 'codex-2', providerOptions, workspace, accessMode: 'workspace-write', prompt: 'two', onEvent: event => events.push(event), session: SESSION })
  assert.deepEqual([envelope.providerId, session.providerId], ['codex-2', 'codex-2']); assert.equal(session.transport, 'session'); assert.equal(session.sessionId, 'thread-x1')
  assert.deepEqual(cli.records().map(record => record.env.codexHome), [dir, dir])
  assert.equal(cli.records()[1].env.token, 'tok', 'Orbit\'s own session token still reaches the instance\'s CLI')
  assert.deepEqual([...new Set(events.map(event => event.providerId))], ['codex-2'])
  await runProvider({ providerId: 'codex', workspace, accessMode: 'read-only', prompt: 'three' })
  assert.equal(cli.records()[2].env.codexHome, null)
  assert.equal(cli.records().length, 3)
})

// The App Server: a fake `codex app-server` that records CODEX_HOME at start-up, then answers a thread and a turn.
const APP_SERVER = `
  const send = message => console.log(JSON.stringify(message));
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'thread/resume') return send({ id: m.id, error: { code: -32602, message: 'unknown thread' } });
    if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: 'thread-' + process.pid }, model: 'fixture-model' } });
    if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'item/completed', params: { threadId: m.params.threadId, item: { id: 'msg', type: 'agentMessage', phase: 'final_answer', text: 'App ' + m.params.input[0].text } } });
      send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { status: 'completed' } } });
    }
  });
`
async function appServerRun(t, providerId, providerOptions, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-instance-appserver-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const record = path.join(directory, 'env.jsonl')
  fs.writeFileSync(path.join(directory, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  fs.writeFileSync(path.join(directory, 'cli.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ codexHome: process.env.CODEX_HOME ?? null }) + '\\n');\n${APP_SERVER}`)
  const events = []
  const result = await runProvider({ providerId, providerOptions: { ...providerOptions, command: path.join(directory, 'cli.cmd') }, workspace: workspaceFolder(t), accessMode: 'workspace-write', approvalPolicy: 'on-request', prompt: 'ask', onEvent: event => events.push(event), ...extra })
  return { result, events, homes: () => fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).codexHome) }
}

test('Codex App Server (one turn and a session) starts with the instance\'s CODEX_HOME; events and result name the instance', async t => {
  withEnv(t, NO_ACCOUNT)
  const dir = accountFolder(t, 'codex-2')
  const providerOptions = { base: 'codex', label: 'Second', accountDir: dir }
  const turn = await appServerRun(t, 'codex-2', providerOptions)
  assert.equal(turn.result.providerId, 'codex-2'); assert.equal(turn.result.text, 'App ask')
  assert.deepEqual(turn.homes(), [dir])
  assert.ok(turn.events.every(event => event.providerId === 'codex-2'))
  const live = await appServerRun(t, 'codex-2', providerOptions, { session: SESSION })
  try {
    assert.equal(live.result.providerId, 'codex-2'); assert.equal(live.result.transport, 'session')
    assert.deepEqual(live.homes(), [dir])
    assert.ok(live.events.length > 0 && live.events.every(event => event.providerId === 'codex-2'))
  } finally { await codexServer.closeSession(live.result.sessionId) }
  const plain = await appServerRun(t, 'codex', undefined, { session: SESSION })
  try { assert.deepEqual(plain.homes(), [null]); assert.equal(plain.result.providerId, 'codex') } finally { await codexServer.closeSession(plain.result.sessionId) }
})

test('a live App Server thread is never continued on another account\'s process', async t => {
  withEnv(t, NO_ACCOUNT)
  const first = accountFolder(t, 'codex-a'), second = accountFolder(t, 'codex-b')
  const one = await appServerRun(t, 'codex-2', { base: 'codex', label: 'A', accountDir: first }, { session: SESSION })
  try {
    assert.equal(codexServer.sessions.has(one.result.sessionId), true)
    const live = codexServer.sessions.get(one.result.sessionId)
    const two = await appServerRun(t, 'codex-3', { base: 'codex', label: 'B', accountDir: second }, { session: { ...SESSION, id: one.result.sessionId, resume: true } })
    assert.deepEqual(two.homes(), [second], 'a resume on the other account started that account\'s own process')
    assert.equal(live.closed, true, 'the first account\'s process was closed, not borrowed')
    await codexServer.closeSession(two.result.sessionId)
  } finally { await codexServer.closeSession(one.result.sessionId) }
})

test('a refused instance spawns nothing and says why: no folder, a CLI without account support', async t => {
  withEnv(t, NO_ACCOUNT)
  const claude = accountCli(t, 'ORBIT_CLAUDE_COMMAND', CLAUDE_ANSWER)
  const cursor = accountCli(t, 'ORBIT_CURSOR_COMMAND', `out({ type: 'result', subtype: 'success', result: 'x' })`)
  const antigravity = accountCli(t, 'ORBIT_ANTIGRAVITY_COMMAND', '')
  const workspace = workspaceFolder(t)
  await assert.rejects(runProvider({ providerId: 'claude-2', workspace, prompt: 'x', accessMode: 'read-only' }), /claude-2 has no account folder/)
  await assert.rejects(runProvider({ providerId: 'claude-2', providerOptions: { base: 'claude', accountDir: '  ' }, workspace, prompt: 'x', accessMode: 'read-only', session: SESSION }), /no account folder/)
  await assert.rejects(runProvider({ providerId: 'codex-3', providerOptions: { command: claude.command }, workspace, prompt: 'x', accessMode: 'read-only' }), /codex-3 has no account folder/)
  const events = []
  await assert.rejects(runProvider({ providerId: 'cursor-2', providerOptions: { base: 'cursor', accountDir: os.tmpdir() }, workspace, prompt: 'x', accessMode: 'danger-full-access', onEvent: event => events.push(event) }), /cursor has no setting for a second account: only one Cursor subscription/)
  await assert.rejects(runProvider({ providerId: 'antigravity-2', providerOptions: { accountDir: os.tmpdir() }, workspace, prompt: 'x', accessMode: 'read-only', session: SESSION }), /antigravity has no setting for a second account/)
  assert.deepEqual([claude.records(), cursor.records(), antigravity.records(), events], [[], [], [], []], 'no process was started and nothing was reported as the default account\'s')
})

test('ids of an instance resolve by their base: transport, call limits and session ids', () => {
  assert.equal(transportFor('claude-2'), 'session'); assert.equal(transportFor('codex-2'), 'session')
  assert.equal(transportFor('cursor-2', { accessMode: 'danger-full-access' }), 'envelope')
  assert.equal(mcpCallLimit('codex-2'), mcpCallLimit('codex')); assert.ok(mcpCallLimit('codex-2') > 0)
  assert.equal(mcpCallLimit('claude-2'), 0)
  assert.throws(() => _testing.normalizeSession('claude-2', { id: 'not-a-uuid' }), /Claude session ids must be UUIDs/)
  assert.match(_testing.normalizeSession('claude-2', {}).id, /^[0-9a-f-]{36}$/, 'a Claude instance gets a fresh UUID session like Claude')
  assert.throws(() => _testing.normalizeSession('codex-2', { id: '--flag', resume: true }), /Unexpected codex session id/)
})

// ---- inspection --------------------------------------------------------------------------------------------------

// The fake `claude`/`codex`: `--version`, and an auth probe that answers by the account folder (signed in once it holds `logged-in`).
const PROBE = `
  const home = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || '';
  const signedIn = !home || fs.existsSync(path.join(home, 'logged-in'));
  if (args[0] === '--version') return console.log('fake-cli 9.9.9');
  if (args[0] === 'auth') return out({ loggedIn: signedIn });
  if (args[0] === 'login') { if (!signedIn) process.exitCode = 1; return console.log(signedIn ? 'Logged in' : 'Not logged in') }
`
const modelsCache = (directory, slug) => fs.writeFileSync(path.join(directory, 'models_cache.json'), JSON.stringify({ models: [{ slug, visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'hidden', visibility: 'hide' }] }))
const unreachable = path.join(os.tmpdir(), 'orbit-no-such-cli-anywhere.cmd')

test('inspectProviders: the six default entries stay as they were, each instance gets an entry probed with its own account', async t => {
  const defaultHome = accountFolder(t, 'default-home')
  withEnv(t, { ...NO_ACCOUNT, CODEX_HOME: defaultHome, ORBIT_CURSOR_COMMAND: unreachable, ORBIT_ANTIGRAVITY_COMMAND: unreachable, ORBIT_OPENAI_BASE_URL: undefined })
  modelsCache(defaultHome, 'default-model'); fs.writeFileSync(path.join(defaultHome, 'logged-in'), '1')
  const claude = accountCli(t, 'ORBIT_CLAUDE_COMMAND', PROBE)
  const codex = accountCli(t, 'ORBIT_CODEX_COMMAND', PROBE)
  const claudeTwo = accountFolder(t, 'claude-2'), codexTwo = accountFolder(t, 'codex-2'), codexThree = accountFolder(t, 'codex-3')
  fs.writeFileSync(path.join(claudeTwo, 'logged-in'), '1')
  fs.writeFileSync(path.join(codexThree, 'logged-in'), '1'); modelsCache(codexThree, 'own-model')
  const other = accountCli(t, undefined, PROBE)
  const options = {
    'claude-2': { base: 'claude', label: 'Work', accountDir: claudeTwo },
    'codex-2': { base: 'codex', label: 'Spare', accountDir: codexTwo },
    'codex-3': { base: 'codex', label: 'Own', accountDir: codexThree, command: other.command },
    'cursor-2': { base: 'cursor', label: 'Second Cursor', accountDir: os.tmpdir() },
    'claude-9': { base: 'claude', label: 'Folderless' },
  }
  const health = await inspectProviders(options)
  assert.deepEqual(health.map(entry => entry.id), ['codex', 'claude', 'ollama', 'antigravity', 'cursor', 'custom', 'claude-2', 'codex-2', 'codex-3', 'cursor-2'], 'six defaults first, then the instances in the options\' order')
  const byId = Object.fromEntries(health.map(entry => [entry.id, entry]))
  for (const id of ['codex', 'claude', 'ollama', 'antigravity', 'cursor', 'custom']) assert.equal('base' in byId[id] || 'label' in byId[id], false, `${id}: a default entry has no base or label`)
  // The default entries: probed without any account variable (the plain CLI's own account), as before.
  assert.equal(byId.claude.authenticated, true); assert.equal(byId.codex.authenticated, true); assert.deepEqual(byId.codex.models, ['default-model'])
  // claude-2: signed in, probed with its folder.
  assert.deepEqual([byId['claude-2'].base, byId['claude-2'].label, byId['claude-2'].supported, byId['claude-2'].available, byId['claude-2'].authenticated], ['claude', 'Work', true, true, true])
  assert.deepEqual(byId['claude-2'].models, ['sonnet', 'opus', 'haiku'])
  assert.match(byId['claude-2'].detail, /fake-cli 9.9.9 · Вход выполнен/)
  // codex-2: not signed in: unavailable, with how to sign in THIS account; the models come from the default home's cache.
  assert.deepEqual([byId['codex-2'].base, byId['codex-2'].label, byId['codex-2'].supported, byId['codex-2'].available, byId['codex-2'].authenticated], ['codex', 'Spare', true, false, false])
  assert.match(byId['codex-2'].detail, /Войдите в этот аккаунт \(Spare\): codex login/); assert.match(byId['codex-2'].detail, /«Войти»/)
  assert.deepEqual(byId['codex-2'].models, ['default-model'], 'no cache in the new account yet: the default home\'s model list stands in')
  assert.deepEqual(byId['codex-2'].reasoningLevels, { 'default-model': ['low', 'high'] })
  // codex-3: its own cache wins, its own `command` is the one probed.
  assert.deepEqual([byId['codex-3'].available, byId['codex-3'].authenticated], [true, true]); assert.deepEqual(byId['codex-3'].models, ['own-model'])
  assert.equal(path.basename(byId['codex-3'].executable).toLowerCase(), 'cli.cmd'); assert.equal(path.dirname(byId['codex-3'].executable), other.directory)
  // cursor-2: Cursor's CLI has no account variable: listed, unsupported, with the reason.
  assert.deepEqual([byId['cursor-2'].base, byId['cursor-2'].supported, byId['cursor-2'].available], ['cursor', false, false]); assert.match(byId['cursor-2'].detail, /only one Cursor subscription/)
  // An instance without a folder is not probed and says so.
  assert.equal(byId['claude-9'], undefined, 'an entry without a folder is not an instance (instancesFromOptions drops it)')

  const seen = (cli, key) => cli.records().map(record => [record.args.join(' '), record.env[key]])
  assert.deepEqual(seen(claude, 'claudeConfig').filter(([, home]) => home === claudeTwo).map(([args]) => args).sort(), ['--version', 'auth status'])
  assert.deepEqual(seen(claude, 'claudeConfig').filter(([, home]) => home !== claudeTwo).map(([, home]) => home), [null, null], 'the default claude probes run with no account variable')
  assert.deepEqual(seen(codex, 'codexHome').filter(([, home]) => home === codexTwo).map(([args]) => args).sort(), ['--version', 'login status'])
  assert.deepEqual(seen(codex, 'codexHome').filter(([, home]) => home !== codexTwo).map(([, home]) => home), [defaultHome, defaultHome], 'the default codex probes keep the process environment')
  assert.deepEqual(seen(other, 'codexHome').map(([args, home]) => [args, home]).sort(), [['--version', codexThree], ['login status', codexThree]])
})

test('inspectProviders: an instance whose CLI is missing is unavailable with the install hint; without instances the list is the six entries', async t => {
  withEnv(t, { ...NO_ACCOUNT, ORBIT_CODEX_COMMAND: unreachable, ORBIT_CLAUDE_COMMAND: unreachable, ORBIT_CURSOR_COMMAND: unreachable, ORBIT_ANTIGRAVITY_COMMAND: unreachable, ORBIT_OPENAI_BASE_URL: undefined, CODEX_HOME: accountFolder(t, 'empty-home') })
  assert.equal((await inspectProviders({})).length, 6)
  const health = await inspectProviders({ 'claude-2': { base: 'claude', label: 'Work', accountDir: accountFolder(t, 'claude-2') } })
  const entry = health.find(item => item.id === 'claude-2')
  assert.deepEqual([entry.base, entry.label, entry.installed, entry.available, entry.authenticated], ['claude', 'Work', false, false, false])
  assert.match(entry.detail, /Claude Code CLI не найден/)
})
