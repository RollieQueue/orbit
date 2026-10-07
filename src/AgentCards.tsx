import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentGalleryItem, AgentProfile, Capability, TrainingRound } from './types'
import './agents.css'
import { Icon } from './Icon'
import { Markdown, errorText } from './format'
import { CHART_PAD, PANEL_TABS, galleryUrl, formatScore, kindLabel, scoreChart, statusLabel, summaryText, trainingSummary } from './agent-view'
import type { PanelTab } from './agent-view'

const dayOf = (time: string) => { const date = new Date(time); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ru-RU') }
const kilobytes = (size: number) => size < 1024 ? `${size} Б` : `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} КБ`

// The two tabs at the top of the Skills panel. Both panels stay mounted (the inactive one is hidden), so a half-edited skill
// or a loaded playbook survives a switch. Arrow keys, Home and End move between the tabs.
export function PanelTabs({ tab, agentCount, onTab, skills, agents }: { tab: PanelTab; agentCount: number; onTab: (tab: PanelTab) => void; skills: ReactNode; agents: ReactNode }) {
  const panels: Record<PanelTab, ReactNode> = { skills, agents }
  function onKeyDown(event: ReactKeyboardEvent) {
    const index = PANEL_TABS.findIndex(item => item.id === tab)
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? PANEL_TABS.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const target = PANEL_TABS[(next + PANEL_TABS.length) % PANEL_TABS.length].id
    onTab(target)
    document.getElementById(`skills-tab-${target}`)?.focus()
  }
  return <>
    <div className="panel-tabs" role="tablist" aria-label="Раздел" onKeyDown={onKeyDown}>
      {PANEL_TABS.map(item => <button key={item.id} type="button" role="tab" id={`skills-tab-${item.id}`} aria-selected={tab === item.id}
        aria-controls={`skills-tabpanel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => onTab(item.id)}>
        {item.id === 'agents' ? `${item.label} (${agentCount})` : item.label}
      </button>)}
    </div>
    {PANEL_TABS.map(item => <div key={item.id} role="tabpanel" id={`skills-tabpanel-${item.id}`} aria-labelledby={`skills-tab-${item.id}`} hidden={tab !== item.id}>
      {panels[item.id]}
    </div>)}
  </>
}

// Score per round, one series on a fixed 0..10 scale.
const CHART = { width: 440, height: 140 }
function ScoreChart({ rounds }: { rounds: readonly TrainingRound[] }) {
  const chart = scoreChart(rounds, CHART.width, CHART.height)
  if (!chart.points.length) return null
  const label = `Оценка по раундам, шкала от 0 до 10: ${chart.points.map(point => `раунд ${point.round} — ${formatScore(point.score)}`).join(', ')}`
  return <svg className="agent-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label={label}>
    {chart.ticks.map(tick => <g key={tick.label}>
      <line className="agent-chart-grid" x1={CHART_PAD.left} x2={CHART.width - CHART_PAD.right} y1={tick.y} y2={tick.y} />
      <text className="agent-chart-label" x={CHART_PAD.left - 6} y={tick.y + 3} textAnchor="end">{tick.label}</text>
    </g>)}
    {chart.xTicks.map(tick => <text key={tick.x} className="agent-chart-label" x={tick.x} y={CHART.height - 6} textAnchor="middle">{tick.label}</text>)}
    {chart.points.length > 1 && <path className="agent-chart-line" d={chart.path} />}
    {chart.points.map(point => <circle key={point.round} className="agent-chart-dot" cx={point.x} cy={point.y} r={3.6}>
      <title>{`Раунд ${point.round}: ${formatScore(point.score)}`}</title>
    </circle>)}
  </svg>
}

function RoundsTable({ rounds }: { rounds: readonly TrainingRound[] }) {
  return <details className="agent-rounds">
    <summary>Раунды обучения ({rounds.length})</summary>
    <div className="agent-rounds-scroll">
      <table>
        <thead><tr><th>№</th><th>Дата</th><th>Понятия</th><th>Оценка</th><th>По критериям</th><th>Судьи</th><th>Заметки</th></tr></thead>
        <tbody>{rounds.map((item, index) => <tr key={`${item.round}-${index}`}>
          <td>{item.round}</td>
          <td>{dayOf(item.at)}</td>
          <td>{(item.concepts ?? []).join(', ')}</td>
          <td className="agent-score">{Number.isFinite(item.score) ? formatScore(item.score) : ''}</td>
          <td>{item.scores && <ul className="agent-criteria">{Object.entries(item.scores).map(([name, value]) => <li key={name}>{name}: {Number.isFinite(value) ? formatScore(value) : value}</li>)}</ul>}</td>
          <td>{!!item.judges?.length && <ul className="agent-judges">{item.judges.map(judge => <li key={judge}>{judge}</li>)}</ul>}</td>
          <td className="agent-notes">{item.notes}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </details>
}

type ImageBox = { url: (file: string) => string; broken: ReadonlySet<string>; onBroken: (file: string) => void }

// A large view of one gallery image: caption, previous and next (arrow keys), Escape, the close button or a click beside the image closes it.
function Lightbox({ items, start, images, onClose }: { items: AgentGalleryItem[]; start: number; images: ImageBox; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef({ index, count: items.length, onClose })
  latest.current = { index, count: items.length, onClose }
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLElement>('.agent-lightbox-close')?.focus()
    const onKey = (event: KeyboardEvent) => {
      const { count, onClose: close } = latest.current
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (event.key === 'Escape') { event.stopPropagation(); close() }
      else if (step && count > 1) { event.preventDefault(); event.stopPropagation(); setIndex(current => (current + step + count) % count) }
      else if (event.key === 'Tab') {
        // Focus stays on the viewer's own buttons.
        event.stopPropagation()
        const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('button') ?? [])
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus() }
  }, [])
  const item = items[index]
  if (!item) return null
  const name = item.caption || item.file
  const missing = images.broken.has(item.file)
  const go = (step: number) => setIndex((index + step + items.length) % items.length)
  return createPortal(<div ref={root} className="agent-lightbox" role="dialog" aria-modal="true" aria-label={`Галерея: ${name}`}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="agent-lightbox-bar">
      <span>{name}</span>
      <small>{index + 1} / {items.length}</small>
      <button type="button" className="icon-button agent-lightbox-close" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="agent-lightbox-stage" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      {items.length > 1 && <button type="button" className="agent-lightbox-nav" aria-label="Предыдущее изображение" onClick={() => go(-1)}>‹</button>}
      {missing ? <div className="agent-missing agent-lightbox-missing" role="img" aria-label={`Не удалось загрузить: ${name}`}><Icon name="image" size={34} /><span>Файл не загрузился</span></div>
        : <img key={item.file} src={images.url(item.file)} alt={name} onError={() => images.onBroken(item.file)} />}
      {items.length > 1 && <button type="button" className="agent-lightbox-nav" aria-label="Следующее изображение" onClick={() => go(1)}>›</button>}
    </div>
    {item.caption && <p className="agent-lightbox-caption">{item.caption}</p>}
  </div>, document.body)
}

// The agent's results as thumbnails of package files (read-only: the window shows them through orbit-skill://).
function Gallery({ packageId, items }: { packageId?: string; items: AgentGalleryItem[] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  if (!items.length) return null
  const images: ImageBox = {
    url: file => packageId ? galleryUrl(packageId, file) : '',
    broken: packageId ? failed : new Set(items.map(item => item.file)),
    onBroken: file => setFailed(current => current.has(file) ? current : new Set(current).add(file)),
  }
  return <section className="agent-gallery" aria-label="Галерея результатов">
    <h4 className="agent-subhead">Галерея ({items.length})</h4>
    <ul>{items.map((item, index) => {
      const name = item.caption || item.file
      return <li key={`${item.file}-${index}`}>
        {images.broken.has(item.file)
          ? <div className="agent-missing" title={`${name}: файл не загрузился`}><Icon name="image" size={22} /><span>Нет файла</span></div>
          : <button type="button" className="agent-thumb" aria-label={`Открыть: ${name}`} title={name} onClick={() => setOpen(index)}>
            <img src={images.url(item.file)} alt={name} loading="lazy" onError={() => images.onBroken(item.file)} />
          </button>}
        <small>{item.caption || item.file}</small>
      </li>
    })}</ul>
    {open !== null && <Lightbox items={items} start={open} images={images} onClose={() => setOpen(null)} />}
  </section>
}

// The playbook (the capability's instructions, up to 40 000 characters) is read on the first opening only.
function Playbook({ entry, workspace, onError }: { entry: Capability; workspace: string; onError: (message: string) => void }) {
  const [detail, setDetail] = useState<Capability | null>(null)
  const [busy, setBusy] = useState(false)
  async function load() {
    if (detail || busy || !window.orbit) return
    setBusy(true)
    try { setDetail(await window.orbit.readCapability(entry.id, workspace)) }
    catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  return <details onToggle={event => { if (event.currentTarget.open) void load() }}>
    <summary>Плейбук</summary>
    {busy && !detail ? <p className="muted">Загружаем…</p> : detail && (detail.instructions.trim() ? <Markdown text={detail.instructions} /> : <p className="muted">Плейбук пуст.</p>)}
    {!busy && !detail && <button className="text-button" onClick={() => void load()}>Повторить загрузку</button>}
  </details>
}

type CardProps = { entry: Capability; agent: AgentProfile; workspace: string; onSaved: () => void; onError: (message: string) => void }

// One trained agent: role and status, defaults, what training did (summary, score chart, rounds), results gallery, playbook, files.
function AgentCard({ entry, agent, workspace, onSaved, onError }: CardProps) {
  const [busy, setBusy] = useState(false)
  const enabled = entry.enabled !== false
  const run = (action: () => Promise<unknown>) => {
    if (!window.orbit || busy) return
    setBusy(true)
    action().then(onSaved).catch(error => onError(errorText(error))).finally(() => setBusy(false))
  }
  async function openFolder() {
    if (!window.orbit || !entry.package) return
    try { const failure = await window.orbit.openPath(entry.package.dir); if (failure) onError(failure) }
    catch (error) { onError(errorText(error)) }
  }
  const summary = trainingSummary(agent)
  const usage = entry.uses ? `Применялся: ${entry.uses} · успешно ${Math.round((entry.reliability ?? 0.5) * 100)}%` : 'Ещё не применялся'
  const scopeLabel = `${entry.pinned ? 'закреплён · ' : ''}${entry.scope === 'global' ? 'Общий' : 'Проект'}${entry.version ? ` · v${entry.version}` : ''}`
  const kind = kindLabel(agent.kind)
  const defaults = [kind && `тип: ${kind}`, agent.reasoningEffort && `усилие: ${agent.reasoningEffort}`].filter(Boolean)
  const rounds = agent.rounds ?? []
  return <article className={`library-entry agent-entry ${entry.pinned ? 'pinned' : ''} ${enabled ? '' : 'disabled'}`}>
    <div>
      <strong>{entry.name}</strong>
      <span className={`agent-status ${agent.status}`}>{statusLabel(agent.status)}</span>
      <span className="scope-label">{scopeLabel}</span>
      <button className="skill-switch" disabled={busy} aria-pressed={enabled} aria-label={`${enabled ? 'Выключить' : 'Включить'} агента ${entry.name}`}
        onClick={() => run(() => window.orbit!.setCapabilityEnabled(entry.id, !enabled, workspace))}>
        <span className="skill-switch-track" aria-hidden="true" />{enabled ? 'Включён' : 'Выключен'}
      </button>
      <button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={`${entry.pinned ? 'Открепить' : 'Закрепить'} агента ${entry.name}`}
        onClick={() => run(() => window.orbit!.pinCapability(entry.id, !entry.pinned, workspace))}><Icon name="pin" size={14} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить агента ${entry.name}`}
        onClick={() => { if (window.confirm(`Удалить агента «${entry.name}»? Его плейбук, файлы и записи обучения будут удалены.`)) run(() => window.orbit!.removeCapability(entry.id, workspace)) }}>
        <Icon name="trash" size={15} />
      </button>
    </div>
    <p>{entry.description || agent.role}</p>
    {entry.whenToUse && <p className="skill-when">Когда применять: {entry.whenToUse}</p>}
    {defaults.length > 0 && <ul className="skill-kinds" aria-label="Настройки агента по умолчанию">{defaults.map(item => <li key={String(item)}>{item}</li>)}</ul>}
    <div className="agent-training">
      <p className="agent-summary">{summaryText(summary)}</p>
      <ScoreChart rounds={rounds} />
    </div>
    {rounds.length > 0 && <RoundsTable rounds={rounds} />}
    <Gallery packageId={entry.package?.id} items={agent.gallery ?? []} />
    <Playbook entry={entry} workspace={workspace} onError={onError} />
    {!!entry.files?.length && <details>
      <summary>Файлы ({entry.files.length})</summary>
      <ul className="skill-list">{entry.files.map(file => <li key={file.path}><code>{file.path}</code><small>{kilobytes(file.size)}</small></li>)}</ul>
    </details>}
    {entry.package && <div className="skill-tools">
      <button className="text-button" title={entry.package.dir} onClick={() => void openFolder()}><Icon name="folder" size={13} /> Открыть папку</button>
    </div>}
    <small className="entry-meta">{usage}</small>
    {!!entry.lessons?.length && <ul className="skill-pitfalls" aria-label="Подводные камни">
      {entry.lessons.slice(0, 3).map(lesson => <li key={lesson}>{lesson}</li>)}
    </ul>}
  </article>
}

// The «Агенты» tab: trained specialists (capabilities with an `agent` field).
export function AgentsTab({ agents, workspace, loading, onSaved, onError }: { agents: Capability[]; workspace: string; loading: boolean; onSaved: () => void; onError: (message: string) => void }) {
  return <>
    <p className="modal-intro">
      Агент — обученный специалист для повторяющихся задач: плейбук, папка с примерами и скриптами, галерея результатов и записи о раундах обучения
      с оценками судей. Orbit запускает такого помощника командой spawn_agent с profile и дописывает ему подводные камни по итогам работы. Общие
      агенты доступны во всех проектах, проектные остаются в своём.
    </p>
    {loading && !agents.length ? <p className="muted">Загружаем агентов…</p> : agents.length
      ? agents.map(entry => entry.agent && <AgentCard key={`${entry.id}-${entry.version}`} entry={entry} agent={entry.agent} workspace={workspace} onSaved={onSaved} onError={onError} />)
      : <div className="empty-library">
        <Icon name="agents" size={28} />
        <p>
          Агентов пока нет. Агент — это обученный специалист: плейбук, папка со скриптами и примерами, галерея результатов и записи о раундах обучения
          с оценками судей. Попросите Orbit натренировать агента, например: «Натренируй агента-3D-моделлера и проверь его судьями» — и он появится
          здесь. Orbit запускает такого помощника командой spawn_agent с profile.
        </p>
      </div>}
  </>
}
