// Proves that a typing change changed types only.
//
// For every .mts file under electron/ that differs from HEAD, both versions are stripped of their types
// exactly as Node does it at run time (module.stripTypeScriptTypes, mode 'strip' — the code Node executes),
// the two JavaScript results are parsed with oxc (rolldown/parseAst, no ParenthesizedExpression nodes) and
// the syntax trees are compared with positions, comments, whitespace, redundant parentheses and literal
// spelling ignored. Changed .cjs files are compared the same way without the stripping. Every remaining
// difference is printed with its line and code in both versions. Exit code 0: no run-time difference.
//
// usage: node scripts/check-type-equivalence.mjs [repo] [--base=<rev>] [--exclude=electron/a.mts,electron/b.mts] [--json]
//        node scripts/check-type-equivalence.mjs [repo] --self-test   (checks the checker on known pairs first)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.removeAllListeners('warning')

const args = process.argv.slice(2)
const repo = args.find(a => !a.startsWith('--')) || path.resolve(import.meta.dirname, '..')
// The revision the working copy is compared with (HEAD by default; e.g. --base=afdf490 re-checks the 0.4 typing wave).
const base = (args.find(a => a.startsWith('--base=')) || '--base=HEAD').slice(7)
const exclude = new Set((args.find(a => a.startsWith('--exclude=')) || '--exclude=').slice(10).split(',').filter(Boolean))
const asJson = args.includes('--json')

const { parseAst } = await import(pathToFileURL(path.join(repo, 'node_modules/rolldown/dist/parse-ast-index.mjs')).href)

// Keys that carry no run-time meaning: source positions, comments, and the spelling of a literal
// ('a' vs "a", 1e3 vs 1000); the literal's value is still compared.
const SKIP = new Set(['start', 'end', 'range', 'loc', 'raw', 'comments', 'hashbang'])

const isNode = v => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string'
const unwrap = v => { while (isNode(v) && v.type === 'ParenthesizedExpression') v = v.expression; return v }
const fieldsOf = node => Object.keys(node).filter(k => !SKIP.has(k) && !(k === 'value' && node.regex)).sort()

const memo = new WeakMap()
function key(value) {
  if (value === undefined) return 'u'
  if (value === null) return 'n'
  switch (typeof value) {
    case 'bigint': return `b${value}`
    case 'number': return Object.is(value, -0) ? 'd-0' : `d${value}`
    case 'string': return `s${JSON.stringify(value)}`
    case 'boolean': return value ? 't' : 'f'
    case 'object': break
    default: return `?${String(value)}`
  }
  if (value instanceof RegExp) return `r${value}`
  const unwrapped = unwrap(value)
  if (unwrapped !== value) return key(unwrapped)
  const cached = memo.get(value)
  if (cached) return cached
  const hash = createHash('sha1')
  if (Array.isArray(value)) hash.update(`[${value.map(key).join(',')}]`)
  else hash.update(`{${fieldsOf(value).map(k => `${k}:${key(value[k])}`).join(',')}}`)
  const out = hash.digest('base64')
  memo.set(value, out)
  return out
}

// Longest common subsequence of two key lists: the pairs of indexes that match.
function lcs(a, b) {
  const n = a.length, m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  }
  const pairs = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++ } else if (table[i + 1][j] >= table[i][j + 1]) i++; else j++
  }
  return pairs
}

// Collects the smallest differing pieces of two trees.
function diffNodes(a, b, parents, out) {
  a = unwrap(a); b = unwrap(b)
  if (key(a) === key(b)) return
  if (!isNode(a) || !isNode(b) || a.type !== b.type) { out.push({ old: a, now: b, parents }); return }
  const fields = [...new Set([...fieldsOf(a), ...fieldsOf(b)])]
  const differing = fields.filter(k => key(a[k]) !== key(b[k]))
  const scalar = differing.filter(k => !(isNode(a[k]) || Array.isArray(a[k])) || !(isNode(b[k]) || Array.isArray(b[k])))
  if (scalar.length) { out.push({ old: a, now: b, parents, fields: scalar }); return }
  for (const k of differing) {
    if (Array.isArray(a[k]) && Array.isArray(b[k])) diffLists(a[k], b[k], [...parents, [a, b, k]], out)
    else if (isNode(a[k]) && isNode(b[k])) diffNodes(a[k], b[k], [...parents, [a, b, k]], out)
    else out.push({ old: a, now: b, parents, fields: [k] })
  }
}

function diffLists(a, b, parents, out) {
  const ka = a.map(key), kb = b.map(key)
  const pairs = [...lcs(ka, kb), [a.length, b.length]]
  let i = 0, j = 0
  for (const [pi, pj] of pairs) {
    const removed = a.slice(i, pi), inserted = b.slice(j, pj)
    if (removed.length === inserted.length) removed.forEach((item, x) => diffNodes(item, inserted[x], parents, out))
    else out.push({ old: removed, now: inserted, parents, list: true })
    i = pi + 1; j = pj + 1
  }
}

const lineOf = (text, offset) => { let line = 1; for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++; return line }
const squash = s => s.replace(/\s+/g, ' ').trim()
const clip = (s, max = 400) => (s.length > max ? `${s.slice(0, max)} ...` : s)
function where(side, js) {
  const items = (Array.isArray(side) ? side : [side]).filter(isNode)
  if (!items.length) return { line: null, code: Array.isArray(side) ? '(nothing)' : JSON.stringify(side) ?? '(nothing)' }
  const start = Math.min(...items.map(n => n.start)), end = Math.max(...items.map(n => n.end))
  return { line: lineOf(js, start), code: clip(squash(js.slice(start, end))) }
}
function context(parents, js, index) {
  // The innermost enclosing statement or declaration, to show where a small expression change sits.
  for (let p = parents.length - 1; p >= 0; p--) {
    const node = parents[p][index]
    if (/Statement|Declaration|MethodDefinition|Property$/.test(node.type) && node.type !== 'BlockStatement') {
      return { line: lineOf(js, node.start), code: clip(squash(js.slice(node.start, node.end)), 600) }
    }
  }
  return null
}

// The run-time code of two TypeScript sources, compared. Throws when a source is not erasable TypeScript.
// A CommonJS file (.cjs) is plain JavaScript: it is parsed as it is, only comments and layout are ignored.
function compareSources(oldTs, newTs, commonjs = false) {
  const oldJs = commonjs ? oldTs : stripTypeScriptTypes(oldTs, { mode: 'strip' })
  const newJs = commonjs ? newTs : stripTypeScriptTypes(newTs, { mode: 'strip' })
  const sourceType = commonjs ? 'commonjs' : 'module'
  const oldAst = parseAst(oldJs, { lang: 'js', sourceType, preserveParens: false })
  const newAst = parseAst(newJs, { lang: 'js', sourceType, preserveParens: false })
  const out = []
  diffNodes(oldAst, newAst, [], out)
  return out.map(d => ({
    fields: d.fields,
    old: where(d.old, oldJs),
    now: where(d.now, newJs),
    oldContext: context(d.parents, oldJs, 0),
    nowContext: context(d.parents, newJs, 1),
  }))
}

// Known pairs: the checker must call type-only edits identical and catch every run-time change.
function selfTest() {
  const same = [
    ['function f(a) { return a }', 'function f(a: string): string { return a as any }'],
    ['function f(a) { return a.b }', 'function f(a: unknown) { return (a as { b: number }).b }'],
    ['f(x)', 'f(x!)'],
    ['f(x)', 'f<string>(x)'],
    ['const s = new Set()', 'const s = new Set<string | undefined>()'],
    ['class A { constructor(x) { Object.assign(this, { x }) } }', 'class A implements B { declare x: string; constructor(x: string) { Object.assign(this, { x }) } }'],
    ['import { a } from "./a.mts"\na()', 'import { a } from \'./a.mts\'\nimport type { T } from "./types.mts"\na() // typed'],
    ['const o = { a: 1 }', 'const o = { a: 1 } satisfies Record<string, number>'],
    ['let x', 'let x!: number'],
    ['const n = 1000', 'const n = 1e3'],
    ['const f = (a) => a', 'const f = <T,>(a: T): T => a'],
    ['function f(a) {}', 'function f(this: Window, a?: string): void {}'],
    ['export { a }\nconst a = 1', 'export { a }\nexport type { T } from "./t.mts"\nconst a = 1'],
    ['const x = y.z', 'const x = (y as unknown as { z: 1 }).z'],
  ]
  const different = [
    ['const p = id && find(id)', 'const p = id ? find(id) : undefined'],
    ['class A {}', 'class A { x: string }'],
    ['import { T } from "./t.mts"', 'import type { T } from "./t.mts"'],
    ['const a = 1', 'const a = 2'],
    ['f(a, b)', 'f(b, a)'],
    ['a?.b', 'a.b'],
    ['(a?.b).c', 'a?.b.c'],
    ['const r = /a/g', 'const r = /a/i'],
    ['x = a - b', 'x = +a - +b'],
    ['xs.map(f)', 'xs.map(v => f(v))'],
    ['clearTimeout(t)', 'clearTimeout(t ?? undefined)'],
    ['function f(a = 1) {}', 'function f(a = 2) {}'],
    ['try {} catch (e) { g(e) }', 'try {} catch (c) { const e = c; g(e) }'],
    ['const s = "a"', 'const s = "b"'],
    ['if (a) b()', 'if (a) { b(); c() }'],
  ]
  let failed = 0
  for (const [a, b] of same) {
    const d = compareSources(a, b)
    if (d.length) { failed++; console.log(`SELF-TEST FAIL (should be identical): ${a}  <>  ${b}\n  ${JSON.stringify(d[0])}`) }
  }
  for (const [a, b] of different) {
    const d = compareSources(a, b)
    if (!d.length) { failed++; console.log(`SELF-TEST FAIL (should differ): ${a}  <>  ${b}`) }
  }
  let enumCaught = false
  try { compareSources('const a = 1', 'enum E { A }') } catch { enumCaught = true }
  if (!enumCaught) { failed++; console.log('SELF-TEST FAIL: a non-erasable enum was not rejected') }
  console.log(`self-test: ${same.length} type-only pairs identical, ${different.length} run-time changes detected, non-erasable syntax rejected: ${failed ? `${failed} FAILURE(S)` : 'ok'}`)
  return failed === 0
}

if (args.includes('--self-test') && !selfTest()) { process.exitCode = 2; process.exit() }

const git = (...argv) => execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', maxBuffer: 256 << 20 })
const code = f => f.endsWith('.mts') || f.endsWith('.cjs')
const changed = git('diff', '--name-only', base, '--', 'electron').split('\n').map(s => s.trim()).filter(code)
const added = git('ls-files', '--others', '--exclude-standard', '--', 'electron').split('\n').map(s => s.trim()).filter(code)

const report = { repo, compared: [], identical: [], differing: [], excluded: [...exclude].filter(f => changed.includes(f)), added, errors: [] }
for (const file of changed) {
  if (exclude.has(file)) continue
  if (!existsSync(path.join(repo, file))) { report.errors.push({ file, error: 'deleted in the working copy' }); continue }
  report.compared.push(file)
  let differences
  try {
    differences = compareSources(git('show', `${base}:${file}`), readFileSync(path.join(repo, file), 'utf8'), file.endsWith('.cjs'))
  } catch (error) {
    report.errors.push({ file, error: String(error && error.message || error) })
    continue
  }
  if (differences.length) report.differing.push({ file, differences })
  else report.identical.push(file)
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`compared ${report.compared.length} changed .mts/.cjs file(s) under electron/ (.mts types stripped as Node strips them; syntax trees compared)`)
  if (report.excluded.length) console.log(`excluded: ${report.excluded.join(', ')}`)
  if (report.added.length) console.log(`new files with no HEAD version (not compared): ${report.added.join(', ')}`)
  console.log(`identical at run time: ${report.identical.length}`)
  for (const f of report.identical) console.log(`  = ${f}`)
  console.log(`differing: ${report.differing.length}`)
  for (const { file, differences } of report.differing) {
    console.log(`\n## ${file}: ${differences.length} difference(s)`)
    differences.forEach((d, n) => {
      console.log(`  [${n + 1}]${d.fields ? ` fields: ${d.fields.join(', ')}` : ''}`)
      console.log(`    HEAD  L${d.old.line}: ${d.old.code}`)
      console.log(`    work  L${d.now.line}: ${d.now.code}`)
      if (d.oldContext) console.log(`    in HEAD  L${d.oldContext.line}: ${d.oldContext.code}`)
      if (d.nowContext) console.log(`    in work  L${d.nowContext.line}: ${d.nowContext.code}`)
    })
  }
  if (report.errors.length) {
    console.log('\nerrors:')
    for (const e of report.errors) console.log(`  ! ${e.file}: ${e.error}`)
  }
}
process.exitCode = report.differing.length || report.errors.length ? 1 : 0
