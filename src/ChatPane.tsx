import { useEffect, useRef } from 'react'
import type { ChatThread, HandoverTarget, InspectorTab, Message, Project, RestartNoticeKind, RunSnapshot, Wakeup } from './types'
import { RunHistory, runChangedFiles } from './AgentHistory'
import { MessageAttachments } from './AttachmentChips'
import { WorkingStatus } from './ChatNotices'
import { Composer, type ComposerProps } from './Composer'
import { Icon } from './Icon'
import { handoverLabel } from './QuotaPanel'
import { Markdown, plural, statusText, timeOf } from './format'
import { loopPhaseText, type LoopView } from './improvement-loop'
import { providers } from './providers'
import { historyAnchors, isActiveStatus, resumeLinks, shortRunId, shownStatus, type RunMap } from './run-events'
import { RESTART_WAIT_TEXT, restartCardDetail, settlingRestart } from './state-store'
import { wakeupChip } from './wakeups'

type OpenTeam = (runId: string, tab?: InspectorTab, agentId?: string) => void
const suggestions = ['Помоги разобраться в проекте', 'Давай обсудим новую функцию', 'Найди, что можно улучшить']
const failedStatuses = ['failed', 'error', 'cancelled', 'interrupted', 'restarting']
const handoverName = (target: HandoverTarget) => handoverLabel(providers, target)
const distanceToBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight
const failureDetail = (run: RunSnapshot, restartOutcome?: RestartNoticeKind) =>
  run.error ? `: ${run.error}`
  : run.status === 'interrupted' ? '. Приложение закрылось во время работы. Можно продолжить новым сообщением.'
  : run.status === 'restarting' ? restartCardDetail(run, restartOutcome) : ''

type ChatPaneProps = {
  project?: Project; chat?: ChatThread; chatKey: string; runs: RunMap; ready: boolean; desktop: boolean
  // restartWait: the chat's agent restarted Orbit and the continuation has not started yet (state-store restartWaits).
  running: boolean; restartWait: boolean; starting: boolean; workingRun?: RunSnapshot; currentRun?: RunSnapshot; agentsOpen: boolean; storageError: string
  composer: ComposerProps
  // The chat's endless-improvement loop while it is active: the banner with its state and actions.
  loop?: LoopView; onStopLoop: () => void; onRunLoopNow: () => void
  // The chat's pending scheduled wake-ups: a chip each, which can be made due now or cancelled.
  wakeups: Wakeup[]; onRunWakeupNow: (id: string) => void; onCancelWakeup: (id: string) => void
  onOpenSidebar: () => void; onToggleAgents: () => void; onOpenAgents: () => void; onOpenTeam: OpenTeam
  onSuggest: (text: string) => void; onAddProject: () => void
}

// Header, notices, the conversation (messages, the answer being written, the team's status) and the composer.
export function ChatPane({
  project, chat, chatKey, runs, ready, desktop, running, restartWait, starting, workingRun, currentRun, agentsOpen, storageError, composer,
  loop, onStopLoop, onRunLoopNow, wakeups, onRunWakeupNow, onCancelWakeup, onOpenSidebar, onToggleAgents, onOpenAgents, onOpenTeam, onSuggest, onAddProject,
}: ChatPaneProps) {
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  // The root agent's answer as it is being written, shown as a chat entry until the final message with the same id lands.
  // A paused root's cut-off turn is lost, so the half-written answer is not shown.
  const rootPaused = !!workingRun?.agents.find(a => a.id === 'root')?.paused
  const streaming = rootPaused ? undefined : workingRun?.streaming
  const stub: Message | undefined = streaming && workingRun && chat &&!chat.messages.some(m => m.id === streaming.messageId)
    ? {
      id: streaming.messageId, author: 'orbit', text: streaming.content, time: streaming.startedAt, runId: workingRun.runId,
      model: workingRun.agents.find(a => a.id === 'root')?.model || workingRun.model,
    }
    : undefined
  const otherActiveChats = Object.values(runs).filter(run => run.projectId === project?.id && run.chatId !== chat?.id && isActiveStatus(run.status)).length
  // Each run's team strip and history hang under its answer, or under the message that opened a run that never answered.
  const historyAnchor = historyAnchors(chat?.messages || [], runs)
  // A run that ended by restarting Orbit links to the run that continued it. Without one, the chat's note of the restart
  // says how it ended, and a rollback turns the card red.
  const continuation = currentRun?.status === 'restarting' ? resumeLinks(runs, currentRun).next : undefined
  const restartOutcome = currentRun?.status === 'restarting' && !continuation && chat ? settlingRestart(chat, currentRun.runId)?.kind : undefined
  const noticeTone = restartOutcome === 'rolled-back' ? 'failed' : currentRun?.status
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
    {loop && <LoopBanner loop={loop} onStop={onStopLoop} onRunNow={onRunLoopNow} />}
    {!!wakeups.length && <WakeupList wakeups={wakeups} loopActive={!!loop} onRunNow={onRunWakeupNow} onCancel={onCancelWakeup} />}
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
        {currentRun && !running && failedStatuses.includes(currentRun.status) && <div className={`run-notice ${noticeTone}`}>
          <span className={`status-dot ${noticeTone}`} />
          <span>{statusText(currentRun.status)}{failureDetail(currentRun, restartOutcome)}</span>
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

// «∞ Бесконечное улучшение · задача N» with its state; stopping lets a working task finish, a waiting retry can start now.
function LoopBanner({ loop, onStop, onRunNow }: { loop: LoopView; onStop: () => void; onRunNow: () => void }) {
  const busy = loop.phase === 'running' || loop.phase === 'restarting'
  return <div className="loop-banner" role="status">
    <span className={`status-dot ${loop.phase === 'retry' || loop.phase === 'waiting' ? 'waiting' : 'working'}`} />
    <span><strong>∞ Бесконечное улучшение · задача {loop.task}</strong> · {loopPhaseText(loop)}</span>
    {loop.phase === 'retry' && <button type="button" onClick={onRunNow}>Запустить сейчас</button>}
    <button type="button" onClick={onStop} title={busy ? 'Текущая задача доработает, следующая не начнётся' : undefined}>
      {busy ? 'Остановить цикл после текущей задачи' : 'Остановить цикл'}
    </button>
  </div>
}

// «⏰ 14:30 — задача» per pending wake-up of the chat. «Сейчас» makes it due (it starts as soon as the chat is idle, and in a chat
// with an active loop releases the loop's next task); the loop's next task does not start before its wake-ups are due.
function WakeupList({ wakeups, loopActive, onRunNow, onCancel }: { wakeups: Wakeup[]; loopActive: boolean; onRunNow: (id: string) => void; onCancel: (id: string) => void }) {
  const now = Date.now()
  return <div className="wakeup-list" role="status">
    {wakeups.map(w => {
      const chip = wakeupChip(w, now, loopActive && !w.manual && w.dueAt > now)
      return <div key={w.id} className={`wakeup-chip${chip.overdue ? ' overdue' : ''}`} title={`${w.reason}\n\n${w.task}`}>
        <span className="wakeup-text">⏰ <strong>{chip.clock}</strong> — {chip.text}{chip.held && <em> · цикл ждёт этого пробуждения</em>}</span>
        <button type="button" onClick={() => onRunNow(w.id)} title="Запустить сразу, как только чат освободится">Сейчас</button>
        <button type="button" onClick={() => onCancel(w.id)}>Отменить</button>
      </div>
    })}
  </div>
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
  const scheduled = message.kind === 'wakeup'
  const author = scheduled ? 'Расписание' : message.author === 'user' ? 'Вы' : message.author === 'system' ? 'Система' : 'Orbit'
  return <article className={`message ${message.author}${streaming ? ' streaming' : ''}`} aria-busy={streaming || undefined}>
    <div className="message-avatar">{scheduled ? '⏰' : message.author === 'user' ? 'В' : message.author === 'system' ? '!' : <span className="tiny-orbit" />}</div>
    <div className="message-content">
      <div className="message-meta">
        <strong>{author}</strong>
        {message.model && <span>{message.model}</span>}
        {message.kind === 'steer' && <span title="Отправлено агенту, пока он работал">во время работы</span>}
        {streaming && <span className="typing-label"><span className="status-dot working" />печатает…</span>}
        <time>{timeOf(message.time)}</time>
      </div>
      {(message.text.trim() || !message.attachments?.length) && <Markdown text={streaming && !message.text.trim() ? 'Формирует ответ…' : message.text} />}
      <MessageAttachments attachments={message.attachments} />
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
      {helpers.slice(0, 5).map(agent => <span key={agent.id} className="team-chip"><span className={`status-dot ${shownStatus(agent)}`} />{agent.name}</span>)}
      {helpers.length > 5 && <span className="team-chip more">+{helpers.length - 5}</span>}
    </button>}
    {!!changed && <button type="button" className="team-files" onClick={() => onOpen(run.runId, 'changes')} title="Открыть изменения этого запуска">
      {plural(changed, ['файл изменён', 'файла изменено', 'файлов изменено'])}
    </button>}
  </div>
}
