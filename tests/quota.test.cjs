const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { QuotaMonitor, assess, classifyQuotaError, parseResetText, parseCodexLimits, parseClaudeUsage, parseAntigravityUsage, parseCursorAbout, claudeStreamLimit, codexUpdateLimit } = quota
const { createClaudeParser } = require('../electron/providers.mts')._testing

// Shapes below were captured from the real CLIs on 2026-09-29 (account identifiers removed).
const CODEX_RESULT = {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: 1790687385 }, secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1791166194 }, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus', rateLimitReachedType: null },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: 1790687385 }, secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1791166194 }, credits: { hasCredits: false, unlimited: false, balance: '0' }, planType: 'plus', rateLimitReachedType: null } },
}
const CLAUDE_USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 8% used · resets Sep 29, 5pm (Europe/Moscow)
Current week (all models): 2% used · resets Oct 5, 1pm (Europe/Moscow)
Current week (Fable): 0% used · resets Oct 5, 1pm (Europe/Moscow)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.`
const AGY_USAGE = { status: 'SUCCESS', response: '', command: { name: 'usage', data: { groups: [
  { name: 'Gemini Models', description: 'Models within this group: Gemini Flash, Gemini Pro', buckets: [
    { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9934998750686646, reset_time: '2026-10-05T18:59:21Z' },
    { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.9714571237564087, reset_time: '2026-09-29T13:10:54Z' }] },
  { name: 'Claude and GPT models', description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', buckets: [
    { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-06T11:23:03Z' },
    { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-09-29T16:23:03Z' }] }] } } }
const SAMPLE_NOW = Date.UTC(2026, 8, 29, 8, 0)

test('Codex rate limits become a 5-hour and a weekly window with plan and credits', () => {
  const parsed = parseCodexLimits(CODEX_RESULT)
  assert.deepEqual(parsed.windows.map(w => [w.kind, w.usedPercent, w.resetsAt, w.scope, w.models]), [['session', 97, 1790687385000, 'all', []], ['week', 46, 1791166194000, 'all', []]])
  assert.equal(parsed.plan, 'plus')
  assert.deepEqual(parsed.credits, { hasCredits: false, unlimited: false, balance: '0' })
  assert.equal(parsed.blocked, false)
  assert.equal(parseCodexLimits({ ...CODEX_RESULT, ordinaryUsageAllowed: false }).blocked, true)
  assert.equal(parseCodexLimits({ rateLimits: { ...CODEX_RESULT.rateLimits, rateLimitReachedType: 'rate_limit_reached' } }).blocked, true, 'a reached-limit type blocks even without the multi-bucket view')
})

test('Codex buckets other than the main one are limited to their own model', () => {
  const parsed = parseCodexLimits({ rateLimits: {}, rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300 } },
    codex_spark: { limitId: 'codex_spark', limitName: 'Spark', normalModelSlug: 'gpt-6-spark', primary: { usedPercent: 99, windowDurationMins: 300 } },
  } })
  assert.deepEqual(parsed.windows.map(w => [w.scope, w.models]), [['all', []], ['Spark', ['gpt-6-spark', 'spark', 'codex_spark']]])
  const snapshot = { windows: parsed.windows }
  assert.equal(assess(snapshot, { model: 'gpt-6-astra' }).usedPercent, 10, 'the spark bucket does not count for other models')
  assert.equal(assess(snapshot, { model: 'gpt-6-spark' }).usedPercent, 99)
})

test('a sparse Codex update carries only the windows it names', () => {
  const update = codexUpdateLimit({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1790687385 }, secondary: null })
  assert.deepEqual(update.windows.map(w => [w.kind, w.usedPercent]), [['session', 99]])
  assert.equal(update.blocked, false)
  assert.equal(codexUpdateLimit({ rateLimitReachedType: 'workspace_member_usage_limit_reached' }).blocked, true)
})

test('Claude /usage text yields session and weekly windows with real reset instants', () => {
  const parsed = parseClaudeUsage(CLAUDE_USAGE, SAMPLE_NOW)
  assert.deepEqual(parsed.windows.map(w => [w.kind, w.scope, w.usedPercent, w.models]), [['session', 'all', 8, []], ['week', 'all', 2, []], ['week', 'Fable', 0, ['fable']]])
  assert.equal(parsed.windows[0].resetsAt, Date.UTC(2026, 8, 29, 14, 0), '5pm in Moscow is 14:00 UTC')
  assert.equal(parsed.windows[1].resetsAt, Date.UTC(2026, 9, 5, 10, 0))
  assert.equal(parsed.detail, '')
})

test('Claude /usage without subscription limits reports why instead of inventing numbers', () => {
  const parsed = parseClaudeUsage('You are currently using API billing.\nUsage limits do not apply.', SAMPLE_NOW)
  assert.deepEqual(parsed.windows, [])
  assert.equal(parsed.detail, 'You are currently using API billing.')
})

test('reset times cover dates, bare clock times, minutes, year rollover and daylight saving', () => {
  assert.equal(parseResetText('5:30pm (Europe/Moscow)', SAMPLE_NOW), Date.UTC(2026, 8, 29, 14, 30))
  assert.equal(parseResetText('9am (Europe/Moscow)', SAMPLE_NOW), Date.UTC(2026, 8, 30, 6, 0), 'a clock time already gone by means tomorrow')
  assert.equal(parseResetText('Jan 2, 3am (UTC)', Date.UTC(2026, 11, 30)), Date.UTC(2027, 0, 2, 3, 0))
  assert.equal(parseResetText('Mar 15, 12pm (Europe/Berlin)', Date.UTC(2026, 2, 1)), Date.UTC(2026, 2, 15, 11, 0), 'CET is UTC+1')
  assert.equal(parseResetText('Mar 30, 12pm (Europe/Berlin)', Date.UTC(2026, 2, 1)), Date.UTC(2026, 2, 30, 10, 0), 'CEST is UTC+2')
  assert.equal(parseResetText('12am (UTC)', Date.UTC(2026, 0, 1, 1)), Date.UTC(2026, 0, 2, 0, 0))
  assert.equal(parseResetText('12pm (UTC)', Date.UTC(2026, 0, 1, 1)), Date.UTC(2026, 0, 1, 12, 0))
  assert.equal(parseResetText('5', SAMPLE_NOW), null, 'a bare number is not a time')
  assert.equal(parseResetText('tomorrow', SAMPLE_NOW), null)
  assert.equal(parseResetText('Xyz 3, 5pm (UTC)', SAMPLE_NOW), null)
  assert.ok(Number.isFinite(parseResetText('5pm (Not/AZone)', SAMPLE_NOW)), 'an unknown zone falls back to local time')
})

test('Antigravity /usage gives per-group windows tied to their models', () => {
  const parsed = parseAntigravityUsage(AGY_USAGE)
  assert.equal(parsed.windows.length, 4)
  const gemini5h = parsed.windows.find(w => w.scope === 'Gemini Models' && w.kind === 'session')
  assert.equal(gemini5h.usedPercent, 3)
  assert.equal(gemini5h.resetsAt, Date.parse('2026-09-29T13:10:54Z'))
  assert.deepEqual(gemini5h.models, ['gemini'])
  assert.deepEqual(parsed.windows.find(w => w.scope === 'Claude and GPT models').models, ['claude', 'gpt-oss'])
  const snapshot = { windows: parsed.windows }
  assert.equal(assess(snapshot, { model: 'gemini-3.1-pro-high', now: SAMPLE_NOW }).usedPercent, 3)
  assert.equal(assess(snapshot, { model: 'claude-opus-4-6-thinking', now: SAMPLE_NOW }).usedPercent, 0)
})

test('Antigravity /usage text form is understood too', () => {
  const text = 'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-05T18:59:21Z\nGemini Models\tFive Hour Limit Remaining\t40%\t2026-09-29T13:10:54Z\n'
  const parsed = parseAntigravityUsage({ response: text })
  assert.deepEqual(parsed.windows.map(w => [w.kind, w.usedPercent]), [['week', 1], ['session', 60]])
  assert.equal(parseAntigravityUsage('nothing useful').windows.length, 0)
})

test('Cursor names the plan but publishes no limits', () => {
  const parsed = parseCursorAbout('About Cursor CLI\n\nCLI Version         2026.09.26\nSubscription Tier   Free\nOS                  win32 (x64)\n')
  assert.equal(parsed.plan, 'Free')
  assert.equal(parsed.state, 'unknown')
  assert.deepEqual(parsed.windows, [])
  assert.match(parsed.detail, /Free/)
})

test('Claude stream limits are fractions of the window; a rejected status blocks', () => {
  const warned = claudeStreamLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.92, resetsAt: 1790000000 })
  assert.deepEqual(warned.windows.map(w => [w.kind, w.usedPercent, w.resetsAt]), [['session', 92, 1790000000000]])
  assert.equal(warned.blocked, false)
  const unified = claudeStreamLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization: 0.5, resetsAt: 2 } } })
  assert.deepEqual(unified.windows.map(w => [w.kind, w.usedPercent]), [['session', 10], ['week', 50]])
  assert.equal(claudeStreamLimit({ status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 1, resetsAt: 5 }).blocked, true)
  assert.deepEqual(claudeStreamLimit({ status: 'allowed', rateLimitType: 'overage', utilization: 0.2 }).windows, [], 'window types Orbit does not model are ignored')
  assert.deepEqual(claudeStreamLimit(null).windows, [])
})

test('the Claude parser forwards limit events, keeps them out of the conversation and types a rejected refusal', () => {
  const events = [], parser = createClaudeParser(event => events.push(event))
  parser.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1790000000 } }))
  parser.line(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Something the wording does not reveal' }))
  assert.deepEqual(events.filter(e => e.kind === 'quota').map(e => e.quota.blocked), [true])
  assert.equal(events.filter(e => e.kind === 'output').length, 0)
  assert.throws(() => parser.finish(), error => error.quota?.providerId === 'claude' && error.quota.resetsAt === 1790000000000 && classifyQuotaError(error, 'claude').resetsAt === 1790000000000)
})

test('provider errors are told apart: quota refusals versus everything else', () => {
  const now = Date.UTC(2026, 8, 29, 8, 0)
  const refused = [
    "You've hit your usage limit. Upgrade to Pro or try again in 3 hours 22 minutes.",
    'Claude AI usage limit reached|1790000000',
    "You've hit your limit · resets 5pm (Europe/Moscow)",
    '429 Too Many Requests',
    'RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
    'Your quota will reset after 3h22m0s.',
    'You have exhausted your capacity on this model.',
    '{"error":{"code":"insufficient_quota"}}',
    'Weekly limit reached',
    'Compatible endpoint error: rate_limit_exceeded',
  ]
  for (const message of refused) assert.ok(classifyQuotaError(new Error(message), 'codex', now), message)
  const notRefused = [
    'context length exceeded: the maximum context is 8000 tokens',
    'Codex turn cancelled', 'spawn codex ENOENT', 'Provider turn time budget exhausted', 'Orbit tool protocol failed after 2 repair attempts',
    'The prompt is too long: the limit for this model is 200000 tokens',
  ]
  for (const message of notRefused) assert.equal(classifyQuotaError(new Error(message), 'codex', now), null, message)
  assert.equal(classifyQuotaError(Object.assign(new Error('rate limit'), { name: 'AbortError' }), 'codex', now), null, 'cancellation is never a refusal')
  assert.equal(classifyQuotaError(Object.assign(new Error('quota'), { name: 'TimeoutError' }), 'codex', now), null)
  assert.equal(classifyQuotaError(null), null)
})

test('the moment a limit lifts is taken from the vendor message when it names one', () => {
  const now = Date.UTC(2026, 8, 29, 8, 0)
  assert.equal(classifyQuotaError(new Error('try again in 3 hours 22 minutes'), 'codex', now), null, 'no quota wording, no refusal')
  const reset = message => classifyQuotaError(new Error(`usage limit. ${message}`), 'codex', now).resetsAt
  assert.equal(reset('Try again in 3 hours 22 minutes.'), now + (3 * 60 + 22) * 60000)
  assert.equal(reset('Resets after 3h22m0s'), now + (3 * 60 + 22) * 60000)
  assert.equal(reset('Retry after 45 seconds'), now + 45000)
  assert.equal(reset('Try again in 2 days'), now + 2 * 86400000)
  assert.equal(reset('Resets 5pm (Europe/Moscow)'), Date.UTC(2026, 8, 29, 14, 0))
  assert.equal(reset('Resets Oct 5, 1pm (Europe/Moscow)'), Date.UTC(2026, 9, 5, 10, 0))
  assert.equal(reset('No hint here'), null)
  assert.equal(classifyQuotaError({ message: 'x', quota: { providerId: 'codex', resetsAt: 123 } }, 'other', now).resetsAt, 123, 'a typed refusal wins over wording')
  assert.equal(classifyQuotaError({ message: 'anything', quota: { providerId: 'codex' } }, 'other', now).providerId, 'codex')
})

test('assessment respects model scope, rolled-over windows, blocks and refusal marks', () => {
  const now = Date.UTC(2026, 8, 29, 12, 0)
  const snapshot = { windows: [
    { kind: 'session', scope: 'all', models: [], usedPercent: 50, resetsAt: now + 1000 },
    { kind: 'week', scope: 'all', models: [], usedPercent: 10, resetsAt: now + 1000 },
    { kind: 'week', scope: 'Fable', models: ['fable'], usedPercent: 95, resetsAt: now + 1000 },
  ] }
  assert.equal(assess(snapshot, { model: 'claude-fable-5-1', now }).usedPercent, 95)
  assert.equal(assess(snapshot, { model: 'claude-fable-5-1', now, threshold: 90 }).near, true)
  assert.equal(assess(snapshot, { model: 'opus', now }).usedPercent, 50)
  assert.equal(assess(snapshot, { model: '', now }).usedPercent, 50, 'an unknown model is judged by account-wide windows only')
  assert.equal(assess({ windows: [{ kind: 'session', scope: 'G', models: ['gemini'], usedPercent: 70, resetsAt: null }] }, { model: '', now }).usedPercent, 70, 'when every window is model-specific, all of them count')
  assert.equal(assess({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: 99, resetsAt: now - 1 }] }, { now }).usedPercent, 0, 'a window that has reset counts as empty')
  assert.equal(assess({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: 100, resetsAt: now + 5 }] }, { now }).exhausted, true)
  assert.equal(assess({ windows: [], blocked: true }, { now }).exhausted, true)
  assert.equal(assess({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: 3, resetsAt: now - 1 }], blocked: true }, { now }).exhausted, false, 'a block whose window has reset no longer holds')
  const marked = assess({ windows: [], exhaustedUntil: now + 60000 }, { now })
  assert.deepEqual([marked.exhausted, marked.usedPercent, marked.resetsAt], [true, 100, now + 60000])
  assert.deepEqual(assess(null), { usedPercent: null, window: null, exhausted: false, near: false, resetsAt: null })
})

function patchReaders(t, replacements) {
  const original = { ...quota.readers }
  Object.assign(quota.readers, replacements)
  t.after(() => Object.assign(quota.readers, original))
}
const window = (used, extra = {}) => ({ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null, ...extra })

test('the monitor caches, shares one refresh among concurrent callers and refreshes when asked', async t => {
  let now = 1000, calls = 0
  patchReaders(t, { codex: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { windows: [window(40)], plan: 'plus' } } })
  const monitor = new QuotaMonitor({ clock: () => now })
  const [a, b] = await Promise.all([monitor.get('codex'), monitor.get('codex')])
  assert.equal(calls, 1)
  assert.equal(a.state, 'ok'); assert.equal(b.plan, 'plus')
  now += 30000; await monitor.get('codex'); assert.equal(calls, 1, 'still fresh')
  now += 40000; await monitor.get('codex'); assert.equal(calls, 2, 'past the time to live')
  await monitor.get('codex', { force: true }); assert.equal(calls, 3)
  await monitor.get('codex', { maxAgeMs: 1e9 }); assert.equal(calls, 3, 'a caller may accept older data')
})

test('states follow the fullest window: ok, warning, exhausted; local and unavailable providers say so', async t => {
  patchReaders(t, {
    codex: async () => ({ windows: [window(30), window(85, { kind: 'week' })] }),
    claude: async () => ({ windows: [window(100)] }),
    ollama: async () => ({ windows: [], state: 'unlimited', detail: 'local' }),
    antigravity: async () => { throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) },
    cursor: async () => ({ windows: [], state: 'unknown', plan: 'Free', detail: 'no numbers' }),
  })
  const all = await new QuotaMonitor().all(['codex', 'claude', 'ollama', 'antigravity', 'cursor', 'nothing'])
  assert.deepEqual(Object.fromEntries(Object.entries(all).map(([id, s]) => [id, s.state])), { codex: 'warning', claude: 'exhausted', ollama: 'unlimited', antigravity: 'unavailable', cursor: 'unknown', nothing: 'unavailable' })
  assert.match(all.antigravity.detail, /не найден/)
  assert.match(all.nothing.detail, /Unknown provider/)
})

test('a failed refresh is retried soon, and keeps the last good figures marked as old', async t => {
  let now = 1000, calls = 0, fail = false
  patchReaders(t, { codex: async () => { calls++; if (fail) throw new Error('network down'); return { windows: [window(55)] } } })
  const monitor = new QuotaMonitor({ clock: () => now })
  fail = true
  const failed = await monitor.get('codex')
  assert.equal(failed.state, 'unavailable'); assert.match(failed.detail, /network down/)
  await monitor.get('codex'); assert.equal(calls, 1, 'not hammered right after a failure')
  now += 25000; fail = false
  assert.equal((await monitor.get('codex')).state, 'ok'); assert.equal(calls, 2, 'retried after the short failure lifetime')
  now += 61000; fail = true
  const stale = await monitor.get('codex')
  assert.equal(stale.stale, true); assert.equal(stale.windows[0].usedPercent, 55); assert.match(stale.detail, /network down/)
  assert.equal(stale.state, 'ok', 'old figures are still shown')
})

test('waiting for a slow reader is bounded and the stale answer is returned', async t => {
  let release
  patchReaders(t, { codex: () => new Promise(resolve => { release = () => resolve({ windows: [window(20)] }) }) })
  const monitor = new QuotaMonitor()
  assert.equal(await monitor.get('codex', { waitMs: 30 }), null, 'nothing known yet')
  release()
  await new Promise(r => setTimeout(r, 10))
  assert.equal(monitor.peek('codex').state, 'ok', 'the refresh still completes in the background')
})

test('live figures refine the last reading, revive an unavailable provider, and a reached limit takes it out of rotation', async t => {
  let now = 1000
  patchReaders(t, { claude: async () => { throw new Error('boom') } })
  const monitor = new QuotaMonitor({ clock: () => now })
  const seen = []
  monitor.onUpdate(update => seen.push([update.providerId, update.snapshot.state]))
  assert.equal((await monitor.get('claude')).state, 'unavailable')
  monitor.ingest('claude', { windows: [window(60, { resetsAt: 9e12 })], blocked: false })
  assert.equal(monitor.peek('claude').state, 'ok', 'live figures contradict "unavailable"')
  monitor.ingest('claude', { windows: [window(88, { resetsAt: 9e12 }), window(5, { kind: 'week' })], blocked: false })
  assert.deepEqual(monitor.peek('claude').windows.map(w => [w.kind, w.usedPercent]), [['session', 88], ['week', 5]], 'windows are merged by kind and scope')
  assert.equal(monitor.peek('claude').state, 'warning')
  monitor.ingest('claude', { windows: [], blocked: true, resetsAt: now + 5000 })
  assert.equal(monitor.peek('claude').state, 'exhausted')
  monitor.ingest('codex', { windows: [], blocked: false })
  assert.equal(monitor.peek('codex'), null, 'an empty update creates nothing')
  now += 6000
  assert.equal(monitor.peek('claude').state, 'warning', 'the mark lapses at the reset time')
  assert.ok(seen.length >= 4)
})

test('a refusal mark lasts until the announced reset, or half an hour when none is known', async t => {
  let now = 1000000
  patchReaders(t, { codex: async () => ({ windows: [window(10)] }) })
  const monitor = new QuotaMonitor({ clock: () => now })
  await monitor.get('codex')
  monitor.markExhausted('codex', { resetsAt: now + 10 * 60000, reason: 'test' })
  assert.equal(monitor.peek('codex').state, 'exhausted')
  assert.equal(monitor.peek('codex').exhaustedUntil, now + 10 * 60000)
  await monitor.get('codex', { force: true })
  assert.equal(monitor.peek('codex').state, 'exhausted', 'a known reset time is not overruled by a fresh reading')
  now += 11 * 60000
  assert.equal(monitor.peek('codex').state, 'ok')
  monitor.markExhausted('codex', { reason: 'no time named' })
  assert.equal(monitor.peek('codex').exhaustedUntil, now + 30 * 60000)
  await monitor.get('codex', { force: true })
  assert.equal(monitor.peek('codex').state, 'ok', 'a guessed cooldown ends when the account is measurably below its limits')
  monitor.markExhausted('claude', { resetsAt: 5 })
  assert.equal(monitor.peek('claude').exhaustedUntil, now + 30 * 60000, 'a reset time in the past names nothing')
})

// ---- The real readers, against fake CLIs that speak the same protocols -------------------------------------------

function fakeCli(t, name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-quota-cli-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, `${name}.cjs`), body)
  const shim = path.join(directory, `${name}.cmd`)
  fs.writeFileSync(shim, `@"%dp0%\\node.exe" "%dp0%\\${name}.cjs" %*`)
  return { shim, directory }
}
const APP_SERVER = result => `
  const readline = require('node:readline')
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', line => {
    const m = JSON.parse(line)
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n')
    else if (m.method === 'account/rateLimits/read') {
      process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n')
      process.stdout.write(JSON.stringify({ id: m.id, ${result} }) + '\\n')
    }
  })
`

test('the Codex reader speaks the app-server protocol and returns parsed windows', async t => {
  const { shim } = fakeCli(t, 'codex', APP_SERVER(`result: ${JSON.stringify(CODEX_RESULT)}`))
  const parsed = await quota.readers.codex({ command: shim })
  assert.deepEqual(parsed.windows.map(w => w.usedPercent), [97, 46])
  assert.equal(parsed.plan, 'plus')
})

test('the Codex reader surfaces a server error, and gives up on a silent server', async t => {
  const { shim } = fakeCli(t, 'codex', APP_SERVER(`error: { code: -32600, message: 'ChatGPT authentication required to read rate limits' }`))
  await assert.rejects(quota.readers.codex({ command: shim }), /authentication required/)
  const silent = fakeCli(t, 'codex', 'process.stdin.resume(); setInterval(() => {}, 1000)')
  const started = Date.now()
  await assert.rejects(quota.readers.codex({ command: silent.shim, timeoutMs: 300 }), /did not answer in time/)
  assert.ok(Date.now() - started < 5000)
})

test('through the monitor a Codex failure reads as unavailable with the sign-in hint', async t => {
  const { shim } = fakeCli(t, 'codex', APP_SERVER(`error: { code: 1, message: 'not signed in' }`))
  const snapshot = await new QuotaMonitor().get('codex', { options: { command: shim } })
  assert.equal(snapshot.state, 'unavailable')
  assert.match(snapshot.detail, /ChatGPT/)
  assert.match(snapshot.detail, /not signed in/)
})

test('the Claude reader runs /usage locally and adds only the plan name from the auth probe', async t => {
  const { shim } = fakeCli(t, 'claude', `
    const args = process.argv.slice(2)
    if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, email: 'someone@example.com', subscriptionType: 'max' }))
    else { if (!(args[0] === '-p' && args[1] === '/usage' && args.includes('--no-session-persistence'))) process.exit(3); console.log(JSON.stringify({ result: ${JSON.stringify(CLAUDE_USAGE)} })) }
  `)
  const parsed = await quota.readers.claude({ command: shim })
  assert.deepEqual(parsed.windows.map(w => w.usedPercent), [8, 2, 0])
  assert.equal(parsed.plan, 'max')
  assert.ok(!JSON.stringify(parsed).includes('someone@example.com'), 'no account identifier is kept')
})

test('the Claude reader still answers when the auth probe fails', async t => {
  const { shim } = fakeCli(t, 'claude', `
    if (process.argv[2] === 'auth') { process.stderr.write('auth broke'); process.exit(1) }
    console.log(JSON.stringify({ result: 'Current session: 20% used' }))
  `)
  const parsed = await quota.readers.claude({ command: shim })
  assert.deepEqual(parsed.windows.map(w => [w.usedPercent, w.resetsAt]), [[20, null]])
  assert.equal(parsed.plan, null)
})

test('the Antigravity and Cursor readers parse their own CLI output', async t => {
  const agy = fakeCli(t, 'agy', `
    if (!(process.argv[2] === '-p' && process.argv[3] === '/usage')) process.exit(3)
    console.log(JSON.stringify(${JSON.stringify(AGY_USAGE)}))
  `)
  const parsed = await quota.readers.antigravity({ command: agy.shim, proxyMode: 'direct' })
  assert.equal(parsed.windows.length, 4)
  const cursor = fakeCli(t, 'agent', `console.log('Subscription Tier   Pro'); console.log('User Email  someone@example.com')`)
  const about = await quota.readers.cursor({ command: cursor.shim })
  assert.equal(about.plan, 'Pro')
  assert.ok(!JSON.stringify(about).includes('someone@example.com'))
})

test('local and custom providers need no subscription probe', async () => {
  assert.equal((await new QuotaMonitor().get('ollama')).state, 'unlimited')
  assert.equal((await new QuotaMonitor().get('custom')).state, 'unknown')
})
