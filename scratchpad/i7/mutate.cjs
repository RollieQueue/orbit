// Each mutation breaks one part of the I7 change; the named tests must fail, and every file is restored afterwards.
const fs = require('fs'), { execFileSync } = require('child_process')
const mutations = [
  ['no note', 'electron/runtime/mailbox.mts', '  if (!missed.length) return kept.text', '  return kept.text'],
  ['no held', 'electron/runtime/pause.mts', '  else if (error.spoke) for (const id of delivered) held.add(id)\n', ''],
  ['no pre-seed', 'electron/runtime/loops.mts', 'for (const id of [...mailbox.deliveredIds, ...held]) agent.activeTurn?.delivered.add(id)', 'for (const id of mailbox.deliveredIds) agent.activeTurn?.delivered.add(id)'],
  ['no clear on fresh', 'electron/runtime/loops.mts', '          if (!resume) held.clear()\n', ''],
  ['no exclusion', 'electron/runtime/mailbox.mts', " && !held.has(message.id))", ')'],
]
const originals = new Map(mutations.map(([, file]) => [file, fs.readFileSync(file, 'utf8')]))
try {
  for (const [name, file, from, to] of mutations) {
    const orig = originals.get(file)
    if (!orig.includes(from)) { console.log(name, 'PATTERN NOT FOUND'); continue }
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', 'tests/user-messages.test.cjs', 'tests/steer-messages.test.cjs'], { encoding: 'utf8' }) } catch (e) { out = e.stdout || '' }
    console.log(`== ${name}:`, (out.match(/^not ok .*$/gm) || ['(all pass)']).join(' | '))
    fs.writeFileSync(file, orig)
  }
} finally { for (const [file, text] of originals) fs.writeFileSync(file, text) }
