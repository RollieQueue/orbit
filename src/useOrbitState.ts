import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, ChatThread, ImprovementLoop, Message, Project, RestartNotice, RuntimeStatus, Settings, Workspace } from './types'
import { addFiles, saveFiles } from './attachments'
import { errorText, remoteErrorText } from './format'
import { closedKeysOf, loopNote, loopPrompt, loopStartFailed, loopView, newestPlanRun, nextLoopStep } from './improvement-loop'
import { providers } from './providers'
import { handoverText } from './QuotaPanel'
import { reasoningLevels } from './ReasoningPicker'
import { activeRunIds, applyRunEvent, interruptLost, isActiveStatus, linkResumed, restoreRuns, snapshotBase, type RunMap } from './run-events'
import { initialWatch, watchRuntime } from './runtime-status'
import {
  activateLoop, addChatMessage, addRestartNote, addWorkspace, chatHistory, dropMessage, initialState, mirrorState, nameOf, newChat, now, openChat,
  reconcileRuns, removeChat, restartNote, restartWaits, restoreState, selectChat as selectChatIn, selectProject as selectProjectIn,
  setChatLoop, setGlobalMemory as setGlobalMemoryIn, settlingRestartText, sharingEntries, sharingKey, stampSaved, stopLoop, loopStateNote, titleChat, uid, withSettings,
  type RestoredMessage,
} from './state-store'
import { useQuotas } from './useQuotas'

export type OrbitStore = ReturnType<typeof useOrbitState>
// The same empty list every render, so that a chat without files does not look changed to the components.
const noFiles: File[] = []

// Everything the renderer knows: the saved state (projects, chats, settings) with its persistence, the live runs fed by
// the runtime's events, provider health and quotas, and the actions the components call. Components only render.
export function useOrbitState() {
  const [state, setState] = useState(() => initialState(key => localStorage.getItem(key)))
  const [ready, setReady] = useState(!window.orbit)
  const [runs, setRuns] = useState<RunMap>({})
  // The runs as last rendered, for callbacks that finish after later renders (a start's answer).
  const runsRef = useRef(runs)
  runsRef.current = runs
  const [pending, setPending] = useState<Set<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  // Chats whose message to the working root agent is on its way (no second one until the runtime answers).
  const [steering, setSteering] = useState<Set<string>>(new Set())
  const steeringRef = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // The files chosen for each chat's next message (File objects live in the window only; they are saved when the message is sent).
  const [chosen, setChosen] = useState<Record<string, File[]>>({})
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
  // While the chat's run works, the composer sends to its root agent; not before the start has settled.
  const canSteer = !!workingRun && !pending.has(chatKey) && !restartWait && !steering.has(chatKey) && ready
  const waitsEnd = waits.size ? Math.min(...waits.values()) : 0
  const [, setWaitTick] = useState(0)
  useEffect(() => {
    if (!waitsEnd) return
    const timer = window.setTimeout(() => setWaitTick(n => n + 1), Math.max(0, waitsEnd - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [waitsEnd])
  const draft = drafts[chatKey] || ''
  const files = chosen[chatKey] || noFiles
  const desktop = !!window.orbit
  // The current chat's endless-improvement loop as the chat shows it (undefined while it is not active).
  const loop = loopView(chat?.loop, { running, restartWait })

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
    setChosen(previous => { const next = { ...previous }; delete next[`${project.id}/${chatId}`]; return next })
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
  // What a new run of `target`'s chat starts with: the current settings, the project's memory switch, effort and model.
  function taskPayload(target: Project, chatId: string, prompt: string, history: StartTaskPayload['history'], extra: Partial<StartTaskPayload> = {}): StartTaskPayload {
    return {
      projectId: target.id, chatId, prompt, history, workspace: target.workspace.path, ...state.settings,
      memoryEnabled: true, globalMemoryEnabled: target.globalMemoryEnabled ?? state.settings.memoryEnabled, reasoningEffort: selectedEffort,
      model: state.settings.models[providerId]?.trim() || undefined, ...extra,
    }
  }
  // Starts a run and holds the chat's pending key until the desktop answers (so `running` shows and nothing starts twice).
  // `prepare` runs first under the same key and adds to the payload what needs the desktop (the attachments it saves).
  function launch(task: StartTaskPayload, started: (runId: string) => void, failed: (error: unknown) => void, prepare?: () => Promise<Partial<StartTaskPayload>>) {
    const api = window.orbit!
    const key = `${task.projectId}/${task.chatId}`
    pendingRef.current.add(key)
    setPending(previous => new Set(previous).add(key))
    const start = async () => {
      try {
        const runId = await api.startTask(prepare ? { ...task, ...await prepare() } : task)
        setRuns(previous => {
          const base = previous[runId] || snapshotBase({ runId, projectId: task.projectId, chatId: task.chatId })
          return { ...previous, [runId]: { ...base, workspace: task.workspace, prompt: task.prompt, providerId: task.providerId, ...(task.loopTask ? { loopTask: task.loopTask } : {}) } }
        })
        started(runId)
      } catch (error) { failed(error) } finally {
        pendingRef.current.delete(key)
        setPending(previous => { const next = new Set(previous); next.delete(key); return next })
      }
    }
    void start()
  }
  // Files for the current chat's next message: the ones within the limits join, the error says why the others did not.
  function attachFiles(incoming: File[]): string {
    const result = addFiles(files, incoming)
    if (result.files.length !== files.length) setChosen(previous => ({ ...previous, [chatKey]: addFiles(previous[chatKey] || noFiles, incoming).files }))
    return result.error
  }
  function detachFile(index: number) { setChosen(previous => ({ ...previous, [chatKey]: (previous[chatKey] || noFiles).filter((_, at) => at !== index) })) }
  // Sends the current chat's draft: to the working run's root agent while one works (steer), else as a new run. False
  // when nothing was sent (no project, nothing written or attached, a start in progress or awaited after a restart, not ready).
  // The attached files are saved by the desktop first, in the start's own pending step, and ride with the message.
  // `onStarted` runs as soon as the desktop has given the run its id, before the user's message is tagged with it. With
  // the improvement switch on, the started run begins (or continues) the chat's endless-improvement loop.
  function send(onStarted?: (runId: string) => void): boolean {
    if (workingRun) return steer()
    const api = window.orbit
    if (!api || !project || !chat || (!draft.trim() && !files.length) || running || restartWait || pendingRef.current.has(chatKey) || !ready) return false
    const prompt = draft.trim(), attached = files
    const targetProject = project.id, targetChat = chat.id, key = chatKey
    const userMessage: Message = { id: uid(), author: 'user', text: prompt, time: now() }
    const task = taskPayload(project, targetChat, prompt, chatHistory(chat))
    let saved: Attachment[] = []
    setDrafts(previous => ({ ...previous, [key]: '' }))
    setChosen(previous => ({ ...previous, [key]: noFiles }))
    setState(previous => titleChat(addChatMessage(previous, targetProject, targetChat, userMessage), targetProject, targetChat, prompt || attached[0]?.name || ''))
    launch(task, runId => {
      onStarted?.(runId)
      setState(previous => addChatMessage(previous, targetProject, targetChat, { ...userMessage, runId, ...(saved.length ? { attachments: saved } : {}) }))
      if (task.improvementMode) {
        const earlier = Object.values(runsRef.current).filter(r => r.projectId === targetProject && r.chatId === targetChat && r.runId !== runId)
        const baseline = closedKeysOf(newestPlanRun(earlier)?.improvements)
        setState(previous => activateLoop(previous, targetProject, targetChat, prompt, baseline))
      }
    }, error => {
      setState(previous => dropMessage(previous, targetProject, targetChat, userMessage.id))
      const warning: Message = { id: uid(), author: 'system', text: `Не удалось запустить агента: ${errorText(error)}`, time: now(), kind: 'warning' }
      setState(previous => addChatMessage(previous, targetProject, targetChat, warning))
      setDrafts(previous => ({ ...previous, [key]: previous[key] || prompt }))
      setChosen(previous => ({ ...previous, [key]: previous[key]?.length ? previous[key] : attached }))
    }, attached.length ? async () => { saved = await saveFiles(targetChat, attached); return { attachments: saved } } : undefined)
    return true
  }
  // ---- The endless improvement loop: every chat whose loop is active, in every project ----
  // Once the latest run of such a chat has ended, nextLoopStep decides: the next task as a new run with a fresh context
  // (history: []), a retry after a backoff, or the end of the loop. A timer wakes the driver when a retry or a lost start is due.
  const [loopTick, setLoopTick] = useState(0)
  const [loopWake, setLoopWake] = useState(0)
  const waitKeys = [...waits.keys()].sort().join('|')
  useEffect(() => {
    if (!ready || !window.orbit) { setLoopWake(0); return }
    const at = Date.now(), atIso = new Date(at).toISOString()
    const enabled = !!state.settings.improvementMode
    let wake = 0
    for (const target of state.projects) {
      for (const loopChat of target.chats) {
        if (!loopChat.loop?.active) continue
        const key = `${target.id}/${loopChat.id}`
        const chatRunList = Object.values(runs).filter(r => r.projectId === target.id && r.chatId === loopChat.id)
        const busy = pendingRef.current.has(key) || waits.has(key) || chatRunList.some(r => isActiveStatus(r.status))
        const step = nextLoopStep(loopChat, chatRunList, { enabled, busy, now: at, restartNoteText: runId => settlingRestartText(loopChat, runId) })
        if (step.kind === 'idle') { if (step.wakeAt && (!wake || step.wakeAt < wake)) wake = step.wakeAt }
        else if (step.kind === 'stop' || step.kind === 'retry') {
          const note = loopStateNote(step.note, atIso, step.kind === 'retry' ? `loop-retry-${step.runId}` : undefined)
          setState(previous => addChatMessage(setChatLoop(previous, target.id, loopChat.id, step.loop), target.id, loopChat.id, note))
        } else startLoopTask(target, loopChat, step.loop, step.task, step.outcome)
      }
    }
    setLoopWake(wake)
  }, [ready, state, runs, waitKeys, loopTick])
  useEffect(() => {
    if (!loopWake) return
    const timer = window.setTimeout(() => setLoopTick(n => n + 1), Math.max(0, loopWake - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [loopWake, loopTick])
  // One loop task: the loop is saved first (task number, lastRunId, startingAt), then the run starts under the chat's
  // pending key; its loop note stands for the generated prompt. A refused start is repeated later (loopStartFailed): in
  // seconds and silently while Orbit is busy, after a backoff and with a warning otherwise.
  function startLoopTask(target: Project, loopChat: ChatThread, loop: ImprovementLoop, taskNumber: number, outcome?: string) {
    const key = `${target.id}/${loopChat.id}`
    if (pendingRef.current.has(key)) return
    const previousIteration = loopChat.loop?.iteration ?? 1
    const prompt = loopPrompt(loop, loopChat.messages, taskNumber, outcome)
    const task = taskPayload(target, loopChat.id, prompt, [], { improvementMode: true, loopTask: taskNumber })
    setState(previous => setChatLoop(previous, target.id, loopChat.id, loop))
    launch(task, runId => {
      setState(previous => addChatMessage(previous, target.id, loopChat.id, loopNote(runId, taskNumber, now(), outcome)))
    }, error => {
      setState(previous => {
        const current = previous.projects.find(p => p.id === target.id)?.chats.find(c => c.id === loopChat.id)?.loop
        if (!current?.active) return previous
        const failed = loopStartFailed(current, previousIteration, errorText(error), Date.now())
        const next = setChatLoop(previous, target.id, loopChat.id, failed.loop)
        if (!failed.note) return next
        const warning: Message = { id: uid(), author: 'system', kind: 'warning', text: failed.note, time: now() }
        return addChatMessage(next, target.id, loopChat.id, warning)
      })
    })
  }
  // The loop banner's actions: stop the current chat's loop (a working run finishes its task), or start a waiting retry now.
  function stopLoopHere() {
    if (!project || !chat?.loop?.active) return
    const note = workingRun || pendingRef.current.has(chatKey) ? '∞ Цикл остановлен: текущая задача доработает, следующая не начнётся.' : undefined
    setState(previous => stopLoop(previous, project.id, chat.id, 'manual', now(), note))
  }
  function runLoopNow() {
    if (!project || !chat?.loop?.active || chat.loop.retryAt === undefined) return
    const due = { ...chat.loop, retryAt: Date.now() }
    setState(previous => setChatLoop(previous, project.id, chat.id, due))
  }
  // Sends an extra message to an agent of a working run; rejects with the runtime's reason. A message to the root agent
  // shows in the run's chat at once and is taken back when refused; one to a helper shows only in the inspector.
  // `files` are saved first and go with the message (the composer's attachments; the inspector's box sends none).
  async function messageAgent(runId: string, agentId: string, text: string, files: File[] = []): Promise<void> {
    const run = runs[runId]
    if (!window.orbit || !run) throw new Error('Запуск не найден')
    let attachments: Attachment[] = []
    try { if (files.length) attachments = await saveFiles(run.chatId, files) } catch (error) { throw new Error(remoteErrorText(error)) }
    const message: Message | null = agentId === 'root' ? { id: uid(), author: 'user', text, time: now(), runId, kind: 'steer', ...(attachments.length ? { attachments } : {}) } : null
    if (message) setState(previous => addChatMessage(previous, run.projectId, run.chatId, message))
    try { await window.orbit.messageAgent(runId, agentId, text, attachments.length ? attachments : undefined) } catch (error) {
      if (message) setState(previous => dropMessage(previous, run.projectId, run.chatId, message.id))
      throw new Error(remoteErrorText(error))
    }
  }
  // Pause, resume and stop of one agent of a working run. Like messageAgent they reject with the runtime's reason, which
  // the inspector shows under its buttons; the run's own events bring the new state, so nothing is changed here.
  const controlAgent = (call: 'pauseAgent' | 'resumeAgent' | 'stopAgent') => async (runId: string, agentId: string): Promise<void> => {
    if (!window.orbit) throw new Error('Доступно только в настольном Orbit')
    try { await window.orbit[call](runId, agentId) } catch (error) { throw new Error(remoteErrorText(error)) }
  }
  const pauseAgent = controlAgent('pauseAgent'), resumeAgent = controlAgent('resumeAgent'), stopAgent = controlAgent('stopAgent')
  // The composer's button: pauses the whole team through the root agent, or resumes it; a refusal goes to the toast.
  function togglePause() {
    const root = workingRun?.agents.find(agent => agent.id === 'root')
    if (!workingRun || !root) return
    void (root.paused ? resumeAgent : pauseAgent)(workingRun.runId, 'root').catch(error => setNotice(errorText(error)))
  }
  // The composer's draft to the working root agent; on refusal the draft comes back with a warning in the chat.
  function steer(): boolean {
    const text = draft.trim(), attached = files
    if (!workingRun || !project || !chat || (!text && !attached.length) || !canSteer || steeringRef.current.has(chatKey)) return false
    const key = chatKey, targetProject = project.id, targetChat = chat.id
    const done = () => { steeringRef.current.delete(key); setSteering(previous => { const next = new Set(previous); next.delete(key); return next }) }
    steeringRef.current.add(key)
    setSteering(previous => new Set(previous).add(key))
    setDrafts(previous => ({ ...previous, [key]: '' }))
    setChosen(previous => ({ ...previous, [key]: noFiles }))
    messageAgent(workingRun.runId, 'root', text, attached).catch(error => {
      const warning: Message = { id: uid(), author: 'system', text: `Сообщение не доставлено агенту: ${errorText(error)}`, time: now(), kind: 'warning' }
      setState(previous => addChatMessage(previous, targetProject, targetChat, warning))
      setDrafts(previous => ({ ...previous, [key]: previous[key] || text }))
      setChosen(previous => ({ ...previous, [key]: previous[key]?.length ? previous[key] : attached }))
    }).finally(done)
    return true
  }
  async function stop() {
    if (!workingRun || !window.orbit) return
    // The user's Stop also ends the chat's improvement loop; any other cancel (Orbit quitting, a runtime restart) is retried.
    const { projectId, chatId } = workingRun
    setState(previous => stopLoop(previous, projectId, chatId, 'user'))
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
    project, globalMemoryEnabled, chat, chatKey, chatRuns, workingRun, running, canSteer, restartWait, restartWaits: waits, draft, setDraft, files, attachFiles, detachFile, loop,
    currentHealth, connected, modelChoices, selectedEffort,
    updateSettings, setGlobalMemory, selectProject, selectChat, createChat, deleteChat, addProject, send, messageAgent, pauseAgent, resumeAgent, stopAgent, togglePause, stop, refreshProviders, restartRuntime,
    stopLoop: stopLoopHere, runLoopNow,
  }
}
