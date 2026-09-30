import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { proxyEnvironment } from './provider-network.mts'
import { removeTemporaryDirectory } from './storage.mts'
import { isOrbitResponseEnvelope, TOOL_HANDOFF } from './tool-schema.mts'
import type { QuotaTaggedError } from './quota.mts'
import type { CliResult, NormalizedSession, ProviderEvent, ProviderEventListener, ProviderHealth, ProviderOptions, ProviderResult, ProviderRunOptions, RunCli, SessionHelpers, ToolEvent } from './providers.mts'

type SubscriptionId = 'antigravity' | 'cursor'
interface SubscriptionConfig { command: string; env: string; label: string; login: string; models: string[] }
// The run options after this module has resolved the Cursor model variant and written the Antigravity schema file.
interface SubscriptionRunOptions extends ProviderRunOptions { schemaPath?: string; availableModels?: string[] }
type LaunchArgOptions = Pick<SubscriptionRunOptions, 'accessMode' | 'approvalPolicy' | 'model' | 'reasoningEffort' | 'availableModels' | 'schemaPath'>
// A model name split into its family and the reasoning level Cursor spells into it ("claude-opus-5-5-high-thinking").
interface ModelVariant { family: string | undefined; effort: string; suffix: string }
interface CursorLaunch { model: string | undefined; dropped?: string }
interface SubscriptionParser { line(line: string): typeof TOOL_HANDOFF | undefined; finish(): { text: string; model: string; usage: unknown; sessionId: string | undefined } }
interface SessionParser { line(line: string): undefined; finish(): { text: string; model: string; sessionId: string | undefined } }
// The parser's own accounting of what the CLI reported, and the result shapes of both CLIs.
interface AntigravityToolInfo { output?: string; name?: string; parameters?: unknown; error?: unknown }
interface AntigravityStep { conversation_id?: string; step_type?: string; step_index?: number; text_delta?: string; state?: string; usage?: Record<string, unknown>; tool_name?: string; tool_info?: AntigravityToolInfo }
interface AntigravityResult { status?: string; error?: string; denied_actions?: unknown[]; structured_output?: unknown; response?: string; usage?: unknown; conversation_id?: string; session_id?: string }
interface CursorContentBlock { type?: string; text?: string }
// One `stream-json` line of either CLI; Antigravity fields (`event`, `step_update`, `conversation_id`) and Cursor
// fields (`type`, `subtype`, `tool_call`, `call_id`, `is_error`) share one shape because the parser handles both.
interface SubscriptionEvent {
  type?: string; event?: string; subtype?: string; model?: string; init?: { model?: string }
  conversation_id?: string; session_id?: string; step_update?: AntigravityStep; result?: AntigravityResult | string | unknown
  message?: { content?: CursorContentBlock[] } | string; tool_call?: unknown; call_id?: string; is_error?: boolean; usage?: unknown; error?: { message?: string }
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
// Session mode (Full access only, providers.transportFor decides): one CLI conversation per agent, resumed every turn,
// with Orbit's tools as the MCP server "orbit". Cursor gets a plugin folder per turn; an Antigravity conversation keeps
// a folder of its own (its working folder) until closeSession. Both folder names carry the owning process id.
const CURSOR_PLUGIN_PREFIX = 'orbit-cursor-mcp-'
const AGY_SESSION_PREFIX = 'orbit-agy-session-'
// Antigravity ends an MCP tool call after the server's `timeoutSeconds`; Orbit answers before that (providers.mcpCallLimit).
const AGY_MCP_TIMEOUT_SECONDS = 3600
// Session folders an earlier Orbit process left behind are removed by the first session of this one: at once when the
// process named in the folder is gone, else (an unnamed folder, or a process id reused since) once this old.
const SWEEP_AGE_MS = 6 * 60 * 60 * 1000
// A session id goes back to the CLI as a command-line argument on resume (Cursor --resume, Antigravity --conversation,
// Codex exec resume): only a plain token is taken from a stream, never one that could pass for a flag or is not text.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Orbit's server as each CLI names it: `plugin-orbit-orbit` (Cursor), `orbit_orbit` (Antigravity), or plain `orbit`.
const ORBIT_SERVER = /(?:^|[-_:/.])orbit$/i
// A used-up Cursor plan is reported on stderr only ("ActionRequiredError: You've hit your usage limit …"); other
// ActionRequiredErrors (a login, say) are not quota.
const USAGE_LIMIT = /usage limit|hit your (?:\w+ )?limit/i
// Antigravity conversation id → the folder its turns run in.
const agyFolders = new Map<string, string>()
let swept = false, exitHook = false

function commandFor(id: SubscriptionId, options: ProviderOptions = {}): string { return options.command || process.env[CONFIG[id].env] || CONFIG[id].command }
// The caller's extra variables for the CLI child (the runtime's restart variables), string values only.
function extraEnv(options: Pick<ProviderRunOptions, 'extraEnv'>): Record<string, string> {
  const extra = options.extraEnv
  if (!extra || typeof extra !== 'object') return {}
  return Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[0] && !entry[0].includes('=')))
}
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
// Session turn of Cursor: Full access (`--force` is also what lets it run an MCP tool unprompted), Orbit's server from
// the plugin folder approved up front, a resume by the chat id `system/init` reported. The prompt goes through stdin.
// `--approve-mcps` approves every MCP server Cursor has configured, the user's own (global and project) ones included,
// not only Orbit's plugin: acceptable only because this transport exists in Full access alone.
function buildCursorSessionArgs(options: LaunchArgOptions, session: Pick<NormalizedSession, 'id' | 'resume'>, { pluginDir }: { pluginDir?: string } = {}): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--trust']
  if (pluginDir) args.push('--approve-mcps', '--plugin-dir', pluginDir)
  args.push('--force', '--sandbox', 'disabled')
  if (session.resume && session.id) args.push('--resume', session.id)
  const model = cursorLaunch(options.model, options.reasoningEffort, options.availableModels || []).model
  if (model) args.push('--model', model)
  return args
}
// Session turn of Antigravity: NDJSON in and out, the project added to the scratch working folder, every permission
// granted (headless it cannot approve an MCP call otherwise), a resume by the conversation id `init` reported.
function buildAntigravitySessionArgs(options: LaunchArgOptions, session: Pick<NormalizedSession, 'id' | 'resume'>, workspace: string): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json']
  if (options.model) args.push('--model', options.model)
  args.push('--add-dir', workspace, '--dangerously-skip-permissions')
  if (session.resume && session.id) args.push('--conversation', session.id)
  return args
}
// Cursor loads Orbit's server from a plugin folder (its id becomes `plugin-orbit-orbit`). The header names the token by
// variable, which Cursor expands from its environment, so the token never touches the disk.
function writeCursorPlugin(mcpUrl: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${CURSOR_PLUGIN_PREFIX}${process.pid}-`))
  try {
    fs.mkdirSync(path.join(directory, '.cursor-plugin'))
    fs.writeFileSync(path.join(directory, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'orbit', version: '1.0.0', description: 'Orbit tools' }))
    fs.writeFileSync(path.join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { orbit: { url: mcpUrl, headers: { Authorization: 'Bearer ${env:ORBIT_MCP_TOKEN}' } } } }))
    return directory
  } catch (error) { removeTemporaryDirectory(directory, CURSOR_PLUGIN_PREFIX); throw error }
}
// Antigravity finds plugins under `.agents/` from its working folder up: the conversation's folder holds Orbit's plugin
// with the server (namespaced `orbit_orbit`; this CLI takes no token variable, so the short-lived token is in the file)
// and, as the plugin's always-on rule, the stable Orbit block the other CLIs get as a system prompt. Rewritten before
// every turn, since the port and the token may change.
function writeAntigravityPlugin(directory: string, session: Pick<NormalizedSession, 'mcpUrl' | 'token' | 'systemAppend'>, workspace: string): void {
  const plugin = path.join(directory, '.agents', 'plugins', 'orbit')
  fs.mkdirSync(path.join(plugin, 'rules'), { recursive: true })
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ name: 'orbit' }))
  const servers = session.mcpUrl && session.token ? { orbit: { serverUrl: session.mcpUrl, headers: { Authorization: `Bearer ${session.token}` }, timeoutSeconds: AGY_MCP_TIMEOUT_SECONDS } } : {}
  fs.writeFileSync(path.join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  const where = `WORKSPACE: the project is ${workspace}. This process starts in a scratch folder that only holds Orbit's plugin: work in the project, with absolute paths under it, and run commands with the project as their working directory.`
  const tools = 'Orbit tools are called with call_mcp_tool, ServerName "orbit_orbit" and ToolName the Orbit tool\'s name.'
  fs.writeFileSync(path.join(plugin, 'rules', 'AGENTS.md'), `${session.systemAppend ? `${session.systemAppend}\n\n` : ''}${where}\n${tools}\n`)
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
        if (event.type === 'tool_call') onEvent?.({ providerId: id, kind: 'tool', native: true, text: JSON.stringify(event.tool_call || {}), status: event.subtype, ...(typeof event.call_id === 'string' ? { toolId: event.call_id } : {}) })
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
// Cursor names a tool call by the key inside `tool_call` (`readToolCall`, `shellToolCall`, `mcpToolCall`, …). An MCP
// call to Orbit's server is an Orbit tool event (the runtime records it where it is dispatched); file tools are named
// as file-activity reads them.
const CURSOR_FILE_TOOLS: Record<string, string> = { readToolCall: 'read', writeToolCall: 'write', editToolCall: 'edit' }
function cursorToolEvent(event: SubscriptionEvent): ToolEvent {
  const [kind = 'tool', body] = isRecord(event.tool_call) ? Object.entries(event.tool_call)[0] || [] : []
  const call = isRecord(body) ? body : {}
  const args: Record<string, unknown> = isRecord(call.args) ? call.args : {}
  const done = event.subtype === 'completed'
  const status = done && isRecord(call.result) && ['error', 'failure', 'rejected'].some(key => key in (call.result as object)) ? 'failed' : done ? 'completed' : String(event.subtype || 'started')
  const output = call.result === undefined ? undefined : typeof call.result === 'string' ? call.result : JSON.stringify(call.result)
  const toolId = typeof event.call_id === 'string' ? event.call_id : undefined
  const named = typeof args.toolName === 'string' ? args.toolName : typeof args.name === 'string' ? args.name : ''
  const orbitTool = kind === 'mcpToolCall' && ORBIT_SERVER.test(String(args.providerIdentifier || args.serverIdentifier || '')) ? named.replace(/^(?:mcp_+)?(?:plugin-orbit-)?orbit(?:__|[-_:.])/, '') : ''
  if (orbitTool) return { providerId: 'cursor', kind: 'tool', tool: `mcp__orbit__${orbitTool}`, toolId, status, input: args.args, output, text: `${orbitTool} ${JSON.stringify(args.args ?? {}).slice(0, 200)}`, native: false, mcp: true, server: 'orbit', orbitTool }
  const target = typeof args.path === 'string' ? args.path : undefined
  const text = [args.command, args.path, args.pattern, args.globPattern, args.query, named].find((value): value is string => typeof value === 'string' && value !== '')
  return { providerId: 'cursor', kind: 'tool', tool: (target && CURSOR_FILE_TOOLS[kind]) || kind, toolId, status, input: target ? { path: target } : args, output, text: text || kind, native: true }
}
// Antigravity's tool steps: `call_mcp_tool` on Orbit's plugin server is an Orbit tool event; file tools carry their path
// the way file-activity reads it. Parameter names as the CLI (1.2.13) spells them.
const AGY_FILE_TOOLS: Record<string, [string, string]> = { view_file: ['read', 'AbsolutePath'], write_to_file: ['write', 'TargetFile'], replace_file_content: ['edit', 'TargetFile'], multi_replace_file_content: ['edit', 'TargetFile'] }
const AGY_STATES: Record<string, string> = { ACTIVE: 'started', DONE: 'completed', ERROR: 'failed' }
function antigravityToolEvent(step: AntigravityStep): ToolEvent {
  const name = step.tool_name || 'tool'
  const info: AntigravityToolInfo = step.tool_info || {}
  const parameters: Record<string, unknown> = isRecord(info.parameters) ? info.parameters : {}
  const status = AGY_STATES[String(step.state)] || (step.state ? String(step.state).toLowerCase() : undefined)
  const toolId = step.step_index === undefined ? undefined : `step-${step.step_index}`
  const failure = isRecord(info.error) && typeof info.error.message === 'string' ? info.error.message : undefined
  const output = typeof info.output === 'string' ? info.output : failure
  const orbitTool = name === 'call_mcp_tool' && ORBIT_SERVER.test(String(parameters.ServerName || '')) && typeof parameters.ToolName === 'string' ? parameters.ToolName : ''
  if (orbitTool) return { providerId: 'antigravity', kind: 'tool', tool: `mcp__orbit__${orbitTool}`, toolId, status, input: parameters.Arguments, output, text: `${orbitTool} ${JSON.stringify(parameters.Arguments ?? {}).slice(0, 200)}`, native: false, mcp: true, server: 'orbit', orbitTool }
  const file = AGY_FILE_TOOLS[name]
  const target = file && typeof parameters[file[1]] === 'string' ? parameters[file[1]] as string : undefined
  const text = target || (typeof parameters.CommandLine === 'string' ? parameters.CommandLine : '') || name
  return { providerId: 'antigravity', kind: 'tool', tool: file && target ? file[0] : name, toolId, status, input: target ? { path: target } : parameters, output, text, native: true }
}
// Session mode: no envelope and no handoff. The session id, Orbit's MCP calls, native tool activity and the final answer
// come from the stream; usage arrives once, with the completion observation. A denied action is a diagnostic, not a
// failure, and an empty final result (Antigravity `response`, Cursor `result`) falls back to the last text the turn streamed.
function createSessionParser(id: SubscriptionId, onEvent: ProviderEventListener | null | undefined, requestedModel = ''): SessionParser {
  let model = requestedModel, sessionId: string | undefined, failure = '', result: string | undefined, streamed = '', segment = 0, badId = false
  const messages = new Map<string, string>()
  const completed = new Set<string>()
  const emit = (event: ProviderEvent) => { try { onEvent?.(event) } catch { /* A UI observer does not control the provider. */ } }
  // A session id is taken only as a plain token (SESSION_ID); anything else is ignored, and reported once.
  const takeId = (value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (typeof value === 'string' && SESSION_ID.test(value)) { sessionId = value; return }
    if (!badId) { badId = true; emit({ providerId: id, kind: 'observation', source: 'diagnostic', text: `Ignored a malformed session id: ${String(JSON.stringify(value)).slice(0, 80)}` }) }
  }
  const cursorText = (event: SubscriptionEvent) => {
    const content = typeof event.message === 'object' ? event.message?.content : undefined
    const text = Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text || '').join('') : ''
    if (!text) return
    // Text between two tool calls is one message; a message that does not continue the previous one starts another.
    let messageId = `cursor-${segment}`, previous = messages.get(messageId)
    if (previous !== undefined && !text.startsWith(previous)) { messageId = `cursor-${++segment}`; previous = undefined }
    if (text !== previous) emit({ providerId: id, kind: 'output', text: text.slice(previous?.length || 0), messageId, partial: false })
    messages.set(messageId, text)
    if (text.trim()) streamed = text
  }
  return {
    line(line) {
      if (!line.trim()) return
      let event: unknown
      try { event = JSON.parse(line) } catch { emit({ providerId: id, kind: 'observation', source: 'diagnostic', text: line }); return }
      if (!isSubscriptionEvent(event)) return
      model = event.model || event.init?.model || model
      if (id === 'antigravity') {
        const step = event.step_update
        takeId(step?.conversation_id); takeId(event.conversation_id)
        if (step?.step_type === 'agent_response') {
          const messageId = String(step.step_index ?? 'response')
          if (!completed.has(messageId)) {
            const output = (messages.get(messageId) || '') + (step.text_delta || '')
            messages.set(messageId, output)
            if (step.text_delta) emit({ providerId: id, kind: 'output', partial: step.state !== 'DONE', messageId, text: step.text_delta })
            if (step.state === 'DONE') { completed.add(messageId); if (output.trim()) streamed = output }
          }
        }
        if (step?.step_type === 'tool') emit(antigravityToolEvent(step))
        if (event.event === 'result') {
          const outcome: AntigravityResult = isRecord(event.result) ? event.result : {}
          takeId(outcome.conversation_id)
          if (outcome.status !== 'SUCCESS') failure = outcome.error || `Antigravity ended with ${outcome.status}`
          else result = outcome.structured_output ? JSON.stringify(outcome.structured_output) : outcome.response || ''
          if (outcome.denied_actions?.length) emit({ providerId: id, kind: 'observation', source: 'diagnostic', status: 'denied', text: `Antigravity denied: ${JSON.stringify(outcome.denied_actions).slice(0, 500)}` })
          emit({ providerId: id, kind: 'observation', text: failure || 'Antigravity turn completed', status: failure ? 'error' : 'completed', usage: outcome.usage })
        }
      } else {
        takeId(event.session_id)
        if (event.type === 'assistant') cursorText(event)
        if (event.type === 'tool_call') { emit(cursorToolEvent(event)); if (event.subtype !== 'completed') segment++ }
        if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') failure = typeof event.result === 'string' && event.result ? event.result : 'Cursor request failed'
          else result = typeof event.result === 'string' ? event.result : ''
          emit({ providerId: id, kind: 'observation', text: failure || 'Cursor turn completed', status: failure ? 'error' : 'completed', usage: event.usage })
        }
      }
      // An error's `message` is its text; anything else is described (as JSON, never "[object Object]").
      if (event.type === 'error' || event.event === 'error') {
        const detail: unknown = event.error?.message ?? event.error
        failure = typeof detail === 'string' && detail ? detail
          : detail !== null && typeof detail === 'object' ? JSON.stringify(detail)
          : (typeof event.message === 'string' && event.message) || 'CLI request failed'
      }
    },
    finish() {
      if (failure) throw new Error(failure)
      if (result === undefined) throw new Error(`${CONFIG[id].label} ended without a successful result`)
      // Antigravity's `response` joins every message of the turn, the narration between tool calls included; the answer
      // is its last message, as the other CLIs report it. A response that does not end with that message is kept whole.
      const joined = id === 'antigravity' && streamed.trim() !== '' && result.trim().endsWith(streamed.trim())
      const text = result.trim() && !joined ? result : streamed
      if (!text.trim()) throw new Error(`${CONFIG[id].label} completed without an assistant response`)
      return { text, model, sessionId }
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
// Cursor spells the reasoning level into the model name, so a level needs the catalog (cached a minute) to pick the variant.
async function resolveCursorModel(options: SubscriptionRunOptions, command: string, runCli: RunCli): Promise<{ options: SubscriptionRunOptions; dropped?: string }> {
  if (!options.reasoningEffort) return { options }
  let catalog = modelCache.get(`cursor:${command}`)
  if (!catalog || catalog.expires < Date.now()) {
    let output = ''
    const result = await runCli(command, CONFIG.cursor.models, { timeoutMs: 10000, signal: options.signal, onLine: line => { output += `${line}\n` } })
    catalog = { models: parseModels(output || result.stdout), expires: Date.now() + 60000 }
    modelCache.set(`cursor:${command}`, catalog)
  }
  const launch = cursorLaunch(options.model, options.reasoningEffort, catalog.models)
  const resolved: SubscriptionRunOptions = { ...options, model: launch.model, availableModels: catalog.models, ...(launch.dropped ? { reasoningEffort: '' } : {}) }
  if (launch.dropped) resolved.onEvent?.({ providerId: 'cursor', kind: 'observation', source: 'diagnostic', text: `Cursor не предлагает вариантов уровня рассуждений для ${resolved.model || 'автоматической модели'}: уровень ${launch.dropped} не применён, модель запущена как есть.` })
  return { options: resolved, dropped: launch.dropped }
}
async function run(id: SubscriptionId, options: SubscriptionRunOptions, { runCli }: { runCli: RunCli }): Promise<ProviderResult> {
  const command = commandFor(id, options.providerOptions)
  const parserRequestedModel = options.model || ''
  const parser = createParser(id, options.onEvent, options.model, options.responseSchema)
  let directory: string | undefined, droppedEffort: string | undefined
  try {
    const env = { ...extraEnv(options), ...(id === 'antigravity' ? await proxyEnvironment(options.providerOptions) : {}) }
    if (id === 'cursor') ({ options, dropped: droppedEffort } = await resolveCursorModel(options, command, runCli))
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

// ---- Session mode -------------------------------------------------------------------------------------------------
// The CLI's own words for a failed turn. A usage-limit refusal (Cursor says it on stderr only, sometimes without a
// failed result event) is tagged, so failover recognises it without reading prose; an in-band failure the parser saw
// beats the raw output tail runCli reports.
function usageRefusal(id: SubscriptionId, stderr: string[]): QuotaTaggedError | null {
  const line = stderr.find(text => USAGE_LIMIT.test(text))
  if (!line) return null
  const error: QuotaTaggedError = new Error(line.trim())
  error.quota = { providerId: id }
  return error
}
function turnFailure(id: SubscriptionId, error: unknown, parser: SessionParser, stderr: string[]): unknown {
  if (['AbortError', 'TimeoutError'].includes((error as Error | null)?.name ?? '')) return error
  const refusal = usageRefusal(id, stderr)
  if (refusal) return refusal
  try { parser.finish() } catch (reported) { if (!/ended without|completed without/.test((reported as Error).message)) return reported }
  return error
}
function finishTurn(id: SubscriptionId, parser: SessionParser, stderr: string[]): ReturnType<SessionParser['finish']> {
  try { return parser.finish() } catch (error) {
    const refusal = usageRefusal(id, stderr)
    if (refusal) throw refusal
    if (/ended without|completed without/.test((error as Error).message) && stderr.length) throw new Error(`${(error as Error).message}: ${stderr.slice(-3).join(' | ')}`, { cause: error })
    throw error
  }
}
const keepTail = (lines: string[], text: string): void => { lines.push(text); if (lines.length > 20) lines.shift() }

async function runCursorSession(options: SubscriptionRunOptions & { workspace: string }, session: NormalizedSession, { runCli, busyCheck, loopbackNoProxy }: SessionHelpers): Promise<ProviderResult> {
  const command = commandFor('cursor', options.providerOptions)
  const requestedModel = options.model || ''
  const { options: resolved, dropped } = await resolveCursorModel(options, command, runCli)
  const parser = createSessionParser('cursor', resolved.onEvent, resolved.model)
  const stderr: string[] = []
  // One plugin folder per turn: the MCP connection is made again by every process, a resume included.
  const pluginDir = session.mcpUrl && session.token ? writeCursorPlugin(session.mcpUrl) : undefined
  try {
    // Cursor has no system-prompt option: the stable Orbit block opens the conversation's first message.
    const input = !session.resume && session.systemAppend ? `${session.systemAppend}\n\n---\n\n${resolved.prompt}` : resolved.prompt
    try {
      await runCli(command, buildCursorSessionArgs(resolved, session, { pluginDir }), {
        // Cursor keys its chats by the working folder: every turn, the resume included, runs in the workspace.
        cwd: options.workspace, input, signal: resolved.signal,
        env: { ...extraEnv(resolved), ...(session.token ? { ORBIT_MCP_TOKEN: session.token } : {}), ...loopbackNoProxy() },
        timeoutMs: resolved.timeoutMs ?? null, inactivityMs: resolved.inactivityMs, isBusy: busyCheck(session),
        onLine: parser.line,
        onDiagnostic: text => { keepTail(stderr, text); resolved.onEvent?.({ providerId: 'cursor', kind: 'observation', source: 'stderr', text }) },
      })
    } catch (error) { throw turnFailure('cursor', error, parser, stderr) }
    const parsed = finishTurn('cursor', parser, stderr)
    return {
      providerId: 'cursor', client: CONFIG.cursor.label, transport: 'session', sessionId: parsed.sessionId || (session.resume ? session.id : null),
      text: parsed.text, model: parsed.model === requestedModel ? resolved.model || parsed.model : parsed.model, access: resolved.accessMode, ...(dropped ? { reasoningEffort: '' } : {}),
    }
  } finally {
    removeTemporaryDirectory(pluginDir, CURSOR_PLUGIN_PREFIX)
  }
}

async function runAntigravitySession(options: SubscriptionRunOptions & { workspace: string }, session: NormalizedSession, { runCli, busyCheck, loopbackNoProxy }: SessionHelpers): Promise<ProviderResult> {
  const command = commandFor('antigravity', options.providerOptions)
  const parser = createSessionParser('antigravity', options.onEvent, options.model)
  const stderr: string[] = []
  const proxy = await proxyEnvironment(options.providerOptions)
  // A resume runs in the folder its conversation started in; a new conversation (or a lost folder) gets a new one.
  let directory = session.resume && session.id ? agyFolders.get(session.id) : undefined
  if (directory && !fs.existsSync(directory)) { agyFolders.delete(session.id as string); directory = undefined }
  const created = !directory
  const folder = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), `${AGY_SESSION_PREFIX}${process.pid}-`))
  removeFoldersOnExit()
  let conversation: string | undefined
  try {
    writeAntigravityPlugin(folder, session, options.workspace)
    try {
      await runCli(command, buildAntigravitySessionArgs(options, session, options.workspace), {
        cwd: folder, input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n', signal: options.signal,
        // The Google proxy stays for Google; Orbit's loopback server is reached directly.
        env: { ...extraEnv(options), ...proxy, ...loopbackNoProxy({ ...process.env, ...proxy }) },
        timeoutMs: options.timeoutMs ?? null, inactivityMs: options.inactivityMs, isBusy: busyCheck(session),
        onLine: parser.line,
        onDiagnostic: text => { keepTail(stderr, text); options.onEvent?.({ providerId: 'antigravity', kind: 'observation', source: 'stderr', text }) },
      })
    } catch (error) { throw turnFailure('antigravity', error, parser, stderr) }
    const parsed = finishTurn('antigravity', parser, stderr)
    conversation = parsed.sessionId || (session.resume && session.id ? session.id : undefined)
    return { providerId: 'antigravity', client: CONFIG.antigravity.label, transport: 'session', sessionId: conversation ?? null, text: parsed.text, model: parsed.model || options.model || '', access: options.accessMode }
  } finally {
    // A conversation known from this turn keeps its folder until closeSession; a failed first turn has nothing to resume.
    if (conversation) {
      if (session.id && session.id !== conversation) agyFolders.delete(session.id)
      agyFolders.set(conversation, folder)
    } else if (created) removeTemporaryDirectory(folder, AGY_SESSION_PREFIX)
  }
}

// One session turn of a subscription CLI (runProvider sends it here when transportFor chose the session transport).
async function runSession(id: SubscriptionId, options: SubscriptionRunOptions & { workspace: string }, session: NormalizedSession, helpers: SessionHelpers): Promise<ProviderResult> {
  if (options.accessMode !== 'danger-full-access' || options.approvalPolicy === 'on-request') throw new Error(`${CONFIG[id].label}: the session transport runs only with Full access`)
  if (!swept) { swept = true; try { sweepSessionDirectories() } catch { /* Housekeeping only. */ } }
  try { return await (id === 'cursor' ? runCursorSession(options, session, helpers) : runAntigravitySession(options, session, helpers)) }
  catch (error) {
    const detail = eligibilityDetail(id, error)
    if (detail) throw new Error(`${detail}\n\n${(error as SubscriptionError).message}`, { cause: error })
    throw error
  }
}
// Ends what a session keeps between turns: an Antigravity conversation's folder (a Cursor turn keeps nothing). False
// for an id this process does not know.
function closeSession(sessionId: string): boolean {
  const folder = agyFolders.get(sessionId)
  if (!folder) return false
  agyFolders.delete(sessionId)
  removeTemporaryDirectory(folder, AGY_SESSION_PREFIX)
  return true
}
// Orbit quitting takes its conversations' folders along; a crash leaves them to the next start's sweep. An exit handler
// cannot wait for a timer, so a folder still locked (an `agy` process that has not quite ended) is retried synchronously.
function removeFoldersOnExit(): void {
  if (exitHook) return
  exitHook = true
  process.once('exit', () => { for (const folder of agyFolders.values()) { try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* The next start sweeps it. */ } } })
}
// Whether the process a folder names is certainly gone: only "no such process" says so. A live process (this one, or one
// of another user) keeps the folder, and so does a process id reused since: the folder then waits for the age rule.
function ownerGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
// Session folders an earlier Orbit process left in the temp folder (it crashed or was killed before closing them). One
// whose owning process is gone goes at once; otherwise a folder whose configuration was written within `maxAgeMs` may
// belong to another running Orbit (or predates owner names) and is left alone.
function sweepSessionDirectories(maxAgeMs = SWEEP_AGE_MS, now = Date.now()): string[] {
  const root = os.tmpdir(), live = new Set(agyFolders.values()), removed: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const prefix = [AGY_SESSION_PREFIX, CURSOR_PLUGIN_PREFIX].find(item => entry.name.startsWith(item))
    const folder = path.join(root, entry.name)
    if (!prefix || !entry.isDirectory() || live.has(folder)) continue
    const owner = /^(\d+)-/.exec(entry.name.slice(prefix.length))
    const written = [folder, path.join(folder, '.agents', 'plugins', 'orbit', 'mcp_config.json'), path.join(folder, 'mcp.json')].map(file => { try { return fs.statSync(file).mtimeMs } catch { return 0 } })
    if (!(owner && ownerGone(Number(owner[1]))) && now - Math.max(...written) < maxAgeMs) continue
    removeTemporaryDirectory(folder, prefix)
    removed.push(folder)
  }
  return removed
}
export type { SubscriptionId, SubscriptionConfig, SubscriptionRunOptions, SubscriptionEvent, SubscriptionParser, SessionParser, CursorLaunch, ModelVariant }
export { inspect, run, runSession, closeSession, sweepSessionDirectories, buildArgs, buildCursorSessionArgs, buildAntigravitySessionArgs, writeCursorPlugin, writeAntigravityPlugin, createParser, createSessionParser, parseModels, cursorReasoningModels, cursorEffortModel, cursorLaunch, CONFIG, SESSION_ID }
