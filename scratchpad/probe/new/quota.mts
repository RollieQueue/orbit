import os from 'node:os'
import { spawn } from 'node:child_process'
import { proxyEnvironment } from './provider-network.mts'
// providers.mts imports this file for its parsers and this file spawns CLIs through providers' helpers: an ESM cycle,
// harmless because both sides touch the other only inside functions. The thunk keeps the call sites as they were.
import * as providersModule from './providers.mts'
// Subscription quotas, read from what each CLI itself reports. Orbit never reads or copies OAuth tokens and never
// calls a vendor's private HTTP API: Codex answers a protocol request, Claude Code and Antigravity answer their own
// `/usage` command locally (no model call, no quota spent), Cursor's CLI only names the plan.
//
// Snapshot: { providerId, state, windows, plan, credits, blocked, detail, source, fetchedAt, checkedAt, exhaustedUntil? }
// Window: { kind: 'session' | 'week' | 'other', usedPercent, resetsAt (ms or null), scope, models }
// `models` lists lowercase name fragments the window is limited to; an empty list means every model of the account.
// What a parser or reader produces: the account figures without Orbit's bookkeeping.
// The part of a snapshot the assessment looks at (tests and the failover pass bare objects of this shape).
// A reading as the monitor caches it, stamped with when it was read and last confirmed.
// What `peek` returns: the cached reading (or a bare refusal mark) with the derived state.
// The sparse figures a running turn reports (Claude's rate_limit_event, Codex's account/rateLimits/updated).
// A provider's saved options as the readers use them: the CLI command and, for Antigravity, the proxy settings.
// An error a transport has already recognised as a quota refusal (the stream said so); the classifier trusts it.
// Codex `account/rateLimits/read` result and the `account/rateLimits/updated` notification (one bucket of it).
// Claude Code's `rate_limit_event.rate_limit_info`.
// Antigravity's `/usage` JSON: model groups with 5-hour and weekly buckets.
// One line of the App Server's stdout as a JSON-RPC message.
const PROVIDER_IDS = ['codex', 'claude', 'antigravity', 'cursor', 'ollama', 'custom']
const SESSION_MINUTES = 300
const WEEK_MINUTES = 10080
const MINUTE = 60000
const DEFAULT_TTL_MS = MINUTE
const FAILURE_TTL_MS = 20000
// How long a provider that refused a request stays out of rotation when the message names no reset time.
const FALLBACK_COOLDOWN_MS = 30 * MINUTE
const WARNING_PERCENT = 80
const providers = () => providersModule
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const percent = (value) => Math.max(0, Math.min(100, Math.round(Number(value))))
const kindOf = (minutes) => minutes === SESSION_MINUTES ? 'session' : minutes === WEEK_MINUTES ? 'week' : 'other'
const first = (value) => String(value ?? '').split(/\r?\n/)[0].trim()
// Callers that stop waiting early clear these timers (see `timers`); one left running must not be silently dropped.
const delay = (ms , timers) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timers?.push(timer) })
// ---------------------------------------------------------------------------------------------------------------
// Time zones: Claude prints reset times as wall-clock text plus an IANA zone, e.g. "Sep 29, 5pm (Europe/Moscow)".
function zoneParts(timeMs , timeZone) {
 const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(timeMs))
 const get = (type) => Number(parts.find(part => part.type === type) .value)
 return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}
function zoneOffset(timeMs , timeZone) {
 const p = zoneParts(timeMs, timeZone)
 return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(timeMs / 1000) * 1000
}
// Wall-clock fields in `timeZone` to a UTC timestamp; a missing or unknown zone means this machine's local time.
function zonedEpoch({ year, month, day, hour, minute } , timeZone) {
 const local = () => new Date(year, month, day, hour, minute).getTime()
 if (!timeZone) return local()
 try {
 const wall = Date.UTC(year, month, day, hour, minute)
 let guess = wall - zoneOffset(wall, timeZone)
 guess = wall - zoneOffset(guess, timeZone)
 return guess
 } catch { return local() }
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET_TEXT = /^(?:(?<month>[A-Za-z]{3,9})\.?\s+(?<day>\d{1,2})(?:,?\s*(?<year>\d{4}))?,?\s+(?:at\s+)?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?(?:\s*\((?<zone>[^)]+)\))?/i
// The named groups of RESET_TEXT; every group but `hour` is optional.
// "Sep 29, 5pm (Europe/Moscow)", "5:30 PM", "Oct 5, 1pm". A bare number is not a time: it needs am/pm or minutes.
function parseResetText(text , now = Date.now()) {
 const match = String(text || '').trim().match(RESET_TEXT)
 if (!match) return null
 const { month, day, year, hour, minute, meridiem, zone } = match.groups
 if (!meridiem && minute === undefined) return null
 let h = Number(hour)
 if (meridiem) { if (h < 1 || h > 12) return null; h = h % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0) }
 else if (h > 23) return null
 const timeZone = zone?.trim() || undefined
 let today
 try { today = zoneParts(now, timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone) } catch { today = zoneParts(now, 'UTC') }
 const fields = { year: today.year, month: today.month, day: today.day, hour: h, minute: Number(minute || 0) }
 if (month) {
 const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase())
 if (index < 0) return null
 Object.assign(fields, { month: index, day: Number(day), ...(year ? { year: Number(year) } : {}) })
 let epoch = zonedEpoch(fields, timeZone)
 // A date without a year that has already gone by more than a day ago is next year's.
 if (!year && epoch < now - 24 * 3600000) epoch = zonedEpoch({ ...fields, year: fields.year + 1 }, timeZone)
 return epoch
 }
 let epoch = zonedEpoch(fields, timeZone)
 if (epoch < now) epoch = zonedEpoch({ ...fields, day: fields.day + 1 }, timeZone)
 return epoch
}
const DURATION_UNITS = { d: 86400000, h: 3600000, m: 60000, s: 1000 }
function parseDuration(text) {
 let total = 0, found = false
 // "3 hours 22 minutes" and "3h22m0s" alike: a unit ends where a letter does not follow.
 for (const match of String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?![a-z])/gi)) {
 found = true
 total += Number(match[1]) * DURATION_UNITS[match[2][0].toLowerCase()]
 }
 return found ? total : null
}
// ---------------------------------------------------------------------------------------------------------------
// Parsers. Each turns one vendor format into { windows, plan, blocked, detail, source }.
function codexBucketWindows(bucket , now) {
 if (!bucket) return []
 const scoped = !!bucket.limitId && bucket.limitId !== 'codex'
 const models = scoped ? [...new Set([bucket.normalModelSlug, bucket.limitName, bucket.limitId].filter(Boolean).map(value => String(value).toLowerCase()))] : []
 return ([['primary', 'session'], ['secondary', 'week']]).flatMap(([slot, fallback]) => {
 const window = bucket[slot]
 if (!window || !Number.isFinite(Number(window.usedPercent))) return []
 const minutes = Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null
 const kind = minutes === null ? fallback : kindOf(minutes)
 return [{ kind, usedPercent: percent(window.usedPercent), resetsAt: window.resetsAt ? Number(window.resetsAt) * 1000 : null, scope: scoped ? String(bucket.limitName || bucket.limitId) : 'all', models, minutes }]
 })
}
// Response of `account/rateLimits/read`.
function parseCodexLimits(result , now = Date.now()) {
 const keyed = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? Object.values(result.rateLimitsByLimitId) : []
 const buckets = keyed.length ? keyed : [result?.rateLimits].filter((bucket) => Boolean(bucket))
 const main = buckets.find(bucket => bucket.limitId === 'codex') || buckets[0] || {}
 const credits = main.credits ? { hasCredits: !!main.credits.hasCredits, unlimited: !!main.credits.unlimited, balance: main.credits.balance ?? null } : null
 return {
 windows: buckets.flatMap(bucket => codexBucketWindows(bucket, now)),
 plan: main.planType && main.planType !== 'unknown' ? String(main.planType) : null,
 credits,
 blocked: result?.ordinaryUsageAllowed === false || buckets.some(bucket => !!bucket.rateLimitReachedType),
 reachedType: buckets.map(bucket => bucket.rateLimitReachedType).find(Boolean) || null,
 detail: '', source: 'codex',
 }
}
// The sparse `account/rateLimits/updated` notification carries only the windows that changed.
const codexUpdateLimit = (rateLimits , now = Date.now()) => ({ windows: codexBucketWindows(rateLimits, now), blocked: !!rateLimits?.rateLimitReachedType, source: 'codex-live' })
const CLAUDE_LINE = /^\s*Current (session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•|-]\s*resets?\s+(.+?))?\s*$/i
function claudeScope(label) {
 const name = String(label || '').trim().replace(/\s+only$/i, '')
 return !name || /^all models?$/i.test(name) ? { scope: 'all', models: [] } : { scope: name, models: [name.toLowerCase()] }
}
// Text of `claude -p "/usage"`. A plan without subscription limits (API key) prints prose instead, which yields no windows.
function parseClaudeUsage(text , now = Date.now()) {
 const windows = []
 for (const line of String(text || '').split(/\r?\n/)) {
 const match = line.match(CLAUDE_LINE)
 if (!match) continue
 const [, kind, label, used, reset] = match
 windows.push({ kind: kind.toLowerCase() === 'session' ? 'session' : 'week', usedPercent: percent(used), resetsAt: parseResetText(reset, now), minutes: kind.toLowerCase() === 'session' ? SESSION_MINUTES : WEEK_MINUTES, ...claudeScope(label) })
 }
 return { windows, plan: null, detail: windows.length ? '' : first(text) || 'Claude Code не вернул данные о лимитах', source: 'claude' }
}
const CLAUDE_TYPES = {
 five_hour: { kind: 'session', scope: 'all', models: [], minutes: SESSION_MINUTES },
 seven_day: { kind: 'week', scope: 'all', models: [], minutes: WEEK_MINUTES },
 seven_day_opus: { kind: 'week', scope: 'Opus', models: ['opus'], minutes: WEEK_MINUTES },
 seven_day_sonnet: { kind: 'week', scope: 'Sonnet', models: ['sonnet'], minutes: WEEK_MINUTES },
}
// `rate_limit_event.rate_limit_info` from the stream. Its utilization is the API header value: a fraction of the window.
function claudeStreamLimit(info , now = Date.now()) {
 if (!info || typeof info !== 'object') return { windows: [], blocked: false, source: 'claude-live' }
 const windows = []
 const add = (type , utilization , resetsAt) => {
 const shape = CLAUDE_TYPES[type]
 if (!shape || !Number.isFinite(Number(utilization))) return
 windows.push({ ...shape, usedPercent: percent(Number(utilization) * 100), resetsAt: Number.isFinite(Number(resetsAt)) ? Number(resetsAt) * 1000 : null })
 }
 for (const [type, window] of Object.entries(info.unifiedWindows || {})) add(type, window?.utilization, window?.resetsAt)
 if (!windows.length && info.rateLimitType) add(info.rateLimitType, info.utilization, info.resetsAt)
 return { windows, blocked: info.status === 'rejected', resetsAt: Number.isFinite(Number(info.resetsAt)) ? Number(info.resetsAt) * 1000 : null, source: 'claude-live' }
}
// "Models within this group: Gemini Flash, Gemini Pro" -> ['gemini']: the first word of each named model.
function groupTokens(group) {
 const named = String(group?.description || '').split(':').slice(1).join(':')
 const words = (named ? named.split(',') : String(group?.name || '').replace(/\bmodels?\b/gi, '').split(/\band\b|,/i)).map(item => item.trim().split(/\s+/)[0]?.toLowerCase()).filter((word) => Boolean(word))
 return [...new Set(words)]
}
const AGY_TEXT_LINE = /^(.+?)\t(.+?)\t(\d+(?:\.\d+)?)%\t(\S+)\s*$/
// Output of `agy -p "/usage" --output-format json` (or its text form: group, bucket, remaining %, reset time).
function parseAntigravityUsage(payload , now = Date.now()) {
 const windows = []
 const body = isRecord(payload) ? (payload) : null
 const groups = body?.command?.data?.groups
 if (Array.isArray(groups)) {
 for (const group of groups) for (const bucket of group.buckets || []) {
 if (!Number.isFinite(Number(bucket.remaining_fraction))) continue
 const kind = bucket.window === '5h' ? 'session' : bucket.window === 'weekly' ? 'week' : 'other'
 windows.push({ kind, usedPercent: percent(100 - Number(bucket.remaining_fraction) * 100), resetsAt: Date.parse(String(bucket.reset_time)) || null, scope: String(group.name || 'all'), models: groupTokens(group), minutes: kind === 'session' ? SESSION_MINUTES : kind === 'week' ? WEEK_MINUTES : null })
 }
 } else {
 for (const line of String(body?.response ?? payload ?? '').split(/\r?\n/)) {
 const match = line.match(AGY_TEXT_LINE)
 if (!match) continue
 const [, group, name, remaining, reset] = match
 const kind = /five|5/i.test(name) ? 'session' : /week/i.test(name) ? 'week' : 'other'
 windows.push({ kind, usedPercent: percent(100 - Number(remaining)), resetsAt: Date.parse(reset) || null, scope: group, models: groupTokens({ name: group }), minutes: kind === 'session' ? SESSION_MINUTES : kind === 'week' ? WEEK_MINUTES : null })
 }
 }
 return { windows, plan: null, detail: windows.length ? '' : 'Antigravity не вернул данные о квоте', source: 'antigravity' }
}
// `agent about` names the plan but publishes no usage numbers.
function parseCursorAbout(text) {
 const tier = String(text || '').match(/Subscription Tier\s+(.+)/i)?.[1]?.trim() || null
 return { windows: [], plan: tier, state: 'unknown', detail: `Cursor CLI не сообщает остаток лимитов${tier ? ` (тариф ${tier})` : ''}. Отказ по лимиту Orbit заметит сам и переключит агента.`, source: 'cursor' }
}
// ---------------------------------------------------------------------------------------------------------------
// Readers. Each takes the provider's saved options ({ command, proxy... }) and resolves to a parser result.
async function cliText(command , args , { env, timeoutMs = 30000, signal } = {}) {
 const lines = []
 // A neutral working directory: Windows locks the directory of a running child, and /usage needs no project.
 await providers().runCli(command, args, { cwd: os.tmpdir(), env, timeoutMs, signal, onLine: line => { lines.push(line) } })
 return lines.join('\n')
}
const commandOf = (id , options , env) => options?.command || process.env[env] || id
async function codexRpc (command , method , { signal, timeoutMs = 20000 } = {}) {
 const { resolveLaunch, terminateProcess, createLineReader } = providers()
 const launch = resolveLaunch(command, ['app-server'])
 const child = spawn(launch.executable, launch.args, { cwd: os.tmpdir(), env: launch.env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
 const pending = new Map ()
 let sequence = 0, closed = false, stderr = ''
 const settleAll = (error) => { closed = true; for (const item of pending.values()) item.reject(error); pending.clear() }
 const send = (message) => { if (!closed && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`) }
 const request = (name , params) => new Promise ((resolve, reject) => {
 if (closed) return reject(new Error('Codex connection closed'))
 const id = ++sequence
 pending.set(id, { resolve, reject })
 send({ id, method: name, params })
 })
 const reader = createLineReader(line => {
 if (!line.trim()) return
 let message
 try { message = JSON.parse(line) } catch { return }
 if (!isRecord(message)) return
 const { id, method, result, error } = message
 if (method && id !== undefined) { send({ id, error: { code: -32601, message: 'Not supported by this client' } }); return }
 const item = !method && id !== undefined && pending.get(id)
 if (!item) return
 pending.delete(id)
 if (error) item.reject(new Error(error.message || JSON.stringify(error)))
 else item.resolve(result)
 })
 const timers = []
 const abort = () => settleAll(new Error('Codex request cancelled'))
 child.on('error', settleAll)
 child.stdin.on('error', settleAll)
 child.stdout.on('data', chunk => reader.write(chunk))
 child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
 child.on('close', () => settleAll(new Error(stderr.trim() || 'Codex App Server closed before answering')))
 signal?.addEventListener('abort', abort, { once: true })
 try {
 const work = (async () => {
 await request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '0.3.1' } })
 send({ method: 'initialized', params: {} })
 return request (method)
 })()
 work.catch(() => {}) // Once the timeout has won, a late failure of the request is of no interest.
 return await Promise.race([work, delay(timeoutMs, timers).then(() => { throw new Error('Codex App Server did not answer in time') })])
 } finally {
 timers.forEach(clearTimeout)
 signal?.removeEventListener('abort', abort)
 closed = true
 await terminateProcess(child)
 }
}
async function readCodex(options = {}) {
 const command = commandOf('codex', options, 'ORBIT_CODEX_COMMAND')
 return parseCodexLimits(await codexRpc (command, 'account/rateLimits/read', { signal: options.signal, timeoutMs: options.timeoutMs }))
}
async function readClaude(options = {}) {
 const command = commandOf('claude', options, 'ORBIT_CLAUDE_COMMAND')
 const [usage, auth] = await Promise.allSettled([
 cliText(command, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], { signal: options.signal }),
 cliText(command, ['auth', 'status'], { timeoutMs: 15000, signal: options.signal }),
 ])
 if (usage.status === 'rejected') throw usage.reason
 let text = usage.value
 try { text = JSON.parse(usage.value).result ?? usage.value } catch { /* Plain text output is parsed as it is. */ }
 const parsed = parseClaudeUsage(text)
 // The auth probe returns account identifiers; only the plan name is kept.
 try { parsed.plan = JSON.parse((auth).value).subscriptionType || null } catch { /* The plan is optional. */ }
 return parsed
}
async function readAntigravity(options = {}) {
 const command = commandOf('agy', options, 'ORBIT_ANTIGRAVITY_COMMAND')
 const env = await proxyEnvironment(options)
 const text = await cliText(command, ['-p', '/usage', '--output-format', 'json'], { env, signal: options.signal })
 let payload = text
 try { payload = JSON.parse(text) } catch { /* Text output is parsed line by line. */ }
 return parseAntigravityUsage(payload)
}
async function readCursor(options = {}) {
 const command = commandOf('agent', options, 'ORBIT_CURSOR_COMMAND')
 return parseCursorAbout(await cliText(command, ['about'], { timeoutMs: 15000, signal: options.signal }))
}
// Patched in place by the desktop smoke, so the table stays a plain object.
const readers = {
 codex: readCodex, claude: readClaude, antigravity: readAntigravity, cursor: readCursor,
 ollama: async () => ({ windows: [], state: 'unlimited', detail: 'Локальная модель: лимитов подписки нет', source: 'local' }),
 custom: async () => ({ windows: [], state: 'unknown', detail: 'Лимиты OpenAI-совместимого адреса зависят от сервера и не публикуются', source: 'custom' }),
}
const UNAVAILABLE_HINTS = {
 codex: 'Лимиты Codex доступны при входе через ChatGPT (codex login); ключ API тарифицируется по использованию.',
 claude: 'Лимиты Claude Code доступны при входе подпиской (claude auth login).',
 antigravity: 'Не удалось получить квоту Antigravity: проверьте вход (agy) и прокси Google CLI.',
 cursor: 'Не удалось запустить Cursor CLI (agent).',
}
// What a reader threw: an Error, usually with a `code` when the CLI itself was not found.
const thrown = (error) => isRecord(error) ? error : {}
function unavailable(id , error) {
 const missing = thrown(error).code === 'ENOENT'
 const hint = missing ? 'CLI не найден. Установите его и выполните вход, см. «Настройки → Провайдеры».' : UNAVAILABLE_HINTS[id] || ''
 return { windows: [], state: 'unavailable', detail: [hint, missing ? '' : first(thrown(error).message).slice(0, 200)].filter(Boolean).join(' '), source: id }
}
// ---------------------------------------------------------------------------------------------------------------
// Assessment: how close is this account to a refusal, for this model?
function applicable(snapshot , model) {
 const windows = snapshot?.windows || []
 const name = String(model || '').toLowerCase()
 // Without a known model only account-wide windows count, unless every window is model-specific (Antigravity groups).
 if (!name) { const general = windows.filter(window => !window.models?.length); return general.length ? general : windows }
 return windows.filter(window => !window.models?.length || window.models.some(token => name.includes(token)))
}
function assess(snapshot , { model = '', threshold = 90, now = Date.now() } = {}) {
 const empty = { usedPercent: null, window: null, exhausted: false, near: false, resetsAt: null }
 if (!snapshot) return empty
 // A window whose reset time has passed has rolled over: what was measured there no longer counts.
 const measured = applicable(snapshot, model || '').map(window => ({ window, used: window.resetsAt && window.resetsAt <= now ? 0 : window.usedPercent }))
 const binding = measured.reduce ((best, item) => !best || item.used > best.used ? item : best, null)
 const marked = snapshot.exhaustedUntil && snapshot.exhaustedUntil > now
 const blocked = (snapshot.blocked && (!binding || binding.used > 0)) || marked
 const used = binding ? binding.used : null
 return {
 usedPercent: marked || blocked ? Math.max(used ?? 0, 100) : used,
 window: binding?.window || null,
 exhausted: !!blocked || (used ?? 0) >= 100,
 near: (used ?? 0) >= threshold,
 resetsAt: (marked ? snapshot.exhaustedUntil : null) || binding?.window.resetsAt || null,
 }
}
function stateOf(snapshot , now = Date.now()) {
 if (snapshot.state && ['unlimited', 'unavailable'].includes(snapshot.state)) return snapshot.state
 if (!snapshot.windows?.length) return snapshot.exhaustedUntil != null && snapshot.exhaustedUntil > now ? 'exhausted' : 'unknown'
 const level = assess(snapshot, { threshold: WARNING_PERCENT, now })
 const worst = snapshot.windows.reduce((max, window) => Math.max(max, window.resetsAt && window.resetsAt <= now ? 0 : window.usedPercent), 0)
 if (level.exhausted || worst >= 100) return 'exhausted'
 return worst >= WARNING_PERCENT ? 'warning' : 'ok'
}
// ---------------------------------------------------------------------------------------------------------------
// Refusals: which provider errors mean "this subscription is out of quota"?
const QUOTA_PATTERNS = [
 /usage limit/i, /hit your (?:usage |rate |session |weekly)?limit/i, /limit (?:reached|exceeded)/i,
 /(?:5-hour|five[- ]hour|weekly|daily|monthly|session) limit/i, /rate[ _-]?limit/i, /quota/i, /resource[_ ]exhausted/i,
 /exhausted your capacity/i, /too many requests/i, /\b429\b/, /insufficient[_ ]?(?:quota|credits?)/i,
 /credits? (?:are |have been)?(?:depleted|exhausted)/i, /out of (?:credits|usage)/i, /spend (?:limit|cap)/i,
]
const CONTEXT_LIMIT = /context (?:length|window)|maximum context|prompt is too long|too many tokens/i
const STRONG_QUOTA = /usage limit|quota|rate[ _-]?limit|too many requests/i
// Best effort: when the limit lifts, as named in the vendor's own message.
function resetFromMessage(message , now = Date.now()) {
 const text = String(message || '')
 const epoch = text.match(/\|(\d{10})\b/)
 if (epoch) return Number(epoch[1]) * 1000
 const relative = text.match(/(?:reset|refresh)s?\s+(?:in|after)\s+([^.\n]+)/i) || text.match(/(?:try again|retry)\s+(?:in|after)\s+([^.\n]+)/i)
 const wait = relative && parseDuration(relative[1])
 if (wait) return now + wait
 const clock = text.match(/(?:resets?|try again)\s+(?:at\s+)?((?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+(?:at\s+)?)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([^)]+\))?)/i)
 return clock ? parseResetText(clock[1], now) : null
}
// Returns null for anything that is not a quota refusal (cancellations, timeouts, ordinary failures).
function classifyQuotaError(error , providerId = '', now = Date.now()) {
 if (!error) return null
 // Whatever was thrown: an Error (possibly tagged by a transport), or a bare string.
 const failure = error
 const message = String(failure.message ?? error)
 if (failure.quota) return { providerId: failure.quota.providerId || providerId, resetsAt: failure.quota.resetsAt ?? resetFromMessage(message, now), message: message.slice(0, 500) }
 if (failure.name === 'AbortError' || failure.name === 'TimeoutError') return null
 if (CONTEXT_LIMIT.test(message) && !STRONG_QUOTA.test(message)) return null
 if (!QUOTA_PATTERNS.some(pattern => pattern.test(message))) return null
 return { providerId, resetsAt: resetFromMessage(message, now), message: message.slice(0, 500) }
}
// ---------------------------------------------------------------------------------------------------------------
function mergeWindows(current , incoming) {
 const key = (window) => `${window.kind}|${window.scope}`
 const merged = new Map(current.map(window => [key(window), window]))
 for (const window of incoming) merged.set(key(window), { ...merged.get(key(window)), ...window })
 return [...merged.values()]
}
// A cached reading being refined by live figures; only `checkedAt` is missing until the merge stamps it.
class QuotaMonitor {
 constructor({ clock = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
 Object.assign(this, { clock, ttlMs })
 this.cache = new Map(); this.inflight = new Map(); this.marks = new Map(); this.listeners = new Set()
 }
 onUpdate(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
 notify(id) {
 const snapshot = this.peek(id)
 for (const listener of this.listeners) { try { listener({ providerId: id, snapshot }) } catch { /* A closed window cannot stop a run. */ } }
 }
 // The newest known snapshot, or null; an active refusal mark is folded in.
 peek(id) {
 const cached = this.cache.get(id)
 const mark = this.marks.get(id)
 const now = this.clock()
 if (mark && mark.until <= now) this.marks.delete(id)
 const live = this.marks.get(id)
 if (!cached && !live) return null
 const snapshot = { providerId: id, windows: [], plan: null, detail: '', source: id, fetchedAt: null, checkedAt: null, ...cached, ...(live ? { exhaustedUntil: live.until, exhaustedReason: live.reason } : {}) }
 return { ...snapshot, state: stateOf(snapshot, now) }
 }
 // Cached data no older than maxAgeMs; otherwise one shared refresh. waitMs bounds how long a caller waits for it.
 async get(id , { maxAgeMs = this.ttlMs, waitMs = null, options = {}, force = false } = {}) {
 const cached = this.cache.get(id)
 if (cached && !force && this.clock() - cached.checkedAt < maxAgeMs) return this.peek(id)
 let pending = this.inflight.get(id)
 if (!pending) {
 pending = this.refresh(id, options).finally(() => this.inflight.delete(id))
 this.inflight.set(id, pending)
 }
 if (waitMs === null) await pending
 else {
 const timers = []
 await Promise.race([pending, delay(waitMs, timers)])
 timers.forEach(clearTimeout)
 }
 return this.peek(id)
 }
 async all(ids = PROVIDER_IDS, opts = {}) {
 const options = opts.options || {}
 const entries = await Promise.all(ids.map(async (id) => [id, await this.get(id, { ...opts, options: options[id] || {} })]))
 return Object.fromEntries(entries.filter((entry) => Boolean(entry[1])))
 }
 async refresh(id , options = {}) {
 const reader = readers[id]
 const now = this.clock()
 const previous = this.cache.get(id)
 let snapshot
 try {
 if (!reader) throw new Error(`Unknown provider ${id}`)
 snapshot = { providerId: id, ...(await reader(options)), fetchedAt: this.clock(), checkedAt: this.clock() }
 // A fallback cooldown ends as soon as the account is measurably below its limits again.
 const mark = this.marks.get(id)
 if (mark && !mark.known && snapshot.windows?.length && snapshot.windows.every(window => window.usedPercent < 100)) this.marks.delete(id)
 } catch (error) {
 // Data that could not be refreshed stays visible, flagged as old, instead of vanishing on a network hiccup.
 snapshot = previous?.windows?.length
 ? { ...previous, checkedAt: now, stale: true, detail: `Не удалось обновить: ${first(thrown(error).message).slice(0, 160)}` }
 : { providerId: id, ...unavailable(id, error), fetchedAt: now, checkedAt: now - (this.ttlMs - FAILURE_TTL_MS) }
 }
 this.cache.set(id, snapshot)
 this.notify(id)
 return snapshot
 }
 // Live figures from a running provider (Claude stream, Codex notifications) refine the last reading without a new probe.
 ingest(id , partial) {
 if (!partial || (!partial.windows?.length && !partial.blocked)) return
 const now = this.clock()
 const seed = this.cache.get(id) || { providerId: id, windows: [], plan: null, detail: '', source: partial.source || id, fetchedAt: now }
 const { state, ...current } = seed
 // Figures arriving from a live turn contradict an earlier "unavailable"/"unknown" verdict, so the state is derived again.
 // A refusal is carried by the time-limited mark below; the cached `blocked` flag only follows what was actually read.
 const blocked = partial.blocked ? current.blocked : partial.windows?.length ? false : current.blocked
 this.cache.set(id, { ...current, ...(state === 'unlimited' ? { state } : {}), windows: mergeWindows(current.windows, partial.windows || []), blocked, stale: false, fetchedAt: now, checkedAt: now })
 if (partial.blocked) this.markExhausted(id, { resetsAt: partial.resetsAt, reason: 'provider reported the limit as reached' })
 else this.notify(id)
 }
 // A provider that just refused a request stays out of rotation until its limit lifts.
 markExhausted(id , { resetsAt = null, reason = '' } = {}) {
 const now = this.clock()
 const known = resetsAt !== null && Number.isFinite(resetsAt) && resetsAt > now
 this.marks.set(id, { until: known ? resetsAt : now + FALLBACK_COOLDOWN_MS, known, reason: String(reason).slice(0, 300) })
 this.notify(id)
 }
}
export { QuotaMonitor, readers, PROVIDER_IDS, WARNING_PERCENT, assess, stateOf, classifyQuotaError, resetFromMessage, parseResetText, zonedEpoch, parseCodexLimits, codexUpdateLimit, parseClaudeUsage, claudeStreamLimit, parseAntigravityUsage, parseCursorAbout }
