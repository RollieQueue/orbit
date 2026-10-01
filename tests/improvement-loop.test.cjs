const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/run-events.test.cjs: vite's oxc transform, then an ES module from a data URL.
// improvement-loop.ts only has type imports, which the transform erases.
let loop
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'improvement-loop.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  loop = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
})

const T0 = '2026-09-30T10:00:00.000Z', T1 = '2026-09-30T10:05:00.000Z', T2 = '2026-09-30T10:10:00.000Z'
const NOW = Date.parse('2026-09-30T11:00:00.000Z')
const MIN = 60_000
const task = (id, status, title = `task ${id}`) => ({ id, title, status, evidence: '' })
const run = (runId, status, extra = {}) => ({ runId, projectId: 'p', chatId: 'c', workspace: 'w', prompt: 'x', status, agents: [], traces: [], messages: [], communications: [], startedAt: T1, ...extra })
const activeLoop = (extra = {}) => ({ active: true, goal: 'Сделай Orbit лучше', startedAt: T0, iteration: 1, failures: 0, closedKeys: ['1|task 1'], ...extra })
const chatWith = (loopState, messages = []) => ({ id: 'c', title: 'Чат', messages, updated: T0, loop: loopState })
const step = (loopState, runs, options = {}) => loop.nextLoopStep(chatWith(loopState), runs, { enabled: true, busy: false, now: NOW, ...options })

test('retryDelay backs off 1, 3, 10, then 30 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(loop.retryDelay), [MIN, 3 * MIN, 10 * MIN, 30 * MIN, 30 * MIN, 30 * MIN])
  assert.equal(loop.retryDelay(0), MIN)
})

test('closed keys: done tasks as id|title, blocked ones as id|title|blocked, merged without duplicates and bounded to 200', () => {
  const tasks = [task('1', 'done'), task('2', 'working'), task('3', 'blocked'), task('4', 'pending')]
  assert.deepEqual(loop.closedKeysOf(tasks), ['1|task 1', '3|task 3|blocked'])
  assert.deepEqual(loop.closedKeysOf(undefined), [])
  assert.deepEqual(loop.newClosedKeys(['1|task 1'], tasks), ['3|task 3|blocked'])
  assert.deepEqual(loop.mergeClosedKeys(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  const many = Array.from({ length: 210 }, (_, i) => `k${i}`)
  const merged = loop.mergeClosedKeys(many.slice(0, 150), many.slice(150))
  assert.equal(merged.length, 200)
  assert.equal(merged[0], 'k10', 'the oldest keys go first')
})

test('a task blocked before and done now (the user answered) is progress; the same blocked task again is not', () => {
  const known = activeLoop({ closedKeys: ['1|task 1', '2|task 2|blocked'] })
  const unblocked = step(known, [run('r1', 'completed', { improvements: [task('1', 'done'), task('2', 'done')] })])
  assert.equal(unblocked.kind, 'start')
  assert.deepEqual(unblocked.loop.closedKeys, ['1|task 1', '2|task 2|blocked', '2|task 2'])
  const still = step(known, [run('r2', 'completed', { improvements: [task('1', 'done'), task('2', 'blocked')] })])
  assert.equal(still.kind, 'retry')
  assert.match(still.note, /не закрыла ни одной задачи плана/)
})

test('an inactive loop does nothing; the switch off stops an active one even while its run works', () => {
  assert.equal(step({ ...activeLoop(), active: false }, [run('r1', 'completed')]).kind, 'idle')
  const off = step(activeLoop(), [run('r1', 'working')], { enabled: false, busy: true })
  assert.equal(off.kind, 'stop')
  assert.equal(off.reason, 'switch')
  assert.equal(off.loop.active, false)
  assert.equal(off.loop.stopped.reason, 'switch')
  assert.match(off.note, /выключено/)
})

test('a busy chat or a working latest run waits', () => {
  assert.deepEqual(step(activeLoop(), [run('r1', 'completed')], { busy: true }), { kind: 'idle' })
  assert.deepEqual(step(activeLoop(), [run('r1', 'working')]), { kind: 'idle' })
  assert.deepEqual(step(activeLoop(), []), { kind: 'idle' })
})

test('a completed run that closed a task starts the next task at once, failures reset', () => {
  const latest = run('r1', 'completed', { improvements: [task('1', 'done'), task('2', 'done'), task('3', 'pending')], improvementStatus: 'implementing' })
  const next = step(activeLoop({ failures: 2 }), [latest])
  assert.equal(next.kind, 'start')
  assert.equal(next.task, 2)
  assert.equal(next.outcome, undefined)
  assert.equal(next.loop.iteration, 2)
  assert.equal(next.loop.failures, 0)
  assert.equal(next.loop.lastRunId, 'r1')
  assert.equal(next.loop.startingAt, NOW)
  assert.deepEqual(next.loop.closedKeys, ['1|task 1', '2|task 2'])
})

test('the latest run is the newest by startedAt', () => {
  const older = run('old', 'failed', { startedAt: T0 })
  const newer = run('new', 'completed', { startedAt: T2, improvements: [task('9', 'done')] })
  assert.equal(step(activeLoop(), [newer, older]).loop.lastRunId, 'new')
  assert.equal(loop.latestRun([newer, older]).runId, 'new')
  assert.equal(loop.newestPlanRun([newer, run('x', 'completed', { startedAt: T2.replace('10:10', '10:20') })]).runId, 'new', 'runs without a plan are skipped')
})

test('a blocked plan pauses the loop and records its closed tasks', () => {
  const latest = run('r1', 'completed', { improvements: [task('2', 'blocked')], improvementStatus: 'blocked' })
  const next = step(activeLoop(), [latest])
  assert.equal(next.kind, 'stop')
  assert.equal(next.reason, 'blocked')
  assert.equal(next.loop.lastRunId, 'r1')
  assert.deepEqual(next.loop.closedKeys, ['1|task 1', '2|task 2|blocked'])
  assert.match(next.note, /пауз/)
})

test('a cancelled run the loop still sees (Orbit quit, the runtime restarted) is retried: the user\'s Stop ends the loop itself', () => {
  const next = step(activeLoop(), [run('r1', 'cancelled')])
  assert.equal(next.kind, 'retry')
  assert.equal(next.loop.active, true)
  assert.equal(next.loop.lastRunId, 'r1')
  assert.match(next.note, /остановлена: Orbit закрылся/)
})

test('a completion that moved nothing, a failure, an interruption: a retry once per run, with the backoff', () => {
  const noProgress = step(activeLoop(), [run('r1', 'completed', { improvements: [task('1', 'done')] })])
  assert.equal(noProgress.kind, 'retry')
  assert.equal(noProgress.runId, 'r1')
  assert.equal(noProgress.loop.failures, 1)
  assert.equal(noProgress.loop.retryAt, NOW + MIN)
  assert.equal(noProgress.loop.lastRunId, 'r1')
  assert.match(noProgress.note, /не закрыла ни одной задачи плана/)
  assert.match(noProgress.note, new RegExp(`в ${loop.clockOf(NOW + MIN)}\\.$`))

  const failed = step(activeLoop({ failures: 1 }), [run('r2', 'failed', { error: 'boom' })])
  assert.equal(failed.kind, 'retry')
  assert.equal(failed.loop.retryAt, NOW + 3 * MIN)
  assert.match(failed.note, /ошибкой: boom/)
  assert.equal(step(activeLoop(), [run('r3', 'interrupted')]).kind, 'retry')
  assert.equal(step(activeLoop({ startingAt: NOW - 5 * MIN }), [run('r3', 'error')]).loop.startingAt, undefined, 'a scheduled retry is no lost start')
})

test('a scheduled retry waits until retryAt, then starts the next task with the previous outcome', () => {
  const waiting = activeLoop({ lastRunId: 'r1', failures: 1, retryAt: NOW + 30_000 })
  assert.deepEqual(step(waiting, [run('r1', 'failed', { error: 'boom' })]), { kind: 'idle', wakeAt: NOW + 30_000 })
  const due = step({ ...waiting, retryAt: NOW - 1 }, [run('r1', 'failed', { error: 'boom' })])
  assert.equal(due.kind, 'start')
  assert.equal(due.task, 2)
  assert.equal(due.loop.retryAt, undefined)
  assert.equal(due.loop.failures, 1, 'failures stay until a task moves the plan')
  assert.match(due.outcome, /ошибкой: boom/)
  const noProgress = step({ ...waiting, retryAt: NOW - 1 }, [run('r1', 'completed')])
  assert.equal(noProgress.outcome, loop.NO_PROGRESS_TEXT)
})

test('a restart without continuation retries with the settling restart note as the outcome', () => {
  const latest = run('r1', 'restarting')
  const next = step(activeLoop(), [latest], { restartNoteText: runId => runId === 'r1' ? 'Перезапуск не удался и откатился' : undefined })
  assert.equal(next.kind, 'retry')
  assert.match(next.note, /Перезапуск не удался и откатился/)
  const plain = step(activeLoop(), [latest])
  assert.match(plain.note, /продолжение не началось/)
})

test('a start whose run never came is repeated after 60 s with the same task number', () => {
  const started = activeLoop({ iteration: 3, lastRunId: 'r1', startingAt: NOW - 10_000 })
  const latest = run('r1', 'completed', { improvements: [task('1', 'done')] })
  assert.deepEqual(step(started, [latest]), { kind: 'idle', wakeAt: NOW - 10_000 + loop.LOOP_START_TIMEOUT_MS })
  const again = step({ ...started, startingAt: NOW - loop.LOOP_START_TIMEOUT_MS }, [latest])
  assert.equal(again.kind, 'start')
  assert.equal(again.task, 3)
  assert.equal(again.loop.startingAt, NOW)
  assert.equal(again.outcome, undefined, 'the handled run completed normally')
  assert.deepEqual(step(activeLoop({ lastRunId: 'r1' }), [latest]), { kind: 'idle' }, 'handled, nothing scheduled')
})

test('loopStartFailed takes the task number back and schedules a retry; a refused start is no failed run', () => {
  const failed = loop.loopStartFailed(activeLoop({ iteration: 4, startingAt: NOW, failures: 0 }), 'нет провайдера', NOW)
  assert.equal(failed.loop.iteration, 3)
  assert.equal(failed.loop.failures, 0, 'a start that never made a run is not a failed attempt')
  assert.equal(failed.loop.startFailures, 1)
  assert.equal(failed.loop.retryAt, NOW + MIN)
  assert.equal(failed.loop.startingAt, undefined)
  assert.equal(failed.loop.busyStarts, undefined)
  assert.match(failed.note, /Не удалось запустить задачу: нет провайдера/)
  assert.match(failed.note, /Не удалось запустить задачу: .*Следующая попытка в \d\d:\d\d\./)
})

test('BUSY_RETRY_MS and busyRetryDelay: 5, 10, then 30 seconds, the count clamped to 1..3', () => {
  assert.deepEqual(loop.BUSY_RETRY_MS, [5_000, 10_000, 30_000])
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(loop.busyRetryDelay), [5_000, 5_000, 10_000, 30_000, 30_000, 30_000])
})

const { START_REFUSALS } = require('../electron/runtime/lifecycle.mts')
const wrapped = text => `Error invoking remote method 'orbit:start-task': Error: ${text}`

test('isBusyRefusal: the three "wait and retry" start refusals of the runtime, also wrapped by IPC', () => {
  for (const key of ['chatBusy', 'restarting', 'cleanup']) assert.ok(START_REFUSALS[key], key)
  for (const text of Object.values(START_REFUSALS)) {
    assert.equal(loop.isBusyRefusal(text), true, text)
    assert.equal(loop.isBusyRefusal(wrapped(text)), true, `wrapped: ${text}`)
  }
  assert.equal(loop.isBusyRefusal('Select a configured provider before sending a message'), false)
  assert.equal(loop.isBusyRefusal(wrapped('Select a configured provider before sending a message')), false)
  assert.equal(loop.isBusyRefusal(''), false)
})

test('loopStartFailed: a busy refusal keeps the task number and the failure counts, and retries after 5, 10, 30 s', () => {
  let started = activeLoop({ iteration: 4, startingAt: NOW, failures: 2, startFailures: 1 })
  const delays = []
  for (let n = 1; n <= 4; n++) {
    const failed = loop.loopStartFailed(started, wrapped(START_REFUSALS.chatBusy), NOW)
    assert.equal(failed.loop.iteration, 3)
    assert.equal(failed.loop.busyStarts, n)
    assert.equal(failed.loop.failures, 2, 'unchanged')
    assert.equal(failed.loop.startFailures, 1, 'unchanged')
    assert.equal(failed.loop.startingAt, undefined)
    assert.equal(failed.note, undefined, 'no warning in the chat for a wait')
    delays.push(failed.loop.retryAt - NOW)
    // The due retry starts task 4 again (startStep: iteration + 1).
    started = { ...failed.loop, iteration: failed.loop.iteration + 1, startingAt: NOW }
  }
  assert.deepEqual(delays, [5_000, 10_000, 30_000, 30_000])
  for (const key of ['restarting', 'cleanup']) assert.equal(loop.loopStartFailed(activeLoop({ startingAt: NOW }), START_REFUSALS[key], NOW).loop.busyStarts, 1, key)
})

test('loopStartFailed: another refusal backs off 1, 3, 10, 30 minutes on its own counter and clears the busy count', () => {
  let started = activeLoop({ iteration: 4, startingAt: NOW, failures: 1, busyStarts: 2 })
  const delays = []
  for (let n = 1; n <= 5; n++) {
    const failed = loop.loopStartFailed(started, 'нет провайдера', NOW)
    assert.equal(failed.loop.iteration, 3)
    assert.equal(failed.loop.startFailures, n)
    assert.equal(failed.loop.failures, 1, 'unchanged')
    assert.equal(failed.loop.busyStarts, undefined)
    assert.match(failed.note, /Не удалось запустить задачу: нет провайдера\. Следующая попытка в \d\d:\d\d\./)
    delays.push(failed.loop.retryAt - NOW)
    started = { ...failed.loop, iteration: failed.loop.iteration + 1, startingAt: NOW }
  }
  assert.deepEqual(delays, [MIN, 3 * MIN, 10 * MIN, 30 * MIN, 30 * MIN])
})

test('a new run the loop handles clears the start counters: the start worked', () => {
  const counters = { startFailures: 3, busyStarts: 2 }
  const closed = step(activeLoop({ ...counters }), [run('r1', 'completed', { improvements: [task('1', 'done'), task('2', 'done')] })])
  assert.equal(closed.kind, 'start')
  const noProgress = step(activeLoop({ ...counters }), [run('r2', 'completed', { improvements: [task('1', 'done')] })])
  assert.equal(noProgress.kind, 'retry')
  const failed = step(activeLoop({ ...counters }), [run('r3', 'failed', { error: 'boom' })])
  assert.equal(failed.kind, 'retry')
  const blocked = step(activeLoop({ ...counters }), [run('r4', 'completed', { improvements: [task('2', 'blocked')], improvementStatus: 'blocked' })])
  assert.equal(blocked.kind, 'stop')
  for (const next of [closed, noProgress, failed, blocked]) {
    assert.ok(!('startFailures' in next.loop) && !('busyStarts' in next.loop), next.kind)
  }
})

test('TECH-DEBT 19: a refused start of the next task is retried as that task, not as "no progress" (busy and other refusals)', () => {
  const closedRun = run('r1', 'completed', { improvements: [task('1', 'done'), task('2', 'done'), task('3', 'pending')], improvementStatus: 'implementing' })
  const runs = [closedRun]
  for (const error of [START_REFUSALS.chatBusy, wrapped(START_REFUSALS.cleanup), 'нет провайдера']) {
    // The chain useOrbitState runs: a step says start, startTask refuses, loopStartFailed schedules, the retry comes due.
    const before = activeLoop()
    const first = step(before, runs)
    assert.equal(first.kind, 'start')
    assert.equal(first.task, 2)
    const failed = loop.loopStartFailed(first.loop, error, NOW)
    assert.equal(failed.loop.iteration, 1)
    const due = step(failed.loop, runs, { now: failed.loop.retryAt })
    assert.equal(due.kind, 'start', error)
    assert.equal(due.task, 2, error)
    assert.equal(due.outcome, undefined, `${error}: the previous run completed normally`)
  }
  // Repeated busy refusals never turn into a failure either.
  let current = activeLoop()
  for (let i = 0; i < 4; i++) {
    const started = step(current, runs, { now: NOW + i * MIN })
    assert.equal(started.kind, 'start')
    assert.equal(started.outcome, undefined, `attempt ${i}`)
    current = loop.loopStartFailed(started.loop, START_REFUSALS.restarting, NOW + i * MIN).loop
    assert.equal(current.failures, 0)
    current = { ...current, retryAt: NOW + i * MIN }
  }
})

test('a repeated lost start that is refused is retried as the same task: the number does not skip (review T4)', () => {
  // Task 3 was started (its loop saved with iteration 3) and its run never came: the start is repeated as task 3.
  const latest = run('r1', 'completed', { improvements: [task('1', 'done'), task('2', 'done')] })
  const lost = activeLoop({ iteration: 3, lastRunId: 'r1', startingAt: NOW - loop.LOOP_START_TIMEOUT_MS })
  for (const error of [START_REFUSALS.chatBusy, wrapped(START_REFUSALS.restarting), 'нет провайдера']) {
    const again = step(lost, [latest])
    assert.equal(again.kind, 'start')
    assert.equal(again.task, 3)
    assert.equal(again.loop.iteration, 3, 'the loop saved before the start already has the number')
    const failed = loop.loopStartFailed(again.loop, error, NOW)
    assert.equal(failed.loop.iteration, 2, error)
    const due = step(failed.loop, [latest], { now: failed.loop.retryAt })
    assert.equal(due.kind, 'start', error)
    assert.equal(due.task, 3, error)
    assert.equal(due.loop.iteration, 3, error)
  }
})

test('contrast: a completion that moved nothing keeps its no-progress outcome through a refused retry start', () => {
  const latest = run('r1', 'completed', { improvements: [task('1', 'done')] })
  const first = step(activeLoop(), [latest])
  assert.equal(first.kind, 'retry')
  assert.equal(first.loop.failures, 1)
  const due = step(first.loop, [latest], { now: first.loop.retryAt })
  assert.equal(due.kind, 'start')
  assert.equal(due.outcome, loop.NO_PROGRESS_TEXT)
  const failed = loop.loopStartFailed(due.loop, 'нет провайдера', first.loop.retryAt)
  assert.equal(failed.loop.failures, 1, 'a refused start does not count as another failed run')
  const again = step(failed.loop, [latest], { now: failed.loop.retryAt })
  assert.equal(again.kind, 'start')
  assert.equal(again.outcome, loop.NO_PROGRESS_TEXT)
})

test('loopPrompt: the header, the goal, the last 5 later user messages (steer included, clipped), the outcome and the rule', () => {
  const messages = [
    { id: 'goal', author: 'user', text: 'Сделай Orbit лучше', time: '2026-09-30T09:59:00.000Z' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, author: 'user', text: `сообщение ${i}`, time: `2026-09-30T10:0${i + 1}:00.000Z` })),
    { id: 's', author: 'user', kind: 'steer', text: 'x'.repeat(700), time: '2026-09-30T10:08:00.000Z' },
    { id: 'o', author: 'orbit', text: 'ответ', time: '2026-09-30T10:09:00.000Z' },
    { id: 'n', author: 'system', text: 'заметка', time: '2026-09-30T10:09:00.000Z' },
  ]
  const prompt = loop.loopPrompt(activeLoop(), messages, 7, 'Предыдущая попытка завершилась ошибкой: boom.')
  const lines = prompt.split('\n')
  assert.equal(lines[0], '∞ Бесконечное улучшение — задача №7.')
  assert.equal(lines[1], 'Цель цикла: Сделай Orbit лучше')
  assert.ok(!prompt.includes('сообщение 0') && !prompt.includes('сообщение 1'), 'only the last 5')
  assert.ok(prompt.includes('- сообщение 5'))
  assert.ok(prompt.includes(`- ${'x'.repeat(599)}…`), 'each clipped to 600 chars')
  assert.ok(!prompt.includes('ответ') && !prompt.includes('заметка'))
  assert.ok(prompt.includes('Итог предыдущей попытки: Предыдущая попытка завершилась ошибкой: boom.'))
  assert.match(lines.at(-1), /пачку независимых задач/)
  assert.match(lines.at(-1), /Orbit запустит сам/)
  const plain = loop.loopPrompt(activeLoop(), [messages[0]], 2)
  assert.ok(!plain.includes('Сообщения пользователя') && !plain.includes('Итог предыдущей попытки'), 'the goal message itself predates the loop')
})

test('loopNote and loopView', () => {
  assert.deepEqual(loop.loopNote('r9', 4, T1), { id: 'loop-r9', author: 'system', kind: 'loop', runId: 'r9', text: '∞ Задача 4: следующая задача плана', time: T1 })
  assert.match(loop.loopNote('r9', 4, T1, 'Ошибка.').text, /новая попытка\. Ошибка\./)
  assert.equal(loop.loopView(undefined, { running: true, restartWait: false }), undefined)
  assert.equal(loop.loopView({ ...activeLoop(), active: false }, { running: true, restartWait: false }), undefined)
  assert.deepEqual(loop.loopView(activeLoop({ iteration: 3 }), { running: true, restartWait: false }), { task: 3, phase: 'running' })
  assert.equal(loop.loopView(activeLoop(), { running: false, restartWait: true }).phase, 'restarting')
  const retry = loop.loopView(activeLoop({ retryAt: NOW }), { running: false, restartWait: false })
  assert.deepEqual(retry, { task: 1, phase: 'retry', retryAt: NOW })
  assert.equal(loop.loopPhaseText(retry), `следующая попытка в ${loop.clockOf(NOW)}`)
  assert.equal(loop.loopPhaseText(loop.loopView(activeLoop(), { running: false, restartWait: false })), 'запускается…')
})

test('loopView: a busy wait shows "waiting", a plain retry keeps "retry"', () => {
  const waiting = loop.loopView(activeLoop({ retryAt: NOW, busyStarts: 1 }), { running: false, restartWait: false })
  assert.deepEqual(waiting, { task: 1, phase: 'waiting', retryAt: NOW })
  assert.equal(loop.loopPhaseText({ task: 1, phase: 'waiting', retryAt: NOW }), 'ждёт, пока Orbit освободится…')
  assert.equal(loop.loopView(activeLoop({ retryAt: NOW, startFailures: 2 }), { running: false, restartWait: false }).phase, 'retry')
  assert.equal(loop.loopView(activeLoop({ retryAt: NOW, busyStarts: 0 }), { running: false, restartWait: false }).phase, 'retry')
  assert.equal(loop.loopView(activeLoop({ retryAt: NOW, busyStarts: 1 }), { running: true, restartWait: false }).phase, 'running')
})
