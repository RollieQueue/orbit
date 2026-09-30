const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const wait = ms => new Promise(r => setTimeout(r, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 900, show: false })
  const errs = []
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) errs.push(m.slice(0, 160)) })
  await win.loadFile(path.join(__dirname, 'harness-dist', 'index.html'))
  await wait(800)
  const ev = s => win.webContents.executeJavaScript(s)
  console.log('start', await ev('window.__count()'))
  const seq = [1, 2, 0, 2, 1, 0, 1, 2, 0, 0, 2]
  for (const i of seq) {
    await ev(`document.querySelectorAll('.agent-row')[${i}].click()`)
    await wait(150)
    console.log('row', i, await ev('window.__count()'))
  }
  console.log('errors', JSON.stringify(errs))
  app.quit()
})
