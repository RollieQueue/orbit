'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createProcessWatch, membersOf, describeStopped } = require('../electron/process-reaper.mts')
const { parseProcessTable } = require('../electron/process-table.mts')

// A fake process table: rows are set by the test, the clock moves one ms per reading of it, so a reading taken after an
// event is never confused with one taken before it, and `kill` only records.
const T = 1_700_000_000_000
const row = (pid, ppid, created, name = 'x.exe') => ({ pid, ppid, created, name })

function fakeChild(pid) {
  const listeners = []
  return { pid, once: (event, listener) => { if (event === 'exit') listeners.push(listener) }, exit: () => { for (const listener of listeners.splice(0)) listener() } }
}

function harness(options = {}) {
  let clock = T
  let table = []
  const reads = [], killed = [], names = [], groups = []
  const watch = createProcessWatch({
    read: async () => { reads.push(clock); return table === null ? null : table.map(item => ({ ...item })) },
    kill: async (pid, name) => { killed.push(pid); names.push(name) },
    killGroup: (pid) => { groups.push(pid) },
    now: () => clock++, platform: 'win32', snapshotMs: 0, settleMs: 0, enabled: true, ...options,
  })
  return { watch, reads, killed, names, groups, set: (rows) => { table = rows }, advance: (ms) => { clock += ms } }
}
const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }

test('a CLI that ended by itself: its surviving children and theirs are stopped, a stranger and a late process are not', async () => {
  const { watch, set, advance, killed, names } = harness()
  const child = fakeChild(100)
  const heard = []
  watch.track(child, { startedAt: T, scope: { label: 'agent', onStopped: (list) => heard.push(...list) } })
  advance(5000); child.exit()
  set([
    row(200, 100, T + 50, 'node.exe'), // an orphan of the dead CLI, created while it lived
    row(201, 200, T + 60, 'msedge.exe'), // its child
    row(300, 1, T + 55, 'explorer.exe'), // somebody else's
    row(202, 100, T + 9000, 'late.exe'), // created after the CLI's exit: not its child
    row(203, 100, T - 5000, 'early.exe'), // created before the CLI: its pid was another process's then
  ])
  const stopped = await watch.end(child)
  assert.deepEqual(killed.sort(), [200, 201], 'each member on its own: taskkill /t would follow parent pids with no creation time')
  assert.deepEqual(names.sort(), ['msedge.exe', 'node.exe'], 'taskkill is told the image too, so a recycled pid is not stopped by mistake')
  assert.deepEqual(stopped.map(item => item.name).sort(), ['msedge.exe', 'node.exe'])
  assert.deepEqual(heard, stopped, 'the scope hears what was stopped')
  assert.equal(watch.tracked, 0)
})

test('a process the CLI started that a snapshot saw below a parent that has exited since is still its own', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  // While the CLI runs: claude -> bash -> node.
  set([row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 1000, 'bash.exe'), row(120, 110, T + 2000, 'node.exe')])
  await watch.snapshot()
  // bash finished its command and exited; the runner it started goes on, and starts a browser.
  advance(20_000)
  set([row(100, 1, T + 10, 'claude.exe'), row(120, 110, T + 2000, 'node.exe'), row(121, 120, T + 21_000, 'msedge.exe')])
  await watch.snapshot()
  advance(1000); child.exit()
  set([row(120, 110, T + 2000, 'node.exe'), row(121, 120, T + 21_000, 'msedge.exe'), row(122, 120, T + 22_000, 'msedge.exe')])
  const stopped = await watch.end(child)
  assert.deepEqual(killed.sort(), [120, 121, 122])
  assert.equal(stopped.length, 3)
})

test('without a snapshot a runner whose parent exited before the CLI ended is not linked to it and is left alone', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  advance(20_000); child.exit()
  set([row(120, 110, T + 2000, 'node.exe'), row(121, 120, T + 3000, 'msedge.exe')])
  assert.deepEqual(await watch.end(child), [])
  assert.deepEqual(killed, [])
})

test('a recorded parent that has exited is no parent any more: what appears below its pid later may be a stranger\'s', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  set([row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 1000, 'bash.exe')])
  await watch.snapshot()
  advance(120_000); child.exit()
  // bash is gone and its pid went to a launcher that started a process and exited: that process is not the CLI's.
  set([row(130, 110, T + 90_000, 'launcher-child.exe'), row(131, 110, T + 90_500, 'discord.exe')])
  assert.deepEqual(await watch.end(child), [])
  assert.deepEqual(killed, [])
})

test('a stop: nothing is read until the kill is done, the cleanup shows in idle, and what the kill could not reach is stopped', async () => {
  const { watch, set, advance, killed, reads } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  let killDone
  const kill = new Promise(resolve => { killDone = resolve })
  const ended = watch.end(child, { settleMs: 0, after: kill })
  let idle = false
  void watch.idle().then(() => { idle = true })
  await flush()
  assert.equal(reads.length, 0, 'the table is read once the CLI is gone')
  assert.equal(idle, false, 'a shutdown waits for a stop under way')
  // taskkill /t ended the CLI; the node it started survived (access denied, say), and so did a browser below it.
  advance(2000); child.exit()
  set([row(130, 100, T + 1000, 'node.exe'), row(131, 130, T + 1500, 'msedge.exe')])
  killDone()
  assert.deepEqual((await ended).map(item => item.pid).sort(), [130, 131])
  assert.deepEqual(killed.sort(), [130, 131])
  assert.equal(reads.length, 1)
  await watch.idle()
  assert.equal(idle, true)
})

test('a CLI still running when it is ended is stopped with what it started', async () => {
  const { watch, set, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  set([row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 1000, 'bash.exe')])
  const stopped = await watch.end(child)
  assert.deepEqual(killed.sort(), [100, 110])
  assert.deepEqual(stopped.map(item => item.name).sort(), ['bash.exe', 'claude.exe'])
})

test('a recycled pid links nothing: the children of the stranger that took the CLI\'s pid are not stopped', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  advance(5000); child.exit()
  set([
    row(100, 1, T + 6000, 'other.exe'), // took the pid after the CLI ended
    row(150, 100, T + 7000, 'child-of-other.exe'),
    row(160, 100, T + 3000, 'orphan.exe'), // a real orphan of the CLI
  ])
  await watch.end(child)
  assert.deepEqual(killed, [160])
})

test('a CLI that failed within a moment is not mistaken for the stranger that took its pid (nor are its children)', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  advance(300); child.exit()
  // git took the pid 500 ms after the start: inside the window in which a CLI's creation time is accepted.
  advance(200)
  set([row(100, 1, T + 800, 'git.exe'), row(101, 100, T + 900, 'conhost.exe'), row(102, 100, T + 150, 'orphan.exe')])
  const stopped = await watch.end(child)
  assert.deepEqual(killed, [102], 'only what the CLI itself started while it lived')
  assert.deepEqual(stopped.map(item => item.pid), [102])
})

test('a reading that began before the CLI was started says nothing about it', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  // The pid was held by a process created just before the spawn; the reading is older than the spawn.
  set([row(100, 1, T + 450, 'old.exe')])
  watch.track(child, { startedAt: T + 500 })
  await watch.snapshot()
  advance(1000)
  // The CLI that really got the pid is still running when it is ended.
  set([row(100, 1, T + 520, 'claude.exe'), row(110, 100, T + 900, 'bash.exe')])
  await watch.end(child)
  assert.deepEqual(killed.sort(), [100, 110])
})

test('a CLI that a table showed before is still the CLI when a later reading shows it after its exit was heard', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  set([row(100, 1, T + 10, 'claude.exe')])
  await watch.snapshot()
  advance(2000); child.exit()
  set([row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 1000, 'node.exe')])
  await watch.end(child)
  assert.deepEqual(killed.sort(), [100, 110], 'its children are its own, whatever the order of the exit event and the reading')
})

test('a known parent whose pid another process took does not adopt the new process\'s children, and a row without a creation time links nothing', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  set([row(100, 1, T + 10), row(110, 100, T + 1000, 'bash.exe')])
  await watch.snapshot()
  advance(10_000); child.exit()
  set([row(110, 1, T + 9000, 'stranger.exe'), row(111, 110, T + 9500, 'stranger-child.exe'), row(112, 100, null, 'unknown-time.exe')])
  await watch.end(child)
  assert.deepEqual(killed, [])
  const unknownHolder = harness()
  const other = fakeChild(300)
  unknownHolder.watch.track(other, { startedAt: T })
  unknownHolder.advance(1000); other.exit()
  unknownHolder.set([row(300, 1, null, 'who.exe'), row(301, 300, T + 100, 'child.exe')])
  await unknownHolder.watch.end(other)
  assert.deepEqual(unknownHolder.killed, [], 'something runs under the pid at an unknown time: its children cannot be told apart')
})

test('never main, the runtime, a child of either, the pids 0 and 4, another followed CLI or what is recorded below it', async () => {
  const { watch, set, advance, killed } = harness()
  const mine = fakeChild(100), theirs = fakeChild(500)
  watch.track(mine, { startedAt: T })
  watch.track(theirs, { startedAt: T })
  set([row(500, 1, T + 5, 'claude.exe'), row(510, 500, T + 100, 'node.exe')])
  await watch.snapshot()
  advance(5000); mine.exit()
  set([
    row(process.pid, 100, T + 10, 'runtime.exe'), row(process.ppid, 100, T + 11, 'main.exe'), row(4, 100, T + 12, 'System'), row(0, 100, T + 13, 'Idle'),
    row(500, 100, T + 14, 'claude.exe'), row(510, 500, T + 100, 'node.exe'), // another agent's CLI, and below it
    row(700, 100, T + 15, 'node.exe'),
  ])
  const stopped = await watch.end(mine)
  assert.deepEqual(killed, [700])
  assert.deepEqual(stopped.map(item => item.pid), [700])
  // Whatever hangs below the runtime or main is never a leftover, wherever the table puts it.
  const below = harness()
  const odd = fakeChild(process.pid)
  below.watch.track(odd, { startedAt: T })
  below.advance(100); odd.exit()
  below.set([row(800, process.pid, T + 10, 'git.exe'), row(801, process.ppid, T + 11, 'electron.exe')])
  assert.deepEqual(await below.watch.end(odd), [])
  assert.deepEqual(below.killed, [])
})

test('the relaunch watcher of a self-upgrade an agent ran, and the Orbit it starts, are never stopped even when a snapshot caught their launcher', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  const watcher = '"C:/Program Files/nodejs/node.exe" "C:/orbit/scripts/self-upgrade.cjs" --watch "C:/orbit/artifacts/plan.json"'
  const foreground = '"C:/Program Files/nodejs/node.exe" "C:/orbit/scripts/self-upgrade.cjs" --dry-run'
  // The snapshot happened to see the cmd.exe of `start /b` while it still ran: the watcher is below it.
  set([row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 1000, 'cmd.exe'), { ...row(111, 110, T + 1010, 'node.exe'), command: watcher }, row(112, 111, T + 1100, 'electron.exe')])
  await watch.snapshot()
  advance(5000); child.exit()
  set([{ ...row(111, 110, T + 1010, 'node.exe'), command: watcher }, row(112, 111, T + 1100, 'electron.exe'), row(113, 112, T + 1200, 'electron.exe'), row(120, 100, T + 2000, 'node.exe'), { ...row(121, 100, T + 2100, 'node.exe'), command: foreground }])
  const stopped = await watch.end(child)
  assert.deepEqual(killed.sort(), [120, 121], 'a self-upgrade script in the foreground is an ordinary runner')
  assert.deepEqual(stopped.map(item => item.pid).sort(), [120, 121])
})

test('a table that cannot be read stops nothing; one read that fails is asked for again; a kill that fails or a scope that throws changes nothing', async () => {
  const unreadable = harness()
  const a = fakeChild(100)
  unreadable.watch.track(a, { startedAt: T })
  unreadable.advance(10); a.exit()
  unreadable.set(null)
  assert.deepEqual(await unreadable.watch.end(a), [])
  assert.deepEqual(unreadable.killed, [])
  assert.equal(unreadable.reads.length, 2, 'asked again once')
  let calls = 0
  const flaky = harness({ read: async () => ++calls === 1 ? null : [row(200, 100, T + 5, 'node.exe')] })
  const c = fakeChild(100)
  flaky.watch.track(c, { startedAt: T })
  flaky.advance(10); c.exit()
  assert.deepEqual((await flaky.watch.end(c)).map(item => item.pid), [200])
  const failing = harness({ kill: async () => { throw new Error('access denied') } })
  const b = fakeChild(100)
  failing.watch.track(b, { startedAt: T, scope: { onStopped: () => { throw new Error('trace failed') } } })
  failing.advance(10); b.exit()
  failing.set([row(200, 100, T + 5, 'node.exe')])
  assert.deepEqual((await failing.watch.end(b)).map(item => item.pid), [200])
})

test('ends of several agents at once share the table reads', async () => {
  const { watch, set, advance, reads } = harness()
  const children = [100, 110, 120, 130].map(fakeChild)
  for (const child of children) watch.track(child, { startedAt: T })
  advance(1000)
  for (const child of children) child.exit()
  set([row(900, 1, T + 5, 'other.exe')])
  await Promise.all(children.map(child => watch.end(child)))
  assert.ok(reads.length <= 2, `${reads.length} reads for four ends`)
})

test('end is idempotent, a child that was never followed has nothing to end, and the switches turn it all off', async () => {
  const { watch, set, advance, killed, reads } = harness()
  const child = fakeChild(100)
  assert.equal(watch.track(child, { startedAt: T }), true)
  assert.equal(watch.track(child, { startedAt: T }), false, 'followed once')
  advance(10); child.exit()
  set([row(200, 100, T + 5, 'node.exe')])
  const first = watch.end(child)
  assert.equal(watch.end(child), first)
  await first
  assert.deepEqual(killed, [200])
  assert.deepEqual(await watch.end(fakeChild(999)), [])
  assert.equal(watch.track({ pid: undefined, once() {} }), false, 'a process that did not start')
  assert.equal(reads.length, 1)
  const off = harness({ enabled: false })
  assert.equal(off.watch.track(fakeChild(1), { startedAt: T }), false)
})

test('a CLI that exited and was never ended is ended by a later snapshot', async () => {
  const { watch, set, advance, killed } = harness()
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  advance(100); child.exit()
  set([row(200, 100, T + 50, 'node.exe')])
  advance(70_000)
  await watch.snapshot()
  await watch.idle()
  assert.deepEqual(killed, [200])
  assert.equal(watch.tracked, 0)
})

test('the snapshot timer runs while a turn runs and not for a session that only lives between turns', async () => {
  const active = harness({ snapshotMs: 15 })
  const turn = fakeChild(100)
  active.watch.track(turn, { startedAt: T })
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(active.reads.length >= 2, `${active.reads.length} snapshots while a turn runs`)
  turn.exit()
  await active.watch.end(turn)
  const readsAfter = active.reads.length
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(active.reads.length, readsAfter, 'no timer once nothing is followed')
  const passive = harness({ snapshotMs: 15 })
  passive.watch.track(fakeChild(200), { startedAt: T, passive: true })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(passive.reads.length, 0, 'an idle session does not cost a table read')
  passive.watch.dispose()
})

test('a session that lives between turns is followed by the snapshot timer only while a turn of it runs', async () => {
  const { watch, reads } = harness({ snapshotMs: 15 })
  const session = fakeChild(300)
  watch.track(session, { startedAt: T, passive: true })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(reads.length, 0)
  watch.busy(session, true)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(reads.length >= 2, `${reads.length} snapshots during a turn`)
  watch.busy(session, false)
  await new Promise(resolve => setTimeout(resolve, 40))
  const after = reads.length
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(reads.length, after, 'idle again: no more reads')
  watch.dispose()
})

test('off Windows the CLI\'s process group is killed and the table is not read', async () => {
  const { watch, reads, groups, killed } = harness({ platform: 'linux' })
  const child = fakeChild(100)
  watch.track(child, { startedAt: T })
  child.exit()
  await watch.end(child)
  await watch.snapshot()
  assert.deepEqual(groups, [100])
  assert.deepEqual([reads.length, killed.length], [0, 0])
})

test('membersOf: parent links count only within the parent\'s life, and learn what it finds', () => {
  const lease = { child: fakeChild(100), pid: 100, startedAt: T, scope: null, passive: false, created: null, exitHeard: false, exitedAt: null, known: new Map(), ending: null }
  const { root, alive } = membersOf(lease, [
    row(100, 1, T + 10, 'claude.exe'), row(110, 100, T + 100, 'bash.exe'), row(111, 110, T + 200, 'node.exe'),
    row(112, 110, T + 50, 'older-than-its-parent.exe'), // its pid was another process's when this one was created
    row(9, 1, T + 100, 'stranger.exe'),
  ])
  assert.equal(root.pid, 100)
  assert.equal(lease.created, T + 10, 'the CLI\'s own creation time is kept once the table showed it')
  assert.deepEqual(alive.map(item => item.pid).sort(), [110, 111])
  assert.deepEqual([...lease.known.keys()].sort(), [110, 111])
})

test('the table the reader parses carries the image name and command line, and rows without them parse as before', () => {
  assert.deepEqual(parseProcessTable(JSON.stringify([{ p: 10, pp: 1, c: 5, n: 'node.exe', l: 'node x.js' }, { p: 11, pp: 10, c: null, n: '', l: '' }, { p: 12, pp: 10, c: 7 }])),
    [{ pid: 10, ppid: 1, created: 5, name: 'node.exe', command: 'node x.js' }, { pid: 11, ppid: 10, created: null }, { pid: 12, ppid: 10, created: 7 }])
})

test('describeStopped counts the images', () => {
  assert.equal(describeStopped([{ pid: 1, name: 'msedge.exe' }, { pid: 2, name: 'msedge.exe' }, { pid: 3, name: 'node.exe' }]), 'Orbit stopped 3 processes this turn\'s CLI left running: msedge.exe ×2, node.exe')
  assert.equal(describeStopped([{ pid: 1, name: '' }]), 'Orbit stopped 1 process this turn\'s CLI left running: a process')
})

// ---- Real processes (Windows): runCli with a scope, the real process table and the real taskkill -----------------------

const { execFileSync } = require('node:child_process')
const { processWatch } = require('../electron/process-reaper.mts')
const { runCli } = require('../electron/providers.mts')
const windows = process.platform === 'win32' ? false : 'the process table is read on Windows only'
const running = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (check, what, ms = 30_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error(`timed out waiting for ${what}`) }
const killAll = (pids) => { for (const pid of pids) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }) } catch { /* Already gone. */ } } }

test('Windows: a runner the CLI left running when it ended by itself is stopped, and the agent is told', { skip: windows, timeout: 90_000 }, async (t) => {
  const pids = []
  t.after(() => killAll(pids))
  const heard = []
  // The CLI starts a runner on its own (a stand-in for a test runner), which starts a long ping (a browser), and the CLI ends.
  // Each is stopped by itself, with no `taskkill /t`: the ping is found below the runner by pid and creation time.
  const runner = "const { spawn } = require('node:child_process'); const p = spawn('ping', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }); console.log(JSON.stringify({ runner: process.pid, ping: p.pid })); setInterval(() => {}, 1000)"
  const script = `const { spawn } = require('node:child_process'); const r = spawn(process.execPath, ['-e', ${JSON.stringify(runner)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }); r.unref(); setTimeout(() => process.exit(0), 1500)`
  await runCli(process.execPath, ['-e', script], { scope: { label: 'agent', onStopped: (list) => heard.push(...list) }, onLine: (line) => { const message = JSON.parse(line); if (message.ping) pids.push(message.runner, message.ping) } })
  assert.equal(pids.length, 2)
  assert.ok(pids.every(running), 'the runner and its browser outlive their CLI')
  await processWatch.idle()
  await until(() => !pids.some(running), 'the runner and its child to be stopped')
  assert.ok(pids.every(pid => heard.some(item => item.pid === pid)), JSON.stringify(heard))
})

test('Windows: a CLI that is stopped leaves nothing behind, a runner whose launcher had exited included', { skip: windows, timeout: 120_000 }, async (t) => {
  const pids = []
  t.after(() => killAll(pids))
  const heard = []
  // CLI -> middle -> ping: the middle one starts the ping, lingers a few seconds and exits, which leaves the ping with no
  // parent in any tree, so `taskkill /t` on the CLI cannot reach it. The CLI itself goes on.
  const middle = "const { spawn } = require('node:child_process'); const p = spawn('ping', ['-n', '120', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true }); p.unref(); console.log(JSON.stringify({ middle: process.pid, ping: p.pid })); setTimeout(() => {}, 5000)"
  const cli = `const { spawn } = require('node:child_process'); const m = spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`
  const controller = new AbortController()
  let report = null
  const turn = runCli(process.execPath, ['-e', cli], { scope: { onStopped: (list) => heard.push(...list) }, signal: controller.signal, onLine: (line) => { const message = JSON.parse(line); if (message.ping) { report = message; pids.push(message.ping, message.middle) } } })
  turn.catch(() => {})
  await until(() => report, 'the runner to start')
  assert.ok(running(report.ping))
  // A snapshot while the middle process runs: the runner is seen below it.
  await processWatch.snapshot()
  await until(() => !running(report.middle), 'the launcher to exit')
  assert.ok(running(report.ping), 'the runner outlives its launcher')
  controller.abort()
  await assert.rejects(turn, /cancelled/)
  await until(() => !running(report.ping), 'the runner to be stopped')
  assert.ok(heard.some(item => item.pid === report.ping), JSON.stringify(heard))
})

// ---- The turn: the provider is handed a scope, and what it reports is the agent's trace ------------------------------------

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')

test('a provider turn carries a process scope; what the provider layer stopped becomes a trace of the agent, and a report after the run is ignored', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-process-scope-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  let scope = null
  const runtime = new OrbitRuntime({ runProvider: async (options) => {
    scope = options.processScope
    scope.onStopped([{ pid: 11, name: 'msedge.exe' }, { pid: 12, name: 'msedge.exe' }, { pid: 13, name: 'node.exe' }])
    return { text: 'done' }
  } })
  const finished = new Promise(resolve => { runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve() }) })
  const id = await runtime.start({ providerId: 'test', prompt: 'Do the task', accessMode: 'workspace-write', workspace })
  const timer = setTimeout(() => runtime.stop(id), 5000)
  await finished; clearTimeout(timer)
  const run = runtime.getRun(id)
  assert.equal(run.status, 'completed', run.error || 'run did not complete')
  assert.equal(scope.label, 'Orbit', 'the scope names the agent')
  const stopped = run.traces.filter(trace => trace.kind === 'processes')
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].text, 'Orbit stopped 3 processes this turn\'s CLI left running: msedge.exe ×2, node.exe')
  scope.onStopped([{ pid: 14, name: 'node.exe' }])
  assert.equal(runtime.getRun(id).traces.filter(trace => trace.kind === 'processes').length, 1, 'the finished run takes no more traces')
})
