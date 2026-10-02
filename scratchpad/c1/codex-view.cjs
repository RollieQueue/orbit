// Config view of the real codex: which -c overrides parse for an stdio and an http connector (no model call).
const { spawnSync } = require('node:child_process')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const exe = 'C:\\Users\\Roman Andreevich\\.vscode\\extensions\\openai.chatgpt-26.917.62051-win32-x64\\bin\\windows-x86_64\\codex.exe'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-conn-'))
const overrides = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : [
  '-c', 'mcp_servers.fx.command="node"', '-c', 'mcp_servers.fx.args=["a b","--x\\"y"]', '-c', 'mcp_servers.fx.env={ "TOK" = "s3 cret", "B" = "x" }',
  '-c', 'mcp_servers.web.url="http://127.0.0.1:9/mcp"', '-c', 'mcp_servers.web.http_headers={ "Authorization" = "Bearer zz", "X-A" = "1" }',
]
for (const name of ['fx', 'web']) {
  const r = spawnSync(exe, [...overrides, 'mcp', 'get', name, '--json'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' })
  console.log(`--- ${name} exit ${r.status}\n${r.stdout}${r.stderr}`)
}
fs.rmSync(home, { recursive: true, force: true })
