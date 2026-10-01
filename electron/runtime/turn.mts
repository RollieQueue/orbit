// One provider turn: the call itself with its slot, budgets, timing record and cancellation plumbing, and the stream
// of events it produces (buffered traces, the root's streamed answer, usage, native file events, the cut-off record).
import { randomUUID } from 'node:crypto'
import { ORBIT_RESPONSE_SCHEMA } from '../tool-schema.mts'
import { TERMINAL, ceiling, MCP_TOOL_PREFIX, answerLimit, bounded, clip, isRecord, TurnBudgetError, abortError, abortable, agentWorkspace, diagnostics, markProviderFailure } from './util.mts'
import { agentEnv } from './restart.mts'
import { pauseGate, pausedBy, PauseInterrupt, pauseNote } from './pause.mts'
import type { InterruptReason } from './pause.mts'
import { watchTurn, clearSilentTurns, isStall } from './watchdog.mts'
import type { TurnWatch } from './watchdog.mts'
import { messageNote, stopSteer } from './steer.mts'
import type { AgentRecord, AgentUsage, OrbitRuntimeLike, ProviderEvent, ProviderResult, RunRecord, SessionInfo, StreamState, ToolImage, TraceImage, TurnTiming, UsageFigures } from '../types.mts'
// The root agent's answer in progress is published at most four times a second.
const STREAM_INTERVAL_MS = 250
// A session turn can hold the whole task, so the window counts the agent's actions (tool calls) and shows its thinking
// while the turn runs: a change is published at most once a second, and the delayed update carries the latest state.
const PROGRESS_INTERVAL_MS = 1000
const progressTimers = new WeakMap<AgentRecord, ReturnType<typeof setTimeout>>()
function publishProgress(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): void {
  if (progressTimers.has(agent)) return
  const timer = setTimeout(() => {
    progressTimers.delete(agent)
    if (agent.activeTurn && !TERMINAL.has(run.status)) runtime.updateAgent(run, agent, {}, false)
  }, PROGRESS_INTERVAL_MS)
  timer.unref?.()
  progressTimers.set(agent, timer)
}
// A turn that ends with a change still unpublished sends it at once, with the turn closed: the window must not keep
// showing the thinking (or an old count) of a turn that is over until the agent's next update.
function flushProgress(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): void {
  const timer = progressTimers.get(agent)
  if (timer === undefined) return
  clearTimeout(timer); progressTimers.delete(agent)
  if (!TERMINAL.has(run.status)) runtime.updateAgent(run, agent, {}, false)
}
// The model's thinking in progress, which the window shows as «думает · ~N тыс. токенов»: the provider's estimate of the
// thinking block so far. A text or a tool call of the agent itself (not of a native subagent) means the block is over.
function noteThinking(timing: TurnTiming, event: ProviderEvent): void {
  if (event.kind === 'thinking') {
    if (event.done) delete timing.thinking
    else timing.thinking = Math.max(0, Math.round(Number(event.tokens) || 0))
  } else if (((event.kind === 'output' && event.text) || event.kind === 'tool') && !event.parentToolId) delete timing.thinking
}
// Thinking still open when the turn ends is over with it (the provider stopped, the turn was cut off); the window learns
// it with the turn's end (flushProgress).
function closeThinking(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, timing: TurnTiming): void {
  if (timing.thinking === undefined) return
  delete timing.thinking
  publishProgress(runtime, run, agent)
}

// What a turn had produced when the provider cut it off: the last streamed message and the native tool actions.
function notePartialTurn(runtime: OrbitRuntimeLike, agent: AgentRecord, event: ProviderEvent): void {
  const partial = agent.partialTurn
  if (!partial || event?.parentToolId) return
  if (event.kind === 'output') {
    const id = event.messageId || 'output'
    const text = event.replace ? String(event.text || '') : (partial.messages.get(id) || '') + String(event.text || '')
    partial.messages.delete(id); partial.messages.set(id, text)
    // The map holds more than four entries here, so its first key exists.
    if (partial.messages.size > 4) partial.messages.delete(partial.messages.keys().next().value!)
  } else if (event.native && event.kind === 'tool') {
    // A tool event without an id is keyed by its text (possibly undefined, as before: one shared slot).
    const key = (event.toolId || event.text) as string
    partial.tools.delete(key)
    partial.tools.set(key, `${event.tool || 'tool'}: ${clip(event.text, 140)}${event.status ? ` [${event.status}]` : ''}`)
    if (partial.tools.size > 12) partial.tools.delete(partial.tools.keys().next().value!)
  }
}
function providerEvent(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, event: ProviderEvent): void {
  if (runtime.agentSignal(run, agent).aborted) return
  if (event?.kind === 'quota') {
    // Account figures from a live turn refine the shared monitor; they are not part of the agent's story.
    try { runtime.quota?.ingest?.(agent.providerId, event.quota) } catch (error) { diagnostics(runtime, run, 'quota.ingest', error, agent.id) /* Quota bookkeeping never breaks the stream. */ }
    return
  }
  // Tokens spent since the provider's last report: counted, but no trace and no sign of life for the watchdog.
  if (event?.kind === 'usage') { runtime.recordUsage(run, agent, event.usage); return }
  runtime.notePartialTurn(agent, event)
  const counted = agent.activeTurn?.timing.nativeToolCalls, thinking = agent.activeTurn?.timing.thinking
  runtime.noteTurnEvent(agent, event)
  if (agent.activeTurn && (agent.activeTurn.timing.nativeToolCalls !== counted || agent.activeTurn.timing.thinking !== thinking)) publishProgress(runtime, run, agent)
  // The thinking estimate lives in the turn's record for the window; it is no trace.
  if (event?.kind === 'thinking') return
  // Bookkeeping about touched files must never break the provider stream it is read from.
  if (event?.native) { try { runtime.trackNativeFiles(run, agent, event) } catch (error) { diagnostics(runtime, run, 'trackNativeFiles', error, agent.id) } }
  if (event?.usage) runtime.recordUsage(run, agent, event.usage)
  if (agent.id === 'root' && event?.kind === 'output' && !event.parentToolId && (event.partial || event.messageId)) runtime.streamOutput(run, agent, event)
  if (['output', 'reasoning'].includes(event?.kind) && (event.partial || event.messageId)) {
    const key = `${agent.id}:${agent.turns}:${event.parentToolId || 'main'}:${event.kind}:${event.messageId || 'output'}`
    let buffer = run.providerBuffers.get(key)
    if (!buffer) {
      buffer = { id: randomUUID(), text: '', kind: event.kind, agentId: agent.id, timer: null, dirty: false }
      run.providerBuffers.set(key, buffer)
    }
    buffer.text = event.replace ? String(event.text || '') : buffer.text + String(event.text || '')
    buffer.dirty = true
    if (!buffer.timer) buffer.timer = setTimeout(() => runtime.flushProviderBuffer(run, key), 250)
    if (!event.partial) runtime.flushProviderBuffer(run, key)
    return
  }
  for (const [key, buffer] of run.providerBuffers) if (buffer.agentId === agent.id) runtime.flushProviderBuffer(run, key)
  const text = [event?.text || event?.message || '', event?.output ? bounded(event.output, 4000) : '', event?.exitCode !== undefined ? `exitCode=${event.exitCode}` : '', event?.status ? `status=${event.status}` : ''].filter(Boolean).join('\n')
  const images = event?.images?.length ? saveImages(runtime, run, agent, event.images) : undefined
  runtime.trace(run, agent.id, event?.kind || 'provider', text || bounded(event, 4000), undefined, images)
}
// The images of a tool result (a screenshot the agent read) go to the run store; the trace only names them. A few per
// result at most, and a failed write never breaks the provider stream.
function saveImages(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, images: ToolImage[]): TraceImage[] {
  const saved: TraceImage[] = []
  for (const image of images.slice(0, 8)) {
    try { const record = runtime.runStore?.saveImage?.(run.runId, image); if (record) saved.push(record) }
    catch (error) { diagnostics(runtime, run, 'saveImage', error, agent.id) }
  }
  return saved
}
function flushProviderBuffer(runtime: OrbitRuntimeLike, run: RunRecord, key: string): void {
  const buffer = run.providerBuffers.get(key)
  if (!buffer) return
  clearTimeout(buffer.timer ?? undefined); buffer.timer = null
  if (buffer.dirty && buffer.text) runtime.trace(run, buffer.agentId, buffer.kind, buffer.text, buffer.id)
  buffer.dirty = false
}
// Per-turn timing: when the provider first spoke, and how many native tool calls it made (Orbit's MCP tools are
// counted where they are dispatched). A native call is counted once however many status events it produces.
function noteTurnEvent(runtime: OrbitRuntimeLike, agent: AgentRecord, event: ProviderEvent): void {
  const turn = agent.activeTurn
  if (!turn) return
  turn.watch?.note(event)
  if (!turn.timing.firstEventAt) turn.timing.firstEventAt = new Date().toISOString()
  if (event) noteThinking(turn.timing, event)
  if (event?.kind !== 'tool' || !event.native || String(event.tool || '').startsWith(MCP_TOOL_PREFIX)) return
  const key = event.toolId || `${event.tool || 'tool'}:${turn.nativeSeen.size}`
  if (turn.nativeSeen.has(key)) return
  turn.nativeSeen.add(key)
  turn.timing.nativeToolCalls++
}
// The root agent's answer as it is written: the whole text so far, at most four times a second, under one message id
// that the final message.added reuses. A tool envelope being typed in envelope mode is not an answer and stays out.
function streamOutput(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, event: ProviderEvent): void {
  const turn = agent.activeTurn
  if (!turn) return
  if (!turn.stream) turn.stream = { messageId: randomUUID(), parts: new Map(), lastAt: 0, timer: null, dirty: false }
  const stream = turn.stream
  agent.stream = stream
  const id = event.messageId || 'output'
  const text = event.replace ? String(event.text || '') : (stream.parts.get(id) || '') + String(event.text || '')
  stream.parts.delete(id); stream.parts.set(id, text)
  stream.dirty = true
  const elapsed = Date.now() - stream.lastAt
  if (elapsed >= STREAM_INTERVAL_MS) runtime.flushStream(run, agent, stream)
  else if (!stream.timer) { stream.timer = setTimeout(() => runtime.flushStream(run, agent, stream), STREAM_INTERVAL_MS - elapsed); stream.timer.unref?.() }
}
function flushStream(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, stream: StreamState): void {
  clearTimeout(stream.timer ?? undefined); stream.timer = null
  if (!stream.dirty || TERMINAL.has(run.status)) return
  stream.dirty = false
  const content = [...stream.parts.values()].filter(Boolean).join('\n\n')
  if (!content.trim() || /^\s*(?:```(?:json)?\s*)?\{/.test(content)) return
  stream.lastAt = Date.now()
  runtime.emit(run, 'message.streaming', { agentId: agent.id, messageId: stream.messageId, content: bounded(content, answerLimit(run, agent)) }, false)
}
// Token figures as vendors spell them, in one shape; null when they hold no number at all. `inputTokens` is everything the
// model was sent, the cached part included: Anthropic and Cursor count the cache apart from the input, so it is added to
// it, while OpenAI-style figures (Codex, endpoints, Ollama) already include it.
function normalizeUsage(usage: unknown): AgentUsage | null {
  if (!isRecord(usage)) return null
  const figures: UsageFigures = usage
  const first = (...values: unknown[]): number | undefined => {
    for (const value of values) { const number = Number(value); if (value != null && Number.isFinite(number) && number >= 0) return number }
    return undefined
  }
  const read = first(figures.cache_read_input_tokens, figures.cacheReadTokens, figures.cache_read_tokens), written = first(figures.cache_creation_input_tokens, figures.cacheWriteTokens)
  const input = first(figures.input_tokens, figures.inputTokens, figures.prompt_tokens), output = first(figures.output_tokens, figures.outputTokens, figures.completion_tokens)
  const apart = read !== undefined || written !== undefined
  const cached = apart ? read : first(figures.cached_input_tokens, figures.prompt_tokens_details?.cached_tokens)
  if (input === undefined && output === undefined && cached === undefined) return null
  return { inputTokens: (input ?? 0) + (apart ? (read ?? 0) + (written ?? 0) : 0), outputTokens: output ?? 0, cachedInputTokens: cached ?? 0 }
}
// Adds what a provider reported to the agent and, as the sum of its agents, to the run. The window shows it while the turn
// runs, but at most once a second (publishProgress), however often the provider's stream reports.
function recordUsage(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, usage: unknown): void {
  const figures = normalizeUsage(usage)
  if (!figures) return
  agent.usage = {
    inputTokens: (agent.usage?.inputTokens ?? 0) + figures.inputTokens, outputTokens: (agent.usage?.outputTokens ?? 0) + figures.outputTokens,
    cachedInputTokens: (agent.usage?.cachedInputTokens ?? 0) + figures.cachedInputTokens,
  }
  run.usage.inputTokens = (run.usage.inputTokens ?? 0) + figures.inputTokens
  run.usage.outputTokens = (run.usage.outputTokens ?? 0) + figures.outputTokens
  run.usage.cachedInputTokens = (run.usage.cachedInputTokens ?? 0) + figures.cachedInputTokens
  publishProgress(runtime, run, agent)
}
function trackOperation<T>(runtime: OrbitRuntimeLike, run: RunRecord, operation: T | PromiseLike<T>, agent: { id: string }): Promise<Awaited<T>> {
  const pending = Promise.resolve(operation)
  run.operations.add(pending)
  run.agentOperations.get(agent?.id)?.add(pending)
  const finished = () => { run.operations.delete(pending); run.agentOperations.get(agent?.id)?.delete(pending) }
  pending.then(finished, finished)
  return pending
}
// One provider turn. `session` (session transport) is passed to the provider in place of the envelope schema; the
// turn's slot object lets an MCP wait release the model slot and take it back (see dispatchMcp).
async function providerTurn(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, prompt: string | (() => string), session: SessionInfo | null = null): Promise<ProviderResult> {
  for (;;) {
    await pauseGate(runtime, run, agent)
    await runtime.acquireTurn(run, agent)
    if (!pausedBy(run, agent)) break
    runtime.releaseTurn(run)
  }
  const signal = runtime.agentSignal(run, agent)
  const controller = new AbortController(), abort = () => controller.abort()
  const slot = { held: true }
  let providerTask: Promise<ProviderResult> | undefined, counted = false, timing: TurnTiming | null = null
  let interrupted: InterruptReason | null = null, pauseHolder: AgentRecord | null = null, watch: TurnWatch | null = null
  // The session the provider's stream named in this session turn (a Codex thread, a Cursor chat, an Antigravity conversation),
  // and one it named instead of the session it was to resume.
  let named: string | null = null, strayed: string | null = null
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw abortError()
    if (agent.id !== 'root' && run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) throw new TurnBudgetError('Shared worker turn budget exhausted')
    run.usage.providerTurns++; agent.turns++
    if (agent.id !== 'root') run.usage.workerTurns++
    counted = true
    agent.partialTurn = { messages: new Map(), tools: new Map() }
    // The record names the turn's session as its provider knows it: the one resumed, or Claude's, started under Orbit's id
    // (--session-id). Codex, Cursor and Antigravity name their own: none until their stream does (below), as the id Orbit
    // proposes is not theirs. A cut first turn's repeat and a restart's continuation resume it (resume.rootSession).
    timing = { turn: agent.turns, transport: agent.transport, startedAt: new Date().toISOString(), firstEventAt: null, endedAt: null, promptChars: 0, nativeToolCalls: 0, orbitToolCalls: 0, sessionId: session && (session.resume || agent.providerId === 'claude') ? session.id || null : null }
    agent.turnTimings.push(timing)
    runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing', startedAt: agent.startedAt || new Date().toISOString() })
    // `delivered`: the mail this turn's prompt carries; during a session turn it is no longer pending (see pendingMail).
    // `signal`: aborted when the turn ends, however it ends; an Orbit wait the turn called ends with it (dispatchMcp).
    agent.activeTurn = { slot, timing, changed: false, nativeSeen: new Set(), stream: null, delivered: new Set(), signal: controller.signal,
      interrupt: (reason: InterruptReason = 'pause') => { interrupted = reason; pauseHolder = pausedBy(run, agent); controller.abort() } }
    const resolvedPrompt = typeof prompt === 'function' ? prompt() : prompt
    run.usage.promptChars = (run.usage.promptChars || 0) + resolvedPrompt.length
    agent.promptChars = (agent.promptChars || 0) + resolvedPrompt.length
    timing.promptChars = resolvedPrompt.length
    // The provider's CLI (and every shell it opens) learns which run it serves: a self-upgrade started there continues it.
    const extraEnv = agentEnv(runtime, run, agent)
    // A turn that reports nothing for too long is stopped (watchdog.mts); recoverProvider repeats it or hands it over.
    const turnWatch = watch = agent.activeTurn.watch = watchTurn(agent, session, () => controller.abort())
    providerTask = runtime.trackOperation(run, Promise.resolve().then(() => runtime.runProvider({
      providerId: agent.providerId, model: agent.requestedModel, prompt: resolvedPrompt, workspace: agentWorkspace(run, agent),
      mode: run.accessMode, accessMode: run.accessMode, approvalPolicy: run.approvalPolicy,
      reasoningEffort: agent.reasoningEffort,
      providerOptions: run.providerOptions[agent.providerId] || {},
      ...(session ? { session } : { responseSchema: ORBIT_RESPONSE_SCHEMA }),
      ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
      onApproval: request => turnWatch.hold(runtime.approve(run, agent, request, controller.signal)),
      signal: controller.signal, timeoutMs: run.limits.timeoutMs,
      onEvent: (event) => {
        if (controller.signal.aborted) return
        // The stream naming its session is not the model speaking: the turn's record names that session at once, and a cut
        // first turn resumes it (below).
        if (event?.kind !== 'session') return runtime.providerEvent(run, agent, event)
        if (!session || !event.sessionId || !timing) return
        timing.sessionId = named = event.sessionId
        // A CLI that did not find the session from before a cut or a restart may start another one silently (Codex
        // `exec resume`, the App Server's thread/start): without the task, which only the lost session held. The turn
        // stops before the model acts, and the session loop starts afresh with the full prompt.
        if (session.resume && named !== session.id && (agent.pausedSession === session.id || run.resumeSession === session.id)) { strayed = named; controller.abort() }
      },
    })).catch((error: unknown) => { throw markProviderFailure(error) }), agent)
    const result = await abortable(providerTask, controller.signal, run.limits.timeoutMs, 'Provider turn time budget exhausted')
    clearSilentTurns(agent)
    // A continuation's resume of the session from before the restart answered: from now on it is an ordinary session.
    if (session && run.resumeSession === session.id) run.resumeSession = undefined
    if (result?.model) { runtime.updateAgent(run, agent, { model: result.model }); if (agent.id === 'root') run.model = result.model }
    // A provider that could not apply the requested level (Cursor `auto` has no variants) reports the one that really ran.
    if (typeof result?.reasoningEffort === 'string' && result.reasoningEffort !== agent.reasoningEffort) { runtime.updateAgent(run, agent, { reasoningEffort: result.reasoningEffort }); if (agent.id === 'root') run.reasoningEffort = result.reasoningEffort }
    if (result?.usage) runtime.recordUsage(run, agent, result.usage)
    timing.endedAt = new Date().toISOString()
    closeThinking(runtime, run, agent, timing)
    runtime.emit(run, 'run.info', { agentId: agent.id, providerId: agent.providerId, model: agent.model, usage: { ...run.usage }, timing: { ...timing } })
    return result
  } catch (caught) {
    // A turn that is repeated (after a silence, on another subscription, with a message the agent is to read now, or
    // after the user's pause) was never taken: it must not eat the turn budgets.
    const refund = () => { if (counted) { run.usage.providerTurns--; agent.turns--; if (agent.id !== 'root') run.usage.workerTurns-- } }
    if (interrupted && !signal.aborted) {
      refund()
      // The model itself spoke (a stderr line or a note from before the CLI started does not count): its session holds
      // the turn's prompt. A first session turn that spoke has its session, which the repeat resumes: the one the turn's
      // record names (named by the stream of Codex, Cursor or Antigravity, or Claude's under Orbit's id), as a restart's
      // continuation resumes it (resume.rootSession).
      const spoke = watch ? Number.isFinite(watch.stepAge()) : !!timing?.firstEventAt
      const opened = session && !session.resume && spoke ? timing?.sessionId || null : null
      throw new PauseInterrupt(interrupted === 'message' ? messageNote(agent) : pauseNote(agent, pauseHolder), interrupted, opened, spoke)
    }
    if (strayed && !signal.aborted) {
      refund()
      throw Object.assign(new Error(`${agent.providerId} opened session ${strayed} instead of resuming ${session?.id}`), { code: 'ORBIT_SESSION_ID' })
    }
    // A turn the watchdog stopped ends as a stall, whatever the aborted provider reported.
    const error = watch?.stalled && !signal.aborted ? watch.stalled : caught
    if (!signal.aborted && (isStall(error) || runtime.failoverActive(run))) refund()
    throw error
  } finally {
    watch?.stop()
    for (const [key, buffer] of run.providerBuffers) if (buffer.agentId === agent.id) {
      runtime.flushProviderBuffer(run, key)
      run.providerBuffers.delete(key)
    }
    if (timing && !timing.endedAt) timing.endedAt = new Date().toISOString()
    if (timing) closeThinking(runtime, run, agent, timing)
    flushProgress(runtime, run, agent)
    if (agent.activeTurn?.stream) runtime.flushStream(run, agent, agent.activeTurn.stream)
    stopSteer(agent.activeTurn)
    agent.activeTurn = null
    controller.abort(); signal.removeEventListener('abort', abort)
    // Releasing a slot/overwrite lock before a cancelled process tree exits permits races. A slot an MCP wait gave
    // away and never took back (the agent was cancelled while waiting) is not released twice.
    const release = () => { if (slot.held) { slot.held = false; runtime.releaseTurn(run) } }
    if (providerTask) providerTask.then(release, release)
    else release()
  }
}

export { notePartialTurn, providerEvent, flushProviderBuffer, noteTurnEvent, streamOutput, flushStream, recordUsage, trackOperation, providerTurn, publishProgress }
