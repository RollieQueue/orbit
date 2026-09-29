import { assess } from './quota.mts'
import TIERS from './model-tiers.json' with { type: 'json' }
import REASONING from './reasoning-defaults.json' with { type: 'json' }
// Replacing an agent whose subscription is running out: which model may take over, and what the newcomer is told.
// Pure functions; the runtime decides when to call them and applies the result.
// Shape of model-tiers.json: ordered name patterns giving a quality tier, and the tier assumed per provider when the
// model being replaced is not known by name.
// One provider of the health list (`inspectProviders`), as far as failover reads it.
// One member of the user's provider pool.
// Only the cached reading is consulted here; the runtime refreshes the monitor before asking.
// The level the runtime hands over: a quota assessment, or the synthetic `{ usedPercent: 100 }` after a refusal.
const tiers = TIERS
const reasoningLevels = REASONING
const RULES = tiers.rules.map(rule => ({ tier: rule.tier, pattern: new RegExp(rule.match, 'i') }))
// Local models and arbitrary endpoints have no comparable quality; they are replacements only when the user listed them.
const LOCAL = new Set(['ollama', 'custom'])
const MAX_CATALOG_MODELS = 40
// A provider that publishes no quota ranks after measured healthy ones and before nearly empty ones.
const UNMEASURED_USED = 45
const DEFAULTS = Object.freeze({ enabled: true, switchAtPercent: 90, allowWeaker: false })
function normalizeFailover(input) {
 const value = (input && typeof input === 'object' ? input : {})
 const percent = Number(value.switchAtPercent)
 return {
 enabled: value.enabled !== false,
 switchAtPercent: Number.isFinite(percent) ? Math.max(50, Math.min(99, Math.round(percent))) : DEFAULTS.switchAtPercent,
 allowWeaker: value.allowWeaker === true,
 }
}
function tierOf(model) {
 const name = String(model || '').toLowerCase()
 if (!name) return 0
 for (const rule of RULES) if (rule.pattern.test(name)) return rule.tier
 return 0
}
// The tier the agent being replaced is judged by.
const baselineTier = (providerId , model) => tierOf(model) || tiers.baseline[providerId] || 2
const targetKey = (providerId , model) => `${providerId}:${String(model || '').toLowerCase()}`
const targetLabel = (target) => `${target.providerId}${target.model ? ` / ${target.model}` : ''}`
// Cursor and Antigravity encode or ignore the level themselves; the others keep the agent's level only where the target offers it.
function effortFor(providerId , model , wanted , entry , poolEffort) {
 if (poolEffort !== undefined && poolEffort !== null) return providerId === 'antigravity' ? '' : poolEffort
 if (!wanted || providerId === 'antigravity' || providerId === 'cursor') return ''
 const levels = entry?.reasoningLevels?.[model] || reasoningLevels[providerId] || []
 return levels.includes(wanted) ? wanted : ''
}
// Ranked replacements for `agent`, best first. `quota` is a QuotaMonitor (only cached readings are used here) and
// `catalog` the provider health list ({ id, available, models, reasoningLevels }).
// `relaxed` also admits providers that are close to the limit but not out of it (after a refusal, anything beats stopping).
// `skip` names providers that just failed to answer at all (region, sign-in, network): none of their models is tried.
function replacements({ agent, catalog = [], pool = [], models = {}, quota, config, now = Date.now(), relaxed = false, skip = new Set () }) {
 const baseline = baselineTier(agent.providerId, agent.model || agent.requestedModel)
 const floor = baseline - (config.allowWeaker ? 1 : 0)
 const entries = new Map(catalog.map(entry => [entry.id, entry]))
 // Without a health list the user's own pool is all that is known.
 const providerIds = catalog.length ? catalog.filter(entry => entry.available !== false).map(entry => entry.id) : [...new Set(pool.map(member => member.providerId))]
 const own = new Set([targetKey(agent.providerId, agent.requestedModel), targetKey(agent.providerId, agent.model)])
 const found = []
 for (const providerId of [...new Set(providerIds)]) {
 if (skip.has(providerId)) continue
 const members = pool.filter(member => member.providerId === providerId)
 if (LOCAL.has(providerId) && !members.length) continue
 const entry = entries.get(providerId)
 const names = [...members.map(member => member.model || ''), ...(models[providerId] ? [models[providerId]] : []), ...(entry?.models || []).slice(0, MAX_CATALOG_MODELS)]
 for (const model of [...new Set(names)]) {
 const key = targetKey(providerId, model)
 if (own.has(key) || agent.failedCandidates?.has(key)) continue
 const inPool = members.some(member => (member.model || '') === model)
 const tier = tierOf(model)
 if (tier ? tier < floor : !inPool) continue
 const level = assess(quota?.peek(providerId), { model, threshold: config.switchAtPercent, now })
 if (level.exhausted || (level.near && !relaxed)) continue
 const member = members.find(item => (item.model || '') === model)
 found.push({ providerId, model, tier, inPool, key, usedPercent: level.usedPercent, reasoningEffort: effortFor(providerId, model, agent.reasoningEffort, entry, member?.reasoningEffort) })
 }
 }
 // The user's own pool first, then the closest quality (equal, then better, then weaker), then the most headroom.
 const distance = (item) => !item.tier ? 0.5 : item.tier === baseline ? 0 : item.tier > baseline ? 1 + (item.tier - baseline) / 10 : 3 + (baseline - item.tier)
 return found.sort((a, b) => Number(b.inPool) - Number(a.inPool) || distance(a) - distance(b) || (a.usedPercent ?? UNMEASURED_USED) - (b.usedPercent ?? UNMEASURED_USED) || a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model))
}
const clock = (time) => Number.isFinite(time) ? new Date(time).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown'
function reasonText({ reason, level, error }) {
 if (reason === 'approaching') return `the subscription quota is nearly used up (${level?.usedPercent ?? '?'}% of its ${level?.window?.kind === 'week' ? 'weekly' : '5-hour'} window; it resets ${clock(level?.resetsAt)})`
 // The error is whatever the provider threw; its message is used when it has one, otherwise the value itself is printed.
 if (reason === 'replacement-failed') return `the replacement chosen before could not run (${String((error)?.message || error).replace(/\s+/g, ' ').slice(0, 200)})`
 return `the provider refused the request because the quota is exhausted${level?.resetsAt ? ` (it resets ${clock(level.resetsAt)})` : ''}`
}
const excerpt = (value , limit) => { const text = String(value ?? '').trim(); return text.length > limit ? `…${text.slice(-limit)}` : text }
// What the newcomer is told. The runtime already keeps the agent's memory outside any model (work log, transcript, team
// directory, file map), so this states the change, digests the state, and reports what the previous turn left half done.
function handoverNote({ agent, from, to, reason, level, error, interrupted, team = { running: [], finished: [] }, unread = 0, actions = [] }) {
 const files = agent.files || { read: [], wrote: [] }
 const lines = [
 'HANDOVER: your model changed mid-task because of subscription quota.',
 `Before: ${targetLabel(from)}. Now: ${targetLabel(to)}. Reason: ${reasonText({ reason, level, error })}.`,
 `You are still the same agent, "${agent.name}" (id=${agent.id}), and your task is unchanged. Orbit keeps your memory outside the model: the WORK LOG, AGENT TRANSCRIPT, TEAM DIRECTORY and FILE MAP in this prompt are the complete record of what you did before the change. Continue from that record; do not restart the task and do not repeat completed calls.`,
 `State at the handover: ${agent.turns} turn(s) taken; files written: ${JSON.stringify(files.wrote.slice(-8))}; files read: ${JSON.stringify(files.read.slice(-6))}; teammates still running: ${JSON.stringify(team.running)}; finished: ${JSON.stringify(team.finished)}; unread messages: ${unread}.`,
 ]
 if (actions.length) lines.push(`Your last recorded actions:\n${actions.map(action => `- ${action}`).join('\n')}`)
 if (interrupted && (interrupted.text || interrupted.actions?.length)) {
 lines.push('The previous model\'s LAST TURN WAS CUT OFF by the quota refusal, so its result is missing.')
 if (interrupted.text) lines.push(`Text it had streamed before the cut (may be incomplete): ${JSON.stringify(excerpt(interrupted.text, 1500))}`)
 if (interrupted.actions?.length) lines.push(`Native tool actions it had started in that turn (they may already have taken effect):\n${interrupted.actions.map(action => `- ${action}`).join('\n')}`)
 lines.push('Check the real state (read the files, run the check) before repeating any write or command from that turn.')
 } else if (interrupted) lines.push('The previous turn produced nothing before the cut, so nothing needs to be checked.')
 else lines.push('The previous turn had completed; nothing was cut off.')
 const note = lines.join('\n')
 return note.length > 5000 ? `${note.slice(0, 5000)}\n[truncated]` : note
}
export { normalizeFailover, tierOf, baselineTier, replacements, handoverNote, reasonText, targetKey, targetLabel, DEFAULTS, LOCAL }
