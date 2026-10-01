// I22 live check without quota: a real `codex app-server` (Orbit's openCodexSession and runCodexSessionTurn) against
// fake-responses.cjs. Turn 1 starts a thread, turn 2 reuses the live process, turn 3 resumes the thread in a new process
// (thread/resume), turn 4 resumes it with a changed block. Prints the developer messages of every model request.
const { spawn } = require('node:child_process')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const codex = process.argv[2] || path.join(os.homedir(), '.vscode', 'extensions', 'openai.chatgpt-26.917.62051-win32-x64', 'bin', 'windows-x86_64', 'codex.exe')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i22-app-'))
const home = path.join(root, 'codex-home'); const workspace = path.join(root, 'ws'); const log = path.join(root, 'requests.jsonl')
fs.mkdirSync(home); fs.mkdirSync(workspace)
const SYSTEM = 'You are Orbit (I22 marker APP-MARK-51c2).\nQuotes "here", a backslash C:\\Users\\x, Кириллица.'
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
  const base = { workspace, accessMode: 'workspace-write', approvalPolicy: 'on-request', model: 'gpt-5.2', timeoutMs: 120000, onApproval: async () => false }
  const session = { id: null, resume: false, mcpUrl: null, token: null, systemAppend: SYSTEM, activity: null }
  const first = await codexServer.runCodexSessionTurn({ ...base, prompt: 'T1' }, session, helpers)
  console.log('turn 1:', first.sessionId, JSON.stringify(first.text))
  const second = await codexServer.runCodexSessionTurn({ ...base, prompt: 'T2' }, { ...session, id: first.sessionId, resume: true }, helpers)
  console.log('turn 2:', second.sessionId, JSON.stringify(second.text))
  await codexServer.closeSession(first.sessionId)
  const third = await codexServer.runCodexSessionTurn({ ...base, prompt: 'T3' }, { ...session, id: first.sessionId, resume: true }, helpers)
  console.log('turn 3 (new process, thread/resume):', third.sessionId, JSON.stringify(third.text))
  await codexServer.closeSession(first.sessionId)
  const fourth = await codexServer.runCodexSessionTurn({ ...base, prompt: 'T4' }, { ...session, systemAppend: 'BLOCK-B changed block', id: first.sessionId, resume: true }, helpers)
  console.log('turn 4 (thread/resume, changed block):', fourth.sessionId, JSON.stringify(fourth.text))
  await codexServer.closeAllSessions()
  server.kill()
  for (const request of fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))) {
    const input = request.body.input || []
    const describe = item => {
      if (item.role === 'developer') { const text = (item.content || []).map(part => part.text || '').join('\u0001'); return `dev[${text.includes(SYSTEM) ? 'EXACT-ORBIT-BLOCK' : text.includes('BLOCK-B') ? 'BLOCK-B' : '-'}]` }
      if (item.role === 'user') return `user[${(item.content || []).map(part => part.text || '').join('').slice(0, 12).replace(/\n/g, ' ')}]`
      return item.type === 'message' ? item.role : item.type
    }
    console.log(`${request.method} ${request.url}: ${input.map(describe).join(' ')}`)
  }
}
main().catch(error => { console.error(error); process.exit(1) })
