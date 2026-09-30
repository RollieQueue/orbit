import pathlib

path = pathlib.Path(r'C:\Users\Roman Andreevich\Desktop\smth\tests\failover.test.cjs')
raw = path.read_bytes().decode('utf-8')
assert '\r\n' in raw
text = raw.replace('\r\n', '\n')

def swap(old, new):
    global text
    assert text.count(old) == 1, old
    text = text.replace(old, new)

swap("""    sonnet: 2, 'claude-sonnet-5-thinking-high': 2, 'gpt-5.6-terra': 2, 'gpt-5.5': 2, 'gpt-5.3-codex-high': 2, 'composer-2.5': 2, 'grok-4.7-high': 2, 'gpt-oss-120b-medium': 2,
    haiku: 1, 'gemini-3.8-flash-high': 1, 'gpt-6-luna': 1, 'gpt-5.6-luna': 1, 'gpt-4o-mini': 1,
""", """    sonnet: 2, 'claude-sonnet-5-thinking-high': 2, 'gpt-5.6-terra': 2, 'gpt-5.5': 2, 'gpt-5.3-codex-high': 2, 'composer-2.5': 2, 'grok-4.7-high': 2,
    'claude-haiku-5': 1, 'gemini-3.8-flash-high': 1, 'gpt-5.6-luna': 1, 'gpt-4o-mini': 1,
""")

swap("""test('the model being replaced is judged by its name, else by a deliberately high baseline', () => {""",
"""test('measured tiers of the 2026-09-30 audit come before the names: GPT-6 Luna strong, Haiku 4.5 weak, GPT-OSS unreliable', () => {
  for (const model of ['gpt-6-luna', 'gpt-6-luna-high']) assert.equal(tierOf(model), 2, model)
  for (const model of ['haiku', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5', 'claude-4.5-haiku']) assert.equal(tierOf(model), 0.5, model)
  for (const model of ['gpt-oss-120b-medium', 'gpt-oss:20b']) assert.equal(tierOf(model), 0, model)
  assert.equal(tierOf('gpt-5.6-luna'), 1, 'only the measured model moves, not its whole family')
  assert.equal(tierOf('claude-haiku-5'), 1, 'a later Haiku is light by its name until it is measured')
  assert.equal(baselineTier('claude', 'haiku'), 0.5, 'a Haiku agent accepts light replacements')
  assert.equal(baselineTier('antigravity', 'gpt-oss-120b-medium'), 3, 'an unreliable model is judged by the high provider baseline')
  const { rules } = require('../electron/model-tiers.json')
  assert.equal(rules.filter(rule => rule.measured).length, 3)
  assert.ok(rules.slice(0, 3).every(rule => rule.measured), 'measured rules come first and say why')
})

test('the model being replaced is judged by its name, else by a deliberately high baseline', () => {""")

swap("""  for (const weaker of ['claude/sonnet', 'codex/gpt-5.5', 'cursor/composer-2.5']) { assert.ok(!strict.includes(weaker), weaker); assert.ok(relaxed.includes(weaker), weaker) }
  for (const light of ['claude/haiku', 'codex/gpt-6-luna', 'antigravity/gemini-3.8-flash-high']) assert.ok(!relaxed.includes(light), light)
""", """  for (const weaker of ['claude/sonnet', 'codex/gpt-5.5', 'cursor/composer-2.5', 'codex/gpt-6-luna']) { assert.ok(!strict.includes(weaker), weaker); assert.ok(relaxed.includes(weaker), weaker) }
  for (const light of ['claude/haiku', 'antigravity/gemini-3.8-flash-high']) assert.ok(!relaxed.includes(light), light)
""")

swap("""test('models of unknown quality and local models count only when the user put them in the pool', () => {""",
"""test('measured tiers decide replacements: Luna stands in for strong models, Haiku only for light ones when weaker is allowed, GPT-OSS only from the pool', () => {
  const pick = (agent, extra = {}) => labels(replacements({ agent, catalog: CATALOG, quota: fakeQuota({}), config: config(), ...extra }))
  const sonnet = agentOf({ providerId: 'claude', model: 'sonnet', requestedModel: 'sonnet' })
  assert.ok(pick(sonnet).includes('codex/gpt-6-luna'), 'GPT-6 Luna replaces a strong model')
  const strongWeaker = pick(sonnet, { config: config({ allowWeaker: true }) })
  assert.ok(strongWeaker.includes('antigravity/gemini-3.8-flash-high'), 'one step below strong is light')
  assert.ok(!strongWeaker.includes('claude/haiku'), 'but never Haiku')
  const flash = agentOf({ providerId: 'antigravity', model: 'gemini-3.8-flash-high', requestedModel: 'gemini-3.8-flash-high' })
  assert.ok(!pick(flash).includes('claude/haiku'), 'Haiku is weaker than the light models')
  assert.equal(pick(flash, { config: config({ allowWeaker: true }) }).at(-1), 'claude/haiku', 'one step down allowed: Haiku comes last')
  const withOss = CATALOG.map(entry => entry.id === 'antigravity' ? { ...entry, models: [...entry.models, 'gpt-oss-120b-medium'] } : entry)
  const haiku = agentOf({ providerId: 'claude', model: 'haiku', requestedModel: 'haiku' })
  assert.ok(pick(haiku, { catalog: withOss }).includes('antigravity/gemini-3.8-flash-high'), 'a Haiku agent takes light models')
  assert.ok(!pick(haiku, { catalog: withOss, config: config({ allowWeaker: true }) }).includes('antigravity/gpt-oss-120b-medium'), 'GPT-OSS is never chosen on its own')
  assert.ok(pick(haiku, { catalog: withOss, pool: [{ providerId: 'antigravity', model: 'gpt-oss-120b-medium' }] }).includes('antigravity/gpt-oss-120b-medium'), 'only from the pool')
})

test('models of unknown quality and local models count only when the user put them in the pool', () => {""")

path.write_bytes(text.replace('\n', '\r\n').encode('utf-8'))
print('ok')
