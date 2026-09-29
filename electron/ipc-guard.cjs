// @ts-check
'use strict'

/**
 * What the guard reads from an IPC event. Electron's IpcMainInvokeEvent and IpcMainEvent satisfy it (sender is the
 * WebContents, senderFrame the WebFrameMain or null); the tests pass plain objects of this shape.
 * @typedef {object} IpcSenderEvent
 * @property {{ isDestroyed?: () => boolean, getURL?: () => string } | null} [sender]
 * @property {{ url?: string, parent?: unknown } | null} [senderFrame]
 */
/** @typedef {{ isDev?: boolean }} GuardOptions */

/**
 * Only Orbit's own renderer origins: the Vite dev server in development, file: URLs (dist/index.html, packaged or not).
 * @param {unknown} url
 * @param {GuardOptions} [options]
 * @returns {boolean}
 */
function isTrustedOrbitUrl(url, { isDev = false } = {}) {
  if (!url || typeof url !== 'string') return false
  if (isDev && /^http:\/\/127\.0\.0\.1:5173(?:\/|\?|#|$)/.test(url)) return true
  if (url.startsWith('file:')) return true
  return false
}

/**
 * Throws unless `event` comes from Orbit's own window: a live sender, the top frame, a trusted URL.
 * @param {IpcSenderEvent} event
 * @param {GuardOptions} [options]
 * @returns {void}
 */
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

/**
 * Wraps an ipcMain handler so the sender check runs before it; the handler's signature is kept.
 * @template {IpcSenderEvent} E
 * @template {unknown[]} A
 * @template R
 * @param {(event: E, ...args: A) => R} handler
 * @param {GuardOptions} [options]
 * @returns {(event: E, ...args: A) => R}
 */
function guardIpc(handler, options = {}) {
  return (event, ...args) => {
    assertOrbitIpcSender(event, options)
    return handler(event, ...args)
  }
}

/** @param {GuardOptions} [options] @returns {string} */
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
