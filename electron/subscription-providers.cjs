const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { proxyEnvironment } = require('./provider-network.cjs')
const { removeTemporaryDirectory } = require('./storage.cjs')
const { isOrbitResponseEnvelope, TOOL_HANDOFF } = require('./tool-schema.cjs')
const modelCache = new Map()

const CONFIG = {
  antigravity: { command: 'agy', env: 'ORBIT_ANTIGRAVITY_COMMAND', label: 'Antigravity CLI', login: 'agy', models: ['models'] },
  cursor: { command: 'agent', env: 'ORBIT_CURSOR_COMMAND', label: 'Cursor CLI', login: 'agent login', models: ['--list-models'] },
}
function commandFor(id, options = {}) { return options.command || process.env[CONFIG[id].env] || CONFIG[id].command }
function buildArgs(id, options) {
  const fullAccess = options.accessMode === 'danger-full-access' && (!options.approvalPolicy || options.approvalPolicy === 'never')
  const args = id === 'cursor'
    ? ['--print', '--output-format', 'stream-json', '--trust', ...(fullAccess ? ['--force', '--sandbox', 'disabled'] : ['--mode', 'ask'])]
    : ['--input-format', 'stream-json', '--output-format', 'stream-json', '--agent', 'orbit-transport']
  const model = id === 'cursor' ? cursorLaunch(options.model, options.reasoningEffort, options.availableModels || []).model : options.model
  if (model) args.push('--model', model)
  // Google models have reasoning built in: the CLI is never given an effort flag, whatever was persisted.
  if (id === 'antigravity' && options.schemaPath) args.push('--json-schema', options.schemaPath)
  return args
}
function modelVariant(model) {
  const match = String(model || '').match(/^(.*?)-(extra-high|xhigh|none|minimal|low|medium|high|max|ultra)((?:-fast|-thinking)*)$/)
  return match ? { family: match[1], effort: match[2] === 'extra-high' ? 'xhigh' : match[2], suffix: match[3] } : { family: model, effort: '', suffix: '' }
}
function cursorReasoningModels(models) {
  return Object.fromEntries(models.map(model => {
    const variant = modelVariant(model)
    const choices = models.filter(candidate => {
      const other = modelVariant(candidate)
      return other.effort && other.family === variant.family && other.suffix === variant.suffix
    })
    return [model, Object.fromEntries(choices.map(candidate => [modelVariant(candidate).effort, candidate]))]
  }))
}
function cursorEffortModel(model, effort, models) {
  const selected = cursorReasoningModels(models)[model]?.[effort]
  if (!selected) throw new Error(`Cursor: уровень ${effort} недоступен для ${model || 'автоматической модели'}. Выберите модель и обновите список провайдеров.`)
  return selected
}
// Cursor spells the level into the model name, so only a model that lists level variants can honour one. A saved level
// meeting a model without variants (`auto`) has nothing to select and is dropped rather than stopping the run
// (`dropped` names it); a level missing from a model that does list variants is still refused.
function cursorLaunch(model, effort, models) {
  if (!effort) return { model }
  if (!Object.keys(cursorReasoningModels(models)[model] || {}).length) return { model, dropped: effort }
  return { model: cursorEffortModel(model, effort, models) }
}
function createParser(id, onEvent, requestedModel = '', responseSchema) {
  let model = requestedModel, result, failure = '', text = ''
  let handoff, sessionId
  const messages = new Map()
  const completed = new Set()
  const usage = {}
  return {
    line(line) {
      if (handoff !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event
      try { event = JSON.parse(line) } catch { onEvent?.({ providerId: id, kind: 'observation', source: 'diagnostic', text: line }); return }
      model = event.model || event.init?.model || model
      if (id === 'antigravity') {
        sessionId = event.conversation_id || sessionId
        const step = event.step_update
        if (step?.step_type === 'agent_response') {
          const messageId = String(step.step_index ?? 'response')
          if (!completed.has(messageId)) {
            const output = (messages.get(messageId) || '') + (step.text_delta || '')
            messages.set(messageId, output)
            if (step.text_delta) onEvent?.({ providerId: id, kind: 'output', partial: step.state !== 'DONE', messageId, text: step.text_delta })
            if (step.state === 'DONE') {
              completed.add(messageId)
              for (const [key, value] of Object.entries(step.usage || {})) if (typeof value === 'number') usage[key] = (usage[key] || 0) + value
              // The CLI may continue with schema-repair turns after an already
              // complete response. Orbit owns the next turn and all tool calls.
              if (!failure && isOrbitResponseEnvelope(output, responseSchema)) {
                handoff = output
                return TOOL_HANDOFF
              }
            }
          }
        }
        if (step?.step_type === 'tool') onEvent?.({ providerId: id, kind: 'tool', native: true, text: step.tool_name || 'tool', output: step.tool_info?.output })
        if (event.event === 'result') {
          result = event.result
          if (result?.status !== 'SUCCESS') failure = result?.error || `Antigravity ended with ${result?.status}`
          if (result?.denied_actions?.length) failure = 'Antigravity denied native actions; use Orbit tools'
          text = result?.structured_output ? JSON.stringify(result.structured_output) : result?.response || ''
        }
      } else {
        if (event.type === 'assistant') {
          const content = event.message?.content
          const output = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : ''
          if (output) onEvent?.({ providerId: id, kind: 'output', text: output, partial: true })
        }
        if (event.type === 'tool_call') onEvent?.({ providerId: id, kind: 'tool', native: true, text: JSON.stringify(event.tool_call || {}), status: event.subtype })
        if (event.type === 'result') {
          result = event
          if (event.is_error || event.subtype !== 'success') failure = typeof event.result === 'string' ? event.result : 'Cursor request failed'
          text = typeof event.result === 'string' ? event.result : ''
        }
      }
      if (event.type === 'error' || event.event === 'error') failure = event.error?.message || event.message || 'CLI request failed'
    },
    finish() {
      if (handoff !== undefined) return { text: handoff, model, usage, sessionId }
      if (failure) throw new Error(failure)
      if (!result || !text.trim()) throw new Error(`${CONFIG[id].label} ended without a successful result`)
      return { text, model, usage: result.usage, sessionId: result.conversation_id || result.session_id }
    },
  }
}
function parseModels(output) {
  const clean = String(output || '').replace(/\x1b\[[0-9;]*m/g, '')
  try {
    const parsed = JSON.parse(clean)
    const values = Array.isArray(parsed) ? parsed : parsed.models || []
    if (Array.isArray(values)) return [...new Set(values.map(item => typeof item === 'string' ? item : item.slug || item.id || item.model).filter(value => typeof value === 'string' && value.length > 0))]
  } catch {}
  return [...new Set(clean.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(?:[*>•]\s*)?([a-z0-9][a-z0-9._:/-]*)(?:\t|\s{2,}|\s+-\s+|$)/)
    return match && (match[1].includes('-') || ['auto', 'composer', 'default'].includes(match[1])) ? [match[1]] : []
  }))]
}
function eligibilityDetail(id, error) {
  const message = String(error?.message || error || '')
  if (id !== 'antigravity' || !/eligibility check failed|not eligible for antigravity|user location is not supported|unsupported (?:country|region|location)|not (?:currently )?available in your (?:location|country|region)/i.test(message)) return ''
  return /location|region|country/i.test(message)
    ? 'Google отклонил доступ к Antigravity по региону. Проверьте прокси Google CLI в настройках Orbit: VPN браузера может не охватывать CLI. Также проверьте страну аккаунта на https://policies.google.com/terms и доступность на https://antigravity.google/docs/faq. Если страна указана неверно: https://policies.google.com/country-association-form. Прокси не меняет страну аккаунта; оплаченная подписка не отменяет проверку доступности Google.'
    : 'Google отклонил доступ аккаунта к Antigravity. Проверьте требования аккаунта на https://antigravity.google/docs/faq.'
}
async function inspect(id, { runCli }, options = {}) {
  const command = commandFor(id, options), config = CONFIG[id]
  let env
  try { env = id === 'antigravity' ? await proxyEnvironment(options) : undefined; await runCli(command, ['--version'], { timeoutMs: 7000, env }) }
  catch (error) {
    const missing = error.code === 'ENOENT'
    const detail = eligibilityDetail(id, error) || (missing
      ? `${config.label} не найден. ${id === 'cursor' ? 'Cursor IDE и Cursor CLI устанавливаются отдельно. Установка CLI: https://cursor.com/docs/cli/installation. ' : ''}Вход: ${config.login}`
      : `${config.label}: не удалось запустить CLI. ${error.message}`)
    return { id, supported: true, available: false, installed: !missing, authenticated: null, models: [], detail }
  }
  let authenticated = null, models = []
  if (id === 'cursor') {
    try {
      const auth = await runCli(command, ['status', '--format', 'json'], { timeoutMs: 7000 })
      const status = JSON.parse(auth.stdout)
      authenticated = status.isAuthenticated ?? status.authenticated ?? status.loggedIn ?? status.logged_in ?? null
    } catch { authenticated = null }
  }
  try {
    let output = ''
    const result = await runCli(command, config.models, { timeoutMs: 20000, env, onLine: line => { output += `${line}\n` } })
    const detail = eligibilityDetail(id, `${output}\n${result?.stdout || ''}\n${result?.stderr || ''}`)
    if (detail) return { id, supported: true, installed: true, available: false, authenticated, models: [], detail }
    models = parseModels(output || result?.stdout)
    if (models.length) modelCache.set(`${id}:${command}`, { models, expires: Date.now() + 60000 })
  } catch (error) {
    const detail = eligibilityDetail(id, error)
    if (detail) return { id, supported: true, installed: true, available: false, authenticated, models: [], detail }
    // Other model-list failures still allow manual model IDs.
  }
  return { id, supported: true, installed: true, available: authenticated !== false, authenticated, models,
    reasoningLevels: id === 'antigravity' ? {} : Object.fromEntries(Object.entries(cursorReasoningModels(models)).map(([model, choices]) => [model, Object.keys(choices)])),
    detail: `${config.label} · ${authenticated === true ? 'Вход выполнен' : authenticated === false ? `Войдите: ${config.login}` : `Авторизация проверяется при запуске · ${config.login}`}` }
}
async function run(id, options, { runCli }) {
  const command = commandFor(id, options.providerOptions)
  const parserRequestedModel = options.model || ''
  const parser = createParser(id, options.onEvent, options.model, options.responseSchema)
  let directory, droppedEffort
  try {
    const env = id === 'antigravity' ? await proxyEnvironment(options.providerOptions) : undefined
    if (id === 'cursor' && options.reasoningEffort) {
      let catalog = modelCache.get(`${id}:${command}`)
      if (!catalog || catalog.expires < Date.now()) {
        let output = ''
        const result = await runCli(command, CONFIG.cursor.models, { timeoutMs: 10000, signal: options.signal, onLine: line => { output += `${line}\n` } })
        catalog = { models: parseModels(output || result.stdout), expires: Date.now() + 60000 }
        modelCache.set(`${id}:${command}`, catalog)
      }
      const launch = cursorLaunch(options.model, options.reasoningEffort, catalog.models)
      droppedEffort = launch.dropped
      options = { ...options, model: launch.model, availableModels: catalog.models, ...(droppedEffort ? { reasoningEffort: '' } : {}) }
      if (droppedEffort) options.onEvent?.({ providerId: id, kind: 'observation', source: 'diagnostic', text: `Cursor не предлагает вариантов уровня рассуждений для ${options.model || 'автоматической модели'}: уровень ${droppedEffort} не применён, модель запущена как есть.` })
    }
    if (id === 'antigravity') {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-'))
      const agentDirectory = path.join(directory, '.agents', 'agents')
      fs.mkdirSync(agentDirectory, { recursive: true })
      fs.writeFileSync(path.join(agentDirectory, 'orbit-transport.md'), '---\nname: orbit-transport\ndescription: Orbit inference transport. All tools execute in the Orbit runtime.\ntools: []\nsubagent: false\nmainAgent: true\n---\nReturn Orbit JSON only. Use no native tools. The workspace and shared memory are supplied in the prompt.\n')
      const schemaPath = path.join(directory, 'response.schema.json')
      if (options.responseSchema) fs.writeFileSync(schemaPath, JSON.stringify(options.responseSchema))
      options = { ...options, schemaPath: options.responseSchema ? schemaPath : undefined }
    }
    await runCli(command, buildArgs(id, options), {
      cwd: directory || options.workspace,
      input: id === 'antigravity' ? JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n' : options.prompt,
      timeoutMs: options.timeoutMs, signal: options.signal, onLine: parser.line,
      env,
      onDiagnostic: text => options.onEvent?.({ providerId: id, kind: 'observation', source: 'stderr', text }),
    })
    const result = parser.finish()
    // The level that really ran is reported so the agent is not shown (and does not keep asking for) one that was dropped.
    return { providerId: id, client: CONFIG[id].label, access: options.accessMode || 'read-only', ...result, model: result.model === parserRequestedModel ? options.model || result.model : result.model, ...(droppedEffort ? { reasoningEffort: '' } : {}) }
  } catch (error) {
    const detail = eligibilityDetail(id, error)
    if (detail) throw new Error(`${detail}\n\n${error.message}`, { cause: error })
    throw error
  } finally {
    removeTemporaryDirectory(directory, 'orbit-agy-')
  }
}
module.exports = { inspect, run, buildArgs, createParser, parseModels, cursorReasoningModels, cursorEffortModel, cursorLaunch, CONFIG }
