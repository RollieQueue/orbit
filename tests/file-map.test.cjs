const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/diff-parse.test.cjs: vite's oxc transform, then an ES module from a data URL.
// file-map.ts only has a type import, which the transform erases.
let fileMap, changedFiles, isSharedFile, isConflictFile
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'file-map.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
  ;({ fileMap, changedFiles, isSharedFile, isConflictFile } = mod)
})

const agent = (id, read, wrote) => ({ id, name: id, files: { read, wrote } })
const byPath = files => Object.fromEntries(files.map(file => [file.path, file]))

test('fileMap attributes reads and writes to each agent', () => {
  const files = byPath(fileMap([
    agent('a', ['src/x.ts', 'README.md'], ['src/y.ts']),
    agent('b', ['src/y.ts'], ['src/z.ts'])
  ]))
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'src/x.ts', 'src/y.ts', 'src/z.ts'])
  assert.deepEqual(files['src/x.ts'], { path: 'src/x.ts', readers: ['a'], writers: [] })
  assert.deepEqual(files['src/y.ts'], { path: 'src/y.ts', readers: ['b'], writers: ['a'] })
  assert.deepEqual(files['src/z.ts'], { path: 'src/z.ts', readers: [], writers: ['b'] })
})

test('fileMap tolerates agents without file lists and an empty team', () => {
  assert.deepEqual(fileMap([]), [])
  assert.deepEqual(fileMap([{ id: 'a', name: 'a' }, { id: 'b', name: 'b', files: {} }]), [])
})

test('fileMap lists an agent that reads and writes the same path in both lists', () => {
  const [file] = fileMap([agent('a', ['f.js'], ['f.js'])])
  assert.deepEqual(file, { path: 'f.js', readers: ['a'], writers: ['a'] })
})

test('fileMap keeps paths distinct by exact text (case and slashes are not normalised)', () => {
  const files = fileMap([agent('a', [], ['src/A.ts', 'src/a.ts', 'src\\a.ts'])])
  assert.equal(files.length, 3)
})

test('read-only files have no writers and are not shared or in conflict unless several agents read them', () => {
  const files = byPath(fileMap([agent('a', ['r.md', 'both.md'], []), agent('b', ['both.md'], [])]))
  assert.equal(files['r.md'].writers.length, 0)
  assert.equal(isSharedFile(files['r.md']), false)
  assert.equal(isConflictFile(files['r.md']), false)
  // Read by two agents but written by nobody: not shared (shared needs a writer).
  assert.equal(isSharedFile(files['both.md']), false)
  assert.equal(isConflictFile(files['both.md']), false)
})

test('a file written by one agent and read by another is shared but not a conflict', () => {
  const [file] = fileMap([agent('a', [], ['f']), agent('b', ['f'], [])])
  assert.equal(isSharedFile(file), true)
  assert.equal(isConflictFile(file), false)
})

test('a file written by two agents is shared and a conflict', () => {
  const [file] = fileMap([agent('a', [], ['f']), agent('b', [], ['f'])])
  assert.equal(isSharedFile(file), true)
  assert.equal(isConflictFile(file), true)
})

test('a file touched (read and written) by a single agent is neither shared nor a conflict', () => {
  const [file] = fileMap([agent('a', ['f'], ['f'])])
  assert.equal(isSharedFile(file), false)
  assert.equal(isConflictFile(file), false)
})

test('one agent listing a path twice as written is not a conflict', () => {
  const [file] = fileMap([agent('a', [], ['f', 'f'])])
  assert.deepEqual(file.writers, ['a', 'a'])
  assert.equal(isConflictFile(file), false)
  assert.equal(isSharedFile(file), false)
})

test('conflict implies shared, and shared implies a writer, for every combination of three agents', () => {
  // Each agent has one of four roles for the file: none, read, write, read+write.
  const role = (id, n) => agent(id, n & 1 ? ['f'] : [], n & 2 ? ['f'] : [])
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) {
    const [file] = fileMap([role('a', a), role('b', b), role('c', c)]).filter(f => f.path === 'f')
    if (!file) continue
    const writers = new Set(file.writers).size
    const touching = new Set([...file.readers, ...file.writers]).size
    assert.equal(isConflictFile(file), writers > 1, `conflict ${a}${b}${c}`)
    assert.equal(isSharedFile(file), writers > 0 && touching > 1, `shared ${a}${b}${c}`)
    if (isConflictFile(file)) assert.equal(isSharedFile(file), true)
    if (isSharedFile(file)) assert.ok(file.writers.length > 0)
  }
})

test('the chip predicates built on these helpers partition the map consistently', () => {
  // Mirrors the counts a user sees: changed + readonly = all, conflict <= shared <= changed.
  const files = fileMap([
    agent('a', ['r1', 'r2'], ['w1', 'shared', 'conf']),
    agent('b', ['shared'], ['conf']),
    agent('c', ['r2'], [])
  ])
  const changed = files.filter(file => file.writers.length > 0)
  const readonly = files.filter(file => file.writers.length === 0)
  const shared = files.filter(isSharedFile)
  const conflict = files.filter(isConflictFile)
  assert.equal(changed.length + readonly.length, files.length)
  assert.deepEqual(changed.map(file => file.path).sort(), ['conf', 'shared', 'w1'])
  assert.deepEqual(readonly.map(file => file.path).sort(), ['r1', 'r2'])
  assert.deepEqual(shared.map(file => file.path).sort(), ['conf', 'shared'])
  assert.deepEqual(conflict.map(file => file.path), ['conf'])
})

test('changedFiles counts distinct written paths across agents', () => {
  assert.equal(changedFiles(undefined), 0)
  assert.equal(changedFiles({ agents: [] }), 0)
  assert.equal(changedFiles({ agents: [agent('a', ['x'], []), { id: 'b', name: 'b' }] }), 0)
  assert.equal(changedFiles({ agents: [agent('a', [], ['x', 'y']), agent('b', ['z'], ['y', 'w'])] }), 3)
  assert.equal(changedFiles({}), 0)
})
