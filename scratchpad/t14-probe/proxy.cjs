const { app, session, net } = require('electron')
app.whenReady().then(async () => {
  for (const url of ['https://www.youtube.com/embed/6-8E4Nirh9s', 'https://api.anthropic.com/', 'https://www.google.com/']) {
    const proxy = await session.defaultSession.resolveProxy(url)
    let status
    try { const response = await net.fetch(url, { method: 'HEAD' }); status = response.status } catch (error) { status = `error ${error.message}` }
    console.log(`${url} → proxy: ${proxy} | fetch: ${status}`)
  }
  app.quit()
})
