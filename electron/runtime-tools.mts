import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveLaunch, terminateProcess } from './providers.mts'
import { readText } from './change-log.mts'
import type { CommandResult, ToolArgs, WorkspaceContext } from './types.mts'

// What each workspace tool returns (run_command returns a CommandResult).
interface ReadFileResult { path: string; totalLines: number; startLine: number; content: string; truncated: boolean }
interface ListedFile { path: string; type: 'symlink' | 'directory' | 'file' }
interface ListFilesResult { files: ListedFile[]; truncated: boolean }
interface WriteFileResult { ok: true; path: string; bytes: number }
interface EditFileResult { ok: true; path: string }
type WorkspaceToolResult = CommandResult | ReadFileResult | ListFilesResult | WriteFileResult | EditFileResult

const WORKSPACE_TOOLS = new Set(['read_file', 'list_files', 'write_file', 'edit_file', 'run_command'])
// Generated output (this project keeps dozens of packaged Orbit-standalone-* copies next to its source).
// A recursive listing shows these folders but does not descend into them.
const BUILD_OUTPUT = /^(dist|release([-_].*)?|Orbit-standalone-.*|.orbit-partial-.*)$/i
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function workspacePath(workspace: string, requested: unknown = '.', write = false): string {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('Invalid workspace path')
  const root = fs.realpathSync(workspace)
  const target = path.resolve(root, requested)
  if (!within(root, target)) throw new Error('Path is outside the selected workspace')
  if (write && path.relative(root, target).split(path.sep).some((part) => part.toLowerCase() === '.git')) throw new Error('Direct writes to Git internals are not allowed')
  let ancestor = target
  while (!fs.existsSync(ancestor)) {
    // Dangling symlinks must not be mistaken for missing directories.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Dangling symlink paths are not allowed') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error('Cannot resolve workspace path')
    ancestor = parent
  }
  if (!within(root, fs.realpathSync(ancestor))) throw new Error('Symlink resolves outside the selected workspace')
  return target
}
function assertWritable(accessMode: string): void {
  if (!(['workspace-write', 'danger-full-access'] as string[]).includes(accessMode)) throw new Error('Project writes and command execution are disabled in read-only mode')
}
function runCommand(args: ToolArgs, context: WorkspaceContext): Promise<CommandResult> {
  assertWritable(context.accessMode)
  const command = String(args.command || '').trim()
  if (!command || command.includes('\0')) throw new Error('Command must name an executable')
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('Command args must be an array of strings')
  const cwd = workspacePath(context.workspace, args.cwd || '.')
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Command cwd is not a directory')
  const executable = !path.isAbsolute(command) && /[\\/]/.test(command) ? path.resolve(cwd, command) : command
  const launch = resolveLaunch(executable, args.args || [])
  const timeoutMs = Math.max(20, Math.min(Number(args.timeout_ms) || 600000, 3600000))
  return new Promise<CommandResult>((resolve, reject) => {
    if (context.signal?.aborted) return reject(new Error('Run cancelled'))
    // context.env comes last: it names the agent's run (resume.mts restartEnv) even when Orbit itself inherited such names.
    const child = spawn(launch.executable, launch.args, { cwd, env: { ...process.env, ...launch.env, ...context.env }, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, settled = false, terminating = false, timer: ReturnType<typeof setTimeout> | undefined
    // Every call without an error passes a result.
    const finish = (error: Error | null, result?: CommandResult) => {
      if (settled) return
      settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(result as CommandResult)
    }
    const stop = (error: Error | null, result?: CommandResult) => {
      if (settled || terminating) return
      terminating = true
      Promise.resolve(terminateProcess(child)).then(() => finish(error, result), (cleanupError: Error) => finish(cleanupError))
    }
    const abort = () => stop(new Error('Run cancelled'))
    context.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop(null, { ok: false, timedOut: true, stdout, stderr, error: `Command exceeded ${timeoutMs}ms` }), timeoutMs)
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      bytes += chunk.length
      if (stream === 'stdout') stdout = (stdout + chunk.toString()).slice(0, context.maxOutputChars)
      else stderr = (stderr + chunk.toString()).slice(0, context.maxOutputChars)
      if (bytes > 4 * 1024 * 1024) stop(null, { ok: false, stdout, stderr, error: 'Command output exceeded 4 MB' })
    }
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
    child.on('error', (error) => { if (!terminating) finish(error) })
    child.on('close', (code, signal) => { if (!terminating) finish(null, { ok: code === 0, exitCode: code, signal, stdout, stderr, truncated: bytes > context.maxOutputChars }) })
  })
}

// Tells the caller about a finished write; a broken listener must not fail the tool.
function reportChange(context: WorkspaceContext, target: string, before: string | null, after: string): void {
  try { context.onFileChange?.({ path: path.relative(context.workspace, target), before, after }) } catch { /* Change tracking is best effort. */ }
}

async function executeWorkspaceTool(name: string, args: ToolArgs, context: WorkspaceContext): Promise<WorkspaceToolResult> {
  if (context.signal?.aborted) throw new Error('Run cancelled')
  if (name === 'run_command') return runCommand(args, context)
  const target = workspacePath(context.workspace, args.path ?? '.', ['write_file', 'edit_file'].includes(name))
  if (name === 'read_file') {
    const stat = await fs.promises.stat(target)
    if (!stat.isFile()) throw new Error('Path is not a file')
    if (stat.size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MB read limit; use a targeted provider-native tool')
    const content = await fs.promises.readFile(target, 'utf8')
    if (content.includes('\0')) throw new Error('Binary file cannot be read as text')
    const lines = content.split(/\r?\n/)
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1)), limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 200), 1000))
    const selected = lines.slice(start - 1, start - 1 + limit).map((line, index) => `${start + index}: ${line}`).join('\n')
    return { path: path.relative(context.workspace, target), totalLines: lines.length, startLine: start, content: selected.slice(0, context.maxOutputChars), truncated: selected.length > context.maxOutputChars || start - 1 + limit < lines.length }
  }
  if (name === 'list_files') {
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000)), files: ListedFile[] = []
    const visit = async (directory: string, depth: number): Promise<void> => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (files.length >= limit) return
        if (['.git', 'node_modules'].includes(entry.name)) continue
        const child = path.join(directory, entry.name)
        files.push({ path: path.relative(context.workspace, child), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' })
        if (args.recursive && entry.isDirectory() && depth < 5 && !BUILD_OUTPUT.test(entry.name)) await visit(child, depth + 1)
      }
    }
    await visit(target, 0)
    return { files, truncated: files.length >= limit }
  }
  assertWritable(context.accessMode)
  if (name === 'write_file') {
    if (typeof args.content !== 'string') throw new Error('File content must be a string')
    if (Buffer.byteLength(args.content) > 1024 * 1024) throw new Error('File write exceeds the 1 MB limit')
    const before = context.onFileChange ? await readText(target) : undefined
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    workspacePath(context.workspace, args.path, true)
    await fs.promises.writeFile(target, args.content, 'utf8')
    if (before !== undefined && !args.content.includes('\0')) reportChange(context, target, before, args.content)
    return { ok: true, path: path.relative(context.workspace, target), bytes: Buffer.byteLength(args.content) }
  }
  if (name === 'edit_file') {
    if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('Nonempty old_text and string new_text are required')
    if ((await fs.promises.stat(target)).size > 2 * 1024 * 1024) throw new Error('File exceeds the edit size limit')
    const content = await fs.promises.readFile(target, 'utf8')
    // Models write LF. In a file that uses CRLF throughout (usual in a Windows working copy) old_text is also looked for
    // with CRLF, and new_text gets CRLF, so an edit neither fails on line endings nor leaves LF lines in a CRLF file.
    // A file with mixed endings is edited verbatim.
    const crlf = content.includes('\r\n') && !/(^|[^\r])\n/.test(content)
    const inFile = (text: string) => crlf ? text.replace(/\r?\n/g, '\r\n') : text
    const oldText = content.includes(args.old_text) ? args.old_text : inFile(args.old_text), newText = inFile(args.new_text)
    const index = content.indexOf(oldText)
    if (index < 0) throw new Error('old_text was not found; read the file again')
    if (content.indexOf(oldText, index + 1) >= 0) throw new Error('old_text is ambiguous; include more surrounding text')
    const updated = content.slice(0, index) + newText + content.slice(index + oldText.length)
    if (Buffer.byteLength(updated) > 2 * 1024 * 1024) throw new Error('Updated file exceeds the edit size limit')
    await fs.promises.writeFile(target, updated, 'utf8')
    if (!content.includes('\0') && !updated.includes('\0')) reportChange(context, target, content, updated)
    return { ok: true, path: path.relative(context.workspace, target) }
  }
  throw new Error(`Unknown workspace tool: ${name}`)
}
export { executeWorkspaceTool, workspacePath, WORKSPACE_TOOLS, BUILD_OUTPUT }
export type { WorkspaceToolResult, ReadFileResult, ListFilesResult, ListedFile, WriteFileResult, EditFileResult }
