// I25 (Claude Fable is never an automatic replacement, only from the user's pool): each mutation must make at least one
// named test fail. Files are restored. Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/failover.test.cjs', 'tests/model-routing.test.cjs']
const FAILOVER = 'electron/failover.mts', TIERS = 'electron/model-tiers.json'
const mutations = [
  [FAILOVER, 'exclusion not applied', 'if (!inPool && excluded(model)) continue', ''],
  [FAILOVER, 'pool does not lift the exclusion', 'if (!inPool && excluded(model)) continue', 'if (excluded(model)) continue'],
  [FAILOVER, 'excluded never matches', 'return !!name && EXCLUDED.some(pattern => pattern.test(name))', 'return false'],
  [FAILOVER, 'excluded rules not read', "const EXCLUDED = (tiers.excluded || []).map(", "const EXCLUDED = ([] as { match: string }[]).map("],
  [TIERS, 'no excluded list', '"excluded": [', '"excludedOff": ['],
  [TIERS, 'pattern without delimiters', '"match": "(?:^|[-_/. ])fable(?=$|[-_/.:@ ])"', '"match": "fable"'],
  [TIERS, 'version suffix not delimited', '"match": "(?:^|[-_/. ])fable(?=$|[-_/.:@ ])"', '"match": "(?:^|[-_/. ])fable(?=$|[-_/. ])"'],
  [TIERS, 'Fable no longer a flagship', '(?:opus|fable|astra|sol|pro)', '(?:opus|astra|sol|pro)'],
]
const only = process.argv[3]
// A filter of several names: 'pool|list'.
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, name]) => only.split('|').some(part => name.includes(part))))
let caught = 0
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  // failover.mts is CRLF: single-line patterns match either way.
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  if (orig.indexOf(from) !== orig.lastIndexOf(from)) { console.log(`== ${name}: PATTERN NOT UNIQUE`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    if (failed.length) caught++
    console.log(`== ${name}: ${failed.length ? failed.map(line => line.slice(0, 90)).join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
