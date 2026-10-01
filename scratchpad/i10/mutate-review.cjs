// I10 review fixes: the mark named in every first session prompt (Codex gets no system block), and a helper's budget
// handoff without its mark. Each mutation must make a named test fail. Files are restored.
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/user-messages.test.cjs', 'tests/steer-messages.test.cjs']
const mutations = [
  ['first session prompt without the mark', 'electron/runtime/prompts.mts', "${mailRule(agent, 'at the end of an Orbit tool result or in your next prompt')}\n", ''],
  ['budget handoff shows the mark', 'electron/runtime/agents.mts', ".replaceAll(agent.mailMark, 'mark')", ''],
]
for (const [name, file, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    console.log(`== ${name}: ${failed.length ? failed.join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
