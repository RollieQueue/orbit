const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, resolveLaunch, _testing } = require('../electron/providers.mts')
const { ORBIT_RESPONSE_SCHEMA, TOOL_HANDOFF } = require('../electron/tool-schema.mts')
const { runCli, createCodexParser } = _testing

test('a CLI that fails before reading a large prompt reports its own error, not a stdin write error', async () => {
  // Orbit prompts routinely exceed the ~64 KB Windows pipe buffer. Writing them to a process that already
  // exited raised EOF, which used to replace the CLI's real message (bad flag, login required, region block).
  const script = 'process.stderr.write("REAL_CLI_ERROR: unknown option --bogus"); process.exit(2)'
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(runCli(process.execPath, ['-e', script], { input: 'x'.repeat(300000), timeoutMs: 8000 }), error => {
      assert.match(error.message, /REAL_CLI_ERROR: unknown option --bogus/)
      assert.doesNotMatch(error.message, /write EOF|EPIPE/)
      return true
    })
  }
})

test('a finished answer is not held hostage by a background process that inherited the output pipes', async () => {
  // e.g. an MCP or dev server started detached by the CLI keeps stdout open after the CLI itself has exited.
  const code = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit', detached: true }).unref();
    console.log(JSON.stringify({ done: true }));
  `
  const lines = []
  const started = Date.now()
  await runCli(process.execPath, ['-e', code], { timeoutMs: 20000, onLine: line => { lines.push(line) } })
  assert.deepEqual(lines, ['{"done":true}'])
  assert.ok(Date.now() - started < 4500, `resolved after ${Date.now() - started} ms; it must not wait for the background process`)
})

test('a Codex warning item does not block a valid tool handoff or a completed answer', () => {
  const warning = { type: 'item.completed', item: { id: 'w1', type: 'error', message: 'Model metadata for this model was not found; using fallback metadata.' } }
  const envelope = JSON.stringify({ content: '', tool_calls: [{ id: 'a', name: 'list_agents', arguments: {} }] })
  const events = []
  const handoff = createCodexParser(event => events.push(event), 'model', ORBIT_RESPONSE_SCHEMA)
  assert.equal(handoff.line(JSON.stringify(warning)), undefined)
  assert.equal(handoff.line(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: envelope } })), TOOL_HANDOFF)
  assert.equal(handoff.finish().text, envelope)
  assert.ok(events.some(event => event.status === 'warning' && /fallback metadata/.test(event.text)), 'the warning is still shown to the user')

  const completed = createCodexParser(() => {}, 'model')
  for (const event of [warning, { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Готово' } }, { type: 'turn.completed' }]) completed.line(JSON.stringify(event))
  assert.equal(completed.finish().text, 'Готово')

  const failed = createCodexParser(() => {}, 'model')
  for (const event of [warning, { type: 'turn.failed', error: { message: 'Quota exceeded' } }]) failed.line(JSON.stringify(event))
  assert.throws(() => failed.finish(), /Quota exceeded/, 'a real failed turn is still a failure')
})

test('a failure reported in-band by a CLI that then exits non-zero is shown as that message, not as raw JSONL', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-inband-fixture-'))
  const previous = process.env.ORBIT_CLAUDE_COMMAND
  t.after(() => {
    if (previous === undefined) delete process.env.ORBIT_CLAUDE_COMMAND; else process.env.ORBIT_CLAUDE_COMMAND = previous
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(temporary, 'cli.cjs'), `
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key - Please run /login' }));
      process.exit(1);
    });
  `)
  fs.writeFileSync(path.join(temporary, 'cli.cmd'), '@"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*')
  process.env.ORBIT_CLAUDE_COMMAND = path.join(temporary, 'cli.cmd')
  await assert.rejects(runProvider({ providerId: 'claude', workspace: temporary, accessMode: 'read-only', prompt: 'Fixture', timeoutMs: 5000 }), error => {
    assert.match(error.message, /Invalid API key - Please run \/login/)
    assert.doesNotMatch(error.message, /"type":/, 'no raw JSONL in the message')
    return true
  })
})

test('Ollama is asked for a context window that fits the prompt', async t => {
  const http = require('node:http')
  const bodies = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      if (request.url.endsWith('/api/generate')) bodies.push(JSON.parse(raw))
      response.setHeader('content-type', 'application/x-ndjson')
      response.end(`${JSON.stringify({ model: 'fixture', response: 'ok', done: true, done_reason: 'stop' })}\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = process.env.ORBIT_OLLAMA_URL
  process.env.ORBIT_OLLAMA_URL = `http://127.0.0.1:${server.address().port}`
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_OLLAMA_URL; else process.env.ORBIT_OLLAMA_URL = previous; server.close() })
  for (const prompt of ['short', 'п'.repeat(12000), 'п'.repeat(30000), 'x'.repeat(200000)]) await runProvider({ providerId: 'ollama', model: 'fixture', workspace: os.tmpdir(), accessMode: 'read-only', prompt, timeoutMs: 5000 })
  assert.deepEqual(bodies.map(body => body.options.num_ctx), [4096, 8192, 16384, 32768])
})

test('commands are found on PATH without where.exe, including directories with non-ASCII names', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-путь-'))
  const previous = process.env.PATH
  t.after(() => { process.env.PATH = previous; fs.rmSync(directory, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(directory, 'orbit-fixture-tool.exe'), 'not really an executable')
  process.env.PATH = `${directory}${path.delimiter}${previous}`
  assert.equal(resolveLaunch('orbit-fixture-tool', []).executable, path.join(directory, 'orbit-fixture-tool.exe'))
  // The lookup cache is keyed by PATH, so a changed PATH is never answered from a stale entry.
  process.env.PATH = previous
  assert.equal(resolveLaunch('orbit-fixture-tool', []).executable, 'orbit-fixture-tool')
})
