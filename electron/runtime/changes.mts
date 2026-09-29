// @ts-nocheck
// What happened to the workspace: file activity per agent (Orbit tools, native tool events, attributed commands),
// change records with their diffs made in the background, and the project index's readiness for a prompt.
import { executeWorkspaceTool } from '../runtime-tools.mts'
import { normalizeRel } from '../file-activity.mts'
import { nativeChange, commandChange } from '../change-log.mts'
import { TERMINAL, overlappingWorkspaces, diagnostics } from './util.mts'
// A command can change many files at once (a formatter, a generator); past this it is not attributed to anyone.
const COMMAND_ATTRIBUTION_LIMIT = 40
// How long a finishing run waits for file change records still being made (a Git call is bounded by 5 s on its own).
const CHANGE_DRAIN_MS = 1500
// How long the first turn waits for the project index before it goes on without it.
const INDEX_WAIT_MS = 2500

// The index scan starts with the run; a prompt waits for it only briefly and the run never depends on it.
async function awaitIndex(runtime, run, { refresh = false } = {}) {
  if (!runtime.projectIndex || (run.indexSettled && !refresh)) return
  const pending = refresh && run.indexSettled ? runtime.projectIndex.refresh(run.workspace) : run.indexReady
  let timer
  await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, INDEX_WAIT_MS); timer.unref?.() })]).catch(error => diagnostics(runtime, run, 'awaitIndex', error))
  clearTimeout(timer)
  run.indexSettled = true
}
function publishFiles(runtime, run, agent) { runtime.updateAgent(run, agent, { files: run.fileActivity.forAgent(agent.id) }, false) }
// Records that `agent` read or changed a file. A change also tells the other agents who used that file.
function touchFile(runtime, run, agent, target, action) {
  const touch = run.fileActivity.record(agent.id, target, action)
  if (!touch) return { shared: [] }
  if (touch.isNew) runtime.publishFiles(run, agent)
  return { touch, shared: action === 'write' ? run.router.notifyWrite(agent, touch.path) : [] }
}
// Files touched by a vendor's own tools (Codex file changes, Claude Read/Edit/Write) arrive as provider events.
function trackNativeFiles(runtime, run, agent, event) {
  const call = run.changes.remember(agent.id, event)
  const changed = new Set() // one tool call names a file once, however often its event lists it
  for (const touch of run.fileActivity.nativeEvent(agent.id, event)) {
    if (touch.isNew) runtime.publishFiles(run, agent)
    if (touch.action !== 'write') continue
    agent.workDone++
    run.router.notifyWrite(agent, touch.path)
    runtime.projectIndex?.touch(run.workspace, [touch.path]).catch(error => diagnostics(runtime, run, 'projectIndex.touch', error, agent.id))
    if (changed.has(touch.path)) continue
    changed.add(touch.path)
    runtime.captureChange(run, agent, touch.path, call?.tool || event.tool, first => nativeChange(run.workspace, touch.path, call, first, run.changes.startedAt))
  }
}
// Change records are made one after another in the background: reading files and asking Git must not slow the provider stream.
function captureChange(runtime, run, agent, target, tool, describe) {
  const rel = normalizeRel(run.workspace, target)
  if (!rel) return
  const first = run.changes.claim(rel)
  run.changePending++
  run.changeQueue = run.changeQueue.then(async () => runtime.recordChange(run, agent, { path: rel, tool, ...await describe(first) })).catch(error => diagnostics(runtime, run, `captureChange ${rel}`, error, agent.id)).then(() => { run.changePending-- })
}
// A run ends after the records still being made, but never waits long for them.
async function drainChanges(runtime, run, ms = CHANGE_DRAIN_MS) {
  let timer
  try { await Promise.race([run.changeQueue, new Promise(resolve => { timer = setTimeout(resolve, ms) })]) } finally { clearTimeout(timer) }
}
function recordChange(runtime, run, agent, input) {
  const change = run.changes.add({ agentId: agent.id, ...input })
  if (!change) return
  runtime.emit(run, 'change.added', { change }, false)
  // Behind a finished run (a record that took longer than the drain) the saved copy is completed soon, before Orbit may close.
  if (!run.persistTimer) { run.persistTimer = setTimeout(() => runtime.persist(run), TERMINAL.has(run.status) ? 100 : 1000); run.persistTimer.unref?.() }
}
// Orbit's own file tools report the exact text before and after a write.
function reportWrite(runtime, run, agent, tool, { path: target, before, after }) {
  const rel = normalizeRel(run.workspace, target)
  if (!rel) return
  run.changes.claim(rel)
  run.commands.writes++ // a command that overlapped this write cannot claim the file
  runtime.recordChange(run, agent, { path: rel, tool, source: 'exact', before, after })
}
async function trackWorkspaceTool(runtime, run, agent, name, args, result) {
  if (name === 'read_file') runtime.touchFile(run, agent, args.path, 'read')
  else if (name === 'write_file' || name === 'edit_file') {
    const { shared } = runtime.touchFile(run, agent, args.path, 'write')
    try { await runtime.projectIndex?.touch(run.workspace, [args.path]) } catch (error) { diagnostics(runtime, run, 'projectIndex.touch', error, agent.id) /* The index catches up on its next scan. */ }
    if (shared.length) return { ...result, sharedWith: shared }
  }
  return result
}
// A command's file changes are attributed to its agent only when nothing else could have made them:
// no other command overlapped it, no other agent had a provider turn (native tools) running and no other chat works in the folder.
async function runTrackedCommand(runtime, run, agent, args, context) {
  if (!runtime.projectIndex) return executeWorkspaceTool('run_command', args, context)
  const commands = run.commands, serial = ++commands.serial
  try { await runtime.projectIndex.refresh(run.workspace) } catch (error) { diagnostics(runtime, run, 'runTrackedCommand refresh', error, agent.id) /* Attribution is best effort. */ }
  const writes = commands.writes
  commands.running++
  let result
  try { result = await executeWorkspaceTool('run_command', args, context) } finally { commands.running-- }
  try {
    const otherChats = [...runtime.runs.values()].some(other => other !== run && !TERMINAL.has(other.status) && overlappingWorkspaces(other.workspace, run.workspace))
    // In session mode the agent's own provider turn is running while it calls run_command over MCP; that slot is its own.
    const ownSlot = agent.activeTurn?.slot?.held ? 1 : 0
    const alone = commands.serial === serial && commands.running === 0 && commands.writes === writes && run.activeTurns - ownSlot === 0 && !otherChats
    const diff = await runtime.projectIndex.refresh(run.workspace, { force: true })
    const changed = [...new Set([...diff.added, ...diff.changed, ...diff.removed])]
    if (alone && changed.length && changed.length <= COMMAND_ATTRIBUTION_LIMIT) for (const file of changed) {
      runtime.touchFile(run, agent, file, 'write'); agent.workDone++
      const kind = diff.added.includes(file) ? 'create' : diff.removed.includes(file) ? 'delete' : 'modify'
      runtime.captureChange(run, agent, file, 'run_command', () => commandChange(run.workspace, file, kind))
    }
  } catch (error) { diagnostics(runtime, run, 'runTrackedCommand attribution', error, agent.id) }
  return result
}

export { awaitIndex, publishFiles, touchFile, trackNativeFiles, captureChange, drainChanges, recordChange, reportWrite, trackWorkspaceTool, runTrackedCommand }
