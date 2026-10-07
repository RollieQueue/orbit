// Trained agents at run time (electron/trained-agents.mts holds their data, electron/capabilities.mts their store): the tools
// agent_save and agent_read, and what spawn_agent {profile} does before the helper exists: it finds the agent, makes its
// playbook part of the helper's prompt, takes its defaults and counts the use. An agent is a capability, so capability_feedback
// rates it and its pitfalls come from there.
import { reliability } from '../capabilities.mts'
import { folderManifest } from '../skill-packages.mts'
import { PLAYBOOK_CHARS, lastScore } from '../trained-agents.mts'
import { projectReferences, describe as describeReferences } from '../scope-guard.mts'
import { AGENT_READ_CHARS, clip } from './util.mts'
import type { AgentRecord, CapabilityStoreLike, Observation, OrbitRuntimeLike, RunRecord, SkillEntry, SkillSaveInput, SkillScope, SpawnResult, ToolArgs } from '../types.mts'

// The newest rounds agent_read shows whole (older ones only as a score history), each with its notes cut: the playbook comes last
// and must never be the part an output limit takes.
const ROUNDS_SHOWN = 8, NOTES_SHOWN = 600
const RATE = (id: string): string => `When the helper's work is judged, report it with capability_feedback {id: "${id}", outcome: worked|partial|failed, note}: a failure's note becomes a pitfall for the next use and the outcome the agent's record.`

// A use of the agent in this run, counted once per run however it was reached (agent_read or spawn_agent {profile}).
function markAgentUse(runtime: OrbitRuntimeLike, run: RunRecord, id: string): void {
  const used = run.agentUse ??= new Set<string>()
  if (used.has(id)) return
  used.add(id)
  runtime.capabilityStore?.recordUse?.(id, run.workspace, run.globalMemoryEnabled)
}

// The reachable agent a reference names (id, unique id prefix or exact name); a switched-off one is refused for agents, as a skill is.
function reachable(store: CapabilityStoreLike, run: RunRecord, reference: unknown): SkillEntry {
  if (typeof store.findAgent !== 'function') throw new Error('Trained agents are unavailable in this run')
  const entry = store.findAgent(String(reference ?? ''), run.workspace, run.globalMemoryEnabled)
  if (!entry?.agent) throw new Error(`No trained agent "${clip(reference, 60)}" is reachable from this project; agent_read without an id lists them (id or exact name)`)
  if (entry.enabled === false) throw new Error(`The trained agent "${entry.name}" is switched off by the user (Skills panel, Agents tab)`)
  return entry
}

async function executeAgentTool(runtime: OrbitRuntimeLike, run: RunRecord, agent: AgentRecord, name: string, args: ToolArgs): Promise<Observation> {
  const store: CapabilityStoreLike = runtime.capabilityStore!
  const shared = run.globalMemoryEnabled
  if (name === 'agent_read') {
    if (args.id === undefined || String(args.id).trim() === '') {
      const agents = typeof store.agents === 'function' ? store.agents(run.workspace, shared) : []
      return { agents, hint: agents.length ? 'agent_read {id} returns one agent whole (playbook, files, gallery, training rounds, pitfalls); spawn_agent {profile: id or name, task, reason} runs a helper as it' : 'No trained agent yet: agent_save creates one' }
    }
    const entry = reachable(store, run, args.id)
    const full = await store.read(entry.id, run.workspace, shared)
    markAgentUse(runtime, run, entry.id)
    const profile = full.agent!
    const rounds = profile.rounds.slice(-ROUNDS_SHOWN).map(round => ({ ...round, ...(round.notes ? { notes: clip(round.notes, NOTES_SHOWN) } : {}) }))
    const shown = {
      id: full.id, name: full.name, role: profile.role, status: profile.status, scope: full.scope, version: full.version, whenToUse: full.whenToUse,
      ...(profile.kind ? { kind: profile.kind } : {}), ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
      ...(full.package ? { package: full.package } : {}), files: full.files ?? [], gallery: profile.gallery,
      training: { rounds: profile.rounds.length, ...(profile.trainingMinutes !== undefined ? { minutes: profile.trainingMinutes } : {}), ...(lastScore(profile) !== undefined ? { lastScore: lastScore(profile) } : {}), history: profile.rounds.map(round => ({ round: round.round, score: round.score })) },
      rounds, ...(profile.rounds.length > rounds.length ? { roundsOmitted: profile.rounds.length - rounds.length } : {}),
      uses: full.uses, successes: full.successes, failures: full.failures, reliability: Math.round(reliability(full) * 100) / 100,
      ...(full.lessons?.length ? { pitfalls: full.lessons } : {}),
      note: `spawn_agent {profile: "${full.id}", task, reason} runs a helper as this agent (its kind and reasoningEffort are the defaults). ${RATE(full.id)}`,
    }
    // The playbook comes last. One that JSON escaping makes longer than an observation holds is cut at its end and says so, rather
    // than leaving the cut to the output limit unannounced (a revision made from a cut text would damage the agent).
    let playbook = full.instructions
    const room = AGENT_READ_CHARS - JSON.stringify(shown).length - 600
    while (JSON.stringify(playbook).length > room && playbook.length > 1000) playbook = playbook.slice(0, Math.floor(playbook.length * 0.95))
    return playbook === full.instructions ? { ...shown, playbook }
      : { ...shown, playbookCut: `only the first ${playbook.length} of ${full.instructions.length} characters fit in one result; do not rewrite the playbook from this text, edit its source file in the package folder and save it with agent_save {fromDir}`, playbook }
  }
  // agent_save: create (no id) or update (id) a trained agent, following capability_install's conventions.
  const known = args.id ? store.find(String(args.id), run.workspace, shared) : null
  if (args.id && !known) throw new Error('No trained agent with that id is reachable from this project (agent_read lists them); leave id out to create one')
  if (known && !known.agent) throw new Error(`"${known.name}" is a skill, not a trained agent: change it with capability_install`)
  const manifest = args.fromDir ? folderManifest(String(args.fromDir), run.workspace, true) : null
  const field = (key: 'name' | 'whenToUse' | 'instructions' | 'scope' | 'role'): string | undefined => args[key] ?? manifest?.[key]
  if (!known && (!String(field('name') || '').trim() || !String(field('role') || '').trim() || !String(field('instructions') || '').trim())) {
    throw new Error('A new trained agent needs a name, a role (one line) and a playbook (instructions), unless fromDir holds a skill.json with them; to change an agent pass its id')
  }
  // Scope. An update stays where the agent is: an explicit scope that differs is refused (the store cannot move an agent; a
  // folder's skill.json scope only decides a new agent). A NEW agent may ask to be shared and is kept in the project when its text
  // names it or sharing is off. An update of a shared agent is checked for one thing: what it now says must not name this project.
  const asked = known ? args.scope : field('scope')
  if (known && asked && asked !== known.scope) throw new Error(`"${known.name}" is a ${known.scope === 'global' ? 'shared' : 'project'} agent and an agent's scope cannot be changed: save a new agent in the other scope (agent_save without id) and remove this one in the Skills panel`)
  let scope: SkillScope = known ? known.scope : asked === 'global' ? 'global' : 'project', kept = ''
  if (scope === 'global') {
    const round = args.round as { notes?: unknown } | undefined, gallery = Array.isArray(args.gallery) ? args.gallery as { caption?: unknown }[] : []
    const texts = [field('name'), field('role'), field('whenToUse'), field('instructions'), typeof round?.notes === 'string' ? round.notes : '', ...gallery.map(item => typeof item?.caption === 'string' ? item.caption : '')]
    const references = describeReferences(projectReferences(texts.filter(Boolean).join('\n'), run.workspace))
    if (known) {
      if (references) throw new Error(`"${known.name}" is shared with every project, so what you save cannot name this project (${references}); keep that out of it`)
    } else {
      // Sharing is the agent's call, but an agent that only makes sense here stays here, and so does one from a project that opted out.
      if (!(shared && agent.memoryProfile === 'project-global')) kept = 'sharing is switched off for this project or worker'
      else if (references) kept = `it names ${references}`
      if (kept) scope = 'project'
    }
  }
  const pack = args as Record<string, unknown>
  const saved = store.save({
    id: known?.id, name: field('name') as string, whenToUse: field('whenToUse'), instructions: field('instructions') as string,
    scope, workspace: run.workspace, source: `agent:${agent.id}`,
    files: pack.files as SkillSaveInput['files'], removeFiles: pack.removeFiles as string[] | undefined, fromDir: pack.fromDir as string | undefined,
    agent: { role: field('role'), kind: args.kind, reasoningEffort: args.reasoningEffort, status: args.status, round: args.round, gallery: args.gallery, trainingMinutes: args.trainingMinutes },
  }, { origin: 'agent' })
  const entry = saved.entry as SkillEntry & { notes?: string[] }
  const profile = entry.agent!
  const notes = [...(saved.notes ?? [])]
  if (kept) notes.push(`Saved to this PROJECT's agents instead of the shared library: ${kept}.`)
  if (String(field('instructions') || '').trim().length > PLAYBOOK_CHARS) notes.push(`The playbook was cut to ${PLAYBOOK_CHARS} characters: keep it shorter, and put long references in files of the package`)
  return {
    ok: true, id: entry.id, name: entry.name, scope: entry.scope, version: entry.version, status: profile.status, ...(kept ? { demoted: true } : {}),
    package: { dir: entry.package?.dir ?? null, files: entry.files?.length ?? 0 }, rounds: profile.rounds.length, ...(lastScore(profile) !== undefined ? { lastScore: lastScore(profile) } : {}), gallery: profile.gallery.length,
    ...(notes.length ? { note: notes.join(' ') } : {}),
  }
}

// What the helper's prompt starts with: who it is, where its package is, the playbook and the pitfalls earlier uses found.
function profilePrompt(entry: SkillEntry, dir: string | undefined): string {
  const pitfalls = entry.lessons?.length ? `\n\nKNOWN PITFALLS (from earlier uses):\n${entry.lessons.slice(0, 5).map(lesson => `- ${lesson}`).join('\n')}` : ''
  return `YOU ARE "${entry.name}", a trained Orbit agent (${entry.agent!.role}). Your playbook is your trained expertise: follow it.${dir ? ` PACKAGE FOLDER (scripts, references): ${dir}` : ''}${dir ? '\nRelative paths in the playbook are relative to that folder.' : ''}\n\nPLAYBOOK:\n${entry.instructions}${pitfalls}`
}

// The short line a resumed session turn carries (it sends only what is new, so the first prompt's playbook is out of sight once the
// session is compacted): who the helper is, where its package is, and that its playbook rules.
function profileReminder(entry: SkillEntry, dir: string | undefined): string {
  return `YOU ARE "${entry.name}", a trained Orbit agent (${entry.agent!.role}). Follow your playbook (in your first prompt of this session)${dir ? `; package folder: ${dir}` : ''}.`
}

// spawn_agent {profile}: the spec as the helper gets it (kind and reasoningEffort the caller left out come from the agent, and a name
// it left out is chosen at registration; the playbook rides on the helper's prompt, never on its visible task), or the refusal. `trained` is internal: a caller cannot set it.
function applyProfile(runtime: OrbitRuntimeLike, run: RunRecord, spec: ToolArgs): { spec: ToolArgs; entry: SkillEntry; dir?: string } | SpawnResult {
  const reference = spec.profile
  if (typeof reference !== 'string' || !reference.trim()) return { ok: false, reason: 'invalid_profile', instruction: 'profile is the id (or exact name) of a trained agent; agent_read lists them' }
  const store = runtime.capabilityStore
  if (!store) return { ok: false, reason: 'unknown_profile', instruction: 'Trained agents are unavailable in this run' }
  let entry: SkillEntry
  try { entry = reachable(store, run, reference.trim()) } catch (error) {
    const off = /switched off/.test((error as Error).message)
    return { ok: false, reason: off ? 'profile_disabled' : 'unknown_profile', instruction: (error as Error).message }
  }
  const dir = store.read(entry.id, run.workspace, run.globalMemoryEnabled).package?.dir
  const profile = entry.agent!
  // The name stays the caller's; without one agents.vetSpawn picks a free one at registration ("<agent>", "<agent> 2", ...).
  return {
    entry, ...(dir ? { dir } : {}),
    spec: {
      ...spec, ...(spec.kind || !profile.kind ? {} : { kind: profile.kind }),
      ...(spec.reasoningEffort || !profile.reasoningEffort ? {} : { reasoningEffort: profile.reasoningEffort }),
      trained: { id: entry.id, name: entry.name, role: profile.role, prompt: profilePrompt(entry, dir), reminder: profileReminder(entry, dir), ...(spec.name ? {} : { autoName: true as const }) },
    },
  }
}

// A name nobody in this run has: the wanted one, else "<name> 2", "<name> 3", ... (at most 80 characters, as an agent's name is).
function freeName(run: RunRecord, wanted: string): string {
  const taken = new Set([...run.agentNodes.values()].map(agent => agent.name))
  const base = wanted.trim().slice(0, 80) || 'Agent'
  for (let number = 1; ; number++) {
    const candidate = number === 1 ? base : `${base.slice(0, 80 - String(number).length - 1)} ${number}`
    if (!taken.has(candidate)) return candidate
  }
}

// What spawn_agent answers for a helper started as an agent: who it runs as and how its work is rated.
const profileResult = (entry: SkillEntry): NonNullable<SpawnResult['profile']> => ({ id: entry.id, name: entry.name, role: entry.agent!.role, note: RATE(entry.id) })

export { executeAgentTool, applyProfile, freeName, profileResult, markAgentUse }
