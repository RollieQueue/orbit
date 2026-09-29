'use strict'
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { readJSON, writeJSON, keyCache, redact, clone } = require('./storage.cjs')
const { TextIndex, uniqueTerms, similarity, signature } = require('./text-index.cjs')
const { projectReferences, scrub } = require('./scope-guard.cjs')

// Skills: what agents learned to do and can do again. A skill is a versioned, self-contained procedure. Beyond the
// text it carries what makes the library improve by use instead of just growing: how often it was used, whether
// it worked, and the pitfalls agents ran into. Retrieval ranks by relevance and track record; the library is
// capped per scope and what nobody uses, or what keeps failing, is pruned.
const DAY = 86400000
const LIMITS = { project: 60, global: 100 }
const AGENT_INSTRUCTION_CHARS = 12000, USER_INSTRUCTION_CHARS = 24000
const REVISIONS = 10, LESSONS = 8, PROJECTS_SEEN = 20
// A skill an agent saves that says (nearly) what an existing one says improves it. The bar is high: "Release Node package"
// and "Release Python package" share most of their words and are different procedures.
const MERGE_NAME = 0.66, MERGE_TEXT = 0.7, DUPLICATE_TEXT = 0.85
const OUTCOMES = { worked: [1, 0], partial: [0.5, 0.5], failed: [0, 1] }
const FLUSH_DELAY_MS = 2500
const shortId = id => id.length <= 14 ? id : id.slice(0, 12)
const groupKey = entry => `${entry.scope}|${entry.workspace || ''}`
const authored = entry => entry.source === 'user'
const isProtected = entry => entry.pinned === true || authored(entry)
const reliability = entry => ((entry.successes || 0) + 1) / ((entry.successes || 0) + (entry.failures || 0) + 2)
const fingerprint = (name, text) => ({ text: uniqueTerms(`${name} ${text}`), title: uniqueTerms(name) })
const oneLine = (text, limit) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value }

class CapabilityStore {
  constructor(userDataPath, { clock = Date.now } = {}) {
    this.file = path.join(userDataPath, 'capabilities.json')
    this.clock = clock
    this.key = keyCache()
    this.index = new TextIndex()
    this.prints = new Map()
    this.dirty = false
    this.timer = null
    const data = readJSON(this.file, [])
    this.entries = Array.isArray(data) ? data.filter(entry => entry && typeof entry.instructions === 'string').map(entry => this.revive(entry)) : []
    for (const entry of this.entries) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  revive(entry) {
    const stamp = typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(this.clock()).toISOString()
    return {
      ...entry, id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
      ...(entry.workspace ? { workspace: this.key(entry.workspace) } : {}),
      description: entry.description || '', whenToUse: entry.whenToUse || '', updatedAt: stamp, created: entry.created || stamp, lastUsed: entry.lastUsed || stamp,
      uses: entry.uses || 0, successes: entry.successes || 0, failures: entry.failures || 0,
      lessons: Array.isArray(entry.lessons) ? entry.lessons : [], usedIn: Array.isArray(entry.usedIn) ? entry.usedIn : [], pinned: entry.pinned === true,
    }
  }
  indexable(entry) { return entry.scope === 'global' || (entry.scope === 'project' && !!entry.workspace) }
  fields(entry) { return [[entry.name, 3], [entry.whenToUse, 2], [entry.description, 2], [entry.instructions, 1]] }

  // `includeGlobal` false is a project that switched shared memory off: it neither sees nor touches the shared library.
  visible(workspace, includeGlobal = true) {
    const key = this.key(workspace)
    return this.entries.filter(entry => (includeGlobal && entry.scope === 'global') || (key && entry.scope === 'project' && entry.workspace === key))
  }
  // A project copy of a skill that was promoted to the shared library is shown once, from the shared library.
  distinct(workspace, includeGlobal = true) {
    const shared = new Set(this.entries.filter(entry => entry.scope === 'global').map(entry => entry.id))
    return this.visible(workspace, includeGlobal).filter(entry => !(entry.dupOf && includeGlobal && shared.has(entry.dupOf)))
  }

  print(entry) {
    const cached = this.prints.get(entry.id)
    if (cached?.stamp === entry.updatedAt) return cached
    const print = { stamp: entry.updatedAt, ...fingerprint(entry.name, `${entry.whenToUse} ${entry.description} ${entry.instructions}`) }
    this.prints.set(entry.id, print)
    return print
  }
  near(left, right, name, text) {
    const a = left.text ? left : this.print(left), b = right.text ? right : this.print(right)
    return similarity(a.title, b.title) >= name && similarity(a.text, b.text) >= text
  }

  value(entry) {
    if (isProtected(entry)) return 2
    const age = Math.max(0, (this.clock() - Date.parse(entry.lastUsed || entry.updatedAt)) / DAY) || 0
    return 0.1 + 0.35 * reliability(entry) + 0.3 * 0.5 ** (age / 180) + 0.25 * Math.min(1, Math.log1p(entry.uses || 0) / Math.log1p(10))
  }

  present(entry) {
    const { instructions, revisions, ...rest } = entry
    return { ...clone(rest), reliability: Math.round(reliability(entry) * 100) / 100 }
  }

  list(workspace, includeGlobal = true) { return this.visible(workspace, includeGlobal).map(entry => this.present(entry)) }

  // Ranked by relevance first, then by track record: a skill that worked beats an untried one that reads the same.
  rank(query, candidates) {
    const found = this.index.search(query, new Set(candidates.map(entry => entry.id)))
    const top = Math.max(0, ...[...found.values()].map(hit => hit.score))
    return candidates.map(entry => {
      const hit = found.get(entry.id)
      const relevance = hit && top ? hit.score / top : 0
      return { entry, relevance, matched: hit?.matched || 0, score: relevance * 0.7 + reliability(entry) * 0.15 + Math.min(1, this.value(entry)) * 0.15 }
    })
  }
  search(query, workspace, limit = 8, includeGlobal = true) {
    const empty = !uniqueTerms(query).size
    return this.rank(query, this.distinct(workspace, includeGlobal)).filter(item => empty || item.matched > 0).sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map(item => this.present(item.entry))
  }
  // For a prompt: the skills that match the task, then a few proven ones so the agent knows the library has more.
  suggest(query, workspace, limit = 6, includeGlobal = true) {
    const ranked = this.rank(query, this.distinct(workspace, includeGlobal))
    const relevant = ranked.filter(item => item.matched >= 1).sort((a, b) => b.score - a.score).slice(0, limit)
    const proven = ranked.filter(item => item.matched < 1 && item.entry.uses > 0 && reliability(item.entry) >= 0.5).sort((a, b) => this.value(b.entry) - this.value(a.entry)).slice(0, Math.min(3, limit - relevant.length))
    return { skills: [...relevant, ...proven].map(item => ({ ...this.present(item.entry), relevant: item.matched >= 1 })), total: ranked.length }
  }

  find(id, workspace, includeGlobal = true) {
    const visible = this.visible(workspace, includeGlobal)
    const exact = visible.find(entry => entry.id === id)
    if (exact) return exact
    const wanted = String(id || '')
    const prefixed = wanted.length >= 6 ? visible.filter(entry => entry.id.startsWith(wanted)) : []
    return prefixed.length === 1 ? prefixed[0] : null
  }
  read(id, workspace, includeGlobal = true) {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    return clone(entry)
  }

  commit(next, changed = [], removed = []) {
    writeJSON(this.file, next)
    this.entries = next
    this.dirty = false
    for (const id of removed) { this.index.delete(id); this.prints.delete(id) }
    for (const entry of changed) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  overflow(entries, keep) {
    const group = entries.filter(entry => groupKey(entry) === groupKey(keep))
    if (group.length <= LIMITS[keep.scope]) return []
    return group.filter(entry => entry !== keep && !isProtected(entry)).map(entry => ({ entry, value: this.value(entry) }))
      .sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt))).slice(0, group.length - LIMITS[keep.scope]).map(item => item.entry.id)
  }

  // origin 'agent' is bounded, and a skill that says what an existing one says improves that one instead of duplicating it.
  // Track-record fields are never taken from the input: they change only through use and feedback.
  save(input, { origin = 'user' } = {}) {
    if (!input || typeof input !== 'object') throw new Error('Capability is required')
    const scope = input.scope === 'global' ? 'global' : 'project'
    const workspace = scope === 'project' ? this.key(input.workspace) : ''
    if (scope === 'project' && !workspace) throw new Error('Project capability requires a workspace')
    const guarded = origin === 'agent'
    const name = redact(input.name || input.id).trim().slice(0, 120)
    const instructions = redact(input.instructions).trim().slice(0, guarded ? AGENT_INSTRUCTION_CHARS : USER_INSTRUCTION_CHARS)
    if (!name || !instructions) throw new Error('Capability name and instructions are required')
    let existing = input.id ? this.entries.find(entry => entry.id === input.id) : this.visible(workspace).find(entry => entry.name === name && entry.scope === scope)
    if (existing && (existing.scope !== scope || (existing.workspace || '') !== workspace)) {
      throw new Error('Cannot replace a capability from another project or scope')
    }
    // An agent cannot claim to be the user, the harness or the promotion pass.
    const claimed = redact(input.source || 'agent').slice(0, 300)
    const source = guarded && /^(user|system|promoted)$/i.test(claimed.trim()) ? 'agent' : claimed
    let merged = false
    if (!existing && guarded) {
      const probe = fingerprint(name, `${input.whenToUse || ''} ${input.description || ''} ${instructions}`)
      const twin = this.entries.find(item => groupKey(item) === groupKey({ scope, workspace }) && this.near(probe, item, MERGE_NAME, MERGE_TEXT))
      if (twin) { existing = twin; merged = true }
    }
    const now = new Date(this.clock()).toISOString()
    const kept = { ...existing }
    delete kept.dupOf
    const entry = {
      ...kept,
      id: existing?.id || (typeof input.id === 'string' && input.id.trim() ? input.id.slice(0, 120) : randomUUID()), name,
      description: redact(input.description ?? existing?.description ?? '').slice(0, 600),
      whenToUse: redact(input.whenToUse ?? existing?.whenToUse ?? '').slice(0, 300), instructions,
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
    }
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
    this.commit(evicted.length ? entries.filter(item => !evicted.includes(item.id)) : entries, [entry], evicted)
    return { entry: clone(entry), merged, ...(merged ? { improved: existing.name } : {}), evicted: evicted.length }
  }
  install(input, options) { return this.save(input, options).entry }

  // The agent used the skill: counted, and remembered per project (as a hash, so no path is stored) for shared skills.
  recordUse(id, workspace, includeGlobal = true) {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) return null
    entry.uses = (entry.uses || 0) + 1
    entry.lastUsed = new Date(this.clock()).toISOString()
    const seen = createHash('sha1').update(this.key(workspace)).digest('hex').slice(0, 8)
    if (entry.scope === 'global' && !entry.usedIn.includes(seen)) entry.usedIn = [...entry.usedIn, seen].slice(-PROJECTS_SEEN)
    this.schedule()
    return entry.id
  }
  schedule() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, FLUSH_DELAY_MS)
    this.timer.unref?.()
  }
  flush() {
    clearTimeout(this.timer); this.timer = null
    if (!this.dirty) return
    try { writeJSON(this.file, this.entries); this.dirty = false } catch { /* Retried with the next change; a counter never breaks a run. */ }
  }

  // Did it work? A failure or a partial result keeps its pitfall with the skill for the next agent.
  feedback(id, workspace, { outcome, note, includeGlobal = true } = {}) {
    const entry = this.find(id, workspace, includeGlobal)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    if (!OUTCOMES[outcome]) throw new Error('Outcome must be worked, partial or failed')
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

  pin(id, pinned, workspace) {
    const entry = this.find(id, workspace)
    if (!entry) throw new Error('Capability was not found in this project or shared library')
    const next = { ...entry, pinned: pinned === true }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return this.present(next)
  }

  remove(id, workspace) {
    const entry = this.visible(workspace).find(item => item.id === id)
    if (!entry) return false
    this.commit(this.entries.filter(item => item !== entry), [], [entry.id])
    return true
  }

  restore(id, version, workspace) {
    const entry = this.read(id, workspace)
    const revision = entry.revisions.find(item => item.version === version)
    if (!revision) throw new Error('Capability revision was not found')
    return this.install({ ...entry, ...revision, id: entry.id })
  }

  stats(workspace) {
    const visible = this.visible(workspace)
    const scope = name => { const items = visible.filter(entry => entry.scope === name); return { count: items.length, limit: LIMITS[name] } }
    return { project: scope('project'), global: scope('global'), used: visible.filter(entry => entry.uses > 0).length }
  }

  // Prune what is not earning its place, keep the caps, and promote what proved itself in several projects.
  maintain({ workspace, crossProject = false, projects } = {}) {
    const now = this.clock(), key = this.key(workspace)
    const allowed = projects ? new Set(projects.map(project => this.key(project))) : null
    const report = { expired: 0, merged: 0, evicted: 0, shared: 0 }
    const work = new Map(this.entries.map(entry => [entry.id, entry]))
    const touched = new Set(), gone = new Set(), created = []
    const drop = (entry, counter) => { gone.add(entry.id); work.delete(entry.id); report[counter]++ }
    const edit = (entry, patch) => { work.set(entry.id, { ...work.get(entry.id), ...patch }); touched.add(entry.id) }
    const live = () => [...work.values()].filter(entry => this.indexable(entry) && (crossProject || entry.scope === 'global' || (!!key && entry.workspace === key)))
    const age = entry => (now - Date.parse(entry.lastUsed || entry.updatedAt)) / DAY

    for (const entry of live()) {
      if (isProtected(entry)) continue
      if ((!(entry.uses > 0) && age(entry) > 180) || ((entry.failures || 0) >= 3 && reliability(entry) < 0.25)) drop(entry, 'expired')
    }
    const groups = new Map()
    for (const entry of live()) { const id = groupKey(entry); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(entry) }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = work.get(group[i].id), b = work.get(group[j].id)
        if (!a || !b || (isProtected(a) && isProtected(b)) || !this.near(a, b, MERGE_NAME, DUPLICATE_TEXT)) continue
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
      const victims = list.filter(entry => !isProtected(entry)).map(entry => ({ entry, value: this.value(work.get(entry.id)) })).sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt)))
      for (const { entry } of victims.slice(0, list.length - LIMITS[list[0].scope])) drop(entry, 'evicted')
    }
    if (crossProject) this.share(live(), edit, created, report, allowed)
    if (touched.size || gone.size || created.length) {
      const next = [...created, ...this.entries.filter(entry => !gone.has(entry.id)).map(entry => work.get(entry.id) || entry)]
      this.commit(next, [...touched].filter(id => work.has(id)).map(id => work.get(id)).concat(created), [...gone])
    }
    return report
  }

  // The same procedure, word for word, in several projects, used at least once and tied to none of them, is shared. "Similar"
  // is not enough: one different tool name (npm / pnpm) makes it another procedure. Pitfalls travel only when they name no project.
  share(entries, edit, created, report, allowed) {
    const buckets = new Map()
    for (const entry of entries) {
      if (entry.scope !== 'project' || entry.dupOf || isProtected(entry) || (allowed && !allowed.has(entry.workspace))) continue
      const title = [...this.print(entry).title].sort().join(' ')
      if (!title) continue
      if (!buckets.has(title)) buckets.set(title, [])
      buckets.get(title).push(entry)
    }
    const shared = entries.filter(entry => entry.scope === 'global')
    for (const bucket of buckets.values()) {
      if (new Set(bucket.map(entry => entry.workspace)).size < 2 || !bucket.some(entry => entry.uses > 0)) continue
      const seed = bucket.map(entry => ({ entry, value: this.value(entry) })).sort((a, b) => b.value - a.value)[0].entry
      const same = entry => signature(`${entry.name} ${entry.description} ${entry.whenToUse} ${entry.instructions}`)
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
          lessons: [...new Set(family.flatMap(entry => entry.lessons.filter(lesson => !/<(?:project|file|repo)>/.test(lesson) && !projectReferences(lesson, entry.workspace).length)))].slice(0, LESSONS), usedIn: [], pinned: false,
        }
        created.push(target); shared.push(target); report.shared++
      }
      for (const entry of family) edit(entry, { dupOf: target.id })
    }
  }
}

const TIER = { global: 'all projects', project: 'this project' }
// The prompt block for `suggest()`: enough for an agent to recognise a fitting skill and load it, nothing more.
function renderSkills({ skills = [], total = 0 } = {}, budget = 1800) {
  if (!total) return ''
  const lines = []
  let used = 0
  for (const skill of skills) {
    const record = skill.uses ? `, used ${skill.uses}×, worked ${Math.round(skill.reliability * 100)}%` : ', untried'
    const line = `- ${shortId(skill.id)} [${TIER[skill.scope] || skill.scope}${record}] ${oneLine(skill.name, 70)} — ${oneLine(skill.description, 170)}${skill.whenToUse ? ` Use when: ${oneLine(skill.whenToUse, 130)}` : ''}${skill.lessons?.length ? ` Pitfall: ${oneLine(skill.lessons[0], 110)}` : ''}`
    if (lines.length && used + line.length > budget) break
    lines.push(line); used += line.length + 1
  }
  return `${lines.join('\n')}${total > lines.length ? `\n(${total - lines.length} more skills stored: capability_search finds them)` : ''}`
}

module.exports = { CapabilityStore, renderSkills, reliability, shortId, LIMITS }
