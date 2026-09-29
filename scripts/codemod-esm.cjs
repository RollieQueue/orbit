'use strict'
/**
 * One-shot codemod of wave 3 (2026-09-29): the main-process modules under electron/ go from CommonJS `.cjs` to
 * ES modules `.mts` (Node type stripping, see docs/TYPESCRIPT-MAIN.md). It is kept in the repository as the record
 * of what was done mechanically; running it again on the converted tree is a no-op that only prints the leftovers.
 *
 *   node scripts/codemod-esm.cjs [--dry-run]
 *
 * What it does:
 *   1. Renames every electron/*.cjs and electron/runtime/*.cjs to .mts except the Electron-facing shell (SHELL below),
 *      which stays CommonJS because tests/main-load.test.cjs stubs the `electron` module through Module._load /
 *      require.cache, which ESM cannot do.
 *   2. Inside each converted file: drops 'use strict'; turns the statement-level
 *      `const x = require('…')` / `const { a, b: c } = require('…')` into `import` (namespace import for local modules,
 *      default import for Node built-ins, `with { type: 'json' }` for JSON); turns `module.exports = { … }` into
 *      `export { … }` (plus `export const key = expression` for non-identifier values, such as the `_testing` bag);
 *      `module.exports.x = …` / `exports.x = …` into `export const x = …`; a remaining `module.exports.x` reference
 *      into the plain `x`; `__dirname`/`__filename` into `import.meta.dirname`/`import.meta.filename`; and prepends
 *      `// @ts-nocheck` (the typing agents remove it file by file).
 *   3. Rewrites `require('…/<module>.cjs')` in tests/*.test.cjs, scripts/*.cjs and the shell files to the `.mts` path,
 *      and `<module>.cjs` mentions in comments and docs (README.md, docs/ARCHITECTURE.md, docs/providers.md).
 *   4. Prints every `require(` left inside a converted file: lazy requires inside functions are converted by hand
 *      (the report of the wave lists each one and how).
 *
 * Hand fixes that followed this script (not mechanical): lazy requires in codex-server, providers, quota,
 * runtime/session, runtime/knowledge, provider-network (`await import('electron')`); main.cjs passes
 * `runProvider` into the runtime so scripts/smoke-desktop.cjs can substitute what main.cjs requires through
 * Module._load instead of assigning to a (read-only) ESM namespace; the source-reading tests
 * (runtime-modules, tool-registry, mcp-server) point at the new names; package.json / tsconfig.main.json / CI /
 * self-upgrade commands carry `--experimental-strip-types` and the main-process typecheck.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const dryRun = process.argv.includes('--dry-run')
const electronDir = path.join(root, 'electron')
const runtimeDir = path.join(electronDir, 'runtime')
const SHELL = new Set(['main.cjs', 'preload.cjs', 'ipc-handlers.cjs', 'ipc-guard.cjs', 'ipc-contract.cjs'])

const listCjs = (dir) => fs.readdirSync(dir).filter(name => name.endsWith('.cjs')).map(name => path.join(dir, name))
const rel = (file) => path.relative(electronDir, file).replace(/\\/g, '/')
const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, text) => { if (!dryRun) fs.writeFileSync(file, text) }
const log = (...args) => console.log(...args)

// Modules that are (or were) converted: 'capabilities', 'runtime/util', … — both the .cjs still present and the .mts already there.
const converted = new Set()
for (const dir of [electronDir, runtimeDir]) {
  for (const name of fs.readdirSync(dir)) {
    if (/\.(cjs|mts)$/.test(name) && !SHELL.has(name)) converted.add(rel(path.join(dir, name)).replace(/\.(cjs|mts)$/, ''))
  }
}
const basenames = new Set([...converted].map(name => name.split('/').pop()))

/** './x.cjs' seen from `fromFile` → './x.mts' when x is a converted module; other specifiers unchanged. */
function rewriteSpecifier(spec, fromFile) {
  if (!/^\.\.?\//.test(spec) || !spec.endsWith('.cjs')) return spec
  const target = rel(path.resolve(path.dirname(fromFile), spec)).replace(/\.cjs$/, '')
  return converted.has(target) ? spec.replace(/\.cjs$/, '.mts') : spec
}

function importFor(binding, spec, fromFile, semicolon) {
  const target = rewriteSpecifier(spec, fromFile)
  const local = /^\.\.?\//.test(target)
  if (target.endsWith('.json')) return `import ${binding} from '${target}' with { type: 'json' }${semicolon}`
  if (local && !binding.startsWith('{')) return `import * as ${binding} from '${target}'${semicolon}`
  return `import ${binding} from '${target}'${semicolon}`
}

/** `a, b: c` (CommonJS destructuring) → `a, b as c` (ESM import list). */
const importList = (names) => names.split(',').map(part => part.trim()).filter(Boolean).map(part => part.replace(/^(\w+)\s*:\s*(\w+)$/, '$1 as $2')).join(', ')

/** The `module.exports = { … }` block at column 0 (single or multi-line) → `export const` lines and one `export { … }`. */
function convertExportBlock(text, notes) {
  const match = /^module\.exports = \{/m.exec(text)
  if (!match) return text
  const open = match.index + match[0].length - 1
  let depth = 0, close = -1, quote = null
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; continue }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue }
    if ('{[('.includes(char)) depth++
    else if ('}])'.includes(char)) { depth--; if (depth === 0) { close = i; break } }
  }
  if (close < 0) throw new Error('unbalanced module.exports block')
  const body = text.slice(open + 1, close)
  const entries = []
  let start = 0; depth = 0; quote = null
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; continue }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue }
    if ('{[('.includes(char)) depth++
    else if ('}])'.includes(char)) depth--
    else if (char === ',' && depth === 0) { entries.push(body.slice(start, i)); start = i + 1 }
  }
  entries.push(body.slice(start))
  const semicolon = text[close + 1] === ';' ? ';' : ''
  const names = [], consts = []
  for (const raw of entries.map(entry => entry.trim()).filter(Boolean)) {
    let m
    if (/^\w+$/.test(raw)) names.push(raw)
    else if ((m = /^(\w+):\s*(\w+)$/.exec(raw))) names.push(m[2] === m[1] ? m[1] : `${m[2]} as ${m[1]}`)
    else if ((m = /^(\w+):\s*([\s\S]+)$/.exec(raw))) { consts.push(`export const ${m[1]} = ${m[2].trim()}${semicolon}`); notes.push(`export const ${m[1]} (was a non-identifier value in module.exports)`) }
    else throw new Error(`unrecognised module.exports entry: ${raw}`)
  }
  const replacement = [...consts, `export { ${names.join(', ')} }${semicolon}`].join('\n')
  return text.slice(0, match.index) + replacement + text.slice(close + 1 + semicolon.length)
}

function toEsm(text, file) {
  const notes = []
  let out = text.replace(/\r\n/g, '\n')
  out = out.replace(/^'use strict';?\n\n?/, '')
  out = out.replace(/^const (\w+) = require\('([^']+)'\)(;?)$/gm, (_, name, spec, semi) => importFor(name, spec, file, semi))
  out = out.replace(/^const \{([^}]+)\} = require\('([^']+)'\)(;?)$/gm, (_, names, spec, semi) => importFor(`{ ${importList(names)} }`, spec, file, semi))
  out = convertExportBlock(out, notes)
  out = out.replace(/^(?:module\.)?exports\.(\w+) = /gm, 'export const $1 = ')
  out = out.replace(/module\.exports\.(\w+)/g, (_, name) => { notes.push(`module.exports.${name} → ${name}`); return name })
  out = out.replace(/\b__dirname\b/g, () => { notes.push('__dirname → import.meta.dirname'); return 'import.meta.dirname' })
  out = out.replace(/\b__filename\b/g, () => { notes.push('__filename → import.meta.filename'); return 'import.meta.filename' })
  if (/require\.main === module/.test(out)) notes.push('require.main === module: replace by hand with an isMain check on process.argv[1]')
  // Comment mentions of converted modules (the code references were rewritten above).
  out = out.replace(/(^|[^\w.-])([\w-]+)\.cjs\b/g, (m, before, name) => basenames.has(name) && !SHELL.has(`${name}.cjs`) ? `${before}${name}.mts` : m)
  out = `// @ts-nocheck\n${out}`
  return { out, notes }
}

function convertModules() {
  const files = [...listCjs(electronDir), ...listCjs(runtimeDir)].filter(file => !SHELL.has(path.basename(file)))
  for (const file of files) {
    const target = file.replace(/\.cjs$/, '.mts')
    if (fs.existsSync(target)) throw new Error(`${rel(target)} already exists`)
    const { out, notes } = toEsm(read(file), file)
    write(target, out)
    if (!dryRun) fs.unlinkSync(file)
    log(`${rel(file)} → ${rel(target)}${notes.length ? `\n    ${notes.join('\n    ')}` : ''}`)
  }
  return files.map(file => file.replace(/\.cjs$/, '.mts'))
}

/** Consumers: `require('…/<module>.cjs')` → `.mts`, and comment mentions of the converted names. */
function rewriteConsumers() {
  const consumers = [
    ...fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs') && name !== 'self-upgrade.test.cjs').map(name => path.join(root, 'tests', name)),
    ...fs.readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.cjs') && name !== 'codemod-esm.cjs').map(name => path.join(root, 'scripts', name)),
    ...[...SHELL].map(name => path.join(electronDir, name)),
  ]
  for (const file of consumers) {
    const before = read(file)
    let after = before.replace(/require\('([^']+\.cjs)'\)/g, (m, spec) => `require('${rewriteSpecifier(spec, file)}')`)
    after = after.replace(/(^|[^\w/.-])(electron\/(?:runtime\/)?)?([\w-]+)\.cjs\b/gm, (m, lead, dir, name) => {
      const key = dir && dir.includes('runtime/') ? `runtime/${name}` : [...converted].find(c => c.split('/').pop() === name)
      return key && converted.has(key) && !SHELL.has(`${name}.cjs`) ? `${lead}${dir || ''}${name}.mts` : m
    })
    if (after !== before) { write(file, after); log(`rewrote references in ${path.relative(root, file)}`) }
  }
  for (const doc of ['README.md', 'docs/ARCHITECTURE.md', 'docs/providers.md'].map(name => path.join(root, name))) {
    const before = read(doc)
    const after = before.replace(/(^|[^\w/.-])(electron\/(?:runtime\/)?)?([\w-]+)\.cjs\b/gm, (m, lead, dir, name) => {
      const key = [...converted].find(c => c.split('/').pop() === name)
      return key && !SHELL.has(`${name}.cjs`) ? `${lead}${dir || ''}${name}.mts` : m
    })
    if (after !== before) { write(doc, after); log(`rewrote mentions in ${path.relative(root, doc)}`) }
  }
}

function reportLeftovers(files) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    const lines = read(file).split('\n')
    const hits = lines.map((line, index) => ({ line, index })).filter(({ line }) => /\brequire\(|\bmodule\.exports\b|\bexports\.\w+ =|require\.(main|resolve|cache)/.test(line))
    if (hits.length) log(`leftovers in ${rel(file)}:\n${hits.map(({ line, index }) => `    ${index + 1}: ${line.trim().slice(0, 160)}`).join('\n')}`)
  }
}

const done = convertModules()
rewriteConsumers()
reportLeftovers(done.length ? done : [...converted].map(name => path.join(electronDir, `${name}.mts`)))
log(dryRun ? 'dry run: nothing written' : 'done')
