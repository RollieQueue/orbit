import { useEffect, useState } from 'react'
import type { Attachment } from './types'
import { Icon } from './Icon'
import { formatSize, isImage } from './attachments'
import './attachments.css'

// Thumbnails of saved images, asked from the desktop once per file (a chat shows the same message again and again).
// Bounded by count and by the characters the data URLs hold (about 30 MB), the oldest leaving first.
const thumbnails = new Map<string, Promise<string | null>>()
const sizes = new Map<string, number>()
const THUMBNAILS_KEPT = 40
const THUMBNAIL_CHARS = 30_000_000
function forget(path: string) { thumbnails.delete(path); sizes.delete(path) }
function thumbnail(path: string): Promise<string | null> {
  let found = thumbnails.get(path)
  if (!found) {
    found = window.orbit ? window.orbit.readAttachmentImage(path).catch(() => null) : Promise.resolve(null)
    thumbnails.set(path, found)
    void found.then(url => { if (!thumbnails.has(path)) return; sizes.set(path, url?.length ?? 0); trim(path) })
  }
  return found
}
function trim(keep: string) {
  let total = 0
  for (const size of sizes.values()) total += size
  for (const path of [...thumbnails.keys()]) {
    if (thumbnails.size <= THUMBNAILS_KEPT && total <= THUMBNAIL_CHARS) break
    if (path === keep) continue
    total -= sizes.get(path) ?? 0; forget(path)
  }
}
function useThumbnail(attachment: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setUrl(null)
    if (isImage(attachment)) void thumbnail(attachment.path).then(value => { if (current) setUrl(value) })
    return () => { current = false }
  }, [attachment.path])
  return url
}

// Object URLs of the image files chosen for the next message; released when the files change.
function useObjectUrls(files: File[]): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([])
  useEffect(() => {
    const made = files.map(file => isImage({ type: file.type, name: file.name }) ? URL.createObjectURL(file) : null)
    setUrls(made)
    return () => { for (const url of made) if (url) URL.revokeObjectURL(url) }
  }, [files])
  return urls
}

// The files chosen for the message being written, above its text, each with a remove button.
export function ComposerAttachments({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const urls = useObjectUrls(files)
  if (!files.length) return null
  return <ul className="attachment-strip" aria-label="Вложения сообщения">
    {files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`} className="attachment-chip">
      <span className="attachment-thumb">{urls[index] ? <img src={urls[index]!} alt="" /> : <Icon name="paperclip" size={15} />}</span>
      <span className="attachment-name" title={file.name}>{file.name || 'файл'}</span>
      <small>{formatSize(file.size)}</small>
      <button type="button" className="attachment-remove" aria-label={`Убрать ${file.name}`} title="Убрать" onClick={() => onRemove(index)}><Icon name="close" size={12} /></button>
    </li>)}
  </ul>
}

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const url = useThumbnail(attachment)
  const open = () => { void window.orbit?.openPath(attachment.path).catch(() => undefined) }
  return <li>
    <button type="button" className={`attachment-chip message-attachment ${url ? 'has-image' : ''}`} onClick={open} title={`Открыть: ${attachment.name}`}>
      <span className="attachment-thumb">{url ? <img src={url} alt="" /> : <Icon name={isImage(attachment) ? 'image' : 'paperclip'} size={15} />}</span>
      <span className="attachment-name">{attachment.name}</span>
      <small>{formatSize(attachment.size)}</small>
    </button>
  </li>
}

// The files a chat message carries; a click opens one with the system's program for it.
export function MessageAttachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null
  return <ul className="attachment-strip message-attachments" aria-label="Вложения">
    {attachments.map(attachment => <MessageAttachment key={attachment.id || attachment.path} attachment={attachment} />)}
  </ul>
}
