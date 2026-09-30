import type { Capability, SkillAction } from './types'

// The celebration an action skill shows when a task is completed: pure decisions and text handling only (CelebrationOverlay.tsx
// draws it). The action lives in the skill's instructions as an `orbit-action` block that the skill store validates.

// The player needs a moment to load before the clip starts.
const PLAYER_LOAD_MS = 3000
const MISSED_WINDOW_MS = 120_000

// The player address is built from the video id alone, never from the link the user typed.
export function embedUrl(action: Pick<SkillAction, 'videoId' | 'start' | 'end'>): string {
  const query = `autoplay=1&start=${action.start}&end=${action.end}&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&modestbranding=1`
  return `https://www.youtube.com/embed/${encodeURIComponent(action.videoId)}?${query}`
}

export const celebrationMs = (action: Pick<SkillAction, 'start' | 'end'>): number => (action.end - action.start) * 1000 + PLAYER_LOAD_MS

// The first enabled skill with a celebration for a completed task; project skills before global ones.
export function pickCelebration(skills: Capability[]): SkillAction | null {
  const candidates = skills.filter(skill => skill.enabled !== false && skill.action?.on === 'task-completed' && skill.action.effect === 'celebration')
  const chosen = candidates.find(skill => skill.scope === 'project') ?? candidates[0]
  return chosen?.action ?? null
}

// Only a run that really completed celebrates. A run that ends 'restarting' is continued after the reboot, and that
// continuation run is the one that completes.
export const isCompletion = (event: { type: string; status?: string }): boolean =>
  event.type === 'run.finished' && (event.status === undefined || event.status === 'completed')

// Runs that completed shortly before now and were not celebrated: used once after the window (re)loads, so a run that
// completed while the window was reloading still celebrates. Newest first.
export function missedCompletions(
  runs: Array<{ id: string; status?: string; finishedAt?: string }>, seen: ReadonlySet<string>, now: number, windowMs = MISSED_WINDOW_MS,
): string[] {
  return runs
    .map(run => ({ id: run.id, at: run.status === 'completed' && run.finishedAt ? Date.parse(run.finishedAt) : NaN }))
    .filter(run => !seen.has(run.id) && Number.isFinite(run.at) && now - run.at <= windowMs)
    .sort((a, b) => b.at - a.at)
    .map(run => run.id)
}

export type Motion = { x: number; y: number; vx: number; vy: number }
// One step of the DVD-logo motion (velocity in px/ms): the box reflects at every edge of the area and stays inside it.
// A box larger than the area sticks to the top-left corner. hit = it bounced in this step.
export function bounce(state: Motion, dtMs: number, box: { w: number; h: number }, area: { w: number; h: number }): Motion & { hit: boolean } {
  const axis = (position: number, speed: number, limit: number) => {
    const next = position + speed * dtMs
    if (next < 0) return { position: Math.min(-next, limit), speed: Math.abs(speed), hit: true }
    if (next > limit) return { position: Math.max(2 * limit - next, 0), speed: -Math.abs(speed), hit: true }
    return { position: next, speed, hit: false }
  }
  const x = axis(state.x, state.vx, Math.max(0, area.w - box.w))
  const y = axis(state.y, state.vy, Math.max(0, area.h - box.h))
  return { x: x.position, y: y.position, vx: x.speed, vy: y.speed, hit: x.hit || y.hit }
}

const BLOCK = /```orbit-action[ \t]*\r?\n[\s\S]*?```/

// The skill's instructions with the orbit-action block set to this video and clip: the first existing block is replaced in
// place, otherwise one is appended after a blank line. The rest of the text and its line-ending style stay as they were.
export function withAction(instructions: string, action: { video: string; start: number; end: number }): string {
  const eol = instructions.includes('\r\n') ? '\r\n' : '\n'
  const block = ['```orbit-action', 'on: task-completed', 'effect: celebration', `video: ${action.video.trim()}`, `start: ${action.start}`, `end: ${action.end}`, '```'].join(eol)
  if (BLOCK.test(instructions)) return instructions.replace(BLOCK, () => block)
  const body = instructions.replace(/\s+$/, '')
  return body ? `${body}${eol}${eol}${block}${eol}` : `${block}${eol}`
}
