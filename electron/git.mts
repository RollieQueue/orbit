import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'

// One way to run Git for every main-process module. `workspace` becomes `-C <workspace>`; the process itself starts
// from a neutral folder (os.tmpdir() unless `cwd` says otherwise): on Windows a process keeps its working directory
// locked, and that must never be a project the user wants to delete. What every call shares: paths are file names,
// never patterns ("[id].tsx" is one file, not a character class), non-ASCII names come back unescaped, no fsmonitor
// hook of the repository runs for Orbit, no optional index lock is taken, and no credential prompt can hang a hidden
// process. The search for a repository stops at `ceiling` (the home folder by default, added to any
// GIT_CEILING_DIRECTORIES already set): a plain folder under a home directory that is itself a repository is not
// reported as inside it, while the ceiling folder itself and repositories below it are found as before.
// The answer never throws: `ok` says whether Git ran and exited with 0.
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024
const CONFIG = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false']
const ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }

type GitEncoding = BufferEncoding | 'buffer'

// What a caller may change about one call; the defaults are those of `runGit`.
interface GitOptions {
  timeoutMs?: number
  cwd?: string
  literalPathspecs?: boolean
  maxBuffer?: number
  encoding?: GitEncoding
  env?: NodeJS.ProcessEnv | null
  ceiling?: string | null
}

// { ok, code, signal, timedOut, stdout, stderr, value, error }. `stdout` is a string (a Buffer with
// `encoding: 'buffer'`) and `value` its trimmed text; `stderr` and `error` are trimmed strings, and `error` also
// names a timeout or a spawn failure when Git said nothing. `code` is Git's exit status, or the spawn error code
// (a string such as 'ENOENT': no Git, or no such `cwd`) when it never ran.
interface GitResult<Output extends string | Buffer = string> {
  ok: boolean
  code: number | string | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: Output
  stderr: string
  value: string
  error: string
}

// What execFile reports when Git fails, or what a synchronous spawn failure threw: the fields are read when present.
type RunFailure = Pick<ExecFileException, 'killed' | 'code' | 'signal' | 'message'>

const text = (value: unknown): string => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')

function outcome(error: RunFailure | null, stdout: string | Buffer, stderr: string | Buffer, { encoding, timeoutMs }: { encoding: GitEncoding, timeoutMs: number }): GitResult<string | Buffer> {
  const binary = encoding === 'buffer'
  const out: string | Buffer = binary ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(text(stdout))) : text(stdout)
  const base = { stdout: out, stderr: text(stderr).trim(), value: typeof out === 'string' ? out.trim() : '' }
  if (!error) return { ok: true, code: 0, signal: null, timedOut: false, error: '', ...base }
  const timedOut = error.killed === true && error.code == null
  const message = base.stderr || (timedOut ? `git did not finish within ${timeoutMs} ms` : String(error.message || error))
  return { ok: false, code: error.code ?? null, signal: error.signal ?? null, timedOut, error: message, ...base }
}

function runGit(workspace: string | null | undefined, args: readonly string[], options: GitOptions & { encoding: 'buffer' }): Promise<GitResult<Buffer>>
function runGit(workspace: string | null | undefined, args: readonly string[], options?: GitOptions & { encoding?: BufferEncoding }): Promise<GitResult<string>>
function runGit(workspace: string | null | undefined, args: readonly string[], options?: GitOptions): Promise<GitResult<string | Buffer>>
function runGit(workspace: string | null | undefined, args: readonly string[], { timeoutMs = DEFAULT_TIMEOUT_MS, cwd = os.tmpdir(), literalPathspecs = true, maxBuffer = DEFAULT_MAX_BUFFER, encoding = 'utf8', env = null, ceiling = os.homedir() }: GitOptions = {}): Promise<GitResult<string | Buffer>> {
  if (!Array.isArray(args)) throw new TypeError('runGit: args must be an array')
  const argv = [...(workspace ? ['-C', String(workspace)] : []), ...(literalPathspecs ? ['--literal-pathspecs'] : []), ...CONFIG, ...args.map(String)]
  const settings = { encoding, timeoutMs }
  const merged: NodeJS.ProcessEnv = { ...process.env, ...ENV, ...env }
  const ceilings = [merged.GIT_CEILING_DIRECTORIES, ceiling].filter(Boolean).join(path.delimiter)
  if (ceilings) merged.GIT_CEILING_DIRECTORIES = ceilings
  // On Windows the `git` found on PATH is often Git's cmd\git.exe, a wrapper that starts the real git.exe. execFile's own
  // timeout ends only the wrapper, and the real Git lives on, holding the workspace, for as long as its stdin stays
  // open. There the timeout ends the whole tree with taskkill /t.
  const tree = process.platform === 'win32' && timeoutMs > 0
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  return new Promise<GitResult<string | Buffer>>(resolve => {
    try {
      const child = execFile('git', argv, { cwd, timeout: tree ? 0 : timeoutMs, maxBuffer, encoding, windowsHide: true, env: merged }, (error, stdout, stderr) => {
        clearTimeout(timer)
        // Ended by the tree kill: reported as execFile reports its own timeout.
        const failure: RunFailure | null = error && expired ? { killed: true, code: null, signal: 'SIGTERM', message: error.message } : error
        resolve(outcome(failure, stdout, stderr, settings))
      })
      if (tree) timer = setTimeout(() => {
        expired = true
        if (!child.pid) { child.kill(); return }
        execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }, failed => { if (failed) child.kill() })
      }, timeoutMs)
    } catch (error) { clearTimeout(timer); resolve(outcome(error as RunFailure, '', '', settings)) }
  })
}

let probe: Promise<boolean> | null = null
// Whether a Git CLI answers at all. The answer is kept for the life of the process; `refresh` asks again.
function gitAvailable({ refresh = false }: { refresh?: boolean } = {}): Promise<boolean> {
  if (!probe || refresh) probe = runGit(null, ['--version'], { timeoutMs: 5000 }).then(result => result.ok && result.value.startsWith('git version'))
  return probe
}

export { runGit, gitAvailable, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BUFFER }
export type { GitOptions, GitResult }
