const fs = require('fs')
let p = 'electron/tool-registry.mts'
let s = fs.readFileSync(p, 'utf8')
function rep(a, b) { if (s.split(a).length !== 2) throw new Error('count ' + (s.split(a).length - 1) + ': ' + a.slice(0, 70)); s = s.replace(a, () => b) }

rep(`const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): ObjectSchema => ({ type: 'object', properties, required, additionalProperties: false })
`, `const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): ObjectSchema => ({ type: 'object', properties, required, additionalProperties: false })
// A property of a nested object that may be left out: listed as required with a null option, which is how a strict
// output schema (the envelope) spells optional. The checks below accept it missing or null.
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] })
`)

rep(`  { name: 'capability_search', signature: '{query,limit?}',
    blurb: '',
    description: 'Ranked search of the reusable skills (procedures) you can reach.',`, `  { name: 'capability_search', signature: '{query,limit?}',
    blurb: '',
    description: 'Ranked search of the skills you can reach (procedures, and packages with pages or commands); each shows its kinds.',`)
rep(`    description: 'List the reusable skills (procedures) you can reach.',`, `    description: 'List the skills you can reach (procedures, and packages with pages or commands); each shows its kinds.',`)
rep(`    blurb: 'full instructions of one skill.',
    description: 'Full instructions of one skill. When you are done using it, report the outcome with capability_feedback.',`, `    blurb: 'full instructions of one skill, and for a package its folder (package.dir), files, parameters with their current values, triggers and commands.',
    description: 'Full instructions of one skill, and for a package its folder (package.dir), files, parameters with their current values, triggers and commands. A skill the user switched off is refused. When you are done using it, report the outcome with capability_feedback.',`)

rep(`  { name: 'capability_install', signature: '{name,description,whenToUse?,instructions,id?,scope?,source?}',
    blurb: 'save a self-contained procedure (prerequisites, exact steps or commands, how to verify, pitfalls); scope global when it does not depend on this project; improve an existing skill by passing its id rather than adding a near-copy. Verify helper scripts before saving a skill.',
    properties: { name: string, instructions: string, description: string, whenToUse: string, id: string, scope: enumeration('project', 'global'), source: string }, required: ['name', 'instructions', 'description'], mutating: true },`,
`  { name: 'capability_install', signature: '{name?,description?,whenToUse?,instructions?,id?,scope?,source?,files?:[{path,content}],removeFiles?,fromDir?,params?:[{key,label,type,default,hint?}],triggers?:[{on,show}],commands?:[{name,run,description?}]}',
    blurb: 'save a skill: any add-on that helps later, not only a procedure. name and instructions are required unless fromDir or id is given. A plain skill is a self-contained procedure (prerequisites, exact steps or commands, how to verify, pitfalls); scope global when it does not depend on this project; improve an existing skill by passing its id rather than adding a near-copy. A package also carries files (pages, scripts, assets; at most 40, 512 KB each, 4 MB in all): files writes text files, removeFiles deletes some, fromDir is an absolute folder inside the project or the temp folder whose files replace the package, and its skill.json may hold name, description, whenToUse, instructions, scope, params, triggers and commands. params are values the user sets in the skills panel (type text|url|number|seconds|boolean; a page reads them from its address); triggers [{on:"task-completed",show:"page.html"}] make Orbit show that page full screen when a task completes; commands [{name,run,description?}] are what agents run in the package folder. Omitted package fields keep what the skill has, [] clears. Build a package in a folder and install it with fromDir; verify scripts before saving a skill.',
    properties: {
      name: string, instructions: string, description: string, whenToUse: string, id: string, scope: enumeration('project', 'global'), source: string,
      files: { type: 'array', items: object({ path: string, content: string }) }, removeFiles: strings, fromDir: string,
      params: { type: 'array', items: object({ key: string, label: string, type: enumeration('text', 'url', 'number', 'seconds', 'boolean'), default: { anyOf: [string, number, boolean] }, hint: nullable(string) }) },
      triggers: { type: 'array', items: object({ on: enumeration('task-completed'), show: string }) },
      commands: { type: 'array', items: object({ name: string, run: string, description: nullable(string) }) },
    }, required: [], mutating: true },`)

rep(`    for (const key of schema.required || []) if ((value as Record<string, unknown>)[key] === undefined || (value as Record<string, unknown>)[key] === null) return \`\${label}.\${key} is required\``,
`    for (const key of schema.required || []) {
      const missing = (value as Record<string, unknown>)[key] === undefined || (value as Record<string, unknown>)[key] === null
      if (missing && !schema.properties?.[key]?.anyOf?.some(option => option.type === 'null')) return \`\${label}.\${key} is required\`
    }`)

rep(`  capability_install: args => blank(args.name) || blank(args.instructions) ? 'Capability name and instructions are required' : null,`,
`  // A skill folder's skill.json can supply them, and an existing skill (id) keeps its own: the store decides those cases.
  capability_install: args => !args.fromDir && !args.id && (blank(args.name) || blank(args.instructions)) ? 'Capability name and instructions are required' : null,`)

fs.writeFileSync(p, s)
