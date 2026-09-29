import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { runGit } from './git.mts'

const NODE = process.platform === 'win32' ? 'node.exe' : 'node'
const GIT_TIMEOUT_MS = 120000 // worktree add, diff and apply may walk a large working copy
const PROBE_TIMEOUT_MS = 8000 // rev-parse and status

// One shape for Git and Node answers here: `value` is trimmed stdout, `raw` the untrimmed one, `error` trimmed stderr.
interface CommandResult { ok: boolean; value: string; raw: string; error: string }
// Why a lane could not be created or a patch not applied, for the interface to show.
interface Refusal { ok: false; reason: string; detail: string }

// Git through electron/git.mts, in the shape this module reads: `value` is trimmed stdout, `raw` the untrimmed one,
// `error` trimmed stderr.
async function git(workspace: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<CommandResult> {
  const result = await runGit(workspace, args, { timeoutMs })
  return { ok: result.ok, value: result.value, raw: result.stdout, error: result.stderr }
}

function node(args: readonly string[], cwd: string, timeout: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    execFile(NODE, args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, value: (stdout || '').trim(), raw: stdout || '', error: (stderr || '').trim() })
    })
  })
}

function canonicalPath(p: string): string {
  try { return fs.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
}

async function createWorktree(workspace: string, runId: string, artifactRoot: string): Promise<Refusal | { ok: true; source: string; path: string }> {
  const root = await git(workspace, ['rev-parse', '--show-toplevel'], PROBE_TIMEOUT_MS)
  if (!root.ok) return { ok: false, reason: 'not_git', detail: 'A write lane requires a Git repository.' }
  if (canonicalPath(root.value) !== canonicalPath(workspace)) return { ok: false, reason: 'not_workspace_root', detail: 'Select the repository root before enabling a write lane.' }
  const status = await git(workspace, ['status', '--porcelain'], PROBE_TIMEOUT_MS)
  if (!status.ok) return { ok: false, reason: 'git_status_failed', detail: status.error || 'Could not read Git status.' }
  if (status.value) return { ok: false, reason: 'dirty_workspace', detail: 'Write lane requires a clean source worktree; existing changes were preserved.' }

  const worktreePath = path.join(artifactRoot, 'worktrees', runId)
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  const result = await git(workspace, ['worktree', 'add', '--detach', worktreePath, 'HEAD'])
  if (!result.ok) return { ok: false, reason: 'worktree_failed', detail: result.error || result.value || 'Could not create isolated worktree.' }
  return { ok: true, source: root.value, path: worktreePath }
}

async function collectPatch(worktreePath: string, artifactRoot: string, runId: string): Promise<{ patchPath: string; stat: string; hasChanges: boolean }> {
  // Mark untracked files intent-to-add so the reviewable patch includes new files
  // without staging them in the user's source repository.
  await git(worktreePath, ['add', '-N', '.'])
  const diff = await git(worktreePath, ['diff', '--binary', '--no-ext-diff'])
  const stat = await git(worktreePath, ['diff', '--stat', '--no-ext-diff'])
  const runDir = path.join(artifactRoot, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const patchPath = path.join(runDir, 'change.patch')
  fs.writeFileSync(patchPath, diff.raw || diff.value || '', 'utf8')
  return { patchPath, stat: stat.value, hasChanges: Boolean(diff.value) }
}

function protectedPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\//, '').toLowerCase()
  return normalized === '.env' || normalized.startsWith('.env.') || normalized.startsWith('migrations/') || normalized.includes('/migrations/')
}

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^(?:\+\+\+ b\/|--- a\/)(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((file) => file !== '/dev/null')
}

async function applyPatch({ workspace, patchPath, artifactRoot }: { workspace: string; patchPath: string; artifactRoot: string }): Promise<Refusal | { ok: true; detail: string }> {
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
  const check = await git(workspace, ['apply', '--check', resolvedPatch])
  if (!check.ok) return { ok: false, reason: 'apply_check_failed', detail: check.error || check.value }
  const applied = await git(workspace, ['apply', resolvedPatch])
  if (!applied.ok) return { ok: false, reason: 'apply_failed', detail: applied.error || applied.value }
  return { ok: true, detail: 'Patch applied after Git preflight.' }
}

async function removeWorktree(workspace: string, worktreePath: string | null | undefined): Promise<void> {
  if (!worktreePath) return
  await git(workspace, ['worktree', 'remove', '--force', worktreePath])
}

async function verifyWorktree(worktreePath: string): Promise<{ ok: boolean; detail: string }> {
  const diffCheck = await git(worktreePath, ['diff', '--check'])
  if (!diffCheck.ok) return { ok: false, detail: diffCheck.error || diffCheck.value }
  const changed = await git(worktreePath, ['diff', '--name-only'])
  const syntaxFiles = changed.value.split(/\r?\n/).filter((file) => /\.(?:cjs|mjs|js)$/i.test(file))
  const nodeCli = syntaxFiles.length ? await node(['--version'], worktreePath, 5000) : { ok: false }
  if (nodeCli.ok) {
    for (const file of syntaxFiles) {
      const checked = await node(['--check', path.join(worktreePath, file)], worktreePath, 15000)
      if (!checked.ok) return { ok: false, detail: `node --check failed for ${file}: ${checked.error || checked.value}` }
    }
  }
  const syntaxDetail = !syntaxFiles.length ? '' : nodeCli.ok ? `; node syntax checks passed (${syntaxFiles.length})` : '; node syntax checks skipped (Node CLI unavailable)'
  return { ok: true, detail: `git diff --check passed${syntaxDetail}` }
}

export { createWorktree, collectPatch, applyPatch, removeWorktree, verifyWorktree }
