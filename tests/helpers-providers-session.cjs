const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { terminateProcess, _testing } = require('../electron/providers.mts')

// Fixtures shared by tests/providers-session*.test.cjs: fake CLIs written to a fresh temp folder per call, and the fake
// Codex App Server (a node -e script) with the launch helpers codex-server.mts takes.
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

const appServerFixture = `
  const send = message => console.log(JSON.stringify(message));
  let turns = 0;
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    // FIXTURE_LOG: the thread and turn requests, one JSON line each.
    if (process.env.FIXTURE_LOG && /^(thread|turn)\\//.test(m.method)) require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
    // A request the test holds: the fixture writes its pid to FIXTURE_MARK when it arrives and answers it 400 ms later.
    if (process.env.FIXTURE_HOLD && m.method === process.env.FIXTURE_HOLD) {
      require('node:fs').writeFileSync(process.env.FIXTURE_MARK, String(process.pid));
      const result = m.method === 'initialize' ? {} : { thread: { id: m.params.threadId || 'thread-' + process.pid }, model: 'fixture-model' };
      return setTimeout(() => send({ id: m.id, result }), 400);
    }
    if (m.method === 'initialize') return send({ id: m.id, result: {} });
    if (m.method === 'thread/resume') return send({ id: m.id, error: { code: -32602, message: 'unknown thread' } });
    if (m.method === 'thread/start') {
      if (m.params.ephemeral !== false || m.params.approvalPolicy !== 'on-request') throw new Error('session threads persist and ask');
      const answer = JSON.stringify({ id: m.id, result: { thread: { id: 'thread-' + process.pid }, model: 'fixture-model' } });
      // FIXTURE_TRAIL: a rate-limit notice follows the answer in the same write, so Orbit reads both at once.
      return process.stdout.write(answer + '\\n' + (process.env.FIXTURE_TRAIL ? JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: {} } }) + '\\n' : ''));
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
const helpers = (launches, env = {}) => ({
  resolveLaunch: (_command, args) => { launches.push(args); return { executable: process.execPath, args: ['-e', appServerFixture], env: { ...process.env, ...env } } },
  terminateProcess, createLineReader: _testing.createLineReader, busyCheck: () => () => false,
})

module.exports = { UUID, SESSION, after, count, withEnv, fakeCli, recordingCli, workspaceFolder, samePath, until, appServerFixture, helpers }
