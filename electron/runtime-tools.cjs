const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { resolveLaunch, terminateProcess } = require('./providers.cjs')

const WORKSPACE_TOOLS = new Set(['read_file', 'list_files', 'write_file', 'edit_file', 'run_command'])
// Generated output (this project keeps dozens of packaged Orbit-standalone-* copies next to its source).
// A recursive listing shows these folders but does not descend into them.
const BUILD_OUTPUT = /^(dist|release([-_].*)?|Orbit-standalone-.*|.orbit-partial-.*)$/i
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function workspacePath(workspace, requested = '.', write = false) {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('Invalid workspace path')
  const root = fs.realpathSync(workspace)
  const target = path.resolve(root, requested)
  if (!within(root, target)) throw new Error('Path is outside the selected workspace')
  if (write && path.relative(root, target).split(path.sep).some((part) => part.toLowerCase() === '.git')) throw new Error('Direct writes to Git internals are not allowed')
  let ancestor = target
  while (!fs.existsSync(ancestor)) {
    // Dangling symlinks must not be mistaken for missing directories.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Dangling symlink paths are not allowed') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error('Cannot resolve workspace path')
    ancestor = parent
  }
  if (!within(root, fs.realpathSync(ancestor))) throw new Error('Symlink resolves outside the selected workspace')
  return target
}
function assertWritable(accessMode) {
  if (!['workspace-write', 'danger-full-access'].includes(accessMode)) throw new Error('Project writes and command execution are disabled in read-only mode')
}
function runCommand(args, context) {
  assertWritable(context.accessMode)
  const command = String(args.command || '').trim()
  if (!command || command.includes('\0')) throw new Error('Command must name an executable')
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('Command args must be an array of strings')
  const cwd = workspacePath(context.workspace, args.cwd || '.')
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Command cwd is not a directory')
  const executable = !path.isAbsolute(command) && /[\\/]/.test(command) ? path.resolve(cwd, command) : command
  const launch = resolveLaunch(executable, args.args || [])
  const timeoutMs = Math.max(20, Math.min(Number(args.timeout_ms) || 60000, 120000))
  return new Promise((resolve, reject) => {
    if (context.signal?.aborted) return reject(new Error('Run cancelled'))
    const child = spawn(launch.executable, launch.args, { cwd, env: { ...process.env, ...launch.env }, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, settled = false, terminating = false, timer
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(result)
    }
    const stop = (error, result) => {
      if (settled || terminating) return
      terminating = true
      Promise.resolve(terminateProcess(child)).then(() => finish(error, result), (cleanupError) => finish(cleanupError))
    }
    const abort = () => stop(new Error('Run cancelled'))
    context.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop(null, { ok: false, timedOut: true, stdout, stderr, error: `Command exceeded ${timeoutMs}ms` }), timeoutMs)
    const append = (chunk, stream) => {
      bytes += chunk.length
      if (stream === 'stdout') stdout = (stdout + chunk.toString()).slice(0, context.maxOutputChars)
      else stderr = (stderr + chunk.toString()).slice(0, context.maxOutputChars)
      if (bytes > 4 * 1024 * 1024) stop(null, { ok: false, stdout, stderr, error: 'Command output exceeded 4 MB' })
    }
    child.stdout.on('data', (chunk) => append(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'))
    child.on('error', (error) => { if (!terminating) finish(error) })
    child.on('close', (code, signal) => { if (!terminating) finish(null, { ok: code === 0, exitCode: code, signal, stdout, stderr, truncated: bytes > context.maxOutputChars }) })
  })
}

async function executeWorkspaceTool(name, args, context) {
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
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000)), files = []
    const visit = async (directory, depth) => {
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
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    workspacePath(context.workspace, args.path, true)
    await fs.promises.writeFile(target, args.content, 'utf8')
    return { ok: true, path: path.relative(context.workspace, target), bytes: Buffer.byteLength(args.content) }
  }
  if (name === 'edit_file') {
    if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('Nonempty old_text and string new_text are required')
    if ((await fs.promises.stat(target)).size > 2 * 1024 * 1024) throw new Error('File exceeds the edit size limit')
    const content = await fs.promises.readFile(target, 'utf8'), index = content.indexOf(args.old_text)
    if (index < 0) throw new Error('old_text was not found; read the file again')
    if (content.indexOf(args.old_text, index + 1) >= 0) throw new Error('old_text is ambiguous; include more surrounding text')
    const updated = content.slice(0, index) + args.new_text + content.slice(index + args.old_text.length)
    if (Buffer.byteLength(updated) > 2 * 1024 * 1024) throw new Error('Updated file exceeds the edit size limit')
    await fs.promises.writeFile(target, updated, 'utf8')
    return { ok: true, path: path.relative(context.workspace, target) }
  }
  throw new Error(`Unknown workspace tool: ${name}`)
}
module.exports = { executeWorkspaceTool, workspacePath, WORKSPACE_TOOLS, BUILD_OUTPUT }
