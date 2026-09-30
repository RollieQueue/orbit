import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import type { TraceImage } from './types'
import './trace-images.css'

// The images traces name, as the runtime serves them (data: URLs). A request in flight or done is shared by the
// thumbnail and the enlarged view; a failed one is forgotten, so the next showing asks again. Only the newest are kept.
const loaded = new Map<string, Promise<string | null>>()
const KEPT_IMAGES = 24
function loadImage(runId: string, imageId: string): Promise<string | null> {
  const key = `${runId}/${imageId}`
  let pending = loaded.get(key)
  if (!pending) {
    const api = window.orbit
    pending = (api ? api.readTraceImage(runId, imageId) : Promise.resolve(null)).catch(() => null)
      .then(url => { if (!url) loaded.delete(key); return url })
    loaded.set(key, pending)
    if (loaded.size > KEPT_IMAGES) loaded.delete(loaded.keys().next().value!)
  }
  return pending
}
// undefined while loading, null when the runtime has no such image.
function useImage(runId: string, imageId: string) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let current = true
    setUrl(undefined)
    void loadImage(runId, imageId).then(value => { if (current) setUrl(value) })
    return () => { current = false }
  }, [runId, imageId])
  return url
}

const sizeOf = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`
const labelOf = (image: TraceImage) => `Изображение ${image.mediaType.replace(/^image\//, '').toUpperCase()}, ${sizeOf(image.bytes)}`

// One image over the whole window: fitted to it first; a click on the image (or the button) shows it at its own size,
// scrolled as needed. Escape, the close button or a click beside the image closes it.
function ImageViewer({ url, label, onClose }: { url: string; label: string; onClose: () => void }) {
  const [actual, setActual] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  // The inspector re-renders many times a second during a run: the handler is read through a ref, so focus and the
  // key listener are set up once.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close.current() } }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); before?.focus() }
  }, [])
  const beside = (event: React.MouseEvent) => { if (event.target === event.currentTarget) onClose() }
  return createPortal(<div className="image-viewer" role="dialog" aria-modal="true" aria-label={label} onMouseDown={beside}>
    <header className="image-viewer-bar">
      <span>{label}</span>
      <button type="button" className="image-viewer-size" onClick={() => setActual(!actual)}>{actual ? 'Вписать в окно' : 'Исходный размер'}</button>
      <button ref={closeButton} type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className={`image-viewer-stage ${actual ? 'actual' : ''}`} onMouseDown={beside}>
      <img src={url} alt={label} onClick={() => setActual(!actual)} />
    </div>
  </div>, document.body)
}

function Thumbnail({ runId, image, onOpen }: { runId: string; image: TraceImage; onOpen: (url: string, label: string) => void }) {
  const url = useImage(runId, image.id)
  const label = labelOf(image)
  if (url === null) return <span className="trace-image missing">{label}: файл не найден</span>
  return <button type="button" className="trace-image" disabled={!url} title={`${label}. Нажмите, чтобы увеличить`}
    aria-label={`${label}. Открыть в увеличенном виде`} onClick={() => url && onOpen(url, label)}>
    {url ? <img src={url} alt={label} /> : <span className="trace-image-loading">Загрузка изображения…</span>}
  </button>
}

// The images of one trace (what a tool result showed the agent, such as a screenshot it read) as thumbnails; a click
// opens one enlarged.
export function TraceImages({ runId, images }: { runId: string; images: TraceImage[] }) {
  const [open, setOpen] = useState<{ url: string; label: string } | null>(null)
  return <div className="trace-images">
    {images.map(image => <Thumbnail key={image.id} runId={runId} image={image} onOpen={(url, label) => setOpen({ url, label })} />)}
    {open && <ImageViewer url={open.url} label={open.label} onClose={() => setOpen(null)} />}
  </div>
}
