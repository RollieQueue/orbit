const test = require('node:test')
const assert = require('node:assert/strict')
const { replacements, isPinned } = require('../electron/failover.mts')
const { ranOnFields, agentDirectory } = require('../electron/runtime/agents.mts')
const { validate } = require('../electron/tool-registry.mts')
const { route } = require('../electron/model-routing.mts')
const { w, CATALOG, labels, fakeQuota, agentOf, config, folder, tool, response, identity, finished, payload, world, USAGE_LIMIT } = require('./helpers-failover.cjs')

// spawn_agent's failover options: a helper the caller sent to one subscription (an independent judge of another vendor)
// is never moved to another one without the caller being told, and can be forbidden to move at all.
const HEALTHY = fakeQuota({ codex: { windows: [w(20)] }, claude: { windows: [w(10)] }, antigravity: { windows: [w(10)] }, cursor: { windows: [w(10)] } })
const pick = extra => labels(replacements({ agent: agentOf({ providerId: 'codex', ...extra }), catalog: CATALOG, quota: HEALTHY, config: config() }))

// ---- replacements() and isPinned() ---------------------------------------------------------------------------------

test('replacements() never offers an avoided provider', () => {
  assert.ok(pick().some(label => label.startsWith('claude/')), 'control: claude is a candidate when nothing is avoided')
  const avoided = pick({ avoidProviders: ['claude'] })
  assert.ok(avoided.length, 'other subscriptions still qualify')
  assert.ok(!avoided.some(label => label.startsWith('claude/')), 'claude is gone')
  assert.deepEqual(pick({ avoidProviders: CATALOG.map(entry => entry.id) }), [], 'avoiding everything leaves nothing')
})

test("replacements() finds nobody for an agent pinned with failover 'none'", () => {
  assert.ok(pick().length > 0)
  assert.deepEqual(pick({ failover: 'none' }), [])
})

test('a review sent to another subscription than the caller\'s is pinned unless failover says auto', () => {
  assert.equal(isPinned({ kind: 'review', providerId: 'codex' }, 'claude'), true)
  assert.equal(isPinned({ kind: 'review', providerId: 'codex', failover: 'auto' }, 'claude'), false)
  assert.equal(isPinned({ kind: 'review', providerId: 'claude' }, 'claude'), false, 'the caller\'s own subscription is no cross-vendor judge')
  assert.equal(isPinned({ kind: 'review' }, 'claude'), false, 'no provider named: no pin')
  assert.equal(isPinned({ kind: 'code', providerId: 'codex' }, 'claude'), false)
  assert.equal(isPinned({ kind: 'code', providerId: 'codex', failover: 'none' }, 'claude'), true)
})

// ---- the option is accepted, validated and stored ------------------------------------------------------------------

test('the registry accepts failover and avoidProviders and rejects wrong values', () => {
  const base = { task: 'x', reason: 'r' }
  assert.deepEqual(validate('spawn_agent', { ...base, failover: 'none', avoidProviders: ['claude'] }), { ok: true, args: { ...base, failover: 'none', avoidProviders: ['claude'] } })
  assert.match(validate('spawn_agent', { ...base, failover: 'never' }).error, /failover must be one of/)
  assert.match(validate('spawn_agent', { ...base, avoidProviders: 'claude' }).error, /avoidProviders must be an array/)
  assert.match(validate('spawn_agent', { ...base, avoidProviders: [3] }).error, /avoidProviders\[0\]/)
})

const POOL = [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex', model: 'gpt-6-sol' }]
// The root (claude) spawns one helper, waits for it, and lists the agents; `helper` plays the helper's provider calls.
async function judged(t, usage, spec, helper, extra = {}) {
  const workspace = folder(t), calls = [], rootPrompts = []
  const { runtime } = world(t, usage)
  let rootTurn = 0
  const { snapshot } = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    if (name === 'Helper') { calls.push(options.providerId); return helper(options, calls) }
    rootPrompts.push(options.prompt)
    switch (++rootTurn) {
      case 1: return response(tool('spawn_agent', { name: 'Helper', task: 'Judge the build', reason: 'An independent judge', ...spec }), tool('wait_agent'))
      case 2: return response(tool('list_agents'))
      default: return { text: 'Reviewed' }
    }
  }), payload(workspace, { providerId: 'claude', model: 'opus', providerPool: POOL, ...extra }))
  return { snapshot, calls, rootPrompts, helper: snapshot.agents.find(agent => agent.name === 'Helper') }
}
const refuse = (options, calls) => { if (options.providerId === 'codex') throw new Error(USAGE_LIMIT); return { text: 'judged elsewhere' } }
const SOL = { providerId: 'codex', model: 'gpt-6-sol' }

test("a pinned helper stays on its subscription and stops with an error that names it", async t => {
  const { helper, calls, rootPrompts } = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, failover: 'none' }, refuse)
  assert.deepEqual(calls, ['codex'], 'it was never started elsewhere')
  assert.equal(helper.status, 'error')
  assert.equal(helper.handovers.length, 0)
  assert.equal(helper.failover, 'none', 'the option is stored on the agent')
  assert.match(helper.error, /«codex»/)
  assert.match(helper.error, /failover 'none'/)
  assert.match(rootPrompts.at(-1), /failover \\?'none\\?'/, 'the parent sees the reason through wait_agent')
})

test('a pinned helper whose provider fails for another reason stops too, and names the provider', async t => {
  const crash = options => { if (options.providerId === 'codex') throw new Error('codex exited with code 3'); return { text: 'elsewhere' } }
  const { helper, calls } = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, failover: 'none' }, crash)
  assert.deepEqual(calls, ['codex'])
  assert.equal(helper.status, 'error')
  assert.match(helper.error, /«codex»[^]*привязан[^]*failover 'none'[^]*exited with code 3/)
  const free = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL }, crash)
  assert.equal(free.helper.providerId, 'claude', 'control: without the pin the failed provider is replaced')
})

test('avoidProviders also narrows the model Orbit picks for a kind of work', async t => {
  const pool = { providerPool: [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex' }] }
  const control = await judged(t, { codex: [w(20)], claude: [w(10)] }, { kind: 'review' }, () => ({ text: 'ok' }), pool)
  assert.deepEqual(control.calls, ['codex'], 'control: codex heads the table for review')
  const { helper, calls } = await judged(t, { codex: [w(20)], claude: [w(10)] }, { kind: 'review', avoidProviders: ['codex'] }, () => ({ text: 'ok' }), pool)
  assert.ok(helper && !calls.includes('codex'), `ran on ${calls}`)
  assert.equal(helper.providerId, 'claude')
})

test('a review on another subscription than the caller\'s is pinned by default, failover auto lets it move and says so', async t => {
  const pinned = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, kind: 'review' }, refuse)
  assert.deepEqual(pinned.calls, ['codex'])
  assert.equal(pinned.helper.failover, 'none')
  const free = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, kind: 'review', failover: 'auto' }, refuse)
  assert.equal(free.helper.status, 'done')
  assert.equal(free.helper.failover, undefined)
  assert.equal(free.helper.providerId, 'claude')
  assert.equal(free.helper.handovers[0].fresh, true, 'it moved before doing anything, which ranOn does not report')
  const seen = free.rootPrompts.at(-1)
  assert.match(seen, /failedOver/, 'wait_agent and list_agents tell the parent')
  assert.match(seen.replaceAll('\\"', '"'), /"from":"codex\/gpt-6-sol","to":"claude\/opus","switches":1,"why":"quota exhausted"/)
})

test('a review the routing table sends to another subscription is not pinned: it may move as usual', async t => {
  const pool = { providerPool: [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex' }] }
  const { helper, calls } = await judged(t, { codex: [w(20)], claude: [w(10)] }, { kind: 'review' }, refuse, pool)
  assert.equal(calls[0], 'codex', 'the table chose codex')
  assert.equal(helper.failover, undefined, 'only a subscription the caller named pins a review')
  assert.equal(helper.providerId, 'claude')
  assert.equal(helper.status, 'done')
})

test('avoidProviders keeps a helper off those subscriptions when it has to move', async t => {
  const usage = { codex: [w(20)], claude: [w(10)], antigravity: [w(5)], cursor: [w(5)] }
  const control = await judged(t, usage, { ...SOL }, refuse)
  assert.equal(control.helper.providerId, 'claude', 'control: without the option the helper moves to claude')
  const { helper, calls } = await judged(t, usage, { ...SOL, avoidProviders: ['claude'] }, refuse)
  assert.deepEqual(helper.avoidProviders, ['claude'])
  assert.notEqual(helper.providerId, 'claude')
  assert.ok(!calls.includes('claude'))
  assert.equal(helper.status, 'done')
})

test('a spawn with a wrong failover or avoidProviders is refused with an instruction', async t => {
  const bad = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, failover: 'never' }, refuse)
  assert.match(bad.rootPrompts.at(-1), /invalid_failover/)
  assert.equal(bad.helper, undefined)
  const clash = await judged(t, { codex: [w(20)], claude: [w(10)] }, { ...SOL, avoidProviders: ['codex'] }, refuse)
  assert.match(clash.rootPrompts.at(-1), /invalid_avoid_providers/)
  assert.equal(clash.helper, undefined)
})

test('routing a helper by kind passes over the providers the caller ruled out', () => {
  const input = { kind: 'review', catalog: null, known: new Set(['claude', 'codex']), pool: [], runProviderId: 'claude', quota: null, threshold: 90, now: 0, skip: new Set() }
  assert.equal(route(input).choice.providerId, 'codex', 'control: codex heads the table for review')
  const { choice, skipped } = route({ ...input, avoid: new Set(['codex']) })
  assert.notEqual(choice.providerId, 'codex')
  assert.ok(skipped.some(line => line.startsWith('codex/') && /avoidProviders/.test(line)))
})

// ---- a subscription with no usable model --------------------------------------------------------------------------

test('a pinned review whose subscription is out of quota is not started; a free one starts and the result says it may move', async t => {
  const spec = { providerId: 'codex', kind: 'review' }
  const refused = await judged(t, { codex: [w(100)], claude: [w(10)] }, spec, () => ({ text: 'unreachable' }))
  assert.match(refused.rootPrompts.at(-1), /provider_unavailable/)
  assert.match(refused.rootPrompts.at(-1), /quota used up/)
  assert.equal(refused.helper, undefined, 'no helper was created')
  assert.deepEqual(refused.calls, [])
  const free = await judged(t, { codex: [w(100)], claude: [w(10)] }, { ...spec, failover: 'auto' }, () => ({ text: 'ok' }))
  assert.ok(free.helper, 'the helper starts')
  assert.match(free.rootPrompts.at(-1).replaceAll('\\"', '"'), /Orbit may move it to another subscription/)
})

// ---- visibility ----------------------------------------------------------------------------------------------------

const move = (from, to, extra = {}) => ({ id: 'h', time: 't', reason: 'exhausted', from, to, fresh: true, usedPercent: 100, resetsAt: null, interrupted: false, turn: 0, ...extra })
const CODEX = { providerId: 'codex', model: '' }, GEMINI = { providerId: 'antigravity', model: 'gemini-3.1-pro-high' }, OPUS = { providerId: 'claude', model: 'opus' }

test('a switch before the first turn is reported by wait_agent and list_agents as failedOver', () => {
  const agent = { ...OPUS, handovers: [move(CODEX, GEMINI), move(GEMINI, OPUS, { reason: 'replacement-failed' })] }
  const fields = ranOnFields(agent)
  assert.equal(fields.ranOn, undefined, 'nothing worked on the first models, so ranOn stays silent')
  assert.deepEqual(fields.failedOver, { from: 'codex', to: 'claude/opus', switches: 2, why: 'quota exhausted', steps: 'codex → antigravity/gemini-3.1-pro-high before any turn (exhausted); antigravity/gemini-3.1-pro-high → claude/opus before any turn (replacement-failed)' })
  assert.deepEqual(ranOnFields({ ...OPUS, handovers: [] }), {}, 'an agent that never moved has no field')
  const run = { limits: { maxOutputChars: 40000 }, agentNodes: new Map([['a', { id: 'a', name: 'A', task: 't', result: '', status: 'working', generation: 0, ...agent }], ['b', { id: 'b', name: 'B', task: 't', result: '', status: 'working', generation: 0, ...OPUS, handovers: [] }]]) }
  const [a, b] = agentDirectory(null, run)
  assert.deepEqual(a.failedOver, { from: 'codex', to: 'claude/opus', switches: 2, why: 'quota exhausted' })
  assert.ok(!('failedOver' in b))
})
