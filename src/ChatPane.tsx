import { useEffect, useRef } from 'react'
import type { ChatThread, HandoverTarget, InspectorTab, Message, Project, RunSnapshot } from './types'
import { RunHistory, runChangedFiles } from './AgentHistory'
import { WorkingStatus } from './ChatNotices'
import { Composer, type ComposerProps } from './Composer'
import { Icon } from './Icon'
import { handoverLabel } from './QuotaPanel'
import { Markdown, plural, statusText, timeOf } from './format'
import { providers } from './providers'
import { historyAnchors, isActiveStatus, resumeLinks, shortRunId, type RunMap } from './run-events'
import { RESTART_WAIT_TEXT } from './state-store'

type OpenTeam = (runId: string, tab?: InspectorTab, agentId?: string) => void
const suggestions = ['Помоги разобраться в проекте', 'Давай обсудим новую функцию', 'Найди, что можно улучшить']
const failedStatuses = ['failed', 'error', 'cancelled', 'interrupted', 'restarting']
const handoverName = (target: HandoverTarget) => handoverLabel(providers, target)
const distanceToBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight
const failureDetail = (run: RunSnapshot) =>
  run.error ? `: ${run.error}`
  : run.status === 'interrupted' ? '. Приложение закрылось во время работы. Можно продолжить новым сообщением.'
  : run.status === 'restarting' ? `. Агент перезапустил Orbit${run.restart?.reason ? `: ${run.restart.reason}` : ''}.` : ''

type ChatPaneProps = {
  project?: Project; chat?: ChatThread; chatKey: string; runs: RunMap; ready: boolean; desktop: boolean
  // restartWait: the chat's agent restarted Orbit and the continuation has not started yet (state-store restartWaits).
  running: boolean; restartWait: boolean; starting: boolean; workingRun?: RunSnapshot; currentRun?: RunSnapshot; agentsOpen: boolean; storageError: string
  composer: ComposerProps
  onOpenSidebar: () => void; onToggleAgents: () => void; onOpenAgents: () => void; onOpenTeam: OpenTeam
  onSuggest: (text: string) => void; onAddProject: () => void
}

// Header, notices, the conversation (messages, the answer being written, the team's status) and the composer.
export function ChatPane({
  project, chat, chatKey, runs, ready, desktop, running, restartWait, starting, workingRun, currentRun, agentsOpen, storageError, composer,
  onOpenSidebar, onToggleAgents, onOpenAgents, onOpenTeam, onSuggest, onAddProject,
}: ChatPaneProps) {
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  // The root agent's answer as it is being written, shown as a chat entry until the final message with the same id lands.
  const streaming = workingRun?.streaming
  const stub: Message | undefined = streaming && chat && !chat.messages.some(m => m.id === streaming.messageId)
    ? {
      id: streaming.messageId, author: 'orbit', text: streaming.content, time: streaming.startedAt, runId: workingRun.runId,
      model: workingRun.agents.find(a => a.id === 'root')?.model || workingRun.model,
    }
    : undefined
  const otherActiveChats = Object.values(runs).filter(run => run.projectId === project?.id && run.chatId !== chat?.id && isActiveStatus(run.status)).length
  // Each run's team strip and history hang under its answer, or under the message that opened a run that never answered.
  const historyAnchor = historyAnchors(chat?.messages || [], runs)
  // A run that ended by restarting Orbit links to the run that continued it.
  const continuation = currentRun?.status === 'restarting' ? resumeLinks(runs, currentRun).next : undefined
  useEffect(() => { nearBottom.current = true; bottom.current?.scrollIntoView({ behavior: 'instant' }) }, [chatKey])
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages.length, running])
  // A growing answer keeps the view pinned to the bottom, without the smooth scroll that would stutter several times a second.
  useEffect(() => { if (nearBottom.current && streaming) bottom.current?.scrollIntoView({ behavior: 'instant' }) }, [streaming?.content.length])
  // A sent message pins the view to the bottom again.
  const submit = () => { const accepted = composer.onSend(); if (accepted) nearBottom.current = true; return accepted }
  return <main className="main-pane">
    <header className="chat-header">
      <button className="icon-button mobile-menu" title="Открыть меню" onClick={onOpenSidebar}><Icon name="menu" /></button>
      <div className="chat-heading">
        <span>{project?.workspace.name || 'Ваше пространство'}</span><span className="header-slash">/</span><strong>{chat?.title || 'Начало работы'}</strong>
      </div>
      <button className={`agents-toggle ${agentsOpen ? 'active' : ''}`} onClick={onToggleAgents} aria-expanded={agentsOpen}>
        <Icon name="agents" size={17} /><span>Агенты</span>{!!currentRun?.agents.length && <b>{currentRun.agents.length}</b>}
      </button>
    </header>
    {!desktop && <div className="preview-banner">
      <Icon name="terminal" size={16} /><span>Предпросмотр. Подключение проектов и работа агентов доступны в настольном Orbit.</span>
    </div>}
    {storageError && <div className="error-banner" role="alert">{storageError}</div>}
    {!!otherActiveChats && <div className="parallel-chat-notice" role="status">
      Других активных чатов в проекте: {otherActiveChats}. Файлы общие — поручайте изменения разных участков.
    </div>}
    <div className="conversation" onScroll={event => { nearBottom.current = distanceToBottom(event.currentTarget) < 100 }}>
      {!chat?.messages.length ? <Welcome project={project} desktop={desktop} onSuggest={onSuggest} onAddProject={onAddProject} />
      : <div className="message-list">
        {[...chat.messages, ...(stub ? [stub] : [])].map(message => <ChatMessage key={message.id} message={message}
          run={message.runId ? runs[message.runId] : undefined} anchored={!!message.runId && historyAnchor.get(message.runId) === message.id}
          loaded={ready} streaming={message === stub} onOpen={onOpenTeam} />)}
        {running && <WorkingStatus run={workingRun} starting={starting && !workingRun} label={handoverName}>
          <button onClick={() => workingRun ? onOpenTeam(workingRun.runId) : onOpenAgents()}>Посмотреть действия <Icon name="agents" size={14} /></button>
        </WorkingStatus>}
        {currentRun && !running && failedStatuses.includes(currentRun.status) && <div className={`run-notice ${currentRun.status}`}>
          <span className={`status-dot ${currentRun.status}`} />
          <span>{statusText(currentRun.status)}{failureDetail(currentRun)}</span>
          {continuation && <button onClick={() => onOpenTeam(continuation.runId)}>Продолжен в {shortRunId(continuation.runId)}</button>}
          <button onClick={onOpenAgents}>Подробности</button>
        </div>}
        {restartWait && !running && <div className="working-indicator" role="status"><span className="status-dot working" /><span>{RESTART_WAIT_TEXT}</span></div>}
      </div>}
      <div ref={bottom} />
    </div>
    <Composer {...composer} onSend={submit} />
  </main>
}

type WelcomeProps = { project?: Project; desktop: boolean; onSuggest: (text: string) => void; onAddProject: () => void }

function Welcome({ project, desktop, onSuggest, onAddProject }: WelcomeProps) {
  return <div className="welcome">
    <div className="welcome-symbol"><span className="brand-mark"><span /></span></div>
    <div className="eyebrow">{project ? 'ПРОСТРАНСТВО ДЛЯ ВАШИХ ИДЕЙ' : 'ОДИН АГЕНТ. ВАШИ ПРОЕКТЫ.'}</div>
    <h1>{project ? 'Над чем поработаем?' : 'Начните с проекта.'}</h1>
    <p>{project
      ? 'Обсудите идею, задайте вопрос или поручите задачу. Агент сам выберет подход и подключит помощников, когда это полезно.'
      : 'Подключите локальную папку или Git-репозиторий. Чаты, память и работа агентов останутся в контексте проекта.'}</p>
    {project
      ? <div className="prompt-suggestions">
        {suggestions.map(text => <button key={text} disabled={!desktop} onClick={() => onSuggest(text)}>{text}<Icon name="arrow" size={14} /></button>)}
      </div>
      : <button className="primary-button" onClick={onAddProject}><Icon name="plus" />Подключить проект</button>}
    <div className="welcome-footnote">Отдельные чаты · Общая и проектная память · Агенты по задаче</div>
  </div>
}

// One chat entry. A streaming entry is the root agent's answer being written; it carries the id of the final message,
// so when that message lands React updates the same element instead of adding a second one.
function ChatMessage({ message, run, anchored, loaded, streaming, onOpen }: {
  message: Message; run?: RunSnapshot; anchored: boolean; loaded: boolean; streaming?: boolean; onOpen: OpenTeam
}) {
  const author = message.author === 'user' ? 'Вы' : message.author === 'system' ? 'Система' : 'Orbit'
  return <article className={`message ${message.author}${streaming ? ' streaming' : ''}`} aria-busy={streaming || undefined}>
    <div className="message-avatar">{message.author === 'user' ? 'В' : message.author === 'system' ? '!' : <span className="tiny-orbit" />}</div>
    <div className="message-content">
      <div className="message-meta">
        <strong>{author}</strong>
        {message.model && <span>{message.model}</span>}
        {streaming && <span className="typing-label"><span className="status-dot working" />печатает…</span>}
        <time>{timeOf(message.time)}</time>
      </div>
      <Markdown text={streaming && !message.text.trim() ? 'Формирует ответ…' : message.text} />
      {anchored && <><TeamStrip run={run} onOpen={onOpen} /><RunHistory run={run} loaded={loaded} onOpen={onOpen} /></>}
    </div>
  </article>
}

function TeamStrip({ run, onOpen }: { run?: RunSnapshot; onOpen: (runId: string, tab?: InspectorTab) => void }) {
  const helpers = (run?.agents || []).filter(agent => agent.id !== 'root')
  const changed = runChangedFiles(run)
  if (!run || (!helpers.length && !changed)) return null
  return <div className="team-strip">
    {!!helpers.length && <button type="button" className="team-strip-open" onClick={() => onOpen(run.runId)}
      title="Открыть команду этого запуска: действия, переписку и файлы">
      <span className="team-strip-title"><Icon name="agents" size={13} />Команда · {helpers.length}</span>
      {helpers.slice(0, 5).map(agent => <span key={agent.id} className="team-chip"><span className={`status-dot ${agent.status}`} />{agent.name}</span>)}
      {helpers.length > 5 && <span className="team-chip more">+{helpers.length - 5}</span>}
    </button>}
    {!!changed && <button type="button" className="team-files" onClick={() => onOpen(run.runId, 'changes')} title="Открыть изменения этого запуска">
      {plural(changed, ['файл изменён', 'файла изменено', 'файлов изменено'])}
    </button>}
  </div>
}
