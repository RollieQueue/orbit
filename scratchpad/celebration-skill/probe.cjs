// What YouTube's embedded player itself shows for a video, with main's Referer rule (non-http Referer -> PROBE_REFERER).
//   node scripts/run-electron.cjs scratchpad/celebration-skill/probe.cjs <videoId> [host]
const { app, BrowserWindow, session } = require('electron')

const id = process.argv[2] || '6-8E4Nirh9s'
const host = process.argv[3] || 'www.youtube.com'
const referer = process.env.PROBE_REFERER || 'https://orbit.local/'
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube.com/*', 'https://www.youtube-nocookie.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders
    const current = headers.Referer || headers.referer
    if (!current || !/^https?:/i.test(current)) { delete headers.referer; headers.Referer = referer }
    callback({ requestHeaders: headers })
  })
  const win = new BrowserWindow({ width: 960, height: 540, show: false, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  const src = `https://${host}/embed/${id}?autoplay=1&start=13&end=73&controls=0&rel=0&playsinline=1&enablejsapi=1`
  const page = `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe src="${src}" style="border:0;width:100vw;height:100vh" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  await wait(Number(process.env.PROBE_WAIT_MS || 9000))
  const frame = win.webContents.mainFrame.framesInSubtree.find(f => /youtube/.test(f.url))
  const seen = frame
    ? await frame.executeJavaScript(`JSON.stringify({ text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 220),
        video: (() => { const v = document.querySelector('video'); return v ? { t: Math.round(v.currentTime * 10) / 10, paused: v.paused, src: !!v.src } : null })() })`).catch(e => `exec error ${e.message}`)
    : 'no youtube frame'
  console.log(`PROBE id=${id} host=${host} referer=${referer} -> ${seen}`)
  app.quit()
})
