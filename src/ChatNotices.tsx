import { useEffect, useState, type ReactNode } from 'react'
import type { HandoverTarget, RunSnapshot } from './types'
import { plural, timeOf } from './format'
import { actionCount, durationMs, formatDuration, openTurn, runNotices, thinkingText, transportLabel } from './run-events'

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
  const root = run?.agents.find(agent => agent.id === 'root')
  // A paused root has no running turn (the paused one was cut off), so no turn timer is shown.
  const paused = !!root?.paused
  const turn = paused ? undefined : openTurn(root)
  const actions = actionCount(root)
  const turnMs = turn ?durationMs(turn.startedAt, null, at) : null
  const totalMs = run ? durationMs(run.startedAt, null, at) : null
  const notices = runNotices(run, label)
  const latest = notices.at(-1)
  // A thinking model streams nothing visible, sometimes for minutes: the line says it thinks and how much so far.
  const thinking = thinkingText(turn?.thinking)
  const text = paused ? 'Агент на паузе' : starting && !run ? 'Запускаем агента…'
    : turn && turnMs !== null ? ['Агент работает', actions ? plural(actions, ['действие', 'действия', 'действий']) : '', formatDuration(turnMs), thinking].filter(Boolean).join(' · ')
    : totalMs !== null ? `Агент работает · ${formatDuration(totalMs)}` : 'Агент работает'
  // In session mode one turn is one model run that does the whole task, so the turn number says little; actions are counted instead.
  const title = turn ? `Ход ${turn.turn}: ход — один запуск модели; в режиме сессии модель делает за один ход много действий (команды, правки, инструменты Orbit). `
    + `Режим: ${transportLabel(turn.transport)}${totalMs !== null ? ` · с начала запуска ${formatDuration(totalMs)}` : ''}`
    + (thinking ? '. «Думает»: модель рассуждает перед следующим шагом; число токенов — примерная оценка Claude CLI для этого размышления' : '') : undefined
  return <>
    <div className="working-indicator" role="status"><span className={`status-dot ${paused ? 'paused' : 'working'}`} /><span title={title}>{text}</span>{children}</div>
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
