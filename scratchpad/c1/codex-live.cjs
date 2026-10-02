// The real codex parses the overrides Orbit's own code builds for connectors (config view, no model call).
// Run: node --experimental-strip-types --disable-warning=ExperimentalWarning scratchpad/c1/codex-live.cjs
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const providers = require('../../electron/providers.mts')
const { normalizeConnector } = require('../../electron/connectors.mts')
const exe = 'C:\\Users\\Roman Andreevich\\.vscode\\extensions\\openai.chatgpt-26.917.62051-win32-x64\\bin\\windows-x86_64\\codex.exe'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-conn-'))
const fx = { ...normalizeConnector({ name: 'fx', description: 'd', command: process.execPath, args: [path.resolve('tests/fixtures/echo-mcp-server.cjs'), 'a "q" b'], env: ['FIXTURE_SECRET=s3 cr"et\\x'] }, 'now'), scope: 'project' }
const web = { ...normalizeConnector({ name: 'web-1', description: 'd', url: 'https://example.com/mcp?key=a b', headers: ['Authorization: Bearer zz', 'X-Two: 2'] }, 'now'), scope: 'global' }
const args = providers.codexMcpArgs({ mcpUrl: 'http://127.0.0.1:1/mcp', token: 't', connectors: [fx, web] })
console.log(args.join('\n'))
for (const name of ['orbit', 'fx', 'web-1']) {
  const r = spawnSync(exe, [...args, 'mcp', 'get', name, '--json'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' })
  console.log(`--- ${name} exit ${r.status}\n${r.stdout}${r.stderr}`)
}
fs.rmSync(home, { recursive: true, force: true })
