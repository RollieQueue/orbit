import type { ReactNode } from 'react'
import type { Agent, InspectorTab, QuotaSnapshot, RunSnapshot } from './types'
import { RunHistoryList } from './AgentHistory'
import { AgentInspector } from './AgentInspector'
import { Icon } from './Icon'
import { handoverLabel } from './QuotaPanel'
import { plural, statusText } from './format'
import { providerName, providers } from './providers'
import { isActiveStatus } from './run-events'

type TreeOptions = { run: RunSnapshot; selectedId?: string; onSelect: (id: string) => void }
const handoverTitle = (agent: Agent) =>
  (agent.handovers || []).map(item => `${handoverLabel(providers, item.from)} → ${handoverLabel(providers, item.to)}`).join('\n')

// The agents of a run as rows, each parent followed by its children. An agent whose parent is missing is shown at the top.
function agentTree(items: Agent[], options: TreeOptions, parentId: string | null = null, depth = 0, seen = new Set<string>()): ReactNode {
  const orphan = (a: Agent) => parentId === null && !!a.parentId && !items.some(p => p.id === a.parentId)
  const children = items.filter(a => (a.parentId || null) === parentId || orphan(a)).filter(a => !seen.has(a.id))
  return children.map(agent => {
    const nextSeen = new Set(seen).add(agent.id)
    const providerId = agent.providerId || options.run.providerId
    const modelLabel = `${providerName(providerId) || providerId || 'Провайдер не указан'} · ${agent.model || 'Модель: авто (ещё не определена)'}`
    const files = agent.files
    return <div key={agent.id}>
      <button className={`agent-row ${options.selectedId === agent.id ? 'selected' : ''}`} style={{ paddingLeft: 14 + Math.min(depth, 8) * 16 }}
        onClick={() => options.onSelect(agent.id)}>
        <span className={`status-dot ${agent.status}`} />
        <span className="agent-row-label">
          <strong>{agent.name || agent.id}</strong>
          <small title={modelLabel}>{modelLabel}</small>
          {agent.role && <small>{agent.role}</small>}
          {!!files && files.wrote.length + files.read.length > 0 && <small>Файлы: изменил {files.wrote.length}, читал {files.read.length}</small>}
          {!!agent.handovers?.length && <small className="handover-badge" title={handoverTitle(agent)}>⇄ Сменил подписку: {agent.handovers.length}</small>}
        </span>
        <span className="agent-state">{statusText(agent.status)}</span>
      </button>
      {agentTree(items, options, agent.id, depth + 1, nextSeen)}
    </div>
  })
}

type AgentsPanelProps = {
  chatRuns: RunSnapshot[]; currentRun?: RunSnapshot; selectedAgent: string; inspectorRequest: { runId: string; tab: InspectorTab; seq: number } | null
  quotas: Record<string, QuotaSnapshot>; onClose: () => void; onPick: (runId: string) => void; onSelectAgent: (id: string) => void
}

// The agents panel: the chat's runs, the selected run's team as a tree (plus the router) and the inspector of one agent.
export function AgentsPanel({ chatRuns, currentRun, selectedAgent, inspectorRequest, quotas, onClose, onPick, onSelectAgent }: AgentsPanelProps) {
  const routerAgent: Agent = {
    id: 'router', name: 'Маршрутизатор', role: 'Системный участник', status: isActiveStatus(currentRun?.status) ? 'working' : 'done',
  }
  const selected = selectedAgent === 'router' && currentRun ? routerAgent : currentRun?.agents.find(a => a.id === selectedAgent) || currentRun?.agents[0]
  const latest = chatRuns.at(-1)
  const newerRun = chatRuns.length > 1 && currentRun && latest && latest.runId !== currentRun.runId && isActiveStatus(latest.status) ? latest : undefined
  const requested = inspectorRequest?.runId === currentRun?.runId ? inspectorRequest : null
  const routerRow = !!currentRun && (currentRun.agents.length > 1 || !!currentRun.communications?.length)
  return <aside className="agents-panel">
    <header>
      <div><Icon name="agents" /><strong>Агенты</strong></div>
      <button className="icon-button" aria-label="Закрыть панель агентов" onClick={onClose}><Icon name="close" /></button>
    </header>
    {chatRuns.length > 1 && <RunHistoryList runs={[...chatRuns].reverse()} currentId={currentRun?.runId} onPick={onPick} />}
    {newerRun && <button type="button" className="history-follow" onClick={() => onPick(newerRun.runId)}>
      <span className="status-dot working" />Идёт новый запуск — перейти
    </button>}
    {!currentRun?.agents.length ? <div className="panel-empty">
      <Icon name="agents" size={34} />
      <h3>Команда появится здесь</h3>
      <p>После отправки сообщения здесь будут реальные агенты, их задачи и действия. Подагенты создаются по необходимости.</p>
    </div> : <>
      <div className="run-summary">
        <span className={`status-dot ${currentRun.status}`} />
        {statusText(currentRun.status)}
        <span>{plural(currentRun.agents.length, ['агент', 'агента', 'агентов'])}</span>
      </div>
      <div className="agent-tree">
        {agentTree(currentRun.agents, { run: currentRun, selectedId: selected?.id, onSelect: onSelectAgent })}
        {routerRow && <button className={`agent-row router-row ${selected?.id === 'router' ? 'selected' : ''}`} onClick={() => onSelectAgent('router')}>
          <span className={`status-dot ${routerAgent.status}`} />
          <span className="agent-row-label"><strong>{routerAgent.name}</strong><small>Адресует сообщения и следит за общими файлами</small></span>
          <span className="agent-state">{(currentRun.router?.routed ?? 0) + (currentRun.router?.notices ?? 0)}</span>
        </button>}
      </div>
      {selected && <AgentInspector key={requested ? `${currentRun.runId}:${requested.seq}` : currentRun.runId} run={currentRun} agent={selected}
        onSelect={onSelectAgent} quotas={quotas} initialTab={requested?.tab} />}
    </>}
  </aside>
}
