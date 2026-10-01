// The "task completed" celebration page: the YouTube segment full window, confetti, and the text turning around its own
// axis while it flies over the screen like the DVD logo. Orbit shows the page in a frame when a task completes and the
// page asks the host to close it: postMessage({type:'orbit-skill:close'}). Parameters come from the address (?video=&start=&end=&text=&confetti=).
(function () {
  'use strict'

  var DEFAULTS = { video: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', start: 42, end: 73, text: 'TASK COMPLETED', confetti: true }
  var NO_VIDEO_MS = 12000        // how long confetti and text alone stay when there is no video
  var PLAYER_WAIT_MS = 15000     // the player must start playing within this, else the page goes on without it
  var CLOSE_SLACK_MS = 5000      // fallback timer: the segment's length plus this
  var MAX_SEGMENT_S = 580
  var HUE_STEP = 67
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var stage = document.getElementById('stage')
  var state = { video: 'none', time: null, playerState: null, closed: false, hits: 0 }
  window.celebrationState = state // read by the live check of this page

  // ---- parameters -------------------------------------------------------------------------------------------------
  function seconds(value, fallback) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback
    var text = String(value).trim().toLowerCase().replace(/s$/, '')
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
    var parts = text.split(':')
    if (parts.length < 2 || parts.length > 3 || !parts.every(function (part) { return /^\d+$/.test(part) })) return fallback
    return parts.reduce(function (total, part) { return total * 60 + Number(part) }, 0)
  }

  // The player address is built from the 11-character video id alone, never from the link itself.
  function videoId(link) {
    var text = String(link || '').trim()
    if (/^[\w-]{11}$/.test(text)) return text
    var url
    try { url = new URL(text) } catch (error) { return null }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    var host = url.hostname.replace(/^(www|m|music)\./, '')
    var id = null
    if (host === 'youtu.be') id = url.pathname.split('/')[1]
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      var match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)
      id = match ? match[1] : url.pathname === '/watch' ? url.searchParams.get('v') : null
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null
  }

  function readParams() {
    var query = new URLSearchParams(location.search)
    var start = seconds(query.get('start'), DEFAULTS.start)
    var end = seconds(query.get('end'), DEFAULTS.end)
    if (!(end > start)) end = start + 30
    if (end - start > MAX_SEGMENT_S) end = start + MAX_SEGMENT_S
    var text = (query.get('text') || '').trim().slice(0, 80) || DEFAULTS.text
    var confetti = query.has('confetti') ? !/^(false|0|no|off)$/i.test(query.get('confetti')) : DEFAULTS.confetti
    var link = query.has('video') ? query.get('video') : DEFAULTS.video
    return { id: videoId(link), start: start, end: end, text: text, confetti: confetti }
  }

  var params = readParams()

  // ---- closing ----------------------------------------------------------------------------------------------------
  var timers = []
  var stops = []
  function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id }

  function close() {
    if (state.closed) return
    state.closed = true
    state.closedAt = Date.now()
    timers.forEach(clearTimeout)
    stops.forEach(function (stop) { try { stop() } catch (error) { /* stopping must not fail */ } })
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'orbit-skill:close' }, '*')
    else window.close()
  }

  window.addEventListener('keydown', function (event) { if (event.key === 'Escape') close() }, true)
  document.getElementById('catcher').addEventListener('click', close)
  window.focus() // so that Esc reaches the page, not only the host

  // ---- the video --------------------------------------------------------------------------------------------------
  var frame = document.getElementById('video')
  var fallbackTimer = 0
  var playedOnce = false

  // The player frame is dropped and the page goes on with confetti and text alone.
  function giveUpVideo(reason) {
    if (state.closed || state.video === 'none') return
    state.video = 'none'
    state.videoIssue = reason
    frame.hidden = true
    frame.removeAttribute('src')
    clearTimeout(fallbackTimer)
    later(close, NO_VIDEO_MS)
  }

  function armFallback(ms) { clearTimeout(fallbackTimer); fallbackTimer = later(close, ms) }

  function startVideo() {
    if (!params.id) { state.video = 'none'; state.videoIssue = 'invalid link'; later(close, NO_VIDEO_MS); return }
    if (navigator.onLine === false) { state.video = 'none'; state.videoIssue = 'offline'; later(close, NO_VIDEO_MS); return }
    var query = 'autoplay=1&start=' + Math.floor(params.start) + '&end=' + Math.ceil(params.end) +
      '&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&modestbranding=1&enablejsapi=1'
    frame.src = 'https://www.youtube.com/embed/' + encodeURIComponent(params.id) + '?' + query
    frame.hidden = false
    state.video = 'loading'
    var length = (params.end - params.start) * 1000
    armFallback(length + CLOSE_SLACK_MS + PLAYER_WAIT_MS)
    later(function () { if (!playedOnce) giveUpVideo('the player did not start') }, PLAYER_WAIT_MS)

    // The player speaks the iframe API over postMessage; asking "listening" repeatedly until it answers is the documented handshake.
    function listen() {
      if (state.closed || !frame.contentWindow) return
      frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'orbit-celebration', channel: 'widget' }), '*')
      ;['onStateChange', 'onError'].forEach(function (name) {
        frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: [name], id: 'orbit-celebration', channel: 'widget' }), '*')
      })
    }
    frame.addEventListener('load', listen)
    var handshake = setInterval(function () { if (state.heard || state.closed) clearInterval(handshake); else listen() }, 500)
    stops.push(function () { clearInterval(handshake) })

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || typeof event.data !== 'string') return
      var data
      try { data = JSON.parse(event.data) } catch (error) { return }
      state.heard = true
      var info = data && data.info
      if (data.event === 'onError') { giveUpVideo('player error ' + info); return }
      var playerState = data.event === 'onStateChange' ? info : info && typeof info === 'object' ? info.playerState : undefined
      if (info && typeof info === 'object' && typeof info.currentTime === 'number') state.time = info.currentTime
      if (typeof playerState !== 'number') return
      state.playerState = playerState
      if (playerState === 1 && !playedOnce) {
        // Playing: the segment's remaining length (plus slack) now bounds the page, not the time the player took to load.
        playedOnce = true
        state.video = 'playing'
        armFallback(Math.max(1000, (params.end - Math.max(state.time || 0, params.start)) * 1000) + CLOSE_SLACK_MS)
      }
      // 0 = ended. The player stops at `end` by itself, so the segment's end is the player's end.
      if (playerState === 0 && playedOnce) { state.video = 'ended'; later(close, 400) }
    })
  }

  // ---- the text ---------------------------------------------------------------------------------------------------
  function startText() {
    var flyer = document.getElementById('flyer')
    var words = document.getElementById('words')
    params.text.split(/\s+/).filter(Boolean).forEach(function (word) {
      var span = document.createElement('span')
      span.className = 'word'
      span.textContent = word
      words.appendChild(span)
    })
    var longest = params.text.split(/\s+/).reduce(function (max, word) { return Math.max(max, word.length) }, 4)
    // The longest word takes about a third of the window's width; very short texts stay modest, long ones shrink.
    var fit = function () { flyer.style.fontSize = Math.max(24, Math.min(window.innerWidth * 0.11, (window.innerWidth * 0.36) / (longest * 0.6))) + 'px' }
    fit()
    window.addEventListener('resize', fit)
    stops.push(function () { window.removeEventListener('resize', fit) })
    if (reduced) { holdText(flyer); return }

    var speed = Math.max(0.15, window.innerWidth / 8000)
    var angle = (20 + Math.random() * 50) * (Math.PI / 180)
    var x = Math.random() * window.innerWidth * 0.4
    var y = Math.random() * window.innerHeight * 0.3
    var vx = Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1)
    var vy = Math.sin(angle) * speed * (Math.random() < 0.5 ? -1 : 1)
    var hue = 0
    var last = performance.now()
    var frameId = 0
    // The turning text sweeps a circle, so the bounce box is a square around it and the text never leaves the screen.
    function axis(position, velocity, size, limit, dt) {
      var next = position + velocity * dt
      var room = Math.max(0, limit - size)
      if (next < 0) return { p: Math.min(-next, room), v: Math.abs(velocity), hit: true }
      if (next > room) return { p: Math.max(2 * room - next, 0), v: -Math.abs(velocity), hit: true }
      return { p: next, v: velocity, hit: false }
    }
    function step(dt) {
      var width = flyer.offsetWidth
      var height = flyer.offsetHeight
      var side = Math.hypot(width, height) * 0.85
      var nx = axis(x, vx, side, window.innerWidth, dt)
      var ny = axis(y, vy, side, window.innerHeight, dt)
      x = nx.p; vx = nx.v; y = ny.p; vy = ny.v
      flyer.style.transform = 'translate3d(' + (x + (side - width) / 2) + 'px,' + (y + (side - height) / 2) + 'px,0)'
      state.textX = Math.round(x); state.textY = Math.round(y)
      if (nx.hit || ny.hit) { hue += HUE_STEP; state.hits++; flyer.style.filter = 'hue-rotate(' + hue + 'deg)' }
    }
    function tick(time) {
      // A long pause (a hidden frame) must not throw the text across the screen.
      step(Math.min(48, time - last))
      last = time
      frameId = requestAnimationFrame(tick)
    }
    step(0)
    frameId = requestAnimationFrame(tick)
    stops.push(function () { cancelAnimationFrame(frameId) })
  }

  // Reduced motion: the text stands still in the middle of the window (celebration.css stops its turn and pulse).
  function holdText(flyer) {
    function centre() {
      var x = Math.max(0, (window.innerWidth - flyer.offsetWidth) / 2)
      var y = Math.max(0, (window.innerHeight - flyer.offsetHeight) / 2)
      flyer.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'
      state.textX = Math.round(x); state.textY = Math.round(y)
    }
    centre()
    window.addEventListener('resize', centre)
    stops.push(function () { window.removeEventListener('resize', centre) })
  }

  // ---- confetti ---------------------------------------------------------------------------------------------------
  function startConfetti() {
    var canvas = document.getElementById('confetti')
    var context = canvas.getContext('2d')
    if (!context) return
    var COLORS = ['#ff3b6b', '#ffb400', '#2ee6a6', '#39a0ff', '#b45cff', '#ff7a2f', '#f5ff3d', '#ffffff']
    var EMOJI = ['🎉', '🥳', '🦆', '🍕', '🌈', '⭐', '💾', '🚀', '🎊', '🐸', '🍩', '🦄', '💃', '🔥', '👾']
    var MAX_PIECES = 420
    var BURST_PIECES = 180
    var RAIN_PER_SECOND = 70
    var GRAVITY = 0.00042
    var DRAG = 0.0012
    var width = 0, height = 0, ratio = 1

    var between = function (low, high) { return low + Math.random() * (high - low) }
    var pick = function (items) { return items[Math.floor(Math.random() * items.length)] }
    var scale = function () { return Math.min(1.6, Math.max(0.8, width / 1200)) }

    function resize() {
      ratio = window.devicePixelRatio || 1
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    resize()
    window.addEventListener('resize', resize)

    function makePiece(px, py, pvx, pvy) {
      var emoji = Math.random() < 0.28 ? pick(EMOJI) : undefined
      return {
        x: px, y: py, vx: pvx, vy: pvy, angle: between(0, Math.PI * 2), spin: between(-0.012, 0.012),
        phase: between(0, Math.PI * 2), flutter: between(0.004, 0.009), emoji: emoji, color: pick(COLORS),
        size: (emoji ? between(22, 40) : between(8, 16)) * scale(), shape: pick(['rect', 'rect', 'strip', 'circle']),
      }
    }

    // Reduced motion: no burst and no rain. The pieces lie still along the edges of the window, drawn once (and again when
    // it is resized), so the middle and the video stay clear.
    if (reduced) {
      var lay = function () {
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        context.clearRect(0, 0, width, height)
        var band = Math.min(width, height) * 0.14
        var count = Math.round(Math.min(200, Math.max(40, (width + height) / 20)))
        for (var n = 0; n < count; n++) {
          var across = Math.random() < width / (width + height)
          var px = across ? between(0, width) : Math.random() < 0.5 ? between(0, band) : between(width - band, width)
          var py = !across ? between(0, height) : Math.random() < 0.5 ? between(0, band) : between(height - band, height)
          draw(makePiece(px, py, 0, 0))
        }
        state.pieces = count
      }
      lay()
      window.addEventListener('resize', lay)
      stops.push(function () { window.removeEventListener('resize', resize); window.removeEventListener('resize', lay) })
      return
    }

    // Two cannons in the bottom corners and one in the middle shoot the first pieces up and inwards.
    var cannons = [{ x: 0, dir: 1 }, { x: width, dir: -1 }, { x: width / 2, dir: 0 }]
    var pieces = []
    for (var index = 0; index < BURST_PIECES; index++) {
      var cannon = cannons[index % cannons.length]
      var power = between(0.6, 1.5) * Math.min(1, Math.max(0.6, height / 800))
      var aim = cannon.dir === 0 ? between(-0.6, 0.6) : between(0.25, 0.95) * cannon.dir
      pieces.push(makePiece(cannon.x, height, Math.sin(aim) * power, -Math.cos(aim) * power))
    }

    function draw(piece) {
      context.save()
      context.translate(piece.x, piece.y)
      context.rotate(piece.angle)
      if (piece.emoji) {
        context.font = piece.size + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(piece.emoji, 0, 0)
      } else {
        // A piece of paper turns around its own edge: its height follows the cosine of the flip phase.
        context.scale(1, Math.cos(piece.phase))
        context.fillStyle = piece.color
        if (piece.shape === 'circle') { context.beginPath(); context.arc(0, 0, piece.size / 2, 0, Math.PI * 2); context.fill() }
        else if (piece.shape === 'strip') context.fillRect(-piece.size / 2, -piece.size / 6, piece.size, piece.size / 3)
        else context.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.7)
      }
      context.restore()
    }

    var last = performance.now()
    var rain = 0
    var frameId = 0
    function tick(time) {
      var dt = Math.min(48, time - last) // a long pause must not throw the pieces across the screen
      last = time
      rain += (RAIN_PER_SECOND * dt) / 1000
      while (rain >= 1) {
        rain -= 1
        if (pieces.length < MAX_PIECES) pieces.push(makePiece(between(0, width), -40, between(-0.08, 0.08), between(0.02, 0.12)))
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      for (var i = 0; i < pieces.length; i++) {
        var piece = pieces[i]
        piece.vy += GRAVITY * dt
        // Air resistance caps the fall speed, the sway makes the paper flutter from side to side.
        piece.vx -= piece.vx * DRAG * dt
        piece.vy -= Math.max(0, piece.vy - 0.16) * DRAG * 6 * dt
        piece.phase += piece.flutter * dt * 2.4
        piece.x += (piece.vx + Math.sin(piece.phase) * 0.05) * dt
        piece.y += piece.vy * dt
        piece.angle += piece.spin * dt
        draw(piece)
      }
      pieces = pieces.filter(function (piece) { return piece.y < height + 60 && piece.x > -80 && piece.x < width + 80 })
      state.pieces = pieces.length
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    stops.push(function () { cancelAnimationFrame(frameId); window.removeEventListener('resize', resize) })
  }

  // One part failing must not take the others down.
  function safely(fn) { try { fn() } catch (error) { state.error = String(error && error.message || error) } }
  if (params.confetti) safely(startConfetti)
  else document.getElementById('confetti').hidden = true
  safely(startText)
  safely(startVideo)
})()
