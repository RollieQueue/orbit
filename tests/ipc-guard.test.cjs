'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isTrustedOrbitUrl,
  assertOrbitIpcSender,
  guardIpc,
  contentSecurityPolicy,
} = require('../electron/ipc-guard.cjs')

test('trusted Orbit URLs accept only local renderer origins', () => {
  assert.equal(isTrustedOrbitUrl('http://127.0.0.1:5173/', { isDev: true }), true)
  assert.equal(isTrustedOrbitUrl('http://127.0.0.1:5173/index.html', { isDev: true }), true)
  assert.equal(isTrustedOrbitUrl('file:///C:/orbit/dist/index.html', { isDev: false }), true)
  assert.equal(isTrustedOrbitUrl('http://127.0.0.1:5173/', { isDev: false }), false)
  assert.equal(isTrustedOrbitUrl('http://evil.example/', { isDev: true }), false)
  assert.equal(isTrustedOrbitUrl('https://example.com', { isDev: true }), false)
  assert.equal(isTrustedOrbitUrl('', { isDev: true }), false)
})

test('assertOrbitIpcSender rejects foreign and destroyed senders', () => {
  assert.throws(
    () => assertOrbitIpcSender({ sender: { isDestroyed: () => true, getURL: () => 'file://x' } }, { isDev: false }),
    /Unauthorized IPC sender/,
  )
  assert.throws(
    () => assertOrbitIpcSender({
      sender: { isDestroyed: () => false, getURL: () => 'https://evil.example' },
      senderFrame: { url: 'https://evil.example' },
    }, { isDev: false }),
    /Unauthorized IPC origin/,
  )
  assert.doesNotThrow(() => assertOrbitIpcSender({
    sender: { isDestroyed: () => false, getURL: () => 'file:///C:/orbit/dist/index.html' },
    senderFrame: { url: 'file:///C:/orbit/dist/index.html', parent: null },
  }, { isDev: false }))
  assert.throws(() => assertOrbitIpcSender({
    sender: { isDestroyed: () => false, getURL: () => 'file:///C:/orbit/dist/index.html' },
    senderFrame: { url: 'file:///C:/orbit/dist/other.html', parent: { url: 'file:///C:/orbit/dist/index.html' } },
  }, { isDev: false }), /Unauthorized IPC frame/)
})

test('guardIpc blocks before invoking the handler', async () => {
  let called = false
  const wrapped = guardIpc(() => {
    called = true
    return 'ok'
  }, { isDev: false })
  await assert.rejects(
    async () => wrapped({ sender: { isDestroyed: () => false, getURL: () => 'https://evil.example' } }),
    /Unauthorized IPC origin/,
  )
  assert.equal(called, false)
  const value = wrapped({
    sender: { isDestroyed: () => false, getURL: () => 'file:///app/index.html' },
    senderFrame: { url: 'file:///app/index.html' },
  })
  assert.equal(value, 'ok')
  assert.equal(called, true)
})

test('CSP disables remote script sources in production', () => {
  const prod = contentSecurityPolicy({ isDev: false })
  assert.match(prod, /default-src 'self'/)
  assert.match(prod, /script-src 'self'/)
  assert.doesNotMatch(prod, /unsafe-eval/)
  assert.doesNotMatch(prod, /https:/)
  const dev = contentSecurityPolicy({ isDev: true })
  assert.match(dev, /127\.0\.0\.1:5173/)
})

test('CSP lets the window show package images (orbit-skill:) and widens nothing else', () => {
  for (const isDev of [false, true]) {
    const directives = new Map(contentSecurityPolicy({ isDev }).split('; ').map(item => [item.split(' ')[0], item.split(' ').slice(1)]))
    assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'orbit-skill:'])
    for (const name of ['default-src', 'script-src', 'style-src', 'font-src', 'connect-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      assert.ok(!directives.get(name)?.includes('orbit-skill:'), `${name} must not allow orbit-skill: (isDev=${isDev})`)
    }
    assert.equal(directives.has('frame-src'), false)
    assert.equal(directives.has('object-src'), false)
  }
  assert.equal(contentSecurityPolicy({ isDev: false }).includes("script-src 'self';"), true)
  assert.equal(contentSecurityPolicy({ isDev: false }).includes("connect-src 'self';"), true)
  assert.equal(contentSecurityPolicy({ isDev: true }).includes("script-src 'self' 'unsafe-inline';"), true)
  assert.match(contentSecurityPolicy({ isDev: true }), /connect-src 'self' http:\/\/127\.0\.0\.1:5173 ws:\/\/127\.0\.0\.1:5173 ws:\/\/127\.0\.0\.1:\* http:\/\/127\.0\.0\.1:\*;/)
})

test('every main-process IPC channel is registered through the sender guard', () => {
  const read = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'electron', file), 'utf8')
  const handlers = read('ipc-handlers.cjs')
  const main = read('main.cjs')
  assert.equal(handlers.split('ipcMain.handle(').length - 1, 1, 'only registerIpcHandlers may call ipcMain.handle directly')
  assert.ok(handlers.includes('ipcMain.handle(channel, guardIpc(handler, { isDev }))'), 'the one registration wraps every handler in the sender guard')
  assert.equal(main.split('ipcMain.handle(').length - 1, 0, 'main.cjs registers channels only through electron/ipc-handlers.cjs')
  assert.ok(main.includes('registerIpcHandlers(ipcMain, createIpcHandlers('), 'main.cjs wires the handler map through the guarded registration')
  for (const source of [handlers, main]) assert.doesNotMatch(source, /providers:ask/, 'the unguarded direct provider channel must stay removed')
})
