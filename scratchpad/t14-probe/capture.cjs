// T14 visual check: the built harness (the real Celebration component) in Electron 44 with main.cjs's Referer hook and
// autoplay policy. Saves two screenshots, reports the YouTube frame's state and whether the overlay closed by itself.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const out = path.join(__dirname, 'shots')
fs.mkdirSync(out, { recursive: true })
const PEEK = `(() => { const v = document.querySelector('video'); const e = document.querySelector('.ytp-error-content-wrap-reason, .ytp-error');
  return JSON.stringify({ err: e ? e.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null, t: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v ? v.paused : null, muted: v ? v.muted : null }) })()`
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function shot(win, name) {
  win.webContents.invalidate()
  await win.webContents.capturePage()
  await wait(500)
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(out, name), image.toPNG())
  return image.getSize()
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (!headers.Referer && !headers.referer) headers.Referer = 'https://orbit.local/'
    callback({ requestHeaders: headers })
  })
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message.slice(0, 200)) })
  await win.loadFile(path.join(__dirname, 'harness-dist', 'index.html'))
  const peek = async () => {
    const frame = win.webContents.mainFrame.frames.find(item => /youtube/.test(item.url))
    return frame ? frame.executeJavaScript(PEEK).catch(error => `exec error: ${error.message}`) : 'no youtube frame'
  }
  await wait(6000)
  console.log('shot 1', JSON.stringify(await shot(win, 'celebration-1.png')), await peek())
  await wait(2500)
  console.log('shot 2', JSON.stringify(await shot(win, 'celebration-2.png')), await peek())
  const flyer = await win.webContents.executeJavaScript(`(() => { const f = document.querySelector('.celebration-flyer'); const w = document.querySelector('.celebration-word');
    return JSON.stringify({ transform: f && f.style.transform, font: w && getComputedStyle(w).fontFamily, closeFocused: document.activeElement && document.activeElement.className }) })()`)
  console.log('flyer', flyer)
  await wait(28000)
  const closed = await win.webContents.executeJavaScript('JSON.stringify(window.__closed || [])')
  console.log('closed after ~37 s:', closed, '| renderer errors:', JSON.stringify(errors.slice(0, 5)))
  app.quit()
})
