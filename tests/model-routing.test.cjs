const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { tierOf } = require('../electron/failover.mts')
const { ROUTING_KINDS, candidates, route } = require('../electron/model-routing.mts')
const registry = require('../electron/tool-registry.mts')

const w = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })
const CATALOG = [
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.5'], reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh'], 'gpt-6-luna': ['low', 'medium'] } },
  { id: 'claude', available: true, models: ['sonnet', 'opus', 'haiku'], reasoningLevels: {} },
  { id: 'antigravity', available: true, models: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'gpt-oss-120b-medium'] },
  { id: 'cursor', available: true, models: ['auto', 'claude-fable-5-thinking-high'] },
]
const fakeQuota = snapshots => ({ peek: id => snapshots[id] ? { providerId: id, ...snapshots[id] } : null })
const input = (extra = {}) => ({ kind: 'code', catalog: CATALOG, known: new Set(), pool: [], runProviderId: 'claude', quota: fakeQuota({}), threshold: 90, now: Date.now(), skip: new Set(), ...extra })
const picked = result => result.choice && `${result.choice.providerId}/${result.choice.model}`

// ---- The table ----------------------------------------------------------------------------------------------------

test('the routing table names four kinds of work, each with candidates from at least two subscriptions', () => {
  assert.deepEqual([...ROUTING_KINDS], ['code', 'review', 'lookup', 'text'])
  assert.deepEqual(registry.tool('spawn_agent').inputSchema.properties.kind.enum, ['', ...ROUTING_KINDS], 'spawn_agent offers exactly the kinds of the table, and no kind as an empty string like reasoningEffort')
  const call = kind => registry.validate('spawn_agent', { task: 'Look', reason: 'Independent work', kind })
  assert.deepEqual([call('review').ok, call('').ok, call(null).ok, call('poem').ok], [true, true, true, false], 'an MCP call is checked against the same list')
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-routing.json'), 'utf8'))
  for (const kind of ROUTING_KINDS) {
    const list = candidates(kind)
    assert.ok(list.length >= 3, kind)
    assert.ok(new Set(list.map(item => item.providerId)).size >= 2, `${kind}: a reserve on another subscription`)
    assert.equal(new Set(list.map(item => `${item.providerId}/${item.model}`)).size, list.length, `${kind}: no candidate twice`)
    assert.ok(raw.kinds[kind].candidates.every(item => item.why), `${kind}: every candidate says what the audit measured`)
  }
  assert.deepEqual(candidates('poem'), [])
})

test('the table leaves out what the user or the audit ruled out: Fable, Haiku, GPT-OSS, GPT-5.6 Luna, unmeasured Cursor', () => {
  for (const kind of ROUTING_KINDS) for (const { providerId, model } of candidates(kind)) {
    assert.doesNotMatch(model, /fable|haiku|gpt-oss|gpt-5\.6-luna/i, `${kind}: ${providerId}/${model}`)
    assert.notEqual(providerId, 'cursor', `${kind}: Cursor was not measured`)
    assert.ok(tierOf(model) >= 1, `${kind}: ${model} is neither weak nor of unknown quality`)
  }
  assert.ok(candidates('review').every(item => tierOf(item.model) >= 3), 'a review goes to flagships only')
})

// ---- The choice ---------------------------------------------------------------------------------------------------

test('with every subscription healthy each kind gets its first choice at the level the audit measured', () => {
  const expected = { code: ['claude/sonnet', 'high'], review: ['codex/gpt-6-astra', 'high'], lookup: ['codex/gpt-6-luna', 'medium'], text: ['claude/opus', 'high'] }
  for (const [kind, [model, effort]] of Object.entries(expected)) {
    const result = route(input({ kind }))
    assert.equal(picked(result), model, kind)
    assert.equal(result.choice.reasoningEffort, effort, `${kind}: a level the target does not offer becomes its nearest one (Luna lists only low and medium here: high -> medium)`)
    assert.deepEqual(result.skipped, [], kind)
  }
  assert.equal(route(input({ kind: 'code', quota: fakeQuota({ claude: { windows: [w(100)] } }) })).choice.reasoningEffort, 'high', 'Astra offers high')
  const google = route(input({ kind: 'code', skip: new Set(['claude', 'codex']) }))
  assert.deepEqual([picked(google), google.choice.reasoningEffort], ['antigravity/gemini-3.1-pro-high', ''], 'Antigravity takes no level')
})

test('a subscription near or at its limit is passed over, and the reason is named', () => {
  const near = route(input({ kind: 'review', quota: fakeQuota({ codex: { windows: [w(95)] } }) }))
  assert.equal(picked(near), 'claude/opus')
  assert.deepEqual(near.skipped, ['codex/gpt-6-astra: quota 95% used'])
  const below = route(input({ kind: 'review', quota: fakeQuota({ codex: { windows: [w(85)] } }) }))
  assert.equal(picked(below), 'codex/gpt-6-astra', 'below the switch point the first choice stays')
  assert.equal(picked(route(input({ kind: 'review', threshold: 80, quota: fakeQuota({ codex: { windows: [w(85)] } }) }))), 'claude/opus', 'the switch point is the run setting')
  const out = route(input({ kind: 'lookup', quota: fakeQuota({ codex: { windows: [], exhaustedUntil: Date.now() + 60000 } }) }))
  assert.equal(picked(out), 'antigravity/gemini-3.8-flash-high')
  assert.deepEqual(out.skipped, ['codex/gpt-6-luna: quota used up', 'codex/gpt-5.6-terra: quota used up'], 'a refusal mark counts as used up')
  const rolled = route(input({ kind: 'review', quota: fakeQuota({ codex: { windows: [w(100, { resetsAt: Date.now() - 1000 })] } }) }))
  assert.equal(picked(rolled), 'codex/gpt-6-astra', 'a window whose reset has passed no longer counts')
})

test('a model-specific window counts only for its model', () => {
  const sonnetOut = fakeQuota({ claude: { windows: [w(100, { kind: 'week', scope: 'Sonnet', models: ['sonnet'] }), w(20)] } })
  const code = route(input({ kind: 'code', quota: sonnetOut }))
  assert.equal(picked(code), 'codex/gpt-6-astra')
  assert.deepEqual(code.skipped, ['claude/sonnet: quota used up'])
  assert.equal(picked(route(input({ kind: 'text', quota: sonnetOut }))), 'claude/opus', 'Opus has its own window')
})

test('only connected providers and the models they list count; without the provider list only providers known to answer', () => {
  const offline = CATALOG.map(entry => entry.id === 'codex' ? { ...entry, available: false } : entry)
  const review = route(input({ kind: 'review', catalog: offline }))
  assert.equal(picked(review), 'claude/opus')
  assert.deepEqual(review.skipped, ['codex/gpt-6-astra: not connected'])
  const renamed = CATALOG.map(entry => entry.id === 'codex' ? { ...entry, models: ['gpt-6-sol'] } : entry)
  assert.deepEqual(route(input({ kind: 'lookup', catalog: renamed })).skipped, ['codex/gpt-6-luna: not in its model list', 'codex/gpt-5.6-terra: not in its model list'])
  const missing = route(input({ kind: 'text', catalog: CATALOG.filter(entry => entry.id !== 'claude'), runProviderId: 'codex' }))
  assert.deepEqual([picked(missing), missing.skipped], ['antigravity/gemini-3.1-pro-high', ['claude/opus: not connected']])
  const unlisted = route(input({ kind: 'code', catalog: CATALOG.map(entry => ({ ...entry, models: [] })) }))
  assert.equal(picked(unlisted), 'claude/sonnet', 'a provider that lists no models is not judged by its list')
  const blind = route(input({ kind: 'code', catalog: null, known: new Set(['codex']) }))
  assert.equal(picked(blind), 'codex/gpt-6-astra')
  assert.deepEqual(blind.skipped, ['claude/sonnet: the provider list could not be read'])
  assert.equal(route(input({ kind: 'review', catalog: null, known: new Set() })).choice, null)
})

test('the provider pool and providers that could not answer limit the choice; providerId keeps it to one subscription', () => {
  const pool = [{ providerId: 'codex', model: 'gpt-6-luna' }, { providerId: 'antigravity' }]
  const review = route(input({ kind: 'review', pool, runProviderId: 'claude' }))
  assert.equal(picked(review), 'claude/opus', "the run's own provider is always allowed")
  assert.deepEqual(review.skipped, ['codex/gpt-6-astra: not in the provider pool'])
  assert.equal(picked(route(input({ kind: 'lookup', pool, runProviderId: 'claude' }))), 'codex/gpt-6-luna', 'a pool member with its model')
  assert.equal(picked(route(input({ kind: 'text', pool, runProviderId: 'codex', skip: new Set() }))), 'antigravity/gemini-3.1-pro-high', 'a pool member without a model allows every model of it')
  const broken = route(input({ kind: 'lookup', skip: new Set(['codex']) }))
  assert.equal(picked(broken), 'antigravity/gemini-3.8-flash-high')
  assert.deepEqual(broken.skipped, ['codex/gpt-6-luna: could not answer a moment ago', 'codex/gpt-5.6-terra: could not answer a moment ago'])
  const narrowed = route(input({ kind: 'text', providerId: 'codex' }))
  assert.deepEqual([picked(narrowed), narrowed.skipped], ['codex/gpt-6-sol', []], 'other subscriptions are neither tried nor named')
  assert.equal(route(input({ kind: 'code', providerId: 'cursor' })).choice, null, 'no candidate on that subscription')
  assert.equal(route(input({ kind: 'poem' })).choice, null)
})

// ---- spawn_agent ---------------------------------------------------------------------------------------------------

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-routing-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
async function finished(runtime, payload) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return runtime.getRun(runId)
}
// A run whose root (claude/opus) spawns one helper with `spawn` and waits for it; `calls` records every provider turn.
function world(t, { usage = {}, catalog = CATALOG, quotaMonitor = true } = {}) {
  const original = { ...quota.readers }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: usage[id] || [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const calls = [], prompts = []
  const runProvider = spawn => async options => {
    const [, name] = identity(options.prompt)
    calls.push({ name, providerId: options.providerId, model: options.model, effort: options.reasoningEffort })
    if (name !== 'Orbit') return { text: 'helper done' }
    prompts.push(options.prompt)
    return prompts.length === 1 ? response(...[spawn].flat().map(args => tool('spawn_agent', { name: 'Helper', task: 'Look at the change', reason: 'Independent work', ...args })), tool('wait_agent')) : { text: 'Готово' }
  }
  const make = spawn => new OrbitRuntime({ runProvider: runProvider(spawn), ...(quotaMonitor ? { quota: new quota.QuotaMonitor() } : {}), ...(catalog ? { catalog: async () => catalog } : {}) })
  return { calls, prompts, make }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'claude', model: 'opus', prompt: 'Current task', ...extra })
const helperOf = snapshot => snapshot.agents.find(agent => agent.name === 'Helper')
const delegation = snapshot => snapshot.traces.find(trace => trace.kind === 'delegation')?.text || ''
// What spawn_agent returned, as the root's next prompt shows it: a transcript line whose result is the JSON text.
const spawnResults = prompt => prompt.split('\n').filter(line => line.startsWith('{"type":"tool_result"')).map(line => JSON.parse(line)).filter(entry => entry.name === 'spawn_agent').map(entry => JSON.parse(entry.result))

test('spawn_agent with a kind runs the helper on the model routed for that work and says which', async t => {
  const workspace = folder(t)
  const { calls, prompts, make } = world(t)
  const snapshot = await finished(make({ kind: 'review' }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls.filter(call => call.name === 'Helper').map(call => [call.providerId, call.model, call.effort]), [['codex', 'gpt-6-astra', 'high']])
  const helper = helperOf(snapshot)
  assert.deepEqual([helper.providerId, helper.model, helper.handovers.length], ['codex', 'gpt-6-astra', 0])
  assert.deepEqual(spawnResults(prompts[1]).map(result => result.routed), [{ kind: 'review', model: 'codex/gpt-6-astra' }], 'the caller is told the choice')
  assert.match(delegation(snapshot), /Model for review work: codex\/gpt-6-astra$/)
})

test('a subscription near its limit is passed over when the helper is created, so it starts elsewhere without a handover', async t => {
  const workspace = folder(t)
  const { calls, prompts, make } = world(t, { usage: { codex: [w(95)], claude: [w(10)] } })
  const snapshot = await finished(make({ kind: 'lookup' }), payload(workspace))
  assert.deepEqual(calls.filter(call => call.name === 'Helper').map(call => [call.providerId, call.model]), [['antigravity', 'gemini-3.8-flash-high']])
  assert.equal(helperOf(snapshot).handovers.length, 0)
  assert.deepEqual(spawnResults(prompts[1])[0].routed, { kind: 'lookup', model: 'antigravity/gemini-3.8-flash-high', skipped: ['codex/gpt-6-luna: quota 95% used', 'codex/gpt-5.6-terra: quota 95% used'] })
  assert.match(delegation(snapshot), /Model for lookup work: antigravity\/gemini-3\.8-flash-high \(passed over codex\/gpt-6-luna: quota 95% used; codex\/gpt-5\.6-terra: quota 95% used\)/)
})

test('an explicit model wins over the kind, and providerId alone keeps the routing to that subscription', async t => {
  const explicit = world(t)
  const first = await finished(explicit.make({ kind: 'review', providerId: 'claude', model: 'sonnet' }), payload(folder(t)))
  assert.deepEqual([helperOf(first).providerId, helperOf(first).model], ['claude', 'sonnet'])
  assert.equal(spawnResults(explicit.prompts[1])[0].routed, undefined)
  assert.doesNotMatch(delegation(first), /Model for/)
  const narrowed = world(t)
  const second = await finished(narrowed.make({ kind: 'code', providerId: 'codex' }), payload(folder(t)))
  assert.deepEqual([helperOf(second).providerId, helperOf(second).model, helperOf(second).reasoningEffort], ['codex', 'gpt-6-astra', 'high'])
})

test('the level: the caller\'s, else the measured one, which beats the provider settings and the parent\'s level', async t => {
  const caller = world(t)
  assert.equal(helperOf(await finished(caller.make({ kind: 'review', reasoningEffort: 'low' }), payload(folder(t)))).reasoningEffort, 'low')
  const settings = world(t)
  assert.equal(helperOf(await finished(settings.make({ kind: 'review' }), payload(folder(t), { providerOptions: { codex: { reasoningEffort: 'xhigh' } } }))).reasoningEffort, 'high', 'the routing table\'s level, not the provider settings\'')
  const same = world(t)
  const inherited = helperOf(await finished(same.make({ kind: 'text' }), payload(folder(t), { reasoningEffort: 'max' })))
  assert.deepEqual([inherited.providerId, inherited.model, inherited.reasoningEffort, inherited.effortSource], ['claude', 'opus', 'high', 'routing'], 'the routing table\'s level also beats the parent\'s level on the parent\'s own model')
})

test('without a usable candidate, or without the provider list, the helper gets what it would get without a kind', async t => {
  const blind = world(t, { catalog: null })
  const snapshot = await finished(blind.make({ kind: 'review' }), payload(folder(t)))
  assert.deepEqual([helperOf(snapshot).providerId, helperOf(snapshot).model], ['claude', 'opus'], 'only the provider the root runs on is known to answer')
  assert.deepEqual(spawnResults(blind.prompts[1])[0].routed, { kind: 'review', model: 'claude/opus', skipped: ['codex/gpt-6-astra: the provider list could not be read'] })
  // Failover is off here, so the helper stays where it started; the routing still judges the quotas.
  const busy = world(t, { usage: { codex: [w(99)], claude: [w(99)], antigravity: [w(99)] } })
  const none = await finished(busy.make({ kind: 'text' }), payload(folder(t), { quotaFailover: { enabled: false } }))
  const { routed } = spawnResults(busy.prompts[1])[0]
  assert.deepEqual([routed.model, routed.skipped], [null, ['claude/opus: quota 99% used', 'antigravity/gemini-3.1-pro-high: quota 99% used', 'codex/gpt-6-sol: quota 99% used']])
  assert.equal(routed.note, 'No model of the routing table can take this work now; the helper got the model it gets without a kind.')
  assert.deepEqual([helperOf(none).providerId, helperOf(none).model], ['claude', 'opus'])
  assert.match(delegation(none), /Model for text work: none of the routing table can take it now, so the usual one \(passed over claude\/opus: quota 99% used; /)
})

test('an unknown kind is refused with the kinds that exist; a helper reused by its name is not routed again', async t => {
  const unknown = world(t)
  const snapshot = await finished(unknown.make({ kind: 'poem' }), payload(folder(t)))
  assert.equal(helperOf(snapshot), undefined)
  assert.deepEqual(spawnResults(unknown.prompts[1]), [{ ok: false, reason: 'unknown_kind', instruction: 'kind is one of: code, review, lookup, text' }])
  for (const empty of [null, '']) {
    const plain = world(t)
    const result = await finished(plain.make({ kind: empty }), payload(folder(t)))
    assert.deepEqual([helperOf(result).providerId, helperOf(result).model], ['claude', 'opus'], `kind ${JSON.stringify(empty)} is no kind`)
    assert.equal(spawnResults(plain.prompts[1])[0].routed, undefined)
  }
  const twice = world(t)
  const runtime = twice.make([{ kind: 'review' }, { kind: 'text' }])
  let routings = 0
  const routeSpawn = runtime.routeSpawn.bind(runtime)
  runtime.routeSpawn = (...args) => { routings++; return routeSpawn(...args) }
  const reused = await finished(runtime, payload(folder(t)))
  const [first, second] = spawnResults(twice.prompts[1])
  assert.equal(first.routed.model, 'codex/gpt-6-astra')
  assert.deepEqual([second.reused, second.agentId, second.routed], [true, first.agentId, undefined], 'the second call reuses the helper and routes nothing')
  assert.equal(routings, 1, 'a call that reuses a helper does not wait for a routing')
  assert.deepEqual([helperOf(reused).model, twice.calls.filter(call => call.name === 'Helper').length], ['gpt-6-astra', 1])
})

test('two calls routed at the same time under one name create one helper; the other reuses it without a routing result', async t => {
  const original = { ...quota.readers }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  let results = null
  const runtime = new OrbitRuntime({ quota: new quota.QuotaMonitor(), catalog: async () => CATALOG, runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name !== 'Orbit') return { text: 'helper done' }
    if (results) return { text: 'Готово' }
    // Like two MCP calls arriving together: both pass the name check before either helper exists.
    const [runId] = [...runtime.runs.keys()]
    results = await Promise.all(['review', 'code'].map(kind => runtime.spawnSubAgent(runId, 'root', { name: 'Helper', task: 'Look at the change', reason: 'Independent work', kind })))
    return response(tool('wait_agent'))
  } })
  const snapshot = await finished(runtime, payload(folder(t)))
  assert.equal(snapshot.agents.filter(agent => agent.name === 'Helper').length, 1)
  const [made, again] = results
  assert.deepEqual([made.ok, made.reused, made.routed], [true, undefined, { kind: 'review', model: 'codex/gpt-6-astra' }])
  assert.deepEqual([again.ok, again.reused, again.agentId, again.routed], [true, true, made.agentId, undefined])
})

test('the routing at spawn time honours the provider pool and passes over a subscription that just could not answer', async t => {
  const pooled = world(t)
  const snapshot = await finished(pooled.make({ kind: 'lookup' }), payload(folder(t), { providerPool: [{ providerId: 'claude', model: 'opus' }, { providerId: 'antigravity' }] }))
  assert.deepEqual([helperOf(snapshot).providerId, helperOf(snapshot).model], ['antigravity', 'gemini-3.8-flash-high'])
  assert.deepEqual(spawnResults(pooled.prompts[1])[0].routed.skipped, ['codex/gpt-6-luna: not in the provider pool', 'codex/gpt-5.6-terra: not in the provider pool'])

  const original = { ...quota.readers }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const calls = [], prompts = []
  // The first helper is routed to Codex, whose CLI cannot answer at all; the second one, spawned later, is not sent there.
  const runtime = new OrbitRuntime({ quota: new quota.QuotaMonitor(), catalog: async () => CATALOG, runProvider: async options => {
    const [, name] = identity(options.prompt)
    calls.push(`${name}@${options.providerId}/${options.model}`)
    if (options.providerId === 'codex') throw new Error('Eligibility check failed: not currently available in your location')
    if (name !== 'Orbit') return { text: `${name} done` }
    prompts.push(options.prompt)
    if (prompts.length === 1) return response(tool('spawn_agent', { name: 'Scout', task: 'Find the call sites', reason: 'Independent work', kind: 'lookup' }), tool('wait_agent'))
    if (prompts.length === 2) return response(tool('spawn_agent', { name: 'Helper', task: 'Review the change', reason: 'Independent work', kind: 'review' }), tool('wait_agent'))
    return { text: 'Готово' }
  } })
  const run = await finished(runtime, payload(folder(t)))
  assert.equal(run.status, 'completed')
  assert.ok(calls.includes('Scout@codex/gpt-6-luna'), 'the first helper was routed to Codex')
  assert.deepEqual(calls.filter(call => call.startsWith('Helper@')), ['Helper@claude/opus'])
  assert.deepEqual(spawnResults(prompts[2]).at(-1).routed, { kind: 'review', model: 'claude/opus', skipped: ['codex/gpt-6-astra: could not answer a moment ago'] })
})

// Quota readers that report nothing, for the tests below that build their own runtime.
function quietQuota(t) {
  const original = { ...quota.readers }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  return new quota.QuotaMonitor()
}
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise(resolve => setTimeout(resolve, 5)) } }

test('a provider list that does not come is waited for only so long; then only the providers known to answer count', async t => {
  const previous = process.env.ORBIT_ROUTE_WAIT_MS
  process.env.ORBIT_ROUTE_WAIT_MS = '50'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_ROUTE_WAIT_MS; else process.env.ORBIT_ROUTE_WAIT_MS = previous })
  let spawned = null
  const runtime = new OrbitRuntime({ quota: quietQuota(t), catalog: () => new Promise(() => {}), runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name !== 'Orbit') return { text: 'helper done' }
    if (spawned) return { text: 'Готово' }
    const [runId] = [...runtime.runs.keys()]
    const started = Date.now()
    spawned = { result: await runtime.spawnSubAgent(runId, 'root', { name: 'Helper', task: 'Look at the change', reason: 'Independent work', kind: 'review' }), ms: Date.now() - started }
    return response(tool('wait_agent'))
  } })
  const snapshot = await finished(runtime, payload(folder(t)))
  assert.ok(spawned.ms < 3000, `the spawn returned after ${spawned.ms} ms`)
  assert.deepEqual(spawned.result.routed, { kind: 'review', model: 'claude/opus', skipped: ['codex/gpt-6-astra: the provider list could not be read'] })
  assert.deepEqual([helperOf(snapshot).providerId, helperOf(snapshot).model], ['claude', 'opus'])
})

test('a subscription without candidates for the kind is not waited for, and the note says so', async t => {
  const previous = process.env.ORBIT_ROUTE_WAIT_MS
  process.env.ORBIT_ROUTE_WAIT_MS = '50'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_ROUTE_WAIT_MS; else process.env.ORBIT_ROUTE_WAIT_MS = previous })
  let spawned = null
  const runtime = new OrbitRuntime({ quota: quietQuota(t), catalog: () => new Promise(() => {}), runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name !== 'Orbit') return { text: 'helper done' }
    if (spawned) return { text: 'Готово' }
    const [runId] = [...runtime.runs.keys()]
    const started = Date.now()
    spawned = { result: await runtime.spawnSubAgent(runId, 'root', { name: 'Helper', task: 'Look at the change', reason: 'Independent work', kind: 'code', providerId: 'cursor' }), ms: Date.now() - started }
    return response(tool('wait_agent'))
  } })
  const snapshot = await finished(runtime, payload(folder(t)))
  assert.ok(spawned.ms < 1000, `the provider list that never comes is not awaited (${spawned.ms} ms)`)
  assert.deepEqual(spawned.result.routed, { kind: 'code', model: null, note: 'The routing table has no code candidate on cursor; the helper got the model it gets without a kind.' })
  assert.equal(helperOf(snapshot).providerId, 'cursor')
})

test('a pause that cuts the caller\'s turn while the model is chosen creates no helper behind its back', async t => {
  const previous = process.env.ORBIT_ROUTE_WAIT_MS
  process.env.ORBIT_ROUTE_WAIT_MS = '50'
  t.after(() => { if (previous === undefined) delete process.env.ORBIT_ROUTE_WAIT_MS; else process.env.ORBIT_ROUTE_WAIT_MS = previous })
  let release = null, spawning = null, turns = 0
  const runtime = new OrbitRuntime({ quota: quietQuota(t), catalog: () => new Promise(resolve => { release = () => resolve(CATALOG) }), runProvider: async options => {
    const [, name] = identity(options.prompt)
    if (name !== 'Orbit') return { text: 'helper done' }
    if (++turns > 1) return { text: 'Готово' }
    // Like an MCP call inside a session turn: the turn goes on while Orbit chooses the model, and a pause cuts it.
    const [runId] = [...runtime.runs.keys()]
    spawning = runtime.spawnSubAgent(runId, 'root', { name: 'Helper', task: 'Look at the change', reason: 'Independent work', kind: 'review' })
    return new Promise(() => {})
  } })
  const done = finished(runtime, payload(folder(t)))
  await until(() => spawning && release)
  const [runId] = [...runtime.runs.keys()]
  runtime.pauseAgent(runId, 'root')
  await until(() => !runtime.runs.get(runId).agentNodes.get('root').activeTurn)
  release()
  assert.deepEqual(await spawning, { ok: false, reason: 'turn_interrupted', instruction: 'Your turn was cut off (a pause) while the helper\'s model was being chosen, so no helper was created; spawn it again if it is still needed.' })
  runtime.resumeAgent(runId, 'root')
  const snapshot = await done
  assert.equal(snapshot.status, 'completed')
  assert.equal(helperOf(snapshot), undefined)
})
