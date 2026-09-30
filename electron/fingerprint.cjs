// @ts-check
'use strict'

/**
 * Code fingerprints for Orbit's restart levels (docs/TECH-DEBT.md items 1-2).
 *
 * The main process (the "shell": window, preload, IPC, health, relaunch) and the runtime process load different files
 * of electron/. `fingerprints(root)` hashes each part: main puts the hashes of the code it and its runtime loaded into
 * every health report (`shellHash`, `runtimeHash`), and scripts/self-upgrade.cjs compares them with the files on disk
 * to pick the cheapest restart (a changed shell needs a full relaunch, a changed runtime only a new runtime process).
 * `rendererHash(root)` hashes what `vite build` makes dist/ from (RENDERER_INPUTS): the build record of dist/ carries
 * it, and so does every health report (`rendererHash`), so that a rollback puts src/ back only to the state the
 * window was running.
 *
 * Hash: sha1 over the files sorted by repository-relative POSIX path; each file adds `<path>\0<length>\0<content>`
 * with CRLF turned into LF, so a Windows checkout (core.autocrlf) and a file an agent wrote with LF hash alike. A
 * missing file adds nothing, so deleting or creating a file changes the hash. Only node:* modules: main.cjs loads this
 * file before anything else.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Files the main process itself loads, repository-relative with POSIX separators; every other file under electron/
 * is runtime code. Frozen on purpose: scripts/self-upgrade.cjs reads this list in another process, so a module the
 * main process starts to require is added here, in the source, not pushed at run time.
 * @type {readonly string[]}
 */
const SHELL_FILES = Object.freeze([
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/ipc-contract.cjs',
  'electron/ipc-handlers.cjs',
  'electron/ipc-guard.cjs',
  'electron/runtime-client.cjs',
  'electron/fingerprint.cjs',
  'electron/git.mts',
  'electron/runtime-protocol.mts',
  'package.json',
])

/** The directory whose files are runtime code unless SHELL_FILES lists them. */
const CODE_DIR = 'electron'

/**
 * What `vite build` reads, repository-relative (a folder counts with all its files): a change anywhere else (electron/,
 * tests/, docs/) needs no new dist/.
 * @type {readonly string[]}
 */
const RENDERER_INPUTS = Object.freeze(['src', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json'])

/** @param {string} file @returns {string} */
function toPosix(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** @param {string} dir @returns {import('node:fs').Dirent[]} */
function readEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

/** @param {string} file @returns {Buffer | null} */
function readContent(file) {
  try { return fs.readFileSync(file) } catch { return null }
}

/**
 * Files below `dir` (recursively), as sorted repository-relative POSIX paths; a missing directory has none.
 * @param {string} root
 * @param {string} dir repository-relative
 * @returns {string[]}
 */
function listFiles(root, dir) {
  /** @type {string[]} */
  const files = []
  /** @param {string} relative */
  const visit = (relative) => {
    for (const entry of readEntries(path.join(root, relative))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
      else if (entry.isSymbolicLink()) {
        // A link to a file counts as that file; a link to a directory is not followed (no cycles).
        try { if (fs.statSync(path.join(root, child)).isFile()) files.push(child) } catch { /* Dangling link. */ }
      }
    }
  }
  visit(toPosix(dir).replace(/\/+$/, ''))
  return files.sort()
}

/**
 * @param {Buffer} content
 * @returns {Buffer} the same bytes with every CRLF turned into LF
 */
function normalizeLineEndings(content) {
  if (!content.includes(13)) return content
  // latin1 maps every byte to one character and back, so only the CR bytes of CRLF pairs are dropped.
  return Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}

/**
 * sha1 (hex) over the given files; the order they are passed in, duplicates and missing files do not matter.
 * @param {string} root
 * @param {Iterable<string>} files repository-relative paths (either separator)
 * @returns {string}
 */
function hashFiles(root, files) {
  const hash = crypto.createHash('sha1')
  const sorted = [...new Set([...files].map(toPosix))].sort()
  for (const file of sorted) {
    const content = readContent(path.join(root, file))
    if (!content) continue
    const normalized = normalizeLineEndings(content)
    hash.update(`${file}\0${normalized.length}\0`)
    hash.update(normalized)
  }
  return hash.digest('hex')
}

/**
 * What the shell and the runtime of the repository at `root` are made of, as two hashes.
 * @param {string} root repository root
 * @param {{ shellFiles?: readonly string[] }} [options] another shell list (tests)
 * @returns {{ shell: string, runtime: string }}
 */
function fingerprints(root, { shellFiles = SHELL_FILES } = {}) {
  const shell = new Set(shellFiles.map(toPosix))
  const runtime = listFiles(root, CODE_DIR).filter((file) => !shell.has(file))
  return { shell: hashFiles(root, shell), runtime: hashFiles(root, runtime) }
}

/**
 * The files of the renderer inputs (a folder's recursively, a file itself), as sorted repository-relative POSIX paths;
 * a missing input has none.
 * @param {string} root repository root
 * @param {readonly string[]} [inputs] another list of inputs (tests)
 * @returns {string[]}
 */
function rendererFiles(root, inputs = RENDERER_INPUTS) {
  /** @type {string[]} */
  const files = []
  for (const entry of inputs) {
    let stat
    try { stat = fs.statSync(path.join(root, entry)) } catch { continue }
    if (stat.isDirectory()) files.push(...listFiles(root, entry))
    else files.push(toPosix(entry))
  }
  return files.sort()
}

/**
 * What the renderer of the repository at `root` is built from, as one hash (the same rules as `fingerprints`: CRLF
 * counts as LF, the path is part of the hash). dist/orbit-build.json records it for the build it describes, and main
 * puts it into every health report.
 * @param {string} root repository root
 * @returns {string}
 */
function rendererHash(root) {
  return hashFiles(root, rendererFiles(root))
}

module.exports = { SHELL_FILES, CODE_DIR, RENDERER_INPUTS, fingerprints, rendererHash, rendererFiles, hashFiles, listFiles, normalizeLineEndings }
