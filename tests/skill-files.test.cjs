const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { skillPackageId, skillPackageDir, packagePath, resolvePackageFile, mimeType, SKILL_SCHEME, SKILLS_DIR } = require('../electron/skill-files.mts')

// The package folder of a skill is the host of its orbit-skill:// URLs, and a URL lowercases its host: an id that is not
// already a safe lowercase name gets a stable hash instead.
test('skillPackageId keeps a safe lowercase id and hashes any other one, the same way every time', () => {
  assert.equal(skillPackageId('task-completed-celebration'), 'task-completed-celebration')
  assert.equal(skillPackageId('3f2b9c1e-0a4d-4a51-9c3e-2f6b7d8e9a10'), '3f2b9c1e-0a4d-4a51-9c3e-2f6b7d8e9a10')
  for (const id of ['Upper', 'with space', '../escape', 'a'.repeat(64), '', 'ünicode']) {
    const hashed = skillPackageId(id)
    assert.match(hashed, /^s-[0-9a-f]{24}$/, id)
    assert.equal(skillPackageId(id), hashed)
  }
  assert.notEqual(skillPackageId('Upper'), skillPackageId('upper2'))
  assert.equal(skillPackageDir('/data', 'party'), path.join('/data', SKILLS_DIR, 'party'))
  assert.equal(SKILL_SCHEME, 'orbit-skill')
})

test('packagePath accepts plain relative paths and refuses what could leave the package or hide a file', () => {
  assert.equal(packagePath('page.html'), 'page.html')
  assert.equal(packagePath('scripts\\start.ps1'), 'scripts/start.ps1')
  assert.equal(packagePath(' assets/font-1.woff2 '), 'assets/font-1.woff2')
  for (const bad of ['', '/etc/passwd', 'C:/x', '../x', 'a/../b', 'a/./b', '.hidden', 'a/.git/config', 'a//b', 'a b.txt', `${'a/'.repeat(8)}b`, 'x'.repeat(161), null, undefined]) {
    assert.equal(packagePath(bad), null, String(bad))
  }
})

test('resolvePackageFile stays inside <userData>/skills/<package> and needs a valid package id', () => {
  const root = path.resolve('/orbit-data')
  assert.equal(resolvePackageFile(root, 'party', 'page.html'), path.join(root, 'skills', 'party', 'page.html'))
  assert.equal(resolvePackageFile(root, 'party', 'js/app.js'), path.join(root, 'skills', 'party', 'js', 'app.js'))
  for (const [id, file] of [['party', '../secret'], ['party', '..'], ['party', ''], ['Party', 'page.html'], ['../skills', 'page.html'], ['', 'page.html']]) {
    assert.equal(resolvePackageFile(root, id, file), null, `${id} ${file}`)
  }
})

test('mimeType answers the types a page needs and a safe default', () => {
  assert.match(mimeType('page.HTML'), /^text\/html/)
  assert.match(mimeType('a/app.js'), /^text\/javascript/)
  assert.equal(mimeType('font.woff2'), 'font/woff2')
  assert.equal(mimeType('archive.zip'), 'application/octet-stream')
})
