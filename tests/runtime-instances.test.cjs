const test = require('node:test')
const assert = require('node:assert/strict')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { w, labels, folder, tool, response, identity, finished, payload, USAGE_LIMIT } = require('./helpers-failover.cjs')

// A run with a second Claude account: providerOptions['claude-2'] carries { base, label, accountDir } next to the CLI options of
// the default account, the health list names claude-2 as a provider of its own, and quota is read and marked per account.
const ACCOUNT = { base: 'claude', label: 'Work', accountDir: 'C:\\accounts\\claude-2' }
const OPTIONS = { claude: { reasoningEffort: 'high' }, 'claude-2': { reasoningEffort: 'high', ...ACCOUNT } }
const entry = (id, models = ['sonnet', 'opus', 'haiku']) => ({ id, available: true, models })
const CATALOG = [entry('claude'), entry('claude-2'), entry('codex', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])]
const POOL = [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex', model: 'gpt-6-sol' }]

// The monitor's surface the runtime uses (peek, get, markExhausted, ingest): one reading per instance id, and a record of what
// was read and marked, so a test can say which account's quota was touched.
function monitor(usage) {
  const windows = { ...usage }, until = {}, record = { marked: [], read: [], peeked: [] }
  const peek = id => windows[id] || until[id] ? { providerId: id, state: 'ok', windows: windows[id] || [], exhaustedUntil: until[id] ?? null, checkedAt: Date.now(), fetchedAt: Date.now() } : null
  return {
    record,
    peek: id => { record.peeked.push(id); return peek(id) },
    get: async (id, options = {}) => { record.read.push({ id, options: options.options }); return peek(id) },
    markExhausted: (id, info) => { record.marked.push(id); until[id] = info?.resetsAt || Date.now() + 30 * 60000 },
    ingest: () => {},
  }
}
const world = (usage, catalog = CATALOG) => { const quota = monitor(usage); return { quota, runtime: run => new OrbitRuntime({ runProvider: run, quota, catalog: async () => catalog }) } }
const start = (workspace, extra = {}) => payload(workspace, { providerId: 'claude', model: 'opus', providerOptions: OPTIONS, providerPool: POOL, ...extra })

test('claude refuses with a usage limit: the agent moves to claude-2 with the same model, and only claude is marked exhausted', async t => {
  const workspace = folder(t), calls = []
  const { runtime, quota } = world({ claude: [w(10)], 'claude-2': [w(10)], codex: [w(0)] })
  const { snapshot } = await finished(runtime(async options => {
    calls.push({ providerId: options.providerId, model: options.model, providerOptions: options.providerOptions, prompt: options.prompt })
    if (options.providerId === 'claude') throw new Error(USAGE_LIMIT)
    return { text: 'Done on the second account' }
  }), start(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls.map(call => `${call.providerId}/${call.model}`), ['claude/opus', 'claude-2/opus'], 'the same vendor and model, not codex')
  assert.equal(calls[1].providerOptions.accountDir, ACCOUNT.accountDir, 'the repeated turn runs with the account\'s own options')
  assert.deepEqual([calls[1].providerOptions.base, calls[1].providerOptions.label], ['claude', 'Work'])
  assert.equal(calls[0].providerOptions.accountDir, undefined, 'the default account is run as before')
  const root = snapshot.agents[0]
  assert.deepEqual([root.providerId, root.model], ['claude-2', 'opus'])
  assert.deepEqual([root.handovers[0].from.providerId, root.handovers[0].to.providerId, root.handovers[0].reason], ['claude', 'claude-2', 'exhausted'])
  assert.deepEqual(quota.record.marked, ['claude'], 'the refusal marks the account that refused, never claude-2 or a base for an instance')
  assert.ok(quota.record.read.some(item => item.id === 'claude-2' && item.options?.accountDir === ACCOUNT.accountDir), 'the other account\'s quota was read with its own options before the choice')
  assert.match(snapshot.traces.map(trace => trace.text || trace.message || '').join('\n'), /claude \/ opus → claude-2 \/ opus/)
})

test('an agent on claude-2 whose account refuses moves back to the default account; claude is not marked', async t => {
  const workspace = folder(t), calls = []
  const { runtime, quota } = world({ claude: [w(10)], 'claude-2': [w(10)], codex: [w(0)] })
  const { snapshot } = await finished(runtime(async options => {
    calls.push(options.providerId)
    if (options.providerId === 'claude-2') throw new Error(USAGE_LIMIT)
    return { text: 'Back on the default account' }
  }), start(workspace, { providerId: 'claude-2' }))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['claude-2', 'claude'])
  assert.deepEqual(quota.record.marked, ['claude-2'])
  assert.equal(snapshot.agents[0].providerId, 'claude')
})

test('both Claude accounts out: the agent leaves for codex; a claude-2 that cannot sign in is dropped and the agent moves on', async t => {
  const out = folder(t), calls = []
  const first = world({ claude: [w(10)], 'claude-2': [w(100)], codex: [w(0)] })
  const { snapshot } = await finished(first.runtime(async options => {
    calls.push(options.providerId)
    if (options.providerId === 'claude') throw new Error(USAGE_LIMIT)
    return { text: 'ok' }
  }), start(out))
  assert.deepEqual(calls, ['claude', 'codex'], 'claude-2 is exhausted: the usual rules pick codex')
  assert.equal(snapshot.status, 'completed')
  const broken = folder(t), tries = []
  const second = world({ claude: [w(10)], 'claude-2': [w(10)], codex: [w(0)] })
  const result = await finished(second.runtime(async options => {
    tries.push(options.providerId)
    if (options.providerId === 'claude-2') throw new Error('Not logged in · Please run claude login')
    if (options.providerId === 'claude' && tries.length === 1) throw new Error(USAGE_LIMIT)
    return { text: 'ok' }
  }), start(broken))
  assert.equal(result.snapshot.status, 'completed')
  assert.deepEqual(tries.slice(0, 3), ['claude', 'claude-2', 'codex'], 'claude-2 could not sign in, so the agent moved on')
  const run = result.snapshot
  assert.notEqual(run.agents[0].providerId, 'claude-2')
})

// The root (claude/opus) spawns one helper and waits; `helper` plays its provider calls.
async function spawned(t, usage, spec, extra = {}, catalog = CATALOG) {
  const workspace = folder(t), calls = [], rootPrompts = []
  const { runtime, quota } = world(usage, catalog)
  let rootTurn = 0
  const { snapshot } = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Helper') { calls.push({ providerId: options.providerId, model: options.model, providerOptions: options.providerOptions }); return { text: 'helped' } }
    rootPrompts.push(options.prompt)
    switch (++rootTurn) {
      case 1: return response(tool('spawn_agent', { name: 'Helper', task: 'Do the part', reason: 'Independent work', ...spec }), tool('wait_agent'))
      default: return { text: 'Integrated' }
    }
  }), start(workspace, extra))
  return { snapshot, calls, rootPrompts, quota, helper: snapshot.agents.find(agent => agent.name === 'Helper') }
}
// No provider pool: every account of every provider may be chosen.
const FREE = { providerPool: [] }
const HEALTHY = { claude: [w(10)], 'claude-2': [w(10)], codex: [w(10)] }

test('spawn_agent accepts providerId claude-2: the helper runs on that account with its options', async t => {
  const { helper, calls, rootPrompts } = await spawned(t, HEALTHY, { providerId: 'claude-2', model: 'opus' })
  assert.deepEqual([helper.providerId, helper.model, helper.status], ['claude-2', 'opus', 'done'])
  assert.deepEqual(calls.map(call => `${call.providerId}/${call.model}`), ['claude-2/opus'])
  assert.equal(calls[0].providerOptions.accountDir, ACCOUNT.accountDir)
  assert.match(rootPrompts.at(-1), /"providerId":\s*"claude-2"/, 'the spawn answer names the instance')
  const pooled = await spawned(t, HEALTHY, { providerId: 'claude-2' })
  assert.deepEqual([pooled.helper.providerId, pooled.helper.model], ['claude-2', 'opus'], 'the pool entry claude/opus admits claude-2 and gives it the model')
})

test("an unknown instance id is refused with the ones the run has; the accounts of the run's vendor are allowed whatever the pool says", async t => {
  const refused = await spawned(t, HEALTHY, { providerId: 'claude-9' })
  assert.equal(refused.helper, undefined, 'no helper was created')
  assert.match(refused.rootPrompts.at(-1), /unknown_provider/)
  assert.match(refused.rootPrompts.at(-1), /claude-9 is not a subscription of this run/)
  assert.match(refused.rootPrompts.at(-1), /claude-2 \(Claude Code · Work\)/, 'the message names the known accounts')
  const none = await spawned(t, HEALTHY, { providerId: 'claude-2' }, { providerOptions: { claude: OPTIONS.claude } })
  assert.equal(none.helper, undefined, 'a run without instances refuses claude-2 the same way')
  assert.match(none.rootPrompts.at(-1), /This run has no extra subscriptions/)
  const codexOnly = await spawned(t, HEALTHY, { providerId: 'claude-2' }, { providerPool: [{ providerId: 'codex', model: 'gpt-6-sol' }] })
  assert.equal(codexOnly.helper?.providerId, 'claude-2', 'the run is on claude: its second account is allowed although the pool lists codex only')
  const conflict = await spawned(t, HEALTHY, { providerId: 'claude-2', avoidProviders: ['claude'] })
  assert.equal(conflict.helper, undefined, 'avoiding claude avoids claude-2 too, so naming it contradicts')
  assert.match(conflict.rootPrompts.at(-1), /invalid_avoid_providers/)
})

test('kind routing: a helper for code goes to claude-2 when claude is out; avoidProviders claude keeps both accounts out', async t => {
  const out = await spawned(t, { ...HEALTHY, claude: [w(100)] }, { kind: 'code' }, FREE)
  assert.deepEqual([out.helper.providerId, out.helper.model], ['claude-2', 'sonnet'])
  assert.match(out.rootPrompts.at(-1), /claude-2\/sonnet/, 'the routed line names the instance')
  assert.ok(out.quota.record.read.some(item => item.id === 'claude-2' && item.options?.accountDir === ACCOUNT.accountDir), 'its quota was refreshed with its options')
  const avoid = await spawned(t, HEALTHY, { kind: 'code', avoidProviders: ['claude'] }, FREE)
  assert.equal(avoid.helper.providerId, 'codex', 'claude-2 is out of the routing too')
  assert.deepEqual(avoid.helper.avoidProviders, ['claude'])
  const narrow = await spawned(t, { ...HEALTHY, claude: [w(100)] }, { kind: 'code', providerId: 'claude' }, FREE)
  assert.equal(narrow.helper.providerId, 'claude-2', 'providerId claude alone means any account of it')
  const exact = await spawned(t, { ...HEALTHY, claude: [w(0)], 'claude-2': [w(40)] }, { kind: 'code', providerId: 'claude-2' }, FREE)
  assert.equal(exact.helper.providerId, 'claude-2', 'an instance id means exactly that account')
})

test('a helper that must stay where it is is never moved to the other account of the same provider by the failover', async t => {
  const pinned = await spawned(t, HEALTHY, { providerId: 'claude', model: 'opus', failover: 'none' })
  assert.equal(pinned.helper.failover, 'none')
  assert.equal(pinned.helper.providerId, 'claude')
})

test('the prompt lists the accounts only when the run has them; without any it is exactly as before', async t => {
  const withAccounts = await spawned(t, HEALTHY, {})
  const [first] = withAccounts.rootPrompts
  assert.match(first, /EXTRA SUBSCRIPTIONS \(same vendor, separate quota: failover moves an agent here before any other vendor[^)]*\): claude-2 = Claude Code · Work/)
  assert.match(first, /PROVIDER POOL: \[[^\n]*\]\nEXTRA SUBSCRIPTIONS[^\n]*\nREASONING LEVELS/, 'one short line between the pool and the levels')
  const plain = await spawned(t, HEALTHY, {}, { providerOptions: { claude: OPTIONS.claude } }, CATALOG.filter(item => item.id !== 'claude-2'))
  assert.doesNotMatch(plain.rootPrompts[0], /EXTRA SUBSCRIPTIONS|claude-2/)
  assert.match(plain.rootPrompts[0], /PROVIDER POOL: \[[^\n]*\]\nREASONING LEVELS/)
})

test('without instances the failover is what it was: a refusal still moves the agent to the best other vendor', async t => {
  const workspace = folder(t), calls = []
  const { runtime, quota } = world({ claude: [w(10)], codex: [w(0)] }, [entry('claude'), entry('codex', ['gpt-6-astra', 'gpt-6-sol'])])
  const { snapshot } = await finished(runtime(async options => {
    calls.push(options.providerId)
    if (options.providerId === 'claude') throw new Error(USAGE_LIMIT)
    return { text: 'ok' }
  }), start(workspace, { providerOptions: { claude: OPTIONS.claude } }))
  assert.deepEqual(calls, ['claude', 'codex'])
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(quota.record.marked, ['claude'])
  assert.deepEqual(labels(snapshot.agents[0].handovers.map(item => item.to)), ['codex/gpt-6-sol'])
})
