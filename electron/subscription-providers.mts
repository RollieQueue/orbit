import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proxyEnvironment } from './provider-network.mts'
import { removeTemporaryDirectory } from './storage.mts'
import { isOrbitResponseEnvelope, TOOL_HANDOFF } from './tool-schema.mts'
import type { CliResult, ProviderEventListener, ProviderHealth, ProviderOptions, ProviderResult, ProviderRunOptions, RunCli } from './providers.mts'

type SubscriptionId = 'antigravity' | 'cursor'
interface SubscriptionConfig { command: string; env: string; label: string; login: string; models: string[] }
// The run options after this module has resolved the Cursor model variant and written the Antigravity schema file.
interface SubscriptionRunOptions extends ProviderRunOptions { schemaPath?: string; availableModels?: string[] }
type LaunchArgOptions = Pick<SubscriptionRunOptions, 'accessMode' | 'approvalPolicy' | 'model' | 'reasoningEffort' | 'availableModels' | 'schemaPath'>
// A model name split into its family and the reasoning level Cursor spells into it ("claude-opus-5-5-high-thinking").
interface ModelVariant { family: string | undefined; effort: string; suffix: string }
interface CursorLaunch { model: string | undefined; dropped?: string }
interface SubscriptionParser { line(line: string): typeof TOOL_HANDOFF | undefined; finish(): { text: string; model: string; usage: unknown; sessionId: string | undefined } }
// The parser's own accounting of what the CLI reported, and the result shapes of both CLIs.
interface AntigravityStep { step_type?: string; step_index?: number; text_delta?: string; state?: string; usage?: Record<string, unknown>; tool_name?: string; tool_info?: { output?: string } }
interface AntigravityResult { status?: string; error?: string; denied_actions?: unknown[]; structured_output?: unknown; response?: string; usage?: unknown; conversation_id?: string; session_id?: string }
interface CursorContentBlock { type?: string; text?: string }
// One `stream-json` line of either CLI; Antigravity fields (`event`, `step_update`, `conversation_id`) and Cursor
// fields (`type`, `subtype`, `tool_call`, `is_error`) share one shape because the parser handles both.
interface SubscriptionEvent {
  type?: string; event?: string; subtype?: string; model?: string; init?: { model?: string }
  conversation_id?: string; session_id?: string; step_update?: AntigravityStep; result?: AntigravityResult | string | unknown
  message?: { content?: CursorContentBlock[] } | string; tool_call?: unknown; is_error?: boolean; usage?: unknown; error?: { message?: string }
}
interface SubscriptionError { code?: string; message?: string }
interface CursorStatus { isAuthenticated?: boolean; authenticated?: boolean; loggedIn?: boolean; logged_in?: boolean }
interface ModelCatalog { models: string[]; expires: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// A parsed line is taken as the CLI's event shape once it is an object; the fields are checked where they are used.
const isSubscriptionEvent = (value: unknown): value is SubscriptionEvent => isRecord(value)
const modelCache = new Map<string, ModelCatalog>()

const CONFIG: Record<SubscriptionId, SubscriptionConfig> = {
  antigravity: { command: 'agy', env: 'ORBIT_ANTIGRAVITY_COMMAND', label: 'Antigravity CLI', login: 'agy', models: ['models'] },
  cursor: { command: 'agent', env: 'ORBIT_CURSOR_COMMAND', label: 'Cursor CLI', login: 'agent login', models: ['--list-models'] },
}
function commandFor(id: SubscriptionId, options: ProviderOptions = {}): string { return options.command || process.env[CONFIG[id].env] || CONFIG[id].command }
function buildArgs(id: SubscriptionId, options: LaunchArgOptions): string[] {
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
function modelVariant(model: string | undefined): ModelVariant {
  const match = String(model || '').match(/^(.*?)-(extra-high|xhigh|none|minimal|low|medium|high|max|ultra)((?:-fast|-thinking)*)$/)
  return match ? { family: match[1], effort: match[2] === 'extra-high' ? 'xhigh' : match[2], suffix: match[3] } : { family: model, effort: '', suffix: '' }
}
function cursorReasoningModels(models: string[]): Record<string, Record<string, string>> {
  return Object.fromEntries(models.map((model): [string, Record<string, string>] => {
    const variant = modelVariant(model)
    const choices = models.filter(candidate => {
      const other = modelVariant(candidate)
      return other.effort && other.family === variant.family && other.suffix === variant.suffix
    })
    return [model, Object.fromEntries(choices.map((candidate): [string, string] => [modelVariant(candidate).effort, candidate]))]
  }))
}
function cursorEffortModel(model: string | undefined, effort: string, models: string[]): string {
  // An unnamed model looks up the "undefined" key, as the untyped code did; nothing is listed under it.
  const selected = cursorReasoningModels(models)[model as string]?.[effort]
  if (!selected) throw new Error(`Cursor: уровень ${effort} недоступен для ${model || 'автоматической модели'}. Выберите модель и обновите список провайдеров.`)
  return selected
}
// Cursor spells the level into the model name, so only a model that lists level variants can honour one. A saved level
// meeting a model without variants (`auto`) has nothing to select and is dropped rather than stopping the run
// (`dropped` names it); a level missing from a model that does list variants is still refused.
function cursorLaunch(model: string | undefined, effort: string | undefined, models: string[]): CursorLaunch {
  if (!effort) return { model }
  if (!Object.keys(cursorReasoningModels(models)[model as string] || {}).length) return { model, dropped: effort }
  return { model: cursorEffortModel(model, effort, models) }
}
function createParser(id: SubscriptionId, onEvent: ProviderEventListener | null | undefined, requestedModel = '', responseSchema?: unknown): SubscriptionParser {
  // The terminal event's payload: Antigravity's `result` object, or the whole Cursor `result` event.
  let model = requestedModel, result: AntigravityResult | SubscriptionEvent | undefined, failure = '', text = ''
  let handoff: string | undefined, sessionId: string | undefined
  const messages = new Map<string, string>()
  const completed = new Set<string>()
  const usage: Record<string, number> = {}
  return {
    line(line) {
      if (handoff !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event: unknown
      try { event = JSON.parse(line) } catch { onEvent?.({ providerId: id, kind: 'observation', source: 'diagnostic', text: line }); return }
      if (!isSubscriptionEvent(event)) return
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
          // Antigravity's terminal event carries its result object; a malformed one fails the checks below.
          result = event.result as AntigravityResult | undefined
          if (result?.status !== 'SUCCESS') failure = result?.error || `Antigravity ended with ${result?.status}`
          if (result?.denied_actions?.length) failure = 'Antigravity denied native actions; use Orbit tools'
          text = result?.structured_output ? JSON.stringify(result.structured_output) : result?.response || ''
        }
      } else {
        if (event.type === 'assistant') {
          const content = typeof event.message === 'object' ? event.message?.content : undefined
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
      // An error's `message` is its text; a non-string one is kept as before (Error() stringifies it).
      if (event.type === 'error' || event.event === 'error') failure = (event.error?.message || event.message || 'CLI request failed') as string
    },
    finish() {
      if (handoff !== undefined) return { text: handoff, model, usage, sessionId }
      if (failure) throw new Error(failure)
      if (!result || !text.trim()) throw new Error(`${CONFIG[id].label} ended without a successful result`)
      return { text, model, usage: result.usage, sessionId: result.conversation_id || result.session_id }
    },
  }
}
function parseModels(output: unknown): string[] {
  const clean = String(output || '').replace(/\x1b\[[0-9;]*m/g, '')
  try {
    const parsed: unknown = JSON.parse(clean)
    const values = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown }).models || []
    if (Array.isArray(values)) return [...new Set(values.map((item: string | { slug?: string; id?: string; model?: string }) => typeof item === 'string' ? item : item.slug || item.id || item.model).filter((value): value is string => typeof value === 'string' && value.length > 0))]
  } catch {}
  return [...new Set(clean.split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(?:[*>•]\s*)?([a-z0-9][a-z0-9._:/-]*)(?:\t|\s{2,}|\s+-\s+|$)/)
    return match && (match[1].includes('-') || ['auto', 'composer', 'default'].includes(match[1])) ? [match[1]] : []
  }))]
}
function eligibilityDetail(id: SubscriptionId, error: unknown): string {
  const message = String((error as SubscriptionError | null | undefined)?.message || error || '')
  if (id !== 'antigravity' || !/eligibility check failed|not eligible for antigravity|user location is not supported|unsupported (?:country|region|location)|not (?:currently )?available in your (?:location|country|region)/i.test(message)) return ''
  return /location|region|country/i.test(message)
    ? 'Google отклонил доступ к Antigravity по региону. Проверьте прокси Google CLI в настройках Orbit: VPN браузера может не охватывать CLI. Также проверьте страну аккаунта на https://policies.google.com/terms и доступность на https://antigravity.google/docs/faq. Если страна указана неверно: https://policies.google.com/country-association-form. Прокси не меняет страну аккаунта; оплаченная подписка не отменяет проверку доступности Google.'
    : 'Google отклонил доступ аккаунта к Antigravity. Проверьте требования аккаунта на https://antigravity.google/docs/faq.'
}
async function inspect(id: SubscriptionId, { runCli }: { runCli: RunCli }, options: ProviderOptions = {}): Promise<ProviderHealth> {
  const command = commandFor(id, options), config = CONFIG[id]
  let env: Record<string, string> | undefined
  try { env = id === 'antigravity' ? await proxyEnvironment(options) : undefined; await runCli(command, ['--version'], { timeoutMs: 7000, env }) }
  catch (error) {
    const missing = (error as SubscriptionError).code === 'ENOENT'
    const detail = eligibilityDetail(id, error) || (missing
      ? `${config.label} не найден. ${id === 'cursor' ? 'Cursor IDE и Cursor CLI устанавливаются отдельно. Установка CLI: https://cursor.com/docs/cli/installation. ' : ''}Вход: ${config.login}`
      : `${config.label}: не удалось запустить CLI. ${(error as SubscriptionError).message}`)
    return { id, supported: true, available: false, installed: !missing, authenticated: null, models: [], detail }
  }
  let authenticated: boolean | null = null, models: string[] = []
  if (id === 'cursor') {
    try {
      const auth = await runCli(command, ['status', '--format', 'json'], { timeoutMs: 7000 })
      const status = JSON.parse(auth.stdout) as CursorStatus
      authenticated = status.isAuthenticated ?? status.authenticated ?? status.loggedIn ?? status.logged_in ?? null
    } catch { authenticated = null }
  }
  try {
    let output = ''
    const result: CliResult | undefined = await runCli(command, config.models, { timeoutMs: 20000, env, onLine: line => { output += `${line}\n` } })
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
    reasoningLevels: id === 'antigravity' ? {} : Object.fromEntries(Object.entries(cursorReasoningModels(models)).map(([model, choices]): [string, string[]] => [model, Object.keys(choices)])),
    detail: `${config.label} · ${authenticated === true ? 'Вход выполнен' : authenticated === false ? `Войдите: ${config.login}` : `Авторизация проверяется при запуске · ${config.login}`}` }
}
async function run(id: SubscriptionId, options: SubscriptionRunOptions, { runCli }: { runCli: RunCli }): Promise<ProviderResult> {
  const command = commandFor(id, options.providerOptions)
  const parserRequestedModel = options.model || ''
  const parser = createParser(id, options.onEvent, options.model, options.responseSchema)
  let directory: string | undefined, droppedEffort: string | undefined
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
    if (detail) throw new Error(`${detail}\n\n${(error as SubscriptionError).message}`, { cause: error })
    throw error
  } finally {
    removeTemporaryDirectory(directory, 'orbit-agy-')
  }
}
export type { SubscriptionId, SubscriptionConfig, SubscriptionRunOptions, SubscriptionEvent, SubscriptionParser, CursorLaunch, ModelVariant }
export { inspect, run, buildArgs, createParser, parseModels, cursorReasoningModels, cursorEffortModel, cursorLaunch, CONFIG }
