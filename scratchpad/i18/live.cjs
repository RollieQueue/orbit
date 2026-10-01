// I18 live check: does a CLI session keep the prompt of a turn cut off after its model spoke?
// Turn 1 (fresh session) carries a random code and asks for a long answer; Orbit's AbortSignal cuts it at the model's
// first event (or `delayMs` later). Turn 2 resumes the session the stream named and asks for the code.
// Mode `resumed`: an ordinary first turn, then the cut turn resumes that session (where Orbit's mail usually arrives).
// Usage: node --experimental-strip-types scratchpad/i18/live.cjs <provider> <model|-> [delayMs] [first|resumed]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runProvider } = require('../../electron/providers.mts')

const [providerId, modelArg = '-', delayArg = '0', mode = 'first'] = process.argv.slice(2)
const model = modelArg === '-' ? undefined : modelArg
const delayMs = Number(delayArg) || 0
const MODEL_EVENTS = new Set(['output', 'reasoning', 'thinking', 'tool'])
// I18_RESUME_WAIT_MS: pause between the cut and the resume (Orbit resumes at once); I18_CUT_ON=tool: cut at the first
// native tool event of a turn told to run a long command first.
const resumeWait = Number(process.env.I18_RESUME_WAIT_MS ?? 3000)
const cutOn = process.env.I18_CUT_ON || 'model'
const code = `ZEBRA-${Math.floor(1000 + Math.random() * 9000)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'i18-ws-'))
const base = {
  providerId, model, workspace, mode: 'danger-full-access', accessMode: 'danger-full-access', approvalPolicy: 'never',
  providerOptions: providerId === 'cursor' ? { transport: 'session' } : providerId === 'antigravity' ? { proxyMode: 'custom', proxyUrl: process.env.HTTPS_PROXY || 'http://127.0.0.1:12334' } : {},
}
const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args)

async function cutTurn(resumeId = null) {
  const controller = new AbortController()
  let sessionId = null, firstModelEvent = null, cutAt = null, streamed = ''
  const started = Date.now()
  const task = runProvider({
    ...base,
    prompt: cutOn === 'tool'
      ? `Remember this secret code for later in our conversation: ${code}. Do not repeat the code now. First run the shell command "ping -n 20 127.0.0.1" in the current folder and wait for it to finish, then write a long poem of at least 60 lines about the ocean.`
      : `Remember this secret code for later in our conversation: ${code}. Do not repeat the code now and do not use any tools. Now write a long poem of at least 60 lines about the ocean, one stanza after another.`,
    session: { id: resumeId, resume: !!resumeId },
    signal: controller.signal,
    onEvent: event => {
      if (event.kind === 'session') { sessionId = event.sessionId; log('session', sessionId) }
      if (MODEL_EVENTS.has(event.kind) && (cutOn !== 'tool' || event.kind === 'tool')) {
        if (event.kind === 'output') streamed += event.text || ''
        if (!firstModelEvent) {
          firstModelEvent = { kind: event.kind, ms: Date.now() - started }
          log('first model event', event.kind, `${firstModelEvent.ms} ms`, event.kind === 'tool' ? JSON.stringify([event.tool, event.status, event.text]).slice(0, 160) : '')
          setTimeout(() => { cutAt = Date.now() - started; log('cut', `${cutAt} ms`); controller.abort() }, delayMs)
        }
      }
    },
  })
  try { const result = await task; log('turn 1 was NOT cut: it finished', JSON.stringify(result).slice(0, 200)); return { sessionId: result.sessionId, finished: true, firstModelEvent, streamed } }
  catch (error) { log('turn 1 ended:', error?.name, String(error?.message || error).slice(0, 200)) }
  return { sessionId: sessionId || resumeId, finished: false, firstModelEvent, cutAt, streamed }
}

async function askCode(sessionId) {
  const named = []
  const result = await runProvider({
    ...base,
    prompt: 'Earlier in this conversation I gave you a secret code. Reply with that code only. If you cannot see any secret code in this conversation, reply with the single word NONE.',
    session: { id: sessionId, resume: true },
    onEvent: event => { if (event.kind === 'session') named.push(event.sessionId) },
  })
  return { text: String(result.text || '').trim(), sessionId: result.sessionId, named }
}

;(async () => {
  log('provider', providerId, 'model', model || '(default)', 'delay', delayMs, 'code', code, 'workspace', workspace)
  let opened = null
  if (mode === 'resumed') {
    const plain = await runProvider({ ...base, prompt: 'Reply with the single word READY and nothing else. Do not use any tools.', session: { id: null, resume: false } })
    opened = plain.sessionId
    log('plain first turn answered', JSON.stringify(String(plain.text).slice(0, 80)), 'session', opened)
    if (!opened) { log('RESULT: the plain first turn named no session'); return }
  }
  const first = await cutTurn(opened)
  if (!first.sessionId) { log('RESULT: no session id named by the cut turn: nothing to resume'); return }
  await new Promise(resolve => setTimeout(resolve, resumeWait))
  try {
    const answer = await askCode(first.sessionId)
    const kept = answer.text.includes(code)
    log('turn 2 session named', JSON.stringify(answer.named), 'result session', answer.sessionId)
    log('turn 2 answer', JSON.stringify(answer.text.slice(0, 300)))
    log(`RESULT ${providerId} (${mode}, cut on ${cutOn}, resume after ${resumeWait} ms): ${kept ? 'KEPT the cut prompt' : 'LOST the cut prompt'}; first model event ${JSON.stringify(first.firstModelEvent)}; cut at ${first.cutAt} ms; streamed ${first.streamed.length} chars; same session ${answer.sessionId === first.sessionId}`)
  } catch (error) {
    log(`RESULT ${providerId}: resume FAILED:`, String(error?.message || error).slice(0, 400))
  } finally {
    try { fs.rmSync(workspace, { recursive: true, force: true }) } catch {}
  }
})()
