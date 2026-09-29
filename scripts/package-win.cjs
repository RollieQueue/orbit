const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { removeTemporaryDirectory } = require('../electron/storage.cjs')

const root = path.resolve(__dirname, '..')
const tag = `v${Date.now()}`
const temporaryOutput = path.join(os.tmpdir(), `orbit-package-${tag}`)
const projectOutput = path.join(root, `Orbit-standalone-${tag}`)
const builder = require.resolve('electron-builder/cli.js')

// A run that failed or was killed leaves a complete copy of the app behind (hundreds of MB each).
// Only this script's own scratch folders are swept, and only stale ones.
const STALE_MS = 60 * 60 * 1000
function sweepStaleScratch() {
  const stale = (target) => { try { return Date.now() - fs.statSync(target).mtimeMs > STALE_MS } catch { return false } }
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (/^orbit-package-v\d+$/.test(name) && name !== `orbit-package-${tag}` && stale(path.join(os.tmpdir(), name))) removeTemporaryDirectory(path.join(os.tmpdir(), name), 'orbit-package-')
    }
    for (const name of fs.readdirSync(root)) {
      if (/^\.orbit-partial-v\d+$/.test(name) && stale(path.join(root, name))) fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
  } catch { /* Housekeeping only. */ }
}

function main() {
  sweepStaleScratch()
  const result = spawnSync(process.execPath, [
    builder, '--win', '--dir',
    `--config.directories.output=${temporaryOutput}`,
  ], { stdio: 'inherit', shell: false, windowsHide: true, cwd: root })

  if (result.error || result.status !== 0) {
    console.error(result.error?.message || `electron-builder exited with ${result.status}`)
    return result.status || 1
  }

  const unpacked = path.join(temporaryOutput, 'win-unpacked')
  const asar = require('@electron/asar')
  const archive = path.join(unpacked, 'resources', 'app.asar')
  // Verify inside the temporary output first: a bundle that fails verification must never appear
  // under a name that Orbit.cmd / standalone-resolve would pick as the newest valid bundle.
  for (const file of fs.readdirSync(path.join(root, 'electron')).filter(file => file.endsWith('.cjs'))) {
    const source = fs.readFileSync(path.join(root, 'electron', file))
    if (!asar.extractFile(archive, `electron/${file}`).equals(source)) throw new Error(`Packaged runtime differs from source: ${file}`)
  }
  if (!asar.extractFile(archive, 'dist/index.html').equals(fs.readFileSync(path.join(root, 'dist', 'index.html')))) throw new Error('Packaged renderer differs from the tested build')
  // Publish atomically: copy under a name the resolver ignores, then rename.
  const staging = path.join(root, `.orbit-partial-${tag}`)
  try {
    fs.cpSync(unpacked, staging, { recursive: true, force: false })
    fs.renameSync(staging, projectOutput)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
  console.log(`Orbit bundle verified and copied to ${projectOutput}`)
  return 0
}

let exitCode = 1
try {
  exitCode = main()
} catch (error) {
  console.error(error.stack || error.message)
} finally {
  // The scratch copy is removed on every outcome, not only on success.
  removeTemporaryDirectory(temporaryOutput, 'orbit-package-')
}
// Set, not process.exit(): pending stdout writes (the result line the caller reads) must be flushed first.
process.exitCode = exitCode
