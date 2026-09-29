const { spawn } = require('node:child_process')
const { isOrbitToolEnvelope } = require('./tool-schema.cjs')

// Codex exec cannot answer native approval requests; Ask uses the stdio App Server.
async function runCodexServer(options, helpers) {
  const { resolveLaunch, terminateProcess, createLineReader } = helpers
  if (options.signal?.aborted) throw new Error('Codex request cancelled')
  const launch = resolveLaunch(options.providerOptions?.command || process.env.ORBIT_CODEX_COMMAND || 'codex', ['app-server', '-c', 'features.multi_agent=false'])
  const child = spawn(launch.executable, launch.args, { cwd: options.workspace, env: launch.env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  const requests = new Map(), items = new Map()
  let sequence = 0, closed = false, stderr = '', bytes = 0, threadId, text = '', actualModel = options.model || ''
  let handedOff = false
  let resolveDone, rejectDone
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  // A process error can arrive while initialization is still pending.
  done.catch(() => {})
  const fail = error => {
    if (closed) return
    closed = true
    for (const pending of requests.values()) pending.reject(error)
    requests.clear()
    rejectDone(error)
  }
  const send = message => { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n') }
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Codex connection closed'))
    const id = ++sequence
    requests.set(id, { resolve, reject })
    send({ id, method, params })
  })
  const emit = event => options.onEvent?.({ providerId: 'codex', ...event })
  const handle = async message => {
    if (closed) return
    if (message.method && message.id !== undefined) {
      if (handedOff) { send({ id: message.id, error: { code: -32600, message: 'Control transferred to Orbit' } }); return }
      const params = message.params || {}
      if (threadId && params.threadId && params.threadId !== threadId) {
        send({ id: message.id, error: { code: -32602, message: 'Unknown thread' } }); return
      }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method)) {
        const approved = options.accessMode !== 'read-only' && !!(await options.onApproval?.({ tool: message.method, arguments: { ...params, item: items.get(params.itemId) } }))
        if (options.signal?.aborted || closed || handedOff) return
        const result = message.method === 'item/permissions/requestApproval'
          ? { permissions: approved ? params.permissions || {} : {}, scope: 'turn' }
          : { decision: approved ? 'accept' : 'decline' }
        send({ id: message.id, result })
      } else send({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } })
      return
    }
    if (!message.method && requests.has(message.id)) {
      const pending = requests.get(message.id); requests.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    const params = message.params || {}
    if (handedOff) return
    if (threadId && params.threadId && params.threadId !== threadId) return
    if (message.method === 'item/agentMessage/delta') emit({ kind: 'output', text: params.delta || '', messageId: params.itemId, partial: true })
    if (message.method === 'item/reasoning/summaryTextDelta') emit({ kind: 'reasoning', text: params.delta || '', messageId: `${params.itemId}:${params.summaryIndex || 0}`, partial: true })
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item || {}
      items.set(item.id, item)
      if (item.type === 'agentMessage' && message.method === 'item/completed' && isOrbitToolEnvelope(item.text, options.responseSchema)) {
        handedOff = true
        text = item.text
        emit({ kind: 'observation', text: 'Codex handed control to Orbit tools', source: 'protocol' })
        resolveDone({ providerId: 'codex', client: 'Codex App Server', text, model: actualModel, access: options.accessMode })
        return
      }
      if (item.type === 'agentMessage' && message.method === 'item/completed' && item.phase !== 'commentary') text = item.text || text
      if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) emit({ kind: 'tool', native: true, tool: item.type, toolId: item.id, changes: item.changes, text: item.command || JSON.stringify(item.changes || item), status: message.method === 'item/started' ? 'started' : item.status || 'completed' })
    }
    if (message.method === 'turn/completed') {
      if (params.turn?.status !== 'completed') fail(new Error(params.turn?.error?.message || `Codex turn ${params.turn?.status || 'incomplete'}`))
      else if (!text.trim()) fail(new Error('Codex completed without a final response'))
      else resolveDone({ providerId: 'codex', client: 'Codex App Server', text, model: actualModel, access: options.accessMode })
    }
    if (message.method === 'error' && !params.willRetry) fail(new Error(params.error?.message || 'Codex server error'))
  }
  const reader = createLineReader(line => {
    if (!line.trim()) return
    try { Promise.resolve(handle(JSON.parse(line))).catch(fail) } catch (error) { fail(error) }
  })
  const abort = () => fail(new Error('Codex request cancelled'))
  const timer = options.timeoutMs === null ? null : setTimeout(() => fail(new Error('Codex App Server timed out')), options.timeoutMs || 1800000)
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 32 * 1024 * 1024) return fail(new Error('Codex output limit exceeded'))
    reader.write(chunk)
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000) })
  child.on('close', () => { reader.end(); fail(new Error(stderr || 'Codex App Server closed before completion')) })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    await request('initialize', { clientInfo: { name: 'orbit', title: 'Orbit', version: '0.2.0' } })
    send({ method: 'initialized', params: {} })
    const thread = await request('thread/start', { cwd: options.workspace, ...(options.model ? { model: options.model } : {}), approvalPolicy: 'on-request', sandbox: options.accessMode === 'read-only' ? 'read-only' : 'workspace-write', ephemeral: true })
    threadId = thread.thread.id
    actualModel = thread.model || actualModel
    await request('turn/start', { threadId, input: [{ type: 'text', text: options.prompt }], ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}), ...(options.responseSchema ? { outputSchema: options.responseSchema } : {}) })
    return await done
  } finally {
    closed = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    await terminateProcess(child)
    if (options.signal?.aborted) throw new Error('Codex request cancelled')
  }
}

module.exports = { runCodexServer }
