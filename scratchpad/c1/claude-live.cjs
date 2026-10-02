// One real `claude --print` turn launched with the arguments Orbit's own builder produces for a full-access run with the
// fixture connector: does its tool appear in the init tools list, and may the model call it (bypassPermissions)?
// Run: node --experimental-strip-types --disable-warning=ExperimentalWarning scratchpad/c1/claude-live.cjs
const { spawn } = require('node:child_process')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto')
const providers = require('../../electron/providers.mts')
const { normalizeConnector } = require('../../electron/connectors.mts')
const exe = path.join(os.homedir(), '.local', 'bin', 'claude.exe')
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-claude-live-'))
const fx = { ...normalizeConnector({ name: 'fx', description: 'Fixture echo server', command: process.execPath, args: [path.resolve('tests/fixtures/echo-mcp-server.cjs')], env: ['FIXTURE_SECRET=live-secret-42'] }, 'now'), scope: 'project' }
const session = { id: randomUUID(), resume: false, mcpUrl: 'http://127.0.0.1:9/mcp', token: 'unused', connectors: [fx] }
const args = providers._testing.buildClaudeSessionArgs({ accessMode: process.argv[2] || 'danger-full-access', approvalPolicy: process.argv[3] || 'never', model: 'haiku' }, session)
console.log(args.filter(arg => !arg.startsWith('{')).join(' '))
const child = spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = '', calls = [], result = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
    let event; try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'system' && event.subtype === 'init') console.log('INIT mcp_servers:', JSON.stringify(event.mcp_servers), '\nINIT mcp tools:', JSON.stringify((event.tools || []).filter(name => name.startsWith('mcp__'))), '\nINIT permissionMode:', event.permissionMode)
    if (event.type === 'assistant') for (const block of event.message?.content || []) if (block.type === 'tool_use') calls.push(`${block.name} ${JSON.stringify(block.input)}`)
    if (event.type === 'user') for (const block of event.message?.content || []) if (block.type === 'tool_result') console.log('TOOL RESULT:', JSON.stringify(block.content).slice(0, 200), block.is_error ? '(error)' : '')
    if (event.type === 'result') result = String(event.result)
  }
})
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.stdin.end('Call the tool mcp__fx__echo with the text "ping-from-orbit" and reply with exactly what it returned. If the tool is not available, reply with NOT AVAILABLE.')
child.on('close', code => { console.log('CALLS:', calls, '\nRESULT:', result, '\nexit', code); fs.rmSync(cwd, { recursive: true, force: true }) })
setTimeout(() => { console.log('timeout'); child.kill() }, 120000)
