// What a skill package is made of and how it reaches the disk: the checks for its files, parameters, triggers and
// commands (the same for the user's panel and for an agent), reading a folder to install, and writing the files of one
// skill into <userData>/skills/<package id>. electron/capabilities.mts decides WHEN; nothing here touches the entries.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packagePath } from './skill-files.mts'
import type { SkillCommand, SkillFile, SkillParam, SkillParamType, SkillParamValue, SkillTrigger } from './types.mts'

const MAX_FILES = 40, MAX_FILE_BYTES = 512 * 1024, MAX_PACKAGE_BYTES = 4 * 1024 * 1024
const MAX_PARAMS = 20, MAX_TRIGGERS = 5, MAX_COMMANDS = 20
const PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/, COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/
const PARAM_TYPES: readonly string[] = ['text', 'url', 'number', 'seconds', 'boolean']
const MANIFEST = 'skill.json'
// The manifest of an Agent Skills folder (the format of github.com/anthropics/skills, Claude Code and Codex).
const SKILL_MD = 'SKILL.md'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => { throw new Error(message) }
function entries(value: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(value)) return fail(`${what} must be an array`)
  return value.length > max ? fail(`${what}: at most ${max} entries`) : value
}
// Optional text of a nested object: absent, null (the envelope's spelling of absent) and empty all mean "none".
function optionalText(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return fail(`${what} must be text`)
  return value.length > max ? fail(`${what} is longer than ${max} characters`) : value
}

// Seconds as a number, `42`, `42s`, `m:ss` or `h:mm:ss`.
function seconds(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim(), plain = /^(\d{1,7}(?:\.\d+)?)s?$/i.exec(text), clock = /^(?:(\d{1,4}):)?(\d{1,4}):([0-5]\d)$/.exec(text)
  if (plain) return Number(plain[1])
  return clock ? (clock[1] === undefined ? 0 : Number(clock[1]) * 3600) + Number(clock[2]) * 60 + Number(clock[3]) : null
}
// A value as its parameter's type stores it; `what` names the parameter in the error.
function paramValue(type: SkillParamType, raw: unknown, what: string): SkillParamValue {
  const bad = (why: string): never => fail(`Parameter ${what}: ${why}`)
  if (type === 'boolean') return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : bad('must be true or false')
  if (type === 'number') {
    const number = typeof raw === 'string' && raw.trim() ? Number(raw) : raw
    return typeof number === 'number' && Number.isFinite(number) ? number : bad('must be a number')
  }
  if (type === 'seconds') { const value = seconds(raw); return value ?? bad('must be seconds (42, 42s) or m:ss / h:mm:ss') }
  if (typeof raw !== 'string') return bad('must be text')
  if (type === 'text') return raw.length <= 500 ? raw : bad('is longer than 500 characters')
  const link = raw.trim()
  let url: URL | null = null
  try { url = new URL(link) } catch { /* Reported below. */ }
  return url && (url.protocol === 'http:' || url.protocol === 'https:') && link.length <= 2000 ? link : bad('must be an http(s) link of at most 2000 characters')
}

// The parameters a save gives. A parameter that keeps its key and type keeps the value the user chose.
function checkParams(input: unknown, previous: readonly SkillParam[] = []): SkillParam[] {
  const seen = new Set<string>()
  return entries(input, 'params', MAX_PARAMS).map((raw, index) => {
    if (!isRecord(raw)) return fail(`params[${index}] must be an object`)
    const key = typeof raw.key === 'string' ? raw.key : ''
    if (!PARAM_KEY.test(key)) return fail(`params[${index}].key must be lowercase letters, digits and _ (start with a letter, at most 32)`)
    if (seen.has(key)) return fail(`Parameter "${key}" is given twice`)
    seen.add(key)
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (!label || label.length > 80) return fail(`Parameter "${key}" needs a label of at most 80 characters`)
    const type = PARAM_TYPES.includes(raw.type as string) ? raw.type as SkillParamType : fail(`Parameter "${key}" type must be one of ${PARAM_TYPES.join(', ')}`)
    const fallback = paramValue(type, raw.default, `"${key}" default`)
    const hint = optionalText(raw.hint, `Parameter "${key}" hint`, 300)
    const before = previous.find(item => item.key === key && item.type === type)
    return { key, label, type, default: fallback, value: before ? before.value : fallback, ...(hint ? { hint } : {}) }
  })
}
// What the file on disk says, without throwing: a parameter that no longer fits is dropped, a value that does not fit resets.
function reviveParams(stored: unknown): SkillParam[] {
  if (!Array.isArray(stored)) return []
  const found: SkillParam[] = []
  for (const raw of stored.slice(0, MAX_PARAMS)) {
    try {
      const [param] = checkParams([raw]), value = isRecord(raw) ? raw.value : undefined
      let kept = param.default
      try { kept = paramValue(param.type, value, param.key) } catch { /* The default stands. */ }
      if (!found.some(item => item.key === param.key)) found.push({ ...param, value: kept })
    } catch { /* Not a parameter. */ }
  }
  return found
}
// `setParams`: the new values of existing parameters, all checked before any is used.
function checkValues(params: readonly SkillParam[], values: unknown): SkillParam[] {
  if (!isRecord(values)) return fail('Parameter values must be an object {key: value}')
  for (const key of Object.keys(values)) if (!params.some(param => param.key === key)) fail(`This skill has no parameter "${key}"`)
  return params.map(param => Object.hasOwn(values, param.key) ? { ...param, value: paramValue(param.type, values[param.key], `"${param.key}"`) } : param)
}

// A trigger shows one html page of the package; `has` says whether the package has the file.
const TRIGGER_EVENTS: readonly SkillTrigger['on'][] = ['task-completed', 'quota-panel']
function checkTriggers(input: unknown, has: (file: string) => boolean): SkillTrigger[] {
  const found = new Map<string, SkillTrigger>()
  entries(input, 'triggers', MAX_TRIGGERS).forEach((raw, index) => {
    const on = isRecord(raw) ? TRIGGER_EVENTS.find(event => event === raw.on) : undefined
    if (!isRecord(raw) || !on) return fail(`triggers[${index}].on must be "task-completed" or "quota-panel"`)
    const show = packagePath(raw.show)
    if (!show || !/\.html?$/i.test(show)) return fail(`triggers[${index}].show must be an .html page of the package (letters, digits, . _ - and / only)`)
    if (!has(show)) return fail(`Trigger page "${show}" is not a file of this package`)
    found.set(`${on}|${show}`, { on, show })
  })
  return [...found.values()]
}
function checkCommands(input: unknown): SkillCommand[] {
  const seen = new Set<string>()
  return entries(input, 'commands', MAX_COMMANDS).map((raw, index) => {
    if (!isRecord(raw)) return fail(`commands[${index}] must be an object`)
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (!COMMAND_NAME.test(name)) return fail(`commands[${index}].name must be lowercase letters, digits and - (start with a letter, at most 40)`)
    if (seen.has(name)) return fail(`Command "${name}" is given twice`)
    seen.add(name)
    const run = typeof raw.run === 'string' ? raw.run.trim() : ''
    if (!run || run.length > 1000) return fail(`Command "${name}" needs a run line of at most 1000 characters`)
    const description = optionalText(raw.description, `Command "${name}" description`, 300)
    return { name, run, ...(description ? { description } : {}) }
  })
}
function reviveFiles(stored: unknown): SkillFile[] {
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is SkillFile => isRecord(item) && typeof item.size === 'number' && packagePath(item.path) === item.path)
}
function reviveTriggers(stored: unknown): SkillTrigger[] { try { return checkTriggers(stored, () => true) } catch { return [] } }
function reviveCommands(stored: unknown): SkillCommand[] {
  if (!Array.isArray(stored)) return []
  const found = new Map<string, SkillCommand>()
  for (const raw of stored.slice(0, MAX_COMMANDS)) try { const [command] = checkCommands([raw]); if (!found.has(command.name)) found.set(command.name, command) } catch { /* Not a command. */ }
  return [...found.values()]
}

// ---- files ----------------------------------------------------------------------------------------------------------
// A folder to install from. An agent may only read from the project folder or the temp folder (it could not open
// anything else with its own tools in a restricted mode); the user's own choice is unrestricted.
function checkSourceDir(dir: string, workspace: unknown, guarded: boolean): string {
  if (!path.isAbsolute(dir)) return fail('fromDir must be an absolute folder path')
  const target = path.resolve(dir)
  const roots = [os.tmpdir(), typeof workspace === 'string' ? workspace : ''].filter(Boolean).map(root => path.resolve(root))
  const inside = (root: string): boolean => { const relative = path.relative(root, target); return !relative.startsWith('..') && !path.isAbsolute(relative) }
  return !guarded || roots.some(inside) ? target : fail('fromDir must be inside the project folder or the temp folder')
}
interface Manifest { name?: string; description?: string; whenToUse?: string; instructions?: string; scope?: string; params?: unknown; triggers?: unknown; commands?: unknown }
interface Source { files: Map<string, Buffer>; manifest: Manifest | null }
// The files of a folder, recursively; dot files and folders, node_modules and links are skipped. Every file is counted
// and measured, so that one error names all the files over the limit (a skill folder from the ecosystem often carries big
// samples), but contents are read only while the package stays within the limits.
function readFolder(dir: string): Source {
  let stat: fs.Stats | null = null
  try { stat = fs.statSync(dir) } catch { /* Reported below. */ }
  if (!stat?.isDirectory()) return fail(`fromDir is not a folder: ${dir}`)
  const files = new Map<string, Buffer>()
  let total = 0, count = 0
  const largeFiles: { path: string; size: number }[] = []
  const walk = (folder: string): void => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.isSymbolicLink()) continue
      const file = path.join(folder, item.name)
      if (item.isDirectory()) { walk(file); continue }
      if (!item.isFile()) continue
      const rel = packagePath(path.relative(dir, file))
      if (!rel) return fail(`Cannot install "${path.relative(dir, file)}": file names may use only letters, digits, . _ - and at most 8 folders deep`)
      // A folder far beyond the limits (a whole repository) is not walked to its end.
      if (++count > MAX_FILES * 25) return fail(`Skill package limit: at most ${MAX_FILES} files, and ${dir} holds more than ${MAX_FILES * 25}: is it the skill's own folder?`)
      const size = fs.statSync(file).size
      total += size
      if (size > MAX_FILE_BYTES) largeFiles.push({ path: rel, size })
      else if (!largeFiles.length && count <= MAX_FILES && total <= MAX_PACKAGE_BYTES) files.set(rel, fs.readFileSync(file))
    }
  }
  walk(dir)
  if (largeFiles.length) return fail(`Skill package limit: ${largeFiles.length} files are larger than ${MAX_FILE_BYTES / 1024} KB: ${largeFiles.map(item => `"${item.path}" (${Math.round(item.size / 1024)} KB)`).join(', ')}`)
  if (count > MAX_FILES) return fail(`Skill package limit: at most ${MAX_FILES} files (found ${count})`)
  if (total > MAX_PACKAGE_BYTES) return fail(`Skill package limit: at most ${MAX_PACKAGE_BYTES / 1024 / 1024} MB in total (found ${Math.round(total / 1024 / 1024 * 10) / 10} MB)`)
  const json = files.has(MANIFEST) ? parseManifest(files.get(MANIFEST)!.toString('utf8')) : null
  const markdown = files.has(SKILL_MD) ? parseMarkdownManifest(files.get(SKILL_MD)!.toString('utf8')) : null
  return { files, manifest: mergeManifests(json, markdown) }
}

// The manifest of an Agent Skills folder (github.com/anthropics/skills, Claude Code, Codex): name and description from
// the YAML frontmatter of SKILL.md (other keys, nested ones included, are skipped), the trigger sentence of the
// description as whenToUse, the markdown body as the instructions. Plain, quoted and block (| >) scalars, CRLF, a BOM and
// a closing --- at the end of the file are understood.
function parseMarkdownManifest(text: string): Manifest {
  const manifest: Manifest = {}
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  const lines = match ? match[1].split(/\r?\n/) : []
  for (let i = 0; i < lines.length; i++) {
    const entry = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(lines[i])
    if (!entry) continue
    // Indented and blank lines below a key continue its value: a block, a folded scalar, a nested mapping nobody reads.
    const more: string[] = []
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i])
    if (entry[1] === 'name' || entry[1] === 'description') manifest[entry[1]] = yamlScalar((entry[2] ?? '').trim(), more)
  }
  if (manifest.description) {
    const trigger = /(?:^|[.!?]\s+)((?:use|trigger) (?:this skill |it )?(?:when|for|if)\b[\s\S]*)$/i.exec(manifest.description)
    manifest.whenToUse = trigger ? trigger[1].trim() : manifest.description
  }
  manifest.instructions = `Note: relative paths are relative to the package folder (package.dir in capability_read) and scripts run from there.\n\n${(match ? match[2] : text).trim()}`
  return manifest
}
// Lines folded the YAML way: one line per paragraph, a blank line between paragraphs stays a line break.
const foldLines = (rows: string[]): string => rows.map(row => row.trim()).join('\n').split(/\n{2,}/).map(part => part.replace(/\n/g, ' ')).join('\n').trim()
// One YAML scalar from the text after its key and the lines continuing it: | keeps the lines, > and plain or quoted
// scalars fold them.
function yamlScalar(head: string, more: string[]): string {
  const block = /^([|>])[+-]?[0-9]?(?:[ \t]+#.*)?$/.exec(head)
  if (block) {
    const filled = more.filter(line => line.trim())
    const indent = filled.length ? Math.min(...filled.map(line => line.length - line.trimStart().length)) : 0
    const rows = more.map(line => line.slice(indent))
    return block[1] === '|' ? rows.join('\n').trim() : foldLines(rows)
  }
  const value = foldLines([/^["']/.test(head) ? head : head.replace(/[ \t]+#.*$/, ''), ...more])
  if (/^"[\s\S]*"$/.test(value)) return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\/])/g, '$1')
  if (/^'[\s\S]*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

// skill.json fields win, SKILL.md fills the ones it leaves out.
function mergeManifests(json: Manifest | null, markdown: Manifest | null): Manifest | null {
  if (!json || !markdown) return json || markdown
  return { ...markdown, ...Object.fromEntries(Object.entries(json).filter(([, value]) => value !== undefined)) }
}

// A folder's file as text, '' when it has none.
function readIfThere(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
// Only the manifest of a folder (skill.json and SKILL.md; null when it has neither), for a caller that has to know the
// skill's scope before the install.
function folderManifest(dir: string, workspace: unknown, guarded: boolean): Manifest | null {
  const folder = checkSourceDir(dir, workspace, guarded)
  const json = readIfThere(path.join(folder, MANIFEST)), markdown = readIfThere(path.join(folder, SKILL_MD))
  return mergeManifests(json ? parseManifest(json) : null, markdown ? parseMarkdownManifest(markdown) : null)
}
function parseManifest(text: string): Manifest {
  let data: unknown
  try { data = JSON.parse(text.replace(/^﻿/, '')) } catch { return fail(`${MANIFEST} is not valid JSON`) }
  if (!isRecord(data)) return fail(`${MANIFEST} must be a JSON object`)
  const manifest: Manifest = {}
  for (const key of ['name', 'description', 'whenToUse', 'instructions', 'scope'] as const) if (typeof data[key] === 'string') manifest[key] = data[key]
  for (const key of ['params', 'triggers', 'commands'] as const) if (data[key] !== undefined) manifest[key] = data[key]
  return manifest
}

interface PackagePlan { files: SkillFile[]; writes: Map<string, Buffer>; deletes: string[] }
// The files a save leaves in the package: the current ones, or only the folder's when one is given, plus the files the
// call writes, minus those it removes. Every limit is checked here, before anything is written.
function planPackage(current: readonly SkillFile[], { source, files, removeFiles }: { source?: Source | null; files?: unknown; removeFiles?: unknown }): PackagePlan {
  const writes = new Map<string, Buffer>()
  const final = new Map<string, number>(source ? [] : current.map((file): [string, number] => [file.path, file.size]))
  const put = (rel: string, data: Buffer): void => { writes.set(rel, data); final.set(rel, data.length) }
  for (const [rel, data] of source?.files ?? []) put(rel, data)
  if (files !== undefined) for (const [index, raw] of entries(files, 'files', Infinity).entries()) {
    const rel = isRecord(raw) ? packagePath(raw.path) : null
    if (!rel) return fail(`files[${index}].path must be a relative path with letters, digits, . _ - and / only (no "..", no hidden files)`)
    if (typeof (raw as Record<string, unknown>).content !== 'string') return fail(`files[${index}].content must be text`)
    put(rel, Buffer.from((raw as Record<string, string>).content, 'utf8'))
  }
  if (removeFiles !== undefined) for (const [index, raw] of entries(removeFiles, 'removeFiles', Infinity).entries()) {
    const rel = packagePath(raw)
    if (!rel) return fail(`removeFiles[${index}] is not a package file path`)
    final.delete(rel); writes.delete(rel)
  }
  const lower = new Set<string>()
  for (const rel of final.keys()) {
    const key = rel.toLowerCase()
    if (lower.has(key)) return fail(`Skill package: "${rel}" differs from another file only by letter case`)
    lower.add(key)
  }
  for (const rel of final.keys()) if ([...final.keys()].some(other => other.startsWith(`${rel}/`))) return fail(`Skill package: "${rel}" is both a file and a folder`)
  if (final.size > MAX_FILES) return fail(`Skill package limit: at most ${MAX_FILES} files`)
  for (const [rel, data] of writes) if (data.length > MAX_FILE_BYTES) return fail(`Skill package limit: "${rel}" is larger than ${MAX_FILE_BYTES / 1024} KB`)
  if ([...final.values()].reduce((sum, size) => sum + size, 0) > MAX_PACKAGE_BYTES) return fail(`Skill package limit: at most ${MAX_PACKAGE_BYTES / 1024 / 1024} MB in total`)
  return {
    files: [...final].map(([rel, size]) => ({ path: rel, size })).sort((a, b) => a.path.localeCompare(b.path)),
    writes, deletes: current.map(file => file.path).filter(rel => !final.has(rel)),
  }
}

const fileOf = (dir: string, rel: string): string => path.join(dir, ...rel.split('/'))
function pruneEmpty(folder: string): void {
  let names: string[] = []
  try { names = fs.readdirSync(folder) } catch { return }
  for (const name of names) { const child = path.join(folder, name); try { if (fs.statSync(child).isDirectory()) pruneEmpty(child) } catch { /* Gone already. */ } }
  try { fs.rmdirSync(folder) } catch { /* Not empty (or gone). */ }
}
// Writes the plan into the package folder. A failure puts every touched file back as it was and rethrows; on success the
// returned function does the same, for a caller whose own next step failed.
function applyPackage(dir: string, plan: PackagePlan): () => void {
  const before = new Map<string, Buffer | null>()
  const undo = (): void => {
    for (const [rel, data] of before) {
      try { if (data) { fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true }); fs.writeFileSync(fileOf(dir, rel), data) } else fs.rmSync(fileOf(dir, rel), { force: true }) } catch { /* Best effort. */ }
    }
    pruneEmpty(dir)
  }
  try {
    for (const rel of [...plan.writes.keys(), ...plan.deletes]) { let data: Buffer | null = null; try { data = fs.readFileSync(fileOf(dir, rel)) } catch { /* New file. */ } before.set(rel, data) }
    // Deletes first: on a case-insensitive disk "Page.html" -> "page.html" is a delete and a write of the same file, and the write must win.
    for (const rel of plan.deletes) fs.rmSync(fileOf(dir, rel), { force: true })
    for (const [rel, data] of plan.writes) { fs.mkdirSync(path.dirname(fileOf(dir, rel)), { recursive: true }); fs.writeFileSync(fileOf(dir, rel), data) }
    pruneEmpty(dir)
  } catch (error) { undo(); throw error }
  return undo
}
// The folder of a skill that is gone. A file another program holds open stays behind; it is never served without an entry.
function removePackage(dir: string): void { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Left behind. */ } }

export {
  MAX_FILES, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, checkParams, checkValues, checkTriggers, checkCommands, reviveParams, reviveFiles, reviveTriggers, reviveCommands,
  checkSourceDir, readFolder, folderManifest, parseManifest, planPackage, applyPackage, removePackage,
}
export type { Manifest, PackagePlan, Source as PackageSource }
