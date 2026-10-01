import type { Capability } from './types'

// When a skill's page is shown (SkillStage.tsx draws it): pure decisions and address building only.

const MISSED_WINDOW_MS = 120_000

// Only a run that really completed triggers. A run that ends 'restarting' is continued after the reboot, and that
// continuation run is the one that completes.
export const isCompletion = (event: { type: string; status?: string }): boolean =>
  event.type === 'run.finished' && (event.status === undefined || event.status === 'completed')

// Runs that completed shortly before now and were not handled: used once after the window (re)loads, so a run that
// completed while the window was reloading still triggers. Newest first.
export function missedCompletions(
  runs: Array<{ id: string; status?: string; finishedAt?: string }>, seen: ReadonlySet<string>, now: number, windowMs = MISSED_WINDOW_MS,
): string[] {
  return runs
    .map(run => ({ id: run.id, at: run.status === 'completed' && run.finishedAt ? Date.parse(run.finishedAt) : NaN }))
    .filter(run => !seen.has(run.id) && Number.isFinite(run.at) && now - run.at <= windowMs)
    .sort((a, b) => b.at - a.at)
    .map(run => run.id)
}

export type SkillPage = { skill: Capability; show: string }

// The pages a skill shows when a task completes; none without a package to serve them from.
export const completionPages = (skill: Capability): SkillPage[] =>
  skill.package ? (skill.triggers ?? []).filter(trigger => trigger.on === 'task-completed').map(trigger => ({ skill, show: trigger.show })) : []

// Enabled skills, project skills before global ones.
const enabledInOrder = (skills: Capability[]): Capability[] => {
  const enabled = skills.filter(skill => skill.enabled !== false)
  return [...enabled.filter(skill => skill.scope === 'project'), ...enabled.filter(skill => skill.scope !== 'project')]
}

// Pages of the enabled skills for a completed task; project skills before global ones, the triggers of one skill keep their order.
export const triggeredSkills = (skills: Capability[]): SkillPage[] => enabledInOrder(skills).flatMap(completionPages)

// Pages the enabled skills show inside the quota window (QuotaPanel.tsx), in the same order.
export const panelPages = (skills: Capability[]): SkillPage[] => enabledInOrder(skills).flatMap(skill =>
  skill.package ? (skill.triggers ?? []).filter(trigger => trigger.on === 'quota-panel').map(trigger => ({ skill, show: trigger.show })) : [])

// The page address: every parameter's current value (booleans as true/false) and what happened. The page reads its settings
// from the query, so a changed parameter applies at once. `show` is a package-relative path; each segment is encoded.
export function skillPageUrl(skill: Capability, show: string, extra: { orbit_event: 'task-completed' | 'preview' | 'quota-panel'; orbit_run?: string }): string {
  const query = new URLSearchParams()
  for (const param of skill.params ?? []) query.set(param.key, String(param.value))
  query.set('orbit_event', extra.orbit_event)
  if (extra.orbit_run) query.set('orbit_run', extra.orbit_run)
  const path = show.split('/').map(encodeURIComponent).join('/')
  return `orbit-skill://${skill.package?.id ?? ''}/${path}?${query}`
}
