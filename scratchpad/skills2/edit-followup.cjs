const fs = require('fs')
function edit(p, pairs) {
  let s = fs.readFileSync(p, 'utf8')
  for (const [a, b] of pairs) { if (s.split(a).length !== 2) throw new Error(p + ' count ' + (s.split(a).length - 1) + ': ' + a.slice(0, 70)); s = s.replace(a, () => b) }
  fs.writeFileSync(p, s)
}
const OLD = 'Omitted package fields keep what the skill has, [] clears.'
const NEW = 'Omitted package fields keep what the skill has; params, triggers and commands given as [] are cleared, while files only adds or replaces the given files (use removeFiles or fromDir to drop others). Changing an existing package skill needs its id.'
edit('electron/tool-registry.mts', [[OLD, NEW]])
edit('tests/tool-registry.test.cjs', [[OLD, NEW]])

// 1. A case-only rename: delete first, so the file just written is never the one removed.
edit('electron/skill-packages.mts', [
  [`    for (const [rel, data] of plan.writes) { fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true }); fs.writeFileSync(fileOf(dir, rel), data) }
    for (const rel of plan.deletes) fs.rmSync(fileOf(dir, rel), { force: true })
    pruneEmpty(dir)`, `    // Deletes first: on a case-insensitive disk "Page.html" -> "page.html" is a delete and a write of the same file, and the write must win.
    for (const rel of plan.deletes) fs.rmSync(fileOf(dir, rel), { force: true })
    for (const [rel, data] of plan.writes) { fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true }); fs.writeFileSync(fileOf(dir, rel), data) }
    pruneEmpty(dir)`],
])

edit('electron/capabilities.mts', [
  [`    const id = existing?.id || (typeof input.id`, `    // An agent that names a package skill without its id could clear the page or commands of one the user relies on.
    if (guarded && existing && !input.id && hasPackage(existing)) throw new Error(\`A skill named "\${existing.name}" already is a package (files, a page or commands); to change it pass its id "\${existing.id}", or save yours under another name\`)
    const id = existing?.id || (typeof input.id`],
  [`    const now = new Date(this.clock()).toISOString()
    const kept: Partial<Skill> = { ...existing }`, `    const now = new Date(this.clock()).toISOString()
    const kept: Partial<Skill> = { ...existing }`],
  [`    // Leftovers of an earlier skill with this id must not become part of a new one.
    if (!existing && plan.writes.size) removePackage(dir)
    const undo = plan.writes.size || plan.deletes.length ? applyPackage(dir, plan) : (): void => {}
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
`, `    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
    // Protected skills (packages, pinned, the user's) are never evicted: a new skill that would still not fit is refused, not squeezed in.
    if (!existing && entries.filter(item => groupKey(item) === groupKey(entry)).length - evicted.length > LIMITS[scope]) {
      throw new Error(\`Skill limit: at most \${LIMITS[scope]} \${scope === 'global' ? 'shared' : 'project'} skills, and the rest are protected (packages, pinned or the user's); remove one or improve an existing skill by its id\`)
    }
    // Leftovers of an earlier skill with this id must not become part of a new one.
    if (!existing && plan.writes.size) removePackage(dir)
    const undo = plan.writes.size || plan.deletes.length ? applyPackage(dir, plan) : (): void => {}
`],
])
