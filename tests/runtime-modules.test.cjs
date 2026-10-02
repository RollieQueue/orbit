// The runtime split (electron/runtime.mts facade + electron/runtime/*): the facade's surface is backed one-to-one by
// module functions, the modules stay small and acyclic, the inline tool guide matches the registry, and an error the
// runtime deliberately survives leaves a `diagnostic` trace instead of vanishing.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const { OrbitRuntime } = require('../electron/runtime.mts')
const registry = require('../electron/tool-registry.mts')
const { TOOL_GUIDE } = require('../electron/runtime/prompts.mts')
const { diagnostics } = require('../electron/runtime/util.mts')

const ROOT = path.join(__dirname, '..', 'electron')
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const modules = fs.readdirSync(RUNTIME_DIR).filter(name => name.endsWith('.mts'))
const OWN = ['constructor', 'setQuota', 'setCatalog', 'onEvent', 'setProjectIndex', 'setMemoryStore', 'setCapabilityStore', 'setConnectorStore', 'setRunStore', 'setContextStore', 'routeMessage']

test('the envelope tool guide the runtime keeps inline matches the registry', () => {
  assert.equal(TOOL_GUIDE, registry.describeForPrompt({ id: 'root' }, {}))
})

test('every facade method is one delegation to a module function of the same name', () => {
  // The types are stripped the way Node strips them when it loads the facade (blanked in place, so the layout stays);
  // what is compared is the code that runs: `getRun(id: string)` becomes `getRun(id        )`.
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, 'runtime.mts'), 'utf8'), { mode: 'strip' })
  const aliases = Object.fromEntries([...source.matchAll(/^import \* as (\w+) from '\.\/runtime\/(\w+)\.mts'/gm)].map(match => [match[1], match[2]]))
  const delegations = [...source.matchAll(/^  (\w+) *\(([^)]*)\) *\{ return (\w+)\.(\w+)\(this(?:, ([^)]*))?\) \}\r?$/gm)]
  const names = params => params.split(',').map(param => param.trim()).filter(Boolean).join(', ')
  assert.ok(delegations.length >= 90, `${delegations.length} delegations found`)
  for (const [, method, params, alias, target, forwarded] of delegations) {
    assert.equal(target, method, `${method} delegates to ${alias}.${target}`)
    assert.equal(forwarded || '', names(params), `${method} forwards its parameters unchanged`)
    assert.ok(aliases[alias], `${alias} is a runtime module`)
    const mod = require(path.join(RUNTIME_DIR, `${aliases[alias]}.mts`))
    assert.equal(typeof mod[method], 'function', `${aliases[alias]}.mts exports ${method}`)
  }
  const methods = Object.getOwnPropertyNames(OrbitRuntime.prototype).filter(name => !OWN.includes(name))
  assert.deepEqual(methods.sort(), delegations.map(item => item[1]).sort())
})

test('runtime modules stay small, acyclic and never import the facade', () => {
  const requires = {}
  for (const name of modules) {
    const text = fs.readFileSync(path.join(RUNTIME_DIR, name), 'utf8')
    assert.ok(text.split('\n').length <= 400, `${name} has at most 400 lines`)
    assert.ok(!text.includes("from '../runtime.mts'"), `${name} does not import the facade`)
    requires[name] = [...text.matchAll(/from '\.\/(\w+)\.mts'/g)].map(match => `${match[1]}.mts`)
  }
  const visiting = new Set(), done = new Set()
  const visit = (name, trail) => {
    if (done.has(name)) return
    assert.ok(!visiting.has(name), `import cycle: ${[...trail, name].join(' -> ')}`)
    visiting.add(name)
    for (const dependency of requires[name] || []) visit(dependency, [...trail, name])
    visiting.delete(name); done.add(name)
  }
  for (const name of modules) visit(name, [])
})

test('an error the runtime survives leaves a diagnostic trace instead of vanishing', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-modules-'))
  const projectIndex = { refresh: async () => { throw new Error('index on fire') }, overview: () => '', touch: async () => {} }
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'Done' }), projectIndex })
  const finished = new Promise(resolve => runtime.onEvent(event => { if (['run.finished', 'run.failed'].includes(event.type)) resolve(event) }))
  const runId = await runtime.start({ prompt: 'hello', providerId: 'custom', workspace, projectId: 'p', chatId: 'c', memoryEnabled: false })
  assert.equal((await finished).type, 'run.finished')
  const diagnostic = runtime.getRun(runId).traces.filter(trace => trace.kind === 'diagnostic')
  assert.deepEqual(diagnostic.map(trace => [trace.agentName, trace.text]), [['Orbit', 'projectIndex.refresh: index on fire']])
  fs.rmSync(workspace, { recursive: true, force: true })
})

test('diagnostics never throws, names the agent when given one, and a finished run keeps no new traces', () => {
  assert.doesNotThrow(() => diagnostics({ trace() { throw new Error('listener exploded') } }, { runId: 'r' }, 'somewhere', new Error('x')))
  const traces = []
  const fake = { trace: (run, agentId, kind, text) => traces.push({ agentId, kind, text }) }
  diagnostics(fake, {}, 'where', 'plain string error')
  diagnostics(fake, {}, 'where', new Error('an error'), 'agent-1')
  assert.deepEqual(traces, [{ agentId: 'root', kind: 'diagnostic', text: 'where: plain string error' }, { agentId: 'agent-1', kind: 'diagnostic', text: 'where: an error' }])
  const runtime = new OrbitRuntime({ runProvider: async () => ({ text: 'Done' }) })
  const run = { runId: 'r', status: 'completed', traces: [], agentNodes: new Map() }
  diagnostics(runtime, run, 'late', new Error('after the end'))
  assert.equal(run.traces.length, 0)
})
