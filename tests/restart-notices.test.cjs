const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// The renderer's side of restart_orbit and of the runtime child process, as pure functions: the terminal status
// 'restarting', restart notices kept as chat notes, the continuation run tied to its chat and to the run it continues,
// and the runtime status line. Same loader as tests/state-store.test.cjs: vite's oxc transform, written to a temporary
// directory as .mjs files with their relative imports rewritten.
let events, store, runtime, dir
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-restart-notices-'))
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
  const names = ['run-events', 'state-store', 'runtime-status']
  for (const name of names) await emit(name)
  ;[events, store, runtime] = await Promise.all(names.map(name => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href)))
})
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

const T0 = '2026-09-30T10:00:00.000Z', T1 = '2026-09-30T10:01:00.000Z', T2 = '2026-09-30T10:02:00.000Z'
const fold = (list, initial = {}) => list.reduce((runs, event, index) => events.applyRunEvent(runs, event, `2026-09-30T09:59:${String(index).padStart(2, '0')}.000Z`), initial)
const ev = (type, runId, extra = {}) => ({ type, runId, projectId: 'p', chatId: 'c', ...extra })
const agent = (id, status = 'working') => ({ id, name: id, parentId: id === 'root' ? null : 'root', status })
const workspace = { path: 'C:\\work\\alpha', name: 'alpha', connected: false, branch: '', changedFiles: 0 }
const chat = (id, messages = []) => ({ id, title: 'Чат', messages, updated: T0 })
const baseState = (chats) => store.normalize({ version: 3, projects: [{ id: 'p', workspace, chats, activeChatId: chats[0]?.id }], activeProjectId: 'p', settings: {} })
const snapshot = (runId, extra = {}) => ({ runId, projectId: 'p', chatId: 'c', workspace: 'C:\\work\\alpha', prompt: `prompt ${runId}`, status: 'completed', agents: [], traces: [], messages: [], communications: [], startedAt: T0, ...extra })
const resumed = (extra = {}) => ({
  kind: 'resumed', projectId: 'p', chatId: 'c', runId: 'old', resumedRunId: 'new', level: 'runtime', reason: 'новый инструмент', time: T1,
  text: 'Orbit перезапущен по запросу агента, задача продолжена (причина: новый инструмент)', ...extra,
})
const started = () => fold([ev('run.started', 'old', { prompt: 'Сделай навык', workspace: 'w' }), ev('agent.created', 'old', { agent: agent('root', 'waiting') }),
  ev('agent.created', 'old', { agent: agent('helper') }), ev('message.streaming', 'old', { agentId: 'root', messageId: 'm1', content: 'Перезапускаю…' })])

test("'restarting' is terminal: the run keeps it from any terminal event, drops its stub and ignores late chunks", () => {
  assert.ok(events.TERMINAL_STATUSES.includes('restarting'))
  assert.equal(events.isActiveStatus('restarting'), false)
  const restart = { reason: 'новый инструмент', requestedAt: T0, source: 'tool' }
  const runs = events.applyRunEvent(started(), ev('run.finished', 'old', { status: 'restarting', restart }), T1)
  assert.deepEqual([runs.old.status, runs.old.finishedAt, runs.old.streaming], ['restarting', T1, undefined])
  assert.deepEqual(runs.old.restart, restart, 'the terminal event carries why the agent restarted Orbit')
  assert.equal(events.applyRunEvent(runs, ev('message.streaming', 'old', { messageId: 'm2', content: 'late' })).old.streaming, undefined)
  assert.equal(events.applyRunEvent(runs, ev('agent.updated', 'old', { agent: { id: 'root', status: 'restarting' } })).old.status, 'restarting')
  for (const type of ['run.cancelled', 'run.failed']) {
    assert.equal(events.applyRunEvent(started(), ev(type, 'old', { status: 'restarting' })).old.status, 'restarting', `${type} with status restarting`)
  }
  assert.equal(events.applyRunEvent(started(), ev('run.cancelled', 'old', { status: 'cancelled' })).old.status, 'cancelled', 'other ends are unchanged')
  const notices = events.runNotices({ ...runs.old, agents: [agent('root', 'restarting'), agent('helper', 'restarting')] })
  assert.deepEqual(notices.filter(item => item.kind !== 'spawned').map(item => [item.kind, item.text]), [['restarting', '«helper» остановлен перезапуском Orbit']])
})

test("restoreRuns: a saved 'restarting' is final, and a live copy whose end died with the runtime takes the saved agents", () => {
  const live = started()
  const saved = snapshot('old', { status: 'restarting', finishedAt: T1, error: 'Orbit перезапускается по запросу агента', agents: [agent('root', 'restarting'), agent('helper', 'cancelled')] })
  const restored = events.restoreRuns(live, [saved]).old
  assert.deepEqual([restored.status, restored.finishedAt, restored.error, restored.streaming], ['restarting', T1, 'Orbit перезапускается по запросу агента', undefined])
  assert.deepEqual(restored.agents.map(item => [item.id, item.status]), [['root', 'restarting'], ['helper', 'cancelled']])
  assert.equal(restored.prompt, 'Сделай навык', 'other live fields still win')
  // After a crash the new runtime reports the run interrupted: the same rule.
  const crashed = events.restoreRuns(live, [{ ...saved, status: 'interrupted' }]).old
  assert.deepEqual(crashed.agents.map(item => item.status), ['restarting', 'cancelled'])
  // A run the saved list still calls active keeps the live agents, as before.
  const active = events.restoreRuns(live, [{ ...saved, status: 'working', agents: [agent('root', 'waiting')] }]).old
  assert.deepEqual(active.agents.map(item => [item.id, item.status]), [['root', 'waiting'], ['helper', 'working']])
  assert.equal(active.status, 'working')
})

test('a restart notice becomes a system note saved with its chat, once per notice', () => {
  const state = baseState([chat('c'), chat('d')])
  const notice = resumed()
  const next = store.addRestartNote(state, notice)
  const note = { id: 'restart-resumed-new', author: 'system', kind: 'restart', time: T1, text: notice.text, runId: 'new' }
  assert.deepEqual(next.projects[0].chats[0].messages, [note], 'the note stands for the continuation in its chat')
  assert.deepEqual(next.projects[0].chats[1].messages, [], 'other chats are untouched')
  assert.deepEqual(store.addRestartNote(next, notice).projects[0].chats[0].messages, [note], 'the same notice twice is one note')
  // Saved as part of the chat: what loadState returns after saveState keeps it.
  assert.deepEqual(store.normalize(JSON.parse(JSON.stringify(next))).projects[0].chats[0].messages, [note])
  assert.deepEqual(store.chatHistory(next.projects[0].chats[0]), [], 'a note is not sent to the next run as conversation')
  // Other kinds: keyed by the old run, no run id of their own, the runtime's text or a default one.
  const rolled = store.restartNote({ kind: 'rolled-back', projectId: 'p', chatId: 'c', runId: 'old', text: '', error: 'tests failed', patch: 'C:\\repo\\artifacts\\self-upgrade-failed.patch', time: T2 })
  assert.deepEqual(rolled, { id: 'restart-rolled-back-old', author: 'system', kind: 'restart', time: T2, text: 'Перезапуск не удался и откатился' })
  assert.equal(store.restartNote({ kind: 'expired', projectId: null, chatId: null, runId: null, text: ' ', time: T2 }).id, `restart-expired-${T2}`)
  // The chat is found without the project id; a notice for no chat of this state changes nothing.
  assert.deepEqual(store.addRestartNote(state, { ...notice, projectId: null }).projects[0].chats[0].messages, [note])
  assert.deepEqual(store.addRestartNote(state, { ...notice, projectId: 'other' }).projects[0].chats[0].messages, [note])
  assert.equal(store.addRestartNote(state, { ...notice, chatId: 'missing' }), state)
  assert.equal(store.addRestartNote(state, { ...notice, chatId: null }), state)
  // A notice that arrives while the start-up load is in flight is applied again over the desktop copy.
  const local = { ...baseState([chat('c')]), savedAt: 1 }
  const saved = { ...baseState([chat('c', [{ id: 'u', author: 'user', text: 'q', time: T0 }])]), savedAt: 2 }
  const restored = store.restoreState(local, saved, [], [], [notice])
  assert.deepEqual(restored.projects[0].chats[0].messages.map(message => message.id), ['u', 'restart-resumed-new'])
})

test('a resumed run attaches to its chat: live through its events and the notice', () => {
  // The old run's end died with the previous runtime; the continuation's events arrive; then the notice.
  let runs = events.applyRunEvent(started(), { type: 'run.started', runId: 'new', projectId: 'p', chatId: 'c', prompt: 'Продолжи задачу', workspace: 'w' }, T1)
  runs = events.linkResumed(runs, resumed(), T1)
  assert.deepEqual([runs.new.resumedFrom, runs.new.status, runs.new.prompt], ['old', 'working', 'Продолжи задачу'])
  assert.deepEqual(Object.values(runs).filter(run => run.projectId === 'p' && run.chatId === 'c').map(run => run.runId), ['old', 'new'], 'both runs belong to the chat')
  assert.deepEqual([runs.old.status, runs.old.finishedAt, runs.old.streaming], ['restarting', T1, undefined], 'the old run ends with the restart')
  // resumedFrom on the continuation's own events works the same way.
  assert.equal(events.applyRunEvent({}, { type: 'run.started', runId: 'new', projectId: 'p', chatId: 'c', resumedFrom: 'old', resumeChain: 1 }).new.resumeChain, 1)
  // A notice ahead of the run's events places the run in the notice's chat; the events then fill it in.
  const early = events.linkResumed({}, resumed(), T1)
  assert.deepEqual([early.new.projectId, early.new.chatId, early.new.resumedFrom, early.new.status], ['p', 'c', 'old', 'working'])
  const filled = events.applyRunEvent(early, { type: 'run.started', runId: 'new', projectId: 'p', chatId: 'c', prompt: 'Продолжи задачу', workspace: 'w' })
  assert.deepEqual([filled.new.resumedFrom, filled.new.prompt], ['old', 'Продолжи задачу'])
  // Nothing to link: another kind, no continuation id, or nowhere to place it.
  assert.equal(events.linkResumed(runs, resumed({ kind: 'expired' })), runs)
  assert.equal(events.linkResumed(runs, resumed({ resumedRunId: undefined })), runs)
  const empty = {}
  assert.equal(events.linkResumed(empty, resumed({ projectId: null })), empty)
  // A run already final is not touched.
  const finished = events.applyRunEvent(started(), ev('run.finished', 'old', { status: 'restarting' }), T0)
  assert.equal(events.linkResumed(finished, resumed(), T2).old.finishedAt, T0)
  // In the chat, the note anchors the continuation's history while the continuation has no answer of its own.
  const messages = store.addRestartNote(baseState([chat('c', [{ id: 'u', author: 'user', text: 'Сделай навык', time: T0, runId: 'old' }])]), resumed()).projects[0].chats[0].messages
  const ended = { ...runs, old: { ...runs.old }, new: { ...runs.new, status: 'failed' } }
  assert.deepEqual([...events.historyAnchors(messages, ended)], [['old', 'u'], ['new', 'restart-resumed-new']])
  assert.deepEqual([...events.historyAnchors(messages, runs)], [['old', 'u']], 'a working continuation shows its status at the bottom instead')
  const answered = [...messages, { id: 'a', author: 'orbit', text: 'Готово', time: T2, runId: 'new' }]
  assert.equal(events.historyAnchors(answered, ended).get('new'), 'a', 'an answer is the anchor once there is one')
  assert.equal(events.historyAnchors([{ id: 's', author: 'system', kind: 'warning', text: 'x', time: T0, runId: 'new' }], ended).size, 0, 'only restart notes anchor')
})

test("linkResumed ends the old run's working agents too, so a list read after the notice cannot keep them working", () => {
  // The old run's end died with the runtime; the continuation and its notice arrive before the run list does.
  const finishedHelper = { ...agent('done-helper', 'done'), finishedAt: T0 }
  let runs = events.applyRunEvent(started(), ev('agent.created', 'old', { agent: finishedHelper }), T0)
  runs = events.applyRunEvent(runs, ev('run.started', 'new', { resumedFrom: 'old', resumeChain: 1 }), T1)
  runs = events.linkResumed(runs, resumed(), T1)
  const detail = 'Orbit перезапускается по запросу агента'
  assert.deepEqual(runs.old.agents.map(item => [item.id, item.status, item.finishedAt, item.detail]),
    [['root', 'cancelled', T1, detail], ['helper', 'cancelled', T1, detail], ['done-helper', 'done', T0, undefined]])
  // The saved list, read later, agrees; before the fix the live 'working' agents won over the saved 'cancelled' ones.
  const saved = [
    snapshot('old', { status: 'restarting', finishedAt: T0, agents: [agent('root', 'cancelled'), agent('helper', 'cancelled'), finishedHelper] }),
    snapshot('new', { status: 'working', startedAt: T1, resumedFrom: 'old', resumeChain: 1 }),
  ]
  const restored = events.restoreRuns(runs, saved)
  assert.deepEqual(restored.old.agents.map(item => [item.id, item.status]), [['root', 'cancelled'], ['helper', 'cancelled'], ['done-helper', 'done']])
  assert.deepEqual(events.runNotices(restored.old).map(item => [item.agentId, item.kind]),
    [['helper', 'spawned'], ['done-helper', 'spawned'], ['done-helper', 'done'], ['helper', 'cancelled']])
  assert.equal(restored.new.status, 'working')
})

test('a chat whose agent restarted Orbit waits for the continuation: busy until it or its notice comes, two minutes at most', () => {
  const restart = { reason: 'новый инструмент', requestedAt: T0, source: 'tool' }
  const ended = events.applyRunEvent(started(), ev('run.finished', 'old', { status: 'restarting', restart }), T1)
  const state = baseState([chat('c', [{ id: 'u', author: 'user', text: 'Сделай навык', time: T0, runId: 'old' }]), chat('d')])
  const at = Date.parse(T1) + 5000
  // Before: nothing in the chat was active, so a message could be sent (the runtime then refused the continuation) and
  // the chat deleted (the continuation ran unseen). Now the chat waits, keyed like the pending sends.
  assert.equal(Object.values(ended).some(run => events.isActiveStatus(run.status)), false)
  assert.deepEqual([...store.restartWaits(state, ended, at)], [['p/c', Date.parse(T1) + store.RESTART_WAIT_MS]])
  assert.equal(store.RESTART_WAIT_TEXT, 'Orbit перезапускается, задача продолжится автоматически')
  // It ends when the continuation starts, from its events or from the notice that names it ...
  assert.equal(store.restartWaits(state, events.applyRunEvent(ended, ev('run.started', 'new', { resumedFrom: 'old', resumeChain: 1 }), T2), at).size, 0)
  assert.equal(store.restartWaits(state, events.linkResumed(ended, resumed({ time: T2 }), T2), at).size, 0)
  // ... when a notice says none will start (its note is in the chat) ...
  for (const kind of ['rolled-back', 'loop-limit', 'expired', 'failed']) {
    const noted = store.addRestartNote(state, { kind, projectId: 'p', chatId: 'c', runId: 'old', text: '', time: T2 })
    assert.equal(store.restartWaits(noted, ended, at).size, 0, kind)
  }
  const unrelated = store.addRestartNote(state, { kind: 'failed', projectId: 'p', chatId: 'c', runId: 'another', text: '', time: T2 })
  assert.equal(store.restartWaits(unrelated, ended, at).size, 1, 'a note about another run does not end the wait')
  // ... and two minutes after the run ended at the latest, also when the clock stepped back.
  assert.equal(store.restartWaits(state, ended, Date.parse(T1) + store.RESTART_WAIT_MS - 1).size, 1)
  assert.equal(store.restartWaits(state, ended, Date.parse(T1) + store.RESTART_WAIT_MS).size, 0)
  assert.equal(store.restartWaits(state, ended, Date.parse(T1) - store.RESTART_WAIT_MS).size, 0)
  // Only the chat's latest run counts, only a 'restarting' end waits, and a chat this state does not have waits for nothing.
  assert.equal(store.restartWaits(state, events.applyRunEvent(ended, ev('run.started', 'later'), T2), at).size, 0)
  assert.equal(store.restartWaits(state, events.applyRunEvent(started(), ev('run.cancelled', 'old'), T1), at).size, 0)
  assert.equal(store.restartWaits(baseState([chat('d')]), ended, at).size, 0)
  // After a full relaunch the run comes from the saved list: the same wait, from the saved end.
  const restored = events.restoreRuns({}, [snapshot('old', { status: 'restarting', finishedAt: T1, restart })])
  assert.deepEqual([...store.restartWaits(state, restored, at)], [['p/c', Date.parse(T1) + store.RESTART_WAIT_MS]])
})

test('a resumed run attaches to its chat: restored from the saved runs with the note instead of a user prompt', () => {
  const snapshots = [
    snapshot('new', { startedAt: T1, prompt: 'Продолжи задачу.\n\nOrbit перезапущен с новым кодом…', resumedFrom: 'old', resumeChain: 1, status: 'working',
      messages: [{ id: 'a', agentId: 'root', author: 'orbit', text: 'Навык работает', time: T2 }] }),
    snapshot('old', { status: 'restarting', prompt: 'Сделай навык', restart: { reason: 'новый навык', requestedAt: T0, source: 'tool' } }),
  ]
  const restored = store.reconcileRuns(baseState([]), snapshots)
  const messages = restored.projects[0].chats.find(item => item.id === 'c').messages
  assert.deepEqual(messages.map(message => [message.id, message.author, message.runId]), [['prompt-old', 'user', 'old'], ['restart-resumed-new', 'system', 'new'], ['a', 'orbit', 'new']])
  assert.equal(messages[1].text, 'Orbit перезапущен по запросу агента, задача продолжена (причина: новый навык)', 'worded like the runtime\'s notice')
  assert.equal(restored.projects[0].chats.find(item => item.id === 'c').title, 'Сделай навык', 'the chat is named after the user\'s run')
  const chatsOf = (state) => state.projects.map(project => project.chats.map(item => [item.id, item.title, item.messages]))
  assert.deepEqual(chatsOf(store.reconcileRuns(restored, snapshots)), chatsOf(restored), 'reconciling again (the runtime came back) changes no chat')
  // The live notice's note, when it came first, is kept: it is the runtime's own text.
  const live = store.addRestartNote(baseState([chat('c')]), resumed())
  const again = store.reconcileRuns(live, snapshots).projects[0].chats[0].messages
  assert.deepEqual(again.filter(message => message.kind === 'restart').map(message => message.text), [resumed().text])
  // The saved continuation keeps its link, and the run map stays consistent with the list.
  const runs = events.restoreRuns({}, snapshots)
  assert.equal(runs.new.resumedFrom, 'old')
  assert.equal(events.resumeLinks(runs, runs.old).next.runId, 'new')
})

test('resumedFrom links resolve both ways', () => {
  const old = snapshot('old-run-1234567890', { status: 'restarting', startedAt: T0 })
  const middle = snapshot('mid-run-1234567890', { status: 'restarting', startedAt: T1, resumedFrom: old.runId, resumeChain: 1 })
  const last = snapshot('new-run-1234567890', { status: 'working', startedAt: T2, resumedFrom: middle.runId, resumeChain: 2 })
  const other = snapshot('other', { startedAt: T1 })
  const list = [last, other, middle, old]
  assert.deepEqual(events.resumeLinks(list, old), { from: undefined, previous: undefined, next: middle })
  assert.deepEqual(events.resumeLinks(list, middle), { from: old.runId, previous: old, next: last }, 'a run between two restarts links both ways')
  assert.deepEqual(events.resumeLinks(list, last), { from: middle.runId, previous: middle, next: undefined })
  assert.deepEqual(events.resumeLinks(list, other), { from: undefined, previous: undefined, next: undefined })
  const map = Object.fromEntries(list.map(run => [run.runId, run]))
  assert.deepEqual(events.resumeLinks(map, middle), events.resumeLinks(list, middle), 'a run map works like a list')
  assert.deepEqual(events.resumeLinks([last], last), { from: middle.runId, previous: undefined, next: undefined }, 'a run no longer loaded is named, not linked')
  assert.deepEqual(events.resumeLinks(list, undefined), {})
  const twice = snapshot('late', { startedAt: '2026-09-30T11:00:00.000Z', resumedFrom: old.runId })
  assert.equal(events.resumeLinks([twice, ...list], old).next, middle, 'the earliest continuation is the one linked')
  assert.equal(events.shortRunId('0123456789abcdef'), '01234567')
})

test('runtime status: the sidebar line, the settings summary and when the runtime came back', () => {
  const status = (state, extra = {}) => ({ state, mode: 'child', pid: 10, since: 1000, lastRestartMs: null, restarts: 0, retrying: false, ...extra })
  const line = (value, at) => runtime.runtimeIndicator(value, at)
  assert.equal(line(null), null)
  assert.equal(line(status('ready'), 1500), null, 'a runtime that simply runs says nothing')
  assert.deepEqual(line(status('starting')), { text: 'runtime запускается…', tone: 'busy' })
  assert.deepEqual(line(status('restarting', { restarts: 1 })), { text: 'runtime перезапускается…', tone: 'busy' })
  assert.deepEqual(line(status('starting', { restarts: 1 })), { text: 'runtime перезапускается…', tone: 'busy' })
  assert.deepEqual(line(status('crashed', { error: 'exit code 1', retrying: true })), { text: 'runtime упал, перезапускается…', tone: 'busy', title: 'exit code 1' })
  assert.deepEqual(line(status('stopped', { error: 'три сбоя за минуту' })), { text: 'runtime остановлен: три сбоя за минуту', tone: 'error', title: 'три сбоя за минуту' })
  const back = status('ready', { restarts: 2, lastRestartMs: 640, pid: 11 })
  assert.deepEqual(line(back, 1100), { text: 'runtime перезапущен за 640 мс', tone: 'done', until: 1000 + runtime.RESTARTED_SHOW_MS })
  assert.equal(line(back, 1000 + runtime.RESTARTED_SHOW_MS), null, 'the line goes away after a few seconds')
  assert.equal(runtime.runtimeSummary(back), 'Отдельный процесс · работает · pid 11 · перезапусков: 2 · последний за 640 мс')
  assert.equal(runtime.runtimeSummary(status('ready', { mode: 'inprocess' })), 'В основном процессе · работает · pid 10')
  assert.equal(runtime.runtimeSummary(status('stopped', { pid: null, error: 'boom' })), 'Отдельный процесс · остановлен · boom')
  assert.equal(runtime.runtimeSummary(null), 'Состояние runtime неизвестно.')
  // watchRuntime: the renderer reads the run list again only when the runtime came back.
  const replay = (states) => {
    let watch = runtime.initialWatch
    return states.map(value => { const step = runtime.watchRuntime(watch, value); watch = step.watch; return step.cameBack })
  }
  assert.deepEqual(replay([status('starting'), status('ready')]), [false, false], 'the first start is not a comeback')
  assert.deepEqual(replay([status('ready'), status('restarting'), status('starting', { restarts: 1 }), status('ready', { pid: 11, restarts: 1 }), status('ready', { pid: 11, restarts: 1 })]),
    [false, false, false, true, false])
  assert.deepEqual(replay([status('ready'), status('crashed'), status('ready', { pid: 12 })]), [false, false, true])
  assert.deepEqual(replay([status('ready'), status('stopped'), status('ready', { pid: 10 })]), [false, false, true], 'back after a stop, even in the same process')
  assert.deepEqual(replay([status('ready'), status('ready', { pid: 13 })]), [false, true], 'a new process is a comeback even when the restart itself was missed')
})

test('runtime status: a crash reads as a restart under way only when main says one is scheduled (`retrying`), whatever its text', () => {
  const status = (state, extra = {}) => ({ state, mode: 'child', pid: null, since: 1000, lastRestartMs: null, restarts: 0, retrying: false, ...extra })
  // A crash the client restarts after a short pause keeps the busy line.
  assert.deepEqual(runtime.runtimeIndicator(status('crashed', { error: 'the process exited with code 3221225477', retrying: true })),
    { text: 'runtime упал, перезапускается…', tone: 'busy', title: 'the process exited with code 3221225477' })
  assert.equal(runtime.runtimeIndicator(status('crashed', { retrying: true })).tone, 'busy')
  // Nothing is scheduled: the error, in the error tone, however it is worded.
  const mismatch = 'the runtime process speaks protocol 2 and this Orbit window speaks 3; relaunch Orbit (Orbit.cmd --relaunch) to load both from the same code'
  assert.deepEqual(runtime.runtimeIndicator(status('crashed', { error: mismatch })), { text: `runtime упал: ${mismatch}`, tone: 'error', title: mismatch })
  assert.deepEqual(runtime.runtimeIndicator(status('crashed', { error: 'the process exited with code 1' })),
    { text: 'runtime упал: the process exited with code 1', tone: 'error', title: 'the process exited with code 1' }, 'no guessing from the text')
  assert.deepEqual(runtime.runtimeIndicator(status('crashed')), { text: 'runtime упал', tone: 'error', title: undefined })
  assert.equal(runtime.runtimeIndicator(status('crashed', { error: 'relaunch Orbit', retrying: true })).tone, 'busy', 'the flag decides, not the words')
  // A status without the flag (an older main) is not a restart under way either.
  const { retrying, ...older } = status('crashed', { error: 'boom' })
  assert.equal(retrying, false)
  assert.equal(runtime.runtimeIndicator(older).tone, 'error')
})

test('runtime status: an error nothing caught in the running runtime shows in the sidebar for a moment and stays in the settings summary', () => {
  const status = (state, extra = {}) => ({ state, mode: 'child', pid: 10, since: 1000, lastRestartMs: null, restarts: 0, retrying: false, ...extra })
  const lastError = { message: 'Cannot read properties of undefined (reading \'id\')', at: 5000, count: 1 }
  const running = status('ready', { lastError })
  assert.deepEqual(runtime.runtimeIndicator(running, 5100), {
    text: 'ошибка в runtime: Cannot read properties of undefined (reading \'id\')', tone: 'error', title: lastError.message, until: 5000 + runtime.ERROR_SHOW_MS,
  })
  assert.equal(runtime.runtimeIndicator(running, 5000 + runtime.ERROR_SHOW_MS), null, 'it goes away after a few seconds; the runtime keeps running')
  const burst = status('ready', { lastError: { message: 'x'.repeat(400), at: 5000, count: 7 } })
  const text = runtime.runtimeIndicator(burst, 5100).text
  assert.ok(text.startsWith('ошибка в runtime (7): xxx') && text.endsWith('…') && text.length < 200, text)
  assert.equal(runtime.runtimeIndicator(burst, 5100).title.length, 400, 'the tooltip has the whole message')
  // Down or restarting says more than an old error; a fresh error says more than a recent restart.
  assert.equal(runtime.runtimeIndicator(status('stopped', { error: 'boom', lastError }), 5100).text, 'runtime остановлен: boom')
  assert.equal(runtime.runtimeIndicator(status('ready', { restarts: 1, lastRestartMs: 300, since: 4900, lastError }), 5100).text, 'ошибка в runtime: Cannot read properties of undefined (reading \'id\')')
  assert.equal(runtime.runtimeSummary(status('ready', { lastError: { ...lastError, count: 3 } })),
    'Отдельный процесс · работает · pid 10 · необработанных ошибок: 3 (последняя: Cannot read properties of undefined (reading \'id\'))')
  assert.equal(runtime.runtimeSummary(status('ready')), 'Отдельный процесс · работает · pid 10', 'none: nothing added')
})

test("runtime status: pushes apply in arrival order whatever main's clock says; the start-up reply only before the first push", () => {
  const status = (state, extra = {}) => ({ state, mode: 'child', pid: 10, since: 5000, lastRestartMs: null, restarts: 0, retrying: false, ...extra })
  const replay = (items) => {
    let watch = runtime.initialWatch
    return items.map(([value, pushed]) => {
      const step = runtime.watchRuntime(watch, value, pushed)
      if (!step.ignored) watch = step.watch
      return [step.ignored, step.wentDown, step.cameBack]
    })
  }
  // The wall clock stepped back during a restart: the new 'ready' is older by `since` than 'restarting', and still counts.
  assert.deepEqual(replay([[status('ready'), true], [status('restarting', { since: 9000 }), true], [status('ready', { pid: 11, since: 2000, restarts: 1 }), true]]),
    [[false, false, false], [false, true, false], [false, false, true]])
  // The reply to getRuntimeStatus may be older than a push that overtook it: ignored once a push was taken...
  assert.deepEqual(replay([[status('restarting', { since: 9000 }), true], [status('ready', { since: 1000 }), false], [status('ready', { pid: 11, since: 9500 }), true]]),
    [[false, true, false], [true, false, false], [false, false, true]])
  // ... and taken while none was.
  assert.deepEqual(replay([[status('ready'), false], [status('crashed', { pid: null }), true], [status('starting', { pid: null, restarts: 1 }), true], [status('ready', { pid: 12, restarts: 1 }), true]]),
    [[false, false, false], [false, true, false], [false, false, false], [false, false, true]])
  // wentDown once per outage (the runs are remembered then), or at a comeback whose outage went unseen.
  assert.deepEqual(replay([[status('ready'), true], [status('restarting'), true], [status('restarting', { pid: null }), true], [status('ready', { pid: 11 }), true]]).map(step => step[1]),
    [false, true, false, false])
  assert.deepEqual(replay([[status('ready'), true], [status('ready', { pid: 13 }), true]]), [[false, false, false], [false, true, true]])
})
