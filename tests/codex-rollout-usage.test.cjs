const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createCodexRolloutMeter } = require('../electron/codex-rollout-usage.mts')
const { startedThread, execTurnUsage } = require('../electron/codex-usage.mts')
const { runProvider } = require('../electron/providers.mts')
const { fakeCli, withEnv } = require('./helpers-providers-session.cjs')

const tokens = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output })
const row = (at, counts, extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: { ...counts, cache_write_input_tokens: 0, reasoning_output_tokens: 3, total_tokens: counts.input_tokens + counts.output_tokens }, last_token_usage: counts, model_context_window: 258400 }, ...extra,
} }) + '\n'
function lab(t, thread, date = new Date()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-rollout-test-'))
  t.after(() => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()))
    fs.rmSync(home, { recursive: true, force: true })
  })
  const day = path.join(home, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
  fs.mkdirSync(day, { recursive: true })
  return { home, file: path.join(day, `rollout-test-${thread}.jsonl`) }
}
const sum = events => events.reduce((total, usage) => tokens(total.input_tokens + usage.input_tokens, total.cached_input_tokens + usage.cached_input_tokens, total.output_tokens + usage.output_tokens), tokens(0, 0, 0))

test('exec rollout reports cache hits before completion and deduplicates stdout and late/replayed rows', t => {
  const thread = randomUUID(), at = Date.now(), events = [], counts = tokens(3000, 2600, 70)
  const { home, file } = lab(t, thread)
  startedThread(thread)
  fs.writeFileSync(file, row(at, tokens(1000, 800, 20)))
  const meter = createCodexRolloutMeter(home, at, usage => events.push(usage))
  t.after(() => meter.close())
  meter.start(thread)
  assert.deepEqual(sum(events), tokens(1000, 800, 20), 'live, before any final stdout report')
  fs.appendFileSync(file, row(at + 1, counts) + row(at + 1, counts))
  meter.flush()
  assert.deepEqual(sum(events), counts)
  assert.equal(execTurnUsage(thread, counts, false), null, 'the final report repeats the live total')
  fs.appendFileSync(file, row(at + 2, tokens(1000, 800, 20)) + row(at + 2, counts))
  meter.flush()
  assert.deepEqual(sum(events), counts, 'late smaller totals never recharge an earlier call')
  meter.close()
  fs.appendFileSync(file, row(at + 3, tokens(9000, 8000, 100)))
  meter.flush()
  assert.deepEqual(sum(events), counts, 'no reports after disposal')
})

test('resume after a restart uses old rollout rows as baseline, including a rollout in an older date', t => {
  const thread = randomUUID(), at = Date.now(), events = []
  const { home, file } = lab(t, thread, new Date(at - 7 * 86400000))
  fs.writeFileSync(file, row(at - 60000, tokens(9000, 8000, 90)) + row(at + 1, tokens(10000, 8900, 120)))
  const meter = createCodexRolloutMeter(home, at, usage => events.push(usage))
  t.after(() => meter.close())
  meter.start(thread)
  assert.deepEqual(sum(events), tokens(1000, 900, 30), 'previous runs are not charged to this run')
  const final = execTurnUsage(thread, tokens(12000, 10700, 150), true)
  events.push(final)
  // Stdout finished before the last record became readable. Disposal still cannot double count that record.
  fs.appendFileSync(file, row(at + 2, tokens(12000, 10700, 150)))
  meter.close()
  assert.deepEqual(sum(events), tokens(3000, 2700, 60))
})

test('reader handles partial UTF-8 JSONL, oversized tool output and malformed records', t => {
  const thread = randomUUID(), at = Date.now(), events = []
  const { home, file } = lab(t, thread)
  startedThread(thread)
  fs.writeFileSync(file, '{not json}\n' + JSON.stringify({ type: 'response_item', payload: { text: 'текст'.repeat(600000) } }) + '\n')
  const meter = createCodexRolloutMeter(home, at, usage => events.push(usage))
  t.after(() => meter.close())
  meter.start(thread)
  const bytes = Buffer.from(row(at + 1, tokens(123, 100, 4), { note: 'ё🙂'.repeat(15000) }))
  const split = Math.floor(bytes.length / 2)
  fs.appendFileSync(file, bytes.subarray(0, split)); meter.flush()
  assert.deepEqual(events, [], 'a partial record is not reported')
  fs.appendFileSync(file, bytes.subarray(split)); meter.flush()
  assert.deepEqual(sum(events), tokens(123, 100, 4))
  fs.appendFileSync(file, row(at + 2, tokens(999, 999, 999), { info: null }))
  meter.flush()
  assert.deepEqual(sum(events), tokens(123, 100, 4), 'rate-limit updates with no usage are ignored')
})

test('subscription home and exact thread filename keep other accounts and agents out of the count', t => {
  const thread = randomUUID(), at = Date.now(), events = []
  const own = lab(t, thread), other = lab(t, thread)
  startedThread(thread)
  fs.writeFileSync(own.file, row(at, tokens(100, 80, 3)))
  fs.writeFileSync(other.file, row(at, tokens(900000, 800000, 9000)))
  fs.writeFileSync(path.join(path.dirname(own.file), `rollout-test-${randomUUID()}.jsonl`), row(at, tokens(800000, 700000, 8000)))
  const meter = createCodexRolloutMeter(own.home, at, usage => events.push(usage))
  t.after(() => meter.close())
  meter.start(thread)
  assert.deepEqual(sum(events), tokens(100, 80, 3))
})

test('full-access provider forwards live rollout usage from CODEX_HOME and final usage is counted once', async t => {
  const thread = randomUUID(), at = Date.now(), { home, file } = lab(t, thread)
  withEnv(t, { ORBIT_LEGACY_ENVELOPE: undefined })
  const cli = fakeCli(t, 'ORBIT_CODEX_COMMAND', `
    const path = require('node:path');
    const file = ${JSON.stringify(file)};
    if (process.env.CODEX_HOME !== ${JSON.stringify(home)}) throw Error('Wrong subscription home');
    out({ type: 'thread.started', thread_id: ${JSON.stringify(thread)} });
    setTimeout(() => fs.appendFileSync(file, ${JSON.stringify(row(at + 10000, tokens(5000, 4000, 200)))}), 100);
    setTimeout(() => {
      out({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } });
      out({ type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 200 } });
    }, 1600);
  `)
  fs.writeFileSync(file, '')
  const events = []
  let ended = false, reportLive
  const live = new Promise(resolve => { reportLive = resolve })
  const result = runProvider({ providerId: 'codex', workspace: cli.directory, accessMode: 'danger-full-access', approvalPolicy: 'never',
    prompt: 'fixture', session: { id: null, resume: false }, extraEnv: { CODEX_HOME: home }, timeoutMs: 5000,
    onEvent: event => { events.push(event); if (event.kind === 'usage') reportLive() },
  }).then(value => { ended = true; return value })
  await live
  assert.equal(ended, false, 'usage reached Orbit while the Codex turn was still running')
  assert.equal((await result).text, 'done')
  assert.deepEqual(sum(events.filter(event => event.kind === 'usage').map(event => event.usage)), tokens(5000, 4000, 200))
})
