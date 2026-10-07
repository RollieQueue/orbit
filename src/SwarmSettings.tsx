import type { PoolMember, ProviderOption, RunLimits, Settings } from './types'
import { ReasoningPicker } from './ReasoningPicker'
import { baseOf } from './subscriptions'

type LimitField = { key: keyof RunLimits; label: string; min: number }
const limitFields: LimitField[] = [
  { key: 'maxAgents', label: 'Всего агентов', min: 1 }, { key: 'maxDepth', label: 'Глубина вложенности', min: 0 },
  { key: 'maxConcurrent', label: 'Одновременно', min: 1 }, { key: 'maxTurns', label: 'Ходов на помощника', min: 1 },
  { key: 'maxTotalTurns', label: 'Ходов всех помощников', min: 1 }, { key: 'maxMessages', label: 'Сообщений между агентами', min: 1 },
  { key: 'maxToolCalls', label: 'Вызовов инструментов за ход', min: 1 }, { key: 'timeoutMs', label: 'Время хода, мс', min: 1 },
  { key: 'runTimeoutMs', label: 'Время задачи, мс', min: 1 },
]
const MAX_MS = 2147483647
const contextFields = ['maxContextChars', 'maxOutputChars'] as const
const contextLabel = { maxContextChars: 'Размер контекста, символов', maxOutputChars: 'Размер наблюдения, символов' }
const contextDefault = { maxContextChars: 120000, maxOutputChars: 12000 }
const cliProviders = ['codex', 'claude', 'antigravity', 'cursor']
const cliCommand: Record<string, string> = { antigravity: 'agy', cursor: 'agent', codex: 'codex', claude: 'claude' }
const cliLogin: Record<string, string> = { antigravity: 'agy → Google-аккаунт', cursor: 'agent login', codex: 'codex login', claude: 'claude auth login' }
type ProxyMode = NonNullable<ProviderOption['proxyMode']>

type SwarmSettingsProps = {
  settings: Settings; update: (patch: Partial<Settings>) => void; providers: { id: string; name: string }[]; health: ProviderHealth[]
}

// Improvement and learning modes, the swarm limits, context sizes, the model pool and the CLI options of the chosen provider.
export function SwarmSettings({ settings, update, providers, health }: SwarmSettingsProps) {
  const pool = settings.providerPool || []
  const options = settings.providerOptions || {}
  const { providerId } = settings
  // An extra subscription runs its base provider's CLI: the CLI path, the login line and the connection settings are the base's.
  const base = baseOf(providerId)
  const setLimit = (field: LimitField, raw: string) => {
    const value = raw === '' ? null : Number(raw)
    const valid = value === null || (Number.isSafeInteger(value) && value >= field.min && (!field.key.endsWith('Ms') || value <= MAX_MS))
    if (valid) update({ limits: { ...settings.limits, [field.key]: value }, limitVersion: 2 })
  }
  const setContext = (key: typeof contextFields[number], raw: string) => {
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value >= 1000) update({ limits: { ...settings.limits, [key]: value } })
  }
  const clearLimits = () => update({ limits: { ...settings.limits, ...Object.fromEntries(limitFields.map(field => [field.key, null])) }, limitVersion: 2 })
  const setMember = (index: number, patch: Partial<PoolMember>) => update({ providerPool: pool.map((item, i) => i === index ? { ...item, ...patch } : item) })
  const setOption = (id: string, patch: Partial<ProviderOption>) => update({ providerOptions: { ...options, [id]: { ...options[id], ...patch } } })
  const addMember = () => {
    const reasoningEffort = providerId === 'antigravity' ? '' : options[providerId]?.reasoningEffort || ''
    update({ providerPool: [...pool, { providerId, model: settings.models[providerId] || '', reasoningEffort }] })
  }
  return <>
    <label className="toggle-setting">
      <input type="checkbox" checked={!!settings.improvementMode} onChange={event => update({ improvementMode: event.target.checked })} />
      Бесконечное улучшение
    </label>
    <p className="field-hint">
      Включено: ваше сообщение задаёт цель. За один запуск агент делает одну задачу: реализует, проверяет и сразу применяет (код Orbit —
      перезапуском), а следующую задачу Orbit начинает сам, в новом запуске со свежим контекстом. Цикл идёт, пока переключатель включён;
      его прерывают «Стоп» и «Остановить цикл». Цель с числом («сделай 5 улучшений») ставит цикл на паузу, когда число выполнено.
      Выключено: запрос «найдите улучшения» возвращает список.
    </p>
    <label className="toggle-setting">
      <input type="checkbox" checked={settings.skillLearning !== false} onChange={event => update({ skillLearning: event.target.checked })} />
      Учиться на задачах: сохранять навыки
    </label>
    <p className="field-hint">
      После содержательной задачи (10 и более ходов) или применения навыка оркестратор один раз оценивает использованные навыки и сохраняет новый,
      если в работе появилась повторяемая процедура. Это добавляет один ход модели. Выключено: навыки создаются только по вашей просьбе или по
      собственной инициативе агента.
    </p>
    <h3>Ограничения по вашему выбору</h3>
    <p className="field-hint">
      Пустое поле — без ограничения. Верхних потолков для числа агентов, ходов и сообщений нет. Глубина 0 запрещает подагентов. Ограничения подписок
      провайдеров сохраняются.
    </p>
    <button type="button" className="text-button" onClick={clearLimits}>Убрать все ограничения</button>
    <div className="limits-grid">
      {limitFields.map(field => <label key={field.key}>{field.label}
        <input type="number" min={field.min} step={1} placeholder="Без ограничения" value={settings.limits[field.key] ?? ''}
          max={field.key.endsWith('Ms') ? MAX_MS : undefined} onChange={event => setLimit(field, event.target.value)} />
      </label>)}
    </div>
    <h3>Контекст</h3>
    <p className="field-hint">
      Проектная память и общий кэш загружаются каждому агенту. Исполнители по умолчанию не получают историю чата и общую память; оркестратор может
      включить общую память для отдельного помощника.
    </p>
    <div className="limits-grid">
      {contextFields.map(key => <label key={key}>{contextLabel[key]}
        <input type="number" min={1000} step={1000} value={settings.limits[key] ?? contextDefault[key]}
          onChange={event => setContext(key, event.target.value)} />
      </label>)}
    </div>
    <h3>Модели смешанного роя</h3>
    <p className="field-hint">
      Добавьте доступные по вашим подпискам модели. Оркестратор выбирает исполнителей из этого списка и записывает проверенные результаты моделей в
      общую память. Пустой список использует выбранного провайдера.
    </p>
    {pool.map((member, index) => {
      const memberHealth = health.find(provider => provider.id === member.providerId)
      return <div className="pool-row" key={index}>
        <select aria-label={`Провайдер участника ${index + 1}`} value={member.providerId}
          onChange={event => setMember(index, { providerId: event.target.value, model: '', reasoningEffort: '' })}>
          {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        <input aria-label={`Модель участника ${index + 1}`} list={`pool-models-${index}`} value={member.model} placeholder="Модель CLI по умолчанию"
          onChange={event => setMember(index, { model: event.target.value, reasoningEffort: '' })} />
        <datalist id={`pool-models-${index}`}>{memberHealth?.models?.map(model => <option key={model} value={model} />)}</datalist>
        <ReasoningPicker label={`Рассуждения участника ${index + 1}`} providerId={member.providerId} model={member.model} health={memberHealth}
          value={member.reasoningEffort || ''} onChange={reasoningEffort => setMember(index, { reasoningEffort })} />
        <input aria-label={`Назначение участника ${index + 1}`} value={member.purpose || ''} placeholder="Предпочтительное назначение (необязательно)"
          onChange={event => setMember(index, { purpose: event.target.value })} />
        <button type="button" className="text-button" onClick={() => update({ providerPool: pool.filter((_, i) => i !== index) })}>Удалить</button>
      </div>
    })}
    <button type="button" className="secondary-button" onClick={addMember}>Добавить модель в рой</button>
    <p className="field-hint">Рассуждения задаются отдельно для каждой модели роя. Настройки применяются к новым задачам.</p>
    {cliProviders.includes(base) && <>
      <h3>Параметры CLI</h3>
      <label>Путь к CLI
        <input placeholder={cliCommand[base]} value={options[providerId]?.command || ''}
          onChange={event => setOption(providerId, { command: event.target.value })} />
      </label>
      <p className="field-hint">Вход выполняется в официальном CLI: {cliLogin[base]}{base !== providerId && ' (для этой подписки — кнопка «Войти» в списке провайдеров)'}. После входа нажмите «Проверить».</p>
      {base === 'claude' && <p className="field-hint">
        Для подписки Claude войдите через claude auth login своим Claude-аккаунтом. API-ключ не нужен. Модель можно оставить автоматической или
        выбрать sonnet, opus, haiku; доступность зависит от подписки.
      </p>}
      {base === 'antigravity' && <>
        <label>Соединение Google CLI
          <select value={options.antigravity?.proxyMode || 'system'}
            onChange={event => setOption('antigravity', { proxyMode: event.target.value as ProxyMode })}>
            <option value="system">Системный прокси / VPN</option>
            <option value="custom">Указать HTTP-прокси</option>
            <option value="inherit">Переменные окружения CLI</option>
            <option value="direct">Прямое соединение</option>
          </select>
        </label>
        {options.antigravity?.proxyMode === 'custom' && <label>Адрес HTTP-прокси
          <input placeholder="http://127.0.0.1:12334" value={options.antigravity?.proxyUrl || ''}
            onChange={event => setOption('antigravity', { proxyUrl: event.target.value })} />
        </label>}
        <p className="field-hint">
          Системный прокси передаётся процессу Google CLI. При VPN в режиме TUN оставьте системный режим. Если Google отклоняет страну аккаунта,
          проверьте её на policies.google.com/terms; исправление неверной страны — policies.google.com/country-association-form. Прокси не меняет
          страну аккаунта.
        </p>
      </>}
    </>}
  </>
}
