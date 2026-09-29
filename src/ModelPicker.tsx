import { useState } from 'react'

// The provider's known models plus the saved one, and a free-text field for an id the CLI did not list.
type ModelPickerProps = { value: string; models: string[]; onChange: (value: string) => void; label?: string }

export function ModelPicker({ value, models, onChange, label = 'Модель' }: ModelPickerProps) {
  const [custom, setCustom] = useState(false)
  const choices = [...new Set([...models, ...(value ? [value] : [])])]
  const pick = (next: string) => {
    if (next === '__custom__') setCustom(true)
    else { setCustom(false); onChange(next) }
  }
  return <div className="model-picker">
    <select aria-label={label} title={value || 'Модель по умолчанию'} value={custom ? '__custom__' : value} onChange={event => pick(event.target.value)}>
      <option value="">Модель: автоматически</option>
      {choices.map(model => <option key={model} value={model}>{model}</option>)}
      <option value="__custom__">Указать свою…</option>
    </select>
    {custom && <input autoFocus aria-label={`${label}: свой идентификатор`} placeholder="Идентификатор модели" value={value}
      onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />}
  </div>
}
