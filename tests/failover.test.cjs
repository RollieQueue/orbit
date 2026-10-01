const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { normalizeFailover, tierOf, baselineTier, excluded, replacements, handoverNote, unreachable } = require('../electron/failover.mts')

const w = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })
const CATALOG = [
  { id: 'codex', available: true, models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5'], reasoningLevels: { 'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'gpt-5.5': ['low', 'medium', 'high', 'xhigh'] } },
  { id: 'claude', available: true, models: ['sonnet', 'opus', 'haiku'] },
  { id: 'antigravity', available: true, models: ['gemini-3.1-pro-high', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking'] },
  { id: 'cursor', available: true, models: ['auto', 'composer-2.5', 'claude-opus-5-5-high'] },
  { id: 'ollama', available: true, models: ['llama3'] },
]
const labels = list => list.map(item => `${item.providerId}/${item.model}`)
const fakeQuota = snapshots => ({ peek: id => snapshots[id] ? { providerId: id, ...snapshots[id] } : null })
const agentOf = (extra = {}) => ({ id: 'root', name: 'Orbit', providerId: 'codex', model: 'gpt-6-sol', requestedModel: 'gpt-6-sol', reasoningEffort: 'high', failedCandidates: new Set(), turns: 3, files: { read: [], wrote: [] }, ...extra })
const config = (extra = {}) => normalizeFailover(extra)

// ---- Which model may take over ------------------------------------------------------------------------------------

test('quality tiers follow naming conventions and place doubtful models low', () => {
  const expected = {
    'claude-opus-5-5-high': 3, 'claude-fable-5-thinking-high': 3, opus: 3, 'gpt-6-astra': 3, 'gpt-6-sol': 3, 'gpt-5.6-sol-high': 3, 'gemini-3.1-pro-high': 3, 'claude-opus-4-6-thinking': 3,
    sonnet: 2, 'claude-sonnet-5-thinking-high': 2, 'gpt-5.6-terra': 2, 'gpt-5.5': 2, 'gpt-5.3-codex-high': 2, 'composer-2.5': 2, 'grok-4.7-high': 2,
    'claude-haiku-5': 1, 'gemini-3.8-flash-high': 1, 'gpt-5.6-luna': 1, 'gpt-4o-mini': 1,
    auto: 0, '': 0, 'some-new-model': 0,
  }
  for (const [model, tier] of Object.entries(expected)) assert.equal(tierOf(model), tier, model)
  assert.equal(tierOf('GEMINI-3.1-PRO-HIGH'), 3, 'case does not matter')
  assert.equal(tierOf('gemini-3.8-flash-high'), 1, "'mini' inside 'gemini' must not make a light model of a strong one")
  assert.equal(tierOf('claude-haiku-pro'), 1, 'a light marker wins over a flagship one')
})

test('measured tiers of the 2026-09-30 audit come before the names: GPT-6 Luna strong, Haiku 4.5 weak, GPT-OSS unreliable', () => {
  for (const model of ['gpt-6-luna', 'gpt-6-luna-high']) assert.equal(tierOf(model), 2, model)
  for (const model of ['haiku', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5', 'claude-4.5-haiku', 'claude-haiku-4-5@20251001']) assert.equal(tierOf(model), 0.5, model)
  for (const model of ['gpt-oss-120b-medium', 'gpt-oss:20b', 'openai/gpt-oss-120b']) assert.equal(tierOf(model), 0, model)
  assert.equal(tierOf('gpt-5.6-luna'), 1, 'only the measured model moves, not its whole family')
  assert.equal(tierOf('claude-haiku-5'), 1, 'a later Haiku is light by its name until it is measured')
  assert.equal(baselineTier('claude', 'haiku'), 0.5, 'a Haiku agent accepts light replacements')
  assert.equal(baselineTier('antigravity', 'gpt-oss-120b-medium'), 3, 'an unreliable model is judged by the high provider baseline')
  const { rules } = require('../electron/model-tiers.json')
  assert.equal(rules.filter(rule => rule.measured).length, 3)
  assert.ok(rules.slice(0, 3).every(rule => rule.measured), 'measured rules come first and say why')
})

test('the model being replaced is judged by its name, else by a deliberately high baseline', () => {
  assert.equal(baselineTier('claude', 'sonnet'), 2)
  assert.equal(baselineTier('claude', ''), 3)
  assert.equal(baselineTier('codex', 'made-up'), 3)
  assert.equal(baselineTier('cursor', 'auto'), 2)
  assert.equal(baselineTier('nobody', ''), 2)
})

test('failover settings are clamped and default to on, at 90%, without weaker models', () => {
  assert.deepEqual(normalizeFailover(undefined), { enabled: true, switchAtPercent: 90, allowWeaker: false })
  assert.deepEqual(normalizeFailover({ enabled: false, switchAtPercent: 10, allowWeaker: true }), { enabled: false, switchAtPercent: 50, allowWeaker: true })
  assert.equal(normalizeFailover({ switchAtPercent: 250 }).switchAtPercent, 99)
  assert.equal(normalizeFailover({ switchAtPercent: 'x' }).switchAtPercent, 90)
  assert.equal(normalizeFailover({ allowWeaker: 'yes' }).allowWeaker, false)
})

test('replacements are comparable models of connected subscriptions, never the agent itself, local models or unknowns', () => {
  const found = replacements({ agent: agentOf(), catalog: CATALOG, quota: fakeQuota({}), config: config() })
  assert.deepEqual(labels(found), ['antigravity/claude-opus-4-6-thinking', 'antigravity/gemini-3.1-pro-high', 'claude/opus', 'codex/gpt-6-astra', 'cursor/claude-opus-5-5-high'])
  assert.ok(found.every(item => item.tier === 3))
})

test('healthy subscriptions with the most headroom come first; those near or at the limit are left out', () => {
  const snapshots = {
    codex: { windows: [w(96)] },
    claude: { windows: [w(30)] },
    antigravity: { windows: [w(70, { models: ['gemini'] }), w(5, { models: ['claude', 'gpt-oss'] })] },
  }
  const found = replacements({ agent: agentOf(), catalog: CATALOG, quota: fakeQuota(snapshots), config: config() })
  assert.deepEqual(labels(found), ['antigravity/claude-opus-4-6-thinking', 'claude/opus', 'cursor/claude-opus-5-5-high', 'antigravity/gemini-3.1-pro-high'], 'a provider that publishes no numbers ranks between healthy and busy ones')
  const strict = replacements({ agent: agentOf(), catalog: CATALOG, quota: fakeQuota({ ...snapshots, antigravity: { windows: [w(91, { models: ['gemini'] })] } }), config: config() })
  assert.ok(!labels(strict).includes('antigravity/gemini-3.1-pro-high'), 'above the switch threshold')
  const exhausted = fakeQuota({ claude: { windows: [w(100)] }, antigravity: { windows: [w(95)] } })
  assert.deepEqual(labels(replacements({ agent: agentOf(), catalog: CATALOG, quota: exhausted, config: config(), relaxed: true })), ['codex/gpt-6-astra', 'cursor/claude-opus-5-5-high', 'antigravity/claude-opus-4-6-thinking', 'antigravity/gemini-3.1-pro-high'], 'relaxed mode admits near-limit providers (last, by headroom) but never an exhausted one')
  assert.ok(!labels(replacements({ agent: agentOf(), catalog: CATALOG, quota: exhausted, config: config() })).some(label => label.startsWith('antigravity')), 'not relaxed: 95% is too close')
  const marked = fakeQuota({ claude: { windows: [], exhaustedUntil: Date.now() + 60000 } })
  assert.ok(!labels(replacements({ agent: agentOf(), catalog: CATALOG, quota: marked, config: config(), relaxed: true })).some(label => label.startsWith('claude')), 'a provider that just refused a request is out')
})

test('a weaker model is used only when allowed, and never a light one', () => {
  const list = allowWeaker => labels(replacements({ agent: agentOf(), catalog: CATALOG, quota: fakeQuota({}), config: config({ allowWeaker }) }))
  const strict = list(false), relaxed = list(true)
  for (const weaker of ['claude/sonnet', 'codex/gpt-5.5', 'cursor/composer-2.5', 'codex/gpt-6-luna']) { assert.ok(!strict.includes(weaker), weaker); assert.ok(relaxed.includes(weaker), weaker) }
  for (const light of ['claude/haiku', 'antigravity/gemini-3.8-flash-high']) assert.ok(!relaxed.includes(light), light)
  assert.deepEqual(relaxed.slice(0, 5), strict, 'equal quality still comes before weaker')
  const sonnet = agentOf({ providerId: 'claude', model: 'claude-sonnet-5-thinking-high', requestedModel: 'sonnet' })
  assert.ok(labels(replacements({ agent: sonnet, catalog: CATALOG, quota: fakeQuota({}), config: config() })).includes('codex/gpt-5.5'), 'a strong-tier agent accepts strong-tier models')
})

test('measured tiers decide replacements: Luna stands in for strong models, Haiku only for light ones when weaker is allowed, GPT-OSS only from the pool', () => {
  const pick = (agent, extra = {}) => labels(replacements({ agent, catalog: CATALOG, quota: fakeQuota({}), config: config(), ...extra }))
  const sonnet = agentOf({ providerId: 'claude', model: 'sonnet', requestedModel: 'sonnet' })
  assert.ok(pick(sonnet).includes('codex/gpt-6-luna'), 'GPT-6 Luna replaces a strong model')
  const strongWeaker = pick(sonnet, { config: config({ allowWeaker: true }) })
  assert.ok(strongWeaker.includes('antigravity/gemini-3.8-flash-high'), 'one step below strong is light')
  assert.ok(!strongWeaker.includes('claude/haiku'), 'but never Haiku')
  assert.ok(!pick(sonnet, { pool: [{ providerId: 'claude', model: 'haiku' }] }).includes('claude/haiku'), 'not even from the pool')
  const flash = agentOf({ providerId: 'antigravity', model: 'gemini-3.8-flash-high', requestedModel: 'gemini-3.8-flash-high' })
  assert.ok(!pick(flash).includes('claude/haiku'), 'Haiku is weaker than the light models')
  const flashWeaker = replacements({ agent: flash, catalog: CATALOG, quota: fakeQuota({}), config: config({ allowWeaker: true }) })
  const haikuAt = flashWeaker.findIndex(item => item.model === 'haiku')
  assert.ok(haikuAt >= 0, 'one step down allowed: Haiku is a candidate')
  assert.ok(flashWeaker.every((item, index) => item.tier < 1 || index < haikuAt), 'after every light or better model')
  const withOss = CATALOG.map(entry => entry.id === 'antigravity' ? { ...entry, models: [...entry.models, 'gpt-oss-120b-medium'] } : entry)
  const haiku = agentOf({ providerId: 'claude', model: 'haiku', requestedModel: 'haiku' })
  assert.ok(pick(haiku, { catalog: withOss }).includes('antigravity/gemini-3.8-flash-high'), 'a Haiku agent takes light models')
  assert.ok(!pick(haiku, { catalog: withOss, config: config({ allowWeaker: true }) }).includes('antigravity/gpt-oss-120b-medium'), 'GPT-OSS is never chosen on its own')
  assert.ok(pick(haiku, { catalog: withOss, pool: [{ providerId: 'antigravity', model: 'gpt-oss-120b-medium' }] }).includes('antigravity/gpt-oss-120b-medium'), 'only from the pool')
})

test('models of unknown quality and local models count only when the user put them in the pool', () => {
  const base = { agent: agentOf(), catalog: CATALOG, quota: fakeQuota({}), config: config() }
  assert.ok(!labels(replacements(base)).includes('cursor/auto'))
  assert.ok(!labels(replacements(base)).some(label => label.startsWith('ollama')), 'local models are never offered on their own')
  const pooled = replacements({ ...base, pool: [{ providerId: 'cursor', model: 'auto' }, { providerId: 'ollama', model: 'mystery-7b' }] })
  assert.deepEqual(labels(pooled).slice(0, 2), ['cursor/auto', 'ollama/mystery-7b'], "the user's own pool comes first")
  assert.ok(!labels(replacements({ ...base, pool: [{ providerId: 'ollama', model: 'llama3' }] })).includes('ollama/llama3'), 'a model known to be weaker is not admitted by the pool alone')
  assert.equal(replacements({ ...base, pool: [{ providerId: 'claude', model: 'sonnet' }] }).some(item => item.model === 'sonnet'), false, 'a known weaker model stays out even when pooled, unless weaker is allowed')
  assert.equal(labels(replacements({ ...base, pool: [{ providerId: 'claude', model: 'opus' }] }))[0], 'claude/opus')
})

test("Claude Fable is never a replacement on its own (the user's rule), only when the user put it in the pool", () => {
  for (const model of ['claude-fable-5-1', 'Claude-Fable-5-Thinking-High', 'fable', 'anthropic/claude-fable@2026']) assert.equal(excluded(model), true, model)
  for (const model of ['opus', 'claude-opus-5-5-high', 'fabled-7b', '']) assert.equal(excluded(model), false, model)
  // Cursor lists Fable first, and as a flagship it would be the closest match for a flagship agent.
  const withFable = CATALOG.map(entry => entry.id === 'cursor' ? { ...entry, models: ['claude-fable-5-thinking-high', ...entry.models] } : entry.id === 'claude' ? { ...entry, models: [...entry.models, 'claude-fable-5-1'] } : entry)
  const base = { agent: agentOf(), catalog: withFable, quota: fakeQuota({}), config: config() }
  const fable = list => labels(list).filter(label => /fable/.test(label))
  assert.deepEqual(fable(replacements(base)), [])
  assert.deepEqual(fable(replacements({ ...base, relaxed: true })), [], 'not even when anything beats stopping')
  assert.deepEqual(fable(replacements({ ...base, models: { claude: 'claude-fable-5-1' } })), [], 'nor as the model chosen for its provider in the composer')
  assert.deepEqual(fable(replacements({ ...base, pool: [{ providerId: 'cursor' }] })), [], 'a provider pooled without a model does not name it')
  assert.equal(labels(replacements({ ...base, pool: [{ providerId: 'cursor', model: 'claude-fable-5-thinking-high' }] }))[0], 'cursor/claude-fable-5-thinking-high', 'named in the pool it is taken first')
  assert.equal(baselineTier('cursor', 'claude-fable-5-thinking-high'), 3, 'an agent running on Fable is still replaced by flagship models')
})

test('candidates skip the agent itself, failed replacements and providers that are not connected', () => {
  const failed = agentOf({ failedCandidates: new Set(['claude:opus']) })
  assert.ok(!labels(replacements({ agent: failed, catalog: CATALOG, quota: fakeQuota({}), config: config() })).includes('claude/opus'))
  const onClaude = agentOf({ providerId: 'claude', model: 'claude-opus-5-5', requestedModel: 'opus' })
  assert.ok(!labels(replacements({ agent: onClaude, catalog: CATALOG, quota: fakeQuota({}), config: config() })).includes('claude/opus'), 'the requested alias is the same model')
  const disconnected = CATALOG.map(entry => entry.id === 'claude' ? { ...entry, available: false } : entry)
  assert.ok(!labels(replacements({ agent: agentOf(), catalog: disconnected, quota: fakeQuota({}), config: config() })).some(label => label.startsWith('claude')))
  assert.deepEqual(replacements({ agent: agentOf(), catalog: [], pool: [], quota: fakeQuota({}), config: config() }), [], 'nothing known, nothing offered')
  assert.deepEqual(labels(replacements({ agent: agentOf(), catalog: [], pool: [{ providerId: 'claude', model: 'opus' }], quota: fakeQuota({}), config: config() })), ['claude/opus'], 'without a health list the pool is all there is')
})

test('another model of the same subscription helps only when the exhausted window is model-specific', () => {
  const fable = agentOf({ providerId: 'claude', model: 'claude-fable-5-1', requestedModel: 'claude-fable-5-1' })
  const scoped = { claude: { windows: [w(10), w(97, { kind: 'week', scope: 'Fable', models: ['fable'] })] } }
  assert.ok(labels(replacements({ agent: fable, catalog: CATALOG, quota: fakeQuota(scoped), config: config() })).includes('claude/opus'))
  const shared = { claude: { windows: [w(97)] } }
  assert.ok(!labels(replacements({ agent: fable, catalog: CATALOG, quota: fakeQuota(shared), config: config() })).some(label => label.startsWith('claude')), 'the shared 5-hour window is exhausted for every Claude model')
})

test('the reasoning level follows the agent only where the target offers it', () => {
  const pick = (effort, pool = []) => Object.fromEntries(replacements({ agent: agentOf({ reasoningEffort: effort }), catalog: CATALOG, pool, quota: fakeQuota({}), config: config({ allowWeaker: true }) }).map(item => [`${item.providerId}/${item.model}`, item.reasoningEffort]))
  const high = pick('xhigh')
  assert.equal(high['codex/gpt-6-astra'], 'xhigh'); assert.equal(high['codex/gpt-5.5'], 'xhigh'); assert.equal(high['claude/opus'], 'xhigh')
  assert.equal(high['antigravity/gemini-3.1-pro-high'], '', 'Google models have reasoning built in')
  assert.equal(high['cursor/claude-opus-5-5-high'], '', 'Cursor encodes the level in the model name')
  const ultra = pick('ultra')
  assert.equal(ultra['codex/gpt-6-astra'], 'ultra'); assert.equal(ultra['codex/gpt-5.5'], '', 'gpt-5.5 has no ultra'); assert.equal(ultra['claude/opus'], '', 'Claude has no ultra')
  const pooled = pick('high', [{ providerId: 'claude', model: 'opus', reasoningEffort: 'low' }, { providerId: 'antigravity', model: 'gemini-3.1-pro-high', reasoningEffort: 'max' }, { providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: '' }])
  assert.equal(pooled['claude/opus'], 'low', 'the pool entry decides'); assert.equal(pooled['antigravity/gemini-3.1-pro-high'], ''); assert.equal(pooled['codex/gpt-6-astra'], '', 'an empty pool level means auto')
  assert.equal(pick('')['claude/opus'], '')
})

test('the handover note states the change, the state, the cut-off turn and what to verify', () => {
  const agent = agentOf({ turns: 4, files: { read: ['a.txt'], wrote: ['b.txt'] } })
  const note = handoverNote({
    agent, from: { providerId: 'codex', model: 'gpt-6-sol' }, to: { providerId: 'claude', model: 'opus' }, reason: 'exhausted',
    level: { usedPercent: 100, resetsAt: Date.UTC(2026, 8, 29, 14, 0) }, team: { running: ['Tests'], finished: ['Docs'] }, unread: 2, actions: ['#3 write_file b.txt → wrote 10 bytes'],
    interrupted: { text: 'Patching parser…', actions: ['commandExecution: npm test [started]'] },
  })
  for (const part of ['HANDOVER', 'Before: codex / gpt-6-sol. Now: claude / opus', 'quota is exhausted', '2026-09-29 14:00 UTC', '"Orbit" (id=root)', '4 turn(s)', '"b.txt"', '"Tests"', '"Docs"', 'unread messages: 2', '#3 write_file b.txt', 'LAST TURN WAS CUT OFF', 'Patching parser', 'npm test [started]', 'Check the real state', 'do not repeat completed calls']) assert.ok(note.includes(part), part)
  const clean = handoverNote({ agent, from: { providerId: 'codex', model: '' }, to: { providerId: 'claude', model: 'opus' }, reason: 'approaching', level: { usedPercent: 93, window: { kind: 'week' }, resetsAt: null } })
  assert.match(clean, /nearly used up \(93% of its weekly window/)
  assert.match(clean, /previous turn had completed; nothing was cut off/)
  assert.match(handoverNote({ agent, from: { providerId: 'a' }, to: { providerId: 'b' }, reason: 'exhausted', interrupted: { text: '', actions: [] } }), /produced nothing before the cut/)
  assert.match(handoverNote({ agent, from: { providerId: 'a' }, to: { providerId: 'b' }, reason: 'replacement-failed', error: new Error('region blocked') }), /replacement chosen before could not run \(region blocked\)/)
  const failed = handoverNote({ agent, from: { providerId: 'a' }, to: { providerId: 'b' }, reason: 'failed', error: new Error('API Error: Connection dropped'), interrupted: { text: 'Half a patch', actions: [] } })
  assert.match(failed, /^HANDOVER: your model changed mid-task because the previous one failed with an error\./)
  assert.match(failed, /turn failed with an error \(API Error: Connection dropped\)/)
  assert.match(failed, /CUT OFF by the provider error/)
  assert.match(handoverNote({ agent, from: { providerId: 'a' }, to: { providerId: 'b' }, reason: 'stalled', error: new Error('silent'), interrupted: { text: 'x', actions: [] } }), /because the previous one stopped responding[\s\S]*CUT OFF by Orbit's watchdog/)
  const long = handoverNote({ agent, from: { providerId: 'a' }, to: { providerId: 'b' }, reason: 'exhausted', interrupted: { text: 'x'.repeat(20000), actions: Array.from({ length: 200 }, (_, i) => `native action number ${i} `.repeat(20)) } })
  assert.ok(long.length <= 5020 && long.endsWith('[truncated]'), 'a huge cut-off turn cannot flood the prompt')
})

// ---- The runtime moves a running agent -----------------------------------------------------------------------------

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-failover-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const tool = (name, args = {}) => ({ id: `${name}-${Math.random()}`, name, arguments: args })
const response = (...calls) => ({ text: JSON.stringify({ tool_calls: calls }) })
const identity = prompt => prompt.match(/Agent: ([^;]+); id=([^;]+); parent=([^;]+); depth=(\d+)/)
async function finished(runtime, payload) {
  const events = []
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => {
    events.push(event)
    if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event)
  })
  const runId = await runtime.start(payload)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return { snapshot: runtime.getRun(runId), events, event, runId }
}
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'codex', model: 'gpt-6-sol', prompt: 'Current task', ...extra })
function world(t, usage = {}, catalog = CATALOG) {
  const original = { ...quota.readers }
  const windows = { ...usage }
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async () => ({ windows: windows[id] || [], plan: 'test' })
  t.after(() => Object.assign(quota.readers, original))
  const monitor = new quota.QuotaMonitor()
  return { monitor, windows, runtime: run => new OrbitRuntime({ runProvider: run, quota: monitor, catalog: async () => catalog }) }
}
const USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 22 minutes."

test('a fresh agent whose subscription is nearly used up simply starts on a comparable one', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(97)], claude: [w(10)] })
  const { snapshot, events } = await finished(runtime(async options => { calls.push({ providerId: options.providerId, model: options.model, prompt: options.prompt }); return { text: 'Готово' } }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls.map(call => [call.providerId, call.model]), [['claude', 'opus']], 'the nearly empty subscription was never called')
  assert.ok(!calls[0].prompt.includes('HANDOVER: your model changed'), 'an agent that has done nothing needs no handover note')
  const [handover] = snapshot.agents[0].handovers
  assert.deepEqual([handover.reason, handover.fresh, handover.from.providerId, handover.to.providerId, handover.to.model, handover.usedPercent], ['approaching', true, 'codex', 'claude', 'opus', 97])
  assert.equal(snapshot.agents[0].providerId, 'claude')
  assert.equal(events.filter(event => event.type === 'agent.handover').length, 1)
  assert.equal(events.find(event => event.type === 'agent.handover').agentId, 'root')
})

test('a working agent moves to another subscription between two turns and keeps everything it knew', async t => {
  const workspace = folder(t), calls = []
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'x')
  const { runtime, monitor } = world(t, { codex: [w(40)], claude: [w(10)] })
  const { snapshot, events } = await finished(runtime(async options => {
    calls.push({ providerId: options.providerId, model: options.model, prompt: options.prompt })
    if (calls.length === 1) {
      monitor.ingest('codex', { windows: [w(96)] }) // a live figure announcing that the limit is close
      return response(tool('list_files'))
    }
    return { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls.map(call => call.providerId), ['codex', 'claude'])
  const second = calls[1].prompt
  assert.match(second, /HANDOVER: your model changed mid-task because of subscription quota/)
  assert.match(second, /Before: codex \/ gpt-6-sol\. Now: claude \/ opus/)
  assert.ok(second.includes('notes.txt'), 'the earlier observation is still in the transcript')
  assert.match(second, /WORK LOG[\s\S]*list_files/, 'the work log carries over')
  assert.match(second, /HANDOVER codex \/ gpt-6-sol → claude \/ opus \(approaching\)/, 'the switch is itself in the work log')
  assert.match(second, /previous turn had completed/)
  assert.match(second, /Agent: Orbit; id=root/, 'it is the same agent')
  assert.ok(!calls[0].prompt.includes('HANDOVER'))
  const root = snapshot.agents[0]
  assert.equal(root.turns, 2)
  assert.deepEqual([root.handovers.length, root.handovers[0].fresh, root.handovers[0].interrupted], [1, false, false])
  assert.match(root.handovers[0].note, /HANDOVER/)
  assert.ok(snapshot.traces.some(trace => trace.kind === 'handover' && /codex → claude|codex \/ gpt-6-sol → claude \/ opus/.test(trace.text) && /журнал действий/.test(trace.text)))
  assert.equal(events.filter(event => event.type === 'agent.handover').length, 1)
})

test('a refusal in the middle of a turn: the cut-off turn is redone elsewhere and the newcomer is told what it left half done', async t => {
  const workspace = folder(t), calls = []
  const { runtime, monitor } = world(t, { codex: [w(20)], claude: [w(10)] })
  const before = Date.now()
  const { snapshot } = await finished(runtime(async options => {
    calls.push({ providerId: options.providerId, prompt: options.prompt })
    if (calls.length === 1) {
      options.onEvent({ kind: 'output', messageId: 'm1', text: 'Начинаю править парсер…', partial: true })
      options.onEvent({ kind: 'tool', native: true, tool: 'commandExecution', toolId: 'c1', text: 'npm test', status: 'started' })
      throw new Error(USAGE_LIMIT)
    }
    return { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls.map(call => call.providerId), ['codex', 'claude'])
  assert.match(calls[1].prompt, /LAST TURN WAS CUT OFF/)
  assert.ok(calls[1].prompt.includes('Начинаю править парсер'))
  assert.ok(calls[1].prompt.includes('commandExecution: npm test [started]'))
  assert.match(calls[1].prompt, /provider refused the request because the quota is exhausted/)
  const root = snapshot.agents[0]
  assert.deepEqual([root.handovers[0].reason, root.handovers[0].fresh, root.handovers[0].interrupted], ['exhausted', true, true], 'a cut-off turn is passed on even if it was the agent\'s first')
  assert.equal(root.turns, 1, 'the refused attempt is not a turn the agent took')
  assert.equal(snapshot.usage.providerTurns, 1)
  const codex = monitor.peek('codex')
  assert.equal(codex.state, 'exhausted')
  const wait = codex.exhaustedUntil - before
  assert.ok(wait > (3 * 60 + 22) * 60000 - 5000 && wait < (3 * 60 + 22) * 60000 + 5000, `cooldown follows the announced ${wait}`)
})

test('when every other subscription is unusable the agent stops with an explanation, the provider stays marked, and nothing is retried in a loop', async t => {
  const workspace = folder(t), calls = []
  const { runtime, monitor } = world(t, { codex: [w(20)] }, [CATALOG[0]])
  const { snapshot } = await finished(runtime(async options => { calls.push(options.providerId); throw new Error(USAGE_LIMIT) }), payload(workspace))
  assert.equal(snapshot.status, 'failed')
  assert.deepEqual(calls, ['codex'])
  assert.match(snapshot.error, /Квота подписки «codex» исчерпана/)
  assert.match(snapshot.error, /подходящей замены среди подключённых подписок нет/)
  assert.match(snapshot.error, /usage limit/, 'the provider\'s own words are kept')
  assert.equal(monitor.peek('codex').state, 'exhausted')
  assert.equal(snapshot.agents[0].handovers.length, 0)
})

test('subscriptions are tried one after another, each once, until all are out', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(20)], claude: [w(30)], antigravity: [w(40, { models: ['claude'] })] })
  const { snapshot } = await finished(runtime(async options => { calls.push(options.providerId); throw new Error(`${options.providerId}: ${USAGE_LIMIT}`) }), payload(workspace))
  assert.equal(snapshot.status, 'failed')
  assert.equal(new Set(calls).size, calls.length, 'no provider is called twice')
  assert.deepEqual(new Set(calls), new Set(['codex', 'claude', 'antigravity', 'cursor']))
  assert.match(snapshot.error, /исчерпана/)
})

test('a replacement that cannot run is dropped and the next candidate is tried', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(20)], claude: [w(30)], antigravity: [w(5, { models: ['claude', 'gpt-oss'] })] }, CATALOG.slice(0, 3))
  const { snapshot } = await finished(runtime(async options => {
    calls.push(options.providerId)
    if (options.providerId === 'codex') throw new Error(USAGE_LIMIT)
    if (options.providerId === 'antigravity') throw new Error('Eligibility check failed: not currently available in your location')
    return { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['codex', 'antigravity', 'claude'], 'the healthiest candidate was tried first, then the next one')
  const root = snapshot.agents[0]
  assert.deepEqual(root.handovers.map(handover => handover.reason), ['exhausted', 'replacement-failed'])
  assert.equal(root.providerId, 'claude')
  assert.equal(snapshot.usage.providerTurns, 1, 'neither failed attempt counts as a turn')
})

test('a subscription that could not answer is dropped as a whole, not model by model', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(20)], claude: [w(30)], antigravity: [w(1)] }, CATALOG.slice(0, 3))
  const { snapshot } = await finished(runtime(async options => {
    calls.push(`${options.providerId}/${options.model}`)
    if (options.providerId === 'codex') throw new Error(USAGE_LIMIT)
    if (options.providerId === 'antigravity') throw new Error('Eligibility check failed: not currently available in your location')
    return { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.equal(calls.filter(call => call.startsWith('antigravity')).length, 1, 'three Antigravity models are listed, one attempt is enough to know the region is refused')
  assert.equal(calls.at(-1), 'claude/opus')
  assert.equal(snapshot.agents[0].handovers.length, 2)
})

// ---- An agent in error is replaced (user's rule 2026-09-30) ------------------------------------------------------------

test('a subscription that cannot answer at all is told apart from a passing failure', () => {
  for (const message of [
    'Google отклонил доступ к Antigravity по региону.\n\nFAILED_PRECONDITION (code 400): User location is not supported for the API use.',
    'error: Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
    'spawn agy ENOENT', 'Not logged in · Please run /login',
  ]) assert.equal(unreachable(new Error(message)), true, message)
  for (const message of ['API Error: Connection dropped (ECONNRESET)', 'error: invalid model selection (--model "x" --effort "max")', 'ActionRequiredError: Named models unavailable Free plans can only use Auto.', 'Provider returned an empty response']) {
    assert.equal(unreachable(new Error(message)), false, message)
  }
})

test('an agent whose own provider fails moves to another subscription, and one that cannot answer is dropped as a whole', async t => {
  const workspace = folder(t), calls = []
  const REGION = 'Google отклонил доступ к Antigravity по региону.\n\nFAILED_PRECONDITION (code 400): User location is not supported for the API use.'
  const { runtime } = world(t, { codex: [w(20)], claude: [w(10)], antigravity: [w(1)] }, CATALOG.slice(0, 3))
  const { snapshot } = await finished(runtime(async options => {
    calls.push(`${options.providerId}/${options.model}`)
    if (options.providerId === 'antigravity') throw new Error(REGION)
    return { text: 'Готово' }
  }), payload(workspace, { providerId: 'antigravity', model: 'gemini-3.1-pro-high' }))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['antigravity/gemini-3.1-pro-high', 'claude/opus'], 'the freer Antigravity model is not tried after a region refusal')
  assert.deepEqual(snapshot.agents[0].handovers.map(handover => handover.reason), ['failed'])
  assert.ok(snapshot.traces.some(trace => trace.kind === 'handover' && /ошибка провайдера/.test(trace.text)))
  assert.equal(snapshot.usage.providerTurns, 1, 'the failed attempt is not a turn the agent took')
})

test('a passing provider error moves the agent on but keeps the subscription for its other models', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(1)], claude: [w(30)] }, CATALOG.slice(0, 2))
  const { snapshot } = await finished(runtime(async options => {
    calls.push(`${options.providerId}/${options.model}`)
    if (calls.length === 1) throw new Error('API Error: Connection dropped (ECONNRESET)')
    return { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['codex/gpt-6-sol', 'codex/gpt-6-astra'])
  assert.deepEqual(snapshot.agents[0].handovers.map(handover => handover.reason), ['failed'])
})

test('a failing agent with nobody to take over, or with failover off, stops with the provider\'s own error', async t => {
  const workspace = folder(t)
  for (const [catalog, extra] of [[[{ id: 'codex', available: true, models: ['gpt-6-sol'] }], {}], [CATALOG, { quotaFailover: { enabled: false } }]]) {
    const calls = []
    const { runtime } = world(t, { codex: [w(20)], claude: [w(10)] }, catalog)
    const { snapshot, events } = await finished(runtime(async options => { calls.push(options.providerId); throw new Error('API Error: Connection dropped (ECONNRESET)') }), payload(workspace, extra))
    assert.equal(snapshot.status, 'failed')
    assert.deepEqual(calls, ['codex'])
    assert.equal(snapshot.error, 'API Error: Connection dropped (ECONNRESET)')
    assert.equal(events.filter(event => event.type === 'agent.handover').length, 0)
    assert.ok(!snapshot.traces.some(trace => trace.kind === 'quota'), 'an error is not reported as a quota problem')
  }
})

test('Orbit\'s own failure around a turn (its time budget) is not blamed on the provider: no handover', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(20)], claude: [w(10)] })
  const { snapshot, events } = await finished(runtime(options => {
    calls.push(options.providerId)
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }), payload(workspace, { limits: { timeoutMs: 100 } }))
  assert.equal(snapshot.status, 'failed')
  assert.deepEqual(calls, ['codex'])
  assert.match(snapshot.error, /time budget exhausted/)
  assert.equal(events.filter(event => event.type === 'agent.handover').length, 0)
})

test('providers named to skip are not offered at all', () => {
  const found = replacements({ agent: agentOf(), catalog: CATALOG, quota: fakeQuota({}), config: config(), skip: new Set(['antigravity', 'cursor']) })
  assert.deepEqual(labels(found), ['claude/opus', 'codex/gpt-6-astra'])
})

test('a replacement that fails with nobody left explains that the replacement failed', async t => {
  const workspace = folder(t)
  const { runtime } = world(t, { codex: [w(20)] }, [CATALOG[0], CATALOG[3]])
  const { snapshot } = await finished(runtime(async options => {
    if (options.providerId === 'codex') throw new Error(USAGE_LIMIT)
    throw new Error('Cursor: named models are not available on the Free plan')
  }), payload(workspace, { quotaFailover: { allowWeaker: true } }))
  assert.equal(snapshot.status, 'failed')
  assert.match(snapshot.error, /Замена cursor/)
  assert.match(snapshot.error, /Free plan/)
})

test('with failover switched off a refusal is reported as it is', async t => {
  const workspace = folder(t), calls = []
  const { runtime, monitor } = world(t, { codex: [w(97)], claude: [w(10)] })
  const { snapshot, events } = await finished(runtime(async options => { calls.push(options.providerId); throw new Error(USAGE_LIMIT) }), payload(workspace, { quotaFailover: { enabled: false } }))
  assert.equal(snapshot.status, 'failed')
  assert.deepEqual(calls, ['codex'], 'not even the near-limit reading moved the agent')
  assert.match(snapshot.error, /usage limit/)
  assert.doesNotMatch(snapshot.error, /Квота подписки/)
  assert.equal(events.filter(event => event.type === 'agent.handover').length, 0)
  assert.equal(monitor.peek('codex'), null, 'nothing was even measured')
})

test('without a quota monitor the runtime behaves exactly as before', async t => {
  const workspace = folder(t), calls = []
  const { snapshot } = await finished(new OrbitRuntime({ runProvider: async options => { calls.push(options.providerId); throw new Error(USAGE_LIMIT) } }), payload(workspace))
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.error, USAGE_LIMIT)
  assert.deepEqual(calls, ['codex'])
  assert.equal(snapshot.usage.providerTurns, 1, 'the failed turn stays counted')
})

test('an agent stays on the new subscription: no ping-pong between two busy ones', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(96)], claude: [w(50)] }, CATALOG.slice(0, 2))
  let turn = 0
  const { snapshot } = await finished(runtime(async options => {
    calls.push(options.providerId)
    return ++turn < 4 ? response(tool('list_files')) : { text: 'Готово' }
  }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['claude', 'claude', 'claude', 'claude'])
  assert.equal(snapshot.agents[0].handovers.length, 1)
})

test('no comparable subscription ahead of the limit: the agent carries on where it is and says so once', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(95)] }, [CATALOG[0]])
  let turn = 0
  const { snapshot } = await finished(runtime(async options => { calls.push(options.providerId); return ++turn < 3 ? response(tool('list_files')) : { text: 'Готово' } }), payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.deepEqual(calls, ['codex', 'codex', 'codex'])
  assert.equal(snapshot.traces.filter(trace => trace.kind === 'quota').length, 1)
  assert.match(snapshot.traces.find(trace => trace.kind === 'quota').text, /95%/)
  assert.equal(snapshot.agents[0].handovers.length, 0)
})

test('the switch point and the weaker-model permission come from the run settings', async t => {
  const workspace = folder(t)
  const onlySonnet = [CATALOG[0], { id: 'claude', available: true, models: ['sonnet'] }]
  const seen = async settings => {
    const calls = []
    const { runtime } = world(t, { codex: [w(60)], claude: [w(10)] }, onlySonnet)
    await finished(runtime(async options => { calls.push(options.providerId); return { text: 'Готово' } }), payload(workspace, { quotaFailover: settings }))
    return calls
  }
  assert.deepEqual(await seen({ switchAtPercent: 90 }), ['codex'], '60% is below the default point')
  assert.deepEqual(await seen({ switchAtPercent: 50 }), ['codex'], 'a lower point alone does not admit a weaker model')
  assert.deepEqual(await seen({ switchAtPercent: 50, allowWeaker: true }), ['claude'])
})

test('helpers are moved on their own, and a refused attempt does not eat their turn budget', async t => {
  const workspace = folder(t), calls = []
  const pool = [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex', model: 'gpt-6-sol' }]
  const { runtime } = world(t, { codex: [w(96)], claude: [w(10)] })
  const { snapshot } = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    calls.push(`${name}@${options.providerId}`)
    if (name === 'Orbit' && calls.filter(call => call.startsWith('Orbit')).length === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Look around', reason: 'Independent work', providerId: 'codex', model: 'gpt-6-sol' }), tool('wait_agent'))
    if (name === 'Helper') return calls.filter(call => call.startsWith('Helper')).length === 1 ? response(tool('list_files')) : { text: 'helper done' }
    return { text: 'Готово' }
  }), payload(workspace, { providerId: 'claude', model: 'opus', providerPool: pool, limits: { maxTurns: 3 } }))
  assert.equal(snapshot.status, 'completed')
  const helper = snapshot.agents.find(agent => agent.name === 'Helper'), root = snapshot.agents.find(agent => agent.id === 'root')
  assert.deepEqual(calls.filter(call => call.startsWith('Helper')), ['Helper@claude', 'Helper@claude'], 'the helper never ran on the nearly empty subscription')
  assert.deepEqual([helper.handovers.length, helper.handovers[0].fresh, helper.providerId], [1, true, 'claude'])
  assert.equal(root.handovers.length, 0)
  assert.equal(helper.budgetLimited, false)
  assert.equal(helper.result, 'helper done')
})

test('a refused attempt of a helper is not counted against its turn limit', async t => {
  const workspace = folder(t), calls = []
  const pool = [{ providerId: 'claude', model: 'opus' }, { providerId: 'codex', model: 'gpt-6-sol' }]
  const { runtime } = world(t, { codex: [w(20)], claude: [w(10)] })
  const { snapshot } = await finished(runtime(async options => {
    const [, name] = identity(options.prompt)
    calls.push(`${name}@${options.providerId}`)
    if (name === 'Orbit' && calls.filter(call => call.startsWith('Orbit')).length === 1) return response(tool('spawn_agent', { name: 'Helper', task: 'Look around', reason: 'Independent work', providerId: 'codex', model: 'gpt-6-sol' }), tool('wait_agent'))
    if (name === 'Helper' && options.providerId === 'codex') throw new Error(USAGE_LIMIT)
    if (name === 'Helper') return calls.filter(call => call.startsWith('Helper@claude')).length === 1 ? response(tool('list_files')) : { text: 'helper done' }
    return { text: 'Готово' }
  }), payload(workspace, { providerId: 'claude', model: 'opus', providerPool: pool, limits: { maxTurns: 3 } }))
  const helper = snapshot.agents.find(agent => agent.name === 'Helper')
  assert.deepEqual(calls.filter(call => call.startsWith('Helper')), ['Helper@codex', 'Helper@claude', 'Helper@claude'])
  assert.equal(helper.turns, 2, 'two real turns; the refused one was handed back')
  assert.equal(helper.budgetLimited, false, 'with maxTurns 3 the helper still had its last turn free')
  assert.equal(snapshot.usage.workerTurns, 2)
})

test('live quota events from a provider reach the monitor and stay out of the agent trace', async t => {
  const workspace = folder(t)
  const { runtime, monitor } = world(t, { claude: [w(10)] })
  const { snapshot } = await finished(runtime(async options => {
    options.onEvent({ kind: 'quota', providerId: 'claude', quota: { windows: [w(63)], blocked: false, source: 'claude-live' } })
    return { text: 'Готово' }
  }), payload(workspace, { providerId: 'claude', model: 'opus' }))
  assert.equal(snapshot.status, 'completed')
  assert.equal(monitor.peek('claude').windows[0].usedPercent, 63)
  assert.ok(!JSON.stringify(snapshot.traces).includes('claude-live'))
})

test('a reading a few minutes old does not hold a turn back while it is refreshed', async t => {
  const workspace = folder(t)
  let offset = 0
  const clock = () => Date.now() + offset
  const original = { ...quota.readers }
  t.after(() => Object.assign(quota.readers, original))
  quota.readers.codex = () => new Promise(() => {}) // a probe that never answers
  const monitor = new quota.QuotaMonitor({ clock })
  monitor.ingest('codex', { windows: [w(40)] })
  offset = 2 * 60000
  const started = Date.now()
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'Готово' }), quota: monitor, catalog: async () => CATALOG, clock })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed')
  assert.ok(Date.now() - started < 3000, 'the turn did not wait for the six-second probe limit')
  assert.equal(monitor.peek('codex').windows[0].usedPercent, 40)
  offset = 30 * 60000
  const cold = Date.now()
  await finished(new OrbitRuntime({ runProvider: async () => ({ text: 'Готово' }), quota: monitor, catalog: async () => CATALOG, clock }), payload(workspace, { chatId: 'chat-2' }))
  assert.ok(Date.now() - cold >= 5500, 'a very old reading is waited for, up to the limit')
})

test('a stopped run is not treated as a quota problem', async t => {
  const workspace = folder(t), calls = []
  const { runtime } = world(t, { codex: [w(20)], claude: [w(10)] })
  const rt = runtime(async options => {
    calls.push(options.providerId)
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('rate limit while stopping'), { name: 'AbortError' })), { once: true }))
  })
  const events = []
  rt.onEvent(event => events.push(event))
  const runId = await rt.start(payload(workspace))
  for (let waited = 0; !calls.length && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50)) // the first provider call may take a while under a loaded machine
  rt.stop(runId)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(calls, ['codex'])
  assert.equal(rt.getRun(runId).status, 'cancelled')
  assert.equal(events.filter(event => event.type === 'agent.handover').length, 0)
})
