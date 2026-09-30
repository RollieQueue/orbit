// One provider turn: the call itself with its slot, budgets, timing record and cancellation plumbing, and the stream
// of events it produces (buffered traces, the root's streamed answer, usage, native file events, the cut-off record).
import { randomUUID } from 'node:crypto'
import { ORBIT_RESPONSE_SCHEMA } from '../tool-schema.mts'
import { classifyQuotaError } from '../quota.mts'
import { TERMINAL, ceiling, MCP_TOOL_PREFIX, answerLimit, bounded, clip, TurnBudgetError, abortError, abortable, diagnostics } from './util.mts'
import { agentEnv } from './restart.mts'
import type { AgentRecord, OrbitRuntimeLike, ProviderEvent, ProviderResult, RunRecord, SessionInfo, StreamState, TurnTiming, UsageFigures } from '../types.mts'
// The root agent's answer in progress is published at most four times a second.
const STREAM_INTERVAL_MS = 250

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
  runtime.notePartialTurn(agent, event)
  runtime.noteTurnEvent(agent, event)
  // Bookkeeping about touched files must never break the provider stream it is read from.
  if (event?.native) { try { runtime.trackNativeFiles(run, agent, event) } catch (error) { diagnostics(runtime, run, 'trackNativeFiles', error, agent.id) } }
  if (event?.usage) runtime.recordUsage(run, event.usage)
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
  runtime.trace(run, agent.id, event?.kind || 'provider', text || bounded(event, 4000))
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
  if (!turn.timing.firstEventAt) turn.timing.firstEventAt = new Date().toISOString()
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
function recordUsage(runtime: OrbitRuntimeLike, run: RunRecord, usage: UsageFigures): void {
  const input = Number(usage.input_tokens ?? usage.prompt_tokens), output = Number(usage.output_tokens ?? usage.completion_tokens)
  if (Number.isFinite(input)) run.usage.inputTokens = (run.usage.inputTokens || 0) + input
  if (Number.isFinite(output)) run.usage.outputTokens = (run.usage.outputTokens || 0) + output
  const cached = Number(usage.cached_input_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens)
  if (Number.isFinite(cached)) run.usage.cachedInputTokens = (run.usage.cachedInputTokens || 0) + cached
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
  await runtime.acquireTurn(run, agent)
  const signal = runtime.agentSignal(run, agent)
  const controller = new AbortController(), abort = () => controller.abort()
  const slot = { held: true }
  let providerTask: Promise<ProviderResult> | undefined, counted = false, timing: TurnTiming | null = null
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw abortError()
    if (agent.id !== 'root' && run.usage.workerTurns >= ceiling(run.limits, 'maxTotalTurns')) throw new TurnBudgetError('Shared worker turn budget exhausted')
    run.usage.providerTurns++; agent.turns++
    if (agent.id !== 'root') run.usage.workerTurns++
    counted = true
    agent.partialTurn = { messages: new Map(), tools: new Map() }
    timing = { turn: agent.turns, transport: agent.transport, startedAt: new Date().toISOString(), firstEventAt: null, endedAt: null, promptChars: 0, nativeToolCalls: 0, orbitToolCalls: 0, sessionId: session?.id || null }
    agent.turnTimings.push(timing)
    runtime.updateAgent(run, agent, { status: 'working', detail: 'Provider is executing', startedAt: agent.startedAt || new Date().toISOString() })
    // `delivered`: the mail this turn's prompt carries; during a session turn it is no longer pending (see pendingMail).
    agent.activeTurn = { slot, timing, changed: false, nativeSeen: new Set(), stream: null, delivered: new Set() }
    const resolvedPrompt = typeof prompt === 'function' ? prompt() : prompt
    run.usage.promptChars = (run.usage.promptChars || 0) + resolvedPrompt.length
    agent.promptChars = (agent.promptChars || 0) + resolvedPrompt.length
    timing.promptChars = resolvedPrompt.length
    // The provider's CLI (and every shell it opens) learns which run it serves: a self-upgrade started there continues it.
    const extraEnv = agentEnv(runtime, run, agent)
    providerTask = runtime.trackOperation(run, Promise.resolve().then(() => runtime.runProvider({
      providerId: agent.providerId, model: agent.requestedModel, prompt: resolvedPrompt, workspace: run.workspace,
      mode: run.accessMode, accessMode: run.accessMode, approvalPolicy: run.approvalPolicy,
      reasoningEffort: agent.reasoningEffort,
      providerOptions: run.providerOptions[agent.providerId] || {},
      ...(session ? { session } : { responseSchema: ORBIT_RESPONSE_SCHEMA }),
      ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
      onApproval: request => runtime.approve(run, agent, request, controller.signal),
      signal: controller.signal, timeoutMs: run.limits.timeoutMs,
      onEvent: (event) => { if (!controller.signal.aborted) runtime.providerEvent(run, agent, event) },
    })), agent)
    const result = await abortable(providerTask, signal, run.limits.timeoutMs, 'Provider turn time budget exhausted')
    // A continuation's resume of the session from before the restart answered: from now on it is an ordinary session.
    if (session && run.resumeSession === session.id) run.resumeSession = undefined
    if (result?.model) { runtime.updateAgent(run, agent, { model: result.model }); if (agent.id === 'root') run.model = result.model }
    // A provider that could not apply the requested level (Cursor `auto` has no variants) reports the one that really ran.
    if (typeof result?.reasoningEffort === 'string' && result.reasoningEffort !== agent.reasoningEffort) { runtime.updateAgent(run, agent, { reasoningEffort: result.reasoningEffort }); if (agent.id === 'root') run.reasoningEffort = result.reasoningEffort }
    if (result?.usage) runtime.recordUsage(run, result.usage)
    timing.endedAt = new Date().toISOString()
    runtime.emit(run, 'run.info', { agentId: agent.id, providerId: agent.providerId, model: agent.model, usage: { ...run.usage }, timing: { ...timing } })
    return result
  } catch (error) {
    // A turn the failover is about to redo on another subscription was never taken: it must not eat the turn budgets.
    if (counted && runtime.failoverActive(run) && !signal.aborted && (agent.trial || classifyQuotaError(error, agent.providerId, runtime.clock()))) {
      run.usage.providerTurns--; agent.turns--
      if (agent.id !== 'root') run.usage.workerTurns--
    }
    throw error
  } finally {
    for (const [key, buffer] of run.providerBuffers) if (buffer.agentId === agent.id) {
      runtime.flushProviderBuffer(run, key)
      run.providerBuffers.delete(key)
    }
    if (timing && !timing.endedAt) timing.endedAt = new Date().toISOString()
    if (agent.activeTurn?.stream) runtime.flushStream(run, agent, agent.activeTurn.stream)
    agent.activeTurn = null
    controller.abort(); signal.removeEventListener('abort', abort)
    // Releasing a slot/overwrite lock before a cancelled process tree exits permits races. A slot an MCP wait gave
    // away and never took back (the agent was cancelled while waiting) is not released twice.
    const release = () => { if (slot.held) { slot.held = false; runtime.releaseTurn(run) } }
    if (providerTask) providerTask.then(release, release)
    else release()
  }
}

export { notePartialTurn, providerEvent, flushProviderBuffer, noteTurnEvent, streamOutput, flushStream, recordUsage, trackOperation, providerTurn }
