// I22 review fix, live: a real `codex app-server` gets a block and a prompt cut inside an emoji (a lone surrogate).
// Before the fix Codex dropped the JSON-RPC line and never answered; now the turn completes and the model request
// carries U+FFFD in its place. Quota-free: fake-responses.cjs stands in for the model.
const { spawn } = require('node:child_process')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const codex = process.argv[2] || path.join(os.homedir(), '.vscode', 'extensions', 'openai.chatgpt-26.917.62051-win32-x64', 'bin', 'windows-x86_64', 'codex.exe')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i22-sur-'))
const home = path.join(root, 'codex-home'); const workspace = path.join(root, 'ws'); const log = path.join(root, 'requests.jsonl')
fs.mkdirSync(home); fs.mkdirSync(workspace)
async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'fake-responses.cjs')], { env: { ...process.env, LOG: log }, stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise(resolve => server.stdout.once('data', chunk => resolve(String(chunk).trim())))
  const providers = require(path.join(__dirname, '..', '..', 'electron', 'providers.mts'))
  const codexServer = require(path.join(__dirname, '..', '..', 'electron', 'codex-server.mts'))
  const overrides = ['-c', 'model_provider="fake"', '-c', `model_providers.fake={ name = "fake", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`]
  const helpers = {
    resolveLaunch: (_command, args) => { const launch = providers.resolveLaunch(codex, [...args, ...overrides]); return { ...launch, env: { ...launch.env, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } } },
    terminateProcess: providers.terminateProcess, createLineReader: providers.createLineReader,
  }
  const started = Date.now()
  try {
    const result = await codexServer.runCodexSessionTurn({ workspace, accessMode: 'workspace-write', approvalPolicy: 'on-request', model: 'gpt-5.2', timeoutMs: 60000, prompt: 'cut \ud83d', onApproval: async () => false }, { id: null, resume: false, mcpUrl: null, token: null, systemAppend: 'name \ud83d end', activity: null }, helpers)
    console.log(`answered in ${Date.now() - started} ms: ${JSON.stringify(result.text)}`)
  } catch (error) { console.log(`failed after ${Date.now() - started} ms: ${error.name}: ${error.message}`) }
  await codexServer.closeAllSessions()
  server.kill()
  for (const request of (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).filter(Boolean).map(line => JSON.parse(line))) {
    const input = request.body.input || []
    const developer = input.filter(item => item.role === 'developer').map(item => (item.content || []).map(part => part.text || '').join('')).join('')
    const user = input.filter(item => item.role === 'user').map(item => (item.content || []).map(part => part.text || '').join('')).at(-1)
    console.log(`developer has "name \\ufffd end": ${developer.includes('name � end')}; last user text: ${JSON.stringify(user)}`)
  }
}
main().catch(error => { console.error(error); process.exit(1) })
