'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findNewestStandalone, listStandaloneBundles } = require('../scripts/standalone-resolve.cjs')
const { newestSourceChange, readBuildMarker, writeBuildMarker, discardBundle, toolPath, toolchain } = require('../scripts/self-upgrade.cjs')

test('findNewestStandalone prefers highest numeric v* over lexical v9', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-self-upgrade-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })

  assert.equal(findNewestStandalone(root), null)

  const legacy = path.join(root, 'Orbit-standalone-v9')
  const stamped = path.join(root, 'Orbit-standalone-v1790563080601')
  const incomplete = path.join(root, 'Orbit-standalone-v1790999999999')
  fs.mkdirSync(legacy)
  fs.mkdirSync(stamped)
  fs.mkdirSync(incomplete)
  fs.writeFileSync(path.join(legacy, 'Orbit.exe'), 'legacy')
  fs.writeFileSync(path.join(stamped, 'Orbit.exe'), 'stamped')
  for (const bundle of [legacy, stamped]) {
    fs.mkdirSync(path.join(bundle, 'resources'))
    fs.writeFileSync(path.join(bundle, 'resources', 'app.asar'), 'packaged application')
  }
  // incomplete: no Orbit.exe — ignored even with higher version

  const bundles = listStandaloneBundles(root)
  assert.equal(bundles.length, 2)
  assert.equal(bundles[0].name, 'Orbit-standalone-v1790563080601')
  assert.equal(findNewestStandalone(root).name, 'Orbit-standalone-v1790563080601')
  assert.equal(findNewestStandalone(root).exe, path.join(stamped, 'Orbit.exe'))
})

test('the build tools resolve through their declared bin, not through package exports', () => {
  // require.resolve('typescript/bin/tsc') throws ERR_PACKAGE_PATH_NOT_EXPORTED with current versions,
  // which used to make every real self-upgrade die before its first step.
  const tools = toolchain()
  for (const file of Object.values(tools)) assert.ok(fs.existsSync(file), `${file} must exist`)
  assert.equal(tools.tsc.split(path.sep).slice(-3).join('/'), 'typescript/bin/tsc')
  assert.equal(tools.vite.split(path.sep).slice(-3).join('/'), 'vite/bin/vite.js')
  assert.throws(() => toolPath('typescript', 'no-such-binary'), /does not declare/)
})

test('a bundle is up to date only relative to the sources recorded when it was built', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-self-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'electron')); fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'node_modules'))
  fs.writeFileSync(path.join(root, 'electron', 'main.cjs'), 'main')
  fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'app')
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'dependency noise')
  const bundle = path.join(root, 'Orbit-standalone-v1000')
  fs.mkdirSync(path.join(bundle, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(bundle, 'Orbit.exe'), 'exe')
  fs.writeFileSync(path.join(bundle, 'resources', 'app.asar'), 'payload')
  const at = (file, seconds) => { const time = new Date(Date.now() + seconds * 1000); fs.utimesSync(file, time, time) }
  for (const file of ['electron/main.cjs', 'src/App.tsx', 'package.json']) at(path.join(root, file), -60)
  at(path.join(root, 'node_modules', 'ignored.js'), 600)
  const found = findNewestStandalone(root)

  assert.equal(readBuildMarker(found), null, 'a bundle built without the script has unknown provenance')
  const built = newestSourceChange(root)
  assert.ok(built.time > 0 && built.file !== path.join('node_modules', 'ignored.js'), 'node_modules is not a source')
  writeBuildMarker(found, { builtAt: new Date().toISOString(), sourceNewest: built.time, sourceFile: built.file })
  assert.equal(readBuildMarker(found).sourceNewest, built.time)
  assert.ok(newestSourceChange(root).time <= readBuildMarker(found).sourceNewest, 'nothing changed since the recorded build')

  // Even an edit made while the build was running is newer than the recorded sources, unlike the asar's pack time.
  at(path.join(root, 'src', 'App.tsx'), 30)
  const changed = newestSourceChange(root)
  assert.equal(changed.file, path.join('src', 'App.tsx'))
  assert.ok(changed.time > readBuildMarker(found).sourceNewest, 'an edit after the recorded sources requires a new bundle')
})

test('only a numbered bundle inside the project root can be discarded', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-self-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const own = path.join(root, 'Orbit-standalone-v2000'), other = path.join(root, 'notes'), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  for (const dir of [own, other]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'file.txt'), 'x') }
  assert.equal(discardBundle({ name: 'notes', dir: other }, root), false)
  assert.equal(discardBundle({ name: 'Orbit-standalone-v2000', dir: outside }, root), false, 'a bundle outside the root is refused')
  assert.ok(fs.existsSync(other) && fs.existsSync(outside))
  assert.equal(discardBundle({ name: 'Orbit-standalone-v2000', dir: own }, root), true)
  assert.equal(fs.existsSync(own), false)
})
