const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const connectors = require('../electron/connectors.mts')
const { ConnectorStore, normalizeConnector, maskToolArguments, toolCallText, testConnector, launchOf } = connectors
const { OrbitRuntime } = require('../electron/runtime.mts')
const providers = require('../electron/providers.mts')
const subscriptions = require('../electron/subscription-providers.mts')
const { sessionGuide } = require('../electron/runtime/prompts.mts')
const { validate, toolsFor } = require('../electron/tool-registry.mts')
const { folder, fakeMcp, finished, payload, agentOf } = require('./helpers-session.cjs')

const SERVER = path.join(__dirname, 'fixtures', 'echo-mcp-server.cjs')
const SECRET = 'sup3r-s3cret-value'
const stdio = (extra = {}) => ({ name: 'fx', description: 'Fixture echo server', command: process.execPath, args: [SERVER], env: [`FIXTURE_SECRET=${SECRET}`], ...extra })
const remote = (extra = {}) => ({ name: 'web', description: 'A remote server', url: 'https://example.com/mcp?key=urlsecret', headers: [`Authorization: Bearer ${SECRET}`], ...extra })
const NOW = '2026-10-01T00:00:00.000Z'
const stored = (input, scope = 'project') => ({ ...normalizeConnector(input, NOW), scope })

test('validation: names, transport, url, env and header shapes each fail with a clear message', () => {
  assert.equal(normalizeConnector(stdio(), NOW).stdio.env.FIXTURE_SECRET, SECRET)
  assert.deepEqual(normalizeConnector(stdio({ env: { A: '1' } }), NOW).stdio.env, { A: '1' }, 'an object works as well as a list')
  assert.deepEqual(normalizeConnector(remote({ headers: ['X-A: 1', 'X-B:2'] }), NOW).http.headers, { 'X-A': '1', 'X-B': '2' })
  for (const [input, message] of [
    [stdio({ name: 'Bad Name' }), /Connector name must be 1-40 characters/],
    [stdio({ name: '1abc' }), /Connector name must be/],
    [stdio({ name: 'a'.repeat(41) }), /Connector name must be/],
    [stdio({ name: 'orbit' }), /"orbit" is reserved/],
    [stdio({ description: '  ' }), /needs a short description/],
    [stdio({ url: 'https://x.test' }), /either command .* or url .*, not both/],
    [{ name: 'a', description: 'd' }, /needs either command .* or url/],
    [remote({ url: 'not a url' }), /url is not a valid URL/],
    [remote({ url: 'ftp://example.com/x' }), /must start with http/],
    [stdio({ env: ['NOEQUALS'] }), /env\[0\] must be a string like "KEY=value"/],
    [stdio({ env: ['1BAD=x'] }), /env: "1BAD" is not a valid name/],
    [stdio({ args: 'one' }), /args must be an array of strings/],
    [stdio({ args: [1] }), /args\[0\] must be a string/],
    [stdio({ headers: ['A: b'] }), /headers belong to an HTTP connector/],
    [remote({ env: ['A=1'] }), /args and env belong to a command connector/],
    [remote({ headers: ['no colon'] }), /headers\[0\] must be a string like "Name: value"/],
  ]) assert.throws(() => normalizeConnector(input, NOW), message, JSON.stringify(input).slice(0, 80))
  assert.throws(() => normalizeConnector(null, NOW), /needs a name/)
})

test('the registry: three tools need full access, the list does not, and arguments are validated', () => {
  const names = access => toolsFor({ root: false, accessMode: access }).map(tool => tool.name).filter(name => name.startsWith('connector_'))
  assert.deepEqual(names('danger-full-access').sort(), ['connector_add', 'connector_list', 'connector_remove', 'connector_test'])
  assert.deepEqual(names('workspace-write'), ['connector_list'])
  assert.deepEqual(names('read-only'), ['connector_list'])
  assert.equal(validate('connector_add', { name: 'fx', description: 'd', command: 'node', args: ['a'], env: ['A=1'] }).ok, true)
  assert.deepEqual(validate('connector_add', { name: 'fx', description: 'd', command: 'node', enabled: false }), { ok: true, args: { name: 'fx', description: 'd', command: 'node', enabled: false } })
  assert.match(validate('connector_add', { name: 'fx', description: 'd', command: 'node', enabled: 'no' }).error, /enabled/)
  assert.match(validate('connector_add', { name: ' ', description: 'd' }).error, /name and a description/)
  assert.match(validate('connector_add', { name: 'x', description: 'd', env: { A: '1' } }).error, /env must be an array/)
  assert.match(validate('connector_test', {}).error, /name is required/)
})

test('scopes: global and project, the project hides a global one of its name, only enabled ones launch, removal order', t => {
  const root = folder(t), project = path.join(root, 'p1'), other = path.join(root, 'p2')
  fs.mkdirSync(project); fs.mkdirSync(other)
  const store = new ConnectorStore(path.join(root, 'data'))
  assert.equal(store.add(stdio({ name: 'shared' }), { scope: 'global' }).replaced, false)
  assert.equal(store.add(stdio({ name: 'shared', description: 'project version' }), { scope: 'project', workspace: project }).replaced, false)
  store.add(remote(), { workspace: project })
  assert.equal(store.add(remote({ description: 'changed' }), { workspace: project }).replaced, true, 'the same name in a scope replaces')
  assert.deepEqual(store.resolve(project).map(item => [item.name, item.scope, item.description]), [['shared', 'project', 'project version'], ['web', 'project', 'changed']])
  assert.deepEqual(store.resolve(other).map(item => [item.name, item.scope]), [['shared', 'global']], 'another project sees only the global one')
  assert.deepEqual(store.list(project).map(item => [item.name, item.scope, item.shadowedBy || '']), [['shared', 'project', ''], ['web', 'project', ''], ['shared', 'global', 'project']])
  store.setEnabled('web', false, { workspace: project })
  assert.deepEqual(store.resolve(project).map(item => item.name), ['shared'])
  assert.equal(store.list(project).find(item => item.name === 'web').enabled, false)
  assert.equal(store.remove('shared', { workspace: project }).scope, 'project', 'without a scope the project one goes first')
  assert.equal(store.remove('shared', { workspace: project }).scope, 'global')
  assert.equal(store.remove('shared', { workspace: project }), null)
  assert.throws(() => store.add(stdio(), { scope: 'nope' }), /scope must be/)
  // A new store over the same folder reads what was saved, secrets included (they are launch data), and drops what is invalid.
  const file = path.join(root, 'data', 'connectors.json')
  const again = new ConnectorStore(path.join(root, 'data'))
  assert.equal(again.resolve(project).length, 0, 'web is disabled')
  assert.equal(again.find('web', project).http.headers.Authorization, `Bearer ${SECRET}`)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.global.push({ name: 'orbit', description: 'x', stdio: { command: 'x', args: [], env: {} } }, { name: 'bad', description: '' })
  fs.writeFileSync(file, JSON.stringify(raw))
  assert.deepEqual(new ConnectorStore(path.join(root, 'data')).list(other), [])
})

test('masking: views, tool arguments and trace lines never carry an env or header value', () => {
  const [one, two] = [stored(stdio()), stored(remote(), 'global')]
  const views = JSON.stringify([connectors.connectorView(one, 'project'), connectors.connectorView(two, 'global')])
  assert.ok(!views.includes(SECRET) && !views.includes('urlsecret'), views)
  assert.deepEqual(connectors.connectorView(one, 'project').envKeys, ['FIXTURE_SECRET'])
  assert.deepEqual(connectors.connectorView(two, 'global').headerNames, ['Authorization'])
  assert.equal(connectors.connectorView(two, 'global').url, 'https://example.com/mcp?key=***')
  const args = { name: 'fx', description: 'd', command: 'node', env: [`K=${SECRET}`, 'B=1'], headers: [`Authorization: Bearer ${SECRET}`], url: 'https://u:pw@example.com/?t=zzz' }
  const masked = JSON.stringify(maskToolArguments('connector_add', args))
  assert.ok(!masked.includes(SECRET) && !masked.includes('zzz') && !masked.includes(':pw@'), masked)
  assert.match(masked, /"env":\["K=\*\*\*","B=\*\*\*"\]/)
  assert.deepEqual(maskToolArguments('connector_add', { env: { K: SECRET } }), { env: { K: '***' } })
  assert.equal(maskToolArguments('read_file', args), args, 'other tools pass through')
  assert.ok(!toolCallText('connector_add', args).includes(SECRET))
  assert.match(toolCallText('connector_add', args), /^connector_add \{/)
})

// The text npm writes for a package's .cmd shim: the JS entry is the quoted "%dp0%\..." path.
const npmShim = entry => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*\r\n`
const NASTY = ['injected" & echo INJECTED_OUTPUT', 'https://x.test/?a=1&b=2', '100%', '^caret|pipe<in>out', 'two words', 'line\nbreak']

test('launchOf runs a standard npm shim as node + its JS entry with the literal arguments, no shell', t => {
  const bin = folder(t), nodes = folder(t)
  fs.mkdirSync(path.join(bin, 'node_modules', 'srv', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(bin, 'node_modules', 'srv', 'bin', 'cli.js'), '')
  fs.writeFileSync(path.join(bin, 'npx.cmd'), npmShim('node_modules\\srv\\bin\\cli.js')); fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh')
  fs.writeFileSync(path.join(nodes, 'node.exe'), '')
  const entry = path.join(bin, 'node_modules', 'srv', 'bin', 'cli.js')
  // No node.exe beside the shim: the one on PATH.
  const onPath = { platform: 'win32', pathEnv: [bin, nodes].join(path.delimiter) }
  assert.deepEqual(launchOf({ command: 'npx', args: ['-y', ...NASTY], env: {} }, onPath), { command: path.join(nodes, 'node.exe'), args: [entry, '-y', ...NASTY] })
  assert.deepEqual(launchOf({ command: path.join(bin, 'npx.cmd'), args: ['a'], env: {} }, onPath), { command: path.join(nodes, 'node.exe'), args: [entry, 'a'] }, 'a shim given by path')
  assert.deepEqual(launchOf({ command: 'npx.cmd', args: ['a'], env: {} }, onPath), { command: path.join(nodes, 'node.exe'), args: [entry, 'a'] }, 'a shim given by name with its extension')
  // node.exe next to the shim wins over the one on PATH.
  fs.writeFileSync(path.join(bin, 'node.exe'), '')
  assert.equal(launchOf({ command: 'npx', args: [], env: {} }, onPath).command, path.join(bin, 'node.exe'))
  fs.rmSync(path.join(bin, 'node.exe'))
  // A shim whose entry is gone is not a standard shim any more; no node anywhere is a clear refusal.
  assert.throws(() => launchOf({ command: 'npx', args: [], env: {} }, { platform: 'win32', pathEnv: bin }), /needs Node\.js, and node\.exe was not found/)
  fs.rmSync(entry)
  assert.throws(() => launchOf({ command: 'npx', args: ['a&b'], env: {} }, onPath), /not a standard npm shim/)
  // The launch goes into every provider's config unchanged.
  fs.writeFileSync(entry, '')
  const spec = { name: 'fx', stdio: { command: 'npx', args: ['-y', NASTY[0]], env: {} } }
  assert.deepEqual(connectors.claudeServers([spec], onPath).fx, { type: 'stdio', command: path.join(nodes, 'node.exe'), args: [entry, '-y', NASTY[0]] })
  assert.deepEqual(connectors.cursorServers([spec], onPath).fx.args, [entry, '-y', NASTY[0]])
})

test('launchOf: a .cmd that is not an npm shim goes through cmd /d /c only without cmd.exe metacharacters, else it is refused', t => {
  const bin = folder(t)
  fs.writeFileSync(path.join(bin, 'tool.cmd'), '@echo off\r\necho hi'); fs.writeFileSync(path.join(bin, 'plain.exe'), '')
  const where = { platform: 'win32', pathEnv: bin }
  assert.deepEqual(launchOf({ command: 'tool', args: ['-y', 'two words', 'https://x.test/path'], env: {} }, where), { command: 'cmd', args: ['/d', '/c', 'tool', '-y', 'two words', 'https://x.test/path'] })
  assert.deepEqual(launchOf({ command: path.join(bin, 'tool.cmd'), args: [], env: {} }, where), { command: 'cmd', args: ['/d', '/c', path.join(bin, 'tool.cmd')] })
  for (const nasty of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', '100%', 'say "hi"', 'one\ntwo', 'one\rtwo']) {
    assert.throws(() => launchOf({ command: 'tool', args: ['ok', nasty], env: {} }, where), /not a standard npm shim.*cannot pass an argument with & \| < > \^ % " or a line break unchanged.*the url transport/, JSON.stringify(nasty))
  }
  assert.throws(() => launchOf({ command: 'my&tool.cmd', args: [], env: {} }, where), /not a standard npm shim/, 'the command itself too')
  // An .exe, an unknown name, a plain path, and every other platform are left exactly as given.
  assert.deepEqual(launchOf({ command: 'plain', args: ['a&b'], env: {} }, where), { command: 'plain', args: ['a&b'] })
  assert.deepEqual(launchOf({ command: 'missing', args: ['a&b'], env: {} }, where), { command: 'missing', args: ['a&b'] })
  assert.deepEqual(launchOf({ command: 'C:\\x\\server.exe', args: ['a&b'], env: {} }, where), { command: 'C:\\x\\server.exe', args: ['a&b'] })
  assert.deepEqual(launchOf({ command: 'tool', args: ['a&b'], env: {} }, { ...where, platform: 'linux' }), { command: 'tool', args: ['a&b'] })
  assert.deepEqual(launchOf({ command: 'tool.cmd', args: ['a&b'], env: {} }, { ...where, platform: 'darwin' }), { command: 'tool.cmd', args: ['a&b'] })
})

test('a refused script is refused at connector_add and named by connector_test; a launch that cannot be made leaves the connector out', { skip: process.platform !== 'win32' }, async t => {
  const bin = folder(t), root = folder(t)
  fs.writeFileSync(path.join(bin, 'tool.cmd'), '@echo off\r\necho hi')
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  t.after(() => { process.env.PATH = previous })
  const store = new ConnectorStore(path.join(root, 'data'))
  assert.throws(() => store.add({ name: 'bad', description: 'd', command: 'tool', args: ['a&b'] }, { scope: 'global' }), /not a standard npm shim/)
  assert.equal(store.list(root).length, 0, 'nothing was saved')
  const refused = await testConnector({ name: 'bad', stdio: { command: 'tool', args: ['a&b'], env: {} } })
  assert.equal(refused.ok, false); assert.match(refused.error, /not a standard npm shim/)
  assert.deepEqual(connectors.claudeServers([{ name: 'bad', stdio: { command: 'tool', args: ['a&b'], env: {} } }]), {})
  assert.deepEqual(connectors.codexConnectorArgs([{ name: 'bad', stdio: { command: 'tool', args: ['a&b'], env: {} } }], JSON.stringify), [])
})

test('connector_test through a real temp npm shim: node runs the fixture server, arguments with & and quotes reach it unchanged', { skip: process.platform !== 'win32' }, async t => {
  const bin = folder(t)
  fs.copyFileSync(SERVER, path.join(bin, 'server.cjs'))
  fs.writeFileSync(path.join(bin, 'echo-srv.cmd'), npmShim('server.cjs'))
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  t.after(() => { process.env.PATH = previous })
  const launch = launchOf({ command: 'echo-srv', args: NASTY, env: {} })
  assert.deepEqual(launch.args, [path.join(bin, 'server.cjs'), ...NASTY])
  const result = await testConnector({ name: 'shim', stdio: { command: 'echo-srv', args: NASTY, env: { FIXTURE_SECRET: SECRET } } })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.tools.map(tool => tool.name), ['echo', 'env_value'])
})

test('Claude gets the connectors next to Orbit in --mcp-config, still strict, and only Orbit in --allowedTools', () => {
  const launch = [stored(stdio()), stored(remote())]
  const session = { id: '11111111-1111-4111-8111-111111111111', resume: false, mcpUrl: 'http://127.0.0.1:1/mcp', token: 'tok', connectors: launch }
  const args = providers._testing.buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'never' }, session)
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1])
  assert.deepEqual(Object.keys(config.mcpServers), ['orbit', 'fx', 'web'])
  assert.deepEqual(config.mcpServers.fx, { type: 'stdio', command: process.execPath, args: [SERVER], env: { FIXTURE_SECRET: SECRET } })
  assert.deepEqual(config.mcpServers.web, { type: 'http', url: 'https://example.com/mcp?key=urlsecret', headers: { Authorization: `Bearer ${SECRET}` } })
  assert.ok(args.includes('--strict-mcp-config'))
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__orbit__*')
  const bare = providers._testing.buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'never' }, { ...session, connectors: [] })
  assert.deepEqual(Object.keys(JSON.parse(bare[bare.indexOf('--mcp-config') + 1]).mcpServers), ['orbit'])
  const none = providers._testing.buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'never' }, { id: session.id, resume: false, mcpUrl: null, token: null })
  assert.ok(!none.includes('--mcp-config'), 'no Orbit server, no config')
})

test('Codex gets mcp_servers.<name> overrides for exec and the App Server alike', () => {
  const launch = [stored(stdio({ args: [SERVER, 'a "quoted" arg'] })), stored(remote())]
  const session = { id: null, resume: false, mcpUrl: 'http://127.0.0.1:1/mcp', token: 'tok', systemAppend: '', connectors: launch }
  const q = JSON.stringify
  const expected = [
    '-c', `mcp_servers.fx.command=${q(process.execPath)}`, '-c', `mcp_servers.fx.args=[${q(SERVER)}, ${q('a "quoted" arg')}]`, '-c', `mcp_servers.fx.env={ "FIXTURE_SECRET" = ${q(SECRET)} }`,
    '-c', 'mcp_servers.web.url="https://example.com/mcp?key=urlsecret"', '-c', `mcp_servers.web.http_headers={ "Authorization" = ${q(`Bearer ${SECRET}`)} }`,
  ]
  const exec = providers._testing.buildCodexSessionArgs({ workspace: '.', accessMode: 'danger-full-access', approvalPolicy: 'never' }, session)
  const at = exec.indexOf('mcp_servers.fx.command=' + q(process.execPath)) - 1
  assert.deepEqual(exec.slice(at, at + expected.length), expected)
  assert.ok(exec.some(arg => arg.startsWith('mcp_servers.orbit.url=')))
  assert.deepEqual(providers.codexMcpArgs(session).slice(-expected.length), expected, 'the App Server uses the same overrides')
  assert.ok(!providers.codexMcpArgs({ ...session, connectors: [] }).some(arg => arg.startsWith('mcp_servers.fx')))
  assert.deepEqual(providers.codexMcpArgs({ mcpUrl: null, token: null, connectors: launch }), [], 'nothing without Orbit\'s own server')
})

test('Cursor and Antigravity plugin files carry the connectors next to Orbit', t => {
  const launch = [stored(stdio()), stored(remote())]
  const cursor = subscriptions.writeCursorPlugin('http://127.0.0.1:1/mcp', launch)
  t.after(() => fs.rmSync(cursor, { recursive: true, force: true }))
  const mcp = JSON.parse(fs.readFileSync(path.join(cursor, 'mcp.json'), 'utf8')).mcpServers
  assert.deepEqual(Object.keys(mcp), ['orbit', 'fx', 'web'])
  assert.equal(mcp.orbit.headers.Authorization, 'Bearer ${env:ORBIT_MCP_TOKEN}', 'Orbit\'s token still travels by variable')
  assert.deepEqual(mcp.fx, { command: process.execPath, args: [SERVER], env: { FIXTURE_SECRET: SECRET } })
  assert.deepEqual(mcp.web, { url: 'https://example.com/mcp?key=urlsecret', headers: { Authorization: `Bearer ${SECRET}` } })
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(subscriptions.writeCursorPlugin('http://x/mcp'), 'mcp.json'), 'utf8')).mcpServers), ['orbit'])
  const agy = folder(t)
  subscriptions.writeAntigravityPlugin(agy, { mcpUrl: 'http://127.0.0.1:1/mcp', token: 'tok', systemAppend: 'BLOCK', connectors: launch }, 'C:\\ws')
  const plugin = path.join(agy, '.agents', 'plugins', 'orbit')
  const servers = JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')).mcpServers
  assert.deepEqual(Object.keys(servers), ['orbit', 'fx', 'web'])
  assert.deepEqual(servers.fx, { command: process.execPath, args: [SERVER], env: { FIXTURE_SECRET: SECRET } })
  assert.deepEqual(servers.web, { serverUrl: 'https://example.com/mcp?key=urlsecret', headers: { Authorization: `Bearer ${SECRET}` } })
  assert.match(fs.readFileSync(path.join(plugin, 'rules', 'AGENTS.md'), 'utf8'), /connectors' tools \(fx, web\) .* "orbit_<connector name>"/)
  subscriptions.writeAntigravityPlugin(agy, { mcpUrl: 'http://127.0.0.1:1/mcp', token: 'tok', systemAppend: '' }, 'C:\\ws')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(plugin, 'mcp_config.json'), 'utf8')).mcpServers), ['orbit'], 'a turn without connectors rewrites the file without them')
})

test('normalizeSession keeps well-formed connectors only', () => {
  const kept = providers._testing.normalizeSession('claude', { mcpUrl: 'http://x/mcp', token: 't', connectors: [stored(stdio()), null, { name: 'x' }] })
  assert.deepEqual(kept.connectors.map(item => item.name), ['fx'])
  assert.deepEqual(providers._testing.normalizeSession('claude', { mcpUrl: 'http://x/mcp', token: 't' }).connectors, [])
})

test('the stable system block names the connectors in one line, and says nothing without them', () => {
  const run = { projectId: 'p', workspace: 'C:\\ws', accessMode: 'danger-full-access', approvalPolicy: 'never' }
  const agent = { id: 'root', name: 'Orbit', parentId: null, depth: 0 }
  const plain = sessionGuide(run, agent), withOne = sessionGuide(run, agent, [{ name: 'github', description: 'Issues and pull requests' }, { name: 'db', description: 'The SQLite database' }])
  assert.ok(!/CONNECTORS/.test(plain))
  const line = withOne.split('\n').find(row => row.startsWith('CONNECTORS'))
  assert.match(line, /github — Issues and pull requests; db — The SQLite database/)
  assert.match(line, /mcp__<name>__\*/)
  assert.equal(withOne.replace(`${line}\n`, ''), plain)
})

test('connector_test: tool names from a stdio server, paging, the exact failure with secrets masked, a hang, a missing command', async () => {
  const ok = await testConnector(stored(stdio()))
  assert.equal(ok.ok, true, ok.error); assert.equal(ok.transport, 'stdio'); assert.equal(ok.server, 'fixture-echo 1.0.0')
  assert.deepEqual(ok.tools.map(tool => tool.name), ['echo', 'env_value'])
  assert.equal(ok.tools[0].description, 'Echoes its text argument back.')
  const noisy = await testConnector(stored(stdio({ env: [`FIXTURE_SECRET=${SECRET}`, 'FIXTURE_LOG=1', 'FIXTURE_PAGES=1'] })))
  assert.deepEqual(noisy.tools.map(tool => tool.name), ['echo', 'env_value'], 'log lines on stdout are ignored and pages are followed')
  const failed = await testConnector(stored(stdio({ env: [`FIXTURE_SECRET=${SECRET}`, 'FIXTURE_FAIL=1'] })))
  assert.equal(failed.ok, false)
  assert.match(failed.error, /process ended \(exit 3\) before answering/)
  assert.match(failed.error, /stderr: cannot start: token \*\*\* was rejected/)
  assert.ok(!failed.error.includes(SECRET))
  const hung = await testConnector(stored(stdio({ env: ['FIXTURE_SILENT=1'] })), { timeoutMs: 600 })
  assert.equal(hung.ok, false); assert.match(hung.error, /no answer within 1 s/)
  const missing = await testConnector(stored(stdio({ command: path.join(os.tmpdir(), 'orbit-no-such-command-xyz') })))
  assert.equal(missing.ok, false); assert.match(missing.error, /could not start/)
})

test('connector_test over HTTP: a JSON answer, an event-stream answer and an HTTP error with the header masked', async t => {
  const seen = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk }).on('end', () => {
      const message = JSON.parse(body)
      seen.push({ method: message.method, authorization: request.headers.authorization, session: request.headers['mcp-session-id'] })
      if (request.url.startsWith('/denied')) { response.writeHead(401, { 'content-type': 'text/plain' }); return response.end(`bad credentials ${request.headers.authorization}`) }
      if (message.id === undefined) { response.writeHead(202); return response.end() }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'remote', version: '2' } } : { tools: [{ name: 'search' }] }
      if (request.url.startsWith('/sse')) { response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'S1' }); return response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`) }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  for (const route of ['/json', '/sse']) {
    seen.length = 0
    const result = await testConnector(stored(remote({ url: `${base}${route}` })))
    assert.equal(result.ok, true, result.error); assert.equal(result.transport, 'http'); assert.equal(result.server, 'remote 2')
    assert.deepEqual(result.tools.map(tool => tool.name), ['search'])
    assert.deepEqual(seen.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list'])
    assert.ok(seen.every(item => item.authorization === `Bearer ${SECRET}`), 'the header is sent')
    assert.equal(seen[2].session, 'S1', 'the session id is carried on')
  }
  const denied = await testConnector(stored(remote({ url: `${base}/denied` })))
  assert.equal(denied.ok, false); assert.match(denied.error, /HTTP 401/)
  assert.ok(!denied.error.includes(SECRET), denied.error)
})

test('a run with full access launches its provider with the connectors; a restricted run gets none, and the tools follow the same rule', async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const store = new ConnectorStore(path.join(root, 'data'))
  store.add(stdio({ name: 'globalfx', description: 'Global fixture' }), { scope: 'global' })
  const seen = []
  const run = async (accessMode, drive) => {
    const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', connectorStore: store, runProvider: async options => {
      seen.push({ accessMode, session: options.session, who: agentOf(options)[1] })
      return { text: await drive?.(runtime, options) ?? 'done' }
    } })
    const { snapshot, runId } = await finished(runtime, payload(workspace, { accessMode, approvalPolicy: 'never' }), 20000)
    assert.equal(snapshot.status, 'completed', snapshot.error)
    return { runtime, snapshot, run: runtime.runs.get(runId) }
  }
  await run('workspace-write')
  assert.deepEqual(seen.at(-1).session.connectors, [], 'workspace-write: none')
  assert.ok(!/CONNECTORS/.test(seen.at(-1).session.systemAppend))
  await run('read-only')
  assert.deepEqual(seen.at(-1).session.connectors, [], 'read-only: none')

  let added, listed, tested, refused, restricted, removed, off
  const { run: record } = await run('danger-full-access', async (runtime, options) => {
    const token = options.session.token
    if (!options.session.resume && seen.filter(item => item.accessMode === 'danger-full-access').length === 1) {
      assert.deepEqual(options.session.connectors.map(item => [item.name, item.scope]), [['globalfx', 'global']], 'full access: the global connector')
      assert.match(options.session.systemAppend, /CONNECTORS .*globalfx — Global fixture/)
      added = await runtime.dispatchMcp(token, 'connector_add', { name: 'projfx', description: 'Project fixture', command: process.execPath, args: [SERVER], env: [`FIXTURE_SECRET=${SECRET}`] })
      listed = await runtime.dispatchMcp(token, 'connector_list', {})
      tested = await runtime.dispatchMcp(token, 'connector_test', { name: 'projfx' })
      refused = await runtime.dispatchMcp(token, 'connector_add', { name: 'orbit', description: 'x', command: 'node' })
      removed = await runtime.dispatchMcp(token, 'connector_remove', { name: 'nosuch' })
      off = await runtime.dispatchMcp(token, 'connector_add', { name: 'offfx', description: 'Off fixture', command: process.execPath, args: [SERVER], enabled: false })
    }
    return 'done'
  })
  assert.equal(added.ok, true, added.error)
  const addedResult = JSON.parse(added.text)
  assert.equal(addedResult.name, 'projfx'); assert.equal(addedResult.scope, 'project'); assert.deepEqual(addedResult.envKeys, ['FIXTURE_SECRET'])
  assert.match(addedResult.note, /afterwards/)
  assert.deepEqual(JSON.parse(listed.text).connectors.map(item => item.name), ['projfx', 'globalfx'])
  assert.equal(JSON.parse(listed.text).passedToThisRun, true)
  const testResult = JSON.parse(tested.text)
  assert.equal(testResult.ok, true, tested.text); assert.deepEqual(testResult.tools.map(tool => tool.name), ['echo', 'env_value'])
  assert.equal(refused.ok, false); assert.match(refused.error, /reserved/)
  assert.equal(removed.ok, false); assert.match(removed.error, /No connector named "nosuch"/)
  for (const answer of [added, listed, tested]) assert.ok(!answer.text.includes(SECRET), 'no result carries the secret')
  const everything = JSON.stringify([record.traces, [...record.agentNodes.values()].map(agent => [agent.ledger, agent.transcript])])
  assert.ok(!everything.includes(SECRET), 'neither the traces, the work log nor the transcript carry the secret')
  assert.ok(record.traces.some(trace => trace.kind === 'tool' && /^connector_add .*"env":\["FIXTURE_SECRET=\*\*\*"\]/.test(trace.text)), 'the call is traced with the value masked')
  assert.ok(record.agentNodes.get('root').ledger.some(entry => /^#\d+ connector_add projfx → registered \(project stdio\)/.test(entry.text)))
  assert.ok(record.agentNodes.get('root').ledger.some(entry => /connector_test projfx → 2 tools: echo, env_value/.test(entry.text)))
  // A connector added with enabled false is registered switched off.
  assert.equal(off.ok, true, off.error)
  const offResult = JSON.parse(off.text)
  assert.equal(offResult.enabled, false); assert.match(offResult.note, /switched off/)
  // The next run of the project launches with both enabled connectors, the project's first; the switched-off one stays out.
  await run('danger-full-access')
  assert.deepEqual(seen.at(-1).session.connectors.map(item => item.name), ['projfx', 'globalfx'])
  store.remove('offfx', { scope: 'project', workspace })

  // A restricted run reads the list (and is told they do not reach it) but cannot add, test or remove.
  await run('workspace-write', async (runtime, options) => {
    if (options.session.resume) return 'done'
    listed = await runtime.dispatchMcp(options.session.token, 'connector_list', {})
    restricted = await runtime.dispatchMcp(options.session.token, 'connector_add', { name: 'sneaky', description: 'x', command: 'node' })
    tested = await runtime.dispatchMcp(options.session.token, 'connector_test', { name: 'projfx' })
    return 'done'
  })
  const restrictedList = JSON.parse(listed.text)
  assert.equal(restrictedList.passedToThisRun, false); assert.match(restrictedList.note, /workspace-write access: connectors reach only provider processes of runs with full access/)
  assert.equal(restricted.ok, false); assert.match(restricted.error, /needs full access/)
  assert.equal(tested.ok, false); assert.match(tested.error, /needs full access/)
  assert.deepEqual(store.list(workspace).map(item => item.name), ['projfx', 'globalfx'], 'nothing was added')
})
