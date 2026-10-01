// I29 (the window takes HTTP(S)_PROXY while the system proxy is off; a failed frame inside the page is no failed
// renderer): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const WP = 'electron/window-proxy.cjs', MAIN = 'electron/main.cjs', CLIENT = 'electron/runtime-client.cjs', FP = 'electron/fingerprint.cjs'
const UNIT = ['tests/window-proxy.test.cjs'], LOAD = ['tests/main-load.test.cjs'], RC = ['tests/runtime-client.test.cjs']
const mutations = [
  [WP, UNIT, 'no direct failover', '`${scheme}=${proxy},direct://`', '`${scheme}=${proxy}`'],
  [WP, UNIT, 'all_proxy ignored', "variable(`${scheme}_proxy`) || variable('all_proxy')", 'variable(`${scheme}_proxy`)'],
  [WP, UNIT, 'upper-case names ignored', '[env[name], env[name.toUpperCase()]]', '[env[name]]'],
  [WP, UNIT, 'credentials accepted', 'url.username || url.password || ', ''],
  [WP, UNIT, 'path accepted', "!['', '/'].includes(url.pathname) || ", ''],
  [WP, UNIT, 'socks5h passed through', "['socks5h', 'socks5']", "['socks5h', 'socks5h']"],
  [WP, UNIT, 'NO_PROXY=* ignored', "if (entries.includes('*')) return null", ''],
  [WP, UNIT, 'names without subdomains', 'return [name, `*.${name}`]', 'return [name]'],
  [WP, UNIT, 'bare IPv6 unbracketed', ': [`[${entry}]`]', ': [entry]'],
  [WP, UNIT, 'last route entry read', "String(route).split(';')[0].trim()", "String(route).split(';').at(-1).trim()"],
  // From the review: a PAC file may send YouTube directly and only the video streams through a proxy.
  [WP, UNIT, 'one probe only', 'PROBE_URLS.map((url) => probe.resolveProxy(url))', '[PROBE_URLS[0]].map((url) => probe.resolveProxy(url))'],
  [WP, UNIT, 'one DIRECT host suffices', 'routes.every((route)', 'routes.some((route)'],
  [WP, UNIT, 'no video-stream probe', "'https://redirector.googlevideo.com/', ", ''],
  [WP, UNIT, 'NO_PROXY trailing dot kept', ".replace(/\\.$/, '')", ''],
  [WP, UNIT, 'never back to the system', "await target.setProxy(direct ? config : { mode: 'system' })", 'if (direct) await target.setProxy(config)'],
  [WP, UNIT, 'state before setProxy', "    await target.setProxy(direct ? config : { mode: 'system' })\n    onEnv = direct\n", "    onEnv = direct\n    await target.setProxy(direct ? config : { mode: 'system' })\n"],
  [WP, UNIT, 'questions pile up', 'running ??= once()', 'running = once()'],
  [WP, UNIT, 'timer asks nothing', 'const timer = setInterval(() => { void check() }, intervalMs)', 'const timer = setInterval(() => {}, intervalMs)'],
  [WP, UNIT, 'stop keeps asking', 'stop: () => clearInterval(timer)', 'stop: () => {}'],
  [WP, LOAD, 'no first check', '  void check()\n  return { check', '  return { check'],
  [WP, UNIT, 'no config still asks', "  if (!config) return { check: () => Promise.resolve(), stop: () => {} }\n", ''],
  [MAIN, LOAD, 'window proxy not followed', "  followEnvProxy({ target: session.defaultSession, system: systemProxySession, config: envProxy, log: (text) => console.log(`[orbit] ${text}`) })\n", ''],
  [MAIN, LOAD, 'runtime asks the window session', 'resolveProxy: (url) => systemProxySession().resolveProxy(url),', 'resolveProxy: (url) => session.defaultSession.resolveProxy(url),'],
  [MAIN, LOAD, 'probe on the window session', 'system: systemProxySession,', 'system: () => session.defaultSession,'],
  [MAIN, LOAD, 'subframe treated as the page', '    if (isMainFrame === false) {\n', '    if (false) {\n'],
  [MAIN, LOAD, 'page failure not reported', '    if (!aborted) writeHealth(', '    if (false) writeHealth('],
  [MAIN, LOAD, 'aborted page reported', 'const aborted = errorCode === -3', 'const aborted = false'],
  [CLIENT, RC, 'inprocess resolver not installed', "    if (resolve) require('./provider-network.mts').setProxyResolver(", "    if (false) require('./provider-network.mts').setProxyResolver("],
  [FP, LOAD, 'window-proxy not a shell file', "  'electron/window-proxy.cjs',\n", ''],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, , name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Map()
for (const tests of [UNIT, LOAD, RC]) {
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
