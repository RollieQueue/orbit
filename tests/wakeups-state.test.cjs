const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The state-store half of scheduled wake-ups (tests/wakeups.test.cjs covers src/wakeups.ts itself). Same loader as
// tests/state-store.test.cjs: state-store.ts imports other src files at run time, so they are written to a temporary directory.
let store, wake
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wakeups-state-'))
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
  const url = name => require('node:url').pathToFileURL(path.join(dir, `${name}.mjs`)).href
  store = await import(url('state-store'))
  wake = await import(url('wakeups'))
})

const T0 = '2026-10-01T10:00:00.000Z'
const workspace = { path: 'C:\\work\\alpha', name: 'alpha', connected: false, branch: '', changedFiles: 0 }
const w = (id, dueAt, extra = {}) => ({ id, dueAt, task: `задача ${id}`, reason: `причина ${id}`, createdAt: T0, ...extra })
const chat = (id, extra = {}) => ({ id, title: 'Чат', messages: [], updated: T0, ...extra })
const stateOf = chats => store.normalize({ version: 3, projects: [{ id: 'p', workspace, chats, activeChatId: chats[0].id }], activeProjectId: 'p', settings: {} })
const wakeupsOf = (state, chatId = 'c') => state.projects[0].chats.find(c => c.id === chatId).wakeups

test('addWakeup adds in due order, replaces the same id, and leaves other chats and unknown targets alone', () => {
  let state = stateOf([chat('c'), chat('d')])
  state = store.addWakeup(state, 'p', 'c', w('b', 200))
  state = store.addWakeup(state, 'p', 'c', w('a', 100))
  assert.deepEqual(wakeupsOf(state).map(item => item.id), ['a', 'b'])
  state = store.addWakeup(state, 'p', 'c', w('b', 50, { task: 'новая' }))
  assert.deepEqual(wakeupsOf(state).map(item => [item.id, item.task]), [['b', 'новая'], ['a', 'задача a']], 'same id: replaced, not duplicated')
  assert.equal(wakeupsOf(state, 'd'), undefined)
  assert.equal(store.addWakeup(state, 'p', 'nope', w('x', 1)), state)
  assert.equal(store.addWakeup(state, 'nope', 'c', w('x', 1)), state)
})

test('removeWakeups removes the named ones, drops the key when none is left, and is a no-op for unknown ids', () => {
  let state = stateOf([chat('c', { wakeups: [w('a', 1), w('b', 2), w('c', 3)] })])
  assert.equal(store.removeWakeups(state, 'p', 'c', ['zzz']), state, 'unchanged state keeps its identity (no re-render)')
  state = store.removeWakeups(state, 'p', 'c', ['a', 'c', 'zzz'])
  assert.deepEqual(wakeupsOf(state).map(item => item.id), ['b'])
  state = store.removeWakeups(state, 'p', 'c', ['b'])
  assert.equal('wakeups' in state.projects[0].chats[0], false)
  assert.equal(store.removeWakeups(state, 'p', 'c', ['b']), state)
})

test('patchWakeup changes fields, removes the ones set to undefined, keeps the id, and ignores an unknown id', () => {
  const state = stateOf([chat('c', { wakeups: [w('a', 1000, { retryAt: 5000, failures: 2 }), w('b', 2000)] })])
  const patched = store.patchWakeup(state, 'p', 'c', 'a', { dueAt: 10, retryAt: undefined, manual: true, id: 'other' })
  assert.deepEqual(wakeupsOf(patched).map(item => item.id), ['a', 'b'])
  assert.deepEqual(wakeupsOf(patched)[0], w('a', 10, { failures: 2, manual: true }))
  assert.equal(store.patchWakeup(state, 'p', 'c', 'zzz', { manual: true }), state)
  assert.deepEqual(wakeupsOf(store.patchWakeup(state, 'p', 'c', 'b', { dueAt: 1 })).map(item => item.id), ['b', 'a'], 'the list stays in due order')
})

test('normalize repairs saved wake-ups: garbage items go, and the key goes when none is left', () => {
  const state = stateOf([
    chat('c', { wakeups: [w('b', 200), 'junk', null, { id: 'x' }, w('a', 100), w('a', 1)] }),
    chat('d', { wakeups: 'not a list' }),
    chat('e', { wakeups: [] }),
    chat('f'),
  ])
  assert.deepEqual(wakeupsOf(state).map(item => item.id), ['a', 'b'])
  for (const id of ['d', 'e', 'f']) assert.equal('wakeups' in state.projects[0].chats.find(c => c.id === id), false, id)
})

test('wake-ups survive a save and load round trip (the mirror and the desktop file are JSON of the state)', () => {
  const saved = stateOf([chat('c', { wakeups: [w('a', 1_790_000_000_000, { runId: 'r1', manual: true, retryAt: 1_790_000_100_000, failures: 1 }), w('b', 1_800_000_000_000)] })])
  const mirror = { [store.STATE_KEY]: JSON.stringify(store.stampSaved(saved, 7)) }
  const loaded = store.initialState(key => mirror[key] ?? null)
  assert.deepEqual(wakeupsOf(loaded), wakeupsOf(saved))
  const restored = store.restoreState(loaded, JSON.parse(mirror[store.STATE_KEY]), [], [])
  assert.deepEqual(wakeupsOf(restored), wakeupsOf(saved))
})

test('restoreState re-applies wake-ups scheduled and cancelled while the load was in flight, in order', () => {
  const local = stateOf([chat('c')])
  const saved = { ...stateOf([chat('c', { wakeups: [w('old', 100), w('keep', 200)] })]), savedAt: 5 }
  const during = [
    { projectId: 'p', chatId: 'c', added: w('new', 300) },
    { projectId: 'p', chatId: 'c', removed: 'old' },
    { projectId: 'p', chatId: 'gone', added: w('lost', 1) },
  ]
  const next = store.restoreState(local, saved, [], [], [], during)
  assert.deepEqual(wakeupsOf(next).map(item => item.id), ['keep', 'new'])
  assert.deepEqual(wakeupsOf(store.restoreState(local, saved, [], [], [])).map(item => item.id), ['old', 'keep'], 'the new parameter is optional')
})

test('a wake-up run\'s own message stands for its prompt: reconcileRuns adds no second user message', () => {
  const state = stateOf([chat('c', { messages: [wake.wakeupMessage('r1', 'текст пробуждения', T0)] })])
  const run = { runId: 'r1', projectId: 'p', chatId: 'c', workspace: 'C:\\work\\alpha', prompt: 'текст пробуждения', status: 'completed', agents: [], traces: [], messages: [], communications: [], startedAt: T0 }
  const next = store.reconcileRuns(state, [run])
  assert.deepEqual(next.projects[0].chats[0].messages.map(m => m.id), ['wakeup-r1'])
})
