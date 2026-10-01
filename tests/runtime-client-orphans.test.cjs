'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRuntimeClient, nodeFork, killProcessTree, listProcessTable, orphansOf } = require('../electron/runtime-client.cjs')
const { PROTOCOL_VERSION } = require('../electron/runtime-protocol.mts')
const { until, writtenJson } = require('./helpers-runtime-client.cjs')

// The review's scenario: a runtime starts a native CLI (cmd.exe) that starts a grandchild (PING.EXE), and crashes. On
// Windows the CLI dies with the runtime (libuv's kill-on-close job), the grandchild does not, and taskkill /t cannot
// reach it through the dead CLI; the client finds it in the process table by its parent pid and creation time.
test('Windows: after a crash the orphaned grandchild of a CLI the runtime started is stopped (cmd.exe -> PING.EXE)', { skip: process.platform === 'win32' ? false : 'the process table is read on Windows only', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-reap-'))
  const entry = path.join(root, 'crashing-runtime.cjs')
  const cliFile = path.join(root, 'cli.json')
  fs.writeFileSync(entry, `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
process.send({ t: 'ready', pid: process.pid, ms: 1, protocol: ${PROTOCOL_VERSION} })
const startedAt = Date.now()
const cli = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' })
cli.once('spawn', () => {
  process.send({ t: 'processes', processes: [{ pid: cli.pid, startedAt }] })
  fs.writeFileSync(${JSON.stringify(cliFile)}, JSON.stringify({ pid: cli.pid, startedAt }))
})
process.on('message', (message) => { if (message && message.t === 'call' && message.channel === 'crash') process.exit(1) })
`)
  const logs = []
  const client = createRuntimeClient({
    userData: root, repoRoot: path.join(__dirname, '..'), entry, fork: nodeFork({ cwd: os.tmpdir() }),
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
  const imageName = (pid) => childProcess.execFileSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).split(',')[0].replace(/"/g, '').trim()

  await client.ready
  await until(() => writtenJson(cliFile), 'the CLI started', 20000)
  const cli = writtenJson(cliFile)
  let before = []
  for (const deadline = Date.now() + 20000; !before.some(row => imageName(row.pid) === 'PING.EXE') && Date.now() < deadline;) before = await childrenOf(cli)
  assert.ok(before.some(row => imageName(row.pid) === 'PING.EXE'), 'PING.EXE runs under the CLI')

  await assert.rejects(client.call('crash', []), /stopped unexpectedly/)
  let after = before
  for (const deadline = Date.now() + 30000; after.length && Date.now() < deadline;) after = await childrenOf(cli)
  assert.deepEqual(after, [], `nothing the CLI started outlives the runtime:\n${logs.join('\n')}`)
  assert.throws(() => process.kill(before[0].pid, 0), /ESRCH/)
  reaped = true
  assert.ok(logs.some(line => /stopping \d+ process\(es\) the runtime \(pid \d+\) left behind/.test(line)), logs.join('\n'))
})
