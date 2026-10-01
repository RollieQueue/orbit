// @ts-check
'use strict'

// The window's way to the web when the system has none. Chromium takes its proxy from the system settings only (on
// Windows and macOS it never reads HTTP(S)_PROXY), while the agents' CLIs go through the proxy those variables name.
// With the system proxy off and the web reachable only through that proxy (a DNS that does not answer for YouTube), a
// skill page's video failed with ERR_NAME_NOT_RESOLVED while the agents worked. So while the system sends the probe
// URLs directly, the window's session uses the environment's proxy; a system proxy (PAC included) still wins.

/** @typedef {import('electron').ProxyConfig} ProxyConfig */
/** @typedef {{ resolveProxy: (url: string) => Promise<string> }} SystemSession a session left on the system's settings */
/** @typedef {{ setProxy: (config: ProxyConfig) => Promise<void> }} WindowSession the window's session */
/** @typedef {{ check: () => Promise<void>, stop: () => void }} ProxyFollower */

/**
 * What the system is asked about: the hosts of the video player, the window's own web traffic. A system route through a
 * proxy for any of them (a PAC file that sends only the video streams through one) keeps the window on the system's.
 */
const PROBE_URLS = Object.freeze(['https://www.youtube.com/', 'https://www.youtube-nocookie.com/', 'https://i.ytimg.com/', 'https://redirector.googlevideo.com/', 'https://www.google.com/'])
/** How often the system is asked again: its proxy can be switched on and off while Orbit runs. */
const RECHECK_MS = 30000
/** Chromium's scheme for each proxy scheme curl knows (Chromium's socks5 resolves names on the proxy, as socks5h does). */
const SCHEMES = new Map([['http', 'http'], ['https', 'https'], ['socks4', 'socks4'], ['socks5', 'socks5'], ['socks5h', 'socks5']])

/**
 * A proxy variable's value as a Chromium proxy URL ("http://127.0.0.1:12334"), '' when it is not one Chromium can use:
 * a user name or password (Chromium would ask for them, and Orbit has no prompt), a path, another scheme. Without a port
 * the scheme's default applies, as in the agents' Node and Rust clients (curl alone assumes 1080).
 * @param {string} value
 * @returns {string}
 */
function chromiumProxy(value) {
  let url
  try { url = new URL(value.includes('://') ? value : `http://${value}`) } catch { return '' }
  const scheme = SCHEMES.get(url.protocol.slice(0, -1))
  if (!scheme || !url.hostname || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) return ''
  return `${scheme}://${url.host}`
}

/**
 * NO_PROXY as Chromium bypass rules, null when it names every host ('*'). A name covers its subdomains too, as curl
 * reads it; Chromium never proxies loopback addresses anyway.
 * @param {string} value
 * @returns {string[] | null}
 */
function bypassRules(value) {
  const entries = value.split(/[\s,]+/).filter(Boolean)
  if (entries.includes('*')) return null
  return entries.flatMap((entry) => {
    const name = entry.replace(/^\*?\./, '').replace(/\.$/, '')
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(name) && /[a-z]/i.test(name)) return [name, `*.${name}`]
    // A bare IPv6 address: Chromium reads one only in brackets.
    return entry.includes('/') || entry.startsWith('[') || (entry.match(/:/g) || []).length < 2 ? [entry] : [`[${entry}]`]
  })
}

/**
 * The window session's proxy from the environment, by the names curl reads: https_proxy for https:// (and wss://),
 * http_proxy for http://, all_proxy for either when its own is not set, no_proxy for the hosts reached directly (each
 * name in either case). Each proxy falls back to a direct connection when it cannot be reached. Null when the
 * environment names no proxy Chromium can use, or no_proxy is '*'.
 * @param {NodeJS.ProcessEnv} env
 * @returns {ProxyConfig | null}
 */
function envProxyConfig(env) {
  /** @param {string} name */
  const variable = (name) => [env[name], env[name.toUpperCase()]].find((value) => value?.trim())?.trim() || ''
  const rules = ['http', 'https'].flatMap((scheme) => {
    const proxy = chromiumProxy(variable(`${scheme}_proxy`) || variable('all_proxy'))
    return proxy ? [`${scheme}=${proxy},direct://`] : []
  })
  const bypass = bypassRules(variable('no_proxy'))
  if (!rules.length || !bypass) return null
  return { mode: 'fixed_servers', proxyRules: rules.join(';'), proxyBypassRules: bypass.join(',') }
}

/**
 * Keeps the window's session on `config` while the system sends every PROBE_URLS address directly, and on the system's
 * settings otherwise: asked at once, then every `intervalMs`. Without a config it does nothing.
 * @param {object} options
 * @param {WindowSession} options.target the window's session
 * @param {() => SystemSession} options.system a session left on the system's settings (created on first use)
 * @param {ProxyConfig | null} options.config envProxyConfig of this process
 * @param {(text: string) => void} [options.log]
 * @param {number} [options.intervalMs]
 * @returns {ProxyFollower}
 */
function followEnvProxy({ target, system, config, log = () => {}, intervalMs = RECHECK_MS }) {
  if (!config) return { check: () => Promise.resolve(), stop: () => {} }
  let onEnv = false
  /** @type {Promise<void> | null} */
  let running = null
  const once = async () => {
    const probe = system()
    const routes = await Promise.all(PROBE_URLS.map((url) => probe.resolveProxy(url)))
    const direct = routes.every((route) => /^DIRECT$/i.test(String(route).split(';')[0].trim()))
    if (direct === onEnv) return
    await target.setProxy(direct ? config : { mode: 'system' })
    onEnv = direct
    log(direct ? `the system proxy is off: the window goes through the environment's (${config.proxyRules})` : 'the window follows the system proxy again')
  }
  // One question at a time: a slow answer (a PAC file to fetch) does not pile the next ones up.
  const check = () => (running ??= once()
    .catch((error) => log(`the window's proxy stays as it was: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => { running = null }))
  const timer = setInterval(() => { void check() }, intervalMs)
  timer.unref()
  void check()
  return { check, stop: () => clearInterval(timer) }
}

module.exports = { envProxyConfig, followEnvProxy, PROBE_URLS, RECHECK_MS }
