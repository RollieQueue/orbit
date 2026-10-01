'use strict'
// Rebuilds the files as they were before I16 by undoing its edits (the run record abbreviates long lines, so its diffs
// do not reverse-apply), writes scratchpad/i16/base/<file> and scratchpad/i16/i16.diff (base → current, 4 lines of context).
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..', '..')
const S = 'electron/runtime/session.mts', M = 'electron/runtime/mailbox.mts', T = 'electron/runtime/tools.mts', U = 'electron/runtime/turn.mts', Y = 'electron/types.mts', R = 'electron/runtime.mts'
// [file, text now, text before]; whole inserted blocks are matched by their first and last lines.
const undo = [
  [U, "    // `signal`: aborted when the turn ends, however it ends; an Orbit wait the turn called ends with it (dispatchMcp).\n", ''],
  [U, 'delivered: new Set(), signal: controller.signal,', 'delivered: new Set(),'],
  [Y, 'delivered: Set<string>; signal: AbortSignal; interrupt:', 'delivered: Set<string>; interrupt:'],
  [Y, 'timeout?: number, signal?: AbortSignal): Promise<string>', 'timeout?: number): Promise<string>'],
  [Y, 'args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>): Promise<ReadMessagesResult>', 'args: ToolArgs): Promise<ReadMessagesResult>'],
  [Y, 'signal?: AbortSignal, ready?: () => Promise<void>): Promise<Observation>', 'signal?: AbortSignal): Promise<Observation>'],
  [R, 'timeout?: number, signal?: AbortSignal) { return mailbox.waitForTeam(this, run, agent, participants, timeout, signal) }', 'timeout?: number) { return mailbox.waitForTeam(this, run, agent, participants, timeout) }'],
  [R, 'args: ToolArgs, signal?: AbortSignal, ready?: () => Promise<void>) { return mailbox.waitAgentMessage(this, run, agent, args, signal, ready) }', 'args: ToolArgs) { return mailbox.waitAgentMessage(this, run, agent, args) }'],
  [R, 'signal?: AbortSignal, ready?: () => Promise<void>) { return tools.executeTool(this, run, agent, name, args, signal, ready) }', 'signal?: AbortSignal) { return tools.executeTool(this, run, agent, name, args, signal) }'],
  [T, "// `ready` (session.dispatchMcp, waits only): awaited before a wait takes what it found (mail read, helper results seen).\n", ''],
  [T, 'signal: AbortSignal = runtime.agentSignal(run, agent), ready?: () => Promise<void>): Promise<Observation> {', 'signal: AbortSignal = runtime.agentSignal(run, agent)): Promise<Observation> {'],
  [T, 'runtime.waitAgentMessage(run, agent, args, signal, ready)', 'runtime.waitAgentMessage(run, agent, args)'],
  [T, '    await runtime.waitForTeam(run, agent, children, timeout, signal)\n    await ready?.()\n', '    await runtime.waitForTeam(run, agent, children, timeout)\n'],
  [S, 'SKILL_READ_CHARS, abortable, bounded,', 'SKILL_READ_CHARS, bounded,'],
  [S, /\/\/ A wait serves the turn that called it[^]*?const TURN_ENDED = [^\n]*\n/, ''],
  ['electron/runtime/loops.mts', '        // Cut off by a pause or a message: the session goes on with the note and the results of helpers finished by now.\n        if (error instanceof PauseInterrupt) { instruction = interruptedSession(runtime, agent, error, cursorBeforeTurn, mailbox.deliveredIds, held); runtime.collectChildren(run, agent, transcript); continue }',
    '        // A pause or a message cut the turn off: the same session goes on with the note (pause.interruptedSession).\n        if (error instanceof PauseInterrupt) { instruction = interruptedSession(runtime, agent, error, cursorBeforeTurn, mailbox.deliveredIds, held); continue }'],
  [S, "  // Without a running turn no model would read a wait's answer.\n  if (!turn && TURN_WAITS.has(call.name)) return refuse(TURN_ENDED)\n", ''],
  [S, /  \/\/ The slot is taken back before the result goes to the model, once[^]*?  } : undefined\n/, ''],
  [S, 'call.arguments, bound, ready), agent)\n    } else if', 'call.arguments), agent)\n    } else if'],
  [S, '} else observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments, bound, ready), agent)', '} else observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments), agent)'],
  [S, '    // A wait its turn left behind was aborted with the turn (abortable says "Run cancelled"), the run itself goes on.\n    failure = turnWait?.signal.aborted && !signal.aborted ? TURN_ENDED : (error as Error).message\n', '    failure = (error as Error).message\n'],
  [S, '  } finally {\n    await slotBack().catch(() => {})\n  }', [
    '  } finally {',
    '    // The slot is taken back before the result goes to the model. A provider whose client ends a call on its own clock',
    '    // is not kept waiting past it for a busy slot: the slot comes back in the background, the turn goes on meanwhile.',
    '    if (waits && turn && !turn.slot.held && !signal.aborted) {',
    '      const retake = retakeSlot(runtime, run, agent, turn)',
    "      // What is left of the limit, or a tenth of it (at most 5 s) when the wait used it all: Cursor's 60 s outlast 50 s + 5 s.",
    '      const grace = Math.max(Math.min(5000, Math.ceil(limit / 10)), limit - (Date.now() - calledAt))',
    '      if (!limit) await retake',
    "      else if (await withinLimit(retake, grace) === STILL_RUNNING && agent.activeTurn === turn) runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing' })",
    '    }',
    '  }',
  ].join('\n')],
  [M, "// `signal`: what ends the wait early; a session turn's wait ends with its turn (session.dispatchMcp).\n", ''],
  [M, 'timeout = 0, signal = runtime.agentSignal(run, agent)): Promise<string> {', 'timeout = 0): Promise<string> {'],
  [M, "]), signal, timeout, 'wait_timeout')", "]), runtime.agentSignal(run, agent), timeout, 'wait_timeout')"],
  [M, /\/\/ `signal`: what ends the wait early \(a session turn's wait[^]*?  await ready\?\.\(\)\n  return mailArrived\(runtime, run, agent, turn\)\n}\n/, [
    'async function waitAgentMessage(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs): Promise<ReadMessagesResult> {',
    '  const turn = agent.activeTurn',
    '  if (runtime.pendingMail(run, agent).length || stoppedHelpers(runtime, run, agent).length) return mailArrived(runtime, run, agent, turn)',
    '  const signal = runtime.agentSignal(run, agent)',
    '  if (signal.aborted) throw abortError()',
    '  const timeout = Math.max(10, Math.min(Number(args.timeout_ms) || 30000, 60000))',
    '  // Assigned by the Promise executor, which runs synchronously.',
    '  let wake!: () => void',
    '  const incoming = new Promise<void>((resolve) => { wake = resolve })',
    '  if (!run.messageWaiters.has(agent.id)) run.messageWaiters.set(agent.id, new Set())',
    '  // Created on the line above when missing.',
    '  run.messageWaiters.get(agent.id)!.add(wake)',
    "  runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for a message' })",
    '  try {',
    "    await abortable(incoming, signal, timeout, 'mailbox_timeout')",
    '    return mailArrived(runtime, run, agent, turn)',
    '  } catch (error) {',
    '    // abortable rejects with Errors (a timeout or an abort).',
    "    if ((error as Error).message === 'mailbox_timeout') return { messages: [], timedOut: true, remainingUnread: 0 }",
    '    throw error',
    '  } finally {',
    '    const waiters = run.messageWaiters.get(agent.id)',
    '    waiters?.delete(wake)',
    '    if (!waiters?.size) run.messageWaiters.delete(agent.id)',
    '  }',
    '}',
    '',
  ].join('\n')],
  ['tests/pause-agents.test.cjs', /\n\/\/ The answer of a wait the test started without awaiting it[^]*?\n  assert\.deepEqual\(after, \{ timedOut: true, activeTurns: 1, held: true \}\)\n}\)\n/, '\n'],
]
const crlf = new Set([T])
const slash = value => value.split(path.sep).join('/')
const out = []
for (const file of [...new Set(undo.map(([name]) => name))]) {
  const current = fs.readFileSync(path.join(repo, file), 'utf8')
  let text = crlf.has(file) ? current.replace(/\r\n/g, '\n') : current
  for (const [, now, before] of undo.filter(([name]) => name === file)) {
    const hits = typeof now === 'string' ? text.split(now).length - 1 : (text.match(new RegExp(now.source, 'g')) || []).length
    if (hits !== 1) throw new Error(`${file}: ${hits} matches for ${String(now).slice(0, 80)}`)
    text = text.replace(now, () => before)
  }
  if (crlf.has(file)) text = text.replace(/\n/g, '\r\n')
  const base = path.join(__dirname, 'base', file)
  fs.mkdirSync(path.dirname(base), { recursive: true })
  fs.writeFileSync(base, text)
  const r = spawnSync('git', ['diff', '--no-index', '-U4', '--ignore-cr-at-eol', slash(path.relative(repo, base)), file], { cwd: repo, encoding: 'utf8' })
  out.push(r.stdout.split('a/scratchpad/i16/base/').join('a/'))
}
fs.writeFileSync(path.join(__dirname, 'i16.diff'), out.join(''))
console.log('ok')
