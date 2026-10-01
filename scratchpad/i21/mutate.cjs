// I21 (a cancellation while the Codex App Server session opens kills the process and keeps no session): each mutation
// must make a test fail that passes without it. Files are restored. Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const CS = 'electron/codex-server.mts'
const T = ['tests/providers-session.test.cjs', 'tests/codex-server.test.cjs']
const NL = '\r\n'
const mutations = [
  [CS, 'no abort listener while the session opens', "  options.signal?.addEventListener('abort', cancelOpen, { once: true })" + NL, ''],
  [CS, 'the open fails before the process tree is gone', '    await fail(error as Error)' + NL + '    throw error' + NL, '    fail(error as Error)' + NL + '    throw error' + NL],
  [CS, 'a request after the close fails with a generic error, not the cancellation', "reject(failure || new Error('Codex connection closed'))", "reject(new Error('Codex connection closed'))"],
  [CS, 'a session closed between the answer and registration is kept', '    if (closed) throw failure' + NL, ''],
  [CS, 'a session closed after the answer fails with a generic error', '    if (closed) throw failure' + NL, "    if (closed) throw new Error('Codex connection closed')" + NL],
  [CS, 'no check of an already cancelled open', '  if (options.signal?.aborted) throw cancelledError()' + NL + '  const launch', '  const launch'],
  [CS, 'a cancellation at the thread event leaves the opened session', '  if (options.signal?.aborted) { if (opened) await live.close(); throw cancelledError() }' + NL, ''],
  [CS, 'a cancellation at the thread event closes a reused session too', 'if (opened) await live.close()', 'await live.close()'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', '--test-timeout=60000', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
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
