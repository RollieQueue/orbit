// A stand-in for the OpenAI Responses API: logs every request body to LOG (JSONL) and answers with one assistant
// message over SSE, so a real Codex CLI can be run against it without spending quota. Prints the port on stdout.
const http = require('node:http')
const fs = require('node:fs')
const log = process.env.LOG || 'requests.jsonl'
let count = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body) } catch { parsed = body.slice(0, 2000) }
    fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, body: parsed }) + '\n')
    if (req.method !== 'POST' || !/\/responses$/.test(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}') }
    const id = `resp_${++count}`
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${count}`, content: [{ type: 'output_text', text: `fake answer ${count}` }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
})
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => { console.log(server.address().port) })
