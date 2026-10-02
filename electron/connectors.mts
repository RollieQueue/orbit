// Connectors: external MCP servers (browser automation, databases, GitHub, …) that the user or an agent registers once and
// that Orbit passes, next to its own server, to every provider process of a run with full access. They live in Orbit's
// user-data folder (never in a project), at two scopes: global (every project) and project (keyed by the workspace).
// Environment values and header values are secrets: stored, handed to the server at launch, and never shown in a tool
// result, a prompt or a trace (names only, masked values).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { readJSON, writeJSON, workspaceKey, redact } from './storage.mts'

export type ConnectorScope = 'global' | 'project'
export interface ConnectorStdio { command: string; args: string[]; env: Record<string, string> }
export interface ConnectorHttp { url: string; headers: Record<string, string> }
// A stored connector: exactly one of `stdio` and `http`.
export interface Connector { name: string; description: string; stdio?: ConnectorStdio; http?: ConnectorHttp; enabled: boolean; addedAt: string }
// What a provider process is launched with: the connector and the scope it came from.
export interface ConnectorLaunch extends Connector { scope: ConnectorScope }
// What an agent sees of one: no value of env or headers, a url without its query values.
export interface ConnectorView {
  name: string; description: string; scope: ConnectorScope; enabled: boolean; addedAt: string; transport: 'stdio' | 'http'
  command?: string; args?: string[]; envKeys?: string[]; url?: string; headerNames?: string[]; shadowedBy?: ConnectorScope
}
export interface ConnectorInput {
  name?: unknown; description?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; enabled?: unknown
}
export interface ConnectorTestResult { ok: boolean; name: string; transport: 'stdio' | 'http'; tools?: { name: string; description?: string }[]; server?: string; error?: string; elapsedMs: number }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const MAX_PER_SCOPE = 20, MAX_ARGS = 64, MAX_PAIRS = 32, MAX_VALUE = 4096, DESCRIPTION_CHARS = 200
const TEST_TIMEOUT_MS = 20000
const PROTOCOL_VERSION = '2025-06-18'

// ---- Validation ----------------------------------------------------------------------------------------------------
const text = (value: unknown): string => typeof value === 'string' ? value : ''
function stringList(value: unknown, label: string, max: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of strings`)
  if (value.length > max) throw new Error(`${label} may have at most ${max} entries`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] must be a string`)
    if (item.includes('\0') || item.length > MAX_VALUE) throw new Error(`${label}[${index}] is too long or holds a NUL character`)
    return item
  })
}
// A map given as an array of "KEY=value" / "Name: value" strings (what the strict tool schema allows) or as a plain object.
function pairs(value: unknown, label: string, split: RegExp, key: RegExp, shape: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => {
      const match = typeof item === 'string' ? split.exec(item) : null
      if (!match) throw new Error(`${label}[${index}] must be a string like ${shape}`)
      return [match[1].trim(), match[2]]
    })
    : value && typeof value === 'object' ? Object.entries(value) : (() => { throw new Error(`${label} must be an array of ${shape} strings`) })()
  if (entries.length > MAX_PAIRS) throw new Error(`${label} may have at most ${MAX_PAIRS} entries`)
  const result: Record<string, string> = {}
  for (const [name, item] of entries) {
    if (!key.test(name)) throw new Error(`${label}: "${name.slice(0, 40)}" is not a valid name`)
    if (typeof item !== 'string' || item.includes('\0') || item.length > MAX_VALUE) throw new Error(`${label}: the value of ${name} must be a string of at most ${MAX_VALUE} characters`)
    result[name] = item
  }
  return result
}
const envPairs = (value: unknown): Record<string, string> => pairs(value, 'env', /^([^=]+)=([\s\S]*)$/, ENV_KEY, '"KEY=value"')
const headerPairs = (value: unknown): Record<string, string> => pairs(value, 'headers', /^([^:]+):\s*([\s\S]*)$/, HEADER_NAME, '"Name: value"')

// Checks one connector as given by a user or an agent and returns the stored form; the error names what is wrong.
function normalizeConnector(input: ConnectorInput | null | undefined, now: string): Connector {
  if (!input || typeof input !== 'object') throw new Error('A connector needs a name, a description and either a command or a url')
  const name = text(input.name).trim()
  if (!NAME.test(name)) throw new Error('Connector name must be 1-40 characters: a lowercase letter first, then lowercase letters, digits or "-" (for example "github")')
  if (name === 'orbit') throw new Error('The name "orbit" is reserved for Orbit\'s own server')
  const description = redact(text(input.description)).replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS)
  if (!description) throw new Error('A connector needs a short description of what its tools are for (the agents read it)')
  const command = text(input.command).trim(), url = text(input.url).trim()
  if (command && url) throw new Error('Give either command (a local stdio server) or url (a remote HTTP server), not both')
  if (!command && !url) throw new Error('A connector needs either command (a local stdio server) or url (a remote HTTP server)')
  const enabled = input.enabled === false ? false : true
  if (command) {
    if (command.includes('\0') || command.length > 1000) throw new Error('command must be an executable name or path of at most 1000 characters')
    if (input.headers !== undefined && input.headers !== null && (!Array.isArray(input.headers) || input.headers.length)) throw new Error('headers belong to an HTTP connector (url), not to a command')
    return { name, description, stdio: { command, args: stringList(input.args, 'args', MAX_ARGS), env: envPairs(input.env) }, enabled, addedAt: now }
  }
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`url is not a valid URL: "${url.slice(0, 80)}"`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url must start with http:// or https://')
  if ((Array.isArray(input.args) && input.args.length) || (Array.isArray(input.env) ? input.env.length : input.env && typeof input.env === 'object' && Object.keys(input.env).length)) throw new Error('args and env belong to a command connector, not to a url')
  return { name, description, http: { url: parsed.toString(), headers: headerPairs(input.headers) }, enabled, addedAt: now }
}

// ---- Masking -------------------------------------------------------------------------------------------------------
const MASK = '***'
// A url with the values of its query, and any user:password, hidden: tokens travel there.
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = MASK
    if (parsed.password) parsed.password = MASK
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, MASK)
    return decodeURIComponent(parsed.toString())
  } catch { return redact(url).slice(0, 200) }
}
function view(connector: Connector, scope: ConnectorScope): ConnectorView {
  const base = { name: connector.name, description: connector.description, scope, enabled: connector.enabled, addedAt: connector.addedAt }
  if (connector.stdio) return { ...base, transport: 'stdio', command: connector.stdio.command, args: connector.stdio.args.map(arg => redact(arg).slice(0, 200)), envKeys: Object.keys(connector.stdio.env) }
  const http = connector.http!
  return { ...base, transport: 'http', url: maskUrl(http.url), headerNames: Object.keys(http.headers) }
}
// Every secret a connector holds, longest first, so that masking one never leaves a longer one's tail behind.
function secretsOf(connector: Pick<Connector, 'stdio' | 'http'>): string[] {
  const values = [...Object.values(connector.stdio?.env || {}), ...Object.values(connector.http?.headers || {})]
  if (connector.http) { try { const parsed = new URL(connector.http.url); values.push(...parsed.searchParams.values(), parsed.password) } catch { /* the url was validated when it was stored */ } }
  for (const value of Object.values(connector.http?.headers || {})) { const bearer = /^\S+\s+(\S+)$/.exec(value); if (bearer) values.push(bearer[1]) }
  return [...new Set(values.filter(value => value.length >= 3))].sort((a, b) => b.length - a.length)
}
const maskSecrets = (value: string, secrets: string[]): string => secrets.reduce((result, secret) => result.split(secret).join(MASK), value)

// The arguments of a connector tool call as a trace, a transcript or a work log may keep them: env and header values hidden.
function maskToolArguments(tool: string | undefined, args: unknown): unknown {
  if (tool !== 'connector_add' || !args || typeof args !== 'object' || Array.isArray(args)) return args
  const input = args as Record<string, unknown>
  const hide = (value: unknown, separator: string): unknown => {
    if (Array.isArray(value)) return value.map(item => { const at = typeof item === 'string' ? item.indexOf(separator) : -1; return at < 0 ? MASK : `${(item as string).slice(0, at)}${separator}${MASK}` })
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, MASK]))
    return value
  }
  return { ...input, ...(input.env !== undefined ? { env: hide(input.env, '=') } : {}), ...(input.headers !== undefined ? { headers: hide(input.headers, ':') } : {}), ...(typeof input.url === 'string' ? { url: maskUrl(input.url) } : {}) }
}
// The one-line form of a call that the providers' trace events carry ("name {args…}"), secrets masked.
const toolCallText = (tool: string, args: unknown, limit = 200): string => `${tool} ${JSON.stringify(maskToolArguments(tool, args) ?? {}).slice(0, limit)}`

// ---- The store -----------------------------------------------------------------------------------------------------
interface StoreFile { version: 1; global: Connector[]; projects: Record<string, Connector[]> }

class ConnectorStore {
  declare file: string
  declare clock: () => number
  declare data: StoreFile | null
  constructor(userDataPath: string, { clock = Date.now }: { clock?: () => number } = {}) {
    this.file = path.join(userDataPath, 'connectors.json')
    this.clock = clock
    this.data = null
  }
  private load(): StoreFile {
    if (this.data) return this.data
    const raw = readJSON(this.file, null) as Partial<StoreFile> | null
    // What the file holds is whatever an earlier version wrote: each entry goes through the same checks as a new one.
    const clean = (list: unknown): Connector[] => (Array.isArray(list) ? list : []).flatMap((item: Partial<Connector>): Connector[] => {
      try { return [normalizeConnector({ name: item.name, description: item.description, command: item.stdio?.command, args: item.stdio?.args, env: item.stdio?.env, url: item.http?.url, headers: item.http?.headers, enabled: item.enabled }, String(item.addedAt || new Date(this.clock()).toISOString()))] } catch { return [] }
    })
    const projects: Record<string, Connector[]> = {}
    for (const [key, list] of Object.entries(raw?.projects && typeof raw.projects === 'object' ? raw.projects : {})) { const kept = clean(list); if (kept.length) projects[key] = kept }
    this.data = { version: 1, global: clean(raw?.global), projects }
    return this.data
  }
  private save(): void { writeJSON(this.file, this.data) }
  private bucket(scope: ConnectorScope, workspace: string, create = false): Connector[] {
    const data = this.load()
    if (scope === 'global') return data.global
    const key = workspaceKey(workspace)
    if (!key) throw new Error('A project connector needs a project (this run has no workspace)')
    return create ? (data.projects[key] ||= []) : data.projects[key] || []
  }
  // Adds a connector, or replaces the one of that name in the scope.
  add(input: ConnectorInput, { scope = 'project', workspace = '' }: { scope?: ConnectorScope; workspace?: string } = {}): { connector: ConnectorView; replaced: boolean } {
    if (scope !== 'global' && scope !== 'project') throw new Error('scope must be "project" or "global"')
    const connector = normalizeConnector(input, new Date(this.clock()).toISOString())
    // A script that cannot be launched safely on this machine is refused now, not found out at the first launch.
    if (connector.stdio) launchOf(connector.stdio)
    const list = this.bucket(scope, workspace, true)
    const index = list.findIndex(item => item.name === connector.name)
    if (index < 0 && list.length >= MAX_PER_SCOPE) throw new Error(`At most ${MAX_PER_SCOPE} connectors per scope: remove one first (connector_remove)`)
    if (index >= 0) list[index] = { ...connector, addedAt: list[index].addedAt }
    else list.push(connector)
    this.save()
    return { connector: view(list[index >= 0 ? index : list.length - 1], scope), replaced: index >= 0 }
  }
  // Without a scope: the project's connector of that name, else the global one.
  remove(name: string, { scope, workspace = '' }: { scope?: ConnectorScope; workspace?: string } = {}): ConnectorView | null {
    if (scope !== undefined && scope !== 'global' && scope !== 'project') throw new Error('scope must be "project" or "global"')
    const scopes: ConnectorScope[] = scope ? [scope] : ['project', 'global']
    for (const candidate of scopes) {
      let list: Connector[]
      try { list = this.bucket(candidate, workspace) } catch (error) { if (scope) throw error; continue }
      const index = list.findIndex(item => item.name === name)
      if (index < 0) continue
      const [gone] = list.splice(index, 1)
      if (candidate === 'project' && !list.length) delete this.load().projects[workspaceKey(workspace)]
      this.save()
      return view(gone, candidate)
    }
    return null
  }
  setEnabled(name: string, enabled: boolean, { scope = 'project', workspace = '' }: { scope?: ConnectorScope; workspace?: string } = {}): ConnectorView | null {
    const found = this.bucket(scope, workspace).find(item => item.name === name)
    if (!found) return null
    found.enabled = enabled
    this.save()
    return view(found, scope)
  }
  // Every connector this project sees (the project's first); a project connector hides a global one of the same name.
  list(workspace: string): ConnectorView[] {
    const own = workspaceKey(workspace) ? this.bucket('project', workspace) : []
    const names = new Set(own.map(item => item.name))
    return [...own.map(item => view(item, 'project')), ...this.load().global.map(item => names.has(item.name) ? { ...view(item, 'global'), shadowedBy: 'project' as const } : view(item, 'global'))]
  }
  // What a provider process of this project is launched with: the enabled connectors, secrets included.
  resolve(workspace: string): ConnectorLaunch[] {
    const own = workspaceKey(workspace) ? this.bucket('project', workspace) : []
    const names = new Set(own.map(item => item.name))
    return [...own.map(item => ({ ...item, scope: 'project' as const })), ...this.load().global.filter(item => !names.has(item.name)).map(item => ({ ...item, scope: 'global' as const }))].filter(item => item.enabled)
  }
  // The stored connector itself (secrets included), for connector_test.
  find(name: string, workspace: string, scope?: ConnectorScope): ConnectorLaunch | null {
    return this.resolveAll(workspace).find(item => item.name === name && (!scope || item.scope === scope)) ?? null
  }
  private resolveAll(workspace: string): ConnectorLaunch[] {
    const own = workspaceKey(workspace) ? this.bucket('project', workspace) : []
    return [...own.map(item => ({ ...item, scope: 'project' as const })), ...this.load().global.map(item => ({ ...item, scope: 'global' as const }))]
  }
  flush(): void { /* every change is written at once */ }
}

// ---- What each provider is launched with ---------------------------------------------------------------------------
// On Windows a server started as `npx`/`npm`/… is a .cmd shim, which neither Node nor the CLIs can spawn without a shell,
// and the CLIs quote arguments the MSVCRT way, which cmd.exe does not honour (an argument holding `"&` would run a
// command). So a standard npm shim is read, its JS entry found, and the server is launched as `node <entry> ...args` with
// no shell, the way providers.resolveLaunch launches Orbit's own npm CLIs: arguments arrive unchanged. Any other .cmd/.bat
// goes through `cmd /d /c` only when neither its name nor an argument holds a cmd.exe metacharacter, else it is refused.
// The lookup runs where the process is launched, so it follows the machine's PATH of that moment.
type LaunchEnv = { platform?: string; pathEnv?: string }
const CMD_META = /[&|<>^%"\r\n]/
const SHIM_ENTRY = /"%(?:dp0|~dp0)%?([\\/][^"\r\n]+\.(?:c?js|mjs))"/i
const SHIM_LIMIT = 256 * 1024
const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile() } catch { return false } }
function findOnPath(command: string, extensions: string[], pathEnv: string): string | null {
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) { const candidate = path.join(directory, command + extension); if (isFile(candidate)) return candidate }
  }
  return null
}
function launchOf(stdio: ConnectorStdio, { platform = process.platform, pathEnv = process.env.PATH || process.env.Path || '' }: LaunchEnv = {}): { command: string; args: string[] } {
  const { command, args } = stdio
  if (platform !== 'win32') return { command, args }
  // What the command names: a .cmd/.bat given by path or name, or a bare name found on PATH (an .exe wins over a shim).
  let script: string | null = null
  if (/\.(?:cmd|bat)$/i.test(command)) script = path.isAbsolute(command) ? command : /[\\/]/.test(command) ? path.resolve(command) : findOnPath(command, [''], pathEnv) || command
  else if (!/[\\/]/.test(command) && !/\.[A-Za-z0-9]+$/.test(command)) {
    const found = findOnPath(command, ['.exe', '.cmd', '.bat'], pathEnv)
    if (found && !/\.exe$/i.test(found)) script = found
  }
  if (!script) return { command, args }
  let entry: string | null = null
  try {
    if (fs.statSync(script).size <= SHIM_LIMIT) {
      const match = fs.readFileSync(script, 'utf8').match(SHIM_ENTRY)
      const candidate = match && path.resolve(path.dirname(script), match[1].replace(/^[\\/]+/, ''))
      if (candidate && isFile(candidate)) entry = candidate
    }
  } catch { /* unreadable: handled like a script that is not a shim */ }
  if (entry) {
    const node = [path.join(path.dirname(script), 'node.exe')].find(isFile) ?? findOnPath('node', ['.exe'], pathEnv)
    if (!node) throw new Error(`"${command}" is an npm shim that needs Node.js, and node.exe was not found next to it or on PATH`)
    return { command: node, args: [entry, ...args] }
  }
  const unsafe = [command, ...args].find(item => CMD_META.test(item))
  if (unsafe !== undefined) throw new Error(`"${command}" is a Windows script (.cmd/.bat) that is not a standard npm shim, so it would run through cmd.exe, which cannot pass an argument with & | < > ^ % " or a line break unchanged (${JSON.stringify(unsafe.slice(0, 40))}): use the server's .exe, or node with its script, or the url transport`)
  return { command: 'cmd', args: ['/d', '/c', command, ...args] }
}
// What a provider is launched with, or null for a stdio connector that cannot be launched here (a refusal of launchOf):
// the process starts without it rather than failing the whole turn; connector_add and connector_test name the reason.
function stdioLaunch(stdio: ConnectorStdio, env: LaunchEnv): { command: string; args: string[] } | null {
  try { return launchOf(stdio, env) } catch { return null }
}
const withEnv = (stdio: ConnectorStdio) => Object.keys(stdio.env).length ? { env: stdio.env } : {}
const withHeaders = (http: ConnectorHttp) => Object.keys(http.headers).length ? { headers: http.headers } : {}
type Servable = Pick<Connector, 'name' | 'stdio' | 'http'>
// One entry per connector in the shape of one provider's config; a stdio one that cannot be launched here is left out.
function serversOf(connectors: Servable[] | undefined, env: LaunchEnv, local: (launch: { command: string; args: string[] }, stdio: ConnectorStdio) => unknown, remote: (http: ConnectorHttp) => unknown): Record<string, unknown> {
  const entries: [string, unknown][] = []
  for (const connector of connectors || []) {
    if (connector.stdio) { const launch = stdioLaunch(connector.stdio, env); if (launch) entries.push([connector.name, local(launch, connector.stdio)]) }
    else entries.push([connector.name, remote(connector.http!)])
  }
  return Object.fromEntries(entries)
}
// Claude Code: the entries of --mcp-config next to Orbit's own.
const claudeServers = (connectors: Servable[] | undefined, env: LaunchEnv = {}): Record<string, unknown> => serversOf(connectors, env,
  (launch, stdio) => ({ type: 'stdio', ...launch, ...withEnv(stdio) }), http => ({ type: 'http', url: http.url, ...withHeaders(http) }))
// Cursor's plugin mcp.json entries.
const cursorServers = (connectors: Servable[] | undefined, env: LaunchEnv = {}): Record<string, unknown> => serversOf(connectors, env,
  (launch, stdio) => ({ ...launch, ...withEnv(stdio) }), http => ({ url: http.url, ...withHeaders(http) }))
// Antigravity's plugin mcp_config.json entries (a remote server's address is `serverUrl` there).
const antigravityServers = (connectors: Servable[] | undefined, env: LaunchEnv = {}): Record<string, unknown> => serversOf(connectors, env,
  (launch, stdio) => ({ ...launch, ...withEnv(stdio) }), http => ({ serverUrl: http.url, ...withHeaders(http) }))
// Codex: `-c mcp_servers.<name>.…` overrides (command + args + env, or url + http_headers; keys checked against
// codex-cli 0.155 with `codex mcp get <name> --json`). `quote` writes a TOML basic string (providers.tomlString).
function codexConnectorArgs(connectors: Servable[] | undefined, quote: (value: string) => string, env: LaunchEnv = {}): string[] {
  const table = (map: Record<string, string>): string => `{ ${Object.entries(map).map(([key, value]) => `${quote(key)} = ${quote(value)}`).join(', ')} }`
  const args: string[] = []
  for (const connector of connectors || []) {
    const prefix = `mcp_servers.${connector.name}`
    if (connector.stdio) {
      const launch = stdioLaunch(connector.stdio, env)
      if (!launch) continue
      args.push('-c', `${prefix}.command=${quote(launch.command)}`, '-c', `${prefix}.args=[${launch.args.map(quote).join(', ')}]`)
      if (Object.keys(connector.stdio.env).length) args.push('-c', `${prefix}.env=${table(connector.stdio.env)}`)
    } else {
      args.push('-c', `${prefix}.url=${quote(connector.http!.url)}`)
      if (Object.keys(connector.http!.headers).length) args.push('-c', `${prefix}.http_headers=${table(connector.http!.headers)}`)
    }
  }
  return args
}
// The line the stable system block carries when connectors are passed to this agent's process.
function connectorsLine(connectors: Pick<Connector, 'name' | 'description'>[] | undefined): string {
  if (!connectors?.length) return ''
  return `CONNECTORS (external MCP servers Orbit passes to this process next to its own; their tools are native tools of yours, in Claude Code named mcp__<name>__*): ${connectors.map(item => `${item.name} — ${item.description}`).join('; ')}. Add one with connector_add, check it with connector_test.`
}

// ---- connector_test: a minimal MCP client ---------------------------------------------------------------------------
interface Rpc { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }
const clip = (value: string, limit: number): string => value.length > limit ? `${value.slice(0, limit)}…` : value
const rpcError = (reply: Rpc): string => `${reply.error?.message || 'error'}${reply.error?.code !== undefined ? ` (code ${reply.error.code})` : ''}`
const initializeParams = { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'orbit', version: '1' } }

interface Exchange { request(method: string, params?: unknown): Promise<unknown>; notify(method: string, params?: unknown): Promise<void> }
async function listTools(exchange: Exchange): Promise<{ server?: string; tools: { name: string; description?: string }[] }> {
  const init = await exchange.request('initialize', initializeParams) as { serverInfo?: { name?: string; version?: string } } | undefined
  await exchange.notify('notifications/initialized')
  const tools: { name: string; description?: string }[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await exchange.request('tools/list', cursor ? { cursor } : {}) as { tools?: { name?: unknown; description?: unknown }[]; nextCursor?: unknown } | undefined
    for (const tool of result?.tools || []) if (typeof tool?.name === 'string') tools.push({ name: tool.name, ...(typeof tool.description === 'string' ? { description: clip(tool.description.replace(/\s+/g, ' '), 120) } : {}) })
    if (typeof result?.nextCursor !== 'string' || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return { server: init?.serverInfo?.name ? `${init.serverInfo.name}${init.serverInfo.version ? ` ${init.serverInfo.version}` : ''}` : undefined, tools }
}

// stdio: newline-delimited JSON-RPC on the process's stdin and stdout.
function stdioExchange(stdio: ConnectorStdio, deadline: AbortSignal, cwd?: string): { exchange: Exchange; stop: () => void; stderr: () => string; exited: Promise<string> } {
  const launch = launchOf(stdio)
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...stdio.env }, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
  let buffer = '', errors = '', next = 0, closed = false
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const fail = (error: Error) => { for (const entry of waiting.values()) entry.reject(error); waiting.clear() }
  const exited = new Promise<string>(resolve => {
    child.once('error', error => { closed = true; const message = `could not start "${stdio.command}": ${error.message}`; fail(new Error(message)); resolve(message) })
    child.once('close', (code, signal) => { closed = true; const message = `the process ended (${signal ? `signal ${signal}` : `exit ${code}`}) before answering`; fail(new Error(message)); resolve(message) })
  })
  child.stdin.on('error', () => { /* a dead process is reported by 'close' */ })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-4000) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1)
      if (!line) continue
      let message: Rpc
      try { message = JSON.parse(line) } catch { continue /* a log line on stdout is not a message */ }
      if (typeof message.id === 'number' && !message.method) {
        const entry = waiting.get(message.id)
        if (entry) { waiting.delete(message.id); if (message.error) entry.reject(new Error(rpcError(message))); else entry.resolve(message.result) }
      } else if (message.method && message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'not supported by this client' } }) })}\n`)
    }
  })
  const send = (message: Rpc) => { if (!closed) child.stdin.write(`${JSON.stringify(message)}\n`) }
  deadline.addEventListener('abort', () => fail(new Error('timed out')), { once: true })
  const exchange: Exchange = {
    request: (method, params) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('the process is not running'))
      const id = ++next
      waiting.set(id, { resolve, reject })
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    }),
    notify: async (method, params) => { send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) },
  }
  const stop = () => {
    try { child.stdin.end() } catch { /* already closed */ }
    if (child.pid && !closed) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.kill('SIGKILL')
    }
  }
  return { exchange, stop, stderr: () => errors, exited }
}

// http: Streamable HTTP, one POST per message; the answer is JSON or a one-shot event stream; a session id is carried on.
function httpExchange(http: ConnectorHttp, deadline: AbortSignal): Exchange {
  let next = 0, session = ''
  const post = async (body: Rpc): Promise<Response> => {
    const response = await fetch(http.url, {
      method: 'POST', signal: deadline,
      headers: { ...http.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify(body),
    })
    session = response.headers.get('mcp-session-id') || session
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${clip((await response.text().catch(() => '')).replace(/\s+/g, ' ').trim(), 300)}`.trim())
    return response
  }
  return {
    request: async (method, params) => {
      const id = ++next
      const response = await post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      const raw = await response.text()
      const candidates: string[] = /text\/event-stream/i.test(response.headers.get('content-type') || '') ? raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()) : [raw]
      for (const candidate of candidates) {
        let message: Rpc | Rpc[]
        try { message = JSON.parse(candidate) } catch { continue }
        const reply = (Array.isArray(message) ? message : [message]).find(item => item.id === id)
        if (reply) { if (reply.error) throw new Error(rpcError(reply)); return reply.result }
      }
      throw new Error(`no JSON-RPC answer in the response: ${clip(raw.replace(/\s+/g, ' ').trim(), 200)}`)
    },
    notify: async (method, params) => { await post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }).then(response => response.body?.cancel()) },
  }
}

// Starts (or contacts) the server, does `initialize` and `tools/list`, and reports the tool names or the exact failure.
async function testConnector(connector: Pick<Connector, 'name' | 'stdio' | 'http'>, { timeoutMs = TEST_TIMEOUT_MS, cwd, signal }: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {}): Promise<ConnectorTestResult> {
  const started = Date.now()
  const secrets = secretsOf(connector)
  const transport = connector.stdio ? 'stdio' : 'http'
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  // The caller's own cancellation (the run stopped) ends the test the way the time limit does.
  signal?.addEventListener('abort', () => deadline.abort(), { once: true })
  let stop = () => {}, stderr = () => ''
  try {
    let exchange: Exchange, exited: Promise<string> | null = null
    if (connector.stdio) { const opened = stdioExchange(connector.stdio, deadline.signal, cwd); ({ exchange, stop, stderr } = opened); exited = opened.exited }
    else exchange = httpExchange(connector.http!, deadline.signal)
    // A process that ends first is the failure to report; the race loser is never left as an unhandled rejection.
    const ended = exited ? exited.then((message): never => { throw new Error(message) }) : null
    ended?.catch(() => {})
    const listed = await Promise.race([listTools(exchange), ...(ended ? [ended] : [])])
    return { ok: true, name: connector.name, transport, server: listed.server, tools: listed.tools, elapsedMs: Date.now() - started }
  } catch (error) {
    const aborted = deadline.signal.aborted
    const tail = stderr().trim().split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')
    const reason = signal?.aborted ? 'the run was cancelled' : aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (error as Error).message
    return { ok: false, name: connector.name, transport, error: maskSecrets(`${reason}${tail ? `; the server's stderr: ${clip(tail, 600)}` : ''}`, secrets), elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
    stop()
  }
}

export { ConnectorStore, normalizeConnector, view as connectorView, maskToolArguments, toolCallText, maskUrl, maskSecrets, secretsOf, claudeServers, cursorServers, antigravityServers, codexConnectorArgs, connectorsLine, testConnector, launchOf, NAME as CONNECTOR_NAME, MAX_PER_SCOPE, TEST_TIMEOUT_MS }
