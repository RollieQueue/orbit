// The system's process table, read once on demand: pid, parent pid, creation time, image name and command line of every process.
// Windows only (Win32_Process through PowerShell, 0.4-0.75 s measured), null elsewhere or when it cannot be read.
// Main uses it to find what a crashed runtime left running (runtime-client.cjs), the runtime to find what an agent's
// CLI left running (process-reaper.mts). Win32_Process keeps the pid of a parent that has exited, which is how orphans
// are found. A shell file (SHELL_FILES of fingerprint.cjs): it imports only node: modules.
import childProcess from 'node:child_process'
import path from 'node:path'

// `created`: the creation time in ms since the epoch, null when the OS gave none; `name`: the image name (node.exe);
// `command`: the command line, its first 600 characters (absent for a process the OS keeps it from us).
interface ProcessRow { pid: number; ppid: number; created: number | null; name?: string; command?: string }

// The table as JSON, `[{ p, pp, c, n, l }]`: pid, parent pid, creation time, image name, command line; run through
// -EncodedCommand, so nothing in it needs quoting.
const PROCESS_TABLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$rows = Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, Name, CommandLine FROM Win32_Process' | ForEach-Object {",
  '  $created = $null',
  '  if ($_.CreationDate) { $created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }',
  '  $line = [string]$_.CommandLine',
  '  if ($line.Length -gt 600) { $line = $line.Substring(0, 600) }',
  '  [pscustomobject]@{ p = [long]$_.ProcessId; pp = [long]$_.ParentProcessId; c = $created; n = [string]$_.Name; l = $line }',
  '}',
  'ConvertTo-Json -InputObject @($rows) -Compress',
].join('\n')
// How long the process table may take to read (PowerShell starts in ~0.5 s).
const PROCESS_TABLE_TIMEOUT_MS = 15000

// PROCESS_TABLE_SCRIPT's output as rows; null when it is not that.
function parseProcessTable(text: string): ProcessRow[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(text.trim()) } catch { return null }
  const list: unknown[] | null = Array.isArray(parsed) ? parsed : (parsed !== null && typeof parsed === 'object' ? [parsed] : null)
  if (!list) return null
  const rows: ProcessRow[] = []
  for (const item of list) {
    const fields = (item !== null && typeof item === 'object' ? item : null) as { p?: unknown; pp?: unknown; c?: unknown; n?: unknown; l?: unknown } | null
    if (!fields || !Number.isSafeInteger(fields.p) || !Number.isSafeInteger(fields.pp)) continue
    rows.push({
      pid: Number(fields.p), ppid: Number(fields.pp), created: typeof fields.c === 'number' && Number.isFinite(fields.c) ? fields.c : null,
      ...(typeof fields.n === 'string' && fields.n ? { name: fields.n } : {}),
      ...(typeof fields.l === 'string' && fields.l ? { command: fields.l } : {}),
    })
  }
  return rows
}

// The system's process table, read once: on Windows Win32_Process through PowerShell. Null elsewhere, or when it cannot
// be read in time; the callers then leave every process alone.
function listProcessTable(timeoutMs: number = PROCESS_TABLE_TIMEOUT_MS): Promise<ProcessRow[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const systemRoot = process.env.SystemRoot
  const powershell = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const encoded = Buffer.from(PROCESS_TABLE_SCRIPT, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    childProcess.execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => resolve(error ? null : parseProcessTable(String(stdout))))
  })
}

export type { ProcessRow }
export { PROCESS_TABLE_SCRIPT, PROCESS_TABLE_TIMEOUT_MS, parseProcessTable, listProcessTable }
