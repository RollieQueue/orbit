'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRuntimeClient, nodeFork, killProcessTree, listProcessTable, orphansOf } = require('../electron/runtime-client.cjs')
const { until, writtenJson } = require('./helpers-runtime-client.cjs')

// The scenario of runtime-client-orphans.test.cjs, which has a fake runtime, with the real runtime child.

// The same with the real runtime: its provider (a fixture) starts the CLI inside a run, the runtime records it through
// Node's diagnostics channel with the time the spawn began (runtime-host.mts), and then the runtime process dies.
test('Windows: the real runtime records what it starts well enough for main to stop the orphans after it crashed', { skip: process.platform === 'win32' ? false : 'the process table is read on Windows only', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-reap-real-'))
  const profile = path.join(root, 'profile')
  const workspace = path.join(root, 'workspace')
  for (const folder of [profile, workspace]) fs.mkdirSync(folder)
  const cliFile = path.join(root, 'cli.json')
  const fixtures = path.join(root, 'cli-fixtures.cjs')
  fs.writeFileSync(fixtures, `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
exports.runProvider = async (options) => {
  const startedAt = Date.now()
  const cli = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve) => cli.once('spawn', resolve))
  fs.writeFileSync(${JSON.stringify(cliFile)}, JSON.stringify({ pid: cli.pid, startedAt }))
  await new Promise((resolve) => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }) })
  throw Object.assign(new Error('stopped'), { name: 'AbortError' })
}
// The runtime process dies the hard way when asked to: no shutdown, no clean-up of its own.
exports.inspectProviders = async (options) => { if (options && options.crash) setImmediate(() => process.exit(1)); return [] }
`)
  const logs = []
  const client = createRuntimeClient({
    userData: profile, repoRoot: path.join(__dirname, '..'), fork: nodeFork({ cwd: os.tmpdir() }), env: { ORBIT_RUNTIME_FIXTURES: fixtures },
    settings: { maxAutoRestarts: 0 }, log: (level, text) => logs.push(`${level}: ${text}`),
  })
  let reaped = false
  t.after(async () => {
    await client.kill()
    // A failed run leaves nothing either: the CLI's tree, found the same way (a run that has shown it gone has nothing to look for).
    const cli = writtenJson(cliFile)
    if (cli && !reaped) for (const pid of orphansOf([cli], (await listProcessTable()) ?? [], { exitedAt: Date.now() })) await killProcessTree(pid)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const childrenOf = async (cli) => ((await listProcessTable()) ?? []).filter(row => row.ppid === cli.pid && row.created !== null && row.created >= cli.startedAt - 100)

  await client.ready
  await client.call('runtime:start', [{
    projectId: 'project', chatId: 'chat', prompt: 'Run the CLI', history: [], workspace, memoryEnabled: false,
    providerId: 'custom', model: 'fixture-model', agentInstructions: '', accessMode: 'workspace-write', approvalPolicy: 'never', limits: {},
  }])
  await until(() => writtenJson(cliFile), 'the provider started its CLI', 30000)
  const cli = writtenJson(cliFile)
  let before = []
  for (const deadline = Date.now() + 20000; !before.length && Date.now() < deadline;) before = await childrenOf(cli)
  assert.ok(before.length > 0, 'the CLI has children of its own')

  await client.call('providers:health', [{ crash: true }]).catch(() => {})
  await until(() => client.status().state === 'stopped', 'the runtime is gone', 20000)
  let after = before
  for (const deadline = Date.now() + 30000; after.length && Date.now() < deadline;) after = await childrenOf(cli)
  assert.deepEqual(after, [], `nothing the CLI started outlives the runtime:\n${logs.join('\n')}`)
  reaped = true
  assert.ok(logs.some(line => /stopping \d+ process\(es\) the runtime \(pid \d+\) left behind/.test(line)), logs.join('\n'))
})
