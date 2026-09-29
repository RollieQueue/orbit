'use strict'

/**
 * Packaged copies next to the sources: Orbit-standalone-* (npm run package:win), release* (electron-builder output),
 * .orbit-partial-* (an interrupted package run). Orbit itself runs from the repository, so they are distribution
 * output only, each a complete copy of the app.
 *
 *   node scripts/clean-bundles.cjs              list them with sizes; nothing is deleted
 *   node scripts/clean-bundles.cjs --yes        delete all of them except the newest valid Orbit-standalone-*
 *   node scripts/clean-bundles.cjs --yes --all  delete every listed folder
 *   --json                                      machine-readable listing
 */
const fs = require('node:fs')
const path = require('node:path')
const { versionKey, isValidBundle } = require('./standalone-resolve.cjs')

const BUNDLE_PATTERN = /^(Orbit-standalone-.+|release(?:[-_].*)?|\.orbit-partial-.+)$/i

function kindOf(name) {
  if (/^Orbit-standalone-/i.test(name)) return 'standalone'
  if (/^\.orbit-partial-/i.test(name)) return 'partial'
  return 'release'
}

function directorySize(dir) {
  let bytes = 0
  let files = 0
  const visit = (target) => {
    let entries
    try { entries = fs.readdirSync(target, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(target, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) { try { bytes += fs.statSync(file).size; files++ } catch { /* Vanished meanwhile. */ } }
    }
  }
  visit(dir)
  return { bytes, files }
}

function listBundles(base, { sizes = true } = {}) {
  const root = path.resolve(base)
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BUNDLE_PATTERN.test(entry.name))
    .map((entry) => {
      const dir = path.join(root, entry.name)
      let mtime = 0
      try { mtime = fs.statSync(dir).mtimeMs } catch { /* ignore */ }
      const size = sizes ? directorySize(dir) : { bytes: null, files: null }
      return { name: entry.name, dir, kind: kindOf(entry.name), version: versionKey(entry.name).toString(), mtime, valid: kindOf(entry.name) === 'standalone' && isValidBundle(dir), ...size }
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'standalone' ? -1 : b.kind === 'standalone' ? 1 : a.kind.localeCompare(b.kind)
      const av = BigInt(a.version), bv = BigInt(b.version)
      if (av !== bv) return av > bv ? -1 : 1
      return b.mtime - a.mtime
    })
}

/** The newest valid Orbit-standalone-* is kept unless --all: it is the copy Orbit.cmd inside a bundle would start. */
function newestStandalone(entries) {
  return entries.filter((entry) => entry.kind === 'standalone' && entry.valid)[0] || null
}

function selectForDeletion(entries, { all = false } = {}) {
  if (all) return entries
  const keep = newestStandalone(entries)
  return entries.filter((entry) => entry !== keep)
}

function removeBundles(entries, { yes = false, base } = {}) {
  const root = path.resolve(base)
  const result = { removed: [], skipped: [], errors: [] }
  for (const entry of entries) {
    if (!yes) { result.skipped.push(entry.name); continue }
    if (path.dirname(entry.dir) !== root || !BUNDLE_PATTERN.test(entry.name)) { result.errors.push({ name: entry.name, error: 'outside the project root or not a bundle' }); continue }
    try { fs.rmSync(entry.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); result.removed.push(entry.name) } catch (error) { result.errors.push({ name: entry.name, error: error.message }) }
  }
  return result
}

const megabytes = (bytes) => bytes == null ? '?' : `${(bytes / 1024 / 1024).toFixed(0)} MB`

function main() {
  const args = new Set(process.argv.slice(2))
  const base = path.resolve(__dirname, '..')
  const entries = listBundles(base)
  const keep = args.has('--all') ? null : newestStandalone(entries)
  const doomed = selectForDeletion(entries, { all: args.has('--all') })
  const total = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0)
  if (args.has('--json')) {
    console.log(JSON.stringify({ base, count: entries.length, totalBytes: total, keep: keep?.name || null, entries }, null, 2))
  } else {
    if (!entries.length) console.log('No packaged copies found.')
    for (const entry of entries) console.log(`${entry === keep ? 'keep  ' : 'delete'} ${megabytes(entry.bytes).padStart(8)}  ${entry.name}${entry.kind === 'standalone' && !entry.valid ? ' (incomplete)' : ''}`)
    console.log(`${entries.length} folder(s), ${megabytes(total)} in total${keep ? `; the newest bundle ${keep.name} is kept (pass --all to remove it too)` : ''}.`)
  }
  if (!args.has('--yes')) {
    if (doomed.length) console.log(`Nothing was deleted. Run again with --yes to delete ${doomed.length} folder(s) (${megabytes(doomed.reduce((sum, entry) => sum + (entry.bytes || 0), 0))}).`)
    return
  }
  const result = removeBundles(doomed, { yes: true, base })
  console.log(`Deleted ${result.removed.length} folder(s)${result.errors.length ? `; ${result.errors.length} failed: ${result.errors.map((item) => `${item.name} (${item.error})`).join(', ')}` : ''}.`)
  if (result.errors.length) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { BUNDLE_PATTERN, listBundles, newestStandalone, selectForDeletion, removeBundles, directorySize }
