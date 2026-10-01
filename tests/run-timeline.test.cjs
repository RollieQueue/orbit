const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/file-map.test.cjs: vite's oxc transform, then an ES module from a data URL.
// run-timeline.ts only has type imports, which the transform erases.
let buildRunTimeline, tickOffsets
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'run-timeline.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
  ;({ buildRunTimeline, tickOffsets } = mod)
})

// Times are minutes and seconds after 12:00:00 UTC on 2026-10-01: `at` is the ISO text a run record holds, `T` the epoch
// milliseconds the timeline answers with. The clock is always passed in, so nothing here depends on the real time.
const at = (min, sec = 0) => new Date(Date.UTC(2026, 9, 1, 12, min, sec)).toISOString()
const T = (min, sec = 0) => Date.UTC(2026, 9, 1, 12, min, sec)
const MIN = 60000
const HOUR = 60 * MIN
const NOW = T(60)

// Builders: a provider turn (`to` left out = it has not ended), an agent (a helper of the root unless it is the root itself), a spawn
// message, a subscription change, and a run that finished 12:00-12:10; `live(...)` gives the options that make a run a working one.
const turn = (n, from, to, extra) => ({ turn: n, transport: 'session', startedAt: from, ...(to ? { endedAt: to } : {}), ...extra })
const agent = (id, extra) => ({ id, name: id, status: 'done', parentId: id === 'root' ? null : 'root', ...extra })
const spawn = (to, time, from = 'root') => ({ id: `spawn-${to}`, kind: 'spawn', fromAgentId: from, toAgentId: to, fromAgentName: from, toAgentName: to, text: 'task', time, status: 'read', delivery: 'next-turn' })
const handover = (id, time) => ({ id, time, reason: 'exhausted', from: { providerId: 'claude', model: 'opus' }, to: { providerId: 'codex', model: 'gpt' }, fresh: true, interrupted: false, usedPercent: 100, resetsAt: null })
const run = (agents, extra) => ({ runId: 'run-1', status: 'completed', prompt: '', workspace: '', agents, traces: [], messages: [], communications: [], startedAt: at(0), finishedAt: at(10), ...extra })
const live = extra => ({ status: 'working', finishedAt: undefined, ...extra })

const row = (tl, id) => tl.rows.find(r => r.agentId === id)
const view = bar => [bar.start, bar.end, bar.state, bar.open, bar.cut]
const ofKind = (tl, kind) => tl.markers.filter(m => m.kind === kind)
// wall time, time with two or more helpers, time with none, most helpers at once
const headline = tl => [tl.summary.wallMs, tl.summary.parallelMs, tl.summary.noHelperMs, tl.summary.maxHelpers]
// Walks a result and fails on any NaN or infinite number.
function assertFinite(value, where = 'timeline') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${where} is ${value}`)
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) assertFinite(inner, `${where}.${key}`)
}

test('an empty run, and agents without any times, give no time and do not throw', () => {
  for (const startedAt of [undefined, '', 'not a time']) {
    for (const status of ['completed', 'working']) {
      const tl = buildRunTimeline({ runId: 'r', status, agents: [], communications: [], startedAt }, NOW)
      assert.deepEqual(tl.rows, [], `${status} / ${startedAt}`)
      assert.deepEqual(tl.markers, [])
      assert.equal(tl.live, status === 'working')
      assert.equal(tl.summary.wallMs, 0)
      assert.equal(tl.summary.rootShare, 0)
      assert.deepEqual(tl.concurrency.filter(part => part.end > part.start), [])
      assertFinite(tl)
    }
  }
  // Missing lists are no reason to throw.
  const bare = buildRunTimeline({ runId: 'r', status: 'completed', startedAt: at(0) }, NOW)
  assert.deepEqual([bare.rows, bare.markers], [[], []])
  // Agents that carry no time at all (no start, no turn timings) still make rows.
  for (const status of ['working', 'completed']) {
    const tl = buildRunTimeline({ runId: 'r', status, agents: [agent('root', { status: 'working' }), agent('helper', { status: 'waiting' })] }, NOW)
    assert.deepEqual(tl.rows.map(r => [r.agentId, r.depth, r.parentId, r.bars.length, r.workMs, r.spawnedAt, r.queue]),
      [['root', 0, null, 0, 0, null, null], ['helper', 1, 'root', 0, 0, null, null]])
    // No provider or model on the record: null and an empty string, not undefined.
    assert.deepEqual(tl.rows.map(r => [r.providerId, r.model]), [[null, ''], [null, '']])
    assert.deepEqual(tl.markers, [])
    assert.equal(tl.summary.wallMs, 0)
    assert.equal(tl.summary.rootShare, 0)
    assertFinite(tl)
  }
})

test('concurrency counts the helpers with a turn running and keeps agent time apart from wall time', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('a', { turnTimings: [turn(1, at(1), at(5))] }),
    agent('b', { turnTimings: [turn(1, at(3), at(8)), turn(2, at(8), at(9))] })
  ]), NOW)
  // Nobody 0-1, a alone 1-3, a and b 3-5, b alone 5-9 (its two turns touch at 8:00: still one helper), nobody 9-10.
  assert.deepEqual(tl.concurrency, [
    { start: T(0), end: T(1), helpers: 0 },
    { start: T(1), end: T(3), helpers: 1 },
    { start: T(3), end: T(5), helpers: 2 },
    { start: T(5), end: T(9), helpers: 1 },
    { start: T(9), end: T(10), helpers: 0 }
  ])
  assert.deepEqual(headline(tl), [10 * MIN, 2 * MIN, 2 * MIN, 2])
  assert.equal(tl.summary.rootMs, 10 * MIN)
  // a 4 + b 5 + b 1: the stretch where a and b both work counts twice, it is agent time.
  assert.equal(tl.summary.helpersMs, 10 * MIN)
  assert.equal(tl.summary.rootShare, 0.5)
  assert.deepEqual(tl.rows.map(r => [r.agentId, r.workMs]), [['root', 10 * MIN], ['a', 4 * MIN], ['b', 6 * MIN]])
  assert.deepEqual(row(tl, 'b').bars.map(bar => [bar.start, bar.end]), [[T(3), T(8)], [T(8), T(9)]])
})

test('back-to-back turns of two different helpers are not an overlap', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('a', { turnTimings: [turn(1, at(1), at(5))] }),
    agent('c', { turnTimings: [turn(1, at(5), at(8))] })
  ]), NOW)
  // a ends at 5:00 and c starts at 5:00: one helper at a time from 1:00 to 8:00, so one merged stretch.
  assert.deepEqual(tl.concurrency, [
    { start: T(0), end: T(1), helpers: 0 },
    { start: T(1), end: T(8), helpers: 1 },
    { start: T(8), end: T(10), helpers: 0 }
  ])
  assert.deepEqual(headline(tl), [10 * MIN, 0, 3 * MIN, 1])
  assert.equal(tl.summary.helpersMs, 7 * MIN)
})

test('overlapping turns of one helper count once, in its work time and in the concurrency', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('a', { turnTimings: [turn(1, at(1), at(5)), turn(2, at(3), at(8))] })
  ]), NOW)
  assert.equal(row(tl, 'a').bars.length, 2)
  assert.equal(row(tl, 'a').workMs, 7 * MIN)
  assert.deepEqual(tl.concurrency, [
    { start: T(0), end: T(1), helpers: 0 },
    { start: T(1), end: T(8), helpers: 1 },
    { start: T(8), end: T(10), helpers: 0 }
  ])
  assert.deepEqual(headline(tl), [10 * MIN, 0, 3 * MIN, 1])
  assert.equal(tl.summary.helpersMs, 7 * MIN)
})

test('an open turn of a live run grows to now and the axis ends at now', () => {
  const now = T(15)
  const tl = buildRunTimeline(run([
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('h', { status: 'working', turnTimings: [turn(1, at(2), at(4)), turn(2, at(6))] })
  ], live({ updatedAt: at(14) })), now)
  assert.equal(tl.live, true)
  assert.equal(tl.start, T(0))
  assert.equal(tl.end, now)
  assert.equal(tl.summary.wallMs, 15 * MIN)
  assert.deepEqual(view(row(tl, 'root').bars[0]), [T(0), now, 'working', true, false])
  assert.deepEqual(row(tl, 'h').bars.map(view), [[T(2), T(4), 'done', false, false], [T(6), now, 'working', true, false]])
  // The open turn is work up to now: 2 + 9 minutes for the helper, 15 for the root.
  assert.equal(row(tl, 'h').workMs, 11 * MIN)
  assert.equal(row(tl, 'root').workMs, 15 * MIN)
  assert.deepEqual(tl.concurrency, [
    { start: T(0), end: T(2), helpers: 0 },
    { start: T(2), end: T(4), helpers: 1 },
    { start: T(4), end: T(6), helpers: 0 },
    { start: T(6), end: now, helpers: 1 }
  ])
  assert.equal(tl.summary.noHelperMs, 4 * MIN)

  // The run is still going but nobody has a turn open (the root waits): the axis still runs to the clock, not to the last update.
  const idle = buildRunTimeline(run([agent('root', { status: 'waiting', turnTimings: [turn(1, at(0), at(5))] })], live({ status: 'waiting', updatedAt: at(6) })), now)
  assert.deepEqual([idle.live, idle.end, idle.summary.wallMs], [true, now, 15 * MIN])
  assert.equal(idle.rows[0].bars[0].open, false)
})

test('an open turn takes the agent state: waiting, paused by the user, held by a paused ancestor', () => {
  const now = T(15)
  const tl = buildRunTimeline(run([
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('wait', { status: 'waiting', turnTimings: [turn(1, at(1))] }),
    agent('user', { status: 'working', paused: true, turnTimings: [turn(1, at(2))] }),
    agent('held', { status: 'paused', turnTimings: [turn(1, at(3))] }),
    // A pause flag on an agent that has finished means nothing (same rule as shownStatus in run-events.ts).
    agent('gone', { status: 'done', paused: true, turnTimings: [turn(1, at(4), at(5))] })
  ], live()), now)
  assert.deepEqual(tl.rows.map(r => [r.agentId, r.status, r.bars[0].state, r.bars[0].open, r.bars[0].end]), [
    ['root', 'working', 'working', true, now],
    ['wait', 'waiting', 'waiting', true, now],
    ['user', 'paused', 'paused', true, now],
    ['held', 'paused', 'paused', true, now],
    ['gone', 'done', 'done', false, T(5)]
  ])
})

test('an unfinished turn in an ended run is cut where the record stops, never extended to now', () => {
  const agents = () => [
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('own', { status: 'working', finishedAt: at(8), turnTimings: [turn(1, at(2))] }),
    agent('fin', { status: 'done', finishedAt: at(9), turnTimings: [turn(1, at(3))] })
  ]
  for (const status of ['completed', 'interrupted']) {
    const tl = buildRunTimeline(run(agents(), { status, finishedAt: at(12), updatedAt: at(13) }), NOW)
    assert.equal(tl.live, false, status)
    assert.equal(tl.end, T(12), status)
    // The root has no finish of its own: the run's finish. The others stop at their own; an agent that finished 'done' keeps
    // its bar 'done' (the bar is still cut: its turn never reported an end), like its finished marker.
    assert.deepEqual(tl.rows.map(r => [r.agentId, ...view(r.bars[0])]), [
      ['root', T(0), T(12), 'interrupted', false, true],
      ['own', T(2), T(8), 'interrupted', false, true],
      ['fin', T(3), T(9), 'done', false, true]
    ], status)
    // The cut turns still count as work: own 2-8 and fin 3-9 overlap from 3:00 to 8:00; nobody 0-2 and 9-12.
    assert.deepEqual(headline(tl), [12 * MIN, 5 * MIN, 5 * MIN, 2], status)
  }
  // No finish on the run either: the last update is where the record stops.
  const updated = buildRunTimeline(run(agents(), { status: 'interrupted', finishedAt: undefined, updatedAt: at(13) }), NOW)
  assert.equal(row(updated, 'root').bars[0].end, T(13))
  assert.equal(row(updated, 'own').bars[0].end, T(8))
  assert.equal(updated.end, T(13))
  assert.equal(updated.live, false)

  // Inside a live run a helper that has ended (here stopped by the user) is cut at its finish too: only a live agent's bar grows.
  const now = T(20)
  const going = buildRunTimeline(run([
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('gone', { status: 'cancelled', stoppedByUser: true, finishedAt: at(6), turnTimings: [turn(1, at(2))] })
  ], live({ updatedAt: at(19) })), now)
  assert.deepEqual(view(row(going, 'root').bars[0]), [T(0), now, 'working', true, false])
  assert.deepEqual(view(row(going, 'gone').bars[0]), [T(2), T(6), 'cancelled', false, true])
  assert.equal(row(going, 'gone').workMs, 4 * MIN)
})

test('a run Orbit ended at its next start is cut at its last save, not at that start', () => {
  // run-store finds a run still working on disk at the next start and ends it then: finishedAt is that start, ten hours later;
  // updatedAt is the last save; its working agents are cancelled without a finish of their own.
  const tl = buildRunTimeline(run([
    agent('root', { status: 'cancelled', turnTimings: [turn(1, at(0))] }),
    agent('h', { status: 'cancelled', turnTimings: [turn(1, at(2))] })
  ], { status: 'interrupted', finishedAt: at(600), updatedAt: at(13) }), NOW)
  assert.equal(tl.live, false)
  assert.equal(tl.end, T(13))
  assert.deepEqual(tl.rows.map(r => [r.agentId, ...view(r.bars[0])]), [
    ['root', T(0), T(13), 'cancelled', false, true],
    ['h', T(2), T(13), 'cancelled', false, true]
  ])
  assert.deepEqual(headline(tl), [13 * MIN, 0, 2 * MIN, 1])
  // A run saved after it finished (the usual order) keeps its own finish.
  const normal = buildRunTimeline(run([agent('root', { turnTimings: [turn(1, at(0), at(10))] })], { finishedAt: at(10), updatedAt: at(11) }), NOW)
  assert.equal(normal.end, T(10))
})

test('closed turns are done; only the last bar of an ended agent takes the way it ended', () => {
  for (const ending of ['error', 'cancelled', 'interrupted', 'restarting']) {
    const tl = buildRunTimeline(run([
      agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
      // The timings come in reverse order: the last bar is the latest one in time.
      agent('h', { status: ending, turnTimings: [turn(2, at(5), at(6)), turn(1, at(1), at(2))] })
    ]), NOW)
    assert.deepEqual(row(tl, 'h').bars.map(bar => [bar.turn, bar.state, bar.open, bar.cut]), [[1, 'done', false, false], [2, ending, false, false]], ending)
    assert.equal(row(tl, 'h').status, ending)
    assert.equal(row(tl, 'root').bars[0].state, 'done')
  }
  // Finished cleanly, still working between two turns, or waiting: every closed bar is done and nothing is open.
  for (const status of ['done', 'working', 'waiting']) {
    const tl = buildRunTimeline(run([
      agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
      agent('h', { status, turnTimings: [turn(1, at(1), at(2)), turn(2, at(3), at(4))] })
    ], live()), T(20))
    assert.deepEqual(row(tl, 'h').bars.map(bar => [bar.state, bar.open]), [['done', false], ['done', false]], status)
  }
})

test('rows follow the spawn tree: each parent followed by its helpers, siblings by spawn time, array order only breaks ties', () => {
  const tree = [
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('A', { turnTimings: [turn(1, at(0, 40), at(5))] }),
    agent('B', { turnTimings: [turn(1, at(0, 20), at(3))] }),
    agent('A1', { parentId: 'A', turnTimings: [turn(1, at(1, 10), at(4))] }),
    agent('A2', { parentId: 'A1', turnTimings: [turn(1, at(2, 10), at(3))] })
  ]
  const spawns = [spawn('A', at(0, 30)), spawn('B', at(0, 10)), spawn('A1', at(1), 'A'), spawn('A2', at(2), 'A1')]
  // B is listed after A but was spawned first.
  const tl = buildRunTimeline(run(tree, { communications: spawns }), NOW)
  assert.deepEqual(tl.rows.map(r => [r.agentId, r.depth, r.parentId]), [['root', 0, null], ['B', 1, 'root'], ['A', 1, 'root'], ['A1', 2, 'A'], ['A2', 3, 'A1']])
  // A helper of B spawned after A still stands under B, not after A's subtree.
  const deeper = buildRunTimeline(run([...tree, agent('B1', { parentId: 'B', turnTimings: [turn(1, at(0, 55), at(2))] })], { communications: [...spawns, spawn('B1', at(0, 50), 'B')] }), NOW)
  assert.deepEqual(deeper.rows.map(r => [r.agentId, r.depth]), [['root', 0], ['B', 1], ['B1', 2], ['A', 1], ['A1', 2], ['A2', 3]])
  // Without a spawn message the first turn is the spawn time; equal spawn times keep the array order.
  const flat = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('G', { turnTimings: [turn(1, at(1), at(2))] }),
    agent('D', { turnTimings: [turn(1, at(2), at(3))] }),
    agent('C', { turnTimings: [turn(1, at(2), at(3))] }),
    agent('F', { turnTimings: [turn(1, at(0, 45), at(1))] })
  ], { communications: [spawn('G', at(0, 48)), spawn('D', at(0, 50)), spawn('C', at(0, 50))] }), NOW)
  assert.deepEqual(flat.rows.map(r => r.agentId), ['root', 'F', 'G', 'D', 'C'])
})

test('broken parent links: an orphan stands at the top level after the root subtree, a parent loop cannot hang the order', () => {
  // The orphan (parent 'ghost' is not in the run) is the earliest agent and is listed before the root, yet follows the root's subtree.
  const orphans = buildRunTimeline(run([
    agent('orphan', { parentId: 'ghost', turnTimings: [turn(1, at(0, 5), at(2))] }),
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('h1', { turnTimings: [turn(1, at(0, 20), at(3))] }),
    agent('kid', { parentId: 'orphan', turnTimings: [turn(1, at(0, 30), at(1))] })
  ]), NOW)
  assert.deepEqual(orphans.rows.map(r => [r.agentId, r.depth, r.parentId]), [['root', 0, null], ['h1', 1, 'root'], ['orphan', 0, null], ['kid', 1, 'orphan']])

  // X and Y name each other, Z hangs under X, Self names itself; none of them is reachable from the root.
  const loop = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('X', { parentId: 'Y', turnTimings: [turn(1, at(1), at(2))] }),
    agent('Y', { parentId: 'X', turnTimings: [turn(1, at(1, 30), at(3))] }),
    agent('Z', { parentId: 'X', turnTimings: [turn(1, at(2), at(4))] }),
    agent('Self', { parentId: 'Self', turnTimings: [turn(1, at(5), at(6))] })
  ]), NOW)
  assert.equal(loop.rows.length, 5)
  assert.deepEqual(loop.rows.map(r => r.agentId).sort(), ['Self', 'X', 'Y', 'Z', 'root'])
  // An agent that names itself has no parent; the X-Y loop is cut where it is first met: X stands at the top, Y and Z under it.
  assert.deepEqual(loop.rows.map(r => [r.agentId, r.depth, r.parentId]), [['root', 0, null], ['Self', 0, null], ['X', 0, null], ['Y', 1, 'X'], ['Z', 1, 'X']])
  // Every agent is counted once: 1 + 1.5 + 2 + 1 minutes of helper work.
  assert.equal(loop.summary.helpersMs, 5.5 * MIN)
  assertFinite(loop)
})

test('spawnedAt is the earliest of the spawn message and the first turn; the root has none; repeated turn numbers make separate bars', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(30))] }),
    agent('early', { turnTimings: [turn(1, at(1, 40), at(3))] }),
    agent('late', { turnTimings: [turn(1, at(3, 30), at(5))] }),
    // A follow-up restarted these two (generation 1, startedAt moved to the follow-up): their first turns are still the old ones.
    agent('again', { generation: 1, startedAt: at(20), turnTimings: [turn(1, at(6), at(8)), turn(2, at(20), at(22))] }),
    agent('plain', { generation: 1, startedAt: at(21), turnTimings: [turn(1, at(7), at(9)), turn(1, at(21), at(23))] })
  ], {
    finishedAt: at(30),
    communications: [
      spawn('early', at(1)), // older than its first turn: wins
      spawn('late', at(4)), // newer than its first turn: the first turn wins
      spawn('again', at(9)), spawn('again', at(5, 40)), spawn('again', at(7)), // several spawn messages: the earliest, wherever it stands
      { ...spawn('plain', at(6, 30)), kind: 'followup' }, // not a spawn
      spawn('plain', 'not a time') // unreadable: skipped
    ]
  }), NOW)
  assert.deepEqual(Object.fromEntries(tl.rows.map(r => [r.agentId, r.spawnedAt])), { root: null, early: T(1), late: T(3, 30), again: T(5, 40), plain: T(7) })
  assert.equal(ofKind(tl, 'spawned').some(m => m.agentId === 'root'), false)
  assert.deepEqual(row(tl, 'again').bars.map(bar => [bar.turn, bar.start, bar.end]), [[1, T(6), T(8)], [2, T(20), T(22)]])
  // The number 1 comes twice: two bars, told apart by their times.
  assert.deepEqual(row(tl, 'plain').bars.map(bar => [bar.turn, bar.start, bar.end]), [[1, T(7), T(9)], [1, T(21), T(23)]])
  assert.equal(row(tl, 'plain').workMs, 4 * MIN)
})

test('queue is the wait from creation to the first turn, up to the axis end for a helper that has not started', () => {
  const now = T(10)
  const tl = buildRunTimeline(run([
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('slow', { turnTimings: [turn(1, at(1, 40), at(3))] }),
    agent('pending', { status: 'waiting' }),
    agent('prompt', { turnTimings: [turn(1, at(5), at(6))] }),
    agent('instant', { turnTimings: [turn(1, at(6), at(7))] })
  ], live({
    communications: [spawn('slow', at(1)), spawn('pending', at(4)), spawn('instant', at(6))]
  })), now)
  assert.deepEqual(row(tl, 'slow').queue, { start: T(1), end: T(1, 40) })
  assert.deepEqual(row(tl, 'pending').queue, { start: T(4), end: now })
  assert.equal(tl.end, now)
  assert.deepEqual([row(tl, 'pending').bars.length, row(tl, 'pending').workMs, row(tl, 'pending').spawnedAt], [0, 0, T(4)])
  // The root, a helper with no spawn message (its first turn is its creation), a helper whose first turn starts at once: no queue.
  for (const id of ['root', 'prompt', 'instant']) assert.equal(row(tl, id).queue, null, id)

  // An older record (no turn timings) whose start was reset by a follow-up: the wait until that start is a queue only for a
  // first-generation helper; after a follow-up (generation 1) the helper worked before it, so nothing is drawn as waiting.
  const old = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('first', { startedAt: at(8), finishedAt: at(9) }),
    agent('again', { generation: 1, startedAt: at(8), finishedAt: at(9) })
  ], { communications: [spawn('first', at(2)), spawn('again', at(2))] }), NOW)
  assert.deepEqual(row(old, 'first').queue, { start: T(2), end: T(8) })
  assert.equal(row(old, 'again').queue, null)
})

test('an agent without turn timings gets one estimated bar from its start to its finish', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('old', { startedAt: at(2), finishedAt: at(7) }),
    agent('blank')
  ]), NOW)
  const bar = row(tl, 'old').bars
  assert.equal(bar.length, 1)
  assert.deepEqual(view(bar[0]), [T(2), T(7), 'done', false, false])
  assert.deepEqual([bar[0].estimated, bar[0].turn, bar[0].nativeToolCalls, bar[0].orbitToolCalls], [true, 0, 0, 0])
  assert.equal(row(tl, 'old').workMs, 5 * MIN)
  // The agent with neither timings nor a start is still a row, with nothing to draw.
  assert.deepEqual([row(tl, 'blank').bars, row(tl, 'blank').workMs], [[], 0])
  assert.deepEqual(tl.rows.map(r => r.agentId), ['root', 'old', 'blank'])
  assert.equal(row(tl, 'root').bars[0].estimated, false)

  // A live run and a working agent: the bar is open and ends at now.
  const now = T(12)
  const working = buildRunTimeline(run([agent('root', { status: 'working', startedAt: at(0) }), agent('old', { status: 'working', startedAt: at(4) })], live()), now)
  assert.deepEqual(view(row(working, 'old').bars[0]), [T(4), now, 'working', true, false])
  assert.equal(row(working, 'old').bars[0].estimated, true)
  assert.equal(working.end, now)

  // An agent that never recorded a finish, in a run that is over: drawn up to where the record stops, not to now.
  const stale = buildRunTimeline(run([agent('root', { startedAt: at(0), finishedAt: at(10) }), agent('old', { status: 'working', startedAt: at(3) })]), NOW)
  assert.equal(row(stale, 'old').bars[0].end, T(10))
  assert.equal(row(stale, 'old').bars[0].open, false)
  // It reads as cut and interrupted, the same as an unfinished turn of such an agent does.
  assert.deepEqual(view(row(stale, 'old').bars[0]), [T(3), T(10), 'interrupted', false, true])
  // An agent that ended badly shows it on its estimated bar too.
  const failed = buildRunTimeline(run([agent('root', { turnTimings: [turn(1, at(0), at(10))] }), agent('old', { status: 'error', startedAt: at(2), finishedAt: at(7) })]), NOW)
  assert.equal(row(failed, 'old').bars[0].state, 'error')
})

test('a spawned marker sits on the parent row at the spawn time; a helper whose parent is missing hangs on the root', () => {
  const tl = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(10))] }),
    agent('A', { turnTimings: [turn(1, at(1, 30), at(5))] }),
    agent('A1', { parentId: 'A', turnTimings: [turn(1, at(2, 30), at(4))] }),
    agent('lost', { parentId: 'ghost', turnTimings: [turn(1, at(3, 30), at(6))] })
  ], { communications: [spawn('A', at(1)), spawn('A1', at(2), 'A'), spawn('lost', at(3), 'ghost')] }), NOW)
  assert.deepEqual(ofKind(tl, 'spawned').map(m => [m.at, m.rowId, m.agentId]), [[T(1), 'root', 'A'], [T(2), 'A', 'A1'], [T(3), 'root', 'lost']])
})

test('a finished marker sits on the own row of an ended helper at its finish, with the way it ended', () => {
  const now = T(30)
  const tl = buildRunTimeline(run([
    agent('root', { status: 'working', turnTimings: [turn(1, at(0))] }),
    agent('busy', { status: 'working', turnTimings: [turn(1, at(1))] }),
    agent('idle', { status: 'waiting', turnTimings: [turn(1, at(2), at(3))] }),
    agent('ok', { status: 'done', finishedAt: at(6, 30), turnTimings: [turn(1, at(2), at(6))] }),
    // No finish of its own: the end of its last bar.
    agent('bad', { status: 'error', turnTimings: [turn(1, at(3), at(9))] }),
    agent('stopped', { status: 'cancelled', stoppedByUser: true, finishedAt: at(12), turnTimings: [turn(1, at(5), at(8))] }),
    agent('cut', { status: 'interrupted', finishedAt: at(15), turnTimings: [turn(1, at(4), at(14))] }),
    agent('moved', { status: 'restarting', finishedAt: at(16), turnTimings: [turn(1, at(5), at(15))] })
  ], live()), now)
  assert.deepEqual(ofKind(tl, 'finished').map(m => [m.at, m.rowId, m.agentId, m.state]), [
    [T(6, 30), 'ok', 'ok', 'done'],
    [T(9), 'bad', 'bad', 'error'],
    [T(12), 'stopped', 'stopped', 'cancelled'],
    [T(15), 'cut', 'cut', 'interrupted'],
    [T(16), 'moved', 'moved', 'restarting']
  ])
})

test('handover and restart markers; every kind comes back sorted by time', () => {
  const [first, second, atRoot] = [handover('ho-a1', at(3)), handover('ho-a2', at(5)), handover('ho-root', at(7))]
  const tl = buildRunTimeline(run([
    agent('root', { handovers: [atRoot], turnTimings: [turn(1, at(0), at(10))] }),
    agent('a', { finishedAt: at(9, 30), handovers: [first, second], turnTimings: [turn(1, at(1, 30), at(9, 30))] })
  ], { communications: [spawn('a', at(1))] }), NOW)
  // The root's handover is met first when the rows are walked, but it happened after the helper's two.
  assert.deepEqual(tl.markers.map(m => [m.kind, m.at, m.rowId, m.agentId]), [
    ['spawned', T(1), 'root', 'a'],
    ['handover', T(3), 'a', 'a'],
    ['handover', T(5), 'a', 'a'],
    ['handover', T(7), 'root', 'root'],
    ['finished', T(9, 30), 'a', 'a']
  ])
  assert.deepEqual(ofKind(tl, 'handover').map(m => m.handover), [first, second, atRoot])

  // A restart belongs to the whole chart (no row, no agent), at the time the agent asked for it.
  const restarting = () => [agent('root', { status: 'restarting', turnTimings: [turn(1, at(0), at(17))] })]
  const request = { reason: 'apply the update', requestedAt: at(18), source: 'tool' }
  const asked = buildRunTimeline(run(restarting(), { status: 'restarting', restart: request, finishedAt: at(19) }), NOW)
  assert.deepEqual(ofKind(asked, 'restart').map(m => [m.at, m.rowId, m.agentId]), [[T(18), null, null]])
  assert.deepEqual(ofKind(asked, 'restart')[0].restart, request)
  assert.equal(asked.end, T(19))
  // Only the status says it restarts: the marker goes to the end of the run.
  const unknown = buildRunTimeline(run(restarting(), { status: 'restarting', finishedAt: at(19) }), NOW)
  assert.deepEqual(ofKind(unknown, 'restart').map(m => [m.at, m.rowId, m.agentId]), [[T(19), null, null]])
  // The record has no finish and no update either: the marker goes to where the chart ends (the last turn).
  const bare = buildRunTimeline(run(restarting(), { status: 'restarting', finishedAt: undefined, updatedAt: undefined }), NOW)
  assert.deepEqual(ofKind(bare, 'restart').map(m => [m.at, m.rowId]), [[T(17), null]])
  assert.equal(bare.end, T(17))
  // A normal run has none.
  assert.deepEqual(buildRunTimeline(run([agent('root', { turnTimings: [turn(1, at(0), at(10))] })]), NOW).markers, [])
})

test('in a run ended by an Orbit restart, agents saved as cancelled read as restarting unless the user stopped them', () => {
  // The saved record of a restarting run keeps its agents as 'cancelled'; the root's detail says why.
  const agents = () => [
    agent('root', { status: 'cancelled', detail: 'Orbit перезапускается по запросу агента', turnTimings: [turn(1, at(0), at(17))] }),
    agent('swept', { status: 'cancelled', finishedAt: at(16), turnTimings: [turn(1, at(2), at(6)), turn(2, at(8), at(15))] }),
    // Killed with the run: its last turn never reported an end.
    agent('killed', { status: 'cancelled', finishedAt: at(17), turnTimings: [turn(1, at(4))] }),
    agent('stopped', { status: 'cancelled', stoppedByUser: true, finishedAt: at(12), turnTimings: [turn(1, at(3), at(11))] }),
    // Only 'cancelled' is rewritten: another way of ending is kept.
    agent('crashed', { status: 'error', finishedAt: at(13), turnTimings: [turn(1, at(5), at(13))] })
  ]
  const last = r => r.bars[r.bars.length - 1].state
  const request = { reason: 'apply the update', requestedAt: at(18), source: 'tool' }
  const restarting = buildRunTimeline(run(agents(), { status: 'restarting', restart: request, finishedAt: at(19) }), NOW)
  assert.deepEqual(restarting.rows.map(r => [r.agentId, r.status, last(r)]), [
    ['root', 'restarting', 'restarting'],
    ['swept', 'restarting', 'restarting'],
    ['stopped', 'cancelled', 'cancelled'],
    ['killed', 'restarting', 'restarting'],
    ['crashed', 'error', 'error']
  ])
  // Only the last bar takes it: the earlier turn of the agent was an ordinary finished one.
  assert.deepEqual(row(restarting, 'swept').bars.map(bar => bar.state), ['done', 'restarting'])
  assert.deepEqual(view(row(restarting, 'killed').bars[0]), [T(4), T(17), 'restarting', false, true])
  assert.deepEqual(ofKind(restarting, 'finished').map(m => [m.at, m.agentId, m.state]), [
    [T(12), 'stopped', 'cancelled'], [T(13), 'crashed', 'error'], [T(16), 'swept', 'restarting'], [T(17), 'killed', 'restarting']
  ])
  assert.deepEqual(ofKind(restarting, 'restart').map(m => m.at), [T(18)])

  // The same record in a run that ended any other way stays cancelled.
  for (const status of ['completed', 'interrupted', 'failed', 'cancelled']) {
    const other = buildRunTimeline(run(agents(), { status, finishedAt: at(19) }), NOW)
    assert.deepEqual(other.rows.map(r => [r.agentId, r.status, last(r)]), [
      ['root', 'cancelled', 'cancelled'],
      ['swept', 'cancelled', 'cancelled'],
      ['stopped', 'cancelled', 'cancelled'],
      ['killed', 'cancelled', 'cancelled'],
      ['crashed', 'error', 'error']
    ], status)
    assert.deepEqual(ofKind(other, 'finished').map(m => [m.agentId, m.state]), [['stopped', 'cancelled'], ['crashed', 'error'], ['swept', 'cancelled'], ['killed', 'cancelled']], status)
    assert.deepEqual(ofKind(other, 'restart'), [], status)
  }
})

test('the axis starts at the earliest known time and ends at the latest', () => {
  const root = (from, to) => agent('root', { turnTimings: [turn(1, from, to)] })
  // A turn that began before the run's own start moves the start back.
  const early = buildRunTimeline(run([root(at(3), at(9))], { startedAt: at(5) }), NOW)
  assert.deepEqual([early.start, early.end, early.summary.wallMs], [T(3), T(10), 7 * MIN])
  // So does a spawn message older than every turn.
  const spawned = buildRunTimeline(run([root(at(3), at(9)), agent('h', { turnTimings: [turn(1, at(6), at(8))] })], { startedAt: at(5), communications: [spawn('h', at(2, 30))] }), NOW)
  assert.deepEqual([spawned.start, spawned.end, spawned.summary.wallMs], [T(2, 30), T(10), 7.5 * MIN])
  // The usual case: the run starts first.
  const usual = buildRunTimeline(run([root(at(3), at(9))], { startedAt: at(1) }), NOW)
  assert.deepEqual([usual.start, usual.end], [T(1), T(10)])
  // A turn that ends after the run's finish pushes the end out; a finish after every turn is the end.
  const late = buildRunTimeline(run([root(at(0), at(11))], { finishedAt: at(10) }), NOW)
  assert.deepEqual([late.end, late.summary.wallMs], [T(11), 11 * MIN])
  assert.equal(buildRunTimeline(run([root(at(0), at(9))], { finishedAt: at(10) }), NOW).end, T(10))
  // Without a finish the last update is the end of an ended run.
  assert.equal(buildRunTimeline(run([root(at(0), at(9))], { finishedAt: undefined, updatedAt: at(12) }), NOW).end, T(12))
  // The concurrency profile covers exactly the axis.
  const parts = spawned.concurrency
  assert.equal(parts[0].start, spawned.start)
  assert.equal(parts[parts.length - 1].end, spawned.end)
  parts.slice(1).forEach((part, index) => assert.equal(part.start, parts[index].end))
})

test('unparsable times are skipped, the rest of the record stays and no number is NaN', () => {
  const tl = buildRunTimeline(run([
    // Turn 1 and 3 have no readable start: no bar. Turn 2 is fine.
    agent('root', { turnTimings: [turn(1, 'nope', at(2)), turn(2, at(1), at(4)), turn(3, undefined, at(5))] }),
    agent('h', { finishedAt: 'bad', turnTimings: [turn(1, at(2), at(3)), turn(2, '', at(5))], handovers: [handover('ho-bad', 'yesterday')] })
  ], { startedAt: 'also bad', finishedAt: at(10), communications: [spawn('h', 'bad')] }), NOW)
  assert.deepEqual(row(tl, 'root').bars.map(bar => [bar.start, bar.end]), [[T(1), T(4)]])
  assert.deepEqual(row(tl, 'h').bars.map(bar => [bar.start, bar.end]), [[T(2), T(3)]])
  // The unreadable spawn message is ignored (the first turn is the spawn time), the unreadable finish falls back to the last bar,
  // the unreadable handover has no marker.
  assert.equal(row(tl, 'h').spawnedAt, T(2))
  assert.deepEqual(tl.markers.map(m => [m.kind, m.at, m.rowId, m.agentId]), [['spawned', T(2), 'root', 'h'], ['finished', T(3), 'h', 'h']])
  // The start is the earliest readable time (the run's own start is unreadable), the end the run's finish.
  assert.deepEqual([tl.start, tl.end], [T(1), T(10)])
  assert.deepEqual(headline(tl), [9 * MIN, 0, 8 * MIN, 1])
  assert.equal(tl.summary.rootShare, 0.75)
  assertFinite(tl)
})

test('rootShare is the root part of all agent time and only the agent called root is the root', () => {
  // The root works 30 minutes, three helpers 30 minutes each at the same time: 90 agent-minutes.
  const crowd = buildRunTimeline(run([
    agent('root', { turnTimings: [turn(1, at(0), at(30))] }),
    ...['h1', 'h2', 'h3'].map(id => agent(id, { turnTimings: [turn(1, at(0), at(30))] }))
  ], { finishedAt: at(30) }), NOW)
  assert.equal(crowd.summary.rootMs, 30 * MIN)
  assert.equal(crowd.summary.helpersMs, 90 * MIN)
  assert.equal(crowd.summary.rootShare, 0.25)
  assert.deepEqual(headline(crowd), [30 * MIN, 30 * MIN, 0, 3])

  // Nothing worked (no bars, or bars of no length): 0, not NaN.
  assert.equal(buildRunTimeline(run([agent('root'), agent('h')]), NOW).summary.rootShare, 0)
  assert.equal(buildRunTimeline(run([agent('root', { turnTimings: [turn(1, at(2), at(2))] })]), NOW).summary.rootShare, 0)
  // The root alone did everything.
  assert.equal(buildRunTimeline(run([agent('root', { turnTimings: [turn(1, at(0), at(10))] })]), NOW).summary.rootShare, 1)

  // A top-level agent that is not called root is a helper, whatever its name says.
  const lead = buildRunTimeline(run([
    agent('lead', { name: 'root', parentId: null, turnTimings: [turn(1, at(0), at(8))] }),
    agent('h', { parentId: 'lead', turnTimings: [turn(1, at(1), at(3))] })
  ]), NOW)
  assert.equal(lead.summary.rootMs, 0)
  assert.equal(lead.summary.helpersMs, 10 * MIN)
  assert.equal(lead.summary.rootShare, 0)
  assert.equal(row(lead, 'lead').isRoot, false)
  assert.deepEqual(headline(lead), [10 * MIN, 2 * MIN, 2 * MIN, 2])
})

test('tickOffsets picks the smallest round step that fits the label budget', () => {
  assert.deepEqual(tickOffsets(82 * MIN, 6), [0, 15, 30, 45, 60, 75].map(minutes => minutes * MIN))
  assert.deepEqual(tickOffsets(82 * MIN, 5), [0, 20, 40, 60, 80].map(minutes => minutes * MIN))
  assert.deepEqual(tickOffsets(45 * 1000, 6), [0, 10, 20, 30, 40].map(seconds => seconds * 1000))
  // Hours: 1 h would need 11 labels and 2 h would need 6, so the step is 3 h.
  assert.deepEqual(tickOffsets(10 * HOUR, 5), [0, 3, 6, 9].map(hours => hours * HOUR))
})

test('tickOffsets: degenerate inputs give one label, absurd spans stay within the budget, and the labels are always even and inside the span', () => {
  for (const [span, ticks] of [[0, 6], [-5 * MIN, 6], [NaN, 6], [5 * MIN, 1], [5 * MIN, 0], [5 * MIN, -3]]) assert.deepEqual(tickOffsets(span, ticks), [0], `${span}, ${ticks}`)
  const huge = tickOffsets(1000 * 24 * HOUR, 5)
  assert.ok(huge.length >= 2 && huge.length <= 5, `${huge.length} labels for 1000 days`)
  assert.equal(huge[0], 0)
  assert.ok(huge[huge.length - 1] <= 1000 * 24 * HOUR)
  for (const span of [1, 999, 1000, 45 * 1000, 59 * MIN + 59 * 1000, 82 * MIN, 3 * HOUR, 10 * HOUR, 49 * HOUR, 1000 * 24 * HOUR]) {
    for (const ticks of [2, 3, 5, 6, 8, 12]) {
      const offsets = tickOffsets(span, ticks)
      const label = `${span} ms, ${ticks} labels`
      assert.equal(offsets[0], 0, label)
      assert.ok(offsets.length >= 1 && offsets.length <= ticks, label)
      assert.ok(offsets.every(offset => Number.isInteger(offset) && offset <= span), label)
      const step = offsets[1] - offsets[0]
      if (offsets.length > 1) assert.ok(step > 0 && offsets.every((offset, index) => offset === index * step), `even steps: ${label}`)
    }
  }
})

test('a realistic saved run: the headline numbers and the facts of each row', () => {
  const H1 = 'agent-1f0c9a52-7d4e-4b8a-9c11-2a6f3e8d5b01', H2 = 'agent-7b3e0d44-95a1-4f27-8e6c-c1d2a9b7f302'
  const H3 = 'agent-c92a61e8-3b05-4d19-a7f0-5e8b4c6d9a03', H4 = 'agent-0d5f8b17-e2c4-46a3-b9d8-71a3e5f0c204'
  const saved = run([
    agent('root', { name: 'Orbit', providerId: 'claude', model: 'claude-opus-5-5', turns: 1, turnTimings: [turn(1, at(0, 3), at(58, 25), { nativeToolCalls: 140, orbitToolCalls: 25 })] }),
    agent(H1, { name: 'reader', providerId: 'codex', model: 'gpt-6-luna', finishedAt: at(9, 41), turnTimings: [turn(1, at(2, 15), at(9, 40), { nativeToolCalls: 31, orbitToolCalls: 4 })] }),
    agent(H2, {
      name: 'implementer', providerId: 'claude', model: 'claude-sonnet-5-5', finishedAt: at(36, 5), handovers: [handover('ho-1', at(10, 10))],
      turnTimings: [
        turn(1, at(4, 5), at(10), { nativeToolCalls: 12, orbitToolCalls: 3 }),
        // After the subscription change the new process counts from 1 again.
        turn(1, at(10, 20), at(15), { nativeToolCalls: 30, orbitToolCalls: 5 }),
        // Seventeen minutes of waiting for the root's follow-up, then the last turn.
        turn(2, at(32), at(36), { nativeToolCalls: 8, orbitToolCalls: 1 })
      ]
    }),
    agent(H3, { name: 'stopped', status: 'cancelled', stoppedByUser: true, finishedAt: at(25, 31), turnTimings: [turn(1, at(20, 5), at(25, 30))] }),
    agent(H4, { name: 'reviewer', finishedAt: at(44, 1), turnTimings: [turn(1, at(36, 35), at(44))] })
  ], {
    finishedAt: at(58, 30),
    updatedAt: at(58, 30),
    communications: [spawn(H1, at(2, 10)), spawn(H2, at(4)), { ...spawn(H2, at(31, 55)), kind: 'followup' }, spawn(H3, at(20)), spawn(H4, at(36, 30))]
  })
  const tl = buildRunTimeline(saved, NOW)
  assert.equal(tl.live, false)
  assert.deepEqual([tl.start, tl.end], [T(0), T(58, 30)])
  // Wall 58:30 = 3510 s. Two helpers at once 4:05-9:40 = 335 s. Nobody 0-2:15, 10:00-10:20, 15:00-20:05, 25:30-32:00, 36:00-36:35
  // and 44:00-58:30 = 135 + 20 + 305 + 390 + 35 + 870 = 1755 s. At most two helpers.
  assert.deepEqual(headline(tl), [3510 * 1000, 335 * 1000, 1755 * 1000, 2])
  assert.deepEqual(tl.concurrency.map(part => [part.start, part.end, part.helpers]), [
    [T(0), T(2, 15), 0], [T(2, 15), T(4, 5), 1], [T(4, 5), T(9, 40), 2], [T(9, 40), T(10), 1], [T(10), T(10, 20), 0], [T(10, 20), T(15), 1], [T(15), T(20, 5), 0],
    [T(20, 5), T(25, 30), 1], [T(25, 30), T(32), 0], [T(32), T(36), 1], [T(36), T(36, 35), 0], [T(36, 35), T(44), 1], [T(44), T(58, 30), 0]
  ])
  // Root 58:25 - 0:03 = 3502 s. Helpers 445 + (355 + 280 + 240) + 325 + 445 = 2090 s.
  assert.equal(tl.summary.rootMs, 3502 * 1000)
  assert.equal(tl.summary.helpersMs, 2090 * 1000)
  assert.ok(Math.abs(tl.summary.rootShare - 3502 / 5592) < 1e-12)

  assert.deepEqual(tl.rows.map(r => [r.agentId, r.depth, r.parentId, r.workMs / 1000]), [['root', 0, null, 3502], [H1, 1, 'root', 445], [H2, 1, 'root', 875], [H3, 1, 'root', 325], [H4, 1, 'root', 445]])
  assert.deepEqual([row(tl, 'root').name, row(tl, 'root').providerId, row(tl, 'root').model, row(tl, 'root').isRoot], ['Orbit', 'claude', 'claude-opus-5-5', true])
  const h2 = row(tl, H2)
  assert.deepEqual(h2.bars.map(bar => [bar.turn, bar.start, bar.end, bar.state]), [[1, T(4, 5), T(10), 'done'], [1, T(10, 20), T(15), 'done'], [2, T(32), T(36), 'done']])
  assert.equal(h2.actions, 12 + 3 + 30 + 5 + 8 + 1)
  assert.equal(row(tl, 'root').actions, 165)
  // A turn that reports no tool calls counts none.
  assert.deepEqual([row(tl, H4).actions, row(tl, H4).bars[0].nativeToolCalls, row(tl, H4).bars[0].orbitToolCalls], [0, 0, 0])
  assert.deepEqual(h2.queue, { start: T(4), end: T(4, 5) })
  // The user's stop shows on the helper's last (here only) bar and on its row.
  assert.deepEqual([row(tl, H3).status, row(tl, H3).bars[0].state, row(tl, H3).bars[0].cut], ['cancelled', 'cancelled', false])
  assert.deepEqual(tl.markers.map(m => [m.kind, m.at, m.agentId]), [
    ['spawned', T(2, 10), H1], ['spawned', T(4), H2], ['finished', T(9, 41), H1], ['handover', T(10, 10), H2], ['spawned', T(20), H3],
    ['finished', T(25, 31), H3], ['finished', T(36, 5), H2], ['spawned', T(36, 30), H4], ['finished', T(44, 1), H4]
  ])
  assertFinite(tl)
})
