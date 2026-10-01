// Runs one agent to its result. The envelope loop drives a fresh provider process per turn with the JSON tool
// protocol, the loop guard and the poll budget; the session loop keeps one provider session alive and applies the
// post-answer checks; executeAgent chooses between them and handles budgets, draft answers, errors and cancellation.
import { randomUUID, createHash } from 'node:crypto'
import { targetLabel } from '../failover.mts'
import { TERMINAL, AGENT_TERMINAL, ceiling, USER, WORK_TOOLS, MUTATING_TOOLS, SKILL_READ_CHARS, bounded, TurnBudgetError, abortError } from './util.mts'
import { ToolProtocolError, hasToolCalls, parseResponse } from './envelope.mts'
import { sessionGuide, evaluationReminder, skillReminder } from './prompts.mts'
import * as improvement from './improvement.mts'
import { describeCall } from './ledger.mts'
import { PauseInterrupt, pauseGate, interruptedSession, STOPPED_BY_USER } from './pause.mts'
import { keptAnswer, answerAsKept } from './mailbox.mts'
import type { AgentRecord, AgentResult, MailboxContext, McpServerLike, OrbitRuntimeLike, PromptBase, ProviderResult, RunRecord, SessionInfo, TranscriptEntry } from '../types.mts'
// Consecutive turns made only of identical repeats: warn, then stop the agent honestly.
const STALL_WARN_TURNS = 2
const STALL_STOP_TURNS = 4
const PASSIVE_NUDGE_TURNS = 8
// Harness-injected reminders may be ignored this many times in a row before the answer is accepted.
const REMINDER_LIMIT = 3
// How many provider turns make a run worth a "what did you learn" reminder.
const SKILL_REVIEW_TURNS = 10
// Envelope mode: a turn made only of these calls is polling; after this many in a row the agent is told to wait instead.
const POLL_TOOLS = new Set(['list_agents', 'read_messages', 'context_read', 'wait_agent', 'wait_message'])
const POLL_NUDGE_TURNS = 6
// The stable block appended to a session provider's system prompt never exceeds this (nothing volatile goes in it).
const SYSTEM_APPEND_LIMIT = 6000
// Returned by a transport loop when a handover moved the agent to a provider of the other transport.
export const SWITCH_TRANSPORT = Symbol('switch-transport')

// Fields that change by themselves; they must not hide an otherwise identical repeated result.
const VOLATILE_KEYS = new Set(['turns', 'progress', 'detail', 'promptChars', 'startedAt', 'finishedAt', 'updatedAt', 'time'])
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
// Timings and clock times differ on every run of the same command (a test run prints its duration),
// which would make an endless "run the tests again" loop look like new information each time.
const NOISE: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  [/\bduration_ms\W+[\d.]+/gi, 'duration_ms <n>'],
  [/\b\d+(?:[.,]\d+)?\s?(?:ms|milliseconds?|s|secs?|seconds?)\b/gi, '<n>ms'],
]
function steady(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(steady)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE_KEYS.has(key)).map(([key, item]) => [key, steady(item)]))
  return typeof value === 'string' ? NOISE.reduce((text, [pattern, mark]) => text.replace(pattern, mark), value) : value
}
const digestOf = (value: unknown): string => createHash('sha1').update(canonical(steady(value))).digest('hex')

// Runs one agent to its result. The transport decides the loop: the envelope loop drives a fresh provider process per
// turn with the JSON tool protocol; the session loop keeps one provider session alive and serves Orbit tools over MCP.
// A handover to a provider of the other transport switches loops; everything else (budgets, draft answers, errors,
// cancellation) is handled here for both.
async function executeAgent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<AgentResult> {
  const signal = runtime.agentSignal(run, agent)
  try {
    for (;;) {
      if (agent.transport === 'session' && !await runtime.prepareSession(run, agent)) continue
      const result = agent.transport === 'session' ? await runtime.sessionLoop(run, agent, signal) : await runtime.envelopeLoop(run, agent, signal)
      if (result !== SWITCH_TRANSPORT) return result
      runtime.trace(run, agent.id, 'transport', `Continuing with the ${agent.transport} transport on ${targetLabel({ providerId: agent.providerId, model: agent.model })}`)
    }
  } catch (error) {
    if (agent.stoppedByUser) {
      runtime.updateAgent(run, agent, { status: 'cancelled', error: STOPPED_BY_USER, detail: 'Остановлен вами' })
      return { agentId: agent.id, generation: agent.generation, status: 'cancelled', error: STOPPED_BY_USER, result: agent.result }
    }
    if (error instanceof TurnBudgetError && !signal.aborted) return runtime.budgetHandoff(run, agent)
    // Whatever was thrown, only its `message` is read (undefined for a non-Error).
    if (agent.draftAnswer && !signal.aborted && !TERMINAL.has(run.status)) {
      // Only an optional extra turn (a reminder, or a session resume after the answer) failed; the answer was complete.
      runtime.trace(run, agent.id, 'budget', `The turn after the answer failed (${(error as Error).message}); the drafted answer is delivered`)
      return runtime.completeAgent(run, agent, answerAsKept(runtime, run, agent, agent.draftAnswer, (error as Error).message))
    }
    // An agent already cancelled with a reason (its supervisor was stopped, the whole run was) keeps that reason.
    const marked = signal.aborted && agent.status === 'cancelled'
    runtime.updateAgent(run, agent, { status: signal.aborted ? 'cancelled' : 'error', error: (error as Error).message, detail: marked && agent.detail ? agent.detail : (error as Error).message, finishedAt: marked && agent.finishedAt ? agent.finishedAt : new Date().toISOString() })
    // A failed parent must never leave its descendants executing unowned work.
    run.agentControllers.get(agent.id)?.controller.abort()
    throw error
  } finally {
    const own = run.agentControllers.get(agent.id)
    own?.parentSignal?.removeEventListener('abort', own.abort)
    runtime.releaseSession(run, agent)
  }
}
async function envelopeLoop(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, signal: AbortSignal): Promise<AgentResult | typeof SWITCH_TRANSPORT> {
  const transcript = agent.transcript
  let protocolErrors = 0
  // Loop guard: what this agent already saw, and for how long it has gone without new information.
  const guard = { seen: new Map<string, { digest: string; turn: number }>(), staleTurns: 0, passiveTurns: 0, pollTurns: 0, evaluationReminders: 0, improvementReminders: 0 }
  {
    let base: PromptBase
    while (agent.id === 'root' || agent.turns < ceiling(run.limits, 'maxTurns')) {
      await new Promise(resolve => setImmediate(resolve))
      if (signal.aborted) throw abortError()
      if (runtime.collectChildren(run, agent, transcript)) guard.passiveTurns = 0
      // An agent whose subscription is running out changes provider before the turn, not after it fails.
      await runtime.preflightQuota(run, agent)
      if (agent.transport !== 'envelope') return SWITCH_TRANSPORT
      // Keep correspondence separate from rolling tool observations so trimming cannot lose it.
      // `mailbox` and `lastWorkerTurn` are set by the prompt callback, which providerTurn calls before a result exists.
      let mailbox!: MailboxContext, lastWorkerTurn!: boolean, result: ProviderResult
      for (;;) {
        // The prompt names the agent's provider settings, so it is built again after every switch.
        base = await runtime.context(run, agent)
        try {
          result = await runtime.providerTurn(run, agent, () => {
            lastWorkerTurn = agent.id !== 'root' && (agent.turns >= ceiling(run.limits, 'maxTurns') || run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns'))
            mailbox = runtime.mailboxContext(run, agent)
            runtime.markCommunications(run, mailbox.deliveredIds, 'delivered', 'next-turn')
            return runtime.promptForTurn(base, transcript, run, runtime.teamContext(run, agent) + mailbox.text, agent)
          })
          break
        } catch (error) {
          if (error instanceof PauseInterrupt) { runtime.remember(agent, { type: 'instruction', content: error.note }); continue }
          // A refusal for quota (or a failed replacement) moves the agent to another subscription and repeats the turn.
          if (!await runtime.recoverProvider(run, agent, error)) throw error
          if (agent.transport !== 'envelope') return SWITCH_TRANSPORT
        }
      }
      agent.trial = null
      if (signal.aborted) throw abortError()
      runtime.markCommunications(run, mailbox.deliveredIds, 'read', 'next-turn')
      if (mailbox.deliveredIds.length) guard.passiveTurns = 0
      const output = hasToolCalls(result) ? result : result?.text ?? result
      let response
      try { response = parseResponse(output) }
      catch (error) {
        if (!(error instanceof ToolProtocolError)) throw error
        runtime.trace(run, agent.id, 'protocol_error', error.message)
        if (lastWorkerTurn) return runtime.budgetHandoff(run, agent)
        if (++protocolErrors > 2) throw new Error(`Orbit tool protocol failed after 2 repair attempts: ${error.message}`)
        runtime.remember(agent, { type: 'instruction', content: `${error.message}. No Orbit tools from that response were executed. Resend the entire intended tool_calls array as valid JSON in your FINAL RESPONSE, without prose or Markdown. Use {"content":"optional update","tool_calls":[{"id":"unique-id","name":"tool_name","arguments":{}}]}. Do not claim the tools ran or omit pending calls.` })
        continue
      }
      if (response.calls.length > ceiling(run.limits, 'maxToolCalls')) throw new Error('User-configured tool-call limit reached')
      protocolErrors = 0
      const timing = agent.turnTimings.at(-1)
      if (timing) timing.orbitToolCalls = response.calls.length
      if (lastWorkerTurn) {
        if (response.calls.length) return runtime.budgetHandoff(run, agent)
        if (response.content.trim()) return runtime.completeAgent(run, agent, response.content, true)
        return runtime.budgetHandoff(run, agent)
      }
      if (!response.calls.length) {
        const participants = [...run.agentNodes.values()].filter(child => child.id !== agent.id && (agent.id === 'root' || child.parentId === agent.id))
        const pending = participants.filter(child => !['done', 'error', 'cancelled'].includes(child.status))
        const unseen = participants.some(child => !agent.seenChildren.has(runtime.resultKey(child)))
        if (pending.length || unseen || runtime.pendingMail(run, agent).length) {
          if (pending.length) {
            runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for delegated results' })
            await runtime.waitForTeam(run, agent, pending)
          }
          runtime.remember(agent, { type: 'instruction', content: 'Delegated results or messages arrived after your last turn. Integrate them before giving your final answer.' })
          continue
        }
        if (!response.content.trim()) throw new Error('Provider returned an empty response')
        // A reminder the model ignores REMINDER_LIMIT times in a row is dropped: the answer is accepted
        // rather than looping forever on a request the model will not (or cannot) satisfy.
        if (agent.id === 'root' && run.memoryEnabled && run.globalMemoryEnabled && runtime.memoryStore?.upsert) {
          const pendingEvaluations = participants.filter(child => child.model && ['done', 'error'].includes(child.status) && !run.evaluations.has(runtime.resultKey(child)))
          if (pendingEvaluations.length && guard.evaluationReminders++ < REMINDER_LIMIT) {
            runtime.remember(agent, { type: 'instruction', content: evaluationReminder(pendingEvaluations) })
            continue
          }
        }
        // Improvement mode: the run's one task is closed and, in Orbit's own repository, applied (improvement.mts).
        const improvementReminder = agent.id === 'root' ? improvement.reminderFor(runtime, run) : null
        if (improvementReminder) {
          if (guard.improvementReminders++ < REMINDER_LIMIT) {
            runtime.remember(agent, { type: 'instruction', content: improvementReminder })
            continue
          }
          return runtime.completeAgent(run, agent, `${response.content}\n\n${improvement.acceptedWithout(runtime, run, REMINDER_LIMIT)}`)
        }
        // Skills grow from experience: once per run, when it was substantial or used a skill, the root is asked what to keep.
        if (agent.id === 'root' && run.memoryEnabled && run.skillLearning && !run.skillReminded && typeof runtime.capabilityStore?.save === 'function') {
          const unrated = [...run.skillUse].filter(([, use]) => !use.rated).map(([id, use]) => ({ id: id.slice(0, 12), name: use.name }))
          if (unrated.length || (run.usage.providerTurns >= SKILL_REVIEW_TURNS && !run.skillSaved)) {
            run.skillReminded = true
            // The answer is ready. The next turn is a fresh inference, so it sees the draft in the transcript, and if that
            // optional turn fails or comes back empty the draft is what the user gets (see the catch below).
            agent.draftAnswer = keptAnswer(runtime, run, agent, response.content)
            runtime.remember(agent, { type: 'assistant', content: response.content, tool_calls: [] })
            runtime.remember(agent, { type: 'instruction', content: skillReminder(unrated) })
            continue
          }
        }
        return runtime.completeAgent(run, agent, response.content)
      }
      runtime.remember(agent, { type: 'assistant', content: response.content, tool_calls: response.calls.map(call => ({ ...call, arguments: ['write_file', 'edit_file', 'memory_save', 'context_save', 'capability_install'].includes(call.name) ? { path: call.arguments.path, key: call.arguments.key, summary: 'Payload omitted after execution; use result and shared context.' } : call.arguments })) })
      // A response carrying tool calls is a protocol turn, not an answer to
      // the user. Keep its optional progress note in the agent trace so the
      // next tool result/turn remains the only thing published to chat.
      if (response.content) runtime.trace(run, agent.id, 'assistant_update', response.content)
      const waits = new Set(['wait_agent', 'wait_message'])
      const orderedCalls = [...response.calls.filter(call => !waits.has(call.name)), ...response.calls.filter(call => waits.has(call.name))]
      let novel = false, changed = false
      const repeats = []
      for (const call of orderedCalls) {
        await pauseGate(runtime, run, agent)
        if (signal.aborted) throw abortError()
        runtime.trace(run, agent.id, 'tool', `${call.name} ${bounded(call.arguments, 1200)}`)
        const startedAt = runtime.clock()
        let observation: unknown, failure: string | null = null
        try {
          if (call.arguments.__invalidArguments) throw new Error('Tool arguments must be a JSON object')
          observation = await runtime.trackOperation(run, runtime.executeTool(run, agent, call.name, call.arguments), agent)
        } catch (error) {
          if (signal.aborted) throw error
          failure = (error as Error).message
          observation = { ok: false, error: failure }
        }
        // The same call with the same (steady) result is a repeat: no new information was gained.
        // Blocking on a running team takes real time, so an unchanged wait result is not counted.
        const signature = createHash('sha1').update(`${call.name} ${canonical(call.arguments)}`).digest('hex')
        const digest = digestOf(observation)
        const earlier = guard.seen.get(signature)
        const repeat = earlier?.digest === digest && !(['wait_agent', 'wait_message'].includes(call.name) && runtime.clock() - startedAt >= 1000)
        guard.seen.set(signature, { digest, turn: agent.turns })
        if (guard.seen.size > 400) guard.seen.delete(guard.seen.keys().next().value!)
        if (repeat) repeats.push(`${call.name} (first made in turn ${earlier.turn})`)
        else novel = true
        // An observation is JSON of the tool's own shape; only its optional `ok` flag is read here.
        if (!failure && (observation as { ok?: unknown } | null | undefined)?.ok !== false && MUTATING_TOOLS.has(call.name)) {
          changed = true
          // Talking is not work: the router closes a discussion in which neither side has done anything else.
          if (WORK_TOOLS.has(call.name)) agent.workDone++
        }
        runtime.recordLedger(agent, call.name, `#${agent.turns} ${describeCall(call, observation as Record<string, unknown>, failure, id => run.agentNodes.get(id)?.name || id)}${repeat ? ` (identical repeat of #${earlier.turn})` : ''}`)
        runtime.remember(agent, { type: 'tool_result', tool_call_id: call.id, name: call.name, result: bounded(observation, call.name === 'capability_read' ? Math.max(run.limits.maxOutputChars, SKILL_READ_CHARS) : run.limits.maxOutputChars), ...(repeat ? { note: `Identical repeat of the call from turn ${earlier.turn}: nothing changed since then. Do not repeat it.` } : {}) })
        runtime.trace(run, agent.id, 'observation', `${call.name}: ${bounded(observation, 4000)}`)
        runtime.trimTranscript(run, agent)
      }
      guard.staleTurns = novel ? 0 : guard.staleTurns + 1
      guard.passiveTurns = changed ? 0 : guard.passiveTurns + 1
      // Polling: a turn made only of directory, mailbox, note and wait calls. Different answers each time hide it from
      // the loop guard, so after six in a row the agent is told once (per streak) to wait instead; it is never stopped for it.
      guard.pollTurns = orderedCalls.length && orderedCalls.every(call => POLL_TOOLS.has(call.name)) ? guard.pollTurns + 1 : 0
      guard.evaluationReminders = 0; guard.improvementReminders = 0
      if (guard.staleTurns >= STALL_STOP_TURNS) return runtime.stallHandoff(run, agent, guard.staleTurns)
      if (guard.staleTurns >= STALL_WARN_TURNS) {
        runtime.trace(run, agent.id, 'budget', `Loop guard warning: ${guard.staleTurns} consecutive turns of identical repeated calls`)
        runtime.remember(agent, { type: 'instruction', content: `LOOP GUARD: your last ${guard.staleTurns} turns only repeated calls that returned identical results (${repeats.join('; ')}). Nothing changed, so repeating them cannot help. Read your WORK LOG, then take a DIFFERENT step now: apply the fix or edit, delegate or message a participant, or give your final answer stating what is verified and what is not. If you repeat identical calls again, this agent will be stopped.` })
      } else if (guard.pollTurns === POLL_NUDGE_TURNS) {
        runtime.trace(run, agent.id, 'budget', `Poll budget: ${guard.pollTurns} consecutive turns only polled the team; nudging to wait instead`)
        runtime.remember(agent, { type: 'instruction', content: `POLL BUDGET: your last ${guard.pollTurns} turns only polled (list_agents, read_messages, context_read or waits) and did nothing else. Polling in a loop spends turns without new information. Instead, call wait_agent {timeout_ms} (or wait_message {timeout_ms}) ONCE with a generous timeout: it blocks until a helper finishes or a message arrives, releases your provider slot meanwhile and returns the results. Then integrate what you have and act on it or give your final answer.` })
      } else if (guard.passiveTurns >= PASSIVE_NUDGE_TURNS && guard.passiveTurns % PASSIVE_NUDGE_TURNS === 0) {
        runtime.remember(agent, { type: 'instruction', content: `Your last ${guard.passiveTurns} turns only read or checked things: nothing was changed, delegated, saved or sent. Do not repeat checks whose inputs are unchanged. If the evidence is sufficient, integrate it and give your final answer; if something must be fixed, fix it now; read only what you have not read yet.` })
      }
    }
    return runtime.budgetHandoff(run, agent)
  }
}
// ---- Session transport --------------------------------------------------------------------------------------------
// One provider session per agent: the first turn carries the whole prompt, later turns resume the same session with
// only what is new. Orbit tools are served to the provider over MCP (dispatchMcp) while the turn runs; the answer a
// turn returns is a candidate that the post-answer checks may send back for one more turn each.
async function sessionLoop(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, signal: AbortSignal): Promise<AgentResult | typeof SWITCH_TRANSPORT> {
  const transcript = agent.transcript
  const guard = { improvementReminders: 0, evaluationsAsked: new Set<string>() }
  let instruction: string | null = null
  // Mail a cut-off turn carried into the session that goes on (pause.interruptedSession): only a fresh session gets it again.
  const held = new Set<string>()
  while (agent.id === 'root' || agent.turns < ceiling(run.limits, 'maxTurns')) {
    await new Promise(resolve => setImmediate(resolve))
    if (signal.aborted) throw abortError()
    runtime.collectChildren(run, agent, transcript)
    await runtime.preflightQuota(run, agent)
    if (agent.transport !== 'session') return SWITCH_TRANSPORT
    // `mailbox` and `lastWorkerTurn` are set by the prompt callback, which providerTurn calls before a result exists.
    let mailbox!: MailboxContext, lastWorkerTurn!: boolean, result: ProviderResult, session: SessionInfo
    for (;;) {
      // A known session is resumed; otherwise (first turn, or the replacement after a handover) a fresh one starts.
      const resume = !!agent.sessionId
      // `activity` lets the provider's inactivity guard see that a silent CLI is waiting on an Orbit tool call, not stuck.
      // (`runtime.mcp` is false once the server failed to start; `false?.activity` is undefined like `null?.activity`.)
      const token = agent.sessionToken
      session = { id: agent.sessionId || randomUUID(), token, mcpUrl: runtime.mcpUrl(), systemAppend: bounded(sessionGuide(run, agent), SYSTEM_APPEND_LIMIT), resume, activity: () => { try { return (runtime.mcp as McpServerLike | null)?.activity?.(token) || null } catch { return null } } }
      const base = resume ? null : await runtime.context(run, agent)
      const cursorBeforeTurn = agent.sessionCursor
      try {
        result = await runtime.providerTurn(run, agent, () => {
          lastWorkerTurn = agent.id !== 'root' && (agent.turns >= ceiling(run.limits, 'maxTurns') || run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns'))
          if (!resume) held.clear()
          mailbox = runtime.mailboxContext(run, agent, held)
          runtime.markCommunications(run, mailbox.deliveredIds, 'delivered', 'next-turn')
          for (const id of [...mailbox.deliveredIds, ...held]) agent.activeTurn?.delivered.add(id)
          let text
          if (resume) {
            const pending = transcript.slice(agent.sessionCursor)
            const text0 = instruction || runtime.wakeInstruction(pending, mailbox.text, mailbox.fromUser > 0)
            runtime.remember(agent, { type: 'instruction', content: text0, via: 'session' })
            text = runtime.resumePrompt(run, agent, text0, pending, mailbox.text, lastWorkerTurn)
          } else text = runtime.promptForTurn(base! /* not `resume`: built above */, transcript, run, runtime.teamContext(run, agent) + mailbox.text, agent)
          agent.sessionCursor = transcript.length
          return text
        }, session)
        agent.pausedSession = null
        break
      } catch (error) {
        // A pause or a message cut the turn off: the same session goes on with the note (pause.interruptedSession).
        if (error instanceof PauseInterrupt) { instruction = interruptedSession(runtime, agent, error, cursorBeforeTurn, mailbox.deliveredIds, held); continue }
        // A killed CLI may leave its session unreadable. Try that session once, then carry the note into a fresh one: the
        // failed resume's prompt already put it in the transcript, which the fresh session's full prompt carries.
        if (resume && agent.pausedSession && agent.pausedSession === agent.sessionId && !signal.aborted) {
          agent.pausedSession = null; agent.sessionId = null
          runtime.trace(run, agent.id, 'transport', `The session from before the pause could not be resumed (${(error as Error)?.message || error}); starting a fresh one with the pause note`)
          continue
        }
        // A continuation after a restart tries the session from before it; one that cannot be resumed (a CLI killed
        // mid-turn can leave it unreadable) is dropped once, and a fresh session starts from the restart note.
        if (resume && run.resumeSession && run.resumeSession === agent.sessionId && !signal.aborted) {
          run.resumeSession = undefined; agent.sessionId = null
          runtime.trace(run, agent.id, 'transport', `The session from before the restart could not be resumed (${(error as Error)?.message || error}); starting a fresh one with the restart note`)
          continue
        }
        // A session id the provider refuses to resume (providers.normalizeSession: malformed, it could pass for a CLI
        // flag) is dropped once: a fresh session starts from the full prompt instead of every later turn failing alike.
        if (resume && (error as { code?: unknown } | null)?.code === 'ORBIT_SESSION_ID' && !signal.aborted) {
          runtime.trace(run, agent.id, 'transport', `The session id could not be resumed (${(error as Error).message}); starting a fresh session`)
          agent.sessionId = null
          continue
        }
        // A refusal for quota (or a failed replacement) moves the agent to another subscription: the note is in the
        // transcript and the newcomer starts a fresh session (or the envelope loop) from it.
        if (!await runtime.recoverProvider(run, agent, error)) throw error
        if (agent.transport !== 'session') return SWITCH_TRANSPORT
        instruction = null
      }
    }
    agent.trial = null
    if (signal.aborted) throw abortError()
    // The provider may name the session itself (a Codex thread id); the record of this turn names the real one. One that
    // names its sessions (Cursor, Antigravity, Codex) says null when its stream carried no id: the next turn starts fresh
    // instead of "resuming" the id Orbit proposed, which that CLI never saw.
    agent.sessionId = typeof result?.sessionId === 'string' && result.sessionId ? result.sessionId : result?.sessionId === null ? null : session.id
    runtime.markCommunications(run, [...mailbox.deliveredIds, ...held], 'read', 'next-turn'); held.clear()
    const timing = agent.turnTimings.at(-1)
    if (timing) timing.sessionId = agent.sessionId
    if (timing?.orbitToolCalls) guard.improvementReminders = 0
    const candidate = String(typeof result === 'string' ? result : result?.text ?? '').trim()
    if (lastWorkerTurn) return candidate ? runtime.completeAgent(run, agent, candidate, true) : runtime.budgetHandoff(run, agent)
    // Post-answer checks, each at most once per candidate, each a resume of the same session. Whatever the extra turn
    // brings, the candidate is what the user gets if that turn fails.
    if (candidate) agent.draftAnswer = keptAnswer(runtime, run, agent, candidate)
    const participants = [...run.agentNodes.values()].filter(child => child.id !== agent.id && (agent.id === 'root' || child.parentId === agent.id))
    const pending = participants.filter(child => !AGENT_TERMINAL.has(child.status))
    const unseen = participants.some(child => !agent.seenChildren.has(runtime.resultKey(child)))
    if (pending.length || unseen || runtime.pendingMail(run, agent).length) {
      if (pending.length) {
        runtime.updateAgent(run, agent, { status: 'waiting', detail: 'Waiting for delegated results' })
        await runtime.waitForTeam(run, agent, pending)
      }
      // The user's words come first: they may have ended the wait for helpers before those finished.
      instruction = runtime.pendingMail(run, agent).some(message => message.kind === 'message' && message.fromAgentId === USER.id) ? 'The user wrote to you while you were working (below). Act on it, then give your final answer.'
        : pending.length || unseen ? 'Helpers you delegated to have finished since your last answer; their results are below. Integrate them, then give your final answer.'
        : 'Messages arrived after your last answer (below). Handle them, then give your final answer.'
      continue
    }
    if (!candidate) throw new Error('Provider returned an empty response')
    if (agent.id === 'root' && run.memoryEnabled && run.globalMemoryEnabled && runtime.memoryStore?.upsert) {
      const pendingEvaluations = participants.filter(child => child.model && ['done', 'error'].includes(child.status) && !run.evaluations.has(runtime.resultKey(child)) && !guard.evaluationsAsked.has(runtime.resultKey(child)))
      if (pendingEvaluations.length) {
        for (const child of pendingEvaluations) guard.evaluationsAsked.add(runtime.resultKey(child))
        instruction = `${evaluationReminder(pendingEvaluations)} Then repeat your final answer (as it is, if it still stands).`
        continue
      }
    }
    const improvementReminder = agent.id === 'root' ? improvement.reminderFor(runtime, run) : null
    if (improvementReminder) {
      if (guard.improvementReminders++ < REMINDER_LIMIT) { instruction = improvementReminder; continue }
      return runtime.completeAgent(run, agent, `${candidate}\n\n${improvement.acceptedWithout(runtime, run, REMINDER_LIMIT)}`)
    }
    if (agent.id === 'root' && run.memoryEnabled && run.skillLearning && !run.skillReminded && typeof runtime.capabilityStore?.save === 'function') {
      const unrated = [...run.skillUse].filter(([, use]) => !use.rated).map(([id, use]) => ({ id: id.slice(0, 12), name: use.name }))
      if (unrated.length || (run.usage.providerTurns >= SKILL_REVIEW_TURNS && !run.skillSaved)) {
        run.skillReminded = true
        runtime.remember(agent, { type: 'assistant', content: candidate, tool_calls: [], via: 'session' })
        instruction = skillReminder(unrated)
        continue
      }
    }
    return runtime.completeAgent(run, agent, candidate)
  }
  return runtime.budgetHandoff(run, agent)
}
// What a resumed session is told when the harness itself has no instruction: a woken agent gets its follow-up task or mail.
function wakeInstruction(runtime: OrbitRuntimeLike, pending: TranscriptEntry[], mailbox: string, fromUser = false): string {
  if (pending.some(entry => entry.type === 'followup_task')) return 'A follow-up task was assigned to you (below). Your earlier task and answer stand as context; complete the new task and report the result.'
  if (fromUser) return 'The user wrote to you (below). Your earlier task and answer stand as context; act on the message and report the result.'
  if (mailbox) return 'New messages arrived for you (below). Handle them; if nothing is required from you, say so briefly.'
  return 'You were resumed. Continue your work and give your answer.'
}

export { executeAgent, envelopeLoop, sessionLoop, wakeInstruction }
