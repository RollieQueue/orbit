// Tolerant unified-diff parser. Pure: no DOM, no imports (the tests transpile this file on its own).
// Hunk counts are only a hint (they decide whether a trailing blank line is real context), never a reason to reject input,
// so truncated or hand-edited diffs still parse.

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta'

export type DiffLine = {
  kind: DiffLineKind
  // Line numbers in the old/new file; null where the line does not exist on that side (or the hunk header was unreadable).
  oldLine: number | null
  newLine: number | null
  text: string
}

export type DiffHunk = {
  // Raw '@@ ... @@ section' line.
  header: string
  oldStart: number | null
  newStart: number | null
  // context/add/del rows, plus 'meta' rows for '\ No newline at end of file' markers.
  lines: DiffLine[]
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export type DiffFile = {
  oldPath: string
  newPath: string
  status: DiffFileStatus
  binary: boolean
  added: number
  removed: number
  hunks: DiffHunk[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const DEV_NULL = '/dev/null'

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// Git quotes a path holding non-ASCII or special characters and escapes it C-style: octal bytes of the UTF-8 text
// ("\303\274.txt" is «ü.txt») plus \t, \n, \", \\.
function unescapeQuoted(text: string): string {
  if (!text.includes('\\')) return text
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const octal = text[i] === '\\' ? /^[0-7]{3}/.exec(text.slice(i + 1, i + 4)) : null
    if (octal) { bytes.push(parseInt(octal[0], 8) & 255); i += 3; continue }
    if (text[i] === '\\' && text[i + 1] in ESCAPES) { bytes.push(ESCAPES[text[i + 1]]); i++; continue }
    const point = text.codePointAt(i)!
    bytes.push(...encoder.encode(String.fromCodePoint(point)))
    if (point > 0xffff) i++
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

function stripPrefix(path: string): string {
  let p = path.trim()
  // `--- a/x\t2020-01-01 ...` (plain diff -u) carries a timestamp after a tab.
  const tab = p.indexOf('\t')
  if (tab >= 0) p = p.slice(0, tab)
  if (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"') p = unescapeQuoted(p.slice(1, -1))
  return p
}

function displayPath(path: string): string {
  const p = stripPrefix(path)
  return p === DEV_NULL ? '' : p.replace(/^[ab]\//, '')
}

// `diff --git a/x b/x`: split on the ' b/' that mirrors the a/ path when possible, else in half.
function gitPaths(rest: string): [string, string] {
  const m = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest)
  if (m) return [rest.startsWith('"') ? unescapeQuoted(m[1]) : m[1], rest.endsWith('"') ? unescapeQuoted(m[2]) : m[2]]
  return [rest, rest]
}

type Builder = {
  file: DiffFile
  hunk: DiffHunk | null
  oldCount: number | null
  newCount: number | null
  oldSeen: number
  newSeen: number
  oldLine: number | null
  newLine: number | null
  // A header-less snippet has not seen a path yet.
  hasHeader: boolean
}

function newFile(): DiffFile {
  return { oldPath: '', newPath: '', status: 'modified', binary: false, added: 0, removed: 0, hunks: [] }
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  const files: DiffFile[] = []
  let cur = null as Builder | null

  // Blank lines that trail a hunk are separators, not context, unless the declared counts still expect them.
  const closeHunk = () => {
    if (!cur || !cur.hunk) return
    const rows = cur.hunk.lines
    while (rows.length) {
      const last = rows[rows.length - 1]
      if (last.kind !== 'context' || last.text !== '') break
      const overrun =
        cur.oldCount === null || cur.newCount === null || cur.oldSeen > cur.oldCount || cur.newSeen > cur.newCount
      if (!overrun) break
      rows.pop()
      cur.oldSeen--
      cur.newSeen--
    }
    cur.hunk = null
  }

  const startFile = (hasHeader: boolean) => {
    closeHunk()
    const file = newFile()
    files.push(file)
    cur = {
      file, hunk: null, oldCount: null, newCount: null, oldSeen: 0, newSeen: 0, oldLine: null, newLine: null, hasHeader
    }
    return cur
  }

  const setPaths = (b: Builder, oldRaw: string | null, newRaw: string | null) => {
    if (oldRaw !== null) {
      b.file.oldPath = displayPath(oldRaw)
      if (stripPrefix(oldRaw) === DEV_NULL) b.file.status = 'added'
    }
    if (newRaw !== null) {
      b.file.newPath = displayPath(newRaw)
      if (stripPrefix(newRaw) === DEV_NULL) b.file.status = 'deleted'
    }
    b.hasHeader = true
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('diff --git ')) {
      const b = startFile(true)
      const [o, n] = gitPaths(line.slice(11))
      b.file.oldPath = o
      b.file.newPath = n
      continue
    }

    // '--- x' + '+++ y' + '@@' is a file header; anywhere else '--- ' is just a removed line starting with '-- '.
    if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) {
      const after = lines[i + 2]
      if (after === undefined || after.startsWith('@@') || !cur || !cur.hunk) {
        // Continue the file opened by `diff --git` while it is still header-only; otherwise this starts a new file.
        const b: Builder = cur && !cur.hunk ? cur : startFile(true)
        setPaths(b, line.slice(4), lines[i + 1].slice(4))
        i++
        continue
      }
    }

    if (cur && cur.hunk === null) {
      // Extended header lines between `diff --git` and the first hunk (or between hunks of a headerless snippet).
      if (line.startsWith('new file mode')) { cur.file.status = 'added'; continue }
      if (line.startsWith('deleted file mode')) { cur.file.status = 'deleted'; continue }
      if (line.startsWith('rename from ')) { cur.file.status = 'renamed'; cur.file.oldPath = displayPath(line.slice(12)); continue }
      if (line.startsWith('rename to ')) { cur.file.status = 'renamed'; cur.file.newPath = displayPath(line.slice(10)); continue }
    }
    if (!cur || !cur.hunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { (cur ?? startFile(false)).file.binary = true; continue }
    }

    if (line.startsWith('@@')) {
      const b: Builder = cur ?? startFile(false)
      closeHunk()
      const m = HUNK.exec(line)
      b.oldLine = m ? Number(m[1]) : null
      b.newLine = m ? Number(m[3]) : null
      b.oldCount = m ? (m[2] === undefined ? 1 : Number(m[2])) : null
      b.newCount = m ? (m[4] === undefined ? 1 : Number(m[4])) : null
      b.oldSeen = 0
      b.newSeen = 0
      b.hunk = { header: line, oldStart: b.oldLine, newStart: b.newLine, lines: [] }
      b.file.hunks.push(b.hunk)
      // `@@ -0,0 +1,N @@` / `@@ -1,N +0,0 @@` mark creation/deletion when no header said so.
      if (!b.hasHeader && b.file.hunks.length === 1 && m) {
        if (Number(m[1]) === 0 && b.oldCount === 0) b.file.status = 'added'
        else if (Number(m[3]) === 0 && b.newCount === 0) b.file.status = 'deleted'
      }
      continue
    }

    const b = cur
    if (!b || !b.hunk) continue // preamble before the first hunk: commit message, 'index ...' and the like
    const rows = b.hunk.lines
    const first = line[0]
    const bump = (n: number | null) => (n === null ? null : n + 1)

    if (first === '\\') {
      rows.push({ kind: 'meta', oldLine: null, newLine: null, text: line })
    } else if (first === '+') {
      rows.push({ kind: 'add', oldLine: null, newLine: b.newLine, text: line.slice(1) })
      b.newLine = bump(b.newLine)
      b.newSeen++
      b.file.added++
    } else if (first === '-') {
      rows.push({ kind: 'del', oldLine: b.oldLine, newLine: null, text: line.slice(1) })
      b.oldLine = bump(b.oldLine)
      b.oldSeen++
      b.file.removed++
    } else if (first === ' ' || line === '') {
      // Some tools strip the single space of an empty context line.
      rows.push({ kind: 'context', oldLine: b.oldLine, newLine: b.newLine, text: line.slice(1) })
      b.oldLine = bump(b.oldLine)
      b.newLine = bump(b.newLine)
      b.oldSeen++
      b.newSeen++
    }
    // Anything else inside a hunk (stray header line such as 'index ...') is ignored.
  }
  closeHunk()

  return files
}
