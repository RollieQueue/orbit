import { Icon } from './Icon'

type AddProjectPanelProps = {
  desktop: boolean; busy: boolean; remote: string
  onRemote: (value: string) => void; onAdd: (kind: 'local' | 'git', remote: string) => Promise<boolean>; onDone: () => void
}

// A local folder, or a repository URL to clone. `onDone` runs once a project has been added and selected.
export function AddProjectPanel({ desktop, busy, remote, onRemote, onAdd, onDone }: AddProjectPanelProps) {
  const add = async (kind: 'local' | 'git') => { if (await onAdd(kind, remote)) onDone() }
  return <>
    <p className="modal-intro">Каждый проект — отдельное пространство для чатов и памяти.</p>
    {!desktop && <p className="inline-notice">Откройте настольное приложение Orbit, чтобы подключить проект.</p>}
    <button className="local-project-option" disabled={!desktop || busy} onClick={() => void add('local')}>
      <span className="option-icon"><Icon name="folder" size={25} /></span>
      <span><strong>Открыть локальную папку</strong><small>Работает и без Git</small></span>
      <Icon name="plus" />
    </button>
    <div className="divider-label">или клонировать репозиторий</div>
    <form onSubmit={event => { event.preventDefault(); if (remote.trim()) void add('git') }}>
      <label>URL репозитория
        <input autoFocus placeholder="https://github.com/owner/project.git" value={remote} onChange={event => onRemote(event.target.value)}
          disabled={!desktop || busy} />
      </label>
      <button className="primary-button full-width" disabled={!desktop || busy || !remote.trim()}>
        <Icon name="git" />{busy ? 'Подключаем проект…' : 'Клонировать и открыть'}
      </button>
      <p className="field-hint">Orbit предложит выбрать папку для клонирования.</p>
    </form>
  </>
}
