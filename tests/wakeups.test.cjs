const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/improvement-loop.test.cjs: vite's oxc transform, then an ES module from a data URL. Both files only
// have type imports, which the transform erases (wakeups.ts must stay that way).
let wake, loop
const load = async name => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', `${name}.ts`)
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  return import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
}
test.before(async () => { wake = await load('wakeups'); loop = await load('improvement-loop') })

const MIN = 60_000
// Local-time dates: the clock texts use the local zone.
const at = (day, hour, minute) => new Date(2026, 9, day, hour, minute).getTime()
const NOW = at(1, 15, 0)
const pad = n => String(n).padStart(2, '0')
const hhmm = ms => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const w = (id, dueAt, extra = {}) => ({ id, dueAt, task: `задача ${id}`, reason: `причина ${id}`, createdAt: new Date(at(1, 9, 5)).toISOString(), ...extra })
const chatWith = (wakeups, extra = {}) => ({ id: 'c', title: 'Чат', messages: [], updated: '2026-10-01T10:00:00.000Z', ...(wakeups ? { wakeups } : {}), ...extra })
const activeLoop = (extra = {}) => ({ active: true, goal: 'Цель', startedAt: '2026-10-01T08:00:00.000Z', iteration: 1, failures: 0, closedKeys: [], ...extra })
const startStep = () => ({ kind: 'start', loop: activeLoop(), task: 2 })

test('effectiveDue is the later of dueAt and retryAt', () => {
  assert.equal(wake.effectiveDue(w('a', 100)), 100)
  assert.equal(wake.effectiveDue(w('a', 100, { retryAt: 300 })), 300)
  assert.equal(wake.effectiveDue(w('a', 500, { retryAt: 300 })), 500)
})

test('nextWakeupStep: nothing scheduled, or an active loop, is idle', () => {
  assert.deepEqual(wake.nextWakeupStep(chatWith(undefined), { now: NOW, busy: false }), { kind: 'idle' })
  assert.deepEqual(wake.nextWakeupStep(chatWith([]), { now: NOW, busy: false }), { kind: 'idle' })
  assert.deepEqual(wake.nextWakeupStep(chatWith([w('a', NOW - MIN)], { loop: activeLoop() }), { now: NOW, busy: false }), { kind: 'idle' }, 'the loop driver owns it')
  const stopped = activeLoop({ active: false })
  assert.equal(wake.nextWakeupStep(chatWith([w('a', NOW - MIN)], { loop: stopped }), { now: NOW, busy: false }).kind, 'start', 'a stopped loop does not hold')
})

test('nextWakeupStep: not due yet is idle with the earliest wake time', () => {
  const step = wake.nextWakeupStep(chatWith([w('b', NOW + 90 * MIN), w('a', NOW + 30 * MIN)]), { now: NOW, busy: false })
  assert.deepEqual(step, { kind: 'idle', wakeAt: NOW + 30 * MIN })
})

test('nextWakeupStep: a due wake-up starts, exactly at its time too', () => {
  assert.deepEqual(wake.nextWakeupStep(chatWith([w('a', NOW)]), { now: NOW, busy: false }), { kind: 'start', wakeups: [w('a', NOW)] })
  assert.equal(wake.nextWakeupStep(chatWith([w('a', NOW + 1)]), { now: NOW, busy: false }).kind, 'idle')
})

test('nextWakeupStep: several due at once start together, earliest first; the future one only sets the timer', () => {
  const step = wake.nextWakeupStep(chatWith([w('late', NOW - 10 * MIN), w('future', NOW + 5 * MIN), w('early', NOW - 600 * MIN)]), { now: NOW, busy: false })
  assert.equal(step.kind, 'start')
  assert.deepEqual(step.wakeups.map(item => item.id), ['early', 'late'])
})

test('nextWakeupStep: busy waits, with the timer for the later ones only', () => {
  const step = wake.nextWakeupStep(chatWith([w('a', NOW - MIN), w('b', NOW + 20 * MIN)]), { now: NOW, busy: true })
  assert.deepEqual(step, { kind: 'idle', wakeAt: NOW + 20 * MIN })
  assert.deepEqual(wake.nextWakeupStep(chatWith([w('a', NOW - MIN)]), { now: NOW, busy: true }), { kind: 'idle', wakeAt: undefined })
})

test('nextWakeupStep: a retry time in the future keeps a due wake-up waiting', () => {
  const step = wake.nextWakeupStep(chatWith([w('a', NOW - 10 * MIN, { retryAt: NOW + 10_000 })]), { now: NOW, busy: false })
  assert.deepEqual(step, { kind: 'idle', wakeAt: NOW + 10_000 })
  assert.equal(wake.nextWakeupStep(chatWith([w('a', NOW - 10 * MIN, { retryAt: NOW - 1 })]), { now: NOW, busy: false }).kind, 'start')
})

test('holdLoopStep: only the start step is held; the others pass through', () => {
  const chat = chatWith([w('a', NOW + 60 * MIN)], { loop: activeLoop() })
  for (const step of [{ kind: 'idle', wakeAt: 5 }, { kind: 'idle' }, { kind: 'retry', loop: activeLoop(), note: 'n', runId: 'r' }, { kind: 'stop', reason: 'user', loop: activeLoop(), note: 'n' }]) {
    assert.equal(wake.holdLoopStep(step, chat, NOW), step)
  }
})

test('holdLoopStep: a start without wake-ups is unchanged', () => {
  const step = startStep()
  assert.equal(wake.holdLoopStep(step, chatWith(undefined, { loop: activeLoop() }), NOW), step)
  assert.equal(wake.holdLoopStep(step, chatWith([], { loop: activeLoop() }), NOW), step)
})

test('holdLoopStep: wake-ups not due yet hold the loop until the earliest', () => {
  const chat = chatWith([w('b', NOW + 120 * MIN), w('a', NOW + 45 * MIN)], { loop: activeLoop() })
  assert.deepEqual(wake.holdLoopStep(startStep(), chat, NOW), { kind: 'idle', wakeAt: NOW + 45 * MIN })
})

test('holdLoopStep: due wake-ups join the start step (all of them, earliest first), later ones stay', () => {
  const chat = chatWith([w('c', NOW + 60 * MIN), w('b', NOW - MIN), w('a', NOW - 30 * MIN)], { loop: activeLoop() })
  const step = wake.holdLoopStep(startStep(), chat, NOW)
  assert.equal(step.kind, 'start')
  assert.equal(step.task, 2)
  assert.deepEqual(step.wakeups.map(item => item.id), ['a', 'b'])
})

test('lateText: minutes, then hours and minutes', () => {
  assert.equal(wake.lateText(2 * MIN), '2 мин')
  assert.equal(wake.lateText(59 * MIN + 20_000), '59 мин')
  assert.equal(wake.lateText(60 * MIN), '1 ч')
  assert.equal(wake.lateText(135 * MIN), '2 ч 15 мин')
  assert.equal(wake.lateText(26 * 60 * MIN), '26 ч')
})

test('wakeupPrompt: one wake-up on time has its header, the task and the closing sentence', () => {
  const text = wake.wakeupPrompt([w('a', NOW - 60_000)], NOW)
  assert.equal(text, [
    `⏰ Пробуждение по расписанию (назначено 09:05: причина a)`, 'задача a', '',
    'Это запуск по расписанию, который агент назначил себе сам: пользователя может не быть на месте.',
  ].join('\n'))
})

test('wakeupPrompt: a late one says how late, from two minutes; a manual one says so instead', () => {
  assert.ok(!wake.wakeupPrompt([w('a', NOW - 119_000)], NOW).includes('опоздало'))
  assert.ok(wake.wakeupPrompt([w('a', NOW - 2 * MIN)], NOW).includes('(назначено 09:05: причина a) — опоздало на 2 мин\n'))
  assert.ok(wake.wakeupPrompt([w('a', NOW - 135 * MIN)], NOW).includes('— опоздало на 2 ч 15 мин\n'))
  const manual = wake.wakeupPrompt([w('a', NOW - 500 * MIN, { manual: true })], NOW)
  assert.ok(manual.includes('— запущено вручную\n') && !manual.includes('опоздало'))
})

test('wakeupPrompt: a wake-up scheduled on another day shows the date', () => {
  const old = w('a', NOW - MIN, { createdAt: new Date(2026, 8, 29, 9, 5).toISOString() })
  assert.ok(wake.wakeupPrompt([old], NOW).includes('назначено 29.09 09:05:'))
})

test('wakeupPrompt: several wake-ups are numbered sections followed by one closing sentence', () => {
  const text = wake.wakeupPrompt([w('a', NOW - 5 * MIN), w('b', NOW - MIN)], NOW)
  const lines = text.split('\n')
  assert.ok(lines[0].startsWith('1. ⏰ Пробуждение по расписанию (назначено 09:05: причина a)'))
  assert.equal(lines[1], 'задача a')
  assert.ok(lines[3].startsWith('2. ⏰ Пробуждение'))
  assert.equal(lines[4], 'задача b')
  assert.equal(text.split('Это запуск по расписанию').length, 2)
  assert.ok(text.endsWith('пользователя может не быть на месте.'))
})

test('loopPrompt adds the wake-up text under its heading, after the previous attempt\'s outcome', () => {
  const text = loop.loopPrompt(activeLoop(), [], 3, 'Итог плохой.', wake.wakeupPrompt([w('a', NOW)], NOW))
  const outcome = text.indexOf('Итог предыдущей попытки: Итог плохой.'), heading = text.indexOf('Запланированные пробуждения (их срок наступил):')
  assert.ok(outcome >= 0 && heading > outcome)
  assert.ok(text.indexOf('⏰ Пробуждение по расписанию') > heading)
  assert.ok(text.indexOf('Возьми из плана пачку') > heading, 'the loop rule stays last')
  assert.ok(!loop.loopPrompt(activeLoop(), [], 3).includes('Запланированные пробуждения'))
})

test('wakeupMessage is the user\'s own entry, so reconcileRuns adds no second prompt', () => {
  assert.deepEqual(wake.wakeupMessage('run-1', 'текст', 'T'), { id: 'wakeup-run-1', author: 'user', kind: 'wakeup', text: 'текст', time: 'T', runId: 'run-1' })
})

test('wakeupFailed: a refusal keeps the wake-up, counts the failure and backs off 1, 3, 10, 30 minutes with a note', () => {
  let item = w('a', NOW - MIN)
  const delays = []
  for (let i = 0; i < 5; i++) {
    const failed = wake.wakeupFailed(item, 'нет подписки', NOW)
    delays.push(failed.wakeup.retryAt - NOW)
    assert.equal(failed.wakeup.failures, i + 1)
    assert.equal(failed.note, `⏰ Не удалось запустить пробуждение: нет подписки. Следующая попытка в ${hhmm(failed.wakeup.retryAt)}.`)
    item = failed.wakeup
  }
  assert.deepEqual(delays, [MIN, 3 * MIN, 10 * MIN, 30 * MIN, 30 * MIN])
  assert.equal(item.task, 'задача a', 'the rest of the wake-up is kept')
})

test('wakeupFailed: a busy refusal retries in 10 seconds, silently and without counting', () => {
  const failed = wake.wakeupFailed(w('a', NOW - MIN, { failures: 2 }), 'Error invoking remote method \'task:start\': Error: В этом чате ещё выполняется задача или завершаются её процессы', NOW)
  assert.equal(failed.note, undefined)
  assert.equal(failed.wakeup.retryAt, NOW + 10_000)
  assert.equal(failed.wakeup.failures, 2)
})

test('wakeupFailed: a long error is clipped in the note', () => {
  const failed = wake.wakeupFailed(w('a', NOW), `ошибка ${'x'.repeat(500)}`, NOW)
  assert.ok(failed.note.length < 420 && failed.note.includes('…'))
})

test('the busy-refusal phrases agree with improvement-loop.ts', () => {
  for (const text of ['В этом чате ещё выполняется задача или завершаются её процессы', 'Orbit сейчас применяет изменения своего кода и перезапустится', 'Завершается остановка процессов в этом проекте', 'нет подписки', '']) {
    const wakeBusy = wake.wakeupFailed(w('a', NOW), text, NOW).note === undefined
    assert.equal(wakeBusy, loop.isBusyRefusal(text), text)
  }
})

test('wakeupChip: the due time, a one-line excerpt, overdue and held', () => {
  const chip = wake.wakeupChip(w('a', at(1, 17, 30), { task: 'Проверь\n  сборку   и напиши\tитог' }), NOW)
  assert.deepEqual(chip, { id: 'a', clock: '17:30', text: 'Проверь сборку и напиши итог', overdue: false })
  assert.equal(wake.wakeupChip(w('a', at(2, 9, 0)), NOW).clock, '02.10 09:00')
  assert.equal(wake.wakeupChip(w('a', NOW - MIN), NOW).overdue, true)
  assert.equal(wake.wakeupChip(w('a', NOW + MIN), NOW, true).held, true)
  const long = wake.wakeupChip(w('a', NOW, { task: 'я'.repeat(200) }), NOW)
  assert.equal(long.text.length, 80)
  assert.ok(long.text.endsWith('…'))
})

test('sanitizeWakeups keeps well-formed items only, without duplicates, clipped, sorted and bounded', () => {
  const good = w('a', 200, { runId: 'r', manual: true, retryAt: 300, failures: 2 })
  const result = wake.sanitizeWakeups([
    w('b', 100), good, w('a', 50), null, 'x', 5, { id: 'n', task: 't', reason: 'r', createdAt: 'c', dueAt: 'soon' }, { ...w('nan', 1), dueAt: NaN },
    { ...w('notask', 1), task: undefined }, { ...w('noreason', 1), reason: 3 }, { ...w('nocreated', 1), createdAt: undefined }, { ...w('empty', 1), task: '  ' }, { ...w('', 1) },
    w('c', 300, { retryAt: 'x', failures: Infinity, manual: false, runId: 7, extra: 'drop' }),
  ])
  assert.deepEqual(result.map(item => item.id), ['b', 'a', 'c'], 'sorted by dueAt; the first duplicate wins')
  assert.deepEqual(result[1], good)
  assert.deepEqual(result[2], w('c', 300), 'malformed optional fields and unknown keys are dropped')
  assert.deepEqual(wake.sanitizeWakeups(undefined), [])
  assert.deepEqual(wake.sanitizeWakeups({}), [])
  const clipped = wake.sanitizeWakeups([w('a', 1, { task: 'т'.repeat(5000), reason: 'п'.repeat(400) })])[0]
  assert.equal(clipped.task.length, 4000)
  assert.equal(clipped.reason.length, 300)
  assert.equal(wake.sanitizeWakeups(Array.from({ length: 30 }, (_, i) => w(`w${i}`, 100 - i))).length, 20)
  assert.equal(wake.sanitizeWakeups(Array.from({ length: 30 }, (_, i) => w(`w${i}`, 100 - i)))[0].id, 'w29', 'the earliest ones stay')
})
