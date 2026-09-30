import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The proxy part of a provider's saved options (`{ command, proxyMode, proxyUrl }` in the settings).
interface ProxyOptions { proxyMode?: string; proxyUrl?: string }
// The variables handed to a CLI child: an empty object inherits the parent environment untouched.
type ProxyEnvironment = Record<string, string>

function proxyUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Прокси: укажите HTTP(S) URL, например http://127.0.0.1:12334') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Прокси: нужен HTTP(S) адрес без пароля, пути и параметров')
  }
  return url.origin
}

// What systemProxy asks about: the route to Antigravity's endpoint.
const PROXY_PROBE_URL = 'https://daily-cloudcode-pa.googleapis.com'

// Electron's route for a URL ("PROXY host:port; DIRECT", as session.resolveProxy answers), or null when it cannot tell.
// The runtime child process installs one that asks main (runtime-child.cjs): Electron's session lives in main only.
type ProxyResolver = (url: string) => Promise<string | null>
let proxyResolver: ProxyResolver | null = null
function setProxyResolver(resolver: ProxyResolver | null): void {
  proxyResolver = resolver
}

// The first entry of a route as a proxy URL; '' for DIRECT (no proxy).
function routeProxy(route: string): string {
  const first = route.split(';')[0].trim()
  const match = first.match(/^(PROXY|HTTPS) (.+)$/)
  return match ? proxyUrl(`${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}`) : ''
}

// `readRegistry` is the last source; tests pass their own so the answer does not depend on this machine's settings.
async function systemProxy(readRegistry: () => Promise<string> = registryProxy): Promise<string> {
  // Electron resolves Windows proxy settings and PAC: through the resolver the runtime child installs, or directly in
  // Electron's main process (the in-process runtime). The registry fallback is for CLI diagnostics outside Electron,
  // or when neither answers; never change the machine configuration.
  if (proxyResolver) {
    try {
      const route = await proxyResolver(PROXY_PROBE_URL)
      if (typeof route === 'string') return routeProxy(route)
    } catch { /* No answer from main: the next source. */ }
  }
  try {
    // Loaded here, not at the top: outside Electron the package resolves to the binary's path and has no session.
    const { session } = (await import('electron')).default
    if (session?.defaultSession) return routeProxy(await session.defaultSession.resolveProxy(PROXY_PROBE_URL))
  } catch { /* Standalone Node (and Electron's utility process) has no Electron session. */ }
  return readRegistry()
}

// The static proxy of the Windows Internet settings (no PAC), '' when there is none or it cannot be read.
async function registryProxy(): Promise<string> {
  if (process.platform !== 'win32') return ''
  try {
    const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 3000 })
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout)) return ''
    const raw = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || ''
    const address = raw.includes('=') ? raw.match(/(?:^|;)https=([^;]+)/)?.[1] || raw.match(/(?:^|;)http=([^;]+)/)?.[1] : raw
    return address ? proxyUrl(address.includes('://') ? address : `http://${address}`) : ''
  } catch { return '' }
}

async function proxyEnvironment(options: ProxyOptions = {}, resolveSystem: () => Promise<string> = systemProxy): Promise<ProxyEnvironment> {
  const mode = options.proxyMode || 'system'
  if (!['system', 'inherit', 'direct', 'custom'].includes(mode)) throw new Error('Неизвестный режим прокси')
  if (mode === 'inherit') return {}
  const proxy = mode === 'custom' ? proxyUrl(options.proxyUrl || '') : mode === 'system' ? await resolveSystem() : ''
  if (mode === 'system' && !proxy) return {}
  return {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: mode === 'direct' ? '*' : 'localhost,127.0.0.1,::1',
    no_proxy: mode === 'direct' ? '*' : 'localhost,127.0.0.1,::1',
  }
}
export type { ProxyOptions, ProxyEnvironment, ProxyResolver }
export { proxyEnvironment, proxyUrl, systemProxy, setProxyResolver, PROXY_PROBE_URL }
