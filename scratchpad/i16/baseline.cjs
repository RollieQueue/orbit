'use strict'
// Rebuilds the files as they were before this run's tool edits (run-history changes[] diffs, applied in reverse) and
// writes scratchpad/i16/i16.diff (unified, with context) = baseline → current, plus scratchpad/i16/base/<file>.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..', '..')
const history = path.join(process.env.APPDATA, 'orbit-ide', 'run-history', process.argv[2] + '.json')
const record = JSON.parse(fs.readFileSync(history, 'utf8'))
const only = process.argv.slice(3)
const changes = record.changes.filter((c) => !only.length || only.includes(c.path || c.file))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-i16-base-'))
const files = [...new Set(changes.map((c) => c.path || c.file))]
for (const file of files) { fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.copyFileSync(path.join(repo, file), path.join(work, file)) }
const git = (...args) => { const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout }
git('init', '-q')
changes.slice().reverse().forEach((change, index) => {
  const patch = path.join(work, `p${index}.patch`)
  fs.writeFileSync(patch, change.diff.endsWith('\n') ? change.diff : change.diff + '\n')
  git('apply', '-R', '--unidiff-zero', patch)
  fs.rmSync(patch)
})
const slash = (value) => value.split(path.sep).join('/')
const out = []
for (const file of files) {
  const r = spawnSync('git', ['diff', '--no-index', '-U4', path.join(work, file), path.join(repo, file)], { encoding: 'utf8' })
  out.push(r.stdout.split(slash(work)).join('').split(slash(repo)).join(''))
  fs.mkdirSync(path.join(__dirname, 'base', path.dirname(file)), { recursive: true })
  fs.copyFileSync(path.join(work, file), path.join(__dirname, 'base', file))
}
fs.writeFileSync(path.join(__dirname, 'i16.diff'), out.join(''))
fs.rmSync(work, { recursive: true, force: true })
console.log(files.join('\n'))
