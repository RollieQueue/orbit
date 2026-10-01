'use strict'

// Fixtures of the self-upgrade test files (tests/self-upgrade*.test.cjs). Not a test itself: the suite runs only tests/*.test.cjs.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function temporary(t, prefix = 'orbit-self-upgrade-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeHealth = (file, health) => write(path.dirname(file), { [path.basename(file)]: JSON.stringify(health) })

/** A temporary git repository with its own identity and LF endings. */
function gitRepository(t) {
  const repo = temporary(t, 'orbit-upgrade-repo-')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  return { repo, git }
}

module.exports = { temporary, write, readJsonFile, writeHealth, gitRepository }
