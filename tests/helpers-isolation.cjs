// Fixtures of the tests that drive spawn_agent {isolation} through the runtime (tests/isolation-runtime*.test.cjs): the
// repositories and folders of helpers-worktree.cjs, the fake provider's envelopes, and the waits for a run and for its
// copies to go. Not a test file (the runner takes only *.test.cjs); the parts of the split test file share it.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = require('./helpers-worktree.cjs')

const { git } = base
const folder = (t, label) => base.folder(t, label, 'orbit-isolation')
const repo = (t, files = { 'a.txt': 'l1\nl2\nl3\n' }) => base.initRepo(folder(t, 'repo'), files)
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
let chats = 0
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: `chat-${++chats}`, providerId: 'test', prompt: 'Current task', accessMode: 'workspace-write', ...extra })
async function finished(runtime, start) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsubscribe = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(start)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 30000)
  const event = await terminal
  clearTimeout(timer); unsubscribe()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return { snapshot: runtime.getRun(runId), runId }
}
// Polls often (the check is a directory listing or a look at the run's traces): a run's copies are taken away right after
// it ends, and a coarse poll would add its own interval to every test that waits for that.
async function until(check, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting for the copies to be cleaned up')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8')
const present = (...parts) => fs.existsSync(path.join(...parts))

module.exports = { git, folder, repo, tool, response, identity, payload, finished, until, read, present }
