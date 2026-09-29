import { useEffect, type ReactNode } from 'react'
import { Icon } from './Icon'

export type Panel = 'settings' | 'memory' | 'capabilities' | 'add' | 'quota'
const titles: Record<Panel, string> = { settings: 'Настройки', memory: 'Память', capabilities: 'Навыки', add: 'Добавить проект', quota: 'Квоты' }

// Keyboard focus stays inside the open dialog and returns to the opener when it closes.
function useFocusTrap(panel: Panel) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const selector = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary'
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(selector) || []).filter(element => element.getClientRects().length > 0)
    const timer = setTimeout(() => focusable()[0]?.focus(), 0)
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { clearTimeout(timer); document.removeEventListener('keydown', trap); before?.focus() }
  }, [panel])
}

export function Modal({ panel, onClose, children }: { panel: Panel; onClose: () => void; children: ReactNode }) {
  useFocusTrap(panel)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`modal ${panel === 'add' ? 'compact-modal' : ''}`} role="dialog" aria-modal="true" aria-label={titles[panel]}>
      <header className="modal-header">
        <div><div className="eyebrow">ORBIT WORKSPACE</div><h2>{titles[panel]}</h2></div>
        <button className="icon-button" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="modal-content">{children}</div>
    </section>
  </div>
}

export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  if (!text) return null
  return <div className="toast" role="status">
    <span>{text}</span>
    <button className="icon-button" aria-label="Закрыть уведомление" onClick={onClose}><Icon name="close" size={15} /></button>
  </div>
}
