// Subscription failover as the runtime applies it: the quota check before a turn, the handover of an agent to another
// provider with its note, and the recovery after a refused or failed turn. The pure choice lives in ../failover.mts.
// Also the model a new helper gets for its kind of work (routeSpawn), judged on the same provider list and quotas.
import { randomUUID } from 'node:crypto'
import { classifyQuotaError, assess } from '../quota.mts'
import { replacements, handoverNote, targetLabel, unreachable, isPinned } from '../failover.mts'
import { candidates, route } from '../model-routing.mts'
import { baseOf, instancesFromOptions, matchesProvider } from '../instances.mts'
import type { AgentRecord, CatalogEntry, HandoverReason, HandoverRecord, HandoverRequest, InterruptedTurn, ModelTarget, OrbitRuntimeLike, RoutedSpawn, RunRecord, ToolArgs } from '../types.mts'
import { withoutGoogleReasoning, publicAgent, bounded, clip, TurnBudgetError, diagnostics, fromProvider } from './util.mts'
import { closeAgentSession } from './session.mts'
import { isStall, silentMinutes, stallNote, countSilentTurn, clearSilentTurns } from './watchdog.mts'
// An agent changes provider at most this many times; readings older than the age are refreshed before a turn, but a
// slow probe is never waited for longer than the wait.
const MAX_HANDOVERS = 8
const QUOTA_MAX_AGE_MS = 60000
const QUOTA_WAIT_MS = 6000
const QUOTA_STALE_MS = 5 * 60000
const CATALOG_MAX_AGE_MS = 120000
const BROKEN_PROVIDER_MS = 10 * 60000
// A helper waits this long at most for the provider list before its model is chosen without it (ORBIT_ROUTE_WAIT_MS).
const ROUTE_WAIT_MS = 8000
const routeWait = (): number => { const raw = process.env.ORBIT_ROUTE_WAIT_MS?.trim(), value = Number(raw); return raw && Number.isFinite(value) && value >= 0 ? value : ROUTE_WAIT_MS }

// ---- Subscription failover -------------------------------------------------------------------------------------
// An agent's memory (transcript, work log, files, mailbox) lives in Orbit, and every provider turn is a fresh
// inference, so an agent can change model between two turns without losing anything. What has to be added is an
// explicit HANDOVER note, and the record of what a cut-off turn left half done.
// Every path below runs only when failoverActive() held, so `runtime.quota` is set there (hence its `!`).
function failoverActive(runtime: OrbitRuntimeLike, run: RunRecord): boolean { return !!runtime.quota && run.failover.enabled }
// The ids of the run's extra subscriptions (claude-2), which `providerOptions` carries as entries of their own.
const instanceIds = (run: RunRecord): string[] => instancesFromOptions(run.providerOptions).map(instance => instance.id)
async function providerCatalog(runtime: OrbitRuntimeLike, run: RunRecord): Promise<CatalogEntry[]> {
  if (!runtime.catalog) return []
  // The promise itself is cached, so agents switching at the same moment share one provider inspection.
  if (!run.catalogCache || runtime.clock() - run.catalogCache.at >= CATALOG_MAX_AGE_MS) {
    // Without a health list the user's own pool is still used. (`catalog` was checked on entry.)
    const value = Promise.resolve().then(() => runtime.catalog!(run.providerOptions)).then(list => list || [], (): CatalogEntry[] => [])
    // `list`: the settled answer, for what has to read it without waiting (the reasoning levels a helper may get).
    // The list read before stays in use until the new one arrives (and when the new reading fails): levels and routing never fall back to defaults in between.
    const earlier = run.catalogCache?.list ?? runtime.lastCatalog?.list
    const cache: NonNullable<RunRecord['catalogCache']> = { at: runtime.clock(), value, ...(earlier ? { list: earlier } : {}), ...(run.catalogCache?.waited ? { waited: true } : {}) }
    void value.then(list => {
      if (list.length || !earlier) cache.list = list
      if (list.length) runtime.lastCatalog = { at: cache.at, list }
    })
    run.catalogCache = cache
  }
  return run.catalogCache.value
}
// Waits (at most ROUTE_WAIT_MS) until the provider list has been read once for this run, so the reasoning levels of its
// models are known; the answer is cached on the run, and a list that does not come in time is simply not used (and not
// waited for again: every turn of a run would otherwise pay the wait for a provider that never answers).
// A list an earlier run of this runtime read is taken at once for the levels, marked stale so that routing and failover
// still read their own: a fresh inspection runs every provider's CLI for seconds, and every message would wait for it.
async function settleCatalog(runtime: OrbitRuntimeLike, run: RunRecord): Promise<void> {
  if (!runtime.catalog || run.catalogCache?.list || run.catalogCache?.waited) return
  const known = runtime.lastCatalog
  if (known) {
    if (run.catalogCache) run.catalogCache.list = known.list
    else run.catalogCache = { at: Number.NEGATIVE_INFINITY, value: Promise.resolve(known.list), list: known.list }
    return
  }
  const timers: NodeJS.Timeout[] = []
  await Promise.race([runtime.providerCatalog(run), new Promise<null>(resolve => { timers.push(setTimeout(resolve, routeWait(), null)) })]).catch(() => null)
  timers.forEach(clearTimeout)
  if (run.catalogCache && !run.catalogCache.list) run.catalogCache.waited = true
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
  // A helper pinned to its subscription (spawn_agent failover 'none') never moves: replacements() would find nobody anyway,
  // so the lookups are skipped, and the trace says why it stays.
  if (agent.failover === 'none') {
    if (reason !== 'stalled' && reason !== 'failed' && agent.quotaWarned !== agent.providerId) { agent.quotaWarned = agent.providerId; runtime.trace(run, agent.id, 'quota', `${agent.providerId}: ${reason === 'approaching' ? 'квота на исходе' : 'квота исчерпана'}; помощник привязан к подписке (failover none), замена не ищется`) }
    return false
  }
  const catalog = await runtime.providerCatalog(run)
  const instances = instanceIds(run)
  const ids = new Set([agent.providerId, ...catalog.filter(entry => entry.available !== false).map(entry => entry.id), ...run.providerPool.map(member => member.providerId), ...instances])
  // Candidates are judged on fresh figures; one slow probe does not hold the agent for long.
  await Promise.all([...ids].map(id => runtime.quota!.get(id, { maxAgeMs: CATALOG_MAX_AGE_MS, waitMs: QUOTA_WAIT_MS, options: run.providerOptions[id] || {} })))
  if (runtime.agentSignal(run, agent).aborted) return false
  const now = runtime.clock()
  const skip = new Set([...run.brokenProviders].filter(([, until]) => until > now).map(([id]) => id))
  // run.models is the renderer's model choice per provider: model names by provider id.
  const context = { agent, catalog, pool: run.providerPool, models: run.models as Record<string, string | undefined>, quota: runtime.quota, config: run.failover, now, skip, instances }
  // Ahead of a refusal only comfortable headroom justifies the change; after one, anything with a little left beats stopping.
  const [choice] = replacements(context).concat(reason === 'approaching' ? [] : replacements({ ...context, relaxed: true }))
  if (!choice) {
    // A silent or failing model is not a quota matter: its own error, or recoverStall, says why the agent stops.
    if (reason !== 'stalled' && reason !== 'failed' && agent.quotaWarned !== agent.providerId) {
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
    interrupted: !!(interrupted && (interrupted.text || interrupted.actions.length)), turn: agent.turns,
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
  const why = ({ approaching: `квота ${level?.usedPercent ?? '?'}%`, exhausted: 'квота исчерпана', 'replacement-failed': 'замена не запустилась', stalled: 'модель перестала отвечать', failed: 'ошибка провайдера' } satisfies Record<HandoverReason, string>)[reason]
  // The newcomer starts a fresh session (or the envelope loop) with the note in its first prompt; the old session is over,
  // so what its provider keeps alive for it is closed now.
  const transport = runtime.decideTransport(run, to.providerId, to.model)
  closeAgentSession(runtime, agent)
  clearSilentTurns(agent)
  runtime.updateAgent(run, agent, { providerId: to.providerId, model: to.model, requestedModel: to.model, reasoningEffort: to.reasoningEffort, handovers: [...agent.handovers, record], transport, sessionId: null, detail: `Переключён на ${targetLabel(to)}` })
  runtime.trace(run, agent.id, 'handover', `${targetLabel(from)} → ${targetLabel(to)} (${why})${fresh ? '' : `. Новая модель получила журнал действий, файлы${record.interrupted ? ' и незавершённый ход' : ''}.`}`)
  runtime.emit(run, 'agent.handover', { agentId: agent.id, agent: publicAgent(agent), handover: record })
  return true
}
// After a failed provider turn: true when the agent was moved (or, after a silent turn, is to try again) and the turn
// should be repeated, false when nothing can be done (the caller rethrows the provider's error), and an error when the
// agent must stop because nobody can take over.
async function recoverProvider(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, error: unknown): Promise<boolean> {
  if (runtime.agentSignal(run, agent).aborted || error instanceof TurnBudgetError) return false
  const partial = agent.partialTurn
  const interrupted: InterruptedTurn | null = partial ? { text: [...partial.messages.values()].at(-1) || '', actions: [...partial.tools.values()] } : null
  // A turn stopped for silence is repeated, then handed over; a replacement on trial is judged below.
  if (isStall(error) && !agent.trial) return recoverStall(runtime, run, agent, error, interrupted)
  if (!runtime.failoverActive(run)) return false
  const refusal = classifyQuotaError(error, agent.providerId, runtime.clock())
  // A failed provider turn rejects with an Error; its message is quoted below.
  if (refusal) {
    runtime.quota!.markExhausted?.(agent.providerId, { resetsAt: refusal.resetsAt, reason: refusal.message })
    if (await runtime.handover(run, agent, { reason: 'exhausted', level: { usedPercent: 100, window: null, resetsAt: refusal.resetsAt }, error, interrupted })) return true
    const until = refusal.resetsAt ? ` (лимит снимется ${new Date(refusal.resetsAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})` : ''
    const pinned = agent.failover === 'none' ? ` Помощник привязан к этой подписке (failover 'none'): Orbit не переносит его на другую.` : ''
    throw new Error(`Квота подписки «${agent.providerId}» исчерпана${until}, а подходящей замены среди подключённых подписок нет.${pinned} Подключите другую подписку, разрешите более слабую модель в разделе «Квоты» или дождитесь сброса. Ход и журнал действий сохранены. Ответ провайдера: ${clip((error as Error).message, 240)}`, { cause: error })
  }
  if (!agent.trial) {
    // A provider that failed the turn moves the agent on too: an agent in error is replaced, not lost (the user's rule,
    // 2026-09-30). Orbit's own failures around the turn (the prompt, the time budget) would follow it anywhere, so they
    // stop it as before. A subscription that cannot answer at all (region, sign-in, missing CLI) is not offered to any
    // agent of this run for a while; without a replacement the provider's own error stops the agent, as before.
    if (!fromProvider(error)) return false
    if (unreachable(error)) run.brokenProviders.set(agent.providerId, runtime.clock() + BROKEN_PROVIDER_MS)
    if (agent.failover === 'none') throw new Error(`Подписка «${agent.providerId}» не смогла выполнить ход, а помощник привязан к ней (failover 'none'), поэтому на другую он не переносится: ${clip((error as Error).message, 240)}`, { cause: error })
    return runtime.handover(run, agent, { reason: 'failed', level: null, error, interrupted })
  }
  // The replacement itself failed before completing a turn: try the next one, never the same twice. A subscription that
  // could not answer (wrong region, signed out, missing CLI) is not offered again to any agent of this run for a while;
  // any other failure rules out only that model, so one repeatable error cannot bar every subscription.
  agent.failedCandidates.add(agent.trial.key)
  if (unreachable(error)) run.brokenProviders.set(agent.providerId, runtime.clock() + BROKEN_PROVIDER_MS)
  if (await runtime.handover(run, agent, { reason: 'replacement-failed', level: null, error, interrupted })) return true
  const previous = agent.handovers.at(-1)?.from
  throw new Error(`Замена ${targetLabel({ providerId: agent.providerId, model: agent.model })}${previous ? ` вместо ${targetLabel(previous)}` : ''} не смогла продолжить работу, других подходящих нет: ${clip((error as Error).message, 240)}`, { cause: error })
}
// After a turn the watchdog (watchdog.mts) or the provider's inactivity timeout stopped: true when the turn is to be
// repeated (the first time on the same model in a fresh session, then on another subscription), else an error that
// stops the agent. A replacement on trial that falls silent goes the failover way of recoverProvider instead.
async function recoverStall(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, error: unknown, interrupted: InterruptedTurn | null): Promise<boolean> {
  const label = targetLabel({ providerId: agent.providerId, model: agent.model || agent.requestedModel })
  const silent = silentMinutes(error)
  if (countSilentTurn(agent) === 1) {
    const fresh = agent.transport === 'session'
    runtime.remember(agent, { type: 'instruction', content: stallNote(silent, interrupted, fresh) })
    runtime.recordLedger(agent, 'watchdog', `#${agent.turns + 1} WATCHDOG: no activity for ${silent} min, the turn was stopped and repeated`)
    runtime.trace(run, agent.id, 'watchdog', `Модель ${label} не присылала событий ${silent} мин: ход остановлен и повторяется${fresh ? ' в новой сессии' : ''}`)
    // The killed CLI may have left its session unusable, and a stuck conversation is better not resumed.
    if (fresh) { closeAgentSession(runtime, agent); agent.sessionId = null }
    return true
  }
  clearSilentTurns(agent)
  if (runtime.failoverActive(run) && await runtime.handover(run, agent, { reason: 'stalled', error, interrupted })) return true
  const why = agent.failover === 'none' ? "помощник привязан к подписке (failover 'none')" : runtime.failoverActive(run) ? 'подходящей замены среди подключённых подписок нет' : 'автозамена подписок выключена'
  throw new Error(`Модель ${label} не присылала событий ${silent} мин два хода подряд, поэтому сторож Orbit остановил агента: ${why}. Журнал действий сохранён.`, { cause: error })
}

// ---- Model routing -----------------------------------------------------------------------------------------------
// spawn_agent {kind} without a model: the model for that kind of work (../model-routing.mts). The candidates' quotas are
// refreshed like a handover's, and the provider list is waited for at most ROUTE_WAIT_MS: without it only the providers
// already known to answer count. Nothing here throws; without a usable candidate the spec stays as it is, and the helper
// gets the model it would get without a kind.
async function routeSpawn(runtime: OrbitRuntimeLike, run: RunRecord, parent: AgentRecord, spec: ToolArgs): Promise<{ spec: ToolArgs; routed: RoutedSpawn }> {
  const kind = String(spec.kind)
  // The table names providers; each one's accounts (the run's extra subscriptions of it) are refreshed with it.
  const bases = [...new Set(candidates(kind).map(candidate => candidate.providerId))].filter(id => !spec.providerId || baseOf(spec.providerId) === id)
  if (!bases.length) return { spec, routed: { kind, model: null, note: `The routing table has no ${kind} candidate on ${spec.providerId}; the helper got the model it gets without a kind.` } }
  const accounts = [...new Set([parent.providerId, run.providerId, ...run.providerPool.map(member => member.providerId), ...instanceIds(run)])]
  const ids = [...new Set([...bases, ...accounts.filter(id => baseOf(id) !== id && bases.includes(baseOf(id)))])].filter(id => !spec.providerId || matchesProvider(spec.providerId, id))
  const timers: NodeJS.Timeout[] = []
  const late = new Promise<null>(resolve => { timers.push(setTimeout(resolve, routeWait(), null)) })
  const [list] = await Promise.all([
    Promise.race([runtime.providerCatalog(run), late]).catch(() => null),
    runtime.quota ? Promise.all(ids.map(id => runtime.quota!.get(id, { maxAgeMs: CATALOG_MAX_AGE_MS, waitMs: QUOTA_WAIT_MS, options: run.providerOptions[id] || {} }).catch(() => null))) : null,
  ])
  timers.forEach(clearTimeout)
  const now = runtime.clock()
  const { choice, skipped } = route({
    kind, providerId: spec.providerId, catalog: list?.length ? list : null,
    known: new Set([...accounts, parent.providerId, run.providerId]),
    pool: run.providerPool, runProviderId: run.providerId, quota: runtime.quota, threshold: run.failover.switchAtPercent, now,
    skip: new Set([...run.brokenProviders].filter(([, until]) => until > now).map(([id]) => id)),
    ...(spec.avoidProviders?.length ? { avoid: new Set(spec.avoidProviders) } : {}),
  })
  const passed = skipped.length ? { skipped } : {}
  if (!choice) {
    // The caller named the subscription and none of its models can take the work: say so, and that failover may move the helper.
    const named = spec.providerId ? ` All ${kind} models of ${spec.providerId} are unusable now (${skipped.join('; ')}); the helper starts on ${spec.providerId} with its default model${isPinned(spec, parent.providerId) ? ' and does not change subscription' : ' and Orbit may move it to another subscription (wait_agent then shows failedOver; pass failover "none" to forbid it)'}.` : ''
    return { spec, routed: { kind, model: null, ...passed, note: `No model of the routing table can take this work now; the helper got the model it gets without a kind.${named}` } }
  }
  // The level the audit measured for this model goes along as `routed.reasoningEffort`; createAgent ranks it under the
  // caller's and the user's pool level and above the parent's and the provider settings' (agents.decideEffort).
  return { spec: { ...spec, providerId: choice.providerId, model: choice.model }, routed: { kind, model: `${choice.providerId}/${choice.model}`, ...passed, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) } }
}

export { failoverActive, providerCatalog, settleCatalog, preflightQuota, handover, recoverProvider, routeSpawn }
