// Shared by tests/runtime.test.cjs and tests/runtime-agents.test.cjs (one file of 55 tests took 4.5 s on its own), and the
// OrbitRuntime that the steer-messages, turn-progress and turn-watchdog tests build.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime: Runtime } = require('../electron/runtime.mts')
const { ProjectIndex } = require('../electron/project-index.mts')

// The home folder has a .git here, so every mkdtemp workspace counts as inside a repo and each run's index scan spawned
// `git ls-files` (~30 ms); a lister that answers null, as a folder outside any repo gets, walks the folder instead.
class OrbitRuntime extends Runtime {
  constructor(options = {}) {
    super({ ...options, projectIndex: options.projectIndex === undefined ? new ProjectIndex({ clock: options.clock, lister: async () => null }) : options.projectIndex })
  }
}

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-test-'))
  // Only this fixture's securely generated temporary directory is removed.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = (prompt) => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
async function finished(runtime, payload) {
  const events = []
  let resolve
  const terminal = new Promise((done) => { resolve = done })
  const unsub = runtime.onEvent((event) => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 5000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'Runtime must complete without deadlock')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Current task', ...extra })
const dialogue = snapshot => snapshot.communications.filter(message => !message.kind || message.kind === 'message')

module.exports = { OrbitRuntime, folder, tool, response, identity, finished, payload, dialogue }
