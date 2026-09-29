const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider, _testing, terminateProcess } = require('../electron/providers.mts')
const { runCodexServer } = require('../electron/codex-server.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { ORBIT_RESPONSE_SCHEMA } = require('../electron/tool-schema.mts')

const envelope = JSON.stringify({ content: 'Starting audits', tool_calls: Array.from({ length: 8 }, (_, i) => ({
  id: `spawn-${i}`, name: 'spawn_agent', arguments: { name: `Audit-${i}`, task: 'Return one finding', reason: 'Independent audit', providerId: null, model: null },
})) })
const completed = text => ({ type: 'item.completed', item: { id: 'message', type: 'agent_message', phase: 'commentary', text } })
const late = JSON.stringify({ content: 'I launched eight audits (unverified)', tool_calls: [] })

test('completed commentary transfers the first tool batch; later claims cannot overwrite it', () => {
  const events = []
  const parser = _testing.createCodexParser(event => events.push(event), 'fixture', ORBIT_RESPONSE_SCHEMA)
  parser.line(JSON.stringify(completed(envelope)))
  parser.line(JSON.stringify(completed(late)))
  parser.line(JSON.stringify({ type: 'turn.completed' }))
  assert.equal(parser.finish().text, envelope)
  assert.equal(events.filter(event => event.kind === 'output').length, 1)
})

test('partial messages, native outputs, reasoning and invalid schemas never cause a handoff', () => {
  const invalid = JSON.parse(envelope); invalid.tool_calls[0].arguments.task = 123
  const unknown = JSON.parse(envelope); unknown.tool_calls[0].name = 'unknown'
  const cases = [
    { ...completed(envelope), type: 'item.updated' },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: envelope } },
    { type: 'item.completed', item: { type: 'reasoning', text: envelope } },
    completed(JSON.stringify(invalid)), completed(JSON.stringify(unknown)),
    completed(`Example: ${envelope}`), completed(envelope.slice(0, -1)), completed(late),
  ]
  for (const event of cases) {
    const parser = _testing.createCodexParser(null, '', ORBIT_RESPONSE_SCHEMA)
    assert.equal(parser.line(JSON.stringify(event)), undefined)
    assert.throws(() => parser.finish(), /without a completed turn/)
  }
  const ordinary = _testing.createCodexParser()
  ordinary.line(JSON.stringify(completed(envelope)))
  assert.throws(() => ordinary.finish(), /without a completed turn/)
})

test('commentary may omit unused nullable arguments, but not the delegation task', () => {
  const value = JSON.parse(envelope)
  for (const call of value.tool_calls) { delete call.arguments.providerId; delete call.arguments.model }
  const parser = _testing.createCodexParser(null, '', ORBIT_RESPONSE_SCHEMA)
  parser.line(JSON.stringify(completed(JSON.stringify(value))))
  assert.equal(parser.finish().text, JSON.stringify(value))
  delete value.tool_calls[0].arguments.task
  const invalid = _testing.createCodexParser(null, '', ORBIT_RESPONSE_SCHEMA)
  invalid.line(JSON.stringify(completed(JSON.stringify(value))))
  assert.throws(() => invalid.finish(), /without a completed turn/)
})

test('CLI kills a yielding process and ignores remaining lines in the same chunk', async () => {
  const events = []
  const parser = _testing.createCodexParser(event => events.push(event), '', ORBIT_RESPONSE_SCHEMA)
  let pid
  const lines = [completed(envelope), completed(late), { type: 'turn.completed' }].map(JSON.stringify).join('\n') + '\n'
  await _testing.runCli(process.execPath, ['-e', `console.log(JSON.stringify({pid:process.pid})); process.stdout.write(${JSON.stringify(lines)}); setInterval(()=>{},1000)`], {
    timeoutMs: 3000, onLine: line => { const value = JSON.parse(line); if (value.pid) { pid = value.pid; return }; return parser.line(line) },
  })
  assert.equal(parser.finish().text, envelope)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(events.some(event => event.text?.includes('unverified')), false)
})

test('cancellation during CLI handoff cleanup remains cancellation', async () => {
  const controller = new AbortController()
  const parser = _testing.createCodexParser(null, '', ORBIT_RESPONSE_SCHEMA)
  await assert.rejects(_testing.runCli(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify(completed(envelope)))}); setInterval(()=>{},1000)`], {
    timeoutMs: 3000, signal: controller.signal,
    onLine: line => { const result = parser.line(line); queueMicrotask(() => controller.abort()); return result },
  }), { name: 'AbortError' })
})

for (const provider of ['antigravity', 'claude']) test(`${provider} stops its CLI at the completed Orbit tool envelope`, async () => {
  const parser = provider === 'antigravity'
    ? require('../electron/subscription-providers.mts').createParser(provider, null, '', ORBIT_RESPONSE_SCHEMA)
    : _testing.createClaudeParser(null, '', ORBIT_RESPONSE_SCHEMA)
  const message = text => provider === 'antigravity'
    ? { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', text_delta: text } }
    : { type: 'assistant', message: { id: 'a', content: [{ type: 'text', text }] } }
  const lines = [message(envelope), message(late)].map(JSON.stringify).join('\n') + '\n'
  let pid
  await _testing.runCli(process.execPath, ['-e', `console.log(JSON.stringify({pid:process.pid})); process.stdout.write(${JSON.stringify(lines)}); setInterval(()=>{},1000)`], {
    timeoutMs: 3000, onLine: line => { const event = JSON.parse(line); if (event.pid) { pid = event.pid; return }; return parser.line(line) },
  })
  assert.equal(parser.finish().text, envelope)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('real CLI transport creates all eight runtime nodes before the final answer', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-handoff-test-'))
  const previous = process.env.ORBIT_CODEX_COMMAND
  let runtime, runId
  t.after(async () => {
    if (previous === undefined) delete process.env.ORBIT_CODEX_COMMAND
    else process.env.ORBIT_CODEX_COMMAND = previous
    if (runId) { runtime.stop(runId); await Promise.allSettled([...runtime.runs.get(runId).tasks.values()]) }
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    assert.ok(path.basename(workspace).startsWith('orbit-handoff-test-'))
    fs.rmSync(workspace, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(workspace, 'codex.cmd'), '@"node" "%~dp0\\fixture.cjs" %*')
  fs.writeFileSync(path.join(workspace, 'fixture.cjs'), `
    const fs = require('node:fs'); let prompt = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', part => prompt += part);
    process.stdin.on('end', () => {
      const root = /Agent: Orbit;/.test(prompt);
      const marker = 'root-called';
      const first = root && !fs.existsSync(marker);
      if (first) fs.writeFileSync(marker, 'yes');
      const answer = first ? ${JSON.stringify(envelope)} : JSON.stringify({content: root ? 'All audit results received' : 'Independent finding', tool_calls: []});
      const messages = [{type:'item.completed',item:{id:'a',type:'agent_message',phase: first ? 'commentary' : 'final_answer',text:answer}}];
      if(first) messages.push(${JSON.stringify(completed(late))});
      else messages.push({type:'turn.completed'});
      process.stdout.write(messages.map(JSON.stringify).join('\\n')+'\\n');
      if(first) setInterval(()=>{},1000);
    });
  `)
  process.env.ORBIT_CODEX_COMMAND = path.join(workspace, 'codex.cmd')
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  // The tool handoff is the envelope protocol's mechanism; the session transport (the default for a real Codex) never kills a process at a tool call.
  runtime = new OrbitRuntime({ runProvider, transportFor: () => 'envelope' })
  runtime.onEvent(event => { events.push(event); if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  runId = await runtime.start({ workspace, providerId: 'codex', prompt: 'Audit with eight participants', memoryEnabled: false,
    limits: { maxAgents: 9, maxConcurrent: 8, timeoutMs: 5000, runTimeoutMs: 15000 } })
  const result = await terminal
  assert.equal(result.type, 'run.finished', JSON.stringify(result))
  const snapshot = runtime.getRun(runId)
  assert.equal(snapshot.agents.length, 9)
  assert.equal(events.filter(event => event.type === 'agent.created').length, 9)
  assert.ok(snapshot.agents.every(agent => agent.status === 'done'))
  assert.equal(snapshot.summary.text, 'All audit results received')
  assert.equal(snapshot.traces.some(trace => trace.text?.includes('unverified')), false)
})

for (const cancel of [false, true]) test(`App Server hands off commentary and stops before later messages, cancel=${cancel}`, async () => {
  const controller = new AbortController()
  let pid
  const code = `
    const send = message => console.log(JSON.stringify(message));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if(m.id === undefined) return;
      send({id:m.id,result:m.method === 'thread/start' ? {thread:{id:'thread'}} : {}});
      if(m.method === 'turn/start') {
        send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',phase:'commentary',text:${JSON.stringify(envelope)}}}});
        send({method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',phase:'final_answer',text:${JSON.stringify(late)}}}});
        send({method:'turn/completed',params:{threadId:'thread',turn:{status:'completed'}}});
      }
    });
  `
  const result = runCodexServer({ workspace: process.cwd(), responseSchema: ORBIT_RESPONSE_SCHEMA, timeoutMs: 3000, signal: controller.signal }, {
    resolveLaunch: () => ({ executable: process.execPath, args: ['-e', code], env: process.env }),
    createLineReader: _testing.createLineReader,
    terminateProcess: async child => { pid = child.pid; if (cancel) controller.abort(); await terminateProcess(child) },
  })
  if (cancel) await assert.rejects(result, /cancelled/)
  else assert.equal((await result).text, envelope)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
