import type { Settings, RunLimits } from './types'
import { ReasoningPicker } from './ReasoningPicker'

const limitFields: { key: keyof RunLimits; label: string; min: number }[] = [
  { key: 'maxAgents', label: 'Всего агентов', min: 1 }, { key: 'maxDepth', label: 'Глубина вложенности', min: 0 },
  { key: 'maxConcurrent', label: 'Одновременно', min: 1 }, { key: 'maxTurns', label: 'Ходов на помощника', min: 1 },
  { key: 'maxTotalTurns', label: 'Ходов всех помощников', min: 1 }, { key: 'maxMessages', label: 'Сообщений между агентами', min: 1 },
  { key: 'maxToolCalls', label: 'Вызовов инструментов за ход', min: 1 }, { key: 'timeoutMs', label: 'Время хода, мс', min: 1 },
  { key: 'runTimeoutMs', label: 'Время задачи, мс', min: 1 },
]
export function SwarmSettings({ settings, update, providers, health }: { settings: Settings; update: (patch: Partial<Settings>) => void; providers: { id: string; name: string }[]; health: ProviderHealth[] }) {
  const pool = settings.providerPool || []
  const options = settings.providerOptions || {}
  return <>
    <label className="toggle-setting"><input type="checkbox" checked={!!settings.improvementMode} onChange={event => update({ improvementMode: event.target.checked })} />Бесконечное улучшение</label>
    <p className="field-hint">Включено: агент находит, реализует и проверяет улучшения до завершения вашего задания или остановки. Выключено: запрос «найдите улучшения» возвращает список. Число улучшений задайте в сообщении.</p>
    <h3>Ограничения по вашему выбору</h3>
    <p className="field-hint">Пустое поле — без ограничения. Верхних потолков для числа агентов, ходов и сообщений нет. Глубина 0 запрещает подагентов. Ограничения подписок провайдеров сохраняются.</p>
    <button type="button" className="text-button" onClick={() => update({ limits: { ...settings.limits, ...Object.fromEntries(limitFields.map(field => [field.key, null])) }, limitVersion: 2 })}>Убрать все ограничения</button>
    <div className="limits-grid">{limitFields.map(field => <label key={field.key}>{field.label}<input type="number" min={field.min} step={1} placeholder="Без ограничения" value={settings.limits[field.key] ?? ''} max={field.key.endsWith('Ms') ? 2147483647 : undefined} onChange={event => { const value = event.target.value === '' ? null : Number(event.target.value); if (value === null || (Number.isSafeInteger(value) && value >= field.min && (!field.key.endsWith('Ms') || value <= 2147483647))) update({ limits: { ...settings.limits, [field.key]: value }, limitVersion: 2 }) }} /></label>)}</div>
    <h3>Контекст</h3>
    <p className="field-hint">Проектная память и общий кэш загружаются каждому агенту. Исполнители по умолчанию не получают историю чата и общую память; оркестратор может включить общую память для отдельного помощника.</p>
    <div className="limits-grid">{(['maxContextChars', 'maxOutputChars'] as const).map(key => <label key={key}>{key === 'maxContextChars' ? 'Размер контекста, символов' : 'Размер наблюдения, символов'}<input type="number" min={1000} step={1000} value={settings.limits[key] ?? (key === 'maxContextChars' ? 120000 : 12000)} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 1000) update({ limits: { ...settings.limits, [key]: value } }) }} /></label>)}</div>
    <h3>Модели смешанного роя</h3>
    <p className="field-hint">Добавьте доступные по вашим подпискам модели. Оркестратор выбирает исполнителей из этого списка и записывает проверенные результаты моделей в общую память. Пустой список использует выбранного провайдера.</p>
    {pool.map((member, index) => <div className="pool-row" key={index}>
      <select aria-label={`Провайдер участника ${index + 1}`} value={member.providerId} onChange={event => update({ providerPool: pool.map((item, i) => i === index ? { ...item, providerId: event.target.value, model: '', reasoningEffort: '' } : item) })}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>
      <input aria-label={`Модель участника ${index + 1}`} list={`pool-models-${index}`} value={member.model} placeholder="Модель CLI по умолчанию" onChange={event => update({ providerPool: pool.map((item, i) => i === index ? { ...item, model: event.target.value, reasoningEffort: '' } : item) })} />
      <datalist id={`pool-models-${index}`}>{health.find(provider => provider.id === member.providerId)?.models?.map(model => <option key={model} value={model} />)}</datalist>
      <ReasoningPicker label={`Рассуждения участника ${index + 1}`} providerId={member.providerId} model={member.model} health={health.find(provider => provider.id === member.providerId)} value={member.reasoningEffort || ''} onChange={reasoningEffort => update({ providerPool: pool.map((item, i) => i === index ? { ...item, reasoningEffort } : item) })} />
      <input aria-label={`Назначение участника ${index + 1}`} value={member.purpose || ''} placeholder="Предпочтительное назначение (необязательно)" onChange={event => update({ providerPool: pool.map((item, i) => i === index ? { ...item, purpose: event.target.value } : item) })} />
      <button type="button" className="text-button" onClick={() => update({ providerPool: pool.filter((_, i) => i !== index) })}>Удалить</button>
    </div>)}
    <button type="button" className="secondary-button" onClick={() => update({ providerPool: [...pool, { providerId: settings.providerId, model: settings.models[settings.providerId] || '', reasoningEffort: settings.providerId === 'antigravity' ? '' : options[settings.providerId]?.reasoningEffort || '' }] })}>Добавить модель в рой</button>
    <p className="field-hint">Рассуждения задаются отдельно для каждой модели роя. Настройки применяются к новым задачам.</p>
    {['codex', 'claude', 'antigravity', 'cursor'].includes(settings.providerId) && <>
      <h3>Параметры CLI</h3>
      <label>Путь к CLI<input placeholder={{ antigravity: 'agy', cursor: 'agent', codex: 'codex', claude: 'claude' }[settings.providerId]} value={options[settings.providerId]?.command || ''} onChange={event => update({ providerOptions: { ...options, [settings.providerId]: { ...options[settings.providerId], command: event.target.value } } })} /></label>
      <p className="field-hint">Вход выполняется в официальном CLI: {{ antigravity: 'agy → Google-аккаунт', cursor: 'agent login', codex: 'codex login', claude: 'claude auth login' }[settings.providerId]}. После входа нажмите «Проверить».</p>
      {settings.providerId === 'claude' && <p className="field-hint">Для подписки Claude войдите через claude auth login своим Claude-аккаунтом. API-ключ не нужен. Модель можно оставить автоматической или выбрать sonnet, opus, haiku; доступность зависит от подписки.</p>}
      {settings.providerId === 'antigravity' && <>
        <label>Соединение Google CLI<select value={options.antigravity?.proxyMode || 'system'} onChange={event => update({ providerOptions: { ...options, antigravity: { ...options.antigravity, proxyMode: event.target.value as 'system' | 'inherit' | 'custom' | 'direct' } } })}><option value="system">Системный прокси / VPN</option><option value="custom">Указать HTTP-прокси</option><option value="inherit">Переменные окружения CLI</option><option value="direct">Прямое соединение</option></select></label>
        {options.antigravity?.proxyMode === 'custom' && <label>Адрес HTTP-прокси<input placeholder="http://127.0.0.1:12334" value={options.antigravity?.proxyUrl || ''} onChange={event => update({ providerOptions: { ...options, antigravity: { ...options.antigravity, proxyUrl: event.target.value } } })} /></label>}
        <p className="field-hint">Системный прокси передаётся процессу Google CLI. При VPN в режиме TUN оставьте системный режим. Если Google отклоняет страну аккаунта, проверьте её на policies.google.com/terms; исправление неверной страны — policies.google.com/country-association-form. Прокси не меняет страну аккаунта.</p>
      </>}
    </>}
  </>
}
