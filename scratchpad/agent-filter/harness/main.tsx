import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AgentsPanel } from '../../../src/AgentsPanel'
import type { Agent, RunSnapshot } from '../../../src/types'
import '../../../src/styles.css'

// Hash: #filter=all|active|working|queued|waiting|paused|done|error|cancelled &view=list|timeline &drop=<comma list of agent ids>
const win = window as any
win.__errors = [] as string[]
window.addEventListener('error', event => win.__errors.push(`pageerror: ${event.message}`))
const params = new URLSearchParams(location.hash.replace(/^#/, ''))
localStorage.setItem('orbit.agents-filter', params.get('filter') || 'all')
localStorage.setItem('orbit.agents-view', params.get('view') || 'list')
const drop = new Set((params.get('drop') || '').split(',').filter(Boolean))

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 1, 10, min, sec)).toISOString()
const a = (id: string, name: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({
  id, name, status, parentId: 'root', depth: 1, role: 'Agent', providerId: 'claude', model: 'claude-sonnet-5-5', startedAt: T(1), ...extra,
  turnTimings: extra.turnTimings ?? [{ turn: 1, transport: 'session', startedAt: T(1), ...(status === 'working' || status === 'waiting' ? {} : { endedAt: T(8) }) } as any],
})
const agents: Agent[] = [
  a('root', 'Orbit', 'waiting', { parentId: null, depth: 0, detail: 'Waiting for delegated results', model: 'claude-opus-5-5', reasoningEffort: 'xhigh', effortSource: 'settings' }),
  a('lead', 'ui-lead', 'waiting', { detail: 'Waiting for delegated results', reasoningEffort: 'high', effortSource: 'caller' }),
  a('w1', 'implement-filter', 'working', { parentId: 'lead', depth: 2, reasoningEffort: 'high', effortSource: 'routing', providerId: 'claude' }),
  a('w2', 'write-tests', 'working', { parentId: 'lead', depth: 2, providerId: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium', effortSource: 'pool' }),
  a('q', 'review-ui', 'waiting', { detail: 'Queued', reasoningEffort: 'high', effortSource: 'parent' }),
  a('m', 'docs-writer', 'waiting', { detail: 'Waiting for a message' }),
  a('ap', 'deploy-check', 'waiting', { detail: 'Waiting for your permission' }),
  a('hold', 'perf-audit', 'working', { paused: true }),
  a('ok', 'collect-fixtures', 'done'),
  a('bad', 'run-smoke', 'error', { parentId: 'ok', depth: 2 }),
  a('stop', 'old-experiment', 'cancelled'),
  a('int', 'crashed-one', 'interrupted'),
].filter(agent => !drop.has(agent.id))
const run: RunSnapshot = { runId: 'run-1', projectId: 'p', chatId: 'c', status: 'working', startedAt: T(0), updatedAt: new Date().toISOString(), providerId: 'claude', model: 'claude-opus-5-5', workspace: '.', prompt: 'x', agents, communications: [], traces: [], messages: [] } as any
const ok = async () => {}
function Panel() {
  const [selected, setSelected] = useState('root')
  return <div style={{ width: 340, height: '100vh', overflow: 'hidden' }}>
    <AgentsPanel chatRuns={[run]} currentRun={run} selectedAgent={selected} inspectorRequest={null} quotas={{}} onMessage={ok as any}
      controls={{ pause: ok, resume: ok, stop: ok } as any} onClose={() => {}} onPick={() => {}} onSelectAgent={setSelected} />
  </div>
}
createRoot(document.getElementById('root')!).render(<Panel />)
setTimeout(() => { win.__ready = true }, 600)
