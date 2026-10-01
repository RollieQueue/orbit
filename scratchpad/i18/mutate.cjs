// I18 (Antigravity keeps a cut turn's prompt, so the mail that prompt carried is held like Claude's; Codex and Cursor are
// given it again): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const PAUSE = 'electron/runtime/pause.mts'
const T = ['tests/steer-messages.test.cjs']
const mutations = [
  [PAUSE, T, 'antigravity not in the set (old behaviour)', "new Set(['claude', 'antigravity'])", "new Set(['claude'])"],
  [PAUSE, T, 'codex taken as keeping the prompt', "new Set(['claude', 'antigravity'])", "new Set(['claude', 'antigravity', 'codex'])"],
  [PAUSE, T, 'claude dropped from the set', "new Set(['claude', 'antigravity'])", "new Set(['antigravity'])"],
  [PAUSE, T, 'held whatever the provider', 'error.spoke && KEEPS_CUT_PROMPT.has(agent.providerId)', 'error.spoke'],
  [PAUSE, T, 'held also when the turn had not spoken', 'error.spoke && KEEPS_CUT_PROMPT.has(agent.providerId)', 'KEEPS_CUT_PROMPT.has(agent.providerId)'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, , name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Set(run(T).failed)
console.log(`baseline: ${baseline.size ? [...baseline].join(' | ') : 'all pass'}`)
let caught = 0
for (const [file, tests, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, () => to))
    const fresh = run(tests).failed.filter(test => !baseline.has(test))
    if (fresh.length) caught++
    console.log(`== ${name}: ${fresh.length ? `CAUGHT by ${fresh.join(' | ')}` : 'SURVIVED'}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
