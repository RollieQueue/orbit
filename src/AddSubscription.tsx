import { useState } from 'react'
import type { Settings, SubscriptionInstance } from './types'
import { remoteErrorText } from './format'
import {
  LOGIN_STEPS, MAX_LABEL, SINGLE_ACCOUNT_REASONS, OWN_FOLDER_NOTE, accountChoices, addSubscription, looksManaged, loginCommand, loginStatus, providerList, removalPatch, removeNote, subscriptionProblem,
} from './subscriptions'
import './add-subscription.css'

type Shared = {
  settings: Settings; health: ProviderHealth[]; checking: boolean; desktop: boolean
  onSettings: (patch: Partial<Settings>) => void; onRefresh: () => void; onNotice: (text: string) => void
}

// Opens the CLI's own sign-in in a console window with this account's folder; the owner signs in there, Orbit sees nothing.
async function openLogin(settings: Settings, health: ProviderHealth[], instance: SubscriptionInstance): Promise<string> {
  const reply = await window.orbit!.loginAccount({ id: instance.id, base: instance.base, dir: instance.dir, command: loginCommand(settings, instance, health) })
  return reply.ok ? '' : reply.error || 'причина неизвестна'
}

// «Добавить подписку»: a second account of Claude Code or Codex. Creates the account's folder, saves the subscription, opens the
// CLI's sign-in window; «Проверить» then reads whether the account is signed in and it appears in every list.
export function AddSubscription({ settings, health, checking, desktop, onSettings, onRefresh }: Shared) {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState('claude')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<SubscriptionInstance | null>(null)
  const problem = label ? subscriptionProblem(settings, { base, label }) : ''
  const current = created && settings.subscriptions?.find(item => item.id === created.id)
  const status = current ? loginStatus(health.find(item => item.id === current.id)) : null

  async function create() {
    const refused = subscriptionProblem(settings, { base, label })
    if (refused || !window.orbit) { setError(refused || 'Доступно только в настольном Orbit'); return }
    setBusy(true); setError('')
    try {
      const { id, dir } = await window.orbit.prepareAccount(base, providerList(settings.subscriptions).map(item => item.id))
      const next = addSubscription(settings, { base, label, dir, id })
      const instance = next.subscriptions!.find(item => item.id === id)!
      onSettings({ subscriptions: next.subscriptions })
      setCreated(instance); setLabel('')
      const failed = await openLogin(next, health, instance)
      if (failed) setError(`Не удалось открыть окно входа: ${failed}`)
    } catch (caught) { setError(remoteErrorText(caught)) } finally { setBusy(false) }
  }

  if (!open) return <button type="button" className="secondary-button add-subscription-open" disabled={!desktop} onClick={() => setOpen(true)}
    title={desktop ? undefined : 'Доступно только в настольном Orbit'}>+ Добавить подписку</button>
  return <section className="add-subscription" aria-label="Добавить подписку">
    <div className="settings-section-heading">
      <h3>Добавить подписку</h3>
      <button type="button" className="text-button" onClick={() => { setOpen(false); setCreated(null); setError('') }}>Закрыть</button>
    </div>
    <p className="field-hint">
      Ещё один аккаунт того же провайдера со своей квотой: рабочий и личный, или две подписки. Orbit создаёт для него отдельную папку, а вход выполняется в
      официальном CLI: пароли и токены Orbit не видит.
    </p>
    <div className="add-subscription-form">
      <label>Провайдер
        <select value={base} onChange={event => setBase(event.target.value)} disabled={busy}>
          {accountChoices().map(choice => <option key={choice.id} value={choice.id} disabled={!choice.enabled}>
            {choice.name}{choice.reason ? ` — ${choice.reason}` : ''}
          </option>)}
        </select>
      </label>
      <label>Название
        <input value={label} maxLength={MAX_LABEL} placeholder="Например: Рабочий" disabled={busy} onChange={event => setLabel(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (label.trim() && !problem) void create() } }} />
      </label>
      <button type="button" className="primary-button" disabled={busy || !label.trim() || !!problem || !desktop} onClick={() => void create()}>
        {busy ? 'Создаём…' : 'Создать и войти'}
      </button>
    </div>
    {problem && <p className="add-subscription-error" role="alert">{problem}</p>}
    {error && <p className="add-subscription-error" role="alert">{error}</p>}
    {current && <div className="add-subscription-status" role="status">
      <strong>{current.base === 'claude' ? 'Claude Code' : 'Codex'} · {current.label}</strong>
      <span className={status?.ok ? 'ok' : ''}>{status?.ok ? status.text : LOGIN_STEPS}</span>
      {!status?.ok && status && <small>{status.text}</small>}
      <div className="form-actions">
        <button type="button" className="secondary-button" disabled={!desktop || checking} onClick={onRefresh}>{checking ? 'Проверяем…' : 'Проверить'}</button>
        {!status?.ok && <button type="button" className="text-button" disabled={!desktop} onClick={() => void openLogin(settings, health, current).then(failed => setError(failed ? `Не удалось открыть окно входа: ${failed}` : ''))}>
          Открыть окно входа снова
        </button>}
      </div>
    </div>}
    <p className="field-hint">
      Новая папка аккаунта чистая: настройки основного аккаунта (config.toml Codex, settings.json Claude Code) в неё не копируются. Cursor и Antigravity остаются
      одним аккаунтом: {Object.values(SINGLE_ACCOUNT_REASONS).map(reason => reason.replace('один аккаунт: ', '')).join('; ')}.
    </p>
  </section>
}

// The buttons under an extra subscription's card: its sign-in state, «Войти» (the CLI's sign-in window), «Проверить», «Удалить».
export function SubscriptionActions({ instance, settings, health, checking, desktop, onSettings, onRefresh, onNotice }: Shared & { instance: SubscriptionInstance }) {
  const [confirming, setConfirming] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = loginStatus(health.find(item => item.id === instance.id))
  const own = looksManaged(instance)

  async function signIn() {
    setBusy(true)
    try {
      const failed = await openLogin(settings, health, instance)
      onNotice(failed ? `Не удалось открыть окно входа: ${failed}` : `${LOGIN_STEPS} (${instance.label})`)
    } catch (caught) { onNotice(remoteErrorText(caught)) } finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    let note = ''
    try {
      if (window.orbit) note = removeNote(await window.orbit.removeAccount({ id: instance.id, dir: instance.dir, deleteFiles: own && deleteFiles }), instance)
    } catch (caught) { note = `Подписка убрана из Orbit, папку удалить не удалось: ${remoteErrorText(caught)}` }
    onSettings(removalPatch(settings, instance.id))
    if (note) onNotice(note)
    setBusy(false)
  }
  return <div className="subscription-actions">
    <span className={`subscription-status ${status.ok ? 'ok' : ''}`}>{status.text}</span>
    <div className="subscription-buttons">
      <button type="button" className="text-button" disabled={!desktop || busy} onClick={() => void signIn()}>Войти</button>
      <button type="button" className="text-button" disabled={!desktop || checking} onClick={onRefresh}>{checking ? 'Проверяем…' : 'Проверить'}</button>
      <button type="button" className="text-button danger" disabled={busy} onClick={() => setConfirming(value => !value)}>Удалить</button>
    </div>
    {confirming && <div className="subscription-remove" role="group" aria-label={`Удалить подписку ${instance.label}`}>
      <p>Убрать подписку «{instance.label}» из Orbit? Агенты и пул моделей перестанут её использовать.</p>
      {own && <label className="toggle-setting">
        <input type="checkbox" checked={deleteFiles} onChange={event => setDeleteFiles(event.target.checked)} />
        {OWN_FOLDER_NOTE}
      </label>}
      {!own && <p className="field-hint">Папка аккаунта ({instance.dir}) создана не Orbit и останется на диске.</p>}
      <div className="form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove()}>Удалить подписку</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => setConfirming(false)}>Отмена</button>
      </div>
    </div>}
  </div>
}
