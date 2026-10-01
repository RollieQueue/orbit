import REASONING from './reasoning-defaults.json' with { type: 'json' }

// The reasoning levels of a model and the nearest one to a request. Pure; failover, model routing and spawn_agent share it.
// A level is only ever sent where the target offers it: asking for more than a model has gives its top level, never an error.

// Weakest to strongest. 'enabled' (a thinking switch, Ollama) is not a step of this ladder: it ranks like 'medium' for
// the nearest-level search and is kept only where the model lists it.
const LEVEL_ORDER: readonly string[] = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const RANK: Readonly<Record<string, number>> = Object.freeze({ ...Object.fromEntries(LEVEL_ORDER.map((level, index): [string, number] => [level, index])), enabled: LEVEL_ORDER.indexOf('medium') })
const defaults: Record<string, string[] | undefined> = REASONING

// One provider of the health list, as far as levels are read from it.
interface LevelCatalogEntry { id: string; reasoningLevels?: Record<string, string[] | undefined> }
interface ClampedEffort { level: string; clamped: boolean }

// The levels `model` offers on `providerId`: its own list in the provider catalog, else the provider's default list
// (reasoning-defaults.json). Antigravity has its reasoning built into the model names and offers none; a model whose list
// is empty has none either.
function offeredLevels(providerId: string, model: string | null | undefined, entry?: LevelCatalogEntry | null): string[] {
  if (providerId === 'antigravity') return []
  return entry?.reasoningLevels?.[String(model || '')] || defaults[providerId] || []
}
// The level to send for `wanted`: itself when offered, else the nearest offered one below, else the nearest above. Nothing
// is offered (or nothing was asked): ''. `clamped` says that a level was asked for and another (or none) is sent.
function clampEffort(wanted: string | null | undefined, offered: readonly string[]): ClampedEffort {
  if (!wanted) return { level: '', clamped: false }
  if (offered.includes(wanted)) return { level: wanted, clamped: false }
  const rank = RANK[wanted]
  const ranked = offered.filter(level => RANK[level] !== undefined).sort((a, b) => RANK[a] - RANK[b])
  const nearest = rank === undefined ? undefined : ranked.filter(level => RANK[level] <= rank).at(-1) ?? ranked.find(level => RANK[level] > rank)
  return { level: nearest || '', clamped: true }
}
// "up to xhigh" / "none": the top of what a model offers, for the sentence that explains a clamp.
function topLevel(offered: readonly string[]): string {
  return offered.filter(level => level !== 'enabled' && RANK[level] !== undefined).sort((a, b) => RANK[b] - RANK[a])[0] || offered[0] || ''
}
// One line for the root's prompt: the levels each connected provider (of `only`, when given) offers, models with the same list grouped. With the
// provider health list it is exact per model; without it the defaults of reasoning-defaults.json stand in.
function levelsLine(catalog: readonly (LevelCatalogEntry & { available?: boolean; models?: string[] })[] | null | undefined, only?: ReadonlySet<string>): string {
  const ids = (catalog?.length ? catalog.filter(entry => entry.available !== false).map(entry => entry.id) : Object.keys(defaults)).filter(id => !only || only.has(id))
  const parts: string[] = []
  for (const id of ids) {
    const entry = catalog?.find(item => item.id === id)
    const groups = new Map<string, string[]>()
    for (const model of entry?.models?.length && id !== 'antigravity' ? entry.models.slice(0, 24) : ['']) {
      const key = offeredLevels(id, model, entry).join('/') || 'none'
      groups.set(key, [...(groups.get(key) || []), model])
    }
    if (groups.size === 1) { parts.push(`${id}: ${[...groups.keys()][0]}`); continue }
    const names = (models: string[]): string => models.length > 3 ? `${models.slice(0, 3).join(', ')} +${models.length - 3}` : models.join(', ')
    parts.push(`${id}: ${[...groups].map(([levels, models]) => `${names(models)} ${levels}`).join('; ')}`)
  }
  return parts.join(' · ')
}

export type { LevelCatalogEntry, ClampedEffort }
export { LEVEL_ORDER, RANK, offeredLevels, clampEffort, topLevel, levelsLine }
