import { useState } from 'react'
import { AGENT_FILTERS, filterNames, isAgentFilter, type ActivityCounts, type AgentFilter } from './agent-activity'
import './agent-filter.css'

// The chosen filter is remembered between openings of the panel (one key, checked on read).
const FILTER_KEY = 'orbit.agents-filter'
export function useAgentFilter(): [AgentFilter, (filter: AgentFilter) => void] {
  const [filter, setFilter] = useState<AgentFilter>(() => { try { const saved = localStorage.getItem(FILTER_KEY); return isAgentFilter(saved) ? saved : 'all' } catch { return 'all' } })
  const pick = (next: AgentFilter) => {
    setFilter(next)
    try { localStorage.setItem(FILTER_KEY, next) } catch { /* private mode: only this session remembers */ }
  }
  return [filter, pick]
}

const waitingTitle = ({ waitingBy }: ActivityCounts) => [
  waitingBy.helpers && `Ждут помощников: ${waitingBy.helpers}`, waitingBy.message && `Ждут сообщения: ${waitingBy.message}`, waitingBy.approval && `Ждут разрешения: ${waitingBy.approval}`,
].filter(Boolean).join('\n')

// «Все» and «Активные» always; then one chip per activity that has agents (the chosen one stays even at zero, so it can be switched off).
export function AgentFilterBar({ filter, counts, onChange }: { filter: AgentFilter; counts: ActivityCounts; onChange: (filter: AgentFilter) => void }) {
  return <div className="agent-filter" role="group" aria-label="Фильтр агентов по активности">
    {AGENT_FILTERS.filter(id => id === 'all' || id === 'active' || counts[id] > 0 || id === filter).map(id =>
      <button type="button" key={id} className={`agent-filter-chip${filter === id ? ' active' : ''}`} aria-pressed={filter === id} onClick={() => onChange(id)}
        title={id === 'waiting' ? waitingTitle(counts) : id === 'active' ? 'Работают, в очереди, ждут и на паузе' : undefined}>
        {filterNames[id]} <b>{counts[id]}</b>
      </button>)}
  </div>
}

export function AgentFilterEmpty({ filter, onReset }: { filter: AgentFilter; onReset: () => void }) {
  return <p className="agent-filter-empty">Нет агентов в состоянии «{filterNames[filter]}». <button type="button" onClick={onReset}>Все</button></p>
}
