'use strict'

const fs = require('node:fs')
const path = require('node:path')

function versionKey(name) {
  const match = /^Orbit-standalone-v(\d+)$/.exec(name)
  return match ? BigInt(match[1]) : 0n
}

/**
 * Valid packaged bundle: Orbit.exe + non-empty resources/app.asar.
 * Rejects electron.exe-only layouts and default_app.asar placeholders.
 */
function isValidBundle(dir) {
  const exe = path.join(dir, 'Orbit.exe')
  const appAsar = path.join(dir, 'resources', 'app.asar')
  if (!fs.existsSync(exe)) return false
  try {
    const st = fs.statSync(appAsar)
    if (!st.isFile() || st.size <= 0) return false
  } catch {
    return false
  }
  return true
}

function jsonSafeBundle(bundle) {
  if (!bundle) return null
  return {
    ...bundle,
    version: bundle.version.toString(),
  }
}

/** Newest Orbit-standalone-* with valid Orbit.exe + app.asar (numeric v* then mtime). */
function listStandaloneBundles(root) {
  const base = path.resolve(root)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('Orbit-standalone-'))
    .map((entry) => {
      const dir = path.join(base, entry.name)
      const exe = path.join(dir, 'Orbit.exe')
      const appAsar = path.join(dir, 'resources', 'app.asar')
      let mtime = 0
      let asarSize = 0
      try { mtime = fs.statSync(dir).mtimeMs } catch { /* ignore */ }
      try {
        const st = fs.statSync(appAsar)
        asarSize = st.isFile() ? st.size : 0
      } catch { /* ignore */ }
      const valid = isValidBundle(dir)
      return {
        name: entry.name,
        dir,
        exe,
        hasExe: fs.existsSync(exe),
        asarSize,
        valid,
        version: versionKey(entry.name),
        mtime,
      }
    })
    .filter((bundle) => bundle.valid)
    .sort((a, b) => {
      if (a.version !== b.version) return a.version > b.version ? -1 : 1
      return b.mtime - a.mtime
    })
}

function findNewestStandalone(root) {
  return listStandaloneBundles(root)[0] || null
}

if (require.main === module) {
  const printExe = process.argv.includes('--print-exe')
  const printName = process.argv.includes('--print-name')
  const printJson = process.argv.includes('--print-json')
  const rootArg = process.argv.find((arg, index) => index >= 2 && !arg.startsWith('--'))
  const root = path.resolve(rootArg || path.join(__dirname, '..'))
  const bundles = listStandaloneBundles(root)
  const newest = bundles[0] || null
  if (!newest) {
    if (printExe || printName) process.exit(2)
    const payload = { ok: false, newest: null, count: 0 }
    console.log(JSON.stringify(payload, null, 2))
    process.exit(printJson ? 2 : 0)
  }
  if (printExe) {
    process.stdout.write(newest.exe)
  } else if (printName) {
    process.stdout.write(newest.name)
  } else {
    console.log(JSON.stringify({
      ok: true,
      newest: jsonSafeBundle(newest),
      count: bundles.length,
    }, null, 2))
  }
}

module.exports = {
  listStandaloneBundles,
  findNewestStandalone,
  versionKey,
  isValidBundle,
  jsonSafeBundle,
}
