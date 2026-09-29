const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Same transform as tests/run-events.test.cjs (vite's oxc), but state-store.ts imports run-events.ts and providers.ts at
// run time, so the modules are written to a temporary directory as .mjs files with their relative imports rewritten.
let store
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-state-store-'))
  const done = new Set()
  async function emit(name) {
    if (done.has(name)) return
    done.add(name)
    const file = path.join(__dirname, '..', 'src', `${name}.ts`)
    const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
    const deps = []
    const code = out.code.replace(/from\s+(['"])\.\/([\w-]+)\1/g, (_match, quote, dep) => { deps.push(dep); return `from ${quote}./${dep}.mjs${quote}` })
    fs.writeFileSync(path.join(dir, `${name}.mjs`), code)
    for (const dep of deps) await emit(dep)
  }
  await emit('state-store')
  store = await import(require('node:url').pathToFileURL(path.join(dir, 'state-store.mjs')).href)
})

const T0 = '2026-09-29T10:00:00.000Z', T1 = '2026-09-29T10:01:00.000Z', T2 = '2026-09-29T10:02:00.000Z'
const workspace = (p = 'C:\\work\\alpha') => ({ path: p, name: 'alpha', connected: false, branch: '', changedFiles: 0 })
const chat = (id, messages = [], title = 'Чат') => ({ id, title, messages, updated: T0 })
const project = (id, chats, extra = {}) => ({ id, workspace: workspace(), chats, activeChatId: chats[0]?.id, ...extra })
const baseState = (projects, extra = {}) => store.normalize({ version: 3, projects, activeProjectId: projects[0]?.id, settings: {}, ...extra })
const run = (runId, projectId, chatId, extra = {}) => ({ runId, projectId, chatId, workspace: 'C:\\work\\alpha', prompt: `prompt ${runId}`, status: 'completed', agents: [], traces: [], messages: [], communications: [], startedAt: T0, ...extra })

// ---- reconcileSaved: the savedAt rule ----

test('reconcileSaved: the desktop copy wins when it is as new as the mirror or newer', () => {
  const local = baseState([project('p', [chat('c')])], { savedAt: 100 })
  const durable = baseState([project('q', [chat('d')])], { savedAt: 100 })
  assert.equal(store.reconcileSaved(local, durable), durable, 'equal timestamps: durable')
  assert.equal(store.reconcileSaved(local, { ...durable, savedAt: 101 }).activeProjectId, 'q', 'newer durable')
})

test('reconcileSaved: the mirror wins when it was stamped later, and always without a desktop copy', () => {
  const local = baseState([project('p', [chat('c')])], { savedAt: 200 })
  const durable = baseState([project('q', [chat('d')])], { savedAt: 199 })
  assert.equal(store.reconcileSaved(local, durable), local)
  assert.equal(store.reconcileSaved(local, null), local)
})

test('reconcileSaved: a missing savedAt counts as 0 on either side', () => {
  const local = baseState([project('p', [chat('c')])])
  const durable = baseState([project('q', [chat('d')])])
  assert.equal(store.reconcileSaved(local, durable), durable, 'both missing: durable (0 >= 0)')
  assert.equal(store.reconcileSaved({ ...local, savedAt: 1 }, durable).activeProjectId, 'p', 'local stamped, durable not')
  assert.equal(store.reconcileSaved(local, { ...durable, savedAt: 1 }).activeProjectId, 'q', 'durable stamped, local not')
})

// ---- normalize ----

test('normalize fills defaults, drops projects without a workspace and the old welcome message', () => {
  const state = store.normalize({ projects: [{ id: 'x' }, project('p', [chat('c', [{ id: 'welcome', author: 'system', text: 'hi', time: T0 }, { id: 'm', author: 'user', text: 'q', time: T0 }])])], activeProjectId: 'missing' })
  assert.equal(state.version, 3)
  assert.deepEqual(state.projects.map(p => p.id), ['p'])
  assert.deepEqual(state.projects[0].chats[0].messages.map(m => m.id), ['m'])
  assert.equal(state.activeProjectId, 'p', 'an unknown active project falls back to the first one')
  assert.equal(state.settings.providerId, 'codex')
  assert.deepEqual(state.settings.quotaFailover, { enabled: true, switchAtPercent: 90, allowWeaker: false })
  assert.deepEqual(state.settings.limits, { maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null })
})

test('normalize resets the limits an older version wrote as defaults, once', () => {
  const legacy = store.normalize({ projects: [], settings: { limits: { maxAgents: 12, maxDepth: 2, maxConcurrent: 3, maxTurns: 12, maxTotalTurns: 48 } } })
  assert.deepEqual(legacy.settings.limits, { maxAgents: null, maxDepth: 2, maxConcurrent: null, maxTurns: null, maxTotalTurns: null })
  assert.equal(legacy.settings.limitVersion, 2)
  const chosen = store.normalize({ projects: [], settings: { limitVersion: 2, limits: { maxAgents: 12 } } })
  assert.equal(chosen.settings.limits.maxAgents, 12, 'with limitVersion 2 the same value is a choice')
})

test('normalize validates provider, approval policy and the failover threshold', () => {
  const state = store.normalize({ projects: [], settings: { providerId: 'nope', approvalPolicy: 'sometimes', quotaFailover: { enabled: false, switchAtPercent: 120.4, allowWeaker: true } } })
  assert.equal(state.settings.providerId, 'codex')
  assert.equal(state.settings.approvalPolicy, 'on-request')
  assert.deepEqual(state.settings.quotaFailover, { enabled: false, switchAtPercent: 99, allowWeaker: true })
  assert.equal(store.normalize({ projects: [], settings: { quotaFailover: { switchAtPercent: 10 } } }).settings.quotaFailover.switchAtPercent, 50)
  assert.equal(store.normalize({ projects: [], settings: { quotaFailover: { switchAtPercent: 'x' } } }).settings.quotaFailover.switchAtPercent, 90)
})

test('normalize moves a global reasoning effort under its provider and clears it for Google models', () => {
  const moved = store.normalize({ projects: [], settings: { providerId: 'claude', reasoningEffort: 'high' } })
  assert.equal(moved.settings.reasoningEffort, '')
  assert.equal(moved.settings.providerOptions.claude.reasoningEffort, 'high')
  const kept = store.normalize({ projects: [], settings: { providerId: 'claude', reasoningEffort: 'high', providerOptions: { claude: { reasoningEffort: 'low' } } } })
  assert.equal(kept.settings.providerOptions.claude.reasoningEffort, 'low', 'an explicit per-provider value is not overwritten')
  const google = store.normalize({ projects: [], settings: { providerOptions: { antigravity: { reasoningEffort: 'high', command: 'agy' } }, providerPool: [{ providerId: 'antigravity', model: 'g', reasoningEffort: 'x' }, { providerId: 'codex', model: 'c', reasoningEffort: 'high' }] } })
  assert.deepEqual(google.settings.providerOptions.antigravity, { reasoningEffort: '', command: 'agy' })
  assert.deepEqual(google.settings.providerPool.map(m => m.reasoningEffort), ['', 'high'])
})

// ---- initialState: the localStorage bootstrap ----

test('initialState reads the v3 mirror, else the keys older versions used, else defaults', () => {
  const mirror = { 'orbit:state:v3': JSON.stringify({ version: 3, projects: [project('p', [chat('c')])], activeProjectId: 'p', settings: { providerId: 'claude' }, savedAt: 5 }) }
  const fromMirror = store.initialState(key => mirror[key] ?? null)
  assert.equal(fromMirror.activeProjectId, 'p')
  assert.equal(fromMirror.settings.providerId, 'claude')
  assert.equal(fromMirror.savedAt, 5, 'the mirror keeps its stamp so reconcileSaved can compare it')
  const legacy = { 'orbit:projects': JSON.stringify([project('old', [chat('c')])]), 'orbit:active-project': '"old"', 'orbit:preferred-provider': '"claude"', 'orbit:memory-enabled': 'false', 'orbit:agent-instructions': '"be brief"' }
  const fromLegacy = store.initialState(key => legacy[key] ?? null)
  assert.equal(fromLegacy.activeProjectId, 'old')
  assert.equal(fromLegacy.settings.providerId, 'claude')
  assert.equal(fromLegacy.settings.memoryEnabled, false)
  assert.equal(fromLegacy.settings.agentInstructions, 'be brief')
  assert.equal(fromLegacy.savedAt, undefined)
  const empty = store.initialState(() => null)
  assert.deepEqual(empty.projects, [])
  assert.equal(store.initialState(() => '{not json').settings.providerId, 'codex', 'a corrupt mirror is ignored')
})

// ---- reconcileRuns ----

test('reconcileRuns restores projects, chats, prompts and root replies from saved runs in time order', () => {
  const state = baseState([])
  const runs = [
    run('r2', 'p', 'c', { startedAt: T2, prompt: 'second', messages: [{ id: 'a2', author: 'orbit', text: 'answer 2', time: T2 }] }),
    run('r1', 'p', 'c', { startedAt: T1, prompt: 'first', messages: [{ id: 'a1', author: 'orbit', text: 'answer 1', time: T1 }, { id: 'h', author: 'orbit', agentId: 'helper', text: 'not mine', time: T1 }] }),
    run('bad', '', 'c'),
  ]
  const next = store.reconcileRuns(state, runs)
  assert.equal(next.projects.length, 1)
  assert.equal(next.projects[0].workspace.name, 'alpha')
  const restored = next.projects[0].chats[0]
  assert.equal(restored.id, 'c')
  assert.equal(restored.title, 'first', 'the chat is named after the earliest run')
  assert.deepEqual(restored.messages.map(m => [m.id, m.runId]), [['prompt-r1', 'r1'], ['a1', 'r1'], ['prompt-r2', 'r2'], ['a2', 'r2']])
})

test('reconcileRuns skips deleted chats and adopts a legacy user message with the same text', () => {
  const state = baseState([project('p', [chat('c', [{ id: 'u', author: 'user', text: 'prompt r1', time: T0 }]), chat('gone')], { deletedChatIds: ['gone'] })])
  const next = store.reconcileRuns(state, [run('r1', 'p', 'c'), run('r9', 'p', 'gone')])
  const messages = next.projects[0].chats.find(c => c.id === 'c').messages
  assert.deepEqual(messages.map(m => [m.id, m.runId]), [['u', 'r1']], 'no duplicate prompt; the legacy message now carries the run id')
  assert.equal(next.projects[0].chats.find(c => c.id === 'gone').messages.length, 0)
  assert.equal(next.projects[0].chats.length, 2)
})

test('restoreState picks the newer copy, folds in runs and re-applies messages that arrived during the load', () => {
  const local = baseState([project('p', [chat('c')])], { savedAt: 1 })
  const saved = { version: 3, projects: [project('p', [chat('c')])], activeProjectId: 'p', settings: { providerId: 'claude' }, savedAt: 2 }
  const live = { projectId: 'p', chatId: 'c', message: { id: 'live', author: 'orbit', text: 'live', time: T2, runId: 'r1' } }
  const next = store.restoreState(local, saved, [run('r1', 'p', 'c', { startedAt: T1 })], [live])
  assert.equal(next.settings.providerId, 'claude')
  assert.deepEqual(next.projects[0].chats[0].messages.map(m => m.id), ['prompt-r1', 'live'])
  assert.equal(store.restoreState(local, null, [], []).savedAt, 1, 'without a desktop copy the mirror stays')
})

// ---- transitions ----

test('removeChat keeps one chat, moves the selection and remembers the deleted id', () => {
  const state = baseState([project('p', [chat('a'), chat('b')], { activeChatId: 'a', deletedChatIds: ['z'] })])
  const one = store.removeChat(state, 'p', 'a')
  assert.deepEqual(one.projects[0].chats.map(c => c.id), ['b'])
  assert.equal(one.projects[0].activeChatId, 'b')
  assert.deepEqual(one.projects[0].deletedChatIds, ['z', 'a'])
  const fresh = store.removeChat(one, 'p', 'b', () => chat('new', [], 'Новый чат'))
  assert.deepEqual(fresh.projects[0].chats.map(c => c.id), ['new'], 'the last chat is replaced by a new one')
  assert.equal(fresh.projects[0].activeChatId, 'new')
  assert.deepEqual(store.removeChat(fresh, 'p', 'new').projects[0].deletedChatIds, ['z', 'a', 'b', 'new'])
})

test('addWorkspace selects an already open workspace regardless of case and trailing slashes', () => {
  const state = baseState([project('p', [chat('c')])])
  const same = store.addWorkspace(state, workspace('c:\\WORK\\alpha\\'))
  assert.equal(same.projects.length, 1)
  assert.equal(same.activeProjectId, 'p')
  const added = store.addWorkspace(state, workspace('C:\\work\\beta'), () => chat('first', [], 'Новый чат'))
  assert.equal(added.projects.length, 2)
  assert.equal(added.activeProjectId, added.projects[1].id)
  assert.equal(added.projects[1].activeChatId, 'first')
})

test('titleChat, dropMessage, addChatMessage and openChat', () => {
  const state = baseState([project('p', [chat('c', [], 'Новый чат'), chat('d', [], 'Named')])])
  const titled = store.titleChat(state, 'p', 'c', '  many   words in\nthe prompt that goes on and on and on for a while longer  ')
  assert.equal(titled.projects[0].chats[0].title, ' many words in the prompt that goes on and on and on f')
  assert.equal(store.titleChat(state, 'p', 'd', 'x').projects[0].chats[1].title, 'Named', 'a named chat keeps its title')
  const withMessage = store.addChatMessage(state, 'p', 'c', { id: 'm', author: 'user', text: 'a', time: T0 })
  assert.equal(withMessage.projects[0].chats[0].messages.length, 1)
  const updated = store.addChatMessage(withMessage, 'p', 'c', { id: 'm', author: 'user', text: 'b', time: T0 })
  assert.deepEqual(updated.projects[0].chats[0].messages.map(m => m.text), ['b'], 'same id merges instead of appending')
  assert.equal(store.dropMessage(updated, 'p', 'c', 'm').projects[0].chats[0].messages.length, 0)
  const opened = store.openChat(state, 'p', chat('n', [], 'Новый чат'))
  assert.deepEqual(opened.projects[0].chats.map(c => c.id), ['n', 'c', 'd'])
  assert.equal(opened.projects[0].activeChatId, 'n')
})

test('chatHistory sends the last 40 user and assistant turns', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ id: String(i), author: i % 3 === 2 ? 'system' : i % 2 ? 'orbit' : 'user', text: String(i), time: T0 }))
  const history = store.chatHistory(chat('c', messages))
  assert.equal(history.length, 30, '45 messages minus 15 system ones')
  assert.deepEqual(history[0], { role: 'user', content: '0' })
  assert.deepEqual(history.at(-1), { role: 'assistant', content: '43' }, '44 is a system message; 43 is an assistant turn')
})

test('access, model and reasoning patches', () => {
  const settings = { ...store.defaults, providerId: 'claude', models: { codex: 'gpt' }, providerOptions: { claude: { command: 'c' } } }
  assert.equal(store.accessChoice(settings), 'ask')
  assert.equal(store.accessChoice({ ...settings, approvalPolicy: 'never', accessMode: 'read-only' }), 'read-only')
  assert.deepEqual(store.accessPatch('ask'), { accessMode: 'workspace-write', approvalPolicy: 'on-request' })
  assert.deepEqual(store.accessPatch('read-only'), { accessMode: 'read-only', approvalPolicy: 'never' })
  assert.deepEqual(store.modelPatch(settings, 'opus'), { models: { codex: 'gpt', claude: 'opus' } })
  assert.deepEqual(store.reasoningPatch(settings, 'high'), { providerOptions: { claude: { command: 'c', reasoningEffort: 'high' } } })
})

test('sharingKey and sharingEntries round-trip each project switch', () => {
  const state = baseState([project('p', [chat('c')]), { ...project('q', [chat('d')]), workspace: workspace('D:\\beta'), globalMemoryEnabled: false }], { settings: { memoryEnabled: true } })
  assert.deepEqual(store.sharingEntries(store.sharingKey(state)), [{ workspace: 'C:\\work\\alpha', enabled: true }, { workspace: 'D:\\beta', enabled: false }])
  assert.deepEqual(store.sharingEntries(''), [])
})
