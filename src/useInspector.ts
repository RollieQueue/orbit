import { useEffect, useState } from 'react'
import type { InspectorTab, RunSnapshot } from './types'

// What the agents panel shows: whether it is open, which run of the chat and which agent are selected, and a pending
// request to open a run on a given tab. `seq` remounts an inspector that already shows that run.
export function useInspector(chatKey: string, chatRuns: RunSnapshot[]) {
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [selectedAgent, setSelectedAgent] = useState('root')
  const [inspectorRequest, setInspectorRequest] = useState<{ runId: string; tab: InspectorTab; seq: number } | null>(null)
  const currentRun = chatRuns.find(r => r.runId === selection[chatKey]) || chatRuns.at(-1)
  useEffect(() => { setSelectedAgent('root') }, [chatKey])

  function openTeam(runId: string, tab?: InspectorTab, agentId = 'root') {
    setSelection(previous => ({ ...previous, [chatKey]: runId })); setSelectedAgent(agentId); setAgentsOpen(true)
    if (tab) setInspectorRequest(previous => ({ runId, tab, seq: (previous?.seq || 0) + 1 }))
  }
  // Picking another run forgets an earlier «open on this tab» request, so coming back to a run does not jump to that tab again.
  function pickRun(runId: string) {
    setSelection(previous => ({ ...previous, [chatKey]: runId })); setSelectedAgent('root')
    if (runId !== currentRun?.runId) setInspectorRequest(null)
  }
  // The panel follows a new run only if the user was watching the newest one or the panel is closed; an older run they are reading stays.
  function followNewRun(runId: string) {
    if (!agentsOpen || !currentRun || currentRun.runId === chatRuns.at(-1)?.runId) setSelection(previous => ({ ...previous, [chatKey]: runId }))
  }
  return { agentsOpen, setAgentsOpen, currentRun, selectedAgent, setSelectedAgent, inspectorRequest, openTeam, pickRun, followNewRun }
}
