const test = require('node:test')
const assert = require('node:assert/strict')
const wakeups = require('../electron/runtime/wakeups.mts')
const registry = require('../electron/tool-registry.mts')
const { executeTool } = require('../electron/runtime/tools.mts')
const { OrbitRuntime, folder, tool, response, finished, payload } = require('./helpers-runtime.cjs')

// Scheduled wake-ups, runtime side (electron/runtime/wakeups.mts): schedule_wakeup and cancel_wakeup, their limits, the
// events the window keeps its list from, and how a run learns the chat's pending list. The window's side is wakeups.test.cjs.

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const MIN = 60_000, DAY = 24 * 60 * MIN
const ROOT = { id: 'root' }, HELPER = { id: 'agent-1' }
// The tool as the runtime calls it, with a clock that stands still and the events it emits.
function bench(list = []) {
  const events = []
  const runtime = { clock: () => NOW, agentSignal: () => new AbortController().signal, emit: (run, type, data) => events.push({ type, ...data }), runs: new Map(), runStore: null }
  const run = { runId: 'run-1', wakeups: list }
  const call = (name, args, agent = ROOT) => executeTool(runtime, run, agent, name, args)
  return { events, runtime, run, call }
}
const refused = (promise, pattern) => assert.rejects(promise, error => { assert.match(error.message, pattern); return true })

test('afterMinutes schedules a wake-up: id, due time in ISO and local form, the event the window keeps its list from', async () => {
  const { call, run, events } = bench()
  const result = await call('schedule_wakeup', { afterMinutes: 90, task: 'Check the long job', reason: 'quota reset' })
  assert.match(result.id, /^w-[0-9a-f]{6}$/)
  assert.equal(result.dueAt, new Date(NOW + 90 * MIN).toISOString())
  assert.match(result.dueLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/)
  assert.equal(result.pending, 1)
  const wakeup = { id: result.id, dueAt: NOW + 90 * MIN, task: 'Check the long job', reason: 'quota reset', createdAt: new Date(NOW).toISOString(), runId: 'run-1' }
  assert.deepEqual(run.wakeups, [wakeup])
  assert.deepEqual(events, [{ type: 'wakeup.scheduled', wakeup }])
})

test('at takes an ISO time: with an offset exactly, without one as local time; a bare date or text is refused', async () => {
  const { call, run } = bench()
  const exact = await call('schedule_wakeup', { at: '2026-10-02T09:30:00+03:00', task: 't', reason: 'r' })
  assert.equal(run.wakeups[0].dueAt, Date.UTC(2026, 9, 2, 6, 30))
  assert.equal(exact.dueAt, '2026-10-02T06:30:00.000Z')
  await call('schedule_wakeup', { at: '2026-10-02T09:30:00', task: 't', reason: 'r' })
  assert.equal(run.wakeups[1].dueAt, new Date(2026, 9, 2, 9, 30).getTime(), 'no offset: this machine\'s local time')
  await call('schedule_wakeup', { at: '2026-10-02 09:30', task: 't', reason: 'r' })
  assert.equal(run.wakeups[2].dueAt, new Date(2026, 9, 2, 9, 30).getTime())
  await refused(call('schedule_wakeup', { at: '2026-10-02', task: 't', reason: 'r' }), /ISO 8601 date and time.*it is \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC/)
  await refused(call('schedule_wakeup', { at: 'tomorrow morning', task: 't', reason: 'r' }), /ISO 8601/)
  await refused(call('schedule_wakeup', { at: '2026-13-45T25:00:00Z', task: 't', reason: 'r' }), /ISO 8601/)
  assert.equal(run.wakeups.length, 3)
})

test('the due time is 1 minute to 30 days ahead, the answer names the current local time', async () => {
  const { call, run } = bench()
  await refused(call('schedule_wakeup', { afterMinutes: 0.5, task: 't', reason: 'r' }), /at least 1 minute ahead; it is \d{4}-/)
  await refused(call('schedule_wakeup', { afterMinutes: -5, task: 't', reason: 'r' }), /at least 1 minute/)
  await refused(call('schedule_wakeup', { at: new Date(NOW - 3600_000).toISOString(), task: 't', reason: 'r' }), /at least 1 minute/)
  await refused(call('schedule_wakeup', { afterMinutes: 30 * 24 * 60 + 1, task: 't', reason: 'r' }), /at most 30 days ahead \(until \d{4}-.*; it is \d{4}-/)
  await refused(call('schedule_wakeup', { at: new Date(NOW + 31 * DAY).toISOString(), task: 't', reason: 'r' }), /at most 30 days/)
  await refused(call('schedule_wakeup', { afterMinutes: Number.NaN, task: 't', reason: 'r' }), /afterMinutes must be a number/)
  assert.equal(run.wakeups.length, 0)
  await call('schedule_wakeup', { afterMinutes: 1, task: 't', reason: 'r' })
  await call('schedule_wakeup', { afterMinutes: 30 * 24 * 60, task: 't', reason: 'r' })
  assert.deepEqual(run.wakeups.map(wakeup => wakeup.dueAt - NOW), [MIN, 30 * DAY], 'both ends are allowed')
})

test('exactly one of afterMinutes and at, a task and a reason of bounded length', async () => {
  const { call, run } = bench()
  await refused(call('schedule_wakeup', { task: 't', reason: 'r' }), /exactly one of afterMinutes/)
  await refused(call('schedule_wakeup', { afterMinutes: 5, at: new Date(NOW + 5 * MIN).toISOString(), task: 't', reason: 'r' }), /exactly one of afterMinutes/)
  await refused(call('schedule_wakeup', { afterMinutes: 5, task: '  ', reason: 'r' }), /task and a reason/)
  await refused(call('schedule_wakeup', { afterMinutes: 5, task: 't', reason: '' }), /task and a reason/)
  await refused(call('schedule_wakeup', { afterMinutes: 5, task: 'x'.repeat(4001), reason: 'r' }), /task is longer than 4000/)
  await refused(call('schedule_wakeup', { afterMinutes: 5, task: 't', reason: 'x'.repeat(301) }), /reason is longer than 300/)
  await call('schedule_wakeup', { afterMinutes: 5, task: 'x'.repeat(4000), reason: 'y'.repeat(300) })
  assert.equal(run.wakeups.length, 1)
})

test('a chat holds five pending wake-ups; the sixth is refused naming them, a cancelled one frees a place', async () => {
  const { call, run, events } = bench()
  const ids = []
  for (let n = 1; n <= 5; n++) ids.push((await call('schedule_wakeup', { afterMinutes: n * 10, task: `task ${n}`, reason: 'r' })).id)
  assert.equal(new Set(ids).size, 5)
  await assert.rejects(call('schedule_wakeup', { afterMinutes: 90, task: 'one too many', reason: 'r' }), error => { for (const id of ids) assert.ok(error.message.includes(id), `names ${id}`); assert.match(error.message, /already has 5 pending wake-ups.*cancel_wakeup/); return true })
  const cancelled = await call('cancel_wakeup', { id: ids[2] })
  assert.deepEqual(cancelled, { ok: true, id: ids[2], pending: 4 })
  assert.deepEqual(events.at(-1), { type: 'wakeup.cancelled', wakeupId: ids[2] })
  await call('schedule_wakeup', { afterMinutes: 90, task: 'fits now', reason: 'r' })
  assert.equal(run.wakeups.length, 5)
  assert.ok(!run.wakeups.some(wakeup => wakeup.id === ids[2]))
})

test('cancel_wakeup refuses an unknown id and lists what is pending', async () => {
  const { call, events } = bench()
  await refused(call('cancel_wakeup', { id: 'w-nothing' }), /No pending wake-up "w-nothing" in this chat \(none is pending\)/)
  const { id } = await call('schedule_wakeup', { afterMinutes: 10, task: 't', reason: 'r' })
  await refused(call('cancel_wakeup', { id: 'w-nothing' }), new RegExp(`pending: ${id} \\d{4}-`))
  assert.equal(events.filter(event => event.type === 'wakeup.cancelled').length, 0, 'a refused cancel publishes nothing')
})

test('only the root agent schedules or cancels, and the registry hides both from helpers', async () => {
  const { call, run } = bench([{ id: 'w-1', dueAt: NOW + 5 * MIN, task: 't', reason: 'r', createdAt: new Date(NOW).toISOString() }])
  await refused(call('schedule_wakeup', { afterMinutes: 5, task: 't', reason: 'r' }, HELPER), /Only the orchestrator/)
  await refused(call('cancel_wakeup', { id: 'w-1' }, HELPER), /Only the orchestrator/)
  assert.equal(run.wakeups.length, 1)
  for (const name of ['schedule_wakeup', 'cancel_wakeup']) {
    const spec = registry.tool(name)
    assert.ok(spec.rootOnly && spec.mutating && !spec.waits && spec.minAccess === 'read-only', name)
    assert.equal(registry.allowedFor(spec, { root: false, accessMode: 'danger-full-access' }), false)
    assert.equal(registry.allowedFor(spec, { root: true, accessMode: 'read-only' }), true)
  }
})

test('the registry checks the arguments before the runtime runs: types, one of afterMinutes and at', () => {
  const { validate } = registry
  assert.deepEqual(validate('schedule_wakeup', { afterMinutes: 5, task: 't', reason: 'r', at: null }), { ok: true, args: { afterMinutes: 5, task: 't', reason: 'r' } })
  assert.deepEqual(validate('schedule_wakeup', { at: '2026-10-02T09:30:00Z', task: 't', reason: 'r' }), { ok: true, args: { at: '2026-10-02T09:30:00Z', task: 't', reason: 'r' } })
  assert.match(validate('schedule_wakeup', { task: 't', reason: 'r' }).error, /exactly one of afterMinutes/)
  assert.match(validate('schedule_wakeup', { afterMinutes: 5, at: 'x', task: 't', reason: 'r' }).error, /exactly one of afterMinutes/)
  assert.match(validate('schedule_wakeup', { afterMinutes: '5', task: 't', reason: 'r' }).error, /afterMinutes must be a number/)
  assert.match(validate('schedule_wakeup', { afterMinutes: 5, reason: 'r' }).error, /task is required/)
  assert.match(validate('schedule_wakeup', { afterMinutes: 5, task: ' ', reason: 'r' }).error, /task and a reason/)
  assert.match(validate('cancel_wakeup', {}).error, /id is required/)
  assert.match(validate('cancel_wakeup', { id: ' ' }).error, /wake-up id is required/)
  assert.deepEqual(validate('cancel_wakeup', { id: 'w-1' }), { ok: true, args: { id: 'w-1' } })
})

test('sanitizeWakeups keeps well-formed wake-ups once each, bounded', () => {
  const good = { id: 'w-1', dueAt: NOW, task: 'task', reason: 'why', createdAt: '2026-10-01T10:00:00.000Z', runId: 'run-9' }
  const list = wakeups.sanitizeWakeups([
    good, { ...good }, null, 'text', { ...good, id: '' }, { ...good, id: 'w-2', dueAt: 'soon' }, { ...good, id: 'w-3', dueAt: Number.NaN }, { ...good, id: 'w-4', task: '   ' },
    { ...good, id: 'w-5', reason: 7 }, { ...good, id: 'w-6', createdAt: undefined },
    { ...good, id: 'w-7', task: 'x'.repeat(5000), reason: 'y'.repeat(500), runId: 5, retryAt: NOW, manual: true },
  ])
  assert.deepEqual(list.map(wakeup => wakeup.id), ['w-1', 'w-7'])
  assert.deepEqual(list[0], good)
  assert.equal(list[1].task.length, 4000); assert.equal(list[1].reason.length, 300); assert.ok(list[1].task.endsWith('…'))
  assert.deepEqual(Object.keys(list[1]).sort(), ['createdAt', 'dueAt', 'id', 'reason', 'task'], 'the window\'s private fields and a runId that is no string are not kept')
  assert.deepEqual(wakeups.sanitizeWakeups('nope'), [])
  assert.deepEqual(wakeups.sanitizeWakeups(undefined), [])
  assert.equal(wakeups.sanitizeWakeups(Array.from({ length: 30 }, (_, n) => ({ ...good, id: `w-${n}` }))).length, 20)
})

test('the root\'s prompt line lists the chat\'s pending wake-ups, soonest first; helpers and an empty list get none', () => {
  const clock = () => NOW
  const list = [
    { id: 'w-late', dueAt: NOW + 2 * DAY, task: 'Continue the plan\nwith everything', reason: 'r', createdAt: '' },
    { id: 'w-over', dueAt: NOW - 5 * MIN, task: 'x'.repeat(200), reason: 'r', createdAt: '' },
  ]
  const line = wakeups.pendingLine({ clock }, { wakeups: list }, ROOT)
  assert.match(line, /^SCHEDULED WAKE-UPS of this chat \(cancel_wakeup \{id\} withdraws one\): w-over due \d{4}-.*\(overdue\): x{69}…; w-late due \d{4}-.*: Continue the plan with everything\.$/)
  assert.ok(!line.includes('\n'), 'one line')
  assert.equal(wakeups.pendingLine({ clock }, { wakeups: list }, HELPER), '')
  assert.equal(wakeups.pendingLine({ clock }, { wakeups: [] }, ROOT), '')
})

test('a run schedules in its turn, publishes the event with its chat and keeps the list in its record; the next run starts from the window\'s list', async t => {
  const workspace = folder(t)
  const prompts = []
  let turn = 0, scheduled
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    if (++turn === 1) return response(tool('schedule_wakeup', { afterMinutes: 120, task: 'Look at the nightly job', reason: 'the job ends at night' }))
    if (turn === 2) { scheduled = /id\\?":\\?"(w-[0-9a-f]{6})/.exec(prompt)?.[1]; return response(tool('cancel_wakeup', { id: 'w-gone' })) }
    return { text: 'Scheduled' }
  } })
  const first = await finished(runtime, payload(workspace, { wakeups: [
    { id: 'w-old', dueAt: Date.now() + 3600_000, task: 'Earlier plan', reason: 'earlier', createdAt: new Date().toISOString() }, { id: 'broken' },
  ] }))
  assert.equal(first.snapshot.status, 'completed')
  assert.match(prompts[0], /SCHEDULED WAKE-UPS of this chat \(cancel_wakeup \{id\} withdraws one\): w-old due /, 'the window\'s list is shown to the root')
  assert.ok(!prompts[0].includes('broken'))
  assert.match(prompts[0], /schedule_wakeup \{afterMinutes\?,at\?,task,reason\}: root only/, 'an envelope root reads the tool in its prompt')
  assert.ok(scheduled, `the observation of schedule_wakeup carries an id: ${prompts[1].slice(-600)}`)
  assert.match(prompts[2], /No pending wake-up \\?"w-gone\\?" in this chat; pending: w-old/, 'a refused cancel is an observation, the run goes on')
  const event = first.events.find(item => item.type === 'wakeup.scheduled')
  assert.equal(event.projectId, 'project-1'); assert.equal(event.chatId, 'chat-1'); assert.equal(event.runId, first.runId)
  assert.deepEqual([event.wakeup.id, event.wakeup.task, event.wakeup.reason, event.wakeup.runId], [scheduled, 'Look at the nightly job', 'the job ends at night', first.runId])
  assert.ok(Math.abs(event.wakeup.dueAt - Date.now() - 120 * MIN) < 5000)
  assert.deepEqual(first.snapshot.wakeups.map(item => item.id), ['w-old', scheduled], 'the record keeps the list, a continuation can start from it')
  assert.equal(first.snapshot.startPayload.wakeups, undefined, 'the window\'s list is not a setting a continuation starts again with')
  // The window fired w-old and sends what remains: the next run knows exactly that.
  const second = await finished(runtime, payload(workspace, { prompt: 'Second', wakeups: [event.wakeup] }))
  assert.match(prompts[3], new RegExp(`due .*: Look at the nightly job\\.`))
  assert.ok(!prompts[3].includes('w-old'))
  assert.deepEqual(second.snapshot.wakeups.map(item => item.id), [scheduled])
})

test('a continuation after a restart, started without the window, takes the list of the run it continues', async t => {
  const workspace = folder(t)
  const prompts = []
  let turn = 0
  const runtime = new OrbitRuntime({ runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    return ++turn === 1 ? response(tool('schedule_wakeup', { afterMinutes: 30, task: 'Ping me', reason: 'r' })) : { text: 'Done' }
  } })
  const first = await finished(runtime, payload(workspace))
  const pending = first.snapshot.wakeups
  assert.equal(pending.length, 1)
  const second = await finished(runtime, payload(workspace, { prompt: 'Continue', resumedFrom: first.runId }))
  assert.deepEqual(second.snapshot.wakeups, pending)
  assert.match(prompts.at(-1), /SCHEDULED WAKE-UPS of this chat .*: Ping me\./)
  // A run that is no continuation and has no list from the window knows none.
  const third = await finished(runtime, payload(workspace, { prompt: 'Unrelated' }))
  assert.equal(third.snapshot.wakeups, undefined)
  // The run store is read when the old run is gone (the runtime process was restarted).
  const stored = new OrbitRuntime({ runProvider: async () => ({ text: 'Done' }), runStore: { get: id => id === first.runId ? first.snapshot : null, forChat: () => [], save: async () => {} } })
  const fourth = await finished(stored, payload(workspace, { prompt: 'After the restart', resumedFrom: first.runId }))
  assert.deepEqual(fourth.snapshot.wakeups, pending)
})
