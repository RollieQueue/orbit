import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { ChatThread, Project, QuotaSnapshot, RunSnapshot, Settings } from './types'
import { ComposerAttachments } from './AttachmentChips'
import { Icon } from './Icon'
import { ModelPicker } from './ModelPicker'
import { QuotaChip } from './QuotaPanel'
import { ReasoningPicker } from './ReasoningPicker'
import { providerName, providers } from './providers'
import { RESTART_WAIT_TEXT, accessChoice, accessPatch, modelPatch, reasoningPatch } from './state-store'

export type ComposerProps = {
  settings: Settings; project?: Project; chat?: ChatThread; currentHealth?: ProviderHealth; modelChoices: string[]; selectedEffort: string
  quotas: Record<string, QuotaSnapshot>; draft: string; running: boolean;
  // The task number of the current chat's endless-improvement loop while that loop is active.
  loopTask?: number; canSteer: boolean; restartWait: boolean; workingRun?: RunSnapshot; ready: boolean; desktop: boolean
  // The files chosen for the next message; onAttach adds some and returns why some were refused ('' when all were taken).
  files: File[]; onAttach: (files: File[]) => string; onDetach: (index: number) => void
  onDraft: (text: string) => void; onSend: () => boolean; onStop: () => void; onTogglePause: () => void; onSettings: (patch: Partial<Settings>) => void; onOpenQuota: () => void
}

// The message field with the run options it sends with (provider, model, effort, access) and the stop/send buttons. While
// a run works the message goes to its root agent (canSteer); while the chat waits for the continuation of a restart
// (restartWait) the draft can be written but not sent. Files join the message from the paperclip, a drop or a paste.
export function Composer({
  settings, project, chat, currentHealth, modelChoices, selectedEffort, quotas, draft, running, loopTask, canSteer, restartWait, workingRun, ready, desktop,
  files, onAttach, onDetach, onDraft, onSend, onStop, onTogglePause, onSettings, onOpenQuota,
}: ComposerProps) {
  const model = settings.models[settings.providerId] || ''
  const enabled = desktop && !!project && !!chat && ready
  const hasContent = !!draft.trim() || files.length > 0
  const picker = useRef<HTMLInputElement>(null)
  const [attachError, setAttachError] = useState('')
  const [dragging, setDragging] = useState(false)
  const attach = (chosen: File[]) => { if (chosen.length) setAttachError(onAttach(chosen)) }
  const detach = (index: number) => { setAttachError(''); onDetach(index) }
  const carriesFiles = (event: DragEvent) => enabled && Array.from(event.dataTransfer.types).includes('Files')
  const onDragOver = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true) }
  const onDragLeave = (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }
  const onDrop = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); setDragging(false); attach(Array.from(event.dataTransfer.files)) }
  // A pasted image or file joins the message; pasted text goes into the field as usual.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files)
    if (!pasted.length || !enabled) return
    event.preventDefault(); attach(pasted)
  }
  // The root's own pause flag: pausing the root holds the whole team, so this one button covers every agent.
  const paused = !!workingRun?.agents.find(agent => agent.id === 'root')?.paused
  const placeholder = !project ? 'Сначала подключите проект' : paused ? 'Агент на паузе — сообщение он прочитает после «Продолжить»…'
    : running ? (workingRun ? 'Дополните задачу — агент получит сообщение на следующем шаге…' : 'Можно подготовить следующее сообщение…')
    : restartWait ? `${RESTART_WAIT_TEXT}…` : 'Напишите агенту…'
  const caption = !ready ? 'Восстанавливаем историю…'
    : currentHealth && !currentHealth.available ? `${providerName(currentHealth.id)}: ${currentHealth.detail}`
    : model || 'Модель по настройкам провайдера'
  const chip = <QuotaChip name={providerName(settings.providerId) || ''} snapshot={quotas[settings.providerId]} model={model} onOpen={onOpenQuota} />
  // Enter sends, Shift+Enter breaks the line; while a run starts Enter only keeps the draft.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (running ? canSteer : !restartWait) onSend()
  }
  return <div className="composer-area">
    <label className="improvement-toggle">
      <input type="checkbox" checked={!!settings.improvementMode} onChange={event => onSettings({ improvementMode: event.target.checked })} />
      Бесконечное улучшение{loopTask ? <small> · цикл: задача {loopTask}</small> : running && <small> · для следующей задачи</small>}
    </label>
    <form className={`composer ${running ? 'is-running' : ''} ${dragging ? 'drop-active' : ''}`} onSubmit={event => { event.preventDefault(); onSend() }}
      onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <ComposerAttachments files={files} onRemove={detach} />
      {attachError && <p className="attach-error" role="alert">{attachError}</p>}
      <textarea aria-label="Сообщение агенту" placeholder={placeholder} value={draft} disabled={!enabled} rows={2}
        onChange={event => onDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
      <div className="composer-toolbar">
        <div className="composer-options">
          <input ref={picker} type="file" multiple hidden tabIndex={-1} onChange={event => { attach(Array.from(event.target.files || [])); event.target.value = '' }} />
          <button type="button" className="attach-button" aria-label="Прикрепить файлы" title="Прикрепить документы и изображения (можно перетащить или вставить из буфера)"
            disabled={!enabled} onClick={() => picker.current?.click()}><Icon name="paperclip" size={16} /></button>
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
          ? <div className="composer-actions">
            <button className="send-button" type="submit" aria-label="Отправить агенту в работе" title="Агент получит сообщение на следующем шаге"
              disabled={!hasContent || !enabled || !canSteer}><Icon name="arrow" /></button>
            <button type="button" className={`send-button pause-button ${paused ? 'paused' : ''}`} disabled={!workingRun} onClick={onTogglePause}
              aria-label={paused ? 'Продолжить' : 'Поставить на паузу'}
              title={paused ? 'Агенты продолжат с того места, где остановились'
                : 'Пауза: текущий ход агента и его помощников прервётся, работа продолжится по кнопке «Продолжить»'}>
              <Icon name={paused ? 'play' : 'pause'} />
            </button>
            <button type="button" className="send-button stop-button" aria-label="Остановить агентов" disabled={!workingRun} onClick={onStop}>
              <Icon name="stop" />
            </button>
          </div>
          : <button className="send-button" type="submit" aria-label="Отправить сообщение" title={restartWait ? RESTART_WAIT_TEXT : undefined}
            disabled={!hasContent || !enabled || restartWait}><Icon name="arrow" /></button>}
      </div>
    </form>
    <div className="composer-caption">
      <span>{caption} {chip}</span>
      <span>Enter — отправить · Shift + Enter — новая строка</span>
    </div>
  </div>
}
