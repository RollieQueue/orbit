// Each mutation breaks one part of the I9 change; the named tests must fail, and every file is restored afterwards.
const fs = require('fs'), { execFileSync } = require('child_process')
const T = {
  steer: 'tests/steer-messages.test.cjs', runtime: 'tests/runtime.test.cjs', session: 'tests/providers-session.test.cjs',
  subs: 'tests/subscription-providers.test.cjs',
}
const mutations = [
  ['claude only', 'electron/runtime/turn.mts', "named || (agent.providerId === 'claude' ? session.id : null)", "(agent.providerId === 'claude' ? session.id : null)", [T.steer]],
  ['no spoke gate', 'electron/runtime/turn.mts', "session && !session.resume && spoke ? named", "session && !session.resume ? named", [T.steer]],
  ['no envelope guard', 'electron/runtime/turn.mts', "if (session && event.sessionId && timing)", "if (event.sessionId && timing)", [T.runtime]],
  ['no record', 'electron/runtime/turn.mts', "timing.sessionId = named = event.sessionId", "named = event.sessionId", [T.steer]],
  ['traced', 'electron/runtime/turn.mts', "timing.sessionId = named = event.sessionId; return }", "timing.sessionId = named = event.sessionId }", [T.runtime]],
  ['codex no event', 'electron/providers.mts', "sessionId = event.thread_id; dispatch({ kind: 'session', sessionId }) }", "sessionId = event.thread_id }", [T.session]],
  ['cursor/agy no event', 'electron/subscription-providers.mts', "if (value !== sessionId) emit({ providerId: id, kind: 'session', sessionId: value }); ", '', [T.subs]],
  ['cursor/agy repeats', 'electron/subscription-providers.mts', "if (value !== sessionId) emit(", "emit(", [T.subs]],
  ['app server no event', 'electron/codex-server.mts', "if (live.threadId) { try { options.onEvent", "if (!live.threadId) { try { options.onEvent", [T.session]],
]
const originals = new Map(mutations.map(([, file]) => [file, fs.readFileSync(file, 'utf8')]))
try {
  for (const [name, file, from, to, tests] of mutations) {
    const orig = originals.get(file)
    if (!orig.includes(from)) { console.log(name, 'PATTERN NOT FOUND'); continue }
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...tests], { encoding: 'utf8' }) } catch (e) { out = e.stdout || '' }
    console.log(`== ${name}:`, (out.match(/^not ok .*$/gm) || ['(all pass)']).join(' | '))
    fs.writeFileSync(file, orig)
  }
} finally { for (const [file, text] of originals) fs.writeFileSync(file, text) }
