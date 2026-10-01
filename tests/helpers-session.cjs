const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Fixtures shared by tests/session-mode*.test.cjs (one process each, so every file builds its own state).
// The session transport is driven here with a fake provider that records the `session` options it is given and plays
// the model: it makes Orbit tool calls the way the MCP server would, through runtime.dispatchMcp, in the middle of a
// "turn", then returns its answer text. A fake MCP server issues and revokes tokens. No CLI is ever started.

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function fakeMcp() {
  const issued = [], revoked = []
  return {
    issued, revoked, started: 0, url: 'http://127.0.0.1:65500/mcp',
    async start() { this.started++ },
    issueToken({ runId, agentId }) { const token = `token-${agentId}-${issued.length}`; issued.push({ token, runId, agentId }); return token },
    revoke(token) { revoked.push(token) },
    stop() {},
  }
}
async function finished(runtime, payload, wait = 5000) {
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, wait)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete without deadlock')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'claude', prompt: 'Current task', ...extra })
// Which agent a session turn belongs to: the identity is in the stable system block, not in the user prompt.
const agentOf = options => options.session.systemAppend.match(/running as agent "([^"]+)" \(id=([^;]+); parent=([^;]+); depth=(\d+)\)/)
const session = (extra = {}) => ({ mcp: fakeMcp(), transportFor: () => 'session', ...extra })

// ---- Calls of a provider with an MCP call limit (Cursor), parked and collected ------------------------------------
function callLimit(t, ms) {
  const previous = process.env.ORBIT_MCP_CALL_LIMIT_MS
  process.env.ORBIT_MCP_CALL_LIMIT_MS = String(ms)
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_MCP_CALL_LIMIT_MS; else process.env.ORBIT_MCP_CALL_LIMIT_MS = previous })
}
async function until(check, ms = 5000) {
  const started = Date.now()
  while (!check()) { if (Date.now() - started > ms) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
const cursorFull = { providerId: 'cursor', accessMode: 'danger-full-access', approvalPolicy: 'never' }
const commandAnswer = (runtime, token, args) => runtime.dispatchMcp(token, 'run_command', args).then(answer => JSON.parse(answer.text))

module.exports = { folder, fakeMcp, finished, payload, agentOf, session, callLimit, until, cursorFull, commandAnswer }
