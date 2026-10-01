const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { OrbitMemoryStore } = require('../electron/memory.mts')
const { folder, finished, payload, agentOf, session } = require('./helpers-session.cjs')

// wait_agent without agentId gives a finished helper's full result once per context of the caller (the same session of its
// model), and its status with an excerpt after that; wait_agent {agentId} always gives the whole result. A new session, a
// follow-up's new result and a caller whose context is not known get the full text. The model is played by a fake provider
// that calls the tools through runtime.dispatchMcp inside its turn.
const LONG = (letter, size = 1000) => letter.repeat(size)
const parse = answer => JSON.parse(answer.text)
// Waits until the helper is done (a wait returns at the first helper to finish, or when one is new to the caller).
async function settled(runtime, token, name, args = {}) {
  for (let left = 20; left; left--) {
    const wait = parse(await runtime.dispatchMcp(token, 'wait_agent', args))
    const list = Array.isArray(wait) ? wait : wait.agents
    if (list.every(child => ['done', 'error', 'cancelled'].includes(child.status))) return list
  }
  throw new Error(`${name} did not finish`)
}

test('a finished helper\'s full result comes once, later waits show an excerpt, wait_agent {agentId} shows it whole again', async t => {
  const workspace = folder(t)
  const seen = {}
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: LONG('A') }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
    seen.first = (await settled(runtime, token, 'Helper'))[0]
    seen.second = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    seen.named = parse(await runtime.dispatchMcp(token, 'wait_agent', { agentId: 'Helper' }))[0]
    seen.third = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(seen.first.result, LONG('A'), 'the first wait that shows it gives the whole result')
  assert.equal(seen.first.resultTruncated, undefined)
  for (const later of [seen.second, seen.third]) {
    assert.equal(later.status, 'done')
    assert.equal(later.agentId, seen.first.agentId)
    assert.equal(later.result.length < 400 && later.result.startsWith('AAAA'), true, `an excerpt, ${later.result.length} characters`)
    assert.equal(later.resultTruncated, true)
    assert.match(later.fullResult, /wait_agent \{agentId: "[^"]+"\}/)
  }
  assert.equal(seen.named.result, LONG('A'), 'by agentId the whole result, whenever asked')
  assert.equal(seen.named.resultTruncated, undefined)
})

test('a short result is always given whole', async t => {
  const workspace = folder(t)
  const seen = []
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: 'SHORT RESULT' }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
    await settled(runtime, token, 'Helper')
    seen.push(parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0], parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0])
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(seen.map(child => [child.result, child.resultTruncated]), [['SHORT RESULT', undefined], ['SHORT RESULT', undefined]])
})

test('a follow-up\'s new result is shown in full, and so is every result in a new session of the caller', async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const seen = {}
  let rootTurns = 0
  const runtime = new OrbitRuntime({ memoryStore: new OrbitMemoryStore(path.join(root, 'store')), ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: LONG(options.prompt.includes('SECOND_TASK') ? 'B' : 'A'), model: 'worker-model' }
    rootTurns++
    if (rootTurns === 1) {
      await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
      seen.one = (await settled(runtime, token, 'Helper'))[0]
      seen.oneAgain = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
      await runtime.dispatchMcp(token, 'followup_agent', { agentId: 'Helper', task: 'SECOND_TASK' })
      for (let left = 20; left; left--) {
        const wait = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
        if (wait.status === 'done' && wait.generation === 1) { seen.second = wait; break }
      }
      seen.secondAgain = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
      // The session ends with this turn without a name: the next turn starts a new one, which has read nothing.
      return { text: 'Premature answer', sessionId: null }
    }
    seen.newSession = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    seen.newSessionAgain = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    return { text: 'Final' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(rootTurns, 2, 'the model_evaluate reminder makes the second turn')
  assert.equal(seen.one.result, LONG('A'))
  assert.equal(seen.oneAgain.resultTruncated, true)
  assert.equal(seen.second.result, LONG('B'), 'the follow-up\'s result is new')
  assert.equal(seen.second.resultTruncated, undefined)
  assert.equal(seen.secondAgain.resultTruncated, true)
  assert.equal(seen.newSession.result, LONG('B'), 'a new session has not read it')
  assert.equal(seen.newSessionAgain.resultTruncated, true, 'and reads it once')
})

test('a resumed session keeps what it read, a caller outside a session turn or on the envelope transport is shown everything', async t => {
  const root = folder(t), workspace = path.join(root, 'ws'); fs.mkdirSync(workspace)
  const seen = {}
  let rootTurns = 0
  const runtime = new OrbitRuntime({ memoryStore: new OrbitMemoryStore(path.join(root, 'store')), ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: LONG('A'), model: 'worker-model' }
    rootTurns++
    if (rootTurns === 1) {
      await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
      seen.one = (await settled(runtime, token, 'Helper'))[0]
      // The same call on the envelope transport rebuilds its prompt from a trimmed transcript: nothing is cut.
      const rootAgent = [...runtime.runs.values()][0].agentNodes.get('root')
      rootAgent.transport = 'envelope'
      seen.envelope = [parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0], parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]]
      rootAgent.transport = 'session'
      return { text: 'Premature answer', sessionId: options.session.id }
    }
    seen.resumed = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    return { text: 'Final' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(rootTurns, 2)
  assert.deepEqual(seen.envelope.map(child => child.result.length), [1000, 1000])
  assert.equal(seen.one.result.length, 1000)
  assert.equal(seen.resumed.resultTruncated, true, 'the resumed session is the same context: it read the result in turn one')
  assert.equal(seen.resumed.result.length < 400, true)
})

// ---- the answer's budget ---------------------------------------------------------------------------------------------
// One answer is cut at limits.maxOutputChars. A result counts as shown only when the answer carried it whole.

test('results that do not fit one answer together are never cut and never counted as shown: each comes whole once', async t => {
  const workspace = folder(t)
  const seen = { answers: [], whole: new Map(), earlier: [] }
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name.startsWith('Helper')) return { text: LONG(name.endsWith('1') ? 'A' : 'B', 2500) }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper1', task: 'Work', reason: 'Independent' })
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper2', task: 'Work', reason: 'Independent' })
    for (let left = 12; left && seen.whole.size < 2; left--) {
      const answer = await runtime.dispatchMcp(token, 'wait_agent', {})
      seen.answers.push(answer.text)
      const wait = JSON.parse(answer.text)
      for (const child of Array.isArray(wait) ? wait : wait.agents) {
        if (child.result.length === 2500) seen.whole.set(child.agentId, (seen.whole.get(child.agentId) || 0) + 1)
        else if (child.resultTruncated && /shown in full earlier/.test(child.fullResult)) seen.earlier.push([child.agentId, seen.whole.has(child.agentId)])
      }
    }
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { limits: { maxOutputChars: 3000 } }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(seen.whole.size, 2, 'both results came whole')
  assert.deepEqual([...seen.whole.values()], [1, 1], 'each exactly once')
  assert.ok(seen.answers.every(text => !text.includes('[truncated]') && text.length <= 3000), 'no answer was cut at the limit')
  assert.ok(seen.earlier.every(([, wasWhole]) => wasWhole), 'an excerpt says "shown earlier" only for a result that was shown whole')
})

test('wait_agent {agentId} gives a long result as far as one answer holds, and does not count it as shown', async t => {
  const workspace = folder(t)
  const seen = {}
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: LONG('A', 8000) }
    if (name === 'Small') return { text: LONG('S', 2000) }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Small', task: 'Work', reason: 'Independent' })
    await settled(runtime, token, 'both', { agentId: 'Helper' })
    await settled(runtime, token, 'both', { agentId: 'Small' })
    const raw = await runtime.dispatchMcp(token, 'wait_agent', { agentId: 'Small' })
    seen.small = [parse(raw)[0], raw.text.length]
    const named = await runtime.dispatchMcp(token, 'wait_agent', { agentId: 'Helper' })
    seen.named = [parse(named)[0], named.text.length]
    seen.later = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, { limits: { maxOutputChars: 5000 } }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(seen.small[0].result, LONG('S', 2000), 'a result that fits is whole by id')
  const [named, size] = seen.named
  assert.equal(size <= 5000, true, `valid JSON within the limit, ${size} characters`)
  assert.equal(named.resultTruncated, true)
  assert.ok(named.result.length > 3000 && named.result.length < 5000, `as far as the answer holds: ${named.result.length}`)
  assert.match(named.fullResult, /more than one answer holds/)
  const helper = seen.later.find(child => child.result.startsWith('AAAA'))
  assert.doesNotMatch(helper.fullResult, /earlier/, 'it was never shown whole')
  assert.equal(helper.resultTruncated, true)
})

// ---- compaction ------------------------------------------------------------------------------------------------------

test('after Claude compacts its session the result comes whole again, and an excerpt never says the text is in the context', async t => {
  const workspace = folder(t)
  const seen = {}
  const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
    const [, name] = agentOf(options), token = options.session.token
    if (name === 'Helper') return { text: LONG('A') }
    await runtime.dispatchMcp(token, 'spawn_agent', { name: 'Helper', task: 'Work', reason: 'Independent' })
    seen.first = (await settled(runtime, token, 'Helper'))[0]
    seen.excerpt = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    options.onEvent({ providerId: 'claude', kind: 'compaction' })
    seen.afterCompaction = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    seen.excerptAgain = parse(await runtime.dispatchMcp(token, 'wait_agent', {}))[0]
    return { text: 'Integrated' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(seen.first.result, LONG('A'))
  assert.equal(seen.excerpt.resultTruncated, true)
  assert.doesNotMatch(seen.excerpt.fullResult, /context above|in your context/)
  assert.match(seen.excerpt.fullResult, /if you no longer have it/)
  assert.equal(seen.afterCompaction.result, LONG('A'), 'the compacted session has maybe lost it: shown again')
  assert.equal(seen.excerptAgain.resultTruncated, true, 'and once')
  const { description } = require('../electron/tool-registry.mts').TOOLS.find(tool => tool.name === 'wait_agent')
  assert.doesNotMatch(description, /in your context above/)
  assert.match(description, /if you no longer have it/)
})

test('the Claude stream parser reports compact_boundary as a compaction', () => {
  const { _testing } = require('../electron/providers.mts')
  const events = [], parser = _testing.createClaudeParser(event => events.push(event), 'sonnet')
  parser.line(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5' }))
  assert.equal(events.some(event => event.kind === 'compaction'), false)
  parser.line(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 's', compact_metadata: { trigger: 'auto', pre_tokens: 160000 } }))
  assert.deepEqual(events.filter(event => event.kind === 'compaction'), [{ providerId: 'claude', kind: 'compaction' }])
})
