const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { runGit, gitAvailable, DEFAULT_TIMEOUT_MS } = require('../electron/git.mts')

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
const skip = !hasGit && 'git is not installed'
const git = (workspace, ...args) => execFileSync('git', ['-C', workspace, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
const same = (a, b) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase()

function folder(t, prefix = 'orbit-git-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
// A repository with one file whose name is a glob character class and one file that class would match.
function repo(t) {
  const workspace = folder(t)
  git(workspace, 'init', '-q')
  fs.writeFileSync(path.join(workspace, '[id].txt'), 'literal\n')
  fs.writeFileSync(path.join(workspace, 'i.txt'), 'glob\n')
  git(workspace, 'add', '.')
  git(workspace, 'commit', '-qm', 'initial')
  return workspace
}

test('runGit runs inside the workspace and answers with one shape', { skip }, async t => {
  const workspace = repo(t)
  const result = await runGit(workspace, ['rev-parse', '--show-toplevel'])
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.equal(result.error, '')
  assert.equal(result.stderr, '')
  assert.equal(typeof result.stdout, 'string')
  assert.equal(result.value, result.stdout.trim())
  assert.ok(same(result.value, workspace), `${result.value} is ${workspace}`)
  assert.equal(DEFAULT_TIMEOUT_MS, 8000)
})

test('pathspecs are literal unless a caller says otherwise', { skip }, async t => {
  const workspace = repo(t)
  const literal = await runGit(workspace, ['ls-files', '--', '[id].txt'])
  assert.deepEqual(literal.value.split(/\r?\n/), ['[id].txt'], 'the file named like a character class, not the files it would match')
  // As a pattern, "[id].txt" also matches i.txt (Git still matches the literal name first).
  const glob = await runGit(workspace, ['ls-files', '--', '[id].txt'], { literalPathspecs: false })
  assert.deepEqual(glob.value.split(/\r?\n/), ['[id].txt', 'i.txt'])
})

test('a failing command reports the exit code and what Git said, without throwing', { skip }, async t => {
  const workspace = repo(t)
  const missing = await runGit(workspace, ['rev-parse', '--verify', '--quiet', 'refs/heads/no-such-branch'])
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 1)
  assert.equal(missing.timedOut, false)
  // A temp folder may sit inside some repository (a home directory under Git); a gitfile that points nowhere makes
  // this one a repository Git cannot use, whatever is above it.
  const broken = folder(t, 'orbit-plain-')
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: nowhere\n')
  const plain = await runGit(broken, ['status', '--porcelain'])
  assert.equal(plain.ok, false)
  assert.equal(plain.code, 128)
  assert.match(plain.stderr, /not a git repository/i)
  assert.equal(plain.error, plain.stderr, 'error carries what Git said')
  assert.equal(plain.stdout, '')
})

test('a workspace that does not exist is an ordinary failure', { skip }, async t => {
  const result = await runGit(path.join(folder(t), 'gone'), ['status', '--porcelain'])
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot change to|No such file/i)
})

test('encoding "buffer" hands back bytes', { skip }, async t => {
  const workspace = repo(t)
  const result = await runGit(workspace, ['show', 'HEAD:./[id].txt'], { encoding: 'buffer' })
  assert.equal(result.ok, true)
  assert.ok(Buffer.isBuffer(result.stdout))
  assert.equal(result.stdout.toString('utf8'), 'literal\n')
  assert.equal(result.value, '')
  assert.equal(result.stderr, '')
})

test('a command that never finishes is stopped after timeoutMs', { skip }, async t => {
  const workspace = repo(t)
  const started = Date.now()
  const result = await runGit(workspace, ['hash-object', '--stdin'], { timeoutMs: 300 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.match(result.error, /did not finish within 300 ms/)
  assert.ok(Date.now() - started < 8000, 'stopped by the timeout, not by the test runner')
})

test('the process starts from a neutral folder by default and from cwd when given', { skip }, async t => {
  const workspace = repo(t)
  const chosen = await runGit(null, ['rev-parse', '--show-toplevel'], { cwd: workspace })
  assert.equal(chosen.ok, true)
  assert.ok(same(chosen.value, workspace))
  let tmpInRepo = true
  try { execFileSync('git', ['-C', os.tmpdir(), 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }) } catch { tmpInRepo = false }
  if (tmpInRepo) return t.skip('the temp folder is inside a repository')
  const neutral = await runGit(null, ['rev-parse', '--show-toplevel'])
  assert.equal(neutral.ok, false, 'without -C nothing points at a repository')
})

test('the shared options and a caller environment reach Git', { skip }, async t => {
  const workspace = repo(t)
  const result = await runGit(workspace, ['var', 'GIT_EDITOR'], { env: { GIT_EDITOR: 'orbit-probe' } })
  assert.equal(result.ok, true)
  assert.equal(result.value, 'orbit-probe')
  const monitor = await runGit(workspace, ['config', '--get', 'core.fsmonitor'])
  assert.equal(monitor.value, 'false', 'the shared -c options are in effect')
})

test('runGit rejects a non-array args synchronously', { skip }, () => {
  assert.throws(() => runGit('.', 'status'), TypeError)
})

test('gitAvailable answers once per process and can be asked again', { skip }, async () => {
  const first = gitAvailable()
  assert.equal(gitAvailable(), first, 'the probe is cached')
  assert.equal(await first, true)
  assert.equal(await gitAvailable({ refresh: true }), true)
})
