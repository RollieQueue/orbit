// Explicit live check of the session transport with the user's real Claude Code login and model quota.
// It runs two tiny tasks on a cheap model: (1) a restricted-access agent must create a file through Orbit's
// write_file MCP tool (no native writes), (2) a root agent must spawn one helper and wait for it, which exercises
// spawn_agent/wait_agent over MCP, the slot release while waiting, the "helpers finished" resume and the
// model_evaluate reminder. Usage: node scripts/smoke-session-live.cjs [model] [effort]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { runProvider, transportFor } = require('../electron/providers.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')

const model = process.argv[2] || 'haiku'
const reasoningEffort = process.argv[3] || 'low'

function makeRuntime(userData) {
  let calls = 0
  const events = []
  const runtime = new OrbitRuntime({
    memoryStore: new OrbitMemoryStore(userData),
    runProvider: async options => {
      if (++calls > 12) throw new Error('Live verification exceeded its 12-call allowance')
      events.push({ call: calls, session: options.session ? { id: options.session.id, resume: !!options.session.resume, mcpUrl: options.session.mcpUrl } : null, promptChars: options.prompt.length })
      return runProvider(options)
    },
    transportFor,
  })
  return { runtime, events, calls: () => calls }
}

function untilFinished(runtime) {
  return new Promise((resolve, reject) => runtime.onEvent(event => {
    if (event.type === 'trace.added' && ['tool', 'observation', 'output', 'budget'].includes(event.trace?.kind)) console.log(`  [${event.trace.agentName}] ${event.trace.kind}: ${String(event.trace.text).replace(/\s+/g, ' ').slice(0, 140)}`)
    if (event.type === 'run.finished') resolve()
    if (event.type === 'run.failed' || event.type === 'run.cancelled') reject(new Error(event.error || event.type))
  }))
}

async function scenarioWriteTool(userData) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-live-'))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Session smoke\nA tiny workspace for checking Orbit tools over MCP.\n')
  const { runtime, events, calls } = makeRuntime(userData)
  const finished = untilFinished(runtime)
  const startedAt = Date.now()
  const runId = await runtime.start({
    workspace, providerId: 'claude', model, reasoningEffort, accessMode: 'workspace-write', approvalPolicy: 'never', memoryEnabled: true, skillLearning: false,
    prompt: 'Using the Orbit tool write_file (you have no native write tools), create the file hello.txt in this workspace with the exact content "hi from orbit". Then reply with the single word: done.',
    limits: { maxAgents: 1, maxDepth: 0, maxConcurrent: 2, maxTurns: 6, maxTotalTurns: 6, runTimeoutMs: 300000 },
  })
  try {
    await finished
    const snapshot = runtime.getRun(runId)
    const root = snapshot.agents[0]
    assert.equal(root.transport, 'session', `transport is ${root.transport}`)
    assert.ok(root.sessionId, 'session id recorded')
    assert.equal(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8').trim(), 'hi from orbit')
    const writes = snapshot.changes.filter(change => change.path === 'hello.txt')
    assert.ok(writes.length >= 1 && writes[0].hasDiff, 'write_file produced an exact change with a diff')
    assert.ok(root.turnTimings.length >= 1 && root.turnTimings[0].orbitToolCalls >= 1, 'MCP tool call counted in the turn timing')
    return { ok: true, model: snapshot.model, seconds: Math.round((Date.now() - startedAt) / 1000), providerCalls: calls(), sessions: events, turnTimings: root.turnTimings, final: snapshot.summary?.text, traces: snapshot.traces.length }
  } finally {
    runtime.stop(runId); await Promise.allSettled([...runtime.runs.get(runId).tasks.values()])
    await runtime.shutdown?.()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

async function scenarioSwarm(userData) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-live-'))
  fs.writeFileSync(path.join(workspace, 'numbers.txt'), '17 23\n')
  const { runtime, events, calls } = makeRuntime(userData)
  const finished = untilFinished(runtime)
  const startedAt = Date.now()
  const runId = await runtime.start({
    workspace, providerId: 'claude', model, reasoningEffort, accessMode: 'read-only', approvalPolicy: 'never', memoryEnabled: true, skillLearning: false,
    prompt: 'This is a delegation check. Spawn exactly one helper with spawn_agent whose task is: read numbers.txt and reply with the product of the two numbers. Wait for it with wait_agent, then reply with the product the helper reported and the helper\'s name. Do not compute it yourself.',
    limits: { maxAgents: 3, maxDepth: 1, maxConcurrent: 2, maxTurns: 6, maxTotalTurns: 12, runTimeoutMs: 420000 },
  })
  try {
    await finished
    const snapshot = runtime.getRun(runId)
    const root = snapshot.agents.find(agent => agent.id === 'root')
    const helpers = snapshot.agents.filter(agent => agent.parentId)
    assert.equal(helpers.length, 1, `helpers: ${helpers.length}`)
    assert.equal(helpers[0].status, 'done')
    assert.equal(helpers[0].transport, 'session')
    assert.match(String(snapshot.summary?.text), /391/)
    return { ok: true, model: snapshot.model, seconds: Math.round((Date.now() - startedAt) / 1000), providerCalls: calls(), sessions: events, rootTimings: root.turnTimings, helper: { name: helpers[0].name, result: helpers[0].result, timings: helpers[0].turnTimings }, final: snapshot.summary?.text }
  } finally {
    runtime.stop(runId); await Promise.allSettled([...runtime.runs.get(runId).tasks.values()])
    await runtime.shutdown?.()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-live-profile-'))
  const report = { model, reasoningEffort, startedAt: new Date().toISOString() }
  try {
    console.log('--- scenario 1: write_file over MCP in workspace-write mode')
    report.writeTool = await scenarioWriteTool(userData)
    console.log(JSON.stringify(report.writeTool, null, 1))
    console.log('--- scenario 2: spawn one helper and wait for it')
    report.swarm = await scenarioSwarm(userData)
    console.log(JSON.stringify(report.swarm, null, 1))
    report.ok = true
  } catch (error) {
    report.ok = false; report.error = error.message
    console.error('FAILED:', error.message)
    process.exitCode = 1
  } finally {
    fs.mkdirSync(path.resolve('artifacts'), { recursive: true })
    fs.writeFileSync(path.resolve('artifacts/session-live.json'), JSON.stringify(report, null, 2))
    fs.rmSync(userData, { recursive: true, force: true })
  }
}
main()
