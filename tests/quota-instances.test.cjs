const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { QuotaMonitor, classifyQuotaError, PROVIDER_IDS } = quota
const { createRuntimeApi } = require('../electron/runtime-api.mts')

// Quota per subscription instance (electron/instances.mts): "claude-2" is read with its own account's environment, keeps its
// own snapshot and its own refusal mark; the default account's figures and marks never move with it.

const window = (usedPercent, extra = {}) => ({ kind: 'session', usedPercent, resetsAt: null, scope: 'all', models: [], ...extra })
const OPTIONS = { 'claude-2': { base: 'claude', label: 'Work', accountDir: 'C:\\accounts\\claude-2' }, 'codex-2': { base: 'codex', label: 'Spare', accountDir: 'C:\\accounts\\codex-2' } }

// Replaces the readers of the module (the monitor looks them up at call time) for one test; `calls` records every options object.
function stubReaders(t, answer) {
  const saved = { ...quota.readers }
  const calls = []
  for (const id of ['codex', 'claude', 'antigravity', 'cursor']) quota.readers[id] = async options => { calls.push({ id, options }); return answer(id, options) }
  t.after(() => Object.assign(quota.readers, saved))
  return calls
}
const fine = id => ({ windows: [window(10)], plan: id, source: id })

test('an instance is read by its base reader with the account\'s environment; the default account\'s reader call has none', async t => {
  const calls = stubReaders(t, fine)
  const monitor = new QuotaMonitor()
  const two = await monitor.get('claude-2', { options: OPTIONS['claude-2'] })
  const one = await monitor.get('claude', { options: { command: 'my-claude' } })
  assert.deepEqual([two.providerId, one.providerId], ['claude-2', 'claude'])
  assert.equal(two.plan, 'claude', 'the base reader answered')
  assert.deepEqual(calls.map(call => call.id), ['claude', 'claude'])
  assert.deepEqual(calls[0].options.env, { CLAUDE_CONFIG_DIR: 'C:\\accounts\\claude-2' })
  assert.deepEqual(calls[1].options, { command: 'my-claude' }, 'the default account\'s options reach its reader untouched')
  await monitor.get('codex-2', { options: OPTIONS['codex-2'] })
  assert.deepEqual(calls[2].options.env, { CODEX_HOME: 'C:\\accounts\\codex-2' })
})

test('snapshots, live figures and refusal marks of an instance and its base are independent', async t => {
  stubReaders(t, (id, options) => options?.env ? { windows: [window(100)], blocked: true, source: id } : { windows: [window(12)], source: id })
  let now = 1_000_000
  const monitor = new QuotaMonitor({ clock: () => now })
  const [one, two] = [await monitor.get('claude'), await monitor.get('claude-2', { options: OPTIONS['claude-2'] })]
  assert.deepEqual([one.state, two.state], ['ok', 'exhausted'])
  assert.deepEqual([monitor.peek('claude').windows[0].usedPercent, monitor.peek('claude-2').windows[0].usedPercent], [12, 100])

  const seen = []
  monitor.onUpdate(update => seen.push(update.providerId))
  monitor.markExhausted('claude', { resetsAt: now + 3_600_000, reason: 'refused' })
  assert.equal(monitor.peek('claude').state, 'exhausted'); assert.equal(monitor.peek('claude').exhaustedReason, 'refused')
  assert.equal(monitor.peek('claude-2').exhaustedUntil, undefined, 'the instance carries no mark of the default account')
  assert.deepEqual(seen, ['claude'], 'only the marked id is announced')

  // A mark on the instance does not exhaust the default account either, and live figures go to the id they were ingested under.
  const fresh = new QuotaMonitor({ clock: () => now })
  const live = await Promise.all([fresh.get('claude'), fresh.get('claude-2', { options: OPTIONS['claude-2'] })])
  assert.equal(live.length, 2)
  fresh.marks.delete('claude'); fresh.markExhausted('claude-2', { resetsAt: null, reason: 'second account refused' })
  assert.equal(fresh.peek('claude').state, 'ok'); assert.equal(fresh.peek('claude-2').state, 'exhausted')
  fresh.ingest('claude', { windows: [window(55)], source: 'claude-live' })
  assert.deepEqual([fresh.peek('claude').windows[0].usedPercent, fresh.peek('claude-2').windows[0].usedPercent], [55, 100])
  now += 31 * 60_000
  assert.equal(fresh.peek('claude-2').exhaustedUntil, undefined, 'the fallback cooldown of the instance ends on its own')
})

test('an instance without an account folder (or a provider with no account setting) is unavailable and never read as the default account', async t => {
  const calls = stubReaders(t, fine)
  const monitor = new QuotaMonitor()
  const lonely = await monitor.get('claude-3', { options: { base: 'claude', label: 'No folder' } })
  assert.equal(lonely.state, 'unavailable'); assert.equal(lonely.providerId, 'claude-3')
  assert.match(lonely.detail, /claude-3 has no account folder/); assert.match(lonely.detail, /Claude Code/)
  const cursor = await monitor.get('cursor-2', { options: { base: 'cursor', accountDir: 'C:\\x' } })
  assert.equal(cursor.state, 'unavailable'); assert.match(cursor.detail, /only one Cursor subscription/)
  assert.equal(calls.length, 0, 'no reader ran')
  assert.equal((await monitor.get('nope-2')).state, 'unavailable', 'an id that is no instance of a known provider is still "unknown provider"')
})

test('quota:get answers for every instance the provider options carry, next to the six providers', async t => {
  const calls = stubReaders(t, (id, options) => ({ windows: [window(options?.env ? 90 : 5)], plan: id }))
  const monitor = new QuotaMonitor()
  const handlers = createRuntimeApi({ runtime: {}, quota: monitor, stores: {}, userData: os.tmpdir(), inspectProviders: async () => [] })
  const all = await handlers.get('quota:get')({ ...OPTIONS, 'claude-2': { ...OPTIONS['claude-2'], command: 'work-claude' } }, true)
  assert.deepEqual(Object.keys(all), ['codex', 'codex-2', 'claude', 'claude-2', 'antigravity', 'cursor', 'ollama', 'custom'], 'instances sit right after their base provider')
  assert.deepEqual([all.claude.windows[0].usedPercent, all['claude-2'].windows[0].usedPercent, all['codex-2'].windows[0].usedPercent], [5, 90, 90])
  assert.deepEqual(all['claude-2'].providerId, 'claude-2')
  assert.equal(calls.find(call => call.options?.env?.CLAUDE_CONFIG_DIR).options.command, 'work-claude', 'the instance\'s own options reach its reader')
  assert.deepEqual(PROVIDER_IDS, ['codex', 'claude', 'antigravity', 'cursor', 'ollama', 'custom'], 'PROVIDER_IDS stays the list of base ids')
  // Without instances the answer is what it was.
  assert.deepEqual(Object.keys(await handlers.get('quota:get')({}, true)), PROVIDER_IDS)
})

test('classifyQuotaError: a refusal tagged with the base id is the caller\'s own account when the caller ran an instance', () => {
  const tagged = (providerId, message = 'You have hit your usage limit') => Object.assign(new Error(message), { quota: { providerId, resetsAt: null } })
  assert.equal(classifyQuotaError(tagged('claude'), 'claude-2').providerId, 'claude-2')
  assert.equal(classifyQuotaError(tagged('codex'), 'codex-3').providerId, 'codex-3')
  assert.equal(classifyQuotaError(tagged('claude'), 'claude').providerId, 'claude')
  assert.equal(classifyQuotaError(tagged('claude-2'), 'claude-2').providerId, 'claude-2')
  assert.equal(classifyQuotaError(tagged('claude'), '').providerId, 'claude', 'no caller: the tag stands')
  assert.equal(classifyQuotaError(tagged('codex'), 'claude-2').providerId, 'codex', 'a tag naming another provider is trusted as before')
  assert.equal(classifyQuotaError(tagged(undefined), 'claude-2').providerId, 'claude-2')
  // Untagged errors were always the caller's.
  assert.equal(classifyQuotaError(new Error('429 too many requests'), 'claude-2').providerId, 'claude-2')
  assert.equal(classifyQuotaError(new Error('boom'), 'claude-2'), null)
})

// ---- the real readers against fake CLIs ---------------------------------------------------------------------------------

function fakeCli(t, name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-quota-instance-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, `${name}.cjs`), body)
  const shim = path.join(directory, `${name}.cmd`)
  fs.writeFileSync(shim, `@"%dp0%\\node.exe" "%dp0%\\${name}.cjs" %*`)
  return shim
}
const withoutAccount = t => {
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
}
// A fake Claude Code: the figures depend on the account folder, which is signed in only when it holds `logged-in`.
const CLAUDE = `
  const fs = require('node:fs'), path = require('node:path')
  const home = process.env.CLAUDE_CONFIG_DIR
  const signedIn = !home || fs.existsSync(path.join(home, 'logged-in'))
  if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: signedIn, subscriptionType: home ? path.basename(home) : 'default' })); if (!signedIn) process.exitCode = 1 /* as the real CLI does */ }
  else console.log(JSON.stringify({ result: signedIn ? 'Current session: ' + (home ? 70 : 20) + '% used' : 'Total cost: $0.00' }))
`
const CODEX = `
  const rl = require('node:readline').createInterface({ input: process.stdin })
  rl.on('line', line => {
    const m = JSON.parse(line)
    if (m.method === 'initialize') return process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n')
    if (m.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: m.id, result: { rateLimits: { limitId: 'codex', planType: require('node:path').basename(process.env.CODEX_HOME || 'default'), primary: { usedPercent: 33, windowDurationMins: 300 } } } }) + '\\n')
  })
`

test('the Claude reader runs both probes in the instance\'s folder; a signed-out folder is unavailable with a sign-in hint, while the default account is read as before', async t => {
  withoutAccount(t)
  const command = fakeCli(t, 'claude', CLAUDE)
  const folder = name => { const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-claude-home-')), name); fs.mkdirSync(directory); t.after(() => fs.rmSync(path.dirname(directory), { recursive: true, force: true })); return directory }
  const signedIn = folder('claude-2'), signedOut = folder('claude-3')
  fs.writeFileSync(path.join(signedIn, 'logged-in'), '1')
  const monitor = new QuotaMonitor()
  const two = await monitor.get('claude-2', { options: { command, base: 'claude', accountDir: signedIn } })
  assert.deepEqual([two.state, two.windows[0].usedPercent, two.plan], ['ok', 70, 'claude-2'], 'usage and the plan came from the instance\'s folder')
  const three = await monitor.get('claude-3', { options: { command, base: 'claude', accountDir: signedOut } })
  assert.equal(three.state, 'unavailable'); assert.deepEqual(three.windows, [])
  assert.match(three.detail, /Войдите в этот аккаунт/); assert.match(three.detail, /«Войти»/)
  const plain = await monitor.get('claude', { options: { command } })
  assert.deepEqual([plain.state, plain.windows[0].usedPercent, plain.plan], ['ok', 20, 'default'])
  // The default account is never second-guessed: even a CLI that says it is signed out is read as it always was.
  const loggedOut = fakeCli(t, 'claude', `if (process.argv[2] === 'auth') console.log(JSON.stringify({ loggedIn: false })); else console.log(JSON.stringify({ result: 'Total cost: $0.00' }))`)
  const unchanged = await new QuotaMonitor().get('claude', { options: { command: loggedOut } })
  assert.deepEqual([unchanged.state, unchanged.windows.length], ['unknown', 0])
})

test('the Codex reader starts its App Server with the instance\'s CODEX_HOME', async t => {
  withoutAccount(t)
  const command = fakeCli(t, 'codex', CODEX)
  const monitor = new QuotaMonitor()
  const second = await monitor.get('codex-2', { options: { command, base: 'codex', accountDir: path.join(os.tmpdir(), 'codex-home-two') } })
  assert.deepEqual([second.providerId, second.plan, second.windows[0].usedPercent], ['codex-2', 'codex-home-two', 33])
  const plain = await monitor.get('codex', { options: { command } })
  assert.equal(plain.plan, 'default', 'the default account\'s App Server has no CODEX_HOME of ours')
})
