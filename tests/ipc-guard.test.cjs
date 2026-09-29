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

test('every main-process IPC channel is registered through the sender guard', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.equal(source.split('ipcMain.handle(').length - 1, 1, 'only the guarded helper may call ipcMain.handle directly')
  assert.ok(source.includes('const handle = (channel, handler) => ipcMain.handle(channel, guard(handler))'))
  assert.doesNotMatch(source, /providers:ask/, 'the unguarded direct provider channel must stay removed')
})
