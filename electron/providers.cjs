const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { isOrbitToolEnvelope, TOOL_HANDOFF } = require('./tool-schema.cjs')
const { removeTemporaryDirectory } = require('./storage.cjs')
const { claudeStreamLimit } = require('./quota.cjs')

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 16000
const ACCESS_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
let ollamaSelectionCache = null

function existingFile(candidate) {
  try { return fs.statSync(candidate).isFile() ? candidate : null } catch { return null }
}

function knownCommandCandidates(command) {
  const userProfile = process.env.USERPROFILE || os.homedir()
  if (process.platform !== 'win32') return [path.join(userProfile, '.local', 'bin', command)]
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming')
  const candidates = [
    path.join(userProfile, '.local', 'bin', `${command}.exe`),
    path.join(userProfile, '.local', 'bin', `${command}.cmd`),
    path.join(appData, 'npm', `${command}.exe`),
    path.join(appData, 'npm', `${command}.cmd`),
    path.join(userProfile, 'AppData', 'Local', 'Programs', command, `${command}.exe`),
  ]
  if (['agent', 'cursor-agent'].includes(command)) {
    const root = path.join(process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local'), 'cursor-agent')
    candidates.unshift(path.join(root, `${command}.exe`), path.join(root, `${command}.cmd`))
  }
  if (command === 'agy') candidates.push(path.join(process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'))
  if (command === 'codex') {
    const extensionRoot = path.join(userProfile, '.vscode', 'extensions')
    try {
      const extensions = fs.readdirSync(extensionRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      for (const entry of extensions) candidates.push(path.join(extensionRoot, entry.name, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe'))
    } catch { /* The IDE installation is optional. */ }
  }
  return candidates
}

// PATH is searched in JavaScript. where.exe blocked the main thread for about 110 ms on every provider turn,
// and its OEM-codepage output corrupted PATH directories with non-ASCII names, so those commands were never found.
const pathLookups = new Map()
function findOnPath(command) {
  const key = `${command}\0${process.env.PATH}`
  const cached = pathLookups.get(key)
  if (cached && Date.now() - cached.at < 30000) return cached.found
  let found = null
  if (!/[\\/]/.test(command)) {
    const extensions = /\.(exe|cmd|bat)$/i.test(command) ? [''] : ['.exe', '.bat', '.cmd']
    const matches = []
    for (const directory of String(process.env.PATH || '').split(path.delimiter).map((item) => item.replace(/^"|"$/g, '')).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = existingFile(path.join(directory, command + extension))
        if (candidate) matches.push(candidate)
      }
    }
    found = matches.find((item) => /\.exe$/i.test(item)) || matches[0] || null
  }
  if (pathLookups.size > 200) pathLookups.clear()
  pathLookups.set(key, { found, at: Date.now() })
  return found
}

function resolveCommand(command) {
  if (path.isAbsolute(command)) return command
  if (process.platform === 'win32') {
    const found = findOnPath(command)
    if (found) return found
  }
  return knownCommandCandidates(command).map(existingFile).find(Boolean) || command
}

// Never ask cmd.exe to interpret user-controlled arguments. npm's ordinary shims
// point to a JS entry point which Node can execute directly, with shell:false.
function resolveLaunch(command, args) {
  const executable = resolveCommand(command)
  if (/\.(cmd|bat)$/i.test(executable)) {
    if (/^(?:cursor-)?agent\.cmd$/i.test(path.basename(executable)) && existingFile(path.join(path.dirname(executable), 'cursor-agent.ps1'))) {
      // Official Windows Cursor packages bundle Node. Bypass the cmd/PowerShell
      // launchers to preserve literal arguments and avoid shell interpretation.
      const versions = path.join(path.dirname(executable), 'versions')
      try {
        for (const version of fs.readdirSync(versions).sort().reverse()) {
          const directory = path.join(versions, version)
          const node = existingFile(path.join(directory, 'node.exe'))
          const entry = existingFile(path.join(directory, 'index.js'))
          if (node && entry) return { executable: node, args: [entry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
        }
      } catch { /* Fall through to the ordinary shim check. */ }
    }
    const shim = fs.readFileSync(executable, 'utf8')
    const match = shim.match(/"%(?:dp0|~dp0)%?([\\/][^"\r\n]+\.(?:c?js|mjs))"/i)
    const entry = match && path.resolve(path.dirname(executable), match[1].replace(/^[\\/]+/, ''))
    if (!entry || !existingFile(entry)) throw new Error(`Cannot safely launch ${command}: use its native executable or a standard npm installation`)
    return { executable: process.execPath, args: [entry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { executable, args, env: process.env }
}

function timeoutValue(value) {
  if (value === null || value === 0) return 0
  const configured = Number(value ?? process.env.ORBIT_PROVIDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(configured) || configured < 1 || configured > 2147483647) throw new Error('Provider timeout must be between 1 and 2147483647 ms')
  return configured
}

function cancelledError(label) {
  const error = new Error(`${label} execution cancelled`)
  error.name = 'AbortError'
  return error
}

function terminateProcess(child) {
  if (!child?.pid) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }, (error) => {
      // taskkill also fails when the process is already gone, and when it cannot run at all; killing the
      // direct child is a no-op in the first case and the only remaining option in the second.
      if (error) { try { child.kill() } catch { /* Already stopped. */ } }
      resolve()
    }))
  }
  // POSIX children have their own process group so spawned tools die as well.
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* Already stopped. */ } }
  return Promise.resolve()
}

function createLineReader(onLine) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (text, finish) => {
    pending += text
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      onLine(line)
    }
    if (finish && pending) { const line = pending; pending = ''; onLine(line.replace(/\r$/, '')) }
  }
  return { write: (chunk) => consume(decoder.write(chunk), false), end: () => consume(decoder.end(), true) }
}

function runCli(file, args, { cwd, input = '', timeoutMs, signal, onLine, onDiagnostic, env, maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError(file))
    let launch
    let deadline
    try { launch = resolveLaunch(file, args); deadline = timeoutValue(timeoutMs) } catch (error) { return reject(error) }
    const child = spawn(launch.executable, launch.args, {
      cwd, env: { ...launch.env, ...env }, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    let stopping = false
    let timer
    const finish = (error) => {
      if (settled) return
      if (!error && signal?.aborted) error = cancelledError(file)
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const stop = (error) => {
      if (settled || stopping) return
      stopping = true
      clearTimeout(timer)
      // Settle cancellation after terminating the entire process tree.
      terminateProcess(child).then(() => finish(error), () => finish(error))
    }
    const abort = () => stop(cancelledError(file))
    const outputLines = createLineReader((line) => {
      if (settled || stopping) return
      if (onLine?.(line) === TOOL_HANDOFF) stop()
    })
    const diagnosticLines = createLineReader((line) => { if (line) onDiagnostic?.(line) })
    if (deadline) timer = setTimeout(() => {
      const error = new Error(`${file} timed out after ${deadline} ms`)
      error.name = 'TimeoutError'
      stop(error)
    }, deadline)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (chunk) => {
      if (settled || stopping) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return stop(new Error(`${file} exceeded the ${maxOutputBytes} byte output limit`))
      // Streaming parsers own their state; retain only a diagnostic tail here.
      stdout = (stdout + chunk.toString('utf8')).slice(-DIAGNOSTIC_LIMIT)
      try { outputLines.write(chunk) } catch (error) { stop(error) }
    })
    child.stderr.on('data', (chunk) => {
      if (settled || stopping) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return stop(new Error(`${file} exceeded the ${maxOutputBytes} byte output limit`))
      stderr = (stderr + chunk.toString('utf8')).slice(-DIAGNOSTIC_LIMIT)
      try { diagnosticLines.write(chunk) } catch (error) { stop(error) }
    })
    child.on('error', (error) => finish(error))
    child.on('exit', () => {
      // A background process that inherited the CLI's stdout/stderr (an MCP or dev server) keeps the pipes open
      // after the CLI itself is gone, so 'close' would never fire and a finished answer would wait for the whole
      // timeout. Give the pipes a moment to drain, then release them.
      const release = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, 1500)
      release.unref?.()
      child.once('close', () => clearTimeout(release))
    })
    child.on('close', (code, exitSignal) => {
      if (stopping || settled) return
      try { outputLines.end(); diagnosticLines.end() } catch (error) { return finish(error) }
      if (stopping || settled) return
      if (code === 0) finish()
      else finish(new Error((stderr || stdout || `${file} exited with ${exitSignal || code}`).trim()))
    })
    child.stdin.on('error', (error) => {
      // A CLI that fails early closes stdin before it has read a large prompt: EPIPE on POSIX, EOF on Windows once
      // the prompt exceeds the pipe buffer (about 64 KB). Its own stderr, reported on close, is the real error, and a
      // write error must not replace it.
      if (!['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code)) stop(error)
    })
    child.stdin.end(input, 'utf8')
  })
}

function emit(onEvent, event) {
  // A renderer disconnect must not crash the transport or orphan its process.
  try { onEvent?.(event) } catch { /* UI observers do not control the provider. */ }
}

function errorText(value) {
  if (typeof value === 'string') return value
  return value?.message || (value ? JSON.stringify(value) : 'Unknown provider error')
}

function createCodexParser(onEvent, requestedModel = '', responseSchema) {
  let model = requestedModel
  let finalText = ''
  let finalPhaseText
  let completed = false
  let failure = ''
  let lastError = ''
  let handoffText
  const messages = new Map()
  const tools = new Map()
  const dispatch = (event) => emit(onEvent, { providerId: 'codex', ...event })
  return {
    line(line) {
      if (handoffText !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { dispatch({ kind: 'observation', text: line, source: 'diagnostic' }); return }
      model = event.model || event.thread?.model || event.metadata?.model || model
      if (event.type === 'turn.failed') failure = errorText(event.error)
      if (event.type === 'error') { lastError = errorText(event.message || event.error); dispatch({ kind: 'observation', text: lastError, status: 'error' }) }
      if (event.type === 'turn.completed') { completed = true; dispatch({ kind: 'observation', text: 'Codex turn completed', usage: event.usage, status: 'completed' }) }
      const item = event.item
      if (!item) return
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        const id = item.id || 'message'
        const previous = messages.get(id) || ''
        if (item.text !== previous) {
          dispatch({ kind: 'output', text: item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text, messageId: id, partial: event.type !== 'item.completed', replace: !item.text.startsWith(previous) })
          messages.set(id, item.text)
        }
        if (event.type === 'item.completed') {
          if (!failure && isOrbitToolEnvelope(item.text, responseSchema)) {
            handoffText = item.text
            dispatch({ kind: 'observation', text: 'Codex handed control to Orbit tools', source: 'protocol' })
            return TOOL_HANDOFF
          }
          finalText = item.text
          if (item.phase === 'final_answer') finalPhaseText = item.text
        }
      } else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call'].includes(item.type)) {
        const id = item.id || item.type
        const signature = JSON.stringify(item)
        if (tools.get(id) === signature) return
        tools.set(id, signature)
        const text = item.command || item.query || (item.server ? `${item.server}/${item.tool}` : item.tool) || item.changes?.map((change) => `${change.kind || 'change'} ${change.path}`).join('\n') || item.type
        dispatch({ kind: 'tool', text, tool: item.type, toolId: id, status: item.status || event.type.split('.').at(-1), output: item.aggregated_output || '', exitCode: item.exit_code, changes: item.changes, native: true })
      } else if (item.type === 'reasoning' && typeof item.text === 'string') {
        if (event.type === 'item.completed') dispatch({ kind: 'reasoning', text: item.text, messageId: item.id })
      } else if (item.type === 'error') {
        // In `codex exec --json` an error item is a non-fatal warning (for example missing model metadata). A failed
        // turn arrives as turn.failed or a top-level error event, so a warning must not block a valid answer.
        dispatch({ kind: 'observation', text: errorText(item.message), status: 'warning', source: 'codex' })
      }
      else if (item.type === 'todo_list') dispatch({ kind: 'observation', text: (item.items || []).map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'), source: 'plan' })
    },
    finish() {
      if (handoffText !== undefined) return { text: handoffText, model }
      if (failure || (!completed && lastError)) throw new Error(failure || lastError)
      if (!completed) throw new Error('Codex stream ended without a completed turn')
      const text = finalPhaseText ?? finalText
      if (!text.trim()) throw new Error('Codex completed without an assistant response')
      return { text, model }
    },
  }
}

function createClaudeParser(onEvent, requestedModel = '', responseSchema) {
  let model = requestedModel
  let result
  let failure = ''
  let lastAssistant = ''
  let handoffText
  let lastLimit
  const messages = new Map()
  const streams = new Map()
  const toolIds = new Set()
  const dispatch = (event) => emit(onEvent, { providerId: 'claude', ...event })
  // A refusal that the stream itself announced as a rejected rate limit is typed, so the runtime need not guess from prose.
  const failed = (message) => {
    const error = new Error(message)
    if (lastLimit?.status === 'rejected') error.quota = { providerId: 'claude', resetsAt: Number.isFinite(Number(lastLimit.resetsAt)) ? Number(lastLimit.resetsAt) * 1000 : null }
    return error
  }
  return {
    line(line) {
      if (handoffText !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { dispatch({ kind: 'observation', text: line, source: 'diagnostic' }); return }
      if (event.type === 'rate_limit_event') {
        // Quota figures are shared account state, not part of this agent's conversation.
        if (event.rate_limit_info) { lastLimit = event.rate_limit_info; dispatch({ kind: 'quota', quota: claudeStreamLimit(event.rate_limit_info) }) }
        return
      }
      model = event.model || event.message?.model || model
      const parentToolId = event.parent_tool_use_id || null
      const streamKey = parentToolId || 'main'
      if (event.type === 'error') failure = errorText(event.error || event.message)
      if (event.type === 'result') {
        if (parentToolId) return
        result = event
        if (event.is_error || (event.subtype && event.subtype !== 'success')) failure = errorText(event.errors?.join('\n') || event.result || event.subtype)
        dispatch({ kind: 'observation', text: failure || 'Claude turn completed', status: failure ? 'error' : 'completed', usage: event.usage })
      }
      if (event.type === 'stream_event') {
        const part = event.event || {}
        if (part.type === 'message_start') streams.set(streamKey, { id: part.message?.id || streamKey, text: '' })
        const current = streams.get(streamKey) || { id: streamKey, text: '' }
        if (part.type === 'content_block_delta' && part.delta?.type === 'text_delta') {
          current.text += part.delta.text
          streams.set(streamKey, current)
          messages.set(current.id, current.text)
          dispatch({ kind: 'output', text: part.delta.text, messageId: current.id, parentToolId, partial: true })
        }
        if (part.type === 'content_block_delta' && part.delta?.type === 'thinking_delta') dispatch({ kind: 'reasoning', text: part.delta.thinking, messageId: `${current.id}:thinking:${part.index}`, parentToolId, partial: true })
        if (part.type === 'content_block_start' && part.content_block?.type === 'tool_use') {
          const tool = part.content_block
          toolIds.add(tool.id)
          dispatch({ kind: 'tool', text: tool.name, tool: tool.name, toolId: tool.id, parentToolId, status: 'started', native: true })
        }
      }
      const content = event.message?.content || event.content
      if (event.type === 'assistant' && Array.isArray(content)) {
        const id = event.message?.id || `${streamKey}:assistant`
        const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('')
        const previous = messages.get(id) || ''
        if (text && text !== previous) dispatch({ kind: 'output', text: text.startsWith(previous) ? text.slice(previous.length) : text, messageId: id, parentToolId, partial: false, replace: !text.startsWith(previous) })
        messages.set(id, text)
        if (!parentToolId && text) lastAssistant = text
        if (!parentToolId && !failure && isOrbitToolEnvelope(text, responseSchema)) {
          handoffText = text
          return TOOL_HANDOFF
        }
        for (const tool of content.filter((block) => block.type === 'tool_use')) {
          dispatch({ kind: 'tool', text: tool.input?.command || tool.input?.description || tool.name, tool: tool.name, toolId: tool.id, parentToolId, input: tool.input, status: toolIds.has(tool.id) ? 'running' : 'started', native: true })
          toolIds.add(tool.id)
        }
      }
      if (event.type === 'user' && Array.isArray(content)) {
        for (const tool of content.filter((block) => block.type === 'tool_result')) {
          const output = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content || '')
          dispatch({ kind: 'tool', text: output, output, toolId: tool.tool_use_id, parentToolId, status: tool.is_error ? 'failed' : 'completed', native: true })
        }
      }
      if (event.type === 'system' && event.subtype === 'permission_denied') dispatch({ kind: 'observation', text: errorText(event.message || 'Claude denied a tool permission'), status: 'denied' })
    },
    finish() {
      if (handoffText !== undefined) return { text: handoffText, model }
      if (failure) throw failed(failure)
      if (!result) throw new Error('Claude stream ended without a result')
      const text = result.structured_output ? JSON.stringify(result.structured_output) : typeof result.result === 'string' && result.result.trim() ? result.result : lastAssistant
      if (!text?.trim()) throw new Error('Claude completed without an assistant response')
      return { text, model }
    },
  }
}

function selectedAccess({ mode, accessMode }) {
  const access = accessMode || (mode === 'workspace-write' ? 'workspace-write' : 'read-only')
  if (!ACCESS_MODES.has(access)) throw new Error(`Unsupported access mode: ${access}`)
  return access
}

function buildCodexArgs(options) {
  const access = selectedAccess(options)
  const args = ['exec', '--json', '--ephemeral', '--sandbox', access, '--skip-git-repo-check', '-C', options.workspace]
  args.push('-c', 'features.multi_agent=false')
  // exec has no UI for approval requests; use its sandbox without escalation.
  // Auto-review is opt-in and cannot silently widen a read-only sandbox.
  if (options.approvalPolicy === 'auto-review' && access === 'workspace-write') args.push('--approve-for-me')
  else args.push('-c', 'approval_policy="never"')
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`)
  if (options.outputSchemaPath) args.push('--output-schema', options.outputSchemaPath)
  args.push('-')
  return args
}

function buildClaudeArgs(options) {
  const access = selectedAccess(options)
  const restricted = access !== 'danger-full-access' || options.approvalPolicy === 'on-request'
  const permissionMode = restricted ? 'default' : 'bypassPermissions'
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--permission-mode', permissionMode]
  if (restricted) args.push('--tools', 'Read,Glob,Grep')
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) {
    if (!require('./reasoning-defaults.json').claude.includes(options.reasoningEffort)) throw new Error('Unsupported Claude reasoning effort')
    args.push('--effort', options.reasoningEffort)
  }
  return args
}

async function runNative(providerId, options) {
  if (providerId === 'codex' && options.approvalPolicy === 'on-request') return require('./codex-server.cjs').runCodexServer(options, { resolveLaunch, terminateProcess, createLineReader })
  const parser = providerId === 'codex' ? createCodexParser(options.onEvent, options.model, options.responseSchema) : createClaudeParser(options.onEvent, options.model, options.responseSchema)
  const command = options.providerOptions?.command || process.env[providerId === 'codex' ? 'ORBIT_CODEX_COMMAND' : 'ORBIT_CLAUDE_COMMAND'] || providerId
  let schemaDirectory
  try {
    if (providerId === 'codex' && options.responseSchema) {
      // External CLI processes cannot read files inside Electron's app.asar.
      schemaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-response-schema-'))
      const outputSchemaPath = path.join(schemaDirectory, 'response.schema.json')
      fs.writeFileSync(outputSchemaPath, JSON.stringify(options.responseSchema), 'utf8')
      options = { ...options, outputSchemaPath }
    }
    const args = providerId === 'codex' ? buildCodexArgs(options) : buildClaudeArgs(options)
    try {
      await runCli(command, args, {
        cwd: options.workspace, input: options.prompt, signal: options.signal, timeoutMs: options.timeoutMs,
        onLine: parser.line,
        onDiagnostic: (text) => emit(options.onEvent, { providerId, kind: 'observation', text, source: 'stderr' }),
      })
    } catch (error) {
      // A CLI that reports its failure in-band and then exits non-zero has already told the parser what went
      // wrong; that message is far more useful than the raw JSONL tail runCli would surface.
      if (!['AbortError', 'TimeoutError'].includes(error.name)) {
        try { parser.finish() } catch (reported) { if (!/ended without|completed without/.test(reported.message)) throw reported }
      }
      throw error
    }
    return { providerId, client: providerId === 'codex' ? 'Codex CLI' : 'Claude Code', ...parser.finish(), access: selectedAccess(options) }
  } finally {
    removeTemporaryDirectory(schemaDirectory, 'orbit-response-schema-')
  }
}

function requestSignal(parent, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(cancelledError('Provider'))
  const timer = timeoutMs ? setTimeout(() => {
    const error = new Error(`Provider timed out after ${timeoutMs} ms`)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs) : null
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}

function endpointUrl(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Provider endpoint must be an HTTP(S) URL without embedded credentials')
  return url
}

function ollamaUrl(endpoint) {
  const url = endpointUrl(process.env.ORBIT_OLLAMA_URL || 'http://127.0.0.1:11434')
  url.pathname = `${url.pathname.replace(/\/api\/(generate|chat|tags|show)\/?$/, '').replace(/\/$/, '')}/api/${endpoint}`
  return url.toString()
}

async function consumeBody(response, onLine) {
  if (!response.body) throw new Error('Provider returned an empty response body')
  const reader = response.body.getReader()
  const lines = createLineReader(onLine)
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > MAX_OUTPUT_BYTES) throw new Error('Provider exceeded the 32 MB output limit')
      lines.write(Buffer.from(value))
    }
    lines.end()
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
}

async function readJson(response) {
  let text = ''
  await consumeBody(response, (line) => { text += `${line}\n` })
  try { return JSON.parse(text) } catch { throw new Error('Provider returned invalid JSON') }
}

async function checkResponse(response, label) {
  if (response.ok) return
  let detail = ''
  try { const body = await readJson(response); detail = errorText(body.error || body.message || '') } catch { /* Status still explains the failure. */ }
  throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
}

async function listOllamaModels(signal) {
  const response = await fetch(ollamaUrl('tags'), { signal })
  await checkResponse(response, 'Ollama')
  const body = await readJson(response)
  return (body.models || []).map((model) => model.name || model.model).filter(Boolean)
}

async function selectOllamaModel(signal) {
  const models = await listOllamaModels(signal)
  if (models.length <= 1) return models[0]
  const key = JSON.stringify([ollamaUrl('show'), models])
  if (ollamaSelectionCache?.key === key && Date.now() < ollamaSelectionCache.expires) return ollamaSelectionCache.model
  // Installation order can put an OCR/embedding model first. Select a unique
  // agent-capable model from metadata, otherwise ask for an explicit model.
  if (models.length > 32) throw new Error('Select an Ollama model explicitly or set ORBIT_OLLAMA_MODEL')
  const candidates = await Promise.all(models.map(async (model) => {
    try {
      const response = await fetch(ollamaUrl('show'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }), signal,
      })
      await checkResponse(response, 'Ollama')
      const capabilities = (await readJson(response)).capabilities || []
      return { model, score: (capabilities.includes('tools') ? 2 : 0) + (capabilities.includes('thinking') ? 1 : 0) }
    } catch (error) { if (signal.aborted) throw signal.reason; return { model, score: 0 } }
  }))
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score))
  const best = candidates.filter((candidate) => candidate.score === bestScore)
  if (bestScore === 0 || best.length !== 1) throw new Error('Several Ollama models are installed. Select a model explicitly or set ORBIT_OLLAMA_MODEL.')
  const model = best[0].model
  ollamaSelectionCache = { key, model, expires: Date.now() + 60000 }
  return model
}

// Ollama silently drops the START of a prompt that exceeds its context window, and the start of an Orbit prompt
// is the tool protocol. Ask for a window that fits the prompt, in coarse steps so the model is not reloaded
// every time the transcript grows a little (Cyrillic needs roughly one token per two characters).
function ollamaContext(prompt) {
  const needed = Math.ceil(String(prompt).length / 2.5) + 1024
  return [4096, 8192, 16384, 32768].find((size) => size >= needed) || 32768
}

async function runOllama(options) {
  const request = requestSignal(options.signal, timeoutValue(options.timeoutMs))
  try {
    const model = options.model || process.env.ORBIT_OLLAMA_MODEL || await selectOllamaModel(request.signal)
    if (!model) throw new Error('Ollama has no installed models. Install a model or select an existing one.')
    let think
    if (options.reasoningEffort) {
      const levels = await ollamaReasoningLevels(model, request.signal)
      if (!levels.includes(options.reasoningEffort)) throw new Error(`Ollama: unsupported reasoning effort ${options.reasoningEffort} for ${model}`)
      think = options.reasoningEffort === 'enabled' ? true : options.reasoningEffort === 'none' ? false : options.reasoningEffort
    }
    const response = await fetch(ollamaUrl('generate'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: options.prompt, stream: true, options: { num_ctx: ollamaContext(options.prompt) }, ...(think !== undefined ? { think } : {}) }), signal: request.signal,
    })
    await checkResponse(response, 'Ollama')
    let text = ''
    let completed = false
    let actualModel = model
    await consumeBody(response, (line) => {
      if (!line.trim()) return
      const event = JSON.parse(line)
      if (event.error) throw new Error(errorText(event.error))
      if (event.model) actualModel = event.model
      if (event.thinking) emit(options.onEvent, { providerId: 'ollama', kind: 'reasoning', text: event.thinking, messageId: 'thinking', partial: true })
      if (typeof event.response === 'string') {
        text += event.response
        if (event.response) emit(options.onEvent, { providerId: 'ollama', kind: 'output', text: event.response, messageId: 'response', partial: true })
      }
      if (event.done) {
        completed = true
        if (event.done_reason === 'length') throw new Error('Ollama response was truncated by the model context limit')
        emit(options.onEvent, { providerId: 'ollama', kind: 'observation', text: 'Ollama turn completed', status: 'completed', usage: { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count } })
      }
    })
    if (!completed) throw new Error('Ollama stream ended before completion')
    if (!text.trim()) throw new Error('Ollama completed without an assistant response')
    return { providerId: 'ollama', client: 'Ollama', text, model: actualModel, access: 'harness-tools' }
  } catch (error) { if (request.signal.aborted) throw request.signal.reason; throw error }
  finally { request.dispose() }
}

async function runCompatible(options) {
  const base = process.env.ORBIT_OPENAI_BASE_URL
  if (!base) throw new Error('ORBIT_OPENAI_BASE_URL is not configured')
  const model = options.model || process.env.ORBIT_OPENAI_MODEL
  if (!model) throw new Error('Select an endpoint model or set ORBIT_OPENAI_MODEL')
  const url = endpointUrl(base)
  if (!url.pathname.endsWith('/chat/completions')) url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`
  const request = requestSignal(options.signal, timeoutValue(options.timeoutMs))
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ORBIT_OPENAI_API_KEY ? { authorization: `Bearer ${process.env.ORBIT_OPENAI_API_KEY}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: options.prompt }], stream: true, ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}) }), signal: request.signal,
    })
    await checkResponse(response, 'Compatible endpoint')
    let text = ''
    let actualModel = model
    let completed = false
    let usage
    const accept = (event, streaming) => {
      if (event.error) throw new Error(errorText(event.error))
      actualModel = event.model || actualModel
      usage = event.usage || usage
      const choice = event.choices?.find((item) => item.index === 0) || event.choices?.[0]
      if (!choice) return
      const message = streaming ? choice.delta : choice.message
      if (message?.tool_calls?.length || message?.function_call) throw new Error('Endpoint returned native tool calls without a tool schema; configure it for the Orbit text tool protocol')
      const content = message?.content
      if (typeof content === 'string') { text += content; if (content) emit(options.onEvent, { providerId: 'custom', kind: 'output', text: content, messageId: 'response', partial: streaming }) }
      if (choice.finish_reason && choice.finish_reason !== 'stop') throw new Error(`Endpoint did not complete the response: ${choice.finish_reason}`)
      if (choice.finish_reason === 'stop' || !streaming) completed = true
      if (message?.refusal) throw new Error(message.refusal)
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      let data = []
      const flush = () => {
        if (!data.length) return
        const payload = data.join('\n'); data = []
        if (payload === '[DONE]') return
        accept(JSON.parse(payload), true)
      }
      await consumeBody(response, (line) => {
        if (!line) flush()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      })
      flush()
    } else accept(await readJson(response), false)
    if (!completed) throw new Error('Endpoint stream ended before completion')
    if (!text.trim()) throw new Error('Endpoint completed without an assistant response')
    emit(options.onEvent, { providerId: 'custom', kind: 'observation', text: 'Endpoint turn completed', status: 'completed', usage })
    return { providerId: 'custom', client: 'OpenAI-compatible endpoint', text, model: actualModel, access: 'harness-tools' }
  } catch (error) { if (request.signal.aborted) throw request.signal.reason; throw error }
  finally { request.dispose() }
}

async function commandProbe(command, args) {
  try {
    const result = await runCli(command, args, { timeoutMs: 7000 })
    return { ok: true, ...result }
  } catch (error) { return { ok: false, detail: error.message } }
}

async function inspectNative(id, options = {}) {
  // Stable CLI aliases follow the subscriber's current model catalog.
  let models = id === 'claude' ? ['sonnet', 'opus', 'haiku'] : []
  let reasoningLevels = {}
  if (id === 'codex') {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'))
      models = (cache.models || []).filter(model => model.visibility === 'list' && typeof model.slug === 'string').map(model => model.slug)
      reasoningLevels = Object.fromEntries((cache.models || []).filter(model => models.includes(model.slug)).map(model => [model.slug, (model.supported_reasoning_levels || []).map(level => level.effort)]))
    } catch { /* Model discovery is optional; manual selection remains available. */ }
  }
  const command = options.command || process.env[id === 'codex' ? 'ORBIT_CODEX_COMMAND' : 'ORBIT_CLAUDE_COMMAND'] || id
  const version = await commandProbe(command, ['--version'])
  if (!version.ok) return { id, available: false, installed: false, authenticated: false, models, detail: id === 'claude' ? 'Claude Code CLI не найден. Установка: https://code.claude.com/docs/en/setup. Вход по подписке: claude auth login' : 'Codex CLI not detected', supported: true }
  const auth = await commandProbe(command, id === 'codex' ? ['login', 'status'] : ['auth', 'status'])
  let authenticated = auth.ok
  if (id === 'claude' && auth.ok) {
    try { const status = JSON.parse(auth.stdout); authenticated = status.loggedIn ?? status.logged_in ?? null } catch { authenticated = null }
  }
  const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0].slice(0, 100)
  // Auth probes may return account identifiers. Only expose readiness, never raw output.
  return { id, models, reasoningLevels, supported: true, installed: true, available: authenticated !== false, authenticated, detail: `${versionText} · ${authenticated === true ? 'Вход выполнен' : authenticated === false ? `Войдите: ${id === 'claude' ? 'claude auth login' : 'codex login'}` : 'Авторизация не проверена'}`, executable: resolveCommand(command) }
}

async function ollamaReasoningLevels(model, signal) {
  const response = await fetch(ollamaUrl('show'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal })
  await checkResponse(response, 'Ollama')
  const metadata = await readJson(response)
  const values = metadata.thinking?.values
  if (Array.isArray(values)) return values.some(value => value !== false) ? values.map(value => value === true ? 'enabled' : value === false ? 'none' : value).filter(value => typeof value === 'string') : []
  if (!metadata.capabilities?.includes('thinking')) return []
  return /(?:^|\/)gpt-oss(?::|$)/.test(model) ? ['low', 'medium', 'high'] : ['none', 'enabled']
}

async function inspectOllama() {
  const request = requestSignal(null, 2500)
  try {
    const models = await listOllamaModels(request.signal)
    const reasoningLevels = Object.fromEntries(await Promise.all(models.slice(0, 32).map(async model => [model, await ollamaReasoningLevels(model, request.signal).catch(() => [])])))
    return { id: 'ollama', supported: true, available: models.length > 0, models, reasoningLevels, detail: models.length ? `${models.length} local model(s) ready` : 'Ollama is running; no models installed' }
  } catch { return { id: 'ollama', supported: true, available: false, detail: 'Ollama server is not reachable' } }
  finally { request.dispose() }
}

async function inspectProviders(options = {}) {
  pathLookups.clear()
  const subscriptions = require('./subscription-providers.cjs')
  const native = await Promise.all([inspectNative('codex', options.codex), inspectNative('claude', options.claude), inspectOllama(), ...['antigravity', 'cursor'].map(id => subscriptions.inspect(id, { runCli }, options[id]))])
  let configured = false
  try { if (process.env.ORBIT_OPENAI_BASE_URL) { endpointUrl(process.env.ORBIT_OPENAI_BASE_URL); configured = true } } catch { /* Invalid configuration is not ready. */ }
  return [...native, { id: 'custom', supported: true, available: configured, authenticated: null, detail: configured ? 'Endpoint configured; connection checked when used' : 'Set ORBIT_OPENAI_BASE_URL', model: process.env.ORBIT_OPENAI_MODEL || '' }]
}

async function runProvider(options) {
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw new Error('A non-empty provider prompt is required')
  if (options.signal?.aborted) throw cancelledError('Provider')
  const { providerId } = options
  if (['antigravity', 'cursor'].includes(providerId)) return require('./subscription-providers.cjs').run(providerId, options, { runCli })
  if (providerId === 'codex' || providerId === 'claude') return runNative(providerId, { ...options, workspace: options.workspace || process.cwd() })
  if (providerId === 'ollama') return runOllama(options)
  if (providerId === 'custom') return runCompatible(options)
  throw new Error(`Provider ${providerId} is not supported. Choose Codex, Claude Code, Ollama, or an OpenAI-compatible endpoint.`)
}

module.exports = {
  inspectProviders, runProvider, resolveLaunch, terminateProcess, runCli, createLineReader,
  _testing: { createCodexParser, createClaudeParser, createLineReader, buildCodexArgs, buildClaudeArgs, runCli, resolveLaunch, requestSignal },
}
