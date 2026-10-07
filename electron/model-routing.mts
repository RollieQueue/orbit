import { assess } from './quota.mts'
import { effortFor, poolAllows, UNMEASURED_USED } from './failover.mts'
import { baseOf, isInstanceId, matchesProvider } from './instances.mts'
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
  // The caller named the subscription: only its candidates count. A base id (claude) means any account of it, an extra
  // subscription's id (claude-2) exactly that one.
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
  // Providers the caller ruled out (spawn_agent avoidProviders): a base id rules out all its accounts, an instance id only itself.
  avoid?: Set<string>
}
interface RouteChoice { providerId: string; model: string; reasoningEffort: string }
// `skipped`: the better candidates passed over, as "codex/gpt-6-astra: quota 95% used".
interface Route { choice: RouteChoice | null; skipped: string[] }

const table: RoutingTable = TABLE
const ROUTING_KINDS: readonly string[] = Object.freeze(Object.keys(table.kinds))
const candidates = (kind: string): RouteCandidate[] => table.kinds[kind]?.candidates || []

// Why a candidate cannot take the work now, or null. `providerId` is the account's own id (claude-2 for the table's claude).
// The pool rule is spawn_agent's own: the run's provider (and the other accounts of it) is always allowed, another one only as the
// pool lists it (an entry for the base provider admits its extra accounts too).
function unusable(providerId: string, model: string, input: RouteInput): string | null {
  if (!poolAllows(input.pool, providerId, model, input.runProviderId)) return 'not in the provider pool'
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

// The accounts of a table provider: itself and every extra subscription of it that the list, the run or the pool knows.
function accountsOf(base: string, input: RouteInput): string[] {
  const named = [...(input.catalog || []).map(entry => entry.id), ...input.known, input.runProviderId, ...input.pool.map(member => member.providerId), ...(input.providerId ? [input.providerId] : [])]
  return [base, ...new Set(named.filter(id => isInstanceId(id) && baseOf(id) === base))]
}

function route(input: RouteInput): Route {
  const skipped: string[] = []
  const narrowed = (id: string): boolean => !input.providerId || matchesProvider(input.providerId, id)
  for (const candidate of candidates(input.kind)) {
    // The table names the provider; each of its accounts is a candidate, the one with the most quota left first (the default
    // account on a tie), so a second subscription takes the work before the next provider of the table.
    const usable: { id: string; used: number }[] = []
    for (const id of accountsOf(candidate.providerId, input).filter(narrowed)) {
      const why = [...(input.avoid || [])].some(reference => matchesProvider(reference, id)) ? 'ruled out by avoidProviders' : unusable(id, candidate.model, input)
      if (why) { skipped.push(`${id}/${candidate.model}: ${why}`); continue }
      usable.push({ id, used: assess(input.quota?.peek(id), { model: candidate.model, threshold: input.threshold, now: input.now }).usedPercent ?? UNMEASURED_USED })
    }
    const [first] = usable.sort((a, b) => a.used - b.used || Number(isInstanceId(a.id)) - Number(isInstanceId(b.id)) || a.id.localeCompare(b.id))
    if (!first) continue
    const entry = input.catalog?.find(item => item.id === first.id)
    // The measured level where the target offers it (Antigravity takes none).
    return { choice: { providerId: first.id, model: candidate.model, reasoningEffort: effortFor(first.id, candidate.model, candidate.reasoningEffort, entry, undefined) }, skipped }
  }
  return { choice: null, skipped }
}

export type { RouteCandidate, RouteInput, RouteChoice, Route }
export { ROUTING_KINDS, candidates, route }
