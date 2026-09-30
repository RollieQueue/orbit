const fs = require('fs')
const p = 'electron/capabilities.mts'
let s = fs.readFileSync(p, 'utf8')
const a = s.indexOf("  // origin 'agent' is bounded")
const b = s.indexOf("  install(input: SkillInput")
const save = `  // origin 'agent' is bounded, and a skill that says what an existing one says improves that one instead of duplicating it.
  // Track-record fields are never taken from the input: they change only through use and feedback. Everything the input says is
  // validated (files included) before anything is written; a save that fails leaves the disk and the entry as they were.
  // Package fields left out keep what the skill has, an empty list clears; \`fromDir\` replaces the files and its skill.json fills
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
      const probe = fingerprint(name, \`\${input.whenToUse || ''} \${input.description || ''} \${instructions}\`)
      const twin = this.entries.find(item => !hasPackage(item) && groupKey(item) === groupKey({ scope, workspace }) && this.near(probe, item, MERGE_NAME, MERGE_TEXT))
      if (twin) { existing = twin; merged = true }
    }
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
    // Leftovers of an earlier skill with this id must not become part of a new one.
    if (!existing && plan.writes.size) removePackage(dir)
    const undo = plan.writes.size || plan.deletes.length ? applyPackage(dir, plan) : (): void => {}
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
    try { this.commit(evicted.length ? entries.filter(item => !evicted.includes(item.id)) : entries, [entry], evicted) } catch (error) { undo(); throw error }
    return { entry: { ...clone(entry), ...this.packageOf(entry) }, merged, ...(merged ? { improved: existing?.name } : {}), evicted: evicted.length }
  }
`
s = s.slice(0, a) + save + s.slice(b)
s = s.replace("import { applyPackage,", "import type { Manifest } from './skill-packages.mts'\nimport { applyPackage,")
fs.writeFileSync(p, s)
