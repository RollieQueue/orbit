import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentsPanel } from '../../../src/AgentsPanel'
import { RunTimeline } from '../../../src/RunTimeline'
import type { RunSnapshot } from '../../../src/types'
import '../../../src/styles.css'
import { audit, hoverInfo, tooltips } from './audit'
import e765 from '../fixtures/e765.json'
import restart from '../fixtures/restart.json'
import live from '../fixtures/live.json'
import synthetic from '../fixtures/synthetic.json'
import syntheticRestart from '../fixtures/synthetic-restart.json'
import restartLong from '../fixtures/restart-long.json'
import syntheticSolo from '../fixtures/synthetic-solo.json'
import syntheticEmpty from '../fixtures/synthetic-empty.json'

// The screenshot harness page. Hash: #sample=e765|restart|restart-long|live|synthetic|synthetic-restart|synthetic-solo|synthetic-empty &width=340 &view=panel|bare &select=<agentId> &full=0|1
//   view=panel: the real <AgentsPanel> in a box of `width` px, switched to the timeline by clicking «Таймлайн» (window.__switch tells how that went).
//   view=bare:  only <RunTimeline> in a box of `width` px on the panel's background.
//   full=1:     lifts the chart's own max-height/scroll so that every row is visible (default for bare, off for panel: the panel as shipped).
// window.__ready turns true once rendered; window.__audit() / __hover(x, y) / __errors are read by capture.cjs.
const win = window as any
win.__errors = [] as string[]
window.addEventListener('error', event => win.__errors.push(`pageerror: ${event.message} (${event.filename}:${event.lineno})`))
window.addEventListener('unhandledrejection', event => win.__errors.push(`unhandledrejection: ${String((event.reason && event.reason.stack) || event.reason)}`))

const FIXTURES: Record<string, any> = { e765, restart, 'restart-long': restartLong, live, synthetic, 'synthetic-restart': syntheticRestart, 'synthetic-solo': syntheticSolo, 'synthetic-empty': syntheticEmpty }
const params = new URLSearchParams(location.hash.replace(/^#/, ''))
const sample = params.get('sample') || 'e765'
const width = Number(params.get('width')) || 340
const view = params.get('view') === 'bare' ? 'bare' : 'panel'
const full = params.has('full') ? params.get('full') === '1' : view === 'bare'
const initialSelect = params.get('select') || ''

// A run that is still going has its clock moved so that it was last updated 5 s ago: its open turns then grow to "now" instead of
// stretching over the hours since the snapshot was taken.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
function shifted(value: any, delta: number): any {
  if (typeof value === 'string') return ISO.test(value) ? new Date(Date.parse(value) + delta).toISOString() : value
  if (Array.isArray(value)) return value.map(item => shifted(item, delta))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shifted(item, delta)]))
  return value
}
const raw = FIXTURES[sample]
const isLive = !!raw && ['working', 'waiting', 'paused'].includes(raw.status)
const shiftMs = isLive ? Date.now() - 5000 - Date.parse(raw.updatedAt) : 0
const run: RunSnapshot = raw ? (isLive ? shifted(raw, shiftMs) : raw) : (null as any)
win.__info = { sample, view, width, full, status: raw?.status, live: isLive, shiftMs, agents: raw?.agents?.length, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }

const css = document.createElement('style')
css.textContent = `
html,body{margin:0;min-width:0 !important;background:#17181b}
.harness-frame{width:${width}px;height:100vh;overflow:hidden}
.harness-frame .agents-panel{position:relative !important;right:auto !important;top:auto !important;bottom:auto !important;z-index:auto !important;width:100% !important;height:100% !important;box-shadow:none !important}
.harness-bare{width:${width}px;background:#15171a}
${full ? '.run-timeline{max-height:none !important;overflow:visible !important}' : ''}
`
document.head.append(css)

const settle = () => setTimeout(() => { win.__ready = true }, 300)
const ok = async () => {}

function Panel({ run }: { run: RunSnapshot }) {
  const [selected, setSelected] = useState(initialSelect || run.agents[0]?.id || 'root')
  useEffect(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.agents-view-switch button')].find(item => (item.textContent || '').includes('Таймлайн'))
    win.__switch = button ? 'clicked' : 'missing'
    button?.click()
    settle()
  }, [])
  return <div className="harness-frame">
    <AgentsPanel chatRuns={[run]} currentRun={run} selectedAgent={selected} inspectorRequest={null} quotas={{}} onMessage={ok}
      controls={{ pause: ok, resume: ok, stop: ok }} onClose={() => {}} onPick={() => {}} onSelectAgent={setSelected} />
  </div>
}
function Bare({ run }: { run: RunSnapshot }) {
  const [selected, setSelected] = useState(initialSelect)
  useEffect(() => { settle() }, [])
  return <div className="harness-bare"><RunTimeline run={run} selectedId={selected} onSelect={setSelected} /></div>
}

win.__audit = () => audit(run)
win.__hover = hoverInfo
win.__tips = tooltips
if (!run) {
  win.__fatal = `unknown sample «${sample}» (known: ${Object.keys(FIXTURES).join(', ')})`
  win.__ready = true
} else {
  createRoot(document.getElementById('root')!).render(view === 'bare' ? <Bare run={run} /> : <Panel run={run} />)
}
