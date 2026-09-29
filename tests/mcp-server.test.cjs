const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { createMcpServer, UNREAD_SUFFIX } = require('../electron/mcp-server.mts')
const { PUBLIC_TOOLS } = require('../electron/tool-registry.mts')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function connect(url, token) {
  const client = new Client({ name: 'orbit-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}
const text = result => result.content.map(block => block.text).join('')

async function withServer(options, callback) {
  const calls = []
  const server = createMcpServer({
    dispatch: async (token, name, args, context) => {
      calls.push({ token, name, args, context })
      if (name === 'memory_forget') throw new Error('No such note in the memory you can reach')
      if (name === 'wait_agent') { await sleep(args.timeout_ms || 0); return { text: 'waited', unread: 0 } }
      if (name === 'list_agents') return { text: '[{"id":"root"}]', unread: 2 }
      if (name === 'read_messages') return 'plain text observation'
      return { text: JSON.stringify({ ok: true, name, args }), unread: 0 }
    },
    approve: async (token, request) => request.tool_name === 'Bash' ? true : request.tool_name === 'Write' ? { behavior: 'allow', updatedInput: { ...request.input, file_path: 'safe.txt' } } : { behavior: 'deny', message: 'The user declined this operation' },
    ...options,
  })
  try { await callback(server, calls) } finally { await server.stop() }
}

test('the server listens on loopback only, on an ephemeral port, and start() is idempotent', async () => {
  await withServer({}, async server => {
    const first = await server.start()
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.ok(first.port > 0)
    assert.deepEqual(await server.start(), first)
    assert.equal(server.url, first.url)
  })
})

test('tools/list comes from the registry, filtered by listTools, with approve only where the token asks for it', async () => {
  await withServer({}, async server => {
    const { url } = await server.start()
    const plain = await connect(url, server.issueToken({ runId: 'run', agentId: 'root' }))
    const listed = (await plain.listTools()).tools
    assert.deepEqual(listed.map(tool => tool.name), PUBLIC_TOOLS.map(tool => tool.name))
    assert.ok(listed.every(tool => tool.inputSchema.type === 'object' && typeof tool.description === 'string' && tool.description.length))
    assert.equal(listed.find(tool => tool.name === 'read_file').annotations.readOnlyHint, true)
    assert.equal(listed.find(tool => tool.name === 'write_file').annotations.readOnlyHint, false)
    await plain.close()
    const asking = await connect(url, server.issueToken({ runId: 'run', agentId: 'root', approve: true }))
    assert.ok((await asking.listTools()).tools.some(tool => tool.name === 'approve'))
    await asking.close()
  })
  await withServer({ listTools: (token, context) => context.agentId === 'root' ? ['spawn_agent', 'wait_agent', 'nope'] : [] }, async server => {
    const { url } = await server.start()
    const root = await connect(url, server.issueToken({ runId: 'run', agentId: 'root' }))
    assert.deepEqual((await root.listTools()).tools.map(tool => tool.name), ['spawn_agent', 'wait_agent'])
    await root.close()
    const worker = await connect(url, server.issueToken({ runId: 'run', agentId: 'w1' }))
    assert.deepEqual((await worker.listTools()).tools, [])
    await worker.close()
  })
})

test('tools/call dispatches validated arguments with the token context and renders text, unread mail and errors', async () => {
  await withServer({}, async (server, calls) => {
    const { url } = await server.start()
    const token = server.issueToken({ runId: 'run-1', agentId: 'root' })
    const client = await connect(url, token)
    const saved = await client.callTool({ name: 'memory_save', arguments: { title: 'T', content: 'C', scope: null } })
    assert.equal(saved.isError, undefined)
    assert.deepEqual(JSON.parse(text(saved)), { ok: true, name: 'memory_save', args: { title: 'T', content: 'C' } })
    assert.equal(calls[0].token, token)
    assert.deepEqual(calls[0].args, { title: 'T', content: 'C' }, 'null optionals are dropped before dispatch')
    assert.equal(calls[0].context.runId, 'run-1'); assert.equal(calls[0].context.agentId, 'root')
    const mail = await client.callTool({ name: 'list_agents', arguments: {} })
    assert.equal(text(mail), `[{"id":"root"}]${UNREAD_SUFFIX(2)}`)
    assert.equal(text(await client.callTool({ name: 'read_messages', arguments: {} })), 'plain text observation')
    const failed = await client.callTool({ name: 'memory_forget', arguments: { id: 'x' } })
    assert.equal(failed.isError, true); assert.match(text(failed), /No such note/)
    const before = calls.length
    const invalid = await client.callTool({ name: 'spawn_agent', arguments: { task: 'x' } })
    assert.equal(invalid.isError, true); assert.match(text(invalid), /reason is required/)
    const unknown = await client.callTool({ name: 'launch_missiles', arguments: {} })
    assert.equal(unknown.isError, true); assert.match(text(unknown), /Unknown tool/)
    const rootOnly = await client.callTool({ name: 'improvement_plan', arguments: { status: 'planning', tasks: [{ id: '1', title: 't', status: 'done', evidence: '' }] } })
    assert.equal(rootOnly.isError, true); assert.match(text(rootOnly), /require evidence/)
    assert.equal(calls.length, before, 'invalid and unknown calls never reach dispatch')
    await client.close()
  })
})

test('the approve tool answers Claude Code permission prompts with the JSON string it expects', async () => {
  await withServer({}, async server => {
    const { url } = await server.start()
    const client = await connect(url, server.issueToken({ runId: 'run', agentId: 'root', approve: true }))
    const allow = JSON.parse(text(await client.callTool({ name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'git status' }, tool_use_id: 'toolu_1' } })))
    assert.deepEqual(allow, { behavior: 'allow', updatedInput: { command: 'git status' } })
    const updated = JSON.parse(text(await client.callTool({ name: 'approve', arguments: { tool_name: 'Write', input: { content: 'x' }, tool_use_id: 'toolu_2' } })))
    assert.deepEqual(updated, { behavior: 'allow', updatedInput: { content: 'x', file_path: 'safe.txt' } })
    const deny = JSON.parse(text(await client.callTool({ name: 'approve', arguments: { tool_name: 'Edit', input: {}, tool_use_id: 'toolu_3' } })))
    assert.deepEqual(deny, { behavior: 'deny', message: 'The user declined this operation' })
    await client.close()
  })
  await withServer({ approve: undefined }, async server => {
    const { url } = await server.start()
    const client = await connect(url, server.issueToken({ runId: 'run', agentId: 'root', approve: true }))
    assert.equal(JSON.parse(text(await client.callTool({ name: 'approve', arguments: { tool_name: 'Bash', input: {} } }))).behavior, 'deny')
    await client.close()
  })
})

test('unknown, revoked and missing tokens get 401; other paths 404; nothing leaks about the tools', async () => {
  await withServer({}, async server => {
    const { url } = await server.start()
    await assert.rejects(connect(url, 'not-a-token'), error => error.code === 401 || /401/.test(error.message))
    const token = server.issueToken({ runId: 'run', agentId: 'root' })
    const client = await connect(url, token)
    assert.ok((await client.listTools()).tools.length)
    server.revoke(token)
    await assert.rejects(client.listTools(), /401|Unauthorized/)
    await client.close().catch(() => {})
    assert.equal(server.lookup(token), null)
    const status = (target, headers = {}) => new Promise(resolve => http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, response => { response.resume(); resolve(response.statusCode) }).end('{}'))
    assert.equal(await status(url), 401)
    assert.equal(await status(url.replace('/mcp', '/other'), { Authorization: `Bearer ${server.issueToken({ runId: 'r', agentId: 'a' })}` }), 404)
  })
})

test('activity(token) shows a call in flight, and progress notifications keep a long call alive', async () => {
  await withServer({ progressMs: 20 }, async server => {
    const { url } = await server.start()
    const token = server.issueToken({ runId: 'run', agentId: 'root' })
    const client = await connect(url, token)
    let progress = 0
    const pending = client.callTool({ name: 'wait_agent', arguments: { timeout_ms: 150 } }, undefined, { onprogress: () => { progress++ } })
    await sleep(60)
    assert.equal(server.activity(token).pending, 1)
    assert.equal(text(await pending), 'waited')
    assert.equal(server.activity(token).pending, 0)
    assert.ok(server.activity(token).lastAt > Date.now() - 1000)
    assert.ok(progress >= 2, `progress notifications during the call: ${progress}`)
    assert.equal(server.activity('unknown'), null)
    await client.close()
  })
})

test('stop() drops every token and connection, and a started server never keeps a Node process alive', async () => {
  const server = createMcpServer({ dispatch: async () => 'x' })
  const { url } = await server.start()
  const token = server.issueToken({ runId: 'run', agentId: 'root' })
  const client = await connect(url, token)
  await server.stop()
  assert.equal(server.tokenCount, 0)
  assert.equal(server.url, null)
  await assert.rejects(client.listTools())
  await client.close().catch(() => {})
  await assert.rejects(server.start(), /stopped/)
  await server.stop()
  // A process that starts the server, issues a token and forgets it must still exit on its own (unref'ed server and sockets).
  const script = `const { createMcpServer } = require(${JSON.stringify(path.join(__dirname, '..', 'electron', 'mcp-server.mts'))}); (async () => { const s = createMcpServer({ dispatch: async () => 'x' }); const { url } = await s.start(); s.issueToken({ runId: 'r', agentId: 'a' }); const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' }); console.log(r.status) })()`
  const { code, stdout } = await new Promise(resolve => execFile(process.execPath, ['--experimental-strip-types', '-e', script], { timeout: 8000, windowsHide: true }, (error, out) => resolve({ code: error ? (error.killed ? 'killed' : error.code) : 0, stdout: out })))
  assert.equal(code, 0, 'the process must exit by itself once nothing else is pending')
  assert.equal(stdout.trim(), '401')
})
