'use strict'
// Rebuilds the harness and recaptures every screenshot (the two commands in one):
//   node scratchpad/s4-timeline/shoot.cjs [--only=<text in a shot name>] [--no-build]
// Same as:  npx vite build --config scratchpad/s4-timeline/harness/vite.config.mjs
//           node scripts/run-electron.cjs scratchpad/s4-timeline/capture.cjs
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repo = path.resolve(__dirname, '..', '..')
function run(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: repo, stdio: 'inherit' })
  if (result.status !== 0) { console.error(`${label} failed (exit ${result.status})`); process.exit(result.status || 1) }
}
if (!process.argv.includes('--no-build')) run([path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', path.join(__dirname, 'harness', 'vite.config.mjs')], 'vite build')
run([path.join(repo, 'scripts', 'run-electron.cjs'), path.join(__dirname, 'capture.cjs'), ...process.argv.slice(2).filter(arg => arg !== '--no-build')], 'capture')
