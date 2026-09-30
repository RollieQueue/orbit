// The knowledge tools: durable memory (search, save with the scope guard, forget), skills (list, search, read,
// feedback, install) and model assessments, plus the usage marks that decide what the memory keeps.
import { randomUUID, createHash } from 'node:crypto'
import { reliability as skillReliability } from '../capabilities.mts'
import { folderManifest } from '../skill-packages.mts'
import { projectReferences, describe as describeReferences, scrub } from '../scope-guard.mts'
import { bounded, clip, diagnostics } from './util.mts'
import { modelsWorked } from './agents.mts'
import type { AgentRecord, CapabilityStoreLike, MemoryEntry, MemoryScope, MemorySaveInput, MemorySaveResult, Observation, OrbitRuntimeLike, RunRecord, SkillSaveInput, SkillScope, SkillView, ToolArgs } from '../types.mts'

// A note that matched the task, or was read on purpose, counts as used (once per run). Usage decides what the memory keeps.
function markMemoryUse(runtime: OrbitRuntimeLike, run: RunRecord, entries: readonly (Pick<MemoryEntry, 'id'> | null | undefined)[]): void {
  const fresh: string[] = []
  for (const entry of entries) if (entry?.id && !run.memoryTouched.has(entry.id)) { run.memoryTouched.add(entry.id); fresh.push(entry.id) }
  if (!fresh.length) return
  // A missing store throws here and is reported like any other failure.
  try { runtime.memoryStore!.touch?.(fresh) } catch (error) { diagnostics(runtime, run, 'memoryStore.touch', error) /* A usage counter never stops a turn. */ }
}
// The knowledge tools, reached from executeTool; a capability_* name it does not know is unknown, as before.
async function executeKnowledgeTool(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs): Promise<Observation> {
  if (name === 'model_evaluate') {
    if (agent.id !== 'root') throw new Error('Only the orchestrator can evaluate model results')
    if (!run.memoryEnabled || !run.globalMemoryEnabled || !runtime.memoryStore) throw new Error('Global memory is disabled or unavailable')
    const target = runtime.resolveAgent(run, args.agentId)
    if (!['done', 'error'].includes(target.status)) throw new Error('Evaluate completed work only')
    if (![args.taskType, args.assessment, args.evidence].every(value => typeof value === 'string' && value.trim())) throw new Error('Task type, assessment and verification evidence are required')
    // The assessment belongs to the model that did the work, which after a subscription switch is not always the one the agent ended on.
    const worked = modelsWorked(target)
    const listing = worked.map(item => item.turns ? `${item.label} (${item.turns})` : item.label).join(', ')
    const wanted = typeof args.model === 'string' ? args.model.trim() : ''
    let chosen = worked[0]
    if (wanted) {
      const matches = worked.filter(item => item.label === wanted || item.model === wanted)
      if (matches.length !== 1) throw new Error(`Agent ${target.name} did not run on model "${wanted}" (or it is ambiguous). Models that did its work: ${listing}. Pass model as "<provider>/<model>".`)
      chosen = matches[0]
    } else if (worked.length > 1) throw new Error(`Agent ${target.name} ran on several models: ${listing}. Pass model: "<provider>/<model>" naming the one whose work you assessed; evaluate each separately if both did real work.`)
    if (!chosen.model) throw new Error('Provider did not identify the model; select an explicit model before evaluating')
    const id =`model-${createHash('sha256').update(`${chosen.providerId}:${chosen.model}:${args.taskType}`).digest('hex').slice(0, 24)}`
    const previous = runtime.memoryStore.list(run.workspace).find(entry => entry.id === id)
    // An assessment is shared by every project, so it carries no path of this one, and it is a running record: newest first, twelve at most.
    const observation = { provider: chosen.providerId, model: chosen.model, ...(worked.length > 1 ? { ranOn: worked.map(item => item.label) } : {}), taskType: clip(scrub(args.taskType, run.workspace), 120), assessment: clip(scrub(args.assessment, run.workspace), 400), evidence: clip(scrub(args.evidence, run.workspace), 400), runId: run.runId, agentId: target.id, turns: target.turns, status: target.status, date: new Date().toISOString() }
    const record: MemorySaveInput = { id, scope: 'global', type: 'fact', title: `Model: ${chosen.label} — ${observation.taskType}`, content: [JSON.stringify(observation), ...String(previous?.content || '').split('\n').filter(Boolean)].slice(0, 12).join('\n') }
    const entry = runtime.memoryStore.save ? runtime.memoryStore.save(record, { origin: 'system' }).entry : runtime.memoryStore.upsert(record)
    run.evaluations.add(runtime.resultKey(target))
    return entry
  }
  if (name === 'memory_search' || name === 'memory_save' || name === 'memory_forget') {
    if (!run.memoryEnabled) throw new Error('Durable memory is disabled for this run')
    if (!runtime.memoryStore) throw new Error('Memory store is unavailable')
    const shared = run.globalMemoryEnabled && agent.memoryProfile === 'project-global'
    if (name === 'memory_search') {
      const found = runtime.memoryStore.search(String(args.query || ''), run.workspace, Math.max(1, Math.min(Number(args.limit) || 6, 20)), shared, run.chatId)
      runtime.markMemoryUse(run, found)
      return found.map(({ id, scope, type, title, content, updated, uses, pinned }) => ({ id, scope, type, title, content: bounded(content, 1500), updated, uses, pinned }))
    }
    if (name === 'memory_forget') {
      const entry = runtime.memoryStore.find?.(String(args.id || ''), run.workspace, run.chatId, shared)
      if (!entry) throw new Error('No such note in the memory you can reach; ids are listed in the MEMORY block and returned by memory_search')
      runtime.memoryStore.remove(entry.id, run.workspace, run.chatId, { origin: 'agent', includeGlobal: shared })
      return { ok: true, id: entry.id, scope: entry.scope, title: entry.title }
    }
    if (!String(args.title || '').trim() || !String(args.content || '').trim()) throw new Error('Memory title and content are required')
    const scope = args.scope === 'global' ? 'global' : args.scope === 'chat' ? 'chat' : 'project'
    if (scope === 'global' && !run.globalMemoryEnabled) throw new Error('Global memory is disabled for this project; use project scope')
    if (scope === 'global' && agent.memoryProfile !== 'project-global') throw new Error('This worker has project-only memory')
    const known = args.id ? (runtime.memoryStore.find ? runtime.memoryStore.find(String(args.id), run.workspace, run.chatId, true) : (await runtime.memoryStore.list(run.workspace)).find(entry => entry.id === args.id)) : null
    if (args.id && (!known || known.scope !== scope)) throw new Error('Memory id does not belong to the selected scope')
    // The model chooses the scope, the harness keeps a project's specifics out of the shared tier.
    let target: MemoryScope = scope
    const pinnedTo = scope === 'global' ? describeReferences(projectReferences(`${args.title}\n${args.content}`, run.workspace)) : ''
    if (pinnedTo) {
      if (known) throw new Error(`A shared note cannot name this project (${pinnedTo}); save the project-specific part as a project note`)
      target = 'project'
    }
    const payload: MemorySaveInput = { id: known?.id, title: bounded(args.title, 200), content: bounded(args.content, 6000), type: args.type, confidence: Number.isFinite(args.confidence) ? args.confidence : undefined, scope: target, workspace: target === 'global' ? undefined : run.workspace, chatId: target === 'chat' ? run.chatId : undefined }
    const saved: MemorySaveResult = runtime.memoryStore.save ? runtime.memoryStore.save(payload, { origin: 'agent' }) : { entry: runtime.memoryStore.upsert({ ...payload, id: payload.id || randomUUID() }) }
    run.memoryTouched.add(saved.entry.id)
    const notes: string[] = []
    if (saved.merged) notes.push(saved.unchanged ? 'The user already wrote a note that says this; nothing changed.' : 'An existing note said the same and was updated.')
    if (pinnedTo) notes.push(`Saved to PROJECT memory instead of shared memory: it names ${pinnedTo}, and shared memory holds only what is true in every project.`)
    if (!saved.unchanged && String(args.content).trim().length > saved.entry.content.length) notes.push(`The content was cut to ${saved.entry.content.length} characters: keep notes short, or split them.`)
    return {
      ok: true, id: saved.entry.id, scope: saved.entry.scope, title: saved.entry.title,
      ...(saved.merged ? { merged: true } : {}), ...(pinnedTo ? { demoted: true } : {}), ...(saved.evicted ? { evicted: saved.evicted } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    }
  }
  if (name.startsWith('capability_')) {
    // A missing store fails the call with a TypeError at first use, as it always did.
    const store: CapabilityStoreLike = runtime.capabilityStore!
    // A project that switched shared memory off neither sees nor changes the shared library. Who may CREATE a shared skill is decided below.
    const shared = run.globalMemoryEnabled
    // What a skill is made of, so the agent sees at once whether it is a procedure to follow, a page Orbit shows, or commands to run.
    const brief = ({ id, name, description, whenToUse, scope, uses, reliability, lessons, files, triggers, commands }: SkillView) => ({
      id, name, description, whenToUse, scope, uses, reliability, kinds: ['instructions', ...(triggers?.length ? ['page'] : []), ...(commands?.length ? ['commands'] : [])],
      ...(files?.length ? { files: files.length } : {}), ...(lessons?.length ? { pitfalls: lessons.slice(0, 3) } : {}),
    })
    // A skill the user switched off is invisible to agents: it is not found, read, rated or suggested.
    const switchedOff = (skill: Pick<SkillView, 'enabled'> | null | undefined): void => { if (skill && skill.enabled === false) throw new Error('This skill is switched off') }
    // A skill the user switched off is invisible to agents (the list is filtered before the cap, so off skills take no place).
    if (name === 'capability_list') return (await store.list(run.workspace, shared)).filter(skill => skill.enabled !== false).slice(0, 60).map(brief)
    if (name === 'capability_search') {
      if (!String(args.query || '').trim()) throw new Error('A search query is required')
      return store.search(String(args.query), run.workspace, Number(args.limit) || 8, shared).map(brief)
    }
    if (name === 'capability_read') {
      const skill = await store.read(String(args.id || ''), run.workspace, shared)
      switchedOff(skill)
      // Loading it again in the same run is not another use.
      if (!run.skillUse.has(skill.id)) { store.recordUse?.(skill.id, run.workspace, shared); run.skillUse.set(skill.id, { name: skill.name, rated: false }) }
      // The instructions come last: if an observation is ever cut, the tail lost is prose, not the pitfalls.
      return { id: skill.id, name: skill.name, description: skill.description, whenToUse: skill.whenToUse, scope: skill.scope, version: skill.version, uses: skill.uses, reliability: Math.round(skillReliability(skill) * 100) / 100,
        ...(skill.lessons?.length ? { pitfalls: skill.lessons } : {}),
        ...(skill.package ? { package: skill.package, files: skill.files } : {}),
        ...(skill.params?.length ? { params: skill.params.map(({ key, label, type, value, default: initial, hint }) => ({ key, label, type, value, default: initial, ...(hint ? { hint } : {}) })) } : {}),
        ...(skill.triggers?.length ? { triggers: skill.triggers } : {}), ...(skill.commands?.length ? { commands: skill.commands } : {}),
        note: `When you are done, report the outcome with capability_feedback${skill.commands?.length ? '. Commands run in the package folder (package.dir)' : ''}`, instructions: skill.instructions }
    }
    if (name === 'capability_feedback') {
      switchedOff(store.find(String(args.id || ''), run.workspace, shared))
      const result = store.feedback(String(args.id || ''), run.workspace, { outcome: args.outcome, note: args.note, includeGlobal: shared })
      run.skillUse.set(result.id, { name: result.name, rated: true })
      return { ok: true, id: result.id, name: result.name, uses: result.uses, reliability: result.reliability, ...(result.lessonDropped ? { note: 'The pitfall was not stored: a shared skill cannot name this project' } : {}) }
    }
    if (name === 'capability_install') {
      const known = args.id ? store.find(String(args.id), run.workspace, shared) : null
      // A package folder's skill.json supplies what the call leaves out, so the guard below reads the skill it would actually save.
      const manifest = args.fromDir ? folderManifest(String(args.fromDir), run.workspace, true) : null
      const field = (key: 'name' | 'description' | 'whenToUse' | 'instructions' | 'scope'): string | undefined => args[key] ?? manifest?.[key]
      if (!known && (!String(field('name') || '').trim() || !String(field('instructions') || '').trim())) throw new Error('Capability name and instructions are required (unless fromDir holds a skill.json with them, or id names a skill to change)')
      let scope: SkillScope = field('scope') === 'global' ? 'global' : 'project', kept = ''
      if (scope === 'global') {
        // Sharing a skill is the agent's call, but a skill that only makes sense here stays here, and so does one from a project that opted out.
        const references = describeReferences(projectReferences([field('name'), field('description'), field('whenToUse'), field('instructions')].filter(Boolean).join('\n'), run.workspace))
        if (!(shared && agent.memoryProfile === 'project-global')) kept = 'sharing is switched off for this project or worker'
        else if (references) kept = `it names ${references}`
        if (kept) scope = 'project'
      }
      // An agent is never the user, the harness or the promotion pass, whatever it writes as the source.
      const source = /^(user|system|promoted)$/i.test(String(args.source || '').trim()) ? '' : args.source
      // The package fields go to the store as they came: it validates them (limits, paths, types) and names what is wrong.
      const pack = args as Record<string, unknown>
      const text = (value: string | undefined, max: number): string | undefined => value === undefined ? undefined : bounded(value, max)
      const saved = store.save({
        id: known?.id ?? args.id, name: text(field('name'), 160)!, description: text(field('description'), 1000), whenToUse: text(field('whenToUse'), 400), instructions: text(field('instructions'), 20000)!,
        scope, workspace: run.workspace, source: bounded(source || `agent:${agent.id}`, 300),
        files: pack.files as SkillSaveInput['files'], removeFiles: pack.removeFiles as string[] | undefined, fromDir: pack.fromDir as string | undefined,
        params: pack.params as unknown[] | undefined, triggers: pack.triggers as unknown[] | undefined, commands: pack.commands as unknown[] | undefined,
      }, { origin: 'agent' })
      run.skillSaved = true
      const notes: string[] = []
      if (saved.merged) notes.push(`A skill named "${saved.improved}" was very similar and was improved instead of duplicated (its previous version stays in the history). If yours is a different procedure, save it under a clearly different name.`)
      if (kept) notes.push(`Saved to this PROJECT's skills instead of the shared library: ${kept}.`)
      if (String(field('instructions') || '').trim().length > saved.entry.instructions.length) notes.push(`The instructions were cut to ${saved.entry.instructions.length} characters: keep a skill short, or split it.`)
      return { ok: true, id: saved.entry.id, name: saved.entry.name, scope: saved.entry.scope, version: saved.entry.version,
        ...(saved.merged ? { merged: true } : {}), ...(kept ? { demoted: true } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) }
    }
  }
  throw new Error(`Unknown tool: ${name}`)
}

export { markMemoryUse, executeKnowledgeTool }
