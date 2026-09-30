import { useCallback, useEffect, useRef, useState } from 'react'
import './celebration.css'
import { bounce, celebrationMs, embedUrl, isCompletion, missedCompletions, pickCelebration, type Motion } from './celebration'
import { startConfetti } from './confetti'
import type { RunMap } from './run-events'
import type { Project, SkillAction } from './types'

// The celebration an action skill shows when a task is completed: the video full screen, confetti, and "TASK COMPLETED"
// flying around like the DVD logo. useCelebration decides when to show it, Celebration draws it.

const CELEBRATED_KEY = 'orbit.celebrated'
const CELEBRATED_KEEP = 50
const HUE_STEP = 67

// The window's full-screen changes run one after another, so a second overlay opened right after a closed one (or a
// development double mount) still asks about the state the first one left behind.
let fullScreenQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = fullScreenQueue.then(job)
  fullScreenQueue = next.catch(() => undefined)
  return next
}

// Full screen while the overlay is open; the window goes back to normal only if it was not full screen before.
// Without window.orbit (browser dev mode) there is nothing to switch.
function holdFullScreen(): () => void {
  const api = window.orbit
  if (!api?.setFullScreen) return () => undefined
  const was = enqueue(() => api.setFullScreen(true)).catch(() => true)
  return () => { void enqueue(async () => { if (!(await was)) await api.setFullScreen(false) }).catch(() => undefined) }
}

// TASK COMPLETED: moves like the DVD screensaver logo (bounce, position by transform on the outer element), turns around
// its own axis all the time (CSS animation on the inner one) and changes its colours on every bounce.
function FlyingText() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const speed = Math.max(0.15, window.innerWidth / 8000)
    const angle = (20 + Math.random() * 50) * (Math.PI / 180)
    let motion: Motion = {
      x: Math.random() * window.innerWidth * 0.4, y: Math.random() * window.innerHeight * 0.3,
      vx: Math.cos(angle) * speed * (Math.random() < 0.5 ? -1 : 1), vy: Math.sin(angle) * speed * (Math.random() < 0.5 ? -1 : 1),
    }
    let hue = 0
    let last = performance.now()
    let frame = 0
    const step = (dt: number) => {
      const width = element.offsetWidth
      const height = element.offsetHeight
      // The turning text sweeps a circle, so the bounce box is a square around it and the text never leaves the screen.
      const side = Math.hypot(width, height) * 0.85
      const next = bounce(motion, dt, { w: side, h: side }, { w: window.innerWidth, h: window.innerHeight })
      motion = next
      element.style.transform = `translate3d(${next.x + (side - width) / 2}px, ${next.y + (side - height) / 2}px, 0)`
      if (next.hit) { hue += HUE_STEP; element.style.filter = `hue-rotate(${hue}deg)` }
    }
    const tick = (time: number) => {
      // A long pause (a hidden tab) must not throw the text across the screen.
      step(Math.min(48, time - last))
      last = time
      frame = requestAnimationFrame(tick)
    }
    step(0)
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
  return <div className="celebration-flyer" ref={ref}>
    <div className="celebration-spin">
      <span className="celebration-word">TASK</span>{' '}<span className="celebration-word">COMPLETED</span>
    </div>
  </div>
}

export function Celebration({ action, onClose }: { action: SkillAction; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeNow = useRef(onClose)
  closeNow.current = onClose
  useEffect(() => holdFullScreen(), [])
  useEffect(() => (canvasRef.current ? startConfetti(canvasRef.current) : undefined), [])
  useEffect(() => {
    const timer = window.setTimeout(() => closeNow.current(), celebrationMs(action))
    return () => window.clearTimeout(timer)
  }, [action])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    // Captured first, so Esc closes only the celebration and not the panel under it; Tab stays on the close button.
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeNow.current() }
      else if (event.key === 'Tab') { event.preventDefault(); closeRef.current?.focus() }
    }
    window.addEventListener('keydown', listener, true)
    return () => { window.removeEventListener('keydown', listener, true); before?.focus?.() }
  }, [])
  return <div className="celebration" role="dialog" aria-modal="true" aria-label="Задача завершена: празднование">
    <iframe className="celebration-video" src={embedUrl(action)} title="Видео к завершению задачи" allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin" />
    <canvas className="celebration-confetti" ref={canvasRef} aria-hidden="true" />
    <FlyingText />
    <div className="celebration-catcher" onClick={onClose} />
    <button className="celebration-close" ref={closeRef} aria-label="Закрыть празднование" onClick={onClose}>×</button>
  </div>
}

function loadCelebrated(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CELEBRATED_KEY) || '[]')
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}

// When to celebrate: a run of the runtime completes (an event), or the window finds, once after its saved runs are
// loaded, a run that completed while it was reloading. The skill is looked up for the project of the run each time, so
// turning it off or changing the clip takes effect at once. One celebration at a time: a completion during one is only
// remembered. Celebrated run ids are kept (the last 50) so a reload does not repeat them. preview shows a saved action.
export function useCelebration(projects: Project[], ready: boolean, runs: RunMap) {
  const [action, setAction] = useState<SkillAction | null>(null)
  const celebrated = useRef<string[] | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  const checked = useRef(false)
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const runsRef = useRef(runs)
  runsRef.current = runs

  const remember = useCallback((runId: string) => {
    celebrated.current ??= loadCelebrated()
    celebrated.current = [...celebrated.current.filter(id => id !== runId), runId].slice(-CELEBRATED_KEEP)
    try { localStorage.setItem(CELEBRATED_KEY, JSON.stringify(celebrated.current)) } catch { /* private mode: only this session remembers */ }
  }, [])
  const complete = useCallback((runId: string, projectId: string, workspace?: string) => {
    const api = window.orbit
    celebrated.current ??= loadCelebrated()
    if (!api || celebrated.current.includes(runId)) return
    remember(runId)
    if (busy.current) return
    busy.current = true
    const path = projectsRef.current.find(project => project.id === projectId)?.workspace.path || workspace || ''
    void api.listCapabilities(path).then(pickCelebration).catch(() => null).then(picked => {
      if (picked && mounted.current) setAction(picked)
      else busy.current = false
    })
  }, [remember])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.orbit?.onRuntimeEvent(event => { if (isCompletion(event)) complete(event.runId, event.projectId, event.workspace) })
    return () => { mounted.current = false; unsubscribe?.() }
  }, [complete])
  useEffect(() => {
    if (!ready || checked.current || !window.orbit) return
    checked.current = true
    celebrated.current ??= loadCelebrated()
    const all = Object.values(runsRef.current)
    const missed = missedCompletions(all.map(run => ({ id: run.runId, status: run.status, finishedAt: run.finishedAt })), new Set(celebrated.current), Date.now())
    if (!missed.length) return
    for (const id of missed.slice(1)) remember(id)
    complete(missed[0], all.find(run => run.runId === missed[0])?.projectId || '')
  }, [ready, complete, remember])

  const close = useCallback(() => { busy.current = false; setAction(null) }, [])
  const preview = useCallback((shown: SkillAction) => {
    if (busy.current) return
    busy.current = true
    setAction(shown)
  }, [])
  return { overlay: action ? <Celebration action={action} onClose={close} /> : null, preview }
}
