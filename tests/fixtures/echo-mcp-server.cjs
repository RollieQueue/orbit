// A tiny stdio MCP server for the connector tests: newline-delimited JSON-RPC on stdin/stdout.
// It answers initialize and tools/list (two tools; paging when FIXTURE_PAGES=1) and tools/call for `echo`.
//   FIXTURE_FAIL=1     writes FIXTURE_SECRET to stderr and exits 3 at once (a server that cannot start)
//   FIXTURE_SILENT=1   never answers (a server that hangs)
//   FIXTURE_LOG=1      writes a non-JSON log line to stdout before every answer (servers do)
const readline = require('node:readline')

if (process.env.FIXTURE_FAIL) {
  process.stderr.write(`cannot start: token ${process.env.FIXTURE_SECRET || ''} was rejected\n`)
  process.exit(3)
}
const TOOLS = [
  { name: 'echo', description: 'Echoes its text argument back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'env_value', description: 'Returns the value of FIXTURE_SECRET.', inputSchema: { type: 'object', properties: {} } },
]
const send = message => process.stdout.write(`${process.env.FIXTURE_LOG ? 'log: about to answer\n' : ''}${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (process.env.FIXTURE_SILENT || !line.trim()) return
  const message = JSON.parse(line)
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture-echo', version: '1.0.0' } } })
  if (message.method === 'tools/list') {
    if (process.env.FIXTURE_PAGES) return send({ id: message.id, result: message.params?.cursor ? { tools: [TOOLS[1]] } : { tools: [TOOLS[0]], nextCursor: 'page-2' } })
    return send({ id: message.id, result: { tools: TOOLS } })
  }
  if (message.method === 'tools/call') {
    const text = message.params?.name === 'env_value' ? String(process.env.FIXTURE_SECRET || '') : String(message.params?.arguments?.text ?? '')
    return send({ id: message.id, result: { content: [{ type: 'text', text }] } })
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
})
