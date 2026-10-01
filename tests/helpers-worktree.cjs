// Fixtures of the tests that run git against real temporary repositories: tests/agent-worktree*.test.cjs, and through
// tests/helpers-isolation.cjs tests/isolation-runtime*.test.cjs. This is not a test file (the runner takes only *.test.cjs):
// the parts of a split test file require these helpers instead of repeating them. Every folder comes from mkdtemp and goes
// away with the test that asked for it, so parts running at the same time in different processes share no path.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const worktree = require('../electron/agent-worktree.mts')

// No git configuration is needed for the module itself; the fixtures commit with this identity. GIT_OPTIONAL_LOCKS keeps
// `git status` from refreshing (rewriting) the index that a test compares byte for byte.
const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_OPTIONAL_LOCKS: '0' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const crlf = text => text.replace(/\n/g, '\r\n')

function folder(t, label, prefix = 'orbit-copy') {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${label}-`)))
  // Only this fixture's own temporary folder is removed (a link inside it is unlinked, not followed). Windows may hold a file
  // of a repository for a moment after git, a virus scanner or the indexer touched it (EBUSY): the removal tries again.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return directory
}
function put(directory, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(directory, ...name.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
}
const read = (directory, name) => fs.readFileSync(path.join(directory, ...name.split('/')), 'utf8')
// A repository in `directory` holding `files` and a .gitignore for node_modules, committed unless `commit` is false. The
// module under test reads the repository's own configuration, so core.autocrlf is set in it exactly as `git config
// core.autocrlf <value>` would (the key ends up in the [core] section of .git/config); it is written to the file here, which
// saves a git process for every repository.
function initRepo(directory, files, { eol = false, commit = true } = {}) {
  git(directory, 'init', '-q')
  fs.appendFileSync(path.join(directory, '.git', 'config'), `[core]\n\tautocrlf = ${eol}\n`)
  put(directory, { '.gitignore': 'node_modules/\n', ...files })
  if (commit) { git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'init') }
  return directory
}
function repo(t, files = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'bee\n' }, options) {
  return initRepo(folder(t, 'repo'), files, options)
}
// Counts the copies of one process; the names it makes are used below a fixture's own mkdtemp folder only.
let counter = 0
async function copyOf(t, source, { root = folder(t, 'root'), runId = 'run-test', origin } = {}) {
  const made = await worktree.createCopy({ source, kind: 'worktree', root, runId, agentId: `agent-${++counter}-fixture`, ...(origin ? { origin } : {}) })
  assert.ok(made.ok, made.detail)
  return { copy: made.copy, root }
}
const paths = files => files.map(file => file.path).sort()

module.exports = { IDENTITY, git, crlf, folder, put, read, initRepo, repo, copyOf, paths }
