const fs = require('node:fs'), path = require('node:path'), { stripTypeScriptTypes } = require('node:module')
for (const name of ['providers.mts', 'quota.mts', 'codex-server.mts', 'subscription-providers.mts', 'failover.mts', 'provider-network.mts']) {
  const src = fs.readFileSync(path.join('electron', name), 'utf8')
  const out = stripTypeScriptTypes(src, { mode: 'strip' }).split('\n').map(l => l.replace(/\s+$/, '').replace(/ {2,}/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/, \)/g, ')')).filter(l => l.trim()).join('\n') + '\n'
  fs.writeFileSync(path.join('scratchpad/probe/new', name), out)
}
for (const name of ['providers.mts', 'quota.mts']) {
  const p = path.join('scratchpad/probe/old', name)
  const out = fs.readFileSync(p, 'utf8').split('\n').map(l => l.replace(/\s+$/, '').replace(/ {2,}/g, ' ')).filter(l => l.trim() && l.trim() !== '// @ts-nocheck').join('\n') + '\n'
  fs.writeFileSync(p + '.norm', out)
}
