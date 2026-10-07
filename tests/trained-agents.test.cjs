const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CapabilityStore, renderSkills } = require('../electron/capabilities.mts')
const { skillPackageDir } = require('../electron/skill-files.mts')
const { MAX_IMAGE_BYTES, MAX_FILE_BYTES } = require('../electron/skill-packages.mts')
const { checkRound, checkGallery, reviveAgent, renderAgents, lastScore, MAX_ROUNDS, MAX_GALLERY } = require('../electron/trained-agents.mts')

const DAY = 86400000
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-trained-agents-'))
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const time = { now: Date.parse('2026-03-01T10:00:00Z') }
  return { root, a, b, time, file: path.join(root, 'capabilities.json'), open: () => new CapabilityStore(root, { clock: () => time.now }) }
}
const agent = { origin: 'agent' }
const png = size => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, size - 8), 7)])
// An agent as agent_save passes it to the store.
const modeller = (a, over = {}, profile = {}) => ({
  name: '3D modeller', whenToUse: 'a 3D model has to be made', instructions: '# Playbook\nBuild low-poly models with the scripts in the package folder.', scope: 'project', workspace: a, source: 'agent:test',
  agent: { role: 'Makes stylised low-poly 3D models', ...profile }, ...over,
})
const skill = (a, over = {}) => ({ name: 'Release package', description: 'Cut a release', whenToUse: 'a release is due', instructions: 'Tag, build, publish.', scope: 'project', workspace: a, ...over })

test('create: an agent is a protected capability with a role, a playbook, defaults and a package; it survives a reload', t => {
  const { root, a, open, file } = fixture(t), store = open()
  const saved = store.save(modeller(a, { files: [{ path: 'scripts/make.py', content: 'print(1)' }, { path: 'README.md', content: 'readme' }] }, { kind: 'code', reasoningEffort: 'xhigh', status: 'training', trainingMinutes: 95 }), agent)
  const entry = saved.entry
  assert.equal(entry.name, '3D modeller')
  assert.equal(entry.description, 'Makes stylised low-poly 3D models', 'the role is the description')
  assert.deepEqual(entry.agent, { role: 'Makes stylised low-poly 3D models', kind: 'code', reasoningEffort: 'xhigh', status: 'training', rounds: [], gallery: [], trainingMinutes: 95 })
  assert.equal(entry.version, 1)
  assert.equal(entry.package.dir, skillPackageDir(root, entry.id))
  assert.equal(fs.readFileSync(path.join(entry.package.dir, 'scripts', 'make.py'), 'utf8'), 'print(1)')
  assert.deepEqual(entry.triggers, []); assert.deepEqual(entry.commands, []); assert.deepEqual(entry.params, [])
  const listed = store.list(a)[0]
  assert.equal(listed.instructions, undefined, 'the playbook is not in a list')
  assert.equal(listed.agent.role, entry.agent.role)
  assert.match(store.read(entry.id, a).instructions, /^# Playbook/)
  // Reloaded from disk: the same profile.
  const again = open()
  assert.deepEqual(again.read(entry.id, a).agent, entry.agent)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].agent.kind, 'code')
})

test('create needs a playbook and a role; kind, effort and status are checked; a profile must be an object', t => {
  const { a, open } = fixture(t), store = open()
  assert.throws(() => store.save(modeller(a, { instructions: '' }), agent), /name and playbook/)
  assert.throws(() => store.save(modeller(a, {}, { role: '' }), agent), /needs a role/)
  assert.throws(() => store.save(modeller(a, {}, { kind: 'plumbing' }), agent), /kind must be one of code, review, lookup, text/)
  assert.throws(() => store.save(modeller(a, {}, { reasoningEffort: 'huge' }), agent), /reasoningEffort must be one of/)
  assert.throws(() => store.save(modeller(a, {}, { status: 'done' }), agent), /status must be training or trained/)
  assert.throws(() => store.save({ ...modeller(a), agent: 'yes' }, agent), /must be an object/)
  assert.throws(() => store.save({ ...modeller(a), agent: [] }, agent), /must be an object/)
  assert.equal(store.entries.length, 0, 'nothing was stored')
  const ok = store.save(modeller(a), agent).entry
  assert.equal(ok.agent.status, 'training', 'a new agent is in training')
  assert.equal(ok.agent.kind, undefined)
  // '' clears a default; omitting keeps it.
  const set = store.save({ ...modeller(a), id: ok.id, agent: { kind: 'review', reasoningEffort: 'high' } }, agent).entry
  assert.equal(set.agent.kind, 'review')
  const kept = store.save({ ...modeller(a), id: ok.id, agent: { status: 'trained' } }, agent).entry
  assert.deepEqual([kept.agent.kind, kept.agent.reasoningEffort, kept.agent.status], ['review', 'high', 'trained'])
  const cleared = store.save({ ...modeller(a), id: ok.id, agent: { kind: '', reasoningEffort: '' } }, agent).entry
  assert.deepEqual([cleared.agent.kind, cleared.agent.reasoningEffort], [undefined, undefined])
})

test('an agent is a different kind of entry: ids do not cross, an agent named like a skill is allowed, an agent without its id is not overwritten', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a), agent).entry
  const plain = store.save(skill(a), agent).entry
  assert.throws(() => store.save(skill(a, { id: made.id }), agent), /is a trained agent: change it with agent_save/)
  assert.throws(() => store.save(modeller(a, { id: plain.id }), agent), /is a skill, not a trained agent: change it with capability_install/)
  assert.throws(() => store.save(modeller(a), agent), /already exists; to change it pass its id/, 'an agent that names an existing agent without its id is refused')
  const same = store.save(modeller(a, { name: 'Release package' }), agent).entry
  assert.notEqual(same.id, plain.id, 'the same name as a skill is another entry')
  assert.equal(store.entries.filter(entry => entry.name === 'Release package').length, 2)
  // A skill with the name of an agent does not take the agent over either.
  const twin = store.save(skill(a, { name: '3D modeller', instructions: 'a very different procedure about releases' }), agent).entry
  assert.equal(twin.agent, undefined); assert.notEqual(twin.id, made.id)
  assert.equal(store.read(made.id, a).agent.role, 'Makes stylised low-poly 3D models')
})

test('update by id keeps the record; rounds append with numbers that follow the last one; revisions of a long playbook are kept three deep', t => {
  const { a, time, open } = fixture(t), store = open()
  const made = store.save(modeller(a), agent).entry
  const round = (score, extra = {}) => ({ ...modeller(a), id: made.id, agent: { round: { score, ...extra } } })
  let entry = store.save(round(5.123, { concepts: ['proportions', 'palette'], scores: [{ criterion: 'silhouette', score: 6 }, { criterion: 'colour', score: 4.5 }], judges: ['gpt-6', 'opus-5.5'], notes: 'first pass' }), agent).entry
  assert.deepEqual(entry.agent.rounds.map(item => item.round), [1])
  assert.equal(entry.agent.rounds[0].score, 5.12, 'two decimals')
  assert.deepEqual(entry.agent.rounds[0].scores, { silhouette: 6, colour: 4.5 })
  assert.deepEqual(entry.agent.rounds[0].judges, ['gpt-6', 'opus-5.5'])
  assert.equal(entry.agent.rounds[0].at, new Date(time.now).toISOString(), 'at defaults to now')
  time.now += DAY
  entry = store.save(round(7), agent).entry
  entry = store.save(round(8.5, { at: '2026-03-05T12:00:00+03:00' }), agent).entry
  assert.deepEqual(entry.agent.rounds.map(item => item.round), [1, 2, 3])
  assert.equal(entry.agent.rounds[2].at, '2026-03-05T09:00:00.000Z', 'an ISO time with an offset is normalised')
  assert.equal(lastScore(entry.agent), 8.5)
  assert.equal(entry.version, 4)
  // An explicit number is kept, one already used is refused (a retry does not double-append), the next one follows the highest.
  entry = store.save(round(9, { round: 7 }), agent).entry
  assert.deepEqual(entry.agent.rounds.map(item => item.round), [1, 2, 3, 7])
  assert.throws(() => store.save(round(9, { round: 7 }), agent), /Training round 7 already exists/)
  assert.equal(store.save(round(9.5), agent).entry.agent.rounds.at(-1).round, 8)
  assert.equal(lastScore(store.read(made.id, a).agent), 9.5, 'the last score is the newest round')
  // Revisions keep the text. Rounds, a gallery or a status change are not a new text: five saves, no revision.
  assert.equal(store.read(made.id, a).version, 6)
  assert.equal(store.read(made.id, a).revisions.length, 0)
  assert.equal(store.read(made.id, a).instructions.startsWith('# Playbook'), true)
  assert.equal(entry.agent.role, 'Makes stylised low-poly 3D models', 'the role is kept when an update names none')
})

test('a round is checked: score 0..10, whole round numbers, an ISO time, scores per criterion, bounded lists, notes cut and said so', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a), agent).entry
  const attempt = round => store.save({ ...modeller(a), id: made.id, agent: { round } }, agent)
  assert.throws(() => attempt({}), /round\.score must be a number from 0 to 10/)
  assert.throws(() => attempt({ score: 11 }), /from 0 to 10/)
  assert.throws(() => attempt({ score: -1 }), /from 0 to 10/)
  assert.throws(() => attempt({ score: '7' }), /from 0 to 10/)
  assert.throws(() => attempt({ score: Number.NaN }), /from 0 to 10/)
  assert.throws(() => attempt({ score: 5, round: 1.5 }), /whole number/)
  assert.throws(() => attempt({ score: 5, round: 0 }), /round\.round must be a number from 1/)
  assert.throws(() => attempt({ score: 5, at: 'yesterday' }), /ISO 8601/)
  assert.throws(() => attempt({ score: 5, concepts: 'a' }), /must be an array of text/)
  assert.throws(() => attempt({ score: 5, concepts: [1] }), /text only/)
  assert.throws(() => attempt({ score: 5, concepts: Array.from({ length: 31 }, (_, i) => `c${i}`) }), /at most 30/)
  assert.throws(() => attempt({ score: 5, judges: Array.from({ length: 11 }, (_, i) => `j${i}`) }), /at most 10/)
  assert.throws(() => attempt({ score: 5, scores: [{ criterion: 'a', score: 12 }] }), /"a" must be a number from 0 to 10/)
  assert.throws(() => attempt({ score: 5, scores: [{ criterion: '', score: 1 }] }), /needs a criterion name/)
  assert.throws(() => attempt({ score: 5, scores: [{ criterion: 'a', score: 1 }, { criterion: 'a', score: 2 }] }), /names "a" twice/)
  assert.throws(() => attempt({ score: 5, scores: 'good' }), /list of \{criterion, score\}/)
  assert.throws(() => attempt({ score: 5, scores: Array.from({ length: 21 }, (_, i) => ({ criterion: `k${i}`, score: 1 })) }), /at most 20 criteria/)
  assert.throws(() => attempt('7'), /round must be an object/)
  assert.equal(store.read(made.id, a).agent.rounds.length, 0, 'every refusal left the agent as it was')
  assert.equal(store.read(made.id, a).version, 1)
  // A map is accepted for scores too; notes over 1500 are cut and the caller is told; secrets are redacted.
  const result = attempt({ score: 6, scores: { a: 3, b: 9.999 }, notes: `${'n'.repeat(1600)} token=sk-abcdefghijklmnop`, concepts: ['  spaced  ', ''] })
  assert.deepEqual(result.entry.agent.rounds[0].scores, { a: 3, b: 10 })
  assert.equal(result.entry.agent.rounds[0].notes.length, 1500)
  assert.deepEqual(result.entry.agent.rounds[0].concepts, ['spaced'])
  assert.match(result.notes.join(' '), /notes were cut to 1500/)
  assert.doesNotMatch(JSON.stringify(result.entry.agent), /sk-abcdefghijklmnop/)
  assert.deepEqual(checkRound({ score: 0 }, 4, '2026-01-01T00:00:00.000Z').round, { at: '2026-01-01T00:00:00.000Z', round: 4, concepts: [], score: 0 })
})

test('an agent keeps at most 50 rounds', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a), agent).entry
  for (let i = 1; i <= MAX_ROUNDS; i++) store.save({ ...modeller(a), id: made.id, agent: { round: { score: i % 11 } } }, agent)
  assert.equal(store.read(made.id, a).agent.rounds.length, 50)
  assert.throws(() => store.save({ ...modeller(a), id: made.id, agent: { round: { score: 5 } } }, agent), /at most 50 training rounds/)
  assert.equal(store.read(made.id, a).agent.rounds.length, 50)
})

test('the gallery replaces the list and only holds pictures that the package has after the save', t => {
  const { a, open } = fixture(t), store = open()
  const files = [{ path: 'gallery/one.png', content: 'x' }, { path: 'gallery/two.jpg', content: 'x' }, { path: 'gallery/three.webp', content: 'x' }, { path: 'gallery/four.jpeg', content: 'x' }, { path: 'notes.txt', content: 'x' }]
  const made = store.save(modeller(a, { files }), agent).entry
  const set = gallery => store.save({ ...modeller(a), id: made.id, agent: { gallery } }, agent)
  const first = set([{ file: 'gallery/one.png', caption: 'Fox, round 1' }, { file: 'gallery/two.jpg' }]).entry
  assert.deepEqual(first.agent.gallery, [{ file: 'gallery/one.png', caption: 'Fox, round 1' }, { file: 'gallery/two.jpg' }])
  // A call without a gallery keeps it; a new list replaces it; [] clears it.
  assert.deepEqual(store.save({ ...modeller(a), id: made.id, agent: { status: 'trained' } }, agent).entry.agent.gallery.length, 2)
  assert.deepEqual(set([{ file: 'gallery/three.webp', caption: '  Owl   ' }, { file: 'gallery/four.jpeg', caption: '' }]).entry.agent.gallery, [{ file: 'gallery/three.webp', caption: 'Owl' }, { file: 'gallery/four.jpeg' }])
  assert.throws(() => set([{ file: 'gallery/ghost.png' }]), /not a file of this agent's package/)
  assert.throws(() => set([{ file: 'notes.txt' }]), /not a picture: png, jpg, jpeg or webp/)
  assert.throws(() => set([{ file: 'gallery/one.png' }, { file: 'gallery/one.png' }]), /lists "gallery\/one.png" twice/)
  assert.throws(() => set([{ file: '../outside.png' }]), /package file path/)
  assert.throws(() => set([{ file: '/abs/one.png' }]), /package file path/)
  assert.throws(() => set([{ caption: 'no file' }]), /gallery\[0\]\.file/)
  assert.throws(() => set('one.png'), /must be an array/)
  assert.equal(store.read(made.id, a).agent.gallery.length, 2, 'refusals changed nothing')
  assert.deepEqual(set([]).entry.agent.gallery, [])
  // The picture may come in the same call as the gallery that lists it.
  const together = store.save({ ...modeller(a), id: made.id, files: [{ path: 'new.png', content: 'x' }], agent: { gallery: [{ file: 'new.png' }] } }, agent).entry
  assert.deepEqual(together.agent.gallery, [{ file: 'new.png' }])
  // A gallery that lists a file the same call removes is refused; removing a file without touching the gallery drops it and says so.
  assert.throws(() => store.save({ ...modeller(a), id: made.id, removeFiles: ['new.png'], agent: { gallery: [{ file: 'new.png' }] } }, agent), /not a file of this agent's package/)
  const dropped = store.save({ ...modeller(a), id: made.id, removeFiles: ['new.png'] }, { ...agent })
  assert.deepEqual(dropped.entry.agent.gallery, [])
  assert.match(dropped.notes.join(' '), /Dropped from the gallery, their files are gone: new\.png/)
})

test('the gallery holds at most 24 pictures', t => {
  const { a, open } = fixture(t), store = open()
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `g/${String(i).padStart(2, '0')}.png`, content: 'x' }))
  const made = store.save(modeller(a, { files }), agent).entry
  const list = count => files.slice(0, count).map(file => ({ file: file.path }))
  assert.equal(store.save({ ...modeller(a), id: made.id, agent: { gallery: list(MAX_GALLERY) } }, agent).entry.agent.gallery.length, 24)
  assert.throws(() => store.save({ ...modeller(a), id: made.id, agent: { gallery: list(25) } }, agent), /at most 24 pictures/)
  assert.equal(checkGallery(list(3), files.map(file => ({ path: file.path, size: 1 }))).length, 3)
})

test('package pictures come from a folder: png/jpg/webp up to 1 MB, other files stay at 512 KB, 4 MB and 40 files in all', t => {
  const { root, a, open } = fixture(t), store = open()
  const source = path.join(root, 'trained'); fs.mkdirSync(path.join(source, 'gallery'), { recursive: true }); fs.mkdirSync(path.join(source, 'scripts'))
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ name: '3D modeller', role: 'Makes low-poly models', instructions: '# Playbook\nRun scripts/make.py.', whenToUse: 'a model is due' }))
  fs.writeFileSync(path.join(source, 'scripts', 'make.py'), 'print("ok")')
  fs.writeFileSync(path.join(source, 'README.md'), '# readme')
  fs.writeFileSync(path.join(source, 'gallery', 'big.png'), png(700 * 1024))
  fs.writeFileSync(path.join(source, 'gallery', 'edge.webp'), png(MAX_IMAGE_BYTES))
  assert.equal(MAX_IMAGE_BYTES, 1024 * 1024); assert.equal(MAX_FILE_BYTES, 512 * 1024)
  // The manifest fills name, playbook, whenToUse and role; the pictures come with the folder.
  const made = store.save({ workspace: a, fromDir: source, agent: { gallery: [{ file: 'gallery/big.png', caption: 'big' }, { file: 'gallery/edge.webp' }] } }, agent).entry
  assert.equal(made.name, '3D modeller')
  assert.equal(made.agent.role, 'Makes low-poly models')
  assert.equal(made.instructions.startsWith('# Playbook'), true)
  assert.deepEqual(made.files.map(file => file.path), ['gallery/big.png', 'gallery/edge.webp', 'README.md', 'scripts/make.py', 'skill.json'])
  assert.equal(fs.statSync(path.join(made.package.dir, 'gallery', 'big.png')).size, 700 * 1024)
  assert.equal(made.agent.gallery.length, 2)
  // One byte over the picture limit, and a non-picture over 512 KB, are refused with the limit named.
  fs.writeFileSync(path.join(source, 'gallery', 'edge.webp'), png(MAX_IMAGE_BYTES + 1))
  assert.throws(() => store.save({ workspace: a, fromDir: source, id: made.id, agent: {} }, agent), /larger than 1024 KB: "gallery\/edge\.webp"/)
  fs.writeFileSync(path.join(source, 'gallery', 'edge.webp'), png(1000))
  fs.writeFileSync(path.join(source, 'scripts', 'data.bin'), Buffer.alloc(MAX_FILE_BYTES + 1))
  assert.throws(() => store.save({ workspace: a, fromDir: source, id: made.id, agent: {} }, agent), /larger than 512 KB: "scripts\/data\.bin"/)
  fs.rmSync(path.join(source, 'scripts', 'data.bin'))
  // Over the 4 MB total: five 1 MB pictures are 5 MB.
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(source, 'gallery', `p${i}.png`), png(MAX_IMAGE_BYTES))
  assert.throws(() => store.save({ workspace: a, fromDir: source, id: made.id, agent: {} }, agent), /at most 4 MB in total/)
  // Text files given inline: 512 KB, pictures are not text but the same limit applies to their extension.
  assert.throws(() => store.save({ ...modeller(a, { name: 'Other' }), files: [{ path: 'big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1) }] }, agent), /"big\.txt" is larger than 512 KB/)
  assert.doesNotThrow(() => store.save({ ...modeller(a, { name: 'Other' }), files: [{ path: 'big.png', content: 'x'.repeat(MAX_FILE_BYTES + 1) }] }, agent), 'a picture may pass 512 KB')
  assert.throws(() => store.save({ ...modeller(a, { name: 'Third' }), files: [{ path: 'big.png', content: 'x'.repeat(MAX_IMAGE_BYTES + 1) }] }, agent), /"big\.png" is larger than 1024 KB/)
})

test('skills and agents live apart: lists for agents, searches, suggestions, counts and caps', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a, { instructions: 'Release the 3D model package with the release scripts. Tag build publish.' }), agent).entry
  const plain = store.save(skill(a), agent).entry
  // list() is for the window: both. Searches and suggestions are for agents' skills: never an agent.
  assert.deepEqual(store.list(a).map(item => item.id).sort(), [made.id, plain.id].sort())
  assert.deepEqual(store.search('release 3D model', a).map(item => item.id), [plain.id])
  const suggested = store.suggest('release the 3D model package', a)
  assert.deepEqual(suggested.skills.map(item => item.id), [plain.id]); assert.equal(suggested.total, 1)
  assert.equal(renderSkills(suggested).includes(made.name), false)
  // The skill counters leave agents out, and agents have their own.
  const stats = store.stats(a)
  assert.deepEqual([stats.project.count, stats.project.limit, stats.global.count, stats.used], [1, 60, 0, 0])
  assert.deepEqual(stats.agents, { project: { count: 1, limit: 20 }, global: { count: 0, limit: 20 } })
  // Twenty agents fit, the 21st is refused (agents are protected, so nothing is evicted), and the skills' room is untouched.
  for (let i = 2; i <= 20; i++) store.save(modeller(a, { name: `Agent ${i}`, instructions: `playbook ${i}` }), agent)
  assert.throws(() => store.save(modeller(a, { name: 'Agent 21', instructions: 'playbook 21' }), agent), /Trained agent limit: at most 20 project agents/)
  assert.equal(store.entries.filter(entry => entry.agent).length, 20)
  store.save(skill(a, { name: 'Another skill', instructions: 'something else entirely about databases' }), agent)
  assert.equal(store.stats(a).project.count, 2)
  // A project that switched sharing off sees no shared agent; the other project sees none of this one's.
  assert.equal(store.agents(null, true).length, 0)
})

test('maintenance never expires, evicts, merges or shares an agent', t => {
  const { a, b, time, open } = fixture(t), store = open()
  const text = 'Build low-poly models with the scripts in the package folder and check them with the judges.'
  const made = store.save(modeller(a, { instructions: text }), agent).entry
  const twin = store.save(skill(a, { name: '3D modeller skill', instructions: text }), agent).entry
  const other = store.save(modeller(b, { instructions: text }), agent).entry
  store.recordUse(twin.id, a)
  time.now += 400 * DAY
  const report = store.maintain({ workspace: a, crossProject: true, projects: [a, b] })
  assert.equal(report.expired, 0, 'an agent nobody used for a year is kept')
  assert.equal(report.shared, 0, 'the same playbook in two projects is not promoted')
  const ids = store.entries.map(entry => entry.id)
  assert.ok(ids.includes(made.id) && ids.includes(other.id))
  assert.ok(ids.includes(twin.id), 'a near-identical skill is not merged into an agent')
  assert.equal(store.entries.find(entry => entry.id === made.id).uses, 0)
})

test('findAgent: id, unique id prefix, exact name (the project one first); switched-off agents are found but not usable', t => {
  const { a, b, open } = fixture(t), store = open()
  const mine = store.save(modeller(a), agent).entry
  const shared = store.save(modeller(a, { scope: 'global', workspace: undefined, name: '3D modeller', instructions: 'shared playbook' }), agent).entry
  const hidden = store.save(modeller(a, { name: 'Hidden', instructions: 'hidden playbook' }), agent).entry
  assert.equal(store.findAgent(mine.id, a).id, mine.id)
  assert.equal(store.findAgent(mine.id.slice(0, 8), a).id, mine.id, 'a unique prefix of six or more characters')
  assert.equal(store.findAgent(mine.id.slice(0, 5), a), null, 'a short prefix names nothing')
  assert.equal(store.findAgent('3D modeller', a).id, mine.id, 'the project\'s agent wins over a shared one of the same name')
  assert.equal(store.findAgent('3D modeller', b).id, shared.id, 'another project sees the shared one')
  assert.equal(store.findAgent('3d modeller', a), null, 'the name is exact')
  assert.equal(store.findAgent('', a), null)
  assert.equal(store.findAgent(null, a), null)
  assert.equal(store.findAgent(store.save(skill(a), agent).entry.id, a), null, 'a skill is not an agent')
  assert.equal(store.findAgent('3D modeller', a, false).id, mine.id)
  assert.equal(store.findAgent(shared.id, a, false), null, 'a project that opted out of sharing does not see the shared agent')
  store.setEnabled(hidden.id, false, a)
  assert.equal(store.findAgent('Hidden', a).enabled, false, 'found, so the caller can say it is switched off')
  assert.deepEqual(store.agents(a).map(item => item.name).sort(), ['3D modeller', '3D modeller'])
  assert.equal(store.usableAgents(a).some(entry => entry.id === hidden.id), false)
})

test('agents(), suggestAgents() and renderAgents(): summaries, relevance first, then the best judged, bounded text', t => {
  const { a, open } = fixture(t), store = open()
  const modeller3d = store.save(modeller(a, { instructions: 'Blender low-poly 3D models: meshes, vertices, textures.' }, { status: 'trained' }), agent).entry
  const writer = store.save(modeller(a, { name: 'Release writer', whenToUse: 'release notes are needed', instructions: 'Write changelogs and release notes.' }, { role: 'Writes release notes' }), agent).entry
  const quiet = store.save(modeller(a, { name: 'Quiet', whenToUse: 'silence is wanted', instructions: 'nothing in common with the words below' }, { role: 'Does quiet things' }), agent).entry
  for (const [id, scores] of [[modeller3d.id, [4, 9]], [writer.id, [7]]]) for (const score of scores) store.save({ id, workspace: a, agent: { round: { score, concepts: id === modeller3d.id ? ['topology'] : [] } } }, agent)
  store.recordUse(writer.id, a); store.recordUse(writer.id, a)
  const list = store.agents(a)
  assert.deepEqual(list.map(item => item.name), ['Release writer', '3D modeller', 'Quiet'], 'by use, then by the last score')
  assert.deepEqual(list[1], { id: modeller3d.id, name: '3D modeller', role: 'Makes stylised low-poly 3D models', status: 'trained', scope: 'project', rounds: 2, lastScore: 9, uses: 0, reliability: 0.5 })
  assert.equal(list[2].lastScore, undefined, 'never judged')
  // A task about 3D models puts that agent first; a task about nothing known keeps the best judged ones first.
  const relevant = store.suggestAgents('make a low-poly 3D model of a fox', a)
  assert.equal(relevant.total, 3)
  assert.deepEqual(relevant.agents.map(item => item.name), ['3D modeller', 'Release writer', 'Quiet'])
  assert.equal(relevant.agents[0].relevant, true); assert.equal(relevant.agents[1].relevant, undefined)
  assert.deepEqual(store.suggestAgents('zzz qqq', a).agents.map(item => item.name), ['3D modeller', 'Release writer', 'Quiet'], 'the last score, then use')
  assert.equal(store.suggestAgents('topology', a).agents[0].name, '3D modeller', 'what the training covered is searchable')
  assert.equal(store.suggestAgents('anything', a, 2).agents.length, 2)
  assert.equal(store.suggestAgents('anything', a, 2).total, 3)
  // The block: id, tier, status, last score, name and role; nothing when there is none.
  const block = renderAgents(relevant)
  assert.match(block, new RegExp(`^- ${modeller3d.id.slice(0, 12)} \\[this project, trained, last score 9/10\\] 3D modeller — Makes stylised low-poly 3D models`))
  assert.match(block, /\[this project, training, not judged\] Quiet — Does quiet things/)
  assert.equal(renderAgents({ agents: [], total: 0 }), '')
  const many = { agents: Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`.padEnd(36, 'x'), name: `Agent number ${i}`, role: 'r'.repeat(300), status: 'trained', scope: 'global', rounds: 1, lastScore: 5, uses: 0, reliability: 0.5 })), total: 9 }
  const bounded = renderAgents(many, 400)
  assert.ok(bounded.split('\n').length < 8 && bounded.length < 700)
  assert.match(bounded, /\(\d+ more agents stored: agent_read lists them\)$/)
  assert.match(renderAgents(many), /all projects/)
})

test('feedback rates an agent like a skill: successes, failures and pitfalls; a disabled agent is still ratable by the store', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a), agent).entry
  assert.equal(store.recordUse(made.id, a), made.id)
  const worked = store.feedback(made.id, a, { outcome: 'worked' })
  assert.deepEqual([worked.uses, worked.successes, worked.reliability], [1, 1, 0.67])
  const failed = store.feedback(made.id, a, { outcome: 'failed', note: 'models came out with flipped normals' })
  assert.equal(failed.failures, 1)
  assert.deepEqual(failed.lessons, ['models came out with flipped normals'])
  assert.equal(failed.agent.role, 'Makes stylised low-poly 3D models', 'the card keeps its profile')
  assert.equal(failed.instructions, undefined)
  assert.equal(store.read(made.id, a).lessons.length, 1)
  const reloaded = open()
  assert.equal(reloaded.read(made.id, a).successes, 1)
})

test('the playbook of an agent may be 40 000 characters, a skill\'s stays at 12 000 (24 000 for the user)', t => {
  const { a, open } = fixture(t), store = open()
  const long = 'x'.repeat(41000)
  assert.equal(store.save(modeller(a, { instructions: long }), agent).entry.instructions.length, 40000)
  assert.equal(store.save(skill(a, { instructions: long }), agent).entry.instructions.length, 12000)
  assert.equal(store.save(skill(a, { name: 'User skill', instructions: long, source: 'user' })).entry.instructions.length, 24000)
  assert.equal(store.save(modeller(a, { name: 'By the user', instructions: long, source: 'user' })).entry.instructions.length, 40000)
})

test('restore and setEnabled work on an agent; deleting removes its package; pinning is allowed', t => {
  const { root, a, open } = fixture(t), store = open()
  const made = store.save(modeller(a, { files: [{ path: 'scripts/a.py', content: 'x' }, { path: 'g.png', content: 'x' }] }, { status: 'trained' }), agent).entry
  store.save({ ...modeller(a), id: made.id, instructions: 'second playbook', agent: { round: { score: 6 }, gallery: [{ file: 'g.png' }] } }, agent)
  const restored = store.restore(made.id, 1, a)
  assert.match(restored.instructions, /^# Playbook/, 'the text is back as a new version')
  assert.equal(restored.agent.rounds.length, 1, 'the training record is current state, not part of a revision')
  assert.equal(restored.agent.gallery.length, 1)
  assert.equal(restored.version, 3)
  assert.equal(store.setEnabled(made.id, false, a).enabled, false)
  assert.equal(store.setEnabled(made.id, true, a).enabled, true)
  assert.equal(store.pin(made.id, true, a).pinned, true)
  const dir = skillPackageDir(root, made.id)
  assert.equal(fs.existsSync(dir), true)
  assert.equal(store.remove(made.id, a), true)
  assert.equal(fs.existsSync(dir), false, 'the package folder goes with the agent')
  assert.equal(store.entries.length, 0)
})

test('an agent stored by an older or damaged file is revived without throwing: bad rounds, pictures and defaults are dropped', t => {
  const { a, file, open } = fixture(t), store = open()
  const made = store.save(modeller(a, { files: [{ path: 'g.png', content: 'x' }] }), agent).entry
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored[0].agent = {
    role: 'Role', kind: 'plumbing', reasoningEffort: 5, status: 'weird', trainingMinutes: -3,
    rounds: [{ round: 1, score: 7, at: '2026-01-02T00:00:00Z', concepts: ['a'] }, { round: 2, score: 99 }, 'nope', { round: 3, score: 4, scores: { ok: 3, bad: 30 } }, { score: 5 }],
    gallery: [{ file: 'g.png', caption: 'ok' }, { file: 'notes.txt' }, { file: '../x.png' }, { file: 'g.png' }, 'x'],
  }
  fs.writeFileSync(file, JSON.stringify(stored))
  const agentOf = open().read(made.id, a).agent
  assert.equal(agentOf.role, 'Role'); assert.equal(agentOf.kind, undefined); assert.equal(agentOf.reasoningEffort, undefined)
  assert.equal(agentOf.status, 'training'); assert.equal(agentOf.trainingMinutes, undefined)
  // The round with a score of 99, the one that is not an object and the one with a criterion out of range are dropped; one without a number takes the next.
  assert.deepEqual(agentOf.rounds.map(item => [item.round, item.score]), [[1, 7], [2, 5]])
  assert.deepEqual(agentOf.gallery, [{ file: 'g.png', caption: 'ok' }])
  assert.equal(reviveAgent('text'), undefined)
  assert.equal(reviveAgent({ role: 'x' }).status, 'training')
  // A stored entry that is not an agent stays a skill.
  const skillOnly = open()
  assert.equal(skillOnly.save(skill(a), agent).entry.agent, undefined)
})

test('the tool registry: agent_save and agent_read are open to workers, validated, strict-schema friendly; spawn_agent takes a profile', () => {
  const { validate, tool, toolsFor } = require('../electron/tool-registry.mts')
  const { ORBIT_RESPONSE_SCHEMA, isOrbitToolEnvelope } = require('../electron/tool-schema.mts')
  for (const name of ['agent_save', 'agent_read']) {
    assert.equal(tool(name).rootOnly, false)
    assert.equal(tool(name).minAccess, 'read-only', 'like the skill tools')
    assert.ok(toolsFor({ root: false, accessMode: 'read-only' }).some(item => item.name === name))
  }
  assert.equal(tool('agent_save').mutating, true); assert.equal(tool('agent_read').mutating, false)
  assert.match(validate('agent_save', {}).error, /needs a name, a role and a playbook/)
  assert.match(validate('agent_save', { name: 'n', role: 'r' }).error, /playbook/)
  assert.equal(validate('agent_save', { id: 'known', round: { score: 7 } }).ok, true, 'an update names only what changes')
  assert.equal(validate('agent_save', { fromDir: '/tmp/pack' }).ok, true)
  assert.match(validate('agent_save', { id: 'x', round: { concepts: ['a'] } }).error, /round\.score is required/)
  assert.match(validate('agent_save', { id: 'x', round: { score: 7, bogus: 1 } }).error, /unknown argument "bogus"/)
  assert.match(validate('agent_save', { id: 'x', kind: 'plumbing' }).error, /kind must be one of/)
  assert.match(validate('agent_save', { id: 'x', status: 'done' }).error, /status must be one of/)
  assert.match(validate('agent_save', { id: 'x', gallery: [{ caption: 'c' }] }).error, /gallery\[0\]\.file is required/)
  assert.deepEqual(validate('agent_save', { id: 'x', kind: '', round: { score: 8, round: null, at: null, concepts: null, scores: [{ criterion: 'colour', score: 7 }], judges: ['m'], notes: null }, gallery: [{ file: 'a.png', caption: null }] }).args,
    { id: 'x', kind: '', round: { score: 8, round: null, at: null, concepts: null, scores: [{ criterion: 'colour', score: 7 }], judges: ['m'], notes: null }, gallery: [{ file: 'a.png', caption: null }] }, 'nested optionals may be null, as the envelope spells absent')
  assert.deepEqual(validate('agent_read', {}), { ok: true, args: {} })
  assert.deepEqual(validate('spawn_agent', { task: 't', reason: 'r', profile: '3D modeller' }), { ok: true, args: { task: 't', reason: 'r', profile: '3D modeller' } })
  assert.match(validate('spawn_agent', { task: 't', reason: 'r', profile: 5 }).error, /profile must be a string/)
  // The envelope accepts the calls with every key present and nulls for what is absent.
  const call = { content: '', tool_calls: [{ id: '1', name: 'agent_save', arguments: { name: null, role: null, instructions: null, id: 'x', whenToUse: null, scope: null, fromDir: null, files: null, removeFiles: null, kind: null, reasoningEffort: null, status: null, round: { score: 7, round: null, at: null, concepts: null, scores: null, judges: null, notes: null }, gallery: null, trainingMinutes: 30 } }] }
  assert.equal(isOrbitToolEnvelope(JSON.stringify(call), ORBIT_RESPONSE_SCHEMA), true)
  call.tool_calls[0].arguments.round = { score: 7 }
  assert.equal(isOrbitToolEnvelope(JSON.stringify(call), ORBIT_RESPONSE_SCHEMA), true, 'omitted nullable keys of a nested object are fine too')
  call.tool_calls[0].arguments.round = { concepts: ['a'] }
  assert.equal(isOrbitToolEnvelope(JSON.stringify(call), ORBIT_RESPONSE_SCHEMA), false, 'a round needs its score')
})

test('an agent takes a revision only when its name, whenToUse or playbook change, and keeps ten like a skill', t => {
  const { a, open } = fixture(t), store = open()
  const made = store.save(modeller(a, { instructions: 'playbook 0' }), agent).entry
  const update = (over, profile = {}) => store.save({ id: made.id, workspace: a, ...over, agent: profile }, agent).entry
  // A round, a status, a default, the same text again: new versions, no revision.
  update({}, { round: { score: 4 } }); update({}, { round: { score: 5 } }); update({}, { status: 'trained' }); update({ instructions: 'playbook 0' }, { kind: 'code' })
  assert.deepEqual([store.read(made.id, a).version, store.read(made.id, a).revisions.length], [5, 0])
  // The playbook, the whenToUse and the name each take one, holding the text they replaced.
  update({ instructions: 'playbook 1' }); update({ whenToUse: 'a different trigger' }); update({ name: 'Renamed modeller' })
  const revisions = store.read(made.id, a).revisions
  assert.deepEqual(revisions.map(item => [item.version, item.instructions, item.name]), [[5, 'playbook 0', '3D modeller'], [6, 'playbook 1', '3D modeller'], [7, 'playbook 1', '3D modeller']])
  assert.equal(revisions[1].whenToUse, 'a 3D model has to be made')
  // Rounds after that do not push the history out; twelve more playbooks keep the newest ten.
  for (let i = 0; i < 6; i++) update({}, { round: { score: i } })
  assert.equal(store.read(made.id, a).revisions.length, 3, 'rounds leave the history alone')
  for (let i = 2; i <= 13; i++) update({ instructions: `playbook ${i}` })
  const kept = store.read(made.id, a).revisions
  assert.equal(kept.length, 10)
  assert.equal(kept.at(-1).instructions, 'playbook 12'); assert.equal(kept[0].instructions, 'playbook 3')
  assert.equal(store.restore(made.id, kept[0].version, a).instructions, 'playbook 3', 'a revision of an agent restores like a skill\'s')
  // A skill is unchanged: every save takes a revision.
  const plain = store.save(skill(a), agent).entry
  store.save(skill(a, { id: plain.id }), agent); store.save(skill(a, { id: plain.id }), agent)
  assert.equal(store.read(plain.id, a).revisions.length, 2)
})
