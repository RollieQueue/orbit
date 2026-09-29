import type { Settings } from './types'
import { Icon } from './Icon'
import { ModelPicker } from './ModelPicker'
import { SwarmSettings } from './SwarmSettings'
import { providers, type ProviderInfo } from './providers'
import { accessChoice, accessPatch, modelPatch } from './state-store'

type SettingsPanelProps = {
  settings: Settings; health: ProviderHealth[]; checking: boolean; desktop: boolean; modelChoices: string[]
  onRefresh: () => void; onSettings: (patch: Partial<Settings>) => void
}

function ProviderCard({ provider, status, selected, onPick }: { provider: ProviderInfo; status?: ProviderHealth; selected: boolean; onPick: () => void }) {
  return <button className={`provider-card ${selected ? 'selected' : ''}`} onClick={onPick}>
    <div className="provider-monogram">{provider.name[0]}</div>
    <span><strong>{provider.name}</strong><small>{status?.detail || provider.description}</small></span>
    <span className={`provider-badge ${status?.available ? 'available' : ''}`}>{status ? status.available ? 'Доступен' : 'Не подключён' : 'Не проверен'}</span>
  </button>
}

// Provider cards with their health, the model per provider, the user's instructions and the swarm limits.
export function SettingsPanel({ settings, health, checking, desktop, modelChoices, onRefresh, onSettings }: SettingsPanelProps) {
  const model = settings.models[settings.providerId] || ''
  return <>
    <p className="modal-intro">Агент использует выбранный провайдер. Подключения и авторизация CLI берутся из вашего окружения.</p>
    <div className="settings-section-heading">
      <h3>Провайдеры</h3>
      <button className="text-button" disabled={!desktop || checking} onClick={onRefresh}>
        <Icon name="refresh" size={14} />{checking ? 'Проверяем…' : 'Проверить'}
      </button>
    </div>
    <div className="provider-list">
      {providers.map(provider => <ProviderCard key={provider.id} provider={provider} status={health.find(p => p.id === provider.id)}
        selected={settings.providerId === provider.id} onPick={() => onSettings({ providerId: provider.id })} />)}
    </div>
    <p className="field-hint">{providers.find(p => p.id === settings.providerId)?.help}</p>
    <div className="settings-model">
      <span>Модель</span>
      <ModelPicker key={settings.providerId} label="Модель в настройках" value={model} models={modelChoices}
        onChange={next => onSettings(modelPatch(settings, next))} />
      <p className="field-hint">
        Выбор сохраняется отдельно для каждого провайдера и применяется к следующим сообщениям. Если модели нет в списке, укажите её идентификатор.
      </p>
    </div>
    <label>Ваши инструкции агенту
      <textarea rows={4} placeholder="Предпочтения в работе, языке и проверке результатов…" value={settings.agentInstructions}
        onChange={event => onSettings({ agentInstructions: event.target.value })} />
    </label>
    <details className="advanced-settings">
      <summary>Доступ и ограничения роя</summary>
      <label>Доступ для всех агентов
        <select value={accessChoice(settings)} onChange={event => onSettings(accessPatch(event.target.value))}>
          <option value="ask">Ask — спрашивать разрешение</option>
          <option value="danger-full-access">Full access — полный доступ</option>
          <option value="workspace-write">Только проект</option>
          <option value="read-only">Только чтение</option>
        </select>
      </label>
      <p className="field-hint">
        Выбранный доступ и уровень мышления применяются к новым задачам и наследуются подагентами. В режиме Ask запросы разрешения показываются в
        отдельном окне.
      </p>
      <SwarmSettings settings={settings} update={onSettings} providers={providers} health={health} />
    </details>
    <p className="autosave-label"><Icon name="check" size={14} />Настройки сохраняются автоматически</p>
  </>
}
