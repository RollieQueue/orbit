import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message, RestartNotice, RuntimeStatus, Settings, Workspace } from './types'
import { errorText } from './format'
import { providers } from './providers'
import { handoverText } from './QuotaPanel'
import { reasoningLevels } from './ReasoningPicker'
import { activeRunIds, applyRunEvent, interruptLost, isActiveStatus, linkResumed, restoreRuns, snapshotBase, type RunMap } from './run-events'
import { initialWatch, watchRuntime } from './runtime-status'
import {
  addChatMessage, addRestartNote, addWorkspace, chatHistory, dropMessage, initialState, mirrorState, nameOf, newChat, now, openChat, reconcileRuns,
  removeChat, restartNote, restartWaits, restoreState, selectChat as selectChatIn, selectProject as selectProjectIn, setGlobalMemory as setGlobalMemoryIn,
  sharingEntries, sharingKey, stampSaved, titleChat, uid, withSettings, type RestoredMessage,
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
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null)
  // Counts the runtime's comebacks after a restart or crash: a new runtime process knows nothing the window told the old one.
  const [runtimeEpoch, setRuntimeEpoch] = useState(0)
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
    const noticesDuringLoad: RestartNotice[] = []
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
    // After a restart_orbit restart: a note in the run's chat (kept with the chat), and the continuation tied to the old run.
    const unsubscribeNotices = api.onRestartNotice(notice => {
      if (restoring) noticesDuringLoad.push(notice)
      setState(previous => addRestartNote(previous, notice))
      setRuns(previous => linkResumed(previous, notice))
      setNotice(restartNote(notice).text)
    })
    // The runs the runtime process was running when it went down (restart, crash, stop). Read inside an updater, so in
    // update order: a run whose start event arrived just before the crash is included even if it is not rendered yet.
    let lost: string[] = []
    const rememberLost = () => setRuns(previous => { lost = activeRunIds(previous); return previous })
    // The runtime process restarted or crashed and is back: what ended with the old process is final only in the saved
    // list, and the new one may already run a continuation, so runs and chats are reconciled with the list again. A run
    // of the old process the list does not have died before its first save: it ends interrupted (interruptLost).
    const refreshRuns = () => void api.listRuns().then(snapshots => {
      if (!mounted) return
      setRuns(previous => interruptLost(restoreRuns(previous, snapshots), lost, snapshots))
      setState(previous => reconcileRuns(previous, snapshots))
      setLibraryRevision(n => n + 1)
    }).catch(error => { if (mounted) setNotice(`Не удалось перечитать запуски после перезапуска runtime: ${errorText(error)}`) })
    let watch = initialWatch
    // Pushed statuses apply in arrival order, the one-off reply to getRuntimeStatus only before the first push (watchRuntime).
    const applyStatus = (status: RuntimeStatus, pushed: boolean) => {
      if (!mounted || !status) return
      const step = watchRuntime(watch, status, pushed)
      if (step.ignored) return
      watch = step.watch
      setRuntimeStatus(status)
      if (step.wentDown) rememberLost()
      if (step.cameBack) { refreshRuns(); setRuntimeEpoch(n => n + 1) }
    }
    const unsubscribeStatus = api.onRuntimeStatus(status => applyStatus(status, true))
    void api.getRuntimeStatus().then(status => applyStatus(status, false)).catch(() => undefined)
    void api.checkProviders(state.settings.providerOptions)
      .then(result => { if (mounted) setHealth(result) })
      .catch(error => { if (mounted) setNotice(`Не удалось проверить провайдеры: ${errorText(error)}`) })
    void Promise.allSettled([api.loadState(), api.listRuns()]).then(results => {
      if (!mounted) return
      const [saved, recovered] = results
      const snapshots = recovered.status === 'fulfilled' ? recovered.value : []
      setState(previous => restoreState(previous, saved.status === 'fulfilled' ? saved.value : null, snapshots, restoredDuringLoad, noticesDuringLoad))
      setRuns(previous => restoreRuns(previous, snapshots))
      if (saved.status === 'rejected' || recovered.status === 'rejected') {
        setNotice('Не удалось полностью восстановить данные. Локальная история чатов сохранена в интерфейсе.')
      }
      restoring = false
      setReady(true)
    })
    return () => { mounted = false; unsubscribe(); unsubscribeNotices(); unsubscribeStatus() }
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
  // The runtime decides which projects may feed the shared memory; it learns each project's switch from here, again after
  // every runtime comeback (the switches live in the runtime process's memory only).
  const sharing = sharingKey(state)
  useEffect(() => {
    if (!ready || !window.orbit) return
    for (const entry of sharingEntries(sharing)) if (entry.workspace) void window.orbit.setMemorySharing(entry.workspace, entry.enabled).catch(() => undefined)
  }, [ready, sharing, runtimeEpoch])
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
  // Chats whose agent restarted Orbit wait for the continuation: no new message and no delete until it comes (or its
  // notice says it will not), for a bounded time; a timer re-renders when the first wait runs out.
  const waits = restartWaits(state, runs, Date.now())
  const restartWait = waits.has(chatKey)
  const waitsEnd = waits.size ? Math.min(...waits.values()) : 0
  const [, setWaitTick] = useState(0)
  useEffect(() => {
    if (!waitsEnd) return
    const timer = window.setTimeout(() => setWaitTick(n => n + 1), Math.max(0, waitsEnd - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [waitsEnd])
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
    if (!project || pendingRef.current.has(`${project.id}/${chatId}`) || waits.has(`${project.id}/${chatId}`)) return
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
  // Sends the current chat's draft. False when nothing was sent (no project, empty draft, a run in progress or awaited
  // after a restart, not ready). `onStarted` runs as soon as the desktop has given the run its id, before the user's
  // message is tagged with it.
  function send(onStarted?: (runId: string) => void): boolean {
    const api = window.orbit
    if (!api || !project || !chat || !draft.trim() || running || restartWait || pendingRef.current.has(chatKey) || !ready) return false
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
  // Restarts the runtime process (the window stays); the status line and the run list follow through onRuntimeStatus.
  async function restartRuntime(): Promise<RuntimeRestartResult> {
    if (!window.orbit) return { ok: false, ms: 0, pid: null, error: 'Доступно только в настольном Orbit' }
    try { return await window.orbit.restartRuntime() } catch (error) { return { ok: false, ms: 0, pid: null, error: errorText(error) } }
  }
  const setDraft = (text: string) => setDrafts(previous => ({ ...previous, [chatKey]: text }))
  const bumpLibrary = () => setLibraryRevision(n => n + 1)

  return {
    state, ready, desktop, runs, pending, health, checking, projectBusy, notice, setNotice, storageError, runtimeStorageError, libraryRevision, bumpLibrary,
    quotas, quotaBusy, refreshQuotas, runtimeStatus,
    project, globalMemoryEnabled, chat, chatKey, chatRuns, workingRun, running, restartWait, restartWaits: waits, draft, setDraft,
    currentHealth, connected, modelChoices, selectedEffort,
    updateSettings, setGlobalMemory, selectProject, selectChat, createChat, deleteChat, addProject, send, stop, refreshProviders, restartRuntime,
  }
}
