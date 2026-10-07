const test = require('node:test')
const assert = require('node:assert/strict')
const { replacements, baselineTier, effortFor, poolMembers, isLocal } = require('../electron/failover.mts')
const { offeredLevels, levelsLine } = require('../electron/reasoning-levels.mts')
const { w, CATALOG, labels, fakeQuota, agentOf, config } = require('./helpers-failover.cjs')

// Several subscriptions of one provider: claude-2 is another Claude account (same vendor, its own quota), an entry of the
// health list like any provider. Failover moves an agent there before it tries another vendor.
const entry = (id, models = ['sonnet', 'opus', 'haiku']) => ({ id, available: true, models })
const TWO = [entry('claude'), entry('claude-2'), CATALOG[0]]
const claudeOpus = (extra = {}) => agentOf({ providerId: 'claude', model: 'opus', requestedModel: 'opus', ...extra })
const ask = (extra = {}) => replacements({ agent: claudeOpus(), catalog: TWO, config: config(), ...extra })

test('an exhausted claude/opus moves to claude-2 with the same model before any other vendor, even a better one', () => {
  const quota = fakeQuota({ claude: { windows: [w(100)] }, 'claude-2': { windows: [w(60)] }, codex: { windows: [w(0)] } })
  const found = ask({ quota })
  assert.equal(labels(found)[0], 'claude-2/opus', 'the same model on the other account comes first')
  assert.ok(labels(found).some(label => label.startsWith('codex/')), 'codex stays a candidate behind it')
  assert.ok(!labels(found).includes('claude/opus') && !labels(found).includes('claude/sonnet'), 'the exhausted account is not offered')
  const ranked = ask({ quota, pool: [{ providerId: 'codex', model: 'gpt-6-astra' }] })
  assert.equal(labels(ranked)[0], 'claude-2/opus', 'not even the user\'s pool rank of codex outranks the same model on another account')
  assert.equal(found[0].key, 'claude-2:opus', 'failed-candidate keys name the instance')
})

test('claude-2 exhausted or near: the usual rules pick another vendor', () => {
  const exhausted = ask({ quota: fakeQuota({ claude: { windows: [w(100)] }, 'claude-2': { windows: [w(100)] }, codex: { windows: [w(20)] } }) })
  assert.ok(exhausted.length && exhausted.every(item => item.providerId === 'codex'), labels(exhausted).join())
  const near = ask({ quota: fakeQuota({ claude: { windows: [w(95)] }, 'claude-2': { windows: [w(95)] }, codex: { windows: [w(20)] } }) })
  assert.ok(near.length && near.every(item => item.providerId === 'codex'), 'both Claude accounts near their limit and codex fine: codex')
  const relaxed = ask({ relaxed: true, quota: fakeQuota({ claude: { windows: [w(95)] }, 'claude-2': { windows: [w(95)] }, codex: { windows: [w(20)] } }) })
  assert.equal(labels(relaxed)[0], 'claude-2/opus', 'after a refusal anything beats stopping: the near second account is the first relaxed choice')
})

test('the same model on the most roomy account first, the default account on ties, the agent itself never', () => {
  const catalog = [entry('claude'), entry('claude-2'), entry('claude-3'), CATALOG[0]]
  const roomy = replacements({ agent: claudeOpus(), catalog, config: config(), quota: fakeQuota({ claude: { windows: [w(100)] }, 'claude-2': { windows: [w(50)] }, 'claude-3': { windows: [w(10)] } }) })
  assert.deepEqual(labels(roomy).slice(0, 2), ['claude-3/opus', 'claude-2/opus'])
  const tie = replacements({ agent: claudeOpus({ providerId: 'claude-3' }), catalog, config: config({ allowWeaker: true }), quota: fakeQuota({}) })
  assert.deepEqual(labels(tie).slice(0, 2), ['claude/opus', 'claude-2/opus'], 'equal headroom: the default id first')
  assert.ok(!labels(tie).includes('claude-3/opus'), 'the agent\'s own provider and model are skipped')
  assert.ok(labels(tie).includes('claude-3/sonnet'), 'another model of its own account is still a candidate')
  const model = replacements({ agent: claudeOpus({ model: 'OPUS', requestedModel: 'OPUS' }), catalog: TWO, config: config(), quota: fakeQuota({}) })
  assert.equal(labels(model)[0], 'claude-2/opus', 'the model is compared case-insensitively')
  const sonnet = replacements({ agent: claudeOpus({ model: 'sonnet', requestedModel: 'sonnet' }), catalog: TWO, config: config(), quota: fakeQuota({ claude: { windows: [w(10)] }, 'claude-2': { windows: [w(80)] } }) })
  assert.equal(labels(sonnet)[0], 'claude-2/sonnet', 'sonnet moves with the agent, even to a fuller account, before claude/opus with more headroom')
  assert.equal(labels(replacements({ agent: agentOf(), catalog: TWO, config: config(), quota: fakeQuota({ codex: { windows: [w(80)] } }) }))[0].startsWith('claude'), true, 'an agent of another vendor has no such preference: headroom decides')
})

test('pool membership: a base entry admits its accounts, an instance entry only itself', () => {
  const unknownModel = [{ id: 'claude', available: true, models: ['mystery-1'] }, { id: 'claude-2', available: true, models: ['mystery-1'] }]
  const agent = agentOf()
  const inPool = pool => Object.fromEntries(replacements({ agent, catalog: unknownModel, pool, config: config() }).map(item => [item.providerId, item.inPool]))
  assert.deepEqual(inPool([]), {}, 'a model of unknown quality is taken only from the pool')
  assert.deepEqual(inPool([{ providerId: 'claude', model: 'mystery-1' }]), { claude: true, 'claude-2': true }, 'claude/x also admits claude-2 with x')
  assert.deepEqual(inPool([{ providerId: 'claude-2', model: 'mystery-1' }]), { 'claude-2': true }, 'claude-2/x admits only claude-2')
  assert.deepEqual(poolMembers([{ providerId: 'claude', model: 'a' }, { providerId: 'claude-2', model: 'b' }, { providerId: 'codex' }], 'claude-2').map(item => item.model), ['b', 'a'])
  assert.deepEqual(poolMembers([{ providerId: 'claude-2', model: 'b' }], 'claude'), [], 'a base id is not admitted by its instances')
  // Without a health list the pool is all that is known, and the run's accounts join it the same way.
  const bare = replacements({ agent, pool: [{ providerId: 'claude', model: 'opus' }], instances: ['claude-2', 'codex-2'], config: config() })
  assert.deepEqual(labels(bare).sort(), ['claude-2/opus', 'claude/opus'], 'codex-2 is not admitted: nothing in the pool names codex')
})

test('avoidProviders: a base id avoids all its accounts, an instance id only itself; skip and failed keys stay exact', () => {
  const agent = agentOf()
  const providers = list => [...new Set(list.map(item => item.providerId))].sort()
  assert.deepEqual(providers(replacements({ agent, catalog: TWO, config: config() })), ['claude', 'claude-2', 'codex'])
  assert.deepEqual(providers(replacements({ agent: { ...agent, avoidProviders: ['claude'] }, catalog: TWO, config: config() })), ['codex'])
  assert.deepEqual(providers(replacements({ agent: { ...agent, avoidProviders: ['claude-2'] }, catalog: TWO, config: config() })), ['claude', 'codex'])
  assert.deepEqual(providers(replacements({ agent, catalog: TWO, config: config(), skip: new Set(['claude-2']) })), ['claude', 'codex'], 'a sign-in failure of claude-2 does not ban claude')
  assert.deepEqual(providers(replacements({ agent, catalog: TWO, config: config(), skip: new Set(['claude']) })), ['claude-2', 'codex'], 'and the other way round')
  const failed = replacements({ agent: claudeOpus({ failedCandidates: new Set(['claude-2:opus']) }), catalog: TWO, config: config({ allowWeaker: true }) })
  assert.ok(!labels(failed).includes('claude-2/opus') && labels(failed).includes('claude-2/sonnet'), 'a failed replacement is remembered by the instance id and model')
})

test('an extra subscription is judged like its base provider', () => {
  assert.equal(baselineTier('claude-2', 'mystery'), baselineTier('claude', 'mystery'))
  assert.equal(baselineTier('cursor-2', ''), baselineTier('cursor', ''))
  assert.deepEqual(offeredLevels('claude-2', 'opus'), offeredLevels('claude', 'opus'))
  assert.deepEqual(offeredLevels('claude-2', 'opus', { id: 'claude-2', reasoningLevels: { opus: ['low', 'max'] } }), ['low', 'max'], 'its own catalog entry wins')
  assert.deepEqual(offeredLevels('antigravity-2', 'gemini-3.1-pro-high'), [], 'Google models have no levels on any account')
  assert.equal(effortFor('antigravity-2', 'gemini', 'high', undefined, 'high'), '')
  assert.equal(effortFor('claude-2', 'opus', 'ultra', undefined, undefined), 'max', 'asking for more gives the top level of the account\'s provider')
  assert.ok(isLocal('ollama') && !isLocal('claude-2'))
  const line = levelsLine([entry('claude'), entry('claude-2')], new Set(['claude']))
  assert.match(line, /claude: .*· claude-2: /, 'a pool entry of the base provider shows its accounts too')
  assert.equal(levelsLine([entry('claude'), entry('claude-2')], new Set(['claude-2'])).includes('claude: '), false)
})
