const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CapabilityStore, renderSkills, LIMITS } = require('../electron/capabilities.cjs')

const DAY = 86400000
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-skills-'))
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const time = { now: Date.parse('2026-03-01T10:00:00Z') }
  return { root, a, b, time, open: () => new CapabilityStore(root, { clock: () => time.now }) }
}
const word = i => `${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}qzx${String.fromCharCode(97 + Math.floor(i / 676))}`
const agent = { origin: 'agent' }
const linux = {
  name: 'Isolated Linux environment', description: 'Create a throwaway Linux distro that mirrors the current toolchain',
  whenToUse: 'a task needs a clean Linux box, or must not touch the host', scope: 'global',
  instructions: 'Install WSL, import a minimal rootfs as a new distro, copy the toolchain manifest into it, run the build inside the distro and verify the exit code, then unregister the distro.',
}

test('skills carry a track record and are found by what they are for, in either language', t => {
  const { a, b, open } = fixture(t), skills = open()
  skills.install(linux, agent)
  skills.install({ name: 'Проверка релиза', description: 'Как выпустить версию приложения', whenToUse: 'нужно опубликовать релиз', instructions: 'Собрать, прогнать тесты, упаковать и проверить установщик', scope: 'project', workspace: a })
  skills.install({ name: 'Unrelated', description: 'Something else entirely', instructions: 'zzz', scope: 'project', workspace: a })
  assert.deepEqual(skills.search('need a clean linux environment for the build', a).map(item => item.name), ['Isolated Linux environment'])
  assert.deepEqual(skills.search('выпустить релиз', a).map(item => item.name), ['Проверка релиза'])
  assert.deepEqual(skills.search('выпустить релиз', b).map(item => item.name), [], 'another project does not see it')
  assert.deepEqual(skills.search('linux', b).map(item => item.name), ['Isolated Linux environment'], 'a shared skill is visible everywhere')
  const [first] = skills.list(a)
  assert.equal(first.instructions, undefined); assert.equal(first.uses, 0); assert.equal(first.reliability, 0.5)
  assert.equal(skills.suggest('deploy something', b).skills.length, 0)
  assert.equal(skills.suggest('deploy something', b).total, 1)
})

test('use and feedback build the record; a failure keeps its pitfall; input cannot forge the record', t => {
  const { root, a, b, time, open } = fixture(t), skills = open()
  const skill = skills.install(linux, agent)
  const forged = skills.install({ ...skill, uses: 500, successes: 500, instructions: `${skill.instructions} Also check disk space.` })
  assert.equal(forged.uses, 0); assert.equal(forged.successes, 0); assert.equal(forged.version, 2)
  skills.recordUse(skill.id, a); skills.recordUse(skill.id, a); skills.recordUse(skill.id.slice(0, 12), b)
  time.now += DAY
  skills.feedback(skill.id, a, { outcome: 'worked' })
  skills.feedback(skill.id, a, { outcome: 'worked', note: 'ignored on success' })
  const failed = skills.feedback(skill.id, a, { outcome: 'failed', note: `WSL needs a reboot after enabling the feature in ${a}` })
  assert.equal(failed.uses, 3); assert.equal(failed.successes, 2); assert.equal(failed.failures, 1)
  assert.equal(failed.reliability, 0.6)
  assert.equal(failed.lessons.length, 1)
  assert.ok(!failed.lessons[0].includes('project-a'), 'a shared skill never keeps the path of the project that reported the pitfall')
  assert.equal(failed.usedIn.length, 2, 'two projects, kept as hashes')
  assert.ok(!JSON.stringify(failed.usedIn).includes('project'))
  assert.throws(() => skills.feedback(skill.id, a, { outcome: 'great' }), /worked, partial or failed/)
  assert.throws(() => skills.feedback('missing-id', a, { outcome: 'worked' }), /not found/)
  assert.equal(skills.feedback(skill.id, a, { outcome: 'partial' }).successes, 2.5)
  skills.flush()
  const reloaded = new CapabilityStore(root)
  assert.equal(reloaded.read(skill.id, b).uses, 3)
  assert.equal(reloaded.suggest('something unrelated', b).skills[0].name, linux.name, 'a proven skill stays in view')
  const restored = reloaded.restore(skill.id, 1, a)
  assert.equal(restored.uses, 3, 'restoring text keeps the record'); assert.equal(restored.whenToUse, linux.whenToUse)
})

test('an agent that rediscovers a skill improves it instead of adding a copy; the user\'s version stays reachable', t => {
  const { a, open } = fixture(t), skills = open()
  const first = skills.install({ ...linux, scope: 'project', workspace: a, source: 'user' })
  const second = skills.save({ ...linux, scope: 'project', workspace: a, name: 'Isolated Linux environment copy', instructions: `${linux.instructions} Add a snapshot before unregistering.` }, agent)
  assert.equal(second.merged, true); assert.equal(second.entry.id, first.id); assert.equal(second.entry.version, 2)
  assert.equal(skills.list(a).length, 1)
  assert.equal(skills.read(first.id, a).revisions[0].instructions, linux.instructions)
  const other = skills.save({ name: 'Publish a package', description: 'x', instructions: 'Bump the version, build, then publish to the registry', scope: 'project', workspace: a }, agent)
  assert.equal(other.merged, false); assert.equal(skills.list(a).length, 2)
  assert.ok(skills.install({ ...linux, name: 'Long', instructions: 'x'.repeat(50000), scope: 'global' }, agent).instructions.length <= 12000)
})

test('the library stays within its caps and drops the unproven and failing first', t => {
  const { a, time, open } = fixture(t), skills = open()
  const made = Array.from({ length: LIMITS.project }, (_, i) => skills.install({ name: `Skill ${word(i)}`, description: word(i + 300), instructions: `${word(i)} ${word(i + 400)} steps`, scope: 'project', workspace: a }, agent))
  const good = made[1], bad = made[2], mine = skills.install({ name: 'Mine', description: 'user', instructions: 'keep this', scope: 'project', workspace: a, source: 'user' })
  time.now += 5 * DAY
  skills.recordUse(good.id, a); skills.feedback(good.id, a, { outcome: 'worked' }); skills.feedback(bad.id, a, { outcome: 'failed' }); skills.feedback(bad.id, a, { outcome: 'failed' })
  time.now += 40 * DAY
  const before = skills.list(a).length
  assert.ok(before <= LIMITS.project + 1, 'the user\'s skill may exceed the cap only because nothing else can be dropped')
  const added = skills.install({ name: 'Newcomer', description: word(900), instructions: `${word(901)} ${word(902)} steps`, scope: 'project', workspace: a }, agent)
  const names = skills.list(a).map(item => item.id)
  assert.ok(names.includes(good.id) && names.includes(mine.id) && names.includes(added.id))
  assert.ok(!names.includes(bad.id), 'the failing skill was the first to go')
  assert.ok(skills.list(a).length <= LIMITS.project)
  time.now += 200 * DAY
  const report = skills.maintain({ workspace: a })
  assert.ok(report.expired > 0)
  const rest = skills.list(a).map(item => item.id)
  assert.ok(rest.includes(good.id) && rest.includes(mine.id), 'used and user-written skills survive the age limit')
  assert.ok(!rest.includes(added.id), 'a skill nobody ever used ages out')
})

test('a procedure worked out in several projects is shared; one that names a project is not', t => {
  const { a, b, open } = fixture(t), skills = open()
  const general = { name: 'Rotate a certificate', description: 'Renew a TLS certificate', instructions: 'Generate a key, request the certificate, install it and reload the service, then verify the expiry date', scope: 'project' }
  const one = skills.install({ ...general, workspace: a }, agent)
  skills.install({ ...general, workspace: b }, agent)
  assert.equal(skills.maintain({ workspace: a, crossProject: true }).shared, 0, 'never used: nothing proves it')
  skills.recordUse(one.id, a)
  assert.equal(skills.maintain({ workspace: a, crossProject: true }).shared, 1)
  assert.deepEqual(skills.search('certificate', a).map(item => item.scope), ['global'], 'shown once, from the shared library')
  assert.ok(!JSON.stringify(skills.entries.filter(entry => entry.scope === 'global')).includes('project-'))
  fs.mkdirSync(path.join(a, 'ops')); fs.writeFileSync(path.join(a, 'ops', 'deploy.sh'), 'x')
  const specific = { name: 'Run the release', description: 'Release', instructions: 'Call ops/deploy.sh with the tag and wait for the health check to pass', scope: 'project' }
  const s1 = skills.install({ ...specific, workspace: a }, agent); skills.install({ ...specific, workspace: b }, agent)
  skills.recordUse(s1.id, a)
  assert.equal(skills.maintain({ workspace: a, crossProject: true }).shared, 0)
})

test('the skills block names what is relevant, how it fared, and stays inside its budget', t => {
  const { a, open } = fixture(t), skills = open()
  const skill = skills.install(linux, agent)
  skills.recordUse(skill.id, a); skills.feedback(skill.id, a, { outcome: 'failed', note: 'needs a reboot' })
  for (let i = 0; i < 12; i++) skills.install({ name: `Filler ${word(i)}`, description: word(i + 300), instructions: `${word(i)} ${word(i + 400)}`, scope: 'project', workspace: a }, agent)
  const block = renderSkills(skills.suggest('clean linux box', a), 700)
  assert.match(block, /Isolated Linux environment/); assert.match(block, /used 1×, worked 33%/); assert.match(block, /Pitfall: needs a reboot/)
  assert.match(block, /Use when: a task needs a clean Linux box/)
  assert.match(block, /more skills stored: capability_search/)
  assert.ok(block.length < 1100, `${block.length}`)
  assert.equal(renderSkills({ skills: [], total: 0 }), '')
})

test('a shared skill never keeps a pitfall that names a project, and a skill the user wrote stays protected when an agent improves it', t => {
  const { a, open } = fixture(t), skills = open()
  fs.mkdirSync(path.join(a, 'ops'), { recursive: true }); fs.writeFileSync(path.join(a, 'ops', 'deploy.sh'), 'x')
  const shared = skills.install(linux, agent)
  const kept = skills.feedback(shared.id, a, { outcome: 'failed', note: `Fails after ops/deploy.sh ran in ${a}` })
  assert.deepEqual(kept.lessons, ['Fails after <file> ran in <project>'], 'paths are scrubbed, the general lesson survives')
  const dropped = skills.feedback(shared.id, a, { outcome: 'failed', note: 'The project-a repo needs a token' })
  assert.equal(dropped.lessons[0], 'The <project> repo needs a token', 'the folder name is scrubbed as well')
  assert.equal(dropped.failures, 2, 'the outcome still counts')
  const mine = skills.install({ name: 'Release routine', description: 'How releases go out', instructions: 'Tag, build, publish and announce the release in the usual channel', scope: 'project', workspace: a, source: 'user' })
  const improved = skills.save({ ...mine, instructions: `${mine.instructions}, then verify the download`, source: 'agent:agent-7' }, agent).entry
  assert.equal(improved.source, 'user'); assert.equal(improved.editedBy, 'agent:agent-7'); assert.equal(improved.version, 2)
  for (let i = 0; i < LIMITS.project + 3; i++) skills.install({ name: `Filler ${word(i)}`, description: word(i + 300), instructions: `${word(i)} ${word(i + 400)}`, scope: 'project', workspace: a }, agent)
  assert.ok(skills.list(a).some(skill => skill.id === mine.id), 'still there after the cap forced others out')
  assert.equal(skills.install({ ...improved, instructions: `${improved.instructions}!`, source: 'user' }).editedBy, undefined, 'the user\'s own edit clears the note')
})
