const test = require('node:test')
const assert = require('node:assert/strict')
const { runCodexServer } = require('../electron/codex-server.mts')
const { _testing, terminateProcess } = require('../electron/providers.mts')
const { ORBIT_RESPONSE_SCHEMA } = require('../electron/tool-schema.mts')

const fixture = `
const readline = require('node:readline');
const send = message => console.log(JSON.stringify(message));
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start') {
    if(m.params.sandbox !== 'workspace-write' || m.params.approvalPolicy !== 'on-request') throw Error('Wrong permissions');
    send({id:m.id,result:{thread:{id:'thread-test'},model:'test-model'}});
  }
  if (m.method === 'turn/start') {
    if(m.params.effort !== 'high') throw Error('Missing effort');
    // Codex drops a line with an escaped lone surrogate and never answers; the fixture fails loudly instead.
    if(m.params.input[0].text !== m.params.input[0].text.toWellFormed()) throw Error('Lone surrogate');
    const schema = m.params.outputSchema;
    if (!schema || !schema.required.includes('tool_calls') || schema.additionalProperties !== false) throw Error('Missing strict Orbit output schema');
    const spawn = schema.properties.tool_calls.items.anyOf.find(call => call.properties.name.enum[0] === 'spawn_agent');
    if (!spawn.required.includes('arguments') || !spawn.properties.arguments.required.includes('task')) throw Error('Spawn arguments are not constrained');
    send({id:m.id,result:{turn:{id:'turn-test'}}});
    send({method:'item/reasoning/summaryTextDelta',params:{threadId:'thread-test',itemId:'thought',summaryIndex:0,delta:'Checking permissions'}});
    send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'thread-test',itemId:'command-test',command:'test command'}});
  }
  if(m.id === 900) {
    send({method:'item/completed',params:{threadId:'thread-test',item:{type:'agentMessage',id:'answer',text:'Decision: '+m.result.decision}}});
    send({method:'turn/completed',params:{threadId:'thread-test',turn:{status:'completed'}}});
  }
});
`
const helpers = code => ({ resolveLaunch: (_command, args) => {
  assert.ok(args.includes('features.multi_agent=false'), 'App Server must use Orbit delegation too')
  return { executable: process.execPath, args: ['-e', code], env: process.env }
}, terminateProcess, createLineReader: _testing.createLineReader })
for (const approved of [true, false]) test(`App Server transports effort and ${approved ? 'accepts' : 'declines'} native approval`, async () => {
  let calls = 0
  const events = []
  const result = await runCodexServer({ workspace: process.cwd(), accessMode: 'workspace-write', responseSchema: ORBIT_RESPONSE_SCHEMA, reasoningEffort: 'high', timeoutMs: 3000, prompt: 'Test', onEvent: event => events.push(event), onApproval: async request => {
    calls++
    assert.equal(request.arguments.command, 'test command')
    return approved
  } }, helpers(fixture))
  assert.equal(calls, 1)
  assert.equal(result.text, `Decision: ${approved ? 'accept' : 'decline'}`)
  assert.equal(events.find(event => event.kind === 'reasoning').text, 'Checking permissions')
})
test('App Server sends a string bounded inside an emoji well-formed', async () => {
  const result = await runCodexServer({ workspace: process.cwd(), accessMode: 'workspace-write', responseSchema: ORBIT_RESPONSE_SCHEMA, reasoningEffort: 'high', timeoutMs: 3000, prompt: 'Cut \ud83d', onApproval: async () => true }, helpers(fixture))
  assert.equal(result.text, 'Decision: accept')
})
test('App Server cancellation interrupts an unanswered approval', async () => {
  const controller = new AbortController()
  await assert.rejects(runCodexServer({ workspace: process.cwd(), accessMode: 'workspace-write', responseSchema: ORBIT_RESPONSE_SCHEMA, reasoningEffort: 'high', timeoutMs: 3000, prompt: 'Test', signal: controller.signal, onApproval: () => {
    controller.abort()
    return new Promise(() => {})
  } }, helpers(fixture)), /cancelled/)
})
test('App Server refuses early process exit', async () => {
  await assert.rejects(runCodexServer({ workspace: process.cwd(), timeoutMs: 3000 }, helpers('process.exit(0)')), /closed before completion/)
})

// Token usage: the v2 protocol's turn/completed has no usage; `thread/tokenUsage/updated` carries the thread's total and
// the latest model call (checked against codex-cli 0.155), and the server replays it right after thread/resume.
const usageFixture = `
const readline = require('node:readline');
const send = message => console.log(JSON.stringify(message));
const tokens = (input, cached, output) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
let thread = '', calls = 0, turns = 0, total = { input: 0, cached: 0, output: 0 };
const update = (turnId, call) => {
  total = { input: total.input + call[0], cached: total.cached + call[1], output: total.output + call[2] };
  const message = { method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId, tokenUsage: { total: tokens(total.input, total.cached, total.output), last: tokens(...call) } } };
  send(message);
  return message;
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') { thread = 'thread-usage-a'; send({ id: m.id, result: { thread: { id: thread }, model: 'test-model' } }); }
  if (m.method === 'thread/resume') {
    thread = m.params.threadId; total = { input: 9000, cached: 900, output: 90 };
    send({ id: m.id, result: { thread: { id: thread }, model: 'test-model' } });
    if (thread.includes('replay')) send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: 'turn-old', tokenUsage: { total: tokens(9000, 900, 90), last: tokens(5000, 500, 50) } } });
  }
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turns), prompt = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turnId, status: 'inProgress' } } });
    let last;
    for (let call = 0; call < (prompt.includes('two calls') ? 2 : 1); call++) { const n = ++calls; last = update(turnId, [1000 * n, 100 * n, 10 * n]); }
    if (prompt.includes('repeat')) send(last);
    send({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', id: 'a' + turns, text: 'answer ' + turns } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } });
  }
});
`
test('App Server counts each model call once, and the replay after thread/resume only sets the start', async t => {
  const { runCodexSessionTurn, closeAllSessions } = require('../electron/codex-server.mts')
  t.after(() => closeAllSessions())
  const turn = async (session, prompt) => {
    const events = []
    await runCodexSessionTurn({ workspace: process.cwd(), accessMode: 'workspace-write', timeoutMs: 5000, prompt, onEvent: event => events.push(event), onApproval: async () => false },
      { id: null, resume: false, mcpUrl: null, token: null, systemAppend: '', activity: null, ...session }, helpers(usageFixture))
    return events.filter(event => event.kind === 'usage').map(event => event.usage).reduce((sum, usage) => ({ input_tokens: sum.input_tokens + usage.input_tokens, cached_input_tokens: sum.cached_input_tokens + usage.cached_input_tokens, output_tokens: sum.output_tokens + usage.output_tokens }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })
  }
  const figures = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output })
  // A new thread: two model calls in the turn (1000 and 2000 input tokens), the last update sent twice.
  assert.deepEqual(await turn({}, 'two calls, repeat'), figures(3000, 300, 30))
  // The next turn in the live process: the third call.
  assert.deepEqual(await turn({ id: 'thread-usage-a', resume: true }, 'one call'), figures(3000, 300, 30))
  // A new process resumes a thread of 9000 input tokens and replays that total first: only the new call counts.
  await closeAllSessions()
  assert.deepEqual(await turn({ id: 'thread-usage-replay', resume: true }, 'one call'), figures(1000, 100, 10))
  // A server that does not replay: a thread this process has not seen counts the latest model call, not its total.
  await closeAllSessions()
  assert.deepEqual(await turn({ id: 'thread-usage-unseen', resume: true }, 'one call'), figures(1000, 100, 10))
})
