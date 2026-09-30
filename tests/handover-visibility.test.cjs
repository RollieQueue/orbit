const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { modelsWorked, ranOnFields, agentDirectory } = require('../electron/runtime/agents.mts')
const { evaluationReminder } = require('../electron/runtime/prompts.mts')

const ASTRA = { providerId: 'codex', model: 'gpt-6-astra' }, GEMINI = { providerId: 'antigravity', model: 'gemini-3.1-pro-high' }, CURSOR = { providerId: 'cursor', model: 'auto' }, SONNET = { providerId: 'claude', model: 'sonnet' }
const move = (from, to, extra = {}) => ({ id: 'h', time: 't', reason: 'exhausted', from, to, fresh: false, usedPercent: 100, resetsAt: null, interrupted: false, ...extra })
const agentOn = (current, handovers = []) => ({ ...current, handovers })

// ---- modelsWorked -------------------------------------------------------------------------------------------------

test('an agent that never switched worked on its one model', () => {
  assert.deepEqual(modelsWorked(agentOn(ASTRA)), [{ label: 'codex/gpt-6-astra', ...ASTRA }])
  assert.deepEqual(ranOnFields(agentOn(ASTRA)), {})
})

test('a real handover lists both models with the turns each one took', () => {
  const agent = agentOn(GEMINI, [move(ASTRA, GEMINI, { turn: 3 })])
  assert.deepEqual(modelsWorked(agent).map(item => [item.label, item.turns]), [['codex/gpt-6-astra', 'turns 1–3'], ['antigravity/gemini-3.1-pro-high', 'turns 4–']])
  const fields = ranOnFields(agent)
  assert.deepEqual(fields.ranOn, ['codex/gpt-6-astra (turns 1–3)', 'antigravity/gemini-3.1-pro-high (turns 4–)'])
  assert.equal(fields.switched, 'codex/gpt-6-astra → antigravity/gemini-3.1-pro-high after turn 3 (exhausted)')
  assert.deepEqual(modelsWorked(agentOn(GEMINI, [move(ASTRA, GEMINI, { turn: 1 })])).map(item => item.turns), ['turn 1', 'turns 2–'])
})

test('records without a turn number list the models without ranges', () => {
  assert.deepEqual(modelsWorked(agentOn(GEMINI, [move(ASTRA, GEMINI)])).map(item => [item.label, item.turns]), [['codex/gpt-6-astra', undefined], ['antigravity/gemini-3.1-pro-high', undefined]])
})

test('a model that was switched away from before it did anything is not credited', () => {
  const agent = agentOn(SONNET, [move(CURSOR, SONNET, { fresh: true, turn: 0, reason: 'replacement-failed' })])
  assert.deepEqual(modelsWorked(agent).map(item => [item.label, item.turns]), [['claude/sonnet', 'turns 1–']])
  assert.deepEqual(ranOnFields(agent), {}, 'nothing to disambiguate')
  const chain = agentOn(GEMINI, [move(CURSOR, ASTRA, { fresh: true, turn: 0 }), move(ASTRA, GEMINI, { turn: 2 })])
  assert.deepEqual(modelsWorked(chain).map(item => [item.label, item.turns]), [['codex/gpt-6-astra', 'turns 1–2'], ['antigravity/gemini-3.1-pro-high', 'turns 3–']])
})

test('a model the agent returns to is one entry when nothing else worked in between', () => {
  const agent = agentOn(ASTRA, [move(ASTRA, GEMINI, { fresh: true, turn: 0 }), move(GEMINI, ASTRA, { fresh: true, turn: 0 })])
  assert.deepEqual(modelsWorked(agent).map(item => [item.label, item.turns]), [['codex/gpt-6-astra', 'turns 1–']])
})

test('the directory names the models that worked only after a switch', () => {
  const run = { limits: { maxOutputChars: 40000 }, agentNodes: new Map([['a', { id: 'a', name: 'A', task: 't', result: '', status: 'done', generation: 0, ...agentOn(GEMINI, [move(ASTRA, GEMINI, { turn: 3 })]) }], ['b', { id: 'b', name: 'B', task: 't', result: '', status: 'done', generation: 0, ...agentOn(ASTRA) }]]) }
  const [a, b] = agentDirectory(null, run)
  assert.deepEqual(a.ranOn, ['codex/gpt-6-astra', 'antigravity/gemini-3.1-pro-high'])
  assert.equal(a.model, 'gemini-3.1-pro-high')
  assert.ok(!('ranOn' in b))
})

test('the evaluation reminder asks for the model only when several worked', () => {
  const text = evaluationReminder([{ id: 'a', ...agentOn(GEMINI, [move(ASTRA, GEMINI, { turn: 3 })]) }, { id: 'b', ...agentOn(ASTRA) }])
  const [a, b] = JSON.parse(text.match(/\[\{.*\}\]/)[0])
  assert.deepEqual(a.ranOn, ['codex/gpt-6-astra', 'antigravity/gemini-3.1-pro-high'])
  assert.match(a.hint, /pass model/)
  assert.ok(!('ranOn' in b) && !('hint' in b))
})

// ---- through the runtime ------------------------------------------------------------------------------------------

const w = used => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null })
const CATALOG = [
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-6-sol'] },
  { id: 'claude', available: true, models: ['sonnet', 'opus'] },
]
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
function world(t, usage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-handover-visibility-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = { ...quota.readers }
  for (const id of ['codex', 'claude']) quota.readers[id] = async () => ({ windows: usage[id] || [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const monitor = new quota.QuotaMonitor(), memory = new OrbitMemoryStore(path.join(root, 'store'))
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace)
  return { monitor, memory, workspace, runtime: run => new OrbitRuntime({ runProvider: run, quota: monitor, catalog: async () => CATALOG, memoryStore: memory }) }
}
async function finished(runtime, payload) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); off()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return runtime.getRun(runId)
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'claude', model: 'opus', prompt: 'Current task', providerPool: [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex', model: 'gpt-6-sol' }], ...extra })
// Tool results reach the next prompt as JSON inside JSON.
const unescape = text => text.replaceAll('\\"', '"')
const assessments = (memory, workspace) => memory.list(workspace).filter(entry => entry.id.startsWith('model-'))
const evaluate = extra => tool('model_evaluate', { agentId: 'Helper', taskType: 'code', assessment: 'Wrote the parser', evidence: 'Ran the tests myself', ...extra })

test('after a real switch wait_agent and model_evaluate say which model did what', async t => {
  const { runtime, monitor, memory, workspace } = world(t, { codex: [w(40)], claude: [w(10)] })
  const rootPrompts = []
  let rootTurn = 0
  const run = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Helper') {
      if (options.providerId === 'codex') { monitor.ingest('codex', { windows: [w(96)] }); return response(tool('list_files')) }
      return { text: 'helper finished the report' }
    }
    rootPrompts.push(options.prompt)
    switch (++rootTurn) {
      case 1: return response(tool('spawn_agent', { name: 'Helper', task: 'Write the parser', reason: 'Independent work', providerId: 'codex', model: 'gpt-6-sol' }), tool('wait_agent'))
      case 2: return response(evaluate())
      case 3: return response(evaluate({ model: 'antigravity/gemini' }))
      case 4: return response(evaluate({ model: 'codex/gpt-6-sol' }))
      default: return { text: 'Reviewed' }
    }
  }), payload(workspace))
  assert.equal(run.status, 'completed')
  const helper = run.agents.find(agent => agent.name === 'Helper')
  assert.deepEqual([helper.handovers.length, helper.handovers[0].fresh, helper.handovers[0].turn], [1, false, 1])
  assert.deepEqual(modelsWorked(helper).map(item => item.label), ['codex/gpt-6-sol', 'claude/opus'])
  // wait_agent: the models come before the result
  const waited = unescape(rootPrompts[1])
  assert.ok(waited.includes('"providerId":"claude","model":"opus","ranOn":["codex/gpt-6-sol (turn 1)","claude/opus (turns 2–)"],"switched":"codex/gpt-6-sol → claude/opus after turn 1 (approaching)","result"'), waited.slice(waited.indexOf('"generation"'), waited.indexOf('"generation"') + 400))
  // model_evaluate: no model, a model that did no work, then the right one
  assert.match(rootPrompts[2], /ran on several models: codex\/gpt-6-sol \(turn 1\), claude\/opus \(turns 2–\)\. Pass model: "<provider>\/<model>"/)
  assert.match(rootPrompts[3], /did not run on model "antigravity\/gemini"/)
  const [record, ...rest] = assessments(memory, workspace)
  assert.equal(rest.length, 0)
  assert.equal(record.title, 'Model: codex/gpt-6-sol — code')
  const observation = JSON.parse(record.content.split('\n')[0])
  assert.deepEqual([observation.provider, observation.model, observation.ranOn], ['codex', 'gpt-6-sol', ['codex/gpt-6-sol', 'claude/opus']])
  assert.equal(run.agents.find(agent => agent.id === 'root').handovers.length, 0)
})

test('a worker that switched before doing anything is credited to the model that did the work, without a model argument', async t => {
  const { runtime, memory, workspace } = world(t, { codex: [w(96)], claude: [w(10)] })
  const rootPrompts = []
  let rootTurn = 0
  const run = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Helper') return { text: 'helper done' }
    rootPrompts.push(options.prompt)
    switch (++rootTurn) {
      case 1: return response(tool('spawn_agent', { name: 'Helper', task: 'Look around', reason: 'Independent work', providerId: 'codex', model: 'gpt-6-sol' }), tool('wait_agent'))
      case 2: return response(evaluate())
      default: return { text: 'Reviewed' }
    }
  }), payload(workspace))
  assert.equal(run.status, 'completed')
  const helper = run.agents.find(agent => agent.name === 'Helper')
  assert.deepEqual([helper.handovers.length, helper.handovers[0].fresh], [1, true])
  assert.ok(!unescape(rootPrompts[1]).includes('"ranOn"'), 'nothing ambiguous to report')
  assert.ok(unescape(rootPrompts[1]).includes('"providerId":"claude","model":"opus","result":"helper done"'))
  const [record] = assessments(memory, workspace)
  assert.equal(record.title, 'Model: claude/opus — code')
  assert.ok(!('ranOn' in JSON.parse(record.content.split('\n')[0])))
})
