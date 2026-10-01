import type { Agent } from './types'
import { shownStatus } from './run-events'

// What an agent is doing right now, for the agents panel's filter and state labels. The runtime keeps one status for «not working yet»
// (status 'waiting') and tells the reasons apart only in agent.detail, so the detail is read here.
export type Activity = 'working' | 'queued' | 'waiting' | 'paused' | 'done' | 'error' | 'cancelled'
export type WaitingReason = 'helpers' | 'message' | 'approval'

// The detail strings electron/runtime/*.mts sets while an agent waits (saved runs of older versions carry the same ones).
// tests/agent-activity.test.cjs checks that the runtime still sets them: a renamed detail must not turn into «В очереди» unnoticed.
export const WAITING_DETAILS: Record<WaitingReason, string> = {
  helpers: 'Waiting for delegated results',
  message: 'Waiting for a message',
  approval: 'Waiting for your permission',
}

export function waitingReasonOf(agent: Agent): WaitingReason | undefined {
  if (agent.status !== 'waiting') return undefined
  return (Object.keys(WAITING_DETAILS) as WaitingReason[]).find(reason => WAITING_DETAILS[reason] === agent.detail)
}

// 'Queued', 'Queued follow-up', 'Waiting for a provider slot', 'Continuing conversation' and anything unknown are all the queue.
export function activityOf(agent: Agent): Activity {
  const shown = shownStatus(agent)
  switch (shown) {
    case 'paused': return 'paused'
    case 'working': return 'working'
    case 'done': return 'done'
    case 'error': return 'error'
    case 'cancelled': case 'interrupted': case 'restarting': return 'cancelled'
    default: return waitingReasonOf(agent) ? 'waiting' : 'queued'
  }
}

export const activityNames: Record<Activity, string> = {
  working: 'Работает', queued: 'В очереди', waiting: 'Ждёт', paused: 'Пауза', done: 'Завершён', error: 'Ошибка', cancelled: 'Остановлен',
}
const waitingNames: Record<WaitingReason, string> = { helpers: 'Ждёт помощников', message: 'Ждёт сообщения', approval: 'Ждёт разрешения' }

// The state label of an agent's row. An agent that ended by an interruption or an Orbit restart keeps its own, more exact wording.
export function activityLabel(agent: Agent): string {
  if (agent.status === 'interrupted') return 'Прерван'
  if (agent.status === 'restarting') return 'Перезапуск Orbit'
  const reason = waitingReasonOf(agent)
  return reason && activityOf(agent) === 'waiting' ? waitingNames[reason] : activityNames[activityOf(agent)]
}

// Who picked the agent's reasoning level (Agent.effortSource), for a tooltip.
export const effortSourceNames: Record<string, string> = {
  caller: 'выбрал Orbit', routing: 'по таблице маршрутизации', pool: 'из пула провайдеров', parent: 'как у родителя', settings: 'из настроек провайдера',
}

// The filter: everything, the agents that are still going, or one activity.
export type AgentFilter = 'all' | 'active' | Activity
export const AGENT_FILTERS: AgentFilter[] = ['all', 'active', 'working', 'queued', 'waiting', 'paused', 'done', 'error', 'cancelled']
export const isAgentFilter = (value: unknown): value is AgentFilter => AGENT_FILTERS.includes(value as AgentFilter)
export const filterNames: Record<AgentFilter, string> = {
  all: 'Все', active: 'Активные', working: 'Работают', queued: 'В очереди', waiting: 'Ждут', paused: 'На паузе', done: 'Завершены', error: 'С ошибкой', cancelled: 'Остановлены',
}
const ACTIVE: Activity[] = ['working', 'queued', 'waiting', 'paused']
export const matchesFilter = (filter: AgentFilter, activity: Activity) => filter === 'all' || (filter === 'active' ? ACTIVE.includes(activity) : filter === activity)

export type ActivityCounts = Record<AgentFilter, number> & { waitingBy: Record<WaitingReason, number> }
export function countActivities(agents: Agent[]): ActivityCounts {
  const counts: ActivityCounts = { all: agents.length, active: 0, working: 0, queued: 0, waiting: 0, paused: 0, done: 0, error: 0, cancelled: 0, waitingBy: { helpers: 0, message: 0, approval: 0 } }
  for (const agent of agents) {
    const activity = activityOf(agent)
    counts[activity]++
    if (ACTIVE.includes(activity)) counts.active++
    if (activity === 'waiting') counts.waitingBy[waitingReasonOf(agent)!]++
  }
  return counts
}

// The agents a filter shows: the matching ones, and their ancestors as context (the tree stays readable). Absent = hidden.
// `all` shows everyone as a match.
export function visibleAgents(agents: Agent[], filter: AgentFilter): Map<string, 'match' | 'context'> {
  const shown = new Map<string, 'match' | 'context'>()
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  for (const agent of agents) if (matchesFilter(filter, activityOf(agent))) shown.set(agent.id, 'match')
  for (const agent of agents) {
    if (shown.get(agent.id) !== 'match') continue
    const seen = new Set([agent.id])
    for (let parent = byId.get(agent.parentId || ''); parent && !seen.has(parent.id); parent = byId.get(parent.parentId || '')) {
      seen.add(parent.id)
      if (!shown.has(parent.id)) shown.set(parent.id, 'context')
    }
  }
  return shown
}
