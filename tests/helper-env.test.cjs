const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')

// The environment a provider turn gets (turn.mts): a Claude helper runs without Claude Code's "say what you are doing"
// reminder, which only made it write status lines nobody reads; the root, whom the user reads, keeps it.
async function envs(t, providerId) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-helper-env-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const seen = {}
  let rootTurn = 0
  const runtime = new OrbitRuntime({ runProvider: async options => {
    // A helper's prompt carries the reason it was delegated; the root's carries the chat instead.
    const helper = options.prompt.includes('DELEGATION REASON')
    seen[helper ? 'helper' : 'root'] = options.extraEnv || {}
    if (helper) return { text: 'helper done' }
    return ++rootTurn === 1 ? { tool_calls: [{ name: 'spawn_agent', arguments: { task: 'Check one thing', reason: 'test' } }] } : { text: 'root done' }
  } })
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() })
  const id = await runtime.start({ providerId, prompt: 'Do the task', accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(id), 5000)
  await done; clearTimeout(timer); off()
  assert.equal(runtime.getRun(id).status, 'completed', runtime.getRun(id).error || 'run did not complete')
  return seen
}

test('a Claude helper runs without Claude Code\'s silent-turn reminder; the root and other providers keep their environment', async t => {
  const claude = await envs(t, 'claude')
  assert.equal(claude.helper.CLAUDE_CODE_SILENT_TURN_REMINDER, '0')
  assert.equal(claude.root.CLAUDE_CODE_SILENT_TURN_REMINDER, undefined, 'the user reads the root: it keeps the reminder')
  const other = await envs(t, 'test')
  assert.equal(other.helper.CLAUDE_CODE_SILENT_TURN_REMINDER, undefined, 'only Claude Code reads the variable')
})
