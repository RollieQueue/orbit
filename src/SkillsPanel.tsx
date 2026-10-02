import { useCallback, useEffect, useState } from 'react'
import type { Capability, ConnectorTestResult, ConnectorView, LibraryStats, SkillParam, SkillParamValue } from './types'
import './skill-stage.css'
import { Icon } from './Icon'
import { LibraryForm, TierBar } from './Library'
import { Markdown, errorText } from './format'
import { completionPages } from './skill-triggers'
import { SKILL_ORDERS, groupSkills, parseOrder, sortSkills } from './skill-groups'
import type { SkillOrder } from './skill-groups'

type CardProps = { entry: Capability; workspace: string; onSaved: () => void; onError: (message: string) => void; onPreview?: (skill: Capability) => void }
const dayOf = (time: string) => new Date(time).toLocaleDateString('ru-RU')
const kilobytes = (size: number) => size < 1024 ? `${size} Б` : `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} КБ`

// What the skill is, for the card: any of an instruction, a page shown on a trigger, commands, files.
function kindsOf(entry: Capability): string[] {
  const kinds = ['Инструкция']
  if (completionPages(entry).length) kinds.push('Страница: по завершении задачи')
  if (entry.package && entry.triggers?.some(trigger => trigger.on === 'quota-panel')) kinds.push('Страница: в окне квот')
  if (entry.commands?.length) kinds.push(`Команды: ${entry.commands.length}`)
  if (entry.files?.length) kinds.push(`Файлы: ${entry.files.length}`)
  return kinds
}

// The form holds text; a value is converted to its type only on save, so the user can clear a number field while typing.
function paramValues(params: SkillParam[], draft: Record<string, string | boolean>): Record<string, SkillParamValue> | string {
  const values: Record<string, SkillParamValue> = {}
  for (const param of params) {
    const raw = draft[param.key]
    if (param.type === 'boolean') values[param.key] = raw === true
    else if (param.type === 'number' || param.type === 'seconds') {
      const number = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(number) || (param.type === 'seconds' && number < 0)) return `«${param.label}»: укажите число${param.type === 'seconds' ? ' секунд (не меньше 0)' : ''}.`
      values[param.key] = number
    } else values[param.key] = typeof raw === 'string' ? raw.trim() : ''
  }
  return values
}

function ParamsForm({ entry, workspace, onSaved, onError }: Pick<CardProps, 'entry' | 'workspace' | 'onSaved' | 'onError'>) {
  const params = entry.params ?? []
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(params.map(param => [param.key, param.type === 'boolean' ? param.value === true : String(param.value)])))
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!window.orbit || busy) return
    const values = paramValues(params, draft)
    if (typeof values === 'string') { onError(values); return }
    setBusy(true)
    try { await window.orbit.setCapabilityParams(entry.id, values, workspace); onSaved() }
    catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  const set = (key: string, value: string | boolean) => setDraft(current => ({ ...current, [key]: value }))
  return <div className="skill-params">
    <div className="skill-params-form">
      {params.map(param => {
        const hint = param.hint ? <small>{param.hint}</small> : null
        if (param.type === 'boolean') return <label key={param.key} className="wide check">
          <input type="checkbox" checked={draft[param.key] === true} onChange={event => set(param.key, event.target.checked)} />{param.label}{hint}
        </label>
        const number = param.type === 'number' || param.type === 'seconds'
        return <label key={param.key} className={number ? '' : 'wide'}>{param.label}
          <input type={number ? 'number' : param.type === 'url' ? 'url' : 'text'} min={param.type === 'seconds' ? 0 : undefined} step={number ? 'any' : undefined}
            value={String(draft[param.key] ?? '')} onChange={event => set(param.key, event.target.value)} />{hint}
        </label>
      })}
      <div className="capability-actions"><button className="secondary-button" disabled={busy} onClick={() => void save()}>Сохранить</button></div>
    </div>
  </div>
}

// One skill: what it is (kind badges), its parameters, provenance, use statistics and pitfalls; the instructions load on
// demand and can be edited or rolled back.
function CapabilityCard({ entry, workspace, onSaved, onError, onPreview }: CardProps) {
  const [detail, setDetail] = useState<Capability | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [revision, setRevision] = useState('')
  const enabled = entry.enabled !== false
  async function load() {
    if (detail || busy || !window.orbit) return
    setBusy(true)
    try { const loaded = await window.orbit.readCapability(entry.id, workspace); setDetail(loaded); setInstructions(loaded.instructions) }
    catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  async function mutate(action: 'save' | 'restore' | 'remove') {
    if (!window.orbit || busy) return
    setBusy(true)
    try {
      if (action === 'remove') await window.orbit.removeCapability(entry.id, workspace)
      else if (action === 'restore') await window.orbit.restoreCapability(entry.id, Number(revision), workspace)
      else if (detail) {
        // Only the text fields go back: the files, parameters, triggers and commands stay in the store as they are (the
        // view's file list has sizes, not contents, and would read as an attempt to replace the package).
        const { files, params, triggers, commands, package: pack, revisions, ...text } = detail
        await window.orbit.installCapability({ ...text, instructions: instructions.trim(), source: 'user' })
      }
      onSaved()
    } catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  function pin() {
    setBusy(true)
    window.orbit?.pinCapability(entry.id, !entry.pinned, workspace).then(onSaved).catch(error => onError(errorText(error))).finally(() => setBusy(false))
  }
  function toggle() {
    setBusy(true)
    window.orbit?.setCapabilityEnabled(entry.id, !enabled, workspace).then(onSaved).catch(error => onError(errorText(error))).finally(() => setBusy(false))
  }
  // shell.openPath answers with an error text, empty on success.
  async function openFolder() {
    if (!window.orbit || !entry.package) return
    try { const failure = await window.orbit.openPath(entry.package.dir); if (failure) onError(failure) }
    catch (error) { onError(errorText(error)) }
  }
  const pages = completionPages(entry)
  const usage = entry.uses ? `Применялся: ${entry.uses} · успешно ${Math.round((entry.reliability ?? 0.5) * 100)}%` : pages.length ? 'Срабатывает при завершении задачи' : 'Ещё не применялся'
  const usedIn = entry.scope === 'global' && entry.usedIn?.length ? ` · проектов: ${entry.usedIn.length}` : ''
  const provenance = detail && [
    detail.source === 'user' ? 'Добавлен пользователем' : `Источник: ${detail.source || 'агент'}`,
    detail.editedBy ? ' · улучшен агентом' : '', detail.updatedAt ? ` · ${new Date(detail.updatedAt).toLocaleString('ru-RU')}` : '',
  ].join('')
  const scopeLabel = `${entry.pinned ? 'закреплён · ' : ''}${entry.scope === 'global' ? 'Общий' : 'Проект'}${entry.version ? ` · v${entry.version}` : ''}`
  const pinLabel = `${entry.pinned ? 'Открепить' : 'Закрепить'} навык ${entry.name}`
  const switchLabel = `${enabled ? 'Выключить' : 'Включить'} навык ${entry.name}`
  return <article className={`library-entry ${entry.pinned ? 'pinned' : ''} ${enabled ? '' : 'disabled'}`}>
    <div>
      <strong>{entry.name}</strong>
      <span className="scope-label">{scopeLabel}</span>
      <button className="skill-switch" disabled={busy} aria-pressed={enabled} aria-label={switchLabel} onClick={toggle}>
        <span className="skill-switch-track" aria-hidden="true" />{enabled ? 'Включён' : 'Выключен'}
      </button>
      <button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={pinLabel} onClick={pin}><Icon name="pin" size={14} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить навык ${entry.name}`} onClick={() => void mutate('remove')}>
        <Icon name="trash" size={15} />
      </button>
    </div>
    <p>{entry.description}</p>
    {entry.whenToUse && <p className="skill-when">Когда применять: {entry.whenToUse}</p>}
    <ul className="skill-kinds" aria-label="Из чего состоит навык">{kindsOf(entry).map(kind => <li key={kind}>{kind}</li>)}</ul>
    {!!entry.params?.length && <ParamsForm entry={entry} workspace={workspace} onSaved={onSaved} onError={onError} />}
    {(pages.length > 0 || entry.package) && <div className="skill-tools">
      {pages.length > 0 && <button className="text-button" title="Показывает страницу с сохранёнными параметрами" disabled={!onPreview} onClick={() => onPreview?.(entry)}>Показать</button>}
      {entry.package && <button className="text-button" title={entry.package.dir} onClick={() => void openFolder()}><Icon name="folder" size={13} /> Открыть папку</button>}
    </div>}
    {!!entry.files?.length && <details>
      <summary>Файлы ({entry.files.length})</summary>
      <ul className="skill-list">{entry.files.map(file => <li key={file.path}><code>{file.path}</code><small>{kilobytes(file.size)}</small></li>)}</ul>
    </details>}
    {!!entry.commands?.length && <details>
      <summary>Команды ({entry.commands.length})</summary>
      <ul className="skill-list">{entry.commands.map(command => <li key={command.name}>
        <code>{command.name}</code>{command.description && <small>{command.description}</small>}<br /><code>{command.run}</code>
      </li>)}</ul>
    </details>}
    <small className="entry-meta">{usage}{usedIn}</small>
    {!!entry.lessons?.length && <ul className="skill-pitfalls" aria-label="Подводные камни">
      {entry.lessons.slice(0, 3).map(lesson => <li key={lesson}>{lesson}</li>)}
    </ul>}
    <details onToggle={event => { if (event.currentTarget.open) void load() }}>
      <summary>Инструкции и версии</summary>
      {busy && !detail ? <p className="muted">Загружаем…</p> : detail && <>
        <div className="capability-provenance">{provenance}</div>
        {editing ? <>
          <textarea aria-label="Инструкции навыка" rows={8} value={instructions} onChange={event => setInstructions(event.target.value)} />
          <div className="capability-actions">
            <button className="text-button" onClick={() => { setEditing(false); setInstructions(detail.instructions) }}>Отмена</button>
            <button className="secondary-button" disabled={busy || !instructions.trim()} onClick={() => void mutate('save')}>Сохранить новую версию</button>
          </div>
        </> : <>
          <Markdown text={detail.instructions} />
          <button className="text-button" onClick={() => setEditing(true)}>Редактировать</button>
        </>}
        {!!detail.revisions?.length && <div className="revision-controls">
          <select aria-label="Предыдущая версия навыка" value={revision} onChange={event => setRevision(event.target.value)}>
            <option value="">Предыдущие версии</option>
            {[...detail.revisions].reverse().map(item => <option key={item.version} value={item.version}>v{item.version} · {dayOf(item.updatedAt)}</option>)}
          </select>
          <button className="text-button" disabled={busy || !revision} onClick={() => void mutate('restore')}>Восстановить</button>
        </div>}
      </>}
      {!busy && !detail && <button className="text-button" onClick={() => void load()}>Повторить загрузку</button>}
    </details>
  </article>
}

// One connector (an external MCP server an agent added with connector_add): what it is, where it runs, switch, test, remove.
// Env and header values never reach the window; the view holds their names only.
function ConnectorCard({ connector, workspace, onChanged, onError }: { connector: ConnectorView; workspace: string; onChanged: () => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<ConnectorTestResult | null>(null)
  const run = async (action: () => Promise<unknown>, changed: boolean) => {
    if (!window.orbit || busy) return
    setBusy(true)
    try { await action(); if (changed) onChanged() }
    catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  const switchLabel = `${connector.enabled ? 'Выключить' : 'Включить'} коннектор ${connector.name}`
  const where = connector.transport === 'http' ? connector.url : [connector.command, ...(connector.args ?? [])].join(' ')
  const secrets = connector.transport === 'http' ? connector.headerNames : connector.envKeys
  return <article className={`library-entry connector-entry ${connector.enabled ? '' : 'disabled'}`}>
    <div>
      <strong>{connector.name}</strong>
      <span className="scope-label">{connector.scope === 'global' ? 'Общий' : 'Проект'}{connector.shadowedBy ? ' · скрыт одноимённым проектным' : ''}</span>
      <button className="skill-switch" disabled={busy} aria-pressed={connector.enabled} aria-label={switchLabel}
        onClick={() => void run(() => window.orbit!.setConnectorEnabled(connector.name, !connector.enabled, connector.scope, workspace), true)}>
        <span className="skill-switch-track" aria-hidden="true" />{connector.enabled ? 'Включён' : 'Выключен'}
      </button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить коннектор ${connector.name}`}
        onClick={() => { if (window.confirm(`Удалить коннектор «${connector.name}»? Он перестанет передаваться агентам.`)) void run(() => window.orbit!.removeConnector(connector.name, connector.scope, workspace), true) }}>
        <Icon name="trash" size={15} />
      </button>
    </div>
    <p>{connector.description}</p>
    <ul className="skill-kinds" aria-label="Подключение коннектора">
      <li>{connector.transport === 'http' ? 'HTTP' : 'Команда (stdio)'}</li>
      {!!secrets?.length && <li>{connector.transport === 'http' ? 'Заголовки' : 'Переменные'}: {secrets.join(', ')}</li>}
    </ul>
    <small className="entry-meta connector-where"><code>{where}</code></small>
    <div className="skill-tools">
      <button className="text-button" disabled={busy} title="Запускает сервер и просит у него список инструментов"
        onClick={() => void run(async () => setTest(await window.orbit!.testConnector(connector.name, connector.scope, workspace)), false)}>{busy ? 'Подождите…' : 'Проверить'}</button>
      {test && <small className={test.ok ? 'connector-ok' : 'connector-fail'} role="status">
        {test.ok ? `Работает: инструментов ${test.tools?.length ?? 0}${test.server ? ` · ${test.server}` : ''}` : `Не запускается: ${test.error ?? 'нет ответа'}`}
      </small>}
    </div>
    <small className="entry-meta">Добавлен: {dayOf(connector.addedAt)}</small>
  </article>
}

type SkillsPanelProps = {
  desktop: boolean; workspace: string; skills: Capability[]; stats: LibraryStats | null; loading: boolean
  onChanged: () => void; onError: (message: string) => void; onPreview?: (skill: Capability) => void
}

const ORDER_KEY = 'orbit.skills.order'
const loadOrder = (): SkillOrder => { try { return parseOrder(window.localStorage.getItem(ORDER_KEY)) } catch { return 'type' } }

// Project and shared skills and the connectors. By type (the default): headed groups of what Orbit built for itself;
// otherwise one list, pinned first, then by use or by date, with the connectors in a section of their own on top.
export function SkillsPanel({ desktop, workspace, skills, stats, loading, onChanged, onError, onPreview }: SkillsPanelProps) {
  const [order, setOrder] = useState<SkillOrder>(loadOrder)
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(null)
  const loadConnectors = useCallback(() => {
    if (!desktop || !window.orbit) return
    window.orbit.listConnectors(workspace).then(setConnectors).catch(error => onError(errorText(error)))
  }, [desktop, workspace, onError])
  useEffect(loadConnectors, [loadConnectors])
  if (!desktop) return <p className="inline-notice">Навыки доступны в настольном приложении.</p>
  const chooseOrder = (value: string) => {
    const next = parseOrder(value)
    setOrder(next)
    try { window.localStorage.setItem(ORDER_KEY, next) } catch { /* the choice is not kept */ }
  }
  const tiers = stats && [
    { name: 'Проект', stat: stats.skills.project }, { name: 'Общие', stat: stats.skills.global }, { name: 'Применялись', text: String(stats.skills.used) },
  ]
  const skillCard = (entry: Capability) =>
    <CapabilityCard key={`${entry.id}-${entry.version}-${entry.uses}-${entry.pinned}-${entry.enabled}-${entry.params?.map(param => String(param.value)).join('|')}`} entry={entry} workspace={workspace}
      onSaved={onChanged} onError={onError} onPreview={onPreview} />
  const connectorCards = connectors === null ? <p className="muted">Загружаем коннекторы…</p> : connectors.length
    ? connectors.map(connector => <ConnectorCard key={`${connector.scope}-${connector.name}-${connector.enabled}`} connector={connector} workspace={workspace} onChanged={loadConnectors} onError={onError} />)
    : <p className="muted">Коннекторов нет: агент добавляет внешние серверы MCP (браузер, базы данных, GitHub) командой connector_add.</p>
  return <>
    <p className="modal-intro">
      Навык — надстройка, которую Orbit делает себе сам, в любой форме: проверенная процедура (например, поднять изолированное окружение), страница
      с анимацией по завершении задачи, набор скриптов и команд. Инструкции агент находит по задаче, применяет, оценивает результат и дописывает подводные
      камни; параметры страниц вы меняете здесь. Общие навыки доступны во всех проектах, проектные остаются в своём.
    </p>
    {tiers && <TierBar items={tiers} />}
    <LibraryForm kind="capability" workspace={workspace} onSaved={onChanged} onError={onError} />
    <label className="skill-order">Порядок
      <select aria-label="Порядок навыков" value={order} onChange={event => chooseOrder(event.target.value)}>
        {SKILL_ORDERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    {order !== 'type' && <section className="skill-group" aria-label="Коннекторы">
      <h3 className="section-label">Инструменты: коннекторы<span>{connectors?.length ?? 0}</span></h3>
      {connectorCards}
    </section>}
    {loading ? <p className="muted">Загружаем навыки…</p> : order === 'type' ? groupSkills(skills, connectors?.length ?? 0).map(group =>
      <section key={group.id} className="skill-group" aria-label={group.title}>
        <h3 className="section-label">{group.title}<span>{group.count}</span></h3>
        {group.id === 'tools' && connectorCards}
        {group.skills.map(skillCard)}
      </section>,
    ) : skills.length ? sortSkills(skills, order).map(skillCard) : <div className="empty-library">
      <Icon name="skill" size={28} />
      <p>Навыков пока нет. Агент создаёт их по мере работы, когда находит повторяемую процедуру; вы также можете добавить свой.</p>
    </div>}
  </>
}
