import pathlib

ROOT = pathlib.Path(r'C:\Users\Roman Andreevich\Desktop\smth')

def edit(rel, pairs):
    path = ROOT / rel
    raw = path.read_bytes().decode('utf-8')
    crlf = '\r\n' in raw
    text = raw.replace('\r\n', '\n')
    for old, new in pairs:
        assert text.count(old) == 1, (rel, old[:90])
        text = text.replace(old, new)
    if crlf:
        text = text.replace('\n', '\r\n')
    path.write_bytes(text.encode('utf-8'))
    print('edited', rel, 'crlf' if crlf else 'lf')

edit('electron/model-tiers.json', [
    ('"(?:^|[-_/. ])gpt-6-luna(?=$|[-_/. ])"', '"(?:^|[-_/. ])gpt-6-luna(?=$|[-_/.:@ ])"'),
    ('"^haiku$|(?:^|[-_/. ])(?:haiku[-_.]4[-_.]5|4[-_.]5[-_.]haiku)(?=$|[-_/. ])"', '"^haiku$|(?:^|[-_/. ])(?:haiku[-_.]4[-_.]5|4[-_.]5[-_.]haiku)(?=$|[-_/.:@ ])"'),
    ('"(?:^|[-_/. ])gpt-oss(?=$|[-_/.: ])"', '"(?:^|[-_/. ])gpt-oss(?=$|[-_/.:@ ])"'),
    ('mistakes in code, review and logic."', 'mistakes in code, review and logic. The alias follows the newest Haiku: revisit this rule when it moves past 4.5."'),
])

edit('docs/CHANGELOG.md', [(
    'а следующая Haiku, например `claude-haiku-5`, до нового замера остаётся «лёгкой».',
    'а следующая Haiku, например `claude-haiku-5`, до нового замера остаётся «лёгкой». Псевдоним `haiku` остаётся «слабым», пока указывает на Haiku 4.5; когда он перейдёт на новую модель, правило нужно пересмотреть.',
)])

edit('docs/MODEL-AUDIT.md', [(
    '`haiku` — новый уровень «слабая»: заменяют только слабые модели или, если разрешены более слабые, лёгкие.',
    '`haiku` (пока он указывает на 4.5) — новый уровень «слабая»: заменяют только слабые модели или, если разрешены\n   более слабые, лёгкие.',
)])

edit('tests/failover.test.cjs', [
    ("""  for (const model of ['haiku', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5', 'claude-4.5-haiku']) assert.equal(tierOf(model), 0.5, model)
  for (const model of ['gpt-oss-120b-medium', 'gpt-oss:20b']) assert.equal(tierOf(model), 0, model)
""", """  for (const model of ['haiku', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5', 'claude-4.5-haiku', 'claude-haiku-4-5@20251001']) assert.equal(tierOf(model), 0.5, model)
  for (const model of ['gpt-oss-120b-medium', 'gpt-oss:20b', 'openai/gpt-oss-120b']) assert.equal(tierOf(model), 0, model)
"""),
    ("""  assert.ok(!strongWeaker.includes('claude/haiku'), 'but never Haiku')
""", """  assert.ok(!strongWeaker.includes('claude/haiku'), 'but never Haiku')
  assert.ok(!pick(sonnet, { pool: [{ providerId: 'claude', model: 'haiku' }] }).includes('claude/haiku'), 'not even from the pool')
"""),
    ("""  assert.equal(pick(flash, { config: config({ allowWeaker: true }) }).at(-1), 'claude/haiku', 'one step down allowed: Haiku comes last')
""", """  const flashWeaker = replacements({ agent: flash, catalog: CATALOG, quota: fakeQuota({}), config: config({ allowWeaker: true }) })
  const haikuAt = flashWeaker.findIndex(item => item.model === 'haiku')
  assert.ok(haikuAt >= 0, 'one step down allowed: Haiku is a candidate')
  assert.ok(flashWeaker.every((item, index) => item.tier < 1 || index < haikuAt), 'after every light or better model')
"""),
])
