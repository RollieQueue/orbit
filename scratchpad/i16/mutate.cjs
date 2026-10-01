// I16 (a session turn's wait ends with its turn and takes what it found only once the turn has its slot back and still
// runs): each mutation must make a test fail that passes without it. Files are restored.
// Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const SESSION = 'electron/runtime/session.mts', MAILBOX = 'electron/runtime/mailbox.mts', TOOLS = 'electron/runtime/tools.mts', TURN = 'electron/runtime/turn.mts'
const PAUSE = ['tests/pause-agents.test.cjs'], BOTH = ['tests/pause-agents.test.cjs', 'tests/session-mode.test.cjs']
const mutations = [
  [SESSION, PAUSE, 'waits use the agent signal', 'const bound = turnWait ? turnWait.signal : signal', 'const bound = signal'],
  [SESSION, PAUSE, 'no ready hook', 'const ready = turnWait ? async', 'const ready = undefined && turnWait ? async'],
  [SESSION, PAUSE, 'ready skips the slot', '    await slotBack().catch(() => {})\n    if (agent.activeTurn !== turnWait', '    if (agent.activeTurn !== turnWait'],
  [SESSION, PAUSE, 'ready ignores the turn', '    if (agent.activeTurn !== turnWait || turnWait.signal.aborted) throw new Error(TURN_ENDED)\n', ''],
  [SESSION, PAUSE, 'no refusal without a turn', '  if (!turn && TURN_WAITS.has(call.name)) return refuse(TURN_ENDED)\n', ''],
  [SESSION, PAUSE, 'turn end reported as a cancelled run', 'failure = turnWait?.signal.aborted && !signal.aborted ? TURN_ENDED : (error as Error).message', 'failure = (error as Error).message'],
  [SESSION, BOTH, 'slot not taken back after the call', '    await slotBack().catch(() => {})\n  }\n  if (!failure', '  }\n  if (!failure'],
  [MAILBOX, PAUSE, 'wait_message takes before ready', '  await ready?.()\n  return mailArrived(runtime, run, agent, turn)', '  const found = mailArrived(runtime, run, agent, turn)\n  await ready?.()\n  return found'],
  [MAILBOX, PAUSE, 'wait_message ignores its signal', "      await abortable(incoming, signal, timeout, 'mailbox_timeout')", "      await abortable(incoming, runtime.agentSignal(run, agent), timeout, 'mailbox_timeout')"],
  [MAILBOX, PAUSE, 'wait_agent ignores its signal', "]), signal, timeout, 'wait_timeout')", "]), runtime.agentSignal(run, agent), timeout, 'wait_timeout')"],
  [TOOLS, PAUSE, 'wait_agent takes before ready', '    await ready?.()\r\n    return children.map', '    return children.map'],
  [TOOLS, PAUSE, 'wait_message without ready', 'runtime.waitAgentMessage(run, agent, args, signal, ready)', 'runtime.waitAgentMessage(run, agent, args, signal)'],
  [TOOLS, PAUSE, 'wait_message without the signal', 'runtime.waitAgentMessage(run, agent, args, signal, ready)', 'runtime.waitAgentMessage(run, agent, args, undefined, ready)'],
  [TOOLS, PAUSE, 'wait_agent without the signal', 'await runtime.waitForTeam(run, agent, children, timeout, signal)', 'await runtime.waitForTeam(run, agent, children, timeout)'],
  // From the review: a turn cut off by a pause or a message is repeated with the results of helpers finished by then.
  ['electron/runtime/loops.mts', PAUSE, 'repeat without finished helpers', 'held); runtime.collectChildren(run, agent, transcript); continue }', 'held); continue }'],
  [TURN, PAUSE, 'turn signal never aborts','delivered: new Set(), signal: controller.signal,', 'delivered: new Set(), signal: new AbortController().signal,'],
  // Expected to survive: latency and defence only (a dead wait waits for a free slot before it gives up; the turn is
  // cleared before ready looks at it in every path the tests drive).
  [SESSION, PAUSE, 'retake not bound to the turn (expected to survive)', 'const retake = abortable(retakeSlot(runtime, run, agent, turn), turn.signal)', 'const retake = retakeSlot(runtime, run, agent, turn)'],
  [SESSION, PAUSE, 'ready checks only the active turn (expected to survive)', 'if (agent.activeTurn !== turnWait || turnWait.signal.aborted) throw', 'if (agent.activeTurn !== turnWait) throw'],
]
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, , name]) => only.split('|').some(part => name.includes(part))))
const run = (tests) => {
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8', timeout: 240000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
  return { out, failed: (out.match(/^not ok .*$/gm) || []).map(line => line.replace(/^not ok \d+ - /, '')) }
}
const baseline = new Map()
for (const tests of [PAUSE, BOTH]) {
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
