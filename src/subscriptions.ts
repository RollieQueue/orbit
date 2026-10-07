import type { BaseProvider, ProviderOption, Settings, SubscriptionInstance } from './types'
import { providers, type ProviderInfo } from './providers'

// More than one account of the same provider (two Claude accounts, two Codex accounts), as the window sees it.
// An instance is { id: 'claude-2', base: 'claude', label: 'Рабочий', dir: '<account folder>' } kept in `settings.subscriptions`;
// the window sends it to the desktop only inside `providerOptions` (instanceOptions), and every provider id of Orbit
// ("claude-2") then runs, is inspected and reports its quota as an instance of its base.
//
// The id rules mirror electron/instances.mts (the desktop's side of the same contract); tests/subscription-instances.test.cjs
// loads both and fails when they disagree. Pure functions only, and imports of ./relative modules only: the tests transform
// the src files one by one.

export type { SubscriptionInstance } from './types'

export const BASE_PROVIDERS: readonly BaseProvider[] = ['claude', 'codex', 'antigravity', 'cursor']
// The variable that points a provider's CLI at its own account folder; null: the CLI has none, so the provider is single-account.
export const ACCOUNT_ENV: Readonly<Record<BaseProvider, string | null>> = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', antigravity: null, cursor: null })
export const BASE_NAMES: Readonly<Record<BaseProvider, string>> = Object.freeze({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor' })
// What the add form says about a provider whose CLI cannot keep a second account (checked against the real CLIs).
export const SINGLE_ACCOUNT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  cursor: 'один аккаунт: CURSOR_CONFIG_DIR переносит только cli-config.json, а токен входа читается из фиксированного пути (%APPDATA%\\Cursor\\auth.json, ~/.cursor/auth.json)',
  antigravity: 'один аккаунт: вход хранится в системном хранилище учётных данных (Windows Credential Manager, «gemini:antigravity»), переменной или флага для другой папки нет',
})
export const SINGLE_ACCOUNT_REASON = 'один аккаунт: у CLI нет отдельной папки конфигурации'

export const MAX_INSTANCES = 20
export const MAX_LABEL = 40
const INSTANCE_ID = /^(claude|codex|antigravity|cursor)-([a-z0-9][a-z0-9-]{0,23})$/

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

// "claude-2" -> "claude"; any other id (a base provider, ollama, custom, an unknown one) is returned as it is.
export const baseOf = (id: string): string => INSTANCE_ID.exec(String(id))?.[1] ?? String(id)
export const isInstanceId = (id: string): boolean => INSTANCE_ID.test(String(id))
export const isBaseProvider = (id: string): id is BaseProvider => (BASE_PROVIDERS as readonly string[]).includes(id)
export const supportsAccounts = (base: string): boolean => isBaseProvider(base) && ACCOUNT_ENV[base] !== null

// The first free id of a base provider: claude-2, claude-3, ... `taken` is every id in use (instances and providers).
export function nextInstanceId(base: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
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
export function instanceOptions(instances: readonly SubscriptionInstance[] | undefined, options: Record<string, ProviderOption> | undefined): Record<string, ProviderOption> {
  const merged: Record<string, ProviderOption> = { ...(options || {}) }
  for (const { id, base, label, dir } of instances || []) merged[id] = { ...(options?.[base] || {}), ...(options?.[id] || {}), base, label, accountDir: dir }
  return merged
}

// ---- Lists ----

export const instanceName = (instance: Pick<SubscriptionInstance, 'base' | 'label'>) => `${BASE_NAMES[instance.base]} · ${instance.label}`
export const instanceInfo = (instance: SubscriptionInstance): ProviderInfo => ({
  id: instance.id, base: instance.base, name: instanceName(instance), description: 'Дополнительная подписка · отдельная квота',
  help: `Это отдельный аккаунт ${BASE_NAMES[instance.base]} со своей квотой. Войдите именно в этот аккаунт: кнопка «Войти» открывает окно входа CLI, `
    + 'Orbit не видит ваш пароль и токены. После входа нажмите «Проверить».',
})

// The static providers with each instance placed right after its base provider ("claude", "claude-2", "codex", ...).
export function providerList(subscriptions: readonly SubscriptionInstance[] | undefined): ProviderInfo[] {
  const instances = sanitizeInstances(subscriptions)
  if (!instances.length) return providers
  return providers.flatMap(provider => [provider, ...instances.filter(item => item.base === provider.id).map(instanceInfo)])
}
export const subscriptionsOf = (settings: Pick<Settings, 'subscriptions'>): SubscriptionInstance[] => settings.subscriptions || []
export const instanceOf = (settings: Pick<Settings, 'subscriptions'>, id: string): SubscriptionInstance | undefined => settings.subscriptions?.find(item => item.id === id)
// An id of a subscription this settings object does not have: a deleted one still prints as its id.
export const isKnownProvider = (settings: Pick<Settings, 'subscriptions'>, id: string): boolean => providerList(settings.subscriptions).some(item => item.id === id)

// The providers the add form offers: which can have a second account, and why the others cannot.
export const accountChoices = (): { id: BaseProvider; name: string; enabled: boolean; reason?: string }[] =>
  BASE_PROVIDERS.map(id => supportsAccounts(id) ? { id, name: BASE_NAMES[id], enabled: true } : { id, name: BASE_NAMES[id], enabled: false, reason: SINGLE_ACCOUNT_REASONS[id] || SINGLE_ACCOUNT_REASON })

// ---- Transitions ----

// The id the next added instance of `base` gets (claude-2, claude-3, ...), over the existing instances and every provider id.
export const nextSubscriptionId = (settings: Pick<Settings, 'subscriptions'>, base: string): string =>
  nextInstanceId(base, [...providers.map(p => p.id), ...subscriptionsOf(settings).map(item => item.id)])

export type NewSubscription = { base: string; label: string; dir: string; id?: string }
// What is wrong with a new subscription's name or provider, '' when nothing.
export function subscriptionProblem(settings: Pick<Settings, 'subscriptions'>, input: { base: string; label: string }): string {
  if (!isBaseProvider(input.base) || !supportsAccounts(input.base)) return SINGLE_ACCOUNT_REASON
  const label = input.label.trim()
  if (!label) return 'Укажите название подписки'
  if (label.length > MAX_LABEL) return `Название длиннее ${MAX_LABEL} символов`
  if (subscriptionsOf(settings).some(item => item.base === input.base && item.label.toLowerCase() === label.toLowerCase())) return 'Подписка с таким названием уже есть'
  if (subscriptionsOf(settings).length >= MAX_INSTANCES) return `Не больше ${MAX_INSTANCES} дополнительных подписок`
  return ''
}

// The settings with the instance added (it appears after its base in every list). Throws the reason when it cannot be.
export function addSubscription<S extends Settings>(settings: S, input: NewSubscription): S {
  const problem = subscriptionProblem(settings, input)
  if (problem) throw new Error(problem)
  const dir = input.dir.trim()
  if (!dir) throw new Error('У подписки нет папки аккаунта')
  const wanted = input.id && isInstanceId(input.id) && baseOf(input.id) === input.base && !providerList(settings.subscriptions).some(p => p.id === input.id) ? input.id : ''
  const id = wanted || nextSubscriptionId(settings, input.base)
  const instance: SubscriptionInstance = { id, base: input.base as BaseProvider, label: input.label.trim(), dir }
  return { ...settings, subscriptions: [...subscriptionsOf(settings), instance] }
}

// The settings without the instance, and everything that pointed at it: its pool members, model and options; the active
// provider falls back to Codex when it was this one.
export function removeSubscription<S extends Settings>(settings: S, id: string): S {
  if (!settings.subscriptions?.some(item => item.id === id)) return settings
  const { [id]: _model, ...models } = settings.models || {}
  const { [id]: _options, ...providerOptions } = settings.providerOptions || {}
  return {
    ...settings, subscriptions: settings.subscriptions.filter(item => item.id !== id), models, providerOptions,
    providerPool: (settings.providerPool || []).filter(member => member.providerId !== id), providerId: settings.providerId === id ? 'codex' : settings.providerId,
  }
}

// The members of a pool that name an instance Orbit no longer has are dropped (an old id, a deleted subscription).
export const withoutDeadMembers = <M extends { providerId: string }>(pool: readonly M[] | undefined, subscriptions: readonly SubscriptionInstance[]): M[] =>
  (pool || []).filter(member => !isInstanceId(member.providerId) || subscriptions.some(item => item.id === member.providerId))

// ---- Account folders ----

// Whether the question "delete the folder too?" is worth asking: Orbit makes account folders as <data folder>/accounts/<id>. This
// is only a hint for the window; the desktop decides again (a managed folder, the owner's confirmation) before it deletes anything.
export const looksManaged = (instance: Pick<SubscriptionInstance, 'id' | 'dir'>): boolean => {
  const parts = instance.dir.split('\\').join('/').split('/').filter(Boolean)
  return parts.length >= 2 && parts[parts.length - 1] === instance.id && parts[parts.length - 2].toLowerCase() === 'accounts'
}
export const OWN_FOLDER_NOTE = 'Удалить также папку аккаунта (там хранится вход)'
// What the desktop answered to the removal of an account (AccountRemoveResult), as the sentence the owner reads.
export function removeNote(result: { deleted: boolean; reason?: string; error?: string }, instance: Pick<SubscriptionInstance, 'label' | 'dir'>): string {
  const head = `Подписка «${instance.label}» убрана из Orbit`
  if (result.deleted) return `${head}, папка аккаунта удалена.`
  if (result.reason === 'declined') return `${head}. Удаление папки отменено в окне подтверждения, папка осталась: ${instance.dir}`
  if (result.reason === 'unmanaged') return `${head}. Папку создал не Orbit, поэтому она осталась на диске: ${instance.dir}`
  if (result.reason === 'missing') return `${head}. Папки аккаунта уже не было.`
  if (result.reason === 'failed') return `${head}, но папку удалить не удалось${result.error ? `: ${result.error}` : ''}`
  return `${head}. Папка аккаунта осталась: ${instance.dir}`
}
// The settings fields a removal changes, as one patch (the window's onSettings merges a patch into the current settings).
export const removalPatch = (settings: Settings, id: string): Partial<Settings> => {
  const next = removeSubscription(settings, id)
  return { subscriptions: next.subscriptions, models: next.models, providerOptions: next.providerOptions, providerPool: next.providerPool, providerId: next.providerId }
}

// The CLI the sign-in window runs: the one the owner chose for the account or its provider, else the path Orbit found for the provider
// (the window is a new process with Orbit's own PATH, which may lack the CLI's folder). A path with a character a console would read as
// syntax (electron/accounts.mts checkCommand) is left out: the bare command is tried instead.
export function loginCommand(settings: Pick<Settings, 'providerOptions'>, instance: Pick<SubscriptionInstance, 'id' | 'base'>, health: readonly { id: string; executable?: string }[] | undefined): string | undefined {
  const chosen = settings.providerOptions?.[instance.id]?.command || settings.providerOptions?.[instance.base]?.command
  if (chosen) return chosen
  const found = health?.find(item => item.id === instance.base)?.executable
  return found && !/["\r\n\0&|<>^%!()`;$]/.test(found) ? found : undefined
}

// The line the owner reads while a new subscription waits for the sign-in.
export const LOGIN_STEPS = 'Войдите в открывшемся окне, затем нажмите «Проверить».'
// What the instance's card says about its sign-in, from the health entry (undefined: not checked yet).
export function loginStatus(health: { available: boolean; detail?: string; authenticated?: boolean } | undefined): { ok: boolean; text: string } {
  if (!health) return { ok: false, text: 'Не проверено: нажмите «Проверить»' }
  if (health.available && health.authenticated !== false) return { ok: true, text: 'Вход выполнен' }
  return { ok: false, text: health.detail ? `Войдите в аккаунт. ${health.detail}` : 'Войдите в аккаунт в окне входа и нажмите «Проверить»' }
}
