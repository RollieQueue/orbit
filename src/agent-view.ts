import type { AgentKind, AgentProfile, Capability, TrainingRound } from './types'

// What the «Агенты» tab of the Skills panel shows: trained agents are capabilities with an `agent` field. Pure, no React
// (the test loads this file with type-only imports, like skill-groups.ts).

export type PanelTab = 'skills' | 'agents'
export const PANEL_TABS: { id: PanelTab; label: string }[] = [{ id: 'skills', label: 'Навыки' }, { id: 'agents', label: 'Агенты' }]
// A saved choice that is not one of the tabs (a stale or hand-edited value) falls back to the skills.
export const parseTab = (value: unknown): PanelTab => PANEL_TABS.some(tab => tab.id === value) ? value as PanelTab : 'skills'

export const isAgent = (entry: Capability): boolean => !!entry.agent && typeof entry.agent === 'object'

const timeOf = (entry: Capability): number => { const time = Date.parse(entry.updatedAt ?? ''); return Number.isFinite(time) ? time : 0 }

// The list holds skills and agents together. Skills keep the store's order; agents: pinned first, then by use, then newest.
export function splitCapabilities(list: readonly Capability[]): { skills: Capability[]; agents: Capability[] } {
  const skills: Capability[] = [], agents: Capability[] = []
  for (const entry of list) (isAgent(entry) ? agents : skills).push(entry)
  agents.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.uses ?? 0) - (a.uses ?? 0) || timeOf(b) - timeOf(a))
  return { skills, agents }
}

export const KIND_LABELS: Record<AgentKind, string> = { code: 'код', review: 'ревью', lookup: 'поиск', text: 'текст' }
// An unknown kind (a newer store) shows as it is; no kind shows nothing.
export const kindLabel = (kind?: AgentKind): string => kind ? KIND_LABELS[kind] ?? String(kind) : ''
export const statusLabel = (status?: AgentProfile['status']): string => status === 'trained' ? 'Обучен' : 'Обучается'

const round1 = (value: number): number => Math.round(value * 10) / 10
const clampScore = (score: number): number => Math.min(10, Math.max(0, score))
const scored = (rounds: readonly TrainingRound[]): TrainingRound[] =>
  rounds.filter(item => Number.isFinite(item.score) && Number.isFinite(item.round)).sort((a, b) => a.round - b.round)

export type ChartPad = { left: number; right: number; top: number; bottom: number }
export type ScoreChart = {
  points: { x: number; y: number; round: number; score: number }[]
  path: string
  ticks: { y: number; label: string }[]
  xTicks: { x: number; label: string }[]
}
export const CHART_PAD: ChartPad = { left: 26, right: 12, top: 10, bottom: 22 }
const MAX_X_LABELS = 8

// The geometry of the score-per-round line chart in a width x height box: a fixed 0..10 y axis (ticks at 0, 5, 10), rounds in
// order of their number spread evenly along x (one round sits in the middle). Scores outside the scale are clamped, rounds
// without a number are skipped. Coordinates are rounded to a tenth.
export function scoreChart(rounds: readonly TrainingRound[], width: number, height: number, pad: ChartPad = CHART_PAD): ScoreChart {
  const items = scored(rounds)
  const innerWidth = Math.max(0, width - pad.left - pad.right), innerHeight = Math.max(0, height - pad.top - pad.bottom)
  const yOf = (score: number) => round1(pad.top + innerHeight * (1 - score / 10))
  const xOf = (index: number) => round1(items.length < 2 ? pad.left + innerWidth / 2 : pad.left + (innerWidth * index) / (items.length - 1))
  const points = items.map((item, index) => ({ x: xOf(index), y: yOf(clampScore(item.score)), round: item.round, score: item.score }))
  // At most MAX_X_LABELS round numbers under the axis; the last one is labelled when it does not crowd the previous label.
  const step = Math.max(1, Math.ceil(items.length / MAX_X_LABELS))
  const xTicks: ScoreChart['xTicks'] = []
  let lastLabelled = -Infinity
  points.forEach((point, index) => {
    if (index % step === 0 || (index === points.length - 1 && index - lastLabelled >= Math.ceil(step / 2))) {
      xTicks.push({ x: point.x, label: String(point.round) }); lastLabelled = index
    }
  })
  return {
    points,
    path: points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' '),
    ticks: [0, 5, 10].map(value => ({ y: yOf(value), label: String(value) })),
    xTicks,
  }
}

export type TrainingSummary = { rounds: number; minutes?: number; first?: number; last?: number; best?: number; delta?: number }

// Rounds, time, and the score from the first round to the last (and the best, which the caller shows when it differs).
export function trainingSummary(agent: AgentProfile): TrainingSummary {
  const rounds = agent.rounds ?? []
  const items = scored(rounds)
  const summary: TrainingSummary = { rounds: rounds.length }
  if (Number.isFinite(agent.trainingMinutes) && agent.trainingMinutes! > 0) summary.minutes = Math.round(agent.trainingMinutes!)
  if (items.length) {
    summary.first = items[0].score
    summary.last = items[items.length - 1].score
    summary.best = Math.max(...items.map(item => item.score))
    if (items.length > 1) summary.delta = round1(summary.last - summary.first)
  }
  return summary
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return ''
  const total = Math.round(minutes)
  if (total < 60) return `${total} мин`
  const hours = Math.floor(total / 60), rest = total % 60
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`
}

export const formatScore = (score: number): string => (Math.round(score * 10) / 10).toFixed(1)
export const formatDelta = (delta: number): string => `${delta < 0 ? '−' : '+'}${formatScore(Math.abs(delta))}`

// «Раундов: 4 · Обучение: 1 ч 35 мин · Оценка: 5.1 → 8.4 (+3.3) · лучшая 9.0»; unknown parts are left out.
export function summaryText(summary: TrainingSummary): string {
  const parts = [`Раундов: ${summary.rounds}`]
  if (summary.minutes) parts.push(`Обучение: ${formatMinutes(summary.minutes)}`)
  if (summary.first !== undefined && summary.last !== undefined) {
    const progress = summary.delta !== undefined ? ` → ${formatScore(summary.last)} (${formatDelta(summary.delta)})` : ''
    parts.push(`Оценка: ${formatScore(summary.first)}${progress}`)
    if (summary.best !== undefined && formatScore(summary.best) !== formatScore(summary.last)) parts.push(`лучшая ${formatScore(summary.best)}`)
  }
  return parts.join(' · ')
}

// orbit-skill://<package id>/<file>: every path segment is encoded on its own and '.' / '..' / empty segments are dropped
// (both slashes separate), so the file name cannot climb out of the package folder or smuggle a query or a fragment.
export function galleryUrl(packageId: string, file: string): string {
  const segments = String(file).split(/[\\/]+/).filter(part => part && part !== '.' && part !== '..').map(encodeURIComponent)
  return `orbit-skill://${encodeURIComponent(packageId)}/${segments.join('/')}`
}
