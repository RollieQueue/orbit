const test = require('node:test')
const assert = require('node:assert/strict')
const { envProxyConfig, followEnvProxy, PROBE_URLS } = require('../electron/window-proxy.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// The environment as Orbit's window reads it. Plain objects stand for it: on Windows process.env ignores the case of
// a name, so either case must work, and the lower one wins as in curl.
test('the window\'s proxy comes from HTTP(S)_PROXY, ALL_PROXY and NO_PROXY as curl reads them', () => {
  const proxy = 'http://127.0.0.1:12334'
  assert.deepEqual(envProxyConfig({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy }), {
    mode: 'fixed_servers', proxyRules: `http=${proxy},direct://;https=${proxy},direct://`, proxyBypassRules: '',
  })
  for (const env of [{}, { HTTPS_PROXY: '  ' }, { NO_PROXY: 'example.com' }]) assert.equal(envProxyConfig(env), null, JSON.stringify(env))
  // ALL_PROXY covers a scheme without its own variable; the lower-case name wins over the upper-case one.
  assert.equal(envProxyConfig({ https_proxy: 'http://low:1', HTTPS_PROXY: 'http://up:2', ALL_PROXY: 'socks5h://all:1080' }).proxyRules,
    'http=socks5://all:1080,direct://;https=http://low:1,direct://')
  assert.equal(envProxyConfig({ HTTPS_PROXY: '127.0.0.1:12334/' }).proxyRules, 'https=http://127.0.0.1:12334,direct://', 'no scheme is http, the slash goes')
  assert.equal(envProxyConfig({ HTTPS_PROXY: 'http://[::1]:3128' }).proxyRules, 'https=http://[::1]:3128,direct://')
  // A value Chromium cannot use names no proxy for its scheme, and ALL_PROXY does not stand in for it.
  for (const value of ['http://user:secret@proxy:3128', 'http://proxy:3128/path', 'ftp://proxy:21', 'socks://proxy:1080', 'http://proxy:3128/?a=1', 'constructor://proxy:1']) {
    assert.equal(envProxyConfig({ HTTPS_PROXY: value, ALL_PROXY: 'http://all:1' })?.proxyRules, 'http=http://all:1,direct://', value)
  }
  // NO_PROXY: a name covers its subdomains, a bare IPv6 address gets brackets, addresses, ranges and ports stay.
  assert.equal(envProxyConfig({ HTTPS_PROXY: proxy, no_proxy: 'localhost, 127.0.0.1,::1 ,.corp.example,*.lan.example,dot.example.,10.0.0.0/8,host:8080,[fe80::1],::1/128' }).proxyBypassRules,
    'localhost,*.localhost,127.0.0.1,[::1],corp.example,*.corp.example,lan.example,*.lan.example,dot.example,*.dot.example,10.0.0.0/8,host:8080,[fe80::1],::1/128')
  assert.equal(envProxyConfig({ HTTPS_PROXY: proxy, NO_PROXY: 'example.com,*' }), null, 'NO_PROXY=* reaches every host directly')
})

// A fake of the two sessions: the system's answers `route` (or route(url), or throws it), the window's records what it is
// set to. `asked` counts the checks (each asks about every probe URL once), `urls` the addresses asked.
function sessions(route) {
  const state = { route, asked: 0, urls: [], created: 0, set: [], failSet: null, hold: null }
  const system = () => {
    state.created++
    return {
      resolveProxy: async (url) => {
        state.urls.push(url)
        if (url === PROBE_URLS[0]) state.asked++
        if (state.hold) await state.hold
        if (state.route instanceof Error) throw state.route
        return typeof state.route === 'function' ? state.route(url) : state.route
      },
    }
  }
  const target = { setProxy: async (config) => { if (state.failSet) throw state.failSet; state.set.push(config) } }
  return { state, system, target }
}

test('the window follows the environment\'s proxy only while the system has none, and the system\'s again once it has one', async () => {
  const config = envProxyConfig({ HTTPS_PROXY: 'http://127.0.0.1:12334' })
  const logs = []
  const { state, system, target } = sessions('DIRECT')
  const follower = followEnvProxy({ target, system, config, log: text => logs.push(text), intervalMs: 60000 })
  try {
    await follower.check()
    assert.deepEqual(state.set, [config], 'the system sends YouTube directly: the environment\'s proxy')
    assert.deepEqual(state.urls, [...PROBE_URLS], 'every host of the video player is asked about')
    assert.ok(PROBE_URLS.some(url => url.includes('googlevideo.com')) && PROBE_URLS.some(url => url.includes('ytimg.com')))
    await follower.check()
    assert.equal(state.set.length, 1, 'nothing changed, nothing set')
    state.route = 'PROXY 10.0.0.1:8080; DIRECT'
    await follower.check()
    assert.deepEqual(state.set, [config, { mode: 'system' }], 'a system proxy (its first entry) wins')
    state.route = 'direct'
    await follower.check()
    assert.deepEqual(state.set, [config, { mode: 'system' }, config])
    // A PAC file that sends only the video streams through a proxy: the system's route stays for the whole window.
    state.route = url => (url.includes('googlevideo.com') ? 'PROXY 10.0.0.9:8080' : 'DIRECT')
    await follower.check()
    assert.deepEqual(state.set, [config, { mode: 'system' }, config, { mode: 'system' }], 'one host with a system proxy is enough')
    assert.equal(logs.length, 4)
    assert.match(logs[0], /127\.0\.0\.1:12334/)
    // No answer from the system, or a window session that refuses: the window stays as it is and the next check retries.
    state.route = 'DIRECT'
    state.failSet = new Error('refused')
    await follower.check()
    state.failSet = null
    state.route = new Error('no network service')
    await follower.check()
    assert.equal(state.set.length, 4)
    assert.deepEqual(logs.slice(4).map(text => /stays as it was/.test(text)), [true, true])
    state.route = 'DIRECT'
    await follower.check()
    assert.deepEqual(state.set.at(-1), config)
  } finally {
    follower.stop()
  }
})

test('the system is asked again on a timer, one question at a time; without an environment proxy never', async () => {
  const config = envProxyConfig({ HTTP_PROXY: 'http://127.0.0.1:12334' })
  const { state, system, target } = sessions('PROXY 10.0.0.1:8080')
  let release
  state.hold = new Promise(resolve => { release = resolve })
  const until = async (check, label) => {
    const deadline = Date.now() + 5000
    while (!check()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await delay(5) }
  }
  const follower = followEnvProxy({ target, system, config, intervalMs: 5 })
  try {
    await delay(40)
    assert.equal(state.asked, 1, 'a slow answer does not pile the next questions up')
    release()
    state.hold = null
    await until(() => state.asked >= 3, 'asked again')
    assert.deepEqual(state.set, [], 'the system has a proxy: the window keeps it')
    state.route = 'DIRECT'
    await until(() => state.set.length === 1, 'the switch seen')
    assert.deepEqual(state.set, [config], 'the switch is seen without a call from outside')
  } finally {
    follower.stop()
  }
  const asked = state.asked
  await delay(30)
  assert.equal(state.asked, asked, 'stop ends the checks')
  const none = sessions('DIRECT')
  const idle = followEnvProxy({ target: none.target, system: none.system, config: null, intervalMs: 5 })
  await idle.check()
  await delay(20)
  idle.stop()
  assert.deepEqual([none.state.created, none.state.asked, none.state.set], [0, 0, []], 'no session is made, nothing is set')
})
