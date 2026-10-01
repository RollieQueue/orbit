// I15 (the self-upgrade script reads the health report where ORBIT_HEALTH_FILE puts it; "0": no report, nothing
// restarts): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const SCRIPT = 'scripts/self-upgrade.cjs', MAIN = 'electron/main.cjs', RESUME = 'electron/resume.mts', RESTART = 'electron/runtime/restart.mts'
const TESTS = ['tests/self-upgrade.test.cjs'], LOAD = ['tests/main-load.test.cjs'], HOST = ['tests/restart-orbit.test.cjs'], LOOP = ['tests/improvement-loop-runtime.test.cjs']
const mutations = [
  [SCRIPT, TESTS, 'PATHS ignore the environment', 'const PATHS = upgradePaths(root, process.env)', 'const PATHS = upgradePaths(root)'],
  [SCRIPT, TESTS, 'test paths follow the environment', 'function upgradePaths(base = root, env = {})', 'function upgradePaths(base = root, env = process.env)'],
  [SCRIPT, TESTS, 'relative path from the cwd', 'path.resolve(base, value)', 'path.resolve(value)'],
  [SCRIPT, TESTS, '"0" is a file name', "return value && value !== '0' ? path.resolve", 'return value ? path.resolve'],
  [SCRIPT, TESTS, 'empty value is a file name', "return value && value !== '0' ? path.resolve", "return value !== '0' ? path.resolve"],
  [SCRIPT, TESTS, 'default when set', "if (value === undefined) return path.join(base, 'artifacts', 'self-upgrade-health.json')", "if (!value || value) return path.join(base, 'artifacts', 'self-upgrade-health.json')"],
  [SCRIPT, TESTS, 'healthPrev fixed in artifacts', 'healthPrev: health ? path.join(path.dirname(health), `${path.basename(health, extension)}-prev${extension}`) : null,', "healthPrev: path.join(artifacts, 'self-upgrade-health-prev.json'),"],
  [SCRIPT, TESTS, 'no refusal without a report', "  if (!PATHS.health && !dryRun && !noRelaunch && !verifyOnly) failWithReport(NO_HEALTH_MESSAGE, { runId, status: 'no-health-report', nextAction: 'restart-orbit-by-hand', exitCode: 2 })\n", ''],
  [SCRIPT, TESTS, 'dry-run refused', 'if (!PATHS.health && !dryRun && !noRelaunch', 'if (!PATHS.health && !noRelaunch'],
  [SCRIPT, TESTS, '--no-relaunch refused', '!dryRun && !noRelaunch && !verifyOnly) failWithReport(NO_HEALTH', '!dryRun && !verifyOnly) failWithReport(NO_HEALTH'],
  [SCRIPT, TESTS, '--verify-only refused', '!noRelaunch && !verifyOnly) failWithReport(NO_HEALTH', '!noRelaunch) failWithReport(NO_HEALTH'],
  [SCRIPT, TESTS, 'refusal exits 1', "status: 'no-health-report', nextAction: 'restart-orbit-by-hand', exitCode: 2", "status: 'no-health-report', nextAction: 'restart-orbit-by-hand'"],
  [SCRIPT, TESTS, 'refusal after the lock', "  if (!PATHS.health && !dryRun && !noRelaunch && !verifyOnly) failWithReport(NO_HEALTH_MESSAGE, { runId, status: 'no-health-report', nextAction: 'restart-orbit-by-hand', exitCode: 2 })\n", "  if (!PATHS.health && !dryRun && !noRelaunch && !verifyOnly) { try { require('node:fs').mkdirSync(PATHS.artifacts, { recursive: true }); require('node:fs').writeFileSync(lockFile(root), '{}') } catch {} failWithReport(NO_HEALTH_MESSAGE, { runId, status: 'no-health-report', nextAction: 'restart-orbit-by-hand', exitCode: 2 }) }\n"],
  [SCRIPT, TESTS, 'no note without a report', ": !paths.health ? 'Orbit writes no health report (ORBIT_HEALTH_FILE=0)' : null", ': null'],
  [SCRIPT, TESTS, 'plan without healthFile', 'healthFile: PATHS.health, ', ''],
  // From the review: main and the runtime resolve a relative path from the repository too, and restart_orbit says what to do.
  [MAIN, LOAD, 'main resolves from the cwd', 'path.resolve(repoRoot, process.env.ORBIT_HEALTH_FILE)', 'path.resolve(process.env.ORBIT_HEALTH_FILE)'],
  [RESUME, HOST, 'runtime resolves from the cwd', 'path.resolve(root, value)', 'path.resolve(value)'],
  [RESTART, LOOP, 'no hint for no-health-report', "  'no-health-report': ", "  'no-health-report-x': "],
  [RESTART, LOOP, 'no-health-report not deferred', "result.status === 'cycle-limit' || result.status === 'no-health-report' ?", "result.status === 'cycle-limit' ?"],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, , name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Map()
for (const tests of [TESTS, LOAD, HOST, LOOP]) {
  const { failed } = run(tests)
  baseline.set(tests, new Set(failed))
  console.log(`baseline ${tests.join(' ')}: ${failed.length ? failed.join(' | ') : 'all pass'}`)
}
let caught = 0
for (const [file, tests, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    const { out, failed } = run(tests)
    const fresh = failed.filter(line => !baseline.get(tests).has(line))
    if (fresh.length) caught++
    console.log(`== ${name}: ${fresh.length ? fresh.map(line => line.slice(0, 90)).join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
