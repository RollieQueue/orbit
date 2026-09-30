const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { RunStore } = require('../electron/run-store.mts')

const tool = (name, args = {}) => ({ name, arguments: args })
const envelope = (...calls) => JSON.stringify({ content: '', tool_calls: calls })

test('Custom SSE and Ollama NDJSON agents exchange durable messages through one provider slot', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mixed-messaging-'))
  const workspace = path.join(temporary, 'workspace')
  fs.mkdirSync(workspace)
  const savedEnvironment = Object.fromEntries(['ORBIT_OPENAI_BASE_URL', 'ORBIT_OPENAI_API_KEY', 'ORBIT_OLLAMA_URL'].map((key) => [key, process.env[key]]))
  const hello = 'Из custom: проверь 19×23; строка "один".\nСтрока два: 🛰️'
  const reply = 'Из Ollama: 437, подтверждаю "независимо".\nЖду подтверждения.'
  const acknowledgment = 'Ответ получен; заверши задачу.'
  const requests = []
  const errors = []
  const turns = { Orbit: 0, Worker: 0 }
  let workerReplied = false
  const fixtures = (prompt, route, model) => {
    const identity = prompt.match(/^Agent: ([^;]+); id=([^;]+);/m)
    assert.ok(identity, 'The actual runtime prompt must identify its agent')
    const name = identity[1]
    const turn = ++turns[name]
    requests.push({ name, turn, route, model })
    if (name === 'Orbit') {
      assert.equal(route, '/v1/chat/completions')
      assert.equal(model, 'custom-selected')
      if (turn === 1) return envelope(
        tool('spawn_agent', { name: 'Worker', task: 'Independently verify the supplied arithmetic and await acknowledgment', reason: 'Independent result from another provider', providerId: 'ollama', model: 'ollama-selected' }),
        tool('send_message', { agentId: 'Worker', message: hello }),
        tool('wait_message', { timeout_ms: 2000 }),
      )
      if (turn === 2) {
        assert.ok(prompt.includes(JSON.stringify(reply).slice(1, -1)), 'The Ollama reply must reach the next custom prompt unchanged')
        return envelope(tool('send_message', { agentId: 'Worker', message: acknowledgment }), tool('wait_agent', { timeout_ms: 2000 }))
      }
      assert.equal(turn, 3)
      assert.match(prompt, /Ollama verified 437/)
      return 'Обмен между custom и Ollama завершён: результат 437.'
    }
    assert.equal(name, 'Worker')
    assert.equal(route, '/api/generate')
    assert.equal(model, 'ollama-selected')
    if (!workerReplied) {
      // A child may enter its first turn before the parent executes the next
      // tool in the spawn/send envelope. Wait without occupying a model slot.
      // The root is the Worker's supervisor: its message leads the prompt whole (MESSAGE FROM YOUR SUPERVISOR), unescaped.
      if (!prompt.includes('Orbit (message ') || !prompt.includes(hello)) return envelope(tool('wait_message', { timeout_ms: 2000 }))
      workerReplied = true
      return envelope(tool('send_message', { agentId: 'root', message: reply }), tool('wait_message', { timeout_ms: 2000 }))
    }
    assert.ok(turn === 2 || turn === 3)
    assert.match(prompt, /Ответ получен; заверши задачу/)
    return 'Ollama verified 437 after receiving the acknowledgment.'
  }
  const server = http.createServer((request, response) => {
    let input = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { input += chunk })
    request.on('end', () => {
      try {
        const body = JSON.parse(input)
        assert.equal(body.stream, true)
        const custom = request.url === '/v1/chat/completions'
        const prompt = custom ? body.messages[0].content : body.prompt
        const text = fixtures(prompt, request.url, body.model)
        const parts = [text.slice(0, 13), text.slice(13)]
        if (custom) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const content of parts) response.write(`data: ${JSON.stringify({ model: 'reported-custom-alias', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
          response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        } else {
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
          parts.forEach((part, index) => response.write(JSON.stringify({ model: 'reported-ollama-alias', response: part, done: index === parts.length - 1 }) + '\n'))
          response.end()
        }
      } catch (error) {
        errors.push(error)
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  process.env.ORBIT_OPENAI_BASE_URL = `${base}/v1`
  process.env.ORBIT_OLLAMA_URL = base
  delete process.env.ORBIT_OPENAI_API_KEY
  const runStore = new RunStore(path.join(temporary, 'storage'))
  const runtime = new OrbitRuntime({ runStore })
  const events = []
  let runId, deadline, resolveFinished, rejectFinished
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
  runtime.onEvent((event) => {
    events.push(event)
    if (event.type === 'run.finished') resolveFinished()
    if (event.type === 'run.failed') rejectFinished(new Error(event.error))
  })
  try {
    runId = await runtime.start({
      workspace, projectId: 'mixed-fixture', chatId: 'mixed-fixture', providerId: 'custom', model: 'custom-selected',
      prompt: 'Coordinate the independent verification across the selected providers.', accessMode: 'read-only', memoryEnabled: false,
      limits: { maxAgents: 3, maxDepth: 1, maxConcurrent: 1, maxTurns: 5, maxTotalTurns: 8, timeoutMs: 3000, runTimeoutMs: 12000 },
    })
    await Promise.race([finished, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Mixed-provider messaging deadlocked')), 13000) })])
    assert.deepEqual(errors, [])
    const snapshot = runtime.getRun(runId)
    assert.equal(snapshot.status, 'completed')
    assert.match(snapshot.summary.text, /437/)
    assert.equal(snapshot.agents.length, 2)
    assert.ok(snapshot.agents.every((agent) => agent.status === 'done'))
    assert.ok(snapshot.usage.providerTurns === 5 || snapshot.usage.providerTurns === 6)
    assert.ok([2, 3].includes(requests.filter((request) => request.route === '/api/generate').length))
    assert.equal(requests.filter((request) => request.route === '/v1/chat/completions').length, 3)
    assert.deepEqual(snapshot.communications.filter(message => message.kind === 'message').map((message) => message.text), [hello, reply, acknowledgment])
    assert.equal(snapshot.communications.filter(message => message.kind === 'spawn').length, 2)
    assert.equal(new Set(snapshot.communications.map((message) => message.id)).size, 5)
    for (const message of snapshot.communications) {
      assert.equal(message.status, 'read')
      assert.ok(message.deliveredAt && message.readAt)
      assert.equal(events.filter((event) => event.type === 'communication.added' && event.communication.id === message.id && event.communication.status === 'read').length, 1, 'One read transition per message')
    }
    assert.equal(runtime.runs.get(runId).messageWaiters.size, 0)
    assert.equal(runtime.runs.get(runId).activeTurns, 0)
    assert.deepEqual(fs.readdirSync(workspace), [])
    runStore.flush()
    const restored = new RunStore(path.join(temporary, 'storage')).get(runId)
    assert.deepEqual(restored.communications, snapshot.communications)
  } finally {
    clearTimeout(deadline)
    if (runId) {
      runtime.stop(runId)
      await Promise.allSettled([...runtime.runs.get(runId).tasks.values()])
    }
    runStore.flush()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
