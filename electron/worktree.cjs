const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

function command(file, args, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, value: (stdout || '').trim(), raw: stdout || '', error: (stderr || '').trim() })
    })
  })
}

function canonical(p) {
  try { return fs.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
}

async function createWorktree(workspace, runId, artifactRoot) {
  const root = await command('git', ['rev-parse', '--show-toplevel'], workspace, 8000)
  if (!root.ok) return { ok: false, reason: 'not_git', detail: 'A write lane requires a Git repository.' }
  if (canonical(root.value) !== canonical(workspace)) return { ok: false, reason: 'not_workspace_root', detail: 'Select the repository root before enabling a write lane.' }
  const status = await command('git', ['status', '--porcelain'], workspace, 8000)
  if (!status.ok) return { ok: false, reason: 'git_status_failed', detail: status.error || 'Could not read Git status.' }
  if (status.value) return { ok: false, reason: 'dirty_workspace', detail: 'Write lane requires a clean source worktree; existing changes were preserved.' }

  const worktreePath = path.join(artifactRoot, 'worktrees', runId)
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  const result = await command('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], workspace)
  if (!result.ok) return { ok: false, reason: 'worktree_failed', detail: result.error || result.value || 'Could not create isolated worktree.' }
  return { ok: true, source: root.value, path: worktreePath }
}

async function collectPatch(worktreePath, artifactRoot, runId) {
  // Mark untracked files intent-to-add so the reviewable patch includes new files
  // without staging them in the user's source repository.
  await command('git', ['add', '-N', '.'], worktreePath)
  const diff = await command('git', ['diff', '--binary', '--no-ext-diff'], worktreePath)
  const stat = await command('git', ['diff', '--stat', '--no-ext-diff'], worktreePath)
  const runDir = path.join(artifactRoot, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const patchPath = path.join(runDir, 'change.patch')
  fs.writeFileSync(patchPath, diff.raw || diff.value || '', 'utf8')
  return { patchPath, stat: stat.value, hasChanges: Boolean(diff.value) }
}

function protectedPath(file) {
  const normalized = file.replaceAll('\\', '/').replace(/^\//, '').toLowerCase()
  return normalized === '.env' || normalized.startsWith('.env.') || normalized.startsWith('migrations/') || normalized.includes('/migrations/')
}

function patchPaths(patch) {
  return [...patch.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((file) => file !== '/dev/null')
}

async function applyPatch({ workspace, patchPath, artifactRoot }) {
  const safeRoot = path.resolve(artifactRoot)
  const resolvedPatch = path.resolve(patchPath)
  if (!resolvedPatch.startsWith(`${safeRoot}${path.sep}`)) return { ok: false, reason: 'unsafe_patch_path', detail: 'Patch is outside Orbit artifact storage.' }
  if (!fs.existsSync(resolvedPatch)) return { ok: false, reason: 'missing_patch', detail: 'Patch artifact no longer exists.' }
  const patch = fs.readFileSync(resolvedPatch, 'utf8')
  const files = patchPaths(patch)
  const unsafe = files.filter((file) => path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
  if (unsafe.length) return { ok: false, reason: 'unsafe_patch_path', detail: `Unsafe paths in patch: ${unsafe.join(', ')}` }
  const blocked = files.filter(protectedPath)
  if (blocked.length) return { ok: false, reason: 'protected_path', detail: `Human approval required for: ${blocked.join(', ')}` }
  const check = await command('git', ['apply', '--check', resolvedPatch], workspace)
  if (!check.ok) return { ok: false, reason: 'apply_check_failed', detail: check.error || check.value }
  const applied = await command('git', ['apply', resolvedPatch], workspace)
  if (!applied.ok) return { ok: false, reason: 'apply_failed', detail: applied.error || applied.value }
  return { ok: true, detail: 'Patch applied after Git preflight.' }
}

async function removeWorktree(workspace, worktreePath) {
  if (!worktreePath) return
  await command('git', ['worktree', 'remove', '--force', worktreePath], workspace)
}

async function verifyWorktree(worktreePath) {
  const diffCheck = await command('git', ['diff', '--check'], worktreePath)
  if (!diffCheck.ok) return { ok: false, detail: diffCheck.error || diffCheck.value }
  const changed = await command('git', ['diff', '--name-only'], worktreePath)
  const syntaxFiles = changed.value.split(/\r?\n/).filter((file) => /\.(?:cjs|mjs|js)$/i.test(file))
  const node = syntaxFiles.length ? await command(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], worktreePath, 5000) : { ok: false }
  if (node.ok) {
    for (const file of syntaxFiles) {
      const checked = await command(process.platform === 'win32' ? 'node.exe' : 'node', ['--check', path.join(worktreePath, file)], worktreePath, 15000)
      if (!checked.ok) return { ok: false, detail: `node --check failed for ${file}: ${checked.error || checked.value}` }
    }
  }
  const syntaxDetail = !syntaxFiles.length ? '' : node.ok ? `; node syntax checks passed (${syntaxFiles.length})` : '; node syntax checks skipped (Node CLI unavailable)'
  return { ok: true, detail: `git diff --check passed${syntaxDetail}` }
}

module.exports = { createWorktree, collectPatch, applyPatch, removeWorktree, verifyWorktree }
