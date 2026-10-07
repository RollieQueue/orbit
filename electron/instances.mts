// Subscription instances: more than one account of the same provider (two Claude accounts, two ChatGPT/Codex accounts).
//
// An instance is { id, base, label, dir }: `id` is what every other part of Orbit calls a provider id ("claude-2"),
// `base` the provider whose adapter runs it ("claude"), `label` the owner's name for it and `dir` the account's own
// configuration directory, which the CLI is pointed at through its environment (CLAUDE_CONFIG_DIR, CODEX_HOME).
// The default account of each provider keeps today's id ("claude"), has no instance entry and no environment change, so a
// single-account setup behaves exactly as before. Credentials stay in the CLI's own directory: Orbit never reads them.
//
// How the instances travel: the window keeps them in `settings.subscriptions` and sends them inside `providerOptions`
// (the map every IPC call, run start, quota read and provider inspection already takes), as extra fields of the entry
// named by the instance id: `providerOptions['claude-2'] = { base: 'claude', label, accountDir, ...the base's CLI options }`.
// So any function that has the options of a provider can run, inspect and read the quota of an instance without a registry.
//
// Pure functions only; src/subscriptions.ts mirrors the id rules for the window (tests/subscription-instances.test.cjs checks both agree).

export const BASE_PROVIDERS = ['claude', 'codex', 'antigravity', 'cursor'] as const
export type BaseProvider = (typeof BASE_PROVIDERS)[number]

// The variable that points a provider's CLI at its own account directory; null: the CLI has none, so the provider is
// single-account and the window says so instead of pretending (verified against the real CLIs, docs/providers.md "Several accounts").
export const ACCOUNT_ENV: Readonly<Record<BaseProvider, string | null>> = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', antigravity: null, cursor: null })
export const BASE_NAMES: Readonly<Record<BaseProvider, string>> = Object.freeze({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor' })

export interface SubscriptionInstance { id: string; base: BaseProvider; label: string; dir: string }
// The fields of a `providerOptions` entry that make it an instance (and nothing else: the entry also carries the CLI options).
export interface InstanceOptions { base?: unknown; label?: unknown; accountDir?: unknown; [extra: string]: unknown }

const MAX_INSTANCES = 20
const MAX_LABEL = 40
// "claude-2", "codex-work": a base provider id, a hyphen and a short lowercase suffix. The base never contains a hyphen,
// so the base of an id is readable from the id alone (no registry needed in the runtime's many id comparisons).
const INSTANCE_ID = /^(claude|codex|antigravity|cursor)-([a-z0-9][a-z0-9-]{0,23})$/

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

// "claude-2" -> "claude"; any other id (a base provider, ollama, custom, an unknown one) is returned as it is.
export const baseOf = (id: string): string => INSTANCE_ID.exec(String(id))?.[1] ?? String(id)
export const isInstanceId = (id: string): boolean => INSTANCE_ID.test(String(id))
export const isBaseProvider = (id: string): id is BaseProvider => (BASE_PROVIDERS as readonly string[]).includes(id)
// Two ids run the same provider's adapter (the same vendor, possibly another account).
export const sameBase = (a: string, b: string): boolean => baseOf(a) === baseOf(b)
// Whether a reference a caller wrote (spawn_agent providerId / avoidProviders) names this provider: exactly, or as the
// provider as a whole when it is a base id ("claude" also covers "claude-2"; "claude-2" covers only itself).
export const matchesProvider = (reference: string, id: string): boolean => reference === id || (!isInstanceId(reference) && baseOf(id) === reference)
export const supportsAccounts = (base: string): boolean => isBaseProvider(base) && ACCOUNT_ENV[base] !== null

// The first free id of a base provider: claude-2, claude-3, ... `taken` is every id in use (instances and providers).
export function nextInstanceId(base: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

// The account directory a providerOptions entry names, '' when none.
export const accountDir = (options: InstanceOptions | null | undefined): string => text(options?.accountDir)

// The environment that points an instance's CLI at its own account. {} for a default provider (the CLI uses its usual
// account). An instance without a directory or whose provider has no such variable THROWS: running it with the default
// account's credentials would spend (and mislabel) another subscription's quota, which is exactly what must never happen.
export function accountEnv(id: string, options?: InstanceOptions | null): Record<string, string> {
  if (!isInstanceId(id)) return {}
  const base = baseOf(id)
  const variable = isBaseProvider(base) ? ACCOUNT_ENV[base] : null
  if (!variable) throw new Error(`${base} has no setting for a second account: only one ${BASE_NAMES[base as BaseProvider] ?? base} subscription can be used`)
  const dir = accountDir(options)
  if (!dir) throw new Error(`Subscription ${id} has no account folder: add it again in Settings → Subscriptions`)
  return { [variable]: dir }
}

// The owner's name for a provider in prompts and lists: "Claude Code" or "Claude Code · Work".
export function providerLabel(id: string, options?: InstanceOptions | null): string {
  const base = baseOf(id)
  const name = isBaseProvider(base) ? BASE_NAMES[base] : id
  return isInstanceId(id) ? `${name} · ${text(options?.label) || id}` : name
}

// A saved list of instances made valid: well-formed ids of a known base, a name (the id when none) and a folder; no repeats.
export function sanitizeInstances(raw: unknown): SubscriptionInstance[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>(), found: SubscriptionInstance[] = []
  for (const item of raw) {
    const entry = record(item), id = text(entry.id), base = baseOf(id), dir = text(entry.dir)
    if (!isInstanceId(id) || !isBaseProvider(base) || !dir || seen.has(id) || (text(entry.base) && text(entry.base) !== base)) continue
    seen.add(id)
    found.push({ id, base, label: (text(entry.label) || id).slice(0, MAX_LABEL), dir })
    if (found.length >= MAX_INSTANCES) break
  }
  return found
}

// `providerOptions` with every instance's entry added: the CLI options of its base provider as the default (the same
// binary, proxy and reasoning level), the instance's own saved options over them, and the identity fields last.
export function instanceOptions<T extends InstanceOptions>(instances: readonly SubscriptionInstance[], options: Record<string, T> | null | undefined): Record<string, T | (T & InstanceOptions)> {
  const merged: Record<string, T | (T & InstanceOptions)> = { ...(options || {}) }
  for (const { id, base, label, dir } of instances) merged[id] = { ...(options?.[base] || {}), ...(options?.[id] || {}), base, label, accountDir: dir } as T & InstanceOptions
  return merged
}

// The instances `providerOptions` carries, read back (what the runtime knows without a registry).
export function instancesFromOptions(options: Record<string, InstanceOptions | undefined> | null | undefined): SubscriptionInstance[] {
  return sanitizeInstances(Object.entries(options || {}).filter(([id]) => isInstanceId(id)).map(([id, entry]) => ({ id, base: entry?.base, label: entry?.label, dir: entry?.accountDir })))
}

// A list of provider ids with every instance placed right after its base provider ("claude", "claude-2", "codex", ...).
export function withInstances(ids: readonly string[], options: Record<string, InstanceOptions | undefined> | null | undefined): string[] {
  const extra = instancesFromOptions(options).map(item => item.id).filter(id => !ids.includes(id))
  return ids.flatMap(id => [id, ...extra.filter(item => baseOf(item) === id)]).concat(extra.filter(item => !ids.includes(baseOf(item))))
}
