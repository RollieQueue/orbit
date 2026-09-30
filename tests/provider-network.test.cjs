const test = require('node:test')
const assert = require('node:assert/strict')
const { proxyEnvironment, systemProxy, setProxyResolver, PROXY_PROBE_URL } = require('../electron/provider-network.mts')
const { _testing: { runCli } } = require('../electron/providers.mts')

test('proxy modes are process-scoped and explicit routes override inherited bypasses', async () => {
  const env = await proxyEnvironment({}, async () => 'http://127.0.0.1:12334')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12334')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.deepEqual(await proxyEnvironment({ proxyMode: 'inherit' }), {})
  assert.deepEqual(await proxyEnvironment({}, async () => ''), {})
  assert.equal((await proxyEnvironment({ proxyMode: 'direct' })).HTTPS_PROXY, '')
  await assert.rejects(proxyEnvironment({ proxyMode: 'custom', proxyUrl: 'http://user:secret@localhost:1234' }), /HTTP/)
  await assert.rejects(proxyEnvironment({ proxyMode: 'custom', proxyUrl: 'socks5://localhost:1234' }), /HTTP/)
  const result = await runCli(process.execPath, ['-e', 'console.log(process.env.HTTPS_PROXY)'], { env, timeoutMs: 5000 })
  assert.equal(result.stdout.trim(), env.HTTPS_PROXY)
})

// The runtime child process has no Electron session: it installs a resolver that asks main (runtime-child.cjs), and
// systemProxy asks that first, parses its route as it parses Electron's, and falls back as before when it cannot tell.
test('the system proxy comes from an installed resolver first; a route is parsed as Electron\'s, no answer falls back', async () => {
  // The last source (the Windows registry) is replaced, so the answer does not depend on this machine or on how fast
  // reg.exe starts under load; plain Node has no Electron session, so the fallback reaches it.
  const fallback = 'http://fallback.example:1'
  const registry = async () => fallback
  const asked = []
  try {
    setProxyResolver(async (url) => { asked.push(url); return 'PROXY 10.0.0.5:3128; DIRECT' })
    assert.equal(await systemProxy(registry), 'http://10.0.0.5:3128')
    assert.deepEqual(asked, [PROXY_PROBE_URL])
    setProxyResolver(async () => 'HTTPS proxy.example:8443; PROXY other:1')
    assert.equal(await systemProxy(registry), 'https://proxy.example:8443', 'the first entry wins')
    setProxyResolver(async () => 'DIRECT')
    assert.equal(await systemProxy(registry), '', 'DIRECT is an answer: no proxy, and no fallback')
    setProxyResolver(async () => null)
    assert.equal(await systemProxy(registry), fallback, 'no answer: the same sources as without a resolver')
    setProxyResolver(async () => { throw new Error('main is gone') })
    assert.equal(await systemProxy(registry), fallback, 'a failing resolver falls back as well')
    setProxyResolver(async () => 'PROXY user:secret@10.0.0.5:3128')
    assert.equal(await systemProxy(registry), fallback, 'a route that is no usable proxy URL falls back, as a bad Electron answer does')
    setProxyResolver(async () => 'PROXY 10.0.0.5:3128')
    const env = await proxyEnvironment({})
    assert.deepEqual([env.HTTPS_PROXY, env.NO_PROXY], ['http://10.0.0.5:3128', 'localhost,127.0.0.1,::1'], 'the "system" proxy mode uses it')
  } finally {
    setProxyResolver(null)
  }
  assert.equal(await systemProxy(registry), fallback, 'without a resolver the behaviour is unchanged')
})
