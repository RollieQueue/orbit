// restart_orbit: the root agent asks Orbit to apply its own new code. The restart host (electron/resume.mts) runs the
// self-upgrade script, which verifies and builds the code and restarts as little of Orbit as it must; this module checks
// the call, keeps the script's progress in one trace of the agent, and turns the outcome into the tool's result or error.
// It is offered to the root agent of any run, whatever project the chat works on: Orbit improves itself from every chat,
// and the self-upgrade always acts on the repository Orbit runs from (host.repoRoot), never on the run's workspace. It
// also gives every command the root agent runs the environment that names its run (so a self-upgrade started from its own
// shell is continued the same way), writes the restart note of a run a restart ends, and prepares the root agent of the
// continuation.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { restartEnv } from '../resume.mts'
import type { RestartHost, RestartLevel, RestartResult, RestartRollback } from '../resume.mts'
import { attachmentLines } from '../attachments.mts'
import { TERMINAL, AGENT_TERMINAL, abortError, bounded, clip, overlappingWorkspaces, isMailMark } from './util.mts'
import type { AgentRecord, Attachment, OrbitRuntimeLike, RunRecord, ToolArgs } from '../types.mts'

const REASON_CHARS = 1000
const CONTINUE_CHARS = 8000
// The progress trace is rewritten at most this often and keeps this much of the script's latest output.
const TRACE_EVERY_MS = 500
const TRACE_CHARS = 6000
const NOTE_CHARS = 5000
const RESUMED_FILES = 'Files the user attached in that run (still in Orbit\'s attachments folder; read them with your file tools when the task needs them):'
// What the model learns when the script refused before doing anything (the other statuses get the general advice).
const HINTS: Record<string, string> = {
  'cycle-limit': 'Orbit was restarted too many times in a short while (ORBIT_UPGRADE_MAX_CYCLES); nothing was restarted. Tell the user, or try again later.',
  locked: 'Another self-upgrade is already running; wait for it to finish, then call restart_orbit again if it is still needed.',
  busy: 'Another restart is already in progress; wait for it to finish.',
  'spawn-failed': 'The self-upgrade script could not be started; nothing was restarted.',
  'no-health-report': 'Orbit runs with ORBIT_HEALTH_FILE=0 and writes no health report, so a restart could be neither checked nor rolled back; nothing was restarted. Do not call restart_orbit again in this Orbit: tell the user to restart Orbit to apply the change.',
}
// Where a rolled-back upgrade keeps the failed change (scripts/self-upgrade.cjs), when its report does not say.
const FAILED_PATCH = 'artifacts/self-upgrade-failed.patch'
const FAILED_REF = 'refs/orbit/self-upgrade/failed'

interface RestartObservation { ok: true; level: RestartLevel; restarted: boolean; status: string | null; note: string }

function setRestartHost(runtime: OrbitRuntimeLike, host: RestartHost | null): void { runtime.restartHost = host }
// `npm run dev` serves the window from Vite: a relaunch would stop the dev server with it.
const devServer = (): boolean => process.env.ORBIT_DEV === '1'
// A folder as the file system names it (8.3 short names expanded), or as given when it cannot be resolved.
function realFolder(folder: string): string {
  try { return fs.realpathSync.native(folder) } catch { return path.resolve(folder) }
}
// Whether the run works on Orbit's own code: its workspace is the repository Orbit runs from, a folder inside it, or a
// folder that contains it (letter case aside on Windows, as path.relative compares there). Not a condition of
// restart_orbit (every project's run may use it), but of what the agent is told: in Orbit's repository its edits are
// Orbit's code, elsewhere they belong to the project and Orbit's own code is a separate checkout (prompts.mts,
// improvement.mts).
function onOrbitRepository(host: RestartHost, run: RunRecord): boolean {
  return overlappingWorkspaces(realFolder(run.workspace), realFolder(host.repoRoot))
}
// The same for a runtime that may have no restart host (a packaged build, a test): false then.
function runOnOrbitRepository(runtime: OrbitRuntimeLike, run: RunRecord): boolean {
  return !!runtime.restartHost?.available && onOrbitRepository(runtime.restartHost, run)
}
// Whether the root agent of this run can use restart_orbit at all (the prompt mentions it only then). In any project's
// chat: the restart applies Orbit's own code, wherever the user is working when the agent changes it.
function restartOffered(runtime: OrbitRuntimeLike, run: RunRecord, agent: { id: string }): boolean {
  return agent.id === 'root' && run.accessMode !== 'read-only' && !devServer() && !!runtime.restartHost?.available
}

// The environment of every command the root agent runs (its provider CLI and Orbit's run_command): what the self-upgrade
// script needs to write the intent that continues this run, and to signal this Orbit's profile. Given exactly where
// restart_orbit itself is offered: empty for helpers (only the orchestrator restarts Orbit), read-only runs, under the
// Vite dev server (the script refuses it) and without a host that can restart Orbit.
function agentEnv(runtime: OrbitRuntimeLike, run: RunRecord, agent: { id: string }): Record<string, string> {
  const host = runtime.restartHost
  if (!host || !restartOffered(runtime, run, agent)) return {}
  return restartEnv(run, agent, host.resumeFile, host.userData)
}

// What the root of the continuation is told about the run a restart ends, written while that run still exists (its work
// log, helpers and a cut-off turn are known only here), like failover's handover note, and saved with the run.
function restartNote(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): string {
  const files = agent.files || { read: [], wrote: [] }
  const lines = [
    `RESTART NOTE: Orbit restarted with new code, and this run continues run ${run.runId}, which the restart ended (status restarting). You are the same orchestrator; this note is Orbit's record of that run.`,
    `State before the restart: ${agent.turns} turn(s) taken; files written: ${JSON.stringify(files.wrote.slice(-10))}; files read: ${JSON.stringify(files.read.slice(-8))}.`,
  ]
  const actions = agent.ledger.slice(-10).map(entry => entry.text)
  if (actions.length) lines.push(`Your last recorded actions:\n${actions.map(action => `- ${action}`).join('\n')}`)
  const helpers = [...run.agentNodes.values()].filter(member => member.id !== agent.id).slice(-8)
  if (helpers.length) lines.push(`Helpers of that run (all stopped by the restart; team_history returns their full reports):\n${helpers.map(member => `- ${member.name} [${AGENT_TERMINAL.has(member.status) ? member.status : 'stopped while working'}]: ${clip(member.result || member.error || member.task, 240)}`).join('\n')}`)
  // A provider turn still running (a session waiting for restart_orbit) was cut off; between envelope turns nothing was.
  const partial = agent.activeTurn ? agent.partialTurn : null
  const text = partial ? [...partial.messages.values()].at(-1) || '' : ''
  const tools = partial ? [...partial.tools.values()] : []
  if (text || tools.length) {
    lines.push('Your last turn was cut off by the restart, so its result is missing.')
    if (text) lines.push(`Text you had streamed (may be incomplete): ${JSON.stringify(clip(text, 1200))}`)
    if (tools.length) lines.push(`Native tool actions you had started (they may already have taken effect):\n${tools.map(action => `- ${action}`).join('\n')}`)
  }
  lines.push('Check the real state (read the files, run the check) before repeating any write or command from before the restart.')
  return bounded(lines.join('\n'), NOTE_CHARS)
}
// The root of a continuation after a restart. When it keeps the old root's provider on the session transport, the old
// session is resumed and its first turn carries the continuation's message; otherwise, or when that resume fails
// (loops.mts drops the id once), the root starts fresh. Either way its transcript begins with the restart note, followed
// by the files the user attached in the run it continues (a fresh root has never seen their paths). A resumed session
// keeps the mark of the old root's mail: the messages it already holds carry that mark, and Cursor would not hear of a
// new one (it reads its instructions only in a session's first message).
function prepareContinuation(runtime: OrbitRuntimeLike, run: RunRecord, root: AgentRecord, note: string, session?: { id: string; providerId: string; mailMark?: string }, files: Attachment[] = []): void {
  const resumable = !!session?.id && root.transport === 'session' && root.providerId === session.providerId
  if (resumable) { root.sessionId = session.id; run.resumeSession = session.id }
  if (resumable && isMailMark(session.mailMark)) root.mailMark = session.mailMark
  const attached = files.length ? `\n${RESUMED_FILES}\n${attachmentLines(files)}` : ''
  runtime.remember(root, { type: 'instruction', content: `${resumable ? `${run.prompt}\n\n` : ''}${note}${attached}` })
}

function checkedText(value: unknown, label: string, limit: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`restart_orbit needs ${label}`)
  if (text.length > limit) throw new Error(`restart_orbit: ${label} is longer than ${limit} characters`)
  if (text.includes('\0')) throw new Error(`restart_orbit: ${label} contains a NUL character`)
  return text
}
// The script's output in one trace, rewritten in place while it runs.
function progressTrace(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): { line: (text: string) => void; close: () => void } {
  const id = randomUUID(), lines: string[] = []
  let size = 0, dirty = false, timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!dirty) return
    dirty = false
    runtime.trace(run, agent.id, 'restart', lines.join('\n'), id)
  }
  const line = (text: string) => {
    lines.push(text); size += text.length + 1
    while (size > TRACE_CHARS && lines.length > 1) size -= lines.shift()!.length + 1
    dirty = true
    if (!timer) { timer = setTimeout(flush, TRACE_EVERY_MS); timer.unref?.() }
  }
  return { line, close: flush }
}
// A restart whose new code failed its health check was rolled back: Orbit runs the code from before, and the sources
// may have been put back too, the agent's change being kept aside. Its next step is to bring that change back.
function rolledBack(rollback: RestartRollback | undefined): string {
  const patch = rollback?.patch || FAILED_PATCH, ref = rollback?.failedRef || FAILED_REF
  const head = 'The restarted Orbit failed its health check, so the self-upgrade rolled it back to the code that ran before'
  if (!rollback) return `${head}. If your changes to Orbit's sources were reverted, they are kept in ${patch} and ${ref}: re-apply them before fixing, then fix what the output shows and call restart_orbit again.`
  if (!rollback.restored.length) return `${head}; your source files were left as they are (${rollback.reason || 'no trustworthy rollback base'}), and the failed change is also kept in ${patch} and ${ref}. Fix what the output shows, then call restart_orbit again.`
  const paths = rollback.restored.map(entry => `${entry}/`).join(' and ')
  return `${head}: your changes to ${paths} were reverted to the rollback base ${rollback.base || '(unknown)'}. They are kept in ${patch} and ${ref}: re-apply them before fixing (git restore --source=${ref} --worktree -- ${rollback.restored.join(' ')}), then fix what the output shows and call restart_orbit again.`
}
// Improvement mode: a restart refused for the cycle limit leaves the batch's tasks done; the next restart applies them.
const LOOP_CYCLE_LIMIT = ' Improvement mode: keep the batch\'s tasks done with the evidence "verified, not applied yet (cycle limit)"; the next restart_orbit applies them.'
function failure(result: Extract<RestartResult, { ok: false }>, run: RunRecord): Error {
  const hint = HINTS[result.status] ? `${HINTS[result.status]}${result.status === 'cycle-limit' && run.improvementMode ? LOOP_CYCLE_LIMIT : ''}` : ''
  const advice = result.status === 'rolled-back' ? rolledBack(result.rollback) : hint || 'Nothing was restarted: the running Orbit keeps its current code. Fix what the output shows, then call restart_orbit again.'
  const head = `restart_orbit failed (self-upgrade status ${result.status}${result.exitCode === null ? '' : `, exit code ${result.exitCode}`}${result.error ? `: ${result.error}` : ''}). ${advice}`
  return new Error(result.output ? `${head}\nOutput (last lines):\n${result.output}` : head)
}
function observation(result: Extract<RestartResult, { ok: true }>): RestartObservation {
  if (result.level === 'none') return { ok: true, level: 'none', restarted: false, status: result.status, note: 'Nothing to apply: the running Orbit already has this code, so nothing was restarted.' }
  if (result.level === 'renderer') return { ok: true, level: 'renderer', restarted: true, status: result.status, note: 'Only the interface changed: the window reloaded the new build, while the runtime, this run and your session go on. Continue with what you planned (continueWith).' }
  return { ok: true, level: result.level, restarted: true, status: result.status, note: 'Orbit is restarting with the new code: this run ends with the status restarting, and a new run in this chat continues with continueWith.' }
}

// This run's own helpers stop with it and are continued by the restart note; other chats would simply be cut off.
function refuseWhileOthersWork(runtime: OrbitRuntimeLike, run: RunRecord): void {
  const others = [...runtime.runs.values()].filter(other => other !== run && !TERMINAL.has(other.status))
  if (!others.length) return
  const listed = others.slice(0, 5).map(other => `chat ${other.chatId} ("${clip(other.prompt, 60)}")`).join('; ')
  throw new Error(`restart_orbit refused: ${others.length} other chat(s) are still working and a restart would cut them off: ${listed}${others.length > 5 ? '; …' : ''}. Nothing was restarted. Wait for them to finish (wait_message {timeout_ms} waits without polling), then call restart_orbit again.`)
}

// The tool. Root only, in a run on any project, with write access (the script runs the checks and the build), not under
// the Vite dev server, and not while other chats are working (a restart would cut them off; while the script runs,
// lifecycle.start refuses new runs in other chats); `verify` (default true) runs the checks first, and a
// failed check is an error carrying the output, after which the agent fixes the code and may call again. A runtime or
// full restart shuts this process down while the call waits: the run then ends as `restarting`
// (lifecycle.markRestarting), and the abort that brings must not stop the script (it is restarting Orbit), while the
// user's stop does. Cut off by the restart, the call ends at once, so the shutdown does not wait for a script that only
// finishes once this process is gone; stopped by the user, it ends once the script has exited.
async function executeRestart(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, args: ToolArgs): Promise<RestartObservation> {
  if (agent.id !== 'root') throw new Error('Only the root agent (the orchestrator) can restart Orbit')
  const host = runtime.restartHost
  if (!host?.available) throw new Error('restart_orbit is available only when Orbit runs from its repository')
  if (devServer()) throw new Error('restart_orbit is unavailable while Orbit runs from the Vite dev server (ORBIT_DEV=1): a relaunch would stop npm run dev. Nothing was restarted; ask the user to restart Orbit.')
  if (run.accessMode === 'read-only') throw new Error('restart_orbit runs the checks and the build, so it needs workspace-write or full access')
  const reason = checkedText(args.reason, 'a reason', REASON_CHARS)
  const continueWith = checkedText(args.continueWith, 'continueWith (what to do after the restart)', CONTINUE_CHARS)
  if (args.verify !== undefined && args.verify !== null && typeof args.verify !== 'boolean') throw new Error('restart_orbit: verify must be a boolean')
  const verify = args.verify !== false
  // A refusal the agent cannot fix (other chats working, the user declined, the cycle limit, no health report) defers
  // the change to the next restart: improvement mode then accepts the answer without one (improvement.mts).
  const deferred = (error: Error): Error => { run.restartDeferred = true; return error }
  try { refuseWhileOthersWork(runtime, run) } catch (error) { throw deferred(error as Error) }
  if (run.approvalPolicy === 'on-request' && !await runtime.approve(run, agent, { tool: 'restart_orbit', arguments: { reason, continueWith, verify } })) throw deferred(new Error('User declined this operation'))
  // A chat started while the user was asked: checked again, with nothing awaited between here and the script's start
  // (from then on new runs in other chats wait, see lifecycle.start).
  try { refuseWhileOthersWork(runtime, run) } catch (error) { throw deferred(error as Error) }
  const signal = runtime.agentSignal(run, agent)
  if (signal.aborted) throw abortError()
  const stop = new AbortController()
  let cutOff!: () => void
  const restarting = new Promise<null>(resolve => { cutOff = () => resolve(null) })
  const onAbort = () => { if (run.status === 'restarting') cutOff(); else stop.abort() }
  signal.addEventListener('abort', onAbort, { once: true })
  const progress = progressTrace(runtime, run, agent)
  progress.line(`restart_orbit: ${verify ? 'checks, build' : 'build (checks skipped)'} and restart. Reason: ${reason}`)
  let result: RestartResult | null
  try { result = await Promise.race([host.request({ run, agent, reason, continueWith, verify, onLine: progress.line, signal: stop.signal }), restarting]) }
  finally { signal.removeEventListener('abort', onAbort); progress.close() }
  if (!result || stop.signal.aborted) throw abortError()
  if (!result.ok) throw result.status === 'cycle-limit' || result.status === 'no-health-report' ? deferred(failure(result, run)) : failure(result, run)
  run.restartApplied = true
  return observation(result)
}

export { setRestartHost, restartOffered, onOrbitRepository, runOnOrbitRepository, agentEnv, restartNote, prepareContinuation, executeRestart }
export type { RestartObservation }
