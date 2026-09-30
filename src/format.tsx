import type { MouseEvent, ReactNode } from 'react'
import type { RunStatus } from './types'

const statusNames: Record<RunStatus, string> = {
  idle: 'Готов', waiting: 'В очереди', working: 'Работает', done: 'Завершён', completed: 'Завершён',
  error: 'Ошибка', failed: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Прерван', restarting: 'Перезапуск Orbit',
}
export const statusText = (status?: RunStatus) => statusNames[status || 'idle']
// «1 файл», «2 файла», «5 файлов»: the noun forms are for 1, 2–4 and 5+.
export const plural = (n: number, forms: [string, string, string]) => {
  const form = n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2
  return `${n} ${forms[form]}`
}
export const timeOf = (time?: string) => {
  if (!time) return ''
  const date = new Date(time)
  return Number.isNaN(date.valueOf()) ? time : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (link) {
      const open = (e: MouseEvent<HTMLAnchorElement>) => { if (window.orbit) { e.preventDefault(); void window.orbit.openExternal(link[2]) } }
      return <a key={i} href={link[2]} target="_blank" rel="noreferrer" onClick={open}>{link[1]}</a>
    }
    return part
  })
}
export function assistantOutput(text: string): string {
  if (!/^\s*\{/.test(text)) return text
  try {
    const envelope = JSON.parse(text)
    if (typeof envelope.content === 'string') return envelope.content || 'Выполняет действия…'
  } catch { /* Display the content string while the envelope is streaming. */ }
  const match = text.match(/^\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (match) {
    // A chunk can end inside a JSON escape (including a Unicode escape).
    const content = match[1].replace(/\\u[0-9a-f]{0,3}$/i, '')
    try { return JSON.parse(`"${content}"`) || 'Формирует ответ…' } catch { /* Wait for a complete escape. */ }
  }
  return 'Формирует ответ…'
}

const heading = (line: string) => /^#{1,6} /.test(line) ? <strong className="md-heading">{inline(line.replace(/^#{1,6} /, ''))}</strong> : inline(line)

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{text.split(/(```[\s\S]*?```)/g).map((block, index) => {
    if (block.startsWith('```')) {
      const split = block.indexOf('\n')
      const language = split < 0 ? 'code' : block.slice(3, split)
      const code = split < 0 ? block.slice(3, -3) : block.slice(split + 1, -3)
      return <pre key={index}><span className="code-language">{language}</span><code>{code}</code></pre>
    }
    return block.split(/\n\s*\n/).filter(Boolean).map((part, n) => {
      const lines = part.split('\n')
      const key = `${index}-${n}`
      const items = (marker: RegExp) => lines.map((line, j) => <li key={j}>{inline(line.replace(marker, ''))}</li>)
      if (lines.every(line => /^\s*[-*] /.test(line))) return <ul key={key}>{items(/^\s*[-*] /)}</ul>
      if (lines.every(line => /^\s*\d+\. /.test(line))) return <ol key={key}>{items(/^\s*\d+\. /)}</ol>
      return <p key={key}>{lines.map((line, j) => <span key={j}>{j > 0 && <br />}{heading(line)}</span>)}</p>
    })
  })}</div>
}
