const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { accountsRoot, accountDirFor, prepareAccountDir, freeAccountId, prepareNewAccount, isManagedDir, removeAccountDir, loginLaunch, loginCommandLine } = require('../electron/accounts.mts')

// A scratch "userData" folder, removed in t.after (registered before any assertion).
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-accounts-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const userData = path.join(base, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  return { base, userData }
}
// A link to `target` at `link`; null when the machine does not allow creating it.
function link(target, linkPath) {
  try { fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); return linkPath } catch { return null }
}

// ---- folders ------------------------------------------------------------------------------------------------------

test('accountDirFor accepts instance ids only and stays under <userData>/accounts', () => {
  const ud = path.join(os.tmpdir(), 'ud')
  assert.equal(accountsRoot(ud), path.join(ud, 'accounts'))
  assert.equal(accountDirFor(ud, 'claude-2'), path.join(ud, 'accounts', 'claude-2'))
  assert.equal(accountDirFor(ud, 'codex-work'), path.join(ud, 'accounts', 'codex-work'))
  for (const bad of ['../x', '..', '.', 'claude', 'codex', 'claude-2/..', 'claude-2\\x', 'claude-2/x', '/claude-2', 'claude-', 'claude-2 ', 'CLAUDE-2', 'claude-..', 'cursor', 'ollama-2', 'claude-2\0', '', undefined, null, 5])
    assert.throws(() => accountDirFor(ud, bad), /not a subscription id/, JSON.stringify(bad))
  assert.equal(accountDirFor(ud, 'cursor-1'), path.join(ud, 'accounts', 'cursor-1')) // a well-formed id; whether the provider can run it is loginLaunch's business
})

test('prepareAccountDir creates the folder (and is repeatable)', (t) => {
  const { userData } = sandbox(t)
  const dir = prepareAccountDir(userData, 'claude-2')
  assert.equal(dir, path.join(userData, 'accounts', 'claude-2'))
  assert.ok(fs.statSync(dir).isDirectory())
  assert.equal(prepareAccountDir(userData, 'claude-2'), dir)
  assert.throws(() => prepareAccountDir(userData, '../evil'))
  assert.equal(fs.existsSync(path.join(userData, 'evil')), false)
})

test('a new account gets an id that is free: not taken, no folder left by a removed account, never issued before', (t) => {
  const { userData } = sandbox(t)
  assert.equal(freeAccountId(userData, 'claude', ['claude', 'claude-2']), 'claude-3')
  const first = prepareNewAccount(userData, 'codex', ['codex'])
  assert.deepEqual(first, { id: 'codex-2', dir: path.join(userData, 'accounts', 'codex-2') })
  fs.mkdirSync(path.join(userData, 'accounts', 'codex-3'))
  assert.equal(freeAccountId(userData, 'codex', ['codex']), 'codex-4', 'codex-2 was issued, codex-3 is a leftover folder')
  fs.rmSync(first.dir, { recursive: true })
  assert.equal(freeAccountId(userData, 'codex', ['codex']), 'codex-4', "a removed account's id is not handed out again by this process")
  assert.throws(() => freeAccountId(userData, 'nope'), /not a subscription id/)
})

test('isManagedDir: only folders strictly inside <userData>/accounts', (t) => {
  const { base, userData } = sandbox(t)
  const root = accountsRoot(userData)
  fs.mkdirSync(path.join(base, 'userData', 'accounts-evil'), { recursive: true })
  const table = [
    [path.join(root, 'claude-2'), true, 'inside'],
    [path.join(root, 'claude-2', 'deep', 'er'), true, 'nested'],
    [path.join(root, 'claude-2', '..', 'codex-2'), true, 'normalised, still inside'],
    [path.join(root, 'not-created-yet'), true, 'missing but inside'],
    [root, false, 'the root itself'],
    [root + path.sep, false, 'the root with a trailing separator'],
    [path.join(root, 'claude-2', '..', '..'), false, 'normalises to the parent'],
    [path.join(root, '..', 'claude-2'), false, '.. escape'],
    [path.join(root, '..'), false, 'parent'],
    [userData, false, 'userData'],
    [path.join(userData, 'accounts-evil'), false, 'sibling with the same prefix'],
    [path.join(userData, 'accounts-evil', 'claude-2'), false, 'inside the sibling'],
    [path.join('accounts', 'claude-2'), false, 'relative path (resolved against the cwd)'],
    ['', false, 'empty'],
    ['   ', false, 'blank'],
    [undefined, false, 'undefined'],
    [null, false, 'null'],
    [5, false, 'number'],
    [path.join(root, 'claude-2\0'), false, 'NUL'],
  ]
  for (const [dir, expected, why] of table) assert.equal(isManagedDir(userData, dir), expected, why)
  assert.equal(isManagedDir('', path.join(root, 'claude-2')), false)
})

test('isManagedDir is case-insensitive on Windows only', (t) => {
  const { userData } = sandbox(t)
  const upper = path.join(userData, 'ACCOUNTS', 'claude-2')
  assert.equal(isManagedDir(userData, upper), process.platform === 'win32')
})

test('isManagedDir: a link inside the root that points outside is not managed', (t) => {
  const { base, userData } = sandbox(t)
  const outside = path.join(base, 'outside')
  fs.mkdirSync(outside)
  fs.mkdirSync(accountsRoot(userData), { recursive: true })
  const escape = link(outside, path.join(accountsRoot(userData), 'claude-9'))
  if (!escape) return t.skip('cannot create a link here')
  assert.equal(isManagedDir(userData, escape), false)
  assert.equal(isManagedDir(userData, path.join(escape, 'not-there')), false, 'a missing folder below the link')
  const inside = path.join(accountsRoot(userData), 'real')
  fs.mkdirSync(inside)
  const ok = link(inside, path.join(accountsRoot(userData), 'claude-8'))
  assert.equal(isManagedDir(userData, ok), true, 'a link that stays inside the root')
})

test('removeAccountDir refuses anything that is not managed', (t) => {
  const { base, userData } = sandbox(t)
  const stranger = path.join(base, 'important')
  fs.mkdirSync(stranger)
  fs.writeFileSync(path.join(stranger, 'keep.txt'), 'x')
  const root = accountsRoot(userData)
  fs.mkdirSync(path.join(root, 'claude-2'), { recursive: true })
  assert.equal(removeAccountDir(userData, stranger), false)
  assert.equal(removeAccountDir(userData, root), false)
  assert.equal(removeAccountDir(userData, userData), false)
  assert.equal(removeAccountDir(userData, path.join(root, '..', 'important')), false)
  assert.equal(removeAccountDir(userData, ''), false)
  assert.equal(removeAccountDir(userData, undefined), false)
  assert.ok(fs.existsSync(path.join(stranger, 'keep.txt')))
  assert.ok(fs.existsSync(path.join(root, 'claude-2')))
  assert.equal(removeAccountDir(userData, path.join(root, 'claude-3')), false, 'absent')
})

test('removeAccountDir deletes a managed folder with its content', (t) => {
  const { userData } = sandbox(t)
  const dir = prepareAccountDir(userData, 'codex-2')
  fs.mkdirSync(path.join(dir, 'sessions', 'a'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sessions', 'a', 'x.json'), '{}')
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}')
  assert.equal(removeAccountDir(userData, dir), true)
  assert.equal(fs.existsSync(dir), false)
  assert.ok(fs.existsSync(accountsRoot(userData)), 'the root stays')
})

test('removeAccountDir never follows a link out of the folder', (t) => {
  const { base, userData } = sandbox(t)
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep')
  fs.writeFileSync(path.join(outside, 'sub', 'deep.txt'), 'keep')
  const dir = prepareAccountDir(userData, 'claude-2')
  fs.writeFileSync(path.join(dir, 'own.txt'), 'x')
  const inner = link(outside, path.join(dir, 'shared'))
  if (!inner) return t.skip('cannot create a link here')
  fs.mkdirSync(path.join(dir, 'nested'))
  link(outside, path.join(dir, 'nested', 'again'))
  assert.equal(removeAccountDir(userData, dir), true)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep')
  assert.equal(fs.readFileSync(path.join(outside, 'sub', 'deep.txt'), 'utf8'), 'keep')
})

test('removeAccountDir on a link inside the root removes the link only', (t) => {
  const { base, userData } = sandbox(t)
  const target = path.join(accountsRoot(userData), 'real')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
  const alias = link(target, path.join(accountsRoot(userData), 'claude-5'))
  if (!alias) return t.skip('cannot create a link here')
  assert.equal(removeAccountDir(userData, alias), true)
  assert.equal(fs.existsSync(alias), false)
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep')
  // and a link that points outside is refused outright
  const outside = path.join(base, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const bad = link(outside, path.join(accountsRoot(userData), 'claude-6'))
  assert.equal(removeAccountDir(userData, bad), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
})

// ---- sign-in launch -----------------------------------------------------------------------------------------------

const SPAWN = { detached: true, stdio: 'ignore', windowsHide: false }
const WIN_DIR = 'C:\\Users\\Me\\AppData\\Roaming\\orbit\\accounts\\claude-2'

test('loginLaunch on Windows: cmd /c start with the title, verbatim quoting and the account variable only in env', () => {
  const claude = loginLaunch('claude', { dir: WIN_DIR, platform: 'win32' })
  assert.equal(claude.file, 'cmd.exe')
  assert.deepEqual(claude.args, ['/d', '/c', 'start', '"Orbit · Вход: Claude Code"', 'cmd.exe', '/d', '/k', '""claude" auth login"'])
  assert.deepEqual(claude.env, { CLAUDE_CONFIG_DIR: WIN_DIR })
  assert.equal(claude.windowTitle, 'Orbit · Вход: Claude Code')
  assert.equal(claude.verbatim, true)
  assert.deepEqual(claude.spawnOptions, SPAWN)
  const codex = loginLaunch('codex', { dir: 'D:\\acc\\codex-2', platform: 'win32', command: 'C:\\Program Files\\codex\\codex.exe' })
  assert.deepEqual(codex.args.slice(0, 7), ['/d', '/c', 'start', '"Orbit · Вход: Codex"', 'cmd.exe', '/d', '/k'])
  assert.equal(codex.args[7], '""C:\\Program Files\\codex\\codex.exe" login"')
  assert.deepEqual(codex.env, { CODEX_HOME: 'D:\\acc\\codex-2' })
  assert.equal(loginLaunch('claude', { dir: WIN_DIR, platform: 'win32', keepOpen: false }).args[6], '/c')
})

test('loginLaunch on macOS: osascript with an export prefix inside the Terminal script', () => {
  const dir = "/Users/me/Library/Application Support/orbit/accounts/claude-2"
  const launch = loginLaunch('claude', { dir, platform: 'darwin' })
  assert.equal(launch.file, 'osascript')
  assert.deepEqual(launch.args, ['-e', `tell application "Terminal" to do script "export CLAUDE_CONFIG_DIR='${dir}'; 'claude' 'auth' 'login'"`, '-e', 'tell application "Terminal" to activate'])
  assert.deepEqual(launch.env, {})
  assert.equal(launch.verbatim, false)
  assert.deepEqual(launch.spawnOptions, SPAWN)
  // single quotes are closed, escaped and reopened; AppleScript quotes and backslashes are escaped
  const odd = loginLaunch('codex', { dir: "/Users/o'neil/acc", platform: 'darwin', command: '/opt/my tools/codex' })
  assert.equal(odd.args[1], `tell application "Terminal" to do script "export CODEX_HOME='/Users/o'\\\\''neil/acc'; '/opt/my tools/codex' 'login'"`)
})

test('loginLaunch on Linux: x-terminal-emulator (or xterm) running sh -c with the variable in env', () => {
  const dir = '/home/me/.config/orbit/accounts/codex-2'
  const launch = loginLaunch('codex', { dir, platform: 'linux' })
  assert.equal(launch.file, 'x-terminal-emulator')
  assert.deepEqual(launch.args, ['-e', 'sh', '-c', "'codex' 'login'; printf '\\n'; read -r _"])
  assert.deepEqual(launch.env, { CODEX_HOME: dir })
  assert.deepEqual(launch.spawnOptions, SPAWN)
  assert.equal(loginLaunch('claude', { dir, platform: 'linux', terminal: 'xterm' }).file, 'xterm')
  assert.equal(loginLaunch('claude', { dir, platform: 'linux', terminal: 'evil' }).file, 'x-terminal-emulator')
})

test('loginLaunch: empty or missing command means the default, the command is trimmed', () => {
  for (const command of [undefined, '', '   ', null]) assert.equal(loginLaunch('claude', { dir: WIN_DIR, platform: 'win32', command }).args[7], '""claude" auth login"')
  assert.equal(loginLaunch('codex', { dir: '/a/b', platform: 'linux', command: '  /usr/bin/codex  ' }).args[3], "'/usr/bin/codex' 'login'; printf '\\n'; read -r _")
})

test('loginLaunch refuses commands that a shell could read as syntax', () => {
  for (const bad of ['claude" & calc', 'a"b', 'a\nb', 'a\rb', 'a\0b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a(b', 'a)b', 'a`b', 'a;b', 'a$b', '$(whoami)', 'claude && del *'])
    for (const platform of ['win32', 'darwin', 'linux'])
      assert.throws(() => loginLaunch('claude', { dir: platform === 'win32' ? WIN_DIR : '/a/b', platform, command: bad }), /not allowed/, `${platform} ${JSON.stringify(bad)}`)
  // spaces, backslashes, dots and an apostrophe are fine
  assert.doesNotThrow(() => loginLaunch('claude', { dir: WIN_DIR, platform: 'win32', command: 'C:\\Program Files\\claude\\claude.exe' }))
  assert.doesNotThrow(() => loginLaunch('claude', { dir: '/a/b', platform: 'linux', command: "/opt/o'neil/claude" }))
})

test('loginLaunch refuses an account folder that is empty, relative or has control characters', () => {
  for (const dir of ['', '   ', 'relative\\path', './x', 'a\nb', 'C:\\a\0b', undefined, null, 5])
    assert.throws(() => loginLaunch('claude', { dir, platform: 'win32' }), /account folder/, JSON.stringify(dir))
  assert.throws(() => loginLaunch('claude', { dir: 'C:\\only\\windows', platform: 'linux' }), /account folder/)
})

test('loginLaunch: providers without an account setting throw', () => {
  for (const base of ['cursor', 'antigravity', 'ollama', 'claude-2', '', undefined])
    assert.throws(() => loginLaunch(base, { dir: '/a/b', platform: 'linux' }), /has no setting for a second account/, String(base))
  assert.throws(() => loginLaunch('cursor', { dir: '/a/b', platform: 'linux' }), /^Error: Cursor has no setting for a second account$/)
})

test('loginCommandLine quotes for each shell', () => {
  assert.equal(loginCommandLine('claude', ['auth', 'login'], 'linux'), "'claude' 'auth' 'login'")
  assert.equal(loginCommandLine("it's", ['a b'], 'darwin'), `'it'\\''s' 'a b'`)
  assert.equal(loginCommandLine('C:\\Program Files\\x.exe', ['a b', 'c'], 'win32'), '"C:\\Program Files\\x.exe" "a b" c')
})

// ---- a real launch on Windows -------------------------------------------------------------------------------------

// Runs the produced launch for real (detached, in a new window) and waits for the marker file the started program writes.
function launchAndWait(launch, env, marker) {
  const child = spawn(launch.file, launch.args, { ...launch.spawnOptions, env: { ...process.env, ...env, ...launch.env }, windowsVerbatimArguments: launch.verbatim })
  child.on('error', () => {})
  child.unref()
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (fs.existsSync(marker) && fs.statSync(marker).size > 0) { clearInterval(timer); setTimeout(() => resolve(fs.readFileSync(marker, 'utf8').trim()), 100) }
      else if (Date.now() - started > 20000) { clearInterval(timer); resolve(null) }
    }, 100)
  })
}

test('loginLaunch on Windows really starts the command in a new window with the account variable', { skip: process.platform !== 'win32' }, async (t) => {
  const { base } = sandbox(t)
  const account = path.join(base, 'account dir', 'claude-2')
  fs.mkdirSync(account, { recursive: true })
  const spaced = path.join(base, 'tool dir')
  fs.mkdirSync(spaced)

  // 1. a node script (path with a space) started by node.exe
  const marker = path.join(base, 'marker.txt')
  const script = path.join(spaced, 'write env.cjs')
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, process.env.CLAUDE_CONFIG_DIR + '|' + process.argv.slice(2).join(','))`)
  let launch
  try { launch = loginLaunch('claude', { dir: account, platform: 'win32', command: process.execPath, args: [script, 'x y'], keepOpen: false }) } catch (error) { return t.skip(`node.exe path not allowed: ${error.message}`) }
  const written = await launchAndWait(launch, {}, marker)
  assert.equal(written, `${account}|x y`)

  // 2. a .cmd program whose own path contains spaces
  const marker2 = path.join(base, 'marker2.txt')
  const tool = path.join(spaced, 'my tool.cmd')
  fs.writeFileSync(tool, `@echo off\r\n>"${marker2}" echo %CODEX_HOME%\r\n`)
  const launch2 = loginLaunch('codex', { dir: account, platform: 'win32', command: tool, args: ['login'], keepOpen: false })
  assert.equal(await launchAndWait(launch2, {}, marker2), account)
})
