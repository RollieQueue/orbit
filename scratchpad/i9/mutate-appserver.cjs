// The App Server mutation alone: the test must fail quickly (no hang), and the file is restored.
const fs = require('fs'), { execFileSync } = require('child_process')
const file = 'electron/codex-server.mts', orig = fs.readFileSync(file, 'utf8')
const from = 'if (live.threadId) { try { options.onEvent', to = 'if (!live.threadId) { try { options.onEvent'
if (!orig.includes(from)) { console.log('PATTERN NOT FOUND'); process.exit(1) }
const began = Date.now()
try {
  fs.writeFileSync(file, orig.replace(from, to))
  let out = ''
  try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', 'tests/providers-session.test.cjs'], { encoding: 'utf8', timeout: 120000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ` [killed: ${e.signal}]` : '') }
  console.log('== app server no event:', (out.match(/^not ok .*$/gm) || ['(all pass)']).join(' | '), out.includes('[killed') ? 'HUNG' : '', `${Math.round((Date.now() - began) / 1000)} s`)
} finally { fs.writeFileSync(file, orig) }
