const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectContextStore } = require('../electron/project-context.mts')
const { projectPacket, saveNote } = require('../electron/shared-context.mts')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-shared-context-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  return { root, workspace }
}
const { workspaceKey } = require('../electron/storage.mts')

test('the fingerprint and folder counts an older version stored are dropped: agents get notes and the overview, nothing else', t => {
  const { root, workspace } = fixture(t)
  const legacy = { fingerprint: '{"root":"C:/Users/x","status":"?? Desktop/smth/"}', root: 'C:/Users/x', exactRoot: false, scopedPath: 'Desktop\\smth', fileCount: 0, changedCount: 1, manifests: 0, recent: '', updatedAt: '2026-09-28T00:00:00.000Z', notes: [{ key: 'architecture', summary: 'KEPT_NOTE', files: {}, updatedAt: '2026-09-28T00:00:00.000Z' }] }
  fs.writeFileSync(path.join(root, 'project-context.json'), JSON.stringify({ [workspaceKey(workspace)]: legacy, 'not an entry': 5 }))
  const store = new ProjectContextStore(root)
  assert.deepEqual(Object.keys(store.getLatest(workspace)).sort(), ['notes', 'updatedAt', 'workspace'])
  const packet = projectPacket(store, workspace)
  assert.deepEqual(Object.keys(packet).sort(), ['notes', 'overview', 'updatedAt'])
  assert.equal(packet.notes[0].summary, 'KEPT_NOTE')
  saveNote(store, workspace, null, { key: 'second', summary: 'added later' })
  const written = JSON.parse(fs.readFileSync(path.join(root, 'project-context.json'), 'utf8'))
  const entry = written[workspaceKey(workspace)]
  assert.deepEqual(Object.keys(entry).sort(), ['notes', 'updatedAt', 'workspace'])
  assert.deepEqual(entry.notes.map(note => note.key), ['architecture', 'second'])
  assert.doesNotMatch(JSON.stringify(written), /fingerprint|scopedPath|manifests/)
})

test('saving under a key that redaction rewrites still replaces the earlier note instead of adding a twin', t => {
  const { root, workspace } = fixture(t)
  const store = new ProjectContextStore(root)
  saveNote(store, workspace, null, { key: 'password=hunter2', summary: 'first' })
  saveNote(store, workspace, null, { key: 'password=hunter2', summary: 'second' })
  const notes = store.getLatest(workspace).notes
  assert.equal(notes.length, 1)
  assert.equal(notes[0].key, 'password=[redacted]')
  assert.equal(notes[0].summary, 'second')
})

test('a note remembers the content of its files: the same size with different text is stale, an untouched file is not', t => {
  const { root, workspace } = fixture(t)
  const store = new ProjectContextStore(root)
  fs.writeFileSync(path.join(workspace, 'a.js'), 'const a = 1')
  fs.writeFileSync(path.join(workspace, 'b.js'), 'const b = 1')
  saveNote(store, workspace, null, { key: 'ab', summary: 'a and b', files: ['a.js', 'b.js'] })
  assert.equal(projectPacket(store, workspace).notes[0].stale, false)
  const later = new Date(Date.now() + 5000)
  fs.writeFileSync(path.join(workspace, 'a.js'), 'const a = 2'); fs.utimesSync(path.join(workspace, 'a.js'), later, later)
  assert.equal(projectPacket(store, workspace).notes[0].stale, true, 'same size, different bytes')
  fs.rmSync(path.join(workspace, 'b.js'))
  const packet = projectPacket(store, workspace)
  assert.equal(packet.notes[0].stale, true)
  assert.deepEqual(Object.keys(packet.notes[0].files), ['a.js', 'b.js'], 'the note keeps naming what it depended on')
})

test('a workspace that no longer exists yields an empty overview instead of an exception in the middle of a turn', t => {
  const { root } = fixture(t)
  const packet = projectPacket(new ProjectContextStore(root), path.join(root, 'gone'))
  assert.deepEqual(packet.overview, { entries: [], scripts: {} })
  assert.deepEqual(packet.notes, [])
})

test('the overview leads with how the project is built, tested, linted and run, and has no profile when nothing is recognized', t => {
  const { root, workspace } = fixture(t)
  const store = new ProjectContextStore(root)
  fs.writeFileSync(path.join(workspace, 'README.md'), '# nothing to run\n')
  assert.deepEqual(projectPacket(store, workspace).overview, { entries: ['README.md'], scripts: {} }, 'no profile key for a folder without manifests')
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'tsc' } }))
  fs.writeFileSync(path.join(workspace, 'Cargo.toml'), '[package]\nname = "x"\n')
  const { overview } = projectPacket(store, workspace)
  assert.deepEqual(Object.keys(overview), ['profile', 'entries', 'scripts'], 'the profile comes first: a size cut of the prompt reaches it last')
  assert.deepEqual(overview.profile.ecosystems, ['node', 'rust'])
  assert.equal(overview.profile.commands.test, 'npm test (package.json)')
  assert.equal(overview.profile.commands.lint, 'cargo clippy (Cargo.toml)')
  assert.deepEqual(overview.scripts, { test: 'node --test', build: 'tsc' }, 'the package.json scripts are still shown as found')
  assert.deepEqual(overview.entries, ['Cargo.toml', 'README.md', 'package.json'])
  assert.ok(JSON.stringify(overview.profile).length <= 1200)
  assert.equal(projectPacket(store, workspace).overview.profile, overview.profile, 'an unchanged project is not detected again')
})
