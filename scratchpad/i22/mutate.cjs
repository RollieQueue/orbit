// I22 (Codex in session mode gets the stable Orbit block as the thread's developer instructions; App Server JSON-RPC
// lines go out well-formed): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const PR = 'electron/providers.mts'
const CS = 'electron/codex-server.mts'
const T = ['tests/providers-session.test.cjs', 'tests/codex-server.test.cjs']
const NL = '\r\n'
const mutations = [
  [PR, 'exec gets no developer instructions', "  if (session.systemAppend) args.push('-c', `developer_instructions=${tomlString(session.systemAppend)}`)", ''],
  [PR, 'only a new exec thread gets them, not a resume', 'if (session.systemAppend) args.push', 'if (session.systemAppend && !session.resume) args.push'],
  [PR, 'the TOML value keeps a lone surrogate', 'return JSON.stringify(wellFormed(text))', 'return JSON.stringify(text)'],
  [PR, 'wellFormed replaces nothing', String.raw`return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')`, 'return text'],
  [PR, 'wellFormed replaces only a lone high surrogate', String.raw`/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g`, String.raw`/[\ud800-\udbff](?![\udc00-\udfff])/g`],
  [PR, 'a raw DEL stays in the value', String.raw`.replace(/\x7f/g, '\\u007f')`, ''],
  [PR, 'the value is not a quoted string', 'return JSON.stringify(wellFormed(text))', 'return String(wellFormed(text))'],
  [PR, 'runCodexSession drops the block before the builder', 'buildCodexSessionArgs(options, session), {', "buildCodexSessionArgs(options, { ...session, systemAppend: '' }), {"],
  [CS, 'thread/start without developerInstructions', 'sandbox, ephemeral: false, ...instructions })', 'sandbox, ephemeral: false })'],
  [CS, 'thread/resume without developerInstructions', "approvalPolicy: 'on-request', sandbox, ...instructions })", "approvalPolicy: 'on-request', sandbox })"],
  [CS, 'an empty block still sends developerInstructions', 'session?.systemAppend ? { developerInstructions: session.systemAppend } : {}', '{ developerInstructions: session?.systemAppend }'],
  [CS, 'rpcLine keeps lone surrogates', "JSON.stringify(message, (_key, value: unknown) => typeof value === 'string' ? wellFormed(value) : value)", 'JSON.stringify(message)'],
  [CS, 'the envelope App Server sends raw JSON', 'child.stdin.write(rpcLine(message)) }' + NL + '  const request = <T = unknown,>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {' + NL + "    if (closed) return reject(new Error('Codex connection closed'))", "child.stdin.write(JSON.stringify(message) + '\\n') }" + NL + '  const request = <T = unknown,>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {' + NL + "    if (closed) return reject(new Error('Codex connection closed'))"],
  [CS, 'the session App Server sends raw JSON', 'child.stdin.write(rpcLine(message)) }' + NL + '  // A request after the connection closed', "child.stdin.write(JSON.stringify(message) + '\\n') }" + NL + '  // A request after the connection closed'],
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
