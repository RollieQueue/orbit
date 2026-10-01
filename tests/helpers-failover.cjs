const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { normalizeFailover } = require('../electron/failover.mts')

// Fixtures shared by tests/failover*.test.cjs.
const w = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })
const CATALOG = [
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5'], reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'gpt-5.5': ['low', 'medium', 'high', 'xhigh'] } },
  { id: 'claude', available: true, models: ['sonnet', 'opus', 'haiku'] },
  { id: 'antigravity', available: true, models: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking'] },
  { id: 'cursor', available: true, models: ['auto', 'composer-2.5', 'claude-opus-5-5-high'] },
  { id: 'ollama', available: true, models: ['llama3'] },
]
const labels = list => list.map(item => `${item.providerId}/${item.model}`)
const fakeQuota = snapshots => ({ peek: id => snapshots[id] ? { providerId: id, ...snapshots[id] } : null })
const agentOf = (extra = {}) => ({ id: 'root', name: 'Orbit', providerId: 'codex', model: 'gpt-6-sol', requestedModel: 'gpt-6-sol', reasoningEffort: 'high', failedCandidates: new Set(), turns: 3, files: { read: [], wrote: [] }, ...extra })
const config = (extra = {}) => normalizeFailover(extra)

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-failover-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
async function finished(runtime, payload) {
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'codex', model: 'gpt-6-sol', prompt: 'Current task', ...extra })
function world(t, usage = {}, catalog = CATALOG) {
  const original = { ...quota.readers }
  const windows = { ...usage }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: windows[id] || [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const monitor = new quota.QuotaMonitor()
  return { monitor, windows, runtime: run => new OrbitRuntime({ runProvider: run, quota: monitor, catalog: async () => catalog }) }
}
const USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 22 minutes."

module.exports = { w, CATALOG, labels, fakeQuota, agentOf, config, folder, tool, response, identity, finished, payload, world, USAGE_LIMIT }
