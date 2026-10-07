const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { loadSrcs } = require('./helpers-src.cjs')

// The pure logic behind the window's «Добавить подписку»: the state migration, the add and remove transitions, the provider
// lists and the sentences the owner reads. There is no component-test infrastructure, so the components only render these.
let sub, store, providers, dirs = []
test.before(async () => {
  const loaded = await loadSrcs(['subscriptions', 'state-store', 'providers'])
  sub = loaded.modules.subscriptions; store = loaded.modules['state-store']; providers = loaded.modules.providers; dirs = [loaded.dir]
})
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }) })

// A state saved before subscriptions existed: every field an older Orbit wrote, and none of the new one.
const OLD_STATE = {
  version: 3, activeProjectId: 'p1', savedAt: 1700000000000,
  projects: [{ id: 'p1', workspace: { path: 'C:\\work\\alpha', name: 'alpha', connected: false, branch: '', changedFiles: 0 }, chats: [{ id: 'c1', title: 'Чат', messages: [{ id: 'm1', author: 'user', text: 'привет', time: '2026-09-29T10:00:00.000Z' }], updated: '2026-09-29T10:00:00.000Z' }], activeChatId: 'c1' }],
  settings: {
    providerId: 'claude', models: { claude: 'opus', codex: 'gpt-5' }, limitVersion: 2, improvementMode: true, skillLearning: true,
    providerPool: [{ providerId: 'codex', model: 'gpt-5', reasoningEffort: 'high' }, { providerId: 'claude', model: 'sonnet', reasoningEffort: '' }],
    providerOptions: { claude: { command: 'C:\\bin\\claude.exe', reasoningEffort: 'high' }, antigravity: { proxyMode: 'system' } },
    quotaFailover: { enabled: true, switchAtPercent: 85, allowWeaker: false }, memoryEnabled: true, accessMode: 'workspace-write', approvalPolicy: 'on-request',
    reasoningEffort: '', agentInstructions: 'отвечай по-русски', limits: { maxAgents: null, maxDepth: 4, maxConcurrent: null, maxTurns: null, maxTotalTurns: null },
  },
}
const clone = value => JSON.parse(JSON.stringify(value))

test('migration is a no-op: an old saved state normalizes to what it was plus subscriptions: []', () => {
  const { subscriptions, ...settings } = store.normalize(clone(OLD_STATE)).settings
  assert.deepEqual(subscriptions, [])
  assert.deepEqual(settings, { ...OLD_STATE.settings, providerPool: OLD_STATE.settings.providerPool })
  assert.equal(store.normalize(clone(OLD_STATE)).settings.providerId, 'claude')
  assert.deepEqual(store.normalize(clone(OLD_STATE)).projects, OLD_STATE.projects)
})

test('normalize survives a JSON round trip unchanged (with and without subscriptions)', () => {
  for (const state of [OLD_STATE, { ...OLD_STATE, settings: { ...OLD_STATE.settings, providerId: 'claude-2', subscriptions: [{ id: 'claude-2', base: 'claude', label: 'Рабочий', dir: 'D:\\a\\claude-2' }],
    providerPool: [{ providerId: 'claude-2', model: '', reasoningEffort: '' }] } }, {}]) {
    const once = store.normalize(clone(state))
    assert.deepEqual(store.normalize(JSON.parse(JSON.stringify(once))), once)
  }
})

test('the saved subscriptions are made valid, the active provider may be an instance, a removed instance falls back to codex', () => {
  const subscriptions = [{ id: 'claude-2', label: 'Рабочий', dir: 'D:\\a' }, { id: 'bad id', label: 'x', dir: 'y' }, { id: 'cursor-2', label: 'c', dir: 'd' }, { id: 'codex-2', label: 'Лично' }]
  const withInstance = store.normalize({ settings: { ...OLD_STATE.settings, providerId: 'claude-2', subscriptions } }).settings
  assert.deepEqual(withInstance.subscriptions, [{ id: 'claude-2', base: 'claude', label: 'Рабочий', dir: 'D:\\a' }, { id: 'cursor-2', base: 'cursor', label: 'c', dir: 'd' }])
  assert.equal(withInstance.providerId, 'claude-2')
  assert.equal(store.normalize({ settings: { ...OLD_STATE.settings, providerId: 'claude-3', subscriptions } }).settings.providerId, 'codex')
  assert.equal(store.normalize({ settings: { ...OLD_STATE.settings, providerId: 'claude-2' } }).settings.providerId, 'codex', 'no subscription: the old rule')
})

test('pool members that point at an instance Orbit does not have are dropped, the others stay', () => {
  const pool = [{ providerId: 'claude-2', model: 'a' }, { providerId: 'claude-9', model: 'b' }, { providerId: 'codex', model: 'c' }, { providerId: 'ollama', model: 'd' }]
  const settings = store.normalize({ settings: { ...OLD_STATE.settings, providerPool: pool, subscriptions: [{ id: 'claude-2', label: 'W', dir: 'D:\\a' }] } }).settings
  assert.deepEqual(settings.providerPool.map(member => member.providerId), ['claude-2', 'codex', 'ollama'])
})

const empty = () => store.normalize(clone(OLD_STATE)).settings

test('addSubscription picks the next id over instances and base ids and keeps the rest of the settings', () => {
  const first = sub.addSubscription(empty(), { base: 'claude', label: ' Рабочий ', dir: 'D:\\data\\accounts\\claude-2' })
  assert.deepEqual(first.subscriptions, [{ id: 'claude-2', base: 'claude', label: 'Рабочий', dir: 'D:\\data\\accounts\\claude-2' }])
  const second = sub.addSubscription(first, { base: 'claude', label: 'Личный', dir: 'D:\\data\\accounts\\claude-3' })
  assert.deepEqual(second.subscriptions.map(item => item.id), ['claude-2', 'claude-3'])
  const third = sub.addSubscription(second, { base: 'codex', label: 'Рабочий', dir: '/x/codex-2' })
  assert.deepEqual(third.subscriptions.map(item => item.id), ['claude-2', 'claude-3', 'codex-2'])
  assert.equal(third.providerId, 'claude')
  assert.deepEqual(third.models, OLD_STATE.settings.models)
  assert.deepEqual(empty().subscriptions, [], 'the input is not changed')
  // a wanted id is honoured when free and valid, otherwise the next free one is used
  assert.equal(sub.addSubscription(empty(), { base: 'codex', label: 'x', dir: '/d', id: 'codex-7' }).subscriptions[0].id, 'codex-7')
  assert.equal(sub.addSubscription(first, { base: 'claude', label: 'y', dir: '/d', id: 'claude-2' }).subscriptions[1].id, 'claude-3')
  assert.equal(sub.addSubscription(empty(), { base: 'claude', label: 'y', dir: '/d', id: 'codex-2' }).subscriptions[0].id, 'claude-2')
})

test('addSubscription refuses what cannot be: single-account providers, empty or long or repeated names, no folder, too many', () => {
  const settings = empty()
  assert.throws(() => sub.addSubscription(settings, { base: 'cursor', label: 'x', dir: '/d' }), /один аккаунт/)
  assert.throws(() => sub.addSubscription(settings, { base: 'antigravity', label: 'x', dir: '/d' }), /один аккаунт/)
  assert.throws(() => sub.addSubscription(settings, { base: 'ollama', label: 'x', dir: '/d' }), /один аккаунт/)
  assert.throws(() => sub.addSubscription(settings, { base: 'claude', label: '   ', dir: '/d' }), /название/)
  assert.throws(() => sub.addSubscription(settings, { base: 'claude', label: 'я'.repeat(41), dir: '/d' }), /длиннее 40/)
  assert.throws(() => sub.addSubscription(settings, { base: 'claude', label: 'x', dir: ' ' }), /папки/)
  const one = sub.addSubscription(settings, { base: 'claude', label: 'Рабочий', dir: '/d' })
  assert.throws(() => sub.addSubscription(one, { base: 'claude', label: 'рабочий', dir: '/e' }), /уже есть/)
  assert.doesNotThrow(() => sub.addSubscription(one, { base: 'codex', label: 'Рабочий', dir: '/e' }))
  let many = settings
  for (let n = 0; n < 20; n++) many = sub.addSubscription(many, { base: 'claude', label: `a${n}`, dir: `/d/${n}` })
  assert.throws(() => sub.addSubscription(many, { base: 'claude', label: 'one more', dir: '/d' }), /Не больше 20/)
  assert.equal(sub.subscriptionProblem(settings, { base: 'claude', label: 'ok' }), '')
})

test('removeSubscription drops the instance, its pool members, model and options, and resets the active provider', () => {
  let settings = sub.addSubscription(sub.addSubscription(empty(), { base: 'claude', label: 'A', dir: '/a' }), { base: 'codex', label: 'B', dir: '/b' })
  settings = {
    ...settings, providerId: 'claude-2', models: { ...settings.models, 'claude-2': 'opus', 'codex-2': 'gpt' },
    providerOptions: { ...settings.providerOptions, 'claude-2': { reasoningEffort: 'low' }, 'codex-2': { command: 'x' } },
    providerPool: [...settings.providerPool, { providerId: 'claude-2', model: 'm' }, { providerId: 'codex-2', model: 'm' }],
  }
  const next = sub.removeSubscription(settings, 'claude-2')
  assert.deepEqual(next.subscriptions.map(item => item.id), ['codex-2'])
  assert.equal(next.providerId, 'codex')
  assert.equal('claude-2' in next.models, false)
  assert.equal('claude-2' in next.providerOptions, false)
  assert.deepEqual(next.providerPool.map(member => member.providerId), ['codex', 'claude', 'codex-2'])
  assert.equal(next.models['codex-2'], 'gpt', 'another instance is untouched')
  assert.equal(sub.removeSubscription(settings, 'codex-2').providerId, 'claude-2', 'the active provider stays when it was another one')
  assert.equal(sub.removeSubscription(settings, 'claude-9'), settings, 'an unknown id changes nothing')
  assert.deepEqual(sub.removalPatch(settings, 'claude-2').providerId, 'codex')
  assert.deepEqual(Object.keys(sub.removalPatch(settings, 'claude-2')).sort(), ['models', 'providerId', 'providerOptions', 'providerPool', 'subscriptions'])
})

test('providerList: the static providers, each instance right after its base; the static export is untouched', () => {
  assert.equal(sub.providerList(undefined), providers.providers)
  assert.equal(sub.providerList([]), providers.providers)
  const list = sub.providerList(sub.sanitizeInstances([
    { id: 'codex-2', label: 'Лично', dir: '/c' }, { id: 'claude-3', label: 'Три', dir: '/3' }, { id: 'claude-2', label: 'Рабочий', dir: '/2' },
  ]))
  assert.deepEqual(list.map(item => item.id), ['codex', 'codex-2', 'claude', 'claude-3', 'claude-2', 'antigravity', 'cursor', 'ollama', 'custom'])
  const work = list.find(item => item.id === 'claude-2')
  assert.equal(work.name, 'Claude Code · Рабочий')
  assert.equal(work.description, 'Дополнительная подписка · отдельная квота')
  assert.equal(work.base, 'claude')
  assert.match(work.help, /ЭТОТ|этот аккаунт/)
  assert.equal(providers.providers.length, 6)
  assert.equal(list.filter(item => item.base).length, 3)
})

test('providerName also finds registered extra subscriptions; a deleted one is unknown (callers print its id)', () => {
  assert.equal(providers.providerName('claude'), 'Claude Code')
  assert.equal(providers.providerName('claude-2'), undefined)
  providers.registerExtraProviders(sub.providerList(sub.sanitizeInstances([{ id: 'claude-2', label: 'Рабочий', dir: '/2' }])).filter(item => item.base))
  assert.equal(providers.providerName('claude-2'), 'Claude Code · Рабочий')
  assert.equal(providers.providerName('claude-5'), undefined)
  providers.registerExtraProviders([])
  assert.equal(providers.providerName('claude-2'), undefined)
})

test('instanceOptions: what the window sends is providerOptions with the instances inside, and nothing else changes', () => {
  const settings = sub.addSubscription({ ...empty(), providerOptions: { claude: { command: 'C:\\bin\\claude.exe', reasoningEffort: 'high' } } }, { base: 'claude', label: 'Рабочий', dir: 'D:\\a' })
  const wire = sub.instanceOptions(settings.subscriptions, settings.providerOptions)
  assert.deepEqual(wire['claude-2'], { command: 'C:\\bin\\claude.exe', reasoningEffort: 'high', base: 'claude', label: 'Рабочий', accountDir: 'D:\\a' })
  assert.deepEqual(wire.claude, settings.providerOptions.claude)
  assert.deepEqual(sub.instanceOptions(undefined, settings.providerOptions), settings.providerOptions)
})

test('account choices: Claude and Codex can add one, Cursor and Antigravity say why not', () => {
  const choices = sub.accountChoices()
  assert.deepEqual(choices.filter(item => item.enabled).map(item => item.id), ['claude', 'codex'])
  for (const id of ['cursor', 'antigravity']) assert.match(choices.find(item => item.id === id).reason, /^один аккаунт: /)
  assert.match(choices.find(item => item.id === 'cursor').reason, /CURSOR_CONFIG_DIR/)
  assert.match(choices.find(item => item.id === 'antigravity').reason, /Credential Manager/)
})

test('looksManaged: only <data>/accounts/<id> is offered the delete-the-folder question', () => {
  const item = (dir, id = 'claude-2') => ({ id, dir })
  assert.equal(sub.looksManaged(item('C:\\Users\\me\\AppData\\Roaming\\orbit-ide\\accounts\\claude-2')), true)
  assert.equal(sub.looksManaged(item('/home/me/.config/orbit/accounts/claude-2/')), true)
  assert.equal(sub.looksManaged(item('C:\\my\\own\\claude-home')), false)
  assert.equal(sub.looksManaged(item('C:\\Users\\me\\accounts\\claude-3')), false, 'another id')
  assert.equal(sub.looksManaged(item('claude-2')), false)
})

test('the sentences the owner reads: login status and what the removal did', () => {
  assert.deepEqual(sub.loginStatus(undefined), { ok: false, text: 'Не проверено: нажмите «Проверить»' })
  assert.deepEqual(sub.loginStatus({ available: true, detail: 'ok', authenticated: true }), { ok: true, text: 'Вход выполнен' })
  assert.equal(sub.loginStatus({ available: true, detail: 'ok' }).ok, true)
  const out = sub.loginStatus({ available: false, detail: 'Not logged in', authenticated: false })
  assert.equal(out.ok, false)
  assert.match(out.text, /Войдите.*Not logged in/)
  const gone = { label: 'Рабочий', dir: 'D:\\data\\accounts\\claude-2' }
  assert.match(sub.removeNote({ deleted: true }, gone), /убрана.*папка аккаунта удалена/)
  for (const reason of ['declined', 'unmanaged', 'not-requested']) assert.match(sub.removeNote({ deleted: false, reason }, gone), /D:\\data\\accounts\\claude-2/)
  assert.match(sub.removeNote({ deleted: false, reason: 'failed', error: 'EBUSY' }, gone), /не удалось: EBUSY/)
  assert.match(sub.LOGIN_STEPS, /нажмите «Проверить»/)
})

test('loginCommand: the owner\'s CLI path first, else the path Orbit found for the base provider, never one a console would read as syntax', () => {
  const instance = { id: 'claude-2', base: 'claude' }
  const found = [{ id: 'claude', executable: 'C:\\Users\\me\\.local\\bin\\claude.exe' }, { id: 'codex', executable: 'codex' }]
  assert.equal(sub.loginCommand({ providerOptions: { claude: { command: 'D:\\tools\\claude.cmd' } } }, instance, found), 'D:\\tools\\claude.cmd', 'the provider\'s own setting wins')
  assert.equal(sub.loginCommand({ providerOptions: { claude: { command: 'D:\\a.cmd' }, 'claude-2': { command: 'D:\\b.cmd' } } }, instance, found), 'D:\\b.cmd', 'the account\'s own setting wins over the provider\'s')
  assert.equal(sub.loginCommand({ providerOptions: {} }, instance, found), 'C:\\Users\\me\\.local\\bin\\claude.exe', 'the console window has Orbit\'s PATH only: the path the health check resolved is used')
  assert.equal(sub.loginCommand({}, { id: 'codex-2', base: 'codex' }, found), 'codex', 'a bare name is passed as it is')
  assert.equal(sub.loginCommand({}, instance, [{ id: 'claude', executable: 'C:\\Program Files (x86)\\claude.exe' }]), undefined, 'a path with ( ) is left out: the bare command is tried')
  assert.equal(sub.loginCommand({}, instance, undefined), undefined)
})

test('the single-account reasons keep their backslashes', () => {
  assert.match(sub.SINGLE_ACCOUNT_REASONS.cursor, /%APPDATA%\\Cursor\\auth\.json/)
})
