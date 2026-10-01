// I17 live check on Windows: a file of a deleted chat that another program holds open (PowerShell opens it with
// FileShare.Read, as a PDF viewer does) keeps its folder marked; once released, a sweep removes the folder and the mark.
// Run: node --experimental-strip-types --disable-warning=ExperimentalWarning scratchpad/i17/live-lock.cjs
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process')
const { saveAttachments, discardAttachments, sweepDiscarded, attachmentsRoot } = require('../../electron/attachments.mts')
const upload = (name, text, type) => ({ name, type, data: Buffer.from(text).toString('base64') })
;(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-i17-live-'))
  try {
    const [held] = await saveAttachments(userData, 'chat-live', [upload('open.pdf', '%PDF-1.4', 'application/pdf'), upload('b.txt', 'b', 'text/plain'), upload('c.txt', 'c', 'text/plain')])
    const folder = path.dirname(held.path)
    const script = `$f = [IO.File]::Open('${held.path.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['pipe', 'pipe', 'inherit'] })
    await new Promise(resolve => ps.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve() }))
    let started = Date.now()
    const removed = await discardAttachments(userData, 'chat-live')
    console.log('discard while held:', JSON.stringify({ removed, ms: Date.now() - started, left: fs.existsSync(folder) ? fs.readdirSync(folder) : null, mark: fs.existsSync(`${folder}.discard`) }))
    started = Date.now()
    console.log('sweep while held:', JSON.stringify({ swept: await sweepDiscarded(userData), ms: Date.now() - started, mark: fs.existsSync(`${folder}.discard`) }))
    ps.stdin.end('\n')
    await new Promise(resolve => ps.on('exit', resolve))
    console.log('sweep after release:', JSON.stringify({ swept: await sweepDiscarded(userData), folder: fs.existsSync(folder), mark: fs.existsSync(`${folder}.discard`), root: fs.readdirSync(attachmentsRoot(userData)) }))
  } finally { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
