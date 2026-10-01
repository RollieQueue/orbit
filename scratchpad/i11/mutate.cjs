// I11 (run-history retention): each mutation must make at least one named test fail. Files are restored.
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/run-retention.test.cjs', 'tests/storage.test.cjs', 'tests/run-store-changes.test.cjs', 'tests/trace-images.test.cjs']
const FILE = 'electron/run-store.mts'
const mutations = [
  ['keeps one run too many', 'files.slice(this.keep)', 'files.slice(this.keep + 1)'],
  ['deletes an active run', 'if (activeStatuses.has(this.records.get(id)?.status)) continue', 'if (false) continue'],
  ['backup and leftovers stay', "for (const name of names) if (name.startsWith(`${id}.json.`)) fs.rmSync(path.join(this.root, name), { force: true })", ''],
  ['images stay', "fs.rmSync(path.join(this.root, 'images', id), { recursive: true, force: true })", ''],
  ['deleted run still served', 'this.records.delete(id)', 'void id'],
  ['no prune on open', 'this.prune()\r\n  }\r\n\r\n  save(', '\r\n  }\r\n\r\n  save('],
  ['no prune in a long session', 'if (this.files.size >= this.nextPrune) this.prune()', ''],
  ['prunes on every flush', 'Math.max(this.files.size, this.keep) + this.slack', 'Math.max(this.files.size, this.keep)'],
  ['newest deleted instead of oldest', 'files.sort((a, b) => b.modified - a.modified)', 'files.sort((a, b) => a.modified - b.modified)'],
  ['a failed deletion throws', '} catch { /* Locked: the next prune tries again. */ }', '} finally { }'],
  ['run file deleted first', "fs.rmSync(path.join(this.root, 'images', id), { recursive: true, force: true })", "fs.rmSync(path.join(this.root, `${id}.json`), { force: true }); fs.rmSync(path.join(this.root, 'images', id), { recursive: true, force: true })"],
  ['written files not counted', 'this.files.add(id)', 'void id'],
  ['siblings by bare id prefix', 'name.startsWith(`${id}.json.`)', 'name.startsWith(id)'],
]
for (const [name, from, to] of mutations) {
  const orig = fs.readFileSync(FILE, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  try {
    fs.writeFileSync(FILE, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    console.log(`== ${name}: ${failed.length ? failed.join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(FILE, orig) }
}
