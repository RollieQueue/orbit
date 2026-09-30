// T14 probe: does a YouTube embed play inside Electron from a file:// page, with and without a Referer on the embed request?
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const MODES = (process.env.PROBE_MODES || 'none,https://orbit.local/').split(',')
const page = path.join(__dirname, 'page.html')
fs.writeFileSync(page, '<!doctype html><html><body style="margin:0;background:#000"><iframe width="800" height="450" style="border:0" ' +
  'src="https://www.youtube.com/embed/6-8E4Nirh9s?autoplay=1&start=42&end=73&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0" ' +
  'allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>')

const PEEK = `(() => { const v = document.querySelector('video'); const e = document.querySelector('.ytp-error-content-wrap-reason, .ytp-error');
  return JSON.stringify({ err: e ? e.innerText.replace(/\s+/g, ' ').slice(0, 160) : null, video: !!v, t: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v ? v.paused : null, muted: v ? v.muted : null, ready: v ? v.readyState : null }) })()`

async function attempt(mode) {
  const ses = session.defaultSession
  await ses.clearCache(); await ses.clearStorageData()
  let sent = null
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (mode !== 'none' && !headers.Referer && !headers.referer) headers.Referer = mode
    if (details.url.includes('/embed/')) sent = headers.Referer || headers.referer || '(none)'
    callback({ requestHeaders: headers })
  })
  const win = new BrowserWindow({ width: 820, height: 480, show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  await win.loadFile(page)
  let last = 'no frame'
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500))
    const frame = win.webContents.mainFrame.frames.find(item => /youtube/.test(item.url))
    if (!frame) continue
    try { last = await frame.executeJavaScript(PEEK) } catch (error) { last = `exec error: ${error.message}` }
    if (/"err":"/.test(last) || /"t":(4[3-9]|[5-7]\d)/.test(last)) break
  }
  console.log(`MODE ${mode} | embed Referer sent: ${sent} | ${last}`)
  win.destroy()
}

app.whenReady().then(async () => {
  for (const mode of MODES) await attempt(mode)
  app.quit()
})
