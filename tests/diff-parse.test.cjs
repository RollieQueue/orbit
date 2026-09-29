const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// typescript 7 has no JS transpile API, so the TS parser is compiled with vite's oxc transform and loaded as an ES module.
let parseUnifiedDiff
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'diff-parse.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
  parseUnifiedDiff = mod.parseUnifiedDiff
})

const rows = hunk => hunk.lines.map(l => `${l.kind}:${l.oldLine ?? '-'}:${l.newLine ?? '-'}:${l.text}`)

test('parses a git diff with two files, numbering lines on both sides', () => {
  const files = parseUnifiedDiff([
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,3 @@ function x',
    ' keep',
    '-old',
    '+new',
    ' tail',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -10 +10,2 @@',
    ' ctx',
    '+extra',
    ''
  ].join('\n'))
  assert.equal(files.length, 2)
  assert.deepEqual([files[0].oldPath, files[0].newPath, files[0].status], ['src/a.js', 'src/a.js', 'modified'])
  assert.deepEqual([files[0].added, files[0].removed], [1, 1])
  assert.equal(files[0].hunks[0].header, '@@ -1,3 +1,3 @@ function x')
  assert.deepEqual(rows(files[0].hunks[0]), ['context:1:1:keep', 'del:2:-:old', 'add:-:2:new', 'context:3:3:tail'])
  assert.equal(files[1].newPath, 'b.txt')
  assert.deepEqual(rows(files[1].hunks[0]), ['context:10:10:ctx', 'add:-:11:extra'])
})

test('accepts a header-less snippet that starts at @@', () => {
  const files = parseUnifiedDiff('@@ -5,2 +5,2 @@\n a\n-b\n+c')
  assert.equal(files.length, 1)
  assert.equal(files[0].newPath, '')
  assert.deepEqual(rows(files[0].hunks[0]), ['context:5:5:a', 'del:6:-:b', 'add:-:6:c'])
})

test('detects created and deleted files from headers and /dev/null', () => {
  const created = parseUnifiedDiff('diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n')
  assert.equal(created[0].status, 'added')
  assert.equal(created[0].oldPath, '')
  assert.equal(created[0].newPath, 'n.txt')
  assert.equal(created[0].added, 2)
  const deleted = parseUnifiedDiff('--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n')
  assert.equal(deleted[0].status, 'deleted')
  assert.equal(deleted[0].oldPath, 'gone.txt')
  assert.equal(deleted[0].newPath, '')
  assert.equal(deleted[0].removed, 2)
  assert.equal(parseUnifiedDiff('@@ -0,0 +1 @@\n+x')[0].status, 'added')
  assert.equal(parseUnifiedDiff('@@ -1 +0,0 @@\n-x')[0].status, 'deleted')
})

test('keeps the no-newline marker as a meta row without shifting line numbers', () => {
  const [file] = parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file')
  assert.deepEqual(rows(file.hunks[0]), [
    'del:1:-:a',
    'meta:-:-:\\ No newline at end of file',
    'add:-:1:b',
    'meta:-:-:\\ No newline at end of file'
  ])
  assert.deepEqual([file.added, file.removed], [1, 1])
})

test('handles CRLF line endings', () => {
  const [file] = parseUnifiedDiff('--- a/x\r\n+++ b/x\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n')
  assert.equal(file.newPath, 'x')
  assert.deepEqual(rows(file.hunks[0]), ['context:1:1:a', 'del:2:-:b', 'add:-:2:c'])
})

test('returns nothing for empty input', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
  assert.deepEqual(parseUnifiedDiff('\n'), [])
  assert.deepEqual(parseUnifiedDiff('just some text'), [])
})

test('survives a truncated diff whose hunk counts do not match', () => {
  const [file] = parseUnifiedDiff('--- a/big\n+++ b/big\n@@ -1,50 +1,60 @@\n a\n-b\n+c\n+d')
  assert.deepEqual(rows(file.hunks[0]), ['context:1:1:a', 'del:2:-:b', 'add:-:2:c', 'add:-:3:d'])
  // Counts smaller than the body do not drop lines either.
  const [small] = parseUnifiedDiff('@@ -1 +1 @@\n a\n-b\n-c\n+d\n+e')
  assert.equal(small.hunks[0].lines.length, 5)
})

test('a removed line that looks like a file header stays a removed line inside a hunk', () => {
  const files = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n--- not a header\n-y\n+z')
  assert.equal(files.length, 1)
  const [file] = files
  assert.deepEqual(rows(file.hunks[0]), ['del:1:-:-- not a header', 'del:2:-:y', 'add:-:1:z'])
})

test('drops blank separator lines between files but keeps empty context lines that counts expect', () => {
  const files = parseUnifiedDiff('@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\ndiff --git a/n b/n\n@@ -1 +1 @@\n-x\n+y\n')
  assert.equal(files.length, 2)
  assert.deepEqual(rows(files[0].hunks[0]), ['context:1:1:a', 'context:2:2:', 'del:3:-:b', 'add:-:3:c'])
  assert.equal(files[1].hunks[0].lines.length, 2)
})

test('marks binary files and renames', () => {
  const files = parseUnifiedDiff(
    'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\ndiff --git a/o.js b/n.js\nsimilarity index 90%\nrename from o.js\nrename to n.js\n--- a/o.js\n+++ b/n.js\n@@ -1 +1 @@\n-a\n+b\n'
  )
  assert.equal(files[0].binary, true)
  assert.equal(files[0].hunks.length, 0)
  assert.deepEqual([files[1].status, files[1].oldPath, files[1].newPath], ['renamed', 'o.js', 'n.js'])
})

test('parses a large diff quickly', () => {
  const body = []
  for (let i = 0; i < 50000; i++) body.push(i % 3 === 0 ? `+added ${i}` : i % 3 === 1 ? `-removed ${i}` : ` ctx ${i}`)
  const started = Date.now()
  const [file] = parseUnifiedDiff(`--- a/big\n+++ b/big\n@@ -1,1 +1,1 @@\n${body.join('\n')}`)
  assert.equal(file.hunks[0].lines.length, 50000)
  assert.ok(Date.now() - started < 1000)
})

test('decodes the C-style escapes git puts in quoted paths', () => {
  const quoted = String.raw`"\303\274n\303\257 \"q\".txt"`
  const [file] = parseUnifiedDiff(`diff --git "a/${quoted.slice(1)} "b/${quoted.slice(1)}\n--- "a/${quoted.slice(1)}\n+++ "b/${quoted.slice(1)}\n@@ -1 +1 @@\n-a\n+b\n`)
  assert.deepEqual([file.oldPath, file.newPath], ['ünï "q".txt', 'ünï "q".txt'])
  const [renamed] = parseUnifiedDiff(String.raw`diff --git "a/\321\204.txt" "b/\321\206.txt"
similarity index 100%
rename from "\321\204.txt"
rename to "\321\206.txt"
`)
  assert.deepEqual([renamed.status, renamed.oldPath, renamed.newPath], ['renamed', 'ф.txt', 'ц.txt'])
  // An unquoted path keeps its backslashes.
  assert.equal(parseUnifiedDiff(String.raw`--- a/dir\file.txt
+++ b/dir\file.txt
@@ -1 +1 @@
-a
+b
`)[0].newPath, String.raw`dir\file.txt`)
})
