// Lexical retrieval shared by memory and skills: no model call and no native dependency. A small inverted index
// with BM25 scoring over stemmed terms. The stem is deliberately crude (plural "s", then the first five letters)
// so that English and Russian inflections of one word meet: "memories"/"memory", "проекты"/"проекте".
const TOKEN = /[\p{L}\p{N}_-]{3,}/gu
const STOP = new Set(('the and for are was were this that with from have has had not but you your they them then than what when where which will would '
  + 'can could should into onto about over under also just only some any all each other such very more most use used using '
  + 'что это как для при или его она они мы вы был была были быть есть нет так уже еще ещё все всё чем тем тот эта эти этот там тут где когда если '
  + 'только можно нужно надо будет которые который которая').split(/\s+/))

// One text of a document with its weight: [text, weight].
type IndexField = readonly [text: unknown, weight: number]
// What the index keeps per document: its weighted length and the weight of each of its terms.
interface IndexedDocument { length: number; frequency: Map<string, number> }
// A document's score against a query and how many of the query's terms it contains.
interface IndexHit { score: number; matched: number }

function stem(word: string): string {
  let value = word
  if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1)
  return value.length > 5 ? value.slice(0, 5) : value
}

// Identifiers are split at camelCase and separators too, and also kept whole: "capabilityStore" finds both
// "capability" and "capabilityStore"; "memory_save" finds "memory" and "save".
function terms(text: unknown): string[] {
  const out: string[] = []
  for (const raw of String(text ?? '').match(TOKEN) || []) {
    const spaced = raw.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    const parts = spaced.split(/[\s_-]+/).map(part => part.toLocaleLowerCase()).filter(part => part.length >= 3 && !STOP.has(part))
    for (const part of parts) out.push(stem(part))
    if (parts.length > 1) out.push(raw.toLocaleLowerCase())
  }
  return out
}

const uniqueTerms = (text: unknown): Set<string> => new Set(terms(text))
// The exact words of a text, unstemmed, numbers included, order ignored: two texts with the same signature say the same thing.
const signature = (text: unknown): string => [...new Set(String(text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].sort().join(' ')

// Jaccard overlap of two term sets: 1 for identical vocabularies, 0 for disjoint ones.
function similarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0
  const [small, large] = left.size < right.size ? [left, right] : [right, left]
  let shared = 0
  for (const term of small) if (large.has(term)) shared++
  return shared / (left.size + right.size - shared)
}

class TextIndex {
  declare docs: Map<string, IndexedDocument>
  declare postings: Map<string, Set<string>>
  declare length: number
  constructor() { this.docs = new Map(); this.postings = new Map(); this.length = 0 }

  // fields: [[text, weight], ...]; a title counts three times a body, so a title hit outranks a passing mention.
  set(id: string, fields: ReadonlyArray<IndexField>): void {
    this.delete(id)
    const frequency = new Map<string, number>()
    let length = 0
    for (const [text, weight] of fields) for (const term of terms(text)) { frequency.set(term, (frequency.get(term) || 0) + weight); length += weight }
    this.docs.set(id, { length, frequency })
    this.length += length
    for (const term of frequency.keys()) { let list = this.postings.get(term); if (!list) this.postings.set(term, list = new Set<string>()); list.add(id) }
  }

  delete(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    this.length -= doc.length
    for (const term of doc.frequency.keys()) { const list = this.postings.get(term)!; list.delete(id); if (!list.size) this.postings.delete(term) }
    this.docs.delete(id)
  }

  clear(): void { this.docs.clear(); this.postings.clear(); this.length = 0 }

  // Scores documents against a query. `allowed` (a Set of ids) restricts the corpus statistics too, so a
  // project's ranking is not shaped by another project's vocabulary. Returns Map id -> { score, matched }.
  search(query: unknown, allowed?: ReadonlySet<string> | null): Map<string, IndexHit> {
    const wanted = [...new Set(terms(query))]
    const size = allowed ? allowed.size : this.docs.size
    const scored = new Map<string, IndexHit>()
    if (!wanted.length || !size) return scored
    let total = 0
    if (allowed) for (const id of allowed) total += this.docs.get(id)?.length || 0
    else total = this.length
    const average = total / size || 1
    const weighted = wanted.map(term => {
      const list = this.postings.get(term)
      const ids = list ? (allowed ? [...list].filter(id => allowed.has(id)) : [...list]) : []
      return { term, ids, idf: Math.log(1 + (size - ids.length + 0.5) / (ids.length + 0.5)) }
    }).filter(item => item.ids.length).sort((a, b) => b.idf - a.idf).slice(0, 40)
    for (const { term, ids, idf } of weighted) {
      for (const id of ids) {
        const doc = this.docs.get(id)!, tf = doc.frequency.get(term)!
        const value = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / average))
        const current = scored.get(id) || { score: 0, matched: 0 }
        current.score += value; current.matched++
        scored.set(id, current)
      }
    }
    return scored
  }
}

export { TextIndex, terms, uniqueTerms, similarity, signature, stem }
export type { IndexField, IndexHit }
