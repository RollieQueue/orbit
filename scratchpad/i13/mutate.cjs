// I13 (model routing by kind of work in spawn_agent): each mutation must make at least one named test fail. Files are
// restored. Run on a copy: node mutate.cjs <copy root> [name filter]
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/model-routing.test.cjs', 'tests/tool-registry.test.cjs']
const ROUTING = 'electron/model-routing.mts', HANDOVER = 'electron/runtime/handover.mts', AGENTS = 'electron/runtime/agents.mts', TABLE = 'electron/model-routing.json'
const mutations = [
  [ROUTING, 'pool ignored', "if (input.pool.length && providerId !== input.runProviderId", 'if (false && providerId !== input.runProviderId'],
  [ROUTING, "run's provider not exempt from the pool", 'input.pool.length && providerId !== input.runProviderId && ', 'input.pool.length && '],
  [ROUTING, 'pool member without model refused', '(!member.model || member.model === model)', 'member.model === model'],
  [ROUTING, 'broken providers offered', "if (input.skip.has(providerId)) return 'could not answer a moment ago'", ''],
  [ROUTING, 'unavailable provider offered', "if (!entry || entry.available === false) return 'not connected'", "if (!entry) return 'not connected'"],
  [ROUTING, 'missing provider offered', "if (!entry || entry.available === false) return 'not connected'", "if (entry?.available === false) return 'not connected'"],
  [ROUTING, 'model list ignored', "if (entry.models?.length && !entry.models.includes(model)) return 'not in its model list'", ''],
  [ROUTING, 'empty model list refuses everything', 'if (entry.models?.length && !entry.models.includes(model))', 'if (!entry.models?.includes(model))'],
  [ROUTING, 'no catalog: anything goes', "} else if (!input.known.has(providerId)) return 'the provider list could not be read'", '}'],
  [ROUTING, 'exhausted offered', "if (level.exhausted) return 'quota used up'", ''],
  [ROUTING, 'near offered', "if (level.near) return `quota ${level.usedPercent}% used`", ''],
  [ROUTING, 'quota judged without the model', 'assess(input.quota?.peek(providerId), { model, threshold', 'assess(input.quota?.peek(providerId), { model: \'\', threshold'],
  [ROUTING, 'fixed threshold', 'threshold: input.threshold, now: input.now', 'threshold: 90, now: input.now'],
  [ROUTING, 'providerId ignored', 'if (input.providerId && candidate.providerId !== input.providerId) continue', ''],
  [ROUTING, 'skipped not reported', 'skipped.push(`${candidate.providerId}/${candidate.model}: ${why}`); continue', 'continue'],
  [ROUTING, 'effort not filtered', 'effortFor(candidate.providerId, candidate.model, candidate.reasoningEffort, entry, undefined)', "candidate.reasoningEffort || ''"],
  [HANDOVER, 'no catalog used', 'catalog: list?.length ? list : null', 'catalog: null'],
  [HANDOVER, 'empty catalog trusted', 'catalog: list?.length ? list : null', 'catalog: list'],
  [HANDOVER, 'known misses the parent', 'known: new Set([parent.providerId, run.providerId, ', 'known: new Set(['],
  [HANDOVER, 'no quota refresh', 'runtime.quota ? Promise.all(ids.map(', 'false ? Promise.all(ids.map('],
  [HANDOVER, 'pool not passed', 'pool: run.providerPool, runProviderId', 'pool: [], runProviderId'],
  [HANDOVER, 'threshold from nowhere', 'quota: runtime.quota, threshold: run.failover.switchAtPercent, now,', 'quota: runtime.quota, threshold: 101, now,'],
  [HANDOVER, 'no skip set', 'skip: new Set([...run.brokenProviders]', 'skip: new Set([].concat([])), unused: new Set([...run.brokenProviders]'],
  [HANDOVER, 'caller effort overridden', 'spec.reasoningEffort === undefined && !inherits', '!inherits'],
  [HANDOVER, 'settings effort overridden', ' && !run.providerOptions[choice.providerId]?.reasoningEffort', ''],
  [HANDOVER, 'parent level not inherited', '!inherits && ', ''],
  [HANDOVER, 'table effort never applied', 'choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}', '{}'],
  [HANDOVER, 'routed model not applied', 'spec: { ...spec, providerId: choice.providerId, model: choice.model, ...effort }', 'spec: { ...spec, ...effort }'],
  [HANDOVER, 'skipped dropped', 'routed: { kind, model: `${choice.providerId}/${choice.model}`, ...passed }', 'routed: { kind, model: `${choice.providerId}/${choice.model}` }'],
  [HANDOVER, 'no note without a choice', ", note: 'No model of the routing table can take this work now; the helper got the model it gets without a kind.'", ''],
  [AGENTS, 'kind never routed', 'if (!run || !parent || !ROUTING_KINDS.includes(String(spec.kind))', 'if (true || !ROUTING_KINDS.includes(String(spec.kind))'],
  [AGENTS, 'explicit model routed anyway', '|| spec.model || TERMINAL.has(run.status)', '|| TERMINAL.has(run.status)'],
  [AGENTS, 'reused name routed', ' || (spec.name && [...run.agentNodes.values()].some(agent => agent.name === bounded(spec.name, 80)))) return registerSubAgent', ') return registerSubAgent'],
  [AGENTS, 'routed not returned', 'return result.ok && !result.reused ? { ...result, routed } : result', 'return result'],
  [AGENTS, 'routed on a reused result', 'return result.ok && !result.reused ? { ...result, routed } : result', 'return result.ok ? { ...result, routed } : result'],
  [AGENTS, 'unknown kind accepted', "if (spec.kind && !ROUTING_KINDS.includes(String(spec.kind))) return", 'if (false) return'],
  [AGENTS, 'empty kind refused', "if (spec.kind && !ROUTING_KINDS.includes(String(spec.kind))) return", 'if (spec.kind !== undefined && !ROUTING_KINDS.includes(String(spec.kind))) return'],
  [AGENTS, 'trace without the routing', "${routed ? `\\n${routedLine(routed)}` : ''}", ''],
  [AGENTS, 'trace without skipped', "${skipped?.length ? ` (passed over ${skipped.join('; ')})` : ''}", ''],
  [AGENTS, 'pause during the routing ignored', 'if (turn && parent.activeTurn !== turn) return', 'if (false) return'],
  [HANDOVER, 'waits without candidates', "  if (!ids.length) return { spec, routed: { kind, model: null, note: ", "  if (false) return { spec, routed: { kind, model: null, note: "],
  [HANDOVER, 'unbounded provider list wait', 'Promise.race([runtime.providerCatalog(run), late])', 'runtime.providerCatalog(run)'],
  [HANDOVER, 'wait setting ignored', 'setTimeout(resolve, routeWait(), null)', 'setTimeout(resolve, ROUTE_WAIT_MS, null)'],
  [TABLE, 'Fable in the table', '{ "providerId": "claude", "model": "opus", "reasoningEffort": "high", "why": "Opus 5.5: the Russian text met every requirement" }', '{ "providerId": "claude", "model": "claude-fable-5-1", "reasoningEffort": "high", "why": "Fable" }'],
  [TABLE, 'review first choice swapped', '"review": {\n      "about": "reviewing code: bugs, races, security",\n      "candidates": [\n        { "providerId": "codex", "model": "gpt-6-astra"', '"review": {\n      "about": "reviewing code: bugs, races, security",\n      "candidates": [\n        { "providerId": "codex", "model": "gpt-6-sol"'],
]
const only = process.argv[3]
// A filter of several names: 'pool|skip'.
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([, name]) => only.split('|').some(part => name.includes(part))))
let caught = 0
for (const [file, name, from, to] of mutations) {
  const orig = fs.readFileSync(file, 'utf8')
  // agents.mts is CRLF: single-line patterns match either way.
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  try {
    fs.writeFileSync(file, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    if (failed.length) caught++
    console.log(`== ${name}: ${failed.length ? failed.map(line => line.slice(0, 90)).join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(file, orig) }
}
console.log(`caught ${caught} of ${mutations.length}`)
