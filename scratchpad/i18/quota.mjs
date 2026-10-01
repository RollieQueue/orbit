import { readers } from '../../electron/quota.mts'
const out = {}
for (const id of ['codex', 'cursor', 'antigravity', 'claude']) {
  try { const r = await readers[id]({ timeoutMs: 30000 }); out[id] = { state: r.state, windows: (r.windows || []).map(w => ({ label: w.label, used: w.usedPercent, reset: w.resetsAt ? new Date(w.resetsAt).toISOString() : null, scope: w.scope, models: w.models, blocked: w.blocked })), detail: r.detail, error: r.error } }
  catch (e) { out[id] = { error: String(e?.message || e) } }
}
console.log(JSON.stringify(out, null, 1))
