const { OrbitRuntime } = require('../../electron/runtime.mts')
const fs = require('fs'), os = require('os'), path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
function aborts(options) { return new Promise((resolve, reject) => { const abort = () => reject(new Error('Provider interrupted')); options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort() }) }
function fakeMcp() { let issued = 0; return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {} } }
;(async () => {
  const calls = [], seconds = [], log = []
  let run, wait
  const nameOf = options => /running as agent "([^"]+)"/.exec(options.session.systemAppend)[1]
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    log.push(`call ${nameOf(options)} active=${run.activeTurns} queue=${run.turnQueue.length}`)
    if (nameOf(options) === 'First') return { text: 'FIRST_FINDINGS', sessionId: options.session.id }
    if (nameOf(options) === 'Second') { seconds.push(options); return seconds.length === 1 ? aborts(options) : { text: 'SECOND_DONE', sessionId: options.session.id } }
    calls.push(options)
    if (calls.length === 1) {
      const first = JSON.parse((await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'First', task: 'Check one thing', reason: 'Independent check' })).text)
      await runtime.dispatchMcp(options.session.token, 'spawn_agent', { name: 'Second', task: 'Check another thing', reason: 'Independent check' })
      log.push(`spawned; queue=${run.turnQueue.length}`)
      wait = runtime.dispatchMcp(options.session.token, 'wait_agent', { agentId: first.agentId })
      wait.then(r => log.push('wait settled ' + r.text.slice(0, 120)))
      return aborts(options)
    }
    return { text: 'FINAL_ANSWER', sessionId: options.session.id }
  } })
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-dbg-'))
  const runId = await runtime.start({ workspace, providerId: 'test', prompt: 'Current task', memoryEnabled: false, limits: { maxConcurrent: 1 } })
  run = runtime.runs.get(runId)
  await sleep(1500)
  console.log(log.join('\n'))
  console.log('queue', run.turnQueue.length, 'active', run.activeTurns, [...run.agentNodes.values()].map(a => `${a.name}:${a.status}:${a.detail}`).join(' | '))
  runtime.stop(runId); await runtime.shutdown(); fs.rmSync(workspace, { recursive: true, force: true })
})()
