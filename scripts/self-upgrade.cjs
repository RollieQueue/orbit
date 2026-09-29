'use strict'

/**
 * Orbit self-upgrade: the live loop for an app that runs from this repository (Orbit.cmd / npm start).
 *
 *   lock → typecheck (tsconfig.json and tsconfig.main.json) → node --experimental-strip-types --test tests/*.test.cjs
 *   → runtime smoke → main-load test [→ smoke:desktop]
 *   → dist/ saved to dist-prev/, the verified electron/ + src/ snapshotted as refs/orbit/self-upgrade/candidate
 *   → vite build
 *   → the running Orbit is asked to restart itself: `electron.exe <repo> --relaunch`, what `Orbit.cmd --relaunch`
 *     runs (the second-instance handler in electron/main.cjs flushes state and relaunches; with no instance running
 *     this simply starts one)
 *   → wait ≤ 15 s for a fresh artifacts/self-upgrade-health.json, written by the new process after did-finish-load,
 *     one IPC round trip and a mounted renderer; on success the candidate becomes refs/orbit/self-upgrade/last-good
 *   → on failure: Orbit processes of this repository are stopped, the failed sources are kept as
 *     refs/orbit/self-upgrade/failed + artifacts/self-upgrade-failed.patch, dist-prev/ and the last-good tree of
 *     electron/ + src/ come back, Orbit is started again and the report says `rolled-back`.
 *
 * The relaunch phase runs in a watcher process detached from this one: when an agent runs the upgrade from inside
 * Orbit, the restarting app stops that agent's command tree, and the health check and the rollback must outlive it.
 * The foreground script waits for the watcher's report and prints it.
 *
 * Flags:
 *   --dry-run        print the plan and check the tools; nothing runs
 *   --no-relaunch    verify and build only; the report says what to run next
 *   --verify-only    stop after the checks (alias: --skip-package)
 *   --force          verify, build and relaunch even when nothing changed since the last build
 *   --desktop        also run smoke:desktop (default: skipped; --skip-desktop keeps it off)
 *   --watch <plan>   internal: the detached relaunch phase
 *
 * Env: ORBIT_UPGRADE_MAX_CYCLES relaunches per ORBIT_UPGRADE_CYCLE_WINDOW_MIN minutes (default 3 per 30),
 *      ORBIT_UPGRADE_HEALTH_TIMEOUT_MS (default 15000), ORBIT_USER_DATA (inherited by a freshly started Orbit).
 *
 * Reports: artifacts/self-upgrade-last.json (status, step timings, health, rollback), artifacts/self-upgrade-watch.log.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const ARTIFACTS = path.join(root, 'artifacts')
const DIST = path.join(root, 'dist')
const DIST_PREV = path.join(root, 'dist-prev')
const HEALTH_FILE = path.join(ARTIFACTS, 'self-upgrade-health.json')
const HEALTH_PREV_FILE = path.join(ARTIFACTS, 'self-upgrade-health-prev.json')
const REPORT_FILE = path.join(ARTIFACTS, 'self-upgrade-last.json')
const PLAN_FILE = path.join(ARTIFACTS, 'self-upgrade-plan.json')
const CYCLES_FILE = path.join(ARTIFACTS, 'self-upgrade-cycles.json')
const WATCH_LOG = path.join(ARTIFACTS, 'self-upgrade-watch.log')
const FAILED_PATCH = path.join(ARTIFACTS, 'self-upgrade-failed.patch')
const BUILD_MARKER = 'orbit-build.json'
const RELAUNCH_FLAG = '--relaunch'
const REF_PREFIX = 'refs/orbit/self-upgrade/'
const SNAPSHOT_PATHS = ['electron', 'src']
// Inputs the running application is made of.
const SOURCE_ENTRIES = ['electron', 'src', 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json']
const DEFAULT_HEALTH_TIMEOUT_MS = 15000

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const watchPlan = argv.includes('--watch') ? argv[argv.indexOf('--watch') + 1] : null
const dryRun = flags.has('--dry-run')
const noRelaunch = flags.has('--no-relaunch')
const verifyOnly = flags.has('--verify-only') || flags.has('--skip-package')
const force = flags.has('--force')
const runDesktop = flags.has('--desktop') && !flags.has('--skip-desktop')
const healthTimeoutMs = Math.max(1000, Number(process.env.ORBIT_UPGRADE_HEALTH_TIMEOUT_MS) || DEFAULT_HEALTH_TIMEOUT_MS)
const maxCycles = Math.max(1, Math.floor(Number(process.env.ORBIT_UPGRADE_MAX_CYCLES) || 3))
const cycleWindowMs = Math.max(1, Number(process.env.ORBIT_UPGRADE_CYCLE_WINDOW_MIN) || 30) * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}
function indexMtime(dist = DIST) { try { return Math.round(fs.statSync(path.join(dist, 'index.html')).mtimeMs) } catch { return null } }

// ---------------------------------------------------------------------------------------------------------------
// Tools

/**
 * Entry file of a dependency's executable. Modern packages hide their bin files behind an `exports` map, so
 * `require.resolve('typescript/bin/tsc')` throws; the declared `bin` field is the supported route.
 */
function toolPath(packageName, binName) {
  const manifest = require.resolve(`${packageName}/package.json`)
  const declared = require(manifest).bin
  const relative = typeof declared === 'string' ? declared : declared?.[binName]
  if (!relative) throw new Error(`${packageName} does not declare a "${binName}" executable`)
  const file = path.join(path.dirname(manifest), relative)
  if (!fs.existsSync(file)) throw new Error(`${packageName} executable is missing: ${file}`)
  return file
}

/** The electron package exports the path of its binary when loaded under Node; Orbit.cmd starts the same file. */
function electronBinary() {
  const file = require('electron')
  if (typeof file !== 'string' || !fs.existsSync(file)) throw new Error(`Electron binary is missing (${file}); run npm install`)
  return file
}

function gitVersion() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : null
}

function toolchain() {
  return { tsc: toolPath('typescript', 'tsc'), vite: toolPath('vite', 'vite'), electron: electronBinary(), git: gitVersion() }
}

function testFiles(base = root) {
  return fs.readdirSync(path.join(base, 'tests'))
    .filter((name) => name.endsWith('.test.cjs'))
    .map((name) => path.join('tests', name))
    .sort()
}

// ---------------------------------------------------------------------------------------------------------------
// Sources and the build marker (dist/orbit-build.json: which sources the current dist/ was built and verified from)

function newestSourceChange(base = root) {
  let newest = { time: 0, file: null }
  const visit = (target) => {
    let stat
    try { stat = fs.statSync(target) } catch { return }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) if (name !== 'node_modules') visit(path.join(target, name))
    } else if (stat.mtimeMs > newest.time) newest = { time: stat.mtimeMs, file: path.relative(base, target) }
  }
  for (const entry of SOURCE_ENTRIES) visit(path.join(base, entry))
  return newest
}

/** Missing for a dist/ made by `npm run build` alone: provenance unknown, so the next upgrade verifies and rebuilds. */
function readBuildMarker(dist = DIST) {
  const marker = readJson(path.join(dist, BUILD_MARKER))
  return marker && Number.isFinite(marker.sourceNewest) ? marker : null
}

function writeBuildMarker(dist, marker) {
  return writeJson(path.join(dist, BUILD_MARKER), marker)
}

// ---------------------------------------------------------------------------------------------------------------
// Lock: one upgrade at a time; the watcher takes it over for the relaunch phase.

let lockOwned = false
function lockFile(base = root) { return path.join(base, 'artifacts', 'self-upgrade.lock') }
function releaseLockOnExit(file) {
  process.on('exit', () => {
    if (!lockOwned) return
    try { if (readJson(file)?.pid === process.pid) fs.unlinkSync(file) } catch { /* Already gone. */ }
  })
}
function acquireLock(base = root) {
  const file = lockFile(base)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), role: 'upgrade' }), { flag: 'wx' })
      lockOwned = true
      releaseLockOnExit(file)
      return file
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const holder = readJson(file)
      let alive = false
      // EPERM means the process exists but belongs to someone else (elevated, another user): still running.
      if (holder?.pid) { try { process.kill(holder.pid, 0); alive = true } catch (killError) { alive = killError.code === 'EPERM' } }
      if (alive && Date.now() - holder.startedAt < 45 * 60 * 1000) throw new Error(`Another self-upgrade is already running (pid ${holder.pid}, ${holder.role || 'upgrade'}). Wait for it to finish.`)
      try { fs.unlinkSync(file) } catch { /* Lost the race to another cleanup. */ }
    }
  }
  throw new Error('Could not acquire the self-upgrade lock.')
}
function handOverLock() { lockOwned = false }
function takeOverLock(base = root) {
  const file = lockFile(base)
  writeJson(file, { pid: process.pid, startedAt: Date.now(), role: 'watcher' })
  lockOwned = true
  releaseLockOnExit(file)
}

// ---------------------------------------------------------------------------------------------------------------
// Steps with timings

function createTimer(log = console.log) {
  const timings = []
  const step = async (name, action) => {
    const began = Date.now()
    log(`\n==> ${name}`)
    try {
      const result = await action()
      timings.push({ step: name, ms: Date.now() - began, ok: true })
      return result
    } catch (error) {
      timings.push({ step: name, ms: Date.now() - began, ok: false, error: error.message })
      throw error
    }
  }
  return { timings, step }
}

function run(label, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true, env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} exited with ${result.status}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Git snapshots of electron/ and src/ (the real index is never touched)

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'orbit-self-upgrade', GIT_AUTHOR_EMAIL: 'self-upgrade@orbit.local',
  GIT_COMMITTER_NAME: 'orbit-self-upgrade', GIT_COMMITTER_EMAIL: 'self-upgrade@orbit.local',
}

function git(args, { cwd = root, env = {}, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

function readRef(label, cwd = root) {
  const result = git(['rev-parse', '--verify', '--quiet', `${REF_PREFIX}${label}^{commit}`], { cwd, allowFailure: true })
  return result.ok ? result.out : null
}

/**
 * The working-tree state of electron/ and src/ (modified, new and deleted files alike; `git stash create` would miss
 * new files) as a commit behind refs/orbit/self-upgrade/<label>. A temporary index keeps the real one untouched.
 */
function snapshotTree({ cwd = root, label, paths = SNAPSHOT_PATHS } = {}) {
  if (!label) throw new Error('snapshotTree needs a label')
  const index = path.join(os.tmpdir(), `orbit-upgrade-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, allowFailure: true })
    if (head.ok) git(['read-tree', 'HEAD'], { cwd, env })
    else git(['read-tree', '--empty'], { cwd, env })
    git(['add', '-A', '--', ...paths], { cwd, env })
    const tree = git(['write-tree'], { cwd, env }).out
    const message = `orbit self-upgrade ${label} ${new Date().toISOString()}`
    const commit = git(['commit-tree', tree, ...(head.ok ? ['-p', head.out] : []), '-m', message], { cwd, env: { ...env, ...SNAPSHOT_IDENTITY } }).out
    git(['update-ref', `${REF_PREFIX}${label}`, commit], { cwd })
    return { label, ref: `${REF_PREFIX}${label}`, commit, tree, head: head.ok ? head.out : null }
  } finally {
    try { fs.unlinkSync(index) } catch { /* Never created. */ }
  }
}

/** Puts electron/ and src/ back to a snapshot: tracked files are rewritten or removed; files created after it stay. */
function restoreTree({ cwd = root, commit, paths = SNAPSHOT_PATHS }) {
  if (!commit) throw new Error('restoreTree needs a commit')
  git(['restore', '--source', commit, '--worktree', '--no-overlay', '--', ...paths], { cwd })
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// dist/ and dist-prev/

/** Copy `source` over `target`. The old target is renamed first: a folder another process holds open cannot be deleted at once on Windows, but it can be renamed. */
function replaceDirectory(source, target) {
  const parked = `${target}.old-${Date.now()}`
  if (fs.existsSync(target)) fs.renameSync(target, parked)
  try {
    fs.cpSync(source, target, { recursive: true })
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(parked)) fs.renameSync(parked, target)
    throw error
  }
  try { fs.rmSync(parked, { recursive: true, force: true }) } catch { /* Swept on the next run. */ }
}

function sweepParked(base = root) {
  for (const name of fs.readdirSync(base)) {
    if (/^dist(-prev)?\.old-\d+$/.test(name)) { try { fs.rmSync(path.join(base, name), { recursive: true, force: true }) } catch { /* Still held open. */ } }
  }
}

function saveDistPrev({ dist = DIST, prev = DIST_PREV } = {}) {
  if (!fs.existsSync(path.join(dist, 'index.html'))) return false
  replaceDirectory(dist, prev)
  return true
}

function restoreDistPrev({ dist = DIST, prev = DIST_PREV } = {}) {
  if (!fs.existsSync(path.join(prev, 'index.html'))) throw new Error('dist-prev/ has no build to restore')
  replaceDirectory(prev, dist)
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// Orbit processes, relaunch signal, health

/** Start Orbit the way Orbit.cmd does: electron.exe <repo> [args], without ELECTRON_RUN_AS_NODE. */
function orbitLaunch({ electron, base = root, args = [], env = process.env } = {}) {
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  return { file: electron, args: [base, ...args], env: childEnv, cwd: base }
}

function signalRelaunch(spec, log = console.log) {
  log(`starting ${spec.file} ${spec.args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`)
  const child = spawn(spec.file, spec.args, { cwd: spec.cwd, detached: true, stdio: 'ignore', windowsHide: false, env: spec.env })
  child.on('error', (error) => log(`could not start Electron: ${error.message}`))
  child.unref()
  return child.pid
}

/** Whether a Win32_Process row is an Orbit main process started from this repository (not a helper, smoke, dev server or this script). */
function matchesOrbitProcess(commandLine, base = root) {
  const rest = String(commandLine || '').replace(/^\s*("[^"]*"|\S+)\s*/, '')
  const needle = base.replace(/[\\/]+$/, '').toLowerCase()
  if (!rest.toLowerCase().includes(needle)) return false
  if (/--type=/.test(rest)) return false
  if (/smoke-desktop\.cjs|self-upgrade\.cjs|electron[\\/]main\.cjs/i.test(rest)) return false
  return true
}

function findOrbitProcesses(base = root) {
  if (process.platform !== 'win32') return []
  const command = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (result.status !== 0 || !result.stdout || !result.stdout.trim()) return []
  let rows
  try { rows = JSON.parse(result.stdout) } catch { return [] }
  if (!Array.isArray(rows)) rows = [rows]
  return rows
    .filter((row) => row && matchesOrbitProcess(row.CommandLine, base))
    .map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), commandLine: String(row.CommandLine || '') }))
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return result.status === 0
  }
  try { process.kill(pid, 'SIGKILL'); return true } catch { return false }
}

/** A report from a process that started after the signal, not the one the previous instance left behind. */
function isFreshHealth(health, since) {
  return !!health && Number.isFinite(Number(health.pid)) && Number(health.startedAt) >= since && Number(health.writtenAt) >= Number(health.startedAt)
}

async function waitForHealth({ file = HEALTH_FILE, since, timeoutMs = healthTimeoutMs, poll = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = readJson(file)
    if (isFreshHealth(health, since)) return health
    if (Date.now() >= deadline) return null
    await sleep(poll)
  }
}

function parkHealthFile() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return
    fs.rmSync(HEALTH_PREV_FILE, { force: true })
    fs.renameSync(HEALTH_FILE, HEALTH_PREV_FILE)
  } catch { /* A stale file is ignored by the freshness check anyway. */ }
}

// ---------------------------------------------------------------------------------------------------------------
// Relaunch cap: a chain that keeps restarting the app stops here.

function readCycles({ file = CYCLES_FILE, now = Date.now(), windowMs = cycleWindowMs } = {}) {
  const list = readJson(file)?.relaunches
  return (Array.isArray(list) ? list : []).filter((time) => Number.isFinite(time) && now - time < windowMs)
}
function recordCycle({ file = CYCLES_FILE, now = Date.now(), windowMs = cycleWindowMs } = {}) {
  const list = readCycles({ file, now, windowMs })
  list.push(now)
  writeJson(file, { relaunches: list })
  return list.length
}
function cycleLimitReached({ file = CYCLES_FILE, now = Date.now(), limit = maxCycles, windowMs = cycleWindowMs } = {}) {
  return readCycles({ file, now, windowMs }).length >= limit
}

// ---------------------------------------------------------------------------------------------------------------
// Plan and report

function planSteps({ verifyOnly: onlyVerify = false, noRelaunch: skipRelaunch = false, desktop = false } = {}) {
  const steps = ['typecheck', 'test', 'smoke', 'main-load', ...(desktop ? ['smoke:desktop'] : [])]
  if (onlyVerify) return steps
  steps.push('save-previous', 'build')
  if (!skipRelaunch) steps.push('relaunch', 'health')
  return steps
}

function writeReport(report) { return writeJson(REPORT_FILE, report) }

/** A failure the next reader of self-upgrade-last.json must be able to see, not only the console. */
function failWithReport(message, details = {}) {
  const file = writeReport({ ok: false, status: 'failed', nextAction: 'fix-and-retry', timestamp: new Date().toISOString(), error: message, phase: 'done', ...details })
  console.error(`${message}\nReport: ${file}`)
  process.exit(details.exitCode || 1)
}

function spawnWatcher(planFile) {
  const nodeExe = process.execPath
  const script = __filename
  const env = { ...process.env }
  const onError = (error) => console.error(`Could not start the relaunch watcher: ${error.message}`)
  if (process.platform === 'win32') {
    // `start /b` through cmd.exe breaks the parent chain: the watcher's parent exits at once, so the `taskkill /t`
    // Orbit aims at an agent's command tree while restarting (this script, when an agent runs it) cannot reach it.
    const command = `start "" /b "${nodeExe}" "${script}" --watch "${planFile}"`
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env })
    child.on('error', onError)
    child.unref()
    return
  }
  const child = spawn(nodeExe, [script, '--watch', planFile], { cwd: root, detached: true, stdio: 'ignore', env })
  child.on('error', onError)
  child.unref()
}

async function awaitWatcher(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const report = readJson(REPORT_FILE)
    if (report?.runId === runId && report.phase === 'done') return report
    await sleep(300)
  }
  return null
}

function summarize(report) {
  const lines = [`\nSelf-upgrade ${report.status}${report.ok ? '' : ` — ${report.error || 'see report'}`}`]
  for (const timing of report.timings || []) lines.push(`  ${timing.ok ? 'ok  ' : 'FAIL'} ${timing.step.padEnd(14)} ${timing.ms} ms`)
  if (report.relaunch) lines.push(`  relaunch: health ${report.relaunch.health ? (report.relaunch.health.ok ? 'ok' : 'failed') : 'missing'} after ${report.relaunch.waitedMs} ms${report.relaunch.startedFresh ? ' (started a new instance)' : ''}`)
  if (report.rollback) lines.push(`  rollback: dist ${report.rollback.distRestored ? 'restored' : 'not restored'}, sources ${report.rollback.treeRestored ? 'restored' : 'left as they are'}, recovered: ${report.rollback.recovered}${report.rollback.patch ? `, failed change: ${report.rollback.patch}` : ''}`)
  lines.push(`Report: ${REPORT_FILE}`)
  lines.push(`nextAction: ${report.nextAction}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// The detached relaunch phase

async function relaunchAndWait({ spec, timeoutMs, log }) {
  const runningBefore = findOrbitProcesses().map((process_) => process_.pid)
  parkHealthFile()
  const since = Date.now()
  const signalPid = signalRelaunch(spec, log)
  log(`relaunch signalled (helper pid ${signalPid}); Orbit running before: ${runningBefore.join(', ') || 'none'}`)
  const health = await waitForHealth({ since, timeoutMs })
  log(health ? `health ${health.ok ? 'ok' : 'failed'} from pid ${health.pid} after ${Date.now() - since} ms${health.error ? `: ${health.error}` : ''}` : `no health report within ${timeoutMs} ms`)
  return { since, runningBefore, startedFresh: runningBefore.length === 0, waitedMs: Date.now() - since, health }
}

async function rollback({ plan, spec, log }) {
  const result = { startedAt: new Date().toISOString(), killed: [], distRestored: false, treeRestored: false, failed: null, patch: null, health: null, recovered: false }
  for (const process_ of findOrbitProcesses()) {
    killProcess(process_.pid)
    result.killed.push(process_.pid)
    log(`stopped Orbit pid ${process_.pid}`)
  }
  if (plan.candidate) {
    try {
      const failed = snapshotTree({ label: 'failed' })
      result.failed = failed
      const base = plan.lastGood || failed.head
      if (base) {
        const diff = git(['diff', base, failed.commit, '--', ...SNAPSHOT_PATHS], { allowFailure: true })
        fs.writeFileSync(FAILED_PATCH, `${diff.out}\n`, 'utf8')
        result.patch = FAILED_PATCH
      }
      log(`failed sources kept as ${failed.ref} (${failed.commit})`)
    } catch (error) {
      result.snapshotError = error.message
      log(`could not snapshot the failed sources: ${error.message}`)
    }
  }
  if (plan.distPrevSaved) {
    try { restoreDistPrev(); result.distRestored = true; log('dist/ restored from dist-prev/') } catch (error) { result.distError = error.message; log(`dist restore failed: ${error.message}`) }
  }
  if (plan.lastGood) {
    try { restoreTree({ commit: plan.lastGood }); result.treeRestored = true; log(`electron/ and src/ restored from ${plan.lastGood}`) } catch (error) { result.treeError = error.message; log(`source restore failed: ${error.message}`) }
  } else {
    result.treeNote = 'no last-good snapshot yet: electron/ and src/ were left as they are (the first successful upgrade records the baseline)'
    log(result.treeNote)
  }
  const attempt = await relaunchAndWait({ spec, timeoutMs: plan.healthTimeoutMs, log })
  result.relaunch = attempt
  result.health = attempt.health
  result.recovered = !!attempt.health?.ok
  return result
}

async function watch(planFile) {
  const plan = readJson(planFile)
  if (!plan) { console.error(`Plan file is missing or unreadable: ${planFile}`); process.exit(1) }
  const log = (line) => { try { fs.appendFileSync(WATCH_LOG, `${new Date().toISOString()} ${line}\n`) } catch { /* Log only. */ } }
  takeOverLock()
  log(`watcher ${process.pid} started for run ${plan.runId}`)
  const report = { ...plan.report, phase: 'relaunching', watcherPid: process.pid }
  writeReport(report)
  const spec = orbitLaunch({ electron: plan.electron, args: [RELAUNCH_FLAG] })
  try {
    const attempt = await relaunchAndWait({ spec, timeoutMs: plan.healthTimeoutMs, log })
    report.relaunch = attempt
    if (attempt.health?.ok) {
      recordCycle()
      if (plan.candidate?.commit) {
        try {
          git(['update-ref', `${REF_PREFIX}last-good`, plan.candidate.commit])
          report.lastGood = { commit: plan.candidate.commit, ref: `${REF_PREFIX}last-good` }
        } catch (error) { report.lastGoodError = error.message }
      }
      Object.assign(report, { ok: true, status: 'relaunched', nextAction: 'none', health: attempt.health })
    } else {
      const error = attempt.health ? `the new Orbit reported a failure: ${attempt.health.error || 'unknown'}` : `no health report within ${plan.healthTimeoutMs} ms`
      log(`upgrade failed: ${error}`)
      report.rollback = await rollback({ plan, spec, log })
      recordCycle()
      Object.assign(report, { ok: false, status: 'rolled-back', nextAction: report.rollback.failed ? 'inspect-failed-ref' : 'fix-and-retry', error, health: report.rollback.health })
    }
  } catch (error) {
    log(`watcher error: ${error.stack || error.message}`)
    Object.assign(report, { ok: false, status: 'failed', nextAction: 'fix-and-retry', error: error.message })
  }
  report.phase = 'done'
  report.finished = new Date().toISOString()
  writeReport(report)
  log(`done: ${report.status}`)
}

// ---------------------------------------------------------------------------------------------------------------
// The foreground run

async function main() {
  try { sweepParked() } catch { /* Housekeeping only. */ }
  const started = new Date().toISOString()
  const runId = `${Date.now().toString(36)}-${process.pid}`
  let tools = null
  let toolchainError = null
  try { tools = toolchain() } catch (error) { toolchainError = error.message }
  const sourceAtStart = newestSourceChange()
  const marker = readBuildMarker(DIST)
  const distPresent = fs.existsSync(path.join(DIST, 'index.html'))
  const upToDate = distPresent && !!marker && sourceAtStart.time <= marker.sourceNewest
  const health = readJson(HEALTH_FILE)
  const running = findOrbitProcesses()
  const runningCurrent = !!health?.ok && running.some((process_) => process_.pid === health.pid) && health.distMtime === indexMtime(DIST)
  const lastGood = tools?.git ? readRef('last-good') : null
  const steps = planSteps({ verifyOnly, noRelaunch, desktop: runDesktop })
  const plan = {
    runId, root, dryRun, force, steps, tools, toolchainError, distPresent, upToDate, newestSource: sourceAtStart.file, marker,
    running: running.map((process_) => process_.pid),
    health: health ? { ok: health.ok, pid: health.pid, startedAt: health.startedAt, distMtime: health.distMtime, error: health.error } : null,
    runningCurrent, lastGood, healthTimeoutMs,
    cycles: { used: readCycles().length, max: maxCycles, windowMinutes: cycleWindowMs / 60000 },
    relaunchCommand: tools ? `"${tools.electron}" "${root}" ${RELAUNCH_FLAG}` : null,
  }

  if (dryRun) {
    const ok = !toolchainError
    writeReport({ ok, status: ok ? 'dry-run' : 'failed', nextAction: ok ? 'run-without-dry-run' : 'fix-build-tools', timestamp: started, mode: 'dry-run', phase: 'done', ...plan })
    console.log(JSON.stringify({ ok, mode: 'dry-run', report: REPORT_FILE, ...plan }, null, 2))
    if (!ok) process.exitCode = 1
    return
  }
  if (!tools) failWithReport(`Build tools cannot be resolved: ${toolchainError}`, { runId, nextAction: 'fix-build-tools' })
  if (!tools.git) console.warn('git is not available: the last-good snapshot and the source rollback are off; dist-prev/ still is restored.')

  const skipBuild = !force && upToDate
  if (skipBuild && (runningCurrent || noRelaunch || verifyOnly)) {
    writeReport({ ok: true, status: 'up-to-date', nextAction: 'edit-source-then-rerun', runId, timestamp: started, phase: 'done', newestSource: sourceAtStart.file, marker, running: plan.running, runningCurrent })
    console.log(`Nothing changed since dist/ was built and verified (${marker.builtAt})${runningCurrent ? ' and the running Orbit serves it' : ''}. Pass --force to run the checks and rebuild anyway.`)
    console.log(`Report: ${REPORT_FILE}`)
    return
  }
  if (!verifyOnly && !noRelaunch && cycleLimitReached()) {
    writeReport({ ok: false, status: 'cycle-limit', nextAction: 'review-and-rerun-later', runId, timestamp: started, phase: 'done', cycles: plan.cycles })
    console.error(`Orbit was relaunched ${plan.cycles.used} times in the last ${plan.cycles.windowMinutes} minutes (ORBIT_UPGRADE_MAX_CYCLES=${maxCycles}). Review the changes; raise the limit or wait before the next relaunch.`)
    process.exit(2)
  }

  try { acquireLock() } catch (error) { failWithReport(error.message, { runId, status: 'locked', nextAction: 'wait-for-running-upgrade', exitCode: 2 }) }
  const { timings, step } = createTimer()
  let candidate = null
  let distPrevSaved = false
  let distDirty = false
  const details = () => ({ runId, started, timings, lastGood, candidate, distPrevSaved })

  try {
    if (skipBuild) {
      console.log(`Nothing changed since dist/ was built and verified (${marker.builtAt}); skipping the checks and the build, relaunching only.`)
      if (tools.git) candidate = snapshotTree({ label: 'candidate' })
    } else {
      await step('typecheck', () => { run('typecheck', process.execPath, [tools.tsc, '--noEmit']); run('typecheck:main', process.execPath, [tools.tsc, '-p', 'tsconfig.main.json']) })
      await step('test', () => run('test', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...testFiles()]))
      await step('smoke', () => run('smoke', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join('scripts', 'smoke-runtime.cjs')]))
      await step('main-load', () => run('main-load', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', path.join('tests', 'main-load.test.cjs')]))
      if (runDesktop) await step('smoke:desktop', () => run('smoke:desktop', process.execPath, [path.join('scripts', 'run-electron.cjs'), path.join('scripts', 'smoke-desktop.cjs')]))
      if (verifyOnly) {
        writeReport({ ok: true, status: 'verify-only', nextAction: 'build-when-ready', phase: 'done', finished: new Date().toISOString(), ...details() })
        console.log(summarize({ ok: true, status: 'verify-only', nextAction: 'build-when-ready', timings }))
        return
      }
      await step('save-previous', () => {
        distPrevSaved = saveDistPrev()
        if (tools.git) candidate = snapshotTree({ label: 'candidate' })
      })
      distDirty = true
      await step('build', () => run('build', process.execPath, [tools.vite, 'build']))
      // A source edit that landed during the checks was never verified: this build must not run.
      const sourceAtEnd = newestSourceChange()
      if (sourceAtEnd.time > sourceAtStart.time) throw new Error(`${sourceAtEnd.file} changed while the checks were running; run self-upgrade again`)
      writeBuildMarker(DIST, { builtAt: new Date().toISOString(), sourceNewest: sourceAtStart.time, sourceFile: sourceAtStart.file, commit: candidate?.head || null, candidate: candidate?.commit || null })
      distDirty = false
    }
  } catch (error) {
    let distRestored = false
    if (distDirty && distPrevSaved) { try { restoreDistPrev(); distRestored = true } catch { /* Reported below as not restored. */ } }
    failWithReport(error.message, { ...details(), distRestored })
  }

  const base = { ok: null, status: 'relaunching', nextAction: 'wait-for-health', runId, started, timings, built: !skipBuild, lastGood, candidate, distPrevSaved, healthTimeoutMs, phase: 'relaunching' }
  if (noRelaunch) {
    writeReport({ ...base, ok: true, status: 'built', nextAction: 'relaunch', phase: 'done', finished: new Date().toISOString(), relaunchCommand: plan.relaunchCommand })
    console.log(summarize({ ...base, ok: true, status: 'built', nextAction: 'relaunch' }))
    console.log(`Start or restart Orbit with: Orbit.cmd ${RELAUNCH_FLAG}`)
    return
  }

  const planFile = writeJson(PLAN_FILE, { runId, started, candidate, lastGood, distPrevSaved, built: !skipBuild, healthTimeoutMs, electron: tools.electron, report: base })
  writeReport(base)
  console.log('\n==> relaunch (detached watcher)')
  spawnWatcher(planFile)
  handOverLock()
  const final = await awaitWatcher(runId, healthTimeoutMs * 2 + 60000)
  if (!final) {
    console.log(`The relaunch watcher has not reported yet; it continues on its own. Watch ${REPORT_FILE} and ${WATCH_LOG}.`)
    process.exitCode = 2
    return
  }
  console.log(summarize(final))
  process.exitCode = final.ok ? 0 : 1
}

if (require.main === module) {
  (watchPlan ? watch(watchPlan) : main()).catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  SOURCE_ENTRIES, SNAPSHOT_PATHS, REF_PREFIX, RELAUNCH_FLAG, BUILD_MARKER,
  newestSourceChange, readBuildMarker, writeBuildMarker, acquireLock, toolPath, toolchain, testFiles, planSteps,
  createTimer, isFreshHealth, waitForHealth, snapshotTree, restoreTree, readRef, saveDistPrev, restoreDistPrev,
  replaceDirectory, orbitLaunch, matchesOrbitProcess, findOrbitProcesses, readCycles, recordCycle, cycleLimitReached,
}
