import type { KeyboardEvent } from 'react'
import type { ChatThread, Project, QuotaSnapshot, RunSnapshot, Settings } from './types'
import { Icon } from './Icon'
import { ModelPicker } from './ModelPicker'
import { QuotaChip } from './QuotaPanel'
import { ReasoningPicker } from './ReasoningPicker'
import { providerName, providers } from './providers'
import { RESTART_WAIT_TEXT, accessChoice, accessPatch, modelPatch, reasoningPatch } from './state-store'

export type ComposerProps = {
  settings: Settings; project?: Project; chat?: ChatThread; currentHealth?: ProviderHealth; modelChoices: string[]; selectedEffort: string
  quotas: Record<string, QuotaSnapshot>; draft: string; running: boolean; restartWait: boolean; workingRun?: RunSnapshot; ready: boolean; desktop: boolean
  onDraft: (text: string) => void; onSend: () => boolean; onStop: () => void; onSettings: (patch: Partial<Settings>) => void; onOpenQuota: () => void
}

// The message field with the run options it sends with (provider, model, effort, access) and the stop/send button. While
// the chat waits for the continuation of a restart (restartWait) the draft can be written but not sent.
export function Composer({
  settings, project, chat, currentHealth, modelChoices, selectedEffort, quotas, draft, running, restartWait, workingRun, ready, desktop,
  onDraft, onSend, onStop, onSettings, onOpenQuota,
}: ComposerProps) {
  const model = settings.models[settings.providerId] || ''
  const enabled = desktop && !!project && !!chat && ready
  const placeholder = !project ? 'Сначала подключите проект' : running ? 'Можно подготовить следующее сообщение…'
    : restartWait ? `${RESTART_WAIT_TEXT}…` : 'Напишите агенту…'
  const caption = !ready ? 'Восстанавливаем историю…'
    : currentHealth && !currentHealth.available ? `${providerName(currentHealth.id)}: ${currentHealth.detail}`
    : model || 'Модель по настройкам провайдера'
  const chip = <QuotaChip name={providerName(settings.providerId) || ''} snapshot={quotas[settings.providerId]} model={model} onOpen={onOpenQuota} />
  // Enter sends, Shift+Enter breaks the line; while a run works Enter only keeps the draft.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!running && !restartWait) onSend()
  }
  return <div className="composer-area">
    <label className="improvement-toggle">
      <input type="checkbox" checked={!!settings.improvementMode} onChange={event => onSettings({ improvementMode: event.target.checked })} />
      Бесконечное улучшение{running && <small> · для следующей задачи</small>}
    </label>
    <form className={`composer ${running ? 'is-running' : ''}`} onSubmit={event => { event.preventDefault(); onSend() }}>
      <textarea aria-label="Сообщение агенту" placeholder={placeholder} value={draft} disabled={!enabled} rows={2}
        onChange={event => onDraft(event.target.value)} onKeyDown={onKeyDown} />
      <div className="composer-toolbar">
        <div className="composer-options">
          <select aria-label="Провайдер" value={settings.providerId} onChange={event => onSettings({ providerId: event.target.value })}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <ModelPicker key={settings.providerId} value={model} models={modelChoices} onChange={next => onSettings(modelPatch(settings, next))} />
          <ReasoningPicker providerId={settings.providerId} model={model} health={currentHealth} value={selectedEffort}
            onChange={reasoningEffort => onSettings(reasoningPatch(settings, reasoningEffort))} />
          <select aria-label="Уровень доступа" title="Доступ наследуется всеми агентами задачи" value={accessChoice(settings)}
            onChange={event => onSettings(accessPatch(event.target.value))}>
            <option value="ask">Ask — спрашивать</option>
            <option value="danger-full-access">Full access</option>
            <option value="workspace-write">Только проект</option>
            <option value="read-only">Только чтение</option>
          </select>
        </div>
        {running
          ? <button type="button" className="send-button stop-button" aria-label="Остановить агентов" disabled={!workingRun} onClick={onStop}>
            <Icon name="stop" />
          </button>
          : <button className="send-button" type="submit" aria-label="Отправить сообщение" title={restartWait ? RESTART_WAIT_TEXT : undefined}
            disabled={!draft.trim() || !enabled || restartWait}><Icon name="arrow" /></button>}
      </div>
    </form>
    <div className="composer-caption">
      <span>{caption} {chip}</span>
      <span>Enter — отправить · Shift + Enter — новая строка</span>
    </div>
  </div>
}
