const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { runProvider, _testing } = require('../electron/providers.mts')
const { createCodexParser, createClaudeParser, createLineReader, buildCodexArgs, buildClaudeArgs, runCli, resolveLaunch } = _testing

const feed = (parser, events) => events.forEach((event) => parser.line(JSON.stringify(event)))

test('Claude hands validated Orbit calls back only from a completed main assistant message', () => {
  const { ORBIT_RESPONSE_SCHEMA, TOOL_HANDOFF } = require('../electron/tool-schema.mts')
  const text = JSON.stringify({ content: 'Reading context', tool_calls: [{ id: 'read', name: 'context_read', arguments: {} }] })
  const events = [], parser = createClaudeParser(event => events.push(event), 'sonnet', ORBIT_RESPONSE_SCHEMA)
  const send = event => parser.line(JSON.stringify(event))
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } })
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking' } } })
  assert.equal(send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }), undefined)
  assert.equal(send({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child-m', content: [{ type: 'text', text }] } }), undefined)
  assert.equal(send({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text }] } }), TOOL_HANDOFF)
  send({ type: 'result', subtype: 'success', result: 'must not overwrite tools' })
  assert.equal(parser.finish().text, text)
  assert.equal(events.find(event => event.kind === 'reasoning').text, 'Checking')
})

// Shaped like a stream recorded from Claude Code 2.1.284 (stream-json with partial messages, Sonnet 5.5, high effort):
// the thinking text streams empty, and system/thinking_tokens events estimate the thinking block in progress.
test('Claude reports thinking in progress from system/thinking_tokens, only inside the agent\'s own thinking block', () => {
  const stream = (event, parent = null) => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: parent })
  const estimate = (tokens, delta) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens, estimated_tokens_delta: delta, session_id: 's' })
  const thinking = events => events.filter(event => event.kind === 'thinking').map(({ tokens, done }) => ({ tokens, done }))
  const events = [], parser = createClaudeParser(event => events.push(event), 'sonnet')
  feed(parser, [
    { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5' },
    estimate(10, 10),
    stream({ type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-5-5' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    estimate(50, 50),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } }),
    estimate(null, 0),
    estimate(219, 169),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    stream({ type: 'content_block_stop', index: 0 }),
    // A native subagent thinks: its block names the parent tool, the estimate does not.
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, 'task-1'),
    estimate(80, 80),
    stream({ type: 'content_block_stop', index: 0 }, 'task-1'),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '119' } }),
    stream({ type: 'content_block_stop', index: 1 }),
    { type: 'result', subtype: 'success', result: '119', session_id: 's' },
  ])
  assert.deepEqual(thinking(events), [{ tokens: 0, done: undefined }, { tokens: 50, done: undefined }, { tokens: 219, done: undefined }, { tokens: undefined, done: true }])
  assert.equal(parser.finish().text, '119')
  // A request the CLI starts anew (a retry) leaves no thinking block open.
  const retried = [], again = createClaudeParser(event => retried.push(event))
  feed(again, [
    stream({ type: 'message_start', message: { id: 'm1' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    estimate(120, 120),
    stream({ type: 'message_start', message: { id: 'm2' } }),
    estimate(40, 40),
  ])
  assert.deepEqual(thinking(retried), [{ tokens: 0, done: undefined }, { tokens: 120, done: undefined }, { tokens: undefined, done: true }])
})

test('Claude reads structured results and falls back to the completed assistant for an empty result', () => {
  const parser = createClaudeParser()
  feed(parser, [{ type: 'result', subtype: 'success', result: '', structured_output: { content: 'Answer', tool_calls: [] } }])
  assert.equal(JSON.parse(parser.finish().text).content, 'Answer')
  const fallback = createClaudeParser()
  feed(fallback, [{ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Answer' }] } }, { type: 'result', subtype: 'success', result: '' }])
  assert.equal(fallback.finish().text, 'Answer')
})

test('Codex streams native tool activity and returns only the exact final response', () => {
  const events = []
  const parser = createCodexParser((event) => events.push(event), 'chosen-model')
  const final = '  {"tool_calls":[{"name":"memory.search","arguments":{"query":"привет"}}]}\n'
  feed(parser, [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'I will inspect the project.' } },
    { type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'git status', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'git status', status: 'completed', aggregated_output: 'clean', exit_code: 0 } },
    { type: 'item.updated', item: { id: 'b', type: 'agent_message', text: final.slice(0, 10) } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: final } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: final } },
    { type: 'turn.completed', usage: { input_tokens: 45, output_tokens: 10 } },
  ])
  assert.deepEqual(parser.finish(), { text: final, model: 'chosen-model', sessionId: 'thread-1' })
  assert.equal(events.filter((event) => event.messageId === 'b').map((event) => event.text).join(''), final)
  assert.equal(events.filter((event) => event.kind === 'tool').length, 2)
  assert.equal(events.find((event) => event.exitCode === 0).output, 'clean')
})

test('Codex diagnostics, incomplete turns, and provider failures cannot become a success', () => {
  const diagnostic = createCodexParser()
  diagnostic.line('Please sign in')
  assert.throws(() => diagnostic.finish(), /without a completed turn/)
  const failed = createCodexParser()
  feed(failed, [
    { type: 'item.completed', item: { type: 'agent_message', text: 'Partial result' } },
    { type: 'turn.failed', error: { message: 'Quota exceeded' } },
  ])
  assert.throws(() => failed.finish(), /Quota exceeded/)
  const empty = createCodexParser()
  feed(empty, [{ type: 'turn.completed' }])
  assert.throws(() => empty.finish(), /without an assistant response/)
})

test('Unknown CLI models stay empty rather than becoming an invalid next-turn model', () => {
  const codex = createCodexParser()
  feed(codex, [{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }])
  assert.equal(codex.finish().model, '')
  const claude = createClaudeParser()
  feed(claude, [{ type: 'result', subtype: 'success', result: 'ok' }])
  assert.equal(claude.finish().model, '')
})

test('Claude partial tokens, completed assistant, and result do not duplicate text', () => {
  const events = []
  const parser = createClaudeParser((event) => events.push(event))
  feed(parser, [
    { type: 'system', subtype: 'init', model: 'claude-fixture' },
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Hello' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '\nworld! ' } } },
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: ' Hello\nworld! ' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: ' Hello\nworld! ' },
  ])
  assert.deepEqual(parser.finish(), { text: ' Hello\nworld! ', model: 'claude-fixture' })
  assert.equal(events.filter((event) => event.kind === 'output').map((event) => event.text).join(''), ' Hello\nworld! ')
})

test('Claude reports native tool calls/results and keeps subagent output separate', () => {
  const events = []
  const parser = createClaudeParser((event) => events.push(event))
  feed(parser, [
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'clean' }] } },
    { type: 'assistant', parent_tool_use_id: 'tool-1', message: { id: 'child-message', content: [{ type: 'text', text: 'Child result' }] } },
    { type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: '{"answer":"done"}' }] } },
    { type: 'result', subtype: 'success', result: '{"answer":"done"}' },
  ])
  assert.equal(parser.finish().text, '{"answer":"done"}')
  assert.equal(events.find((event) => event.tool === 'Bash').text, 'git status')
  assert.equal(events.find((event) => event.toolId === 'tool-1' && event.status === 'completed').output, 'clean')
  assert.equal(events.find((event) => event.messageId === 'child-message').parentToolId, 'tool-1')
})

test('Claude error results and missing results reject instead of passing partial text', () => {
  for (const error of [
    { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Maximum turns reached'] },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Authentication failed' },
  ]) {
    const parser = createClaudeParser()
    feed(parser, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Partial text' }] } }, error])
    assert.throws(() => parser.finish(), /Maximum turns|Authentication/)
  }
  assert.throws(() => createClaudeParser().finish(), /without a result/)
})

test('Native arguments use stdin, preserve chosen model, and never widen read-only access', () => {
  const prompt = '" & echo malicious | test\n' + 'long'.repeat(100000)
  const codex = buildCodexArgs({ prompt, workspace: 'C:\\project & spaces', model: 'chosen-model', accessMode: 'read-only', approvalPolicy: 'auto-review' })
  assert.equal(codex.at(-1), '-')
  assert.equal(codex.includes(prompt), false)
  assert.equal(codex.includes('chosen-model'), true)
  assert.equal(codex.includes('--approve-for-me'), false)
  assert.equal(codex.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  assert.ok(codex.includes('features.multi_agent=false'), 'Orbit must own delegation instead of invisible native children')
  const effort = buildCodexArgs({ workspace: '.', accessMode: 'danger-full-access', reasoningEffort: 'high' })
  assert.ok(effort.includes('model_reasoning_effort="high"'))
  const claude = buildClaudeArgs({ prompt, model: 'claude-chosen', accessMode: 'workspace-write' })
  assert.equal(claude.includes(prompt), false)
  assert.equal(claude.includes('claude-chosen'), true)
  assert.equal(claude.includes('Read,Glob,Grep'), true)
  assert.equal(claude.includes('plan'), false)
  const fullClaude = buildClaudeArgs({ accessMode: 'danger-full-access', reasoningEffort: 'high' })
  assert.ok(fullClaude.includes('bypassPermissions'))
  assert.equal(fullClaude[fullClaude.indexOf('--effort') + 1], 'high')
  assert.ok(!fullClaude.includes('--tools'))
  assert.equal(claude.includes('--max-turns'), false)
  const askClaude = buildClaudeArgs({ accessMode: 'read-only', approvalPolicy: 'on-request' })
  assert.ok(askClaude.includes('Read,Glob,Grep'))
  assert.throws(() => buildCodexArgs({ accessMode: 'invalid' }), /Unsupported access mode/)
  const schemaPath = 'C:\\temporary path\\response.schema.json'
  const structured = buildCodexArgs({ workspace: '.', accessMode: 'read-only', outputSchemaPath: schemaPath })
  assert.equal(structured[structured.indexOf('--output-schema') + 1], schemaPath)
})

test('Codex receives the Orbit response schema as a real file and cleans it after success or failure', async t => {
  const { ORBIT_RESPONSE_SCHEMA } = require('../electron/tool-schema.mts')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-schema-fixture-'))
  const previous = process.env.ORBIT_CODEX_COMMAND
  t.after(() => {
    if (previous === undefined) delete process.env.ORBIT_CODEX_COMMAND; else process.env.ORBIT_CODEX_COMMAND = previous
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const script = path.join(temporary, 'cli.cjs'), shim = path.join(temporary, 'cli.cmd'), recorded = path.join(temporary, 'schema-path.txt')
  fs.writeFileSync(shim, '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  process.env.ORBIT_CODEX_COMMAND = shim
  for (const fail of [false, true]) {
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      const schemaPath = process.argv[process.argv.indexOf('--output-schema') + 1];
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      fs.writeFileSync(${JSON.stringify(recorded)}, schemaPath);
      process.stdin.resume();
      process.stdin.on('end', () => {
        if (${fail}) { process.stderr.write('Fixture provider failure'); process.exit(1); }
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(schema)}}));
        console.log(JSON.stringify({type:'turn.completed'}));
      });
    `)
    const result = runProvider({ providerId: 'codex', workspace: temporary, accessMode: 'read-only', prompt: 'Fixture', timeoutMs: 3000, responseSchema: ORBIT_RESPONSE_SCHEMA })
    if (fail) await assert.rejects(result, /Fixture provider failure/)
    else assert.deepEqual(JSON.parse((await result).text), ORBIT_RESPONSE_SCHEMA)
    const schemaPath = fs.readFileSync(recorded, 'utf8')
    assert.equal(fs.existsSync(schemaPath), false)
    assert.equal(fs.existsSync(path.dirname(schemaPath)), false)
  }
})

test('JSONL framing survives split UTF-8 characters and a final line without newline', () => {
  const lines = []
  const reader = createLineReader((line) => lines.push(line))
  const source = Buffer.from('{"text":"Привет 🛰️"}\r\n{"done":true}')
  for (const byte of source) reader.write(Buffer.from([byte]))
  reader.end()
  assert.deepEqual(lines, ['{"text":"Привет 🛰️"}', '{"done":true}'])
})

test('CLI streams before exit and transports long prompts literally over stdin', async () => {
  const prompt = 'Привет " & echo should-not-run | $(anything) %PATH%\n'.repeat(3000)
  const code = 'let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => input += x); process.stdin.on("end", () => { console.log(JSON.stringify({input})); setTimeout(() => process.exit(0), 100) })'
  let settled = false
  let actual
  const result = runCli(process.execPath, ['-e', code], {
    input: prompt, timeoutMs: 3000,
    onLine: (line) => { assert.equal(settled, false); actual = JSON.parse(line).input },
  }).then(() => { settled = true })
  await result
  assert.equal(actual, prompt)
})

test('CLI failures and bounded stderr reject', async () => {
  await assert.rejects(runCli(process.execPath, ['-e', 'process.stderr.write("access denied"); process.exit(7)'], { timeoutMs: 3000 }), /access denied/)
  await assert.rejects(runCli(process.execPath, ['-e', 'process.stderr.write("x".repeat(50000)); setInterval(() => {}, 1000)'], { timeoutMs: 3000, maxOutputBytes: 1000 }), /output limit/)
})

test('Cancellation terminates the CLI and its spawned tools', async () => {
  const controller = new AbortController()
  let childPid
  let toolPid
  const code = 'const cp = require("node:child_process"); const tool = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore", windowsHide:true}); console.log(JSON.stringify({child:process.pid, tool:tool.pid})); setInterval(() => {}, 1000)'
  await assert.rejects(runCli(process.execPath, ['-e', code], {
    signal: controller.signal, timeoutMs: 5000,
    onLine: (line) => { const data = JSON.parse(line); childPid = data.child; toolPid = data.tool; controller.abort() },
  }), { name: 'AbortError' })
  assert.ok(childPid && toolPid)
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
  assert.throws(() => process.kill(toolPid, 0), { code: 'ESRCH' })
})

test('Already-cancelled requests and deadlines stop promptly', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runCli(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }), { name: 'AbortError' })
  await assert.rejects(runCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), { name: 'TimeoutError' })
})

test('Standard npm shims resolve to Node entry points without a shell', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-provider-shim-'))
  try {
    const script = path.join(temporary, 'entry.cjs')
    const shim = path.join(temporary, 'provider.cmd')
    fs.writeFileSync(script, 'process.exit(0)')
    fs.writeFileSync(shim, '@"%dp0%\\node.exe" "%dp0%\\entry.cjs" %*')
    const launch = resolveLaunch(shim, ['--model', 'literal & " value'])
    assert.equal(launch.executable, process.execPath)
    assert.deepEqual(launch.args, [script, '--model', 'literal & " value'])
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
    fs.writeFileSync(shim, '@echo unknown wrapper')
    assert.throws(() => resolveLaunch(shim, []), /Cannot safely launch/)
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

async function withEndpoint(handler, callback) {
  const keys = ['ORBIT_OPENAI_BASE_URL', 'ORBIT_OPENAI_MODEL', 'ORBIT_OPENAI_API_KEY', 'ORBIT_OLLAMA_URL', 'ORBIT_OLLAMA_MODEL']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  process.env.ORBIT_OPENAI_BASE_URL = `${base}/v1`
  process.env.ORBIT_OPENAI_MODEL = 'fixture-model'
  process.env.ORBIT_OLLAMA_URL = base
  delete process.env.ORBIT_OPENAI_API_KEY
  delete process.env.ORBIT_OLLAMA_MODEL
  try { await callback(base) }
  finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('Ollama validates model thinking controls and sends the requested level', async () => {
  const received = [], events = []
  await withEndpoint((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/show') return response.end(JSON.stringify({ thinking: { values: ['low', 'medium', 'high'] } }))
      received.push(JSON.parse(body))
      response.end(JSON.stringify({ thinking: 'fixture reasoning', response: 'done', done: true }) + '\n')
    })
  }, async () => {
    const result = await runProvider({ providerId: 'ollama', model: 'fixture', prompt: 'test', reasoningEffort: 'high', onEvent: event => events.push(event) })
    assert.equal(result.text, 'done')
    assert.equal(received[0].think, 'high')
    assert.ok(events.some(event => event.kind === 'reasoning'))
    await assert.rejects(runProvider({ providerId: 'ollama', model: 'fixture', prompt: 'test', reasoningEffort: 'max' }), /unsupported reasoning/)
    assert.equal(received.length, 1)
  })
})

test('Compatible endpoint supports streamed content and preserves the harness envelope', async () => {
  let received
  let requestUrl
  let authorization
  const content = ' {"tools":[{"name":"spawn_agent","task":"inspect"}]}\n'
  await withEndpoint((request, response) => {
    requestUrl = request.url
    authorization = request.headers.authorization
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of [content.slice(0, 8), content.slice(8)]) response.write(`data: ${JSON.stringify({ model: 'actual-model', choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\r\n\r\n`)
      response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  }, async () => {
    const events = []
    const result = await runProvider({ providerId: 'custom', prompt: 'literal prompt', model: 'explicit-model', onEvent: (event) => events.push(event) })
    assert.equal(result.text, content)
    assert.equal(result.model, 'actual-model')
    assert.equal(events.filter((event) => event.kind === 'output').map((event) => event.text).join(''), content)
  })
  assert.equal(requestUrl, '/v1/chat/completions')
  assert.equal(received.model, 'explicit-model')
  assert.equal(received.messages[0].content, 'literal prompt')
  assert.equal(received.stream, true)
  assert.equal(authorization, undefined)
})

test('Compatible endpoint accepts a JSON response when streaming is not implemented', async () => {
  await withEndpoint((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: 'fixture', choices: [{ message: { content: '  final text\n' }, finish_reason: 'stop' }] }))
  }, async (base) => {
    process.env.ORBIT_OPENAI_BASE_URL = `${base}/v1/chat/completions`
    const result = await runProvider({ providerId: 'custom', prompt: 'test' })
    assert.equal(result.text, '  final text\n')
  })
})

test('HTTP and streaming errors never become successful answers', async () => {
  for (const fixture of [
    { status: 401, body: '{"error":{"message":"invalid token"}}', expected: /HTTP 401: invalid token/ },
    { status: 200, body: '{"error":{"message":"quota exceeded"}}', expected: /quota exceeded/ },
    { status: 200, body: '{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}', expected: /length/ },
    { status: 200, sse: true, body: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', expected: /before completion/ },
    { status: 200, sse: true, body: 'data: {"error":{"message":"stream failed"}}\n\n', expected: /stream failed/ },
  ]) {
    await withEndpoint((request, response) => {
      response.writeHead(fixture.status, { 'content-type': fixture.sse ? 'text/event-stream' : 'application/json' })
      response.end(fixture.body)
    }, async () => { await assert.rejects(runProvider({ providerId: 'custom', prompt: 'test' }), fixture.expected) })
  }
})

test('HTTP requests honor abort signals even while waiting for response headers', async () => {
  await withEndpoint(() => {}, async () => {
    const controller = new AbortController()
    const pending = runProvider({ providerId: 'custom', prompt: 'test', signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(pending, { name: 'AbortError' })
  })
})

test('an endpoint on another host needs HTTPS; plain HTTP stays for this machine or a deliberate opt-in', async t => {
  const { endpointUrl, inspectOllama, inspectCustom } = _testing
  const keys = ['ORBIT_OPENAI_BASE_URL', 'ORBIT_OPENAI_MODEL', 'ORBIT_OPENAI_API_KEY', 'ORBIT_OLLAMA_URL', 'ORBIT_ALLOW_INSECURE_HTTP']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  delete process.env.ORBIT_ALLOW_INSECURE_HTTP
  // A refused address must stop before any request, so neither the prompt nor the key leaves the machine.
  const fetched = []
  t.mock.method(globalThis, 'fetch', async url => { fetched.push(String(url)); throw new Error('the network must not be reached') })

  for (const url of ['http://localhost:1234/v1', 'http://LOCALHOST:1234', 'http://127.0.0.1:11434', 'http://127.1:11434', 'http://2130706433/', 'http://[::1]:11434', 'http://[0:0:0:0:0:0:0:1]/', 'https://api.example.com/v1', 'https://192.168.1.5:11434']) {
    assert.doesNotThrow(() => endpointUrl(url, 'ORBIT_OLLAMA_URL'), url)
  }
  for (const url of ['http://192.168.1.5:11434', 'http://api.example.com/v1', 'http://localhost.example.com/', 'http://127.0.0.1.nip.io/', 'http://0.0.0.0:11434', 'http://[fe80::1]/']) {
    assert.throws(() => endpointUrl(url, 'ORBIT_OLLAMA_URL'), /^Error: ORBIT_OLLAMA_URL \(http:.*https:\/\/.*ORBIT_ALLOW_INSECURE_HTTP=1/, url)
  }
  // Every refusal names the variable, so the user knows which one to fix.
  assert.throws(() => endpointUrl('https://user:secret@api.example.com/v1', 'ORBIT_OPENAI_BASE_URL'), /^Error: ORBIT_OPENAI_BASE_URL: уберите из адреса имя пользователя и пароль/)
  assert.throws(() => endpointUrl('foo', 'ORBIT_OLLAMA_URL'), /^Error: ORBIT_OLLAMA_URL: это не адрес URL/)
  assert.throws(() => endpointUrl('localhost:11434', 'ORBIT_OLLAMA_URL'), /^Error: ORBIT_OLLAMA_URL: адрес должен начинаться с https:\/\//)

  process.env.ORBIT_OPENAI_BASE_URL = 'http://192.0.2.10/v1'
  process.env.ORBIT_OPENAI_MODEL = 'fixture-model'
  process.env.ORBIT_OPENAI_API_KEY = 'fixture-secret'
  process.env.ORBIT_OLLAMA_URL = 'http://192.0.2.10:11434'
  await assert.rejects(runProvider({ providerId: 'custom', prompt: 'private prompt' }), /ORBIT_OPENAI_BASE_URL \(http:\/\/192\.0\.2\.10\)/)
  await assert.rejects(runProvider({ providerId: 'ollama', model: 'fixture', prompt: 'private prompt' }), /ORBIT_OLLAMA_URL \(http:\/\/192\.0\.2\.10:11434\)/)
  // The provider list names the reason instead of «Set ORBIT_OPENAI_BASE_URL» or «not reachable».
  const custom = inspectCustom(), ollama = await inspectOllama()
  assert.equal(custom.available, false)
  assert.match(custom.detail, /^ORBIT_OPENAI_BASE_URL \(http:\/\/192\.0\.2\.10\).*ORBIT_ALLOW_INSECURE_HTTP=1/)
  assert.equal(ollama.available, false)
  assert.match(ollama.detail, /^ORBIT_OLLAMA_URL \(http:\/\/192\.0\.2\.10:11434\)/)
  assert.deepEqual(fetched, [])

  // The address is checked before the model, so a missing model does not hide the refusal.
  delete process.env.ORBIT_OPENAI_MODEL
  await assert.rejects(runProvider({ providerId: 'custom', prompt: 'private prompt' }), /ORBIT_OPENAI_BASE_URL \(http:\/\/192\.0\.2\.10\)/)
  process.env.ORBIT_OPENAI_BASE_URL = 'foo'
  assert.match(inspectCustom().detail, /^ORBIT_OPENAI_BASE_URL: это не адрес URL/)
  assert.deepEqual(fetched, [])

  process.env.ORBIT_OPENAI_BASE_URL = 'https://api.example.com/v1'
  assert.deepEqual([inspectCustom().available, inspectCustom().detail], [true, 'Endpoint configured; connection checked when used'])
  process.env.ORBIT_OPENAI_BASE_URL = 'http://192.0.2.10/v1'
  process.env.ORBIT_ALLOW_INSECURE_HTTP = '1'
  assert.equal(inspectCustom().available, true)
  assert.doesNotThrow(() => endpointUrl('http://192.168.1.5:11434', 'ORBIT_OLLAMA_URL'))
  process.env.ORBIT_ALLOW_INSECURE_HTTP = 'true'
  assert.throws(() => endpointUrl('http://192.168.1.5:11434', 'ORBIT_OLLAMA_URL'), /ORBIT_ALLOW_INSECURE_HTTP=1/)
})

test('Ollama selects an installed model without downloading and streams generated text', async () => {
  let requestedModel
  await withEndpoint((request, response) => {
    if (request.url === '/api/tags') { response.end('{"models":[{"name":"installed-model"}]}'); return }
    assert.equal(request.url, '/api/generate')
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requestedModel = JSON.parse(body).model
      response.setHeader('content-type', 'application/x-ndjson')
      response.end('{"response":"Привет ","done":false}\n{"response":"мир","done":true,"model":"installed-model","eval_count":2}\n')
    })
  }, async () => {
    const events = []
    const result = await runProvider({ providerId: 'ollama', prompt: 'test', onEvent: (event) => events.push(event) })
    assert.equal(result.text, 'Привет мир')
    assert.equal(events.filter((event) => event.kind === 'output').map((event) => event.text).join(''), result.text)
  })
  assert.equal(requestedModel, 'installed-model')
})

test('Ollama rejects incomplete or failed generation', async () => {
  await withEndpoint((request, response) => response.end('{"response":"partial","done":false}\n'), async () => {
    await assert.rejects(runProvider({ providerId: 'ollama', model: 'test', prompt: 'test' }), /before completion/)
  })
  await withEndpoint((request, response) => response.end('{"error":"model not found"}\n'), async () => {
    await assert.rejects(runProvider({ providerId: 'ollama', model: 'test', prompt: 'test' }), /model not found/)
  })
})

test('Ollama prefers the unique agent-capable model over an OCR model installed first', async () => {
  let requestedModel
  await withEndpoint((request, response) => {
    if (request.url === '/api/tags') { response.end('{"models":[{"name":"ocr-model"},{"name":"agent-model"}]}'); return }
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const model = JSON.parse(body).model
      if (request.url === '/api/show') response.end(JSON.stringify({ capabilities: model === 'agent-model' ? ['completion', 'tools', 'thinking'] : ['completion'] }))
      else { requestedModel = model; response.end('{"response":"ready","done":true}\n') }
    })
  }, async () => { assert.equal((await runProvider({ providerId: 'ollama', prompt: 'test' })).text, 'ready') })
  assert.equal(requestedModel, 'agent-model')
})

test('Ollama requires explicit selection when installed models are equally suitable', async () => {
  let generationRequested = false
  await withEndpoint((request, response) => {
    if (request.url === '/api/tags') response.end('{"models":[{"name":"model-a"},{"name":"model-b"}]}')
    else if (request.url === '/api/show') response.end('{"capabilities":["completion","tools"]}')
    else { generationRequested = true; response.end('{"response":"unexpected","done":true}') }
  }, async () => { await assert.rejects(runProvider({ providerId: 'ollama', prompt: 'test' }), /Select a model explicitly/) })
  assert.equal(generationRequested, false)
})

test('Unsupported providers fail explicitly', async () => {
  await assert.rejects(runProvider({ providerId: 'unknown-provider', prompt: 'test' }), /not supported/)
})

// Token usage. The figures below are the ones Claude Code 2.1.285 (haiku) and codex-cli 0.155 really reported when they
// were run against these scenarios: a turn with two API calls (the first with two tool_use blocks), a turn with a native
// subagent that ended in two results, and a stub Responses API that answered 1000n input / 100n cached / 10n output.
const sumUsage = events => events.filter(event => event.kind === 'usage').map(event => event.usage).reduce((sum, usage) => {
  for (const [key, value] of Object.entries(usage)) sum[key] = (sum[key] || 0) + value
  return sum
}, {})
const claudeStream = (event, parent = null) => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: parent })
const claudeMessage = (id, usage, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'text', text: 'x' }], usage } })
const call = (input, created, read, output) => ({ input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output })

test('Claude counts each API call once while the turn runs, and a result adds only what the stream missed', () => {
  const events = [], parser = createClaudeParser(event => events.push(event), 'haiku')
  feed(parser, [
    // One call's figures repeat on message_start, on every `assistant` event and on message_delta; output_tokens is final only on the last.
    claudeStream({ type: 'message_start', message: { id: 'msg-1', usage: call(10, 9499, 17943, 3) } }),
    claudeMessage('msg-1', call(10, 9499, 17943, 3)), claudeMessage('msg-1', call(10, 9499, 17943, 3)), claudeMessage('msg-1', call(10, 9499, 17943, 3)),
    claudeStream({ type: 'message_delta', usage: call(10, 9499, 17943, 202) }),
    claudeStream({ type: 'message_start', message: { id: 'msg-2', usage: call(8, 302, 27442, 1) } }),
    claudeMessage('msg-2', call(8, 302, 27442, 1)), claudeMessage('msg-2', call(8, 302, 27442, 1)),
    claudeStream({ type: 'message_delta', usage: call(8, 302, 27442, 29) }),
  ])
  assert.deepEqual(sumUsage(events), call(18, 9801, 45385, 231), 'live: both calls once, with their final output')
  const before = events.length
  feed(parser, [{ type: 'result', subtype: 'success', result: 'done', usage: { ...call(18, 9801, 45385, 231), output_tokens_details: { thinking_tokens: 97 }, iterations: [] } }])
  const after = events.slice(before)
  assert.equal(after.filter(event => event.kind === 'usage').length, 0, 'a result that agrees with the stream adds nothing')
  assert.equal(after.find(event => event.kind === 'observation').usage, undefined, 'the completion note carries no figures: they would be counted twice')
  assert.equal(parser.finish().text, 'done')
})

test('Claude counts a native subagent live, leaves it out of the results, and counts each result once, in either order', () => {
  // Calls a, b and c of the agent and two of its subagent (whose output_tokens is stale on the `assistant` event).
  const a = [claudeStream({ type: 'message_start', message: { id: 'a', usage: call(10, 5434, 22017, 3) } }), claudeStream({ type: 'message_delta', usage: call(10, 5434, 22017, 201) })]
  const s1 = [claudeMessage('s1', call(10, 16798, 0, 8), 'task-1'), claudeMessage('s1', call(10, 16798, 0, 8), 'task-1')]
  const b = [claudeStream({ type: 'message_start', message: { id: 'b', usage: call(8, 568, 27451, 3) } }), claudeStream({ type: 'message_delta', usage: call(8, 568, 27451, 92) })]
  const s2 = [claudeMessage('s2', call(8, 1189, 16798, 2), 'task-1')]
  const c = [claudeStream({ type: 'message_start', message: { id: 'c', usage: call(10, 519, 28019, 5) } }), claudeStream({ type: 'message_delta', usage: call(10, 519, 28019, 61) })]
  // A result states the agent's own calls of its stretch only: the subagent is not in it, and the second result states c alone.
  const first = { type: 'result', subtype: 'success', result: 'first', usage: call(18, 6002, 49468, 293), session_id: 's' }
  const second = { type: 'result', subtype: 'success', result: 'done', usage: call(10, 519, 28019, 61), session_id: 's' }
  const everything = call(46, 24508, 94285, 364)
  // As the CLI really streamed it (Claude Code 2.1.285): both results came after all three calls...
  const late = [], afterAll = createClaudeParser(event => late.push(event), 'haiku')
  feed(afterAll, [...a, ...s1, ...b, ...s2, ...c])
  assert.deepEqual(sumUsage(late), everything, 'live: every call once')
  feed(afterAll, [first, second])
  assert.deepEqual(sumUsage(late), everything, 'the results state calls already counted')
  // ...and as it would if the first result came as soon as its calls were done.
  const early = [], inOrder = createClaudeParser(event => early.push(event), 'haiku')
  feed(inOrder, [...a, ...s1, ...b, ...s2, first, ...c, second])
  assert.deepEqual(sumUsage(early), everything)
})

test('Claude without partial messages still ends exact: the result adds the output the assistant events could not show', () => {
  const events = [], parser = createClaudeParser(event => events.push(event), 'haiku')
  feed(parser, [
    claudeMessage('msg-1', call(10, 9499, 17943, 3)), claudeMessage('msg-2', call(8, 302, 27442, 1)),
    { type: 'result', subtype: 'success', result: 'done', usage: call(18, 9801, 45385, 231) },
  ])
  assert.deepEqual(sumUsage(events), call(18, 9801, 45385, 231))
  // An error result reports its figures as well, and a stream with no figures reports none.
  const failed = [], broken = createClaudeParser(event => failed.push(event))
  feed(broken, [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', usage: call(5, 0, 100, 7) }])
  assert.deepEqual(sumUsage(failed), call(5, 0, 100, 7))
  const silent = [], plain = createClaudeParser(event => silent.push(event))
  feed(plain, [claudeMessage('m', undefined), { type: 'result', subtype: 'success', result: 'ok' }])
  assert.equal(silent.filter(event => event.kind === 'usage').length, 0)
})

test('Codex exec counts what the thread total grew by: the CLI reports the total, also when it resumes', () => {
  const turn = (thread, usage, resumed) => {
    const events = [], parser = createCodexParser(event => events.push(event), 'gpt-5.2', undefined, { resumed })
    feed(parser, [{ type: 'thread.started', thread_id: thread }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'ok' } }, { type: 'turn.completed', usage }])
    assert.equal(events.find(event => event.kind === 'observation' && event.status === 'completed').usage, undefined, 'the completion note carries no figures')
    return events.filter(event => event.kind === 'usage').map(event => event.usage)
  }
  const total = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 1 })
  // exec, then exec resume twice, as the real CLI printed them (responses of 1000, 2000 and 3000 input tokens).
  assert.deepEqual(turn('thread-usage-a', total(1000, 100, 10), false), [{ input_tokens: 1000, cached_input_tokens: 100, output_tokens: 10 }])
  assert.deepEqual(turn('thread-usage-a', total(3000, 300, 30), true), [{ input_tokens: 2000, cached_input_tokens: 200, output_tokens: 20 }], 'the total of the first two, not the second alone')
  assert.deepEqual(turn('thread-usage-a', total(6000, 600, 60), true), [{ input_tokens: 3000, cached_input_tokens: 300, output_tokens: 30 }])
  assert.deepEqual(turn('thread-usage-a', total(6000, 600, 60), true), [], 'a repeated total adds nothing')
  // A thread resumed in a process that never saw it (after an Orbit restart): its lifetime total is not this turn's.
  assert.deepEqual(turn('thread-usage-unseen', total(900000, 800000, 4000), true), [])
  assert.deepEqual(turn('thread-usage-unseen', total(950000, 840000, 4500), true), [{ input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 500 }], 'the next turn counts from there')
  // A thread whose first turn was cut off before its total arrived still starts from zero.
  const cut = createCodexParser(() => {}, 'gpt-5.2')
  feed(cut, [{ type: 'thread.started', thread_id: 'thread-usage-cut' }])
  assert.deepEqual(turn('thread-usage-cut', total(1200, 0, 40), true), [{ input_tokens: 1200, cached_input_tokens: 0, output_tokens: 40 }])
})
