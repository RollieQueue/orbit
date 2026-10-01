// The runtime side of restarting Orbit with a continuation (docs/TECH-DEBT.md item 1). The self-upgrade script
// (scripts/self-upgrade.cjs) verifies and builds the new code, decides how much of Orbit to restart and, for a runtime
// or full restart, leaves an intent in userData/pending-resume.json that names the run to continue. This module:
//   - reads, validates and deletes that intent (the runtime never writes it: the script and its rollback watcher do);
//   - names the run in the environment of every command the root agent runs (restartEnv), so the script started from
//     its shell writes the same intent, and signals this Orbit's profile (ORBIT_USER_DATA);
//   - runs the script for the restart_orbit tool (createRestartHost); while it runs, the host names the run it serves
//     (inFlight). A stop kills the script's tree, leaves the cancel marker (artifacts/self-upgrade-cancel.json) that
//     the script's detached watcher obeys, and releases the lock (artifacts/self-upgrade.lock) of the killed script;
//   - finishes the requesting run with the status `restarting` when Orbit shuts down for the restart, recording the
//     intent's id on it (markRestartingRuns), and starts the continuation in the same chat after a healthy start
//     (resumePending) — only for the run that intent marked, and only once.
import fs from 'node:fs'
import path from 'node:path'
import { spawn as spawnProcess } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { fingerprints, rendererHash } from './fingerprint.cjs'
import { clip } from './text.mts'
import { MAX_RUN_FILES, trustedAttachments } from './attachments.mts'
import type { OrbitRuntimeLike, RestartMark, RunStoreLike, StoredRun } from './types.mts'

const RESUME_FILE = 'pending-resume.json'
// An intent that could not be deleted is renamed to this (nothing reads it), so that it is never acted on twice.
const TOMBSTONE_SUFFIX = '.consumed'
// A failed delete of the intent (a reader holds the file for a moment) is retried this often, with growing pauses.
const DELETE_ATTEMPTS = 4
const DELETE_PAUSE_MS = 25
const SCRIPT = path.join('scripts', 'self-upgrade.cjs')
const REPORT = path.join('artifacts', 'self-upgrade-last.json')
// The script's lock (JSON: the holder's `pid`, `startedAt`, `role`), and the marker a stop leaves for the script and its
// detached watcher: `{ requestedAt, reason }`, obeyed when newer than their plan's start.
const LOCK = path.join('artifacts', 'self-upgrade.lock')
const CANCEL_MARKER = path.join('artifacts', 'self-upgrade-cancel.json')
// An intent older than this is not acted on: the restart never completed, or the owner has moved on.
const INTENT_TTL_MS = 30 * 60 * 1000
// How long a healthy start waits for the watcher's verdict on the new code, how often it looks, and how young an intent
// must be to be continued without a verdict (a watcher that died, a script that predates verdicts).
const VERDICT_WAIT_MS = 30000
const VERDICT_POLL_MS = 200
const UNCONFIRMED_TTL_MS = 10 * 60 * 1000
// What a failed script leaves for the agent: its last lines, each bounded.
const OUTPUT_LINES = 80
const OUTPUT_CHARS = 12000
const LINE_CHARS = 2000
// How long a cancelled script may take to exit before the call ends anyway.
const CANCEL_GRACE_MS = 10000
const DEFAULT_CONTINUE = 'Продолжи задачу с того места, где остановился перед перезапуском Orbit.'
const UNAVAILABLE = 'restart_orbit is available only when Orbit runs from its repository'
// Terminal colours of the tools the script runs (tsc, node --test) are noise in a trace.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

type RestartSource = 'tool' | 'script'
// How much of Orbit a self-upgrade restarted: nothing, the window's renderer, the runtime process, or the whole app.
type RestartLevel = 'none' | 'renderer' | 'runtime' | 'full'
// The parts of Orbit's code a restart loads anew (electron/fingerprint.cjs): the main process, the runtime, the window.
type CodePart = 'shell' | 'runtime' | 'renderer'
// pending-resume.json as the script writes it (version 1), normalised: every field present, blanks as null. The
// script's detached watcher adds its verdict: `verdict: 'relaunched'` once the new code is healthy,
// `outcome: 'rolled-back'` before it starts the restored code, or `verdict: 'failed'` (with the error) when the watcher
// itself failed.
interface ResumeIntent {
  version: 1; id: string; createdAt: string; source: RestartSource
  reason: string; continueWith: string; verify: boolean
  runId: string; chatId: string | null; projectId: string | null; agentId: string | null
  level: 'runtime' | 'full' | null; state: string; commit: string | null
  // The self-upgrade candidate snapshot of electron/ and src/ (HEAD plus the uncommitted changes that now run), or null.
  snapshot: string | null
  outcome: 'rolled-back' | null; error: string | null; patch: string | null
  verdict: 'relaunched' | 'failed' | null; verdictAt: string | null
}
// What the renderer is told about a restart (event channel `restart:notice`).
interface RestartNotice {
  kind: 'resumed' | 'rolled-back' | 'loop-limit' | 'expired' | 'failed'
  chatId: string | null; projectId: string | null; runId: string | null; resumedRunId?: string
  text: string; reason?: string; level?: 'runtime' | 'full'; patch?: string; error?: string; time: string
}
// What main reports about the start that is healthy now (the protocol's `renderer-healthy` info).
interface ResumeInfo { level?: string | null; commit?: string | null }
// The run and agent a command belongs to (a RunRecord and an AgentRecord fit).
interface RestartRunRef { runId: string; chatId: string; projectId: string }
interface RestartRequest {
  run: RestartRunRef; agent: { id: string }
  reason: string; continueWith: string; verify: boolean
  // Every line the script prints, as it prints it.
  onLine?: (line: string) => void
  // Aborting stops the script (and the checks it runs): the restart is not wanted any more.
  signal?: AbortSignal | null
}
// What a rolled-back self-upgrade did to the sources (the script's report): the base they came back from ("running
// 1a2b3c4d5e6f"), or why they stayed as they are; the paths that came back; where the failed change is kept.
interface RestartRollback { base: string | null; reason: string | null; restored: string[]; patch: string | null; failedRef: string | null }
type RestartResult =
  | { ok: true; level: RestartLevel; status: string | null; output: string; exitCode: 0 }
  | { ok: false; status: string; output: string; exitCode: number | null; error: string | null; rollback?: RestartRollback }
interface RestartHost {
  // False when Orbit does not run from its repository (a packaged build): there is no script to run.
  readonly available: boolean
  readonly repoRoot: string
  // Where the script leaves the intent (userData/pending-resume.json).
  readonly resumeFile: string
  // This Orbit's profile folder: the script signals the instance of this profile (ORBIT_USER_DATA), not another one
  // started from the same repository.
  readonly userData: string
  // Resolves when the script exits. A runtime or full restart shuts this process down first, so it never resolves then.
  request(request: RestartRequest): Promise<RestartResult>
  // The run whose restart_orbit request the script serves right now (checks, build, restart), or null.
  inFlight(): RestartRunRef | null
  // The parts of the code on disk this Orbit does not run yet (unappliedCode), null when it cannot tell; a host without
  // it cannot tell.
  unapplied?(): CodePart[] | null
}
// The part of a child process the host uses; `spawn` is injectable so tests can script the process.
interface RestartChild {
  pid?: number
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}
type SpawnRestart = (command: string, args: string[], options: SpawnOptions) => RestartChild
interface RestartHostOptions {
  repoRoot: string; userData: string
  // Main's health report (healthFilePath by default), null when it writes none.
  healthFile?: string | null
  // The Node binary that runs the script; by default ORBIT_NODE, else Node itself, else `node` on PATH, else Electron as Node.
  nodeCommand?: string | null
  spawn?: SpawnRestart
  // Every line of every request, besides the request's own onLine (the service may log them).
  onLine?: (line: string) => void
  // Stops the script and everything it started; by default taskkill /t on Windows, the process group elsewhere.
  kill?: (child: RestartChild) => void
}
interface ResumeOptions {
  // `runs`, when given, are the live runs a continuation may already be among.
  runtime: Pick<OrbitRuntimeLike, 'start' | 'runStore'> & Partial<Pick<OrbitRuntimeLike, 'runs'>>
  // Where the interrupted run (and a continuation it already has) is looked up; the runtime's own store by default.
  runStore?: Pick<RunStoreLike, 'get' | 'forChat' | 'list'> | null
  userData: string
  notify?: (notice: RestartNotice) => void
  now?: () => number
  maxChain?: number
  info?: ResumeInfo | null
  // How long to wait for the watcher's verdict, and how often to look (tests shorten them).
  verdictWaitMs?: number
  pollMs?: number
}

function resumeFilePath(userData: string): string { return path.join(userData, RESUME_FILE) }
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

function normalizeIntent(value: unknown): ResumeIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const runId = text(raw.runId), createdAt = text(raw.createdAt)
  if (raw.version !== 1 || !runId || !/^[\w-]+$/.test(runId) || !createdAt || !Number.isFinite(Date.parse(createdAt))) return null
  return {
    version: 1, id: text(raw.id) ?? '', createdAt, source: raw.source === 'tool' ? 'tool' : 'script',
    reason: text(raw.reason) ?? '', continueWith: text(raw.continueWith) ?? DEFAULT_CONTINUE, verify: raw.verify !== false,
    runId, chatId: text(raw.chatId), projectId: text(raw.projectId), agentId: text(raw.agentId),
    level: raw.level === 'runtime' || raw.level === 'full' ? raw.level : null, state: text(raw.state) ?? '', commit: text(raw.commit),
    snapshot: typeof raw.snapshot === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.snapshot) ? raw.snapshot : null,
    outcome: raw.outcome === 'rolled-back' ? 'rolled-back' : null, error: text(raw.error), patch: text(raw.patch),
    verdict: raw.verdict === 'relaunched' || raw.verdict === 'failed' ? raw.verdict : null, verdictAt: text(raw.verdictAt),
  }
}
// The intent the script left, or null. A file that is not a valid version-1 intent is treated as absent and deleted.
function readResumeIntent(file: string): ResumeIntent | null { return loadIntent(file).intent }
// `missing` tells a file that is gone (or invalid, and deleted) from one that could not be read for a moment (the
// watcher replacing it): only the first ends a wait for the watcher's verdict.
function loadIntent(file: string): { intent: ResumeIntent | null; missing: boolean } {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch (error) { return { intent: null, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' } }
  let value: unknown = null
  try { value = JSON.parse(raw.replace(/^﻿/, '')) } catch { /* Not JSON: deleted below. */ }
  const intent = normalizeIntent(value)
  if (!intent) deleteResumeIntent(file)
  return { intent, missing: !intent }
}
// Removes the intent, so that it is acted on once: the delete is retried (a reader may hold the file for a moment), then
// the file is renamed to a tombstone nothing reads. False when it is still there.
function deleteResumeIntent(file: string): boolean {
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
    try { fs.rmSync(file, { force: true }); return true } catch { /* Held open: tried again. */ }
    if (attempt < DELETE_ATTEMPTS) pauseSync(DELETE_PAUSE_MS * attempt)
  }
  try { fs.renameSync(file, `${file}${TOMBSTONE_SUFFIX}`); return true } catch { /* Neither worked: the caller decides. */ }
  return !fs.existsSync(file)
}
// A short synchronous wait between two attempts (a spin where Atomics.wait is not allowed).
function pauseSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* Spin. */ } }
}

// The environment that names an agent's run to the self-upgrade script: with it the script writes an intent this run is
// continued from, and signals the Orbit of this profile. Empty without a resume file (no restart host).
function restartEnv(run: RestartRunRef, agent: { id: string }, resumeFile: string | null | undefined, userData?: string | null): Record<string, string> {
  if (!resumeFile) return {}
  return { ORBIT_RUN_ID: run.runId, ORBIT_CHAT_ID: run.chatId, ORBIT_PROJECT_ID: run.projectId, ORBIT_AGENT_ID: agent.id, ORBIT_RESUME_FILE: resumeFile, ...(userData ? { ORBIT_USER_DATA: userData } : {}) }
}

function findOnPath(name: string): string | null {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const folder = directory.trim().replace(/^"(.*)"$/, '$1')
    if (!folder) continue
    const candidate = path.join(folder, name)
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* Not here. */ }
  }
  return null
}
// The runtime may run inside Electron (a utility process), whose own binary is electron.exe: the script and the checks
// it starts need a real Node, and Electron serves as one only with ELECTRON_RUN_AS_NODE.
function nodeBinary(configured: string | null | undefined): { command: string; env: Record<string, string> } {
  const explicit = configured || process.env.ORBIT_NODE
  if (explicit) return { command: explicit, env: {} }
  if (!process.versions.electron) return { command: process.execPath, env: {} }
  const found = findOnPath(process.platform === 'win32' ? 'node.exe' : 'node')
  return found ? { command: found, env: {} } : { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}
const defaultSpawn: SpawnRestart = (command, args, options) => spawnProcess(command, args, options)
function killTree(child: RestartChild): void {
  if (process.platform === 'win32' && child.pid) {
    try { spawnProcess('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); return } catch { /* Fall back to the process itself. */ }
  }
  // Elsewhere the script leads its own process group (spawned detached), so the checks it started stop with it.
  try { if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, 'SIGTERM'); return } } catch { /* Group gone: try the process. */ }
  try { child.kill() } catch { /* Already exited. */ }
}
// The script's report (artifacts/self-upgrade-last.json) when this run of the script wrote it; an older one says nothing.
// (A file's time can lag the clock by a timer tick, hence the small allowance.)
function freshReport(file: string, since: number): Record<string, unknown> | null {
  try {
    if (fs.statSync(file).mtimeMs < since - 250) return null
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}
function levelOf(report: Record<string, unknown> | null): RestartLevel {
  const level = report?.level
  if (level === 'none' || level === 'renderer' || level === 'runtime' || level === 'full') return level
  // A report without a level: nothing changed, or (a script that predates levels) the whole app was relaunched.
  return report?.status === 'relaunched' ? 'full' : 'none'
}
// What the report of a rolled-back upgrade says about the sources; paths inside the repository are shown relative to it.
function rollbackOf(report: Record<string, unknown> | null, root: string): RestartRollback | undefined {
  const raw = report?.rollback
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rollback = raw as Record<string, unknown>
  const field = (value: unknown, key: string): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  const source = field(rollback.base, 'source'), commit = field(rollback.base, 'commit'), reason = field(rollback.base, 'reason'), ref = field(rollback.failed, 'ref')
  const shown = (file: unknown): string | null => {
    if (typeof file !== 'string' || !file) return null
    const relative = path.relative(root, file)
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file
  }
  return {
    base: typeof source === 'string' && typeof commit === 'string' && commit ? `${source} ${commit.slice(0, 12)}` : null,
    reason: typeof reason === 'string' ? reason : null,
    // Pathspecs such as `:(exclude)electron/main.cjs` say what stayed, not what came back.
    restored: rollback.treeRestored === true && Array.isArray(rollback.treePaths) ? rollback.treePaths.filter((entry): entry is string => typeof entry === 'string' && !entry.startsWith(':')) : [],
    patch: shown(rollback.patch), failedRef: typeof ref === 'string' ? ref : null,
  }
}
// Written for the script and its detached watcher when a stop cancels the upgrade (atomically: a reader sees all of it or
// nothing). They stop at their next look when it is newer than their plan's start.
function writeCancelMarker(file: string, now = Date.now()): void {
  const temporary = `${file}.${process.pid}-${now}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ requestedAt: now, reason: 'user-stop' }))
    fs.renameSync(temporary, file)
  } catch { try { fs.rmSync(temporary, { force: true }) } catch { /* Nothing was written. */ } }
}
// Whether a live script or watcher holds the upgrade lock, by the script's own rule: its pid runs and its heartbeat
// (the file's mtime, touched every 10 s) is under a minute old.
const LOCK_STALE_MS = 60000
function lockHeld(file: string, now = Date.now()): boolean {
  try {
    const pid = Number((JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown } | null)?.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0 || now - fs.statSync(file).mtimeMs > LOCK_STALE_MS) return false
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  } catch { return false }
}
// The lock of a script the host killed: removed when it still names that process (a watcher that took it over, and
// escaped the kill, keeps its own until it sees the cancel marker). The script's releaseLockOf does the same.
function releaseLock(file: string, pid: number | undefined): void {
  if (!pid) return
  try {
    const holder: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (holder && typeof holder === 'object' && Number((holder as { pid?: unknown }).pid) === pid) fs.rmSync(file, { force: true })
  } catch { /* No lock, or not one to release. */ }
}

// Where main writes its health report (main.cjs healthFile): ORBIT_HEALTH_FILE (a relative path from the repository;
// "0": nowhere), else the repository's artifacts/self-upgrade-health.json.
function healthFilePath(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ORBIT_HEALTH_FILE
  if (value === undefined) return path.join(root, 'artifacts', 'self-upgrade-health.json')
  return value && value !== '0' ? path.resolve(root, value) : null
}
// The parts of Orbit's code on disk the running Orbit does not run yet, as the self-upgrade tells them to pick its
// restart level: the code fingerprints of the files against those main's health report gives for the code it runs.
// Whatever wrote a file (a tool, a shell command, git) counts, and a change undone counts no more. [] when it runs all
// of it; null when it cannot tell: no report, a failed one, one about another runtime process than `pid` (another
// Orbit, a restart not reported yet) or older than `since` (a reused pid), or one without fingerprints.
function unappliedCode({ root, healthFile, pid = process.pid, since = Date.now() - process.uptime() * 1000 }: { root: string; healthFile: string | null; pid?: number; since?: number }): CodePart[] | null {
  if (!healthFile) return null
  try {
    const report: Record<string, unknown> | null = JSON.parse(fs.readFileSync(healthFile, 'utf8'))
    const hash = (value: unknown): string | null => typeof value === 'string' && value ? value : null
    const running = { shell: hash(report?.shellHash), runtime: hash(report?.runtimeHash), renderer: hash(report?.rendererHash) }
    const about = (report?.runtime as { pid?: unknown } | null | undefined)?.pid, writtenAt = report?.writtenAt
    if (report?.ok !== true || about !== pid || typeof writtenAt !== 'number' || writtenAt < since) return null
    if (!running.shell || !running.runtime || !running.renderer) return null
    const disk = { ...fingerprints(root), renderer: rendererHash(root) }
    return (['shell', 'runtime', 'renderer'] as const).filter(part => disk[part] !== running[part])
  } catch { return null }
}

// Runs `node scripts/self-upgrade.cjs [--no-verify] --reason <r> --continue-with <c>` in the repository for restart_orbit.
// One restart at a time: a second request for the same run (a model retrying after its MCP client gave up waiting)
// joins the one in flight; a request for another run is refused.
interface RestartJob { run: RestartRunRef; listeners: Set<(line: string) => void>; promise: Promise<RestartResult>; abort: () => void }
function createRestartHost({ repoRoot, userData, healthFile, nodeCommand = null, spawn = defaultSpawn, onLine: hostLine, kill = killTree }: RestartHostOptions): RestartHost {
  const root = path.resolve(repoRoot)
  const health = healthFile === undefined ? healthFilePath(root) : healthFile
  const script = path.join(root, SCRIPT)
  const available = fs.existsSync(script) && fs.existsSync(path.join(root, '.git'))
  const resumeFile = resumeFilePath(userData)
  const cancelFile = path.join(root, CANCEL_MARKER), lockFile = path.join(root, LOCK)
  let current: RestartJob | null = null
  const refused = (status: string, error: string): Promise<RestartResult> => Promise.resolve({ ok: false, status, output: '', exitCode: null, error })
  function request(input: RestartRequest): Promise<RestartResult> {
    if (!available) return refused('unavailable', UNAVAILABLE)
    if (current && current.run.runId !== input.run.runId) return refused('busy', `Another Orbit restart is in progress (run ${current.run.runId}); wait for it to finish`)
    const job = current || start(input)
    if (input.onLine) job.listeners.add(input.onLine)
    const signal = input.signal
    if (signal?.aborted) job.abort()
    else if (signal) {
      const abort = () => job.abort()
      signal.addEventListener('abort', abort, { once: true })
      const detach = () => signal.removeEventListener('abort', abort)
      job.promise.then(detach, detach)
    }
    return job.promise
  }
  function start(input: RestartRequest): RestartJob {
    const listeners = new Set<(line: string) => void>()
    const tail: string[] = []
    let child: RestartChild | null = null, cancelled = false, settled = false, job: RestartJob | null = null
    let resolve!: (result: RestartResult) => void
    const promise = new Promise<RestartResult>(settle => { resolve = settle })
    const output = () => { const joined = tail.join('\n'); return joined.length > OUTPUT_CHARS ? joined.slice(-OUTPUT_CHARS) : joined }
    // (A spawn that throws settles before `job` exists; nothing is in flight then.)
    const finish = (result: RestartResult) => { if (settled) return; settled = true; if (job && current === job) current = null; resolve(result) }
    const cancelledResult = (code: number | null): RestartResult => ({ ok: false, status: 'cancelled', output: output(), exitCode: code, error: 'The restart was cancelled' })
    const abort = () => {
      if (settled || cancelled) return
      cancelled = true
      // First the marker: the detached watcher of a restart already under way is not in the tree the kill reaches.
      writeCancelMarker(cancelFile)
      if (child) kill(child)
      // A process tree that will not die must not keep the agent's call, and with it the chat, waiting.
      const timer = setTimeout(() => finish(cancelledResult(null)), CANCEL_GRACE_MS)
      timer.unref?.()
    }
    const emitLine = (raw: string) => {
      const line = raw.replace(ANSI, '').replace(/\s+$/, '')
      if (!line) return
      const bounded = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line
      tail.push(bounded)
      if (tail.length > OUTPUT_LINES) tail.shift()
      for (const listener of [hostLine, ...listeners]) { try { listener?.(bounded) } catch { /* A broken listener never stops the restart. */ } }
    }
    const node = nodeBinary(nodeCommand)
    const args = [script, ...(input.verify ? [] : ['--no-verify']), '--reason', input.reason, '--continue-with', input.continueWith]
    const env = { ...process.env, ...node.env, ...restartEnv(input.run, input.agent, resumeFile, userData), ORBIT_RESTART_SOURCE: 'tool' }
    const since = Date.now()
    // A marker an earlier stop left is not meant for this upgrade — unless the upgrade it stopped still holds the lock (a
    // detached watcher on its way to its checks): then the marker stays for it, and this request fails with `locked`.
    if (!lockHeld(lockFile)) {
      try { fs.rmSync(cancelFile, { force: true }) } catch { /* Held for a moment: older than this plan, so the script ignores it. */ }
    }
    try {
      const started = spawn(node.command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      child = started
      const flushers = [started.stdout, started.stderr].map(stream => {
        if (!stream) return () => {}
        let rest = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string | Buffer) => {
          const parts = (rest + String(chunk)).split('\n')
          rest = parts.pop() ?? ''
          for (const part of parts) emitLine(part)
        })
        return () => { if (rest) emitLine(rest); rest = '' }
      })
      started.on('error', error => finish({ ok: false, status: 'spawn-failed', output: output(), exitCode: null, error: error.message }))
      started.on('close', (code, signal) => {
        for (const flush of flushers) flush()
        // The killed script could not release its lock; the next upgrade must not wait for a process that is gone.
        if (cancelled) { releaseLock(lockFile, started.pid); return finish(cancelledResult(code)) }
        const report = freshReport(path.join(root, REPORT), since)
        const status = typeof report?.status === 'string' ? report.status : null
        if (code === 0) return finish({ ok: true, level: levelOf(report), status, output: output(), exitCode: 0 })
        const rollback = rollbackOf(report, root)
        finish({ ok: false, status: status ?? (signal ? `killed by ${signal}` : 'failed'), output: output(), exitCode: code, error: typeof report?.error === 'string' ? report.error : null, ...(rollback ? { rollback } : {}) })
      })
    } catch (error) { finish({ ok: false, status: 'spawn-failed', output: '', exitCode: null, error: (error as Error).message }) }
    job = { run: { runId: input.run.runId, chatId: input.run.chatId, projectId: input.run.projectId }, listeners, promise, abort }
    if (!settled) current = job
    return job
  }
  const inFlight = (): RestartRunRef | null => current ? { ...current.run } : null
  const unapplied = (): CodePart[] | null => available ? unappliedCode({ root, healthFile: health }) : null
  return { available, repoRoot: root, resumeFile, userData, request, inFlight, unapplied }
}

// Shutting down for a restart: the run the intent names ends with the status `restarting` (not cancelled or
// interrupted), so that the new process continues it. The mark keeps the intent's id: only that intent continues the
// run (a forged or stale one does not). Returns the ids it marked.
function markRestartingRuns({ runtime, userData }: { runtime: Pick<OrbitRuntimeLike, 'markRestarting'>; userData: string }): string[] {
  const intent = readResumeIntent(resumeFilePath(userData))
  if (!intent || intent.outcome) return []
  const mark: RestartMark = { reason: intent.reason, requestedAt: intent.createdAt, source: intent.source, ...(intent.id ? { intentId: intent.id } : {}) }
  return runtime.markRestarting(intent.runId, mark) ? [intent.runId] : []
}

const restartLevel = (intent: Pick<ResumeIntent, 'level'>, info: ResumeInfo | null | undefined): 'runtime' | 'full' | null =>
  info?.level === 'runtime' || info?.level === 'full' ? info.level : intent.level
function restartsWord(count: number): string {
  const last = count % 10, lastTwo = count % 100
  if (last === 1 && lastTwo !== 11) return 'перезапуск'
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'перезапуска' : 'перезапусков'
}
// The first message of the continuation: what the agent said to do next, and what happened in between.
function continuationPrompt(intent: Pick<ResumeIntent, 'continueWith' | 'commit' | 'level' | 'reason' | 'runId'> & { snapshot?: string | null }, info: ResumeInfo | null = null): string {
  const commit = (intent.commit || info?.commit || '').trim().slice(0, 7)
  // The code that runs is the commit plus the uncommitted changes the self-upgrade snapshot recorded.
  const snapshot = (intent.snapshot || '').trim().slice(0, 7)
  const code = `коммит ${commit || 'неизвестен'}${snapshot ? ` + незакоммиченные изменения, снимок ${snapshot}` : ''}`
  const level = restartLevel(intent, info)
  return `${intent.continueWith}\n\nOrbit перезапущен с новым кодом (${code}, уровень ${level || 'неизвестен'}, причина: ${intent.reason || 'не указана'}); предыдущий запуск ${intent.runId} завершён перезапуском, его история — в дайджесте предыдущих ходов чата.`
}
const defaultMaxChain = (): number => Math.max(1, Math.floor(Number(process.env.ORBIT_UPGRADE_MAX_CYCLES) || 3))
// A run the restart did not get to write a note for (Orbit was killed rather than shut down): what its record still says.
function storedNote(old: StoredRun): string {
  const agents = old.agents || []
  const root = agents.find(agent => agent.id === 'root')
  const helpers = agents.filter(agent => agent.id !== 'root').slice(-8)
  const lines = [
    `RESTART NOTE: Orbit restarted with new code, and this run continues run ${old.runId}, which the restart ended (status ${old.status || 'unknown'}). You are the same orchestrator; only the saved record of that run is left.`,
    `Files that run wrote: ${JSON.stringify((root?.files?.wrote || []).slice(-10))}; files it read: ${JSON.stringify((root?.files?.read || []).slice(-8))}.`,
  ]
  if (helpers.length) lines.push(`Helpers of that run (team_history returns their full reports):\n${helpers.map(agent => `- ${String(agent.name ?? agent.id)} [${agent.status || 'unknown'}]: ${clip(String(agent.result || agent.error || agent.task || ''), 240)}`).join('\n')}`)
  lines.push('Check the real state (read the files, run the check) before repeating any write or command from before the restart.')
  return lines.join('\n')
}
// The old root's provider session, when it had one: the continuation resumes it if its root keeps that provider. A root
// cut off in its first session turn has no `sessionId` yet (it is recorded when a turn returns); for Claude, whose
// session Orbit names itself, the record of that turn (turnTimings) holds the id the session was started with — unless
// the root moved to Claude after that turn started. Codex, Cursor and Antigravity name their own sessions: their record
// holds the id their stream named (turn.mts) or, until it did, the one Orbit proposed, which is not theirs; it is not
// used yet (docs/TECH-DEBT.md, item 14). The mark of the old root's mail (saved with the restart) goes along.
function rootSession(old: StoredRun): { id: string; providerId: string; mailMark?: string } | undefined {
  const root = (old.agents || []).find(agent => agent.id === 'root')
  if (root?.transport !== 'session' || typeof root.providerId !== 'string') return undefined
  const mark = typeof old.restart?.mailMark === 'string' ? { mailMark: old.restart.mailMark } : {}
  if (typeof root.sessionId === 'string' && root.sessionId) return { id: root.sessionId, providerId: root.providerId, ...mark }
  if (root.providerId !== 'claude' || !Array.isArray(root.turnTimings)) return undefined
  const last: unknown = root.turnTimings.at(-1)
  const timing = last && typeof last === 'object' ? last as Partial<Record<'transport' | 'sessionId' | 'startedAt', unknown>> : null
  const handover: unknown = Array.isArray(root.handovers) ? root.handovers.at(-1) : null
  const switchedAt = handover && typeof handover === 'object' ? (handover as { time?: unknown }).time : null
  if (timing?.transport !== 'session' || typeof timing.sessionId !== 'string' || !timing.sessionId) return undefined
  if (typeof switchedAt === 'string' && String(timing.startedAt ?? '') < switchedAt) return undefined
  return { id: timing.sessionId, providerId: root.providerId, ...mark }
}
// The run that already continues `old`, if any: a live one, or one the run history kept (in the same chat).
function continuationOf(runtime: ResumeOptions['runtime'], store: ResumeOptions['runStore'], old: StoredRun): string | null {
  for (const run of runtime.runs?.values() ?? []) if (run.resumedFrom === old.runId) return run.runId
  let stored: StoredRun[] = []
  try { stored = old.projectId && old.chatId && store?.forChat ? store.forChat(old.projectId, old.chatId, 12) : store?.list?.() ?? [] } catch { /* An unreadable history shows none. */ }
  return stored.find(run => run.resumedFrom === old.runId)?.runId ?? null
}
// The watcher decides after the new code started: healthy (`verdict: 'relaunched'`), rolled back, or (the watcher itself
// failed) `verdict: 'failed'`. Until then the start that is healthy now may still be killed by a rollback, so the intent
// is read again until one of them is in it.
async function awaitVerdict(file: string, intent: ResumeIntent, waitMs: number, pollMs: number): Promise<ResumeIntent | null> {
  const deadline = Date.now() + waitMs
  let current = intent
  while (!current.outcome && !current.verdict && Date.now() < deadline) {
    await pause(Math.max(1, Math.min(pollMs, deadline - Date.now())))
    const next = loadIntent(file)
    if (next.intent) current = next.intent
    else if (next.missing) return null
  }
  return current
}
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
// One continuation per intent, however often a healthy start is reported while the verdict is awaited.
const resuming = new Map<string, Promise<RestartNotice | null>>()

// After a healthy start: continue the run the intent names, in the same chat, with the same settings, once the watcher
// has confirmed the new code (up to `verdictWaitMs`; without a verdict only an intent younger than 10 minutes is
// continued). The intent is deleted (or renamed to a tombstone) before the continuation starts, so a continuation that
// crashes Orbit is never started twice; an intent that cannot be removed is not acted on, and a run that already has a
// continuation is never continued again. Nothing is started after a rollback or a failed watcher, for an old intent,
// beyond ORBIT_UPGRADE_MAX_CYCLES restarts in a row, when the run is gone or was stopped by the user, or when the shutdown
// did not mark the run with this very intent (markRestartingRuns); the renderer hears why. The continuation's root
// starts with the restart note and resumes the old root's provider session when it can (runtime/restart.mts
// prepareContinuation). Resolves to the notice sent, or null when there was no intent (or it was already used).
function resumePending(options: ResumeOptions): Promise<RestartNotice | null> {
  const file = resumeFilePath(options.userData)
  const running = resuming.get(file)
  if (running) return running
  const task = resumeOnce(file, options).finally(() => resuming.delete(file))
  resuming.set(file, task)
  return task
}
async function resumeOnce(file: string, { runtime, userData, runStore = runtime.runStore, notify, now = Date.now, maxChain = defaultMaxChain(), info = null, verdictWaitMs = VERDICT_WAIT_MS, pollMs = VERDICT_POLL_MS }: ResumeOptions): Promise<RestartNotice | null> {
  let loaded = loadIntent(file)
  for (let attempt = 0; !loaded.intent && !loaded.missing && attempt < 10; attempt++) { await pause(pollMs); loaded = loadIntent(file) }
  const first = loaded.intent
  if (!first) return null
  const unconfirmed = !first.outcome && !first.verdict && now() - Date.parse(first.createdAt) <= INTENT_TTL_MS
  const intent = unconfirmed ? await awaitVerdict(file, first, verdictWaitMs, pollMs) : first
  if (!intent) return null
  let old: StoredRun | null = null
  try { old = runStore?.get?.(intent.runId) ?? null } catch { /* A damaged record is a missing one. */ }
  const level = restartLevel(intent, info)
  const notice = (kind: RestartNotice['kind'], message: string, extra: Partial<RestartNotice> = {}): RestartNotice => {
    const value: RestartNotice = {
      kind, chatId: intent.chatId ?? old?.chatId ?? null, projectId: intent.projectId ?? old?.projectId ?? null, runId: intent.runId,
      text: message, ...(intent.reason ? { reason: intent.reason } : {}), ...(level ? { level } : {}), ...extra, time: new Date(now()).toISOString(),
    }
    try { notify?.(value) } catch { /* A closed window never blocks the continuation. */ }
    return value
  }
  const refuse = (kind: RestartNotice['kind'], message: string, extra: Partial<RestartNotice> = {}): RestartNotice => { deleteResumeIntent(file); return notice(kind, message, extra) }
  if (intent.outcome === 'rolled-back') {
    return refuse('rolled-back', `Перезапуск не удался и откатился: ${intent.error || 'причина неизвестна'}. Неудачное изменение: ${intent.patch || 'не сохранено'}`, { ...(intent.error ? { error: intent.error } : {}), ...(intent.patch ? { patch: intent.patch } : {}) })
  }
  // The watcher failed before it could vouch for the new code: nothing says it works, so nothing is continued.
  if (intent.verdict === 'failed') return refuse('failed', `Перезапуск не подтверждён: наблюдатель самообновления завершился с ошибкой (${intent.error || 'причина неизвестна'}), продолжение не запущено`, intent.error ? { error: intent.error } : {})
  // An intent that outlived its continuation (it could not be removed then) is used up: no second continuation.
  if (old && continuationOf(runtime, runStore, old)) { deleteResumeIntent(file); return null }
  const age = now() - Date.parse(intent.createdAt)
  if (age > INTENT_TTL_MS) return refuse('expired', 'Намерение продолжить устарело (> 30 мин), продолжение не запущено')
  if (!intent.verdict && age > UNCONFIRMED_TTL_MS) return refuse('expired', 'Намерение продолжить устарело (> 10 мин, а перезапуск так и не подтверждён), продолжение не запущено')
  // `chain` counts this restart too: the third restart in a row (default ORBIT_UPGRADE_MAX_CYCLES = 3) is not continued
  // (TECH-DEBT item 1.5); the script's own cycle limit refuses a fourth one within its window anyway.
  const chain = (Number(old?.resumeChain) || 0) + 1
  if (chain >= maxChain) return refuse('loop-limit', `Продолжение не запущено: ${chain} ${restartsWord(chain)} подряд (предел ORBIT_UPGRADE_MAX_CYCLES)`)
  if (!old) return refuse('failed', 'Продолжение не запущено: запись прерванного запуска не найдена')
  if (!old.startPayload) return refuse('failed', 'Продолжение не запущено: у прерванного запуска нет сохранённых параметров запуска')
  if (old.status === 'cancelled') return refuse('failed', 'Продолжение не запущено: запуск был остановлен до перезапуска')
  // Only a run the restart cut off is continued: one that finished on its own before the restart has nothing left to do.
  if (old.status !== 'restarting' && old.status !== 'interrupted') return refuse('failed', `Продолжение не запущено: запуск уже завершился (${old.status})`)
  // Only the intent the shutdown marked the run with continues it: not a forged or stale one, nor one for a run the
  // shutdown never marked (an interrupted run included).
  if (!intent.id || old.restart?.intentId !== intent.id) return refuse('failed', `Продолжение не запущено: запуск не был завершён этим перезапуском (намерение ${intent.id || 'без идентификатора'})`)
  if (!deleteResumeIntent(file)) return notice('failed', 'Продолжение не запущено: файл намерения не удалось удалить, и задача могла бы продолжиться дважды', { error: `Could not remove ${file}` })
  const session = rootSession(old)
  // The files the user attached in that run, those still in Orbit's attachments folder: the note names them again. Only
  // these: a damaged record's start payload brings no files of its own.
  const files = trustedAttachments(userData, Array.isArray(old.attachments) ? old.attachments.slice(-MAX_RUN_FILES) : [], MAX_RUN_FILES)
  try {
    const resumedRunId = await runtime.start({
      ...old.startPayload, projectId: old.projectId || old.startPayload.projectId, chatId: old.chatId || old.startPayload.chatId,
      prompt: continuationPrompt(intent, info), resumedFrom: old.runId, resumeChain: chain,
      restartNote: old.restart?.note || storedNote(old), ...(session ? { resumeSession: session } : {}), attachments: [], resumeAttachments: files,
    })
    return notice('resumed', `Orbit перезапущен по запросу агента, задача продолжена${intent.reason ? ` (причина: ${intent.reason})` : ''}`, { resumedRunId })
  } catch (error) {
    const message = (error as Error)?.message || String(error)
    return notice('failed', `Продолжение не запущено: ${message}`, { error: message })
  }
}

export { resumeFilePath, readResumeIntent, deleteResumeIntent, restartEnv, createRestartHost, healthFilePath, unappliedCode, markRestartingRuns, resumePending, continuationPrompt }
export type { RestartNotice, ResumeIntent, RestartHost, RestartRequest, RestartResult, RestartRollback, RestartLevel, CodePart, RestartSource, ResumeInfo, RestartRunRef, RestartChild, SpawnRestart, RestartHostOptions, ResumeOptions }
