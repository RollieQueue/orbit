import { useEffect, useState } from 'react'
import { AddProjectPanel } from './AddProjectPanel'
import { AgentsPanel } from './AgentsPanel'
import { useSkillTriggers } from './SkillStage'
import { ChatPane } from './ChatPane'
import { useLibrary } from './Library'
import { MemoryPanel } from './MemoryPanel'
import { Modal, Toast, type Panel } from './Modal'
import { QuotaPanel } from './QuotaPanel'
import { SettingsPanel } from './SettingsPanel'
import { Sidebar } from './Sidebar'
import { SkillsPanel } from './SkillsPanel'
import { providers } from './providers'
import { useInspector } from './useInspector'
import { useOrbitState } from './useOrbitState'
import { useQuotaPolling } from './useQuotas'

// Composition only. The state and its persistence live in useOrbitState, the agents panel's selection in useInspector;
// what is open (sidebar, project menu, modal) is decided here. Each pane gets what it shows and the actions it triggers.
export default function App() {
  const orbit = useOrbitState()
  const { state, project, chat, chatKey, chatRuns, runs, ready, desktop, running, restartWait, workingRun, pending, quotas, notice, setNotice, updateSettings } = orbit
  const [panel, setPanel] = useState<Panel | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState(false)
  const [remote, setRemote] = useState('')
  const inspector = useInspector(chatKey, chatRuns)
  const skillStage = useSkillTriggers(state.projects, ready, runs)
  const { currentRun, agentsOpen, setAgentsOpen } = inspector
  const library = useLibrary(panel, project?.workspace.path || '', chat?.id, orbit.libraryRevision, setNotice)
  useQuotaPolling(panel === 'quota', orbit.refreshQuotas)
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPanel(null); setProjectMenu(false); setSidebarOpen(false) } }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return <div className={`app-shell ${agentsOpen ? 'with-agents' : ''}`}>
    <Sidebar
      projects={state.projects} project={project} chat={chat} runs={runs} pending={pending} restartWaits={orbit.restartWaits} ready={ready} desktop={desktop}
      open={sidebarOpen} projectMenu={projectMenu} globalMemoryEnabled={orbit.globalMemoryEnabled}
      quotas={quotas} connected={orbit.connected} providerAvailable={!!orbit.currentHealth?.available} libraryRevision={orbit.libraryRevision}
      runtimeStatus={orbit.runtimeStatus} onClose={() => setSidebarOpen(false)} onProjectMenu={setProjectMenu} onOpenPanel={setPanel} onNotice={setNotice}
      onSelectProject={orbit.selectProject} onSelectChat={chatId => { orbit.selectChat(chatId); setSidebarOpen(false) }}
      onCreateChat={() => { orbit.createChat(); setSidebarOpen(false) }} onDeleteChat={orbit.deleteChat} onGlobalMemory={orbit.setGlobalMemory}
    />
    <ChatPane
      project={project} chat={chat} chatKey={chatKey} runs={runs} ready={ready} desktop={desktop} running={running} restartWait={restartWait} starting={pending.has(chatKey)}
      workingRun={workingRun} currentRun={currentRun} agentsOpen={agentsOpen} storageError={orbit.storageError || orbit.runtimeStorageError}
      onOpenSidebar={() => setSidebarOpen(true)} onToggleAgents={() => setAgentsOpen(!agentsOpen)} onOpenAgents={() => setAgentsOpen(true)}
      onOpenTeam={inspector.openTeam} onSuggest={orbit.setDraft} onAddProject={() => setPanel('add')}
      loop={orbit.loop} onStopLoop={orbit.stopLoop} onRunLoopNow={orbit.runLoopNow}
      composer={{
        settings: state.settings, project, chat, currentHealth: orbit.currentHealth, modelChoices: orbit.modelChoices, selectedEffort: orbit.selectedEffort,
        quotas, draft: orbit.draft, files: orbit.files, onAttach: orbit.attachFiles, onDetach: orbit.detachFile, running, loopTask: orbit.loop?.task, canSteer: orbit.canSteer, restartWait, workingRun, ready, desktop, onDraft: orbit.setDraft, onSend: () => orbit.send(inspector.followNewRun),
        onStop: () => void orbit.stop(), onTogglePause: orbit.togglePause, onSettings: updateSettings, onOpenQuota: () => setPanel('quota'),
      }}
    />
    {agentsOpen && <AgentsPanel
      chatRuns={chatRuns} currentRun={currentRun} selectedAgent={inspector.selectedAgent} inspectorRequest={inspector.inspectorRequest} quotas={quotas}
      onMessage={orbit.messageAgent} controls={{ pause: orbit.pauseAgent, resume: orbit.resumeAgent, stop: orbit.stopAgent }} onClose={() => setAgentsOpen(false)} onPick={inspector.pickRun} onSelectAgent={inspector.setSelectedAgent}
    />}
    {panel && <Modal panel={panel} onClose={() => setPanel(null)}>
      {panel === 'quota' && (desktop
        ? <QuotaPanel providers={providers} connected={orbit.connected} quotas={quotas} busy={orbit.quotaBusy} onRefresh={() => void orbit.refreshQuotas(true)}
          failover={state.settings.quotaFailover!} onFailover={patch => updateSettings({ quotaFailover: { ...state.settings.quotaFailover!, ...patch } })}
          agents={currentRun?.agents || []} currentProviderId={state.settings.providerId} workspace={project?.workspace.path || ''} />
        : <p className="inline-notice">Квоты подписок доступны в настольном приложении.</p>)}
      {panel === 'add' && <AddProjectPanel desktop={desktop} busy={orbit.projectBusy} remote={remote} onRemote={setRemote} onAdd={orbit.addProject}
        onDone={() => { setPanel(null); setRemote(''); setProjectMenu(false) }} />}
      {panel === 'settings' && <SettingsPanel settings={state.settings} health={orbit.health} checking={orbit.checking} desktop={desktop}
        modelChoices={orbit.modelChoices} runtimeStatus={orbit.runtimeStatus} onRefresh={() => void orbit.refreshProviders()} onSettings={updateSettings}
        onRestartRuntime={orbit.restartRuntime} />}
      {panel === 'memory' && <MemoryPanel desktop={desktop} project={project} chat={chat} entries={library.memory} stats={library.stats}
        loading={library.loading} onChanged={orbit.bumpLibrary} onError={setNotice} />}
      {panel === 'capabilities' && <SkillsPanel desktop={desktop} workspace={project?.workspace.path || ''} skills={library.capabilities}
        stats={library.stats} loading={library.loading} onChanged={orbit.bumpLibrary} onError={setNotice} onPreview={skillStage.preview} />}
    </Modal>}
    <Toast text={notice} onClose={() => setNotice('')} />
    {skillStage.stage}
  </div>
}
