// Fixtures shared by the parts of tests/changes-e2e*.test.cjs: the whole path of a file change (an agent's tool → the
// runtime → the events, the snapshot and the saved run) with a real Git repository and a fake provider. Not a test file (the
// runner takes only *.test.cjs).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { OrbitRuntime } = require('../electron/runtime.mts')

function folder(t, prefix = 'orbit-e2e-') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }))
  return directory
}
const write = (workspace, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true })
  fs.writeFileSync(path.join(workspace, rel), text)
}
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
// A repository whose committed files have LF while the working copy has CRLF (core.autocrlf=true), as on this project's machine.
// The setting goes into the repository's own config, where `git config core.autocrlf true` would put it (the module under
// test reads that file), before anything is added; the file write saves a git process for every repository.
function repo(t, files) {
  const workspace = folder(t)
  try { git(workspace, 'init', '-q') } catch { t.skip('git is not available'); return null }
  fs.appendFileSync(path.join(workspace, '.git', 'config'), '[core]\n\tautocrlf = true\n')
  for (const [rel, text] of Object.entries(files)) write(workspace, rel, text)
  git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '-m', 'base')
  return workspace
}
const call = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const envelope = (...calls) => ({ text: JSON.stringify({ content: '', tool_calls: calls }) })
const waitFor = async (predicate, what) => {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const native = (tool, toolId, status, extra = {}) => ({ kind: 'tool', native: true, tool, toolId, status, text: tool, ...extra })

// Runs one root agent. `seen` is what was known the moment the terminal event arrived.
async function run(t, { workspace, provider, runStore, onEvent }) {
  const events = [], seen = {}
  const runtime = new OrbitRuntime({ runProvider: args => provider({ ...args, runtime, events }), runStore })
  let finished
  const done = new Promise(resolve => { finished = resolve })
  runtime.onEvent(event => {
    if (event.type === 'change.added') events.push(event.change)
    onEvent?.(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) { seen.changes = events.length; finished(event) }
  })
  const runId = await runtime.start({ providerId: 'test', prompt: 'Change files', projectId: 'p', chatId: 'c', accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(runId), 20000)
  t.after(() => clearTimeout(timer))
  const terminal = await done
  assert.equal(terminal.type, 'run.finished')
  return { runtime, runId, events, seen, snapshot: runtime.getRun(runId) }
}
const plain = list => list.map(change => ({ ...change, id: undefined, time: undefined }))

module.exports = { folder, write, git, repo, call, envelope, waitFor, native, run, plain }
