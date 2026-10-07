const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const instances = require('../electron/instances.mts')
const { loadSrc } = require('./helpers-src.cjs')

// The window (src/subscriptions.ts) and the desktop (electron/instances.mts) each implement the id rules of a subscription
// instance; the window cannot import the desktop's module, so this test is what keeps the two from drifting apart.
let win, dir
test.before(async () => { ({ module: win, dir } = await loadSrc('subscriptions')) })
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

const ids = ['claude', 'codex', 'antigravity', 'cursor', 'ollama', 'custom', 'claude-2', 'claude-12', 'codex-work', 'codex-a-b', 'cursor-1', 'antigravity-9',
  'claude-', 'claude--x', 'claude-2x_', 'Claude-2', 'claude-A', 'codex-' + 'a'.repeat(24), 'codex-' + 'a'.repeat(25), 'ollama-2', 'claude-2/..', '../claude-2', '', ' claude-2', 'claude-2 ']

test('the id rules agree: baseOf, isInstanceId, isBaseProvider, supportsAccounts', () => {
  for (const id of ids) {
    assert.equal(win.baseOf(id), instances.baseOf(id), `baseOf ${JSON.stringify(id)}`)
    assert.equal(win.isInstanceId(id), instances.isInstanceId(id), `isInstanceId ${JSON.stringify(id)}`)
    assert.equal(win.isBaseProvider(id), instances.isBaseProvider(id), `isBaseProvider ${JSON.stringify(id)}`)
    assert.equal(win.supportsAccounts(id), instances.supportsAccounts(id), `supportsAccounts ${JSON.stringify(id)}`)
  }
})

test('the tables agree: base providers, account variables, names', () => {
  assert.deepEqual([...win.BASE_PROVIDERS], [...instances.BASE_PROVIDERS])
  assert.deepEqual({ ...win.ACCOUNT_ENV }, { ...instances.ACCOUNT_ENV })
  assert.deepEqual({ ...win.BASE_NAMES }, { ...instances.BASE_NAMES })
  assert.equal(win.MAX_LABEL, 40)
})

test('nextInstanceId agrees, over several taken sets', () => {
  const sets = [[], ['claude-2'], ['claude-2', 'claude-3', 'codex-2'], ['claude', 'claude-3'], ['codex-2', 'codex-4']]
  for (const taken of sets) for (const base of ['claude', 'codex']) assert.equal(win.nextInstanceId(base, taken), instances.nextInstanceId(base, taken))
  assert.equal(win.nextInstanceId('claude'), 'claude-2')
})

const dirty = [
  null, 'x', {}, [], [null, 3, 'claude-2'],
  [{ id: 'claude-2', label: 'Работа', dir: 'D:\\a\\claude-2' }],
  [{ id: 'claude-2', base: 'claude', label: '  Рабочий  ', dir: '  D:\\a\\1 ' }, { id: 'claude-2', label: 'dup', dir: 'x' }],
  [{ id: 'claude-2', base: 'codex', label: 'wrong base', dir: 'x' }],
  [{ id: 'claude', label: 'a base id', dir: 'x' }, { id: 'ollama-2', label: 'unknown base', dir: 'x' }, { id: 'codex-3', label: 'no dir' }],
  [{ id: 'codex-w', dir: 'C:\\x' }, { id: 'cursor-2', label: 'c', dir: '/c' }, { id: 'antigravity-2', label: 'a', dir: '/a' }],
  [{ id: 'codex-w', label: 'x'.repeat(100), dir: 'C:\\x' }],
  Array.from({ length: 30 }, (_value, index) => ({ id: `claude-${index + 2}`, label: `L${index}`, dir: `/d/${index}` })),
]
test('sanitizeInstances agrees on dirty input', () => {
  for (const input of dirty) assert.deepEqual(win.sanitizeInstances(input), instances.sanitizeInstances(input), JSON.stringify(input)?.slice(0, 80))
  assert.equal(win.sanitizeInstances(dirty[dirty.length - 1]).length, 20)
})

test('instanceOptions agrees: base options inherited, the instance overrides, identity last', () => {
  const list = instances.sanitizeInstances([{ id: 'claude-2', label: 'Работа', dir: 'D:\\a' }, { id: 'codex-2', label: 'Лично', dir: 'D:\\b' }])
  const options = {
    claude: { command: 'C:\\bin\\claude.exe', reasoningEffort: 'high' }, codex: { reasoningEffort: 'low' },
    'claude-2': { reasoningEffort: 'max', base: 'cursor', accountDir: 'C:\\evil', label: 'evil' },
  }
  for (const given of [options, {}, undefined]) assert.deepEqual(win.instanceOptions(list, given), instances.instanceOptions(list, given))
  const merged = win.instanceOptions(list, options)
  assert.deepEqual(merged['claude-2'], { command: 'C:\\bin\\claude.exe', reasoningEffort: 'max', base: 'claude', label: 'Работа', accountDir: 'D:\\a' })
  assert.deepEqual(merged['codex-2'], { reasoningEffort: 'low', base: 'codex', label: 'Лично', accountDir: 'D:\\b' })
  assert.deepEqual(merged.claude, options.claude, 'the base entry is unchanged')
  assert.deepEqual(win.instanceOptions([], undefined), {})
  assert.deepEqual(win.instanceOptions(undefined, undefined), {})
})

test('what the window sends the desktop reads back: instancesFromOptions(instanceOptions(list)) is the list', () => {
  const list = win.sanitizeInstances([{ id: 'claude-2', label: 'Работа', dir: 'D:\\a' }, { id: 'codex-9', label: 'Лично', dir: '/b' }])
  assert.deepEqual(instances.instancesFromOptions(win.instanceOptions(list, { claude: { command: 'c' } })), list)
})

test('the window and the desktop name an account the same way', () => {
  for (const item of win.sanitizeInstances([{ id: 'claude-2', label: 'Работа', dir: 'D:\\a' }])) {
    assert.equal(win.instanceName(item), instances.providerLabel(item.id, { label: item.label }))
  }
})
