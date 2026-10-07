const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { CapabilityStore } = require('../electron/capabilities.mts')
const registry = require('../electron/tool-registry.mts')
const { OrbitRuntime, tool, response, identity, finished: envelopeFinished, payload: envelopePayload } = require('./helpers-runtime.cjs')
const { folder, finished, payload, agentOf, session } = require('./helpers-session.cjs')

// Trained agents through the runtime: agent_save / agent_read, spawn_agent {profile}, the AGENTS prompt block and the rating of an
// agent with capability_feedback. The store itself is in trained-agents.test.cjs. A fake provider plays the model: in session
// mode it calls runtime.dispatchMcp in the middle of its turn, in envelope mode it answers with tool_calls. No CLI, no network.

// A valid 1x1 PNG (the store checks the extension, the UI shows the file).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const words = count => Array.from({ length: count }, (_, index) => `step${index}`).join(' ')

function fixture(t) {
  const root = folder(t), ws = path.join(root, 'ws'), other = path.join(root, 'other')
  fs.mkdirSync(ws); fs.mkdirSync(other)
  const store = new CapabilityStore(path.join(root, 'data'))
  // A counter flush that fires after the folder is gone would write the file again.
  t.after(() => { clearTimeout(store.timer); store.timer = null; store.dirty = false })
  return { root, ws, other, store }
}
// A package folder as an agent builds it: a manifest, a script, a reference and two pictures.
function packageFolder(fx, manifest = {}) {
  const dir = path.join(fx.root, 'pack')
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ name: 'Modeller', role: '3D modeller for stylised props', instructions: 'PLAYBOOK_MARK run build.py, then judge the renders.', ...manifest }))
  fs.writeFileSync(path.join(dir, 'build.py'), 'print("build")\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Modeller\n')
  for (const name of ['a.png', 'b.png']) fs.writeFileSync(path.join(dir, 'shots', name), PNG)
  return dir
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
// An agent put into the store directly (the setup of the tests that are not about agent_save).
const addAgent = (fx, input = {}, agent = {}) => fx.store.save({ name: 'Modeller', whenToUse: 'stylised 3D props', instructions: 'PLAYBOOK_MARK model the prop, render it, judge it.', scope: 'project', workspace: fx.ws, ...input, agent: { role: '3D modeller', ...agent } }).entry

// Session mode: `script(call, { runtime, options, runId })` plays the root in the middle of its first turn, `helper` plays a helper. `call(tool, args)` is
// dispatchMcp's answer ({ok, observation, error, text}). An error thrown by a script is rethrown here, not turned into a failed run.
async function sessionRun(fx, script, { helper, extra, store = fx.store } = {}) {
  const calls = []
  let thrown
  const runtime = new OrbitRuntime({ ...session(), capabilityStore: store, runProvider: async options => {
    const [, name] = agentOf(options)
    calls.push({ name, options })
    const call = (toolName, args = {}) => runtime.dispatchMcp(options.session.token, toolName, args)
    const context = { runtime, options, get runId() { return [...runtime.runs.keys()][0] } }
    try {
      if (name === 'Orbit') return { text: options.session.resume ? 'FINAL' : (await script(call, context)) ?? 'ROOT_DONE' }
      return { text: (await helper?.(call, { ...context, name })) ?? `${name}_RESULT` }
    } catch (error) { thrown ??= error; return { text: 'SCRIPT_FAILED' } }
  } })
  const done = await finished(runtime, payload(fx.ws, extra))
  if (thrown) throw thrown
  assert.equal(done.snapshot.status, 'completed', done.snapshot.error)
  return { ...done, runtime, calls, run: runtime.runs.get(done.runId), promptOf: name => calls.find(item => item.name === name && !item.options.session.resume)?.options.prompt }
}
const ok = async (call, name, args) => { const answer = await call(name, args); assert.equal(answer.ok, true, `${name}: ${answer.error}`); return answer.observation }
const refused = async (call, name, args) => { const answer = await call(name, args); assert.equal(answer.ok, false, `${name} should be refused: ${answer.text}`); return answer.error }
const savedAgent = (call, input) => ok(call, 'agent_save', { name: 'Plain agent', role: 'does plain things', instructions: 'Do the plain thing.', ...input })

test('agent_save creates an agent from a package folder: the files land in the package, the result and the store agree', async t => {
  const fx = fixture(t), dir = packageFolder(fx)
  let saved, again, bare
  await sessionRun(fx, async call => {
    saved = await ok(call, 'agent_save', { fromDir: dir, whenToUse: 'low-poly props', kind: 'lookup', reasoningEffort: 'high', trainingMinutes: 42 })
    again = await refused(call, 'agent_save', { fromDir: dir })
    bare = await refused(call, 'agent_save', { name: 'No playbook', role: 'r' })
  })
  assert.equal(saved.ok, true)
  assert.deepEqual([saved.name, saved.scope, saved.version, saved.status, saved.rounds, saved.gallery], ['Modeller', 'project', 1, 'training', 0, 0])
  assert.equal(saved.lastScore, undefined)
  const files = walk(saved.package.dir).map(file => path.relative(saved.package.dir, file).split(path.sep).join('/')).sort()
  assert.ok(files.includes('build.py') && files.includes('README.md') && files.includes('shots/a.png') && files.includes('shots/b.png'), files.join(','))
  assert.equal(saved.package.files, files.length)
  assert.deepEqual(fs.readFileSync(path.join(saved.package.dir, 'shots', 'a.png')), PNG)
  const stored = fx.store.read(saved.id, fx.ws)
  assert.deepEqual([stored.agent.role, stored.agent.kind, stored.agent.reasoningEffort, stored.agent.status, stored.agent.trainingMinutes], ['3D modeller for stylised props', 'lookup', 'high', 'training', 42], 'the role comes from skill.json')
  assert.match(stored.instructions, /^PLAYBOOK_MARK/); assert.equal(stored.whenToUse, 'low-poly props')
  assert.match(again, /already exists.*pass its id/, 'a second create under the same name must not overwrite')
  assert.match(bare, /needs a name, a role and a playbook/)
  assert.equal(fx.store.list(fx.ws).length, 1)
})

test('agent_save by id appends rounds with automatic numbers; a used number, a bad score and a foreign id are refused', async t => {
  const fx = fixture(t)
  const skill = fx.store.save({ name: 'Just a skill', instructions: 'Do the skill thing in two steps.', scope: 'project', workspace: fx.ws }).entry
  let id, steps = {}, errors = {}
  await sessionRun(fx, async call => {
    id = (await savedAgent(call)).id
    steps.r1 = await ok(call, 'agent_save', { id, round: { score: 6.5, concepts: ['silhouette'], notes: 'first' } })
    steps.r2 = await ok(call, 'agent_save', { id, round: { score: 7.25, scores: [{ criterion: 'shape', score: 8 }], judges: ['opus'], at: '2026-01-02T03:04:05Z' } })
    steps.r3 = await ok(call, 'agent_save', { id, round: { score: 8, round: null, at: null, concepts: null, scores: null, judges: null, notes: null } })
    errors.repeat = await refused(call, 'agent_save', { id, round: { score: 5, round: 2 } })
    errors.noScore = await refused(call, 'agent_save', { id, round: { notes: 'no score' } })
    errors.range = await refused(call, 'agent_save', { id, round: { score: 11 } })
    errors.badAt = await refused(call, 'agent_save', { id, round: { score: 5, at: 'yesterday' } })
    errors.unknown = await refused(call, 'agent_save', { id: 'no-such-id-at-all', round: { score: 5 } })
    errors.skill = await refused(call, 'agent_save', { id: skill.id, round: { score: 5 } })
    steps.jump = await ok(call, 'agent_save', { id, round: { score: 3, round: 10 } })
    steps.after = await ok(call, 'agent_save', { id, round: { score: 9, notes: 'n'.repeat(2000) } })
    steps.keep = await ok(call, 'agent_save', { id, whenToUse: 'changed only this' })
  })
  assert.deepEqual([steps.r1.rounds, steps.r1.lastScore, steps.r2.rounds, steps.r2.lastScore, steps.r3.rounds, steps.r3.lastScore], [1, 6.5, 2, 7.25, 3, 8])
  assert.deepEqual([steps.r1.version, steps.r2.version, steps.r3.version], [2, 3, 4], 'every save is a version')
  assert.match(errors.repeat, /round 2 already exists/); assert.match(errors.noScore, /round\.score/); assert.match(errors.range, /0 to 10/); assert.match(errors.badAt, /ISO 8601/)
  assert.match(errors.unknown, /No trained agent with that id/); assert.match(errors.skill, /is a skill, not a trained agent/)
  const rounds = fx.store.read(id, fx.ws).agent.rounds
  assert.deepEqual(rounds.map(round => round.round), [1, 2, 3, 10, 11], 'the refused calls changed nothing; the next number follows the highest')
  assert.equal(rounds[1].at, '2026-01-02T03:04:05.000Z'); assert.deepEqual(rounds[1].scores, { shape: 8 }); assert.deepEqual(rounds[1].judges, ['opus'])
  assert.deepEqual(rounds[2].concepts, [])
  assert.equal(steps.jump.lastScore, 3, 'the last score is the newest NUMBER'); assert.equal(steps.after.lastScore, 9)
  assert.match(steps.after.note, /notes were cut to 1500/); assert.equal(rounds[4].notes.length, 1500)
  const kept = fx.store.read(id, fx.ws)
  assert.equal(kept.whenToUse, 'changed only this'); assert.equal(kept.agent.role, 'does plain things'); assert.equal(kept.instructions, 'Do the plain thing.'); assert.equal(kept.agent.rounds.length, 5)
})

test('an agent keeps at most 50 training rounds', async t => {
  const fx = fixture(t)
  let last, over
  await sessionRun(fx, async call => {
    const { id } = await savedAgent(call)
    for (let round = 1; round <= 50; round++) last = await ok(call, 'agent_save', { id, round: { score: round % 11 } })
    over = await refused(call, 'agent_save', { id, round: { score: 5 } })
  })
  assert.equal(last.rounds, 50); assert.match(over, /at most 50 training rounds/)
})

test('gallery: set, replace, clear and the refusals leave it as it was; a removed file drops out of it with a note', async t => {
  const fx = fixture(t), dir = packageFolder(fx)
  let id, set, replaced, cleared, withFiles, dropped
  const errors = {}, galleryOf = () => fx.store.read(id, fx.ws).agent.gallery
  await sessionRun(fx, async call => {
    id = (await ok(call, 'agent_save', { fromDir: dir })).id
    set = await ok(call, 'agent_save', { id, gallery: [{ file: 'shots/a.png', caption: 'A fox' }, { file: 'shots/b.png' }] })
    replaced = await ok(call, 'agent_save', { id, gallery: [{ file: 'shots/b.png', caption: null }] })
    errors.notPicture = await refused(call, 'agent_save', { id, gallery: [{ file: 'README.md' }] })
    errors.missing = await refused(call, 'agent_save', { id, gallery: [{ file: 'shots/zzz.png' }] })
    errors.twice = await refused(call, 'agent_save', { id, gallery: [{ file: 'shots/a.png' }, { file: 'shots/a.png' }] })
    errors.escape = await refused(call, 'agent_save', { id, gallery: [{ file: '../a.png' }] })
    errors.many = await refused(call, 'agent_save', { id, gallery: Array.from({ length: 25 }, (_, index) => ({ file: `shots/${index}.png` })) })
    errors.notList = await refused(call, 'agent_save', { id, gallery: 'shots/a.png' })
    withFiles = await ok(call, 'agent_save', { id, files: [{ path: 'shots/c.webp', content: 'x' }], gallery: [{ file: 'shots/b.png' }, { file: 'shots/c.webp', caption: 'new' }] })
    dropped = await ok(call, 'agent_save', { id, removeFiles: ['shots/b.png'] })
    cleared = await ok(call, 'agent_save', { id, gallery: [] })
  })
  assert.equal(set.gallery, 2); assert.equal(replaced.gallery, 1)
  assert.match(errors.notPicture, /not a picture/); assert.match(errors.missing, /not a file of this agent's package/); assert.match(errors.twice, /twice/)
  assert.match(errors.escape, /package file path/); assert.match(errors.many, /at most 24/); assert.match(errors.notList, /must be an array/)
  assert.equal(withFiles.gallery, 2, 'a picture written by the same call counts')
  assert.match(dropped.note, /Dropped from the gallery.*shots\/b\.png/); assert.equal(dropped.gallery, 1)
  assert.equal(cleared.gallery, 0); assert.deepEqual(galleryOf(), [])
  assert.ok(fs.existsSync(path.join(fx.store.read(id, fx.ws).package.dir, 'shots', 'c.webp')))
})

test('agent_read: the list shows enabled agents only; one agent whole has the playbook last, the newest rounds, the whole history and counts a use once per run', async t => {
  const fx = fixture(t), dir = packageFolder(fx)
  const off = addAgent(fx, { name: 'Switched off', instructions: 'Hidden playbook text' }, { role: 'hidden role' })
  fx.store.setEnabled(off.id, false, fx.ws)
  const empty = new CapabilityStore(path.join(fx.root, 'empty-data'))
  t.after(() => { clearTimeout(empty.timer); empty.timer = null })
  let none, list, whole, byPrefix, byName, errors = {}, id
  await sessionRun(fx, async call => {
    id = (await ok(call, 'agent_save', { fromDir: dir, kind: 'review', reasoningEffort: 'xhigh', gallery: [{ file: 'shots/a.png', caption: 'fox' }] })).id
    for (let round = 1; round <= 10; round++) await ok(call, 'agent_save', { id, round: { score: round, notes: round === 3 ? 'z'.repeat(1000) : `note ${round}`, concepts: [`c${round}`] } })
    list = await ok(call, 'agent_read', {})
    whole = await ok(call, 'agent_read', { id })
    byPrefix = await ok(call, 'agent_read', { id: id.slice(0, 8) })
    byName = await ok(call, 'agent_read', { id: 'Modeller' })
    errors.short = await refused(call, 'agent_read', { id: id.slice(0, 4) })
    errors.unknown = await refused(call, 'agent_read', { id: 'Nobody' })
    errors.off = await refused(call, 'agent_read', { id: off.id })
    errors.skill = await refused(call, 'agent_read', { id: fx.store.save({ name: 'A skill', instructions: 'Do the skill thing.', scope: 'project', workspace: fx.ws }).entry.id })
  }, { extra: {} })
  void none
  assert.deepEqual(list.agents.map(item => item.name), ['Modeller'], 'the switched-off agent is not listed')
  assert.deepEqual(Object.keys(list.agents[0]).sort(), ['id', 'kind', 'lastScore', 'name', 'reasoningEffort', 'reliability', 'role', 'rounds', 'scope', 'status', 'uses'])
  assert.deepEqual([list.agents[0].rounds, list.agents[0].lastScore, list.agents[0].kind, list.agents[0].reasoningEffort, list.agents[0].uses], [10, 10, 'review', 'xhigh', 0])
  assert.match(list.hint, /spawn_agent \{profile/)
  assert.equal(Object.keys(whole).at(-1), 'playbook'); assert.match(whole.playbook, /^PLAYBOOK_MARK/)
  assert.deepEqual([whole.id, whole.name, whole.role, whole.status, whole.scope, whole.kind, whole.reasoningEffort], [id, 'Modeller', '3D modeller for stylised props', 'training', 'project', 'review', 'xhigh'])
  assert.deepEqual(whole.rounds.map(round => round.round), [3, 4, 5, 6, 7, 8, 9, 10], 'the newest eight in full')
  assert.equal(whole.roundsOmitted, 2); assert.ok(whole.rounds[0].notes.length <= 610, `notes are cut: ${whole.rounds[0].notes.length}`)
  assert.deepEqual(whole.training.history.map(item => item.round), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); assert.equal(whole.training.rounds, 10); assert.equal(whole.training.lastScore, 10)
  assert.deepEqual(whole.gallery, [{ file: 'shots/a.png', caption: 'fox' }]); assert.ok(whole.files.length >= 4); assert.ok(whole.package.dir)
  assert.match(whole.note, /spawn_agent \{profile/); assert.match(whole.note, /capability_feedback/)
  assert.deepEqual([byPrefix.id, byName.id], [id, id])
  assert.match(errors.short, /No trained agent/); assert.match(errors.unknown, /No trained agent/); assert.match(errors.off, /switched off by the user/); assert.match(errors.skill, /No trained agent/)
  assert.equal(fx.store.find(id, fx.ws).uses, 1, 'four reads in one run are one use')
  await sessionRun(fx, call => ok(call, 'agent_read', { id }))
  assert.equal(fx.store.find(id, fx.ws).uses, 2, 'the next run is another use')
  await sessionRun({ ...fx, store: empty }, async call => { none = await ok(call, 'agent_read', {}) }, { store: empty })
  assert.deepEqual(none.agents, []); assert.match(none.hint, /agent_save creates one/)
})

test('a playbook near the limit comes back whole from agent_read: through the session path and into the next envelope prompt', async t => {
  const fx = fixture(t)
  const playbook = `PLAYBOOK_START ${words(4500)} PLAYBOOK_END`
  assert.ok(playbook.length > 39000 && playbook.length <= 40000, String(playbook.length))
  let id, read
  const { run } = await sessionRun(fx, async call => {
    id = (await ok(call, 'agent_save', { name: 'Long', role: 'long playbook', instructions: playbook })).id
    read = await call('agent_read', { id })
  })
  assert.equal(read.ok, true)
  assert.ok(read.text.length > 40000, `the observation is longer than the usual output limit: ${read.text.length}`)
  assert.equal(JSON.parse(read.text).playbook, playbook)
  const remembered = run.agentNodes.get('root').transcript.find(entry => entry.type === 'tool_result' && entry.name === 'agent_read')
  assert.equal(remembered.result, read.text, 'the transcript entry the runtime keeps is not cut'); assert.ok(!remembered.result.includes('[truncated]'))

  // The envelope path: the observation enters the transcript and the next prompt whole, the saved payload does not repeat the playbook.
  const second = fixture(t), prompts = []
  let step = 0
  const runtime = new OrbitRuntime({ capabilityStore: second.store, runProvider: async ({ prompt }) => {
    prompts.push(prompt)
    if (++step === 1) return response(tool('agent_save', { name: 'Long', role: 'long playbook', instructions: playbook }))
    if (step === 2) return response(tool('agent_read', { id: 'Long' }))
    return { text: 'done' }
  } })
  const { snapshot, runId } = await envelopeFinished(runtime, envelopePayload(second.ws))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const entry = runtime.runs.get(runId).agentNodes.get('root').transcript.find(item => item.type === 'tool_result' && item.name === 'agent_read')
  assert.ok(entry.result.length > 40000 && !entry.result.includes('[truncated]') && entry.result.includes('PLAYBOOK_END'))
  const last = prompts.at(-1)
  assert.ok(last.includes('PLAYBOOK_END') && !last.includes('[truncated]'), 'the prompt window keeps the whole read')
  assert.equal(last.split('PLAYBOOK_START').length - 1, 1, 'the call that saved it was stored without its payload')
  assert.match(last, /Payload omitted after execution/)
})

// ---- spawn_agent {profile} ----------------------------------------------------------------------------------------

const BIG_TASK = 'TASK_ONE draw the fox'
test('spawn_agent {profile}: the helper starts as the agent: block, playbook and task in that order, defaults, one use however it was reached', async t => {
  const fx = fixture(t), dir = packageFolder(fx)
  const agent = addAgent(fx, { name: 'Modeller', instructions: 'PLAYBOOK_ONLY_MARK step one, step two, verify with renders.', fromDir: dir }, { role: '3D modeller', kind: 'review', reasoningEffort: 'high' })
  const packageDir = fx.store.read(agent.id, fx.ws).package.dir
  let read, one, two, again, waited
  const out = await sessionRun(fx, async call => {
    read = await ok(call, 'agent_read', { id: agent.id })
    one = await ok(call, 'spawn_agent', { profile: agent.id.slice(0, 8), task: BIG_TASK, reason: 'needs a modeller' })
    two = await ok(call, 'spawn_agent', { profile: 'Modeller', name: 'Second', task: 'TASK_TWO', reason: 'second opinion', reasoningEffort: 'medium', kind: 'text' })
    again = await ok(call, 'spawn_agent', { profile: agent.id, task: 'TASK_AGAIN', reason: 'same name again' })
    waited = await ok(call, 'wait_agent', {})
  })
  assert.equal(one.ok, true, JSON.stringify(one)); assert.equal(one.name, 'Modeller', 'the name defaults to the agent\'s')
  assert.deepEqual([one.profile.id, one.profile.name, one.profile.role], [agent.id, 'Modeller', '3D modeller']); assert.match(one.profile.note, /capability_feedback/)
  assert.equal(one.routed.kind, 'review', 'the kind defaults to the agent\'s, routing then applies'); assert.equal(one.reasoningEffort, 'high')
  assert.deepEqual([two.name, two.routed.kind, two.reasoningEffort, two.profile.id], ['Second', 'text', 'medium', agent.id], 'explicit values win')
  assert.equal(again.ok, true); assert.equal(again.reused, undefined, 'a second helper of the same agent is not a reuse of the first')
  assert.equal(again.name, 'Modeller 2', 'without a name it takes a free one'); assert.equal(again.profile.id, agent.id)
  const prompt = out.promptOf('Modeller')
  const at = text => { const index = prompt.indexOf(text); assert.ok(index >= 0, `the prompt has ${text}`); return index }
  const order = [at('YOUR CURRENT TASK:\nYOU ARE "Modeller", a trained Orbit agent (3D modeller)'), at(`PACKAGE FOLDER (scripts, references): ${packageDir}`), at('PLAYBOOK:\nPLAYBOOK_ONLY_MARK step one'), at(`TASK FROM YOUR PARENT:\n${BIG_TASK}`)]
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'block, package, playbook, task')
  assert.ok(out.promptOf('Second').includes('TASK FROM YOUR PARENT:\nTASK_TWO') && !out.promptOf('Second').includes('TASK FROM YOUR PARENT:\nTASK_ONE'))
  const record = out.run.agentNodes.get(one.agentId)
  assert.equal(record.task, BIG_TASK, 'the visible task is the caller\'s'); assert.equal(record.reasoningEffort, 'high')
  assert.ok(out.promptOf('Modeller 2').includes('TASK FROM YOUR PARENT:\nTASK_AGAIN') && out.promptOf('Modeller 2').includes('PLAYBOOK_ONLY_MARK'), 'the third helper runs its own task with the playbook')
  assert.equal(fx.store.find(agent.id, fx.ws).uses, 1, 'agent_read and three spawns are one use'); assert.ok(out.run.agentUse.has(agent.id))
  assert.equal(waited.length, 3)
  // Another run that only spawns is another use.
  await sessionRun(fx, async call => { await ok(call, 'spawn_agent', { profile: 'Modeller', task: 'T', reason: 'r' }); await ok(call, 'wait_agent', {}) })
  assert.equal(fx.store.find(agent.id, fx.ws).uses, 2)
})

test('a helper started as an agent shows its identity but never the playbook: not in the snapshot, the events, the traces or the work log', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { instructions: 'PLAYBOOK_SECRET_MARK do the thing carefully.' })
  const out = await sessionRun(fx, async call => {
    await ok(call, 'spawn_agent', { profile: agent.id, task: 'visible task', reason: 'because' })
    await ok(call, 'wait_agent', {})
  })
  const helper = out.snapshot.agents.find(item => item.name === 'Modeller')
  assert.deepEqual(helper.profile, { id: agent.id, name: 'Modeller', role: '3D modeller' })
  assert.equal(helper.profilePrompt, undefined)
  assert.equal(helper.task, 'visible task')
  const everything = JSON.stringify([out.snapshot, out.events, out.run.traces, out.runtime.getRuns()])
  assert.ok(!everything.includes('PLAYBOOK_SECRET_MARK'), 'the playbook stays in the prompt')
  assert.ok(!everything.includes('YOU ARE "Modeller"'))
  assert.ok(out.events.some(event => event.type === 'agent.created' && event.agent.profile?.id === agent.id), 'the created event carries the profile')
})

test('spawn_agent refusals: unknown, switched off and invalid profiles start nothing and count nothing; a caller\'s `trained` is dropped', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { instructions: 'REAL_PLAYBOOK_MARK real work.' })
  const off = addAgent(fx, { name: 'Off agent' })
  fx.store.setEnabled(off.id, false, fx.ws)
  const answers = {}
  const out = await sessionRun(fx, async (call, { runtime, runId }) => {
    const spawn = args => runtime.spawnSubAgent(runId, 'root', { task: 'T', reason: 'r', ...args })
    answers.unknown = await spawn({ profile: 'no-such-agent' })
    answers.short = await spawn({ profile: agent.id.slice(0, 4) })
    answers.off = await spawn({ profile: off.id })
    answers.blank = await spawn({ profile: '   ' })
    answers.number = await spawn({ profile: 5 })
    answers.registry = await call('spawn_agent', { task: 'T', reason: 'r', profile: 5 })
    answers.skill = await spawn({ profile: fx.store.save({ name: 'A skill', instructions: 'Do the skill thing.', scope: 'project', workspace: fx.ws }).entry.id })
    answers.nothing = await spawn({ profile: '', name: 'Plain' })
    answers.evil = await spawn({ name: 'Sneaky', trained: { id: 'x', name: 'Evil', role: 'r', prompt: 'EVIL_PROMPT' } })
    answers.mixed = await spawn({ profile: agent.id, name: 'Mixed', trained: { id: 'x', name: 'Evil', role: 'r', prompt: 'EVIL_PROMPT' } })
    await call('wait_agent', {})
  })
  assert.deepEqual([answers.unknown.ok, answers.unknown.reason], [false, 'unknown_profile']); assert.match(answers.unknown.instruction, /agent_read without an id lists them/)
  assert.equal(answers.short.reason, 'unknown_profile', 'a prefix needs six characters')
  assert.deepEqual([answers.off.ok, answers.off.reason], [false, 'profile_disabled']); assert.match(answers.off.instruction, /switched off/)
  assert.deepEqual([answers.blank.ok, answers.blank.reason, answers.number.ok, answers.number.reason], [false, 'invalid_profile', false, 'invalid_profile'])
  assert.equal(answers.registry.ok, false); assert.match(answers.registry.error, /profile must be a string/)
  assert.equal(answers.skill.reason, 'unknown_profile', 'a skill is not an agent')
  assert.equal(answers.nothing.ok, true); assert.equal(answers.nothing.profile, undefined, 'an empty profile is no profile')
  assert.equal(answers.evil.profile, undefined)
  assert.equal(answers.mixed.profile.id, agent.id)
  assert.deepEqual([...out.run.agentNodes.values()].map(item => item.name).sort(), ['Mixed', 'Orbit', 'Plain', 'Sneaky'], 'only the accepted calls made helpers')
  assert.equal(out.run.agentNodes.get(answers.evil.agentId).profile, undefined)
  for (const name of ['Plain', 'Sneaky']) assert.ok(!out.promptOf(name).includes('EVIL_PROMPT') && !out.promptOf(name).includes('a trained Orbit agent'))
  assert.ok(out.promptOf('Mixed').includes('REAL_PLAYBOOK_MARK') && !out.promptOf('Mixed').includes('EVIL_PROMPT'), 'the agent\'s own block replaces a caller\'s')
  assert.equal(fx.store.find(agent.id, fx.ws).uses, 1); assert.equal(fx.store.find(off.id, fx.ws).uses, 0)
})

test('a follow-up of a helper that runs as an agent keeps the playbook: in an envelope prompt, and in a session that had to start afresh', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { instructions: 'PLAYBOOK_FOLLOW_MARK keep to the checklist.' })
  const prompts = [], names = []
  let turn = 0
  const runtime = new OrbitRuntime({ capabilityStore: fx.store, runProvider: async ({ prompt }) => {
    const [, name] = identity(prompt)
    if (name === 'Orbit') {
      if (++turn === 1) return response(tool('spawn_agent', { profile: agent.id, task: 'FIRST_TASK', reason: 'r' }), tool('wait_agent'))
      if (turn === 2) return response(tool('followup_agent', { agentId: 'Modeller', task: 'SECOND_TASK' }), tool('wait_agent'))
      return { text: 'done' }
    }
    names.push(name); prompts.push(prompt)
    return { text: `${name}_ANSWER_${prompts.length}` }
  } })
  const { snapshot } = await envelopeFinished(runtime, envelopePayload(fx.ws))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.equal(prompts.length, 2, names.join(','))
  assert.ok(prompts[0].includes('TASK FROM YOUR PARENT:\nFIRST_TASK'))
  assert.ok(prompts[1].includes('PLAYBOOK_FOLLOW_MARK') && prompts[1].includes('YOU ARE "Modeller"'), 'the follow-up prompt carries the playbook')
  assert.ok(prompts[1].includes('TASK FROM YOUR PARENT:\nSECOND_TASK'), 'and the new task')
  assert.equal(snapshot.agents.find(item => item.name === 'Modeller').profile.id, agent.id)

  // Session mode: the follow-up resumes the session that already holds the playbook; a session that was lost starts with the whole prompt.
  const out = await sessionRun(fx, async (call, { runtime: live, runId }) => {
    await ok(call, 'spawn_agent', { profile: agent.id, task: 'S_FIRST', reason: 'r' }); await ok(call, 'wait_agent', {})
    await ok(call, 'followup_agent', { agentId: 'Modeller', task: 'S_SECOND' }); await ok(call, 'wait_agent', {})
    live.runs.get(runId).agentNodes.forEach(item => { if (item.name === 'Modeller') item.sessionId = null })
    await ok(call, 'followup_agent', { agentId: 'Modeller', task: 'S_THIRD' }); await ok(call, 'wait_agent', {})
  })
  const turns = out.calls.filter(item => item.name === 'Modeller').map(item => item.options)
  assert.equal(turns.length, 3)
  assert.deepEqual(turns.map(item => item.session.resume), [false, true, false])
  assert.equal(turns[1].session.id, turns[0].session.id, 'the second turn resumes the same session')
  assert.ok(turns[2].prompt.includes('PLAYBOOK_FOLLOW_MARK') && turns[2].prompt.includes('TASK FROM YOUR PARENT:\nS_THIRD'))
  assert.ok(!turns[0].session.systemAppend.includes('PLAYBOOK_FOLLOW_MARK'), 'the playbook is in the task, not in the stable system block')
})

// ---- prompt blocks -------------------------------------------------------------------------------------------------

const agentsBlock = prompt => prompt.match(/AGENTS \(trained specialists; spawn_agent \{profile\}; agent_read \{id\} for details\):\n([\s\S]*?)(?:\n[A-Z][A-Za-z ]+:|$)/)?.[1]
const skillsBlock = prompt => prompt.match(/SKILLS \(procedures and packages from earlier work; capability_read \{id\} loads one\):\n([\s\S]*?)(?:\nAGENTS \(|$)/)?.[1]

test('the AGENTS block: none without agents, a switched-off one is left out, ranked by the task, formatted with tier, status and score', async t => {
  const fx = fixture(t)
  const { prompt: plain } = (await sessionRun(fx, () => 'x')).calls[0].options
  assert.ok(!plain.includes('AGENTS (trained specialists'), 'no agent, no block')
  const fox = addAgent(fx, { name: 'Fox modeller', whenToUse: 'animals', instructions: 'Model foxes and other animals in Blender with fur cards.' }, { role: 'models foxes and animals' })
  const sql = addAgent(fx, { name: 'SQL tuner', whenToUse: 'slow queries', instructions: 'Tune slow database queries with explain plans and indexes.' }, { role: 'tunes slow database queries' })
  const ghost = addAgent(fx, { name: 'Ghost agent', instructions: 'Tune slow database queries with ghosts.' }, { role: 'database ghost' })
  fx.store.setEnabled(ghost.id, false, fx.ws)
  fx.store.save({ id: fox.id, name: 'Fox modeller', instructions: fx.store.read(fox.id, fx.ws).instructions, scope: 'project', workspace: fx.ws, agent: { round: { score: 8.5 } } })
  fx.store.save({ name: 'Global scribe', instructions: 'Write short release notes from a changelog.', scope: 'global', agent: { role: 'writes release notes' } })
  const lines = prompt => agentsBlock(prompt).split('\n').filter(line => line.startsWith('- '))
  const sqlFirst = (await sessionRun(fx, () => 'x', { extra: { prompt: 'speed up the slow database query' } })).calls[0].options.prompt
  const names = lines(sqlFirst).map(line => line.match(/\] (.+?) — /)[1])
  assert.deepEqual(names, ['SQL tuner', 'Fox modeller', 'Global scribe'], 'the match for the task first, then the judged, then the rest')
  assert.ok(!sqlFirst.includes('Ghost agent'), 'a switched-off agent is not offered')
  assert.match(lines(sqlFirst)[0], new RegExp(`^- ${sql.id.slice(0, 12)} \\[this project, training, not judged\\] SQL tuner — tunes slow database queries$`))
  assert.match(lines(sqlFirst)[1], /\[this project, training, last score 8\.5\/10\] Fox modeller — models foxes and animals$/)
  assert.match(lines(sqlFirst)[2], /\[all projects, training, not judged\] Global scribe — writes release notes$/)
  const foxFirst = (await sessionRun(fx, () => 'x', { extra: { prompt: 'model a fox with fur' } })).calls[0].options.prompt
  assert.equal(lines(foxFirst)[0].match(/\] (.+?) — /)[1], 'Fox modeller')
  // A helper gets the block too, ranked by its own task and reason.
  const out = await sessionRun(fx, async call => { await ok(call, 'spawn_agent', { name: 'Helper', task: 'tune the database indexes', reason: 'slow queries' }); await ok(call, 'wait_agent', {}) })
  assert.equal(lines(out.promptOf('Helper'))[0].match(/\] (.+?) — /)[1], 'SQL tuner')
  assert.ok(out.promptOf('Orbit').includes('AGENTS (trained specialists'))
  void ghost
})

test('the AGENTS block shows at most six agents within its budget and says how many more there are', async t => {
  const fx = fixture(t)
  for (let index = 0; index < 9; index++) addAgent(fx, { name: `Specialist number ${index} of the long named agents`, instructions: `Playbook ${index} about topic${index}.` }, { role: `does the very specific work number ${index} that needs a role of a rather long line to fill the room of the block` })
  const prompt = (await sessionRun(fx, () => 'x')).calls[0].options.prompt
  const block = agentsBlock(prompt), lines = block.split('\n')
  const entries = lines.filter(line => line.startsWith('- '))
  assert.ok(entries.length >= 1 && entries.length <= 6, String(entries.length))
  assert.match(lines.at(-1), new RegExp(`^\\(${9 - entries.length} more agents stored: agent_read lists them\\)$`))
  assert.ok(entries.join('\n').length <= 1200, `the entries fit the budget: ${entries.join('\n').length}`)
})

test('agents are not skills: the SKILLS block, capability_list and capability_search are unchanged by them', async t => {
  const fx = fixture(t)
  const skill = fx.store.save({ name: 'Release routine', whenToUse: 'cutting a release', description: 'Bump, tag, publish', instructions: 'Bump the version, tag it, publish the package.', scope: 'project', workspace: fx.ws }).entry
  const before = skillsBlock((await sessionRun(fx, () => 'x', { extra: { prompt: 'cut a release and model a fox' } })).calls[0].options.prompt)
  addAgent(fx, { name: 'Fox modeller', whenToUse: 'cut a release of foxes', instructions: 'Model foxes. Cut a release of the model.' }, { role: 'models foxes, release notes' })
  let listed, searched
  const after = (await sessionRun(fx, async call => {
    listed = await ok(call, 'capability_list', {})
    searched = await ok(call, 'capability_search', { query: 'fox model release' })
  }, { extra: { prompt: 'cut a release and model a fox' } })).calls[0].options.prompt
  assert.ok(before.includes('Release routine')); assert.equal(skillsBlock(after), before, 'the SKILLS block did not change')
  assert.ok(!skillsBlock(after).includes('Fox modeller') && agentsBlock(after).includes('Fox modeller'))
  assert.deepEqual(listed.map(item => item.name), ['Release routine']); assert.deepEqual(searched.map(item => item.name), ['Release routine'])
  assert.equal(listed[0].id, skill.id)
})

// ---- rating an agent, the tools that are not for it ----------------------------------------------------------------

test('capability_feedback rates an agent: record, pitfall in agent_read and in the next helper\'s prompt; the skill reminder does not track it', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { name: 'Modeller' })
  const skill = fx.store.save({ name: 'Unrelated skill', instructions: 'Do the unrelated thing in three steps.', scope: 'project', workspace: fx.ws }).entry
  let failed, worked, detail, listed
  const out = await sessionRun(fx, async call => {
    await ok(call, 'spawn_agent', { profile: agent.id, task: 'bake textures', reason: 'r' }); await ok(call, 'wait_agent', {})
    failed = await ok(call, 'capability_feedback', { id: agent.id, outcome: 'failed', note: 'texture bake needs a UV unwrap first' })
    worked = await ok(call, 'capability_feedback', { id: agent.id.slice(0, 8), outcome: 'worked', note: 'ignored for a success' })
    detail = await ok(call, 'agent_read', { id: agent.id })
    listed = await ok(call, 'agent_read', {})
  })
  assert.equal(failed.agent, true); assert.deepEqual([failed.uses, failed.id, failed.name], [1, agent.id, 'Modeller']); assert.equal(failed.reliability, 0.33)
  assert.equal(worked.agent, true); assert.equal(worked.reliability, 0.5)
  assert.equal(out.run.skillUse.size, 0, 'an agent never enters the skill-learning list')
  const record = fx.store.find(agent.id, fx.ws)
  assert.deepEqual([record.uses, record.successes, record.failures, record.lessons], [1, 1, 1, ['texture bake needs a UV unwrap first']])
  assert.deepEqual([detail.pitfalls, detail.successes, detail.failures, detail.reliability], [['texture bake needs a UV unwrap first'], 1, 1, 0.5])
  assert.equal(listed.agents[0].reliability, 0.5)
  const next = await sessionRun(fx, async call => { await ok(call, 'spawn_agent', { profile: 'Modeller', task: 'again', reason: 'r' }); await ok(call, 'wait_agent', {}) })
  assert.ok(next.promptOf('Modeller').includes('KNOWN PITFALLS (from earlier uses):\n- texture bake needs a UV unwrap first'))
  assert.ok(next.promptOf('Modeller').indexOf('KNOWN PITFALLS') > next.promptOf('Modeller').indexOf('PLAYBOOK:') && next.promptOf('Modeller').indexOf('KNOWN PITFALLS') < next.promptOf('Modeller').indexOf('TASK FROM YOUR PARENT'))
  // A switched-off agent cannot be rated, as a skill cannot.
  fx.store.setEnabled(agent.id, false, fx.ws)
  const off = await sessionRun(fx, call => refused(call, 'capability_feedback', { id: agent.id, outcome: 'worked' }).then(error => assert.match(error, /switched off/)))
  void off; void skill
})

test('capability_read of an agent points to agent_read and counts nothing; capability_install cannot change an agent, a skill with its name stays a separate skill', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { name: 'Modeller' })
  let read, install, sameName
  const out = await sessionRun(fx, async call => {
    read = await refused(call, 'capability_read', { id: agent.id })
    install = await refused(call, 'capability_install', { id: agent.id, name: 'Modeller', instructions: 'Overwrite the playbook with a skill text.' })
    sameName = await ok(call, 'capability_install', { name: 'Modeller', description: 'a skill', instructions: 'A skill that happens to share the name of an agent.' })
  })
  assert.match(read, /trained agent, not a skill: agent_read \{id\}/); assert.match(install, /trained agent: change it with agent_save/)
  assert.equal(out.run.skillUse.size, 0); assert.equal(fx.store.find(agent.id, fx.ws).uses, 0)
  const stored = fx.store.read(agent.id, fx.ws)
  assert.deepEqual([stored.version, stored.instructions.startsWith('PLAYBOOK_MARK')], [1, true], 'the agent is untouched')
  assert.notEqual(sameName.id, agent.id); assert.equal(fx.store.list(fx.ws).filter(item => item.name === 'Modeller').length, 2)
})

test('the "what did you learn" reminder lists a skill that was read and not rated, never an agent that was used and not rated', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { name: 'Modeller' })
  const skill = fx.store.save({ name: 'Unrated skill', instructions: 'Do the unrated thing in three steps.', scope: 'project', workspace: fx.ws }).entry
  const play = async (calls, extra = {}) => {
    const prompts = []
    let turn = 0
    const runtime = new OrbitRuntime({ capabilityStore: fx.store, runProvider: async ({ prompt }) => { prompts.push(prompt); return ++turn === 1 ? response(...calls) : { text: 'answer' } } })
    const { snapshot } = await envelopeFinished(runtime, envelopePayload(fx.ws, extra))
    assert.equal(snapshot.status, 'completed', snapshot.error)
    return prompts
  }
  const onlyAgent = await play([tool('agent_read', { id: agent.id })])
  assert.ok(!onlyAgent.some(prompt => prompt.includes('capture what this work taught')), 'an agent alone does not trigger the reminder')
  assert.equal(onlyAgent.length, 2)
  const both = await play([tool('capability_read', { id: skill.id }), tool('agent_read', { id: agent.id }), tool('spawn_agent', { profile: agent.id, task: 'T', reason: 'r' }), tool('wait_agent')], { chatId: 'chat-2' })
  const reminder = both.find(prompt => prompt.includes('capture what this work taught'))
  assert.ok(reminder, 'the skill triggers it')
  // The prompt carries the transcript as JSON, so the list's quotes are escaped.
  const asked = reminder.slice(reminder.indexOf('Report how the skills you loaded turned out'), reminder.indexOf('(2) If you worked out'))
  assert.ok(asked.includes(skill.id.slice(0, 12)) && asked.includes('Unrated skill'), asked)
  assert.ok(!asked.includes(agent.id.slice(0, 12)) && !asked.includes('Modeller'), 'only the skill is asked about')
})

// ---- the scope guard ------------------------------------------------------------------------------------------------

test('agent_save scope global: a clean agent is shared, one naming the project (playbook, round notes or caption) stays in it, and updating a shared agent keeps it shared', async t => {
  const fx = fixture(t)
  const dir = packageFolder(fx, { instructions: 'Generic modelling advice without any project reference.' })
  const results = {}
  await sessionRun(fx, async call => {
    results.clean = await ok(call, 'agent_save', { name: 'Generic modeller', role: 'general 3D modeller', instructions: 'Keep silhouettes strong; check scale against a human.', scope: 'global' })
    results.path = await ok(call, 'agent_save', { name: 'Project bound', role: 'role', instructions: `Run ${path.join(fx.ws, 'build.py')} first.`, scope: 'global' })
    results.round = await ok(call, 'agent_save', { name: 'Notes bound', role: 'role', instructions: 'Generic text.', scope: 'global', round: { score: 5, notes: `see ${path.join(fx.ws, 'renders')}` } })
    results.fromDir = await ok(call, 'agent_save', { fromDir: dir, name: 'From folder', scope: 'global', gallery: [{ file: 'shots/a.png', caption: `render of ${path.join(fx.ws, 'a')}` }] })
    results.update = await ok(call, 'agent_save', { id: results.clean.id, round: { score: 7 } })
    results.updateScoped = await ok(call, 'agent_save', { id: results.clean.id, scope: 'global', round: { score: 8 } })
    results.named = await refused(call, 'agent_save', { id: results.clean.id, round: { score: 1, notes: `see ${path.join(fx.ws, 'renders')}` } })
    results.moved = await refused(call, 'agent_save', { id: results.clean.id, scope: 'project', round: { score: 2 } })
    results.movedUp = await refused(call, 'agent_save', { id: results.path.id, scope: 'global', round: { score: 2 } })
  })
  assert.deepEqual([results.clean.scope, results.clean.demoted], ['global', undefined])
  for (const name of ['path', 'round', 'fromDir']) {
    assert.deepEqual([name, results[name].scope, results[name].demoted], [name, 'project', true])
    assert.match(results[name].note, /Saved to this PROJECT's agents instead of the shared library: it names/)
  }
  assert.deepEqual(fx.store.agents(fx.other).map(item => item.name), ['Generic modeller'], 'only the clean one reaches another project')
  assert.equal(results.update.scope, 'global', 'an update by id keeps the agent\'s scope without repeating it')
  assert.equal(results.updateScoped.rounds, 2)
  assert.match(results.named, /is shared with every project, so what you save cannot name this project/); assert.equal(fx.store.read(results.clean.id, fx.ws).agent.rounds.length, 2, 'the refused update changed nothing')
  assert.match(results.moved, /is a shared agent and an agent's scope cannot be changed: save a new agent in the other scope/)
  assert.match(results.movedUp, /is a project agent and an agent's scope cannot be changed/)
  assert.equal(fx.store.read(results.path.id, fx.ws).scope, 'project')
})

test('agent_save scope global: sharing switched off for the project or a project-only worker keeps the agent in the project', async t => {
  const fx = fixture(t)
  const make = (name, scope = 'global') => ({ name, role: 'r', instructions: 'Clean, generic playbook text.', scope })
  const results = {}
  await sessionRun(fx, async call => { results.optedOut = await ok(call, 'agent_save', make('Opted out')) }, { extra: { globalMemoryEnabled: false } })
  assert.deepEqual([results.optedOut.scope, results.optedOut.demoted], ['project', true]); assert.match(results.optedOut.note, /sharing is switched off for this project or worker/)
  let sharedId
  await sessionRun(fx, async call => {
    sharedId = (await ok(call, 'agent_save', make('Shared by root'))).id
    await ok(call, 'spawn_agent', { name: 'Worker', task: 'T1', reason: 'r' })
    await ok(call, 'spawn_agent', { name: 'Sharer', task: 'T2', reason: 'r', memoryProfile: 'project-global' })
    await ok(call, 'wait_agent', {})
  }, { helper: async (call, { name }) => {
    results[name] = await ok(call, 'agent_save', make(`${name} agent`))
    if (name === 'Worker') {
      // An update that adds a round is not sharing: a project-only worker may do it. What the update says is still checked.
      results.update = await ok(call, 'agent_save', { id: sharedId, round: { score: 1 } })
      results.updateNamed = await refused(call, 'agent_save', { id: sharedId, round: { score: 2, notes: `see ${path.join(fx.ws, 'renders')}` } })
    }
  } })
  assert.deepEqual([results.Worker.scope, results.Worker.demoted], ['project', true], 'a project-only worker cannot share')
  assert.deepEqual([results.Sharer.scope, results.Sharer.demoted], ['global', undefined], 'a worker with the global tier can')
  assert.deepEqual(fx.store.agents(fx.other).map(item => item.name).sort(), ['Shared by root', 'Sharer agent'], 'only the shared ones reach another project')
  assert.deepEqual([results.update.scope, results.update.rounds], ['global', 1], 'a round added by a project-only worker to a shared agent is accepted and the agent stays shared')
  assert.match(results.updateNamed, /cannot name this project/)
  assert.equal(fx.store.read(sharedId, fx.ws).agent.rounds.length, 1)
})

test('the registry lists agent_save and agent_read and spawn_agent takes a profile; calls are checked before they run', () => {
  const names = registry.TOOLS.map(item => item.name)
  assert.ok(names.includes('agent_save') && names.includes('agent_read'))
  assert.equal(registry.tool('spawn_agent').inputSchema.properties.profile.type, 'string')
  assert.equal(registry.tool('agent_read').inputSchema.required.length, 0)
  assert.match(registry.validate('agent_save', { name: 'x' }).error, /needs a name, a role and a playbook/)
  assert.equal(registry.validate('agent_save', { id: 'abc', round: { score: 5 } }).ok, true)
  assert.equal(registry.validate('agent_save', { fromDir: '/x' }).ok, true)
  assert.match(registry.validate('agent_save', { id: 'abc', round: { score: '5' } }).error, /round\.score must be a number/)
  assert.match(registry.validate('agent_save', { id: 'abc', kind: 'poet' }).error, /kind must be one of/)
  assert.equal(registry.validate('agent_save', { id: 'abc', kind: '', reasoningEffort: '' }).ok, true)
  assert.match(registry.validate('agent_save', { id: 'abc', gallery: [{ caption: 'no file' }] }).error, /gallery\[0\]\.file is required/)
})

test('a playbook that JSON escaping makes longer than one result holds is cut at its end and says so; a switched-off agent is named as an agent; the work log names both tools', async t => {
  const fx = fixture(t)
  const playbook = '"\n'.repeat(20000)
  let id, read, off
  const { run } = await sessionRun(fx, async call => {
    id = (await ok(call, 'agent_save', { name: 'Escapes', role: 'quote and newline heavy', instructions: playbook })).id
    read = await call('agent_read', { id })
    fx.store.setEnabled(id, false, fx.ws)
    off = await call('capability_feedback', { id, outcome: 'worked' })
  })
  assert.equal(read.ok, true)
  const body = JSON.parse(read.text)
  assert.match(body.playbookCut, /only the first \d+ of \d+ characters fit in one result/)
  assert.ok(body.playbook.length > 1000 && body.playbook.length < playbook.length)
  assert.ok(read.text.length <= 56000 && !read.text.includes('[truncated]'), `the result fits whole: ${read.text.length}`)
  assert.equal(Object.keys(body).at(-1), 'playbook', 'the playbook stays last')
  assert.match(off.error, /This trained agent is switched off/)
  const log = run.agentNodes.get('root').ledger.map(entry => entry.text)
  assert.ok(log.some(text => /agent_save Escapes → saved as project v1, 0 rounds, 0 files/.test(text)), log.join('\n'))
  assert.ok(log.some(text => /agent_read Escapes → loaded v1/.test(text)), log.join('\n'))
})

// ---- names of helpers started as an agent ------------------------------------------------------------------------------

test('parallel spawns of one agent are separate helpers with free names; an explicit name still reuses; names are clipped to 80 without a truncation mark', async t => {
  const fx = fixture(t)
  const agent = addAgent(fx, { name: 'Modeller', instructions: 'PLAYBOOK_NAMES_MARK model it.' }, { kind: 'review' })
  const longName = `Long ${'x'.repeat(100)}`
  const long = addAgent(fx, { name: longName, instructions: 'PLAYBOOK_LONG_MARK do it.' })
  assert.equal(fx.store.find(long.id, fx.ws).name.length, 105, 'the store keeps up to 120')
  let parallel, reused, first, second, waited
  const out = await sessionRun(fx, async call => {
    // The kind makes every spawn wait for the model routing, so the three registrations race.
    parallel = await Promise.all(['fox', 'bee', 'owl'].map(task => call('spawn_agent', { profile: agent.id, task: `TASK_${task}`, reason: 'parallel' })))
    reused = await ok(call, 'spawn_agent', { profile: 'Modeller', name: 'Fox helper', task: 'TASK_named', reason: 'named' })
    const again = await ok(call, 'spawn_agent', { profile: 'Modeller', name: 'Fox helper', task: 'TASK_named_again', reason: 'same name' })
    reused = [reused, again]
    first = await ok(call, 'spawn_agent', { profile: long.id, task: 'TASK_long_1', reason: 'long' })
    second = await ok(call, 'spawn_agent', { profile: long.id, task: 'TASK_long_2', reason: 'long again' })
    waited = await ok(call, 'wait_agent', {})
  })
  assert.ok(parallel.every(answer => answer.ok), JSON.stringify(parallel.map(answer => answer.error)))
  const results = parallel.map(answer => answer.observation)
  assert.ok(results.every(answer => answer.ok === true && !answer.reused), JSON.stringify(results))
  assert.deepEqual(results.map(answer => answer.name).sort(), ['Modeller', 'Modeller 2', 'Modeller 3'], 'three helpers, not one reused')
  assert.equal(new Set(results.map(answer => answer.agentId)).size, 3)
  for (const task of ['fox', 'bee', 'owl']) {
    const answer = results.find(item => out.run.agentNodes.get(item.agentId).task === `TASK_${task}`)
    assert.ok(answer, `${task} has its helper`)
    assert.ok(out.promptOf(answer.name).includes(`TASK FROM YOUR PARENT:\nTASK_${task}`) && out.promptOf(answer.name).includes('PLAYBOOK_NAMES_MARK'), `${task} ran with the playbook`)
  }
  // A name the caller wrote is theirs: a second spawn with it reuses the helper, as it always did.
  assert.deepEqual([reused[0].name, reused[0].reused, reused[1].reused, reused[1].agentId === reused[0].agentId], ['Fox helper', undefined, true, true])
  // The long name: 80 characters at most, no truncation mark, the next one numbered inside the 80.
  assert.equal(first.name, longName.slice(0, 80)); assert.ok(!first.name.includes('truncated'))
  assert.equal(second.name, `${longName.slice(0, 78)} 2`); assert.ok(second.name.length <= 80 && !second.name.includes('truncated'))
  assert.equal(first.profile.name, longName, 'the prompt names the agent in full')
  assert.ok(out.promptOf(first.name).includes(`YOU ARE "${longName}"`))
  assert.equal(waited.length, 3 + 1 + 2)
  assert.equal(fx.store.find(agent.id, fx.ws).uses, 1, 'three spawns in one run are one use')
})

test('resumed session turns of a helper that runs as an agent carry a short reminder with its package folder, never the playbook', async t => {
  const fx = fixture(t), dir = packageFolder(fx, { instructions: 'PLAYBOOK_RESUME_MARK check the renders.' })
  const agent = addAgent(fx, { name: 'Modeller', instructions: 'PLAYBOOK_RESUME_MARK check the renders.', fromDir: dir }, { role: '3D modeller' })
  const plain = addAgent(fx, { name: 'Plain agent without files', instructions: 'PLAYBOOK_PLAIN_MARK be plain.' }, { role: 'plain things' })
  const packageDir = fx.store.read(agent.id, fx.ws).package.dir
  const out = await sessionRun(fx, async call => {
    await ok(call, 'spawn_agent', { profile: agent.id, task: 'R_FIRST', reason: 'r' })
    await ok(call, 'spawn_agent', { profile: plain.id, task: 'P_FIRST', reason: 'r' })
    await ok(call, 'spawn_agent', { name: 'Ordinary', task: 'O_FIRST', reason: 'r' })
    const names = ['Modeller', 'Plain agent without files', 'Ordinary']
    for (const agentId of names) await ok(call, 'wait_agent', { agentId })
    for (const agentId of names) await ok(call, 'followup_agent', { agentId, task: `${agentId[0]}_SECOND` })
    for (const agentId of names) await ok(call, 'wait_agent', { agentId })
  })
  const turns = name => out.calls.filter(item => item.name === name).map(item => item.options)
  const modeller = turns('Modeller')
  assert.deepEqual(modeller.map(item => item.session.resume), [false, true])
  assert.ok(modeller[0].prompt.includes('PLAYBOOK_RESUME_MARK'), 'the first prompt carries the playbook')
  assert.ok(modeller[1].prompt.startsWith(`YOU ARE "Modeller", a trained Orbit agent (3D modeller). Follow your playbook (in your first prompt of this session); package folder: ${packageDir}.`), modeller[1].prompt.slice(0, 300))
  assert.ok(modeller[1].prompt.includes('M_SECOND') && !modeller[1].prompt.includes('PLAYBOOK_RESUME_MARK'), 'the follow-up task follows the reminder; the playbook is not sent again')
  const flat = turns('Plain agent without files')
  assert.ok(flat[1].prompt.startsWith('YOU ARE "Plain agent without files", a trained Orbit agent (plain things). Follow your playbook (in your first prompt of this session).'))
  assert.ok(!flat[1].prompt.includes('package folder'), 'no files, no folder')
  assert.ok(!turns('Ordinary')[1].prompt.includes('YOU ARE'), 'an ordinary helper gets no reminder')
  // The reminder is internal: the snapshot does not carry it.
  assert.ok(!JSON.stringify(out.snapshot).includes('Follow your playbook (in your first prompt'))
})
