import { useEffect, useState } from 'react'
import type { ChatThread, Project, QuotaSnapshot, RuntimeStatus } from './types'
import { Icon } from './Icon'
import type { Panel } from './Modal'
import { errorText, plural } from './format'
import { isActiveStatus, type RunMap } from './run-events'
import { runtimeIndicator } from './runtime-status'
import { RESTART_WAIT_TEXT } from './state-store'

const toneDot = { busy: 'working', done: 'done', error: 'error' } as const

// The runtime process in one line under the sidebar buttons, only while it starts, restarts or is down, and for a few
// seconds after it came back (the line then fades out and a timer removes it).
function RuntimeLine({ status }: { status: RuntimeStatus | null }) {
  const [, setTick] = useState(0)
  const indicator = runtimeIndicator(status)
  const until = indicator?.until
  useEffect(() => {
    if (!until) return
    const timer = window.setTimeout(() => setTick(value => value + 1), Math.max(0, until - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [until])
  if (!indicator) return null
  return <div className={`runtime-label ${indicator.tone}${until ? ' fading' : ''}`} role="status" title={indicator.title}>
    <span className={`status-dot ${toneDot[indicator.tone]}`} /><span>{indicator.text}</span>
  </div>
}

// The project's local index: read when the project changes or a run ends (`revision`), rebuilt on request.
function useProjectIndex(workspace: string | undefined, revision: number, onError: (text: string) => void) {
  const [info, setInfo] = useState<ProjectIndexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const api = window.orbit
    if (!api || !workspace) { setInfo(null); return }
    let mounted = true
    void api.projectIndexStatus(workspace).then(next => { if (mounted) setInfo(next) }).catch(() => { if (mounted) setInfo(null) })
    return () => { mounted = false }
  }, [workspace, revision])
  async function rebuild() {
    if (!window.orbit || !workspace || busy) return
    setBusy(true)
    try { setInfo(await window.orbit.projectIndexStatus(workspace, true)) } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  return { info, busy, rebuild }
}

type SidebarProps = {
  projects: Project[]; project?: Project; chat?: ChatThread; runs: RunMap; pending: Set<string>; restartWaits: ReadonlyMap<string, number>
  ready: boolean; desktop: boolean
  open: boolean; projectMenu: boolean; globalMemoryEnabled: boolean
  quotas: Record<string, QuotaSnapshot>; connected: Record<string, boolean>; providerAvailable: boolean; libraryRevision: number
  runtimeStatus: RuntimeStatus | null
  onClose: () => void; onProjectMenu: (open: boolean) => void; onOpenPanel: (panel: Panel) => void; onNotice: (text: string) => void
  onSelectProject: (projectId: string) => void; onSelectChat: (chatId: string) => void; onCreateChat: () => void
  onDeleteChat: (chatId: string) => void; onGlobalMemory: (enabled: boolean) => void
}

const memoryTitle = 'Общая память для этого проекта. Проектная память доступна всегда. Изменение применяется к новым задачам.'
const indexTitle = 'Локальный индекс проекта: пути, символы, импорты. Агенты ищут по нему командой index_search вместо чтения папок. '
  + 'Нажмите, чтобы переиндексировать.'

// Brand, project picker, the project's memory switch and index, the chat list and the library/settings buttons.
export function Sidebar({
  projects, project, chat, runs, pending, restartWaits, ready, desktop, open, projectMenu, globalMemoryEnabled, quotas, connected, providerAvailable, libraryRevision,
  runtimeStatus, onClose, onProjectMenu, onOpenPanel, onNotice, onSelectProject, onSelectChat, onCreateChat, onDeleteChat, onGlobalMemory,
}: SidebarProps) {
  const index = useProjectIndex(project?.workspace.path, libraryRevision, onNotice)
  // The quota dot summarises the connected subscriptions: any exhausted, any close to the limit, otherwise fine.
  const quotaStates = Object.keys(connected).filter(id => connected[id]).map(id => quotas[id]?.state)
  const quotaDot = quotaStates.includes('exhausted') ? 'error'
    : quotaStates.includes('warning') ? 'waiting' : quotaStates.some(s => s === 'ok') ? 'done' : 'idle'
  const indexText = index.busy || index.info?.indexing ? 'Индексируем…'
    : index.info ? `Индекс: ${plural(index.info.files, ['файл', 'файла', 'файлов'])}` : 'Индекс проекта'
  const workspaceLabel = project?.workspace.connected ? project.workspace.branch || 'Git-репозиторий'
    : project ? 'Локальная папка' : 'Ваше рабочее пространство'
  const isRunning = (chatId: string) => !!project
    && (Object.values(runs).some(r => r.projectId === project.id && r.chatId === chatId && isActiveStatus(r.status)) || pending.has(`${project.id}/${chatId}`))
  // A chat whose agent restarted Orbit is busy until the continuation starts in it (state-store restartWaits).
  const isWaiting = (chatId: string) => !!project && restartWaits.has(`${project.id}/${chatId}`)
  const deleteTitle = (chatId: string) => isWaiting(chatId) ? RESTART_WAIT_TEXT : isRunning(chatId) ? 'Сначала остановите агентов' : 'Удалить чат'
  return <>
    {open && <button className="sidebar-scrim" aria-label="Закрыть меню" onClick={onClose} />}
    <aside className={`sidebar ${open ? 'mobile-open' : ''}`}>
      <div className="brand">
        <span className="brand-mark"><span /></span>
        <span>orbit<span className="brand-dot">.</span></span>
        <span className="brand-caption">workspace</span>
      </div>
      <div className="project-picker">
        <button className="project-button" aria-expanded={projectMenu} onClick={() => onProjectMenu(!projectMenu)}>
          <span className="project-initial">{project?.workspace.name?.[0]?.toUpperCase() || <Icon name="folder" />}</span>
          <span><strong>{project?.workspace.name || 'Выберите проект'}</strong><small>{workspaceLabel}</small></span>
          <Icon name="chevron" size={15} />
        </button>
        {projectMenu && <>
          <button className="dropdown-dismiss" aria-label="Закрыть список проектов" onClick={() => onProjectMenu(false)} />
          <div className="project-dropdown">
            <div className="eyebrow">ПРОЕКТЫ</div>
            {projects.map(p => <button key={p.id} onClick={() => { onSelectProject(p.id); onProjectMenu(false) }}>
              <Icon name="folder" />
              <span><strong>{p.workspace.name}</strong><small title={p.workspace.path}>{p.workspace.path}</small></span>
              {p.id === project?.id && <Icon name="check" size={14} />}
            </button>)}
            <button className="add-project-row" onClick={() => { onOpenPanel('add'); onProjectMenu(false) }}><Icon name="plus" />Добавить проект</button>
          </div>
        </>}
      </div>
      {project && <button type="button" className={`project-memory-toggle memory-toggle ${globalMemoryEnabled ? 'enabled' : ''}`}
        aria-label="Использовать общую память" aria-pressed={globalMemoryEnabled} disabled={!ready} title={memoryTitle}
        onClick={() => onGlobalMemory(!globalMemoryEnabled)}>
        <Icon name="memory" size={14} /><span>Общая память</span><strong>{globalMemoryEnabled ? 'Вкл' : 'Выкл'}</strong>
      </button>}
      {project && desktop && <button type="button" className="project-index-row" disabled={index.busy} title={indexTitle} onClick={() => void index.rebuild()}>
        <Icon name="index" size={14} /><span>{indexText}</span><Icon name="refresh" size={13} />
      </button>}
      <button className="new-chat" onClick={project ? onCreateChat : () => onOpenPanel('add')}>
        <Icon name="plus" />{project ? 'Новый чат' : 'Добавить проект'}<kbd>＋</kbd>
      </button>
      <div className="section-label">ЧАТЫ ПРОЕКТА <span>{project?.chats.length || ''}</span></div>
      <nav className="chat-list" aria-label="Чаты проекта">
        {project?.chats.map(c => <div key={c.id} className="chat-row">
          <button className={`chat-item ${c.id === chat?.id ? 'active' : ''}`} onClick={() => onSelectChat(c.id)}>
            <Icon name="chat" size={16} /><span>{c.title}</span>{(isRunning(c.id) || isWaiting(c.id)) && <span className="status-dot working" />}
          </button>
          <button className="chat-delete" aria-label={`Удалить чат «${c.title}»`} title={deleteTitle(c.id)}
            disabled={isRunning(c.id) || isWaiting(c.id) || !ready} onClick={() => onDeleteChat(c.id)}><Icon name="trash" size={14} /></button>
        </div>)}
        {!project && <p className="sidebar-empty">Подключите папку или репозиторий, чтобы начать.</p>}
      </nav>
      <div className="sidebar-bottom">
        <button onClick={() => onOpenPanel('memory')}><Icon name="memory" />Память</button>
        <button onClick={() => onOpenPanel('capabilities')}><Icon name="skill" />Навыки</button>
        <button onClick={() => onOpenPanel('quota')} title="Остаток квот всех подписок и автозамена агентов">
          <Icon name="gauge" />Квоты<span className={`status-dot ${quotaDot}`} />
        </button>
        <button onClick={() => onOpenPanel('settings')}>
          <Icon name="settings" />Настройки<span className={`status-dot ${providerAvailable ? 'done' : 'idle'}`} />
        </button>
        <div className="local-label"><span className="status-dot idle" />{desktop ? 'История хранится на устройстве' : 'Предпросмотр интерфейса'}</div>
        <RuntimeLine status={runtimeStatus} />
      </div>
    </aside>
  </>
}
