import { useState } from 'react'
import type { Capability, LibraryStats } from './types'
import { Icon } from './Icon'
import { LibraryForm, TierBar } from './Library'
import { Markdown, errorText } from './format'

type CardProps = { entry: Capability; workspace: string; onSaved: () => void; onError: (message: string) => void }
const dayOf = (time: string) => new Date(time).toLocaleDateString('ru-RU')

// One skill: its provenance, use statistics and pitfalls; the instructions load on demand and can be edited or rolled back.
function CapabilityCard({ entry, workspace, onSaved, onError }: CardProps) {
  const [detail, setDetail] = useState<Capability | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [revision, setRevision] = useState('')
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
      else if (detail) await window.orbit.installCapability({ ...detail, instructions: instructions.trim(), source: 'user' })
      onSaved()
    } catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  function pin() {
    setBusy(true)
    window.orbit?.pinCapability(entry.id, !entry.pinned, workspace).then(onSaved).catch(error => onError(errorText(error))).finally(() => setBusy(false))
  }
  const usage = entry.uses ? `Применялся: ${entry.uses} · успешно ${Math.round((entry.reliability ?? 0.5) * 100)}%` : 'Ещё не применялся'
  const usedIn = entry.scope === 'global' && entry.usedIn?.length ? ` · проектов: ${entry.usedIn.length}` : ''
  const provenance = detail && [
    detail.source === 'user' ? 'Добавлен пользователем' : `Источник: ${detail.source || 'агент'}`,
    detail.editedBy ? ' · улучшен агентом' : '', detail.updatedAt ? ` · ${new Date(detail.updatedAt).toLocaleString('ru-RU')}` : '',
  ].join('')
  const scopeLabel = `${entry.pinned ? 'закреплён · ' : ''}${entry.scope === 'global' ? 'Общий' : 'Проект'}${entry.version ? ` · v${entry.version}` : ''}`
  const pinLabel = `${entry.pinned ? 'Открепить' : 'Закрепить'} навык ${entry.name}`
  return <article className={`library-entry ${entry.pinned ? 'pinned' : ''}`}>
    <div>
      <strong>{entry.name}</strong>
      <span className="scope-label">{scopeLabel}</span>
      <button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={pinLabel} onClick={pin}><Icon name="pin" size={14} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить навык ${entry.name}`} onClick={() => void mutate('remove')}>
        <Icon name="trash" size={15} />
      </button>
    </div>
    <p>{entry.description}</p>
    {entry.whenToUse && <p className="skill-when">Когда применять: {entry.whenToUse}</p>}
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

type SkillsPanelProps = {
  desktop: boolean; workspace: string; skills: Capability[]; stats: LibraryStats | null; loading: boolean
  onChanged: () => void; onError: (message: string) => void
}

// Project and shared skills, pinned ones first, then by use.
export function SkillsPanel({ desktop, workspace, skills, stats, loading, onChanged, onError }: SkillsPanelProps) {
  if (!desktop) return <p className="inline-notice">Навыки доступны в настольном приложении.</p>
  const ordered = [...skills].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.uses ?? 0) - (a.uses ?? 0))
  const tiers = stats && [
    { name: 'Проект', stat: stats.skills.project }, { name: 'Общие', stat: stats.skills.global }, { name: 'Применялись', text: String(stats.skills.used) },
  ]
  return <>
    <p className="modal-intro">
      Навык — проверенная процедура, которой агент научился в работе, например поднять изолированное окружение. Агент находит подходящий навык по задаче,
      применяет его, оценивает результат и дописывает подводные камни, так что набор растёт и улучшается сам. Общие навыки доступны во всех проектах,
      проектные остаются в своём.
    </p>
    {tiers && <TierBar items={tiers} />}
    <LibraryForm kind="capability" workspace={workspace} onSaved={onChanged} onError={onError} />
    {loading ? <p className="muted">Загружаем навыки…</p> : ordered.length ? ordered.map(entry =>
      <CapabilityCard key={`${entry.id}-${entry.version}-${entry.uses}-${entry.pinned}`} entry={entry} workspace={workspace}
        onSaved={onChanged} onError={onError} />,
    ) : <div className="empty-library">
      <Icon name="skill" size={28} />
      <p>Навыков пока нет. Агент создаёт их по мере работы, когда находит повторяемую процедуру; вы также можете добавить свой.</p>
    </div>}
  </>
}
