import { useEffect, useState, type ReactNode } from 'react'
import type { HandoverTarget, RunSnapshot } from './types'
import { plural, timeOf } from './format'
import { durationMs, formatDuration, openTurn, runNotices, transportLabel } from './run-events'

function useTick(ms: number, enabled: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setTick(value => value + 1), ms)
    return () => window.clearInterval(timer)
  }, [ms, enabled])
}

type WorkingStatusProps = { run?: RunSnapshot; starting: boolean; label: (target: HandoverTarget) => string; children?: ReactNode }

// Under the last message while a run works: what the root agent is doing, for how long, and the helpers' events in a
// collapsed list. `starting` covers the moment between pressing send and the runtime's first event; `children` is the
// button that opens the inspector, where the detail lives.
export function WorkingStatus({ run, starting, label, children }: WorkingStatusProps) {
  useTick(1000, !!run)
  const at = Date.now()
  const turn = openTurn(run?.agents.find(agent => agent.id === 'root'))
  const turnMs = turn ? durationMs(turn.startedAt, null, at) : null
  const totalMs = run ? durationMs(run.startedAt, null, at) : null
  const notices = runNotices(run, label)
  const latest = notices.at(-1)
  const text = starting && !run ? 'Запускаем агента…'
    : turn && turnMs !== null ? `Агент работает · ход ${turn.turn} · ${formatDuration(turnMs)}`
    : totalMs !== null ? `Агент работает · ${formatDuration(totalMs)}` : 'Агент работает'
  const title = turn ? `Режим: ${transportLabel(turn.transport)}${totalMs !== null ? ` · с начала запуска ${formatDuration(totalMs)}` : ''}` : undefined
  return <>
    <div className="working-indicator" role="status"><span className="status-dot working" /><span title={title}>{text}</span>{children}</div>
    {!!notices.length && <details className="chat-notices">
      <summary>
        <span>Команда · {plural(notices.length, ['событие', 'события', 'событий'])}</span>{latest && <em className={latest.kind}>{latest.text}</em>}
      </summary>
      <ul>
        {notices.slice(-40).map(notice => <li key={notice.id} className={notice.kind}>
          <time dateTime={notice.time}>{timeOf(notice.time)}</time><span>{notice.text}</span>
        </li>)}
      </ul>
    </details>}
  </>
}
