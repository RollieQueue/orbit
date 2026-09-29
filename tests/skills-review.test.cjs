const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CapabilityStore } = require('../electron/capabilities.cjs')

// Cases found by an independent review of the skills library: each one failed before it was fixed.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-skills-review-'))
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b')
  fs.mkdirSync(a); fs.mkdirSync(b)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, a, b, skills: new CapabilityStore(root) }
}
const agent = { origin: 'agent' }

test('procedures that share most words but differ in a tool or language are different skills', t => {
  const { a, b, skills } = fixture(t)
  const node = skills.install({ name: 'Release Node package', description: 'Publish a package', instructions: 'Bump the version, run npm test, run npm publish and tag the release in git', scope: 'project', workspace: a }, agent)
  const python = skills.save({ name: 'Release Python package', description: 'Publish a package', instructions: 'Bump the version, run pytest, run twine upload and tag the release in git', scope: 'project', workspace: a }, agent)
  assert.equal(python.merged, false); assert.notEqual(python.entry.id, node.id)
  assert.equal(skills.list(a).length, 2)
  const npm = { name: 'Install dependencies', description: 'Set up the repository', instructions: 'Run npm install then npm test and confirm that everything passes', scope: 'project' }
  const one = skills.install({ ...npm, workspace: a }, agent)
  skills.install({ ...npm, workspace: b, instructions: 'Run pnpm install then pnpm test and confirm that everything passes' }, agent)
  skills.recordUse(one.id, a)
  assert.equal(skills.maintain({ workspace: a, crossProject: true }).shared, 0, 'one different tool name is a different procedure')
  assert.equal(skills.list(a).filter(skill => skill.scope === 'global').length, 0)
  assert.equal(skills.save({ ...npm, workspace: a, name: 'Install dependencies again' }, agent).merged, true, 'a real restatement still improves the skill')
  assert.equal(skills.save({ ...npm, workspace: a, name: 'Install dependencies again', instructions: npm.instructions, source: 'user' }, agent).entry.source.startsWith('user'), false, 'an agent cannot claim to be the user')
})

test('pitfalls travel to a promoted skill only when they name no project', t => {
  const { a, b, skills } = fixture(t)
  const general = { name: 'Rotate a certificate', description: 'Renew a TLS certificate', instructions: 'Generate a key, request the certificate, install it and reload the service, then verify the expiry date', scope: 'project' }
  const one = skills.install({ ...general, workspace: a }, agent)
  const two = skills.install({ ...general, workspace: b }, agent)
  skills.recordUse(one.id, a)
  skills.feedback(one.id, a, { outcome: 'failed', note: `Fails under ${path.join(a, 'secret-customer-x')}` })
  skills.feedback(two.id, b, { outcome: 'failed', note: 'The reload needs root' })
  assert.equal(skills.maintain({ workspace: a, crossProject: true }).shared, 1)
  const [shared] = skills.list(a).filter(skill => skill.scope === 'global')
  assert.ok(shared.lessons.includes('The reload needs root'))
  assert.ok(!JSON.stringify(shared.lessons).includes('project-a') && !JSON.stringify(shared.lessons).includes('secret-customer-x'), JSON.stringify(shared.lessons))
})

test('a project that switched shared memory off neither sees nor changes the shared library', t => {
  const { a, b, skills } = fixture(t)
  const shared = skills.install({ name: 'Isolated Linux environment', description: 'Throwaway Linux distro', instructions: 'Import a rootfs as a new distro and run the build inside', scope: 'global' }, agent)
  skills.install({ name: 'Local check', description: 'Project check', instructions: 'Run the project checks', scope: 'project', workspace: b }, agent)
  assert.deepEqual(skills.list(b, false).map(skill => skill.name), ['Local check'])
  assert.deepEqual(skills.search('linux distro', b, 8, false), [])
  assert.equal(skills.suggest('linux distro build', b, 6, false).skills.length, 0)
  assert.equal(skills.suggest('linux distro build', b, 6, false).total, 1)
  assert.throws(() => skills.read(shared.id, b, false), /not found/)
  assert.equal(skills.recordUse(shared.id, b, false), null)
  assert.throws(() => skills.feedback(shared.id, b, { outcome: 'failed', note: 'x', includeGlobal: false }), /not found/)
  const untouched = skills.read(shared.id, a)
  assert.equal(untouched.uses, 0); assert.equal(untouched.failures, 0); assert.deepEqual(untouched.usedIn, [])
  assert.equal(skills.search('linux distro', a, 8, true)[0].name, 'Isolated Linux environment')
})
