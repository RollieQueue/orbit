import type { Agent } from './types'
import { useEffect, useRef } from 'react'
import { shownStatus } from './run-events'

const statusLabel: Record<Agent['status'], string> = {
  idle: 'Ожидает', waiting: 'Ожидает', working: 'Работает', paused: 'Пауза', done: 'Ответил', error: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Прерван',
  restarting: 'Перезапуск Orbit',
}
const nodeLabel = (agent: Agent) => agent.budgetLimited ? (agent.stalled ? 'Остановлен · повтор' : 'Лимит · результат сохранён') : statusLabel[shownStatus(agent)]
const nodeClass = (agent: Agent, selected: boolean) => `agent-graph-node ${shownStatus(agent)} ${selected ? 'selected' : ''}`
const isActivation = (key: string) => key === 'Enter' || key === ' '

export function AgentGraph({ agents, selectedId, onSelect }: { agents: Agent[]; selectedId: string; onSelect: (id: string) => void }) {
  const nodes = new Map<string, { agent: Agent; x: number; y: number }>()
  const children = new Map<string, Agent[]>()
  const ids = new Set(agents.map(agent => agent.id))
  for (const agent of agents) {
    const parent = agent.parentId && ids.has(agent.parentId) ? agent.parentId : ''
    children.set(parent, [...(children.get(parent) || []), agent])
  }
  let leaf = 0
  const visited = new Set<string>()
  const place = (agent: Agent, depth: number): number => {
    if (visited.has(agent.id)) return nodes.get(agent.id)?.x || 100
    visited.add(agent.id)
    const descendants = (children.get(agent.id) || []).filter(child => !visited.has(child.id)).map(child => place(child, depth + 1))
    const x = descendants.length ? (descendants[0] + descendants[descendants.length - 1]) / 2 : 100 + leaf++ * 190
    nodes.set(agent.id, { agent, x, y: 45 + depth * 110 })
    return x
  }
  for (const root of children.get('') || []) place(root, 0)
  for (const agent of agents) if (!visited.has(agent.id)) place(agent, 0)
  const width = Math.max(290, leaf * 190 + 10)
  const height = Math.max(160, ...[...nodes.values()].map(node => node.y + 65))
  const viewport = useRef<HTMLDivElement>(null)
  const selected = nodes.get(selectedId)
  useEffect(() => {
    if (viewport.current && selected) viewport.current.scrollLeft = Math.max(0, selected.x - viewport.current.clientWidth / 2)
  }, [selected?.x, selected?.y])
  return <div className="agent-graph-panel">
    <div className="communications-heading">
      <h3>Кто кого создал</h3>
      <p>Стрелка ведёт от инициатора к созданному агенту. Нажмите на участника, чтобы выбрать его.</p>
    </div>
    <div className="agent-graph-scroll" ref={viewport}>
      <svg className="agent-graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Граф создания агентов">
        <defs>
          <marker id="agent-parent-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {[...nodes.values()].map(node => {
          const parent = node.agent.parentId && nodes.get(node.agent.parentId)
          if (!parent) return null
          const d = `M ${parent.x} ${parent.y + 28} C ${parent.x} ${parent.y + 64}, ${node.x} ${node.y - 64}, ${node.x} ${node.y - 31}`
          return <path key={`edge-${node.agent.id}`} className="agent-graph-edge" data-parent={parent.agent.id} data-child={node.agent.id} d={d}
            markerEnd="url(#agent-parent-arrow)">
            <title>{parent.agent.name} создал {node.agent.name}</title>
          </path>
        })}
        {[...nodes.values()].map(({ agent, x, y }) => <g key={agent.id} className={nodeClass(agent, agent.id === selectedId)} role="button" tabIndex={0}
          transform={`translate(${x - 84},${y - 28})`} aria-label={`Выбрать агента ${agent.name}`} aria-pressed={agent.id === selectedId}
          onClick={() => onSelect(agent.id)} onKeyDown={event => { if (isActivation(event.key)) { event.preventDefault(); onSelect(agent.id) } }}>
          <title>{agent.name}{agent.task ? `: ${agent.task}` : ''}</title><rect width="168" height="56" rx="9" /><circle cx="13" cy="19" r="3" />
          <text x="24" y="23">{agent.name.length > 20 ? `${agent.name.slice(0, 19)}…` : agent.name}</text>
          <text className="agent-graph-status" x="12" y="43">{nodeLabel(agent)}</text>
        </g>)}
      </svg>
    </div>
  </div>
}
