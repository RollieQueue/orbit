import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Agent, Communication, Handover, InspectorTab, QuotaSnapshot, RunSnapshot, TraceImage } from './types'
import { AgentGraph } from './AgentGraph'
import { TurnTimings } from './AgentHistory'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
import { Icon } from './Icon'
import { handoverLabel, handoverReason, usedNow, windowName, windowsFor } from './QuotaPanel'
import { effortLabels } from './ReasoningPicker'
import { Markdown, assistantOutput, errorText, timeOf } from './format'
import { TraceImages } from './TraceImages'
import { fileMap } from './file-map'
import { providerName, providers } from './providers'
import { actionCount, isActiveStatus, pauseHolder, transportLabel } from './run-events'

export type MessageAgent = (runId: string, agentId: string, text: string) => Promise<void>

const routeLabel: Record<string, string> = {
  direct: 'напрямую', explicit: 'адресат указан отправителем', match: 'подобран по файлам и теме',
  reply: 'ответ автору сообщения', escalation: 'передано руководителю',
}
const improvementMark = { pending: '○', working: '◐', done: '✓', blocked: '!' }
const deliveryLabel: Record<string, string> = { queued: 'В очереди', delivered: 'Доставлено', read: 'Прочитано' }
const deliveryTitle = (message: Communication) => message.readAt ? `Прочитано ${timeOf(message.readAt)}`
  : message.deliveredAt ? `Доставлено ${timeOf(message.deliveredAt)}` : 'Будет доступно агенту на следующем ходе'
const ofAgent = (agent: Agent) => (item: { agentId?: string }) => (item.agentId || 'root') === agent.id
const isRouted = (message: Communication) => message.via === 'router' && !!message.route && message.route.via !== 'direct'

function kindLabel(message: Communication) {
  if (message.fromAgentId === 'user' && message.kind === 'message') return 'Сообщение от вас'
  if (message.kind === 'notice') return message.conflict ? 'Маршрутизатор · конфликт правок' : 'Маршрутизатор · файл изменён другим агентом'
  if (message.kind === 'spawn') return 'Создание агента · исходная задача'
  if (message.kind === 'followup') return 'Новая задача существующему агенту'
  if (message.route && message.route.via !== 'direct') return message.replyTo ? 'Ответ в обсуждении · через маршрутизатор' : 'Адресовано маршрутизатором'
  if (message.discussionId) return 'Сообщение группе'
  return message.replyTo ? 'Ответ в обсуждении' : 'Сообщение'
}
function handoverNote(item: Handover) {
  const reset = item.resetsAt ? `\nЛимит снимется: ${new Date(item.resetsAt).toLocaleString('ru-RU')}` : ''
  const moved = item.fresh && !item.interrupted
    ? '\nАгент ещё ничего не сделал: работа началась на новой подписке.'
    : `\n\nЧто получила новая модель:\n${item.note || ''}`
  return `Причина: ${handoverReason(item)}${reset}${moved}`
}
function budgetText(agent: Agent, run: RunSnapshot) {
  const turns = agent.parentId ? `Ходы: ${agent.turns || 0} / ${run.limits?.maxTurns ?? '∞'}` : `Ходы: ${agent.turns || 0} · без ограничения`
  const limited = !agent.budgetLimited ? ''
    : agent.stalled ? ' · Остановлен: повторял одни и те же вызовы, результаты сохранены' : ' · Лимит достигнут, результаты сохранены'
  return `Действий: ${actionCount(agent)} · ${turns}${limited}`
}
const ACTIONS_HINT = 'Ход — один запуск модели; в режиме сессии модель делает за один ход много действий (команды, правки, инструменты Orbit).'

function FileChips({ label, files }: { label: string; files: string[] }) {
  if (!files.length) return null
  return <div className="file-group">
    <span className="file-group-label">{label}</span>
    <div className="file-pills">
      {files.slice(0, 12).map(file => <code key={file} title={file}>{file}</code>)}
      {files.length > 12 && <span className="file-more">+{files.length - 12}</span>}
    </div>
  </div>
}

// A trace with images (a screenshot the agent read) shows them under its line, visible without opening it.
function TraceItem({ trace, kind, runId }: { trace: { id: string; text: string; time: string; kind: string; images?: TraceImage[] }; kind: string; runId: string }) {
  const item = <details className="trace-item">
    <summary><span className={`trace-kind ${kind}`} /><span>{trace.text.slice(0, 120) || trace.kind}</span><time>{timeOf(trace.time)}</time></summary>
    <pre>{trace.text}</pre>
  </details>
  if (!trace.images?.length) return item
  return <div className="trace-with-images">{item}<TraceImages runId={runId} images={trace.images} /></div>
}

// The router is not a model: its activity is the list of routing decisions it recorded.
function RouterActivity({ run, agent }: { run: RunSnapshot; agent: Agent }) {
  const traces = run.traces.filter(ofAgent(agent))
  const stats = [
    `Доставлено адресно: ${run.router?.routed ?? 0}`, `Уведомлений об изменениях: ${run.router?.notices ?? 0}`,
    `Остановлено повторов и споров: ${run.router?.refused ?? 0}`,
  ].join(' · ')
  return <>
    <div className="inspector-heading">
      <div className="eyebrow">СИСТЕМНЫЙ УЧАСТНИК</div>
      <h3>{agent.name}</h3>
      <span>Работает без модели: не тратит ходы и не может зациклиться</span>
    </div>
    <div className="agent-task">
      Все сообщения между агентами проходят здесь. Маршрутизатор находит адресата по файлам и теме, сообщает агентам, что кто-то изменил файл,
      который они читали, и закрывает обсуждение, в котором никто ничего не делает.
    </div>
    <p className="agent-budget">{stats}</p>
    <div className="section-label">РЕШЕНИЯ МАРШРУТИЗАТОРА</div>
    <div className="agent-events">
      {traces.map(trace => <details className="trace-item" key={trace.id}>
        <summary><span className="trace-kind message" /><span>{trace.text.slice(0, 120)}</span><time>{timeOf(trace.time)}</time></summary>
        <pre>{trace.text}</pre>
      </details>)}
      {!traces.length && <p className="muted">Адресных обращений пока не было. Уведомления об изменённых файлах смотрите во вкладке «Переписка».</p>}
    </div>
  </>
}

function AgentActivity({ run, agent, quotas }: { run: RunSnapshot; agent: Agent; quotas: Record<string, QuotaSnapshot> }) {
  const traces = run.traces.filter(ofAgent(agent))
  const replies = run.messages.filter(ofAgent(agent))
  const working = run.agents.filter(member => member.status === 'working').length
  const helperTurns = `${run.usage?.workerTurns ?? '—'} / ${run.limits?.maxTotalTurns ?? '∞'}`
  const providerId = agent.providerId || run.providerId
  const at = Date.now()
  const windows = windowsFor(quotas[providerId || ''], agent.model || '')
  const quotaText = windows.map(window => `${windowName(window)} — осталось ${Math.max(0, 100 - usedNow(window, at))}%`).join(' · ')
  const improvements = run.improvements || []
  const done = improvements.filter(task => task.status === 'done').length
  return <>
    <div className="inspector-heading">
      <div className="eyebrow">{agent.parentId ? 'ПОДАГЕНТ' : 'ОСНОВНОЙ АГЕНТ'}</div>
      <h3>{agent.name}</h3>
      <span title={agent.sessionId ? `Сессия ${agent.sessionId}` : undefined}>
        {providerName(agent.providerId) || agent.providerId || run.providerId}
        {agent.model ? ` · ${agent.model}` : ''}
        {agent.transport ? ` · ${transportLabel(agent.transport)}` : ''}
        {agent.reasoningEffort ? ` · Рассуждения: ${effortLabels[agent.reasoningEffort] || agent.reasoningEffort}` : ''}
        {agent.generation ? ` · Продолжение ${agent.generation}` : ''}
      </span>
    </div>
    {agent.task && <div className="agent-task">{agent.task}</div>}
    {agent.reason && <p className="agent-reason">{agent.reason}</p>}
    <p className="agent-budget" title={ACTIONS_HINT}>{budgetText(agent, run)}</p>
    <TurnTimings timings={agent.turnTimings} />
    {run.usage && <p className="agent-budget">Работают: {working} · Ходы помощников: {helperTurns}</p>}
    {!!windows.length && <p className="agent-budget">Квота {providerName(providerId)}: {quotaText}</p>}
    {!!agent.handovers?.length && <div className="handover-list">
      <div className="section-label">СМЕНА ПОДПИСКИ</div>
      {agent.handovers.map(item => <details className="trace-item" key={item.id}>
        <summary>
          <span className="trace-kind handover" />
          <span>{handoverLabel(providers, item.from)} → {handoverLabel(providers, item.to)}</span>
          <time>{timeOf(item.time)}</time>
        </summary>
        <pre>{handoverNote(item)}</pre>
      </details>)}
    </div>}
    {!!(agent.files?.wrote.length || agent.files?.read.length) && <div className="agent-files-summary">
      <FileChips label="Изменил" files={agent.files?.wrote || []} />
      <FileChips label="Читал" files={agent.files?.read || []} />
    </div>}
    {agent.id === 'root' && !!improvements.length && <div className="improvement-progress">
      <strong>Улучшения: {done} / {improvements.length}</strong>
      {improvements.map(task => <details key={task.id}>
        <summary>{improvementMark[task.status]} {task.title}</summary>
        <p>{task.evidence || 'Ожидает выполнения'}</p>
      </details>)}
    </div>}
    <div className="section-label">ДЕЙСТВИЯ И РЕЗУЛЬТАТЫ</div>
    <div className="agent-events">
      {traces.map(trace => ['output', 'assistant_update'].includes(trace.kind)
        ? <div className="agent-output" key={trace.id}>
          <div className="eyebrow">СООБЩЕНИЕ · {timeOf(trace.time)}</div>
          <Markdown text={assistantOutput(trace.text)} />
        </div>
        : <TraceItem key={trace.id} trace={trace} kind={trace.kind} runId={run.runId} />)}
      {replies.map(message => <div className="agent-output" key={message.id}>
        <div className="eyebrow">ОТВЕТ · {timeOf(message.time)}</div>
        <Markdown text={message.text} />
      </div>)}
      {!traces.length && !replies.length && <p className="muted">{agent.detail || 'Событий пока нет.'}</p>}
    </div>
  </>
}

function CommunicationItem({ message, all }: { message: Communication; all: Communication[] }) {
  const route = isRouted(message) ? message.route! : null
  const routeText = route ? `${routeLabel[route.via] || route.via}${route.reasons.length ? ` · ${route.reasons.join('; ')}` : ''}` : ''
  const reply = message.replyTo ? all.find(item => item.id === message.replyTo)?.text.slice(0, 160) || 'Ответ на более раннее сообщение' : ''
  return <article className={`communication-item ${message.kind === 'notice' ? 'notice' : ''} ${message.conflict ? 'conflict' : ''}`}>
    <div className="communication-kind">{kindLabel(message)}</div>
    <div className="communication-route">
      <strong title={message.fromAgentId}>{message.fromAgentName || message.fromAgentId}</strong>
      <span aria-label="пишет">→</span>
      <strong title={message.toAgentId}>{message.toAgentName || message.toAgentId}</strong>
    </div>
    {message.reason && <p className="agent-reason">{message.reason}</p>}
    {route && <p className="agent-reason route-reason">Маршрутизатор: {routeText}</p>}
    {message.replyTo && <blockquote className="communication-reply">{reply}</blockquote>}
    <Markdown text={message.text} />
    <div className="communication-meta">
      <time dateTime={message.time}>{timeOf(message.time)}</time>
      <span className={`delivery-status ${message.status}`} title={deliveryTitle(message)}>{deliveryLabel[message.status] || 'Отправлено'}</span>
    </div>
  </article>
}

type CommunicationsProps = { run: RunSnapshot; agent: Agent; onlySelected: boolean; onToggle: (value: boolean) => void }

function CommunicationsTab({ run, agent, onlySelected, onToggle }: CommunicationsProps) {
  const isRouter = agent.id === 'router'
  const all = run.communications || []
  const routed = (message: Communication) => message.kind === 'notice' || isRouted(message)
  const mine = (message: Communication) => isRouter ? routed(message) : message.fromAgentId === agent.id || message.toAgentId === agent.id
  const communications = onlySelected ? all.filter(mine) : all
  return <div className="agent-communications">
    <div className="communications-heading">
      <h3>{onlySelected ? agent.name : 'Вся команда'}</h3>
      <p>Сообщения между агентами этого запуска и ваши сообщения агентам. Переписка агентов проходит через маршрутизатор; он же сообщает об изменениях общих файлов.</p>
    </div>
    <label className="communications-filter">
      <input type="checkbox" checked={onlySelected} onChange={event => onToggle(event.target.checked)} />
      <span>{isRouter ? 'Только решения маршрутизатора: подбор адресата и уведомления' : `Только с участием ${agent.name}`}</span>
    </label>
    {!communications.length ? <div className="communications-empty">
      <Icon name="chat" size={26} />
      <p>{onlySelected ? 'У этого агента пока нет переписки.' : 'Агенты ещё не обменивались сообщениями.'}</p>
    </div> : communications.map(message => <CommunicationItem key={message.id} message={message} all={all} />)}
  </div>
}

// A message to the selected agent while the run works: it reads it at its next step, and a finished helper starts again.
// A refusal keeps the text and shows the runtime's reason.
function AgentMessageBox({ run, agent, onMessage }: { run: RunSnapshot; agent: Agent; onMessage: MessageAgent }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    const message = text.trim()
    if (!message || busy) return
    setBusy(true)
    setError('')
    try { await onMessage(run.runId, agent.id, message); setText('') } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }
  return <div className="agent-message">
    {agent.status === 'done' && <p className="agent-message-hint">Агент завершил работу — сообщение запустит его снова</p>}
    {(agent.status === 'paused' || agent.paused) && <p className="agent-message-hint">Агент на паузе — прочитает сообщение после «Продолжить»</p>}
    <form onSubmit={event => { event.preventDefault(); void send() }}>
      <textarea aria-label={`Сообщение агенту ${agent.name}`} placeholder={`Написать ${agent.name}…`} rows={2} value={text} disabled={busy}
        onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
      <button className="send-button" type="submit" aria-label="Отправить агенту" title="Агент получит сообщение на следующем шаге"
        disabled={busy || !text.trim()}><Icon name="arrow" /></button>
    </form>
    {error && <p className="agent-message-error" role="alert">{error}</p>}
  </div>
}

// Pause, resume and stop of one agent; each rejects with the runtime's reason.
export type ControlAgent = (runId: string, agentId: string) => Promise<void>
export type AgentControls = { pause: ControlAgent; resume: ControlAgent; stop: ControlAgent }

// The controls under the tabs (every tab): pause or resume this agent (pausing holds its helpers too), stop for helpers.
// The root is stopped by the chat's Stop, which ends the whole run. A refusal stays under the buttons until the next try.
function AgentControlsBar({ run, agent, controls }: { run: RunSnapshot; agent: Agent; controls: AgentControls }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isRoot = agent.id === 'root'
  // Held by an ancestor's pause, not by its own: it goes on when that one is resumed.
  const holder = agent.status === 'paused' && !agent.paused ? pauseHolder(run.agents, agent) : null
  const act = async (call: ControlAgent) => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await call(run.runId, agent.id) } catch (reason) { setError(errorText(reason)) } finally { setBusy(false) }
  }
  return <div className="agent-controls">
    <div className="agent-controls-buttons">
      <button type="button" disabled={busy} aria-label={`${agent.paused ? 'Продолжить' : 'Пауза'}: ${agent.name}`}
        onClick={() => void act(agent.paused ? controls.resume : controls.pause)}>
        <Icon name={agent.paused ? 'play' : 'pause'} size={14} />{agent.paused ? 'Продолжить' : 'Пауза'}
      </button>
      {!isRoot && <button type="button" className="danger" disabled={busy} aria-label={`Остановить: ${agent.name}`}
        title="Остановить этого помощника и его подагентов; руководитель получит, что он успел сделать" onClick={() => void act(controls.stop)}>
        <Icon name="stop" size={14} />Остановить
      </button>}
    </div>
    {isRoot && <p className="agent-controls-note">Остановить весь запуск — кнопка «Стоп» в чате</p>}
    {holder && <p className="agent-controls-note">На паузе, пока на паузе {holder.name}</p>}
    {error && <p className="agent-message-error" role="alert">{error}</p>}
  </div>
}

type AgentInspectorProps = {
  run: RunSnapshot; agent: Agent; onSelect: (id: string) => void; quotas: Record<string, QuotaSnapshot>; initialTab?: InspectorTab; onMessage: MessageAgent
  controls: AgentControls
}

// One agent of the run, under five tabs: its activity, the team's correspondence, files, changes and the spawn graph.
export function AgentInspector({ run, agent, onSelect, quotas, initialTab, onMessage, controls }: AgentInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>(initialTab || 'activity')
  const [focusPath, setFocusPath] = useState<string | undefined>()
  // Opened from a run's «файлов изменено» button: the changes of the whole team, for the agent first shown.
  const [teamWide, setTeamWide] = useState(initialTab === 'changes')
  const firstAgent = useRef(agent.id)
  const [onlySelected, setOnlySelected] = useState(false)
  const pickTab = (next: InspectorTab) => { setFocusPath(undefined); setTeamWide(false); setTab(next) }
  const changedPaths = useMemo(() => new Set((run.changes || []).map(change => change.path)).size, [run.changes])
  const allMessages = run.communications || []
  // Live events replace `run` many times a second; the file map only changes with the agents' file lists.
  const touched = useMemo(() => fileMap(run.agents).length, [run.agents])
  const tabClass = (id: InspectorTab) => `communication-tab ${tab === id ? 'active' : ''}`
  // The runtime refuses stopped and failed agents, and a root agent that has already answered.
  const canMessage = isActiveStatus(run.status) && agent.id !== 'router' && !['error', 'cancelled', 'interrupted'].includes(agent.status)
    && !(agent.id === 'root' && agent.status === 'done')
  // The runtime refuses pause and stop for an agent that has finished; the router is not an agent that can be held.
  const canControl = canMessage && agent.status !== 'done'
  const body = tab === 'activity'
    ? (agent.id === 'router' ? <RouterActivity run={run} agent={agent} /> : <AgentActivity run={run} agent={agent} quotas={quotas} />)
    : tab === 'graph' ? <AgentGraph agents={run.agents} selectedId={agent.id} onSelect={onSelect} />
    : tab === 'files'
      ? <FilesTab key={agent.id} run={run} agent={agent} onSelect={onSelect} onOpenChanges={path => { setFocusPath(path); setTab('changes') }} />
    : tab === 'changes'
      ? <ChangesTab key={agent.id} run={run} agent={agent} onSelect={onSelect} focusPath={focusPath} teamWide={teamWide && agent.id === firstAgent.current} />
    : <CommunicationsTab run={run} agent={agent} onlySelected={onlySelected} onToggle={setOnlySelected} />
  return <div className="agent-inspector-shell">
    <nav className="inspector-tabs" aria-label="Сведения об агентах">
      <button className={tab === 'activity' ? 'active' : ''} aria-pressed={tab === 'activity'} onClick={() => pickTab('activity')}>Действия</button>
      <button className={tabClass('communications')} aria-label="Переписка" aria-pressed={tab === 'communications'} onClick={() => pickTab('communications')}>
        Переписка{!!allMessages.length && <span>{allMessages.length}</span>}
      </button>
      <button className={tabClass('files')} aria-label="Файлы" aria-pressed={tab === 'files'} onClick={() => pickTab('files')}>
        Файлы{!!touched && <span>{touched}</span>}
      </button>
      <button className={tabClass('changes')} aria-label="Изменения" aria-pressed={tab === 'changes'} onClick={() => pickTab('changes')}>
        Изменения{!!changedPaths && <span>{changedPaths}</span>}
      </button>
      <button className={tab === 'graph' ? 'active' : ''} aria-label="Граф агентов" aria-pressed={tab === 'graph'} onClick={() => pickTab('graph')}>
        Граф
      </button>
    </nav>
    {canControl && <AgentControlsBar key={`controls:${agent.id}`} run={run} agent={agent} controls={controls} />}
    <div className="agent-inspector">
    {body}
    </div>
    {canMessage && <AgentMessageBox key={`message:${agent.id}`} run={run} agent={agent} onMessage={onMessage} />}
  </div>
}
