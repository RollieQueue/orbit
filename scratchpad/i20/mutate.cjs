// I20 (a turn's record names no session for a CLI that names its own until its stream does; rootSession trusts the record
// for every provider): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TURN = 'electron/runtime/turn.mts', RES = 'electron/resume.mts'
const T = ['tests/restart-orbit.test.cjs', 'tests/steer-messages.test.cjs']
const RULE = "(session.resume || agent.providerId === 'claude')"
const OPENED = '? timing?.sessionId || null : null'
const mutations = [
  [TURN, "record starts with Orbit's proposed id (old behaviour)", `sessionId: session && ${RULE} ? session.id || null : null }`, 'sessionId: session?.id || null }'],
  [TURN, "Claude's first turn records no session", RULE, '(session.resume)'],
  [TURN, 'a resumed turn of another CLI records none until its stream names it', RULE, "(agent.providerId === 'claude')"],
  [TURN, "a cut first turn resumes Orbit's proposed id", OPENED, '? session.id : null'],
  [TURN, 'a cut first turn never resumes', OPENED, '? null : null'],
  [RES, 'Claude-only gate back in rootSession', 'if (!Array.isArray(root.turnTimings)) return undefined', "if (root.providerId !== 'claude' || !Array.isArray(root.turnTimings)) return undefined"],
  [RES, 'no handover check', "if (typeof switchedAt === 'string' && String(timing.startedAt ?? '') < switchedAt) return undefined", ''],
  [RES, 'a turn that called no tool is resumed too', '  if (!(Number(timing.orbitToolCalls) > 0 || Number(timing.nativeToolCalls) > 0)) return undefined\n', ''],
  [TURN, 'no stray check on the resume after a restart', '(agent.pausedSession === session.id || run.resumeSession === session.id)', '(agent.pausedSession === session.id)'],
  [RES, 'the record of the cut turn is ignored', 'return { id: timing.sessionId, providerId: root.providerId, ...mark }', 'return undefined'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Set(run(T).failed)
console.log(`baseline: ${baseline.size ? [...baseline].join(' | ') : 'all pass'}`)
let caught = 0
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, () => to))
    const fresh = run(T).failed.filter(test => !baseline.has(test))
    if (fresh.length) caught++
    console.log(`== ${name}: ${fresh.length ? `CAUGHT by ${fresh.join(' | ')}` : 'SURVIVED'}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
