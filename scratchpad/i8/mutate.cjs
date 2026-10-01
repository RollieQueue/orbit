// Each mutation breaks one part of the I8 change; the named tests must fail, and every file is restored afterwards.
const fs = require('fs'), { execFileSync } = require('child_process')
const mutations = [
  // The old behaviour of a repeated lost start: the refused loop keeps its number (the caller passed loop.iteration).
  ['no step back', 'src/improvement-loop.ts', 'iteration: started.iteration - 1 }', 'iteration: started.iteration }'],
  ['two back', 'src/improvement-loop.ts', 'iteration: started.iteration - 1 }', 'iteration: started.iteration - 2 }'],
]
const originals = new Map(mutations.map(([, file]) => [file, fs.readFileSync(file, 'utf8')]))
try {
  for (const [name, file, from, to] of mutations) {
    const orig = originals.get(file)
    if (!orig.includes(from)) { console.log(name, 'PATTERN NOT FOUND'); continue }
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', 'tests/improvement-loop.test.cjs'], { encoding: 'utf8' }) } catch (e) { out = e.stdout || '' }
    console.log(`== ${name}:`, (out.match(/^not ok .*$/gm) || ['(all pass)']).join(' | '))
    fs.writeFileSync(file, orig)
  }
} finally { for (const [file, text] of originals) fs.writeFileSync(file, text) }
