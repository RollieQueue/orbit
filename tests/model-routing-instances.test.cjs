const test = require('node:test')
const assert = require('node:assert/strict')
const { route } = require('../electron/model-routing.mts')

// The routing table names providers (claude, codex); every account of a provider is a candidate for its rows. The run has a
// second Claude account, claude-2: same vendor, its own quota.
const w = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })
const entry = (id, models = ['sonnet', 'opus', 'haiku']) => ({ id, available: true, models })
const CATALOG = [entry('claude'), entry('claude-2'), entry('codex', ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra']), entry('antigravity', ['gemini-3.1-pro-high', 'gemini-3.8-flash-high'])]
const fakeQuota = snapshots => ({ peek: id => snapshots[id] ? { providerId: id, ...snapshots[id] } : null })
const input = (extra = {}) => ({ kind: 'code', catalog: CATALOG, known: new Set(), pool: [], runProviderId: 'claude', quota: fakeQuota({}), threshold: 90, now: Date.now(), skip: new Set(), ...extra })
const picked = result => result.choice && `${result.choice.providerId}/${result.choice.model}`
const used = (claude, second) => fakeQuota({ ...(claude === undefined ? {} : { claude: { windows: [w(claude)] } }), ...(second === undefined ? {} : { 'claude-2': { windows: [w(second)] } }) })

test('the default account that is out of quota hands the work to claude-2 before the next provider of the table', () => {
  const result = route(input({ quota: used(100, 20) }))
  assert.equal(picked(result), 'claude-2/sonnet', 'the table row is claude/sonnet; its other account takes it')
  assert.deepEqual(result.skipped, ['claude/sonnet: quota used up'], 'the skipped entry names the account')
  assert.equal(result.choice.reasoningEffort, 'high')
  const near = route(input({ quota: used(95, 20) }))
  assert.deepEqual([picked(near), near.skipped], ['claude-2/sonnet', ['claude/sonnet: quota 95% used']])
  const both = route(input({ quota: used(100, 100) }))
  assert.equal(picked(both), 'codex/gpt-6-astra', 'both accounts out: the table\'s next candidate')
  assert.deepEqual(both.skipped, ['claude/sonnet: quota used up', 'claude-2/sonnet: quota used up'])
})

test('among the usable accounts the one with the least quota used wins, the default account on a tie', () => {
  assert.equal(picked(route(input({ quota: used(40, 10) }))), 'claude-2/sonnet')
  assert.equal(picked(route(input({ quota: used(10, 40) }))), 'claude/sonnet')
  assert.equal(picked(route(input({ quota: used(30, 30) }))), 'claude/sonnet', 'a tie: the default account')
  assert.equal(picked(route(input())), 'claude/sonnet', 'nothing measured: the default account')
  const three = route(input({ catalog: [...CATALOG, entry('claude-3')], quota: fakeQuota({ claude: { windows: [w(50)] }, 'claude-2': { windows: [w(20)] }, 'claude-3': { windows: [w(5)] } }) }))
  assert.equal(picked(three), 'claude-3/sonnet')
})

test('providerId narrows by account: a base id to any account of it, an instance id to exactly that one', () => {
  assert.equal(picked(route(input({ providerId: 'claude', quota: used(100, 20) }))), 'claude-2/sonnet', 'claude covers claude-2')
  assert.equal(picked(route(input({ providerId: 'claude', quota: used(10, 20) }))), 'claude/sonnet')
  assert.equal(picked(route(input({ providerId: 'claude-2', quota: used(0, 60) }))), 'claude-2/sonnet', 'claude-2 exactly, though the default account has more room')
  const exact = route(input({ providerId: 'claude-2', quota: used(0, 100) }))
  assert.equal(exact.choice, null, 'claude-2 is out and nothing else is offered')
  assert.deepEqual(exact.skipped, ['claude-2/sonnet: quota used up'], 'only the named account is judged')
  assert.equal(picked(route(input({ providerId: 'codex', quota: used(0, 0) }))), 'codex/gpt-6-astra', 'another provider named: only its rows')
  assert.equal(route(input({ providerId: 'claude-9' })).choice, null, 'an account nobody knows is not connected')
  assert.deepEqual(route(input({ providerId: 'claude-9' })).skipped, ['claude-9/sonnet: not connected'])
})

test('avoid: a base id rules out all its accounts, an instance id only itself', () => {
  const none = route(input({ avoid: new Set(['claude']), quota: used(0, 0) }))
  assert.equal(picked(none), 'codex/gpt-6-astra', 'claude and claude-2 are both out')
  assert.deepEqual(none.skipped, ['claude/sonnet: ruled out by avoidProviders', 'claude-2/sonnet: ruled out by avoidProviders'])
  assert.equal(picked(route(input({ avoid: new Set(['claude-2']), quota: used(50, 0) }))), 'claude/sonnet', 'only claude-2 is out: the default account stays')
  assert.equal(picked(route(input({ avoid: new Set(['claude-2']), quota: used(100, 0) }))), 'codex/gpt-6-astra')
})

test('the provider pool is base-aware: claude admits its accounts, claude-2 only itself; the run provider is always allowed', () => {
  const run = { runProviderId: 'codex' }
  const base = route(input({ ...run, pool: [{ providerId: 'claude', model: 'sonnet' }], quota: used(100, 20) }))
  assert.equal(picked(base), 'claude-2/sonnet', 'a pool entry for claude admits claude-2')
  const only = route(input({ ...run, pool: [{ providerId: 'claude-2' }], quota: used(0, 60) }))
  assert.equal(picked(only), 'claude-2/sonnet')
  assert.deepEqual(only.skipped, ['claude/sonnet: not in the provider pool'], 'an instance entry does not admit the base')
  const wrongModel = route(input({ runProviderId: 'ollama', kind: 'text', pool: [{ providerId: 'claude-2', model: 'sonnet' }] }))
  assert.equal(picked(wrongModel), null, 'text wants opus: claude-2 is pooled with sonnet only, claude not at all, nothing else of the table is pooled and the run is on neither')
  assert.ok(wrongModel.skipped.includes('claude-2/opus: not in the provider pool'))
  const sameVendor = route(input({ runProviderId: 'claude', pool: [{ providerId: 'codex' }], quota: used(100, 20) }))
  assert.equal(picked(sameVendor), 'claude-2/sonnet', 'the run is on claude: its other accounts are allowed although the pool lists codex only')
})

test('a provider that could not answer is skipped exactly; without a health list only the known accounts count', () => {
  assert.equal(picked(route(input({ skip: new Set(['claude-2']), quota: used(100, 0) }))), 'codex/gpt-6-astra', 'claude-2 failed to answer: it is out, and claude is out of quota')
  assert.equal(picked(route(input({ skip: new Set(['claude']), quota: used(0, 50) }))), 'claude-2/sonnet', 'a sign-in failure of claude does not ban claude-2')
  const bare = route(input({ catalog: null, known: new Set(['claude', 'claude-2']), quota: used(100, 20) }))
  assert.equal(picked(bare), 'claude-2/sonnet')
  const unlisted = route(input({ catalog: null, known: new Set(['claude']), quota: used(100, 20) }))
  assert.equal(picked(unlisted), null, 'claude-2 is not known to answer without the list, the default account is full')
  const runAccount = route(input({ catalog: null, known: new Set(['claude-2']), runProviderId: 'claude-2', pool: [{ providerId: 'claude' }] }))
  assert.equal(picked(runAccount), 'claude-2/sonnet', 'the run\'s own account joins the candidates through the run provider id')
})
