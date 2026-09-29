'use strict'

function isTrustedOrbitUrl(url, { isDev = false } = {}) {
  if (!url || typeof url !== 'string') return false
  if (isDev && /^http:\/\/127\.0\.0\.1:5173(?:\/|\?|#|$)/.test(url)) return true
  if (url.startsWith('file:')) return true
  return false
}

function assertOrbitIpcSender(event, { isDev = false } = {}) {
  const sender = event?.sender
  if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
    throw new Error('Unauthorized IPC sender')
  }
  // Orbit's window has no iframes: a call from a nested frame is never legitimate, whatever its URL.
  if (event.senderFrame?.parent) throw new Error('Unauthorized IPC frame')
  const url = event.senderFrame?.url || (typeof sender.getURL === 'function' ? sender.getURL() : '') || ''
  if (!isTrustedOrbitUrl(url, { isDev })) {
    throw new Error(`Unauthorized IPC origin: ${url || '(empty)'}`)
  }
}

function guardIpc(handler, options = {}) {
  return (event, ...args) => {
    assertOrbitIpcSender(event, options)
    return handler(event, ...args)
  }
}

function contentSecurityPolicy({ isDev = false } = {}) {
  if (isDev) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173 ws://127.0.0.1:* http://127.0.0.1:*",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

module.exports = {
  isTrustedOrbitUrl,
  assertOrbitIpcSender,
  guardIpc,
  contentSecurityPolicy,
}
