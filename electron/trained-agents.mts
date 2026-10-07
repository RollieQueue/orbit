// Trained agents: a reusable specialist profile. It is a capability (electron/capabilities.mts) with an `agent` field, so it keeps
// the capability store's versions, scopes, scope guard, package folder, track record, switch and deletion; this module holds
// what is specific to it: the checks of the profile an agent_save call gives (role, defaults, a training round to append, the
// gallery of pictures in the package), the revival of a stored profile, and the text of the AGENTS block of a prompt.
// The playbook is the capability's `instructions`. Nothing here touches the store or the disk.
import { redact } from './storage.mts'
import { oneLine } from './text.mts'
import { packagePath } from './skill-files.mts'
import { IMAGE_FILE } from './skill-packages.mts'
import type { AgentGalleryItem, AgentKind, AgentProfile, AgentSummary, SkillFile, TrainingRound } from './types.mts'

const MAX_ROUNDS = 50, MAX_GALLERY = 24, MAX_CONCEPTS = 30, MAX_CRITERIA = 20, MAX_JUDGES = 10
const ROLE_CHARS = 200, CONCEPT_CHARS = 120, CRITERION_CHARS = 60, JUDGE_CHARS = 80, CAPTION_CHARS = 200, NOTES_CHARS = 1500, MAX_MINUTES = 100000
// The playbook an agent may hold; a skill's text stays at 12 000 (the user's own at 24 000).
const PLAYBOOK_CHARS = 40000
const KINDS: readonly string[] = ['code', 'review', 'lookup', 'text']
const EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled']
const STATUSES: readonly string[] = ['training', 'trained']

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => { throw new Error(message) }
const mark = (value: number): number => Math.round(value * 100) / 100
// A required-number check: finite and inside the range, else the error names the field.
function numberIn(value: unknown, what: string, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fail(`${what} must be a number from ${min} to ${max}`)
}
// A list of short texts: trimmed, empty ones dropped, each cut to `chars`; more than `max` of them is an error.
function textList(value: unknown, what: string, max: number, chars: number): string[] {
  if (!Array.isArray(value)) return fail(`${what} must be an array of text`)
  const items = value.map(item => typeof item === 'string' ? oneLine(redact(item).trim(), chars) : fail(`${what} must hold text only`)).filter(Boolean)
  return items.length > max ? fail(`${what}: at most ${max} entries`) : items
}
// The per-criterion marks, as the tool gives them ([{criterion, score}], the only shape a strict schema can describe) or as a map.
function criterionScores(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined
  const pairs: [unknown, unknown][] = Array.isArray(value)
    ? value.map((item, index) => isRecord(item) ? [item.criterion, item.score] : fail(`round.scores[${index}] must be {criterion, score}`))
    : isRecord(value) ? Object.entries(value) : fail('round.scores must be a list of {criterion, score}')
  if (pairs.length > MAX_CRITERIA) return fail(`round.scores: at most ${MAX_CRITERIA} criteria`)
  const scores: Record<string, number> = {}
  for (const [rawName, rawScore] of pairs) {
    const name = typeof rawName === 'string' ? oneLine(redact(rawName).trim(), CRITERION_CHARS) : ''
    if (!name) return fail('Every entry of round.scores needs a criterion name')
    if (Object.hasOwn(scores, name)) return fail(`round.scores names "${name}" twice`)
    scores[name] = mark(numberIn(rawScore, `round.scores "${name}"`, 0, 10))
  }
  return Object.keys(scores).length ? scores : undefined
}

// One training round as a call gives it. `number` is the round's number when the call names none, `now` its time. Notes longer
// than 1 500 characters are cut (the caller is told); everything else out of range is an error.
function checkRound(raw: unknown, number: number, now: string): { round: TrainingRound; cut: boolean } {
  if (!isRecord(raw)) return fail('round must be an object {score, concepts?, scores?, judges?, notes?, round?, at?}')
  const given = raw.round === undefined || raw.round === null ? number : numberIn(raw.round, 'round.round', 1, 9999)
  if (!Number.isInteger(given)) return fail('round.round must be a whole number')
  let at = now
  if (raw.at !== undefined && raw.at !== null && raw.at !== '') {
    const time = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN
    if (!Number.isFinite(time)) return fail('round.at must be an ISO 8601 time')
    at = new Date(time).toISOString()
  }
  const notes = typeof raw.notes === 'string' ? redact(raw.notes).trim() : ''
  const scores = criterionScores(raw.scores)
  const judges = raw.judges === undefined || raw.judges === null ? [] : textList(raw.judges, 'round.judges', MAX_JUDGES, JUDGE_CHARS)
  const round: TrainingRound = {
    at, round: given, concepts: raw.concepts === undefined || raw.concepts === null ? [] : textList(raw.concepts, 'round.concepts', MAX_CONCEPTS, CONCEPT_CHARS),
    score: mark(numberIn(raw.score, 'round.score', 0, 10)),
    ...(scores ? { scores } : {}), ...(judges.length ? { judges } : {}), ...(notes ? { notes: notes.slice(0, NOTES_CHARS) } : {}),
  }
  return { round, cut: notes.length > NOTES_CHARS }
}

// The gallery a call gives replaces the old one; every picture must be a png/jpg/jpeg/webp file the package will hold.
function checkGallery(value: unknown, files: readonly SkillFile[]): AgentGalleryItem[] {
  if (!Array.isArray(value)) return fail('gallery must be an array of {file, caption?}')
  if (value.length > MAX_GALLERY) return fail(`gallery: at most ${MAX_GALLERY} pictures`)
  const seen = new Set<string>()
  return value.map((raw, index): AgentGalleryItem => {
    const file = isRecord(raw) ? packagePath(raw.file) : null
    if (!file) return fail(`gallery[${index}].file must be a package file path (letters, digits, . _ - and / only)`)
    if (!IMAGE_FILE.test(file)) return fail(`gallery "${file}" is not a picture: png, jpg, jpeg or webp`)
    if (!files.some(item => item.path === file)) return fail(`gallery "${file}" is not a file of this agent's package (add it with fromDir or files first)`)
    if (seen.has(file)) return fail(`gallery lists "${file}" twice`)
    seen.add(file)
    const caption = typeof (raw as Record<string, unknown>).caption === 'string' ? oneLine(redact((raw as Record<string, string>).caption).trim(), CAPTION_CHARS) : ''
    return { file, ...(caption ? { caption } : {}) }
  })
}

// What a call changes about an agent, checked against the package files the save leaves. `existing` is the stored profile (a
// new agent has none). A round is appended (its number follows the last one), the gallery is replaced, the other fields keep
// their value unless given; a gallery picture whose file the save removed is dropped and named in `dropped`.
interface Checked { agent: AgentProfile; notes: string[] }
function checkAgent(input: Record<string, unknown>, existing: AgentProfile | undefined, files: readonly SkillFile[], now: string, fallbackRole = ''): Checked {
  const notes: string[] = []
  const roleGiven = typeof input.role === 'string' ? redact(input.role).replace(/\s+/g, ' ').trim() : ''
  const role = roleGiven || existing?.role || redact(fallbackRole).replace(/\s+/g, ' ').trim()
  if (!role) return fail('A trained agent needs a role: one line saying what it is the specialist for')
  if (role.length > ROLE_CHARS) notes.push(`The role was cut to ${ROLE_CHARS} characters: keep it one line`)
  const choice = (key: 'kind' | 'reasoningEffort', allowed: readonly string[], current: string | undefined): string | undefined => {
    const value = input[key]
    if (value === undefined || value === null) return current
    if (value === '') return undefined
    return typeof value === 'string' && allowed.includes(value) ? value : fail(`${key} must be one of ${allowed.join(', ')} (or empty to clear it)`)
  }
  const status = input.status === undefined || input.status === null ? existing?.status ?? 'training' : STATUSES.includes(input.status as string) ? input.status as AgentProfile['status'] : fail(`status must be ${STATUSES.join(' or ')}`)
  const rounds = [...(existing?.rounds ?? [])]
  if (input.round !== undefined && input.round !== null) {
    const next = rounds.reduce((top, item) => Math.max(top, item.round), 0) + 1
    const { round, cut } = checkRound(input.round, next, now)
    if (rounds.some(item => item.round === round.round)) return fail(`Training round ${round.round} already exists: omit round.round to append the next one`)
    if (rounds.length >= MAX_ROUNDS) return fail(`A trained agent keeps at most ${MAX_ROUNDS} training rounds`)
    rounds.push(round)
    if (cut) notes.push(`The round's notes were cut to ${NOTES_CHARS} characters`)
  }
  let gallery = existing?.gallery ?? []
  if (input.gallery !== undefined && input.gallery !== null) gallery = checkGallery(input.gallery, files)
  else {
    const kept = gallery.filter(item => files.some(file => file.path === item.file))
    if (kept.length < gallery.length) notes.push(`Dropped from the gallery, their files are gone: ${gallery.filter(item => !kept.includes(item)).map(item => item.file).join(', ')}`)
    gallery = kept
  }
  const minutes = input.trainingMinutes === undefined || input.trainingMinutes === null ? existing?.trainingMinutes : mark(numberIn(input.trainingMinutes, 'trainingMinutes', 0, MAX_MINUTES))
  const kind = choice('kind', KINDS, existing?.kind), reasoningEffort = choice('reasoningEffort', EFFORTS, existing?.reasoningEffort)
  return {
    agent: {
      role: role.slice(0, ROLE_CHARS), ...(kind ? { kind: kind as AgentKind } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), status,
      rounds, gallery, ...(minutes !== undefined ? { trainingMinutes: minutes } : {}),
    },
    notes,
  }
}

// A stored profile, without throwing: whatever no longer fits is dropped (a bad round, a gallery path that is not a picture).
function reviveAgent(stored: unknown): AgentProfile | undefined {
  if (!isRecord(stored)) return undefined
  const rounds: TrainingRound[] = []
  if (Array.isArray(stored.rounds)) for (const raw of stored.rounds.slice(0, MAX_ROUNDS)) {
    try { rounds.push(checkRound(raw, rounds.length + 1, new Date(0).toISOString()).round) } catch { /* Not a round. */ }
  }
  const gallery: AgentGalleryItem[] = []
  if (Array.isArray(stored.gallery)) for (const raw of stored.gallery.slice(0, MAX_GALLERY)) {
    const file = isRecord(raw) ? packagePath(raw.file) : null
    if (!file || !IMAGE_FILE.test(file) || gallery.some(item => item.file === file)) continue
    const caption = typeof (raw as Record<string, unknown>).caption === 'string' ? (raw as Record<string, string>).caption.slice(0, CAPTION_CHARS) : ''
    gallery.push({ file, ...(caption ? { caption } : {}) })
  }
  const minutes = typeof stored.trainingMinutes === 'number' && Number.isFinite(stored.trainingMinutes) && stored.trainingMinutes >= 0 ? stored.trainingMinutes : undefined
  return {
    role: typeof stored.role === 'string' ? stored.role.slice(0, ROLE_CHARS) : '',
    ...(typeof stored.kind === 'string' && KINDS.includes(stored.kind) ? { kind: stored.kind as AgentKind } : {}),
    ...(typeof stored.reasoningEffort === 'string' && EFFORTS.includes(stored.reasoningEffort) ? { reasoningEffort: stored.reasoningEffort } : {}),
    status: STATUSES.includes(stored.status as string) ? stored.status as AgentProfile['status'] : 'training', rounds, gallery, ...(minutes !== undefined ? { trainingMinutes: minutes } : {}),
  }
}

// The newest round's score (the highest round number), or undefined for an agent that was never judged.
const lastScore = (agent: AgentProfile): number | undefined => agent.rounds.length ? agent.rounds.reduce((top, item) => item.round >= top.round ? item : top).score : undefined
// What retrieval indexes besides the playbook: what the training covered.
const trainedConcepts = (agent: AgentProfile): string => agent.rounds.flatMap(round => round.concepts).join(' ')

const short = (id: string): string => id.length <= 14 ? id : id.slice(0, 12)
const TIER: Record<string, string> = { global: 'all projects', project: 'this project' }
// The AGENTS block of a prompt: enough to recognise a fitting specialist and spawn it, nothing more.
function renderAgents({ agents, total }: { agents: readonly AgentSummary[]; total: number }, budget = 1200): string {
  if (!total) return ''
  const lines: string[] = []
  let used = 0
  for (const item of agents) {
    const score = item.lastScore === undefined ? 'not judged' : `last score ${item.lastScore}/10`
    const line = `- ${short(item.id)} [${TIER[item.scope] || item.scope}, ${item.status}, ${score}] ${oneLine(item.name, 60)} — ${oneLine(item.role, 140)}`
    if (lines.length && used + line.length > budget) break
    lines.push(line); used += line.length + 1
  }
  return `${lines.join('\n')}${total > lines.length ? `\n(${total - lines.length} more agents stored: agent_read lists them)` : ''}`
}

export { MAX_ROUNDS, MAX_GALLERY, PLAYBOOK_CHARS, KINDS, EFFORTS, checkAgent, checkRound, checkGallery, reviveAgent, lastScore, trainedConcepts, renderAgents }
