// I22: what a resumed Codex exec thread does with developer instructions that differ from the first process's.
// A: start with block A, resume with block B. B: start without a block, resume with block A.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const codex = process.argv[2] || path.join(os.homedir(), '.vscode', 'extensions', 'openai.chatgpt-26.917.62051-win32-x64', 'bin', 'windows-x86_64', 'codex.exe')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i22-var-'))
const home = path.join(root, 'codex-home'); const workspace = path.join(root, 'ws'); const log = path.join(root, 'requests.jsonl')
fs.mkdirSync(home); fs.mkdirSync(workspace)
async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'fake-responses.cjs')], { env: { ...process.env, LOG: log }, stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise(resolve => server.stdout.once('data', chunk => resolve(String(chunk).trim())))
  const { _testing } = require(path.join(__dirname, '..', '..', 'electron', 'providers.mts'))
  const provider = ['-c', 'model_provider="fake"', '-c', `model_providers.fake={ name = "fake", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`]
  const env = { ...process.env, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  const run = (session, prompt) => {
    const args = _testing.buildCodexSessionArgs({ workspace, accessMode: 'read-only', model: 'gpt-5.2' }, { mcpUrl: null, token: null, ...session })
    const tail = session.resume ? 2 : 1
    const result = spawnSync(codex, [...args.slice(0, -tail), ...provider, ...args.slice(-tail)], { cwd: workspace, env, input: prompt, encoding: 'utf8', timeout: 120000 })
    return (result.stdout || '').split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(event => event?.type === 'thread.started')?.thread_id
  }
  const a = run({ id: null, resume: false, systemAppend: 'BLOCK-A first block' }, 'A1')
  run({ id: a, resume: true, systemAppend: 'BLOCK-B changed block' }, 'A2')
  run({ id: a, resume: true, systemAppend: '' }, 'A3')
  const b = run({ id: null, resume: false, systemAppend: '' }, 'B1')
  run({ id: b, resume: true, systemAppend: 'BLOCK-A late block' }, 'B2')
  server.kill()
  for (const request of fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))) {
    const input = request.body.input || []
    const describe = item => item.role === 'developer' ? `dev[${(item.content || []).map(part => (part.text || '').match(/BLOCK-[AB][a-z ]*/)?.[0]).filter(Boolean).join('+') || '-'}]` : item.role === 'user' ? `user[${(item.content || []).map(part => part.text || '').join('').slice(0, 12).replace(/\n/g, ' ')}]` : item.type === 'message' ? item.role : item.type
    console.log(input.map(describe).join(' '))
  }
}
main().catch(error => { console.error(error); process.exit(1) })
