// The endless improvement loop, runtime side. Every step of the loop is one run (a batch of tasks) in a fresh context;
// the renderer starts the next run in the same chat. This module carries the plan (and a short handoff) from the
// previous run of the chat, updates it (improvement_plan), shows it to the root agent, and decides whether the root's
// answer closes the run: at least one task closed (a run takes a batch of independent ones, in any number), none left
// working, and Orbit's own code, when it changed, applied with one restart_orbit: in Orbit's repository and in any
// other project's chat alike.
import { saveNote } from '../shared-context.mts'
import { ellipsis } from '../text.mts'
import { clip, oneOf, diagnostics } from './util.mts'
import { previousRunProfile } from './run-profile.mts'
import { restartOffered, runOnOrbitRepository } from './restart.mts'
import type { CodePart } from '../resume.mts'
import type { ImprovementStatus, ImprovementTask, OrbitRuntimeLike, RunRecord, StoredRun, TaskStatus, ToolArgs } from '../types.mts'

const PLAN_STATUSES: readonly ImprovementStatus[] = ['planning', 'implementing', 'completed', 'blocked']
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'working', 'done', 'blocked']
const TITLE_CHARS = 300
const EVIDENCE_CHARS = 1500
const HANDOFF_CHARS = 2000
// Done tasks the plan keeps (the newest, in list order); older ones are archived out of it.
const DONE_KEPT = 30
// How many earlier runs of the chat are searched for the plan.
const EARLIER_RUNS = 12
const PROGRESS_CHARS = 6500

const isClosed = (task: ImprovementTask): boolean => task.status === 'done' || task.status === 'blocked'
// Closed in this run: a closed task that is new or whose status changed in this run (a blocked task done now). A task
// closed before the run and only re-sent, renamed or re-worded is not.
const closedInRun = (run: RunRecord, task: ImprovementTask): boolean => isClosed(task) && run.improvementBaseline?.get(task.id)?.status !== task.status
// The same text, or a copy of it clipped by the progress block (whitespace collapsed, cut with "…"): what an agent sends
// back when it re-sends a task it only read in the prompt.
function sameOrClipped(sent: string, original: string): boolean {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  const copy = flat(sent), full = flat(original)
  if (copy === full) return true
  const cut = /^(.{10,}?)\s*(?:…|\.\.\.)$/.exec(copy)
  return !!cut && full.startsWith(cut[1])
}
// A blocked task that documents a blocker of this run: new, newly blocked, or blocked before with new evidence.
const newBlocker = (task: ImprovementTask, before?: ImprovementTask): boolean => !before || before.status !== 'blocked' || !sameOrClipped(task.evidence, before.evidence)

// Tasks as a saved run holds them: anything malformed is left out.
function sanitizeTasks(value: unknown): ImprovementTask[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tasks: ImprovementTask[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, title, status, evidence } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || typeof title !== 'string' || !title || !oneOf(TASK_STATUSES, status) || seen.has(id)) continue
    seen.add(id)
    tasks.push({ id, title: ellipsis(title, TITLE_CHARS), status, evidence: ellipsis(typeof evidence === 'string' ? evidence : '', EVIDENCE_CHARS) })
  }
  return tasks
}

// A new improvement-mode run starts from the plan of the newest earlier run of the same chat that has one (the live
// runs and the saved ones). A stale completed or blocked status is never inherited: the run has work to find or to do.
// Only a continuation after restart_orbit, the same task, keeps the status of the run it continues (a pause included).
function loadPlan(runtime: OrbitRuntimeLike, run: RunRecord): void {
  run.improvementBaseline = new Map()
  if (!run.improvementMode) return
  const found = new Map<string, RunRecord | StoredRun>()
  const sameChat = (item: RunRecord | StoredRun) => item.projectId === run.projectId && item.chatId === run.chatId && item.runId !== run.runId && String(item.startedAt) <= String(run.startedAt)
  try {
    const stored = typeof runtime.runStore?.forChat === 'function' ? runtime.runStore.forChat(run.projectId, run.chatId, EARLIER_RUNS) : []
    for (const item of stored || []) if (item && sameChat(item)) found.set(item.runId, item)
  } catch (error) { diagnostics(runtime, run, 'improvement.loadPlan', error) /* A damaged history must not block the task. */ }
  for (const live of runtime.runs.values()) if (sameChat(live)) found.set(live.runId, live)
  const newestFirst = [...found.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  for (const earlier of newestFirst) {
    const tasks = sanitizeTasks(earlier.improvements)
    const handoff = typeof earlier.improvementHandoff === 'string' ? earlier.improvementHandoff.trim() : ''
    if (!tasks.length && !handoff) continue
    run.improvements = tasks
    const continued = run.resumedFrom === earlier.runId ? earlier.improvementStatus : undefined
    run.improvementStatus = oneOf(PLAN_STATUSES, continued) ? continued : tasks.length ? 'implementing' : 'planning'
    if (handoff) run.improvementHandoff = ellipsis(handoff, HANDOFF_CHARS)
    run.improvementBaseline = new Map(tasks.filter(isClosed).map(task => [task.id, task]))
    return
  }
}

// The `progress:<chatId>` note: a small display copy of the plan (the run records hold the plan itself).
function progressNote(run: RunRecord): string {
  const open = run.improvements.filter(task => task.status === 'pending' || task.status === 'working').map(({ id, title, status }) => ({ id, title: clip(title, 200), status }))
  const recentlyDone = run.improvements.filter(task => task.status === 'done').slice(-5).map(task => clip(task.title, 200))
  return JSON.stringify({ request: clip(run.prompt, 300), status: run.improvementStatus, open, recentlyDone, ...(run.improvementHandoff ? { handoff: clip(run.improvementHandoff, 500) } : {}) })
}

// improvement_plan: validate, keep what must not be lost, archive old done tasks, publish.
function updatePlan(runtime: OrbitRuntimeLike, run: RunRecord, args: ToolArgs): Record<string, unknown> {
  if (!oneOf(PLAN_STATUSES, args.status) || !Array.isArray(args.tasks)) throw new Error('Invalid improvement plan')
  const baseline = run.improvementBaseline || new Map<string, ImprovementTask>()
  const keptTitles: string[] = []
  let tasks = args.tasks.map((item): ImprovementTask => {
    if (!item || !item.id || !item.title || !oneOf(TASK_STATUSES, item.status)) throw new Error('Invalid improvement task')
    if (['done', 'blocked'].includes(item.status) && !String(item.evidence || '').trim()) throw new Error('Done/blocked tasks require evidence')
    const task: ImprovementTask = { id: String(item.id), title: ellipsis(String(item.title), TITLE_CHARS), status: item.status, evidence: ellipsis(String(item.evidence || ''), EVIDENCE_CHARS) }
    // A task closed before this run stays that task while it is closed: a new title would make it look closed anew, and
    // the clipped copy of its evidence from the progress block would erode the full text.
    const before = baseline.get(task.id)
    if (before && isClosed(task)) {
      if (task.title !== before.title) { keptTitles.push(task.id); task.title = before.title }
      if (task.status === before.status && sameOrClipped(task.evidence, before.evidence)) task.evidence = before.evidence
    }
    return task
  })
  if (new Set(tasks.map(item => item.id)).size !== tasks.length) throw new Error('Task ids must be unique')
  if (run.improvements.some(old => (old.status === 'pending' || old.status === 'working') && !tasks.some(item => item.id === old.id))) throw new Error('Unfinished tasks cannot be silently removed')
  if (args.status === 'completed' && (!tasks.length || tasks.some(item => item.status !== 'done'))) throw new Error('Completion requires verified tasks; if none are actionable, record a verified audit task')
  if (args.status === 'blocked') {
    const blocked = tasks.filter(item => item.status === 'blocked')
    if (!blocked.length) throw new Error('Blocked plan requires a documented blocker')
    // An old blocker alone would pause every next task on the same reason. A continuation after restart_orbit is the same
    // task and may keep the pause it set before the restart.
    if (!run.resumedFrom && !blocked.some(item => newBlocker(item, baseline.get(item.id)))) {
      throw new Error('Blocked plan requires a blocker documented in this run: block a new task, or give the earlier blocked task new evidence of what this run found')
    }
  }
  let handoff = run.improvementHandoff
  if (args.handoff !== undefined && args.handoff !== null) {
    if (typeof args.handoff !== 'string') throw new Error('handoff must be a string')
    if (args.handoff.length > HANDOFF_CHARS) throw new Error(`handoff is longer than ${HANDOFF_CHARS} characters; keep only what the next task must know`)
    handoff = args.handoff.trim() || undefined
  }
  const done = tasks.filter(item => item.status === 'done')
  const archived = done.length > DONE_KEPT ? new Set(done.slice(0, done.length - DONE_KEPT)) : null
  if (archived) tasks = tasks.filter(item => !archived.has(item))
  run.improvements = tasks; run.improvementStatus = args.status
  if (handoff) run.improvementHandoff = handoff
  else delete run.improvementHandoff
  run.sharedContext = saveNote(runtime.contextStore, run.workspace, run.sharedContext, { key: `progress:${run.chatId}`, summary: progressNote(run) })
  runtime.emit(run, 'run.info', { improvements: tasks, improvementStatus: args.status, improvementHandoff: run.improvementHandoff ?? null })
  const notes = [
    ...(archived ? [`${archived.size} older done task(s) were archived: the plan keeps the ${DONE_KEPT} newest done tasks.`] : []),
    ...(keptTitles.length ? [`Task(s) ${keptTitles.join(', ')} were closed before this run and kept their original titles.`] : []),
  ]
  return {
    ok: true, status: args.status, tasks, ...(run.improvementHandoff ? { handoff: run.improvementHandoff } : {}),
    ...(archived ? { archived: archived.size } : {}), ...(keptTitles.length ? { keptTitles } : {}), ...(notes.length ? { note: notes.join(' ') } : {}),
  }
}

// CURRENT IMPROVEMENT PROGRESS of an improvement-mode run: counts, open tasks first (with the brief a pending task
// carries), the last done ones, the handoff and, for the root, the profile of the chat's previous run.
function progressBlock(run: RunRecord, withProfile = true): string {
  const count = (status: TaskStatus) => run.improvements.filter(task => task.status === status).length
  const lines = [`Plan status: ${run.improvementStatus}; tasks: ${count('working')} working, ${count('pending')} pending, ${count('done')} done, ${count('blocked')} blocked.`]
  const open = run.improvements.filter(task => task.status === 'working' || task.status === 'pending')
  const blocked = run.improvements.filter(task => task.status === 'blocked')
  const done = run.improvements.filter(task => task.status === 'done').slice(-8)
  const line = (task: ImprovementTask, evidence: number) => `- [${task.status}] ${task.id}: ${clip(task.title, 200)}${task.evidence.trim() ? ` — ${clip(task.evidence, evidence)}` : ''}`
  if (open.length) lines.push('Open tasks:', ...open.map(task => line(task, 600)))
  if (blocked.length) lines.push('Blocked tasks:', ...blocked.map(task => line(task, 200)))
  if (done.length) lines.push(`Last ${done.length} done:`, ...done.map(task => line(task, 200)))
  if (!run.improvements.length) lines.push('No tasks recorded yet.')
  const handoff = run.improvementHandoff ? `\nHANDOFF FROM THE PREVIOUS TASK: ${ellipsis(run.improvementHandoff, HANDOFF_CHARS)}` : ''
  return `CURRENT IMPROVEMENT PROGRESS:\n${ellipsis(lines.join('\n'), PROGRESS_CHARS - handoff.length)}${handoff}${withProfile ? previousRunProfile(run.priorRuns) : ''}`
}

// What the root's answer still misses, first thing first: a task left working, no task closed in this run, or Orbit's
// own code changed but not applied. `null`: the answer closes the run.
type Missing = { kind: 'working'; task: ImprovementTask } | { kind: 'none' } | { kind: 'restart'; parts: CodePart[] | null }
function missing(runtime: OrbitRuntimeLike, run: RunRecord): Missing | null {
  if (!run.improvementMode) return null
  const working = run.improvements.find(task => task.status === 'working')
  if (working) return { kind: 'working', task: working }
  const closed = run.improvements.some(task => closedInRun(run, task))
  // Only a pause (blocked: the user is needed, or a bounded goal is reached) excuses a run from closing a task: marking the
  // inherited plan completed without new work is not a task.
  if (!closed && run.improvementStatus !== 'blocked' && !run.resumedFrom) return { kind: 'none' }
  if (run.restartApplied || run.restartDeferred || !restartOffered(runtime, run, { id: 'root' })) return null
  // The code on disk against the code the running Orbit runs, whatever changed it, but only the parts that changed since
  // this run started: what another chat left unapplied before is that chat's to apply. When that cannot be told, the
  // files this run's agents wrote with the tools Orbit sees, but only in Orbit's own repository: in another project's
  // chat they are that project's files, which no restart applies, so an unknown state asks for nothing there.
  const parts = runtime.restartHost?.unapplied?.(run.codeAtStart ?? null) ?? null
  const wrote = (): boolean => [...run.agentNodes.keys()].some(id => run.fileActivity.forAgent(id).wrote.length > 0)
  const changed = parts ? parts.length > 0 : runOnOrbitRepository(runtime, run) && wrote()
  return changed ? { kind: 'restart', parts } : null
}
const PART_NAMES: Record<CodePart, string> = { shell: 'main process', runtime: 'runtime', renderer: 'interface' }
const lastClosed = (run: RunRecord): string => run.improvements.filter(isClosed).at(-1)?.id || '<id>'
// What one restart applies: every task this run closed (a batch), else the last closed one (a continuation closes none).
function appliedTasks(run: RunRecord): string {
  const ids = run.improvements.filter(task => closedInRun(run, task)).map(task => task.id)
  if (!ids.length) return `Task ${lastClosed(run)} was`
  return ids.length === 1 ? `Task ${ids[0]} was` : `Tasks ${ids.join(', ')} were`
}
function reminderFor(runtime: OrbitRuntimeLike, run: RunRecord): string | null {
  const gap = missing(runtime, run)
  if (!gap) return null
  if (gap.kind === 'working') return `Improvement mode: task ${gap.task.id} ("${clip(gap.task.title, 120)}") is still marked working. Close it with improvement_plan: done with evidence of the checks, or blocked with the reason. Then give your final answer.`
  if (gap.kind === 'none') return 'Improvement mode: this run has not closed a task yet. Take the next tasks of the plan (a batch of independent ones, or record new ones for the goal), implement and verify them, close each with improvement_plan (done with evidence, or blocked with the reason) and apply Orbit\'s own code changes once. A list of suggestions is not a closed task.'
  const what = gap.parts ? `Orbit's code on disk differs from the code the running Orbit runs (${gap.parts.map(part => PART_NAMES[part]).join(', ')}), so a change is not applied yet` : 'this run changed Orbit\'s own code, but the change is not applied yet'
  return `Improvement mode: ${what}. Call restart_orbit now as the last step: it runs the checks and the build and installs the change. continueWith: "${appliedTasks(run)} applied: confirm the new code runs, then give the final answer".`
}
// The note an answer accepted after the ignored reminders carries (Russian: the user reads it).
function acceptedWithout(runtime: OrbitRuntimeLike, run: RunRecord, limit: number): string {
  const gap = missing(runtime, run)
  const what = !gap ? 'план не подтверждён' : gap.kind === 'working' ? `задача ${gap.task.id} осталась в работе (не закрыта через improvement_plan)`
    : gap.kind === 'none' ? 'за этот запуск не закрыта ни одна задача плана (improvement_plan)' : 'изменения кода Orbit не применены через restart_orbit'
  return `(Режим улучшения: ${what} после ${limit} напоминаний, поэтому ответ выдан без этого.)`
}

export { loadPlan, updatePlan, progressBlock, progressNote, reminderFor, acceptedWithout, sanitizeTasks, HANDOFF_CHARS, DONE_KEPT }
