// Subscription failover as the runtime applies it: the quota check before a turn, the handover of an agent to another
// provider with its note, and the recovery after a refused or failed turn. The pure choice lives in ../failover.mts.
import { randomUUID } from 'node:crypto'
import { classifyQuotaError, assess } from '../quota.mts'
import { replacements, handoverNote, targetLabel } from '../failover.mts'
import type { AgentRecord, CatalogEntry, HandoverReason, HandoverRecord, HandoverRequest, InterruptedTurn, ModelTarget, OrbitRuntimeLike, RunRecord } from '../types.mts'
import { withoutGoogleReasoning, publicAgent, bounded, clip, TurnBudgetError, diagnostics } from './util.mts'
import { closeAgentSession } from './session.mts'
// An agent changes provider at most this many times; readings older than the age are refreshed before a turn, but a
// slow probe is never waited for longer than the wait.
const MAX_HANDOVERS = 8
const QUOTA_MAX_AGE_MS = 60000
const QUOTA_WAIT_MS = 6000
const QUOTA_STALE_MS = 5 * 60000
const CATALOG_MAX_AGE_MS = 120000
const BROKEN_PROVIDER_MS = 10 * 60000

// ---- Subscription failover -------------------------------------------------------------------------------------
// An agent's memory (transcript, work log, files, mailbox) lives in Orbit, and every provider turn is a fresh
// inference, so an agent can change model between two turns without losing anything. What has to be added is an
// explicit HANDOVER note, and the record of what a cut-off turn left half done.
// Every path below runs only when failoverActive() held, so `runtime.quota` is set there (hence its `!`).
function failoverActive(runtime: OrbitRuntimeLike, run: RunRecord): boolean { return !!runtime.quota && run.failover.enabled }
async function providerCatalog(runtime: OrbitRuntimeLike, run: RunRecord): Promise<CatalogEntry[]> {
  if (!runtime.catalog) return []
  // The promise itself is cached, so agents switching at the same moment share one provider inspection.
  if (!run.catalogCache || runtime.clock() - run.catalogCache.at >= CATALOG_MAX_AGE_MS) {
    // Without a health list the user's own pool is still used. (`catalog` was checked on entry.)
    run.catalogCache = { at: runtime.clock(), value: Promise.resolve().then(() => runtime.catalog!(run.providerOptions)).then(list => list || [], (): CatalogEntry[] => []) }
  }
  return run.catalogCache.value
}
// Before a turn: is this agent's subscription so close to its limit that the turn should run elsewhere?
async function preflightQuota(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<void> {
  if (!runtime.failoverActive(run) || agent.handovers.length >= MAX_HANDOVERS) return
  const known = runtime.quota!.peek(agent.providerId)
  const refreshed = runtime.quota!.get(agent.providerId, { maxAgeMs: QUOTA_MAX_AGE_MS, waitMs: QUOTA_WAIT_MS, options: run.providerOptions[agent.providerId] || {} })
  // A reading a few minutes old is good enough to judge "nearly out" (live events and the refusal path cover the rest),
  // so it is used at once while a new one is fetched; only a cold or very old one is waited for.
  const usable = known?.checkedAt && runtime.clock() - known.checkedAt < QUOTA_STALE_MS
  if (usable) refreshed.catch(error => diagnostics(runtime, run, `quota.get ${agent.providerId}`, error, agent.id))
  const snapshot = usable ? known : await refreshed
  if (runtime.agentSignal(run, agent).aborted) return
  const level = assess(snapshot, { model: agent.model || agent.requestedModel, threshold: run.failover.switchAtPercent, now: runtime.clock() })
  if (!level.exhausted && !level.near) return
  await runtime.handover(run, agent, { reason: level.exhausted ? 'exhausted' : 'approaching', level })
}
// Moves the agent to the best comparable subscription and tells the newcomer what it takes over. False: nobody suitable.
async function handover(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, { reason, level = null, error = null, interrupted = null }: HandoverRequest): Promise<boolean> {
  if (agent.handovers.length >= MAX_HANDOVERS) return false
  const catalog = await runtime.providerCatalog(run)
  const ids = new Set([agent.providerId, ...catalog.filter(entry => entry.available !== false).map(entry => entry.id), ...run.providerPool.map(member => member.providerId)])
  // Candidates are judged on fresh figures; one slow probe does not hold the agent for long.
  await Promise.all([...ids].map(id => runtime.quota!.get(id, { maxAgeMs: CATALOG_MAX_AGE_MS, waitMs: QUOTA_WAIT_MS, options: run.providerOptions[id] || {} })))
  if (runtime.agentSignal(run, agent).aborted) return false
  const now = runtime.clock()
  const skip = new Set([...run.brokenProviders].filter(([, until]) => until > now).map(([id]) => id))
  // run.models is the renderer's model choice per provider: model names by provider id.
  const context = { agent, catalog, pool: run.providerPool, models: run.models as Record<string, string | undefined>, quota: runtime.quota, config: run.failover, now, skip }
  // Ahead of a refusal only comfortable headroom justifies the change; after one, anything with a little left beats stopping.
  const [choice] = replacements(context).concat(reason === 'approaching' ? [] : replacements({ ...context, relaxed: true }))
  if (!choice) {
    if (agent.quotaWarned !== agent.providerId) {
      agent.quotaWarned = agent.providerId
      runtime.trace(run, agent.id, 'quota', `Квота ${agent.providerId} ${reason === 'approaching' ? `на исходе (${level?.usedPercent ?? '?'}%)` : 'исчерпана'}, подходящей замены среди подключённых подписок нет`)
    }
    return false
  }
  const from: ModelTarget = { providerId: agent.providerId, model: agent.model || agent.requestedModel || '', reasoningEffort: agent.reasoningEffort || '' }
  const to: ModelTarget = { providerId: choice.providerId, model: choice.model, reasoningEffort: withoutGoogleReasoning(choice.providerId, choice.reasoningEffort) }
  // "Fresh" means nothing was done yet: a refused session turn may already have made Orbit tool calls over MCP.
  const fresh = agent.turns === 0 && !agent.ledger.length
  const record: HandoverRecord = {
    id: randomUUID(), time: new Date().toISOString(), reason, from, to, fresh,
    usedPercent: level?.usedPercent ?? null, resetsAt: level?.resetsAt ?? null,
    interrupted: !!(interrupted && (interrupted.text || interrupted.actions.length)),
  }
  // An agent that has done nothing yet simply starts on the other subscription, unless its cut-off turn had already
  // streamed text or started native actions: those may have taken effect and the newcomer must know.
  if (!fresh || record.interrupted) {
    const note = handoverNote({ agent, from, to, reason, level, error, interrupted, team: runtime.teamDigest(run, agent), unread: runtime.pendingMail(run, agent).length, actions: agent.ledger.slice(-8).map(entry => entry.text) })
    runtime.remember(agent, { type: 'instruction', content: note })
    runtime.recordLedger(agent, 'handover', `#${agent.turns} HANDOVER ${targetLabel(from)} → ${targetLabel(to)} (${reason})`)
    record.note = bounded(note, 1500)
  }
  agent.trial = { key: choice.key }
  const why = ({ approaching: `квота ${level?.usedPercent ?? '?'}%`, exhausted: 'квота исчерпана', 'replacement-failed': 'замена не запустилась' } satisfies Record<HandoverReason, string>)[reason]
  // The newcomer starts a fresh session (or the envelope loop) with the note in its first prompt; the old session is over,
  // so what its provider keeps alive for it is closed now.
  const transport = runtime.decideTransport(run, to.providerId, to.model)
  closeAgentSession(runtime, agent)
  runtime.updateAgent(run, agent, { providerId: to.providerId, model: to.model, requestedModel: to.model, reasoningEffort: to.reasoningEffort, handovers: [...agent.handovers, record], transport, sessionId: null, detail: `Переключён на ${targetLabel(to)}` })
  runtime.trace(run, agent.id, 'handover', `${targetLabel(from)} → ${targetLabel(to)} (${why})${fresh ? '' : `. Новая модель получила журнал действий, файлы${record.interrupted ? ' и незавершённый ход' : ''}.`}`)
  runtime.emit(run, 'agent.handover', { agentId: agent.id, agent: publicAgent(agent), handover: record })
  return true
}
// After a failed provider turn: true when the agent was moved and the turn should be repeated, false when it is not a
// case for failover (the caller rethrows), and an error when the agent must stop because nobody can take over.
async function recoverProvider(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, error: unknown): Promise<boolean> {
  if (runtime.agentSignal(run, agent).aborted || !runtime.failoverActive(run) || error instanceof TurnBudgetError) return false
  const partial = agent.partialTurn
  const interrupted: InterruptedTurn | null = partial ? { text: [...partial.messages.values()].at(-1) || '', actions: [...partial.tools.values()] } : null
  const refusal = classifyQuotaError(error, agent.providerId, runtime.clock())
  // A failed provider turn rejects with an Error; its message is quoted below.
  if (refusal) {
    runtime.quota!.markExhausted?.(agent.providerId, { resetsAt: refusal.resetsAt, reason: refusal.message })
    if (await runtime.handover(run, agent, { reason: 'exhausted', level: { usedPercent: 100, window: null, resetsAt: refusal.resetsAt }, error, interrupted })) return true
    const until = refusal.resetsAt ? ` (лимит снимется ${new Date(refusal.resetsAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})` : ''
    throw new Error(`Квота подписки «${agent.providerId}» исчерпана${until}, а подходящей замены среди подключённых подписок нет. Подключите другую подписку, разрешите более слабую модель в разделе «Квоты» или дождитесь сброса. Ход и журнал действий сохранены. Ответ провайдера: ${clip((error as Error).message, 240)}`, { cause: error })
  }
  if (!agent.trial) return false
  // The replacement itself failed before completing a turn: try the next one, never the same twice. A subscription that
  // could not answer (wrong region, signed out, unreachable) is not offered again to any agent of this run for a while.
  agent.failedCandidates.add(agent.trial.key)
  run.brokenProviders.set(agent.providerId, runtime.clock() + BROKEN_PROVIDER_MS)
  if (await runtime.handover(run, agent, { reason: 'replacement-failed', level: null, error, interrupted })) return true
  const previous = agent.handovers.at(-1)?.from
  throw new Error(`Замена ${targetLabel({ providerId: agent.providerId, model: agent.model })}${previous ? ` вместо ${targetLabel(previous)}` : ''} не смогла продолжить работу, других подходящих нет: ${clip((error as Error).message, 240)}`, { cause: error })
}

export { failoverActive, providerCatalog, preflightQuota, handover, recoverProvider }
