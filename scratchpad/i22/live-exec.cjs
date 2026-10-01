// I22 live check without quota: a real Codex CLI (exec, new thread and resume) against fake-responses.cjs, with Orbit's
// own argument builder. Shows where the developer instructions land in each request the model would get.
// Usage: node --experimental-strip-types scratchpad/i22/live-exec.cjs [codex.exe]
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const codex = process.argv[2] || path.join(os.homedir(), '.vscode', 'extensions', 'openai.chatgpt-26.917.62051-win32-x64', 'bin', 'windows-x86_64', 'codex.exe')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i22-live-'))
const home = path.join(root, 'codex-home'); const workspace = path.join(root, 'ws'); const log = path.join(root, 'requests.jsonl')
fs.mkdirSync(home); fs.mkdirSync(workspace)
const SYSTEM = 'You are Orbit (I22 marker DEV-MARK-7f3a).\nQuotes "here", a backslash C:\\Users\\x, Кириллица, tab\tend.\nWhen you finish, reply with the final answer.'

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'fake-responses.cjs')], { env: { ...process.env, LOG: log }, stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise(resolve => server.stdout.once('data', chunk => resolve(String(chunk).trim())))
  const { _testing } = require(path.join(__dirname, '..', '..', 'electron', 'providers.mts'))
  const provider = ['-c', 'model_provider="fake"', '-c', `model_providers.fake={ name = "fake", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`]
  const env = { ...process.env, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  const run = (session, prompt) => {
    const args = _testing.buildCodexSessionArgs({ workspace, accessMode: 'read-only', model: 'gpt-5.2' }, { mcpUrl: null, token: null, systemAppend: SYSTEM, ...session })
    // The provider overrides go before the trailing '-' (and the resumed thread id).
    const tail = session.resume ? 2 : 1
    const full = [...args.slice(0, -tail), ...provider, ...args.slice(-tail)]
    const result = spawnSync(codex, full, { cwd: workspace, env, input: prompt, encoding: 'utf8', timeout: 120000 })
    const thread = (result.stdout || '').split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(event => event?.type === 'thread.started')?.thread_id
    console.log(`exit ${result.status}; thread ${thread}; stderr tail: ${(result.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
    return thread
  }
  const thread = run({ id: null, resume: false }, 'first prompt')
  if (thread) run({ id: thread, resume: true }, 'second prompt')
  server.kill()
  const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  requests.forEach((request, index) => {
    const body = request.body || {}
    const input = Array.isArray(body.input) ? body.input : []
    const marked = input.filter(item => JSON.stringify(item).includes('DEV-MARK-7f3a'))
    console.log(`request ${index + 1}: ${request.method} ${request.url}; instructions has marker: ${String(body.instructions || '').includes('DEV-MARK-7f3a')}; input items ${input.length}, with the marker ${marked.length} (roles ${marked.map(item => item.role).join(',')})`)
    for (const item of marked) {
      const text = (item.content || []).map(part => part.text || '').join('')
      const start = text.indexOf('You are Orbit')
      console.log(`  exact block kept: ${text.includes(SYSTEM)}; excerpt: ${JSON.stringify(text.slice(Math.max(0, start), start + 160))}`)
    }
    console.log(`  user texts: ${JSON.stringify(input.filter(item => item.role === 'user').map(item => (item.content || []).map(part => part.text || '').join('').slice(0, 60)))}`)
  })
  console.log(`root: ${root}`)
}
main().catch(error => { console.error(error); process.exit(1) })
