import { useState } from 'react'
import type { ChatThread, LibraryStats, MemoryEntry, MemoryScope, Project } from './types'
import { Icon } from './Icon'
import { LibraryForm, TIER_NAMES, TierBar } from './Library'
import { errorText } from './format'

const scopes = ['chat', 'project', 'global'] as const
const sourceLabel = (source?: string) =>
  source === 'user' ? 'вы' : source === 'promoted' ? 'поднято автоматически' : source === 'system' ? 'система' : 'агент'

type CardProps = { entry: MemoryEntry; workspace: string; chatId?: string; onChanged: () => void; onError: (message: string) => void }

function MemoryCard({ entry, workspace, chatId, onChanged, onError }: CardProps) {
  const [busy, setBusy] = useState(false)
  async function act(action: () => Promise<unknown>) {
    if (busy || !window.orbit) return
    setBusy(true)
    try { await action(); onChanged() } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  const pinLabel = `${entry.pinned ? 'Открепить' : 'Закрепить'} запись ${entry.title}`
  return <article className={`library-entry ${entry.pinned ? 'pinned' : ''}`}>
    <div>
      <strong>{entry.title}</strong>
      <span className="scope-label">{entry.pinned ? 'закреплено · ' : ''}{sourceLabel(entry.source)}</span>
      <button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={pinLabel}
        onClick={() => void act(() => window.orbit!.pinMemory(entry.id, !entry.pinned, workspace, chatId))}><Icon name="pin" size={14} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить запись ${entry.title}`}
        onClick={() => void act(() => window.orbit!.removeMemory(entry.id, workspace, chatId))}><Icon name="trash" size={15} /></button>
    </div>
    <p>{entry.content}</p>
    <small className="entry-meta">
      {entry.uses ? `Использована: ${entry.uses}` : 'Ещё не использовалась'} · {new Date(entry.updated).toLocaleDateString('ru-RU')}
    </small>
  </article>
}

type MemoryPanelProps = {
  desktop: boolean; project?: Project; chat?: ChatThread; entries: MemoryEntry[]; stats: LibraryStats | null; loading: boolean
  onChanged: () => void; onError: (message: string) => void
}

// The three memory tiers of the current chat and project, with the user's own entries and the pin/delete controls.
export function MemoryPanel({ desktop, project, chat, entries, stats, loading, onChanged, onError }: MemoryPanelProps) {
  const workspace = project?.workspace.path || ''
  if (!desktop) return <p className="inline-notice">Память доступна в настольном приложении.</p>
  const groupTitle: Record<MemoryScope, string> = {
    chat: `ЧАТ · ${chat?.title || 'НЕ ВЫБРАН'}`, project: `ПРОЕКТ · ${project?.workspace.name || 'НЕ ВЫБРАН'}`, global: 'ОБЩАЯ ПАМЯТЬ',
  }
  return <>
    <p className="modal-intro">
      Три уровня. <b>Чат</b> — рабочие заметки этой задачи. <b>Проект</b> — знания о коде, общие для всех его чатов. <b>Общая</b> — то, что верно во
      всех проектах. Записи, к которым агенты не возвращаются, устаревают и вытесняются сами; то, что чат использовал снова и снова, поднимается в
      проект. Детали проекта в общую память не попадают.
    </p>
    {stats && <TierBar items={scopes.map(scope => ({ name: TIER_NAMES[scope], stat: stats.memory[scope] }))} />}
    <LibraryForm kind="memory" workspace={workspace} chatId={chat?.id} onSaved={onChanged} onError={onError} />
    {loading ? <p className="muted">Загружаем записи…</p> : entries.length ? scopes.map(scope => {
      const group = entries.filter(entry => entry.scope === scope)
      if (!group.length && scope === 'chat') return null
      return <div key={scope} className="library-group">
        <div className="section-label">{groupTitle[scope]}<span>{group.length}</span></div>
        {group.map(entry => <MemoryCard key={entry.id} entry={entry} workspace={workspace} chatId={chat?.id} onChanged={onChanged} onError={onError} />)}
      </div>
    }) : <div className="empty-library">
      <Icon name="memory" size={28} />
      <p>Память пока пуста. Добавьте важный контекст или попросите агента его запомнить.</p>
    </div>}
  </>
}
