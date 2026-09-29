import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message, Settings, Workspace } from './types'
import { errorText } from './format'
import { providers } from './providers'
import { handoverText } from './QuotaPanel'
import { reasoningLevels } from './ReasoningPicker'
import { applyRunEvent, isActiveStatus, restoreRuns, snapshotBase, type RunMap } from './run-events'
import {
  addChatMessage, addWorkspace, chatHistory, dropMessage, initialState, mirrorState, nameOf, newChat, now, openChat, removeChat, restoreState,
  selectChat as selectChatIn, selectProject as selectProjectIn, setGlobalMemory as setGlobalMemoryIn, sharingEntries, sharingKey, stampSaved,
  titleChat, uid, withSettings, type RestoredMessage,
} from './state-store'
import { useQuotas } from './useQuotas'

export type OrbitStore = ReturnType<typeof useOrbitState>

// Everything the renderer knows: the saved state (projects, chats, settings) with its persistence, the live runs fed by
// the runtime's events, provider health and quotas, and the actions the components call. Components only render.
export function useOrbitState() {
  const [state, setState] = useState(() => initialState(key => localStorage.getItem(key)))
  const [ready, setReady] = useState(!window.orbit)
  const [runs, setRuns] = useState<RunMap>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [checking, setChecking] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState('')
  const [runtimeStorageError, setRuntimeStorageError] = useState('')
  const [libraryRevision, setLibraryRevision] = useState(0)
  const providerOptionsRef = useRef(state.settings.providerOptions)
  providerOptionsRef.current = state.settings.providerOptions
  const { quotas, quotaBusy, refreshQuotas, scheduleQuotaRefresh } = useQuotas(providerOptionsRef, setNotice)

  // ---- Runtime events and the start-up load ----
  useEffect(() => {
    const api = window.orbit
    if (!api) return
    let mounted = true
    let restoring = true
    const restoredDuringLoad: RestoredMessage[] = []
    const unsubscribe = api.onRuntimeEvent(event => {
      if (!event.projectId || !event.chatId) return
      if (event.warning) setRuntimeStorageError(event.warning)
      setRuns(previous => applyRunEvent(previous, event))
      if (event.message && (!event.message.agentId || event.message.agentId === 'root')) {
        const message = { ...event.message, runId: event.runId }
        if (restoring) restoredDuringLoad.push({ projectId: event.projectId, chatId: event.chatId, message })
        setState(previous => addChatMessage(previous, event.projectId, event.chatId, message))
      }
      if (event.type === 'agent.handover' && event.handover) {
        const handover = event.handover
        const text = handoverText(providers, event.agent?.name || 'Агент', handover)
        setNotice(text)
        if (!event.agentId || event.agentId === 'root') {
          const message: Message = { id: `handover-${handover.id}`, author: 'system', text, time: handover.time, runId: event.runId, kind: 'handover' }
          setState(previous => addChatMessage(previous, event.projectId, event.chatId, message))
        }
      }
      if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') {
        setLibraryRevision(n => n + 1)
        scheduleQuotaRefresh()
      }
    })
    void api.checkProviders(state.settings.providerOptions)
      .then(result => { if (mounted) setHealth(result) })
      .catch(error => { if (mounted) setNotice(`Не удалось проверить провайдеры: ${errorText(error)}`) })
    void Promise.allSettled([api.loadState(), api.listRuns()]).then(results => {
      if (!mounted) return
      const [saved, recovered] = results
      const snapshots = recovered.status === 'fulfilled' ? recovered.value : []
      setState(previous => restoreState(previous, saved.status === 'fulfilled' ? saved.value : null, snapshots, restoredDuringLoad))
      setRuns(previous => restoreRuns(previous, snapshots))
      if (saved.status === 'rejected' || recovered.status === 'rejected') {
        setNotice('Не удалось полностью восстановить данные. Локальная история чатов сохранена в интерфейсе.')
      }
      restoring = false
      setReady(true)
    })
    return () => { mounted = false; unsubscribe() }
  }, [])

  // ---- Persistence: the desktop file is the source of truth; the mirror serves the next start-up's first render ----
  useEffect(() => {
    if (!ready) return
    const snapshot = stampSaved(state, Date.now())
    mirrorState(snapshot)
    const timer = window.setTimeout(() => {
      if (!window.orbit) return
      void window.orbit.saveState(snapshot).then(() => setStorageError('')).catch(error => setStorageError(`Не удалось сохранить историю: ${errorText(error)}`))
    }, 350)
    return () => clearTimeout(timer)
  }, [state, ready])
  // The runtime decides which projects may feed the shared memory; it learns each project's switch from here.
  const sharing = sharingKey(state)
  useEffect(() => {
    if (!ready || !window.orbit) return
    for (const entry of sharingEntries(sharing)) if (entry.workspace) void window.orbit.setMemorySharing(entry.workspace, entry.enabled).catch(() => undefined)
  }, [ready, sharing])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7500); return () => clearTimeout(timer) }, [notice])

  // ---- The current chat and its runs ----
  const project = state.projects.find(p => p.id === state.activeProjectId) || state.projects[0]
  const globalMemoryEnabled = project?.globalMemoryEnabled ?? state.settings.memoryEnabled
  const chat = project?.chats.find(c => c.id === project.activeChatId) || project?.chats[0]
  const chatKey = `${project?.id || ''}/${chat?.id || ''}`
  const chatRuns = useMemo(
    () => Object.values(runs).filter(r => r.projectId === project?.id && r.chatId === chat?.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [runs, project?.id, chat?.id],
  )
  const workingRun = chatRuns.find(r => isActiveStatus(r.status))
  const running = !!workingRun || pending.has(chatKey)
  const draft = drafts[chatKey] || ''
  const desktop = !!window.orbit

  // ---- Provider health, and the model and effort the next message will use ----
  const { providerId } = state.settings
  const currentHealth = health.find(p => p.id === providerId)
  const connected = Object.fromEntries(health.map(p => [p.id, p.available]))
  const usedModels = Object.values(runs).filter(run => run.providerId === providerId && run.model).map(run => run.model!)
  const modelChoices = [...new Set([...(currentHealth?.models || []), ...(currentHealth?.model ? [currentHealth.model] : []), ...usedModels])]
  const effortLevels = reasoningLevels(providerId, state.settings.models[providerId] || '', currentHealth)
  const savedEffort = state.settings.providerOptions?.[providerId]?.reasoningEffort || ''
  const selectedEffort = effortLevels.includes(savedEffort) ? savedEffort : ''

  // ---- Actions ----
  function updateSettings(patch: Partial<Settings>) { setState(previous => withSettings(previous, patch)) }
  function setGlobalMemory(enabled: boolean) { if (project) setState(previous => setGlobalMemoryIn(previous, project.id, enabled)) }
  function selectProject(projectId: string) { setState(previous => selectProjectIn(previous, projectId)) }
  function selectChat(chatId: string) { if (project) setState(previous => selectChatIn(previous, project.id, chatId)) }
  function createChat() {
    if (!project) return
    const next = newChat()
    setState(previous => openChat(previous, project.id, next))
  }
  function deleteChat(chatId: string) {
    if (!project || pendingRef.current.has(`${project.id}/${chatId}`)) return
    if (Object.values(runs).some(r => r.projectId === project.id && r.chatId === chatId && isActiveStatus(r.status))) return
    setState(previous => removeChat(previous, project.id, chatId))
    setDrafts(previous => { const next = { ...previous }; delete next[`${project.id}/${chatId}`]; return next })
    // A deleted chat takes its working notes with it (what proved durable was already moved to the project).
    if (window.orbit && project.workspace.path) void window.orbit.forgetChatMemory(project.workspace.path, chatId).catch(() => undefined)
  }
  // Picks a folder or clones a repository; true when a project is now selected.
  async function addProject(kind: 'local' | 'git', remote: string) {
    if (!window.orbit || projectBusy) return false
    setProjectBusy(true)
    try {
      const context = kind === 'local' ? await window.orbit.pickWorkspace() : await window.orbit.cloneWorkspace(remote.trim())
      if (!context) return false
      if ('error' in context && context.error) throw new Error(String(context.error))
      const workspace: Workspace = { ...context, name: nameOf(context.path) }
      setState(previous => addWorkspace(previous, workspace))
      return true
    } catch (error) { setNotice(errorText(error)); return false } finally { setProjectBusy(false) }
  }
  // Sends the current chat's draft. False when nothing was sent (no project, empty draft, a run in progress, not ready).
  // `onStarted` runs as soon as the desktop has given the run its id, before the user's message is tagged with it.
  function send(onStarted?: (runId: string) => void): boolean {
    const api = window.orbit
    if (!api || !project || !chat || !draft.trim() || running || pendingRef.current.has(chatKey) || !ready) return false
    const prompt = draft.trim()
    const targetProject = project.id, targetChat = chat.id, key = chatKey
    const userMessage: Message = { id: uid(), author: 'user', text: prompt, time: now() }
    const task = {
      projectId: targetProject, chatId: targetChat, prompt, history: chatHistory(chat), workspace: project.workspace.path, ...state.settings,
      memoryEnabled: true, globalMemoryEnabled, reasoningEffort: selectedEffort, model: state.settings.models[providerId]?.trim() || undefined,
    }
    pendingRef.current.add(key)
    setPending(previous => new Set(previous).add(key))
    setDrafts(previous => ({ ...previous, [key]: '' }))
    setState(previous => titleChat(addChatMessage(previous, targetProject, targetChat, userMessage), targetProject, targetChat, prompt))
    const start = async () => {
      try {
        const runId = await api.startTask(task)
        setRuns(previous => {
          const base = previous[runId] || snapshotBase({ runId, projectId: targetProject, chatId: targetChat })
          return { ...previous, [runId]: { ...base, workspace: project.workspace.path, prompt, providerId } }
        })
        onStarted?.(runId)
        setState(previous => addChatMessage(previous, targetProject, targetChat, { ...userMessage, runId }))
      } catch (error) {
        setState(previous => dropMessage(previous, targetProject, targetChat, userMessage.id))
        const warning: Message = { id: uid(), author: 'system', text: `Не удалось запустить агента: ${errorText(error)}`, time: now(), kind: 'warning' }
        setState(previous => addChatMessage(previous, targetProject, targetChat, warning))
        setDrafts(previous => ({ ...previous, [key]: previous[key] || prompt }))
      } finally {
        pendingRef.current.delete(key)
        setPending(previous => { const next = new Set(previous); next.delete(key); return next })
      }
    }
    void start()
    return true
  }
  async function stop() {
    if (!workingRun || !window.orbit) return
    try {
      const stopped = await window.orbit.stopTask(workingRun.runId)
      if (!stopped) setNotice('Этот запуск уже завершён.')
    } catch (error) { setNotice(errorText(error)) }
  }
  async function refreshProviders() {
    if (!window.orbit || checking) return
    setChecking(true)
    try { setHealth(await window.orbit.checkProviders(state.settings.providerOptions)) }
    catch (error) { setNotice(errorText(error)) }
    finally { setChecking(false) }
  }
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [chatKey]: text }))
  const bumpLibrary = () => setLibraryRevision(n => n + 1)

  return {
    state, ready, desktop, runs, pending, health, checking, projectBusy, notice, setNotice, storageError, runtimeStorageError, libraryRevision, bumpLibrary,
    quotas, quotaBusy, refreshQuotas,
    project, globalMemoryEnabled, chat, chatKey, chatRuns, workingRun, running, draft, setDraft,
    currentHealth, connected, modelChoices, selectedEffort,
    updateSettings, setGlobalMemory, selectProject, selectChat, createChat, deleteChat, addProject, send, stop, refreshProviders,
  }
}
