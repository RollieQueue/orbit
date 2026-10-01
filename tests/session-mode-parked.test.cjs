const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { folder, finished, payload, agentOf, session, callLimit, until, cursorFull, commandAnswer } = require('./helpers-session.cjs')

// The session transport is driven with a fake provider and a fake MCP server (tests/helpers-session.cjs); no CLI is started.

// ---- Calls of a provider with an MCP call limit (Cursor), parked and collected ------------------------------------

test('parked calls made side by side each run once, an identical call joins the run under way, and each result is collected once', async t => {
  callLimit(t, 150)
  const workspace = folder(t)
  const slow = tag => ({ command: process.execPath, args: ['-e', `require("fs").appendFileSync("${tag}.txt", "x"); setTimeout(() => console.log("${tag} done"), 450)`] })
  let first, collected = []
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const token = options.session.token
    // A client that sends its tool calls in parallel, one of them twice.
    first = await Promise.all([commandAnswer(runtime, token, slow('A')), commandAnswer(runtime, token, slow('B')), commandAnswer(runtime, token, slow('A'))])
    // Collected in the other order: A ends while B is waited for, and B's end may count A's file as its own change.
    for (const tag of ['B', 'A']) {
      for (let attempt = 0; attempt < 30; attempt++) { const answer = await commandAnswer(runtime, token, slow(tag)); if (!answer.stillRunning) { collected.push(answer); break } }
    }
    return { text: 'ok', sessionId: 'cursor-chat' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(first.every(answer => answer.stillRunning === true), JSON.stringify(first))
  assert.deepEqual(collected.map(answer => [answer.stdout.trim(), answer.collected]), [['B done', true], ['A done', true]])
  assert.ok(collected.every(answer => !Number.isNaN(Date.parse(answer.startedAt))), JSON.stringify(collected))
  assert.deepEqual(['A', 'B'].map(tag => fs.readFileSync(path.join(workspace, `${tag}.txt`), 'utf8')), ['x', 'x'], 'every command ran exactly once')
})

test('a parked call nobody collects is stopped when its agent ends: the command is killed, the operations drain, the chat takes the next message', async t => {
  callLimit(t, 150)
  const workspace = folder(t)
  const late = tag => ({ command: process.execPath, args: ['-e', `setTimeout(() => require("fs").writeFileSync("${tag}-late.txt", "x"), 1900)`] })
  let lastCommandAt = 0
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (options.prompt.includes('Next message')) return { text: 'next answer' }
    const park = async tag => { lastCommandAt = Date.now(); assert.equal((await commandAnswer(runtime, token, late(tag))).stillRunning, true) }
    if (name === 'Helper') { await park('helper'); return { text: 'Helper answered without waiting for its build' } }
    const { run } = runtime.sessionFor(token)
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Start a build', reason: 'Independent' })
    await park('root')
    let helper
    for (let attempt = 0; attempt < 40 && !Array.isArray(helper); attempt++) helper = JSON.parse((await runtime.dispatchMcp(token, 'wait_agent', {})).text)
    // The helper ended: its build was stopped while the run goes on (a follow-up would be refused otherwise).
    await until(() => run.agentOperations.get(helper[0].agentId).size === 0, 3000)
    return { text: 'Root answered; its build still runs', sessionId: 'cursor-chat' }
  } })
  const { snapshot, runId } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const run = runtime.runs.get(runId)
  await until(() => run.operations.size === 0, 3000)
  const next = await finished(runtime, payload(workspace, { ...cursorFull, prompt: 'Next message' }))
  assert.equal(next.snapshot.status, 'completed', next.snapshot.error)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, lastCommandAt + 2800 - Date.now())))
  assert.deepEqual(['root', 'helper'].map(tag => fs.existsSync(path.join(workspace, `${tag}-late.txt`))), [false, false], 'the stopped commands never finished')
})
