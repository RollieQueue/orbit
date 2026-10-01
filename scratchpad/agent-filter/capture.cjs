'use strict'
// Screenshots of the agents panel with the activity filter. node scripts/run-electron.cjs scratchpad/agent-filter/capture.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('force-prefers-reduced-motion')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-filter-shots-')))
app.on('window-all-closed', () => {})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const SHOTS = path.join(__dirname, 'shots')
const PAGES = [
  ['01-all', 'filter=all'], ['02-working-dimmed', 'filter=working'], ['03-waiting', 'filter=waiting'], ['04-active', 'filter=active'],
  ['05-empty', 'filter=cancelled&drop=stop,int'], ['06-timeline-working', 'filter=working&view=timeline'], ['07-timeline-all', 'filter=all&view=timeline'],
]
app.whenReady().then(async () => {
  let failed = false
  fs.mkdirSync(SHOTS, { recursive: true })
  for (const [name, hash] of PAGES) {
    const win = new BrowserWindow({ width: 340, height: 900, useContentSize: true, show: false, backgroundColor: '#17181b' })
    const errors = []
    win.webContents.on('console-message', event => { if (['warning', 'error'].includes(event.level)) errors.push(event.message.slice(0, 300)) })
    await win.loadFile(path.join(__dirname, 'harness-dist', 'index.html'), { hash })
    const until = Date.now() + 15000
    while (!(await win.webContents.executeJavaScript('window.__ready === true')) && Date.now() < until) await wait(50)
    errors.push(...JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__errors)')))
    await wait(300)
    win.webContents.invalidate()
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await wait(300)
    const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
    const text = await win.webContents.executeJavaScript('document.querySelector(".agent-filter")?.innerText.replace(/\\n/g," ")')
    console.log(name, JSON.stringify(image.getSize()), '| chips:', text, errors.length ? `| ERRORS ${JSON.stringify(errors)}` : '')
    if (errors.length) failed = true
    win.destroy()
  }
  app.exit(failed ? 1 : 0)
})
