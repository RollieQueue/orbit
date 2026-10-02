import type { Capability } from './types'

// How the Skills panel orders what Orbit built for itself: by type (headed groups), by use, or by date. Pure, no React.

export type SkillOrder = 'type' | 'uses' | 'date'
export type SkillGroupId = 'tools' | 'pages' | 'files' | 'instructions'
export type SkillGroup = { id: SkillGroupId; title: string; skills: Capability[]; count: number }

export const SKILL_ORDERS: { id: SkillOrder; label: string }[] = [
  { id: 'type', label: 'по типу' }, { id: 'uses', label: 'по применению' }, { id: 'date', label: 'по дате' },
]
export const GROUP_TITLES: Record<SkillGroupId, string> = { tools: 'Инструменты', pages: 'Страницы', files: 'Пакеты с файлами', instructions: 'Инструкции' }
const GROUP_ORDER: SkillGroupId[] = ['tools', 'pages', 'files', 'instructions']

// A package that shows a page on a trigger (task-completed full screen, quota-panel inside the quota window).
export const hasPages = (skill: Capability): boolean => !!skill.package && (skill.triggers ?? []).length > 0

// The one type a skill is listed under: commands make it a tool, else pages, else other files, else it is an instruction.
export function groupOf(skill: Capability): SkillGroupId {
  if (skill.commands?.length) return 'tools'
  if (hasPages(skill)) return 'pages'
  if (skill.files?.length) return 'files'
  return 'instructions'
}

const byUse = (a: Capability, b: Capability): number => Number(!!b.pinned) - Number(!!a.pinned) || (b.uses ?? 0) - (a.uses ?? 0)
const timeOf = (skill: Capability): number => { const time = Date.parse(skill.updatedAt ?? ''); return Number.isFinite(time) ? time : 0 }
const byDate = (a: Capability, b: Capability): number => Number(!!b.pinned) - Number(!!a.pinned) || timeOf(b) - timeOf(a)

// Pinned first, then by use (or by the last change); the sort is stable, so equal skills keep the store's order.
export const sortSkills = (skills: readonly Capability[], order: Exclude<SkillOrder, 'type'>): Capability[] => [...skills].sort(order === 'date' ? byDate : byUse)

// Groups for the "by type" view, inside a group pinned first, then by use. `connectors` are the external MCP servers, which
// are tools too: they count in the "Инструменты" heading, and that group stays even when empty. Other groups appear only
// when they hold a skill.
export function groupSkills(skills: readonly Capability[], connectors = 0): SkillGroup[] {
  const sorted = sortSkills(skills, 'uses')
  return GROUP_ORDER.map(id => {
    const own = sorted.filter(skill => groupOf(skill) === id)
    return { id, title: GROUP_TITLES[id], skills: own, count: own.length + (id === 'tools' ? connectors : 0) }
  }).filter(group => group.id === 'tools' || group.skills.length)
}

// A saved choice that is not one of the orders (a stale or hand-edited value) falls back to "by type".
export const parseOrder = (value: unknown): SkillOrder => SKILL_ORDERS.some(item => item.id === value) ? value as SkillOrder : 'type'
