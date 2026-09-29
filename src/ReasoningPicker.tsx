import defaults from '../electron/reasoning-defaults.json'

export const effortLabels: Record<string, string> = {
  none: 'Без размышлений', enabled: 'Включено', minimal: 'Минимальное', low: 'Низкое', medium: 'Среднее', high: 'Высокое',
  xhigh: 'Очень высокое', max: 'Максимальное', ultra: 'Ultra',
}
const NO_LEVELS = 'У модели нет подтверждённых настроек рассуждений. Выберите модель и нажмите «Проверить».'
// Google (Antigravity) models have reasoning built in, so Orbit offers no control for them.
const hasReasoningControl = (providerId: string) => providerId !== 'antigravity'
export function reasoningLevels(providerId: string, model: string, health?: ProviderHealth): string[] {
  if (!hasReasoningControl(providerId)) return []
  return health?.reasoningLevels?.[model] ?? (defaults as Record<string, string[]>)[providerId] ?? []
}

type ReasoningPickerProps = { providerId: string; model: string; health?: ProviderHealth; value: string; onChange: (value: string) => void; label?: string }

export function ReasoningPicker({ providerId, model, health, value, onChange, label = 'Уровень мышления' }: ReasoningPickerProps) {
  if (!hasReasoningControl(providerId)) return null
  const levels = reasoningLevels(providerId, model, health)
  const title = levels.length ? 'Уровень рассуждений выбранной модели' : NO_LEVELS
  return <select aria-label={label} title={title} value={levels.includes(value) ? value : ''} disabled={!levels.length}
    onChange={event => onChange(event.target.value)}>
    <option value="">Рассуждения: авто</option>
    {levels.map(level => <option key={level} value={level}>{effortLabels[level] || level}</option>)}
  </select>
}
