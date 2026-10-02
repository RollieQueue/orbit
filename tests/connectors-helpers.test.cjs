const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const quota = require('../electron/quota.mts')
const { ConnectorStore } = require('../electron/connectors.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { folder, fakeMcp, finished, payload, agentOf } = require('./helpers-session.cjs')

// Connectors (external MCP servers) reach the root agent's provider process by default; a helper gets only the ones its
// spawn named, never more than its parent has. The fake provider records the `session` each turn is launched with.
const SERVER = path.join(__dirname, 'fixtures', 'echo-mcp-server.cjs')
const SECRET = 'sup3r-s3cret-value'
const stdio = name => ({ name, description: `Fixture ${name}`, command: process.execPath, args: [SERVER], env: [`FIXTURE_SECRET=${SECRET}`] })
const names = session => session.connectors.map(item => item.name)
const answer = result => JSON.parse(result.text)

function world(t, connectors = ['a', 'b']) {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const store = new ConnectorStore(path.join(root, 'data'))
  for (const name of connectors) store.add(stdio(name), { scope: 'global' })
  return { workspace, store }
}
// A scripted team: `script[name]` runs once per turn of that agent (the helper's turns count apart) and returns its text.
function team(t, { store, script, transport = () => 'session', extra = {} }) {
  const seen = [], before = {}
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: transport, connectorStore: store, ...extra, runProvider: async options => {
    const [, name] = agentOf(options) || [], turn = seen.filter(item => item.name === name).length - (before[name] ?? 0)
    seen.push({ name, turn, providerId: options.providerId, session: options.session })
    return { text: await script[name]?.(runtime, options, turn) ?? 'done' }
  } })
  const dispatch = (options, tool, args) => runtime.dispatchMcp(options.session.token, tool, args)
  const turnsOf = name => seen.filter(item => item.name === name)
  // A new run of the same chat counts the agents' turns from its start.
  const nextRun = () => { for (const item of seen) before[item.name] = seen.filter(other => other.name === item.name).length }
  return { runtime, seen, dispatch, turnsOf, nextRun }
}
const waitAll = async (dispatch, options) => {
  for (let left = 6; left; left--) if (!(await dispatch(options, 'wait_agent', {})).observation.some(child => !['done', 'error', 'cancelled'].includes(child.status))) return
}

test('the root gets every enabled connector; a helper gets none unless its spawn names it, and its CONNECTORS line follows', async t => {
  const { workspace, store } = world(t, ['a', 'b', 'c'])
  store.setEnabled('c', false, { scope: 'global' })
  let spawned = {}
  const { runtime, seen, turnsOf, dispatch } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      spawned.none = answer(await dispatch(options, 'spawn_agent', { name: 'Plain', task: 'T', reason: 'R' }))
      spawned.empty = answer(await dispatch(options, 'spawn_agent', { name: 'Empty', task: 'T', reason: 'R', connectors: [] }))
      spawned.one = answer(await dispatch(options, 'spawn_agent', { name: 'WithA', task: 'T', reason: 'R', connectors: ['a'] }))
      spawned.two = answer(await dispatch(options, 'spawn_agent', { name: 'TwoDup', task: 'T', reason: 'R', connectors: ['b', 'a', 'b'] }))
      await waitAll(dispatch, options)
      return 'premature'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(Object.values(spawned).every(result => result.ok), JSON.stringify(spawned))
  const root = turnsOf('Orbit')[0].session
  assert.deepEqual(names(root), ['a', 'b'], 'the root: every enabled connector, not the switched-off one')
  assert.match(root.systemAppend, /CONNECTORS .*a — Fixture a; b — Fixture b\./)
  for (const name of ['Plain', 'Empty']) {
    const session = turnsOf(name)[0].session
    assert.deepEqual(session.connectors, [], `${name}: none`)
    assert.ok(!/CONNECTORS/.test(session.systemAppend), `${name}: no CONNECTORS line`)
  }
  const one = turnsOf('WithA')[0].session
  assert.deepEqual(names(one), ['a'])
  assert.match(one.systemAppend, /CONNECTORS .*a — Fixture a\./)
  assert.ok(!/b — Fixture b/.test(one.systemAppend), 'the line names only what the helper gets')
  assert.deepEqual(names(turnsOf('TwoDup')[0].session), ['a', 'b'], 'the helper gets what its spawn named (the store lists them in its own order)')
  // The public snapshot carries the names the spawn gave, in order and without repeats, and nothing of the launch data.
  const byName = Object.fromEntries(snapshot.agents.map(agent => [agent.name, agent]))
  assert.equal(byName.Orbit.connectors, undefined)
  assert.equal(byName.Plain.connectors, undefined)
  assert.equal(byName.Empty.connectors, undefined)
  assert.deepEqual(byName.WithA.connectors, ['a'])
  assert.deepEqual(byName.TwoDup.connectors, ['b', 'a'])
  assert.ok(!JSON.stringify(snapshot).includes(SECRET), 'no env value in the snapshot')
  assert.ok(!JSON.stringify(runtime.runs.get(snapshot.runId).traces).includes(SECRET))
})

test('spawn_agent refuses a connector the caller cannot pass on, with what it can, and a malformed list', async t => {
  const { workspace, store } = world(t)
  const refused = {}
  const { runtime, dispatch } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      refused.unknown = answer(await dispatch(options, 'spawn_agent', { name: 'U', task: 'T', reason: 'R', connectors: ['a', 'nope'] }))
      refused.shape = await rt.spawnSubAgent([...rt.runs.keys()][0], 'root', { name: 'S', task: 'T', reason: 'R', connectors: 'a' })
      refused.items = await rt.spawnSubAgent([...rt.runs.keys()][0], 'root', { name: 'I', task: 'T', reason: 'R', connectors: ['a', 3] })
      refused.registry = await dispatch(options, 'spawn_agent', { name: 'R', task: 'T', reason: 'R', connectors: 'a' })
      return 'premature'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(refused.unknown.ok, false); assert.equal(refused.unknown.reason, 'unknown_connector')
  assert.match(refused.unknown.instruction, /"nope" is not a connector you can pass on\. Available: a, b\./)
  for (const key of ['shape', 'items']) { assert.equal(refused[key].ok, false); assert.equal(refused[key].reason, 'invalid_connectors') }
  assert.equal(refused.registry.ok, false, 'the registry schema refuses a string too')
  assert.deepEqual(snapshot.agents.map(agent => agent.name), ['Orbit'], 'a refused spawn creates nobody')
})

test('below full access no connector can be passed on: the refusal says why, and an empty list is fine', async t => {
  const { workspace, store } = world(t)
  const results = {}
  const { runtime, seen, dispatch, turnsOf } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      results.refused = answer(await dispatch(options, 'spawn_agent', { name: 'W', task: 'T', reason: 'R', connectors: ['a'] }))
      results.fine = answer(await dispatch(options, 'spawn_agent', { name: 'Plain', task: 'T', reason: 'R', connectors: [] }))
      await waitAll(dispatch, options)
      return 'premature'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'workspace-write', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(results.refused.ok, false); assert.equal(results.refused.reason, 'connectors_unavailable')
  assert.match(results.refused.instruction, /workspace-write access/)
  assert.equal(results.fine.ok, true)
  assert.ok(seen.every(item => item.session.connectors.length === 0), 'nobody gets any')
  assert.equal(snapshot.agents.find(agent => agent.name === 'Plain').connectors, undefined)
  assert.ok(turnsOf('Plain').length)
})

test('a helper passes on only what it has itself, and no connector at all is refused too', async t => {
  const { workspace, store } = world(t, ['a', 'b'])
  const results = {}
  const { runtime, dispatch, turnsOf } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      results.mid = answer(await dispatch(options, 'spawn_agent', { name: 'Mid', task: 'T', reason: 'R', connectors: ['a'] }))
      results.bare = answer(await dispatch(options, 'spawn_agent', { name: 'Bare', task: 'T', reason: 'R' }))
      await waitAll(dispatch, options)
      return 'premature'
    },
    Mid: async (rt, options, turn) => {
      if (turn) return 'MID_DONE'
      results.list = answer(await dispatch(options, 'connector_list', {}))
      results.widen = answer(await dispatch(options, 'spawn_agent', { name: 'Widen', task: 'T', reason: 'R', connectors: ['b'] }))
      results.same = answer(await dispatch(options, 'spawn_agent', { name: 'Same', task: 'T', reason: 'R', connectors: ['a'] }))
      results.inherit = answer(await dispatch(options, 'spawn_agent', { name: 'Inherit', task: 'T', reason: 'R' }))
      await waitAll(dispatch, options)
      return 'MID_DONE'
    },
    Bare: async (rt, options, turn) => {
      if (turn) return 'BARE_DONE'
      results.bareList = answer(await dispatch(options, 'connector_list', {}))
      results.nothing = answer(await dispatch(options, 'spawn_agent', { name: 'Nothing', task: 'T', reason: 'R', connectors: ['a'] }))
      return 'BARE_DONE'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(results.widen.reason, 'unknown_connector'); assert.match(results.widen.instruction, /Available: a\./)
  assert.equal(results.same.ok, true)
  assert.equal(results.nothing.reason, 'connectors_unavailable'); assert.match(results.nothing.instruction, /no connector to pass on/)
  assert.deepEqual(names(turnsOf('Same')[0].session), ['a'])
  assert.deepEqual(turnsOf('Inherit')[0].session.connectors, [], 'a helper that names nothing passes nothing on')
  // connector_list: passedToThisAgent is what this agent's own process gets, and the note says how.
  assert.deepEqual(results.list.passedToThisAgent, ['a']); assert.equal(results.list.passedToThisRun, true)
  assert.deepEqual(results.list.connectors.map(item => item.name), ['a', 'b'], 'the existing fields stay')
  assert.match(results.list.note, /Your parent passed you a at spawn/)
  assert.deepEqual(results.bareList.passedToThisAgent, [])
  assert.match(results.bareList.note, /You have no connector: a helper gets one only when its parent passed it with spawn_agent \{connectors/)
  for (const list of [results.list, results.bareList]) assert.ok(!JSON.stringify(list).includes(SECRET))
})

test('connector_list tells the root which connectors it passes and gets', async t => {
  const { workspace, store } = world(t, ['a', 'b'])
  let listed
  const { runtime, dispatch } = team(t, { store, script: { Orbit: async (rt, options, turn) => { if (!turn) listed = answer(await dispatch(options, 'connector_list', {})); return 'FINAL' } } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(listed.passedToThisAgent, ['a', 'b'])
  assert.match(listed.note, /a helper gets one only when you name it in spawn_agent \{connectors:\[names\]\}/)
})

test('a follow-up keeps the helper\'s connectors, and one removed meanwhile just drops out of its next turn', async t => {
  const { workspace, store } = world(t)
  const { runtime, dispatch, turnsOf } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      await dispatch(options, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R', connectors: ['a', 'b'] })
      await waitAll(dispatch, options)
      await dispatch(options, 'followup_agent', { agentId: 'Helper', task: 'More work', reason: 'Again' })
      await waitAll(dispatch, options)
      store.remove('b', { scope: 'global' })
      await dispatch(options, 'followup_agent', { agentId: 'Helper', task: 'Even more', reason: 'Again' })
      await waitAll(dispatch, options)
      return 'premature'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const turns = turnsOf('Helper')
  assert.equal(turns.length, 3)
  assert.deepEqual(turns.map(item => names(item.session)), [['a', 'b'], ['a', 'b'], ['a']])
  assert.match(turns[2].session.systemAppend, /CONNECTORS .*a — Fixture a\./)
  assert.ok(!/b — Fixture b/.test(turns[2].session.systemAppend))
  assert.deepEqual(snapshot.agents.find(agent => agent.name === 'Helper').connectors, ['a', 'b'], 'the record keeps what the spawn named')
})

test('a handover to another subscription keeps the helper\'s connectors', async t => {
  const { workspace, store } = world(t)
  const original = { ...quota.readers }
  t.after(() => Object.assign(quota.readers, original))
  const window = used => ({ windows: [{ kind: 'session', scope: 'all', models: [], usedPercent: used, resetsAt: null }], plan: 'test' })
  quota.readers.claude = async () => window(20)
  quota.readers.codex = async () => window(10)
  const catalog = [{ id: 'claude', available: true, models: ['opus'] }, { id: 'codex', available: true, models: ['gpt-6-astra'] }]
  const { runtime, dispatch, turnsOf } = team(t, { store, extra: { quota: new quota.QuotaMonitor(), catalog: async () => catalog }, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      await dispatch(options, 'spawn_agent', { name: 'Helper', task: 'T', reason: 'R', connectors: ['b'] })
      await waitAll(dispatch, options)
      return 'premature'
    },
    Helper: async (rt, options) => {
      if (options.providerId === 'claude') throw new Error("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.")
      return 'HELPER_DONE_ON_CODEX'
    },
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { providerId: 'claude', model: 'opus', accessMode: 'danger-full-access', approvalPolicy: 'never' }), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const turns = turnsOf('Helper')
  assert.deepEqual(turns.map(item => item.providerId), ['claude', 'codex'], 'the helper moved to the other subscription')
  assert.deepEqual(turns.map(item => names(item.session)), [['b'], ['b']])
  assert.match(turns[1].session.systemAppend, /CONNECTORS .*b — Fixture b\./)
  const helper = snapshot.agents.find(agent => agent.name === 'Helper')
  assert.equal(helper.handovers.length, 1)
  assert.deepEqual(helper.connectors, ['b'])
})

test('continueFrom inherits the earlier helper\'s connectors that the parent can still pass on; an explicit list wins', async t => {
  const { workspace, store } = world(t, ['a', 'b', 'c'])
  const results = {}
  let phase = 'first'
  const { runtime, dispatch, turnsOf, nextRun } = team(t, { store, script: {
    Orbit: async (rt, options, turn) => {
      if (turn) return 'FINAL'
      if (phase === 'first') {
        await dispatch(options, 'spawn_agent', { name: 'Earlier', task: 'T', reason: 'R', connectors: ['a', 'c'] })
        await dispatch(options, 'spawn_agent', { name: 'Quiet', task: 'T', reason: 'R' })
        await waitAll(dispatch, options)
      } else {
        store.remove('c', { scope: 'global' })
        results.inherit = answer(await dispatch(options, 'spawn_agent', { name: 'Inheritor', task: 'Pick up', reason: 'R', continueFrom: 'Earlier' }))
        results.explicit = answer(await dispatch(options, 'spawn_agent', { name: 'Explicit', task: 'Pick up', reason: 'R', continueFrom: 'Earlier', connectors: ['b'] }))
        results.empty = answer(await dispatch(options, 'spawn_agent', { name: 'Emptied', task: 'Pick up', reason: 'R', continueFrom: 'Earlier', connectors: [] }))
        results.quiet = answer(await dispatch(options, 'spawn_agent', { name: 'QuietToo', task: 'Pick up', reason: 'R', continueFrom: 'Quiet' }))
        await waitAll(dispatch, options)
      }
      return 'premature'
    },
  } })
  const run = extra => finished(runtime, payload(workspace, { accessMode: 'danger-full-access', approvalPolicy: 'never', ...extra }), 20000)
  assert.equal((await run()).snapshot.status, 'completed')
  phase = 'second'; nextRun()
  const { snapshot } = await run({ prompt: 'Continue' })
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.ok(Object.values(results).every(result => result.ok), JSON.stringify(results))
  const byName = Object.fromEntries(snapshot.agents.map(agent => [agent.name, agent]))
  assert.deepEqual(byName.Inheritor.connectors, ['a'], 'c is gone from the store, so only a is passed on')
  assert.deepEqual(names(turnsOf('Inheritor')[0].session), ['a'])
  assert.deepEqual(byName.Explicit.connectors, ['b'])
  assert.deepEqual(names(turnsOf('Explicit')[0].session), ['b'])
  assert.equal(byName.Emptied.connectors, undefined)
  assert.deepEqual(turnsOf('Emptied')[0].session.connectors, [])
  assert.equal(byName.QuietToo.connectors, undefined, 'an earlier helper without connectors passes none on')
})
