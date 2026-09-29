import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, FileChange, RunSnapshot } from './types'
import DiffView from './DiffView'
import { fileMap } from './file-map'
import { plural, timeOf } from './format'
import './changes-tab.css'

type Group = { path: string; changes: FileChange[]; added: number; removed: number; agents: string[]; last: number; kind: 'create' | 'modify' | 'delete'; shared: boolean }

const KIND_LABEL = { create: 'создан', modify: 'изменён', delete: 'удалён' }
const SOURCE_NOTE: Record<string, string> = {
  event: 'по событию инструмента',
  git: 'накопленные изменения файла относительно коммита — могут включать не только правки этого агента',
}
const stamp = (time: string) => { const value = new Date(time).valueOf(); return Number.isNaN(value) ? 0 : value }

// Diff texts are fetched once per run and kept for the session, so switching agents or tabs never asks the main process again.
const RUNS_KEPT = 5
const loadedTexts = new Map<string, Map<string, FileChange>>()
const pendingTexts = new Map<string, Promise<Map<string, FileChange>>>()
function loadTexts(runId: string): Promise<Map<string, FileChange>> {
  const done = loadedTexts.get(runId)
  if (done) return Promise.resolve(done)
  const running = pendingTexts.get(runId)
  if (running) return running
  const api = window.orbit
  if (!api?.getRunChanges) return Promise.reject(new Error('Тексты изменений доступны только в настольном Orbit'))
  const request = api.getRunChanges(runId).then(list => {
    const texts = new Map((list || []).map(change => [change.id, change] as const))
    loadedTexts.set(runId, texts)
    for (const key of [...loadedTexts.keys()]) { if (loadedTexts.size <= RUNS_KEPT) break; loadedTexts.delete(key) }
    return texts
  }).finally(() => pendingTexts.delete(runId))
  pendingTexts.set(runId, request)
  return request
}

function groupChanges(changes: FileChange[]): Group[] {
  const byPath = new Map<string, FileChange[]>()
  for (const change of changes) { const list = byPath.get(change.path); if (list) list.push(change); else byPath.set(change.path, [change]) }
  const groups: Group[] = []
  for (const [path, list] of byPath) {
    const ordered = list.map((change, index) => ({ change, index, at: stamp(change.time) })).sort((a, b) => a.at - b.at || a.index - b.index).map(item => item.change)
    const agents = [...new Set(ordered.map(change => change.agentId))]
    const first = ordered[0], last = ordered[ordered.length - 1]
    groups.push({
      path, changes: ordered, agents, shared: agents.length > 1, last: stamp(last.time),
      added: ordered.reduce((sum, change) => sum + (change.added || 0), 0),
      removed: ordered.reduce((sum, change) => sum + (change.removed || 0), 0),
      kind: last.kind === 'delete' ? 'delete' : first.kind === 'create' ? 'create' : 'modify',
    })
  }
  return groups.sort((a, b) => b.last - a.last || a.path.localeCompare(b.path))
}

// `teamWide` opens on the whole team's changes (from the run's «файлов изменено» button) instead of the selected agent's own.
export function ChangesTab({ run, agent, onSelect, focusPath, teamWide }: { run: RunSnapshot; agent: Agent; onSelect: (id: string) => void; focusPath?: string; teamWide?: boolean }) {
  const isRouter = agent.id === 'router'
  const all = run.changes
  const [onlySelected, setOnlySelected] = useState(() => !isRouter && !teamWide && !(focusPath && (all || []).some(change => change.path === focusPath) && !(all || []).some(change => change.path === focusPath && change.agentId === agent.id)))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusPath ? [focusPath] : []))
  const [texts, setTexts] = useState<Map<string, FileChange> | null>(() => loadedTexts.get(run.runId) || null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const focused = useRef<string | undefined>(undefined)
  const nameOfAgent = (id: string) => run.agents.find(member => member.id === id)?.name || id

  const scoped = !isRouter && onlySelected
  const visible = useMemo(() => (all || []).filter(change => !scoped || change.agentId === agent.id), [all, scoped, agent.id])
  const groups = useMemo(() => groupChanges(visible), [visible])
  const teamFiles = useMemo(() => new Set((all || []).map(change => change.path)).size, [all])
  const needsTexts = !!all?.some(change => change.hasDiff && change.diff == null)

  function fetchTexts() {
    setLoading(true); setError('')
    loadTexts(run.runId).then(result => setTexts(result), reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false))
  }
  // Opening the tab is the moment the texts are wanted (or when a run restored later brings changes without them);
  // a failed attempt waits for the «Повторить» button instead of looping.
  useEffect(() => { if (needsTexts && !texts && !error) fetchTexts() }, [run.runId, needsTexts]) // eslint-disable-line react-hooks/exhaustive-deps

  // A file opened from the Files tab is expanded and brought into view; widen the scope when it is not this agent's file.
  useEffect(() => {
    if (!focusPath || focused.current === focusPath) return
    if (!(all || []).some(change => change.path === focusPath)) return
    focused.current = focusPath
    if (scoped && !(all || []).some(change => change.path === focusPath && change.agentId === agent.id)) setOnlySelected(false)
    setExpanded(previous => new Set(previous).add(focusPath))
    requestAnimationFrame(() => list.current && [...list.current.querySelectorAll<HTMLElement>('[data-path]')].find(node => node.dataset.path === focusPath)?.scrollIntoView({ block: 'nearest' }))
  }, [focusPath, all]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(path: string) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next })
  }
  function resolve(change: FileChange): FileChange {
    if (change.diff != null) return change
    const text = texts?.get(change.id)
    return text ? { ...change, diff: text.diff, truncated: text.truncated ?? change.truncated, binary: text.binary ?? change.binary } : change
  }

  const added = groups.reduce((sum, group) => sum + group.added, 0)
  const removed = groups.reduce((sum, group) => sum + group.removed, 0)
  const agentCount = new Set(groups.flatMap(group => group.agents)).size
  // A run saved before changes were tracked (or whose provider reports none) still lists what the agents wrote in the Files tab.
  const untracked = !all?.length && fileMap(run.agents).some(file => file.writers.length > 0)
  const emptyText = untracked ? 'Для этого запуска изменения не записаны: смотрите список файлов во вкладке «Файлы»' : scoped ? 'Этот агент пока не менял файлы' : 'Агенты пока не меняли файлы'

  function body(change: FileChange) {
    if (change.diff != null || change.binary) return <DiffView diff={change.diff || ''} truncated={change.truncated} binary={change.binary} />
    if (!change.hasDiff) return <p className="changes-note">Построчная разница для этого изменения недоступна: файл не удалось сравнить или её текст не сохранён</p>
    if (loading) return <p className="changes-note">Загружаем текст изменения…</p>
    if (error) return <p className="changes-note">Текст изменения не загружен.</p>
    return <p className="changes-note">Текст этого изменения не найден.</p>
  }

  return <div className="changes-tab">
    <div className="communications-heading"><h3>{scoped ? agent.name : 'Изменения команды'}</h3><p>Что именно агенты меняли в файлах этого запуска: у каждой правки — автор, время, инструмент и построчная разница.</p></div>
    {!isRouter && <label className="communications-filter"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} /><span>Только изменения {agent.name}</span></label>}
    {error && <div className="changes-error" role="alert"><span>Не удалось загрузить тексты изменений: {error}</span><button type="button" onClick={fetchTexts} disabled={loading}>Повторить</button></div>}
    {!groups.length ? <div className="communications-empty changes-empty"><p>{emptyText}</p>{scoped && teamFiles > 0 && <button type="button" className="changes-widen" onClick={() => setOnlySelected(false)}>Показать изменения команды: {plural(teamFiles, ['файл', 'файла', 'файлов'])}</button>}</div> : <>
      <div className="changes-summary">{plural(groups.length, ['файл', 'файла', 'файлов'])} · <span className="changes-plus">+{added}</span> <span className="changes-minus">−{removed}</span> · агентов {agentCount}</div>
      <div className="changes-list" ref={list}>
        {groups.map(group => {
          const open = expanded.has(group.path)
          return <article key={group.path} className={`changes-file ${open ? 'open' : ''} ${group.shared ? 'shared' : ''}`} data-path={group.path}>
            <button type="button" className="changes-file-toggle" aria-expanded={open} onClick={() => toggle(group.path)}>
              <span className="changes-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              <code className="changes-path" title={group.path}>{group.path}</code>
              <span className={`changes-kind ${group.kind}`}>{KIND_LABEL[group.kind]}</span>
              <span className="changes-stat"><span className="changes-plus">+{group.added}</span> <span className="changes-minus">−{group.removed}</span></span>
            </button>
            <div className="changes-file-agents">
              {group.agents.map(id => <button key={id} type="button" onClick={() => onSelect(id)} title={`Открыть ${nameOfAgent(id)}`}>{nameOfAgent(id)}</button>)}
              {group.shared && <span className="changes-shared">правили несколько агентов</span>}
            </div>
            {open && <div className="changes-entries">
              {group.changes.map(raw => {
                const change = resolve(raw)
                return <section key={change.id} className="changes-entry">
                  <div className="changes-entry-head"><strong>{nameOfAgent(change.agentId)}</strong><time dateTime={change.time}>{timeOf(change.time)}</time><span className="changes-tool">{change.tool}</span></div>
                  {SOURCE_NOTE[change.source] && <p className="changes-source">{SOURCE_NOTE[change.source]}</p>}
                  {body(change)}
                </section>
              })}
            </div>}
          </article>
        })}
      </div>
    </>}
  </div>
}
