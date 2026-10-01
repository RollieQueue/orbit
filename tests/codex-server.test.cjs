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
