import { useEffect, useState, type FormEvent } from 'react'
import type { Capability, LibraryStats, MemoryEntry, MemoryScope, TierStats } from './types'
import { Icon } from './Icon'
import type { Panel } from './Modal'
import { errorText } from './format'
import { now, uid } from './state-store'

// Memory entries, skills and the tier statistics, loaded together while either library panel is open and again when a
// run ends (`revision`) or a card changes something.
export function useLibrary(panel: Panel | null, workspace: string, chatId: string | undefined, revision: number, onError: (text: string) => void) {
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (panel !== 'memory' && panel !== 'capabilities') return
    const api = window.orbit
    if (!api) return
    let mounted = true
    setLoading(true)
    setMemory([]); setCapabilities([]); setStats(null)
    void Promise.all([api.listMemory(workspace, chatId), api.listCapabilities(workspace), api.memoryStats(workspace, chatId)])
      .then(([entries, skills, next]) => { if (mounted) { setMemory(entries); setCapabilities(skills); setStats(next) } })
      .catch(error => { if (mounted) onError(errorText(error)) })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [panel, workspace, chatId, revision])
  return { memory, capabilities, stats, loading }
}

export const TIER_NAMES: Record<MemoryScope, string> = { chat: 'Чат', project: 'Проект', global: 'Общая' }
export function TierBar({ items }: { items: { name: string; stat?: TierStats; text?: string }[] }) {
  return <div className="tier-stats" role="status">
    {items.map(item => <span key={item.name} className={item.stat && item.stat.count >= item.stat.limit ? 'full' : ''}>
      <strong>{item.name}</strong> {item.text ?? `${item.stat?.count ?? 0}/${item.stat?.limit ?? 0}`}
    </span>)}
  </div>
}

type LibraryFormProps = { kind: 'memory' | 'capability'; workspace: string; chatId?: string; onSaved: () => void; onError: (message: string) => void }

// A new memory entry or a new skill written by the user, with its scope.
export function LibraryForm({ kind, workspace, chatId, onSaved, onError }: LibraryFormProps) {
  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<MemoryScope>(workspace ? 'project' : 'global')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || !content.trim() || !window.orbit) return
    setBusy(true)
    try {
      if (kind === 'memory') {
        await window.orbit.saveMemory({
          id: uid(), title: title.trim(), content: content.trim(), type: 'fact', scope, workspace: scope === 'global' ? undefined : workspace,
          chatId: scope === 'chat' ? chatId : undefined, updated: now(), confidence: 100,
        })
      } else {
        await window.orbit.installCapability({
          name: title.trim(), description: content.trim().split('\n')[0].slice(0, 200), instructions: content.trim(),
          scope: scope === 'global' ? 'global' : 'project', workspace: scope === 'global' ? undefined : workspace, source: 'user',
        })
      }
      setTitle(''); setContent(''); setExpanded(false); onSaved()
    } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="library-form">
    {!expanded ? <button className="secondary-button" onClick={() => setExpanded(true)}>
      <Icon name="plus" size={16} />{kind === 'memory' ? 'Добавить запись' : 'Добавить навык'}
    </button> : <form onSubmit={submit}>
      <label>Название<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} /></label>
      <label>{kind === 'memory' ? 'Что нужно запомнить' : 'Инструкции навыка'}
        <textarea rows={4} value={content} onChange={event => setContent(event.target.value)} required />
      </label>
      <div className="form-actions">
        <select aria-label="Область действия" value={scope} onChange={event => setScope(event.target.value as MemoryScope)}>
          {kind === 'memory' && <option value="chat" disabled={!workspace || !chatId}>Только этот чат</option>}
          <option value="project" disabled={!workspace}>Только этот проект</option>
          <option value="global">Все проекты</option>
        </select>
        <button type="button" className="text-button" onClick={() => setExpanded(false)}>Отмена</button>
        <button className="primary-button" disabled={busy || !title.trim() || !content.trim()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </form>}
  </div>
}
