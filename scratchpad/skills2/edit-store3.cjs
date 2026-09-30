const fs = require('fs')
const p = 'electron/capabilities.mts'
let s = fs.readFileSync(p, 'utf8')
function rep(a, b) { if (s.split(a).length !== 2) throw new Error('count ' + (s.split(a).length - 1) + ': ' + a.slice(0, 70)); s = s.replace(a, () => b) }
rep("import type { Manifest } from './skill-packages.mts'\nimport { applyPackage,", "import { applyPackage,")
rep("reviveTriggers } from './skill-packages.mts'\n", "reviveTriggers } from './skill-packages.mts'\nimport type { Manifest } from './skill-packages.mts'\n")
rep("  read(id: unknown, workspace: string | null | undefined, includeGlobal = true): Skill {", "  read(id: unknown, workspace: string | null | undefined, includeGlobal = true): Skill & { package?: SkillPackage } {")
rep(`  restore(id: unknown, version: unknown, workspace: string | null | undefined): Skill {
    const entry = this.read(id, workspace)
    const revision = entry.revisions.find(item => item.version === version)
    if (!revision) throw new Error('Capability revision was not found')
    return this.install({ ...entry, ...revision, id: entry.id })
  }`, `  // The text comes back as a new version; the package (files, parameters, triggers, commands) is current state and stays.
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
  }`)
rep("if (!a || !b || a.action || b.action || (isProtected(a) && isProtected(b))", "if (!a || !b || hasPackage(a) || hasPackage(b) || (isProtected(a) && isProtected(b))")
rep("usedIn: [], pinned: false, enabled: true,\n", "usedIn: [], pinned: false, enabled: true, files: [], params: [], triggers: [], commands: [],\n")
rep("export { CapabilityStore, renderSkills, reliability, shortId, parseSkillAction, LIMITS }", "export { CapabilityStore, renderSkills, reliability, shortId, hasPackage, LIMITS }")
rep("export type { SkillAction, Skill,", "export type { Skill,")
rep("const line = `- ${shortId(skill.id)} [${TIER[skill.scope] || skill.scope}${record}] ${oneLine(skill.name, 70)} —", "const commands = skill.commands?.length ? ` [commands: ${oneLine(skill.commands.map(command => command.name).join(', '), 100)}]` : ''\n    const line = `- ${shortId(skill.id)} [${TIER[skill.scope] || skill.scope}${record}] ${oneLine(skill.name, 70)}${commands} —")
fs.writeFileSync(p, s)
