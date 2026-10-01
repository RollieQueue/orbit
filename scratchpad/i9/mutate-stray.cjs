// The stray-session guard: without it, or without the restriction to a resume after a cut, the named tests must fail.
const fs = require('fs'), { execFileSync } = require('child_process')
const file = 'electron/runtime/turn.mts', orig = fs.readFileSync(file, 'utf8')
const mutations = [
  ['no stray guard', '{ strayed = named; controller.abort() }', '{ }'],
  ['stray not coded', "{ code: 'ORBIT_SESSION_ID' })", '{ })'],
  ['stray not refunded', "    if (strayed && !signal.aborted) {\n      refund()\n", "    if (strayed && !signal.aborted) {\n"],
]
try {
  for (const [name, from, to] of mutations) {
    if (!orig.includes(from)) { console.log(name, 'PATTERN NOT FOUND'); continue }
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', 'tests/steer-messages.test.cjs'], { encoding: 'utf8', timeout: 180000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    console.log(`== ${name}:`, (out.match(/^not ok .*$/gm) || ['(all pass)']).join(' | '), out.includes('[killed]') ? 'HUNG' : '')
  }
} finally { fs.writeFileSync(file, orig) }
