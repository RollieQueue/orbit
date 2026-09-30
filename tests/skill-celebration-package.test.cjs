const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CapabilityStore } = require('../electron/capabilities.mts')
const { resolvePackageFile } = require('../electron/skill-files.mts')

// The celebration ships as a skill package in the repository (skills/task-completed-celebration). An agent installs it
// with capability_install {fromDir}: this is the same store call, so the package must stay installable as it is.
const repo = path.resolve(__dirname, '..')
const folder = path.join(repo, 'skills', 'task-completed-celebration')

test('the celebration package installs from its folder as an agent would, and orbit-skill:// finds its page and assets', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-celebration-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const store = new CapabilityStore(userData)
  const { entry } = store.save({ fromDir: folder, workspace: repo, source: 'agent' }, { origin: 'agent' })
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'skill.json'), 'utf8'))
  assert.equal(entry.name, manifest.name)
  assert.equal(entry.scope, 'global')
  assert.deepEqual(entry.triggers, [{ on: 'task-completed', show: 'page.html' }])
  const values = Object.fromEntries(entry.params.map(param => [param.key, param.value]))
  assert.deepEqual(values, { video: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', start: 42, end: 73, text: 'TASK COMPLETED', confetti: true })
  const [listed] = store.list(repo)
  assert.equal(listed.id, entry.id)
  assert.ok(listed.package && listed.enabled !== false, 'the panel gets the package and the switch')
  const page = resolvePackageFile(userData, listed.package.id, 'page.html')
  assert.ok(page && fs.existsSync(page), 'the page is served from the package folder')
  const html = fs.readFileSync(page, 'utf8')
  // Every file the page loads is part of the package (no external scripts besides the YouTube frame).
  for (const [, file] of html.matchAll(/(?:src|href)="(?!https?:)([^"#?]+)"/g)) {
    assert.ok(entry.files.some(item => item.path === file), `${file} is in the package`)
    assert.ok(fs.existsSync(resolvePackageFile(userData, listed.package.id, file)), `${file} is on disk`)
  }
  assert.doesNotMatch(html, /<script[^>]+src="https?:/, 'no external script')
})
