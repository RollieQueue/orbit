// Explicit live regression using the user's Codex login and model quota.
// Unlike the arithmetic smoke test, this permits native repository inspection.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { runProvider } = require('../electron/providers.mts')

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-handoff-live-'))
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Tiny task board\nUsers submit tasks with POST /tasks and list them with GET /tasks. State is currently in memory. Review only; do not change files.\n')
  fs.writeFileSync(path.join(workspace, 'server.cjs'), `const http = require('node:http')
const tasks = []
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tasks') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => { tasks.push(JSON.parse(body)); res.end('saved') })
  } else if (req.method === 'GET' && req.url === '/tasks') {
    res.end(JSON.stringify(tasks))
  } else { res.statusCode = 404; res.end('missing') }
}).listen(3000)
`)
  const initial = fs.readdirSync(workspace).map(name => [name, fs.readFileSync(path.join(workspace, name), 'utf8')])
  let calls = 0, active = 0, peak = 0, runId
  const runtime = new OrbitRuntime({ runProvider: async options => {
    if (++calls > 40) throw new Error('Live verification exceeded its 40-call allowance')
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
      prompt: 'Изучи README.md этого маленького проекта, затем реально создай ровно 8 помощников для независимого краткого аудита server.cjs: архитектура, продукт, frontend/API, backend, безопасность, QA, производительность, developer experience. Каждый помощник должен прочитать код и вернуть одну конкретную проблему с обоснованием, без дальнейшего делегирования. Дождись всех восьми результатов и составь краткий согласованный список приоритетов. Это проверка взаимодействия и запуска: не заменяй помощников собственным анализом. Читать файлы и выполнять команды чтения разрешено; ничего не изменяй и не запускай сервер. Не создавай больше восьми помощников. Ответ на русском.',
      limits: { maxAgents: 9, maxDepth: 1, maxConcurrent: 8, maxTurns: 4, maxTotalTurns: 32, timeoutMs: 180000, runTimeoutMs: 600000 },
    })
    await finished
    const snapshot = runtime.getRun(runId)
    assert.equal(snapshot.agents.length, 9)
    assert.ok(snapshot.agents.every(agent => agent.status === 'done'))
    assert.ok(snapshot.agents.filter(agent => agent.parentId).every(agent => agent.result.trim()))
    assert.equal(snapshot.traces.filter(trace => trace.kind === 'protocol_error').length, 0)
    assert.ok(snapshot.summary.text.trim())
    assert.ok(peak >= 2)
    assert.deepEqual(fs.readdirSync(workspace).map(name => [name, fs.readFileSync(path.join(workspace, name), 'utf8')]), initial)
    const result = { ok: true, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort, agents: snapshot.agents.length, calls, peak,
      handoffs: snapshot.traces.filter(trace => trace.text?.includes('handed control to Orbit tools')).length,
      protocolErrors: 0, participants: snapshot.agents.map(agent => ({ name: agent.name, parentId: agent.parentId, status: agent.status, result: agent.result })), final: snapshot.summary.text }
    fs.mkdirSync(path.resolve('artifacts'), { recursive: true })
    fs.writeFileSync(path.resolve('artifacts/handoff-live.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, traces: runId && runtime.getRun(runId).traces.slice(-5) }))
    throw error
  } finally {
    if (runId) { runtime.stop(runId); await Promise.allSettled([...runtime.runs.get(runId).tasks.values()]) }
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    assert.ok(path.basename(workspace).startsWith('orbit-handoff-live-'))
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}
main().catch(() => { process.exitCode = 1 })
