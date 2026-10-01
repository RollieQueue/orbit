'use strict'

const fs = require('node:fs')

// Shared by tests/runtime-client*.test.cjs (one file of 30 tests took 9 s on its own).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await delay(5)
  }
}

// A file a fixture process writes with writeFileSync can exist, still empty or half written, for a moment: it is read
// only once it parses.
const writtenJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

module.exports = { delay, until, writtenJson }
