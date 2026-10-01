'use strict'

/**
 * Orbit self-upgrade: the live loop for an app that runs from this repository (Orbit.cmd / npm start).
 *
 *   lock → typecheck (tsconfig.json and tsconfig.main.json) → node --experimental-strip-types --test tests/*.test.cjs
 *   → runtime smoke → main-load test [→ smoke:desktop]
 *     (skipped with --no-verify, and when dist/orbit-build.json records that exactly these sources passed them)
 *   → dist/ saved to dist-prev/, the verified electron/ + src/ snapshotted as refs/orbit/self-upgrade/candidate
 *   → vite build, only when the renderer inputs (src/, index.html, vite.config.ts, tsconfig.json, package.json) differ
 *     from the ones dist/orbit-build.json says dist/ was built from: a runtime-only change costs no build
 *   → the restart level, from the code fingerprints (electron/fingerprint.cjs) of the files on disk and of what the
 *     running Orbit loaded (its last health report):
 *       full      shell files changed (main process, preload, IPC), runtime and renderer both changed, or no Orbit
 *                 runs: `--relaunch`
 *       runtime   only the rest of electron/ changed: `--restart-runtime` (a new runtime process, the window stays)
 *       renderer  only dist/ is newer than what the window shows: `--reload-renderer`
 *       none      the running Orbit already runs all of it: status up-to-date, nothing restarts
 *     The signal is `electron.exe <repo> <flag>`, what `Orbit.cmd <flag>` runs: the second-instance handler in
 *     electron/main.cjs acts on it; with no instance running it simply starts one.
 *   → wait ≤ 15 s for a fresh artifacts/self-upgrade-health.json, or the file ORBIT_HEALTH_FILE names (main writes one
 *     per start, runtime restart and renderer reload); on success the candidate becomes refs/orbit/self-upgrade/last-good
 *   → on failure the failed sources are kept as refs/orbit/self-upgrade/failed + artifacts/self-upgrade-failed.patch
 *     and, per level: full — Orbit processes of this repository are stopped, dist-prev/ and electron/ + src/ come
 *     back, Orbit is started again; runtime — the runtime files of electron/ come back (the files of the running main
 *     process stay) and the runtime restarts once more; renderer — dist-prev/ and src/ come back (when this run built
 *     them) and the window reloads. A runtime or renderer retry that fails as well ends in a stop and a fresh start.
 *     The report says `rolled-back`. Sources come back only from the code that ran before the restart
 *     (rollbackBase), part by part: electron/ from a snapshot with the shell and runtime hashes, src/ from one with the
 *     renderer hash of that instance's last health report (what the window was running) — the record
 *     `--record-running` made of that instance, else last-good when it is that very code; a part without such a
 *     snapshot, and every part when no hashes are known, is left as it is ("no trustworthy rollback base"; for src/
 *     only dist/ comes back). They come back through a temporary index (never the real one, nor its lock) in overlay
 *     mode: of the files the snapshot lacks, only those the failed change added go (the report lists them), files
 *     created after it stay. A missing base and a restore that failed ("sources not restored") are named in the
 *     report and in the intent's error.
 *
 * Continuation (restart_orbit, docs/TECH-DEBT.md item 1): when the script runs for an Orbit run (ORBIT_RUN_ID) and
 * knows the resume file (--intent-file, else ORBIT_RESUME_FILE), a runtime or full restart leaves the intent to
 * continue that run: pending-resume.json, written atomically right before the signal (the runtime that shuts down reads
 * it to finish the run as `restarting`, the next one continues it once the watcher has given its word). A healthy
 * restart adds `verdict: 'relaunched'` + `verdictAt`; a rollback adds outcome `rolled-back`, the error and the patch
 * before the old code starts again (a watcher that fails unexpectedly: `verdict: 'failed'` + error). A renderer reload
 * keeps the runtime and its runs, so it leaves no intent; the script then waits for the watcher and exits with the
 * result.
 *
 * `--record-running [--pid N --started-at MS --shell-hash H --runtime-hash H --renderer-hash H]` (main runs it detached
 * after every healthy start, runtime restart and renderer reload; missing values come from the health report of that
 * pid): snapshot electron/ + src/ as refs/orbit/self-upgrade/running with a temporary index (never the real one) and
 * write artifacts/self-upgrade-running.json { commit, pid, startedAt, recordedAt, shellHash, runtimeHash,
 * rendererHash }.
 *
 * The restart phase runs in a watcher process detached from this one: when an agent runs the upgrade from inside
 * Orbit, a runtime or full restart stops that agent's command tree, and the health check and the rollback must
 * outlive it. The foreground script waits for the watcher's report and prints it.
 *
 * One upgrade at a time: artifacts/self-upgrade.lock, kept fresh by its holder (see the Lock section; the restart host
 * removes the lock of a script it killed with releaseLockOf). A stop: when the user stops the run whose restart is
 * under way, the restart host writes artifacts/self-upgrade-cancel.json { requestedAt, reason }; the script looks for
 * it before every step, the watcher right before it writes the intent and right before it signals. A marker from the
 * script's start or later ends it with status `cancelled`: no intent, no signal, the lock released. Under `npm run
 * dev` (ORBIT_DEV=1) the script restarts nothing (status `dev-mode`): a relaunch would stop the dev server;
 * --dry-run, --no-relaunch and --verify-only still run.
 *
 * Flags:
 *   --dry-run               print the plan and the level it would choose, check the tools; nothing runs
 *   --no-relaunch           verify and build only; the report says what to run next
 *   --verify-only           stop after the checks (alias: --skip-package)
 *   --no-verify             skip typecheck, tests, smoke and main-load; build, restart, health and rollback stay
 *   --force                 verify and rebuild even when nothing changed (the new build makes it at least a reload;
 *                           add --level full for a relaunch)
 *   --level <level>         auto (default) | full | runtime | renderer
 *   --reason <text>         why Orbit restarts (intent, report)
 *   --continue-with <text>  what the continued run is asked to do (intent)
 *   --intent-file <path>    where the intent goes (default: ORBIT_RESUME_FILE)
 *   --desktop               also run smoke:desktop (default: skipped; --skip-desktop keeps it off)
 *   --record-running        record the code of the running instance (see above) and exit
 *   --mark-build            write dist/orbit-build.json for the dist/ `npm run build` just made (not verified) and exit
 *   --watch <plan>          internal: the detached restart phase
 *
 * Env: ORBIT_UPGRADE_MAX_CYCLES runtime/full restarts per ORBIT_UPGRADE_CYCLE_WINDOW_MIN minutes (default 3 per 30;
 *      renderer reloads are not limited), ORBIT_UPGRADE_HEALTH_TIMEOUT_MS (default 15000), ORBIT_USER_DATA (the profile
 *      of the Orbit to restart — Orbit sets it for its agents' commands; it wins over the health report's, a health
 *      report of another profile is not used to pick the level, and a freshly started Orbit inherits it),
 *      ORBIT_HEALTH_FILE (where main writes its health report, as electron/main.cjs reads it: the script reads and
 *      waits for the report there; "0" or empty — no report, so nothing restarts: status no-health-report),
 *      ORBIT_RUN_ID / ORBIT_CHAT_ID / ORBIT_PROJECT_ID / ORBIT_AGENT_ID / ORBIT_RESUME_FILE (Orbit sets them for its
 *      agents' commands), ORBIT_RESTART_SOURCE=tool (restart_orbit), ORBIT_DEV=1 (npm run dev: nothing restarts).
 *
 * Exit: 0 applied or up to date; 1 failure (arguments, tools, checks, build, rolled back); 2 cycle limit, lock, dev
 *       mode, no health report (ORBIT_HEALTH_FILE=0), cancelled, or a watcher that has not reported in time.
 * Reports: artifacts/self-upgrade-last.json (status, level, step timings, health, rollback, intentFile, intentWritten,
 *          failures of a failed check), artifacts/self-upgrade-checks.log (the whole output of the checks and the build),
 *          artifacts/self-upgrade-watch.log.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { SHELL_FILES, RENDERER_INPUTS, fingerprints, rendererHash } = require('../electron/fingerprint.cjs')

const root = path.resolve(__dirname, '..')

/**
 * Where main writes its health report (electron/main.cjs healthFile, electron/resume.mts healthFilePath):
 * ORBIT_HEALTH_FILE, a relative path from the repository; null for "0" or an empty value (smoke, tests: no report);
 * else artifacts/self-upgrade-health.json.
 */
function healthFileFor(base, env) {
  const value = env.ORBIT_HEALTH_FILE
  if (value === undefined) return path.join(base, 'artifacts', 'self-upgrade-health.json')
  return value && value !== '0' ? path.resolve(base, value) : null
}

/**
 * Every file the loop reads or writes for the repository at `base`; tests pass a temporary folder. `env` names the
 * health file (ORBIT_HEALTH_FILE): the script's own environment for PATHS, none (the default file) for a test's paths.
 */
function upgradePaths(base = root, env = {}) {
  const artifacts = path.join(base, 'artifacts')
  const health = healthFileFor(base, env)
  const extension = health ? path.extname(health) : ''
  return {
    root: base,
    artifacts,
    dist: path.join(base, 'dist'),
    distPrev: path.join(base, 'dist-prev'),
    health,
    // The report a restart moves aside before its signal, next to it: self-upgrade-health-prev.json by default.
    healthPrev: health ? path.join(path.dirname(health), `${path.basename(health, extension)}-prev${extension}`) : null,
    report: path.join(artifacts, 'self-upgrade-last.json'),
    plan: path.join(artifacts, 'self-upgrade-plan.json'),
    cycles: path.join(artifacts, 'self-upgrade-cycles.json'),
    watchLog: path.join(artifacts, 'self-upgrade-watch.log'),
    // The whole output of the last run's checks and build: the console and the agent's error show only its end.
    checksLog: path.join(artifacts, 'self-upgrade-checks.log'),
    failedPatch: path.join(artifacts, 'self-upgrade-failed.patch'),
    running: path.join(artifacts, 'self-upgrade-running.json'),
    // Written by the restart host when the user stops the run whose restart is under way (cancelRequested).
    cancel: path.join(artifacts, 'self-upgrade-cancel.json'),
  }
}
const PATHS = upgradePaths(root, process.env)
const DIST = PATHS.dist
const DIST_PREV = PATHS.distPrev
const HEALTH_FILE = PATHS.health
const REPORT_FILE = PATHS.report
const PLAN_FILE = PATHS.plan
const CYCLES_FILE = PATHS.cycles
const WATCH_LOG = PATHS.watchLog
const BUILD_MARKER = 'orbit-build.json'
const RELAUNCH_FLAG = '--relaunch'
/** The second-instance flag of each restart level (electron/main.cjs acts on it; Orbit.cmd passes it on). */
const LEVEL_FLAGS = Object.freeze({ full: RELAUNCH_FLAG, runtime: '--restart-runtime', renderer: '--reload-renderer' })
const LEVELS = ['auto', 'full', 'runtime', 'renderer']
const REF_PREFIX = 'refs/orbit/self-upgrade/'
const SNAPSHOT_PATHS = ['electron', 'src']
// Inputs the running application is made of: what the checks verify.
const SOURCE_ENTRIES = ['electron', 'src', 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json']
// What `vite build` reads (RENDERER_INPUTS, electron/fingerprint.cjs): a change anywhere else needs no new dist/.
const DEFAULT_HEALTH_TIMEOUT_MS = 15000
const DEFAULT_REASON = 'самообновление Orbit (npm run self-upgrade)'
const DEFAULT_CONTINUE_WITH = 'Продолжи задачу с того места, где остановился перед перезапуском Orbit.'
const NO_BASE_NOTE = 'sources left as they are (no trustworthy rollback base)'
const DEV_MODE_MESSAGE = 'Orbit runs from the Vite dev server (ORBIT_DEV=1, npm run dev): restarting it would stop npm run dev (its Electron and Vite end together). Nothing was restarted. Restart Orbit by hand, or pass --no-relaunch or --verify-only to verify and build without a restart.'
const NO_HEALTH_MESSAGE = 'Orbit writes no health report (ORBIT_HEALTH_FILE=0): a restart could be neither checked nor rolled back. Nothing was restarted. Restart Orbit by hand, or pass --no-relaunch or --verify-only to verify and build without a restart.'

// Flags that take a value, as `--reason text` or `--reason=text`; any other `--x` is a switch.
const VALUE_FLAGS = new Set(['--watch', '--reason', '--continue-with', '--level', '--intent-file', '--pid', '--started-at', '--shell-hash', '--runtime-hash', '--renderer-hash'])

/** @returns {{ flags: Set<string>, values: Record<string, string>, errors: string[] }} */
function parseArgs(args) {
  const flags = new Set()
  const values = {}
  const errors = []
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index])
    if (!arg.startsWith('--')) continue
    const equals = arg.indexOf('=')
    const name = equals > 0 ? arg.slice(0, equals) : arg
    if (!VALUE_FLAGS.has(name)) { flags.add(arg); continue }
    if (equals > 0) values[name] = arg.slice(equals + 1)
    else if (index + 1 < args.length) values[name] = String(args[++index])
    else errors.push(`${name} needs a value`)
  }
  return { flags, values, errors }
}

const cli = parseArgs(process.argv.slice(2))
const flags = cli.flags
const watchPlan = cli.values['--watch'] ?? null
const dryRun = flags.has('--dry-run')
const noRelaunch = flags.has('--no-relaunch')
const verifyOnly = flags.has('--verify-only') || flags.has('--skip-package')
const noVerify = flags.has('--no-verify')
const force = flags.has('--force')
const runDesktop = flags.has('--desktop') && !flags.has('--skip-desktop')
const forcedLevel = cli.values['--level'] ?? 'auto'
const healthTimeoutMs = Math.max(1000, Number(process.env.ORBIT_UPGRADE_HEALTH_TIMEOUT_MS) || DEFAULT_HEALTH_TIMEOUT_MS)
const maxCycles = Math.max(1, Math.floor(Number(process.env.ORBIT_UPGRADE_MAX_CYCLES) || 3))
const cycleWindowMs = Math.max(1, Number(process.env.ORBIT_UPGRADE_CYCLE_WINDOW_MIN) || 30) * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Blocks the thread for `ms` (a short retry pause inside a synchronous step). */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}
/**
 * Replace `file` as a whole: a reader sees the old content or the new, never a half-written file. A rename over a
 * file another process holds open for a moment fails on Windows (EPERM, EBUSY); it is retried for up to half a second.
 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temporary, file)
      return file
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try { fs.unlinkSync(temporary) } catch { /* Already gone. */ }
        throw error
      }
      sleepSync(25)
    }
  }
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
// Sources and the build marker (dist/orbit-build.json: which renderer inputs dist/ was built from, which sources
// passed the checks)

function newestSourceChange(base = root, entries = SOURCE_ENTRIES) {
  let newest = { time: 0, file: null }
  const visit = (target) => {
    let stat
    try { stat = fs.statSync(target) } catch { return }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) if (name !== 'node_modules') visit(path.join(target, name))
    } else if (stat.mtimeMs > newest.time) newest = { time: stat.mtimeMs, file: path.relative(base, target) }
  }
  for (const entry of entries) visit(path.join(base, entry))
  return newest
}

/**
 * The renderer inputs: their content hash (electron/fingerprint.cjs rendererHash, the one main puts into its health
 * reports; line endings do not count) and the newest file.
 */
function rendererState(base = root) {
  const newest = newestSourceChange(base, RENDERER_INPUTS)
  return { hash: rendererHash(base), newest: newest.time, file: newest.file }
}

/** Missing for a dist/ made by `npm run build` alone: provenance unknown, so the next upgrade verifies and rebuilds. */
function readBuildMarker(dist = DIST) {
  const marker = readJson(path.join(dist, BUILD_MARKER))
  return marker && Number.isFinite(marker.sourceNewest) ? marker : null
}

function writeBuildMarker(dist, marker) {
  return writeJson(path.join(dist, BUILD_MARKER), marker)
}

/** A rollback puts back the record the run started with, or none when there was none. */
function restoreBuildMarker(dist, marker) {
  const file = path.join(dist, BUILD_MARKER)
  if (marker) return writeJson(file, marker)
  fs.rmSync(file, { force: true })
  return null
}

// Records written before the restart levels have no version: one mtime (`sourceNewest`) over every source.
const markerVersion = (marker) => Number(marker?.version) || 1

/**
 * Whether dist/ must be built again: --force, no dist/, no record of its build, or renderer inputs other than the ones
 * the record says it was built from.
 */
function buildDecision({ marker = null, renderer, distPresent = true, force: forced = false }) {
  if (forced) return { needed: true, reason: '--force' }
  if (!distPresent) return { needed: true, reason: 'dist/index.html is missing' }
  if (!marker) return { needed: true, reason: 'dist/ has no build record (built outside self-upgrade)' }
  if (markerVersion(marker) >= 2) {
    return typeof marker.rendererHash === 'string' && marker.rendererHash === renderer.hash
      ? { needed: false, reason: 'the renderer inputs are the ones dist/ was built from' }
      : { needed: true, reason: 'the renderer inputs changed since dist/ was built' }
  }
  return renderer.newest <= marker.sourceNewest
    ? { needed: false, reason: 'no renderer input is newer than the build' }
    : { needed: true, reason: `${renderer.file} changed since dist/ was built` }
}

/**
 * Whether the checks must run: never with --no-verify, always with --force, otherwise unless the record says that
 * exactly these sources (fingerprints of the shell, the runtime and the renderer inputs) passed them.
 */
function verifyDecision({ marker = null, fingerprint, renderer, sourceNewest = Infinity, noVerify: skip = false, force: forced = false }) {
  if (skip) return { needed: false, reason: '--no-verify' }
  if (forced) return { needed: true, reason: '--force' }
  if (!marker) return { needed: true, reason: 'no record of verified sources' }
  if (markerVersion(marker) >= 2) {
    const verified = marker.verified
    if (verified && verified.shell === fingerprint.shell && verified.runtime === fingerprint.runtime && verified.renderer === renderer.hash) {
      return { needed: false, reason: `nothing changed since the checks passed (${verified.at})` }
    }
    return { needed: true, reason: verified ? 'the sources changed since the checks last passed' : 'the current build was not verified' }
  }
  return sourceNewest <= marker.sourceNewest
    ? { needed: false, reason: `nothing changed since dist/ was built and verified (${marker.builtAt})` }
    : { needed: true, reason: 'the sources changed since the checks last passed' }
}

/**
 * The record after a run that verified and/or built: `covers` + `rendererHash` say which renderer inputs dist/ was
 * built from, `verified` which sources passed the checks. What this run did not redo is carried over; `rendererHash`
 * is set either way, since a run that skipped the build has just found dist/ up to date with these inputs.
 */
function nextBuildMarker({ previous = null, built = false, verified = false, renderer, fingerprint, source, candidate = null, now = new Date().toISOString() }) {
  const marker = { ...(previous || {}), version: 2, updatedAt: now, sourceNewest: source.time, sourceFile: source.file, covers: RENDERER_INPUTS, rendererHash: renderer.hash }
  if (built) Object.assign(marker, { builtAt: now, rendererNewest: renderer.newest, rendererFile: renderer.file, commit: candidate?.head || null, candidate: candidate?.commit || null })
  if (verified) marker.verified = { at: now, covers: SOURCE_ENTRIES, shell: fingerprint.shell, runtime: fingerprint.runtime, renderer: renderer.hash }
  else if (markerVersion(previous) < 2 || !marker.verified) marker.verified = null
  return marker
}

// ---------------------------------------------------------------------------------------------------------------
// Lock: one upgrade at a time; the watcher takes it over for the relaunch phase.
//
// artifacts/self-upgrade.lock = { version: 2, pid, nonce, role: 'upgrade' | 'watcher', startedAt }, created
// exclusively. Its holder touches its mtime every LOCK_HEARTBEAT_MS; a lock whose mtime is older than LOCK_STALE_MS is
// stale whatever its pid says (a holder killed with taskkill /f never runs its exit handler, and Windows reuses pids),
// and so is one whose process is gone. The foreground hands the lock to its watcher by nonce: the plan carries it, and
// the watcher takes over only that lock. The restart host (runtime side), which kills the script when the user stops
// the run, removes the lock of the script it killed with releaseLockOf(pid). A lock without a nonce was written by an
// older script, which kept none fresh: it counts while its process lives, for up to 45 minutes.

const LOCK_HEARTBEAT_MS = 10000
const LOCK_STALE_MS = 60000
const LEGACY_LOCK_MS = 45 * 60 * 1000

/** @type {{ file: string, nonce: string, timer: NodeJS.Timeout | null, owned: boolean } | null} */
let heldLock = null
let lockExitHook = false

function lockFile(base = root) { return path.join(base, 'artifacts', 'self-upgrade.lock') }
function newLock(role) { return { version: 2, pid: process.pid, nonce: crypto.randomBytes(8).toString('hex'), role, startedAt: Date.now() } }

/** The lock file's holder; `missing` only when the file is gone (an unreadable one may be mid-replace). */
function readLock(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { return { missing: error.code === 'ENOENT', holder: null } }
  try {
    const holder = JSON.parse(text)
    return { missing: false, holder: holder && typeof holder === 'object' && !Array.isArray(holder) ? holder : null }
  } catch { return { missing: false, holder: null } }
}

/** Deletes the lock file when `test(holder)` says so; false when it was not deleted. */
function removeLockIf(file, test) {
  try {
    if (!test(readLock(file).holder)) return false
    fs.unlinkSync(file)
    return true
  } catch { return false }
}

function processAlive(pid) {
  if (!(Number(pid) > 0)) return false
  // EPERM means the process exists but belongs to someone else (elevated, another user): still running.
  try { process.kill(Number(pid), 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** Whether the lock at `file` belongs to a live upgrade: `{ held, holder, who }` (who: for the message). */
function lockHolder(file, { staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch { return { held: false, holder: null, why: 'gone' } }
  const { holder } = readLock(file)
  const age = now - mtime
  if (!holder) return age < staleMs ? { held: true, holder: null, who: 'a lock file that is being written' } : { held: false, holder: null, why: 'unreadable' }
  const who = `pid ${holder.pid}, ${holder.role || 'upgrade'}`
  if (!processAlive(holder.pid)) return { held: false, holder, why: 'its process is gone' }
  if (holder.nonce) return age <= staleMs ? { held: true, holder, who } : { held: false, holder, why: `no heartbeat for ${Math.round(age / 1000)} s` }
  return now - Number(holder.startedAt) < LEGACY_LOCK_MS ? { held: true, holder, who } : { held: false, holder, why: 'an older script\'s lock, too old' }
}

function stopHeartbeat(lock) {
  if (lock?.timer) { clearInterval(lock.timer); lock.timer = null }
}

/** This process holds the lock `nonce` in `file`: it touches it every `heartbeatMs` and removes it on exit. */
function holdLock(file, nonce, heartbeatMs) {
  stopHeartbeat(heldLock)
  const lock = { file, nonce, timer: null, owned: true }
  lock.timer = setInterval(() => {
    const { missing, holder } = readLock(file)
    // Released (the restart host after a stop) or taken over as stale: not ours to keep fresh any more.
    if (missing || (holder && holder.nonce !== nonce)) { stopHeartbeat(lock); return }
    if (!holder) return
    try { const now = new Date(); fs.utimesSync(file, now, now) } catch { /* Held open for a moment: the next beat. */ }
  }, Math.max(10, heartbeatMs))
  lock.timer.unref?.()
  heldLock = lock
  if (!lockExitHook) {
    lockExitHook = true
    process.on('exit', () => {
      const current = heldLock
      if (current?.owned) removeLockIf(current.file, (holder) => holder?.nonce === current.nonce)
    })
  }
  return lock
}

/**
 * Takes the lock, or throws when a live upgrade holds it (`Another self-upgrade is already running`). A stale lock is
 * replaced. Returns the lock file.
 */
function acquireLock(base = root, { heartbeatMs = LOCK_HEARTBEAT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const file = lockFile(base)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = newLock('upgrade')
    try {
      fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx' })
      holdLock(file, record.nonce, heartbeatMs)
      return file
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const found = lockHolder(file, { staleMs })
    if (found.held) throw new Error(`Another self-upgrade is already running (${found.who}). Wait for it to finish.`)
    // Stale: removed, unless another script replaced it meanwhile.
    removeLockIf(file, (holder) => (holder?.nonce ?? null) === (found.holder?.nonce ?? null) && (holder?.pid ?? null) === (found.holder?.pid ?? null))
  }
  throw new Error('Could not acquire the self-upgrade lock.')
}

/** The nonce of the lock this process holds (the plan carries it to the watcher), or null. */
function heldLockNonce() { return heldLock?.owned ? heldLock.nonce : null }

/** The foreground started its watcher: it stops keeping the lock fresh and leaves it on exit; the watcher takes it over. */
function handOverLock() {
  if (!heldLock) return
  heldLock.owned = false
  stopHeartbeat(heldLock)
}

/**
 * The watcher takes over the lock the foreground handed over: only while it is still that lock (`nonce`, from the
 * plan). A lock that is gone was released by the restart host after it stopped the foreground (the user's stop); one
 * with another nonce belongs to another upgrade. Either way nothing may restart: false.
 */
function takeOverLock(base = root, { nonce = null, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
  const file = lockFile(base)
  if (nonce && readLock(file).holder?.nonce !== nonce) return false
  const record = newLock('watcher')
  writeJsonAtomic(file, record)
  holdLock(file, record.nonce, heartbeatMs)
  return true
}

/** The holder is done: its heartbeat stops and the lock goes, when it is still its own. */
function releaseLock() {
  const lock = heldLock
  if (!lock) return false
  stopHeartbeat(lock)
  const owned = lock.owned
  lock.owned = false
  return owned && removeLockIf(lock.file, (holder) => holder?.nonce === lock.nonce)
}

/**
 * For the restart host (runtime side): after it killed the script (taskkill /f skips the script's exit handler), it
 * removes the lock that script held — only a lock whose pid is `pid`; a watcher that has taken it over keeps it (the
 * cancel marker stops that one). Returns whether a lock was removed.
 */
function releaseLockOf(pid, base = root) {
  return Number(pid) > 0 && removeLockIf(lockFile(base), (holder) => Number(holder?.pid) === Number(pid))
}

// ---------------------------------------------------------------------------------------------------------------
// Stop: the restart host's cancel marker (artifacts/self-upgrade-cancel.json { requestedAt: <ms>, reason })

/** The stop the user asked for at or after `since` (the script's start), or null. */
function cancelRequested(paths = PATHS, since = NaN) {
  const marker = readJson(paths.cancel)
  const at = Number(marker?.requestedAt)
  if (!Number.isFinite(at) || !(at >= Number(since))) return null
  return { requestedAt: at, reason: typeof marker.reason === 'string' && marker.reason ? marker.reason : 'cancelled' }
}

/** What the restart host writes when the user stops a run whose restart script runs (exported for it and for tests). */
function requestCancel(reason = 'user-stop', base = root, now = Date.now()) {
  return writeJsonAtomic(upgradePaths(base).cancel, { requestedAt: now, reason })
}

/** What the restart host does before it starts a new request. */
function clearCancel(base = root) {
  fs.rmSync(upgradePaths(base).cancel, { force: true })
}

/** A stop the user asked for while the script ran: nothing restarts. */
class CancelledError extends Error {
  constructor(stop, when) {
    super(`cancelled (${stop.reason}) ${when}: nothing was restarted`)
    this.name = 'CancelledError'
    this.stop = stop
  }
}

/** The script's start as the plan records it (the cancel marker must be at least as new). */
function planStart(plan) {
  const at = Number(plan?.startedMs)
  return Number.isFinite(at) && at > 0 ? at : Date.parse(plan?.started)
}

// ---------------------------------------------------------------------------------------------------------------
// Steps with timings

/** `beforeStep(name)` runs at every step boundary and may throw to stop the run there (a user's stop). */
function createTimer(log = console.log, beforeStep = null) {
  const timings = []
  const step = async (name, action) => {
    if (beforeStep) beforeStep(name)
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

/**
 * A check or the build, with its output passed through, appended to `log` (the whole output of this run's steps: the
 * console and the agent's error show only its end) and searched for what failed: a failed step's error names the failed
 * tests and carries them as `failures` (failureCollector). Asynchronous, so that the lock's heartbeat goes on meanwhile.
 */
function run(label, command, commandArgs, { log = null, cwd = root, stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const found = failureCollector(cwd)
    let fd = null
    const closeLog = () => { if (fd !== null) { try { fs.closeSync(fd) } catch { /* Closed already. */ } fd = null } }
    const toLog = (chunk) => { if (fd !== null) { try { fs.writeSync(fd, chunk) } catch { closeLog() } } }
    if (log) { try { fd = fs.openSync(log, 'a') } catch { fd = null } }
    toLog(`\n==> ${label}\n`)
    const child = spawn(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, env: process.env })
    child.stdout.on('data', (chunk) => { stdout.write(chunk); toLog(chunk); found.feed(chunk) })
    child.stderr.on('data', (chunk) => { stderr.write(chunk); toLog(chunk) })
    child.on('error', (error) => { closeLog(); reject(error) })
    child.on('close', (code, signal) => {
      closeLog()
      if (code === 0) return resolve(undefined)
      const { failures, total } = found.result()
      const names = failures.map((item) => item.name).join(', ')
      const error = new Error(`${label} exited with ${code ?? signal}${total ? ` (${total} failed: ${names.length > 300 ? `${names.slice(0, 300)}…` : names})` : ''}`)
      reject(Object.assign(error, { failures, failuresTotal: total }))
    })
  })
}

const FAILURE_LIMIT = 12
const FAILURE_CHARS = 300
/**
 * What failed, read from a check's output as it streams by: node:test's TAP `not ok` entries with the error and the
 * location from their YAML block, and TypeScript's `error TS` lines. Left out: a test that failed only because a subtest
 * did (failureType subtestsFailed; the subtest is listed itself) and a failing TODO test. `feed` takes chunks, `result`
 * ends the input and returns the first `limit` failures and how many there were in all.
 */
function failureCollector(base = root, limit = FAILURE_LIMIT) {
  const decoder = new StringDecoder('utf8')
  const failures = []
  let total = 0, rest = '', entry = null, blockField = null
  const clipped = (text) => (text.length > FAILURE_CHARS ? `${text.slice(0, FAILURE_CHARS)}…` : text)
  const add = (item) => { total++; if (failures.length < limit) failures.push(item) }
  // Where a test is, relative to the repository when it is inside it.
  const place = (value) => {
    const match = /^(.*):(\d+):(\d+)$/.exec(value)
    if (!match) return value
    const relative = path.relative(base, match[1])
    const file = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : match[1]
    return `${file}:${match[2]}:${match[3]}`
  }
  // A one-line value of the YAML block is util.inspect's quoted string literal.
  const unquoted = (value) => {
    const text = value.trim()
    if (text.length < 2 || !/^['"`]$/.test(text[0]) || text.at(-1) !== text[0]) return text
    return text.slice(1, -1).replace(/\\(.)/g, (_, char) => ({ n: ' ', r: '', t: ' ' })[char] ?? char)
  }
  const settle = () => {
    if (entry && entry.type !== 'subtestsFailed') add({ name: clipped(entry.name), ...(entry.error ? { error: clipped(entry.error) } : {}), ...(entry.location ? { location: entry.location } : {}) })
    entry = null
    blockField = null
  }
  const line = (text) => {
    const tap = /^\s*(not )?ok \d+ - (.*)$/.exec(text)
    if (tap) {
      settle()
      if (tap[1] && !/(?:^|\s)# TODO\b/i.test(tap[2])) entry = { name: tap[2].replace(/\\#/g, '#').trim(), error: '', location: '', type: '' }
      return
    }
    if (entry) {
      if (/^\s*\.\.\.\s*$/.test(text)) return settle()
      // The first line of a multi-line value (`error: |-`) stands for all of it.
      if (blockField) { if (text.trim()) { entry[blockField] = text.trim(); blockField = null }; return }
      const field = /^\s*(error|location|failureType):\s*(.*)$/.exec(text)
      if (!field) return
      const key = field[1] === 'failureType' ? 'type' : field[1]
      if (/^[|>][-+]?$/.test(field[2].trim())) blockField = key
      else entry[key] = key === 'location' ? place(unquoted(field[2])) : unquoted(field[2])
      return
    }
    const ts = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(text) || /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(text)
    if (ts) return add({ name: `${ts[1].split(path.sep).join('/')}:${ts[2]}:${ts[3]}`, error: clipped(`${ts[4]}: ${ts[5]}`) })
    // An error of the compiler's setup, with no file (a bad tsconfig.json, an unknown option).
    const general = /^error (TS\d+): (.*)$/.exec(text)
    if (general) add({ name: 'tsc', error: clipped(`${general[1]}: ${general[2]}`) })
  }
  const feed = (chunk) => {
    const parts = (rest + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split('\n')
    rest = parts.pop() ?? ''
    // A line that never ends (binary output) is not kept whole.
    if (rest.length > 1 << 16) rest = rest.slice(-(1 << 16))
    for (const part of parts) line(part.replace(/\r$/, ''))
  }
  const result = () => {
    const last = rest + decoder.end()
    rest = ''
    if (last) line(last.replace(/\r$/, ''))
    settle()
    return { failures, total }
  }
  return { feed, result }
}

/** The lines that end a failed run's output: what failed (failureCollector) and where the whole output of the checks is. */
function failureSummary({ failures = [], failuresTotal = failures.length, checksLog = null } = {}) {
  const lines = failures.map((item) => `  - ${item.name}${item.error ? ` — ${item.error}` : ''}${item.location ? ` (${item.location})` : ''}`)
  if (lines.length) lines.unshift(`Failed: ${failuresTotal}${failuresTotal > failures.length ? `, the first ${failures.length}:` : ':'}`)
  if (checksLog) lines.push(`Whole output of the checks: ${checksLog}`)
  return lines
}

/** Starts this run's log of the checks and the build; null when it cannot be written (the steps run without it). */
function startChecksLog(file, runId) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `Orbit self-upgrade ${runId}: the output of the checks and the build, ${new Date().toISOString()}\n`)
    return file
  } catch { return null }
}

// ---------------------------------------------------------------------------------------------------------------
// Git snapshots of electron/ and src/ (the real index is never touched)

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'orbit-self-upgrade', GIT_AUTHOR_EMAIL: 'self-upgrade@orbit.local',
  GIT_COMMITTER_NAME: 'orbit-self-upgrade', GIT_COMMITTER_EMAIL: 'self-upgrade@orbit.local',
}

/** `input` goes to stdin; `raw` keeps stdout as it is (NUL-separated lists). */
function git(args, { cwd = root, env = {}, allowFailure = false, input = undefined, raw = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, ...(input === undefined ? {} : { input }) })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  return { ok: result.status === 0, out: raw ? result.stdout || '' : (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

/** A fresh path for a temporary GIT_INDEX_FILE: snapshots and restores never use the real index or its lock. */
function temporaryIndex() {
  return path.join(os.tmpdir(), `orbit-upgrade-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function readRef(label, cwd = root) {
  const result = git(['rev-parse', '--verify', '--quiet', `${REF_PREFIX}${label}^{commit}`], { cwd, allowFailure: true })
  return result.ok ? result.out : null
}

function headCommit(cwd = root) {
  const result = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, allowFailure: true })
  return result.ok && result.out ? result.out : null
}

/**
 * The working-tree state of electron/ and src/ (modified, new and deleted files alike; `git stash create` would miss
 * new files) as a commit behind refs/orbit/self-upgrade/<label>. A temporary index keeps the real one untouched, so
 * it is safe while an agent edits files. `fingerprint` (the code hashes of these files: shell, runtime and, when
 * given, renderer) goes into the message, where snapshotInfo reads it back; `updateRef: false` leaves the ref for the
 * caller to set.
 */
function snapshotTree({ cwd = root, label, paths = SNAPSHOT_PATHS, fingerprint = null, updateRef = true } = {}) {
  if (!label) throw new Error('snapshotTree needs a label')
  const index = temporaryIndex()
  const env = { GIT_INDEX_FILE: index }
  try {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, allowFailure: true })
    if (head.ok) git(['read-tree', 'HEAD'], { cwd, env })
    else git(['read-tree', '--empty'], { cwd, env })
    git(['add', '-A', '--', ...paths], { cwd, env })
    const tree = git(['write-tree'], { cwd, env }).out
    const hashes = fingerprint ? ['', `shell ${fingerprint.shell}`, `runtime ${fingerprint.runtime}`, ...(fingerprint.renderer ? [`renderer ${fingerprint.renderer}`] : [])] : []
    const message = [`orbit self-upgrade ${label} ${new Date().toISOString()}`, ...hashes].join('\n')
    const commit = git(['commit-tree', tree, ...(head.ok ? ['-p', head.out] : []), '-m', message], { cwd, env: { ...env, ...SNAPSHOT_IDENTITY } }).out
    if (updateRef) git(['update-ref', `${REF_PREFIX}${label}`, commit], { cwd })
    return { label, ref: `${REF_PREFIX}${label}`, commit, tree, head: head.ok ? head.out : null }
  } finally {
    try { fs.unlinkSync(index) } catch { /* Never created. */ }
  }
}

/** What a snapshot commit says about itself: the commit it was taken on and the code fingerprints of its message. */
function snapshotInfo(commit, cwd = root) {
  if (!commit) return null
  const result = git(['show', '-s', '--format=%P%x00%B', commit], { cwd, allowFailure: true })
  if (!result.ok) return null
  const [parents, body = ''] = result.out.split('\0')
  const hash = (name) => new RegExp(`^${name} ([0-9a-f]{40})\\s*$`, 'm').exec(body)?.[1] || null
  return { commit, base: parents.trim().split(/\s+/)[0] || null, shellHash: hash('shell'), runtimeHash: hash('runtime'), rendererHash: hash('renderer') }
}

/**
 * Where a rollback takes the sources from: only the code that ran, healthy, before the restart — never an older state
 * (a last-good taken long ago would undo everything since) nor a newer one — part by part: `parts` are what the
 * rollback puts back, 'electron' (a snapshot fits when its shell and runtime hashes are the ones the instance's health
 * report gave) and 'src' (when its renderer hash is the report's: the renderer inputs the window was running).
 * Candidates:
 * 1. the running record (artifacts/self-upgrade-running.json, written by --record-running after every healthy start,
 *    runtime restart and renderer reload) when it is the record of that instance: same pid and startedAt;
 * 2. last-good, by the fingerprints in its snapshot message alone.
 * The base is the candidate that fits the most parts (the record on a tie); a part it does not fit is left as it is
 * (`skipped`, the report and the intent say so), and so is every part when none fits. That includes every case without
 * known hashes — no Orbit ran, or one that predates fingerprints: nothing shows which state ran, and a snapshot on the
 * current HEAD can still be far behind the uncommitted work in the tree. (An instance without any hashes is still
 * identified by its own record for electron/; src/ needs the renderer hash, since a renderer reload may have followed
 * the record.) `unknown` explains a missing `previous`.
 * @returns {{ source: 'running' | 'last-good' | null, commit: string | null, reason: string, parts: string[], skipped: string[], skippedReason?: string }}
 */
function rollbackBase({ running = null, previous = null, lastGood = null, parts = ['electron', 'src'], unknown = null } = {}) {
  const none = (reason) => ({ source: null, commit: null, reason, parts: [], skipped: [...parts] })
  if (!previous) return none(unknown || 'no Orbit ran before this restart, so no state is known to work')
  const electronKnown = !!(previous.shellHash && previous.runtimeHash)
  const rendererKnown = typeof previous.rendererHash === 'string' && !!previous.rendererHash
  const own = !!running?.commit && Number(running.pid) === Number(previous.pid) && Number(running.startedAt) === Number(previous.startedAt)
  const fits = (snapshot, isOwn) => parts.filter((part) => (part === 'electron'
    ? (electronKnown ? snapshot.shellHash === previous.shellHash && snapshot.runtimeHash === previous.runtimeHash : isOwn)
    : rendererKnown && snapshot.rendererHash === previous.rendererHash))
  const candidates = []
  if (own) candidates.push({ source: 'running', commit: running.commit, parts: fits(running, true), reason: `the code pid ${running.pid} was running (recorded ${running.recordedAt || 'after its start'})` })
  if (lastGood?.commit) candidates.push({ source: 'last-good', commit: lastGood.commit, parts: fits(lastGood, false), reason: 'last-good is the code that was running' })
  const best = candidates.reduce((chosen, candidate) => (candidate.parts.length > (chosen ? chosen.parts.length : 0) ? candidate : chosen), null)
  const rendererUnknown = 'the running Orbit reported no renderer hash (it predates them), so the src/ its window ran is unknown'
  if (!best) {
    if (parts.length === 1 && parts[0] === 'src' && !rendererKnown) return none(rendererUnknown)
    if (!electronKnown && !rendererKnown && !own) return none('the running Orbit reported no code fingerprints and left no record of its code')
    if (!own) return none(lastGood?.commit ? 'the running code was not recorded and last-good is not that code' : 'the running code was not recorded and there is no last-good snapshot')
    return none(`the record of pid ${running.pid} is not the code it runs now (a later restart or reload was not recorded)${lastGood?.commit ? ', and last-good is not that code either' : ''}`)
  }
  const skipped = parts.filter((part) => !best.parts.includes(part))
  if (!skipped.length) return { ...best, skipped }
  const skippedReason = skipped.includes('src') && !rendererKnown ? rendererUnknown
    : `neither the record of the running code nor last-good has the ${skipped.map((part) => `${part}/`).join(' and ')} that was running${skipped.includes('src') ? ' (a renderer reload since was not recorded)' : ''}`
  return { ...best, skipped, skippedReason }
}

/**
 * Files that `to` has and `from` has not, under `paths` (git pathspecs): the files a change added. Renames count as a
 * deletion and an addition.
 */
function addedFiles({ cwd = root, from, to, paths = SNAPSHOT_PATHS, runGit = git }) {
  const listed = runGit(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', from, to, '--', ...paths], { cwd, raw: true }).out
  return listed.split('\0').filter(Boolean)
}

/**
 * Puts `paths` (git pathspecs, so `:(exclude)<file>` keeps a file as it is) back to the snapshot `commit`, in overlay
 * mode: every file the snapshot has there is rewritten, a file it lacks stays unless `remove` names it (the rollback
 * passes the files the failed change added, addedFiles), so files created after the snapshot stay — untracked,
 * staged or committed alike. It goes through a temporary index (read-tree + checkout-index), never the real one: a
 * git process of an editor or an agent that holds .git/index.lock cannot make it fail. An attempt that fails (a file
 * held open for a moment) is retried; a file of `remove` that cannot be deleted is reported, not fatal.
 * @returns {{ files: number, removed: string[], notRemoved: string[], attempts: number }}
 */
function restoreTree({ cwd = root, commit, paths = SNAPSHOT_PATHS, remove = [], attempts = 3, retryMs = 500, runGit = git }) {
  if (!commit) throw new Error('restoreTree needs a commit')
  let failure = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const index = temporaryIndex()
    const env = { GIT_INDEX_FILE: index }
    try {
      runGit(['read-tree', commit], { cwd, env })
      const files = runGit(['ls-files', '-z', '--', ...paths], { cwd, env, raw: true }).out.split('\0').filter(Boolean)
      if (files.length) runGit(['checkout-index', '-f', '-z', '--stdin'], { cwd, env, input: `${files.join('\0')}\0` })
      return { files: files.length, ...removeFiles(cwd, remove, { attempts, retryMs }), attempts: attempt }
    } catch (error) {
      failure = error
      if (attempt < attempts) sleepSync(retryMs)
    } finally {
      try { fs.unlinkSync(index) } catch { /* Never created. */ }
    }
  }
  throw failure
}

/** Deletes repository-relative `files` (retrying one that is held open); returns what went and what could not. */
function removeFiles(cwd, files, { attempts = 3, retryMs = 500 } = {}) {
  const removed = []
  const notRemoved = []
  for (const file of files) {
    const target = path.join(cwd, file)
    for (let attempt = 1; ; attempt++) {
      try {
        fs.rmSync(target)
        removed.push(file)
        break
      } catch (error) {
        if (error.code === 'ENOENT') break
        if (attempt >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) { notRemoved.push(`${file} (${error.code || error.message})`); break }
        sleepSync(retryMs)
      }
    }
  }
  return { removed, notRemoved }
}

/** electron/ without the shell files: a runtime rollback leaves the files of the running main process as they are. */
function runtimeRestorePaths(shellFiles = SHELL_FILES) {
  return ['electron', ...shellFiles.filter((file) => file.startsWith('electron/')).map((file) => `:(exclude)${file}`)]
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
// Orbit processes, restart signals, health

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

/** The process side of a restart; tests pass their own and never start Electron. */
const SYSTEM = {
  findOrbitProcesses: () => findOrbitProcesses(root),
  killProcess: (pid) => killProcess(pid),
  launch: (spec, log) => signalRelaunch(spec, log),
}

/**
 * A report of the start, runtime restart or renderer reload that followed the signal, not one written before it.
 * `restartedAt` is when that generation began (a process's first report has none, or its startedAt).
 */
function isFreshHealth(health, since) {
  if (!health || typeof health !== 'object') return false
  return Number(health.restartedAt ?? health.startedAt) >= since && Number(health.writtenAt) >= since
}

async function waitForHealth({ file = HEALTH_FILE, since, timeoutMs = healthTimeoutMs, poll = 200, accept = () => true } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = readJson(file)
    if (isFreshHealth(health, since) && accept(health)) return health
    if (Date.now() >= deadline) return null
    await sleep(poll)
  }
}

function parkHealthFile(paths = PATHS) {
  try {
    if (!fs.existsSync(paths.health)) return
    fs.rmSync(paths.healthPrev, { force: true })
    fs.renameSync(paths.health, paths.healthPrev)
  } catch { /* A stale file is ignored by the freshness check anyway. */ }
}

/** Whether two paths name the same folder (a profile: userData); on Windows the case does not matter. */
function sameFolder(left, right) {
  const normalize = (value) => path.resolve(String(value)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase() : normalize(left) === normalize(right)
}

/**
 * Which Orbit instances of this repository run, and the last health report when it is one of theirs. Two instances of
 * one repository (two profiles) write the same health file: with `userData` (the profile this script restarts, from
 * ORBIT_USER_DATA) a report of another profile is not the instance's own (`healthNote` says why), and with
 * ORBIT_HEALTH_FILE=0 (no `paths.health`) there is no report at all.
 */
function observeOrbit({ paths = PATHS, system = SYSTEM, userData = null } = {}) {
  const health = paths.health ? readJson(paths.health) : null
  const running = system.findOrbitProcesses().map((process_) => process_.pid)
  const own = !!health && typeof health === 'object' && running.includes(Number(health.pid))
  const foreign = own && !!userData && typeof health.userData === 'string' && !!health.userData && !sameFolder(health.userData, userData)
  const healthNote = foreign ? `the health report is of another Orbit instance of this repository (pid ${health.pid}, profile ${health.userData}), not of the one this script restarts (ORBIT_USER_DATA ${userData}): its code hashes do not count`
    : !paths.health ? 'Orbit writes no health report (ORBIT_HEALTH_FILE=0)' : null
  return { running, health, runningHealth: own && !foreign ? health : null, healthNote }
}

/** The fields of a health report the loop reads, for plans and reports. */
function healthSummary(health) {
  if (!health || typeof health !== 'object') return null
  const { ok, pid, startedAt, restartedAt, writtenAt, level, generation, commit, distMtime, shellHash, runtimeHash, rendererHash: renderer, runtime, userData, error } = health
  return { ok, pid, startedAt, restartedAt, writtenAt, level, generation, commit, distMtime, shellHash, runtimeHash, rendererHash: renderer, runtime, userData, error }
}

/**
 * The cheapest restart that puts the files on disk into the running Orbit. `health` is the last report of the running
 * instance (null when none runs or the report is another process's, `healthNote` then says why); `fingerprint` is of
 * the files on disk and `rendererInputs` the renderer hash of the files on disk; `willBuild` says that a new dist/ is
 * built before the restart.
 *
 * Whether the window must load another dist/: with the renderer hash of the report (what the window runs: the build
 * record of the dist/ it loaded, else the inputs on disk then) it is the renderer inputs alone — a dist/ rebuilt from
 * the inputs the window already runs (a build without a record, a --force) changes nothing it shows, so no reload and,
 * with a runtime change, no full relaunch. A report without that hash (an Orbit that predates it): a new build, or a
 * dist/ other than the one it loaded (dist mtime).
 */
function decideLevel({ forced = 'auto', running = false, health = null, healthNote = null, fingerprint, rendererInputs = null, distMtime = null, willBuild = false }) {
  if (!running) return { level: 'full', reason: 'no Orbit of this repository is running: start one' }
  const inprocess = health?.runtime?.mode === 'inprocess'
  if (forced && forced !== 'auto') {
    if (forced === 'runtime' && inprocess) return { level: 'full', reason: '--level runtime, but the runtime runs inside the main process (ORBIT_RUNTIME_MODE=inprocess)' }
    return { level: forced, reason: `--level ${forced}` }
  }
  if (!health) return { level: 'full', reason: healthNote || 'the running Orbit has no health report of its own' }
  if (health.ok !== true) return { level: 'full', reason: `the running Orbit reported a failure${health.error ? `: ${health.error}` : ''}` }
  if (typeof health.shellHash !== 'string' || !health.shellHash) return { level: 'full', reason: 'the running Orbit reports no code fingerprints (it predates restart levels)' }
  if (health.shellHash !== fingerprint.shell) return { level: 'full', reason: 'shell files changed (main process, preload, IPC)' }
  const windowKnown = typeof health.rendererHash === 'string' && !!health.rendererHash && typeof rendererInputs === 'string' && !!rendererInputs
  const rendererBehind = windowKnown ? health.rendererHash !== rendererInputs : willBuild || Number(health.distMtime) !== distMtime
  if (health.runtimeHash !== fingerprint.runtime) {
    if (inprocess) return { level: 'full', reason: 'runtime files changed, and the runtime runs inside the main process' }
    // A runtime restart keeps the window as it is: a new renderer as well needs the whole app to start again.
    if (rendererBehind) return { level: 'full', reason: 'runtime files and the renderer changed' }
    return { level: 'runtime', reason: 'runtime files changed' }
  }
  if (windowKnown) {
    return rendererBehind
      ? { level: 'renderer', reason: `the renderer inputs differ from the ones the window runs${willBuild ? ': the renderer is rebuilt' : ''}` }
      : { level: 'none', reason: 'the running Orbit already runs these sources' }
  }
  if (willBuild) return { level: 'renderer', reason: 'the renderer is rebuilt' }
  if (rendererBehind) return { level: 'renderer', reason: 'dist/ is newer than what the window shows' }
  return { level: 'none', reason: 'the running Orbit already runs these sources and this build' }
}

const countsAsRestart = (level) => level === 'runtime' || level === 'full'

// ---------------------------------------------------------------------------------------------------------------
// The intent to continue an Orbit run (pending-resume.json; the runtime reads and deletes it, the script writes it)

/**
 * The intent for a runtime or full restart of a script that runs for an Orbit run (ORBIT_RUN_ID) and knows where the
 * runtime looks for it (--intent-file, else ORBIT_RESUME_FILE). A renderer reload keeps the runtime and its runs, so
 * it has none. `createdAt` is filled in when the watcher writes it, right before the signal. `commit` is the HEAD the
 * code was taken on, `snapshot` the candidate snapshot (refs/orbit/self-upgrade/candidate at the time: HEAD plus the
 * uncommitted electron/ and src/ that went live), null when there is none.
 */
function resolveIntent({ env = process.env, level, intentFile = null, reason = null, continueWith = null, verify = true, id, commit = null, snapshot = null }) {
  const configured = intentFile || env.ORBIT_RESUME_FILE || null
  const file = configured ? path.resolve(String(configured)) : null
  if (!countsAsRestart(level)) return { file, intent: null, note: level === 'renderer' ? 'a renderer reload keeps the runtime and its runs' : 'nothing restarts' }
  if (!env.ORBIT_RUN_ID) return { file, intent: null, note: 'ORBIT_RUN_ID is not set: no Orbit run to continue' }
  if (!file) return { file: null, intent: null, note: 'no resume file: pass --intent-file or set ORBIT_RESUME_FILE' }
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return {
    file,
    note: null,
    intent: {
      version: 1,
      id: String(id),
      createdAt: null,
      source: env.ORBIT_RESTART_SOURCE === 'tool' ? 'tool' : 'script',
      reason: text(reason) || DEFAULT_REASON,
      continueWith: text(continueWith) || DEFAULT_CONTINUE_WITH,
      verify: verify !== false,
      runId: String(env.ORBIT_RUN_ID),
      chatId: env.ORBIT_CHAT_ID || null,
      projectId: env.ORBIT_PROJECT_ID || null,
      agentId: env.ORBIT_AGENT_ID || null,
      level,
      state: 'relaunching',
      commit: commit || null,
      snapshot: snapshot || null,
      outcome: null,
      error: null,
      patch: null,
      // The watcher's word, added after the restart: `relaunched` (healthy) — or the outcome above on a rollback.
      verdict: null,
      verdictAt: null,
    },
  }
}

function writeIntent(file, intent) { return writeJsonAtomic(file, intent) }

/**
 * The watcher's word on the intent it wrote; the next runtime waits for it before it continues the run. The file as
 * it is now wins over the plan's copy when it is the same intent; `create` writes the copy when the file is gone.
 */
function settleIntent(file, record, fields, { create = false } = {}) {
  const current = readJson(file)
  const same = !!current && typeof current === 'object' && !Array.isArray(current) && current.id === record?.id
  if (!same && !create) return false
  writeIntent(file, { ...(same ? current : record), ...fields })
  return true
}

/** Before the rolled-back code starts: the next runtime posts the error and the patch instead of continuing the run. */
function markIntentRolledBack(file, record, { error = null, patch = null } = {}) {
  return settleIntent(file, record, { outcome: 'rolled-back', error: error ? String(error) : null, patch: patch || null }, { create: true })
}

/** The new code is live and healthy: the runtime may continue the run. An intent already consumed stays consumed. */
function markIntentRelaunched(file, record, now = new Date().toISOString()) {
  return settleIntent(file, record, { verdict: 'relaunched', verdictAt: now })
}

// ---------------------------------------------------------------------------------------------------------------
// Relaunch cap: a chain that keeps restarting the app stops here (runtime and full restarts; reloads are free).

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

function planSteps({ verifyOnly: onlyVerify = false, noRelaunch: skipRelaunch = false, desktop = false, verify = true, build = true } = {}) {
  const steps = verify ? ['typecheck', 'test', 'smoke', 'main-load', ...(desktop ? ['smoke:desktop'] : [])] : []
  if (onlyVerify) return steps
  if (build) steps.push('save-previous', 'build')
  if (!skipRelaunch) steps.push('relaunch', 'health')
  return steps
}

function writeReport(report) { return writeJson(REPORT_FILE, report) }

/** A failure the next reader of self-upgrade-last.json must be able to see, not only the console. */
function failWithReport(message, details = {}) {
  const file = writeReport({ ok: false, status: 'failed', nextAction: 'fix-and-retry', timestamp: new Date().toISOString(), error: message, phase: 'done', ...details })
  // Printed last, so that the end of the output the agent gets names what failed.
  console.error([message, ...failureSummary(details), `Report: ${file}`].join('\n'))
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
  const lines = [`\nSelf-upgrade ${report.status}${report.level ? ` (level ${report.level})` : ''}${report.ok ? '' : ` — ${report.error || 'see report'}`}`]
  for (const timing of report.timings || []) lines.push(`  ${timing.ok ? 'ok  ' : 'FAIL'} ${timing.step.padEnd(14)} ${timing.ms} ms`)
  const attempt = report.relaunch
  if (attempt) lines.push(`  ${attempt.flag || RELAUNCH_FLAG}: health ${attempt.health ? (attempt.health.ok ? 'ok' : 'failed') : 'missing'} after ${attempt.waitedMs} ms${attempt.startedFresh && attempt.level !== 'runtime' && attempt.level !== 'renderer' ? ' (started a new instance)' : ''}`)
  if (report.intentWritten || report.intentError) lines.push(`  intent: ${report.intentWritten ? `written to ${report.intentFile}` : `not written (${report.intentError})`}${report.verdictWritten ? ', verdict relaunched' : ''}${report.rollback?.intentMarked ? ', marked rolled-back' : ''}`)
  const back = report.rollback
  if (back) {
    const restored = back.treeRestored ? `restored from ${back.base?.source || 'a snapshot'} (${(back.treePaths || []).filter((entry) => !entry.startsWith(':')).join(', ')})` : null
    const sources = [restored, back.sourcesNote].filter(Boolean).join('; ') || back.treeNote || 'left as they are'
    const removed = back.deleted?.length ? `, removed ${back.deleted.length} file(s) the failed change added: ${back.deleted.join(', ')}` : ''
    lines.push(`  rollback: dist ${back.distRestored ? 'restored' : 'not restored'}, sources ${sources.replace(/^sources /, '')}${removed}, recovered: ${back.recovered}${back.fallback ? ' (after a stop and a fresh start)' : ''}${back.patch ? `, failed change: ${back.patch}` : ''}`)
  }
  lines.push(`Report: ${REPORT_FILE}`)
  lines.push(`nextAction: ${report.nextAction}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// The detached restart phase

/** The signal for `level` (a start when no Orbit runs), sent from the running instance's profile. */
function launchSpec(plan, level, paths = PATHS) {
  const env = { ...process.env }
  // The single-instance lock lives in the profile: a signal from another profile would start a second Orbit instead.
  if (!env.ORBIT_USER_DATA && typeof plan.userData === 'string' && plan.userData) env.ORBIT_USER_DATA = plan.userData
  return orbitLaunch({ electron: plan.electron, base: paths.root, args: [LEVEL_FLAGS[level] || RELAUNCH_FLAG], env })
}

/** `beforeSignal` runs before anything changes (it writes the intent; it may throw to call the restart off). */
async function relaunchAndWait({ spec, level = 'full', timeoutMs = healthTimeoutMs, log = () => {}, paths = PATHS, system = SYSTEM, running = null, beforeSignal = null, poll = 200 }) {
  // Only a full relaunch needs to know what ran before: its report must come from a new process.
  const runningBefore = level === 'full' || !Array.isArray(running) ? system.findOrbitProcesses().map((process_) => process_.pid) : running
  if (beforeSignal) beforeSignal()
  parkHealthFile(paths)
  const since = Date.now()
  const flag = spec.args[spec.args.length - 1]
  const signalPid = system.launch(spec, log)
  log(`${flag} signalled (helper pid ${signalPid}); Orbit running before: ${runningBefore.join(', ') || 'none'}`)
  // The process being relaunched may still write a report (a runtime restart during its shutdown): not the new one.
  const accept = (health) => level !== 'full' || !runningBefore.includes(Number(health.pid))
  const health = await waitForHealth({ file: paths.health, since, timeoutMs, poll, accept })
  const waitedMs = Date.now() - since
  log(health
    ? `health ${health.ok ? 'ok' : 'failed'} from pid ${health.pid}${health.level ? ` (${health.level}${health.generation ? `, generation ${health.generation}` : ''})` : ''} after ${waitedMs} ms${health.error ? `: ${health.error}` : ''}`
    : `no health report within ${timeoutMs} ms`)
  return { level, flag, since, runningBefore, startedFresh: runningBefore.length === 0, waitedMs, health }
}

/**
 * Where a rollback of `plan` takes the `parts` from (rollbackBase), read from git and artifacts/ now. No parts (a
 * level that puts no source back): the snapshot of the running code all the same, which the failed patch starts from.
 */
function chooseRollbackBase(plan, paths = PATHS, parts = ['electron', 'src']) {
  const lookup = parts.length ? parts : ['electron', 'src']
  try {
    const record = readJson(paths.running)
    const running = record && typeof record === 'object' && record.commit && snapshotInfo(record.commit, paths.root) ? record : null
    return rollbackBase({ running, previous: plan.previous || null, lastGood: plan.lastGood ? snapshotInfo(plan.lastGood, paths.root) : null, parts: lookup, unknown: plan.previousNote || null })
  } catch (error) {
    return { source: null, commit: null, reason: `git failed: ${error.message}`, parts: [], skipped: [...lookup] }
  }
}

/**
 * What a rollback at `level` puts back of the sources: full — electron/ and src/; runtime — electron/ (without the
 * files of the running main process); renderer — src/, when this run built dist/ from it.
 */
function rollbackParts(level, plan = {}) {
  if (level === 'runtime') return ['electron']
  if (level === 'renderer') return plan.built ? ['src'] : []
  return ['electron', 'src']
}

/** The pathspecs of `parts` at `level`, and how the log names them. */
function partPaths(parts, level) { return parts.flatMap((part) => (part === 'electron' ? (level === 'runtime' ? runtimeRestorePaths() : ['electron']) : ['src'])) }
function partLabel(parts, level) { return parts.map((part) => (part === 'electron' && level === 'runtime' ? 'electron/ (runtime files)' : `${part}/`)).join(' and ') }
const firstLine = (text) => String(text || '').split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 300) || 'unknown error'

async function rollback({ plan, level = 'full', error = null, log = () => {}, paths = PATHS, system = SYSTEM, intent = null }) {
  const result = { startedAt: new Date().toISOString(), level, killed: [], base: null, distRestored: false, markerRestored: false, treeRestored: false, treePaths: [], deleted: [], sourcesNote: null, failed: null, patch: null, intentMarked: false, health: null, recovered: false }
  const stopOrbit = () => {
    for (const process_ of system.findOrbitProcesses()) {
      system.killProcess(process_.pid)
      result.killed.push(process_.pid)
      log(`stopped Orbit pid ${process_.pid}`)
    }
  }
  // A relaunch that failed leaves nothing worth keeping; a runtime restart or a reload keeps the main process.
  if (level === 'full') stopOrbit()
  // What comes back: full — dist-prev/, electron/ and src/; runtime — electron/ without the files of the running main
  // process; renderer — dist-prev/ and src/, when this run built them. Each part of the sources only from a snapshot
  // that is what ran (rollbackBase); a level that puts no source back still looks for one, for the patch.
  const parts = rollbackParts(level, plan)
  const base = parts.length || plan.candidate ? chooseRollbackBase(plan, paths, parts) : null
  result.base = base
  if (base) log(`rollback base: ${base.source ? `${base.source} ${base.commit} for ${partLabel(base.parts, level)}` : 'none'} (${base.reason}${base.skippedReason ? `; ${base.skippedReason}` : ''})`)
  if (plan.candidate) {
    try {
      const failed = snapshotTree({ cwd: paths.root, label: 'failed' })
      result.failed = failed
      const from = base?.commit || failed.head
      if (from) {
        const diff = git(['diff', from, failed.commit, '--', ...SNAPSHOT_PATHS], { cwd: paths.root, allowFailure: true })
        fs.mkdirSync(path.dirname(paths.failedPatch), { recursive: true })
        fs.writeFileSync(paths.failedPatch, `${diff.out}\n`, 'utf8')
        result.patch = paths.failedPatch
      }
      log(`failed sources kept as ${failed.ref} (${failed.commit})`)
    } catch (snapshotError) {
      result.snapshotError = snapshotError.message
      log(`could not snapshot the failed sources: ${snapshotError.message}`)
    }
  }
  if (level !== 'runtime' && plan.distPrevSaved) {
    try { restoreDistPrev({ dist: paths.dist, prev: paths.distPrev }); result.distRestored = true; log('dist/ restored from dist-prev/') } catch (distError) { result.distError = distError.message; log(`dist restore failed: ${distError.message}`) }
  }
  // dist-prev/ brings its own build record. Otherwise the one this run wrote vouches for failed sources: the previous
  // one comes back, or none when dist/ still holds the build of this run.
  if (plan.markerWritten && !result.distRestored) {
    try { restoreBuildMarker(paths.dist, plan.built ? null : plan.markerBefore || null); result.markerRestored = true } catch (markerError) { result.markerError = markerError.message }
  }
  // The sources. What is not put back is said in the report and the intent's error (sourcesNote): no trustworthy base
  // for a part, or a restore that failed.
  const restorable = base?.commit ? parts.filter((part) => base.parts.includes(part)) : []
  const skipped = parts.filter((part) => !restorable.includes(part))
  const notes = []
  if (skipped.length) {
    const note = restorable.length ? `${partLabel(skipped, level)} left as ${skipped.length > 1 ? 'they are' : 'it is'} (no trustworthy rollback base)` : NO_BASE_NOTE
    result.treeNote = `${note}: ${(restorable.length ? base?.skippedReason : base?.reason) || 'unknown'}`
    notes.push(note)
    log(`${partLabel(skipped, level)}: ${result.treeNote}`)
  }
  if (restorable.length && base?.commit) {
    const treePaths = partPaths(restorable, level)
    const label = partLabel(restorable, level)
    // Overlay: of the files the base lacks, only those the failed change added go (from the candidate, else the state
    // the rollback found); files created after it stay.
    let remove = []
    const changed = plan.candidate?.commit || result.failed?.commit || null
    if (changed) {
      try { remove = addedFiles({ cwd: paths.root, from: base.commit, to: changed, paths: treePaths }) } catch (addedError) { result.addedError = addedError.message; log(`could not list the files the failed change added: ${addedError.message}`) }
    }
    try {
      const restored = (system.restoreTree || restoreTree)({ cwd: paths.root, commit: base.commit, paths: treePaths, remove })
      Object.assign(result, { treeRestored: true, treePaths, deleted: restored.removed, restoreAttempts: restored.attempts }, restored.notRemoved.length ? { notRemoved: restored.notRemoved } : {})
      log(`${label} restored from ${base.source} ${base.commit}${restored.removed.length ? `; removed what the failed change added: ${restored.removed.join(', ')}` : ''}${restored.notRemoved.length ? `; could not remove ${restored.notRemoved.join(', ')}` : ''}`)
    } catch (treeError) {
      const note = `sources not restored (the restore of ${label} from ${base.source} failed)`
      result.treeError = treeError.message
      result.treeNote = [result.treeNote, `${note}: ${firstLine(treeError.message)}`].filter(Boolean).join('; ')
      notes.push(note)
      log(`source restore failed: ${treeError.message}`)
    }
  }
  result.sourcesNote = notes.length ? notes.join('; ') : null
  // The next runtime must learn that this restart was rolled back before the old code starts.
  if (intent) {
    try {
      markIntentRolledBack(intent.file, intent.record, { error: result.sourcesNote ? `${error}; ${result.sourcesNote}` : error, patch: result.patch })
      result.intentMarked = true
      log(`intent marked rolled-back: ${intent.file}`)
    } catch (intentError) { result.intentError = intentError.message; log(`could not mark the intent: ${intentError.message}`) }
  }
  const timeoutMs = plan.healthTimeoutMs || healthTimeoutMs
  const fullStart = () => relaunchAndWait({ spec: launchSpec(plan, 'full', paths), level: 'full', timeoutMs, log, paths, system })
  let attempt
  if (level === 'full') attempt = await fullStart()
  else {
    attempt = await relaunchAndWait({ spec: launchSpec(plan, level, paths), level, timeoutMs, log, paths, system, running: plan.running })
    if (!attempt.health?.ok) {
      log(`${LEVEL_FLAGS[level]} did not bring Orbit back: stopping it and starting it again`)
      result.retry = attempt
      stopOrbit()
      attempt = await fullStart()
      result.fallback = 'full'
    }
  }
  result.relaunch = attempt
  result.health = attempt.health
  result.recovered = !!attempt.health?.ok
  return result
}

/**
 * The restart phase for a plan the foreground wrote: intent, signal, health, and on failure the rollback. A user's
 * stop (the cancel marker, from the plan's start on) seen right before the intent or right before the signal calls the
 * restart off: status `cancelled`, no intent (one written a moment before goes again), no signal.
 */
async function runWatcher(plan, { paths = PATHS, system = SYSTEM, log = () => {} } = {}) {
  const level = Object.hasOwn(LEVEL_FLAGS, plan.level) ? plan.level : 'full'
  const report = { ...plan.report, level, phase: 'relaunching', watcherPid: process.pid, intentWritten: false }
  writeJson(paths.report, report)
  // Only a runtime or full restart ends runs; the intent goes to disk right before the signal, because the runtime
  // that shuts down reads it to finish the requesting run as `restarting`.
  const intent = countsAsRestart(level) && plan.intent?.file && plan.intent.record ? { file: plan.intent.file, record: { ...plan.intent.record, level } } : null
  const since = planStart(plan)
  const stopIfCancelled = (when) => {
    const stop = cancelRequested(paths, since)
    if (stop) throw new CancelledError(stop, when)
  }
  const writeIntentNow = () => {
    if (!intent) return
    intent.record = { ...intent.record, createdAt: new Date().toISOString() }
    try {
      writeIntent(intent.file, intent.record)
      report.intentWritten = true
      log(`intent written to ${intent.file} (run ${intent.record.runId}, ${intent.record.source})`)
    } catch (error) {
      report.intentError = error.message
      log(`could not write the intent: ${error.message}`)
    }
  }
  const withdrawIntent = () => {
    if (!report.intentWritten) return
    try {
      if (readJson(intent.file)?.id === intent.record.id) fs.rmSync(intent.file, { force: true })
      Object.assign(report, { intentWritten: false, intentWithdrawn: true })
      log(`intent withdrawn: ${intent.file}`)
    } catch (error) { report.intentError = error.message; log(`could not withdraw the intent: ${error.message}`) }
  }
  const beforeSignal = () => {
    stopIfCancelled('before the restart')
    writeIntentNow()
    try { stopIfCancelled('before the restart') } catch (error) { withdrawIntent(); throw error }
  }
  try {
    const timeoutMs = plan.healthTimeoutMs || healthTimeoutMs
    const attempt = await relaunchAndWait({ spec: launchSpec(plan, level, paths), level, timeoutMs, log, paths, system, running: level === 'full' ? null : plan.running, beforeSignal })
    report.relaunch = attempt
    if (attempt.health?.ok) {
      // First, since the new runtime waits for it: the run may be continued.
      if (report.intentWritten) {
        try {
          report.verdictWritten = markIntentRelaunched(intent.file, intent.record)
          log(report.verdictWritten ? 'intent: verdict relaunched' : 'intent already consumed: no verdict written')
        } catch (error) { report.intentError = error.message; log(`could not write the verdict: ${error.message}`) }
      }
      if (countsAsRestart(level)) recordCycle({ file: paths.cycles })
      if (plan.candidate?.commit) {
        try {
          git(['update-ref', `${REF_PREFIX}last-good`, plan.candidate.commit], { cwd: paths.root })
          report.lastGood = { commit: plan.candidate.commit, ref: `${REF_PREFIX}last-good` }
        } catch (error) { report.lastGoodError = error.message }
      }
      // Files that changed after the checks went live unverified: say so (the hashes are what the new code loaded).
      const drift = ['shell', 'runtime'].filter((part) => plan.fingerprint && typeof attempt.health[`${part}Hash`] === 'string' && attempt.health[`${part}Hash`] !== plan.fingerprint[part])
      if (drift.length) { report.drift = drift; log(`note: the restarted Orbit loaded ${drift.join(' and ')} code other than the verified one`) }
      Object.assign(report, { ok: true, status: 'relaunched', nextAction: 'none', health: attempt.health })
    } else {
      const error = attempt.health ? `the new Orbit reported a failure: ${attempt.health.error || 'unknown'}` : `no health report within ${timeoutMs} ms`
      log(`upgrade failed: ${error}`)
      report.rollback = await rollback({ plan, level, error, log, paths, system, intent: report.intentWritten ? intent : null })
      if (countsAsRestart(level)) recordCycle({ file: paths.cycles })
      Object.assign(report, { ok: false, status: 'rolled-back', nextAction: report.rollback.failed ? 'inspect-failed-ref' : 'fix-and-retry', error: report.rollback.sourcesNote ? `${error}; ${report.rollback.sourcesNote}` : error, health: report.rollback.health })
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      log(`${error.message} (stop requested ${new Date(error.stop.requestedAt).toISOString()})`)
      Object.assign(report, { ok: false, status: 'cancelled', nextAction: 'none', error: error.message, cancel: error.stop })
    } else {
      log(`watcher error: ${error.stack || error.message}`)
      Object.assign(report, { ok: false, status: 'failed', nextAction: 'fix-and-retry', error: error.message })
      // The runtime waits for a word on the intent: this restart failed, unless that word was already given.
      if (report.intentWritten && !report.verdictWritten && !report.rollback?.intentMarked) {
        try { settleIntent(intent.file, intent.record, { verdict: 'failed', verdictAt: new Date().toISOString(), error: error.message }) } catch { /* Reported above. */ }
      }
    }
  }
  report.phase = 'done'
  report.finished = new Date().toISOString()
  writeJson(paths.report, report)
  return report
}

/**
 * The detached watcher (`--watch <plan>`): it takes over the lock the foreground handed over (by the plan's nonce),
 * keeps it fresh while it works and releases it at the end. A lock that is no longer that one means the foreground was
 * stopped and its lock released (or another upgrade holds it): nothing restarts, the report says `cancelled`.
 */
async function watch(planFile, { paths = PATHS, system = SYSTEM } = {}) {
  const plan = readJson(planFile)
  if (!plan) { console.error(`Plan file is missing or unreadable: ${planFile}`); process.exit(1) }
  const log = (line) => { try { fs.appendFileSync(paths.watchLog, `${new Date().toISOString()} ${line}\n`) } catch { /* Log only. */ } }
  if (!takeOverLock(paths.root, { nonce: plan.lockNonce || null })) {
    const error = 'cancelled before the restart: the self-upgrade lock was released or taken by another upgrade before the watcher started (the script that asked for the restart was stopped); nothing was restarted'
    log(`watcher ${process.pid} for run ${plan.runId}: ${error}`)
    // The report is this run's to finish only while no other run has written one.
    const current = readJson(paths.report)
    if (!current || current.runId === plan.runId) writeJson(paths.report, { ...plan.report, ok: false, status: 'cancelled', nextAction: 'none', error, phase: 'done', finished: new Date().toISOString() })
    return null
  }
  log(`watcher ${process.pid} started for run ${plan.runId} (level ${plan.level || 'full'}${plan.levelReason ? `: ${plan.levelReason}` : ''})`)
  try {
    const report = await runWatcher(plan, { paths, system, log })
    log(`done: ${report.status}`)
    return report
  } finally {
    releaseLock()
  }
}

// ---------------------------------------------------------------------------------------------------------------
// --record-running: the code an instance loaded, the rollback base of its next restart

/**
 * Snapshot electron/ + src/ as refs/orbit/self-upgrade/running and write artifacts/self-upgrade-running.json
 * `{ version: 2, commit, ref, head, pid, startedAt, recordedAt, shellHash, runtimeHash, rendererHash }` for `instance`
 * (pid, startedAt and the code hashes its health report gave). Main runs it detached after every healthy start,
 * runtime restart and renderer reload. Safe next to an agent that edits files: a temporary index, never the real one,
 * never `git stash`; the files are fingerprinted before and after the snapshot, and a snapshot that changed meanwhile,
 * or whose electron/ is not the code the instance reported, is not recorded (the previous record stays). src/ counts
 * only when its renderer hash is the one the instance reported (what its window runs): otherwise — edited after that
 * build, or an instance that reported none — the record has `rendererHash: null`, and a rollback leaves src/ alone
 * rather than put that state back.
 */
function recordRunning({ paths = PATHS, instance = null, attempts = 3, now = () => new Date().toISOString() } = {}) {
  const pid = Number(instance?.pid)
  const startedAt = Number(instance?.startedAt)
  if (!(pid > 0) || !(startedAt > 0)) return { recorded: false, reason: 'no running instance to record: --pid and --started-at, or a health report' }
  const state = () => ({ ...fingerprints(paths.root), renderer: rendererHash(paths.root) })
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = state()
    if (instance.shellHash && instance.runtimeHash && (before.shell !== instance.shellHash || before.runtime !== instance.runtimeHash)) {
      return { recorded: false, reason: 'the files on disk are not the code the instance loaded (they changed after it started)' }
    }
    const snapshot = snapshotTree({ cwd: paths.root, label: 'running', fingerprint: before, updateRef: false })
    const after = state()
    if (after.shell !== before.shell || after.runtime !== before.runtime || after.renderer !== before.renderer) continue
    git(['update-ref', snapshot.ref, snapshot.commit], { cwd: paths.root })
    const rendererRuns = !!instance.rendererHash && before.renderer === instance.rendererHash
    const record = { version: 2, commit: snapshot.commit, ref: snapshot.ref, head: snapshot.head, pid, startedAt, recordedAt: now(), shellHash: before.shell, runtimeHash: before.runtime, rendererHash: rendererRuns ? before.renderer : null }
    writeJsonAtomic(paths.running, record)
    const note = rendererRuns ? null : instance.rendererHash ? 'src/ on disk is not what the window runs (edited after its build): recorded without a renderer hash' : 'the instance reported no renderer hash: src/ recorded without one'
    return { recorded: true, record, ...(note ? { note } : {}) }
  }
  return { recorded: false, reason: `the sources changed while they were recorded (${attempts} attempts)` }
}

/**
 * `--record-running [--pid N --started-at MS --shell-hash H --runtime-hash H --renderer-hash H]`; what is not given
 * comes from the health report of that pid.
 */
async function recordRunningCli() {
  const began = Date.now()
  const given = (name) => cli.values[name]
  const health = readJson(HEALTH_FILE)
  const own = health && typeof health === 'object' && (!given('--pid') || Number(health.pid) === Number(given('--pid'))) ? health : null
  const instance = {
    pid: given('--pid') ?? own?.pid,
    startedAt: given('--started-at') ?? own?.startedAt,
    shellHash: given('--shell-hash') ?? own?.shellHash ?? null,
    runtimeHash: given('--runtime-hash') ?? own?.runtimeHash ?? null,
    rendererHash: given('--renderer-hash') ?? own?.rendererHash ?? null,
  }
  let result
  try { result = recordRunning({ instance }) } catch (error) { result = { recorded: false, reason: error.message } }
  const ms = Date.now() - began
  if (result.recorded) console.log(`Recorded the code of pid ${result.record.pid} as ${result.record.ref} (${result.record.commit}) in ${ms} ms.`)
  else console.log(`Not recorded: ${result.reason} (${ms} ms).`)
  if (!result.recorded) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------------------------
// --mark-build: the build record of a dist/ that `npm run build` made

/**
 * Writes dist/orbit-build.json (version 2) for the dist/ just built from the renderer inputs on disk, claiming no
 * verification (the next self-upgrade still runs the checks). `npm run build` runs it after `vite build`, so every
 * build says what it was built from: the build skip reads it, and so does main for the renderer hash of its health
 * reports. An input newer than dist/index.html was edited after the build: then no record is left (the next
 * self-upgrade builds again).
 */
function markBuild({ base = root, now = new Date().toISOString() } = {}) {
  const dist = path.join(base, 'dist')
  let builtAt
  try { builtAt = fs.statSync(path.join(dist, 'index.html')).mtimeMs } catch { return { marked: false, reason: 'dist/index.html is missing: nothing was built' } }
  const renderer = rendererState(base)
  if (renderer.newest > builtAt) {
    restoreBuildMarker(dist, null)
    return { marked: false, reason: `${renderer.file} changed after dist/ was built: no build record, the next self-upgrade builds again` }
  }
  const head = headCommit(base)
  const marker = { ...nextBuildMarker({ previous: readBuildMarker(dist), built: true, verified: false, renderer, fingerprint: fingerprints(base), source: newestSourceChange(base), candidate: head ? { head, commit: null } : null, now }), builtBy: 'npm run build' }
  writeBuildMarker(dist, marker)
  return { marked: true, marker }
}

function markBuildCli() {
  const result = markBuild()
  if (result.marked) console.log(`Build record written: dist/${BUILD_MARKER} (renderer inputs ${result.marker.rendererHash.slice(0, 12)}, not verified).`)
  else console.warn(`No build record: ${result.reason}.`)
  // An input edited after the build leaves no record, but the build itself worked: only a missing build fails.
  if (!result.marked && /missing/.test(result.reason)) process.exitCode = 1
  return Promise.resolve()
}

// ---------------------------------------------------------------------------------------------------------------
// The foreground run

async function main() {
  // A runtime or full restart ends the command tree of the agent that ran this script: writing after that must not
  // crash it (the detached watcher does the work and writes the report).
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => { /* The reader is gone. */ })
  const argumentError = cli.errors[0]
    || (!LEVELS.includes(forcedLevel) ? `--level must be one of ${LEVELS.join(', ')} (got "${forcedLevel}")` : null)
    || (noVerify && verifyOnly ? '--no-verify and --verify-only exclude each other' : null)
  if (argumentError) failWithReport(argumentError, { nextAction: 'fix-arguments' })
  const startedMs = Date.now()
  const started = new Date(startedMs).toISOString()
  const runId = `${startedMs.toString(36)}-${process.pid}`
  // Under `npm run dev` (ORBIT_DEV=1, inherited by the agents' commands) a restart would stop the dev server with it.
  const devMode = process.env.ORBIT_DEV === '1'
  if (devMode && !dryRun && !noRelaunch && !verifyOnly) failWithReport(DEV_MODE_MESSAGE, { runId, status: 'dev-mode', nextAction: 'restart-orbit-by-hand', exitCode: 2 })
  // Without a health report (ORBIT_HEALTH_FILE=0) every restart would end in a timeout and a rollback of good code.
  if (!PATHS.health && !dryRun && !noRelaunch && !verifyOnly) failWithReport(NO_HEALTH_MESSAGE, { runId, status: 'no-health-report', nextAction: 'restart-orbit-by-hand', exitCode: 2 })
  try { sweepParked() } catch { /* Housekeeping only. */ }
  let tools = null
  let toolchainError = null
  try { tools = toolchain() } catch (error) { toolchainError = error.message }
  const fingerprintBegan = Date.now()
  const fingerprint = fingerprints(root)
  const renderer = rendererState(root)
  const fingerprintMs = Date.now() - fingerprintBegan
  const sourceAtStart = newestSourceChange()
  const marker = readBuildMarker(DIST)
  const distPresent = fs.existsSync(path.join(DIST, 'index.html'))
  const build = buildDecision({ marker, renderer, distPresent, force })
  const verify = verifyDecision({ marker, fingerprint, renderer, sourceNewest: sourceAtStart.time, noVerify, force })
  // The profile of the Orbit to restart: ORBIT_USER_DATA (Orbit sets it for its agents' commands) wins over the health
  // report's, and a report of another profile (a second instance of this repository) says nothing about this one.
  const envUserData = process.env.ORBIT_USER_DATA ? path.resolve(process.env.ORBIT_USER_DATA) : null
  const observe = () => observeOrbit({ userData: envUserData })
  const observed = observe()
  const decide = (seen, willBuild) => decideLevel({ forced: forcedLevel, running: seen.running.length > 0, health: seen.runningHealth, healthNote: seen.healthNote, fingerprint, rendererInputs: renderer.hash, distMtime: indexMtime(DIST), willBuild })
  const predicted = decide(observed, build.needed)
  // The instance that runs now, as a rollback identifies its code (rollbackBase).
  const instanceOf = (health) => (health ? { pid: health.pid, startedAt: health.startedAt, shellHash: health.shellHash || null, runtimeHash: health.runtimeHash || null, rendererHash: health.rendererHash || null } : null)
  const profileOf = (seen) => ({ userData: envUserData || (typeof seen.runningHealth?.userData === 'string' ? seen.runningHealth.userData : null), userDataSource: envUserData ? 'ORBIT_USER_DATA' : seen.runningHealth?.userData ? 'health report' : null })
  const lastGood = tools?.git ? readRef('last-good') : null
  const intentOptions = { env: process.env, intentFile: cli.values['--intent-file'] || null, reason: cli.values['--reason'] || null, continueWith: cli.values['--continue-with'] || null, verify: !noVerify, id: runId }
  const intentPreview = resolveIntent({ ...intentOptions, level: predicted.level })
  const levelFields = (decision, intentPlan) => ({ level: decision.level, levelReason: decision.reason, intentFile: intentPlan.file, intentWritten: false, ...(intentPlan.note ? { intentNote: intentPlan.note } : {}) })
  const commandFor = (level) => (tools && LEVEL_FLAGS[level] ? `"${tools.electron}" "${root}" ${LEVEL_FLAGS[level]}` : null)
  const plan = {
    runId, root, dryRun, force, noVerify, forcedLevel,
    steps: planSteps({ verifyOnly, noRelaunch: noRelaunch || predicted.level === 'none', desktop: runDesktop, verify: verify.needed, build: build.needed }),
    tools, toolchainError, ...levelFields(predicted, intentPreview), build, verify,
    fingerprint, rendererHash: renderer.hash, fingerprintMs, distPresent, newestSource: sourceAtStart.file, marker,
    running: observed.running, healthFile: PATHS.health, health: healthSummary(observed.health), healthIsRunning: !!observed.runningHealth,
    ...(observed.healthNote ? { healthNote: observed.healthNote } : {}), ...profileOf(observed),
    lastGood, healthTimeoutMs,
    cycles: { used: readCycles().length, max: maxCycles, windowMinutes: cycleWindowMs / 60000, counts: countsAsRestart(predicted.level) },
    intent: intentPreview.intent ? { file: intentPreview.file, runId: intentPreview.intent.runId, source: intentPreview.intent.source, reason: intentPreview.intent.reason, continueWith: intentPreview.intent.continueWith } : null,
    relaunchCommand: commandFor(predicted.level),
    ...(devMode ? { devMode: true, devModeNote: 'ORBIT_DEV=1: a run without --dry-run, --no-relaunch or --verify-only refuses to restart Orbit (status dev-mode)' } : {}),
  }
  // Where a rollback of this restart would take the sources from.
  if (dryRun && tools?.git) plan.rollbackBase = chooseRollbackBase({ lastGood, previous: instanceOf(observed.runningHealth), previousNote: observed.healthNote }, PATHS, rollbackParts(predicted.level, { built: build.needed }))

  if (dryRun) {
    const ok = !toolchainError
    writeReport({ ok, status: ok ? 'dry-run' : 'failed', nextAction: ok ? 'run-without-dry-run' : 'fix-build-tools', timestamp: started, mode: 'dry-run', phase: 'done', ...plan })
    console.log(JSON.stringify({ ok, mode: 'dry-run', level: predicted.level, levelReason: predicted.reason, report: REPORT_FILE, ...plan }, null, 2))
    if (!ok) process.exitCode = 1
    return
  }
  if (!tools) failWithReport(`Build tools cannot be resolved: ${toolchainError}`, { runId, nextAction: 'fix-build-tools', ...levelFields(predicted, intentPreview) })
  if (!tools.git) console.warn('git is not available: the last-good snapshot and the source rollback are off; dist-prev/ still is restored.')

  const upToDate = (message, extra = {}) => {
    writeReport({ ok: true, status: 'up-to-date', nextAction: 'edit-source-then-rerun', runId, timestamp: started, phase: 'done', ...levelFields(predicted, intentPreview), newestSource: sourceAtStart.file, marker, running: observed.running, ...extra })
    console.log(message)
    console.log(`Report: ${REPORT_FILE}`)
  }
  const stopAtCycleLimit = (decision, intentPlan) => {
    writeReport({ ok: false, status: 'cycle-limit', nextAction: 'review-and-rerun-later', runId, timestamp: started, phase: 'done', ...levelFields(decision, intentPlan), cycles: { ...plan.cycles, used: readCycles().length } })
    console.error(`Orbit was restarted ${readCycles().length} times in the last ${cycleWindowMs / 60000} minutes (ORBIT_UPGRADE_MAX_CYCLES=${maxCycles}); a ${decision.level} restart is not started. Review the changes; raise the limit or wait before the next restart.`)
    process.exit(2)
  }
  if (verifyOnly && !verify.needed) return upToDate(`Nothing to verify: ${verify.reason}. Pass --force to run the checks anyway.`)
  if (noRelaunch && !verify.needed && !build.needed) {
    return upToDate(predicted.level === 'none'
      ? 'Nothing to verify or build, and the running Orbit already runs it.'
      : `Nothing to verify or build (${build.reason}). To apply it: Orbit.cmd ${LEVEL_FLAGS[predicted.level]} (${predicted.reason}).`,
    predicted.level === 'none' ? {} : { nextAction: 'relaunch', relaunchCommand: plan.relaunchCommand })
  }
  if (!verifyOnly && !noRelaunch && predicted.level === 'none') return upToDate(`Nothing to apply: ${predicted.reason}${observed.runningHealth ? ` (pid ${observed.runningHealth.pid})` : ''}. Pass --force to verify and rebuild anyway.`)
  if (!verifyOnly && !noRelaunch && countsAsRestart(predicted.level) && cycleLimitReached()) stopAtCycleLimit(predicted, intentPreview)

  try { acquireLock() } catch (error) { failWithReport(error.message, { runId, status: 'locked', nextAction: 'wait-for-running-upgrade', exitCode: 2, ...levelFields(predicted, intentPreview) }) }
  // The user's stop (the restart host's cancel marker) ends the run at the next step boundary.
  const stopIfCancelled = (when) => {
    const stop = cancelRequested(PATHS, startedMs)
    if (stop) throw new CancelledError(stop, when)
  }
  const { timings, step } = createTimer(console.log, (name) => stopIfCancelled(`before the step ${name}`))
  let candidate = null
  let distPrevSaved = false
  let distDirty = false
  let markerWritten = false
  const checksLog = verify.needed || build.needed ? startChecksLog(PATHS.checksLog, runId) : null
  const check = (label, command, commandArgs) => run(label, command, commandArgs, { log: checksLog })
  const details = () => ({ runId, started, timings, lastGood, candidate, distPrevSaved, built: build.needed, verified: verify.needed, ...(checksLog ? { checksLog } : {}), ...levelFields(predicted, intentPreview) })
  const cancelled = (error, extra = {}) => failWithReport(error.message, { ...details(), status: 'cancelled', nextAction: 'none', exitCode: 2, cancel: error.stop, ...extra })

  try {
    if (verify.needed) {
      await step('typecheck', async () => { await check('typecheck', process.execPath, [tools.tsc, '--noEmit']); await check('typecheck:main', process.execPath, [tools.tsc, '-p', 'tsconfig.main.json']) })
      await step('test', () => check('test', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...testFiles()]))
      await step('smoke', () => check('smoke', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join('scripts', 'smoke-runtime.cjs')]))
      await step('main-load', () => check('main-load', process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', path.join('tests', 'main-load.test.cjs')]))
      if (runDesktop) await step('smoke:desktop', () => check('smoke:desktop', process.execPath, [path.join('scripts', 'run-electron.cjs'), path.join('scripts', 'smoke-desktop.cjs')]))
    } else console.log(`Skipping the checks: ${verify.reason}.`)
    if (verifyOnly) {
      writeReport({ ok: true, status: 'verify-only', nextAction: 'build-when-ready', phase: 'done', finished: new Date().toISOString(), ...details() })
      console.log(summarize({ ok: true, status: 'verify-only', nextAction: 'build-when-ready', timings }))
      return
    }
    // The candidate carries all three hashes: as last-good it may be the base of a later rollback of src/ as well.
    const candidateHashes = { ...fingerprint, renderer: renderer.hash }
    if (build.needed) {
      await step('save-previous', () => {
        distPrevSaved = saveDistPrev()
        if (tools.git) candidate = snapshotTree({ label: 'candidate', fingerprint: candidateHashes })
      })
      distDirty = true
      await step('build', () => check('build', process.execPath, [tools.vite, 'build']))
    } else {
      console.log(`Skipping the renderer build: ${build.reason}.`)
      if (tools.git) await step('snapshot', () => { candidate = snapshotTree({ label: 'candidate', fingerprint: candidateHashes }) })
    }
    // A source edit that landed during the checks or the build was never verified: this state must not go live.
    const fingerprintAtEnd = fingerprints(root)
    if (fingerprintAtEnd.shell !== fingerprint.shell || fingerprintAtEnd.runtime !== fingerprint.runtime || rendererState(root).hash !== renderer.hash) {
      const newest = newestSourceChange()
      throw new Error(`${newest.time > sourceAtStart.time ? newest.file : 'the sources'} changed while the checks were running; run self-upgrade again`)
    }
    if (build.needed || verify.needed) {
      writeBuildMarker(DIST, nextBuildMarker({ previous: marker, built: build.needed, verified: verify.needed, renderer, fingerprint, source: sourceAtStart, candidate }))
      markerWritten = true
    }
    distDirty = false
  } catch (error) {
    let distRestored = false
    if (distDirty && distPrevSaved) { try { restoreDistPrev(); distRestored = true } catch { /* Reported below as not restored. */ } }
    if (error instanceof CancelledError) cancelled(error, { distRestored })
    failWithReport(error.message, { ...details(), distRestored, ...(error.failures?.length ? { failures: error.failures, failuresTotal: error.failuresTotal } : {}) })
  }

  // Decided again: during the checks Orbit may have been closed, or restarted with this code by hand.
  const observedNow = verify.needed || build.needed ? observe() : observed
  const decision = decide(observedNow, false)
  if (decision.level !== predicted.level) console.log(`\nLevel ${decision.level} instead of ${predicted.level}: ${decision.reason}`)
  const intentPlan = resolveIntent({ ...intentOptions, level: decision.level, commit: candidate?.head || (tools.git ? headCommit() : null), snapshot: candidate?.commit || null })
  const base = {
    ok: null, status: 'relaunching', nextAction: 'wait-for-health', runId, started, timings, ...levelFields(decision, intentPlan),
    built: build.needed, verified: verify.needed, lastGood, candidate, distPrevSaved, healthTimeoutMs, phase: 'relaunching',
  }
  if (noRelaunch) {
    const relaunchCommand = LEVEL_FLAGS[decision.level] ? `Orbit.cmd ${LEVEL_FLAGS[decision.level]}` : null
    writeReport({ ...base, ok: true, status: 'built', nextAction: relaunchCommand ? 'relaunch' : 'none', phase: 'done', finished: new Date().toISOString(), relaunchCommand })
    console.log(summarize({ ...base, ok: true, status: 'built', nextAction: relaunchCommand ? 'relaunch' : 'none' }))
    console.log(relaunchCommand ? `Apply it with: ${relaunchCommand} (${decision.reason})` : `Nothing to apply: ${decision.reason}.`)
    return
  }
  if (decision.level === 'none') {
    writeReport({ ...base, ok: true, status: 'up-to-date', nextAction: 'none', phase: 'done', finished: new Date().toISOString() })
    console.log(summarize({ ...base, ok: true, status: 'up-to-date', nextAction: 'none' }))
    console.log(`Nothing to apply: ${decision.reason}.`)
    return
  }
  if (countsAsRestart(decision.level) && cycleLimitReached()) stopAtCycleLimit(decision, intentPlan)
  try { stopIfCancelled('before the restart') } catch (error) { cancelled(error, { ...levelFields(decision, intentPlan) }) }

  const planFile = writeJson(PLAN_FILE, {
    runId, started, startedMs, level: decision.level, levelReason: decision.reason, candidate, lastGood, distPrevSaved, built: build.needed,
    markerWritten, markerBefore: marker, healthTimeoutMs, electron: tools.electron, running: observedNow.running,
    // The instance that runs now: a rollback takes the sources from its recorded code (rollbackBase).
    previous: instanceOf(observedNow.runningHealth), previousNote: observedNow.runningHealth ? null : observedNow.healthNote || null,
    ...profileOf(observedNow),
    // The watcher takes over only this lock (a stop that released it calls the restart off).
    lockNonce: heldLockNonce(),
    fingerprint, intent: intentPlan.intent ? { file: intentPlan.file, record: intentPlan.intent } : null, report: base,
  })
  writeReport(base)
  console.log(`\n==> ${decision.level} restart: ${LEVEL_FLAGS[decision.level]} (detached watcher) — ${decision.reason}`)
  if (intentPlan.intent) console.log(`The intent to continue run ${intentPlan.intent.runId} goes to ${intentPlan.file} right before the signal.`)
  else if (countsAsRestart(decision.level) && intentPlan.note) console.log(`No continuation intent: ${intentPlan.note}.`)
  spawnWatcher(planFile)
  handOverLock()
  // A rollback may take three health waits: the restart, the retry with the old code and a fresh start.
  const final = await awaitWatcher(runId, healthTimeoutMs * 3 + 60000)
  if (!final) {
    console.log(`The relaunch watcher has not reported yet; it continues on its own. Watch ${REPORT_FILE} and ${WATCH_LOG}.`)
    process.exitCode = 2
    return
  }
  console.log(summarize(final))
  process.exitCode = final.ok ? 0 : final.status === 'cancelled' ? 2 : 1
}

if (require.main === module) {
  const entry = watchPlan ? watch(watchPlan) : flags.has('--record-running') ? recordRunningCli() : flags.has('--mark-build') ? markBuildCli() : main()
  entry.catch((error) => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
}

module.exports = {
  SOURCE_ENTRIES, RENDERER_INPUTS, SNAPSHOT_PATHS, REF_PREFIX, RELAUNCH_FLAG, LEVEL_FLAGS, BUILD_MARKER,
  DEFAULT_REASON, DEFAULT_CONTINUE_WITH,
  parseArgs, upgradePaths, newestSourceChange, rendererState, readBuildMarker, writeBuildMarker, buildDecision,
  verifyDecision, nextBuildMarker, acquireLock, toolPath, toolchain, testFiles, planSteps, createTimer, isFreshHealth,
  waitForHealth, decideLevel, observeOrbit, snapshotTree, restoreTree, runtimeRestorePaths, readRef, saveDistPrev,
  restoreDistPrev, replaceDirectory, orbitLaunch, matchesOrbitProcess, findOrbitProcesses, readCycles, recordCycle,
  cycleLimitReached, resolveIntent, writeIntent, writeJsonAtomic, markIntentRolledBack, markIntentRelaunched, settleIntent,
  snapshotInfo, rollbackBase, chooseRollbackBase, recordRunning, relaunchAndWait, rollback, runWatcher, summarize,
  NO_BASE_NOTE, DEV_MODE_MESSAGE, NO_HEALTH_MESSAGE,
  // Restore (overlay, temporary index) and what a rollback puts back; `git` is the runner restoreTree uses by default.
  addedFiles, rollbackParts, git,
  // The lock (see its section for the format) and the stop marker: the restart host (runtime side) uses releaseLockOf,
  // and writes the marker requestCancel describes.
  LOCK_HEARTBEAT_MS, LOCK_STALE_MS, lockFile, takeOverLock, handOverLock, releaseLock, releaseLockOf, heldLockNonce,
  cancelRequested, requestCancel, clearCancel, CancelledError, watch,
  // --mark-build (npm run build).
  markBuild,
  // A check's output: its log and what failed in it.
  run, failureCollector, failureSummary, startChecksLog,
}
