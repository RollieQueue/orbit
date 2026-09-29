const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildArgs, createParser, parseModels, run, inspect, cursorEffortModel, cursorReasoningModels, cursorLaunch } = require('../electron/subscription-providers.mts')
const { ORBIT_RESPONSE_SCHEMA } = require('../electron/tool-schema.mts')
const { TOOL_HANDOFF } = require('../electron/tool-schema.mts')

for (const calls of [[], [{ id: 'read', name: 'context_read', arguments: {} }]]) test(`Antigravity hands off the first completed schema response (${calls.length} calls)`, () => {
  const events = [], parser = createParser('antigravity', event => events.push(event), 'fixture', ORBIT_RESPONSE_SCHEMA)
  const text = JSON.stringify({ content: 'Привет, мир', tool_calls: calls })
  const step = (index, state, delta) => JSON.stringify({ event: 'step_update', step_update: { step_index: index, step_type: 'agent_response', state, text_delta: delta, ...(state === 'DONE' ? { usage: { input_tokens: 3 } } : {}) } })
  parser.line(step(1, 'ACTIVE', 'progress'))
  parser.line(step(1, 'DONE', ''))
  assert.equal(parser.line(step(3, 'ACTIVE', text)), undefined, 'valid JSON is insufficient until the step is done')
  assert.equal(parser.line(step(3, 'DONE', '\n')), TOOL_HANDOFF)
  parser.line(step(5, 'DONE', JSON.stringify({ content: 'must not replace', tool_calls: [] })))
  assert.equal(parser.finish().text, text + '\n')
  assert.equal(parser.finish().usage.input_tokens, 6)
  assert.deepEqual([...new Set(events.map(event => event.messageId))], ['1', '3'])
})

test('Antigravity ignores repeated step completion and never hands off tools, malformed JSON or a failed result', () => {
  const events = [], parser = createParser('antigravity', event => events.push(event), '', ORBIT_RESPONSE_SCHEMA)
  const send = step_update => parser.line(JSON.stringify({ event: 'step_update', step_update }))
  const text = JSON.stringify({ content: 'bad', tool_calls: [{ id: 'x', name: 'unknown', arguments: {} }] })
  const invalid = { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: text }
  assert.equal(send(invalid), undefined)
  send(invalid)
  assert.equal(events.length, 1)
  assert.equal(send({ ...invalid, step_index: 2, step_type: 'tool', text_delta: '{"content":"tool text","tool_calls":[]}' }), undefined)
  assert.equal(send({ ...invalid, step_index: 3, text_delta: '{"content":' }), undefined)
  parser.line(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'failed' } }))
  assert.throws(() => parser.finish(), /failed/)
})

test('subscription arguments respect full access and retain restrictions for Ask and read-only', () => {
  const cursor = buildArgs('cursor', { model: 'composer-fixture', accessMode: 'danger-full-access' })
  assert.ok(!cursor.includes('--mode')); assert.ok(cursor.includes('--force'))
  assert.equal(cursor[cursor.indexOf('--sandbox') + 1], 'disabled')
  for (const options of [{ accessMode: 'read-only' }, { accessMode: 'workspace-write' }, { accessMode: 'danger-full-access', approvalPolicy: 'on-request' }, { accessMode: 'danger-full-access', approvalPolicy: 'auto-review' }]) {
    const args = buildArgs('cursor', options)
    assert.equal(args[args.indexOf('--mode') + 1], 'ask'); assert.ok(!args.includes('--force'))
  }
  const agy = buildArgs('antigravity', { model: 'gemini-fixture', reasoningEffort: 'low' })
  assert.ok(agy.includes('orbit-transport')); assert.ok(agy.includes('gemini-fixture')); assert.ok(!agy.includes('--dangerously-skip-permissions'))
  assert.ok(!agy.includes('--effort'), 'Google models must not receive a reasoning CLI flag')
  assert.doesNotThrow(() => buildArgs('antigravity', { reasoningEffort: 'xhigh' }))
})

test('Cursor reasoning selects only advertised variants, preserving fast/thinking suffixes', () => {
  const models = ['fixture-high', 'fixture-low', 'fixture-high-fast', 'fixture-low-fast', 'legacy-extra-high', 'legacy-low', 'auto']
  assert.equal(cursorEffortModel('fixture-high-fast', 'low', models), 'fixture-low-fast')
  assert.equal(cursorEffortModel('legacy-low', 'xhigh', models), 'legacy-extra-high')
  assert.deepEqual(cursorReasoningModels(models).auto, {})
  assert.throws(() => cursorEffortModel('fixture-high', 'max', models), /Cursor/)
  const args = buildArgs('cursor', { model: 'fixture-high', reasoningEffort: 'low', availableModels: models })
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-low')
  assert.deepEqual(parseModels('gemini-fixture\tGemini fixture'), ['gemini-fixture'])
})

test('a saved Cursor level is dropped for a model without variants and still refused where variants exist', () => {
  const models = ['auto', 'fixture-high', 'fixture-low']
  assert.deepEqual(cursorLaunch('auto', 'high', models), { model: 'auto', dropped: 'high' })
  assert.deepEqual(cursorLaunch('', 'high', models), { model: '', dropped: 'high' }, 'the CLI default model has no variants either')
  assert.deepEqual(cursorLaunch('auto', '', models), { model: 'auto' })
  assert.deepEqual(cursorLaunch('fixture-high', 'low', models), { model: 'fixture-low' })
  assert.throws(() => cursorLaunch('fixture-high', 'max', models), /Cursor: уровень max недоступен для fixture-high/)
  assert.deepEqual(buildArgs('cursor', { model: 'auto', reasoningEffort: 'high', availableModels: models }).slice(-2), ['--model', 'auto'])
})

test('Cursor run on a model without variants ignores the saved level, reports it and keeps the run alive', async () => {
  const providerOptions = { command: 'cursor-level-fixture' }
  const turn = async (model, reasoningEffort) => {
    const events = []; let launched
    const result = await run('cursor', { prompt: 'Hi', workspace: process.cwd(), model, reasoningEffort, providerOptions, onEvent: event => events.push(event) }, { runCli: async (_, args, options) => {
      if (args[0] === '--list-models') { for (const line of ['auto - Automatic', 'fixture-high  Fixture', 'fixture-low  Fixture']) options.onLine(line); return { stdout: '' } }
      launched = args
      options.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }))
    } })
    return { result, events, model: launched[launched.indexOf('--model') + 1] }
  }
  const auto = await turn('auto', 'high')
  assert.equal(auto.model, 'auto')
  assert.equal(auto.result.reasoningEffort, '', 'the level that really ran is reported')
  assert.ok(auto.events.some(event => event.kind === 'observation' && /уровень high не применён/.test(event.text)), 'the dropped level is visible in the trace')
  const chosen = await turn('fixture-high', 'low')
  assert.equal(chosen.model, 'fixture-low')
  assert.equal(chosen.result.reasoningEffort, undefined, 'an applied level is not restated')
  assert.ok(!chosen.events.some(event => event.kind === 'observation'))
  await assert.rejects(turn('fixture-high', 'max'), /Cursor: уровень max недоступен для fixture-high/)
})

test('Google discovery and inference receive the same explicit proxy without changing process environment', async () => {
  const previous = process.env.HTTPS_PROXY
  const providerOptions = { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:12334' }
  const runCli = async (_, args, options) => {
    assert.equal(options.env.HTTPS_PROXY, providerOptions.proxyUrl)
    assert.ok(!args.includes('--effort'), 'Google inference must not receive a reasoning CLI flag')
    if (args[0] === 'models') { assert.deepEqual(args, ['models']); return { stdout: 'fixture-model\tFixture' } }
    if (args[0] !== '--version') options.onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }))
    return { stdout: 'version' }
  }
  const health = await inspect('antigravity', { runCli }, providerOptions)
  assert.deepEqual(health.models, ['fixture-model'])
  assert.deepEqual(health.reasoningLevels, {}, 'Google discovery must not advertise reasoning choices')
  await run('antigravity', { prompt: 'test', providerOptions, reasoningEffort: 'max' }, { runCli })
  assert.equal(process.env.HTTPS_PROXY, previous)
})
for (const id of ['cursor', 'antigravity']) test(`${id} parser accepts only successful terminal output and records usage`, () => {
  const parser = createParser(id, () => {}, 'fixture')
  const result = { content: 'Finished', tool_calls: [] }
  parser.line(JSON.stringify(id === 'cursor' ? { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result), usage: { input_tokens: 10 } } : { event: 'result', result: { status: 'SUCCESS', structured_output: result, usage: { input_tokens: 10 } } }))
  assert.deepEqual(JSON.parse(parser.finish().text), result); assert.equal(parser.finish().usage.input_tokens, 10)
  assert.throws(() => createParser(id).finish(), /without a successful result/)
  const failed = createParser(id)
  failed.line(JSON.stringify(id === 'cursor' ? { type: 'result', subtype: 'error', is_error: true, result: 'quota exhausted' } : { event: 'result', result: { status: 'ERROR', error: 'quota exhausted' } }))
  assert.throws(() => failed.finish(), /quota exhausted/)
})
test('Antigravity transport supplies schema, tool-free agent and literal stdin, then cleans up', async () => {
  let directory
  const prompt = 'Literal Unicode: Привет. $() ` & < > '.repeat(1000)
  const result = await run('antigravity', { prompt, model: 'fixture', responseSchema: ORBIT_RESPONSE_SCHEMA, providerOptions: { command: 'custom-agy' }, timeoutMs: null }, { runCli: async (command, args, options) => {
    assert.equal(command, 'custom-agy'); directory = options.cwd
    assert.equal(JSON.parse(options.input).message.content, prompt)
    assert.match(fs.readFileSync(path.join(directory, '.agents', 'agents', 'orbit-transport.md'), 'utf8'), /tools: \[\]/)
    assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8')), ORBIT_RESPONSE_SCHEMA)
    options.onLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"content":"Done","tool_calls":[]}' } }))
  } })
  assert.equal(result.providerId, 'antigravity'); assert.equal(fs.existsSync(directory), false)
})
test('Cursor transport sends long prompts through stdin and configured executable', async () => {
  const prompt = 'literal '.repeat(10000)
  await run('cursor', { prompt, workspace: process.cwd(), providerOptions: { command: 'custom-cursor' } }, { runCli: async (command, args, options) => {
    assert.equal(command, 'custom-cursor'); assert.equal(options.input, prompt); assert.ok(!args.includes(prompt))
    options.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }))
  } })
})
test('model discovery parses machine output and text slugs without invented defaults', async () => {
  assert.deepEqual(parseModels('{"models":[{"id":"gemini-fixture"},{"slug":"claude-fixture"}]}'), ['gemini-fixture', 'claude-fixture'])
  assert.deepEqual(parseModels('Available models\nauto - Automatic\ncomposer-fixture  Composer\n'), ['auto', 'composer-fixture'])
  const health = await inspect('cursor', { runCli: async (_, args, options) => {
    if (args[0] === 'status') return { stdout: '{"authenticated":false}' }
    if (args[0] === '--list-models') options.onLine('composer-fixture  Composer')
    return { stdout: 'version' }
  } })
  assert.equal(health.available, false); assert.deepEqual(health.models, ['composer-fixture'])
})

test('missing Cursor CLI explains the separate installation; launch errors keep their cause', async () => {
  const missing = await inspect('cursor', { runCli: async () => { throw Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' }) } })
  assert.equal(missing.installed, false)
  assert.equal(missing.available, false)
  assert.match(missing.detail, /Cursor IDE и Cursor CLI устанавливаются отдельно/)
  const broken = await inspect('cursor', { runCli: async () => { throw new Error('Cannot safely launch custom-agent') } })
  assert.equal(broken.available, false)
  assert.match(broken.detail, /Cannot safely launch custom-agent/)
  assert.doesNotMatch(broken.detail, /не найден/)
})

const regionError = 'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.'
for (const isAuthenticated of [false, true]) test(`Cursor reads the official isAuthenticated status: ${isAuthenticated}`, async () => {
  const health = await inspect('cursor', { runCli: async (_, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify({ isAuthenticated }) }
    if (args[0] === '--list-models') return { stdout: 'composer-fixture  Composer' }
    return { stdout: '2026.09.26-dd393fe' }
  } })
  assert.equal(health.authenticated, isAuthenticated)
  assert.equal(health.available, isAuthenticated)
  assert.deepEqual(health.models, ['composer-fixture'])
})

for (const source of ['version', 'models', 'stderr']) test(`Antigravity regional refusal from ${source} is unavailable`, async () => {
  const health = await inspect('antigravity', { runCli: async (_, args) => {
    if (source === 'version' || (source === 'models' && args[0] === 'models')) throw new Error(regionError)
    return { stdout: '', stderr: args[0] === 'models' ? regionError : '' }
  } })
  assert.equal(health.installed, true)
  assert.equal(health.available, false)
  assert.match(health.detail, /Google отклонил доступ.*по региону/)
  assert.match(health.detail, /country-association-form/)
})

test('ordinary model discovery failures still allow manual model selection', async () => {
  const health = await inspect('antigravity', { runCli: async (_, args) => {
    if (args[0] === 'models') throw new Error('Unknown option --json')
    return { stdout: '1.0' }
  } })
  assert.equal(health.available, true)
  assert.deepEqual(health.models, [])
})

test('Antigravity runtime explains regional rejection and cleans its temporary workspace', async () => {
  let directory
  await assert.rejects(run('antigravity', { prompt: 'Hello' }, { runCli: async (_, args, options) => {
    directory = options.cwd
    throw new Error(regionError)
  } }), error => error.message.includes('по региону') && error.message.includes(regionError))
  assert.equal(fs.existsSync(directory), false)
})
