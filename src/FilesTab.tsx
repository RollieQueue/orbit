import { useMemo, useState } from 'react'
import type { Agent, FileTouch, RunSnapshot } from './types'
import { fileMap, isConflictFile, isSharedFile } from './file-map'
import './files-tab.css'

type Mode = 'all' | 'changed' | 'readonly' | 'shared' | 'conflict' | 'created' | 'deleted'
type Stat = { added: number; removed: number; created: boolean; deleted: boolean }
type Row = { file: FileTouch; shared: boolean; conflict: boolean; stat?: Stat }
const PAGE = 200
const modes: { id: Mode; label: string; test: (row: Row) => boolean; hidden?: boolean }[] = [
  { id: 'all', label: 'Все', test: () => true },
  { id: 'changed', label: 'Изменённые', test: row => row.file.writers.length > 0 },
  { id: 'readonly', label: 'Только прочитанные', test: row => row.file.writers.length === 0 },
  { id: 'shared', label: 'Общие', test: row => row.shared },
  { id: 'conflict', label: 'Конфликты', test: row => row.conflict },
  { id: 'created', label: 'Созданные', test: row => !!row.stat?.created, hidden: true },
  { id: 'deleted', label: 'Удалённые', test: row => !!row.stat?.deleted, hidden: true },
]

export function FilesTab({ run, agent, onSelect, onOpenChanges }: { run: RunSnapshot; agent: Agent; onSelect: (id: string) => void; onOpenChanges?: (path: string) => void }) {
  const defaultScope = agent.id === 'router' ? 'all' : agent.id
  const [scope, setScope] = useState(defaultScope)
  const [mode, setMode] = useState<Mode>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'shared' | 'path'>('shared')
  const [shown, setShown] = useState(PAGE)
  const needle = query.trim().toLowerCase()
  const names = useMemo(() => new Map(run.agents.map(member => [member.id, member.name])), [run.agents])
  const nameOfAgent = (id: string) => names.get(id) || id
  // Depends on the two lists, not on `run`: a live run is replaced by every trace event, and the map must not be rebuilt for each.
  const rows = useMemo<Row[]>(() => {
    const stats = new Map<string, Stat>()
    for (const change of run.changes || []) {
      const stat = stats.get(change.path) || { added: 0, removed: 0, created: false, deleted: false }
      stat.added += change.added
      stat.removed += change.removed
      if (change.kind === 'create') stat.created = true
      if (change.kind === 'delete') stat.deleted = true
      stats.set(change.path, stat)
    }
    return fileMap(run.agents).map(file => ({ file, shared: isSharedFile(file), conflict: isConflictFile(file), stat: stats.get(file.path) }))
  }, [run.agents, run.changes])
  const scopeOptions = useMemo(() => {
    const touched = new Set(rows.flatMap(row => [...row.file.readers, ...row.file.writers]))
    return run.agents.filter(member => touched.has(member.id) || member.id === scope)
  }, [rows, run.agents, scope])
  // Counts describe what a chip would show with the agent and the search applied, so they match the list.
  const base = useMemo(() => rows.filter(row => (scope === 'all' || row.file.readers.includes(scope) || row.file.writers.includes(scope)) && (!needle || row.file.path.toLowerCase().includes(needle))), [rows, scope, needle])
  const counts = useMemo(() => Object.fromEntries(modes.map(item => [item.id, base.filter(item.test).length])) as Record<Mode, number>, [base])
  const visible = useMemo(() => {
    const test = modes.find(item => item.id === mode)!.test
    const list = base.filter(test)
    return sort === 'path' ? list.sort((a, b) => a.file.path.localeCompare(b.file.path)) : list.sort((a, b) => Number(b.shared) - Number(a.shared))
  }, [base, mode, sort])
  const filtered = mode !== 'all' || !!needle
  const active = filtered || scope !== defaultScope
  // Any filter change starts from the first page again.
  const change = (apply: () => void) => { apply(); setShown(PAGE) }
  const reset = () => change(() => { setScope(defaultScope); setMode('all'); setQuery('') })
  const emptyText = () => {
    if (!filtered && !base.length) return scope === 'all' ? 'Агенты пока не читали и не меняли файлы.' : 'Этот агент пока не читал и не менял файлы.'
    const parts = [scope !== 'all' && `агент ${nameOfAgent(scope)}`, mode !== 'all' && `«${modes.find(item => item.id === mode)!.label}»`, !!needle && `поиск «${query.trim()}»`].filter(Boolean)
    return `Ничего не найдено: ${parts.join(', ')}.`
  }
  return <div className="agent-files">
    <div className="communications-heading"><h3>{scope === 'all' ? 'Файлы команды' : nameOfAgent(scope)}</h3><p>Кто читал и кто менял файлы в этом запуске. Данные берутся из инструментов Orbit и событий нативных инструментов провайдера. Изменения от команд учитываются, только если их мог сделать один агент.</p></div>
    <div className="files-controls">
      <div className="files-chips" role="group" aria-label="Фильтр файлов">
        {modes.filter(item => !item.hidden || counts[item.id] > 0 || mode === item.id).map(item => <button key={item.id} type="button" className={`files-chip ${mode === item.id ? 'active' : ''}`} aria-pressed={mode === item.id} onClick={() => change(() => setMode(mode === item.id ? 'all' : item.id))}>{item.label}<span className="files-count">{counts[item.id]}</span></button>)}
        {active && <button type="button" className="files-reset" onClick={reset}>Сбросить</button>}
      </div>
      <div className="files-fields">
        <input type="search" className="files-search" placeholder="Поиск по пути" aria-label="Поиск по пути" value={query} onChange={event => change(() => setQuery(event.target.value))} />
        <select aria-label="Агент" value={scope} onChange={event => change(() => setScope(event.target.value))}>
          <option value="all">Агент: все</option>
          {scopeOptions.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        <select aria-label="Сортировка" value={sort} onChange={event => setSort(event.target.value as 'shared' | 'path')}>
          <option value="shared">Сначала общие</option>
          <option value="path">По пути</option>
        </select>
      </div>
    </div>
    {!visible.length ? <div className="communications-empty"><p>{emptyText()}</p></div> : <>
      {visible.slice(0, shown).map(({ file, shared, stat }) => <article key={file.path} className={`file-row ${shared ? 'shared' : ''}`}>
        <code title={file.path}>{file.path}</code>
        {(shared || stat) && <div className="files-meta">
          {shared && <span className="file-shared">общий файл</span>}
          {stat && <span className="files-stat" title="Добавлено и удалено строк"><span className="files-added">+{stat.added}</span><span className="files-removed">−{stat.removed}</span></span>}
          {stat && onOpenChanges && <button type="button" className="files-changes" onClick={() => onOpenChanges(file.path)}>Изменения</button>}
        </div>}
        <div className="file-agents">{file.writers.map(id => <button key={`w-${id}`} onClick={() => onSelect(id)} title={`${nameOfAgent(id)} изменил файл`}>✎ {nameOfAgent(id)}</button>)}{file.readers.filter(id => !file.writers.includes(id)).map(id => <button key={`r-${id}`} className="reader" onClick={() => onSelect(id)} title={`${nameOfAgent(id)} прочитал файл`}>{nameOfAgent(id)}</button>)}</div>
      </article>)}
      {visible.length > shown && <button type="button" className="files-show-more" onClick={() => setShown(count => count + PAGE)}>Показать ещё {Math.min(PAGE, visible.length - shown)}{visible.length - shown > PAGE && ` из ${visible.length - shown}`}</button>}
    </>}
  </div>
}
