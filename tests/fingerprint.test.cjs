'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SHELL_FILES, RENDERER_INPUTS, fingerprints, rendererHash, rendererFiles, hashFiles, listFiles, normalizeLineEndings } = require('../electron/fingerprint.cjs')

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fingerprint-'))
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

// A small repository: shell files, runtime files in electron/ and electron/runtime/, and files that are neither.
const SOURCES = {
  'package.json': '{ "name": "orbit" }\n',
  'electron/main.cjs': "require('./runtime-client.cjs')\n",
  'electron/preload.cjs': 'bridge\n',
  'electron/runtime-client.cjs': 'client\n',
  'electron/runtime.mts': 'export const runtime = 1\n',
  'electron/runtime/turn.mts': 'export const turn = 1\n',
  'electron/model-tiers.json': '{ "a": 3 }\n',
  'src/App.tsx': 'app\n',
  'docs/notes.md': 'notes\n',
}

test('SHELL_FILES holds the main-process files of the contract, as POSIX paths, and is fixed at load time', () => {
  for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'electron/ipc-contract.cjs', 'electron/ipc-handlers.cjs', 'electron/ipc-guard.cjs', 'electron/runtime-client.cjs', 'electron/fingerprint.cjs', 'package.json']) {
    assert.ok(SHELL_FILES.includes(file), `${file} is a shell file`)
  }
  assert.ok(SHELL_FILES.every((file) => !file.includes('\\') && !path.isAbsolute(file)))
  assert.equal(new Set(SHELL_FILES).size, SHELL_FILES.length)
  assert.ok(Object.isFrozen(SHELL_FILES), 'the script reads the list in another process: it is edited in the source, not pushed at run time')
})

test('fingerprints are deterministic: the same files give the same hashes whatever the root and the creation order', (t) => {
  const first = write(temporary(t), SOURCES)
  const second = write(temporary(t), Object.fromEntries(Object.entries(SOURCES).reverse()))
  const a = fingerprints(first)
  assert.match(a.shell, /^[0-9a-f]{40}$/)
  assert.match(a.runtime, /^[0-9a-f]{40}$/)
  assert.notEqual(a.shell, a.runtime)
  assert.deepEqual(fingerprints(first), a, 'twice in a row')
  assert.deepEqual(fingerprints(second), a, 'another folder, files created in the opposite order')
})

test('line endings do not count: a CRLF checkout and LF files hash alike, a real edit does not', (t) => {
  const lf = write(temporary(t), SOURCES)
  const crlf = write(temporary(t), Object.fromEntries(Object.entries(SOURCES).map(([file, content]) => [file, content.replace(/\n/g, '\r\n')])))
  assert.deepEqual(fingerprints(crlf), fingerprints(lf))
  assert.deepEqual(normalizeLineEndings(Buffer.from('a\r\nb\rc\r\n')), Buffer.from('a\nb\rc\n'), 'only CR before LF goes')
  write(crlf, { 'electron/runtime.mts': 'export const runtime = 2\r\n' })
  assert.notEqual(fingerprints(crlf).runtime, fingerprints(lf).runtime)
})

test('a runtime edit moves only the runtime hash, a shell edit only the shell hash, other folders neither', (t) => {
  const root = write(temporary(t), SOURCES)
  const base = fingerprints(root)
  /** Which hashes `mutate` moves; then the files it added are removed, the others rewritten, and the base state checked. */
  const changed = (mutate, added = []) => {
    mutate()
    const next = fingerprints(root)
    for (const file of added) fs.rmSync(path.join(root, file), { recursive: true, force: true })
    write(root, SOURCES)
    assert.deepEqual(fingerprints(root), base, 'back to the base state')
    return { shell: next.shell !== base.shell, runtime: next.runtime !== base.runtime }
  }
  const edit = (files) => () => write(root, files)
  assert.deepEqual(changed(edit({ 'electron/runtime/turn.mts': 'export const turn = 2\n' })), { shell: false, runtime: true }, 'a file in electron/runtime/')
  assert.deepEqual(changed(edit({ 'electron/model-tiers.json': '{ "a": 2 }\n' })), { shell: false, runtime: true }, 'data files the runtime reads')
  assert.deepEqual(changed(edit({ 'electron/new-tool.mts': 'new\n' }), ['electron/new-tool.mts']), { shell: false, runtime: true }, 'a new runtime module')
  assert.deepEqual(changed(edit({ 'electron/main.cjs': 'changed\n' })), { shell: true, runtime: false }, 'main.cjs')
  assert.deepEqual(changed(edit({ 'package.json': '{ "name": "orbit", "version": "2" }\n' })), { shell: true, runtime: false }, 'package.json')
  assert.deepEqual(changed(() => fs.rmSync(path.join(root, 'electron', 'preload.cjs'))), { shell: true, runtime: false }, 'a deleted shell file')
  assert.deepEqual(changed(edit({ 'electron/ipc-guard.cjs': 'guard\n' }), ['electron/ipc-guard.cjs']), { shell: true, runtime: false }, 'a shell file that did not exist before')
  assert.deepEqual(changed(edit({ 'src/App.tsx': 'app 2\n', 'docs/notes.md': 'more\n', 'tests/x.test.cjs': 'test\n' }), ['tests']), { shell: false, runtime: false }, 'src/, docs/ and tests/ are not main-process code')
  const rename = () => fs.renameSync(path.join(root, 'electron', 'runtime.mts'), path.join(root, 'electron', 'renamed.mts'))
  assert.deepEqual(changed(rename, ['electron/renamed.mts']), { shell: false, runtime: true }, 'the path is part of the hash')
})

test('another shell list moves a file from the runtime hash to the shell hash', (t) => {
  const root = write(temporary(t), SOURCES)
  const standard = fingerprints(root)
  const extended = fingerprints(root, { shellFiles: [...SHELL_FILES, 'electron\\runtime.mts'] })
  assert.notEqual(extended.shell, standard.shell)
  assert.notEqual(extended.runtime, standard.runtime)
  write(root, { 'electron/runtime.mts': 'export const runtime = 2\n' })
  const after = fingerprints(root, { shellFiles: [...SHELL_FILES, 'electron/runtime.mts'] })
  assert.equal(after.runtime, extended.runtime, 'a listed file is shell code only')
  assert.notEqual(after.shell, extended.shell)
})

test('listFiles and hashFiles: sorted POSIX paths, any order or separator, missing files and directories skipped', (t) => {
  const root = write(temporary(t), SOURCES)
  assert.deepEqual(listFiles(root, 'electron'), ['electron/main.cjs', 'electron/model-tiers.json', 'electron/preload.cjs', 'electron/runtime-client.cjs', 'electron/runtime.mts', 'electron/runtime/turn.mts'])
  assert.deepEqual(listFiles(root, 'missing'), [])
  const files = ['src/App.tsx', 'package.json']
  assert.equal(hashFiles(root, files), hashFiles(root, ['package.json', 'src\\App.tsx', 'src/App.tsx', 'src/Missing.tsx', 'src']))
  assert.notEqual(hashFiles(root, files), hashFiles(root, ['src/App.tsx']))
  // Length-prefixed entries: moving bytes from one file to the next is a different state.
  const split = write(temporary(t), { 'a.txt': 'ab', 'b.txt': 'c' })
  const moved = write(temporary(t), { 'a.txt': 'a', 'b.txt': 'bc' })
  assert.notEqual(hashFiles(split, ['a.txt', 'b.txt']), hashFiles(moved, ['a.txt', 'b.txt']))
})

test('rendererHash covers exactly what vite build reads, line endings aside, and is the hash of the build record', (t) => {
  const root = write(temporary(t), { ...SOURCES, 'index.html': '<div id="root"></div>\n', 'vite.config.ts': 'config\n', 'tsconfig.json': '{}\n', 'src/view/Panel.tsx': 'panel\n' })
  assert.deepEqual([...RENDERER_INPUTS], ['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json'])
  assert.ok(Object.isFrozen(RENDERER_INPUTS))
  assert.deepEqual(rendererFiles(root), ['index.html', 'package.json', 'src/App.tsx', 'src/view/Panel.tsx', 'tsconfig.json', 'vite.config.ts'])
  const base = rendererHash(root)
  assert.match(base, /^[0-9a-f]{40}$/)
  assert.equal(base, hashFiles(root, rendererFiles(root)))
  /** Whether writing `files` moves the hash; the files are put back (or removed) afterwards. */
  const moves = (files) => {
    const before = Object.fromEntries(Object.keys(files).map((file) => [file, fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null]))
    write(root, files)
    const moved = rendererHash(root) !== base
    for (const [file, content] of Object.entries(before)) {
      if (content) fs.writeFileSync(path.join(root, file), content)
      else fs.rmSync(path.join(root, file))
    }
    assert.equal(rendererHash(root), base, 'back to the base state')
    return moved
  }
  for (const file of ['src/App.tsx', 'src/new.ts', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json']) assert.equal(moves({ [file]: 'changed\n' }), true, `${file} is a renderer input`)
  for (const file of ['electron/runtime.mts', 'electron/main.cjs', 'docs/notes.md', 'tests/x.test.cjs']) assert.equal(moves({ [file]: 'changed\n' }), false, `${file} is not`)
  assert.equal(moves({ 'src/App.tsx': 'app\r\n' }), false, 'a CRLF copy of the same file')
  // The self-upgrade script records the same hash for the build it makes (dist/orbit-build.json rendererHash).
  assert.equal(require('../scripts/self-upgrade.cjs').rendererState(root).hash, base)
})

test('the repository itself is fingerprinted in milliseconds', (t) => {
  const root = path.resolve(__dirname, '..')
  const began = process.hrtime.bigint()
  const result = fingerprints(root)
  const ms = Number(process.hrtime.bigint() - began) / 1e6
  t.diagnostic(`fingerprints(repository) took ${ms.toFixed(1)} ms`)
  assert.match(result.shell, /^[0-9a-f]{40}$/)
  assert.match(result.runtime, /^[0-9a-f]{40}$/)
  assert.ok(ms < 2000, `fingerprints took ${ms} ms`)
})
