import { useEffect, useState } from 'react'
import type { Agent, Handover, QuotaFailover, QuotaSnapshot, QuotaState, QuotaWindow } from './types'
import { shownStatus } from './run-events'

type ProviderInfo = { id: string; name: string; description: string }

const stateLabel: Record<QuotaState, string> = {
  ok: 'В норме', warning: 'Скоро закончится', exhausted: 'Исчерпана', unknown: 'Нет данных', unlimited: 'Без лимитов', unavailable: 'Недоступно',
}
const clock = (time: number) => new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
const dayOf = (time: number) => new Date(time).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

// A window whose reset time has passed has rolled over, whatever was measured in it before.
export const usedNow = (window: QuotaWindow, at: number) => window.resetsAt && window.resetsAt <= at ? 0 : window.usedPercent
const scopeSuffix = (window: QuotaWindow, separator: string) => window.scope && window.scope !== 'all' ? `${separator}${window.scope}` : ''
export const windowName = (window: QuotaWindow) =>
  `${window.kind === 'session' ? '5 часов' : window.kind === 'week' ? 'Неделя' : 'Окно'}${scopeSuffix(window, ' · ')}`
const shortName = (window: QuotaWindow) => `${window.kind === 'session' ? '5 ч' : window.kind === 'week' ? 'нед.' : 'окно'}${scopeSuffix(window, ' ')}`
export function resetText(resetsAt: number | null | undefined, at: number) {
  if (!resetsAt) return ''
  const left = resetsAt - at
  if (left <= 0) return 'лимит уже сброшен'
  const minutes = Math.max(1, Math.round(left / 60000)), hours = Math.floor(minutes / 60)
  if (minutes < 60) return `сброс через ${minutes} мин · ${clock(resetsAt)}`
  if (hours < 48) return `сброс через ${hours} ч ${minutes % 60} мин · ${clock(resetsAt)}`
  return `сброс через ${Math.round(hours / 24)} дн. · ${dayOf(resetsAt)}`
}
const level = (used: number) => used >= 90 ? 'high' : used >= 70 ? 'warn' : 'ok'
// The windows that apply to a model: account-wide ones, plus those limited to it. Without a model, account-wide ones only.
export function windowsFor(snapshot: QuotaSnapshot | undefined | null, model = ''): QuotaWindow[] {
  const windows = snapshot?.windows || []
  const name = model.toLowerCase()
  if (!name) { const general = windows.filter(window => !window.models?.length); return general.length ? general : windows }
  return windows.filter(window => !window.models?.length || window.models.some(token => name.includes(token)))
}
const order = (window: QuotaWindow) => (window.models?.length ? 10 : 0) + (window.kind === 'session' ? 0 : window.kind === 'week' ? 1 : 2)
function useTick(ms: number) {
  const [tick, setTick] = useState(0)
  useEffect(() => { const timer = window.setInterval(() => setTick(value => value + 1), ms); return () => window.clearInterval(timer) }, [ms])
  return tick
}

export function handoverLabel(providers: ProviderInfo[], target: Handover['from']) {
  return `${providers.find(provider => provider.id === target.providerId)?.name || target.providerId}${target.model ? ` · ${target.model}` : ''}`
}
export function handoverReason(handover: Handover) {
  if (handover.reason === 'approaching') return `квота почти исчерпана (${handover.usedPercent ?? '?'}%)`
  if (handover.reason === 'stalled') return 'модель перестала отвечать'
  if (handover.reason === 'failed') return 'ошибка провайдера'
  return handover.reason === 'exhausted' ? 'квота исчерпана' : 'предыдущая замена не запустилась'
}
export function handoverText(providers: ProviderInfo[], agentName: string, handover: Handover) {
  const moved = handover.fresh && !handover.interrupted
    ? 'Работа началась на новой подписке.'
    : `Новая модель продолжает с того же места: ей переданы журнал действий, файлы${handover.interrupted ? ' и незавершённый ход' : ''}.`
  const route = `${handoverLabel(providers, handover.from)} → ${handoverLabel(providers, handover.to)}`
  return `Замена агента «${agentName}»: ${route} — ${handoverReason(handover)}. ${moved}`
}

function Bar({ window, at }: { window: QuotaWindow; at: number }) {
  const used = usedNow(window, at)
  return <div className="quota-row">
    <div className="quota-row-head"><span>{windowName(window)}</span><strong>осталось {Math.max(0, 100 - used)}%</strong></div>
    <div className={`quota-bar ${level(used)}`} role="meter" aria-label={`${windowName(window)}: занято ${used}%`} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={used}><span style={{ width: `${used}%` }} /></div>
    <small>занято {used}%{window.resetsAt ? ` · ${resetText(window.resetsAt, at)}` : ''}</small>
  </div>
}

type CardProps = { provider: ProviderInfo; snapshot?: QuotaSnapshot; connected: boolean; agents: Agent[]; at: number; current: boolean }

function Card({ provider, snapshot, connected, agents, at, current }: CardProps) {
  const state: QuotaState = snapshot?.state || 'unknown'
  const windows = [...(snapshot?.windows || [])].sort((a, b) => order(a) - order(b))
  const blockedUntil = snapshot?.exhaustedUntil && snapshot.exhaustedUntil > at ? snapshot.exhaustedUntil : null
  const stateText = !snapshot ? 'Загружаем…' : !connected && state === 'unavailable' ? 'Не подключён' : stateLabel[state]
  return <article className={`quota-card ${state} ${current ? 'current' : ''} ${connected ? '' : 'disconnected'}`} aria-label={`Квота ${provider.name}`}>
    <header>
      <strong>{provider.name}</strong>
      {snapshot?.plan && <span className="quota-plan">{snapshot.plan}</span>}
      {current && <span className="quota-current">выбран для новых задач</span>}
      <span className={`quota-state ${state}`}>{stateText}</span>
    </header>
    {windows.map((window, index) => <Bar key={`${window.kind}-${window.scope}-${index}`} window={window} at={at} />)}
    {blockedUntil && <p className="quota-note warn">
      Провайдер отказал в запросе, поэтому агенты обходят эту подписку. Ожидаемый {resetText(blockedUntil, at)}.
    </p>}
    {snapshot?.detail && <p className="quota-note">{snapshot.detail}</p>}
    {!!snapshot?.credits && !snapshot.credits.unlimited && snapshot.credits.hasCredits && <p className="quota-note">Кредиты: {snapshot.credits.balance}</p>}
    {!!agents.length && <div className="quota-agents">
      <span>Агенты запуска</span>
      {agents.map(agent => <span key={agent.id} className="quota-agent" title={`${agent.name}${agent.model ? ` · ${agent.model}` : ''}`}>
        <span className={`status-dot ${shownStatus(agent)}`} />{agent.name}{!!agent.handovers?.length && <b title="Агент менял подписку">⇄</b>}
      </span>)}
    </div>}
    {snapshot?.fetchedAt && <footer>{snapshot.stale ? 'Данные устарели · ' : ''}обновлено {clock(snapshot.fetchedAt)}</footer>}
  </article>
}

type QuotaPanelProps = {
  providers: ProviderInfo[]; connected: Record<string, boolean>; quotas: Record<string, QuotaSnapshot>; busy: boolean; onRefresh: () => void
  failover: QuotaFailover; onFailover: (patch: Partial<QuotaFailover>) => void; agents: Agent[]; currentProviderId: string
}

export function QuotaPanel({ providers, connected, quotas, busy, onRefresh, failover, onFailover, agents, currentProviderId }: QuotaPanelProps) {
  useTick(30000)
  const at = Date.now()
  return <>
    <p className="modal-intro">
      Остаток подписок так, как его сообщают сами CLI: Orbit ничего не списывает и не читает токены входа. Если у подписки кончается квота, работающий
      агент переходит на другую с моделью сравнимого уровня.
    </p>
    <div className="settings-section-heading">
      <h3>Подписки и агенты</h3>
      <button className="text-button" disabled={busy} onClick={onRefresh}>{busy ? 'Обновляем…' : '↻ Обновить'}</button>
    </div>
    <div className="quota-list">
      {providers.map(provider => <Card key={provider.id} provider={provider} snapshot={quotas[provider.id]} connected={!!connected[provider.id]}
        agents={agents.filter(agent => agent.providerId === provider.id)} at={at} current={provider.id === currentProviderId} />)}
    </div>
    <section className="quota-failover" aria-label="Автозамена агента">
      <div className="settings-section-heading"><h3>Автозамена агента</h3></div>
      <label className="toggle-setting">
        <input type="checkbox" checked={failover.enabled} onChange={event => onFailover({ enabled: event.target.checked })} />
        Заменять агента другой подпиской, когда квота на исходе, провайдер ответил ошибкой или модель перестала отвечать
      </label>
      <label className={`quota-slider ${failover.enabled ? '' : 'off'}`}>
        <span>Менять подписку, когда использовано <strong>{failover.switchAtPercent}%</strong> лимита</span>
        <input type="range" min={50} max={99} step={1} value={failover.switchAtPercent} disabled={!failover.enabled} aria-label="Порог автозамены, процентов"
          onChange={event => onFailover({ switchAtPercent: Number(event.target.value) })} />
      </label>
      <label className="toggle-setting">
        <input type="checkbox" checked={failover.allowWeaker} disabled={!failover.enabled}
          onChange={event => onFailover({ allowWeaker: event.target.checked })} />
        Если сравнимой модели нет — разрешить чуть более слабую
      </label>
      <p className="field-hint">
        Замена выбирается из подключённых подписок: сначала ваш пул моделей, затем модель того же уровня и с наибольшим запасом квоты. Уровень
        модели берётся из замера (аудит моделей), для остальных — по названию (файл electron/model-tiers.json); неизвестные, ненадёжные и
        исключённые там модели (Claude Fable: расходует гораздо больше квоты, а пишет не лучше Opus) берутся только из пула. Новый агент получает журнал
        действий, файлы, состояние команды и незавершённый ход прежнего. Порог и разрешения действуют для новых задач.
      </p>
    </section>
  </>
}

// A one-line reading for the provider chosen in the composer.
export function QuotaChip({ name, snapshot, model, onOpen }: { name: string; snapshot?: QuotaSnapshot; model: string; onOpen: () => void }) {
  useTick(30000)
  const at = Date.now()
  const windows = [...windowsFor(snapshot, model)].sort((a, b) => order(a) - order(b))
  if (!snapshot || (!windows.length && snapshot.state !== 'exhausted')) return null
  // Measured figures can look healthy while the provider has just refused a request; say so instead of showing both unexplained.
  const refused = snapshot.state === 'exhausted' && windows.every(window => usedNow(window, at) < 100)
  const readings = windows.map(window => `${shortName(window)} ${Math.max(0, 100 - usedNow(window, at))}% ост.`).join(' · ')
  const text = windows.length ? `${readings}${refused ? ' · провайдер отказал' : ''}` : 'квота исчерпана'
  const title = 'Остаток квоты выбранной подписки. Нажмите, чтобы открыть все квоты.'
  return <button type="button" className={`quota-chip ${snapshot.state}`} onClick={onOpen} title={title}>{name}: {text}</button>
}
