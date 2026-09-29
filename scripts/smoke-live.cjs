// Optional real inference smoke. Invoke explicitly: node scripts/smoke-live.cjs
// Uses the installed Codex login and default model; excluded from npm test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.cjs')
const { runProvider } = require('../electron/providers.cjs')
const { OrbitMemoryStore } = require('../electron/memory.cjs')
const { CapabilityStore } = require('../electron/capabilities.cjs')
const { RunStore } = require('../electron/run-store.cjs')

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-live-smoke-'))
  const workspace = path.join(temporary, 'workspace')
  const data = path.join(temporary, 'data')
  fs.mkdirSync(workspace)
  fs.mkdirSync(data)
  const events = []
  const nativeEvents = []
  const requestedModels = []
  const runStore = new RunStore(data)
  const runtime = new OrbitRuntime({
    memoryStore: new OrbitMemoryStore(data), capabilityStore: new CapabilityStore(data), runStore,
    runProvider: (options) => {
      requestedModels.push(options.model)
      return runProvider({ ...options, onEvent: (event) => { nativeEvents.push(event); options.onEvent?.(event) } })
    },
  })
  let runId
  let deadline
  let resolveFinished, rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  const unsubscribe = runtime.onEvent((event) => {
    events.push(event)
    if (event.type === 'run.finished') resolveFinished()
    if (event.type === 'run.failed' || event.type === 'run.cancelled') rejectFinished(new Error(event.error || event.type))
  })
  try {
    runId = await runtime.start({
      projectId: 'live-smoke', chatId: 'live-smoke-chat', workspace, providerId: 'codex',
      accessMode: 'read-only', approvalPolicy: 'never', memoryEnabled: true,
      prompt: 'Создай одного помощника для независимого вычисления 19×23. Попроси его прислать тебе ответ сообщением, дождись результата и ответь одной строкой по-русски. Файлы и команды не нужны.',
      limits: { maxAgents: 3, maxDepth: 2, maxConcurrent: 2, maxTurns: 4, maxTotalTurns: 6, runTimeoutMs: 150000, timeoutMs: 90000 },
    })
    await Promise.race([finished, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Live smoke exceeded 155 seconds')), 155000) })])
    const snapshot = runtime.getRun(runId)
    assert.equal(snapshot.status, 'completed')
    assert.equal(snapshot.agents.length, 2, 'Expected one actual Orbit child plus the root')
    assert.ok(snapshot.agents.every((agent) => agent.status === 'done'), 'Both agents must finish')
    assert.match(snapshot.summary.text, /\b437\b/)
    assert.equal(snapshot.summary.text.trim().split(/\r?\n/).length, 1)
    assert.ok(snapshot.traces.some((trace) => trace.kind === 'tool' && trace.text.startsWith('spawn_agent ')), 'Must invoke actual Orbit spawn_agent')
    assert.ok(snapshot.communications.some(message => message.toAgentId === 'root' && /437/.test(message.text)), 'A real child must message its parent')
    assert.equal(events.filter((event) => event.type === 'agent.created').length, 2)
    assert.equal(nativeEvents.filter((event) => event.kind === 'tool').length, 0, 'No native CLI tools or subagents allowed for this smoke')
    assert.ok(requestedModels.every((model) => !model), 'Use the user CLI default on every turn')
    assert.deepEqual(fs.readdirSync(workspace), [], 'The project workspace must remain empty')
    runStore.flush()
    const restored = new RunStore(data).get(runId)
    assert.equal(restored.status, 'completed')
    assert.equal(restored.agents.length, 2)
    assert.equal(restored.traces.length, snapshot.traces.length)
    console.log(JSON.stringify({
      ok: true, final: snapshot.summary.text, elapsedMs: Date.parse(snapshot.finishedAt) - Date.parse(snapshot.startedAt),
      agents: snapshot.agents.map(({ id, parentId, name, status, turns, result }) => ({ id, parentId, name, status, turns, result })),
      providerTurns: snapshot.usage.providerTurns, usage: snapshot.usage, events: events.length,
      savedTraces: restored.traces.length, nativeTools: 0, requestedModel: 'user CLI default',
    }, null, 2))
  } catch (error) {
    const snapshot = runId && runtime.getRun(runId)
    console.error(JSON.stringify({ ok: false, error: error.message, status: snapshot?.status,
      agents: snapshot?.agents.map(({ id, status, turns, error, result }) => ({ id, status, turns, error, result })),
      final: snapshot?.summary?.text, recentTraces: snapshot?.traces.slice(-10),
    }, null, 2))
    throw error
  } finally {
    clearTimeout(deadline)
    if (runId) {
      runtime.stop(runId)
      const run = runtime.runs.get(runId)
      if (run) await Promise.allSettled([...run.tasks.values()])
    }
    unsubscribe()
    runStore.flush()
    const resolved = path.resolve(temporary)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('orbit-live-smoke-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

main().catch(() => { process.exitCode = 1 })
