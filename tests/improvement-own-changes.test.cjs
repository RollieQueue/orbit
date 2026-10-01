const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const resume = require('../electron/resume.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')

function folder(t, prefix = 'orbit-own-changes-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return directory
}
const calls = (...items) => ({ tool_calls: items.map(([name, args = {}]) => ({ name, arguments: args })) })
const task = (id, status) => ({ id, title: `Task ${id}`, status, evidence: status === 'done' ? `evidence ${id}` : '' })

test('code another chat changed before the run started is not the run\'s to apply; what changes after it is', t => {
  const { fingerprints, rendererHash } = require('../electron/fingerprint.cjs')
  // What the restart host needs to find in a repository: the script and a .git folder.
  const repo = folder(t)
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text) }
  write('scripts/self-upgrade.cjs', "'use strict'\n"); fs.mkdirSync(path.join(repo, '.git'))
  write('electron/main.cjs', 'main\n'); write('electron/runtime/loops.mts', 'loops\n'); write('src/App.tsx', 'app\n'); write('package.json', '{}\n')
  // Main's report about this runtime process: it runs the code on disk now.
  const healthFile = path.join(repo, 'artifacts', 'self-upgrade-health.json')
  const code = fingerprints(repo)
  write('artifacts/self-upgrade-health.json', JSON.stringify({ ok: true, pid: 1, writtenAt: Date.now(), runtime: { pid: process.pid }, shellHash: code.shell, runtimeHash: code.runtime, rendererHash: rendererHash(repo) }))
  const host = resume.createRestartHost({ repoRoot: repo, userData: folder(t), healthFile })
  // Another chat changed the runtime and has not applied it; then this run starts.
  write('electron/runtime/loops.mts', 'loops, another chat\n')
  const atStart = host.codeOnDisk()
  assert.deepEqual(Object.keys(atStart).sort(), ['renderer', 'runtime', 'shell'])
  assert.deepEqual(host.unapplied(), ['runtime'], 'without a baseline whatever changed it counts')
  assert.deepEqual(host.unapplied(atStart), [], 'unchanged since the run started: not this run\'s')
  // This run changes the interface: only that part is its to apply.
  write('src/App.tsx', 'app, this run\n')
  assert.deepEqual(host.unapplied(atStart), ['renderer'])
  // ...and the runtime as well (a shell command, say): now the runtime counts too.
  write('electron/runtime/loops.mts', 'loops, another chat and this run\n')
  assert.deepEqual(host.unapplied(atStart), ['runtime', 'renderer'])
  // Undone back to where the run started: nothing of this run's left to apply.
  write('electron/runtime/loops.mts', 'loops, another chat\n'); write('src/App.tsx', 'app\n')
  assert.deepEqual(host.unapplied(atStart), [])
  // A host that cannot take the fingerprints says so.
  assert.equal(resume.createRestartHost({ repoRoot: folder(t), userData: folder(t), healthFile }).codeOnDisk(), null, 'Orbit does not run from this folder')
})

test('an improvement run passes the code it started with: another chat\'s unapplied change asks for no restart', async t => {
  const workspace = folder(t)
  const baseline = { shell: 'shell-a', runtime: 'runtime-b', renderer: 'renderer-c' }
  const seen = [], requests = []
  // The runtime differs from what runs (another chat's edit), but not from what was on disk when the run started.
  const host = {
    requests, available: true, repoRoot: fs.realpathSync(workspace), userData: workspace, resumeFile: path.join(workspace, 'resume.json'), inFlight: () => null,
    request: async request => { requests.push(request); return { ok: true, level: 'runtime', status: 'ok' } },
    codeOnDisk: () => ({ ...baseline }),
    unapplied: given => { seen.push(given); return given ? [] : ['runtime'] },
  }
  let turn = 0
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async () => ++turn === 1
    ? calls(['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }])
    : { text: 'Done, nothing of mine to apply' } })
  const events = []
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { events.push(event); if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
  const id = await runtime.start({ providerId: 'test', prompt: 'Improve the project', improvementMode: true, accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(id), 5000)
  await done; clearTimeout(timer); off()
  const result = runtime.getRun(id)
  assert.equal(result.status, 'completed', result.error || 'run did not complete')
  assert.equal(result.usage.providerTurns, 2, 'no reminder to call restart_orbit')
  assert.equal(requests.length, 0)
  assert.ok(seen.length > 0 && seen.every(given => given && given.runtime === baseline.runtime), 'the check is made against the code at the run\'s start')
  assert.equal(result.summary.text, 'Done, nothing of mine to apply')
})

test('after a restart this chat deferred, the next run compares all of the code: the change it left still has to be applied', async t => {
  const workspace = folder(t)
  const baseline = { shell: 'shell-a', runtime: 'runtime-b', renderer: 'renderer-c' }
  const seen = [], requests = []
  // Run 1's restart is refused for the cycle limit (deferred); run 2's goes through.
  const host = {
    requests, available: true, repoRoot: fs.realpathSync(workspace), userData: workspace, resumeFile: path.join(workspace, 'resume.json'), inFlight: () => null,
    request: async request => { requests.push(request); return requests.length === 1 ? { ok: false, status: 'cycle-limit', exitCode: 3, output: '' } : { ok: true, level: 'renderer', status: 'ok' } },
    codeOnDisk: () => ({ ...baseline }),
    unapplied: given => { seen.push(given); return given ? [] : ['runtime'] },
  }
  let turn = 0, reminded = ''
  const runtime = new OrbitRuntime({ restartHost: host, runProvider: async ({ prompt }) => {
    switch (++turn) {
      // Run 1: closes t1 and tries to apply it: refused, deferred.
      case 1: return calls(['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done')] }], ['restart_orbit', { reason: 'apply t1', continueWith: 'confirm' }])
      case 2: return { text: 'Verified, not applied yet' }
      // Run 2: closes t2 (tests only, say); the change run 1 left is still unapplied, so it is reminded.
      case 3: return calls(['improvement_plan', { status: 'implementing', tasks: [task('t1', 'done'), task('t2', 'done')] }])
      case 4: return { text: 'Done' }
      case 5: reminded = prompt; return calls(['restart_orbit', { reason: 'apply t1 and t2', continueWith: 'confirm' }])
      default: return { text: 'Applied' }
    }
  } })
  const runOnce = async () => {
    let resolve
    const done = new Promise(r => { resolve = r })
    const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
    const id = await runtime.start({ providerId: 'test', prompt: 'Improve the project', improvementMode: true, accessMode: 'workspace-write', workspace, chatId: 'chat-deferred' })
    const timer = setTimeout(() => runtime.stop(id), 5000)
    await done; clearTimeout(timer); off()
    assert.equal(runtime.getRun(id).status, 'completed', runtime.getRun(id).error || 'run did not complete')
    return id
  }
  const first = await runOnce()
  assert.equal(runtime.runs.get(first).restartDeferred, true)
  assert.deepEqual(runtime.runs.get(first).codeAtStart, baseline, 'nothing deferred before it: run 1 takes the baseline')
  const second = await runOnce()
  assert.equal(runtime.runs.get(second).codeAtStart, null, 'after its own deferred restart the chat checks all of the code')
  assert.match(reminded, /Call restart_orbit now/)
  assert.equal(requests.length, 2)
  assert.equal(runtime.getRun(second).summary.text, 'Applied')
  // The flag survives in the saved snapshot, where the next run of the chat reads it.
  assert.equal(runtime.getRun(first).restartDeferred, true)
})
