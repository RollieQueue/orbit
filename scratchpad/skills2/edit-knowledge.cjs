const fs = require('fs')
let p = 'electron/skill-packages.mts'
let s = fs.readFileSync(p, 'utf8')
function rep(a, b) { if (s.split(a).length !== 2) throw new Error('count ' + (s.split(a).length - 1) + ': ' + a.slice(0, 70)); s = s.replace(a, () => b) }
rep("function parseManifest(text: string): Manifest {", `// Only the skill.json of a folder (null when it has none), for a caller that has to know the skill's scope before the install.
function folderManifest(dir: string, workspace: unknown, guarded: boolean): Manifest | null {
  let text = ''
  try { text = fs.readFileSync(path.join(checkSourceDir(dir, workspace, guarded), MANIFEST), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseManifest(text)
}
function parseManifest(text: string): Manifest {`)
rep("readFolder, parseManifest, planPackage", "readFolder, folderManifest, parseManifest, planPackage")
fs.writeFileSync(p, s)

p = 'electron/runtime/knowledge.mts'
s = fs.readFileSync(p, 'utf8')
rep("import { reliability as skillReliability } from '../capabilities.mts'\n", "import { reliability as skillReliability } from '../capabilities.mts'\nimport { folderManifest } from '../skill-packages.mts'\n")
rep(`    // An action skill is something the app does on an event, not a procedure to follow: the agent is told so in the listing.
    const brief = ({ id, name, description, whenToUse, scope, uses, reliability, lessons, action }: SkillView) => ({ id, name, description, whenToUse, scope, uses, reliability, ...(action ? { action: \`\${action.on} → \${action.effect}\` } : {}), ...(lessons?.length ? { pitfalls: lessons.slice(0, 3) } : {}) })`,
`    // What a skill is made of, so the agent sees at once whether it is a procedure to follow, a page Orbit shows, or commands to run.
    const brief = ({ id, name, description, whenToUse, scope, uses, reliability, lessons, files, triggers, commands }: SkillView) => ({
      id, name, description, whenToUse, scope, uses, reliability, kinds: ['instructions', ...(triggers?.length ? ['page'] : []), ...(commands?.length ? ['commands'] : [])],
      ...(files?.length ? { files: files.length } : {}), ...(lessons?.length ? { pitfalls: lessons.slice(0, 3) } : {}),
    })
    // A skill the user switched off is invisible to agents: it is not found, read, rated or suggested.
    const switchedOff = (skill: Pick<SkillView, 'enabled'> | null | undefined): void => { if (skill && skill.enabled === false) throw new Error('This skill is switched off') }`)
rep(`      const skill = await store.read(String(args.id || ''), run.workspace, shared)
`, `      const skill = await store.read(String(args.id || ''), run.workspace, shared)
      switchedOff(skill)
`)
rep(`      return { id: skill.id, name: skill.name, description: skill.description, whenToUse: skill.whenToUse, scope: skill.scope, version: skill.version, uses: skill.uses, reliability: Math.round(skillReliability(skill) * 100) / 100,
        ...(skill.lessons?.length ? { pitfalls: skill.lessons } : {}), note: 'When you are done, report the outcome with capability_feedback', instructions: skill.instructions }`,
`      return { id: skill.id, name: skill.name, description: skill.description, whenToUse: skill.whenToUse, scope: skill.scope, version: skill.version, uses: skill.uses, reliability: Math.round(skillReliability(skill) * 100) / 100,
        ...(skill.lessons?.length ? { pitfalls: skill.lessons } : {}),
        ...(skill.package ? { package: skill.package, files: skill.files } : {}),
        ...(skill.params?.length ? { params: skill.params.map(({ key, label, type, value, default: initial, hint }) => ({ key, label, type, value, default: initial, ...(hint ? { hint } : {}) })) } : {}),
        ...(skill.triggers?.length ? { triggers: skill.triggers } : {}), ...(skill.commands?.length ? { commands: skill.commands } : {}),
        note: \`When you are done, report the outcome with capability_feedback\${skill.commands?.length ? '. Commands run in the package folder (package.dir)' : ''}\`, instructions: skill.instructions }`)
rep(`      const result = store.feedback(`, `      switchedOff(store.find(String(args.id || ''), run.workspace, shared))
      const result = store.feedback(`)
rep(`      if (!String(args.name || '').trim() || !String(args.instructions || '').trim()) throw new Error('Capability name and instructions are required')
      let scope: SkillScope = args.scope === 'global' ? 'global' : 'project', kept = ''
      if (scope === 'global') {
        // Sharing a skill is the agent's call, but a skill that only makes sense here stays here, and so does one from a project that opted out.
        const references = describeReferences(projectReferences([args.name, args.description, args.whenToUse, args.instructions].filter(Boolean).join('\\n'), run.workspace))`,
`      const known = args.id ? store.find(String(args.id), run.workspace, shared) : null
      // A package folder's skill.json supplies what the call leaves out, so the guard below reads the skill it would actually save.
      const manifest = args.fromDir ? folderManifest(String(args.fromDir), run.workspace, true) : null
      const field = (key: 'name' | 'description' | 'whenToUse' | 'instructions' | 'scope'): string | undefined => args[key] ?? manifest?.[key]
      if (!known && (!String(field('name') || '').trim() || !String(field('instructions') || '').trim())) throw new Error('Capability name and instructions are required (unless fromDir holds a skill.json with them, or id names a skill to change)')
      let scope: SkillScope = field('scope') === 'global' ? 'global' : 'project', kept = ''
      if (scope === 'global') {
        // Sharing a skill is the agent's call, but a skill that only makes sense here stays here, and so does one from a project that opted out.
        const references = describeReferences(projectReferences([field('name'), field('description'), field('whenToUse'), field('instructions')].filter(Boolean).join('\\n'), run.workspace))`)
rep(`      const known = args.id ? store.find(String(args.id), run.workspace, shared) : null
      // An agent is never the user`, `      // An agent is never the user`)
rep(`      const saved = store.save({ id: known?.id ?? args.id, name: bounded(args.name, 160), description: bounded(args.description, 1000), whenToUse: bounded(args.whenToUse, 400), instructions: bounded(args.instructions, 20000), scope, workspace: run.workspace, source: bounded(source || \`agent:\${agent.id}\`, 300) }, { origin: 'agent' })`,
`      // The package fields go to the store as they came: it validates them (limits, paths, types) and names what is wrong.
      const pack = args as Record<string, unknown>
      const text = (value: string | undefined, max: number): string | undefined => value === undefined ? undefined : bounded(value, max)
      const saved = store.save({
        id: known?.id ?? args.id, name: text(field('name'), 160)!, description: text(field('description'), 1000), whenToUse: text(field('whenToUse'), 400), instructions: text(field('instructions'), 20000)!,
        scope, workspace: run.workspace, source: bounded(source || \`agent:\${agent.id}\`, 300),
        files: pack.files as SkillSaveInput['files'], removeFiles: pack.removeFiles as string[] | undefined, fromDir: pack.fromDir as string | undefined,
        params: pack.params as unknown[] | undefined, triggers: pack.triggers as unknown[] | undefined, commands: pack.commands as unknown[] | undefined,
      }, { origin: 'agent' })`)
rep("if (String(args.instructions).trim().length > saved.entry.instructions.length)", "if (String(field('instructions') || '').trim().length > saved.entry.instructions.length)")
rep("SkillScope, SkillView, ToolArgs }", "SkillSaveInput, SkillScope, SkillView, ToolArgs }")
fs.writeFileSync(p, s)
