import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readJSON, writeJSON, keyCache, redact, clone } from './storage.mts'
import { TextIndex, uniqueTerms, similarity, signature } from './text-index.mts'
import type { IndexField } from './text-index.mts'
import { projectReferences, scrub } from './scope-guard.mts'
import { oneLine } from './text.mts'
import { skillPackageDir, skillPackageId } from './skill-files.mts'
import { applyPackage, checkCommands, checkParams, checkSourceDir, checkTriggers, checkValues, planPackage, readFolder, removePackage, reviveCommands, reviveFiles, reviveParams, reviveTriggers } from './skill-packages.mts'
import type { Manifest } from './skill-packages.mts'
import type { SkillCommand, SkillFile, SkillPackage, SkillParam, SkillTrigger } from './types.mts'

// Skills: what agents built or learned to do and can do again. A skill is a versioned add-on of any form: a procedure, or a
// package (pages, scripts, assets in its own folder, electron/skill-packages.mts) with parameters, triggers and commands.
// Beyond the text it carries what makes the library improve by use instead of just growing: how often it was used, whether
// it worked, and the pitfalls agents ran into. Retrieval ranks by relevance and track record; the library is
// capped per scope and what nobody uses, or what keeps failing, is pruned.
const DAY = 86400000
type SkillScope = 'project' | 'global'
type SkillOutcome = 'worked' | 'partial' | 'failed'
const LIMITS: Record<SkillScope, number> = { project: 60, global: 100 }
const AGENT_INSTRUCTION_CHARS = 12000, USER_INSTRUCTION_CHARS = 24000
const REVISIONS = 10, LESSONS = 8, PROJECTS_SEEN = 20
// A skill an agent saves that says (nearly) what an existing one says improves it. The bar is high: "Release Node package"
// and "Release Python package" share most of their words and are different procedures.
const MERGE_NAME = 0.66, MERGE_TEXT = 0.7, DUPLICATE_TEXT = 0.85
const OUTCOMES: Record<SkillOutcome, [number, number]> = { worked: [1, 0], partial: [0.5, 0.5], failed: [0, 1] }
const isOutcome = (value: unknown): value is SkillOutcome => Boolean(OUTCOMES[value as SkillOutcome])
const FLUSH_DELAY_MS = 2500

// An earlier version of a skill's text, kept so `restore` can bring it back as a new version.
interface SkillRevision { version: number; name: string; description: string; whenToUse: string; instructions: string; updatedAt: string }
// A skill as capabilities.json stores it: the procedure, its revisions and its track record. `usedIn` holds short
// hashes of the projects a shared skill was used in; `dupOf` points at the shared copy of a promoted project skill.
interface Skill {
  id: string; name: string; description: string; whenToUse: string; instructions: string; scope: SkillScope; workspace?: string
  source: string; editedBy?: string; version: number; updatedAt: string; revisions: SkillRevision[]
  created: string; lastUsed: string; uses: number; successes: number; failures: number
  lessons: string[]; usedIn: string[]; pinned: boolean; dupOf?: string
  // Agents see only enabled skills. The package's files live in skillPackageDir(userData, id); the lists here are its current
  // state (revisions keep the text only). Params hold the user's values next to the defaults.
  enabled: boolean; files: SkillFile[]; params: SkillParam[]; triggers: SkillTrigger[]; commands: SkillCommand[]
  // An older version's stamp, read only where `updatedAt` may be missing.
  updated?: string
}
// A skill as read from disk: any field may be missing or of another type until `revive` has coerced it.
type StoredSkill = { [Field in keyof Skill]?: unknown }
const isStoredSkill = (value: unknown): value is StoredSkill => !!value && typeof (value as { instructions?: unknown }).instructions === 'string'
// What `save`/`install` accept from the UI or an agent; nothing in it is trusted before it is checked.
interface SkillInput {
  id?: unknown; scope?: unknown; workspace?: unknown; name?: unknown; description?: unknown; whenToUse?: unknown; instructions?: unknown; source?: unknown
  files?: unknown; removeFiles?: unknown; fromDir?: unknown; params?: unknown; triggers?: unknown; commands?: unknown
}
// A skill as lists and search results show it: without the instructions and revisions, with its reliability and, when it has files, where they are.
interface SkillSummary extends Omit<Skill, 'instructions' | 'revisions'> { reliability: number; package?: SkillPackage }
interface SkillRank { entry: Skill; relevance: number; matched: number; score: number }
interface SkillSuggestion { skills: Array<SkillSummary & { relevant: boolean }>; total: number }
interface SaveResult { entry: Skill; merged: boolean; improved?: string; evicted: number }
interface MaintainReport { expired: number; merged: number; evicted: number; shared: number }
interface MaintainOptions { workspace?: string | null; crossProject?: boolean; projects?: string[] | null }
type Editor = (entry: Skill, patch: Partial<Skill>) => void
interface Print { stamp?: string; text: Set<string>; title: Set<string> }

const shortId = (id: string): string => id.length <= 14 ? id : id.slice(0, 12)
const groupKey = (entry: Pick<Skill, 'scope' | 'workspace'>): string => `${entry.scope}|${entry.workspace || ''}`
const authored = (entry: Skill): boolean => entry.source === 'user'
// A package is something the user may rely on (a page Orbit shows, commands agents run), so it is protected like a pinned or
// user-written skill: never expired, evicted or merged.
const hasPackage = (entry: Pick<Skill, 'files' | 'triggers' | 'commands'>): boolean => entry.files.length > 0 || entry.triggers.length > 0 || entry.commands.length > 0
const isProtected = (entry: Skill): boolean => entry.pinned === true || authored(entry) || hasPackage(entry)
const reliability = (entry: { successes?: number; failures?: number }): number => ((entry.successes || 0) + 1) / ((entry.successes || 0) + (entry.failures || 0) + 2)
const fingerprint = (name: string, text: string): Print => ({ text: uniqueTerms(`${name} ${text}`), title: uniqueTerms(name) })
const isPrint = (value: Skill | Print): value is Print => Boolean((value as Print).text)

class CapabilityStore {
  declare file: string
  declare userData: string
  declare clock: () => number
  declare key: (workspace: unknown) => string
  declare index: TextIndex
  declare prints: Map<string, Print>
  declare dirty: boolean
  declare timer: ReturnType<typeof setTimeout> | null
  declare entries: Skill[]
  constructor(userDataPath: string, { clock = Date.now }: { clock?: () => number } = {}) {
    this.file = path.join(userDataPath, 'capabilities.json')
    this.userData = userDataPath
    this.clock = clock
    this.key = keyCache()
    this.index = new TextIndex()
    this.prints = new Map()
    this.dirty = false
    this.timer = null
    const data = readJSON(this.file, [])
    this.entries = Array.isArray(data) ? (data as unknown[]).filter(isStoredSkill).map(entry => this.revive(entry)) : []
    for (const entry of this.entries) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  // The disk boundary: the fields the store relies on are coerced here; scope and workspace are checked by
  // `indexable`/`visible` wherever a skill is looked at.
  revive(entry: StoredSkill): Skill {
    const stamp = typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(this.clock()).toISOString()
    const revived = {
      ...entry, id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
      ...(entry.workspace ? { workspace: this.key(entry.workspace) } : {}),
      description: entry.description || '', whenToUse: entry.whenToUse || '', updatedAt: stamp, created: entry.created || stamp, lastUsed: entry.lastUsed || stamp,
      uses: entry.uses || 0, successes: entry.successes || 0, failures: entry.failures || 0,
      lessons: Array.isArray(entry.lessons) ? entry.lessons : [], usedIn: Array.isArray(entry.usedIn) ? entry.usedIn : [], pinned: entry.pinned === true,
      enabled: entry.enabled !== false, files: reviveFiles(entry.files), params: reviveParams(entry.params),
      triggers: reviveTriggers(entry.triggers), commands: reviveCommands(entry.commands),
    } as Skill
    return revived
  }
  indexable(entry: Skill): boolean { return entry.scope === 'global' || (entry.scope === 'project' && !!entry.workspace) }
  fields(entry: Skill): IndexField[] { return [[entry.name, 3], [entry.whenToUse, 2], [entry.description, 2], [entry.instructions, 1]] }

  // `includeGlobal` false is a project that switched shared memory off: it neither sees nor touches the shared library.
  visible(workspace: string | null | undefined, includeGlobal = true): Skill[] {
    const key = this.key(workspace)
    return this.entries.filter(entry => (includeGlobal && entry.scope === 'global') || (key && entry.scope === 'project' && entry.workspace === key))
  }
  // A project copy of a skill that was promoted to the shared library is shown once, from the shared library.
  distinct(workspace: string | null | undefined, includeGlobal = true): Skill[] {
    const shared = new Set(this.entries.filter(entry => entry.scope === 'global').map(entry => entry.id))
    return this.visible(workspace, includeGlobal).filter(entry => !(entry.dupOf && includeGlobal && shared.has(entry.dupOf)))
  }

  print(entry: Skill): Print {
    const cached = this.prints.get(entry.id)
    if (cached?.stamp === entry.updatedAt) return cached
    const print = { stamp: entry.updatedAt, ...fingerprint(entry.name, `${entry.whenToUse} ${entry.description} ${entry.instructions}`) }
    this.prints.set(entry.id, print)
    return print
  }
  near(left: Skill | Print, right: Skill | Print, name: number, text: number): boolean {
    const a = isPrint(left) ? left : this.print(left), b = isPrint(right) ? right : this.print(right)
    return similarity(a.title, b.title) >= name && similarity(a.text, b.text) >= text
  }

  value(entry: Skill): number {
    if (isProtected(entry)) return 2
    const age = Math.max(0, (this.clock() - Date.parse(entry.lastUsed || entry.updatedAt)) / DAY) || 0
    return 0.1 + 0.35 * reliability(entry) + 0.3 * 0.5 ** (age / 180) + 0.25 * Math.min(1, Math.log1p(entry.uses || 0) / Math.log1p(10))
  }

  present(entry: Skill): SkillSummary {
    const { instructions, revisions, ...rest } = entry
    return { ...clone(rest), ...this.packageOf(entry), reliability: Math.round(reliability(entry) * 100) / 100 }
  }
  packageOf(entry: Skill): { package?: SkillPackage } {
    return entry.files.length ? { package: { id: skillPackageId(entry.id), dir: skillPackageDir(this.userData, entry.id) } } : {}
  }

  list(workspace?: string | null, includeGlobal = true): SkillSummary[] { return this.visible(workspace, includeGlobal).map(entry => this.present(entry)) }

  // Ranked by relevance first, then by track record: a skill that worked beats an untried one that reads the same.
  rank(query: unknown, candidates: Skill[]): SkillRank[] {
    const found = this.index.search(query, new Set(candidates.map(entry => entry.id)))
    const top = Math.max(0, ...[...found.values()].map(hit => hit.score))
    return candidates.map(entry => {
      const hit = found.get(entry.id)
      const relevance = hit && top ? hit.score / top : 0
      return { entry, relevance, matched: hit?.matched || 0, score: relevance * 0.7 + reliability(entry) * 0.15 + Math.min(1, this.value(entry)) * 0.15 }
    })
  }
  search(query: unknown, workspace: string | null | undefined, limit = 8, includeGlobal = true): SkillSummary[] {
    const empty = !uniqueTerms(query).size
    return this.rank(query, this.distinct(workspace, includeGlobal).filter(entry => entry.enabled !== false)).filter(item => empty || item.matched > 0).sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map(item => this.present(item.entry))
  }
  // For a prompt: the skills that match the task, then a few proven ones so the agent knows the library has more.
  // Disabled skills are hidden from agents, and a skill with a trigger and no commands is app behaviour (a page Orbit shows), not a procedure an agent could follow.
  suggest(query: unknown, workspace: string | null | undefined, limit = 6, includeGlobal = true): SkillSuggestion {
    const ranked = this.rank(query, this.distinct(workspace, includeGlobal).filter(entry => entry.enabled !== false && !(entry.triggers.length && !entry.commands.length)))
    const relevant = ranked.filter(item => item.matched >= 1).sort((a, b) => b.score - a.score).slice(0, limit)
    const proven = ranked.filter(item => item.matched < 1 && item.entry.uses > 0 && reliability(item.entry) >= 0.5).sort((a, b) => this.value(b.entry) - this.value(a.entry)).slice(0, Math.min(3, limit - relevant.length))
    return { skills: [...relevant, ...proven].map(item => ({ ...this.present(item.entry), relevant: item.matched >= 1 })), total: ranked.length }
  }

  find(id: unknown, workspace: string | null | undefined, includeGlobal = true): Skill | null {
    const visible = this.visible(workspace, includeGlobal)
    const exact = visible.find(entry => entry.id === id)
    if (exact) return exact
    const wanted = String(id || '')
    const prefixed = wanted.length >= 6 ? visible.filter(entry => entry.id.startsWith(wanted)) : []
    return prefixed.length === 1 ? prefixed[0] : null
  }
  read(id: unknown, workspace: string | null | undefined, includeGlobal = true): Skill & { package?: SkillPackage } {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    return { ...clone(entry), ...this.packageOf(entry) }
  }

  commit(next: Skill[], changed: Skill[] = [], removed: string[] = []): void {
    writeJSON(this.file, next)
    this.entries = next
    this.dirty = false
    for (const id of removed) { this.index.delete(id); this.prints.delete(id); removePackage(skillPackageDir(this.userData, id)) }
    for (const entry of changed) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  overflow(entries: Skill[], keep: Skill): string[] {
    const group = entries.filter(entry => groupKey(entry) === groupKey(keep))
    if (group.length <= LIMITS[keep.scope]) return []
    return group.filter(entry => entry !== keep && !isProtected(entry)).map(entry => ({ entry, value: this.value(entry) }))
      .sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt))).slice(0, group.length - LIMITS[keep.scope]).map(item => item.entry.id)
  }

  // origin 'agent' is bounded, and a skill that says what an existing one says improves that one instead of duplicating it.
  // Track-record fields are never taken from the input: they change only through use and feedback. Everything the input says is
  // validated (files included) before anything is written; a save that fails leaves the disk and the entry as they were.
  // Package fields left out keep what the skill has, an empty list clears; `fromDir` replaces the files and its skill.json fills
  // the fields the call does not give.
  save(input: SkillInput, { origin = 'user' }: { origin?: 'user' | 'agent' } = {}): SaveResult {
    if (!input || typeof input !== 'object') throw new Error('Capability is required')
    const guarded = origin === 'agent'
    const folder = input.fromDir === undefined || input.fromDir === null || input.fromDir === '' ? null : readFolder(checkSourceDir(String(input.fromDir), input.workspace, guarded))
    const manifest = folder?.manifest ?? {}
    const given = <K extends keyof Manifest & keyof SkillInput>(key: K): unknown => input[key] ?? manifest[key]
    const scope: SkillScope = given('scope') === 'global' ? 'global' : 'project'
    const workspace = scope === 'project' ? this.key(input.workspace) : ''
    if (scope === 'project' && !workspace) throw new Error('Project capability requires a workspace')
    const byId = input.id ? this.entries.find(entry => entry.id === input.id) : undefined
    const name = redact(input.name || manifest.name || byId?.name || input.id).trim().slice(0, 120)
    const instructions = redact(input.instructions || manifest.instructions || byId?.instructions).trim().slice(0, guarded ? AGENT_INSTRUCTION_CHARS : USER_INSTRUCTION_CHARS)
    if (!name || !instructions) throw new Error('Capability name and instructions are required')
    let existing: Skill | undefined = input.id ? byId : this.visible(workspace).find(entry => entry.name === name && entry.scope === scope)
    if (existing && (existing.scope !== scope || (existing.workspace || '') !== workspace)) {
      throw new Error('Cannot replace a capability from another project or scope')
    }
    // An agent cannot claim to be the user, the harness or the promotion pass.
    const claimed = redact(input.source || 'agent').slice(0, 300)
    const source = guarded && /^(user|system|promoted)$/i.test(claimed.trim()) ? 'agent' : claimed
    const filled = (value: unknown): boolean => Array.isArray(value) && value.length > 0
    let merged = false
    // A package is never the target or the source of a twin merge: two near-identical pages or command sets are two behaviours.
    if (!existing && guarded && !folder && !filled(input.files) && !filled(given('triggers')) && !filled(given('commands'))) {
      const probe = fingerprint(name, `${input.whenToUse || ''} ${input.description || ''} ${instructions}`)
      const twin = this.entries.find(item => !hasPackage(item) && groupKey(item) === groupKey({ scope, workspace }) && this.near(probe, item, MERGE_NAME, MERGE_TEXT))
      if (twin) { existing = twin; merged = true }
    }
    // An agent that names a package skill without its id could clear the page or commands of one the user relies on.
    if (guarded && existing && !input.id && hasPackage(existing)) throw new Error(`A skill named "${existing.name}" already is a package (files, a page or commands); to change it pass its id "${existing.id}", or save yours under another name`)
    const id = existing?.id || (typeof input.id === 'string' && input.id.trim() ? input.id.slice(0, 120) : randomUUID())
    const dir = skillPackageDir(this.userData, id)
    const plan = planPackage(existing?.files ?? [], { source: folder, files: input.files, removeFiles: input.removeFiles })
    const params = given('params') === undefined ? existing?.params ?? [] : checkParams(given('params'), existing?.params ?? [])
    const triggers = checkTriggers(given('triggers') ?? existing?.triggers ?? [], file => plan.files.some(item => item.path === file))
    const commands = given('commands') === undefined ? existing?.commands ?? [] : checkCommands(given('commands'))
    const now = new Date(this.clock()).toISOString()
    const kept: Partial<Skill> = { ...existing }
    delete kept.dupOf
    const entry: Skill = {
      ...kept,
      id, name,
      description: redact(given('description') ?? existing?.description ?? '').slice(0, 600),
      whenToUse: redact(given('whenToUse') ?? existing?.whenToUse ?? '').slice(0, 300), instructions,
      scope, ...(workspace ? { workspace } : {}),
      // A skill the user wrote stays theirs (protected from pruning) when an agent improves it; the agent's edit is noted next to it.
      source: guarded && existing && authored(existing) ? existing.source : source,
      editedBy: guarded && existing && authored(existing) ? source : undefined,
      version: (existing?.version || 0) + 1, updatedAt: now,
      revisions: existing ? [...(existing.revisions || []), {
        version: existing.version, name: existing.name, description: existing.description, whenToUse: existing.whenToUse,
        instructions: existing.instructions, updatedAt: existing.updatedAt,
      }].slice(-REVISIONS) : [],
      created: existing?.created || now, lastUsed: existing?.lastUsed || now, uses: existing?.uses || 0, successes: existing?.successes || 0, failures: existing?.failures || 0,
      lessons: existing?.lessons || [], usedIn: existing?.usedIn || [], pinned: existing?.pinned === true,
      enabled: existing?.enabled !== false, files: plan.files, params, triggers, commands,
    }
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
    // Protected skills (packages, pinned, the user's) are never evicted: a new skill that would still not fit is refused, not squeezed in.
    if (!existing && entries.filter(item => groupKey(item) === groupKey(entry)).length - evicted.length > LIMITS[scope]) {
      throw new Error(`Skill limit: at most ${LIMITS[scope]} ${scope === 'global' ? 'shared' : 'project'} skills, and the rest are protected (packages, pinned or the user's); remove one or improve an existing skill by its id`)
    }
    // Leftovers of an earlier skill with this id must not become part of a new one.
    if (!existing && plan.writes.size) removePackage(dir)
    const undo = plan.writes.size || plan.deletes.length ? applyPackage(dir, plan) : (): void => {}
    try { this.commit(evicted.length ? entries.filter(item => !evicted.includes(item.id)) : entries, [entry], evicted) } catch (error) { undo(); throw error }
    return { entry: { ...clone(entry), ...this.packageOf(entry) }, merged, ...(merged ? { improved: existing?.name } : {}), evicted: evicted.length }
  }
  install(input: SkillInput, options?: { origin?: 'user' | 'agent' }): Skill { return this.save(input, options).entry }

  // The agent used the skill: counted, and remembered per project (as a hash, so no path is stored) for shared skills.
  recordUse(id: unknown, workspace: string | null | undefined, includeGlobal = true): string | null {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) return null
    entry.uses = (entry.uses || 0) + 1
    entry.lastUsed = new Date(this.clock()).toISOString()
    const seen = createHash('sha1').update(this.key(workspace)).digest('hex').slice(0, 8)
    if (entry.scope === 'global' && !entry.usedIn.includes(seen)) entry.usedIn = [...entry.usedIn, seen].slice(-PROJECTS_SEEN)
    this.schedule()
    return entry.id
  }
  schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, FLUSH_DELAY_MS)
    this.timer.unref?.()
  }
  flush(): void {
    clearTimeout(this.timer ?? undefined); this.timer = null
    if (!this.dirty) return
    try { writeJSON(this.file, this.entries); this.dirty = false } catch { /* Retried with the next change; a counter never breaks a run. */ }
  }

  // Did it work? A failure or a partial result keeps its pitfall with the skill for the next agent.
  feedback(id: unknown, workspace: string | null | undefined, { outcome, note, includeGlobal = true }: { outcome?: unknown; note?: unknown; includeGlobal?: boolean } = {}): SkillSummary & { lessonDropped?: boolean } {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    if (!isOutcome(outcome)) throw new Error('Outcome must be worked, partial or failed')
    const [good, bad] = OUTCOMES[outcome]
    const shared = entry.scope === 'global'
    const scrubbed = redact(scrub(note || '', workspace, { pathsOnly: !shared })).replace(/\s+/g, ' ').trim().slice(0, 300)
    // A pitfall kept with a shared skill must not name a project; if something still does after scrubbing, it is not kept.
    const dropped = shared && projectReferences(scrubbed, workspace).length > 0
    const text = dropped ? '' : scrubbed
    const lessons = text && outcome !== 'worked' ? [text, ...entry.lessons.filter(item => item !== text)].slice(0, LESSONS) : entry.lessons
    const next = { ...entry, successes: (entry.successes || 0) + good, failures: (entry.failures || 0) + bad, lessons, lastUsed: new Date(this.clock()).toISOString() }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return { ...this.present(next), ...(dropped && outcome !== 'worked' ? { lessonDropped: true } : {}) }
  }

  pin(id: unknown, pinned: unknown, workspace: string | null | undefined): SkillSummary {
    const entry = this.find(id, workspace)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    const next = { ...entry, pinned: pinned === true }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return this.present(next)
  }

  // The switch next to every skill: a disabled skill stays in the library but agents neither find nor get it suggested. Not a new version.
  setEnabled(id: unknown, enabled: unknown, workspace: string | null | undefined): SkillSummary {
    const entry = this.find(id, workspace)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    const next = { ...entry, enabled: enabled === true }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return this.present(next)
  }

  remove(id: unknown, workspace: string | null | undefined): boolean {
    const entry = this.visible(workspace).find(item => item.id === id)
    if (!entry) return false
    this.commit(this.entries.filter(item => item !== entry), [], [entry.id])
    return true
  }

  // The text comes back as a new version; the package (files, parameters, triggers, commands) is current state and stays.
  restore(id: unknown, version: unknown, workspace: string | null | undefined): Skill {
    const entry = this.read(id, workspace)
    const revision = entry.revisions.find(item => item.version === version)
    if (!revision) throw new Error('Capability revision was not found')
    const { name, description, whenToUse, instructions } = revision
    return this.install({ id: entry.id, name, description, whenToUse, instructions, scope: entry.scope, workspace: entry.workspace, source: entry.source })
  }

  // The user's values for a skill's parameters (the skills panel). Not a new version: it is the skill's settings, not its text.
  setParams(id: unknown, values: unknown, workspace: string | null | undefined): SkillSummary {
    const entry = this.find(id, workspace)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    const next = { ...entry, params: checkValues(entry.params, values) }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return this.present(next)
  }

  stats(workspace: string | null | undefined): { project: { count: number; limit: number }; global: { count: number; limit: number }; used: number } {
    const visible = this.visible(workspace)
    const scope = (name: SkillScope) => { const items = visible.filter(entry => entry.scope === name); return { count: items.length, limit: LIMITS[name] } }
    return { project: scope('project'), global: scope('global'), used: visible.filter(entry => entry.uses > 0).length }
  }

  // Prune what is not earning its place, keep the caps, and promote what proved itself in several projects.
  maintain({ workspace, crossProject = false, projects }: MaintainOptions = {}): MaintainReport {
    const now = this.clock(), key = this.key(workspace)
    const allowed = projects ? new Set<string | undefined>(projects.map(project => this.key(project))) : null
    const report: MaintainReport = { expired: 0, merged: 0, evicted: 0, shared: 0 }
    const work = new Map<string, Skill>(this.entries.map((entry): [string, Skill] => [entry.id, entry]))
    const touched = new Set<string>(), gone = new Set<string>(), created: Skill[] = []
    const drop = (entry: Skill, counter: keyof MaintainReport): void => { gone.add(entry.id); work.delete(entry.id); report[counter]++ }
    const edit: Editor = (entry, patch) => { work.set(entry.id, { ...work.get(entry.id)!, ...patch }); touched.add(entry.id) }
    const live = (): Skill[] => [...work.values()].filter(entry => this.indexable(entry) && (crossProject || entry.scope === 'global' || (!!key && entry.workspace === key)))
    const age = (entry: Skill): number => (now - Date.parse(entry.lastUsed || entry.updatedAt)) / DAY

    for (const entry of live()) {
      if (isProtected(entry)) continue
      if ((!(entry.uses > 0) && age(entry) > 180) || ((entry.failures || 0) >= 3 && reliability(entry) < 0.25)) drop(entry, 'expired')
    }
    const groups = new Map<string, Skill[]>()
    for (const entry of live()) { const id = groupKey(entry); if (!groups.has(id)) groups.set(id, []); groups.get(id)!.push(entry) }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = work.get(group[i].id), b = work.get(group[j].id)
        if (!a || !b || hasPackage(a) || hasPackage(b) || (isProtected(a) && isProtected(b)) || !this.near(a, b, MERGE_NAME, DUPLICATE_TEXT)) continue
        const keeper = isProtected(a) !== isProtected(b) ? (isProtected(a) ? a : b) : this.value(a) >= this.value(b) ? a : b
        const other = keeper === a ? b : a
        edit(keeper, {
          uses: (keeper.uses || 0) + (other.uses || 0), successes: (keeper.successes || 0) + (other.successes || 0), failures: (keeper.failures || 0) + (other.failures || 0),
          lessons: [...new Set([...keeper.lessons, ...other.lessons])].slice(0, LESSONS), pinned: keeper.pinned || other.pinned,
        })
        drop(other, 'merged')
      }
    }
    for (const group of groups.values()) {
      const list = group.filter(entry => work.has(entry.id))
      if (!list.length || list.length <= LIMITS[list[0].scope]) continue
      const victims = list.filter(entry => !isProtected(entry)).map(entry => ({ entry, value: this.value(work.get(entry.id)!) })).sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt)))
      for (const { entry } of victims.slice(0, list.length - LIMITS[list[0].scope])) drop(entry, 'evicted')
    }
    if (crossProject) this.share(live(), edit, created, report, allowed)
    if (touched.size || gone.size || created.length) {
      const next = [...created, ...this.entries.filter(entry => !gone.has(entry.id)).map(entry => work.get(entry.id) || entry)]
      this.commit(next, [...touched].filter(id => work.has(id)).map(id => work.get(id)!).concat(created), [...gone])
    }
    return report
  }

  // The same procedure, word for word, in several projects, used at least once and tied to none of them, is shared. "Similar"
  // is not enough: one different tool name (npm / pnpm) makes it another procedure. Pitfalls travel only when they name no project.
  share(entries: Skill[], edit: Editor, created: Skill[], report: MaintainReport, allowed: ReadonlySet<string | undefined> | null): void {
    const buckets = new Map<string, Skill[]>()
    for (const entry of entries) {
      if (entry.scope !== 'project' || entry.dupOf || isProtected(entry) || (allowed && !allowed.has(entry.workspace))) continue
      const title = [...this.print(entry).title].sort().join(' ')
      if (!title) continue
      if (!buckets.has(title)) buckets.set(title, [])
      buckets.get(title)!.push(entry)
    }
    const shared = entries.filter(entry => entry.scope === 'global')
    for (const bucket of buckets.values()) {
      if (new Set(bucket.map(entry => entry.workspace)).size < 2 || !bucket.some(entry => entry.uses > 0)) continue
      const seed = bucket.map(entry => ({ entry, value: this.value(entry) })).sort((a, b) => b.value - a.value)[0].entry
      const same = (entry: Skill): string => signature(`${entry.name} ${entry.description} ${entry.whenToUse} ${entry.instructions}`)
      const words = same(seed)
      const family = bucket.filter(entry => entry === seed || same(entry) === words)
      if (new Set(family.map(entry => entry.workspace)).size < 2) continue
      if (family.some(entry => projectReferences(`${entry.name}\n${entry.description}\n${entry.whenToUse}\n${entry.instructions}`, entry.workspace).length)) continue
      let target = shared.find(entry => same(entry) === words)
      if (!target) {
        const now = new Date(this.clock()).toISOString()
        target = {
          id: randomUUID(), name: seed.name, description: seed.description, whenToUse: seed.whenToUse, instructions: seed.instructions, scope: 'global', source: 'promoted',
          version: 1, updatedAt: now, revisions: [], created: now, lastUsed: now, uses: family.reduce((sum, entry) => sum + (entry.uses || 0), 0),
          successes: family.reduce((sum, entry) => sum + (entry.successes || 0), 0), failures: family.reduce((sum, entry) => sum + (entry.failures || 0), 0),
          lessons: [...new Set(family.flatMap(entry => entry.lessons.filter(lesson => !/<(?:project|file|repo)>/.test(lesson) && !projectReferences(lesson, entry.workspace).length)))].slice(0, LESSONS), usedIn: [], pinned: false, enabled: true, files: [], params: [], triggers: [], commands: [],
        }
        created.push(target); shared.push(target); report.shared++
      }
      for (const entry of family) edit(entry, { dupOf: target.id })
    }
  }
}

const TIER: Record<SkillScope, string> = { global: 'all projects', project: 'this project' }
// The prompt block for `suggest()`: enough for an agent to recognise a fitting skill and load it, nothing more.
function renderSkills({ skills = [], total = 0 }: { skills?: SkillSummary[]; total?: number } = {}, budget = 1800): string {
  if (!total) return ''
  const lines: string[] = []
  let used = 0
  for (const skill of skills) {
    const record = skill.uses ? `, used ${skill.uses}×, worked ${Math.round(skill.reliability * 100)}%` : ', untried'
    const commands = skill.commands?.length ? ` [commands: ${oneLine(skill.commands.map(command => command.name).join(', '), 100)}]` : ''
    const line = `- ${shortId(skill.id)} [${TIER[skill.scope] || skill.scope}${record}] ${oneLine(skill.name, 70)}${commands} — ${oneLine(skill.description, 170)}${skill.whenToUse ? ` Use when: ${oneLine(skill.whenToUse, 130)}` : ''}${skill.lessons?.length ? ` Pitfall: ${oneLine(skill.lessons[0], 110)}` : ''}`
    if (lines.length && used + line.length > budget) break
    lines.push(line); used += line.length + 1
  }
  return `${lines.join('\n')}${total > lines.length ? `\n(${total - lines.length} more skills stored: capability_search finds them)` : ''}`
}

export { CapabilityStore, renderSkills, reliability, shortId, hasPackage, LIMITS }
export type { Skill, SkillInput, SkillSummary, SkillSuggestion, SkillScope, SkillOutcome, SkillRevision, SaveResult as SkillSaveResult, MaintainReport as SkillMaintainReport, MaintainOptions as SkillMaintainOptions }
