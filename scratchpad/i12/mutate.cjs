// I12 (HTTPS for remote provider endpoints): each mutation must make at least one named test fail. Files are restored.
process.chdir(process.argv[2] || process.cwd())
const fs = require('fs'), { execFileSync } = require('child_process')
const TESTS = ['tests/providers.test.cjs', 'tests/provider-failures.test.cjs', 'tests/providers-messaging.test.cjs']
const FILE = 'electron/providers.mts'
const CHECK = "if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && process.env.ORBIT_ALLOW_INSECURE_HTTP !== '1')"
const mutations = [
  ['http allowed to any host', CHECK, 'if (false)'],
  ['every host is loopback', "return hostname === 'localhost' || hostname === '[::1]' || /^127\\.\\d+\\.\\d+\\.\\d+$/.test(hostname)", 'return true'],
  ['localhost refused', "hostname === 'localhost' || hostname === '[::1]'", "hostname === '[::1]'"],
  ['[::1] refused', "hostname === 'localhost' || hostname === '[::1]'", "hostname === 'localhost'"],
  ['127/8 refused', " || /^127\\.\\d+\\.\\d+\\.\\d+$/.test(hostname)", ''],
  ['regex not anchored at the end', '/^127\\.\\d+\\.\\d+\\.\\d+$/', '/^127\\.\\d+\\.\\d+\\.\\d+/'],
  ['prefix 127. only', '/^127\\.\\d+\\.\\d+\\.\\d+$/', '/^127\\./'],
  ['opt-in ignored', " && process.env.ORBIT_ALLOW_INSECURE_HTTP !== '1')", ')'],
  ['opt-in accepts any value', "process.env.ORBIT_ALLOW_INSECURE_HTTP !== '1'", '!process.env.ORBIT_ALLOW_INSECURE_HTTP'],
  ['https to a remote host refused', "if (url.protocol === 'http:' && !isLoopbackHost", 'if (!isLoopbackHost'],
  ['host with port checked', 'isLoopbackHost(url.hostname)', 'isLoopbackHost(url.host)'],
  ['Ollama run skips the check', "const url = endpointUrl(process.env.ORBIT_OLLAMA_URL || 'http://127.0.0.1:11434', 'ORBIT_OLLAMA_URL')", "const url = new URL(process.env.ORBIT_OLLAMA_URL || 'http://127.0.0.1:11434')"],
  ['endpoint run skips the check', "const url = endpointUrl(base, 'ORBIT_OPENAI_BASE_URL')", 'const url = new URL(base)'],
  ['Ollama list says not reachable', "try { ollamaUrl('tags') } catch (error) { return { id: 'ollama', supported: true, available: false, detail: (error as Error).message } }", ''],
  ['endpoint list says Set ORBIT_OPENAI_BASE_URL', 'detail = (error as Error).message; report(', 'report('],
  ['refused endpoint listed as configured', '} catch (error) { detail = (error as Error).message; report(', '} catch (error) { configured = true; detail = (error as Error).message; report('],
  ['message without the variable', "throw new Error(`${variable} (${url.origin}): ", 'throw new Error(`(${url.origin}): '],
  ['invalid URL without the variable', "try { url = new URL(raw) } catch { throw new Error(`${variable}: это не адрес URL. Укажите его полностью, начиная с https://.`) }", 'url = new URL(raw)'],
  ['credentials allowed', "if (url.username || url.password) throw", 'if (false) throw'],
  ['model checked before the address', "  const url = endpointUrl(base, 'ORBIT_OPENAI_BASE_URL')\n  const model = options.model || process.env.ORBIT_OPENAI_MODEL\n  if (!model) throw new Error('Select an endpoint model or set ORBIT_OPENAI_MODEL')\n", "  const model = options.model || process.env.ORBIT_OPENAI_MODEL\n  if (!model) throw new Error('Select an endpoint model or set ORBIT_OPENAI_MODEL')\n  const url = endpointUrl(base, 'ORBIT_OPENAI_BASE_URL')\n"],
]
// electron/providers.mts has LF line endings; tests/providers.test.cjs has CRLF.
const only = process.argv[3]
if (only) mutations.splice(0, mutations.length, ...mutations.filter(([name]) => name.includes(only)))
for (const [name, from, to] of mutations) {
  const orig = fs.readFileSync(FILE, 'utf8')
  if (!orig.includes(from)) { console.log(`== ${name}: PATTERN NOT FOUND`); continue }
  try {
    fs.writeFileSync(FILE, orig.replace(from, to))
    let out = ''
    try { out = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', ...TESTS], { encoding: 'utf8', timeout: 300000 }) } catch (e) { out = (e.stdout || '') + (e.signal ? ' [killed]' : '') }
    const failed = out.match(/^not ok .*$/gm) || []
    console.log(`== ${name}: ${failed.length ? failed.join(' | ') : '(all pass: NOT CAUGHT)'}${out.includes('[killed]') ? ' HUNG' : ''}`)
  } finally { fs.writeFileSync(FILE, orig) }
}
