// Live check of skills/task-completed-celebration in Electron: the page is served through an orbit-skill:// protocol like
// electron/main.cjs does, with main's Referer hook, inside a sandboxed frame like SkillStage. Usage:
//   node scripts/run-electron.cjs scratchpad/celebration-skill/live.cjs [query] [tag]
const { app, BrowserWindow, session, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SCHEME = 'orbit-skill'
const root = path.resolve(__dirname, '..', '..', 'skills')
const query = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'start=42&end=47'
const tag = process.argv[3] || 'run'
const out = path.join(__dirname, 'shots')
fs.mkdirSync(out, { recursive: true })
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

const PEEK = `(() => { const v = document.querySelector('video'); const e = document.querySelector('.ytp-error-content-wrap-reason, .ytp-error');
  return JSON.stringify({ err: e ? e.innerText.replace(/\s+/g, ' ').slice(0, 160) : null, t: v ? Math.round(v.currentTime * 10) / 10 : null, paused: v ? v.paused : null, muted: v ? v.muted : null }) })()`

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
    const referer = headers.Referer || headers.referer
    if (!referer || !/^https?:/i.test(referer)) { delete headers.referer; headers.Referer = 'https://orbit.local/' }
    callback({ requestHeaders: headers })
  })
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = path.join(root, url.hostname, decodeURIComponent(url.pathname))
    if (!file.startsWith(root) || !fs.existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' } })
  })
  const shown = process.env.LIVE_SHOW === '1'
  const win = new BrowserWindow({ width: 1280, height: 720, show: shown, ...(shown ? { x: 40, y: 40 } : {}),webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } })
  win.webContents.setAudioMuted(true) // the machine's speakers stay quiet; autoplay policy is what is under test
  const errors = []
  win.webContents.on('console-message', (_event, level, message, _line, source) => { if (level >= 2) errors.push(`[${level}] ${message.slice(0, 200)} (${String(source).slice(-40)})`) })
  const page = `${SCHEME}://task-completed-celebration/page.html?${query}`
  // No network for the player: every request to YouTube fails (enableNetworkEmulation did not stop the player in Electron 44).
  if (process.env.LIVE_OFFLINE === '1') session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*.youtube.com/*', 'https://*.ytimg.com/*', 'https://*.googlevideo.com/*', 'https://*.google.com/*'] }, (details, callback) => callback({ cancel: true }))
  const t0 = Date.now()
  await win.loadFile(path.join(__dirname, 'host.html'), { query: { page } })
  const frames = () => win.webContents.mainFrame.framesInSubtree
  const skill = () => frames().find(f => f.url.startsWith(`${SCHEME}://`))
  const youtube = () => frames().find(f => /youtube/.test(f.url))
  const sample = async (label) => {
    const page = skill()
    // rAF frames per second in the page: a hidden (show:false) window may be painted rarely, which slows the animation.
    const fps = page ? await page.executeJavaScript('new Promise(r=>{let n=0;const t=performance.now();const f=()=>{n++;performance.now()-t<1000?requestAnimationFrame(f):r(n)};requestAnimationFrame(f)})').catch(() => -1) : -1
    const st = page ? await page.executeJavaScript('JSON.stringify(window.celebrationState)').catch(e => `exec error ${e.message}`) : 'no skill frame'
    const yt = youtube()
    const v = yt ? await yt.executeJavaScript(PEEK).catch(e => `exec error ${e.message}`) : 'no youtube frame'
    const msgs = await win.webContents.executeJavaScript('JSON.stringify(window.__msgs)')
    console.log(`${label} fps=${fps} +${((Date.now() - t0) / 1000).toFixed(1)}s state=${st} video=${v} msgs=${msgs}`)
  }
  await wait(5000)
  // LIVE_ACT=esc|click: a key or a click on the page instead of waiting for the segment to end.
  if (process.env.LIVE_ACT) {
    await sample('before-act')
    const at = Date.now() - t0
    win.focus(); win.webContents.focus()
    await win.webContents.executeJavaScript("window.__hev=[];['click','mousedown','mousemove','keydown'].forEach(t=>addEventListener(t,e=>{ if(t!=='mousemove'||__hev.length<3)__hev.push(t+':'+(e.key||'')) },true))")
    await skill().executeJavaScript("window.__ev=[];['click','mousedown','keydown'].forEach(t=>addEventListener(t,e=>__ev.push(t+':'+(e.key||'')),true))")
    // Routing into an out-of-process frame needs a pointer position first.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 590, y: 290 })
    await wait(200)
    if (process.env.LIVE_CDP === '1') {
      // Real input through the DevTools protocol: hit-tested into the frame under the pointer like a user's click.
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      if (process.env.LIVE_ACT === 'esc') {
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      } else {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 590, y: 290 })
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 300, button: 'left', clickCount: 1 })
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 300, button: 'left', clickCount: 1 })
      }
    } else if (process.env.LIVE_ACT === 'esc') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    } else {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: 600, y: 300, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: 600, y: 300, button: 'left', clickCount: 1 })
    }
    await wait(800)
    console.log('host saw:', await win.webContents.executeJavaScript('JSON.stringify(window.__hev)'))
    console.log(`act ${process.env.LIVE_ACT} sent at +${at}ms; events seen by the page:${await skill().executeJavaScript('JSON.stringify(window.__ev)')}`)
    await sample('after-act')
  }
  await sample('A')
  console.log('shot A', JSON.stringify(await shot(win, `${tag}-A.png`)))
  await wait(1500)
  await sample('B')
  console.log('shot B', JSON.stringify(await shot(win, `${tag}-B.png`)))
  const limit = Number(process.env.LIVE_WAIT_MS || 14000)
  const until = Date.now() + limit
  while (Date.now() < until) {
    if ((await win.webContents.executeJavaScript('window.__msgs.length')) > 0) break
    await wait(250)
  }
  await sample('END')
  console.log('errors:', JSON.stringify(errors.slice(0, 8)))
  app.quit()
})
