// I19 (Cursor's envelope parser reports tool calls through cursorToolEvent; a call without call_id is keyed by its own
// toolCallId, else by its argument text; a result that is no success variant fails; no Orbit MCP in the envelope): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const SP = 'electron/subscription-providers.mts'
const T = ['tests/subscription-providers.test.cjs']
const OLD_EVENT = "onEvent?.({ providerId: id, kind: 'tool', native: true, text: JSON.stringify(event.tool_call || {}), status: event.subtype, ...(typeof event.call_id === 'string' ? { toolId: event.call_id } : {}) })"
const mutations = [
  [SP, T, "envelope parser back to the JSON event (old behaviour)", "onEvent?.(cursorToolEvent(event, false))", OLD_EVENT],
  [SP, T, "no toolCallId fallback", "const ids = [event.call_id, isRecord(event.tool_call) ? event.tool_call.toolCallId : undefined]", "const ids = [event.call_id]"],
  [SP, T, "toolCallId before call_id", "const ids = [event.call_id, isRecord(event.tool_call) ? event.tool_call.toolCallId : undefined]", "const ids = [isRecord(event.tool_call) ? event.tool_call.toolCallId : undefined, event.call_id]"],
  [SP, T, "envelope text with the result (key changes at the end)", "onEvent?.(cursorToolEvent(event, false))", "onEvent?.({ ...cursorToolEvent(event, false), toolId: undefined, text: JSON.stringify(event.tool_call || {}) })"],
  [SP, T, "old failure rule (error/failure/rejected only)", "!Object.keys(call.result).some(key => CURSOR_DONE.test(key))", "['error', 'failure', 'rejected'].some(key => key in (call.result as object))"],
  [SP, T, "envelope takes an orbit-named MCP server as Orbit", "cursorToolEvent(event, false)", "cursorToolEvent(event)"],
  [SP, T, "text names the folder before the search pattern", "[args.command, args.pattern, args.globPattern, args.query, args.path, named]", "[args.command, args.path, args.pattern, args.globPattern, args.query, named]"],
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
