// Explicit live regression: uses the user's Codex login and consumes model quota.
// Exercise a six-call spawn batch on the reported model, not a mocked provider.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { runProvider } = require('../electron/providers.mts')

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-protocol-live-'))
  let calls = 0, peak = 0, active = 0, runId
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (++calls > 16) throw new Error('Live verification exceeded its 16-call allowance')
    active++; peak = Math.max(peak, active)
    try { return await runProvider(options) } finally { active-- }
  } })
  let resolve, reject
  const finished = new Promise((yes, no) => { resolve = yes; reject = no })
  runtime.onEvent(event => {
    if (event.type === 'agent.created') console.log(`Participant created: ${event.agent.name}`)
    if (event.type === 'run.finished') resolve()
    if (event.type === 'run.failed' || event.type === 'run.cancelled') reject(new Error(event.error || event.type))
  })
  try {
    runId = await runtime.start({
      workspace, providerId: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', accessMode: 'read-only', approvalPolicy: 'never', memoryEnabled: false,
      prompt: 'Проверка протокола Orbit. Создай одним пакетом ровно шесть реальных помощников с именами Проверка-11, Проверка-12, Проверка-13, Проверка-14, Проверка-15, Проверка-16. Каждому поручай только вычислить его число, умноженное на 7, и вернуть короткий окончательный ответ. Укажи причину: независимая проверка отдельного слагаемого. Дождись всех шести результатов и ответь их суммой. Используй только spawn_agent и wait_agent; файлы, команды, поиск и сообщения для этой проверки не нужны. Не вычисляй за помощников и не создавай дополнительных участников.',
      limits: { maxAgents: 7, maxDepth: 1, maxConcurrent: 3, maxTurns: 3, maxTotalTurns: 12, timeoutMs: 90000, runTimeoutMs: 240000 },
    })
    await finished
    const snapshot = runtime.getRun(runId)
    assert.equal(snapshot.agents.length, 7)
    assert.ok(snapshot.agents.every(agent => agent.status === 'done'))
    assert.equal(snapshot.traces.filter(trace => trace.kind === 'protocol_error').length, 0)
    assert.match(snapshot.summary.text, /567/)
    assert.ok(peak >= 2)
    assert.deepEqual(fs.readdirSync(workspace), [])
    const result = { ok: true, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort, agents: snapshot.agents.length, calls, peak, protocolErrors: 0, final: snapshot.summary.text }
    fs.mkdirSync(path.resolve('artifacts'), { recursive: true })
    fs.writeFileSync(path.resolve('artifacts/protocol-live.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, traces: runId && runtime.getRun(runId).traces.slice(-5) }))
    throw error
  } finally {
    if (runId) {
      runtime.stop(runId)
      await Promise.allSettled([...runtime.runs.get(runId).tasks.values()])
    }
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    assert.ok(path.basename(workspace).startsWith('orbit-protocol-live-'))
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}
main().catch(() => { process.exitCode = 1 })
