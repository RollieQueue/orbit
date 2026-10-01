import { useMemo, useState } from 'react'
import type { Agent, InspectorTab, RunSnapshot, RunStatus, TurnTiming } from './types'
import { Markdown, assistantOutput, plural, statusText, timeOf } from './format'
import { changedFiles } from './file-map'
import { durationMs, formatDuration, shownStatus, transportLabel } from './run-events'
import './agent-history.css'

const dotOf = (status?: RunStatus) => status === 'completed' ? 'done' : status === 'failed' ? 'error' : status || 'idle'
const isActive = (status?: RunStatus) => status === 'working' || status === 'waiting'
// Long answers stay collapsed: a run can hold megabytes of model output.
const PREVIEW_CHARS = 1600

// Files the run changed: the change tracker's paths when it has them, otherwise what the agents reported writing.
// Every App render asks this for every answered run, and a live run is replaced by each event, so the count is kept per list.
const changedCount = new WeakMap<object, number>()
export function runChangedFiles(run?: RunSnapshot) {
  const source = run?.changes?.length ? run.changes : run?.agents
  if (!source) return 0
  let count = changedCount.get(source)
  if (count === undefined) {
    count = run?.changes?.length ? new Set(run.changes.map(change => change.path)).size : changedFiles(run)
    changedCount.set(source, count)
  }
  return count
}

function durationOf(run: RunSnapshot) {
  const ms = run.finishedAt ? durationMs(run.startedAt, run.finishedAt) : null
  return ms === null ? '' : formatDuration(ms)
}

// One agent's provider turns: how long each took, when its first event came, and how many tools it called
// (the CLI's own tools / Orbit's). An open turn shows its elapsed time so far.
export function TurnTimings({ timings }: { timings?: TurnTiming[] }) {
  if (!timings?.length) return null
  const at = Date.now()
  const total = timings.reduce((sum, timing) => sum + (durationMs(timing.startedAt, timing.endedAt, at) ?? 0), 0)
  const chars = (count?: number) => !count ? '—' : count >= 1000 ? `${Math.round(count / 1000)} тыс.` : String(count)
  return <details className="turn-timings">
    <summary>Время по ходам · {timings.length}{total ? ` · ${formatDuration(total)}` : ''}</summary>
    <div className="turn-timings-scroll"><table>
      <thead><tr>
        <th>Ход</th><th>Режим</th><th>Время</th><th title="От начала хода до первого события провайдера">1-е событие</th>
        <th title="Вызовы инструментов: собственные инструменты CLI / инструменты Orbit">CLI / Orbit</th><th title="Размер отправленного промпта">Промпт</th>
      </tr></thead>
      <tbody>{timings.map(timing => {
        const length = durationMs(timing.startedAt, timing.endedAt, at)
        const first = timing.firstEventAt ? durationMs(timing.startedAt, timing.firstEventAt, at) : null
        return <tr key={`${timing.turn}-${timing.startedAt}`} title={timing.sessionId ? `Сессия ${timing.sessionId}` : undefined}>
          <td>{timing.turn}</td><td>{transportLabel(timing.transport)}</td>
          <td>{length === null ? '—' : timing.endedAt ? formatDuration(length) : `идёт · ${formatDuration(length)}`}</td>
          <td>{first === null ? '—' : formatDuration(first)}</td>
          <td>{timing.nativeToolCalls ?? 0} / {timing.orbitToolCalls ?? 0}</td><td>{chars(timing.promptChars)}</td>
        </tr>
      })}</tbody>
    </table></div>
  </details>
}

// Time of day for today's runs, date and time for older ones.
function whenOf(time?: string) {
  const date = time ? new Date(time) : null
  if (!date || Number.isNaN(date.valueOf())) return time || ''
  if (date.toDateString() === new Date().toDateString()) return timeOf(time)
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${timeOf(time)}`
}

// The root agent first, then every helper under its parent; an agent whose parent is missing counts as a root.
function orderedAgents(agents: Agent[]) {
  const ordered: { agent: Agent; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (parentId: string | null, depth: number) => {
    for (const agent of agents) {
      const isChild = (agent.parentId || null) === parentId || (parentId === null && !!agent.parentId && !agents.some(p => p.id === agent.parentId))
      if (!isChild || seen.has(agent.id)) continue
      seen.add(agent.id)
      ordered.push({ agent, depth })
      visit(agent.id, depth + 1)
    }
  }
  visit(null, 0)
  return ordered
}

type Entry = { id: string; label: string; time: string; text: string }

function LongText({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const long = text.length > PREVIEW_CHARS
  return <>
    <Markdown text={long && !full ? `${text.slice(0, PREVIEW_CHARS)}…` : text} />
    {long && <button type="button" className="history-more" onClick={() => setFull(!full)}>
      {full ? 'Свернуть' : `Показать полностью (${Math.round(text.length / 1000)} тыс. симв.)`}
    </button>}
  </>
}

type CardProps = { agent: Agent; depth: number; entries: Entry[]; actions: number; answered: boolean; onOpen: () => void }

function AgentCard({ agent, depth, entries, actions, answered, onOpen }: CardProps) {
  const [opened, setOpened] = useState(false)
  const excerpt = (agent.task || agent.role || '').replace(/\s+/g, ' ').trim()
  return <details className="history-agent" style={{ marginLeft: Math.min(depth, 4) * 14 }} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>
      <span className={`status-dot ${shownStatus(agent)}`} />
      <span className="history-agent-main">
        <strong>{agent.name || agent.id}</strong>{excerpt && <small>{excerpt.length > 110 ? `${excerpt.slice(0, 110)}…` : excerpt}</small>}
      </span>
      <span className="history-agent-state">{statusText(shownStatus(agent))}{!!entries.length && ` · ${entries.length}`}</span>
    </summary>
    {opened && <div className="history-agent-body">
      <div className="history-agent-meta">
        {agent.role && <span>{agent.role}</span>}
        {!!agent.turns && <span>Ходов: {agent.turns}</span>}
        {!!actions && <span>Действий: {actions}</span>}
        <button type="button" className="history-open" onClick={onOpen}>Открыть в панели агентов</button>
      </div>
      {agent.task && <div className="history-task"><LongText text={agent.task} /></div>}
      <TurnTimings timings={agent.turnTimings} />
      {entries.map(entry => <div className="history-entry" key={entry.id}>
        <div className="eyebrow">{entry.label} · {timeOf(entry.time)}</div><LongText text={entry.text} />
      </div>)}
      {!entries.length && <p className="history-empty">
        {answered ? 'Ответ агента — в сообщении чата выше.' : agent.detail || 'Письменных сообщений этот агент не оставил.'}
      </p>}
    </div>}
  </details>
}

type OpenRun = (runId: string, tab?: InspectorTab, agentId?: string) => void

function HistoryBody({ run, onOpen }: { run: RunSnapshot; onOpen: OpenRun }) {
  const cards = useMemo(() => {
    const byAgent = new Map<string, Entry[]>()
    const actions = new Map<string, number>()
    const push = (agentId: string, entry: Entry) => { const list = byAgent.get(agentId); if (list) list.push(entry); else byAgent.set(agentId, [entry]) }
    // The root's replies are the chat's own answers, shown above: a root message with the same text is not repeated here.
    const answers = new Set((run.messages || []).filter(message => !message.agentId || message.agentId === 'root').map(message => message.text.trim()))
    for (const trace of run.traces || []) {
      const agentId = trace.agentId || 'root'
      if (trace.kind === 'output' || trace.kind === 'assistant_update') {
        const text = assistantOutput(trace.text)
        if (agentId !== 'root' || !answers.has(text.trim())) push(agentId, { id: trace.id, label: 'СООБЩЕНИЕ', time: trace.time, text })
      } else actions.set(agentId, (actions.get(agentId) || 0) + 1)
    }
    // The root agent's replies are the chat's own answers, already shown above; helpers' replies exist only here.
    for (const message of run.messages || []) {
      if (message.agentId && message.agentId !== 'root') push(message.agentId, { id: message.id, label: 'ОТВЕТ', time: message.time, text: message.text })
    }
    return orderedAgents(run.agents || []).map(({ agent, depth }) => ({
      agent, depth, entries: (byAgent.get(agent.id) || []).sort((a, b) => a.time.localeCompare(b.time)),
      actions: actions.get(agent.id) || 0, answered: agent.id === 'root' && answers.size > 0,
    }))
  }, [run.traces, run.messages, run.agents])
  if (!cards.length) return <p className="history-empty">Агенты этого запуска не записаны.</p>
  return <div className="history-cards">
    {run.error && <p className="history-error">{run.error}</p>}
    {cards.map(card => <AgentCard key={card.agent.id} {...card} onOpen={() => onOpen(run.runId, undefined, card.agent.id)} />)}
  </div>
}

// «Ход работы» under an answer: every agent of the run with what it wrote, kept after later messages. `loaded` is false
// while the saved history is still being restored, so a run that is merely not loaded yet is not reported as lost.
export function RunHistory({ run, loaded, onOpen }: { run?: RunSnapshot; loaded: boolean; onOpen: OpenRun }) {
  const [opened, setOpened] = useState(false)
  if (!run) return loaded ? <p className="history-missing">Данные этого запуска больше не хранятся</p> : null
  const files = runChangedFiles(run)
  const duration = durationOf(run)
  return <details className="history-block" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>
      <span className={`status-dot ${dotOf(run.status)}`} />
      <strong>Ход работы</strong>
      <span>{plural(run.agents.length, ['агент', 'агента', 'агентов'])}</span>
      <span>{statusText(run.status)}</span>
      {duration ? <span>{duration}</span> : isActive(run.status) ? <span>идёт</span> : null}
      {!!files && <span>{plural(files, ['файл изменён', 'файла изменено', 'файлов изменено'])}</span>}
    </summary>
    {opened && <HistoryBody run={run} onOpen={onOpen} />}
  </details>
}

// «История запусков» in the agents panel: every run of the chat, newest first.
export function RunHistoryList({ runs, currentId, onPick }: { runs: RunSnapshot[]; currentId?: string; onPick: (runId: string) => void }) {
  // Collapsed by default: the open list would take a third of a short agents panel.
  const [open, setOpen] = useState(false)
  const promptOf = (run: RunSnapshot) => run.prompt.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Без текста'
  const current = runs.find(run => run.runId === currentId)
  const metaOf = (run: RunSnapshot, index: number) => {
    const files = runChangedFiles(run)
    const agents = plural(run.agents.length, ['агент', 'агента', 'агентов'])
    const changed = files ? ` · ${plural(files, ['файл', 'файла', 'файлов'])}` : ''
    const resumed = run.resumedFrom ? ' · продолжение после перезапуска' : ''
    return `${index === 0 ? 'Последний · ' : ''}${whenOf(run.startedAt)} · ${statusText(run.status)}${resumed} · ${agents}${changed}`
  }
  return <section className="history-runs" aria-label="История запусков">
    <button type="button" className="history-runs-title" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="history-runs-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span className="history-runs-label">ИСТОРИЯ ЗАПУСКОВ</span><span className="history-runs-count">{runs.length}</span>
      {!open && current && <em title={current.prompt}>{promptOf(current)}</em>}
    </button>
    {open && <div className="history-runs-list">
      {runs.map((run, index) => <button type="button" key={run.runId} className={`history-run ${run.runId === currentId ? 'selected' : ''}`}
        aria-pressed={run.runId === currentId} title={run.prompt} onClick={() => { onPick(run.runId); setOpen(false) }}>
        <span className={`status-dot ${dotOf(run.status)}`} />
        <span className="history-run-main">
          <strong>{promptOf(run)}</strong>
          <small>{metaOf(run, index)}</small>
        </span>
      </button>)}
    </div>}
  </section>
}
