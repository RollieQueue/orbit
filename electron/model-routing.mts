import { assess } from './quota.mts'
import { effortFor } from './failover.mts'
import type { CatalogEntry, PoolMember, QuotaPeeker } from './failover.mts'
import TABLE from './model-routing.json' with { type: 'json' }

// The model a helper gets for a kind of work (spawn_agent `kind` without a model): the candidates of model-routing.json
// in order, the first one that is connected, allowed by the user's provider pool and not near its quota limit.
// Pure; runtime/handover.mts gathers the provider list and the quota readings and applies the choice.

interface RouteCandidate { providerId: string; model: string; reasoningEffort?: string }
// Shape of model-routing.json: per kind of work, the candidates best first.
interface RoutingTable { kinds: Record<string, { candidates: RouteCandidate[] } | undefined> }
interface RouteInput {
  kind: string
  // The caller named the subscription: only its candidates count.
  providerId?: string
  // The provider health list (`inspectProviders`); null when it could not be read in time, and then only `known` counts.
  catalog: CatalogEntry[] | null
  // Providers known to answer without the list: the parent's, the run's and the pool's.
  known: Set<string>
  pool: PoolMember[]
  runProviderId: string
  // Only cached readings are consulted here; the runtime refreshes them before asking.
  quota?: QuotaPeeker | null
  threshold: number
  now: number
  // Providers that could not answer at all a moment ago (region, sign-in, missing CLI).
  skip: Set<string>
  // Providers the caller ruled out (spawn_agent avoidProviders).
  avoid?: Set<string>
}
interface RouteChoice { providerId: string; model: string; reasoningEffort: string }
// `skipped`: the better candidates passed over, as "codex/gpt-6-astra: quota 95% used".
interface Route { choice: RouteChoice | null; skipped: string[] }

const table: RoutingTable = TABLE
const ROUTING_KINDS: readonly string[] = Object.freeze(Object.keys(table.kinds))
const candidates = (kind: string): RouteCandidate[] => table.kinds[kind]?.candidates || []

// Why a candidate cannot take the work now, or null. The pool rule is spawn_agent's own: the run's provider is always
// allowed, another one only as the pool lists it.
function unusable({ providerId, model }: RouteCandidate, input: RouteInput): string | null {
  if (input.pool.length && providerId !== input.runProviderId && !input.pool.some(member => member.providerId === providerId && (!member.model || member.model === model))) return 'not in the provider pool'
  if (input.skip.has(providerId)) return 'could not answer a moment ago'
  if (input.catalog) {
    const entry = input.catalog.find(item => item.id === providerId)
    if (!entry || entry.available === false) return 'not connected'
    if (entry.models?.length && !entry.models.includes(model)) return 'not in its model list'
  } else if (!input.known.has(providerId)) return 'the provider list could not be read'
  const level = assess(input.quota?.peek(providerId), { model, threshold: input.threshold, now: input.now })
  if (level.exhausted) return 'quota used up'
  if (level.near) return `quota ${level.usedPercent}% used`
  return null
}

function route(input: RouteInput): Route {
  const skipped: string[] = []
  for (const candidate of candidates(input.kind)) {
    if (input.providerId && candidate.providerId !== input.providerId) continue
    const why = input.avoid?.has(candidate.providerId) ? 'ruled out by avoidProviders' : unusable(candidate, input)
    if (why) { skipped.push(`${candidate.providerId}/${candidate.model}: ${why}`); continue }
    const entry = input.catalog?.find(item => item.id === candidate.providerId)
    // The measured level where the target offers it (Antigravity takes none).
    return { choice: { providerId: candidate.providerId, model: candidate.model, reasoningEffort: effortFor(candidate.providerId, candidate.model, candidate.reasoningEffort, entry, undefined) }, skipped }
  }
  return { choice: null, skipped }
}

export type { RouteCandidate, RouteInput, RouteChoice, Route }
export { ROUTING_KINDS, candidates, route }
