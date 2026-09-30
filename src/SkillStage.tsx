import { useCallback, useEffect, useRef, useState } from 'react'
import './skill-stage.css'
import type { RunMap } from './run-events'
import { completionPages, isCompletion, missedCompletions, skillPageUrl, triggeredSkills, type SkillPage } from './skill-triggers'
import type { Capability, Project } from './types'

// The page stage: skills with a task-completed trigger get one of their package pages shown full screen over the whole
// window. useSkillTriggers decides when, SkillStage draws the page in a sandboxed frame; what the page looks like and does is
// up to the skill (it closes itself with parent.postMessage({ type: 'orbit-skill:close' }, '*')).

const HANDLED_KEY = 'orbit.skill-triggered'
const HANDLED_KEEP = 50
// A page that never closes itself must not cover the window for good.
const STAGE_MAX_MS = 10 * 60_000

type Shown = { id: number; url: string; title: string }

// The window's full-screen changes run one after another, so a page opened right after a closed one (or a development
// double mount) still asks about the state the first one left behind.
let fullScreenQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = fullScreenQueue.then(job)
  fullScreenQueue = next.catch(() => undefined)
  return next
}

// A renderer reload while a page shows (self-upgrade) unloads without React cleanup, so the window would stay full screen
// with no stage and no way out. The flag records that the stage switched full screen on; the next start undoes it.
const FULLSCREEN_FLAG = 'orbit.skill-stage.fullscreen'
const flag = (on: boolean) => { try { if (on) sessionStorage.setItem(FULLSCREEN_FLAG, '1'); else sessionStorage.removeItem(FULLSCREEN_FLAG) } catch { /* no storage: no recovery */ } }
const flagged = () => { try { return sessionStorage.getItem(FULLSCREEN_FLAG) === '1' } catch { return false } }

// Full screen while a page is shown; the window goes back to normal only if it was not full screen before.
// Without window.orbit (browser dev mode) there is nothing to switch.
function holdFullScreen(): () => void {
  const api = window.orbit
  if (!api?.setFullScreen) return () => undefined
  const was = enqueue(async () => { const before = await api.setFullScreen(true); if (!before) flag(true); return before }).catch(() => true)
  return () => { void enqueue(async () => { if (!(await was)) { await api.setFullScreen(false); flag(false) } }).catch(() => undefined) }
}

// Once per start: a full screen left by a page that a reload cut off is undone.
function releaseStaleFullScreen() {
  const api = window.orbit
  if (!api?.setFullScreen || !flagged()) return
  flag(false)
  void enqueue(() => api.setFullScreen(false)).catch(() => undefined)
}

export function SkillStage({ page, onClose }: { page: Shown; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeNow = useRef(onClose)
  closeNow.current = onClose
  useEffect(() => {
    const timer = window.setTimeout(() => closeNow.current(), STAGE_MAX_MS)
    return () => window.clearTimeout(timer)
  }, [page.id])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    // Captured first, so Esc closes only the page and not the panel under it.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeNow.current() } }
    // Only a message from this frame's own window closes the stage: other frames and the host cannot close it by accident.
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (event.source && event.source === frameRef.current?.contentWindow && data && typeof data === 'object' && (data as { type?: unknown }).type === 'orbit-skill:close') closeNow.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('message', onMessage); before?.focus?.() }
  }, [])
  return <div className="skill-stage" role="dialog" aria-modal="true" aria-label={page.title}>
    <iframe className="skill-stage-frame" ref={frameRef} src={page.url} title={page.title} sandbox="allow-scripts allow-same-origin allow-presentation"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture" />
    <button className="skill-stage-close" ref={closeRef} aria-label="Закрыть" onClick={onClose}>×</button>
  </div>
}

function loadHandled(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HANDLED_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

// A serial number keeps two equal pages in a row (a preview pressed twice) separate frames.
let pageSerial = 0
const shownPage = (page: SkillPage, event: 'task-completed' | 'preview', run?: string): Shown => ({
  id: ++pageSerial, url: skillPageUrl(page.skill, page.show, { orbit_event: event, orbit_run: run }), title: page.skill.name,
})

// When to show pages: a run of the runtime completes (an event), or the window finds, once after its saved runs are loaded,
// a run that completed while it was reloading. The project's skills are fetched for each completion, so a switched-off skill
// or new parameters apply at once. Pages are queued and shown one at a time. Handled run ids are kept (the last 50) so a
// reload does not repeat them. preview shows a skill's pages regardless of the switch (the user asked).
export function useSkillTriggers(projects: Project[], ready: boolean, runs: RunMap) {
  const [queue, setQueue] = useState<Shown[]>([])
  const handled = useRef<string[] | null>(null)
  const mounted = useRef(true)
  const checked = useRef(false)
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const runsRef = useRef(runs)
  runsRef.current = runs

  const remember = useCallback((runId: string) => {
    handled.current ??= loadHandled()
    handled.current = [...handled.current.filter(id => id !== runId), runId].slice(-HANDLED_KEEP)
    try { localStorage.setItem(HANDLED_KEY, JSON.stringify(handled.current)) } catch { /* private mode: only this session remembers */ }
  }, [])
  const complete = useCallback((runId: string, projectId: string, workspace?: string) => {
    const api = window.orbit
    handled.current ??= loadHandled()
    if (!api || handled.current.includes(runId)) return
    remember(runId)
    const path = projectsRef.current.find(project => project.id === projectId)?.workspace.path || workspace || ''
    void api.listCapabilities(path).then(skills => triggeredSkills(skills).map(page => shownPage(page, 'task-completed', runId))).catch((): Shown[] => [])
      .then(pages => { if (pages.length && mounted.current) setQueue(current => [...current, ...pages]) })
  }, [remember])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.orbit?.onRuntimeEvent(event => { if (isCompletion(event)) complete(event.runId, event.projectId, event.workspace) })
    return () => { mounted.current = false; unsubscribe?.() }
  }, [complete])
  useEffect(() => {
    if (!ready || checked.current || !window.orbit) return
    checked.current = true
    handled.current ??= loadHandled()
    const all = Object.values(runsRef.current)
    const missed = missedCompletions(all.map(run => ({ id: run.runId, status: run.status, finishedAt: run.finishedAt })), new Set(handled.current), Date.now())
    if (!missed.length) return
    // One page for the newest missed run; the older ones are only remembered.
    for (const id of missed.slice(1)) remember(id)
    complete(missed[0], all.find(run => run.runId === missed[0])?.projectId || '')
  }, [ready, complete, remember])

  const active = queue.length > 0
  useEffect(() => (active ? holdFullScreen() : undefined), [active])
  useEffect(releaseStaleFullScreen, [])
  const close = useCallback(() => setQueue(current => current.slice(1)), [])
  const preview = useCallback((skill: Capability) => {
    const pages = completionPages(skill).map(page => shownPage(page, 'preview'))
    if (pages.length) setQueue(current => [...current, ...pages])
  }, [])
  return { stage: queue.length ? <SkillStage key={queue[0].id} page={queue[0]} onClose={close} /> : null, preview }
}
