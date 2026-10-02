// What an agent's provider CLI leaves running when its turn ends.
//
// A CLI starts shells, test runners, browsers and MCP servers of its own. `taskkill /t` ends the tree below a live
// process, but on Windows a process whose parent has exited is no longer in any tree: a background runner started by a
// shell that finished, the browsers it opened, an MCP server whose launcher exited all outlive the CLI, the turn that
// stopped it and the agent (measured 2026-10-02: 6 headless msedge and their node runners ran for 40 minutes after the
// helper that started them was stopped). Windows keeps the parent pid of an orphan, so the process table still links it.
//
// Every CLI an agent's turn starts is tracked (`track`). While some turn runs, a coalesced snapshot of the process table
// every 25 s records the descendants of each tracked CLI (pid and creation time). Once the CLI has ended, by itself or
// stopped, the table is read again: whatever of the recorded set still runs with the same creation time, the children
// the CLI created while it lived, and the children of everything found, are stopped. Elsewhere the CLI leads a process
// group, which is killed.
//
// Safety: a process is chosen only through the CLI's own descendants, by pid AND creation time (a recycled pid has
// another creation time), each one is stopped on its own, never with `taskkill /t` (that walks parent pids without any
// creation time, so a stale parent pid of a stranger could take it along), and `taskkill` is asked to check the image
// name too; never main, the runtime, a child of either, the pids 0 and 4, another tracked CLI or what is recorded below
// it. A recorded process is a parent only while
// it runs: the pid of one that exited may belong to a stranger by the next reading, so what it started after the last
// snapshot is not linked to the CLI any more and is left alone, and so is what a short-lived launcher started and left
// between two snapshots (a job object per CLI, which needs native code, would close that gap). The cost is one table read (0.4-0.75 s of PowerShell) per snapshot and per ended CLI, shared by
// every agent that needs one at the same time.
import { execFile } from 'node:child_process'
import { listProcessTable } from './process-table.mts'
import type { ProcessRow } from './process-table.mts'

// How often the descendants of the running CLIs are recorded: slow on purpose, a read is not free.
const SNAPSHOT_EVERY_MS = 25_000
// A CLI that ended by itself waits this long before the table is read, so that the ends of several agents share one read
// and the CLI's own shutdown has finished.
const SETTLE_MS = 400
// One table read is given this long (the PowerShell process is killed after it); a turn waits a little longer for it, and
// asks once more when it failed. Without a table nothing is stopped.
const READ_TIMEOUT_MS = 8000
const READ_WAIT_MS = 10_000
// A CLI that exited and that nobody ended (a path that never reached its end) is ended by a snapshot after this long.
const STALE_END_MS = 60_000
// The OS dates a process by its tick-updated clock and the spawn itself takes a few ms: the creation time of the CLI is
// accepted from before `startedAt` (taken right before the spawn) to after it, as main does for the runtime's children
// (runtime-client.cjs); children of an exited CLI only until a moment after the exit event.
const START_SLACK = Object.freeze({ beforeMs: 30, afterMs: 2000 })
const EXIT_SLACK_MS = 30
// A turn that starts more descendants than this is not followed further.
const MAX_KNOWN = 5000
// A process that lives on purpose: the detached relaunch watcher of scripts/self-upgrade.cjs (an agent's `npm run
// self-upgrade` starts it through `start /b` so that nothing the agent's tree is stopped with can reach it) and the Orbit
// it starts. Never stopped, nor anything below it, even when a snapshot saw it below a parent that was still alive.
const LIVES_ON = /self-upgrade\.cjs"?\s+--watch\b/i

// What was stopped, for the agent's trace.
interface StoppedProcess { pid: number; name: string }
// The agent a CLI belongs to, as the provider layer is told: `onStopped` hears what was stopped after the CLI ended.
interface ProcessScope { label?: string; onStopped?: (stopped: StoppedProcess[]) => void }
// The part of a ChildProcess the watch needs.
interface WatchedChild { pid?: number | undefined; once(event: 'exit', listener: () => void): unknown }
interface Reading { at: number; rows: ProcessRow[] | null }

// One tracked CLI.
interface Lease {
  child: WatchedChild
  pid: number
  // The time taken right before the spawn.
  startedAt: number
  scope: ProcessScope | null
  passive: boolean
  // The CLI's creation time as the OS reports it, once a table has shown it.
  created: number | null
  // Node has reported the CLI's exit: until then its process object is open here and its pid cannot belong to anybody else.
  exitHeard: boolean
  exitedAt: number | null
  // Descendants seen so far: pid → creation time.
  known: Map<number, number>
  ending: Promise<StoppedProcess[]> | null
}
// A parent whose children count: those created from `from` (its creation) until `until`.
interface Parent { pid: number; from: number; until: number }

// The processes of `table` that belong to the lease: its CLI (when the table shows it still running) and everything
// found below it, learned into `lease.known` on the way. Pure apart from that. A child counts when its parent is the
// CLI or a recorded descendant that still runs under that pid with that creation time, and it was created after its
// parent. The CLI itself may be gone: its children count when they were created while it lived (and before any other
// process took its pid). A recorded descendant that is gone is no parent any more: its pid may be a stranger's.
function membersOf(lease: Lease, table: readonly ProcessRow[]): { root: ProcessRow | null; alive: ProcessRow[] } {
  const byPid = new Map<number, ProcessRow>()
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of table) {
    byPid.set(row.pid, row)
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row); else byParent.set(row.ppid, [row])
  }
  const holder = byPid.get(lease.pid)
  // The CLI is the process under its pid with the creation time a table showed before. While no table did, it is the holder
  // created around the spawn, and only while Node has not heard of the CLI's exit (its pid is its own until then; afterwards
  // whoever holds it is a stranger).
  const isRoot = !!holder && holder.created !== null
    && (lease.created !== null ? holder.created === lease.created : !lease.exitHeard && holder.created >= lease.startedAt - START_SLACK.beforeMs && holder.created <= lease.startedAt + START_SLACK.afterMs)
  if (isRoot && lease.created === null) lease.created = holder.created
  const ended = lease.exitedAt === null ? Infinity : lease.exitedAt + EXIT_SLACK_MS
  // Something runs under this pid, created at an unknown time: neither it nor its children can be told apart.
  const until = isRoot ? Infinity : holder ? (holder.created === null ? -Infinity : Math.min(ended, holder.created)) : ended
  const parents: Parent[] = [{ pid: lease.pid, from: lease.created ?? lease.startedAt - START_SLACK.beforeMs, until }]
  const seen = new Set<string>()
  for (const [pid, created] of lease.known) {
    const row = byPid.get(pid)
    if (!row || row.created !== created) continue
    parents.push({ pid, from: created, until: Infinity })
    seen.add(`${pid}:${created}`)
  }
  for (let index = 0; index < parents.length; index++) {
    const parent = parents[index]
    for (const row of byParent.get(parent.pid) ?? []) {
      if (row.pid === parent.pid || row.created === null || row.created < parent.from || row.created >= parent.until) continue
      if (row.command && LIVES_ON.test(row.command)) continue
      const key = `${row.pid}:${row.created}`
      if (seen.has(key)) continue
      seen.add(key)
      if (lease.known.size < MAX_KNOWN) lease.known.set(row.pid, row.created)
      parents.push({ pid: row.pid, from: row.created, until: Infinity })
    }
  }
  const alive: ProcessRow[] = []
  for (const [pid, created] of lease.known) { const row = byPid.get(pid); if (row && row.created === created) alive.push(row) }
  return { root: isRoot && holder ? holder : null, alive }
}

// A line for the agent's trace: "Orbit stopped 9 processes this turn's CLI left running: msedge.exe ×6, node.exe ×3".
function describeStopped(stopped: readonly StoppedProcess[]): string {
  const counts = new Map<string, number>()
  for (const { name } of stopped) counts.set(name || 'a process', (counts.get(name || 'a process') ?? 0) + 1)
  const list = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ')
  return `Orbit stopped ${stopped.length} process${stopped.length === 1 ? '' : 'es'} this turn's CLI left running: ${list}`
}

// This one process, not its tree (`/t` follows parent pids without any creation time): taskkill itself checks the image name
// too, so a pid that was recycled between the reading and the kill is only stopped when the stranger runs the same image.
function taskkillProcess(pid: number, name?: string): Promise<void> {
  const filters = name ? ['/fi', `PID eq ${pid}`, '/fi', `IMAGENAME eq ${name}`] : ['/pid', String(pid)]
  return new Promise(resolve => { execFile('taskkill.exe', [...filters, '/f'], { windowsHide: true, timeout: 10_000 }, () => resolve()) })
}
function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL') } catch { /* No such group: nothing was left. */ }
}
// Waits for `work` at most `ms`; never rejects. The timers are short and cleared: they may keep a process alive for that long.
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) })
  try { return await Promise.race([work.catch(() => undefined), late]) } finally { clearTimeout(timer) }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// A process-table reader that never runs two reads at once and hands a read to everyone who needs one that began at or
// after `since`: a reading that began earlier may show a process that has ended or has yet to start.
function createReader(read: () => Promise<ProcessRow[] | null>, now: () => number, onReading: (reading: Reading) => void): (since: number) => Promise<Reading> {
  let last: Reading | null = null
  let running: { at: number; promise: Promise<Reading> } | null = null
  let queued: Promise<Reading> | null = null
  const start = (): Promise<Reading> => {
    const at = now()
    const promise = Promise.resolve().then(read).catch(() => null).then((rows): Reading => ({ at, rows }))
    const entry = { at, promise }
    running = entry
    // Registered first, so it runs before anyone who awaits the read.
    void promise.then(reading => { if (running === entry) running = null; if (reading.rows) last = reading; onReading(reading) })
    return promise
  }
  return (since) => {
    if (last && last.at >= since) return Promise.resolve(last)
    if (running && running.at >= since) return running.promise
    if (queued) return queued
    if (!running) return start()
    // The read in flight began too early for this caller: the next one, which starts when it ends, will do for everyone waiting.
    queued = running.promise.then(() => { queued = null; return start() })
    return queued
  }
}

interface WatchOptions {
  // The process table (default: process-table.mts); a fake one in tests.
  read?: () => Promise<ProcessRow[] | null>
  // Ends one process, given its image name (default: taskkill /f) and, off Windows, the CLI's process group.
  kill?: (pid: number, name?: string) => Promise<void>
  killGroup?: (pid: number) => void
  now?: () => number
  platform?: NodeJS.Platform
  // 0: no periodic snapshot (a test takes one with `snapshot()`).
  snapshotMs?: number
  settleMs?: number
  // Default: on, off with ORBIT_REAP_PROCESSES=0.
  enabled?: boolean
}
interface ProcessWatch {
  // Starts following a CLI the turn of an agent has just started; `startedAt` is the time taken right before the spawn.
  // `passive`: the process lives between turns (a Codex App Server session), so it does not keep the snapshot timer running.
  track(child: WatchedChild, options?: { startedAt?: number; scope?: ProcessScope | null; passive?: boolean }): boolean
  // The CLI has ended, by itself or stopped: ends what it left running. Idempotent, never rejects. `settleMs` 0 does not
  // wait for company; `after` is the stop under way: the table is read once it has finished.
  end(child: WatchedChild, options?: { settleMs?: number; after?: Promise<unknown> }): Promise<StoppedProcess[]>
  // A passive CLI (see track) is busy while one of its turns runs: it then keeps the snapshot timer running.
  busy(child: WatchedChild, on: boolean): void
  // One snapshot now: records the descendants of every followed CLI.
  snapshot(): Promise<void>
  // Settles when no `end` is under way (a shutdown waits for it).
  idle(): Promise<void>
  // The CLIs followed now.
  readonly tracked: number
  // Stops the snapshot timer.
  dispose(): void
}

function createProcessWatch(options: WatchOptions = {}): ProcessWatch {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const enabled = options.enabled ?? process.env.ORBIT_REAP_PROCESSES !== '0'
  const configured = Number(process.env.ORBIT_REAP_SNAPSHOT_MS)
  const snapshotMs = options.snapshotMs ?? (Number.isFinite(configured) && configured >= 0 && process.env.ORBIT_REAP_SNAPSHOT_MS ? configured : SNAPSHOT_EVERY_MS)
  const kill = options.kill ?? taskkillProcess
  const group = options.killGroup ?? killGroup
  const windows = platform === 'win32'
  const leases = new WeakMap<object, Lease>()
  const active = new Set<Lease>()
  const ending = new Set<Promise<unknown>>()
  let timer: ReturnType<typeof setInterval> | null = null

  // Every reading teaches the CLIs still followed their descendants, whoever asked for it (one that began before the CLI
  // was started says nothing about it).
  const read = createReader(options.read ?? (() => listProcessTable(READ_TIMEOUT_MS)), now, ({ at, rows }) => {
    if (rows) for (const lease of active) if (!lease.ending && at >= lease.startedAt) { try { membersOf(lease, rows) } catch { /* A snapshot never breaks the runtime. */ } }
  })
  const rowsSince = async (since: number): Promise<ProcessRow[] | null> => (await within(read(since), READ_WAIT_MS))?.rows ?? null
  const disarm = (): void => { if (timer) { clearInterval(timer); timer = null } }
  const snapshot = async (): Promise<void> => {
    // A CLI that ended and was never ended by its caller: do it now.
    for (const lease of [...active]) if (!lease.ending && lease.exitedAt !== null && now() - lease.exitedAt > STALE_END_MS) void end(lease.child)
    if (![...active].some(lease => !lease.passive)) return disarm()
    if (windows) await rowsSince(now())
  }
  const arm = (): void => {
    if (timer || !windows || !snapshotMs) return
    timer = setInterval(() => { void snapshot() }, snapshotMs)
    timer.unref?.()
  }
  // The members of the lease that the table shows, without what must never be stopped: this process and main, anything
  // that is a child of either (the runtime's own CLIs, git, readers and commands; main's windows), the idle process and
  // the System process, and every other followed CLI with what was recorded below it. The lease's own CLI is the one
  // child of the runtime that may be stopped.
  const membersToStop = (lease: Lease, rows: readonly ProcessRow[]): ProcessRow[] => {
    const { root, alive } = membersOf(lease, rows)
    const never = new Set<number>([0, 4, process.pid, process.ppid])
    for (const other of active) if (other !== lease) { never.add(other.pid); for (const pid of other.known.keys()) never.add(pid) }
    return [...(root ? [root] : []), ...alive].filter(row => !never.has(row.pid) && (row === root || (row.ppid !== process.pid && row.ppid !== process.ppid)))
  }
  const finish = async (lease: Lease, settleMs: number, after: Promise<unknown> | undefined): Promise<StoppedProcess[]> => {
    try {
      if (after) await after.catch(() => undefined)
      lease.exitedAt ??= now()
      let stopped: StoppedProcess[] = []
      if (!windows) group(lease.pid)
      else {
        if (settleMs > 0) await sleep(settleMs)
        // A table read that began after the CLI exited: it shows what the CLI left (asked once more when it failed).
        const rows = await rowsSince(lease.exitedAt) ?? await rowsSince(now())
        if (rows) {
          const members = membersToStop(lease, rows)
          await Promise.all(members.map(row => kill(row.pid, row.name).catch(() => undefined)))
          stopped = members.map(row => ({ pid: row.pid, name: row.name ?? '' }))
        }
      }
      if (stopped.length) { try { lease.scope?.onStopped?.(stopped) } catch { /* The agent's trace never breaks the cleanup. */ } }
      return stopped
    } catch { return [] } finally {
      active.delete(lease)
      if (!active.size) disarm()
    }
  }
  const end: ProcessWatch['end'] = (child, { settleMs = options.settleMs ?? SETTLE_MS, after } = {}) => {
    const lease = leases.get(child)
    if (!lease) return Promise.resolve([])
    if (!lease.ending) {
      const work = lease.ending = finish(lease, settleMs, after)
      ending.add(work)
      void work.then(() => { ending.delete(work) })
    }
    return lease.ending
  }
  return {
    track(child, { startedAt = now(), scope = null, passive = false } = {}) {
      if (!enabled || !child.pid || leases.has(child)) return false
      const lease: Lease = { child, pid: child.pid, startedAt, scope, passive, created: null, exitHeard: false, exitedAt: null, known: new Map(), ending: null }
      leases.set(child, lease)
      active.add(lease)
      child.once('exit', () => { lease.exitHeard = true; lease.exitedAt ??= now() })
      if (!passive) arm()
      return true
    },
    end,
    busy(child, on) {
      const lease = leases.get(child)
      if (!lease || lease.ending) return
      lease.passive = !on
      if (on) arm()
    },
    snapshot,
    idle: () => Promise.allSettled([...ending]).then(() => undefined),
    get tracked() { return active.size },
    dispose: disarm,
  }
}

// The runtime's own watch: the provider layer tracks the CLIs of agents' turns in it.
const processWatch: ProcessWatch = createProcessWatch()

export type { ProcessScope, StoppedProcess, ProcessWatch, WatchOptions, WatchedChild, Lease }
export { createProcessWatch, processWatch, membersOf, describeStopped, SNAPSHOT_EVERY_MS }
