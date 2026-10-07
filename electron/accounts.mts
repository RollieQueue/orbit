// Account folders and the sign-in launch of a subscription instance (see instances.mts).
//
// Every extra account of a provider gets its own folder under <userData>/accounts/<id>, which its CLI is pointed at through
// CLAUDE_CONFIG_DIR / CODEX_HOME. Orbit creates and deletes those folders and starts the CLI's own login command in a
// terminal window; it never reads the credentials the CLI writes there.
//
// Pure functions plus plain fs, Node builtins only (no electron import), so the main process and the tests share them.
import fs from 'node:fs'
import path from 'node:path'
import { ACCOUNT_ENV, BASE_NAMES, isBaseProvider, isInstanceId } from './instances.mts'
import type { BaseProvider } from './instances.mts'

type Platform = NodeJS.Platform | string

export const accountsRoot = (userData: string): string => path.join(userData, 'accounts')

// The folder of one instance: <userData>/accounts/<id>. Only ids instances.mts accepts ("claude-2"): the id regexp has no
// separator, dot or colon, so no id can leave the root; anything else throws before a path is built.
export function accountDirFor(userData: string, id: string): string {
  if (typeof id !== 'string' || !isInstanceId(id)) throw new Error(`"${String(id)}" is not a subscription id`)
  return path.join(accountsRoot(userData), id)
}

export function prepareAccountDir(userData: string, id: string): string {
  const dir = accountDirFor(userData, id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Ids this process has handed out: a removed account's id is not given again, so nothing the runtime still remembers under it
// (a quota reading, a refusal mark) can pass to a different account.
const issued = new Set<string>()
// The first id of `base` (claude-2, claude-3, ...) that is not in use (`taken`), has no folder and was not issued before. A folder that is
// still there holds a removed account's sign-in (the owner kept it): the next account never starts from it.
export function freeAccountId(userData: string, base: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`
    if (!used.has(id) && !issued.has(`${userData}|${id}`) && !fs.existsSync(accountDirFor(userData, id))) return id
  }
  throw new Error(`Too many ${base} accounts`)
}
// A new account: its id and its empty folder.
export function prepareNewAccount(userData: string, base: string, taken: Iterable<string> = []): { id: string; dir: string } {
  const id = freeAccountId(userData, base, taken)
  const dir = prepareAccountDir(userData, id)
  issued.add(`${userData}|${id}`)
  return { id, dir }
}

const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
// `inner` is strictly inside `outer`: a non-empty relative path that neither climbs out nor jumps to another drive.
function strictlyInside(outer: string, inner: string): boolean {
  const rel = path.relative(fold(outer), fold(inner))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

// The real path of `target` with every link resolved; for a path that does not exist (yet) the nearest existing ancestor
// is resolved and the missing tail appended, so a link above a missing folder is still seen.
function realish(target: string): string {
  const tail: string[] = []
  let current = target
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail.reverse()) } catch { /* missing or unreadable: go up */ }
    const parent = path.dirname(current)
    if (parent === current) return target
    tail.push(path.basename(current))
    current = parent
  }
}

// Whether `dir` is a folder Orbit owns: strictly inside <userData>/accounts, also after links are resolved (a junction
// inside the root that points elsewhere is not managed). The root itself, siblings such as "accounts-evil" and non-paths are not.
export function isManagedDir(userData: string, dir: unknown): boolean {
  if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0') || typeof userData !== 'string' || !userData) return false
  const root = path.resolve(accountsRoot(userData)), target = path.resolve(dir)
  if (!strictlyInside(root, target)) return false
  return strictlyInside(realish(root), realish(target))
}

// Removes one managed account folder, SYNCHRONOUSLY. Returns true when something was deleted, false when the path is not
// managed or does not exist. A folder that is itself a link is unlinked only (never its target), and links inside the
// folder are unlinked before the rest is removed, so nothing outside the root is ever touched.
export function removeAccountDir(userData: string, dir: unknown): boolean {
  if (!isManagedDir(userData, dir)) return false
  const target = path.resolve(dir as string)
  let stat: fs.Stats
  try { stat = fs.lstatSync(target) } catch { return false }
  if (stat.isSymbolicLink()) { unlinkLink(target); return true }
  unlinkInnerLinks(target)
  fs.rmSync(target, { recursive: true, force: true })
  return true
}

function unlinkLink(link: string): void {
  try { fs.unlinkSync(link) } catch { fs.rmdirSync(link) } // a Windows junction may need rmdir
}
function unlinkInnerLinks(dir: string): void {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    let stat: fs.Stats
    try { stat = fs.lstatSync(full) } catch { continue }
    if (stat.isSymbolicLink()) { try { unlinkLink(full) } catch { /* left for rmSync, which does not follow it either */ } }
    else if (stat.isDirectory()) unlinkInnerLinks(full)
  }
}

// ---- sign-in launch ------------------------------------------------------------------------------------------------

// What each CLI runs to sign an account in. Both read the account folder named by ACCOUNT_ENV.
const LOGIN: Readonly<Partial<Record<BaseProvider, { command: string; args: readonly string[] }>>> = Object.freeze({
  claude: { command: 'claude', args: ['auth', 'login'] },
  codex: { command: 'codex', args: ['login'] },
})

export interface LoginOptions {
  command?: string
  dir: string
  platform?: Platform
  // Tests only: replaces the CLI's login arguments (so a harmless script can be started the same way).
  args?: readonly string[]
  // Tests only (win32): false runs the window's shell with /c instead of /k so the window closes by itself.
  keepOpen?: boolean
  // linux: 'xterm' instead of the system's x-terminal-emulator.
  terminal?: string
}
export interface LoginLaunch {
  file: string
  args: string[]
  env: Record<string, string>
  windowTitle: string
  // win32: `args` is already a finished command line, so spawn must not quote it again (windowsVerbatimArguments).
  verbatim: boolean
  spawnOptions: { detached: true; stdio: 'ignore'; windowsHide: boolean }
}

// A command is a program name or a path ("C:\Program Files\claude\claude.exe"): spaces and backslashes are fine, anything a
// shell could read as syntax is not, because the command is placed into a terminal's command line.
const UNSAFE_COMMAND = /["\r\n\0&|<>^%!()`;$]/
export function checkCommand(value: string, what = 'command'): string {
  if (UNSAFE_COMMAND.test(value)) throw new Error(`The ${what} contains a character that is not allowed (quotes, line breaks and & | < > ^ % ! ( ) \` ; $)`)
  return value
}
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const appleScriptString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const cmdWord = (value: string): string => /\s/.test(value) ? `"${value}"` : value

// The shell line "'cmd' 'arg' ..." for POSIX shells.
export function loginCommandLine(command: string, args: readonly string[], platform: Platform = process.platform): string {
  if (platform === 'win32') return [`"${command}"`, ...args.map(cmdWord)].join(' ')
  return [command, ...args].map(shellQuote).join(' ')
}

export function loginLaunch(base: string, options: LoginOptions): LoginLaunch {
  const variable = isBaseProvider(base) ? ACCOUNT_ENV[base] : null
  const login = isBaseProvider(base) ? LOGIN[base] : undefined
  if (!variable || !login || !isBaseProvider(base)) throw new Error(`${isBaseProvider(base) ? BASE_NAMES[base] : String(base)} has no setting for a second account`)
  const platform = options.platform ?? process.platform
  const dir = typeof options.dir === 'string' ? options.dir : ''
  if (!dir.trim() || /[\0\r\n]/.test(dir) || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(dir)) throw new Error('The account folder must be a non-empty absolute path')
  const command = checkCommand(String(options.command ?? '').trim() || login.command)
  const loginArgs = (options.args ?? login.args).map(arg => checkCommand(String(arg), 'argument'))
  const windowTitle = `Orbit · Вход: ${BASE_NAMES[base]}`
  const spawnOptions = { detached: true as const, stdio: 'ignore' as const, windowsHide: false }

  if (platform === 'win32') {
    // cmd /c start "<title>" cmd /k ""<command>" args": `start` opens the new window, and the doubled outer quotes make cmd
    // keep the quoted program path intact (its rule strips the first and the last quote of a /k line that starts with one).
    // The account variable is inherited from the spawn environment. Args are passed verbatim so Node adds no quoting.
    const shell = options.keepOpen === false ? '/c' : '/k'
    const line = `"${loginCommandLine(command, loginArgs, 'win32')}"`
    return { file: 'cmd.exe', args: ['/d', '/c', 'start', `"${windowTitle}"`, 'cmd.exe', '/d', shell, line], env: { [variable]: dir }, windowTitle, verbatim: true, spawnOptions }
  }
  if (platform === 'darwin') {
    // Terminal's new shell does not inherit our environment, so the variable is exported inside the script it runs.
    const script = `export ${variable}=${shellQuote(dir)}; ${loginCommandLine(command, loginArgs, platform)}`
    return { file: 'osascript', args: ['-e', `tell application "Terminal" to do script ${appleScriptString(script)}`, '-e', 'tell application "Terminal" to activate'], env: {}, windowTitle, verbatim: false, spawnOptions }
  }
  const terminal = options.terminal === 'xterm' ? 'xterm' : 'x-terminal-emulator'
  const line = `${loginCommandLine(command, loginArgs, platform)}; printf '\\n'; read -r _`
  return { file: terminal, args: ['-e', 'sh', '-c', line], env: { [variable]: dir }, windowTitle, verbatim: false, spawnOptions }
}
