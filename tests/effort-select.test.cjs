const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { offeredLevels, clampEffort, topLevel, levelsLine } = require('../electron/reasoning-levels.mts')
const { replacements, effortFor } = require('../electron/failover.mts')
const { w, CATALOG, fakeQuota, agentOf, config } = require('./helpers-failover.cjs')
const sessions = require('./helpers-session.cjs')

// ---- the clamp ------------------------------------------------------------------------------------------------------

const codexCatalog = { id: 'codex', reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh'], 'gpt-5.5': [] } }
const level = (providerId, model, wanted, entry) => clampEffort(wanted, offeredLevels(providerId, model, entry)).level

test('a level moves to the nearest one the model offers: below first, then above; nothing where there are no levels', () => {
  assert.equal(level('claude', 'sonnet', 'max'), 'max')
  assert.equal(level('claude', 'sonnet', 'ultra'), 'max', 'Claude has no ultra')
  assert.equal(level('claude', 'sonnet', 'none'), 'low', 'nothing below none and Claude has no none: the nearest above')
  assert.equal(level('claude', 'sonnet', 'minimal'), 'low')
  assert.equal(level('codex', 'gpt-6-astra', 'max', codexCatalog), 'xhigh', 'this model offers up to xhigh')
  assert.equal(level('codex', 'gpt-6-astra', 'none', codexCatalog), 'low')
  assert.equal(level('codex', 'gpt-9-unknown', 'ultra', codexCatalog), 'ultra', 'a model the catalog does not know has the provider defaults')
  assert.equal(level('codex', 'gpt-5.5', 'high', codexCatalog), '', 'a model with an empty list has no levels')
  assert.equal(level('antigravity', 'gemini-3.1-pro-high', 'high', { id: 'antigravity', reasoningLevels: { 'gemini-3.1-pro-high': ['high'] } }), '', 'Antigravity has its reasoning built in')
  assert.equal(level('cursor', 'auto', 'high'), '')
  assert.equal(level('claude', 'sonnet', ''), '')
  assert.equal(level('claude', 'sonnet', undefined), '')
  // 'enabled' only where the model lists it; it ranks like medium otherwise and for the others.
  assert.equal(level('claude', 'sonnet', 'enabled'), 'medium')
  const thinking = { id: 'ollama', reasoningLevels: { qwen: ['none', 'enabled'] } }
  assert.equal(level('ollama', 'qwen', 'high', thinking), 'enabled')
  assert.equal(level('ollama', 'qwen', 'none', thinking), 'none')
  assert.deepEqual([clampEffort('max', ['low', 'high']).clamped, clampEffort('high', ['low', 'high']).clamped], [true, false])
  assert.equal(topLevel(['low', 'xhigh', 'high']), 'xhigh')
})

test('a handover keeps the nearest level of the target instead of dropping to the provider default', () => {
  const pick = effort => Object.fromEntries(replacements({ agent: agentOf({ reasoningEffort: effort }), catalog: CATALOG, quota: fakeQuota({}), config: config({ allowWeaker: true }) }).map(item => [`${item.providerId}/${item.model}`, item.reasoningEffort]))
  const max = pick('max')
  assert.equal(max['codex/gpt-5.5'], 'xhigh', 'gpt-5.5 tops at xhigh'); assert.equal(max['codex/gpt-6-astra'], 'max'); assert.equal(max['claude/opus'], 'max')
  assert.equal(max['antigravity/gemini-3.1-pro-high'], ''); assert.equal(max['cursor/claude-opus-5-5-high'], '', 'no levels listed for Cursor here')
  assert.equal(effortFor('cursor', 'claude-opus-5-5-high', 'high', { id: 'cursor', reasoningLevels: { 'claude-opus-5-5-high': ['low', 'high'] } }, undefined), 'high', 'Cursor offers the variants its catalog lists')
  assert.equal(effortFor('codex', 'gpt-6-astra', 'ultra', undefined, 'low'), 'low', 'the pool entry of the target is taken as it is')
})

test('the root is told the levels per provider and model, grouped', () => {
  const line = levelsLine([{ id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-5.5', 'gpt-5.6'], reasoningLevels: { 'gpt-6-astra': ['low', 'high', 'xhigh'], 'gpt-5.5': ['low', 'high'], 'gpt-5.6': ['low', 'high'] } }, { id: 'claude', available: true, models: ['sonnet'] }, { id: 'antigravity', available: true, models: ['gemini'] }, { id: 'cursor', available: false }])
  assert.equal(line, 'codex: gpt-6-astra low/high/xhigh; gpt-5.5, gpt-5.6 low/high · claude: low/medium/high/xhigh/max · antigravity: none')
  assert.match(levelsLine(null), /^codex: none\/minimal\/low\/medium\/high\/xhigh\/max\/ultra · claude: low\/medium\/high\/xhigh\/max · antigravity: none/)
  assert.equal(levelsLine(null, new Set(['claude'])), 'claude: low/medium/high/xhigh/max')
})

// ---- spawn_agent ----------------------------------------------------------------------------------------------------

const folder = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-effort-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory }
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const SPAWN_CATALOG = [
  { id: 'claude', available: true, models: ['sonnet', 'opus', 'haiku'], reasoningLevels: {} },
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-9'], reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh'] } },
  { id: 'antigravity', available: true, models: ['gemini-3.1-pro-high'] },
]
// A run whose root (claude/opus) spawns `spawns` in one turn, waits for them all, and finishes. `calls` records the helpers' turns.
async function spawned(t, spawns, extra = {}, catalog = SPAWN_CATALOG) {
  const calls = [], prompts = []
  const runProvider = async options => {
    const name = options.prompt.match(/Agent: ([^;]+); id=/)[1]
    if (name !== 'Orbit') { calls.push({ name, providerId: options.providerId, model: options.model, effort: options.reasoningEffort }); return { text: 'helper done' } }
    prompts.push(options.prompt)
    return prompts.length === 1 ? { text: JSON.stringify({ tool_calls: [...spawns.map(args => tool('spawn_agent', { task: `Task of ${args.name}`, reason: 'Independent work', ...args })), tool('wait_agent')] }) } : { text: 'Готово' }
  }
  const runtime = new OrbitRuntime({ runProvider, catalog: async () => catalog })
  let resolve
  const terminal = new Promise(done => { resolve = done })
  runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start({ workspace: folder(t), projectId: 'project-1', chatId: 'chat-1', providerId: 'claude', model: 'opus', prompt: 'Current task', ...extra })
  const timer = setTimeout(() => runtime.stop(runId), 8000)
  const event = await terminal
  clearTimeout(timer)
  assert.equal(event.type, 'run.finished')
  const snapshot = runtime.getRun(runId)
  const results = prompts[1].split('\n').filter(line => line.startsWith('{"type":"tool_result"')).map(line => JSON.parse(line)).filter(entry => entry.name === 'spawn_agent').map(entry => JSON.parse(entry.result))
  const helper = name => snapshot.agents.find(agent => agent.name === name)
  return { calls, prompts, results, helper, result: name => results.find(item => item.name === name) }
}
const got = (helper, name) => { const agent = helper(name); return [agent.reasoningEffort, agent.effortSource] }

test('each source of a helper\'s level beats the ones below it: caller, pool, routing table, parent, provider settings', async t => {
  const pool = [{ providerId: 'claude', model: 'sonnet', reasoningEffort: 'low' }]
  const { helper, calls } = await spawned(t, [
    { name: 'caller', providerId: 'claude', model: 'sonnet', reasoningEffort: 'medium' },
    { name: 'pooled', providerId: 'claude', model: 'sonnet' },
    { name: 'routed', kind: 'code' },
  ], { providerPool: pool, reasoningEffort: 'xhigh', providerOptions: { claude: { reasoningEffort: 'high' } } })
  assert.deepEqual(got(helper, 'caller'), ['medium', 'caller'], 'the caller beats the pool')
  assert.deepEqual(got(helper, 'pooled'), ['low', 'pool'], 'the pool beats the parent and the settings')
  assert.deepEqual(got(helper, 'routed'), ['low', 'pool'], 'the pool beats the routing table (code goes to claude/sonnet at high)')
  assert.equal(calls.find(call => call.name === 'pooled').effort, 'low', 'the provider is asked for that level')
  const open = await spawned(t, [
    { name: 'routed', kind: 'code' },
    { name: 'parent' },
    { name: 'settings', providerId: 'codex', model: 'gpt-9' },
    { name: 'none', providerId: 'antigravity', model: 'gemini-3.1-pro-high' },
  ], { reasoningEffort: 'xhigh', providerOptions: { claude: { reasoningEffort: 'low' }, codex: { reasoningEffort: 'medium' } } })
  assert.deepEqual(got(open.helper, 'routed'), ['high', 'routing'], 'the routing table beats the parent and the settings')
  assert.deepEqual(got(open.helper, 'parent'), ['xhigh', 'parent'], 'the parent\'s level on its own model beats the settings')
  assert.deepEqual(got(open.helper, 'settings'), ['medium', 'settings'])
  assert.deepEqual(got(open.helper, 'none'), ['', ''], 'Antigravity has no levels; nothing names one')
  assert.equal(open.helper('Orbit').effortSource, 'settings', 'the root keeps the run\'s level')
  const bare = await spawned(t, [{ name: 'bare', providerId: 'codex', model: 'gpt-9' }])
  assert.deepEqual(got(bare.helper, 'bare'), ['', ''])
})

test('a requested level is clamped to the model, never refused, and the result says why', async t => {
  const { helper, result, calls } = await spawned(t, [
    { name: 'claude-ultra', providerId: 'claude', model: 'sonnet', reasoningEffort: 'ultra' },
    { name: 'astra-max', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' },
    { name: 'unknown-model', providerId: 'codex', model: 'gpt-9', reasoningEffort: 'ultra' },
    { name: 'google', providerId: 'antigravity', model: 'gemini-3.1-pro-high', reasoningEffort: 'high' },
    { name: 'claude-none', providerId: 'claude', model: 'haiku', reasoningEffort: 'none' },
  ])
  assert.deepEqual(got(helper, 'claude-ultra'), ['max', 'caller'])
  assert.deepEqual(got(helper, 'astra-max'), ['xhigh', 'caller'], 'the provider list says this model stops at xhigh')
  assert.deepEqual(got(helper, 'unknown-model'), ['ultra', 'caller'])
  assert.deepEqual(got(helper, 'google'), ['', 'caller'])
  assert.deepEqual(got(helper, 'claude-none'), ['low', 'caller'])
  assert.equal(result('astra-max').effort, 'xhigh (asked max; codex/gpt-6-astra offers up to xhigh)')
  assert.equal(result('claude-ultra').effort, 'max (asked ultra; claude/sonnet offers up to max)')
  assert.equal(result('google').effort, 'provider default (asked high; antigravity/gemini-3.1-pro-high has no reasoning levels)')
  assert.equal(calls.find(call => call.name === 'astra-max').effort, 'xhigh')
  assert.equal(calls.find(call => call.name === 'google').effort, '')
})

test('the spawn result is compact: who and on what, not the task, the result or the traces', async t => {
  const { result, results } = await spawned(t, [{ name: 'routed', kind: 'review', task: 'A long brief. '.repeat(300) }, { name: 'asked', providerId: 'claude', model: 'sonnet', reasoningEffort: 'medium' }])
  const routed = result('routed')
  assert.deepEqual(Object.keys(routed).sort(), ['agentId', 'effort', 'effortSource', 'model', 'name', 'ok', 'providerId', 'reasoningEffort', 'routed', 'status'])
  assert.deepEqual([routed.providerId, routed.model, routed.reasoningEffort, routed.effortSource, routed.effort, routed.status], ['codex', 'gpt-6-astra', 'high', 'routing', 'high (routing table for review)', 'waiting'])
  assert.deepEqual(routed.routed, { kind: 'review', model: 'codex/gpt-6-astra' }, 'the routing note carries no level of its own')
  assert.equal(result('asked').effort, 'medium (as asked)')
  assert.ok(results.every(item => JSON.stringify(item).length < 600), 'nothing of the task comes back')
})

test('the root\'s prompt lists the levels and both delegation texts tell it to choose', async t => {
  const { prompts } = await spawned(t, [{ name: 'only', providerId: 'claude', model: 'sonnet' }])
  assert.match(prompts[0], /REASONING LEVELS \(spawn_agent reasoningEffort; a level a model lacks becomes its nearest one\): .*claude: low\/medium\/high\/xhigh\/max/)
  assert.match(prompts[0], /choose it yourself for each helper whose model has levels, the lowest that does the task well and never lower than the work needs/)
  assert.doesNotMatch(prompts[0], /configured pool effort takes precedence/)
  const { sessionGuide } = require('../electron/runtime/prompts.mts')
  const guide = sessionGuide({ projectId: 'p', workspace: 'p', accessMode: 'workspace-write', approvalPolicy: 'never' }, { id: 'root', name: 'Orbit', parentId: null, depth: 0, mailMark: '0123456789' })
  assert.match(guide, /Choose reasoningEffort yourself for each helper whose model has levels: the lowest level that does the task well and never lower than the work needs \(quality first\): medium for lookups/)
  assert.match(guide, /max only for the hardest reasoning where a mistake is expensive; higher levels cost tokens on every later step/)
})

// ---- review findings -------------------------------------------------------------------------------------------------

test('a clamp that lands on Ollama\'s thinking switch says what the model offers, not "up to none"', async t => {
  const catalog = [...SPAWN_CATALOG, { id: 'ollama', available: true, models: ['qwen'], reasoningLevels: { qwen: ['none', 'enabled'] } }]
  const { result } = await spawned(t, [{ name: 'think', providerId: 'ollama', model: 'qwen', reasoningEffort: 'high' }, { name: 'plain', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }], {}, catalog)
  assert.equal(result('think').effort, 'enabled (asked high; ollama/qwen offers up to enabled)')
  assert.equal(result('plain').effort, 'xhigh (asked max; codex/gpt-6-astra offers up to xhigh)')
})

// A run on the session transport with a provider list `catalog` returns, and the prompts the root was given.
// `waits`: when given, receives how long a second settleCatalog of the run took once the prompt was built.
async function rootPrompts(t, catalog, waits) {
  const prompts = []
  const runtime = new OrbitRuntime({ ...sessions.session(), catalog, runProvider: async options => {
    prompts.push(options.prompt)
    if (waits) { const started = Date.now(); await runtime.settleCatalog([...runtime.runs.values()][0]); waits.push(Date.now() - started) }
    return { text: 'Готово' }
  } })
  const { snapshot } = await sessions.finished(runtime, sessions.payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  return prompts
}
const LISTED = [
  { id: 'claude', available: true, models: ['opus'], reasoningLevels: {} },
  { id: 'codex', available: true, models: ['gpt-6-astra'], reasoningLevels: { 'gpt-6-astra': ['low', 'high'] } },
  { id: 'cursor', available: false, models: ['auto'], reasoningLevels: {} },
]

test('in session mode the root\'s first prompt carries the exact levels: the provider list is waited for, only connected providers are listed', async t => {
  const prompts = await rootPrompts(t, () => new Promise(resolve => setTimeout(resolve, 120, LISTED)))
  const line = prompts[0].match(/REASONING LEVELS[^\n]*/)[0]
  assert.match(line, /codex: low\/high/)
  assert.match(line, /claude: low\/medium\/high\/xhigh\/max/)
  assert.doesNotMatch(line, /cursor|ultra/, 'an unconnected provider and a level no model offers are not listed')
})

test('a provider list that does not arrive in time leaves the defaults in the root\'s prompt, and the run goes on', async t => {
  const previous = process.env.ORBIT_ROUTE_WAIT_MS
  process.env.ORBIT_ROUTE_WAIT_MS = '40'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_ROUTE_WAIT_MS; else process.env.ORBIT_ROUTE_WAIT_MS = previous })
  const waits = []
  const prompts = await rootPrompts(t, () => new Promise(resolve => setTimeout(resolve, 1500, LISTED).unref()), waits)
  assert.match(prompts[0].match(/REASONING LEVELS[^\n]*/)[0], /codex: none\/minimal\/low\/medium\/high\/xhigh\/max\/ultra/)
  assert.ok(waits[0] < 20, `the wait is paid once, not at every call (${waits[0]} ms for the second)`)
})

test('a spawn whose turn was cut off while the provider list was read creates no helper', async t => {
  let calls = 0, release = null
  const seen = {}
  const runtime = new OrbitRuntime({ ...sessions.session(), catalog: () => ++calls === 1 ? Promise.resolve(LISTED) : new Promise(resolve => { release = resolve }), runProvider: async options => {
    if (sessions.agentOf(options)[1] !== 'Orbit') return { text: 'helper done' }
    const run = [...runtime.runs.values()][0], root = run.agentNodes.get('root'), turn = root.activeTurn
    // No list known yet, neither this run's nor one an earlier run of this Orbit read: the spawn has to wait for it.
    run.catalogCache = null
    runtime.lastCatalog = null
    const spawn = runtime.spawnSubAgent(run.runId, 'root', { name: 'Helper', task: 'Work', reason: 'Independent', reasoningEffort: 'high' })
    await sessions.until(() => release)
    // The pause that cut this turn started another one.
    root.activeTurn = { ...turn }
    release(LISTED)
    seen.result = await spawn
    root.activeTurn = turn
    seen.agents = run.agentNodes.size
    return { text: 'Done' }
  } })
  const { snapshot } = await sessions.finished(runtime, sessions.payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual([seen.result.ok, seen.result.reason, seen.agents], [false, 'turn_interrupted', 1])
})

test('the provider list read before is used while the next one is read, and when that reading fails', async t => {
  let now = 1_000_000, calls = 0, release = null
  const seen = {}
  const runtime = new OrbitRuntime({ ...sessions.session(), clock: () => now, catalog: () => { calls++; return calls === 1 ? Promise.resolve(LISTED) : calls === 2 ? new Promise(resolve => { release = resolve }) : Promise.reject(new Error('probe failed')) }, runProvider: async options => {
    if (sessions.agentOf(options)[1] !== 'Orbit') return { text: 'helper done' }
    const run = [...runtime.runs.values()][0]
    await runtime.providerCatalog(run)
    seen.first = run.catalogCache.list
    now += 130_000
    const again = runtime.providerCatalog(run)
    await sessions.until(() => release)
    seen.during = run.catalogCache.list
    release([{ id: 'claude', available: true, models: ['opus'], reasoningLevels: {} }])
    await again
    seen.after = run.catalogCache.list
    now += 130_000
    await runtime.providerCatalog(run)
    seen.failed = run.catalogCache.list
    return { text: 'Done' }
  } })
  const { snapshot } = await sessions.finished(runtime, sessions.payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(seen.first, LISTED)
  assert.deepEqual(seen.during, LISTED, 'levels are not guessed from the defaults while the list is read again')
  assert.deepEqual(seen.after.map(entry => entry.id), ['claude'], 'the new list replaces it')
  assert.deepEqual(seen.failed.map(entry => entry.id), ['claude'], 'a failed reading keeps the list that was known')
})

test('the next run of the same Orbit takes the levels from the list read before at once, without waiting for a new reading', async t => {
  const previous = process.env.ORBIT_ROUTE_WAIT_MS
  process.env.ORBIT_ROUTE_WAIT_MS = '5000'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_ROUTE_WAIT_MS; else process.env.ORBIT_ROUTE_WAIT_MS = previous })
  let reads = 0
  const prompts = []
  // The first reading answers at once; any later one would take 3 s, longer than the run is allowed below.
  const catalog = () => ++reads === 1 ? Promise.resolve(LISTED) : new Promise(resolve => setTimeout(resolve, 3000, LISTED).unref())
  const runtime = new OrbitRuntime({ ...sessions.session(), catalog, runProvider: async options => { prompts.push(options.prompt); return { text: 'Готово' } } })
  await sessions.finished(runtime, sessions.payload(folder(t)))
  const started = Date.now()
  const { snapshot } = await sessions.finished(runtime, sessions.payload(folder(t)))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(Date.now() - started < 2000, `the second run did not wait for a new provider list (${Date.now() - started} ms)`)
  const line = prompts.at(-1).match(/REASONING LEVELS[^\n]*/)[0]
  assert.match(line, /codex: low\/high/)
  assert.doesNotMatch(line, /cursor|ultra/)
})
