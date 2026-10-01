// Helpers and constants shared by the runtime modules: bounded text, cancellation plumbing, the public view of an
// agent, and the diagnostic trace. Every other runtime module may require this one; it requires none of them.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { clip } from '../text.mts'
import type { AgentRecord, InternalAgentField, OrbitRuntimeLike, PublicAgent, RunLimits, RunRecord } from '../types.mts'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'restarting'])
const AGENT_TERMINAL = new Set(['done', 'error', 'cancelled'])
const ceiling = (limits: RunLimits, key: keyof RunLimits): number => limits[key] ?? Infinity
const MESSAGE_TOOLS = new Set(['send_message', 'broadcast_message', 'ask_team'])
// What counts as doing something rather than talking: it reopens a discussion the router closed.
const WORK_TOOLS = new Set(['write_file', 'edit_file', 'spawn_agent', 'followup_agent'])
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'spawn_agent', 'followup_agent', 'memory_save', 'memory_forget', 'context_save', 'capability_install', 'capability_feedback', 'improvement_plan', 'model_evaluate', ...MESSAGE_TOOLS])
// A skill an agent loads on purpose is read whole (an agent's skill is at most 12 000 characters, the user's 24 000).
const SKILL_READ_CHARS = 28000
const MCP_TOOL_PREFIX = 'mcp__orbit__'
// The user as a sender of communications: the root's task, and messages written to an agent while a run works.
const USER = Object.freeze({ id: 'user', name: 'Вы' })
// The secret mark of an agent's steering mail: the user's and a supervisor's words come under "[orbit:<mark>] MESSAGE
// FROM …" (mailbox.mts), and only the agent's own instructions name the mark (prompts.mts), so the same heading in a
// file, a command's output or a helper's result cannot pass for them. One per agent for its whole life, since Cursor
// reads its instructions only in a session's first message; a continuation that resumes the root's session keeps it.
const newMailMark = (): string => randomBytes(5).toString('hex')
const isMailMark = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{10}$/.test(value)
const mailTag = (agent: Pick<AgentRecord, 'mailMark'>): string => `[orbit:${agent.mailMark}]`
const INTERNAL_AGENT_FIELDS: readonly InternalAgentField[] = ['inbox', 'seenChildren', 'requestedModel', 'transcript', 'previousWork', 'ledger', 'ledgerDropped', 'workDone', 'failedCandidates', 'trial', 'partialTurn', 'quotaWarned', 'draftAnswer', 'activeTurn', 'stream', 'sessionToken', 'sessionCursor', 'transcriptChars', 'pausedSession', 'mailMark', 'effortNote']
// Google models (Antigravity) have reasoning built in: Orbit never sends an effort for them,
// whatever was persisted in settings, the provider pool or a spawn request.
const withoutGoogleReasoning = (providerId: string, effort: string): string => providerId === 'antigravity' ? '' : effort
// The observation limit protects the model's context. The root's final answer is for the user, so it gets
// a far larger allowance instead of being silently cut at the size of a tool observation.
const answerLimit = (run: RunRecord, agent: AgentRecord): number => agent.id === 'root' ? Math.max(run.limits.maxOutputChars, 60000) : run.limits.maxOutputChars
// Every field but the internal ones stays on the copy, which is what PublicAgent says.
const publicAgent = (agent: AgentRecord): PublicAgent => { const copy: Partial<AgentRecord> = { ...agent }; for (const key of INTERNAL_AGENT_FIELDS) delete copy[key]; return copy as PublicAgent }
// The tokens an agent has used (input + output), or undefined while no provider has reported any: what the directory shows.
const agentTokens = (agent: Pick<AgentRecord, 'usage'>): number | undefined => agent.usage ? agent.usage.inputTokens + agent.usage.outputTokens : undefined
// A plain JSON object: what a tool argument bag, an envelope or a parsed event must be before its fields are read.
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
// `values.includes(value)` that also narrows: the runtime checks model-supplied strings against small fixed lists.
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T)

function bounded(value: unknown, limit = 16000): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)) || ''
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text
}
class TurnBudgetError extends Error {}
function abortError(): Error { return new Error('Run cancelled') }
function overlappingWorkspaces(left: string, right: string): boolean {
  const relative = path.relative(left, right)
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) return true
  const reverse = path.relative(right, left)
  return reverse === '' || (!path.isAbsolute(reverse) && reverse !== '..' && !reverse.startsWith(`..${path.sep}`))
}
// Where an agent's files are: the isolated copy it works in (agent-worktree.mts) when it has one, else the run's workspace.
const agentWorkspace = (run: Pick<RunRecord, 'workspace'>, agent: Pick<AgentRecord, 'workspace'>): string => agent.workspace || run.workspace
// Whether two folders are the same one, as the file system names them (letter case and 8.3 short names aside).
function sameFolder(left: string, right: string): boolean {
  const real = (folder: string): string => { try { return fs.realpathSync.native(folder) } catch { return path.resolve(folder) } }
  return path.relative(real(left), real(right)) === ''
}
// The tree an agent's files belong to in the project's own terms, whatever copy it works in: the run's workspace, or
// Orbit's repository for a helper in an 'orbit' copy (isolation.target). The project index and the file map speak of it.
function logicalWorkspace(run: Pick<RunRecord, 'workspace' | 'agentNodes'>, agent: AgentRecord): string {
  for (let current: AgentRecord | undefined = agent; current?.workspace; current = current.parentId ? run.agentNodes.get(current.parentId) : undefined) {
    if (current.isolation?.kind === 'orbit') return current.isolation.target
  }
  return run.workspace
}
function abortable<T>(promise: T | PromiseLike<T>, signal: AbortSignal | null | undefined, timeoutMs?: number | null, timeoutMessage = 'Operation timed out'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false
    const finish = <V,>(callback: (value: V) => void, value: V) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value)
    }
    const abort = () => finish(reject, abortError())
    // Always observe both outcomes, even when cancellation wins.
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (timeoutMs) timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs)
  })
}
// A rejection of the provider call itself (runProvider), as opposed to Orbit's own work around a turn (building the
// prompt, the turn time budget): only such an error moves an agent to another subscription (handover.recoverProvider).
const FROM_PROVIDER = Symbol('orbit.fromProvider')
function markProviderFailure(error: unknown): unknown {
  if (error && typeof error === 'object') { try { Object.defineProperty(error, FROM_PROVIDER, { value: true }) } catch { /* A frozen error stays unmarked. */ } }
  return error
}
const fromProvider = (error: unknown): boolean => !!error && typeof error === 'object' && (error as Record<symbol, unknown>)[FROM_PROVIDER] === true
// An error Orbit deliberately survives (a best-effort index refresh, a usage counter, a quota reading) leaves a trace of
// kind `diagnostic` on the run instead of vanishing in an empty catch. It never throws, and a run that has ended keeps
// no new traces (trace() ignores it), so nothing here can break the path that called it.
function diagnostics(runtime: Pick<OrbitRuntimeLike, 'trace'>, run: RunRecord, where: string, error: unknown, agentId = 'root'): void {
  try { runtime.trace(run, agentId, 'diagnostic', `${where}: ${(error as Error | null | undefined)?.message || String(error)}`) } catch { /* Reporting a failure must not add one. */ }
}

export { TERMINAL, AGENT_TERMINAL, ceiling, WORK_TOOLS, MUTATING_TOOLS, SKILL_READ_CHARS, MCP_TOOL_PREFIX, USER, newMailMark, isMailMark, mailTag, withoutGoogleReasoning, answerLimit, publicAgent, agentTokens, isRecord, oneOf, bounded, clip, TurnBudgetError, abortError, overlappingWorkspaces, agentWorkspace, sameFolder, logicalWorkspace, abortable, diagnostics, markProviderFailure, fromProvider }
