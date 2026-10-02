import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { isOrbitToolEnvelope, TOOL_HANDOFF } from './tool-schema.mts'
import { removeTemporaryDirectory } from './storage.mts'
import { claudeServers, codexConnectorArgs, toolCallText } from './connectors.mts'
import type { ConnectorLaunch } from './connectors.mts'
import { attachmentsFolder } from './attachments.mts'
import { claudeStreamLimit } from './quota.mts'
import type { ClaudeRateLimitInfo, QuotaPartial, QuotaTaggedError } from './quota.mts'
import { execTurnUsage, startedThread } from './codex-usage.mts'
import { report } from './diagnostics.mts'
import { processWatch } from './process-reaper.mts'
import type { ProcessScope } from './process-reaper.mts'
import REASONING_DEFAULTS from './reasoning-defaults.json' with { type: 'json' }
// codex-server.mts imports loopbackNoProxy from this file; both sides use the other only inside functions, so the ESM cycle is harmless.
import * as codexServer from './codex-server.mts'
import * as subscriptions from './subscription-providers.mts'
import type { SubscriptionId } from './subscription-providers.mts'

// ---- Shared shapes -----------------------------------------------------------------------------------------------

type AccessMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type Transport = 'session' | 'envelope'
type ProviderEventKind = 'output' | 'reasoning' | 'thinking' | 'tool' | 'observation' | 'quota' | 'session' | 'usage' | 'compaction'
interface ProviderEventBase { providerId: string; kind: ProviderEventKind }
// A text delta of the assistant's answer; `replace` rewrites the message instead of appending.
interface OutputEvent extends ProviderEventBase { kind: 'output'; text: string; messageId?: string; partial?: boolean; replace?: boolean; parentToolId?: string | null }
interface ReasoningEvent extends ProviderEventBase { kind: 'reasoning'; text: string; messageId?: string; partial?: boolean; parentToolId?: string | null }
// The model thinks (Claude, whose thinking text the stream leaves empty): `tokens` is the CLI's estimate of the thinking
// block so far (0 when it begins), `done` ends the block.
interface ThinkingEvent extends ProviderEventBase { kind: 'thinking'; tokens?: number; done?: boolean }
// A native CLI tool call, or an Orbit tool reached over MCP (`mcp: true`, `orbitTool` names it).
interface ToolEvent extends ProviderEventBase { kind: 'tool'; text: string; tool?: string; toolId?: string; parentToolId?: string | null; status?: string; input?: unknown; output?: string; exitCode?: number | null; changes?: unknown; native: boolean; mcp?: boolean; server?: string; orbitTool?: string; images?: ToolImage[] }
// An image a tool result carried (a screenshot the agent read): base64 bytes and the media type.
interface ToolImage { mediaType: string; data: string }
interface ObservationEvent extends ProviderEventBase { kind: 'observation'; text: string; source?: string; status?: string; usage?: unknown }
// Account figures seen in the stream; the runtime feeds them to the quota monitor.
interface QuotaEvent extends ProviderEventBase { kind: 'quota'; quota: QuotaPartial }
// The CLI named its session as the turn began (a Codex thread, a Cursor chat, an Antigravity conversation): a turn Orbit
// cuts off before its result can still be resumed in it (runtime turn.mts).
interface SessionEvent extends ProviderEventBase { kind: 'session'; sessionId: string }
// Tokens the model spent since the last usage event, in the vendor's own spelling: a growth, never a running total (the
// parsers deal with repeated figures and cumulative totals), which the runtime adds to the agent (runtime/turn.mts).
interface UsageEvent extends ProviderEventBase { kind: 'usage'; usage: unknown }
// Claude Code compacted the session's context (a `compact_boundary` system event): what the model read before is summarized,
// its id is unchanged (runtime/tools.mts wait_agent shows results again after it).
interface CompactionEvent extends ProviderEventBase { kind: 'compaction' }
type ProviderEvent = OutputEvent | ReasoningEvent | ThinkingEvent | ToolEvent | ObservationEvent | QuotaEvent | SessionEvent | UsageEvent | CompactionEvent
// The same union with `providerId` removed from every member (a plain Omit would collapse the union).
type WithoutProvider<E> = E extends ProviderEvent ? Omit<E, 'providerId'> : never
type ParserEvent = WithoutProvider<ProviderEvent>
type ProviderEventListener = (event: ProviderEvent) => void
interface ApprovalRequest { tool: string; arguments: Record<string, unknown> }
type ApprovalHandler = (request: ApprovalRequest) => unknown
// Per-provider settings as saved by the UI (`providerOptions[providerId]`).
interface ProviderOptions { command?: string; transport?: string; proxyMode?: string; proxyUrl?: string }
// What the MCP server reports about an agent's Orbit tool calls in flight.
interface SessionActivity { pending?: number }
type SessionActivityCheck = () => SessionActivity | null | undefined
// The session the runtime asks for: Orbit's id and MCP access; `resume` continues an earlier turn's conversation.
interface SessionOptions { id?: string | null; resume?: boolean; token?: string | null; mcpUrl?: string | null; systemAppend?: string; activity?: SessionActivityCheck | null; connectors?: ConnectorLaunch[] | null }
// `connectors`: external MCP servers (connectors.mts) the process is launched with next to Orbit's own; empty below full access.
interface NormalizedSession { id: string | null; resume: boolean; mcpUrl: string | null; token: string | null; systemAppend: string; activity: SessionActivityCheck | null; connectors: ConnectorLaunch[] }
// The options the CLI argument builders read.
interface LaunchOptions { mode?: string; accessMode?: string; approvalPolicy?: string; workspace?: string; model?: string; reasoningEffort?: string; outputSchemaPath?: string }
interface ProviderRunOptions extends LaunchOptions {
  providerId: string
  prompt: string
  signal?: AbortSignal
  onEvent?: ProviderEventListener | null
  onApproval?: ApprovalHandler | null
  timeoutMs?: number | null
  inactivityMs?: number | null
  responseSchema?: unknown
  session?: SessionOptions | null
  providerOptions?: ProviderOptions
  transport?: string
  legacyEnvelope?: boolean
  // Added to the environment of every CLI process the turn starts (the runtime's restart variables); Orbit's own
  // transport variables (MCP token, NO_PROXY, proxy settings) win over it.
  extraEnv?: Record<string, string> | null
  // The agent's turn the CLI belongs to: what the CLI leaves running when it ends is stopped (process-reaper.mts) and reported here.
  processScope?: ProcessScope | null
}
// A native run always has a workspace (runProvider fills in the process cwd).
interface NativeRunOptions extends ProviderRunOptions { workspace: string }
interface ProviderResult { providerId: string; client: string; text: string; model: string; access?: string; transport?: Transport; sessionId?: string | null; usage?: unknown; reasoningEffort?: string }
interface ProviderHealth { id: string; supported: boolean; available: boolean; installed?: boolean; authenticated?: boolean | null; models?: string[]; reasoningLevels?: Record<string, string[]>; detail: string; executable?: string; model?: string }
type InspectOptions = Record<string, ProviderOptions | undefined>
interface CliLaunch { executable: string; args: string[]; env: NodeJS.ProcessEnv }
interface CliResult { stdout: string; stderr: string }
interface LineReader { write(chunk: string | Buffer | NodeJS.ArrayBufferView): void; end(): void }
interface RunCliOptions {
  cwd?: string
  input?: string
  timeoutMs?: number | null
  inactivityMs?: number | null
  isBusy?: (() => boolean) | null
  signal?: AbortSignal | null
  onLine?: (line: string) => unknown
  onDiagnostic?: (line: string) => void
  env?: NodeJS.ProcessEnv
  maxOutputBytes?: number
  // Set for the CLI of an agent's turn: it is followed, and what it leaves running is stopped when it ends.
  scope?: ProcessScope | null
}
// What a stream parser hands back once the CLI is done.
interface ParsedTurn { text: string; model: string; sessionId?: string; usage?: unknown }
interface StreamParser { line(line: string): typeof TOOL_HANDOFF | undefined; finish(): ParsedTurn }
// The process helpers codex-server.mts and subscription-providers.mts borrow from this module.
interface CliHelpers { resolveLaunch: typeof resolveLaunch; terminateProcess: typeof terminateProcess; createLineReader: typeof createLineReader; busyCheck?: typeof busyCheck }
type RunCli = typeof runCli
// What subscription-providers.mts needs for a session turn (passed in: that module imports only types from this one).
interface SessionHelpers { runCli: RunCli; busyCheck: typeof busyCheck; loopbackNoProxy: typeof loopbackNoProxy }

// ---- CLI stream shapes (trusted after the JSON boundary; the guards only check that a line is an object) --------

// `codex exec --json` events.
interface CodexEventBase { model?: string; thread?: { model?: string }; metadata?: { model?: string }; item?: CodexItem }
interface CodexThreadStartedEvent extends CodexEventBase { type: 'thread.started'; thread_id?: unknown }
interface CodexTurnFailedEvent extends CodexEventBase { type: 'turn.failed'; error?: unknown }
interface CodexErrorEvent extends CodexEventBase { type: 'error'; message?: unknown; error?: unknown }
interface CodexTurnCompletedEvent extends CodexEventBase { type: 'turn.completed'; usage?: unknown }
interface CodexItemEvent extends CodexEventBase { type: 'item.started' | 'item.updated' | 'item.completed' }
type CodexEvent = CodexThreadStartedEvent | CodexTurnFailedEvent | CodexErrorEvent | CodexTurnCompletedEvent | CodexItemEvent
interface CodexChange { kind?: string; path?: string }
interface CodexAgentMessageItem { type: 'agent_message'; id?: string; text?: unknown; phase?: string }
interface CodexToolItem { type: 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search' | 'collab_tool_call'; id?: string; command?: string; query?: string; server?: string; tool?: string; changes?: CodexChange[]; status?: string; aggregated_output?: string; exit_code?: number | null }
interface CodexReasoningItem { type: 'reasoning'; id?: string; text?: unknown }
interface CodexErrorItem { type: 'error'; id?: string; message?: unknown }
interface CodexTodoItem { type: 'todo_list'; id?: string; items?: { completed?: boolean; text?: string }[] }
type CodexItem = CodexAgentMessageItem | CodexToolItem | CodexReasoningItem | CodexErrorItem | CodexTodoItem
const CODEX_TOOL_ITEMS = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call']
const isCodexToolItem = (item: CodexItem): item is CodexToolItem => CODEX_TOOL_ITEMS.includes(item.type)

// `claude --output-format stream-json` events.
interface ClaudeToolInput { command?: string; description?: string; [key: string]: unknown }
interface ClaudeTextBlock { type: 'text'; text: string }
interface ClaudeToolUseBlock { type: 'tool_use'; id: string; name: string; input?: ClaudeToolInput }
interface ClaudeToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
interface ClaudeOtherBlock { type: 'thinking' | 'redacted_thinking' | 'image' | 'document' }
type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock | ClaudeToolResultBlock | ClaudeOtherBlock
const isTextBlock = (block: ClaudeContentBlock): block is ClaudeTextBlock => block.type === 'text'
const isToolUseBlock = (block: ClaudeContentBlock): block is ClaudeToolUseBlock => block.type === 'tool_use'
const isToolResultBlock = (block: ClaudeContentBlock): block is ClaudeToolResultBlock => block.type === 'tool_result'
interface ClaudeMessage { id?: string; model?: string; content?: ClaudeContentBlock[]; usage?: unknown }
interface ClaudeTextDelta { type: 'text_delta'; text: string }
interface ClaudeThinkingDelta { type: 'thinking_delta'; thinking: string }
interface ClaudeOtherDelta { type: 'input_json_delta' | 'signature_delta' }
// One Anthropic streaming event as `stream_event.event`.
interface ClaudeStreamPart { type?: string; index?: number; message?: { id?: string; usage?: unknown }; usage?: unknown; delta?: ClaudeTextDelta | ClaudeThinkingDelta | ClaudeOtherDelta; content_block?: { type?: string; id: string; name: string } }
interface ClaudeEventBase { model?: string; session_id?: string; parent_tool_use_id?: string | null; message?: ClaudeMessage; content?: ClaudeContentBlock[] }
interface ClaudeRateLimitEvent extends ClaudeEventBase { type: 'rate_limit_event'; rate_limit_info?: ClaudeRateLimitInfo }
interface ClaudeErrorEvent extends ClaudeEventBase { type: 'error'; error?: unknown }
interface ClaudeResultEvent extends ClaudeEventBase { type: 'result'; subtype?: string; is_error?: boolean; errors?: unknown[]; result?: unknown; usage?: unknown; structured_output?: unknown }
interface ClaudeStreamEvent extends ClaudeEventBase { type: 'stream_event'; event?: ClaudeStreamPart }
interface ClaudeAssistantEvent extends ClaudeEventBase { type: 'assistant' }
interface ClaudeUserEvent extends ClaudeEventBase { type: 'user' }
// subtype thinking_tokens: `estimated_tokens` is the CLI's running estimate of the thinking block in progress.
interface ClaudeSystemEvent extends ClaudeEventBase { type: 'system'; subtype?: string; estimated_tokens?: unknown }
type ClaudeEvent = ClaudeRateLimitEvent | ClaudeErrorEvent | ClaudeResultEvent | ClaudeStreamEvent | ClaudeAssistantEvent | ClaudeUserEvent | ClaudeSystemEvent

// Ollama `/api/generate` NDJSON, `/api/tags` and `/api/show`.
interface OllamaGenerateEvent { error?: unknown; model?: string; thinking?: string; response?: string; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number }
interface OllamaTags { models?: { name?: string; model?: string }[] }
interface OllamaShow { capabilities?: string[]; thinking?: { values?: unknown[] } }
// Chat Completions, streamed chunk or whole response.
interface ChatMessage { content?: unknown; tool_calls?: unknown[]; function_call?: unknown; refusal?: string }
interface ChatChoice { index?: number; delta?: ChatMessage; message?: ChatMessage; finish_reason?: string | null }
interface ChatCompletion { error?: unknown; model?: string; usage?: unknown; choices?: ChatChoice[] }
// `~/.codex/models_cache.json`.
interface CodexCachedModel { slug?: string; visibility?: string; supported_reasoning_levels?: { effort: string }[] }
interface CodexModelsCache { models?: CodexCachedModel[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
// A parsed JSONL line is taken as the CLI's event shape once it is an object; the fields are checked where they are used.
const isCodexEvent = (value: unknown): value is CodexEvent => isRecord(value)
const isClaudeEvent = (value: unknown): value is ClaudeEvent => isRecord(value)

// A Claude tool result's content as text, and the images in it (the Read tool on a screenshot, an MCP screenshot tool).
// Content with an image names each image in the text instead of its base64 bytes; any other content reads as before.
function claudeToolResult(content: unknown): { output: string; images: ToolImage[] } {
  const images: ToolImage[] = []
  const parts = Array.isArray(content) ? content.map((block: unknown) => {
    const source = isRecord(block) && block.type === 'image' && isRecord(block.source) ? block.source : null
    if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
      return isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block)
    }
    images.push({ mediaType: source.media_type, data: source.data })
    return `Изображение (${source.media_type}, ${Math.max(1, Math.round(source.data.length * 3 / 4 / 1024))} КБ)`
  }) : []
  if (!images.length) return { output: typeof content === 'string' ? content : JSON.stringify(content || ''), images }
  return { output: parts.join('\n'), images }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
// A session CLI is killed only when it has said nothing for this long (an Orbit tool call in flight does not count).
const DEFAULT_INACTIVITY_MS = 15 * 60 * 1000
// Claude Code drops an HTTP MCP tool call that is idle for 5 minutes by default; a wait_agent legitimately takes longer.
const CLAUDE_MCP_IDLE_MS = 24 * 60 * 60 * 1000
const SESSION_PROVIDERS = new Set(['claude', 'codex'])
const SUBSCRIPTION_PROVIDERS = ['antigravity', 'cursor']
const isSubscriptionId = (providerId: string): providerId is SubscriptionId => SUBSCRIPTION_PROVIDERS.includes(providerId)
// Codex ends an MCP tool call after the server's `tool_timeout_sec` (60 s unless set); Orbit's tools legitimately take
// longer (wait_agent, run_command, restart_orbit's checks), so Orbit's server gets an hour.
const CODEX_MCP_TOOL_TIMEOUT_SEC = 3600
// A provider whose MCP client ends a tool call on its own clock gets Orbit's answer before that: waits are cut at this
// limit and a slower call answers "still running, call again" (runtime/session.mts). Cursor's client uses the MCP SDK's
// 60 s default and sends no progress token; Antigravity's is the plugin's `timeoutSeconds`, Codex's `tool_timeout_sec`.
const MCP_CALL_LIMITS: Record<string, number> = { cursor: 50_000, antigravity: 3_540_000, codex: CODEX_MCP_TOOL_TIMEOUT_SEC * 1000 - 60_000 }
// A resumed Cursor chat, Antigravity conversation or Codex thread id goes to the CLI as an argument: never let it look
// like a flag (the stream parsers accept nothing else; this rule lives with the subscription parsers).
const SESSION_ID = subscriptions.SESSION_ID
const ORBIT_MCP_PREFIX = 'mcp__orbit__'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DIAGNOSTIC_LIMIT = 16000
const ACCESS_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const isAccessMode = (value: string): value is AccessMode => ACCESS_MODES.has(value)
let ollamaSelectionCache: { key: string; model: string; expires: number } | null = null

function existingFile(candidate: string): string | null {
  try { return fs.statSync(candidate).isFile() ? candidate : null } catch { return null }
}

function knownCommandCandidates(command: string): string[] {
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
    } catch (error) { report('providers: codex IDE extension scan (the IDE installation is optional)', error) }
  }
  return candidates
}

// PATH is searched in JavaScript. where.exe blocked the main thread for about 110 ms on every provider turn,
// and its OEM-codepage output corrupted PATH directories with non-ASCII names, so those commands were never found.
const pathLookups = new Map<string, { found: string | null; at: number }>()
function findOnPath(command: string): string | null {
  const key = `${command}\0${process.env.PATH}`
  const cached = pathLookups.get(key)
  if (cached && Date.now() - cached.at < 30000) return cached.found
  let found: string | null = null
  if (!/[\\/]/.test(command)) {
    const extensions = /\.(exe|cmd|bat)$/i.test(command) ? [''] : ['.exe', '.bat', '.cmd']
    const matches: string[] = []
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

function resolveCommand(command: string): string {
  if (path.isAbsolute(command)) return command
  if (process.platform === 'win32') {
    const found = findOnPath(command)
    if (found) return found
  }
  return knownCommandCandidates(command).map(existingFile).find(Boolean) || command
}

// Never ask cmd.exe to interpret user-controlled arguments. npm's ordinary shims
// point to a JS entry point which Node can execute directly, with shell:false.
function resolveLaunch(command: string, args: string[]): CliLaunch {
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
      } catch (error) { report('providers: versioned CLI install scan (falls through to the shim check)', error) }
    }
    const shim = fs.readFileSync(executable, 'utf8')
    const match = shim.match(/"%(?:dp0|~dp0)%?([\\/][^"\r\n]+\.(?:c?js|mjs))"/i)
    const entry = match && path.resolve(path.dirname(executable), match[1].replace(/^[\\/]+/, ''))
    if (!entry || !existingFile(entry)) throw new Error(`Cannot safely launch ${command}: use its native executable or a standard npm installation`)
    return { executable: process.execPath, args: [entry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { executable, args, env: process.env }
}

function timeoutValue(value: number | null | undefined): number {
  if (value === null || value === 0) return 0
  const configured = Number(value ?? process.env.ORBIT_PROVIDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(configured) || configured < 1 || configured > 2147483647) throw new Error('Provider timeout must be between 1 and 2147483647 ms')
  return configured
}

function inactivityValue(value: number | null | undefined): number {
  if (value === null || value === 0) return 0
  const configured = Number(value ?? process.env.ORBIT_PROVIDER_INACTIVITY_MS ?? DEFAULT_INACTIVITY_MS)
  if (!Number.isFinite(configured) || configured < 1 || configured > 2147483647) throw new Error('Provider inactivity timeout must be between 1 and 2147483647 ms')
  return configured
}

function cancelledError(label: string): Error {
  const error = new Error(`${label} execution cancelled`)
  error.name = 'AbortError'
  return error
}

function terminateProcess(child: ChildProcess | null | undefined): Promise<void> {
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

function createLineReader(onLine: (line: string) => void): LineReader {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const consume = (text: string, finish: boolean) => {
    pending += text
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      onLine(line)
    }
    if (finish && pending) { const line = pending; pending = ''; onLine(line.replace(/\r$/, '')) }
  }
  return { write: (chunk) => consume(decoder.write(chunk), false), end: () => consume(decoder.end(), true) }
}

// `timeoutMs` is a total deadline (undefined: 30 min, null/0: none). `inactivityMs` kills a process that emits nothing
// for that long (undefined: ORBIT_PROVIDER_INACTIVITY_MS or 15 min, null/0: none) unless `isBusy()` says it is
// legitimately silent, as a session CLI is while an Orbit tool call runs in this process.
function runCli(file: string, args: string[], { cwd, input = '', timeoutMs, inactivityMs, isBusy, signal, onLine, onDiagnostic, env, maxOutputBytes = MAX_OUTPUT_BYTES, scope }: RunCliOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError(file))
    let launch: CliLaunch
    let deadline: number
    let idle: number
    try { launch = resolveLaunch(file, args); deadline = timeoutValue(timeoutMs); idle = inactivityValue(inactivityMs) } catch (error) { return reject(error) }
    const startedAt = Date.now()
    const child = spawn(launch.executable, launch.args, {
      cwd, env: { ...launch.env, ...env }, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    })
    // An agent's CLI is followed: whatever it leaves running when it ends (background runners, browsers) is stopped.
    const followed = !!scope && processWatch.track(child, { startedAt, scope })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    let stopping = false
    let timer: NodeJS.Timeout | undefined
    let idleTimer: NodeJS.Timeout | undefined
    const finish = (error?: unknown) => {
      if (settled) return
      if (!error && signal?.aborted) error = cancelledError(file)
      settled = true
      clearTimeout(timer); clearTimeout(idleTimer)
      signal?.removeEventListener('abort', abort)
      // A CLI that ended by itself is looked at a moment later, without holding the turn's result.
      if (followed) void processWatch.end(child)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const stop = (error?: unknown) => {
      if (settled || stopping) return
      stopping = true
      clearTimeout(timer); clearTimeout(idleTimer)
      // Settle cancellation after terminating the entire process tree and, once that is done, stopping what the CLI left
      // outside it (process-reaper.mts). The Orbit tool call that ends an envelope turn (no error) does not wait for the second.
      const terminated = terminateProcess(child)
      const cleaned = followed ? processWatch.end(child, { settleMs: 0, after: terminated }) : null
      Promise.allSettled(error === undefined || !cleaned ? [terminated] : [terminated, cleaned]).then(() => finish(error))
    }
    const abort = () => stop(cancelledError(file))
    const armIdle = () => {
      if (!idle || settled || stopping) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        let busy = false
        try { busy = !!isBusy?.() } catch { busy = false }
        if (busy) return armIdle()
        // The runtime's recovery (runtime/watchdog.mts) knows this timeout by its code.
        const error = Object.assign(new Error(`${file} produced no output for ${idle} ms`), { code: 'ORBIT_PROVIDER_IDLE' })
        error.name = 'TimeoutError'
        stop(error)
      }, idle)
    }
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
    armIdle()
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || stopping) return
      armIdle()
      bytes += chunk.length
      if (bytes > maxOutputBytes) return stop(new Error(`${file} exceeded the ${maxOutputBytes} byte output limit`))
      // Streaming parsers own their state; retain only a diagnostic tail here.
      stdout = (stdout + chunk.toString('utf8')).slice(-DIAGNOSTIC_LIMIT)
      try { outputLines.write(chunk) } catch (error) { stop(error) }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled || stopping) return
      armIdle()
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
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A CLI that fails early closes stdin before it has read a large prompt: EPIPE on POSIX, EOF on Windows once
      // the prompt exceeds the pipe buffer (about 64 KB). Its own stderr, reported on close, is the real error, and a
      // write error must not replace it.
      if (!['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code ?? '')) stop(error)
    })
    child.stdin.end(input, 'utf8')
  })
}

// The caller's extra variables for a CLI child, string values only (the runtime's restart variables).
function extraEnvOf(options: Pick<ProviderRunOptions, 'extraEnv'>): Record<string, string> {
  const extra = options.extraEnv
  if (!extra || typeof extra !== 'object') return {}
  return Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[0] && !entry[0].includes('=')))
}
// The same variables for a process codex-server.mts spawns itself: they ride on the launch it resolves.
function launchHelpers(options: Pick<ProviderRunOptions, 'extraEnv'>, busy?: typeof busyCheck): CliHelpers {
  const extra = extraEnvOf(options)
  const resolve: typeof resolveLaunch = (command, args) => { const launch = resolveLaunch(command, args); return { ...launch, env: { ...launch.env, ...extra } } }
  return { resolveLaunch: resolve, terminateProcess, createLineReader, ...(busy ? { busyCheck: busy } : {}) }
}

function emit(onEvent: ProviderEventListener | null | undefined, event: ProviderEvent): void {
  // A renderer disconnect must not crash the transport or orphan its process.
  try { onEvent?.(event) } catch (error) { report('providers: event observer threw (UI observers do not control the provider)', error) }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value
  // A `message` that is not a string is passed through as before: Error() and the trace stringify it.
  const message = isRecord(value) ? value.message as string | undefined : undefined
  return message || (value ? JSON.stringify(value) : 'Unknown provider error')
}

// An Orbit tool reached through MCP is not a native tool: the runtime records it through dispatch, not from the stream.
function orbitToolName(name: unknown): string | undefined {
  return typeof name === 'string' && name.startsWith(ORBIT_MCP_PREFIX) ? name.slice(ORBIT_MCP_PREFIX.length) : undefined
}
function toolFlags(orbitTool: string | undefined): { native: false; mcp: true; server: 'orbit'; orbitTool: string } | { native: true } {
  return orbitTool ? { native: false, mcp: true, server: 'orbit', orbitTool } : { native: true }
}

// `resumed`: the turn resumes a thread (`exec resume`); a turn's usage is what the thread's total grew by (codex-usage.mts).
function createCodexParser(onEvent: ProviderEventListener | null | undefined, requestedModel = '', responseSchema?: unknown, { resumed = false }: { resumed?: boolean } = {}): StreamParser {
  let model = requestedModel
  let finalText = ''
  let finalPhaseText: string | undefined
  let completed = false
  let failure = ''
  let lastError = ''
  let handoffText: string | undefined
  let sessionId: string | undefined
  const messages = new Map<string, string>()
  const tools = new Map<string, string>()
  const dispatch = (event: ParserEvent) => emit(onEvent, { providerId: 'codex', ...event })
  return {
    line(line) {
      if (handoffText !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event: unknown
      try { event = JSON.parse(line) } catch { dispatch({ kind: 'observation', text: line, source: 'diagnostic' }); return }
      if (!isCodexEvent(event)) return
      model = event.model || event.thread?.model || event.metadata?.model || model
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && SESSION_ID.test(event.thread_id)) {
        sessionId = event.thread_id
        if (!resumed) startedThread(sessionId)
        dispatch({ kind: 'session', sessionId })
      }
      if (event.type === 'turn.failed') failure = errorText(event.error)
      if (event.type === 'error') { lastError = errorText(event.message || event.error); dispatch({ kind: 'observation', text: lastError, status: 'error' }) }
      if (event.type === 'turn.completed') {
        completed = true
        const usage = execTurnUsage(sessionId, event.usage, resumed)
        if (usage) dispatch({ kind: 'usage', usage })
        dispatch({ kind: 'observation', text: 'Codex turn completed', status: 'completed' })
      }
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
      } else if (isCodexToolItem(item)) {
        const id = item.id || item.type
        const signature = JSON.stringify(item)
        if (tools.get(id) === signature) return
        tools.set(id, signature)
        const text = item.command || item.query || (item.server ? `${item.server}/${item.tool}` : item.tool) || item.changes?.map((change) => `${change.kind || 'change'} ${change.path}`).join('\n') || item.type
        const orbitTool = item.type === 'mcp_tool_call' && item.server === 'orbit' && typeof item.tool === 'string' ? item.tool : undefined
        dispatch({ kind: 'tool', text, tool: item.type, toolId: id, status: item.status || event.type.split('.').at(-1), output: item.aggregated_output || '', exitCode: item.exit_code, changes: item.changes, ...toolFlags(orbitTool) })
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
      if (handoffText !== undefined) return { text: handoffText, model, ...(sessionId ? { sessionId } : {}) }
      if (failure || (!completed && lastError)) throw new Error(failure || lastError)
      if (!completed) throw new Error('Codex stream ended without a completed turn')
      const text = finalPhaseText ?? finalText
      if (!text.trim()) throw new Error('Codex completed without an assistant response')
      return { text, model, ...(sessionId ? { sessionId } : {}) }
    },
  }
}

// Anthropic counts the cache apart from `input_tokens` (the runtime adds them up: runtime/turn.mts normalizeUsage).
const TOKEN_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const
type TokenFigures = Record<(typeof TOKEN_KEYS)[number], number>
const noTokens = (): TokenFigures => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })
function tokenFigures(value: unknown): TokenFigures | null {
  if (!isRecord(value)) return null
  const figures = noTokens()
  for (const key of TOKEN_KEYS) { const number = Number(value[key]); if (Number.isFinite(number) && number > 0) figures[key] = number }
  return figures
}

function createClaudeParser(onEvent: ProviderEventListener | null | undefined, requestedModel = '', responseSchema?: unknown): StreamParser {
  let model = requestedModel
  let result: ClaudeResultEvent | undefined
  let failure = ''
  let lastAssistant = ''
  let handoffText: string | undefined
  let lastLimit: ClaudeRateLimitInfo | undefined
  let sessionId: string | undefined
  const messages = new Map<string, string>()
  const streams = new Map<string, { id: string; text: string }>()
  const toolIds = new Set<string>()
  // Tool id → name, so the result of an Orbit MCP call is labelled like the call that made it.
  const toolNames = new Map<string, string>()
  const dispatch = (event: ParserEvent) => emit(onEvent, { providerId: 'claude', ...event })
  // Tokens by API call. The CLI repeats one call's figures on several events (message_start, an `assistant` event per content
  // block, message_delta) and its `output_tokens` is final only on message_delta, so each call stays at the most the stream
  // showed of it and only a growth is reported: the count is live and counts a call once. A `result` states the agent's own
  // calls of one stretch of the process (not its native subagents' calls, which the stream shows on `assistant` events only),
  // and may come after the next stretch's calls have streamed; so the stretches are summed and compared with the own calls
  // seen so far, and only what the stream missed is added (a stream without partial messages ends exact too). Checked against
  // Claude Code 2.1.285: a turn with two calls, and one with a subagent whose two results followed all three calls.
  const calls = new Map<string, TokenFigures>()
  const own = noTokens(), stated = noTokens(), added = noTokens()
  const noteCall = (id: string, usage: unknown, ownCall: boolean) => {
    const figures = tokenFigures(usage)
    if (!figures) return
    const seen = calls.get(id) || noTokens(), grown = noTokens()
    let any = false
    for (const key of TOKEN_KEYS) {
      const more = figures[key] - seen[key]
      if (more <= 0) continue
      grown[key] = more; seen[key] = figures[key]; any = true
      if (ownCall) own[key] += more
    }
    calls.delete(id); calls.set(id, seen)
    if (calls.size > 512) calls.delete(calls.keys().next().value!)
    if (any) dispatch({ kind: 'usage', usage: grown })
  }
  // The index of the agent's own thinking block in progress. The CLI's system/thinking_tokens events estimate it; they
  // name no parent tool, so one outside such a block (a native subagent thinking) is not taken for the agent's own.
  let thinkingBlock: number | null = null
  const endThinking = () => { if (thinkingBlock !== null) { thinkingBlock = null; dispatch({ kind: 'thinking', done: true }) } }
  // A refusal that the stream itself announced as a rejected rate limit is typed, so the runtime need not guess from prose.
  const failed = (message: string): QuotaTaggedError => {
    const error: QuotaTaggedError = new Error(message)
    if (lastLimit?.status === 'rejected') error.quota = { providerId: 'claude', resetsAt: Number.isFinite(Number(lastLimit.resetsAt)) ? Number(lastLimit.resetsAt) * 1000 : null }
    return error
  }
  return {
    line(line) {
      if (handoffText !== undefined) return TOOL_HANDOFF
      if (!line.trim()) return
      let event: unknown
      try { event = JSON.parse(line) } catch { dispatch({ kind: 'observation', text: line, source: 'diagnostic' }); return }
      if (!isClaudeEvent(event)) return
      if (event.type === 'rate_limit_event') {
        // Quota figures are shared account state, not part of this agent's conversation.
        if (event.rate_limit_info) { lastLimit = event.rate_limit_info; dispatch({ kind: 'quota', quota: claudeStreamLimit(event.rate_limit_info) }) }
        return
      }
      model = event.model || event.message?.model || model
      if (typeof event.session_id === 'string' && event.session_id) sessionId = event.session_id
      const parentToolId = event.parent_tool_use_id || null
      const streamKey = parentToolId || 'main'
      if (event.type === 'error') failure = errorText(event.error || event.message)
      if (event.type === 'result') {
        if (parentToolId) return
        result = event
        if (event.is_error || (event.subtype && event.subtype !== 'success')) failure = errorText(event.errors?.join('\n') || event.result || event.subtype)
        const reported = tokenFigures(event.usage)
        if (reported) {
          const missing = noTokens()
          let any = false
          for (const key of TOKEN_KEYS) {
            stated[key] += reported[key]
            const more = stated[key] - own[key] - added[key]
            if (more > 0) { missing[key] = more; added[key] += more; any = true }
          }
          if (any) dispatch({ kind: 'usage', usage: missing })
        }
        dispatch({ kind: 'observation', text: failure || 'Claude turn completed', status: failure ? 'error' : 'completed' })
      }
      if (event.type === 'stream_event') {
        const part: ClaudeStreamPart = event.event || {}
        if (part.type === 'message_start') streams.set(streamKey, { id: part.message?.id || streamKey, text: '' })
        const current = streams.get(streamKey) || { id: streamKey, text: '' }
        if (part.type === 'message_start') noteCall(current.id, part.message?.usage, !parentToolId)
        if (part.type === 'message_delta') noteCall(current.id, part.usage, !parentToolId)
        if (part.type === 'content_block_delta' && part.delta?.type === 'text_delta') {
          current.text += part.delta.text
          streams.set(streamKey, current)
          messages.set(current.id, current.text)
          dispatch({ kind: 'output', text: part.delta.text, messageId: current.id, parentToolId, partial: true })
        }
        if (part.type === 'content_block_delta' && part.delta?.type === 'thinking_delta') dispatch({ kind: 'reasoning', text: part.delta.thinking, messageId: `${current.id}:thinking:${part.index}`, parentToolId, partial: true })
        // A message that begins anew (the CLI retried the request) leaves no thinking block open.
        if (!parentToolId && (part.type === 'message_start' || (part.type === 'content_block_stop' && part.index === thinkingBlock))) endThinking()
        if (!parentToolId && part.type === 'content_block_start' && (part.content_block?.type === 'thinking' || part.content_block?.type === 'redacted_thinking')) {
          thinkingBlock = part.index ?? 0
          dispatch({ kind: 'thinking', tokens: 0 })
        }
        if (part.type === 'content_block_start' && part.content_block?.type === 'tool_use') {
          const tool = part.content_block
          toolIds.add(tool.id); toolNames.set(tool.id, tool.name)
          dispatch({ kind: 'tool', text: tool.name, tool: tool.name, toolId: tool.id, parentToolId, status: 'started', ...toolFlags(orbitToolName(tool.name)) })
        }
      }
      const content = event.message?.content || event.content
      if (event.type === 'assistant' && Array.isArray(content)) {
        const id = event.message?.id || `${streamKey}:assistant`
        noteCall(id, event.message?.usage, !parentToolId)
        const text = content.filter(isTextBlock).map((block) => block.text).join('')
        const previous = messages.get(id) || ''
        if (text && text !== previous) dispatch({ kind: 'output', text: text.startsWith(previous) ? text.slice(previous.length) : text, messageId: id, parentToolId, partial: false, replace: !text.startsWith(previous) })
        messages.set(id, text)
        if (!parentToolId && text) lastAssistant = text
        if (!parentToolId && !failure && isOrbitToolEnvelope(text, responseSchema)) {
          handoffText = text
          return TOOL_HANDOFF
        }
        for (const tool of content.filter(isToolUseBlock)) {
          const orbitTool = orbitToolName(tool.name)
          const text = tool.input?.command || tool.input?.description || (orbitTool ? toolCallText(orbitTool, tool.input || {}) : tool.name)
          dispatch({ kind: 'tool', text, tool: tool.name, toolId: tool.id, parentToolId, input: tool.input, status: toolIds.has(tool.id) ? 'running' : 'started', ...toolFlags(orbitTool) })
          toolIds.add(tool.id); toolNames.set(tool.id, tool.name)
        }
      }
      if (event.type === 'user' && Array.isArray(content)) {
        for (const tool of content.filter(isToolResultBlock)) {
          const { output, images } = claudeToolResult(tool.content)
          const name = toolNames.get(tool.tool_use_id)
          dispatch({ kind: 'tool', text: output, output, toolId: tool.tool_use_id, parentToolId, status: tool.is_error ? 'failed' : 'completed', ...(name ? { tool: name } : {}), ...(images.length ? { images } : {}), ...toolFlags(orbitToolName(name)) })
        }
      }
      if (event.type === 'system' && event.subtype === 'compact_boundary') dispatch({ kind: 'compaction' })
      if (event.type === 'system' && event.subtype === 'permission_denied') dispatch({ kind: 'observation', text: errorText(event.message || 'Claude denied a tool permission'), status: 'denied' })
      if (event.type === 'system' && event.subtype === 'thinking_tokens' && thinkingBlock !== null) {
        const tokens = event.estimated_tokens
        if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) dispatch({ kind: 'thinking', tokens: Math.round(tokens) })
      }
    },
    finish() {
      if (handoffText !== undefined) return { text: handoffText, model, ...(sessionId ? { sessionId } : {}) }
      if (failure) throw failed(failure)
      if (!result) throw new Error('Claude stream ended without a result')
      const text = result.structured_output ? JSON.stringify(result.structured_output) : typeof result.result === 'string' && result.result.trim() ? result.result : lastAssistant
      if (!text?.trim()) throw new Error('Claude completed without an assistant response')
      return { text, model, ...(sessionId ? { sessionId } : {}) }
    },
  }
}

function selectedAccess({ mode, accessMode }: Pick<LaunchOptions, 'mode' | 'accessMode'>): AccessMode {
  const access = accessMode || (mode === 'workspace-write' ? 'workspace-write' : 'read-only')
  if (!isAccessMode(access)) throw new Error(`Unsupported access mode: ${access}`)
  return access
}

function buildCodexArgs(options: LaunchOptions & { workspace: string }): string[] {
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

function buildClaudeArgs(options: LaunchOptions): string[] {
  const access = selectedAccess(options)
  const restricted = access !== 'danger-full-access' || options.approvalPolicy === 'on-request'
  const permissionMode = restricted ? 'default' : 'bypassPermissions'
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--permission-mode', permissionMode]
  if (restricted) args.push('--tools', 'Read,Glob,Grep')
  args.push(...claudeAttachmentArgs(), ...claudeModelArgs(options))
  return args
}

// Files the user attached to a message live in <userData>/attachments, outside the workspace, and Claude's Read tool
// refuses to go there in a restricted mode. The folder is made here so that a message that brings the first attachment
// to a session already running (its turn resumes with these arguments) finds it known. The folder is the one the runtime
// host configured (attachments.mts); without a host (a bare test) nothing is added.
function claudeAttachmentArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const folder = attachmentsFolder(env)
  if (!folder) return []
  try { fs.mkdirSync(folder, { recursive: true }) } catch { return [] }
  return ['--add-dir', folder]
}

function claudeModelArgs(options: Pick<LaunchOptions, 'model' | 'reasoningEffort'>): string[] {
  const args: string[] = []
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) {
    if (!REASONING_DEFAULTS.claude.includes(options.reasoningEffort)) throw new Error('Unsupported Claude reasoning effort')
    args.push('--effort', options.reasoningEffort)
  }
  return args
}

// HTTP(S)_PROXY in the user's environment (a VPN or a corporate proxy) would route the CLI's calls to Orbit's loopback
// MCP server through the proxy, which cannot reach 127.0.0.1 of this machine; Claude Code then reports the server as
// "failed" and the model never sees the Orbit tools. Loopback is excluded explicitly, keeping what NO_PROXY already had.
function loopbackNoProxy(env: NodeJS.ProcessEnv = process.env): { NO_PROXY: string; no_proxy: string } {
  const existing = String(env.NO_PROXY || env.no_proxy || '').split(',').map(item => item.trim()).filter(Boolean)
  for (const host of ['127.0.0.1', 'localhost', '::1']) if (!existing.some(item => item.toLowerCase() === host)) existing.push(host)
  const value = existing.join(',')
  return { NO_PROXY: value, no_proxy: value }
}

// The Orbit MCP server as Claude Code's --mcp-config sees it: inline JSON, bearer token in the header; the connectors
// (external MCP servers of a run with full access) follow it, and --strict-mcp-config keeps out every other server.
type ConnectorSession = Partial<Pick<NormalizedSession, 'connectors'>>
function claudeMcpConfig(session: Pick<NormalizedSession, 'mcpUrl' | 'token'> & ConnectorSession) {
  return { mcpServers: { orbit: { type: 'http', url: session.mcpUrl, headers: { Authorization: `Bearer ${session.token}` } }, ...claudeServers(session.connectors) } }
}

// Session transport: Orbit chooses the session id, follow-ups resume it, Orbit tools come from the in-process MCP
// server, the stable Orbit block travels in a temp file, and the session file is kept (no --no-session-persistence).
function buildClaudeSessionArgs(options: LaunchOptions, session: Pick<NormalizedSession, 'id' | 'resume' | 'mcpUrl' | 'token'> & ConnectorSession, { appendFile }: { appendFile?: string } = {}): string[] {
  const access = selectedAccess(options)
  const restricted = access !== 'danger-full-access' || options.approvalPolicy === 'on-request'
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  // A Claude session always has an id (normalizeSession chooses one); the builder is also exercised directly by the tests.
  args.push(session.resume ? '--resume' : '--session-id', session.id as string)
  if (session.mcpUrl && session.token) args.push('--mcp-config', JSON.stringify(claudeMcpConfig(session)), '--strict-mcp-config', '--allowedTools', 'mcp__orbit__*')
  else args.push('--strict-mcp-config')
  if (restricted) args.push('--tools', 'Read,Glob,Grep')
  if (appendFile) args.push('--append-system-prompt-file', appendFile)
  if (options.approvalPolicy === 'on-request' && session.mcpUrl && session.token) args.push('--permission-prompt-tool', 'mcp__orbit__approve')
  args.push('--permission-mode', restricted ? 'default' : 'bypassPermissions')
  args.push(...claudeAttachmentArgs(), ...claudeModelArgs(options))
  return args
}

// Orbit's MCP server as config overrides of one Codex process (exec and App Server alike); the token stays in the
// environment. `tool_timeout_sec` checked against codex-cli 0.155 (`codex mcp get orbit --json` shows 3600.0).
// The connectors follow as `mcp_servers.<name>.*` overrides (command/args/env or url/http_headers, same check).
function codexMcpArgs(session: (Pick<NormalizedSession, 'mcpUrl' | 'token'> & ConnectorSession) | null | undefined): string[] {
  if (!session?.mcpUrl || !session.token) return []
  return ['-c', `mcp_servers.orbit.url=${JSON.stringify(session.mcpUrl)}`, '-c', 'mcp_servers.orbit.bearer_token_env_var="ORBIT_MCP_TOKEN"', '-c', `mcp_servers.orbit.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`, ...codexConnectorArgs(session.connectors, tomlString)]
}

// A lone surrogate (a string bounded inside an emoji, such as an agent's name) as U+FFFD: JSON.stringify writes it as an
// escape like \ud83d, which neither TOML nor Codex's JSON-RPC parser accepts.
function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
}

// A `-c key=value` value as a TOML basic string. JSON's escapes are TOML's, except for a lone surrogate's (above) and a
// raw DEL, which TOML wants escaped; Codex would take a value TOML refuses as raw text, escapes and all.
function tomlString(text: string): string {
  return JSON.stringify(wellFormed(text)).replace(/\x7f/g, '\\u007f')
}

// `codex exec resume` takes neither -C nor --sandbox nor --approve-for-me (checked against 0.155): the process cwd is
// the workspace and the sandbox travels as a config override; an auto-review resume keeps the thread's own policy.
// The stable Orbit block is the thread's developer instructions (Codex has no system-prompt file option). A resumed
// thread keeps the block it started with (exec and App Server, checked against 0.155); a resume passes it all the same,
// so no Codex process of a session runs without it.
function buildCodexSessionArgs(options: LaunchOptions & { workspace: string }, session: Pick<NormalizedSession, 'id' | 'resume' | 'mcpUrl' | 'token' | 'systemAppend'> & ConnectorSession): string[] {
  const access = selectedAccess(options)
  const args = session.resume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${JSON.stringify(access)}`]
    : ['exec', '--json', '--skip-git-repo-check', '-C', options.workspace, '--sandbox', access]
  args.push('-c', 'features.multi_agent=false', ...codexMcpArgs(session))
  if (session.systemAppend) args.push('-c', `developer_instructions=${tomlString(session.systemAppend)}`)
  if (options.approvalPolicy === 'auto-review' && access === 'workspace-write') { if (!session.resume) args.push('--approve-for-me') }
  else args.push('-c', 'approval_policy="never"')
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`)
  // A resume always carries the thread id (normalizeSession refuses a resume without one).
  if (session.resume) args.push(session.id as string)
  args.push('-')
  return args
}

// A session id refused below carries this code: the runtime drops it once and starts a fresh session (loops.mts).
const refusedId = (message: string): Error => Object.assign(new Error(message), { code: 'ORBIT_SESSION_ID' })
function normalizeSession(providerId: string, session: SessionOptions | null | undefined): NormalizedSession {
  if (!session || typeof session !== 'object') throw new Error('Session transport needs session options')
  const resume = session.resume === true
  const id = typeof session.id === 'string' && session.id.trim() ? session.id.trim() : null
  if (resume && !id) throw new Error('Resuming a session needs its id')
  if (providerId === 'claude' && id && !UUID.test(id)) throw refusedId('Claude session ids must be UUIDs')
  if ((isSubscriptionId(providerId) || providerId === 'codex') && resume && id && !SESSION_ID.test(id)) throw refusedId(`Unexpected ${providerId} session id`)
  const mcpUrl = typeof session.mcpUrl === 'string' && session.mcpUrl ? session.mcpUrl : null
  const token = typeof session.token === 'string' && session.token ? session.token : null
  if ((mcpUrl && !token) || (token && !mcpUrl)) throw new Error('Session transport needs both the Orbit MCP url and its token')
  return {
    id: id || (providerId === 'claude' ? randomUUID() : null), resume, mcpUrl, token,
    systemAppend: typeof session.systemAppend === 'string' ? session.systemAppend : '',
    activity: typeof session.activity === 'function' ? session.activity : null,
    connectors: Array.isArray(session.connectors) ? session.connectors.filter(item => item && typeof item.name === 'string' && (item.stdio || item.http)) : [],
  }
}
// The inactivity guard asks whether an Orbit tool call is running for this agent (the MCP server's activity(token)).
const busyCheck = (session: Pick<NormalizedSession, 'activity'>) => (): boolean => { const state = session.activity?.(); return !!state && Number(state.pending) > 0 }

// A CLI that reports its failure in-band and then exits non-zero has already told the parser what went wrong; that
// message is far more useful than the raw JSONL tail runCli would surface.
function rethrowParsed(parser: StreamParser, error: unknown): never {
  // Whatever runCli rejected with: its own Error (name and message) or the child's spawn error.
  if (!['AbortError', 'TimeoutError'].includes((error as Error).name)) {
    try { parser.finish() } catch (reported) { if (!/ended without|completed without/.test((reported as Error).message)) throw reported }
  }
  throw error
}

async function runClaudeSession(options: NativeRunOptions, session: NormalizedSession): Promise<ProviderResult> {
  const parser = createClaudeParser(options.onEvent, options.model)
  const command = options.providerOptions?.command || process.env.ORBIT_CLAUDE_COMMAND || 'claude'
  let directory: string | undefined, appendFile: string | undefined
  try {
    if (session.systemAppend) {
      // The stable Orbit block goes through a file: it is long, and a file never meets a command-line limit.
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-claude-session-'))
      appendFile = path.join(directory, 'orbit-system-append.md')
      fs.writeFileSync(appendFile, session.systemAppend, 'utf8')
    }
    const args = buildClaudeSessionArgs(options, session, { appendFile })
    const env = { ...extraEnvOf(options), CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT || String(CLAUDE_MCP_IDLE_MS), ...(session.mcpUrl ? loopbackNoProxy() : {}) }
    try {
      await runCli(command, args, {
        cwd: options.workspace, input: options.prompt, signal: options.signal, env, scope: options.processScope,
        timeoutMs: options.timeoutMs ?? null, inactivityMs: options.inactivityMs, isBusy: busyCheck(session),
        onLine: parser.line,
        onDiagnostic: (text) => emit(options.onEvent, { providerId: 'claude', kind: 'observation', text, source: 'stderr' }),
      })
    } catch (error) { rethrowParsed(parser, error) }
    const parsed = parser.finish()
    return { providerId: 'claude', client: 'Claude Code', transport: 'session', sessionId: parsed.sessionId || session.id, text: parsed.text, model: parsed.model, access: selectedAccess(options) }
  } finally {
    removeTemporaryDirectory(directory, 'orbit-claude-session-')
  }
}

async function runCodexSession(options: NativeRunOptions, session: NormalizedSession): Promise<ProviderResult> {
  if (options.approvalPolicy === 'on-request') return codexServer.runCodexSessionTurn(options, session, launchHelpers(options, busyCheck))
  const parser = createCodexParser(options.onEvent, options.model, undefined, { resumed: session.resume })
  const command = options.providerOptions?.command || process.env.ORBIT_CODEX_COMMAND || 'codex'
  try {
    await runCli(command, buildCodexSessionArgs(options, session), {
      cwd: options.workspace, input: options.prompt, signal: options.signal, env: { ...extraEnvOf(options), ...(session.token ? { ORBIT_MCP_TOKEN: session.token, ...loopbackNoProxy() } : {}) }, scope: options.processScope,
      timeoutMs: options.timeoutMs ?? null, inactivityMs: options.inactivityMs, isBusy: busyCheck(session),
      onLine: parser.line,
      onDiagnostic: (text) => emit(options.onEvent, { providerId: 'codex', kind: 'observation', text, source: 'stderr' }),
    })
  } catch (error) { rethrowParsed(parser, error) }
  const parsed = parser.finish()
  return { providerId: 'codex', client: 'Codex CLI', transport: 'session', sessionId: parsed.sessionId || (session.resume ? session.id : null), text: parsed.text, model: parsed.model, access: selectedAccess(options) }
}

function runSession(providerId: string, options: NativeRunOptions): Promise<ProviderResult> {
  const session = normalizeSession(providerId, options.session)
  return providerId === 'claude' ? runClaudeSession(options, session) : runCodexSession(options, session)
}

// Which transport a provider uses: the CLIs keep a session (resume + MCP tools), everything else gets the JSON
// envelope. Cursor and Antigravity keep one only in Full access: headless, neither can approve an MCP tool call except
// by approving everything (`--force`, `--dangerously-skip-permissions`). Cursor's session is opt-in until a live check
// passes (its account was out of quota): `transport: 'session'` in the Cursor provider options, or ORBIT_CURSOR_SESSION=1.
// ORBIT_LEGACY_ENVELOPE=1 forces the envelope everywhere; `transport: 'envelope'` does for one run or one provider.
function transportFor(providerId: string, options: Pick<ProviderRunOptions, 'transport' | 'legacyEnvelope' | 'providerOptions' | 'accessMode' | 'approvalPolicy'> = {}): Transport {
  if (process.env.ORBIT_LEGACY_ENVELOPE === '1' || options.transport === 'envelope' || options.legacyEnvelope === true || options.providerOptions?.transport === 'envelope') return 'envelope'
  if (SESSION_PROVIDERS.has(providerId)) return 'session'
  if (!isSubscriptionId(providerId) || options.accessMode !== 'danger-full-access' || options.approvalPolicy === 'on-request') return 'envelope'
  // decideTransport spreads the provider's options into `options`; runProvider passes them as `providerOptions`.
  const optedIn = options.transport === 'session' || options.providerOptions?.transport === 'session' || process.env.ORBIT_CURSOR_SESSION === '1'
  return providerId === 'cursor' && !optedIn ? 'envelope' : 'session'
}
// How long one Orbit tool call of this provider's session may take before Orbit answers "still running" (0: no limit).
// ORBIT_MCP_CALL_LIMIT_MS may lower it, never raise it past the client's own limit.
function mcpCallLimit(providerId: string): number {
  const limit = MCP_CALL_LIMITS[providerId] || 0
  const lower = Number(process.env.ORBIT_MCP_CALL_LIMIT_MS)
  return limit && Number.isFinite(lower) && lower >= 10 && lower < limit ? lower : limit
}

// Ends whatever a session keeps alive between turns: a Codex App Server process, an Antigravity conversation's
// folder; false when nothing was alive.
async function closeSession(sessionId: string): Promise<boolean> {
  const codex = await codexServer.closeSession(sessionId)
  return subscriptions.closeSession(sessionId) || codex
}

async function runNative(providerId: 'codex' | 'claude', options: NativeRunOptions): Promise<ProviderResult> {
  if (options.session && transportFor(providerId, options) === 'session') return runSession(providerId, options)
  if (providerId === 'codex' && options.approvalPolicy === 'on-request') return codexServer.runCodexServer(options, launchHelpers(options))
  const parser = providerId === 'codex' ? createCodexParser(options.onEvent, options.model, options.responseSchema) : createClaudeParser(options.onEvent, options.model, options.responseSchema)
  const command = options.providerOptions?.command || process.env[providerId === 'codex' ? 'ORBIT_CODEX_COMMAND' : 'ORBIT_CLAUDE_COMMAND'] || providerId
  let schemaDirectory: string | undefined
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
        cwd: options.workspace, input: options.prompt, signal: options.signal, timeoutMs: options.timeoutMs, env: extraEnvOf(options), scope: options.processScope,
        onLine: parser.line,
        onDiagnostic: (text) => emit(options.onEvent, { providerId, kind: 'observation', text, source: 'stderr' }),
      })
    } catch (error) { rethrowParsed(parser, error) }
    const { text, model } = parser.finish()
    return { providerId, client: providerId === 'codex' ? 'Codex CLI' : 'Claude Code', text, model, access: selectedAccess(options) }
  } finally {
    removeTemporaryDirectory(schemaDirectory, 'orbit-response-schema-')
  }
}

function requestSignal(parent: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(cancelledError('Provider'))
  const timer = timeoutMs ? setTimeout(() => {
    const error = new Error(`Provider timed out after ${timeoutMs} ms`)
    error.name = 'TimeoutError'
    controller.abort(error)
  }, timeoutMs) : null
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  return { signal: controller.signal, dispose: () => { clearTimeout(timer ?? undefined); parent?.removeEventListener('abort', abort) } }
}

// URL has already canonicalized the host: lower case, IPv4 as four decimals (127.1 and 2130706433 become 127.0.0.1),
// IPv6 compressed in brackets.
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

// Plain HTTP carries the prompt (and ORBIT_OPENAI_API_KEY) over the network unencrypted, so it is accepted only for this
// machine; a trusted network (say, Ollama on another computer at home) opts in with ORBIT_ALLOW_INSECURE_HTTP=1.
function endpointUrl(raw: string, variable: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${variable}: это не адрес URL. Укажите его полностью, начиная с https://.`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${variable}: адрес должен начинаться с https:// (http:// — только для этого компьютера).`)
  if (url.username || url.password) throw new Error(`${variable}: уберите из адреса имя пользователя и пароль.`)
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && process.env.ORBIT_ALLOW_INSECURE_HTTP !== '1') {
    throw new Error(`${variable} (${url.origin}): по http:// запросы идут по сети незашифрованными, поэтому такой адрес разрешён только для этого компьютера (localhost, 127.0.0.1, [::1]). Укажите https:// или, если сеть доверенная, задайте ORBIT_ALLOW_INSECURE_HTTP=1.`)
  }
  return url
}

function ollamaUrl(endpoint: string): string {
  const url = endpointUrl(process.env.ORBIT_OLLAMA_URL || 'http://127.0.0.1:11434', 'ORBIT_OLLAMA_URL')
  url.pathname = `${url.pathname.replace(/\/api\/(generate|chat|tags|show)\/?$/, '').replace(/\/$/, '')}/api/${endpoint}`
  return url.toString()
}

async function consumeBody(response: Response, onLine: (line: string) => void): Promise<void> {
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

// The body as the caller expects it; the shape is trusted after this boundary and checked field by field.
async function readJson<T = unknown>(response: Response): Promise<T> {
  let text = ''
  await consumeBody(response, (line) => { text += `${line}\n` })
  try { return JSON.parse(text) as T } catch { throw new Error('Provider returned invalid JSON') }
}

async function checkResponse(response: Response, label: string): Promise<void> {
  if (response.ok) return
  let detail = ''
  try { const body = await readJson<{ error?: unknown; message?: unknown }>(response); detail = errorText(body.error || body.message || '') } catch (error) { report(`providers: ${label} error body is not JSON (the status still explains the failure)`, error) }
  throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
}

async function listOllamaModels(signal: AbortSignal): Promise<string[]> {
  const response = await fetch(ollamaUrl('tags'), { signal })
  await checkResponse(response, 'Ollama')
  const body = await readJson<OllamaTags>(response)
  return (body.models || []).map((model) => model.name || model.model).filter((name): name is string => Boolean(name))
}

async function selectOllamaModel(signal: AbortSignal): Promise<string | undefined> {
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
      const capabilities = (await readJson<OllamaShow>(response)).capabilities || []
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
function ollamaContext(prompt: string): number {
  const needed = Math.ceil(String(prompt).length / 2.5) + 1024
  return [4096, 8192, 16384, 32768].find((size) => size >= needed) || 32768
}

async function runOllama(options: ProviderRunOptions): Promise<ProviderResult> {
  const request = requestSignal(options.signal, timeoutValue(options.timeoutMs))
  try {
    const model = options.model || process.env.ORBIT_OLLAMA_MODEL || await selectOllamaModel(request.signal)
    if (!model) throw new Error('Ollama has no installed models. Install a model or select an existing one.')
    let think: boolean | string | undefined
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
      const event = JSON.parse(line) as OllamaGenerateEvent
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

async function runCompatible(options: ProviderRunOptions): Promise<ProviderResult> {
  const base = process.env.ORBIT_OPENAI_BASE_URL
  if (!base) throw new Error('ORBIT_OPENAI_BASE_URL is not configured')
  const url = endpointUrl(base, 'ORBIT_OPENAI_BASE_URL')
  const model = options.model || process.env.ORBIT_OPENAI_MODEL
  if (!model) throw new Error('Select an endpoint model or set ORBIT_OPENAI_MODEL')
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
    let usage: unknown
    const accept = (event: ChatCompletion, streaming: boolean) => {
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
      let data: string[] = []
      const flush = () => {
        if (!data.length) return
        const payload = data.join('\n'); data = []
        if (payload === '[DONE]') return
        accept(JSON.parse(payload) as ChatCompletion, true)
      }
      await consumeBody(response, (line) => {
        if (!line) flush()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      })
      flush()
    } else accept(await readJson<ChatCompletion>(response), false)
    if (!completed) throw new Error('Endpoint stream ended before completion')
    if (!text.trim()) throw new Error('Endpoint completed without an assistant response')
    emit(options.onEvent, { providerId: 'custom', kind: 'observation', text: 'Endpoint turn completed', status: 'completed', usage })
    return { providerId: 'custom', client: 'OpenAI-compatible endpoint', text, model: actualModel, access: 'harness-tools' }
  } catch (error) { if (request.signal.aborted) throw request.signal.reason; throw error }
  finally { request.dispose() }
}

async function commandProbe(command: string, args: string[]): Promise<({ ok: true } & CliResult) | { ok: false; detail: string }> {
  try {
    const result = await runCli(command, args, { timeoutMs: 7000 })
    return { ok: true, ...result }
  } catch (error) { return { ok: false, detail: (error as Error).message } }
}

async function inspectNative(id: 'codex' | 'claude', options: ProviderOptions = {}): Promise<ProviderHealth> {
  // Stable CLI aliases follow the subscriber's current model catalog.
  let models = id === 'claude' ? ['sonnet', 'opus', 'haiku'] : []
  let reasoningLevels: Record<string, string[]> = {}
  if (id === 'codex') {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8')) as CodexModelsCache
      models = (cache.models || []).filter((model): model is CodexCachedModel & { slug: string } => model.visibility === 'list' && typeof model.slug === 'string').map(model => model.slug)
      reasoningLevels = Object.fromEntries((cache.models || []).filter((model): model is CodexCachedModel & { slug: string } => model.slug !== undefined && models.includes(model.slug)).map((model): [string, string[]] => [model.slug, (model.supported_reasoning_levels || []).map(level => level.effort)]))
    } catch (error) { report('providers: codex models_cache.json unreadable (model discovery is optional; manual selection remains)', error) }
  }
  const command = options.command || process.env[id === 'codex' ? 'ORBIT_CODEX_COMMAND' : 'ORBIT_CLAUDE_COMMAND'] || id
  const version = await commandProbe(command, ['--version'])
  if (!version.ok) return { id, available: false, installed: false, authenticated: false, models, detail: id === 'claude' ? 'Claude Code CLI не найден. Установка: https://code.claude.com/docs/en/setup. Вход по подписке: claude auth login' : 'Codex CLI not detected', supported: true }
  const auth = await commandProbe(command, id === 'codex' ? ['login', 'status'] : ['auth', 'status'])
  let authenticated: boolean | null = auth.ok
  if (id === 'claude' && auth.ok) {
    try { const status = JSON.parse(auth.stdout); authenticated = status.loggedIn ?? status.logged_in ?? null } catch { authenticated = null }
  }
  const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0].slice(0, 100)
  // Auth probes may return account identifiers. Only expose readiness, never raw output.
  return { id, models, reasoningLevels, supported: true, installed: true, available: authenticated !== false, authenticated, detail: `${versionText} · ${authenticated === true ? 'Вход выполнен' : authenticated === false ? `Войдите: ${id === 'claude' ? 'claude auth login' : 'codex login'}` : 'Авторизация не проверена'}`, executable: resolveCommand(command) }
}

async function ollamaReasoningLevels(model: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(ollamaUrl('show'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal })
  await checkResponse(response, 'Ollama')
  const metadata = await readJson<OllamaShow>(response)
  const values = metadata.thinking?.values
  if (Array.isArray(values)) return values.some(value => value !== false) ? values.map(value => value === true ? 'enabled' : value === false ? 'none' : value).filter((value): value is string => typeof value === 'string') : []
  if (!metadata.capabilities?.includes('thinking')) return []
  return /(?:^|\/)gpt-oss(?::|$)/.test(model) ? ['low', 'medium', 'high'] : ['none', 'enabled']
}

async function inspectOllama(): Promise<ProviderHealth> {
  // A refused address says why, instead of «not reachable».
  try { ollamaUrl('tags') } catch (error) { return { id: 'ollama', supported: true, available: false, detail: (error as Error).message } }
  const request = requestSignal(null, 2500)
  try {
    const models = await listOllamaModels(request.signal)
    const reasoningLevels = Object.fromEntries(await Promise.all(models.slice(0, 32).map(async (model): Promise<[string, string[]]> => [model, await ollamaReasoningLevels(model, request.signal).catch(() => [])])))
    return { id: 'ollama', supported: true, available: models.length > 0, models, reasoningLevels, detail: models.length ? `${models.length} local model(s) ready` : 'Ollama is running; no models installed' }
  } catch { return { id: 'ollama', supported: true, available: false, detail: 'Ollama server is not reachable' } }
  finally { request.dispose() }
}

async function inspectProviders(options: InspectOptions = {}): Promise<ProviderHealth[]> {
  pathLookups.clear()
  const native = await Promise.all([inspectNative('codex', options.codex), inspectNative('claude', options.claude), inspectOllama(), ...(['antigravity', 'cursor'] as const).map(id => subscriptions.inspect(id, { runCli }, options[id]))])
  return [...native, inspectCustom()]
}

function inspectCustom(): ProviderHealth {
  let configured = false
  let detail = 'Set ORBIT_OPENAI_BASE_URL'
  try { if (process.env.ORBIT_OPENAI_BASE_URL) { endpointUrl(process.env.ORBIT_OPENAI_BASE_URL, 'ORBIT_OPENAI_BASE_URL'); configured = true; detail = 'Endpoint configured; connection checked when used' } } catch (error) { detail = (error as Error).message; report('providers: ORBIT_OPENAI_BASE_URL is refused (the provider list shows why)', error) }
  return { id: 'custom', supported: true, available: configured, authenticated: null, detail, model: process.env.ORBIT_OPENAI_MODEL || '' }
}

async function runProvider(options: ProviderRunOptions): Promise<ProviderResult> {
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw new Error('A non-empty provider prompt is required')
  if (options.signal?.aborted) throw cancelledError('Provider')
  const { providerId } = options
  if (isSubscriptionId(providerId)) {
    if (options.session && transportFor(providerId, options) === 'session') return subscriptions.runSession(providerId, { ...options, workspace: options.workspace || process.cwd() }, normalizeSession(providerId, options.session), { runCli, busyCheck, loopbackNoProxy })
    return subscriptions.run(providerId, options, { runCli })
  }
  if (providerId === 'codex' || providerId === 'claude') return runNative(providerId, { ...options, workspace: options.workspace || process.cwd() })
  if (providerId === 'ollama') return runOllama(options)
  if (providerId === 'custom') return runCompatible(options)
  throw new Error(`Provider ${providerId} is not supported. Choose Codex, Claude Code, Ollama, or an OpenAI-compatible endpoint.`)
}

export type {
  AccessMode, Transport, ProviderEvent, ProviderEventKind, OutputEvent, ReasoningEvent, ToolEvent, ObservationEvent, QuotaEvent, ParserEvent, ProviderEventListener,
  ApprovalRequest, ApprovalHandler, ProviderOptions, SessionActivity, SessionActivityCheck, SessionOptions, NormalizedSession, LaunchOptions, ProviderRunOptions, NativeRunOptions,
  ProviderResult, ProviderHealth, InspectOptions, CliLaunch, CliResult, LineReader, RunCliOptions, RunCli, CliHelpers, SessionHelpers, ParsedTurn, StreamParser,
}
export const _testing = { createCodexParser, createClaudeParser, createLineReader, buildCodexArgs, buildClaudeArgs, buildClaudeSessionArgs, buildCodexSessionArgs, claudeAttachmentArgs, claudeMcpConfig, normalizeSession, inactivityValue, runCli, resolveLaunch, requestSignal, endpointUrl, inspectOllama, inspectCustom }
export { loopbackNoProxy, codexMcpArgs, wellFormed, inspectProviders, runProvider, transportFor, mcpCallLimit, closeSession, resolveLaunch, terminateProcess, runCli, createLineReader }
