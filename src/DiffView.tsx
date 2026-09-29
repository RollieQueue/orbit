import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { parseUnifiedDiff, type DiffFile, type DiffFileStatus } from './diff-parse'
import { plural } from './format'
import './diff-view.css'

type Props = { diff: string; truncated?: boolean; binary?: boolean; maxLines?: number; title?: string }

type Row =
  | { t: 'file'; file: DiffFile }
  | { t: 'hunk'; text: string }
  | { t: 'line'; kind: 'context' | 'add' | 'del'; oldLine: number | null; newLine: number | null; text: string }
  | { t: 'note'; text: string }

const STATUS_LABEL: Record<DiffFileStatus, string> = {
  modified: 'изменён', added: 'создан', deleted: 'удалён', renamed: 'переименован'
}
const SIGN = { context: ' ', add: '+', del: '-' } as const
const NO_NEWLINE = 'Нет перевода строки в конце файла'
// A minified bundle in a diff would otherwise put megabytes of text into one DOM node.
const MAX_LINE_CHARS = 4000

function flatten(files: DiffFile[]): Row[] {
  const rows: Row[] = []
  const showFile = files.length > 1
  for (const file of files) {
    // A lone file has no header row, unless it is a rename: that is all its diff says.
    if (showFile || file.status === 'renamed') rows.push({ t: 'file', file })
    for (const hunk of file.hunks) {
      rows.push({ t: 'hunk', text: hunk.header })
      for (const l of hunk.lines) {
        if (l.kind === 'meta') rows.push({ t: 'note', text: l.text.startsWith('\\ No newline') ? NO_NEWLINE : l.text.replace(/^\\\s*/, '') })
        else rows.push({ t: 'line', kind: l.kind, oldLine: l.oldLine, newLine: l.newLine, text: l.text })
      }
    }
  }
  return rows
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… (+${text.length - MAX_LINE_CHARS})` : text
}

function fileTitle(f: DiffFile): string {
  if (f.status === 'renamed' && f.oldPath && f.newPath && f.oldPath !== f.newPath) return `${f.oldPath} → ${f.newPath}`
  return f.newPath || f.oldPath || 'без имени'
}

export default function DiffView({ diff, truncated, binary, maxLines = 400, title }: Props) {
  const parsed = useMemo(() => {
    const files = parseUnifiedDiff(diff)
    const rows = flatten(files)
    let maxNo = 0
    let added = 0
    let removed = 0
    for (const f of files) { added += f.added; removed += f.removed }
    for (const r of rows) if (r.t === 'line') maxNo = Math.max(maxNo, r.oldLine ?? 0, r.newLine ?? 0)
    return { files, rows, added, removed, digits: Math.max(2, String(maxNo).length), binary: files.some(f => f.binary) }
  }, [diff])

  // Expansion belongs to one diff text: a new diff starts collapsed again without an effect.
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const limit = Math.max(1, maxLines)
  const expanded = expandedDiff === diff
  const total = parsed.rows.length
  const shown = expanded ? parsed.rows : parsed.rows.slice(0, limit)
  const isBinary = Boolean(binary) || parsed.binary
  const empty = total === 0 && !isBinary

  const copyDiff = async () => {
    let next: 'done' | 'failed' = 'done'
    try {
      await navigator.clipboard.writeText(diff)
    } catch {
      next = 'failed'
    }
    setCopy(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopy('idle'), 1600)
  }

  const numberStyle = { ['--diff-digits' as string]: parsed.digits } as CSSProperties

  return (
    <section className="diff-view" role="region" aria-label={title ? `Diff: ${title}` : 'Diff'}>
      <div className="diff-toolbar">
        {title && <span className="diff-title" title={title}>{title}</span>}
        {total > 0 && (
          <span className="diff-stat" aria-label={`Добавлено ${parsed.added}, удалено ${parsed.removed}`}>
            <span className="diff-stat-add">+{parsed.added}</span> <span className="diff-stat-del">−{parsed.removed}</span>
          </span>
        )}
        {diff && (
          <button type="button" className="diff-btn diff-copy" onClick={copyDiff}>
            {copy === 'done' ? 'Скопировано' : copy === 'failed' ? 'Не удалось' : 'Копировать'}
          </button>
        )}
      </div>
      {truncated && <div className="diff-notice diff-notice-truncated" role="note">Diff обрезан: показана часть изменений</div>}
      {isBinary && <div className="diff-notice diff-notice-binary" role="note">Бинарный файл: сравнение недоступно</div>}
      {empty && <div className="diff-notice diff-notice-empty" role="note">Изменений нет</div>}
      {total > 0 && (
        <div className="diff-scroll" tabIndex={0} role="group" aria-label="Содержимое diff" style={numberStyle}>
          <div className="diff-grid">
            {shown.map((r, i) => {
              if (r.t === 'file') {
                return (
                  <div className="diff-row diff-file" key={i}>
                    <span className="diff-file-path">{fileTitle(r.file)}</span>
                    <span className="diff-file-meta">{STATUS_LABEL[r.file.status]} · +{r.file.added} −{r.file.removed}</span>
                  </div>
                )
              }
              if (r.t === 'hunk') return <div className="diff-row diff-hunk" key={i}>{r.text}</div>
              if (r.t === 'note') return <div className="diff-row diff-marker" key={i}>{r.text}</div>
              return (
                <div className={`diff-row diff-line diff-${r.kind}`} key={i}>
                  <span className="diff-no diff-no-old" aria-hidden="true">{r.oldLine ?? ''}</span>
                  <span className="diff-no diff-no-new" aria-hidden="true">{r.newLine ?? ''}</span>
                  <span className="diff-sign">{SIGN[r.kind]}</span>
                  <span className="diff-code">{clip(r.text)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {!expanded && total > shown.length && (
        <button type="button" className="diff-btn diff-more" onClick={() => setExpandedDiff(diff)}>
          Показать все ({plural(total, ['строка', 'строки', 'строк'])})
        </button>
      )}
    </section>
  )
}
