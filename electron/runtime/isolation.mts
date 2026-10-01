// Isolated helpers at run time (spawn_agent {isolation}): the git worktree copy made for a helper before it exists, its
// merge into the target when the helper finishes, and its removal when the run ends. electron/agent-worktree.mts does the
// git and file work; this module ties it to agents, runs, traces and the change record.
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as worktree from '../agent-worktree.mts'
import type { AgentCopy, SweepResult } from '../agent-worktree.mts'
import type { AgentRecord, IsolationPrepared, OrbitRuntimeLike, RunRecord, Trace } from '../types.mts'
import { TERMINAL, bounded, clip, agentWorkspace, logicalWorkspace, sameFolder, diagnostics } from './util.mts'

// How long a run that ended waits for its provider processes to unwind before it takes the copies away: a process keeps its
// working folder locked on Windows. The removal retries on its own after that.
const SETTLE_MS = 8000
// Where copies are made without a configured folder (tests, embedders); Orbit's runtime host passes <userData>/worktrees.
const rootOf = (runtime: OrbitRuntimeLike): string => runtime.worktreeRoot || path.join(os.tmpdir(), 'orbit-worktrees')
const refusal = (instruction: string): IsolationPrepared => ({ ok: false, reason: 'isolation_unavailable', instruction: `${instruction} Spawn the helper without isolation and give each helper its own files instead.` })

// The copy for a helper of `parent`: a snapshot of the parent's workspace (or of Orbit's repository for 'orbit'), made
// without touching it, and a worktree of that. The copy is kept in run.copies at once, so that the end of the run takes it
// away even when the helper never gets made. The helper's record starts with the fields in `fields`; `id` is its id.
async function prepareIsolation(runtime: OrbitRuntimeLike, run: RunRecord, parent: AgentRecord, kind: string): Promise<IsolationPrepared> {
  if (kind !== 'worktree' && kind !== 'orbit') return { ok: false, reason: 'invalid_isolation', instruction: "isolation is one of '', 'worktree' or 'orbit'" }
  if (run.accessMode === 'read-only') return refusal('This run is read-only, so helpers cannot write files and there is nothing to isolate.')
  const source = kind === 'orbit' ? runtime.restartHost?.repoRoot : agentWorkspace(run, parent)
  if (!source) return refusal("isolation 'orbit' needs Orbit to run from its own repository, which this Orbit does not.")
  const id = `agent-${randomUUID()}`
  // A copy made from another copy is a worktree of the same repository: git's own bookkeeping stays with the first one.
  const real = worktree.realFolder(source)
  const owner = [...(run.copies?.values() ?? [])].find(copy => sameFolder(copy.dir, real) || worktree.inside(copy.dir, real))?.origin
  const made = await worktree.createCopy({ source, kind, root: rootOf(runtime), runId: run.runId, agentId: id, ...(owner ? { origin: owner } : {}) })
  if (!made.ok) return refusal(`${made.detail}.`)
  const { copy } = made
  if (TERMINAL.has(run.status)) {
    await worktree.removeCopy(copy, rootOf(runtime), run.runId).catch(() => undefined)
    return { ok: false, reason: 'run_not_active' }
  }
  ;(run.copies ??= new Map()).set(id, copy)
  return { ok: true, id, fields: { id, workspace: copy.workspace, isolation: { kind, path: copy.workspace, base: copy.startBase, target: copy.target } } }
}
// A copy whose helper was not made after all (a refused name, a limit, a run that ended meanwhile).
async function discardIsolation(runtime: OrbitRuntimeLike, run: RunRecord, agentId: string): Promise<void> {
  const copy = run.copies?.get(agentId)
  if (!copy) return
  run.copies?.delete(agentId)
  await worktree.removeCopy(copy, rootOf(runtime), run.runId).catch(() => undefined)
}

// A merged file's path as the run's workspace names it. The target is that workspace, or a copy of it, so the path below
// the target is the same; null for an 'orbit' copy, whose target is another project's tree.
function runPath(run: RunRecord, agent: AgentRecord, copy: AgentCopy, file: string): string | null {
  if (!sameFolder(logicalWorkspace(run, agent), run.workspace)) return null
  const relative = path.relative(worktree.realFolder(copy.target), path.join(copy.sourceTop, ...file.split('/')))
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null
}
// Merges the helper's changes into its target and records them as the helper's own writes. Resolves, never rejects, with
// the report the helper's parent reads at the head of its result (conflicts included); '' for an agent without a copy.
async function mergeIsolated(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord): Promise<string> {
  const copy = run.copies?.get(agent.id)
  if (!copy || !agent.isolation) return ''
  runtime.updateAgent(run, agent, { detail: `Merging changes into ${clip(copy.target, 80)}` }, false)
  // A run operation: the end of the run waits for a merge under way (cleanupIsolation), and the copy is not taken away
  // under it (agent-worktree.mts runs both on one queue).
  const result = await runtime.trackOperation(run, worktree.mergeCopy(copy), agent)
  // The files are merged whatever happens to their records: a failed record must not make the helper fail.
  for (const file of result.merged) {
    try {
      const rel = runPath(run, agent, copy, file.path)
      if (rel) runtime.reportMerge(run, agent, { ...file, path: rel })
    } catch (error) { diagnostics(runtime, run, `reportMerge ${file.path}`, error, agent.id) }
  }
  runtime.updateAgent(run, agent, { isolation: { ...agent.isolation, merged: (agent.isolation.merged ?? 0) + result.merged.length, conflicts: result.conflicts.map(item => item.path) } }, false)
  const report = worktree.describeMerge(copy, result)
  note(runtime, run, agent.id, report)
  return report
}

// The run is over by the time its copies are taken away, and trace() ignores a finished run; where unmerged work went must
// still reach the inspector, so this note is recorded the way trace() does.
function lateTrace(runtime: OrbitRuntimeLike, run: RunRecord, agentId: string, text: string): void {
  const trace: Trace = { id: randomUUID(), agentId, agentName: run.agentNodes.get(agentId)?.name || 'Orbit', kind: 'isolation', text: bounded(text, 6000), time: new Date().toISOString() }
  run.traces.push(trace)
  runtime.emit(run, 'trace.added', { trace }, false)
  runtime.schedulePersist(run, 100)
}
// A merge can outlive its run (the user stopped the run while the helper's changes were being merged), and what it did must
// reach the inspector all the same.
const note = (runtime: OrbitRuntimeLike, run: RunRecord, agentId: string, text: string): void => TERMINAL.has(run.status) ? lateTrace(runtime, run, agentId, text) : runtime.trace(run, agentId, 'isolation', text)
// Takes the run's copies away once it has ended (finished, failed, cancelled or restarted). Changes that never merged
// (conflicts, the work of a helper that failed or was stopped) are saved as a patch first and the patch is named in a
// trace; the links into node_modules are removed before anything else, so that nothing follows them.
async function cleanupIsolation(runtime: OrbitRuntimeLike, run: RunRecord): Promise<void> {
  const copies = [...(run.copies?.values() ?? [])]
  if (!copies.length) return
  run.copies = new Map()
  // Provider processes still unwinding keep their working folder locked: they finish first, but not for long.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.allSettled([...run.operations]), new Promise(resolve => { timer = setTimeout(resolve, SETTLE_MS) })])
  clearTimeout(timer)
  // Newest first: a copy made from another goes before the copy it was made from.
  for (const copy of copies.reverse()) {
    const name = run.agentNodes.get(copy.agentId)?.name || copy.agentId
    try {
      const outcome = await worktree.removeCopy(copy, rootOf(runtime), run.runId)
      if (outcome.patch) lateTrace(runtime, run, copy.agentId, `Changes of ${name} that were never merged into ${copy.target} are saved as a patch: ${outcome.patch}\nApply them with: git -C "${copy.origin}" apply --3way "${outcome.patch}"`)
      // A copy whose work could not be saved is not thrown away: it stays, and Orbit tries again when it starts next.
      if (outcome.kept) lateTrace(runtime, run, copy.agentId, `The isolated copy of ${name} is KEPT at ${copy.dir}: ${outcome.error}. Its files are still there (and the unmerged work with them); Orbit tries to save them as a patch again when it starts next.`)
      else if (!outcome.removed) lateTrace(runtime, run, copy.agentId, `The isolated copy of ${name} at ${copy.dir} could not be removed (${outcome.error}); Orbit removes it when it starts next.`)
    } catch (error) { lateTrace(runtime, run, copy.agentId, `The isolated copy of ${name} at ${copy.dir} could not be cleaned up: ${(error as Error).message}`) }
  }
}
// At start: copies that runs which no longer exist left behind (worktree.sweepLeftovers).
async function sweepIsolation(runtime: OrbitRuntimeLike): Promise<SweepResult> {
  try { return await worktree.sweepLeftovers(rootOf(runtime)) } catch { return { removed: 0, patches: [], kept: [] } }
}

export { prepareIsolation, discardIsolation, mergeIsolated, cleanupIsolation, sweepIsolation }
