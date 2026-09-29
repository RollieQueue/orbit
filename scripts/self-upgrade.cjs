'use strict'

/**
 * Orbit self-upgrade bootstrap:
 * verify (typecheck → test → smoke [→ smoke:desktop]) → package:win → relaunch newest Orbit-standalone-*.
 *
 * On relaunch the child always receives:
 *   ORBIT_SELF_UPGRADE=1
 *   ORBIT_SELF_UPGRADE_BUNDLE=<Orbit-standalone-v… name>
 * When --loop / ORBIT_UPGRADE_LOOP=1 is set, the child also receives ORBIT_UPGRADE_LOOP=1.
 * Continuation of the improve→verify→package cycle is then the new process's job (handoff);
 * this script does not claim permanent success — it records nextAction and exits.
 *
 * Flags:
 *   --dry-run              print plan / current newest bundle; no commands (fails if the build
 *                          tools cannot be resolved)
 *   --no-relaunch          stop after successful package
 *   --skip-desktop         skip smoke:desktop (default: skip; pass --desktop to enable)
 *   --desktop              run smoke:desktop before package
 *   --skip-package         verify only
 *   --force                rebuild even when no source file changed since the newest bundle
 *   --loop                 handoff mode: after package+relaunch, document that the new
 *                          Orbit process continues the loop (same as ORBIT_UPGRADE_LOOP=1)
 *   --exit-after-relaunch  after a successful detached spawn of Orbit.exe, exit this
 *                          Node process with code 0 (same as ORBIT_SELF_UPGRADE_EXIT=1).
 *                          Only terminates the process running this script (typically
 *                          `node scripts/self-upgrade.cjs`). It does not close other
 *                          Electron windows unless this script is the main process.
 *                          Prefer with --loop when the parent should yield to the child.
 *
 * Env (boolean when set to "1" / "true" / "yes", case-insensitive):
 *   ORBIT_UPGRADE_LOOP=1       same as --loop
 *   ORBIT_SELF_UPGRADE_EXIT=1  same as --exit-after-relaunch
 * Env (numbers):
 *   ORBIT_UPGRADE_MAX_CYCLES   most relaunch cycles a --loop chain may run (default 3)
 *   ORBIT_UPGRADE_CYCLE        set by this script for the relaunched process; do not set by hand
 *
 * Nothing is rebuilt when the sources are not newer than the sources the newest bundle was built
 * from (recorded in <bundle>/orbit-build.json; a bundle without the record is rebuilt once). Only
 * one self-upgrade may run at a time (artifacts/self-upgrade.lock), a bundle whose sources changed
 * while it was being built is discarded instead of published, and a --loop chain stops after
 * ORBIT_UPGRADE_MAX_CYCLES cycles. Together these keep a chain from rebuilding code forever.
 *
 * Report: artifacts/self-upgrade-last.json
 *   bundle, timestamp, status, nextAction (+ ok, completed, relaunch, …)
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { findNewestStandalone, listStandaloneBundles } = require('./standalone-resolve.cjs')

const root = path.resolve(__dirname, '..')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const noRelaunch = args.has('--no-relaunch')
const skipPackage = args.has('--skip-package')
const force = args.has('--force')
const runDesktop = args.has('--desktop') && !args.has('--skip-desktop')

function envFlag(name) {
  const raw = process.env[name]
  if (raw == null || raw === '') return false
  return /^(1|true|yes)$/i.test(String(raw).trim())
}

const loopMode = args.has('--loop') || envFlag('ORBIT_UPGRADE_LOOP')
const exitAfterRelaunch = args.has('--exit-after-relaunch') || envFlag('ORBIT_SELF_UPGRADE_EXIT')
const cycle = Math.max(0, Math.floor(Number(process.env.ORBIT_UPGRADE_CYCLE) || 0))
const maxCycles = Math.max(1, Math.floor(Number(process.env.ORBIT_UPGRADE_MAX_CYCLES) || 3))

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

function run(label, command, commandArgs) {
  console.log(`\n==> ${label}`)
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} exited with ${result.status}`)
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Entry file of a dependency's executable. Modern packages hide their bin files behind an `exports`
 * map, so `require.resolve('typescript/bin/tsc')` throws; the declared `bin` field is the supported route.
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

function toolchain() {
  return {
    tsc: toolPath('typescript', 'tsc'),
    vite: toolPath('vite', 'vite'),
    electronBuilder: require.resolve('electron-builder/cli.js'),
  }
}

// Inputs that end up inside the packaged application.
const SOURCE_ENTRIES = ['electron', 'src', 'package.json', 'index.html', 'vite.config.ts', 'tsconfig.json']

/** Newest modification time among the files a bundle is built from. */
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

const BUILD_MARKER = 'orbit-build.json'

/** The sources a bundle was built from. Missing for bundles made without this script (provenance unknown). */
function readBuildMarker(bundle) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(bundle.dir, BUILD_MARKER), 'utf8'))
    return Number.isFinite(marker.sourceNewest) ? marker : null
  } catch {
    return null
  }
}

function writeBuildMarker(bundle, marker) {
  fs.writeFileSync(path.join(bundle.dir, BUILD_MARKER), JSON.stringify(marker, null, 2), 'utf8')
}

/** Removes a bundle this run just built; never anything that is not one of our numbered bundles. */
function discardBundle(bundle, base = root) {
  if (path.dirname(bundle.dir) !== base || !/^Orbit-standalone-v\d+$/.test(bundle.name)) return false
  try { fs.rmSync(bundle.dir, { recursive: true, force: true }); return true } catch { return false }
}

/** One self-upgrade at a time: two concurrent builds would both publish a bundle and relaunch. */
function acquireLock(base = root) {
  const file = path.join(base, 'artifacts', 'self-upgrade.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
      process.on('exit', () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file) } catch { /* Already gone. */ }
      })
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let holder = null
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* Unreadable lock is stale. */ }
      let alive = false
      // EPERM means the process exists but belongs to someone else (elevated, another user): still running.
      if (holder?.pid) { try { process.kill(holder.pid, 0); alive = true } catch (killError) { alive = killError.code === 'EPERM' } }
      if (alive && Date.now() - holder.startedAt < 45 * 60 * 1000) fail(`Another self-upgrade is already running (pid ${holder.pid}). Wait for it to finish.`)
      try { fs.unlinkSync(file) } catch { /* Lost the race to another cleanup. */ }
    }
  }
  fail('Could not acquire the self-upgrade lock.')
}

function testFiles() {
  return fs.readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('.test.cjs'))
    .map((name) => path.join('tests', name))
    .sort()
}

function runVerifySteps(completed, tools) {
  run('typecheck', process.execPath, [tools.tsc, '--noEmit'])
  completed.push('typecheck')

  run('test', process.execPath, ['--test', ...testFiles()])
  completed.push('test')

  run('smoke', process.execPath, [path.join('scripts', 'smoke-runtime.cjs')])
  completed.push('smoke')

  if (runDesktop) {
    run('smoke:desktop', process.execPath, [path.join('scripts', 'run-electron.cjs'), path.join('scripts', 'smoke-desktop.cjs')])
    completed.push('smoke:desktop')
  }
}

function runPackage(completed, tools) {
  run('build:typecheck', process.execPath, [tools.tsc, '--noEmit'])
  run('build:vite', process.execPath, [tools.vite, 'build'])
  run('package:win', process.execPath, [path.join('scripts', 'package-win.cjs')])
  completed.push('package:win')
}

function writeReport(report) {
  const dir = path.join(root, 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'self-upgrade-last.json')
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

/** A failure the next reader of self-upgrade-last.json must be able to see, not only the console. */
function failWithReport(message, details = {}) {
  const reportPath = writeReport({
    ok: false, timestamp: new Date().toISOString(), status: 'failed', nextAction: 'fix-and-retry',
    error: message, loop: loopMode, relaunch: false, ...details,
  })
  fail(`${message}\nReport: ${reportPath}`)
}

/**
 * Spawn newest Orbit.exe detached with self-upgrade handoff env.
 * Does not wait for the child; caller decides whether to exit this process.
 */
function relaunch(bundle, { loop } = {}) {
  console.log(`\n==> relaunch ${bundle.exe}`)
  const childEnv = {
    ...process.env,
    ORBIT_SELF_UPGRADE: '1',
    ORBIT_SELF_UPGRADE_BUNDLE: bundle.name,
    ORBIT_UPGRADE_CYCLE: String(cycle + 1),
  }
  // Started with this variable Orbit.exe behaves as plain Node: no window, silent exit. It leaks in from
  // shells launched by Electron or a VS Code host, and from commands an agent runs inside Orbit.
  delete childEnv.ELECTRON_RUN_AS_NODE
  if (loop) childEnv.ORBIT_UPGRADE_LOOP = '1'
  else delete childEnv.ORBIT_UPGRADE_LOOP
  const child = spawn(bundle.exe, [], {
    cwd: bundle.dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: childEnv,
  })
  // A failed start is reported asynchronously; without a listener it would crash this script after its report.
  child.on('error', (error) => console.error(`Could not start ${bundle.exe}: ${error.message}`))
  child.unref()
  return child
}

function stillRunning(child) {
  try { process.kill(child.pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function buildReportBase({ started, completed, before, after, error }) {
  const timestamp = new Date().toISOString()
  const bundle = after?.name || before?.name || null
  return {
    ok: !error,
    bundle,
    timestamp,
    status: error ? 'failed' : null,
    nextAction: error ? 'fix-and-retry' : null,
    started,
    finished: timestamp,
    completed,
    error: error || undefined,
    newestBefore: before?.name || null,
    newestAfter: after?.name || null,
    loop: loopMode,
    relaunch: false,
  }
}

function main() {
  const before = findNewestStandalone(root)
  const sourceAtStart = newestSourceChange()
  const marker = before ? readBuildMarker(before) : null
  // A bundle built without this script has no marker: its provenance is unknown, so rebuild once to record it.
  const upToDate = !!before && !!marker && sourceAtStart.time <= marker.sourceNewest
  let tools = null
  let toolchainError = null
  try { tools = toolchain() } catch (error) { toolchainError = error.message }
  const plan = {
    root,
    dryRun,
    loop: loopMode,
    cycle,
    maxCycles,
    exitAfterRelaunch,
    steps: [
      'typecheck',
      'test',
      'smoke',
      ...(runDesktop ? ['smoke:desktop'] : []),
      ...(skipPackage ? [] : ['package:win']),
      ...(noRelaunch || skipPackage ? [] : ['relaunch']),
    ],
    newestBefore: before ? before.name : null,
    upToDate,
    newestSource: sourceAtStart.file,
    standaloneCount: listStandaloneBundles(root).length,
    tools,
    toolchainError,
    handoffEnv: noRelaunch || skipPackage
      ? null
      : {
          ORBIT_SELF_UPGRADE: '1',
          ORBIT_SELF_UPGRADE_BUNDLE: '<newest bundle name after package>',
          ORBIT_UPGRADE_CYCLE: String(cycle + 1),
          ...(loopMode ? { ORBIT_UPGRADE_LOOP: '1' } : {}),
        },
  }

  if (dryRun) {
    const timestamp = new Date().toISOString()
    const reportPath = writeReport({
      ok: !toolchainError,
      bundle: before?.name || null,
      timestamp,
      status: toolchainError ? 'failed' : 'dry-run',
      nextAction: toolchainError ? 'fix-build-tools' : 'run-without-dry-run',
      ...plan,
      mode: 'dry-run',
    })
    console.log(JSON.stringify({ ok: !toolchainError, mode: 'dry-run', report: reportPath, ...plan }, null, 2))
    if (toolchainError) process.exitCode = 1
    return
  }

  if (!tools) failWithReport(`Build tools cannot be resolved: ${toolchainError}`, { newestBefore: before?.name || null })

  if (loopMode && cycle >= maxCycles) {
    const reportPath = writeReport({
      ok: true, bundle: before?.name || null, timestamp: new Date().toISOString(), status: 'cycle-limit',
      nextAction: 'review-and-rerun-manually', newestBefore: before?.name || null, loop: true, cycle, maxCycles, relaunch: false,
    })
    console.log(`Loop stopped after ${cycle} cycle(s) (ORBIT_UPGRADE_MAX_CYCLES=${maxCycles}). Review the changes, then run self-upgrade again.`)
    console.log(`Report: ${reportPath}`)
    return
  }

  if (!skipPackage && !force && upToDate) {
    const reportPath = writeReport({
      ok: true, bundle: before.name, timestamp: new Date().toISOString(), status: 'up-to-date',
      nextAction: 'edit-source-then-rerun', newestBefore: before.name, newestAfter: before.name,
      loop: loopMode, relaunch: false, newestSource: sourceAtStart.file,
    })
    console.log(`Nothing changed since ${before.name} was built; not rebuilding. Pass --force to rebuild anyway.`)
    console.log(`Report: ${reportPath}`)
    return
  }

  acquireLock()
  const started = new Date().toISOString()
  const completed = []

  try {
    runVerifySteps(completed, tools)
    if (!skipPackage) runPackage(completed, tools)
  } catch (error) {
    failWithReport(error.message, buildReportBase({
      started,
      completed,
      before,
      after: findNewestStandalone(root),
      error: error.message,
    }))
  }

  const after = findNewestStandalone(root)
  if (!skipPackage) {
    const details = { started, completed, newestBefore: before?.name || null, newestAfter: after?.name || null }
    if (!after) failWithReport('package:win finished but no Orbit-standalone-*/Orbit.exe was found', details)
    if (before && after.name === before.name) failWithReport(`Expected a new Orbit-standalone-* bundle, still at ${after.name}`, details)
    if (before && after.version <= before.version) failWithReport(`New bundle ${after.name} is not newer than ${before.name}`, details)
    // The tests ran before the bundle was built. A source edit that landed in between was never verified,
    // and Orbit.cmd would pick this bundle as the newest one, so it is discarded rather than published.
    const sourceAtEnd = newestSourceChange()
    if (sourceAtEnd.time > sourceAtStart.time) {
      const removed = discardBundle(after)
      failWithReport(`${sourceAtEnd.file} changed while the bundle was being built; ${removed ? 'the unverified bundle was discarded' : 'the bundle may not match the tested sources'}. Run self-upgrade again.`, details)
    }
    writeBuildMarker(after, { builtAt: new Date().toISOString(), sourceNewest: sourceAtStart.time, sourceFile: sourceAtStart.file })
  }

  const report = buildReportBase({ started, completed, before, after, error: null })

  if (skipPackage) {
    report.status = 'verify-only'
    report.nextAction = 'package-when-ready'
  } else if (noRelaunch) {
    report.status = 'packaged'
    report.nextAction = 'relaunch-or-run-orbit-cmd'
  } else {
    const child = relaunch(after, { loop: loopMode })
    // Orbit quits at once when another instance already holds its single-instance lock (the normal case
    // when this runs inside Orbit), so give it a moment and say what that outcome usually means.
    pause(2500)
    report.relaunch = true
    report.relaunchTarget = after.exe
    report.relaunchAlive = stillRunning(child)
    report.ORBIT_SELF_UPGRADE = '1'
    report.ORBIT_SELF_UPGRADE_BUNDLE = after.name
    report.cycle = cycle + 1
    if (!report.relaunchAlive) report.note = 'The new Orbit exited within 2.5 s. Usually another Orbit is still running: close it and start Orbit.cmd. Otherwise start the bundle by hand to see its error.'
    if (loopMode) {
      report.status = 'handoff'
      report.nextAction = 'continue-improvement-in-new-process'
      report.ORBIT_UPGRADE_LOOP = '1'
      report.handoff = {
        message:
          `Parent packaged and relaunched (cycle ${cycle + 1} of at most ${maxCycles}); the verify→improve cycle continues in the new Orbit process (ORBIT_SELF_UPGRADE / ORBIT_UPGRADE_LOOP). This run is a handoff, not terminal success.`,
      }
    } else {
      report.status = 'relaunched'
      report.nextAction = exitAfterRelaunch ? 'parent-exiting' : 'close-previous-window'
    }
  }

  const reportPath = writeReport(report)
  console.log(`\nSelf-upgrade ${report.status}. Bundle: ${after?.name || '(unchanged)'}`)
  console.log(`Report: ${reportPath}`)
  console.log(`nextAction: ${report.nextAction}`)
  if (report.note) console.log(report.note)

  if (report.relaunch) {
    if (loopMode) {
      console.log(
        'Handoff: new Orbit started with ORBIT_SELF_UPGRADE=1 and ORBIT_UPGRADE_LOOP=1.',
      )
      console.log('Continuation of the upgrade loop is on the new process — not a permanent success of this parent.')
    } else {
      console.log('New Orbit instance started with ORBIT_SELF_UPGRADE=1.')
      if (!exitAfterRelaunch) {
        console.log('Close the previous window to finish the handoff (or pass --exit-after-relaunch).')
      }
    }
  }

  if (report.relaunch && exitAfterRelaunch) {
    console.log(
      'Exiting parent Node process after successful relaunch (--exit-after-relaunch / ORBIT_SELF_UPGRADE_EXIT).',
    )
    // Detached child already unref()'d; exit only this script process.
    process.exit(0)
  }
}

if (require.main === module) main()

module.exports = { newestSourceChange, readBuildMarker, writeBuildMarker, discardBundle, acquireLock, toolPath, toolchain, SOURCE_ENTRIES }
