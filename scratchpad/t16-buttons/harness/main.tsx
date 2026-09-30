import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentsPanel } from '../../../src/AgentsPanel'
import '../../../src/styles.css'

const agents: any[] = [
  { id: 'root', name: 'Orbit', status: 'working' },
  { id: 'a1', name: 'Первый', status: 'working', parentId: 'root' },
  { id: 'a2', name: 'Второй', status: 'working', parentId: 'root' },
]
const run: any = { runId: 'r1', projectId: 'p', chatId: 'c', status: 'working', prompt: 'x', workspace: '.', agents, traces: [], messages: [], communications: [], startedAt: new Date().toISOString() }
const ok = async () => {}
function App() {
  const [sel, setSel] = useState('root')
  return <AgentsPanel chatRuns={[run]} currentRun={run} selectedAgent={sel} inspectorRequest={null} quotas={{}} onMessage={ok}
    controls={{ pause: ok, resume: ok, stop: ok }} onClose={() => {}} onPick={() => {}} onSelectAgent={setSel} />
}
createRoot(document.getElementById('root')!).render(<App />)
;(window as any).__count = () => JSON.stringify({ controls: document.querySelectorAll('.agent-controls').length, message: document.querySelectorAll('.agent-message').length, buttons: [...document.querySelectorAll('.agent-controls button')].map(b => b.textContent).join('|') })
