const fs = require('fs')
const p = 'electron/capabilities.mts'
let s = fs.readFileSync(p, 'utf8')
function rep(a, b) { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 60)); if (s.split(a).length !== 2) throw new Error('not unique: ' + a.slice(0, 60)); s = s.replace(a, () => b) }

rep(`import { oneLine } from './text.mts'
import type { SkillAction } from './types.mts'
`, `import { oneLine } from './text.mts'
import { skillPackageDir, skillPackageId } from './skill-files.mts'
import { applyPackage, checkCommands, checkParams, checkSourceDir, checkTriggers, checkValues, planPackage, readFolder, removePackage, reviveCommands, reviveFiles, reviveParams, reviveTriggers } from './skill-packages.mts'
import type { SkillCommand, SkillFile, SkillPackage, SkillParam, SkillTrigger } from './types.mts'
`)
rep(`// Skills: what agents learned to do and can do again. A skill is a versioned, self-contained procedure. Beyond the
// text it carries`, `// Skills: what agents built or learned to do and can do again. A skill is a versioned add-on of any form: a procedure, or a
// package (pages, scripts, assets in its own folder, electron/skill-packages.mts) with parameters, triggers and commands.
// Beyond the text it carries`)
rep(`  // Agents see only enabled skills. \`action\` is derived from the instructions (\`parseSkillAction\`), never taken from input.
  enabled: boolean; action?: SkillAction
`, `  // Agents see only enabled skills. The package's files live in skillPackageDir(userData, id); the lists here are its current
  // state (revisions keep the text only). Params hold the user's values next to the defaults.
  enabled: boolean; files: SkillFile[]; params: SkillParam[]; triggers: SkillTrigger[]; commands: SkillCommand[]
`)
rep(`interface SkillInput { id?: unknown; scope?: unknown; workspace?: unknown; name?: unknown; description?: unknown; whenToUse?: unknown; instructions?: unknown; source?: unknown }
// A skill as lists and search results show it: without the instructions and revisions, with its reliability.
interface SkillSummary extends Omit<Skill, 'instructions' | 'revisions'> { reliability: number }`, `interface SkillInput {
  id?: unknown; scope?: unknown; workspace?: unknown; name?: unknown; description?: unknown; whenToUse?: unknown; instructions?: unknown; source?: unknown
  files?: unknown; removeFiles?: unknown; fromDir?: unknown; params?: unknown; triggers?: unknown; commands?: unknown
}
// A skill as lists and search results show it: without the instructions and revisions, with its reliability and, when it has files, where they are.
interface SkillSummary extends Omit<Skill, 'instructions' | 'revisions'> { reliability: number; package?: SkillPackage }`)
rep(`// An action skill is app behaviour the user asked for, so it is protected like a pinned or user-written one.
const isProtected = (entry: Skill): boolean => entry.pinned === true || authored(entry) || entry.action !== undefined`, `// A package is something the user may rely on (a page Orbit shows, commands agents run), so it is protected like a pinned or
// user-written skill: never expired, evicted or merged.
const hasPackage = (entry: Pick<Skill, 'files' | 'triggers' | 'commands'>): boolean => entry.files.length > 0 || entry.triggers.length > 0 || entry.commands.length > 0
const isProtected = (entry: Skill): boolean => entry.pinned === true || authored(entry) || hasPackage(entry)`)

rep(`  declare file: string
  declare clock`, `  declare file: string
  declare userData: string
  declare clock`)
rep(`    this.file = path.join(userDataPath, 'capabilities.json')
`, `    this.file = path.join(userDataPath, 'capabilities.json')
    this.userData = userDataPath
`)
rep(`    // The action always comes from the instructions; a block that no longer parses is dropped, loading never throws.
    let action: SkillAction | null = null
    try { action = parseSkillAction(entry.instructions as string) } catch { /* An invalid block is plain text. */ }
`, '')
rep(`      enabled: entry.enabled !== false,
    } as Skill
    if (action) revived.action = action
    else delete revived.action
    return revived`, `      enabled: entry.enabled !== false, files: reviveFiles(entry.files), params: reviveParams(entry.params),
      triggers: reviveTriggers(entry.triggers), commands: reviveCommands(entry.commands),
    } as Skill
    return revived`)
rep(`    const { instructions, revisions, ...rest } = entry
    return { ...clone(rest), reliability: Math.round(reliability(entry) * 100) / 100 }
  }`, `    const { instructions, revisions, ...rest } = entry
    return { ...clone(rest), ...this.packageOf(entry), reliability: Math.round(reliability(entry) * 100) / 100 }
  }
  packageOf(entry: Skill): { package?: SkillPackage } {
    return entry.files.length ? { package: { id: skillPackageId(entry.id), dir: skillPackageDir(this.userData, entry.id) } } : {}
  }`)
rep(`  // Disabled skills are hidden from agents, and action skills are app behaviour, not procedures an agent could follow.`, `  // Disabled skills are hidden from agents, and a skill with a trigger and no commands is app behaviour (a page Orbit shows), not a procedure an agent could follow.`)
rep(`entry.enabled !== false && !entry.action))`, `entry.enabled !== false && !(entry.triggers.length && !entry.commands.length)))`)
rep(`    return clone(entry)
  }

  commit(next: Skill[], changed: Skill[] = [], removed: string[] = []): void {
    writeJSON(this.file, next)
    this.entries = next
    this.dirty = false
    for (const id of removed) { this.index.delete(id); this.prints.delete(id) }`, `    return { ...clone(entry), ...this.packageOf(entry) }
  }

  commit(next: Skill[], changed: Skill[] = [], removed: string[] = []): void {
    writeJSON(this.file, next)
    this.entries = next
    this.dirty = false
    for (const id of removed) { this.index.delete(id); this.prints.delete(id); removePackage(skillPackageDir(this.userData, id)) }`)
fs.writeFileSync(p, s)
