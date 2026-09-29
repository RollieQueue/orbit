'use strict'
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { readJSON, writeJSON, keyCache, redact, clone } = require('./storage.cjs')
const { TextIndex, uniqueTerms, similarity, signature } = require('./text-index.cjs')
const { projectReferences } = require('./scope-guard.cjs')

// These four fabricated entries were shipped by the old demo. They are not user memory.
const demoTitles = new Map([
  ['m1', 'Local-first by default'], ['m2', 'Agent-centric interface'],
  ['m3', 'Provider adapters stay replaceable'], ['m4', 'Every write needs verification'],
])

const DAY = 86400000
const TYPES = ['decision', 'pattern', 'preference', 'fact']
// Three tiers with different lifetimes. Nothing grows without bound: each tier has a size cap, and what goes
// unused loses value until the cap (or the age limit of the chat tier) removes it.
//   chat    working notes of one task thread; short-lived, small, promoted to the project when they prove durable
//   project verified knowledge about one codebase; kept between chats
//   global  what holds in every project (preferences, how-tos, model assessments); shared by the whole harness
const TIERS = {
  chat: { entries: 40, chars: 1500, halfLifeDays: 7, ttlDays: 30 },
  project: { entries: 250, chars: 4000, halfLifeDays: 120 },
  global: { entries: 200, chars: 4000, halfLifeDays: 365 },
}
const HARD_CHARS = 16000
// An agent's new note that says (nearly) what an existing one says updates it instead of piling up beside it.
const MERGE_TEXT = 0.65, MERGE_TITLE = 0.5, MAINTAIN_TEXT = 0.8
// Assessments of models are kept apart from notes: at most this many, the most useful ones.
const SYSTEM_CAP = 60
const SYSTEM_SHOWN = 6
const FLUSH_DELAY_MS = 2500
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const shortId = id => id.length <= 14 ? id : id.slice(0, 12)
const groupKey = entry => `${entry.scope}|${entry.workspace || ''}|${entry.chatId || ''}`
const fingerprint = (title, content) => ({ text: uniqueTerms(`${title} ${content}`), title: uniqueTerms(title) })
// The user's own and pinned notes are never evicted, merged away or touched by an agent. The harness's own records
// (model assessments) are also off limits to agents, but they are capped and can age out.
const isProtected = entry => entry.pinned === true || entry.source === 'user'
const isSystem = entry => entry.source === 'system'

class OrbitMemoryStore {
  constructor(userDataPath, { clock = Date.now } = {}) {
    this.file = path.join(userDataPath, 'memory.json')
    this.clock = clock
    this.key = keyCache()
    this.index = new TextIndex()
    this.prints = new Map()
    this.dirty = false
    this.timer = null
    const data = readJSON(this.file, [])
    // Unscoped legacy project records stay on disk, but are neither indexed nor visible: they never leak into another project.
    this.entries = (Array.isArray(data) ? data : []).filter(entry => entry && typeof entry === 'object')
      .filter(entry => demoTitles.get(entry.id) !== entry.title)
      .map(entry => this.revive(entry))
    for (const entry of this.entries) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  revive(entry) {
    const updated = typeof entry.updated === 'string' ? entry.updated : new Date(this.clock()).toISOString()
    const id = typeof entry.id === 'string' && entry.id ? entry.id : randomUUID()
    return {
      ...entry, id, title: redact(entry.title), content: redact(entry.content),
      ...(entry.workspace ? { workspace: this.key(entry.workspace) } : {}),
      type: TYPES.includes(entry.type) ? entry.type : 'fact',
      updated, created: entry.created || updated, lastUsed: entry.lastUsed || updated,
      uses: Number.isFinite(entry.uses) ? entry.uses : 0, pinned: entry.pinned === true,
      // Assessments of models were written by the harness itself. Older versions saved what the user typed in the UI with
      // confidence 100, which no agent could set, so those are the user's.
      source: entry.source || (id.startsWith('model-') ? 'system' : entry.confidence === 100 ? 'user' : 'legacy'),
    }
  }

  indexable(entry) {
    return (entry.scope === 'global') || ((entry.scope === 'project' || (entry.scope === 'chat' && entry.chatId)) && !!entry.workspace)
  }
  fields(entry) { return [[entry.title, 3], [entry.content, 1]] }

  // What a run in `workspace`/`chatId` may see. Chat notes need both the project and the chat; the shared tier is optional.
  scoped(workspace, chatId, includeGlobal = true) {
    const key = this.key(workspace)
    return this.entries.filter(entry => (includeGlobal && entry.scope === 'global') ||
      (!!key && entry.scope === 'project' && entry.workspace === key) ||
      (!!key && !!chatId && entry.scope === 'chat' && entry.workspace === key && entry.chatId === chatId))
  }

  // The vocabulary of an entry, cached while its text is unchanged. Text that is not stored yet is fingerprinted directly.
  print(entry) {
    const cached = this.prints.get(entry.id)
    if (cached?.stamp === entry.updated) return cached
    const print = { stamp: entry.updated, ...fingerprint(entry.title, entry.content) }
    this.prints.set(entry.id, print)
    return print
  }
  // The same subject in the same words: both the titles and the whole texts overlap.
  near(left, right, threshold) {
    const a = left.text ? left : this.print(left), b = right.text ? right : this.print(right)
    return similarity(a.title, b.title) >= MERGE_TITLE && similarity(a.text, b.text) >= threshold
  }

  // What an entry is worth keeping: how sure it was, how recently it was useful, how often it was used.
  // The user's own and pinned notes are never a candidate for removal.
  value(entry) {
    if (isProtected(entry)) return 2
    const tier = TIERS[entry.scope] || TIERS.project
    const age = Math.max(0, (this.clock() - Date.parse(entry.lastUsed || entry.updated)) / DAY) || 0
    const halfLife = tier.halfLifeDays * (entry.type === 'decision' || entry.type === 'preference' ? 2 : 1)
    const usage = Math.min(1, Math.log1p(entry.uses || 0) / Math.log1p(10))
    return 0.15 + 0.3 * (clamp(Number.isFinite(entry.confidence) ? entry.confidence : 80, 0, 100) / 100) + 0.3 * 0.5 ** (age / halfLife) + 0.25 * usage
  }

  // Relevance 0..1 (share of the best BM25 hit) with how many query terms matched, next to the intrinsic value.
  rank(query, candidates) {
    const found = this.index.search(query, new Set(candidates.map(entry => entry.id)))
    const top = Math.max(0, ...[...found.values()].map(hit => hit.score))
    return candidates.map(entry => {
      const hit = found.get(entry.id)
      return { entry, relevance: hit && top ? hit.score / top : 0, matched: hit?.matched || 0, value: this.value(entry) }
    })
  }

  list(workspace, includeGlobal = true, chatId) {
    return clone(this.scoped(workspace, chatId, includeGlobal))
  }

  search(query, workspace, limit = 6, includeGlobal = true, chatId) {
    const empty = !uniqueTerms(query).size
    return clone(this.rank(query, this.scoped(workspace, chatId, includeGlobal))
      .filter(item => empty || item.matched > 0)
      .sort((a, b) => (b.relevance * 0.75 + b.value * 0.25) - (a.relevance * 0.75 + a.value * 0.25) || String(b.entry.updated).localeCompare(String(a.entry.updated)))
      .slice(0, Math.max(1, Math.min(30, Number(limit) || 6)))
      .map(item => item.entry))
  }

  // Candidates for a prompt, per tier: pinned first, then what matches the task, then whatever is worth the most.
  // `relevant` marks a genuine match; only those count as a use, so unrelated fill-ins cannot keep themselves alive.
  recall({ query = '', workspace, chatId, includeGlobal = true, models = false } = {}) {
    const promoted = new Set(this.entries.filter(entry => entry.scope === 'global').map(entry => entry.id))
    const candidates = this.scoped(workspace, chatId, includeGlobal).filter(entry => !(entry.dupOf && includeGlobal && promoted.has(entry.dupOf)))
    const queryTerms = uniqueTerms(query).size
    const tiers = { chat: [], project: [], global: [] }
    // The orchestrator always sees the newest assessments of models; older ones only when they match.
    const newest = new Set(candidates.filter(isSystem).sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, SYSTEM_SHOWN).map(entry => entry.id))
    for (const item of this.rank(query, candidates)) {
      const relevant = item.matched >= 2 || (item.matched >= 1 && queryTerms <= 3)
      const assessment = isSystem(item.entry)
      if (assessment && !relevant && !(models && newest.has(item.entry.id))) continue
      tiers[item.entry.scope].push({ ...item, relevant, pinned: item.entry.pinned || (assessment && models && newest.has(item.entry.id)) })
    }
    const priority = item => item.pinned ? 0 : item.relevant ? 1 : 2
    const strength = item => item.relevance * 0.75 + item.value * 0.25
    const totals = {}
    for (const [tier, list] of Object.entries(tiers)) {
      totals[tier] = list.length
      list.sort((a, b) => priority(a) - priority(b) || (priority(a) === 2 ? b.value - a.value : strength(b) - strength(a)) || String(b.entry.updated).localeCompare(String(a.entry.updated)))
      // More than a prompt could ever list; the rest is reachable through memory_search.
      tiers[tier] = list.slice(0, 25).map(({ entry, relevant, pinned }) => ({ entry: clone(entry), relevant, pinned }))
    }
    return { tiers, totals }
  }

  // Marks entries as used. Persisted lazily: a counter must never cost a disk write per turn.
  touch(ids) {
    const wanted = new Set(ids)
    const stamp = new Date(this.clock()).toISOString()
    let changed = false
    for (const entry of this.entries) if (wanted.has(entry.id)) { entry.uses = (entry.uses || 0) + 1; entry.lastUsed = stamp; changed = true }
    if (changed) this.schedule()
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
    try { writeJSON(this.file, this.entries); this.dirty = false } catch { /* Retried with the next change; usage counters never break a run. */ }
  }

  // Disk first: a failed write leaves the visible state untouched.
  commit(next, changed = [], removed = []) {
    writeJSON(this.file, next)
    this.entries = next
    this.dirty = false
    for (const id of removed) { this.index.delete(id); this.prints.delete(id) }
    for (const entry of changed) if (this.indexable(entry)) this.index.set(entry.id, this.fields(entry))
  }

  // The ids that must go for `group` to fit its cap: the least valuable ones that are not protected, never `keep`.
  overflow(entries, keep) {
    const tier = TIERS[keep.scope], id = groupKey(keep)
    const group = entries.filter(entry => groupKey(entry) === id)
    const worst = list => list.filter(entry => entry !== keep && !isProtected(entry)).map(entry => ({ entry, value: this.value(entry) })).sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt))).map(item => item.entry.id)
    const gone = new Set()
    const systems = group.filter(isSystem)
    if (systems.length > SYSTEM_CAP) for (const id of worst(systems).slice(0, systems.length - SYSTEM_CAP)) gone.add(id)
    const rest = group.filter(entry => !gone.has(entry.id))
    if (rest.length > tier.entries) for (const id of worst(rest).slice(0, rest.length - tier.entries)) gone.add(id)
    return [...gone]
  }

  // origin: 'user' (the UI: exact, may pin, keeps full length), 'agent' (bounded, merges near duplicates, cannot touch
  // the user's notes) or 'system' (the harness itself, e.g. model assessments).
  save(input, { origin = 'user' } = {}) {
    if (!input || typeof input !== 'object') throw new Error('Memory entry is required')
    const scope = input.scope === 'global' ? 'global' : input.scope === 'chat' ? 'chat' : 'project'
    const workspace = scope === 'global' ? '' : this.key(input.workspace)
    const chatId = scope === 'chat' ? String(input.chatId || '').slice(0, 120) : ''
    if (scope === 'project' && !workspace) throw new Error('Project memory requires a workspace')
    if (scope === 'chat' && (!workspace || !chatId)) throw new Error('Chat memory requires a workspace and a chat')
    const guarded = origin === 'agent'
    const title = redact(input.title).trim().slice(0, 200)
    const content = redact(input.content).trim().slice(0, guarded ? TIERS[scope].chars : HARD_CHARS)
    if (!title || !content) throw new Error('Memory title and content are required')
    let existing = typeof input.id === 'string' ? this.entries.find(item => item.id === input.id) : undefined
    if (existing && (existing.scope !== scope || (existing.workspace || '') !== workspace || (existing.chatId || '') !== chatId)) {
      throw new Error('Memory belongs to a different scope or project')
    }
    if (existing && guarded && (isProtected(existing) || isSystem(existing))) throw new Error('This entry was written or pinned by the user, or is a harness record; save a new entry instead')
    let merged = false
    if (!existing && guarded) {
      const probe = fingerprint(title, content)
      const twin = this.entries.find(item => groupKey(item) === groupKey({ scope, workspace, chatId }) && this.near(probe, item, MERGE_TEXT))
      if (twin && (isProtected(twin) || isSystem(twin))) return { entry: clone(twin), merged: true, unchanged: true, evicted: 0 }
      if (twin) { existing = twin; merged = true }
    }
    const now = new Date(this.clock()).toISOString()
    const kept = { ...existing }
    delete kept.dupOf
    const entry = {
      ...kept,
      id: existing?.id || (typeof input.id === 'string' && input.id.trim() ? input.id.slice(0, 120) : randomUUID()), title, content, scope,
      ...(workspace ? { workspace } : {}), ...(chatId ? { chatId } : {}),
      type: TYPES.includes(input.type) ? input.type : existing?.type || 'fact',
      confidence: clamp(Number.isFinite(input.confidence) ? input.confidence : existing?.confidence ?? 80, 0, 100),
      created: existing?.created || now, updated: now, lastUsed: now, uses: (existing?.uses || 0) + (merged ? 1 : 0),
      pinned: origin === 'user' && input.pinned !== undefined ? input.pinned === true : existing?.pinned === true,
      source: origin === 'user' ? 'user' : origin === 'system' ? 'system' : existing?.source && existing.source !== 'legacy' ? existing.source : 'agent',
    }
    const entries = existing ? this.entries.map(item => item === existing ? entry : item) : [entry, ...this.entries]
    const evicted = this.overflow(entries, entry)
    this.commit(evicted.length ? entries.filter(item => !evicted.includes(item.id)) : entries, [entry], evicted)
    return { entry: clone(entry), merged, evicted: evicted.length }
  }
  upsert(entry, options) { return this.save(entry, options).entry }

  // An id, or an unambiguous prefix of one (prompts show short ids), among what this project/chat can see.
  find(id, workspace, chatId, includeGlobal = true) {
    const visible = this.scoped(workspace, chatId, includeGlobal)
    const exact = visible.find(entry => entry.id === id)
    if (exact) return exact
    const wanted = String(id || '')
    const prefixed = wanted.length >= 6 ? visible.filter(entry => entry.id.startsWith(wanted)) : []
    return prefixed.length === 1 ? prefixed[0] : null
  }

  remove(id, workspace, chatId, { origin = 'user', includeGlobal = true } = {}) {
    const entry = this.find(id, workspace, chatId, includeGlobal)
    if (!entry) return false
    if (origin === 'agent' && (isProtected(entry) || isSystem(entry))) throw new Error('This entry was written or pinned by the user, or is a harness record; only the user can remove it')
    this.commit(this.entries.filter(item => item !== entry), [], [entry.id])
    return true
  }

  pin(id, pinned, workspace, chatId) {
    const entry = this.find(id, workspace, chatId)
    if (!entry) throw new Error('Memory entry was not found in this project')
    const next = { ...entry, pinned: pinned === true }
    this.commit(this.entries.map(item => item === entry ? next : item), [next])
    return clone(next)
  }

  // A deleted chat takes its working notes with it; nothing is promoted on the user's way out.
  forgetChat(workspace, chatId) {
    const key = this.key(workspace)
    if (!key || !chatId) return 0
    const gone = this.entries.filter(entry => entry.scope === 'chat' && entry.workspace === key && entry.chatId === chatId)
    if (gone.length) this.commit(this.entries.filter(entry => !gone.includes(entry)), [], gone.map(entry => entry.id))
    return gone.length
  }

  stats(workspace, chatId) {
    const visible = this.scoped(workspace, chatId, true)
    const tier = name => { const items = visible.filter(entry => entry.scope === name); return { count: items.length, limit: TIERS[name].entries, pinned: items.filter(entry => entry.pinned).length, chars: items.reduce((sum, entry) => sum + entry.content.length, 0) } }
    return { chat: tier('chat'), project: tier('project'), global: tier('global'), stored: this.entries.length }
  }

  // Housekeeping without a model: expire, promote what proved durable, merge near duplicates, enforce the caps.
  // Runs for one project and the shared tier; `crossProject` also looks across projects for what several of them know.
  maintain({ workspace, chatId, crossProject = false, projects } = {}) {
    const now = this.clock(), key = this.key(workspace)
    // Only projects that allow sharing can contribute to the shared tier (a project that switched shared memory off never does).
    const allowed = projects ? new Set(projects.map(project => this.key(project))) : null
    const report = { expired: 0, merged: 0, evicted: 0, promoted: 0, shared: 0 }
    const work = new Map(this.entries.map(entry => [entry.id, entry]))
    const touched = new Set(), gone = new Set(), created = []
    const edit = (entry, patch) => { const next = { ...work.get(entry.id), ...patch }; work.set(entry.id, next); touched.add(entry.id); return next }
    const drop = (entry, counter) => { gone.add(entry.id); work.delete(entry.id); report[counter]++ }
    const inScope = entry => crossProject || entry.scope === 'global' || (!!key && entry.workspace === key)
    const age = entry => (now - Date.parse(entry.lastUsed || entry.updated)) / DAY
    const live = () => [...work.values()].filter(entry => this.indexable(entry) && inScope(entry))

    for (const entry of live()) {
      if (isProtected(entry) || isSystem(entry)) continue
      if (entry.scope === 'chat' && age(entry) > TIERS.chat.ttlDays) drop(entry, 'expired')
      else if (entry.scope !== 'chat' && !(entry.uses > 0) && (Number.isFinite(entry.confidence) ? entry.confidence : 80) < 40 && age(entry) > 120) drop(entry, 'expired')
    }

    // Chat notes the conversation kept coming back to are project knowledge now.
    if (key && chatId) {
      for (const entry of live().filter(item => item.scope === 'chat' && item.chatId === chatId && item.workspace === key)) {
        // What the user wrote or pinned stays where they put it.
        if (isProtected(entry)) continue
        const durable = ['decision', 'pattern', 'fact'].includes(entry.type) ? entry.uses >= 2 : entry.uses >= 3
        if (!durable || (Number.isFinite(entry.confidence) ? entry.confidence : 80) < 70) continue
        const twin = live().find(item => item.scope === 'project' && item.workspace === key && this.near(entry, item, MERGE_TEXT))
        if (twin) { drop(entry, 'merged'); continue }
        const { chatId: _chat, ...rest } = work.get(entry.id)
        work.set(entry.id, { ...rest, scope: 'project', promotedFrom: 'chat' }); touched.add(entry.id); report.promoted++
      }
    }

    const groups = new Map()
    for (const entry of live()) { const id = groupKey(entry); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(entry) }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const a = work.get(group[i].id), b = work.get(group[j].id)
        if (!a || !b || (isProtected(a) && isProtected(b)) || isSystem(a) || isSystem(b) || !this.near(a, b, MAINTAIN_TEXT)) continue
        const keeper = isProtected(a) !== isProtected(b) ? (isProtected(a) ? a : b) : this.value(a) >= this.value(b) ? a : b
        const other = keeper === a ? b : a
        const newer = !isProtected(keeper) && String(other.updated) > String(keeper.updated)
        edit(keeper, {
          uses: (keeper.uses || 0) + (other.uses || 0), confidence: Math.max(keeper.confidence ?? 0, other.confidence ?? 0),
          lastUsed: String(keeper.lastUsed) > String(other.lastUsed) ? keeper.lastUsed : other.lastUsed, pinned: keeper.pinned || other.pinned,
          ...(newer ? { title: other.title, content: other.content, updated: other.updated } : {}),
        })
        drop(other, 'merged')
      }
    }

    for (const group of groups.values()) {
      const list = group.filter(entry => work.has(entry.id)), scope = list[0]?.scope
      if (!scope) continue
      const victims = entries => entries.filter(entry => !isProtected(entry)).map(entry => ({ entry, value: this.value(work.get(entry.id)) })).sort((a, b) => a.value - b.value || String(a.entry.updated || a.entry.updatedAt).localeCompare(String(b.entry.updated || b.entry.updatedAt)))
      const systems = list.filter(isSystem)
      if (systems.length > SYSTEM_CAP) for (const { entry } of victims(systems).slice(0, systems.length - SYSTEM_CAP)) drop(entry, 'evicted')
      const rest = list.filter(entry => work.has(entry.id))
      if (rest.length > TIERS[scope].entries) for (const { entry } of victims(rest).slice(0, rest.length - TIERS[scope].entries)) drop(entry, 'evicted')
    }

    if (crossProject) this.share(live(), edit, created, report, allowed)

    if (touched.size || gone.size || created.length) {
      const next = [...created, ...this.entries.filter(entry => !gone.has(entry.id)).map(entry => work.get(entry.id) || entry)]
      this.commit(next, [...touched].filter(id => work.has(id)).map(id => work.get(id)).concat(created), [...gone])
    }
    return report
  }

  // The same note, word for word, in two or more projects is not about one project: it moves to the shared tier, once
  // nothing in it points at a particular workspace. "Similar" is not enough: one different number or tool name
  // ("port 3000" / "port 8080", npm / pnpm) makes two notes say different things. The project copies stay (a project
  // can switch shared memory off) but are hidden from prompts while the shared note is visible.
  share(entries, edit, created, report, allowed) {
    const buckets = new Map()
    for (const entry of entries) {
      if (entry.scope !== 'project' || entry.dupOf || isProtected(entry) || (allowed && !allowed.has(entry.workspace)) || !['pattern', 'fact', 'preference'].includes(entry.type)) continue
      const title = [...this.print(entry).title].sort().join(' ')
      if (!title) continue
      if (!buckets.has(title)) buckets.set(title, [])
      buckets.get(title).push(entry)
    }
    const shared = entries.filter(entry => entry.scope === 'global')
    for (const bucket of buckets.values()) {
      const projects = new Set(bucket.map(entry => entry.workspace))
      if (projects.size < 2) continue
      const seed = bucket.map(entry => ({ entry, value: this.value(entry) })).sort((a, b) => b.value - a.value)[0].entry
      const words = signature(`${seed.title} ${seed.content}`)
      const family = bucket.filter(entry => entry === seed || signature(`${entry.title} ${entry.content}`) === words)
      if (new Set(family.map(entry => entry.workspace)).size < 2) continue
      if (family.some(entry => projectReferences(`${entry.title}\n${entry.content}`, entry.workspace).length)) continue
      const twin = shared.find(entry => !isSystem(entry) && signature(`${entry.title} ${entry.content}`) === words)
      let target = twin
      if (!twin) {
        const now = new Date(this.clock()).toISOString()
        target = { id: randomUUID(), scope: 'global', title: seed.title, content: seed.content, type: seed.type, confidence: Math.max(...family.map(entry => entry.confidence ?? 80)),
          created: now, updated: now, lastUsed: now, uses: family.reduce((sum, entry) => sum + (entry.uses || 0), 0), pinned: false, source: 'promoted', seenIn: projects.size }
        created.push(target); shared.push(target); report.shared++
      }
      for (const entry of family) edit(entry, { dupOf: target.id })
    }
  }
}

const oneLine = (text, limit) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value }
const TIER_HEADING = {
  chat: 'THIS CHAT (working notes of this task thread)',
  project: 'THIS PROJECT (verified knowledge about this codebase)',
  global: 'ALL PROJECTS (shared knowledge)',
}

// The prompt block for `recall()`: each tier gets its share, unused room flows to the others, and whatever did not
// fit is listed by title so the model knows it exists and can ask for it with memory_search.
function renderRecall(recall, budget = 4500) {
  const order = ['chat', 'project', 'global'], share = { chat: 0.25, project: 0.45, global: 0.3 }
  const tiers = recall?.tiers || {}
  if (!order.some(tier => tiers[tier]?.length)) return ''
  const line = ({ entry, relevant, pinned }) => `- ${shortId(entry.id)} [${entry.type}${entry.pinned ? ', pinned' : ''}] ${oneLine(entry.title, 90)}: ${oneLine(entry.content, relevant || pinned ? 520 : 260)}`
  const room = budget - 700
  const picked = { chat: [], project: [], global: [] }, left = { chat: [...(tiers.chat || [])], project: [...(tiers.project || [])], global: [...(tiers.global || [])] }
  let used = 0
  const take = (tier, limit) => {
    while (left[tier].length) {
      const text = line(left[tier][0])
      if (used > 0 && used + text.length > limit) break
      picked[tier].push(text); left[tier].shift(); used += text.length + 1
    }
  }
  for (const tier of order) take(tier, Math.min(room, used + room * share[tier]))
  for (const tier of ['project', 'global', 'chat']) take(tier, room)
  const omitted = order.flatMap(tier => left[tier].map(item => ({ tier, item })))
  const hidden = order.reduce((sum, tier) => sum + Math.max(0, (recall.totals?.[tier] ?? (tiers[tier] || []).length) - picked[tier].length), 0)
  const blocks = order.filter(tier => picked[tier].length).map(tier => `${TIER_HEADING[tier]}:\n${picked[tier].join('\n')}`)
  if (omitted.length || hidden > 0) {
    let text = ''
    const titles = []
    for (const { tier, item } of omitted) { const next = `${tier[0]}:${shortId(item.entry.id)} ${oneLine(item.entry.title, 50)}`; if (text.length + next.length > 600) break; titles.push(next); text += `${next}; ` }
    blocks.push(`ALSO STORED, not shown (${hidden} entries${titles.length < hidden ? `, ${titles.length} listed` : ''}) — memory_search reads them: ${titles.join('; ')}`)
  }
  return blocks.join('\n')
}

module.exports = { OrbitMemoryStore, renderRecall, shortId, TIERS }
