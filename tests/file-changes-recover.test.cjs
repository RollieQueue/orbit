// Runs saved before changes were tracked get their diffs from Git, relative to the last commit before they started
// (electron/change-log.mts recoverChanges). Its own file: Git is asked about MAX_RECOVERED files, which is over a hundred
// git processes and takes longer than the rest of tests/file-changes.test.cjs together.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { recoverChanges, gitBaseCommit, MAX_RECOVERED } = require('../electron/change-log.mts')
const { folder, write } = require('./helpers-changes.cjs')

// ---- runs saved before changes were tracked -------------------------------------------------------------

// Commits at chosen times: the run below starts between the two, as the owner's runs did between f036f27 and ee8458c.
const gitAt = (workspace, when, ...args) => execFileSync('git', ['-C', workspace, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
function history(t) {
  const workspace = folder(t)
  try { gitAt(workspace, '2026-09-29T10:00:00Z', 'init', '-q') } catch { t.skip('git is not available'); return null }
  write(workspace, 'src/a.ts', 'one\ntwo\n'); write(workspace, 'same.txt', 'still\n'); write(workspace, 'gone.txt', 'bye\n')
  gitAt(workspace, '2026-09-29T10:00:00Z', 'add', '-A'); gitAt(workspace, '2026-09-29T10:00:00Z', 'commit', '-q', '-m', 'before the run')
  // The run (11:00–11:30) edits, creates and deletes; the agent commits afterwards, as the owner's agents do.
  write(workspace, 'src/a.ts', 'one\nTWO\n'); write(workspace, 'new.md', '# new\n'); fs.rmSync(path.join(workspace, 'gone.txt'))
  gitAt(workspace, '2026-09-29T12:00:00Z', 'add', '-A'); gitAt(workspace, '2026-09-29T12:00:00Z', 'commit', '-q', '-m', 'after the run')
  write(workspace, 'later.txt', 'uncommitted\n') // a file changed after the run and never committed
  return workspace
}

test('a run saved without change records gets its diffs from Git relative to the last commit before it started', async t => {
  const workspace = history(t)
  if (!workspace) return
  const base = await gitBaseCommit(workspace, '2026-09-29T11:00:00.918Z')
  assert.match(base, /^[0-9a-f]{40}$/)
  assert.equal(await gitBaseCommit(workspace, '2026-09-29T12:00:00Z'), execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD']).toString().trim(), 'a commit made in the very second the run began counts as before it')
  assert.equal(await gitBaseCommit(workspace, '2026-09-29T09:00:00Z'), null, 'nothing before the first commit')
  assert.equal(await gitBaseCommit(workspace, 'not a time'), undefined)
  assert.equal(await gitBaseCommit(folder(t), '2026-09-29T11:00:00Z'), undefined, 'no repository')

  const time = '2026-09-29T11:30:00.000Z'
  const writes = [{ agentId: 'root', path: 'src/a.ts', time }, { agentId: 'w1', path: 'new.md', time }, { agentId: 'w1', path: 'gone.txt', time }, { agentId: 'w2', path: 'same.txt', time }, { agentId: 'w2', path: 'later.txt', time }, { agentId: 'w2', path: '../outside.txt', time }, { agentId: '', path: 'src/a.ts', time }]
  const recovered = await recoverChanges(workspace, '2026-09-29T11:00:00.918Z', writes)
  const by = rel => recovered.find(change => change.path === rel)
  assert.deepEqual(recovered.map(change => change.id), ['legacy:root:src/a.ts', 'legacy:w1:new.md', 'legacy:w1:gone.txt', 'legacy:w2:same.txt', 'legacy:w2:later.txt'], 'one entry per reported write inside the workspace, with the id the renderer expects')
  assert.deepEqual([by('src/a.ts').kind, by('src/a.ts').source, by('src/a.ts').hasDiff, by('src/a.ts').base, by('src/a.ts').added, by('src/a.ts').removed, by('src/a.ts').tool, by('src/a.ts').time], ['modify', 'git', true, base.slice(0, 7), 1, 1, '', time])
  assert.match(by('src/a.ts').diff, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,2 \+1,2 @@\n one\n-two\n\+TWO$/, 'the diff is against the commit before the run, although the file was committed since')
  assert.deepEqual([by('new.md').kind, by('new.md').added], ['create', 1]); assert.match(by('new.md').diff, /^--- \/dev\/null\n/)
  assert.deepEqual([by('gone.txt').kind, by('gone.txt').removed], ['delete', 1]); assert.match(by('gone.txt').diff, /\+\+\+ \/dev\/null/)
  assert.deepEqual([by('same.txt').hasDiff, by('same.txt').reason, by('same.txt').kind, 'diff' in by('same.txt')], [false, 'git-same', 'unknown', false], 'an unchanged file is listed with the reason, never with an invented diff')
  assert.deepEqual([by('later.txt').hasDiff, by('later.txt').reason], [false, 'git-same'], 'an untracked file is nothing Git can compare')
  assert.ok(recovered.every(change => change.agentId && change.path && change.time && change.source === 'git'))

  assert.deepEqual((await recoverChanges(workspace, '2026-09-29T09:00:00Z', writes.slice(0, 2))).map(change => [change.hasDiff, change.reason, change.base]), [[false, 'no-base-commit', undefined], [false, 'no-base-commit', undefined]])
  assert.deepEqual((await recoverChanges(folder(t), '2026-09-29T11:00:00Z', writes.slice(0, 1))).map(change => [change.hasDiff, change.reason]), [[false, 'no-repo']])
  assert.deepEqual(await recoverChanges(workspace, '2026-09-29T11:00:00Z', []), [])
  const many = await recoverChanges(workspace, '2026-09-29T11:00:00Z', Array.from({ length: MAX_RECOVERED + 2 }, (_, index) => ({ agentId: 'a', path: `f${index}.txt`, time })))
  assert.deepEqual([many.length, many[MAX_RECOVERED - 1].reason, many[MAX_RECOVERED].reason, many[MAX_RECOVERED + 1].reason], [MAX_RECOVERED + 2, 'git-same', 'too-many', 'too-many'], 'Git is asked about a bounded number of files')
})
