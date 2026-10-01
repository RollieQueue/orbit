const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { folder, finished, payload, session, callLimit, until, cursorFull, commandAnswer } = require('./helpers-session.cjs')

// The session transport is driven with a fake provider and a fake MCP server (tests/helpers-session.cjs); no CLI is started.

// ---- Parked results that go stale (Cursor): files changed after a call began or finished ----------------------------

test('a parked result is not handed out once files changed: after an Orbit write or a native edit the repeat runs the command again', async t => {
  callLimit(t, 300)
  for (const how of ['write_file', 'native edit']) {
    const workspace = folder(t)
    fs.writeFileSync(path.join(workspace, 'f.txt'), 'BEFORE')
    // Reads the file when it starts and answers 1500 ms later, like a test run that loads the sources first; the run that follows a change answers after 450 ms.
    // The first run's margin is for the kill after a native edit: the restart gate runs this next to the other checks, and a
    // loaded machine took more than the 600 ms that 900 ms left (taskkill came late and the run wrote its end).
    const command = { command: process.execPath, args: ['-e', 'const fs = require("fs"); const seen = fs.readFileSync("f.txt", "utf8"); const first = !fs.existsSync("starts.txt"); fs.appendFileSync("starts.txt", "s"); setTimeout(() => { fs.appendFileSync("ends.txt", "e"); console.log("SAW:" + seen) }, first ? 1500 : 450)'] }
    const answers = []
    const runtime = new OrbitRuntime({ ...session(), runProvider: async options => {
      const token = options.session.token
      const { run } = runtime.sessionFor(token), quiet = run.operations.size
      answers.push(await commandAnswer(runtime, token, command))
      if (how === 'write_file') {
        assert.equal(JSON.parse((await runtime.dispatchMcp(token, 'write_file', { path: 'f.txt', content: 'AFTER' })).text).ok, true)
        await until(() => run.operations.size === quiet) // the first run finishes meanwhile, uncollected
      } else {
        // Cursor's own edit tool, reported in the stream while the first run is still going.
        fs.writeFileSync(path.join(workspace, 'f.txt'), 'AFTER')
        options.onEvent({ kind: 'tool', native: true, tool: 'write', toolId: 'edit-1', status: 'completed', input: { path: 'f.txt' } })
      }
      for (let attempt = 0; attempt < 30 && !answers.at(-1).stdout; attempt++) answers.push(await commandAnswer(runtime, token, command))
      return { text: 'done', sessionId: 'cursor-chat' }
    } })
    const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
    assert.equal(snapshot.status, 'completed', snapshot.error)
    assert.equal(answers[0].stillRunning, true)
    assert.equal(answers[1].stillRunning, true, `${how}: the repeat started a fresh run`)
    assert.match(answers.at(-1).stdout, /SAW:AFTER/, `${how}: the result is from after the change`)
    assert.equal(answers.at(-1).collected, true)
    assert.equal(fs.readFileSync(path.join(workspace, 'starts.txt'), 'utf8'), 'ss', how)
    // The first run had ended before the write was followed up; the one a native edit overtook was stopped instead.
    assert.equal(fs.readFileSync(path.join(workspace, 'ends.txt'), 'utf8'), how === 'write_file' ? 'ee' : 'e', how)
  }
})

test('a command that changed files after a parked one finished makes it stale; one that ran alongside it does not', async t => {
  callLimit(t, 150)
  const workspace = folder(t)
  // Every command that runs alone is seen to change one file (runTrackedCommand then counts it as the agent's work).
  let changes = 0
  const projectIndex = { refresh: async (_, options) => ({ added: options?.force ? [`generated-${++changes}.txt`] : [], changed: [], removed: [] }), search: () => ({ results: [] }), outline: () => null, overview: () => '', touch: async () => {} }
  const sleeper = (tag, ms) => ({ command: process.execPath, args: ['-e', `require("fs").appendFileSync("${tag}.txt", "x"); setTimeout(() => console.log("${tag} done"), ${ms})`] })
  const results = {}
  const runtime = new OrbitRuntime({ ...session(), projectIndex, runProvider: async options => {
    const token = options.session.token
    const { run } = runtime.sessionFor(token), quiet = run.operations.size
    const collect = async args => { for (let attempt = 0; attempt < 30; attempt++) { const answer = await commandAnswer(runtime, token, args); if (!answer.stillRunning) return answer } }
    // A and B side by side: B ends last, alone, and the change it is credited with is counted after A ended.
    await Promise.all([commandAnswer(runtime, token, sleeper('A', 300)), commandAnswer(runtime, token, sleeper('B', 600))])
    await until(() => run.operations.size === quiet)
    results.B = await collect(sleeper('B', 600))
    results.A = await collect(sleeper('A', 300))
    // C ends; then D runs on its own and changes a file: C's result predates that change.
    assert.equal((await commandAnswer(runtime, token, sleeper('C', 300))).stillRunning, true)
    await until(() => run.operations.size === quiet)
    results.D = await collect(sleeper('D', 10))
    results.C = await collect(sleeper('C', 300))
    return { text: 'ok', sessionId: 'cursor-chat' }
  } })
  const { snapshot } = await finished(runtime, payload(workspace, cursorFull), 20000)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.deepEqual(['A', 'B', 'C', 'D'].map(tag => fs.readFileSync(path.join(workspace, `${tag}.txt`), 'utf8')), ['x', 'x', 'xx', 'x'], 'only C ran again')
  assert.deepEqual(['A', 'B', 'C'].map(tag => [results[tag].stdout.trim(), results[tag].collected]), [['A done', true], ['B done', true], ['C done', true]])
  assert.match(results.D.stdout, /D done/)
})
