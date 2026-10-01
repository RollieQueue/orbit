import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RunSnapshot } from './types'
import { activityLabel, activityOf } from './agent-activity'
import { handoverLabel, handoverReason } from './QuotaPanel'
import { formatDuration, isActiveStatus } from './run-events'
import { buildRunTimeline, tickOffsets, type BarState, type RunTimeline as Timeline, type TimelineBar, type TimelineMarker, type TimelineRow } from './run-timeline'
import { providerName, providers } from './providers'
import { statusText } from './format'
import './run-timeline.css'

// The agents panel shows the team as a list or as this chart; the choice is remembered between openings of the panel.
export type AgentsView = 'list' | 'timeline'
const VIEW_KEY = 'orbit.agents-view'
export function useAgentsView(): [AgentsView, (view: AgentsView) => void] {
  const [view, setView] = useState<AgentsView>(() => { try { return localStorage.getItem(VIEW_KEY) === 'timeline' ? 'timeline' : 'list' } catch { return 'list' } })
  const pick = (next: AgentsView) => {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* private mode: only this session remembers */ }
  }
  return [view, pick]
}
export function AgentsViewSwitch({ view, onChange }: { view: AgentsView; onChange: (view: AgentsView) => void }) {
  const option = (id: AgentsView, label: string) =>
    <button type="button" className={view === id ? 'active' : ''} aria-pressed={view === id} onClick={() => onChange(id)}>{label}</button>
  return <div className="agents-view-switch" role="group" aria-label="Вид команды">{option('list', 'Список')}{option('timeline', 'Таймлайн')}</div>
}

// The clock open turns grow with: it ticks only while the run works (events alone can be minutes apart).
function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}
// The width the chart has, which sets how many labels the minutes axis can hold.
function useWidth() {
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(340)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth || 340)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

// The chart's side margin (run-timeline.css --tl-pad) and the room one axis label needs, in pixels.
const PAD = 14
const LABEL_WIDTH = 84
const stateName: Record<BarState, string> = {
  working: 'Работает', waiting: 'Ожидает', paused: 'Пауза', done: 'Ход завершён', error: 'Ошибка', cancelled: 'Остановлен',
  interrupted: 'Прерван', restarting: 'Остановлен перезапуском Orbit',
}
const endName: Record<string, string> = {
  done: 'завершил работу', error: 'завершился с ошибкой', cancelled: 'остановлен', interrupted: 'прерван', restarting: 'остановлен перезапуском Orbit',
}
// Stopped and interrupted bars share one colour, so they share one entry.
const legendName: Partial<Record<BarState, string>> = {
  working: 'идёт', done: 'ход завершён', waiting: 'ждёт', paused: 'пауза', error: 'ошибка', cancelled: 'остановлен или прерван', restarting: 'перезапуск',
}
const legendOrder: BarState[] = ['working', 'done', 'waiting', 'paused', 'error', 'cancelled', 'restarting']

// «35 мин», not «35 мин 0 с»: the whole-minute figures of a long run.
const neat = (ms: number) => formatDuration(ms).replace(/ 0 с$/, '')
const clock = (time: number) => new Date(time).toLocaleTimeString('ru-RU')
// «0», «0:30», «10 мин», «1 ч», «1 ч 30 мин»: an axis label for an offset from the start.
function tickLabel(offset: number) {
  const seconds = Math.round(offset / 1000)
  if (seconds === 0) return '0'
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60
  if (hours) return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`
  return rest ? `${minutes}:${String(rest).padStart(2, '0')}` : `${minutes} мин`
}
const percent = (part: number, whole: number) => {
  if (!(whole > 0)) return '—'
  const value = Math.round(part / whole * 100)
  return part > 0 && value === 0 ? '<1%' : `${value}%`
}
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const modelOf = (row: TimelineRow) => [providerName(row.providerId) || row.providerId, row.model].filter(Boolean).join(' · ')

type TipContent = { title: string; lines: string[] }
// The tooltip's text is made at every render with the clock, so the figures of an open turn keep running under the pointer.
type MakeTip = (now: number) => TipContent
type Tip = { make: MakeTip; x: number; y: number; below: boolean }

function barTip(row: TimelineRow, bar: TimelineBar, index: number, now: number): TipContent {
  const length = neat((bar.open ? Math.max(now, bar.start) : bar.end) - bar.start)
  const calls = bar.nativeToolCalls + bar.orbitToolCalls
  return {
    title: row.name,
    lines: [
      modelOf(row),
      // The provider's own turn number restarts after a change of subscription, so the bar's place in the row is counted instead.
      bar.estimated ? 'Ходы не записаны: по времени запуска и завершения агента' : `Ход ${index + 1}${row.bars.length > 1 ? ` из ${row.bars.length}` : ''}`,
      bar.open ? `С ${clock(bar.start)} · идёт ${length}` : `${clock(bar.start)} → ${clock(bar.end)} · ${length}`,
      calls ? `Действий: ${calls} (CLI ${bar.nativeToolCalls} · Orbit ${bar.orbitToolCalls})` : '',
      bar.cut ? 'Конец хода не записан: запуск прервался' : stateName[bar.state],
    ].filter(Boolean),
  }
}
function markerTip(marker: TimelineMarker, names: Map<string, string>): TipContent {
  const name = marker.agentId ? names.get(marker.agentId) || marker.agentId : ''
  if (marker.kind === 'spawned') {
    const parent = marker.rowId ? names.get(marker.rowId) : ''
    return { title: `Создан помощник «${name}»`, lines: [parent ? `${parent} · ${clock(marker.at)}` : clock(marker.at)] }
  }
  if (marker.kind === 'finished') return { title: `«${name}» ${endName[marker.state || 'done'] || ''}`.trim(), lines: [clock(marker.at)] }
  if (marker.kind === 'handover' && marker.handover) {
    const { from, to } = marker.handover
    return { title: `«${name}» сменил подписку`, lines: [`${handoverLabel(providers, from)} → ${handoverLabel(providers, to)}`, handoverReason(marker.handover), clock(marker.at)] }
  }
  return { title: 'Перезапуск Orbit', lines: [marker.restart?.reason || 'Агент запросил перезапуск', clock(marker.at)] }
}
function segmentTip(helpers: number, start: number, end: number): TipContent {
  const text = helpers === 0 ? 'Ни один помощник не работал' : helpers === 1 ? 'Работал один помощник'
    : `Одновременно работали помощников: ${helpers}`
  return {
    title: text,
    lines: [`${clock(start)} → ${clock(end)} · ${neat(end - start)}`, ...(helpers >= 2 ? ['Ход помощника идёт и пока он ждёт своих помощников'] : [])],
  }
}

// `visible` is the activity filter's choice of rows (see visibleAgents): only the rows shown change, the chart's figures stay those of the whole team.
type RunTimelineProps = { run: RunSnapshot; selectedId?: string; onSelect: (agentId: string) => void; visible?: Map<string, 'match' | 'context'> }

// Who worked when: a bar per provider turn for every agent (helpers under their parent), the parallelism strip on top, and
// the numbers about waiting. Open turns grow with the clock while the run works; a row selects the agent for the inspector.
export function RunTimeline({ run, selectedId, onSelect, visible }: RunTimelineProps) {
  const now = useClock(isActiveStatus(run.status))
  const timeline: Timeline = useMemo(() => buildRunTimeline(run, now), [run, now])
  const { ref, width } = useWidth()
  const [tip, setTip] = useState<Tip | null>(null)
  const { rows, summary, start, end } = timeline
  const span = Math.max(end - start, 1)
  const at = (time: number) => Math.min(Math.max((time - start) / span, 0), 1)
  const left = (time: number) => `${at(time) * 100}%`
  const wide = (from: number, to: number) => `${(at(to) - at(from)) * 100}%`
  const ticks = tickOffsets(span, Math.max(2, Math.floor((width - 2 * PAD) / LABEL_WIDTH)))
  const names = new Map(rows.map(row => [row.agentId, row.name]))
  const markersOf = new Map<string, TimelineMarker[]>()
  for (const marker of timeline.markers) if (marker.rowId) markersOf.set(marker.rowId, [...(markersOf.get(marker.rowId) || []), marker])
  const restart = timeline.markers.find(marker => marker.kind === 'restart')
  const hasBars = rows.some(row => row.bars.length > 0)
  const hasHelpers = rows.some(row => !row.isRoot)

  const showTip = (event: ReactPointerEvent<HTMLElement>, make: MakeTip) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const below = rect.top < 150
    setTip({ make, x: event.clientX, y: below ? rect.bottom : rect.top, below })
  }
  const tipHandlers = (make: MakeTip) => ({
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => showTip(event, make),
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { const x = event.clientX; setTip(current => current && current.x !== x ? { ...current, x } : current) },
    onPointerLeave: () => setTip(null),
  })
  // What every track draws behind its bars: the axis' grid lines, and the dashed line where Orbit restarted.
  const grid = <>
    {ticks.map(offset => <i key={offset} className="run-timeline-grid" style={{ left: `${offset / span * 100}%` }} />)}
    {restart && <i className="run-timeline-restart" style={{ left: left(restart.at) }} />}
  </>

  const states = new Set<BarState>(rows.flatMap(row => row.bars.map(bar => bar.state === 'interrupted' ? 'cancelled' : bar.state)))
  const legend = legendOrder.filter(state => states.has(state))
  const anyEstimated = rows.some(row => row.bars.some(bar => bar.estimated))
  const anyMarker = (kind: TimelineMarker['kind']) => timeline.markers.some(marker => marker.kind === kind)
  const anyQueue = rows.some(row => row.queue && (row.queue.end - row.queue.start) / span > 0.015)

  const tipText = tip?.make(now)

  return <section className="run-timeline" ref={ref} aria-label="Таймлайн запуска">
    {!hasBars ? <p className="run-timeline-empty">Времени работы агентов пока нет: таймлайн заполнится, когда агенты начнут ходы. Агентов можно выбрать в виде «Список».</p> : <>
      <dl className="run-timeline-summary">
        <div title="От начала запуска до его конца (или до сейчас, пока он идёт)">
          <dt>Запуск</dt><dd>{neat(summary.wallMs)}{timeline.live ? ' · идёт' : ''}</dd>
        </div>
        <div title={`Время, когда одновременно шли ходы двух и больше помощников. Больше всего сразу: ${summary.maxHelpers}. Ход считается целиком, с ожиданием своих помощников: настоящей параллельной работы может быть меньше`}>
          <dt>Параллельно (≥2)</dt><dd>{neat(summary.parallelMs)} · {percent(summary.parallelMs, summary.wallMs)}</dd>
        </div>
        <div title="Время, когда не работал ни один помощник: главный агент один или запуск чего-то ждал">
          <dt>Без помощников</dt><dd>{neat(summary.noHelperMs)} · {percent(summary.noHelperMs, summary.wallMs)}</dd>
        </div>
        <div title="Какую часть времени работы всех агентов заняли ходы главного агента. Работа помощников складывается: параллельные ходы считаются каждый">
          <dt>Доля главного агента</dt><dd>{percent(summary.rootMs, summary.rootMs + summary.helpersMs)}</dd>
        </div>
      </dl>
      <ul className="run-timeline-legend" aria-label="Обозначения">
        {legend.map(state => <li key={state}><span className="run-timeline-swatch" data-state={state} />{legendName[state]}</li>)}
        {anyEstimated && <li><span className="run-timeline-swatch" data-estimated="true" data-state="done" />по времени запуска</li>}
        {anyMarker('spawned') && <li><span className="run-timeline-pin" />создан помощник</li>}
        {anyMarker('finished') && <li><span className="run-timeline-dot" />закончил</li>}
        {anyMarker('handover') && <li><span className="run-timeline-diamond" />смена подписки</li>}
        {anyQueue && <li><span className="run-timeline-queue-sample" />в очереди</li>}
      </ul>
      {restart && <p className="run-timeline-restart-note" {...tipHandlers(() => markerTip(restart, names))}>
        ⟲ Перезапуск Orbit · {clock(restart.at)}{restart.restart?.reason ? ` · ${restart.restart.reason}` : ''}
      </p>}
      <div className="run-timeline-axis" aria-hidden="true">
        {ticks.map((offset, index) => <span key={offset} className={index === 0 ? 'first' : offset / span > 0.9 ? 'last' : ''}
          style={{ left: `calc(var(--tl-pad) + (100% - 2 * var(--tl-pad)) * ${offset / span})` }}>{tickLabel(offset)}</span>)}
      </div>
      <div className="run-timeline-rows">
        {hasHelpers && <div className="run-timeline-parallel">
          <div className="run-timeline-parallel-head">
            <span>Помощники одновременно{summary.maxHelpers ? ` · пик ${summary.maxHelpers}` : ': не работали'}</span>
            <span className="run-timeline-shades" role="img" aria-label="Оттенок показывает, сколько помощников работало одновременно: от нуля до четырёх и больше">
              {[0, 1, 2, 3, 4].map(count => <span key={count}><i className={`run-timeline-shade h${count}`} />{count === 4 ? '4+' : count}</span>)}
            </span>
          </div>
          <span className="run-timeline-track strip" aria-hidden="true">
            {grid}
            {timeline.concurrency.map((part, index) => <span key={index} className={`run-timeline-seg h${Math.min(part.helpers, 4)}`}
              style={{ left: left(part.start), width: wide(part.start, part.end) }} {...tipHandlers(() => segmentTip(part.helpers, part.start, part.end))} />)}
          </span>
        </div>}
        {rows.filter(row => !visible || visible.has(row.agentId)).map(row => {
          const selected = row.agentId === selectedId
          // A waiting agent is «в очереди» only when it really is queued: waiting for its helpers or a message reads as that.
          const source = row.status === 'waiting' ? run.agents.find(agent => agent.id === row.agentId) : undefined
          const queued = row.status === 'waiting' && (!source || activityOf(source) === 'queued')
          const worked = row.bars.length ? `${row.bars.every(bar => bar.estimated) ? '≈ ' : ''}${neat(row.workMs)}` : queued ? 'в очереди' : ''
          return <button type="button" key={row.agentId} className={`run-timeline-row${selected ? ' selected' : ''}${visible?.get(row.agentId) === 'context' ? ' context' : ''}`} aria-pressed={selected}
            aria-label={`${row.name}: ${source ? activityLabel(source) : statusText(row.status)}${row.bars.length ? `, работал ${neat(row.workMs)}` : ''}`} onClick={() => onSelect(row.agentId)}>
            <span className="run-timeline-name" style={{ paddingLeft: Math.min(row.depth, 4) * 10 }}>
              <span className={`status-dot ${row.status}`} />
              <strong>{row.name}</strong>
              {worked && <em>{worked}</em>}
            </span>
            <span className="run-timeline-track" aria-hidden="true">
              {grid}
              {row.queue && <span className="run-timeline-queue" style={{ left: left(row.queue.start), width: wide(row.queue.start, row.queue.end) }}
                {...tipHandlers(() => ({ title: row.name, lines: [`В очереди: создан ${clock(row.queue!.start)}, ещё не работал`, neat(row.queue!.end - row.queue!.start)] }))} />}
              {row.bars.map((bar, index) => <span key={index} className="run-timeline-bar" data-agent={row.agentId} data-state={bar.state}
                data-open={bar.open || undefined} data-estimated={bar.estimated || undefined}
                style={{ left: left(bar.start), width: wide(bar.start, bar.end) }} {...tipHandlers(at => barTip(row, bar, index, at))} />)}
              {(markersOf.get(row.agentId) || []).map((marker, index) => <span key={index} className={`run-timeline-mark ${marker.kind}`} data-state={marker.state}
                style={{ left: left(marker.at) }} {...tipHandlers(() => markerTip(marker, names))} />)}
            </span>
          </button>
        })}
      </div>
    </>}
    {tip && tipText && <div className={`run-timeline-tip${tip.below ? ' below' : ''}`} role="tooltip"
      style={{ left: Math.min(Math.max(tip.x, 130), Math.max(window.innerWidth - 130, 130)), top: tip.y }}>
      <strong>{clip(tipText.title, 90)}</strong>
      {tipText.lines.map((line, index) => <span key={index}>{clip(line, 240)}</span>)}
    </div>}
  </section>
}
