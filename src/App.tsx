import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Agent, AppState, Capability, ChatThread, Communication, InspectorTab, LibraryStats, MemoryEntry, MemoryScope, Message, Project, QuotaSnapshot, RunSnapshot, RunStatus, Settings, TierStats, Workspace } from './types'
import { AgentGraph } from './AgentGraph'
import { Markdown, assistantOutput, plural, statusText, timeOf } from './format'
import { RunHistory, RunHistoryList, runChangedFiles } from './AgentHistory'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
import { fileMap } from './file-map'
import { SwarmSettings } from './SwarmSettings'
import { ReasoningPicker, reasoningLevels, effortLabels } from './ReasoningPicker'
import { QuotaPanel, QuotaChip, handoverLabel, handoverReason, handoverText, windowsFor, usedNow, windowName } from './QuotaPanel'

const providers = [
  { id: 'codex', name: 'Codex', description: 'CLI · подписка или API', help: 'Установите Codex CLI и выполните codex login в терминале.' },
  { id: 'claude', name: 'Claude Code', description: 'CLI · подписка или API', help: 'Установите Claude Code и войдите в аккаунт командой claude.' },
  { id: 'antigravity', name: 'Antigravity', description: 'CLI · Google AI Pro / Ultra', help: 'Установите Antigravity CLI и войдите в Google-аккаунт через agy. Доступ зависит от подписки и поддерживаемого Google региона аккаунта.' },
  { id: 'cursor', name: 'Cursor', description: 'CLI · подписка Cursor', help: 'Cursor IDE и Cursor CLI устанавливаются отдельно. Для Orbit установите Cursor CLI и выполните agent login. Модели загружаются из CLI.' },
  { id: 'ollama', name: 'Ollama', description: 'Локальные модели', help: 'Запустите Ollama. Модель можно указать в настройках; адрес сервера задаётся через ORBIT_OLLAMA_URL.' },
  { id: 'custom', name: 'OpenAI-compatible', description: 'Совместимый API', help: 'Задайте ORBIT_OPENAI_BASE_URL, ORBIT_OPENAI_API_KEY и ORBIT_OPENAI_MODEL в окружении приложения.' },
]
const defaults: Settings = { providerId: 'codex', models: {}, limitVersion: 2, improvementMode: false, skillLearning: true, providerPool: [], providerOptions: {}, quotaFailover: { enabled: true, switchAtPercent: 90, allowWeaker: false }, memoryEnabled: true, accessMode: 'workspace-write', approvalPolicy: 'on-request', reasoningEffort: '', agentInstructions: '', limits: { maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null } }
const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const nameOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Проект'
const active = (status?: RunStatus) => status === 'working' || status === 'waiting'
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const routeLabel: Record<string, string> = { direct: 'напрямую', explicit: 'адресат указан отправителем', match: 'подобран по файлам и теме', reply: 'ответ автору сообщения', escalation: 'передано руководителю' }
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback } }
function normalize(value: Partial<AppState>): AppState {
  const projects = (Array.isArray(value.projects) ? value.projects : []).filter(p => p?.id && p.workspace?.path).map(p => ({ ...p, chats: (Array.isArray(p.chats) ? p.chats : []).map(c => ({ ...c, messages: (Array.isArray(c.messages) ? c.messages : []).filter(m => m.id !== 'welcome') })) }))
  const settings = { ...defaults, ...value.settings, models: { ...value.settings?.models }, limits: { ...defaults.limits, ...value.settings?.limits } }
  if (!value.settings?.limitVersion) {
    const legacy = { maxAgents: 12, maxDepth: 3, maxConcurrent: 3, maxTurns: 12, maxTotalTurns: 48 }
    for (const key of Object.keys(legacy) as (keyof typeof legacy)[]) if (settings.limits[key] === legacy[key]) settings.limits[key] = null
    settings.limitVersion = 2
  }
  if (!providers.some(p => p.id === settings.providerId)) settings.providerId = 'codex'
  if (!['never', 'on-request', 'auto-review'].includes(settings.approvalPolicy)) settings.approvalPolicy = 'on-request'
  const savedFailover = value.settings?.quotaFailover, savedPercent = Number(savedFailover?.switchAtPercent)
  settings.quotaFailover = { enabled: savedFailover?.enabled !== false, switchAtPercent: Number.isFinite(savedPercent) ? Math.max(50, Math.min(99, Math.round(savedPercent))) : 90, allowWeaker: savedFailover?.allowWeaker === true }
  settings.providerOptions = { ...settings.providerOptions }
  if (settings.reasoningEffort && settings.providerOptions[settings.providerId]?.reasoningEffort === undefined) {
    settings.providerOptions[settings.providerId] = { ...settings.providerOptions[settings.providerId], reasoningEffort: settings.reasoningEffort }
  }
  settings.reasoningEffort = ''
  // Google models have reasoning built in; values saved by older versions must not linger or be resent.
  if (settings.providerOptions.antigravity?.reasoningEffort) settings.providerOptions.antigravity = { ...settings.providerOptions.antigravity, reasoningEffort: '' }
  settings.providerPool = (settings.providerPool || []).map(member => member.providerId === 'antigravity' && member.reasoningEffort ? { ...member, reasoningEffort: '' } : member)
  return { version: 3, projects, activeProjectId: projects.some(p => p.id === value.activeProjectId) ? value.activeProjectId! : projects[0]?.id || '', settings, savedAt: value.savedAt }
}
function initialState(): AppState {
  const saved = stored<AppState | null>('orbit:state:v3', null)
  if (saved) return normalize(saved)
  return normalize({ projects: stored<Project[]>('orbit:projects', []), activeProjectId: stored('orbit:active-project', ''), settings: { ...defaults, providerId: stored('orbit:preferred-provider', 'codex'), memoryEnabled: stored('orbit:memory-enabled', true), agentInstructions: stored('orbit:agent-instructions', '') } })
}
function newChat(): ChatThread { return { id: uid(), title: 'Новый чат', messages: [], updated: now() } }
function mergeMessage(messages: Message[], message: Message) { const index = messages.findIndex(m => m.id === message.id); return index < 0 ? [...messages, message] : messages.map(m => m.id === message.id ? { ...m, ...message } : m) }
function mergeById<T extends { id: string }>(saved: T[], live: T[]) {
  const records = new Map(saved.map(item => [item.id, item]))
  for (const item of live) records.set(item.id, { ...records.get(item.id), ...item })
  return [...records.values()]
}
function addChatMessage(state: AppState, projectId: string, chatId: string, message: Message): AppState {
  return { ...state, projects: state.projects.map(p => p.id !== projectId ? p : { ...p, chats: p.chats.map(c => c.id !== chatId ? c : { ...c, updated: now(), messages: mergeMessage(c.messages, message) }) }) }
}
function snapshotBase(event: Partial<RuntimeEvent>): RunSnapshot { return { runId: event.runId!, projectId: event.projectId!, chatId: event.chatId!, workspace: event.workspace || '', prompt: event.prompt || '', status: 'working', agents: [], traces: [], messages: [], communications: [], startedAt: now(), providerId: event.providerId, model: event.model } }
function reconcile(state: AppState, snapshots: RunSnapshot[]) {
  let next = state
  for (const run of [...snapshots].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))) {
    if (!run.runId || !run.projectId || !run.chatId || !run.workspace) continue
    if (next.projects.find(p => p.id === run.projectId)?.deletedChatIds?.includes(run.chatId)) continue
    if (!next.projects.some(p => p.id === run.projectId)) next = { ...next, projects: [...next.projects, { id: run.projectId, workspace: { path: run.workspace, name: nameOf(run.workspace), connected: false, branch: '', changedFiles: 0 }, chats: [] }] }
    next = { ...next, projects: next.projects.map(p => p.id !== run.projectId || p.chats.some(c => c.id === run.chatId) ? p : { ...p, chats: [...p.chats, { id: run.chatId, title: run.prompt?.slice(0, 52) || 'Восстановленный чат', messages: [], updated: run.startedAt }] }) }
    const chat = next.projects.find(p => p.id === run.projectId)!.chats.find(c => c.id === run.chatId)!
    if (run.prompt && !chat.messages.some(m => m.author === 'user' && m.runId === run.runId)) {
      const legacyMessage = chat.messages.find(m => m.author === 'user' && !m.runId && m.text === run.prompt)
      next = addChatMessage(next, run.projectId, run.chatId, legacyMessage ? { ...legacyMessage, runId: run.runId } : { id: `prompt-${run.runId}`, author: 'user', text: run.prompt, time: run.startedAt, runId: run.runId })
    }
    for (const message of run.messages || []) if (!message.agentId || message.agentId === 'root') next = addChatMessage(next, run.projectId, run.chatId, { ...message, runId: run.runId })
  }
  return { ...next, projects: next.projects.map(p => ({ ...p, chats: p.chats.map(c => ({ ...c, messages: [...c.messages].sort((a, b) => { const left = Date.parse(a.time), right = Date.parse(b.time); return Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right }) })) })) }
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />, chevron: <path d="m8 10 4 4 4-4" />, arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    folder: <path d="M3 6h6l2 2h10v12H3z" />, git: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 8c0 6-12 2-12 7" /></>,
    chat: <path d="M21 4H3v14h5l4 4v-4h9z" />, close: <path d="m6 6 12 12M6 18 18 6" />, stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    agents: <><circle cx="12" cy="5" r="3" /><circle cx="5" cy="19" r="3" /><circle cx="19" cy="19" r="3" /><path d="M12 8v4H5v4m7-4h7v4" /></>,
    memory: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
    skill: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" /></>,
    refresh: <><path d="M20 10a8 8 0 1 0-1 8M20 3v7h-7" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />, check: <path d="m5 12 4 4L19 6" />, terminal: <><path d="m4 6 6 6-6 6M13 18h7" /></>,
    index: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    gauge: <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 18 4-6" /></>,
    pin: <><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 12v9" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.chat}</svg>
}
function ModelPicker({ value, models, onChange, label = 'Модель' }: { value: string; models: string[]; onChange: (value: string) => void; label?: string }) {
  const [custom, setCustom] = useState(false)
  const choices = [...new Set([...models, ...(value ? [value] : [])])]
  return <div className="model-picker"><select aria-label={label} title={value || 'Модель по умолчанию'} value={custom ? '__custom__' : value} onChange={event => {
    if (event.target.value === '__custom__') setCustom(true)
    else { setCustom(false); onChange(event.target.value) }
  }}><option value="">Модель: автоматически</option>{choices.map(model => <option key={model} value={model}>{model}</option>)}<option value="__custom__">Указать свою…</option></select>{custom && <input autoFocus aria-label={`${label}: свой идентификатор`} placeholder="Идентификатор модели" value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />}</div>
}

export default function App() {
  const [state, setState] = useState(initialState)
  const [ready, setReady] = useState(!window.orbit)
  const [runs, setRuns] = useState<Record<string, RunSnapshot>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const pendingRef = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [checking, setChecking] = useState(false)
  const [panel, setPanel] = useState<'settings' | 'memory' | 'capabilities' | 'add' | 'quota' | null>(null)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState(false)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [selectedAgent, setSelectedAgent] = useState('root')
  // openTeam(runId, tab) asks the inspector to open on a tab; `seq` remounts an inspector that is already showing that run.
  const [inspectorRequest, setInspectorRequest] = useState<{ runId: string; tab: InspectorTab; seq: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState('')
  const [runtimeStorageError, setRuntimeStorageError] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [remote, setRemote] = useState('')
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [libraryStats, setLibraryStats] = useState<LibraryStats | null>(null)
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [libraryRevision, setLibraryRevision] = useState(0)
  const [indexInfo, setIndexInfo] = useState<ProjectIndexStatus | null>(null)
  const [indexBusy, setIndexBusy] = useState(false)
  const [quotas, setQuotas] = useState<Record<string, QuotaSnapshot>>({})
  const [quotaBusy, setQuotaBusy] = useState(false)
  const providerOptionsRef = useRef(state.settings.providerOptions)
  providerOptionsRef.current = state.settings.providerOptions
  const quotaRefresh = useRef<number | undefined>(undefined)
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const project = state.projects.find(p => p.id === state.activeProjectId) || state.projects[0]
  const globalMemoryEnabled = project?.globalMemoryEnabled ?? state.settings.memoryEnabled
  const chat = project?.chats.find(c => c.id === project.activeChatId) || project?.chats[0]
  const chatKey = `${project?.id || ''}/${chat?.id || ''}`
  const chatRuns = useMemo(() => Object.values(runs).filter(r => r.projectId === project?.id && r.chatId === chat?.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs, project?.id, chat?.id])
  const currentRun = chatRuns.find(r => r.runId === selection[chatKey]) || chatRuns.at(-1)
  const workingRun = chatRuns.find(r => active(r.status))
  const running = !!workingRun || pending.has(chatKey)
  const otherActiveChats = Object.values(runs).filter(run => run.projectId === project?.id && run.chatId !== chat?.id && active(run.status)).length
  const routerAgent: Agent = { id: 'router', name: 'Маршрутизатор', role: 'Системный участник', status: active(currentRun?.status) ? 'working' : 'done' }
  const selected = selectedAgent === 'router' && currentRun ? routerAgent : currentRun?.agents.find(a => a.id === selectedAgent) || currentRun?.agents[0]
  const lastAnswerOfRun = new Map<string, string>()
  for (const message of chat?.messages || []) if (message.author === 'orbit' && message.runId) lastAnswerOfRun.set(message.runId, message.id)
  // A finished run that never answered (failed, stopped) keeps its team strip and history under the user's message.
  const historyAnchor = new Map(lastAnswerOfRun)
  for (const message of chat?.messages || []) if (message.author === 'user' && message.runId && !historyAnchor.has(message.runId) && runs[message.runId] && !active(runs[message.runId].status)) historyAnchor.set(message.runId, message.id)
  const currentHealth = health.find(p => p.id === state.settings.providerId)
  const connected = Object.fromEntries(health.map(p => [p.id, p.available]))
  // The sidebar dot summarises the connected subscriptions: any exhausted, any close to the limit, otherwise fine.
  const quotaStates = providers.filter(p => connected[p.id]).map(p => quotas[p.id]?.state)
  const quotaDot = quotaStates.includes('exhausted') ? 'error' : quotaStates.includes('warning') ? 'waiting' : quotaStates.some(s => s === 'ok') ? 'done' : 'idle'
  const modelChoices = [...new Set([...(currentHealth?.models || []), ...(currentHealth?.model ? [currentHealth.model] : []), ...Object.values(runs).filter(run => run.providerId === state.settings.providerId && run.model).map(run => run.model!)])]
  const effortLevels = reasoningLevels(state.settings.providerId, state.settings.models[state.settings.providerId] || '', currentHealth)
  const savedEffort = state.settings.providerOptions?.[state.settings.providerId]?.reasoningEffort || ''
  const selectedEffort = effortLevels.includes(savedEffort) ? savedEffort : ''
  const accessChoice = state.settings.approvalPolicy === 'on-request' ? 'ask' : state.settings.accessMode
  function chooseAccess(value: string) { updateSettings({ accessMode: value === 'ask' ? 'workspace-write' : value as Settings['accessMode'], approvalPolicy: value === 'ask' ? 'on-request' : 'never' }) }
  const draft = drafts[chatKey] || ''
  const desktop = !!window.orbit

  async function refreshQuotas(force = false) {
    const api = window.orbit
    if (!api) return
    setQuotaBusy(true)
    try { setQuotas(await api.getQuotas(providerOptionsRef.current, force)) } catch (error) { setNotice(`Не удалось получить квоты: ${errorText(error)}`) } finally { setQuotaBusy(false) }
  }
  useEffect(() => {
    const api = window.orbit
    if (!api) return
    const off = api.onQuotaUpdate(update => { if (update.snapshot) setQuotas(previous => ({ ...previous, [update.providerId]: update.snapshot! })) })
    void refreshQuotas()
    return () => { off(); window.clearTimeout(quotaRefresh.current) }
  }, [])
  // The open quota window keeps itself current; the shared cache makes this cheap.
  useEffect(() => {
    if (panel !== 'quota') return
    void refreshQuotas()
    const timer = window.setInterval(() => void refreshQuotas(), 60000)
    return () => window.clearInterval(timer)
  }, [panel])

  useEffect(() => {
    const api = window.orbit
    if (!api) return
    let mounted = true
    let restoring = true
    const restoredDuringLoad: { projectId: string; chatId: string; message: Message }[] = []
    const unsubscribe = api.onRuntimeEvent(event => {
      if (!event.projectId || !event.chatId) return
      if (event.warning) setRuntimeStorageError(event.warning)
      setRuns(previous => {
        const run = { ...(previous[event.runId] || snapshotBase(event)), updatedAt: now() }
        if (event.providerId && (!event.agentId || event.agentId === 'root')) run.providerId = event.providerId
        if (event.model && (!event.agentId || event.agentId === 'root')) run.model = event.model
        if (event.prompt) run.prompt = event.prompt
        if (event.workspace) run.workspace = event.workspace
        if (event.limits) run.limits = event.limits
        if (event.improvements) run.improvements = event.improvements
        if (event.improvementStatus) run.improvementStatus = event.improvementStatus
        if (event.usage) run.usage = event.usage
        if (event.router) run.router = event.router
        if (event.type === 'run.started') run.status = 'working'
        if (event.agent) { const exists = run.agents.some(a => a.id === event.agent!.id); run.agents = exists ? run.agents.map(a => a.id === event.agent!.id ? { ...a, ...event.agent } : a) : [...run.agents, event.agent] }
        if (event.trace) run.traces = (run.traces.some(t => t.id === event.trace!.id) ? run.traces.map(t => t.id === event.trace!.id ? event.trace! : t) : [...run.traces, event.trace]).slice(-1500)
        if (event.message) run.messages = mergeMessage(run.messages, { ...event.message, runId: event.runId })
        if (event.communication) {
          const communication = event.communication
          const existing = run.communications || []
          run.communications = existing.some(item => item.id === communication.id) ? existing.map(item => item.id === communication.id ? { ...item, ...communication } : item) : [...existing, communication]
        }
        if (event.change) { const change = event.change; const existing = run.changes || []; run.changes = (existing.some(item => item.id === change.id) ? existing.map(item => item.id === change.id ? { ...item, ...change } : item) : [...existing, change]).slice(-500) }
        if (event.type === 'run.finished') { run.status = event.status || 'completed'; run.summary = event.summary; run.finishedAt = now() }
        if (event.type === 'run.failed') { run.status = 'failed'; run.error = event.error; run.finishedAt = now() }
        if (event.type === 'run.cancelled') { run.status = 'cancelled'; run.finishedAt = now() }
        return { ...previous, [event.runId]: run }
      })
      if (event.message && (!event.message.agentId || event.message.agentId === 'root')) {
        const message = { ...event.message, runId: event.runId }
        if (restoring) restoredDuringLoad.push({ projectId: event.projectId, chatId: event.chatId, message })
        setState(previous => addChatMessage(previous, event.projectId, event.chatId, message))
      }
      if (event.type === 'agent.handover' && event.handover) {
        const text = handoverText(providers, event.agent?.name || 'Агент', event.handover)
        setNotice(text)
        if (!event.agentId || event.agentId === 'root') setState(previous => addChatMessage(previous, event.projectId, event.chatId, { id: `handover-${event.handover!.id}`, author: 'system', text, time: event.handover!.time, runId: event.runId, kind: 'handover' }))
      }
      if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') {
        setLibraryRevision(n => n + 1)
        // A run has just spent quota: read it again once the burst of finishing runs has settled.
        window.clearTimeout(quotaRefresh.current)
        quotaRefresh.current = window.setTimeout(() => void refreshQuotas(true), 2500)
      }
    })
    void api.checkProviders(state.settings.providerOptions).then(result => { if (mounted) setHealth(result) }).catch(error => { if (mounted) setNotice(`Не удалось проверить провайдеры: ${errorText(error)}`) })
    void Promise.allSettled([api.loadState(), api.listRuns()]).then(results => {
      if (!mounted) return
      const [saved, recovered] = results
      const snapshots = recovered.status === 'fulfilled' ? recovered.value : []
      setState(previous => {
        const durable = saved.status === 'fulfilled' && saved.value ? normalize(saved.value) : null
        const newest = durable && (durable.savedAt || 0) >= (previous.savedAt || 0) ? durable : previous
        return restoredDuringLoad.reduce((result, item) => addChatMessage(result, item.projectId, item.chatId, item.message), reconcile(newest, snapshots))
      })
      setRuns(previous => {
        const restored = { ...previous }
        for (const snapshot of snapshots) {
          const live = previous[snapshot.runId]
          const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)
          restored[snapshot.runId] = {
            ...snapshot, ...live, startedAt: snapshot.startedAt,
            status: terminal ? snapshot.status : live?.status ?? snapshot.status,
            providerId: live?.providerId ?? snapshot.providerId, model: live?.model || snapshot.model,
            prompt: live?.prompt || snapshot.prompt, workspace: live?.workspace || snapshot.workspace,
            agents: mergeById(snapshot.agents || [], live?.agents || []),
            traces: mergeById(snapshot.traces || [], live?.traces || []),
            messages: mergeById(snapshot.messages || [], live?.messages || []),
            communications: mergeById(snapshot.communications || [], live?.communications || []),
          }
          // The saved list has no diff texts, the live events do: keep both, and keep the run without `changes` when neither has any.
          if (snapshot.changes || live?.changes) restored[snapshot.runId].changes = mergeById(snapshot.changes || [], live?.changes || []).slice(-500)
        }
        return restored
      })
      if (saved.status === 'rejected' || recovered.status === 'rejected') setNotice('Не удалось полностью восстановить данные. Локальная история чатов сохранена в интерфейсе.')
      restoring = false
      setReady(true)
    })
    return () => { mounted = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!ready) return
    const snapshot = { ...state, savedAt: Date.now() }
    try { localStorage.setItem('orbit:state:v3', JSON.stringify(snapshot)) } catch { /* Desktop also persists in its data directory. */ }
    const timer = window.setTimeout(() => { if (window.orbit) void window.orbit.saveState(snapshot).then(() => setStorageError('')).catch(error => setStorageError(`Не удалось сохранить историю: ${errorText(error)}`)) }, 350)
    return () => clearTimeout(timer)
  }, [state, ready])

  // The runtime decides which projects may feed the shared memory; it learns each project's switch from here.
  const sharingState = state.projects.map(p => `${p.workspace.path}\u0000${p.globalMemoryEnabled ?? state.settings.memoryEnabled ? 1 : 0}`).join('\u0001')
  useEffect(() => {
    if (!ready || !window.orbit) return
    for (const entry of sharingState ? sharingState.split('\u0001') : []) {
      const [workspace, flag] = entry.split('\u0000')
      if (workspace) void window.orbit.setMemorySharing(workspace, flag === '1').catch(() => undefined)
    }
  }, [ready, sharingState])

  useEffect(() => { nearBottom.current = true; bottom.current?.scrollIntoView({ behavior: 'instant' }); setSelectedAgent('root') }, [chatKey])
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages.length, running])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7500); return () => clearTimeout(timer) }, [notice])
  useEffect(() => {
    if (panel !== 'memory' && panel !== 'capabilities') return
    const api = window.orbit
    if (!api) return
    let mounted = true
    setLoadingLibrary(true)
    setMemory([]); setCapabilities([]); setLibraryStats(null)
    const workspace = project?.workspace.path || ''
    void Promise.all([api.listMemory(workspace, chat?.id), api.listCapabilities(workspace), api.memoryStats(workspace, chat?.id)]).then(([entries, skills, stats]) => { if (mounted) { setMemory(entries); setCapabilities(skills); setLibraryStats(stats) } }).catch(error => { if (mounted) setNotice(errorText(error)) }).finally(() => { if (mounted) setLoadingLibrary(false) })
    return () => { mounted = false }
  }, [panel, project?.workspace.path, chat?.id, libraryRevision])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPanel(null); setProjectMenu(false); setSidebarOpen(false) } }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  useEffect(() => {
    if (!panel) return
    const before = document.activeElement as HTMLElement | null
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') || []).filter(element => element.getClientRects().length > 0)
    const timer = setTimeout(() => focusable()[0]?.focus(), 0)
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable(), first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { clearTimeout(timer); document.removeEventListener('keydown', trap); before?.focus() }
  }, [panel])

  useEffect(() => {
    const api = window.orbit
    if (!api || !project?.workspace.path) { setIndexInfo(null); return }
    let mounted = true
    void api.projectIndexStatus(project.workspace.path).then(info => { if (mounted) setIndexInfo(info) }).catch(() => { if (mounted) setIndexInfo(null) })
    return () => { mounted = false }
  }, [project?.workspace.path, libraryRevision])

  async function rebuildIndex() {
    if (!window.orbit || !project || indexBusy) return
    setIndexBusy(true)
    try { setIndexInfo(await window.orbit.projectIndexStatus(project.workspace.path, true)) } catch (error) { setNotice(errorText(error)) } finally { setIndexBusy(false) }
  }
  function openTeam(runId: string, tab?: InspectorTab, agentId = 'root') {
    setSelection(previous => ({ ...previous, [chatKey]: runId })); setSelectedAgent(agentId); setAgentsOpen(true)
    if (tab) setInspectorRequest(previous => ({ runId, tab, seq: (previous?.seq || 0) + 1 }))
  }
  // Picking another run forgets an earlier «open on this tab» request, so coming back to a run does not jump to that tab again.
  function pickRun(runId: string) {
    setSelection(previous => ({ ...previous, [chatKey]: runId })); setSelectedAgent('root')
    if (runId !== currentRun?.runId) setInspectorRequest(null)
  }
  function updateSettings(patch: Partial<Settings>) { setState(previous => ({ ...previous, settings: { ...previous.settings, ...patch } })) }
  function setGlobalMemory(enabled: boolean) {
    if (!project) return
    setState(previous => ({ ...previous, projects: previous.projects.map(p => p.id === project.id ? { ...p, globalMemoryEnabled: enabled } : p) }))
  }
  function deleteChat(chatId: string) {
    if (!project || pendingRef.current.has(`${project.id}/${chatId}`) || Object.values(runs).some(r => r.projectId === project.id && r.chatId === chatId && active(r.status))) return
    setState(previous => ({ ...previous, projects: previous.projects.map(p => {
      if (p.id !== project.id) return p
      const remaining = p.chats.filter(c => c.id !== chatId)
      const chats = remaining.length ? remaining : [newChat()]
      return { ...p, chats, activeChatId: chats.some(c => c.id === p.activeChatId) ? p.activeChatId : chats[0].id, deletedChatIds: [...new Set([...(p.deletedChatIds || []), chatId])] }
    }) }))
    setDrafts(previous => { const next = { ...previous }; delete next[`${project.id}/${chatId}`]; return next })
    // A deleted chat takes its working notes with it (what proved durable was already moved to the project).
    if (window.orbit && project.workspace.path) void window.orbit.forgetChatMemory(project.workspace.path, chatId).catch(() => undefined)
  }
  function createChat() {
    if (!project) return
    const next = newChat()
    setState(previous => ({ ...previous, projects: previous.projects.map(p => p.id === project.id ? { ...p, activeChatId: next.id, chats: [next, ...p.chats] } : p) }))
    setSidebarOpen(false)
  }
  async function addProject(kind: 'local' | 'git') {
    if (!window.orbit || projectBusy) return
    setProjectBusy(true)
    try {
      const context = kind === 'local' ? await window.orbit.pickWorkspace() : await window.orbit.cloneWorkspace(remote.trim())
      if (!context) return
      if ('error' in context && context.error) throw new Error(String(context.error))
      const workspace: Workspace = { ...context, name: nameOf(context.path) }
      const existing = state.projects.find(p => p.workspace.path.replace(/[\\/]+$/, '').toLowerCase() === context.path.replace(/[\\/]+$/, '').toLowerCase())
      if (existing) setState(previous => ({ ...previous, activeProjectId: existing.id }))
      else { const first = newChat(); const next: Project = { id: uid(), workspace, chats: [first], activeChatId: first.id }; setState(previous => ({ ...previous, projects: [...previous.projects, next], activeProjectId: next.id })) }
      setPanel(null); setRemote(''); setProjectMenu(false)
    } catch (error) { setNotice(errorText(error)) } finally { setProjectBusy(false) }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!window.orbit || !project || !chat || !draft.trim() || running || pendingRef.current.has(chatKey) || !ready) return
    const prompt = draft.trim()
    const targetProject = project.id, targetChat = chat.id, key = chatKey
    const userMessage: Message = { id: uid(), author: 'user', text: prompt, time: now() }
    const history = chat.messages.filter(m => m.author === 'user' || m.author === 'orbit').slice(-40).map(m => ({ role: m.author === 'user' ? 'user' as const : 'assistant' as const, content: m.text }))
    pendingRef.current.add(key)
    setPending(previous => new Set(previous).add(key))
    setDrafts(previous => ({ ...previous, [key]: '' }))
    setState(previous => {
      const next = addChatMessage(previous, targetProject, targetChat, userMessage)
      return { ...next, projects: next.projects.map(p => p.id !== targetProject ? p : { ...p, chats: p.chats.map(c => c.id === targetChat && c.title === 'Новый чат' ? { ...c, title: prompt.replace(/\s+/g, ' ').slice(0, 54) } : c) }) }
    })
    nearBottom.current = true
    // The panel follows the new run only if the user was watching the newest one or the panel is closed; an older run they are reading stays.
    const followNewRun = !agentsOpen || !currentRun || currentRun.runId === chatRuns.at(-1)?.runId
    try {
      const runId = await window.orbit.startTask({ projectId: targetProject, chatId: targetChat, prompt, history, workspace: project.workspace.path, ...state.settings, memoryEnabled: true, globalMemoryEnabled, reasoningEffort: selectedEffort, model: state.settings.models[state.settings.providerId]?.trim() || undefined })
      setRuns(previous => ({ ...previous, [runId]: { ...(previous[runId] || snapshotBase({ runId, projectId: targetProject, chatId: targetChat })), workspace: project.workspace.path, prompt, providerId: state.settings.providerId } }))
      if (followNewRun) setSelection(previous => ({ ...previous, [key]: runId }))
      setState(previous => addChatMessage(previous, targetProject, targetChat, { ...userMessage, runId }))
    } catch (error) {
      setState(previous => ({ ...previous, projects: previous.projects.map(p => p.id !== targetProject ? p : { ...p, chats: p.chats.map(c => c.id !== targetChat ? c : { ...c, messages: c.messages.filter(m => m.id !== userMessage.id) }) }) }))
      setState(previous => addChatMessage(previous, targetProject, targetChat, { id: uid(), author: 'system', text: `Не удалось запустить агента: ${errorText(error)}`, time: now(), kind: 'warning' }))
      setDrafts(previous => ({ ...previous, [key]: previous[key] || prompt }))
    } finally { pendingRef.current.delete(key); setPending(previous => { const next = new Set(previous); next.delete(key); return next }) }
  }
  async function stop() {
    if (!workingRun || !window.orbit) return
    try { const stopped = await window.orbit.stopTask(workingRun.runId); if (!stopped) setNotice('Этот запуск уже завершён.') } catch (error) { setNotice(errorText(error)) }
  }
  async function refreshProviders() {
    if (!window.orbit || checking) return
    setChecking(true)
    try { setHealth(await window.orbit.checkProviders(state.settings.providerOptions)) } catch (error) { setNotice(errorText(error)) } finally { setChecking(false) }
  }
  function agentTree(items: Agent[], parentId: string | null = null, depth = 0, seen = new Set<string>()): ReactNode {
    return items.filter(a => (a.parentId || null) === parentId || (parentId === null && !!a.parentId && !items.some(p => p.id === a.parentId))).filter(a => !seen.has(a.id)).map(agent => {
      const nextSeen = new Set(seen).add(agent.id)
      const providerId = agent.providerId || currentRun?.providerId
      const modelLabel = `${providers.find(provider => provider.id === providerId)?.name || providerId || 'Провайдер не указан'} · ${agent.model || 'Модель: авто (ещё не определена)'}`
      return <div key={agent.id}><button className={`agent-row ${selected?.id === agent.id ? 'selected' : ''}`} style={{ paddingLeft: 14 + Math.min(depth, 8) * 16 }} onClick={() => setSelectedAgent(agent.id)}><span className={`status-dot ${agent.status}`} /><span className="agent-row-label"><strong>{agent.name || agent.id}</strong><small title={modelLabel}>{modelLabel}</small>{agent.role && <small>{agent.role}</small>}{!!agent.files && agent.files.wrote.length + agent.files.read.length > 0 && <small>Файлы: изменил {agent.files.wrote.length}, читал {agent.files.read.length}</small>}{!!agent.handovers?.length && <small className="handover-badge" title={agent.handovers.map(item => `${handoverLabel(providers, item.from)} → ${handoverLabel(providers, item.to)}`).join('\n')}>⇄ Сменил подписку: {agent.handovers.length}</small>}</span><span className="agent-state">{statusText(agent.status)}</span></button>{agentTree(items, agent.id, depth + 1, nextSeen)}</div>
    })
  }

  return <div className={`app-shell ${agentsOpen ? 'with-agents' : ''}`}>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="Закрыть меню" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'mobile-open' : ''}`}>
      <div className="brand"><span className="brand-mark"><span /></span><span>orbit<span className="brand-dot">.</span></span><span className="brand-caption">workspace</span></div>
      <div className="project-picker">
        <button className="project-button" aria-expanded={projectMenu} onClick={() => setProjectMenu(!projectMenu)}><span className="project-initial">{project?.workspace.name?.[0]?.toUpperCase() || <Icon name="folder" />}</span><span><strong>{project?.workspace.name || 'Выберите проект'}</strong><small>{project?.workspace.connected ? project.workspace.branch || 'Git-репозиторий' : project ? 'Локальная папка' : 'Ваше рабочее пространство'}</small></span><Icon name="chevron" size={15} /></button>
        {projectMenu && <><button className="dropdown-dismiss" aria-label="Закрыть список проектов" onClick={() => setProjectMenu(false)} /><div className="project-dropdown"><div className="eyebrow">ПРОЕКТЫ</div>{state.projects.map(p => <button key={p.id} onClick={() => { setState(previous => ({ ...previous, activeProjectId: p.id })); setProjectMenu(false) }}><Icon name="folder" /><span><strong>{p.workspace.name}</strong><small title={p.workspace.path}>{p.workspace.path}</small></span>{p.id === project?.id && <Icon name="check" size={14} />}</button>)}<button className="add-project-row" onClick={() => { setPanel('add'); setProjectMenu(false) }}><Icon name="plus" />Добавить проект</button></div></>}
      </div>
      {project && <button type="button" className={`project-memory-toggle memory-toggle ${globalMemoryEnabled ? 'enabled' : ''}`} aria-label="Использовать общую память" aria-pressed={globalMemoryEnabled} disabled={!ready} title="Общая память для этого проекта. Проектная память доступна всегда. Изменение применяется к новым задачам." onClick={() => setGlobalMemory(!globalMemoryEnabled)}><Icon name="memory" size={14} /><span>Общая память</span><strong>{globalMemoryEnabled ? 'Вкл' : 'Выкл'}</strong></button>}
      {project && desktop && <button type="button" className="project-index-row" disabled={indexBusy} title="Локальный индекс проекта: пути, символы, импорты. Агенты ищут по нему командой index_search вместо чтения папок. Нажмите, чтобы переиндексировать." onClick={() => void rebuildIndex()}><Icon name="index" size={14} /><span>{indexBusy || indexInfo?.indexing ? 'Индексируем…' : indexInfo ? `Индекс: ${plural(indexInfo.files, ['файл', 'файла', 'файлов'])}` : 'Индекс проекта'}</span><Icon name="refresh" size={13} /></button>}
      <button className="new-chat" onClick={project ? createChat : () => setPanel('add')}><Icon name="plus" />{project ? 'Новый чат' : 'Добавить проект'}<kbd>＋</kbd></button>
      <div className="section-label">ЧАТЫ ПРОЕКТА <span>{project?.chats.length || ''}</span></div>
      <nav className="chat-list" aria-label="Чаты проекта">{project?.chats.map(c => {
        const isRunning = Object.values(runs).some(r => r.projectId === project.id && r.chatId === c.id && active(r.status)) || pending.has(`${project.id}/${c.id}`)
        return <div key={c.id} className="chat-row"><button className={`chat-item ${c.id === chat?.id ? 'active' : ''}`} onClick={() => { setState(previous => ({ ...previous, projects: previous.projects.map(p => p.id === project.id ? { ...p, activeChatId: c.id } : p) })); setSidebarOpen(false) }}><Icon name="chat" size={16} /><span>{c.title}</span>{isRunning && <span className="status-dot working" />}</button><button className="chat-delete" aria-label={`Удалить чат «${c.title}»`} title={isRunning ? 'Сначала остановите агентов' : 'Удалить чат'} disabled={isRunning || !ready} onClick={() => deleteChat(c.id)}><Icon name="trash" size={14} /></button></div>
      })}{!project && <p className="sidebar-empty">Подключите папку или репозиторий, чтобы начать.</p>}</nav>
      <div className="sidebar-bottom"><button onClick={() => setPanel('memory')}><Icon name="memory" />Память</button><button onClick={() => setPanel('capabilities')}><Icon name="skill" />Навыки</button><button onClick={() => setPanel('quota')} title="Остаток квот всех подписок и автозамена агентов"><Icon name="gauge" />Квоты<span className={`status-dot ${quotaDot}`} /></button><button onClick={() => setPanel('settings')}><Icon name="settings" />Настройки<span className={`status-dot ${currentHealth?.available ? 'done' : 'idle'}`} /></button><div className="local-label"><span className="status-dot idle" />{desktop ? 'История хранится на устройстве' : 'Предпросмотр интерфейса'}</div></div>
    </aside>

    <main className="main-pane">
      <header className="chat-header"><button className="icon-button mobile-menu" title="Открыть меню" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><div className="chat-heading"><span>{project?.workspace.name || 'Ваше пространство'}</span><span className="header-slash">/</span><strong>{chat?.title || 'Начало работы'}</strong></div><button className={`agents-toggle ${agentsOpen ? 'active' : ''}`} onClick={() => setAgentsOpen(!agentsOpen)} aria-expanded={agentsOpen}><Icon name="agents" size={17} /><span>Агенты</span>{!!currentRun?.agents.length && <b>{currentRun.agents.length}</b>}</button></header>
      {!desktop && <div className="preview-banner"><Icon name="terminal" size={16} /><span>Предпросмотр. Подключение проектов и работа агентов доступны в настольном Orbit.</span></div>}
      {(storageError || runtimeStorageError) && <div className="error-banner" role="alert">{storageError || runtimeStorageError}</div>}
      {!!otherActiveChats && <div className="parallel-chat-notice" role="status">Других активных чатов в проекте: {otherActiveChats}. Файлы общие — поручайте изменения разных участков.</div>}
      <div className="conversation" onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100 }}>
        {!chat?.messages.length ? <div className="welcome"><div className="welcome-symbol"><span className="brand-mark"><span /></span></div><div className="eyebrow">{project ? 'ПРОСТРАНСТВО ДЛЯ ВАШИХ ИДЕЙ' : 'ОДИН АГЕНТ. ВАШИ ПРОЕКТЫ.'}</div><h1>{project ? 'Над чем поработаем?' : 'Начните с проекта.'}</h1><p>{project ? 'Обсудите идею, задайте вопрос или поручите задачу. Агент сам выберет подход и подключит помощников, когда это полезно.' : 'Подключите локальную папку или Git-репозиторий. Чаты, память и работа агентов останутся в контексте проекта.'}</p>{project ? <div className="prompt-suggestions">{['Помоги разобраться в проекте', 'Давай обсудим новую функцию', 'Найди, что можно улучшить'].map(text => <button key={text} disabled={!desktop} onClick={() => setDrafts(previous => ({ ...previous, [chatKey]: text }))}>{text}<Icon name="arrow" size={14} /></button>)}</div> : <button className="primary-button" onClick={() => setPanel('add')}><Icon name="plus" />Подключить проект</button>}<div className="welcome-footnote">Отдельные чаты · Общая и проектная память · Агенты по задаче</div></div> : <div className="message-list">{chat.messages.map(message => <article key={message.id} className={`message ${message.author}`}><div className="message-avatar">{message.author === 'user' ? 'В' : message.author === 'system' ? '!' : <span className="tiny-orbit" />}</div><div className="message-content"><div className="message-meta"><strong>{message.author === 'user' ? 'Вы' : message.author === 'system' ? 'Система' : 'Orbit'}</strong>{message.model && <span>{message.model}</span>}<time>{timeOf(message.time)}</time></div><Markdown text={message.text} />{message.runId && historyAnchor.get(message.runId) === message.id && <><TeamStrip run={runs[message.runId]} onOpen={openTeam} /><RunHistory run={runs[message.runId]} loaded={ready} onOpen={openTeam} /></>}</div></article>)}{running && <div className="working-indicator"><span className="status-dot working" /><span>{pending.has(chatKey) && !workingRun ? 'Запускаем агента…' : 'Агент работает'}</span><button onClick={() => workingRun ? openTeam(workingRun.runId) : setAgentsOpen(true)}>Посмотреть действия <Icon name="agents" size={14} /></button></div>}{currentRun && !running && ['failed', 'error', 'cancelled', 'interrupted'].includes(currentRun.status) && <div className={`run-notice ${currentRun.status}`}><span className={`status-dot ${currentRun.status}`} /><span>{statusText(currentRun.status)}{currentRun.error ? `: ${currentRun.error}` : currentRun.status === 'interrupted' ? '. Приложение закрылось во время работы. Можно продолжить новым сообщением.' : ''}</span><button onClick={() => setAgentsOpen(true)}>Подробности</button></div>}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer-area"><label className="improvement-toggle"><input type="checkbox" checked={!!state.settings.improvementMode} onChange={event => updateSettings({ improvementMode: event.target.checked })} />Бесконечное улучшение{running && <small> · для следующей задачи</small>}</label><form className={`composer ${running ? 'is-running' : ''}`} onSubmit={send}><textarea aria-label="Сообщение агенту" placeholder={!project ? 'Сначала подключите проект' : running ? 'Можно подготовить следующее сообщение…' : 'Напишите агенту…'} value={draft} disabled={!desktop || !project || !chat || !ready} onChange={event => setDrafts(previous => ({ ...previous, [chatKey]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running) void send() } }} rows={2} /><div className="composer-toolbar"><div className="composer-options"><select aria-label="Провайдер" value={state.settings.providerId} onChange={event => updateSettings({ providerId: event.target.value })}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ModelPicker key={state.settings.providerId} value={state.settings.models[state.settings.providerId] || ''} models={modelChoices} onChange={model => updateSettings({ models: { ...state.settings.models, [state.settings.providerId]: model } })} /><ReasoningPicker providerId={state.settings.providerId} model={state.settings.models[state.settings.providerId] || ''} health={currentHealth} value={selectedEffort} onChange={reasoningEffort => updateSettings({ providerOptions: { ...state.settings.providerOptions, [state.settings.providerId]: { ...state.settings.providerOptions?.[state.settings.providerId], reasoningEffort } } })} /><select aria-label="Уровень доступа" title="Доступ наследуется всеми агентами задачи" value={accessChoice} onChange={event => chooseAccess(event.target.value)}><option value="ask">Ask — спрашивать</option><option value="danger-full-access">Full access</option><option value="workspace-write">Только проект</option><option value="read-only">Только чтение</option></select></div>{running ? <button type="button" className="send-button stop-button" aria-label="Остановить агентов" disabled={!workingRun} onClick={() => void stop()}><Icon name="stop" /></button> : <button className="send-button" type="submit" aria-label="Отправить сообщение" disabled={!draft.trim() || !desktop || !project || !chat || !ready}><Icon name="arrow" /></button>}</div></form><div className="composer-caption"><span>{!ready ? 'Восстанавливаем историю…' : currentHealth && !currentHealth.available ? `${providers.find(p => p.id === currentHealth.id)?.name}: ${currentHealth.detail}` : state.settings.models[state.settings.providerId] || 'Модель по настройкам провайдера'} <QuotaChip name={providers.find(p => p.id === state.settings.providerId)?.name || ''} snapshot={quotas[state.settings.providerId]} model={state.settings.models[state.settings.providerId] || ''} onOpen={() => setPanel('quota')} /></span><span>Enter — отправить · Shift + Enter — новая строка</span></div></div>
    </main>

    {agentsOpen && <aside className="agents-panel">
      <header><div><Icon name="agents" /><strong>Агенты</strong></div><button className="icon-button" aria-label="Закрыть панель агентов" onClick={() => setAgentsOpen(false)}><Icon name="close" /></button></header>
      {chatRuns.length > 1 && <RunHistoryList runs={[...chatRuns].reverse()} currentId={currentRun?.runId} onPick={pickRun} />}
      {chatRuns.length > 1 && currentRun && chatRuns.at(-1)!.runId !== currentRun.runId && active(chatRuns.at(-1)!.status) && <button type="button" className="history-follow" onClick={() => pickRun(chatRuns.at(-1)!.runId)}><span className="status-dot working" />Идёт новый запуск — перейти</button>}
      {!currentRun?.agents.length ? <div className="panel-empty"><Icon name="agents" size={34} /><h3>Команда появится здесь</h3><p>После отправки сообщения здесь будут реальные агенты, их задачи и действия. Подагенты создаются по необходимости.</p></div> : <>
        <div className="run-summary"><span className={`status-dot ${currentRun.status}`} />{statusText(currentRun.status)}<span>{plural(currentRun.agents.length, ['агент', 'агента', 'агентов'])}</span></div>
        <div className="agent-tree">{agentTree(currentRun.agents)}{(currentRun.agents.length > 1 || !!currentRun.communications?.length) && <button className={`agent-row router-row ${selected?.id === 'router' ? 'selected' : ''}`} onClick={() => setSelectedAgent('router')}><span className={`status-dot ${routerAgent.status}`} /><span className="agent-row-label"><strong>{routerAgent.name}</strong><small>Адресует сообщения и следит за общими файлами</small></span><span className="agent-state">{(currentRun.router?.routed ?? 0) + (currentRun.router?.notices ?? 0)}</span></button>}</div>
        {selected && <AgentInspector key={inspectorRequest?.runId === currentRun.runId ? `${currentRun.runId}:${inspectorRequest.seq}` : currentRun.runId} run={currentRun} agent={selected} onSelect={setSelectedAgent} quotas={quotas} initialTab={inspectorRequest?.runId === currentRun.runId ? inspectorRequest.tab : undefined} />}
      </>}
    </aside>}

    {panel && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null) }}><section className={`modal ${panel === 'add' ? 'compact-modal' : ''}`} role="dialog" aria-modal="true" aria-label={{ settings: 'Настройки', memory: 'Память', capabilities: 'Навыки', add: 'Добавить проект', quota: 'Квоты' }[panel]}><header className="modal-header"><div><div className="eyebrow">ORBIT WORKSPACE</div><h2>{{ settings: 'Настройки', memory: 'Память', capabilities: 'Навыки', add: 'Добавить проект', quota: 'Квоты' }[panel]}</h2></div><button className="icon-button" aria-label="Закрыть" onClick={() => setPanel(null)}><Icon name="close" /></button></header><div className="modal-content">
      {panel === 'quota' && (desktop ? <QuotaPanel providers={providers} connected={connected} quotas={quotas} busy={quotaBusy} onRefresh={() => void refreshQuotas(true)} failover={state.settings.quotaFailover!} onFailover={patch => updateSettings({ quotaFailover: { ...state.settings.quotaFailover!, ...patch } })} agents={currentRun?.agents || []} currentProviderId={state.settings.providerId} /> : <p className="inline-notice">Квоты подписок доступны в настольном приложении.</p>)}
      {panel === 'add' && <><p className="modal-intro">Каждый проект — отдельное пространство для чатов и памяти.</p>{!desktop && <p className="inline-notice">Откройте настольное приложение Orbit, чтобы подключить проект.</p>}<button className="local-project-option" disabled={!desktop || projectBusy} onClick={() => void addProject('local')}><span className="option-icon"><Icon name="folder" size={25} /></span><span><strong>Открыть локальную папку</strong><small>Работает и без Git</small></span><Icon name="plus" /></button><div className="divider-label">или клонировать репозиторий</div><form onSubmit={event => { event.preventDefault(); if (remote.trim()) void addProject('git') }}><label>URL репозитория<input autoFocus placeholder="https://github.com/owner/project.git" value={remote} onChange={event => setRemote(event.target.value)} disabled={!desktop || projectBusy} /></label><button className="primary-button full-width" disabled={!desktop || projectBusy || !remote.trim()}><Icon name="git" />{projectBusy ? 'Подключаем проект…' : 'Клонировать и открыть'}</button><p className="field-hint">Orbit предложит выбрать папку для клонирования.</p></form></>}
      {panel === 'settings' && <><p className="modal-intro">Агент использует выбранный провайдер. Подключения и авторизация CLI берутся из вашего окружения.</p><div className="settings-section-heading"><h3>Провайдеры</h3><button className="text-button" disabled={!desktop || checking} onClick={() => void refreshProviders()}><Icon name="refresh" size={14} />{checking ? 'Проверяем…' : 'Проверить'}</button></div><div className="provider-list">{providers.map(provider => { const status = health.find(p => p.id === provider.id); return <button key={provider.id} className={`provider-card ${state.settings.providerId === provider.id ? 'selected' : ''}`} onClick={() => updateSettings({ providerId: provider.id })}><div className="provider-monogram">{provider.name[0]}</div><span><strong>{provider.name}</strong><small>{status?.detail || provider.description}</small></span><span className={`provider-badge ${status?.available ? 'available' : ''}`}>{status ? status.available ? 'Доступен' : 'Не подключён' : 'Не проверен'}</span></button> })}</div><p className="field-hint">{providers.find(p => p.id === state.settings.providerId)?.help}</p><div className="settings-model"><span>Модель</span><ModelPicker key={state.settings.providerId} label="Модель в настройках" value={state.settings.models[state.settings.providerId] || ''} models={modelChoices} onChange={model => updateSettings({ models: { ...state.settings.models, [state.settings.providerId]: model } })} /><p className="field-hint">Выбор сохраняется отдельно для каждого провайдера и применяется к следующим сообщениям. Если модели нет в списке, укажите её идентификатор.</p></div><label>Ваши инструкции агенту<textarea rows={4} placeholder="Предпочтения в работе, языке и проверке результатов…" value={state.settings.agentInstructions} onChange={event => updateSettings({ agentInstructions: event.target.value })} /></label><details className="advanced-settings"><summary>Доступ и ограничения роя</summary><label>Доступ для всех агентов<select value={accessChoice} onChange={event => chooseAccess(event.target.value)}><option value="ask">Ask — спрашивать разрешение</option><option value="danger-full-access">Full access — полный доступ</option><option value="workspace-write">Только проект</option><option value="read-only">Только чтение</option></select></label><p className="field-hint">Выбранный доступ и уровень мышления применяются к новым задачам и наследуются подагентами. В режиме Ask запросы разрешения показываются в отдельном окне.</p><SwarmSettings settings={state.settings} update={updateSettings} providers={providers} health={health} /></details><p className="autosave-label"><Icon name="check" size={14} />Настройки сохраняются автоматически</p></>}
      {panel === 'memory' && <MemoryPanel desktop={desktop} project={project} chat={chat} entries={memory} stats={libraryStats} loading={loadingLibrary} onChanged={() => setLibraryRevision(n => n + 1)} onError={setNotice} />}
      {panel === 'capabilities' && <SkillsPanel desktop={desktop} workspace={project?.workspace.path || ''} skills={capabilities} stats={libraryStats} loading={loadingLibrary} onChanged={() => setLibraryRevision(n => n + 1)} onError={setNotice} />}
    </div></section></div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><Icon name="close" size={15} /></button></div>}
  </div>
}

function TeamStrip({ run, onOpen }: { run?: RunSnapshot; onOpen: (runId: string, tab?: InspectorTab) => void }) {
  const helpers = (run?.agents || []).filter(agent => agent.id !== 'root')
  const changed = runChangedFiles(run)
  if (!run || (!helpers.length && !changed)) return null
  return <div className="team-strip">
    {!!helpers.length && <button type="button" className="team-strip-open" onClick={() => onOpen(run.runId)} title="Открыть команду этого запуска: действия, переписку и файлы">
      <span className="team-strip-title"><Icon name="agents" size={13} />Команда · {helpers.length}</span>
      {helpers.slice(0, 5).map(agent => <span key={agent.id} className="team-chip"><span className={`status-dot ${agent.status}`} />{agent.name}</span>)}
      {helpers.length > 5 && <span className="team-chip more">+{helpers.length - 5}</span>}
    </button>}
    {!!changed && <button type="button" className="team-files" onClick={() => onOpen(run.runId, 'changes')} title="Открыть изменения этого запуска">{plural(changed, ['файл изменён', 'файла изменено', 'файлов изменено'])}</button>}
  </div>
}

function FileChips({ label, files }: { label: string; files: string[] }) {
  if (!files.length) return null
  return <div className="file-group"><span className="file-group-label">{label}</span><div className="file-pills">{files.slice(0, 12).map(file => <code key={file} title={file}>{file}</code>)}{files.length > 12 && <span className="file-more">+{files.length - 12}</span>}</div></div>
}

function AgentInspector({ run, agent, onSelect, quotas, initialTab }: { run: RunSnapshot; agent: Agent; onSelect: (id: string) => void; quotas: Record<string, QuotaSnapshot>; initialTab?: InspectorTab }) {
  const [tab, setTab] = useState<InspectorTab>(initialTab || 'activity')
  const [focusPath, setFocusPath] = useState<string | undefined>()
  // Opened from a run's «файлов изменено» button: the changes of the whole team, for the agent first shown.
  const [teamWide, setTeamWide] = useState(initialTab === 'changes')
  const firstAgent = useRef(agent.id)
  const [onlySelected, setOnlySelected] = useState(false)
  const pickTab = (next: InspectorTab) => { setFocusPath(undefined); setTeamWide(false); setTab(next) }
  const changedPaths = useMemo(() => new Set((run.changes || []).map(change => change.path)).size, [run.changes])
  const isRouter = agent.id === 'router'
  const allMessages = run.communications || []
  const routed = (message: Communication) => message.kind === 'notice' || (message.via === 'router' && !!message.route && message.route.via !== 'direct')
  const communications = onlySelected ? allMessages.filter(message => isRouter ? routed(message) : message.fromAgentId === agent.id || message.toAgentId === agent.id) : allMessages
  const traces = run.traces.filter(trace => (trace.agentId || 'root') === agent.id)
  const replies = run.messages.filter(message => (message.agentId || 'root') === agent.id)
  // Live events replace `run` many times a second; the file map only changes with the agents' file lists.
  const touched = useMemo(() => fileMap(run.agents).length, [run.agents])
  return <div className="agent-inspector-shell">
    <nav className="inspector-tabs" aria-label="Сведения об агентах">
      <button className={tab === 'activity' ? 'active' : ''} aria-pressed={tab === 'activity'} onClick={() => pickTab('activity')}>Действия</button>
      <button className={`communication-tab ${tab === 'communications' ? 'active' : ''}`} aria-label="Переписка" aria-pressed={tab === 'communications'} onClick={() => pickTab('communications')}>Переписка{!!allMessages.length && <span>{allMessages.length}</span>}</button>
      <button className={`communication-tab ${tab === 'files' ? 'active' : ''}`} aria-label="Файлы" aria-pressed={tab === 'files'} onClick={() => pickTab('files')}>Файлы{!!touched && <span>{touched}</span>}</button>
      <button className={`communication-tab ${tab === 'changes' ? 'active' : ''}`} aria-label="Изменения" aria-pressed={tab === 'changes'} onClick={() => pickTab('changes')}>Изменения{!!changedPaths && <span>{changedPaths}</span>}</button>
      <button className={tab === 'graph' ? 'active' : ''} aria-label="Граф агентов" aria-pressed={tab === 'graph'} onClick={() => pickTab('graph')}>Граф</button>
    </nav>
    <div className="agent-inspector">
    {tab === 'activity' && isRouter ? <>
      <div className="inspector-heading"><div className="eyebrow">СИСТЕМНЫЙ УЧАСТНИК</div><h3>{agent.name}</h3><span>Работает без модели: не тратит ходы и не может зациклиться</span></div>
      <div className="agent-task">Все сообщения между агентами проходят здесь. Маршрутизатор находит адресата по файлам и теме, сообщает агентам, что кто-то изменил файл, который они читали, и закрывает обсуждение, в котором никто ничего не делает.</div>
      <p className="agent-budget">Доставлено адресно: {run.router?.routed ?? 0} · Уведомлений об изменениях: {run.router?.notices ?? 0} · Остановлено повторов и споров: {run.router?.refused ?? 0}</p>
      <div className="section-label">РЕШЕНИЯ МАРШРУТИЗАТОРА</div>
      <div className="agent-events">
        {traces.map(trace => <details className="trace-item" key={trace.id}><summary><span className="trace-kind message" /><span>{trace.text.slice(0, 120)}</span><time>{timeOf(trace.time)}</time></summary><pre>{trace.text}</pre></details>)}
        {!traces.length && <p className="muted">Адресных обращений пока не было. Уведомления об изменённых файлах смотрите во вкладке «Переписка».</p>}
      </div>
    </> : tab === 'activity' ? <>
      <div className="inspector-heading"><div className="eyebrow">{agent.parentId ? 'ПОДАГЕНТ' : 'ОСНОВНОЙ АГЕНТ'}</div><h3>{agent.name}</h3><span>{providers.find(provider => provider.id === agent.providerId)?.name || agent.providerId || run.providerId}{agent.model ? ` · ${agent.model}` : ''}{agent.reasoningEffort ? ` · Рассуждения: ${effortLabels[agent.reasoningEffort] || agent.reasoningEffort}` : ''}{agent.generation ? ` · Продолжение ${agent.generation}` : ''}</span></div>
      {agent.task && <div className="agent-task">{agent.task}</div>}
      {agent.reason && <p className="agent-reason">{agent.reason}</p>}
      <p className="agent-budget">{agent.parentId ? `Ходы: ${agent.turns || 0} / ${run.limits?.maxTurns ?? '∞'}` : `Ходы: ${agent.turns || 0} · без ограничения`}{agent.budgetLimited && (agent.stalled ? ' · Остановлен: повторял одни и те же вызовы, результаты сохранены' : ' · Лимит достигнут, результаты сохранены')}</p>
      {run.usage && <p className="agent-budget">Работают: {run.agents.filter(member => member.status === 'working').length} · Ходы помощников: {run.usage.workerTurns ?? '—'} / {run.limits?.maxTotalTurns ?? '∞'}</p>}
      {(() => {
        const windows = windowsFor(quotas[agent.providerId || run.providerId || ''], agent.model || '')
        return !!windows.length && <p className="agent-budget">Квота {providers.find(provider => provider.id === (agent.providerId || run.providerId))?.name}: {windows.map(window => `${windowName(window)} — осталось ${Math.max(0, 100 - usedNow(window, Date.now()))}%`).join(' · ')}</p>
      })()}
      {!!agent.handovers?.length && <div className="handover-list"><div className="section-label">СМЕНА ПОДПИСКИ</div>{agent.handovers.map(item => <details className="trace-item" key={item.id}><summary><span className="trace-kind handover" /><span>{handoverLabel(providers, item.from)} → {handoverLabel(providers, item.to)}</span><time>{timeOf(item.time)}</time></summary><pre>{`Причина: ${handoverReason(item)}${item.resetsAt ? `\nЛимит снимется: ${new Date(item.resetsAt).toLocaleString('ru-RU')}` : ''}${item.fresh && !item.interrupted ? '\nАгент ещё ничего не сделал: работа началась на новой подписке.' : `\n\nЧто получила новая модель:\n${item.note || ''}`}`}</pre></details>)}</div>}
      {!!(agent.files?.wrote.length || agent.files?.read.length) && <div className="agent-files-summary"><FileChips label="Изменил" files={agent.files?.wrote || []} /><FileChips label="Читал" files={agent.files?.read || []} /></div>}
      {agent.id === 'root' && !!run.improvements?.length && <div className="improvement-progress"><strong>Улучшения: {run.improvements.filter(task => task.status === 'done').length} / {run.improvements.length}</strong>{run.improvements.map(task => <details key={task.id}><summary>{({ pending: '○', working: '◐', done: '✓', blocked: '!' })[task.status]} {task.title}</summary><p>{task.evidence || 'Ожидает выполнения'}</p></details>)}</div>}
      <div className="section-label">ДЕЙСТВИЯ И РЕЗУЛЬТАТЫ</div>
      <div className="agent-events">
        {traces.map(trace => ['output', 'assistant_update'].includes(trace.kind)
          ? <div className="agent-output" key={trace.id}><div className="eyebrow">СООБЩЕНИЕ · {timeOf(trace.time)}</div><Markdown text={assistantOutput(trace.text)} /></div>
          : <details className="trace-item" key={trace.id}><summary><span className={`trace-kind ${trace.kind}`} /><span>{trace.text.slice(0, 120) || trace.kind}</span><time>{timeOf(trace.time)}</time></summary><pre>{trace.text}</pre></details>)}
        {replies.map(message => <div className="agent-output" key={message.id}><div className="eyebrow">ОТВЕТ · {timeOf(message.time)}</div><Markdown text={message.text} /></div>)}
        {!traces.length && !replies.length && <p className="muted">{agent.detail || 'Событий пока нет.'}</p>}
      </div>
    </> : tab === 'graph' ? <AgentGraph agents={run.agents} selectedId={agent.id} onSelect={onSelect} /> : tab === 'files' ? <FilesTab key={agent.id} run={run} agent={agent} onSelect={onSelect} onOpenChanges={path => { setFocusPath(path); setTab('changes') }} /> : tab === 'changes' ? <ChangesTab key={agent.id} run={run} agent={agent} onSelect={onSelect} focusPath={focusPath} teamWide={teamWide && agent.id === firstAgent.current} /> : <div className="agent-communications">
      <div className="communications-heading"><h3>{onlySelected ? agent.name : 'Вся команда'}</h3><p>Сообщения между агентами этого запуска. Каждое проходит через маршрутизатор; он же сообщает об изменениях общих файлов.</p></div>
      <label className="communications-filter"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} /><span>{isRouter ? 'Только решения маршрутизатора: подбор адресата и уведомления' : `Только с участием ${agent.name}`}</span></label>
      {!communications.length ? <div className="communications-empty"><Icon name="chat" size={26} /><p>{onlySelected ? 'У этого агента пока нет переписки.' : 'Агенты ещё не обменивались сообщениями.'}</p></div> : communications.map(message => <article className={`communication-item ${message.kind === 'notice' ? 'notice' : ''} ${message.conflict ? 'conflict' : ''}`} key={message.id}>
        <div className="communication-kind">{message.kind === 'notice' ? (message.conflict ? 'Маршрутизатор · конфликт правок' : 'Маршрутизатор · файл изменён другим агентом') : message.kind === 'spawn' ? 'Создание агента · исходная задача' : message.kind === 'followup' ? 'Новая задача существующему агенту' : message.route && message.route.via !== 'direct' ? (message.replyTo ? 'Ответ в обсуждении · через маршрутизатор' : 'Адресовано маршрутизатором') : message.discussionId ? 'Сообщение группе' : message.replyTo ? 'Ответ в обсуждении' : 'Сообщение'}</div>
        <div className="communication-route"><strong title={message.fromAgentId}>{message.fromAgentName || message.fromAgentId}</strong><span aria-label="пишет">→</span><strong title={message.toAgentId}>{message.toAgentName || message.toAgentId}</strong></div>
        {message.reason && <p className="agent-reason">{message.reason}</p>}
        {message.via === 'router' && message.route && message.route.via !== 'direct' && <p className="agent-reason route-reason">Маршрутизатор: {routeLabel[message.route.via] || message.route.via}{message.route.reasons.length ? ` · ${message.route.reasons.join('; ')}` : ''}</p>}
        {message.replyTo && <blockquote className="communication-reply">{allMessages.find(item => item.id === message.replyTo)?.text.slice(0, 160) || 'Ответ на более раннее сообщение'}</blockquote>}
        <Markdown text={message.text} />
        <div className="communication-meta"><time dateTime={message.time}>{timeOf(message.time)}</time><span className={`delivery-status ${message.status}`} title={message.readAt ? `Прочитано ${timeOf(message.readAt)}` : message.deliveredAt ? `Доставлено ${timeOf(message.deliveredAt)}` : 'Будет доступно агенту на следующем ходе'}>{{ queued: 'В очереди', delivered: 'Доставлено', read: 'Прочитано' }[message.status] || 'Отправлено'}</span></div>
      </article>)}
    </div>}
    </div>
  </div>
}

function LibraryForm({ kind, workspace, chatId, onSaved, onError }: { kind: 'memory' | 'capability'; workspace: string; chatId?: string; onSaved: () => void; onError: (message: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<MemoryScope>(workspace ? 'project' : 'global')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || !content.trim() || !window.orbit) return
    setBusy(true)
    try {
      if (kind === 'memory') await window.orbit.saveMemory({ id: uid(), title: title.trim(), content: content.trim(), type: 'fact', scope, workspace: scope === 'global' ? undefined : workspace, chatId: scope === 'chat' ? chatId : undefined, updated: now(), confidence: 100 })
      else await window.orbit.installCapability({ name: title.trim(), description: content.trim().split('\n')[0].slice(0, 200), instructions: content.trim(), scope: scope === 'global' ? 'global' : 'project', workspace: scope === 'global' ? undefined : workspace, source: 'user' })
      setTitle(''); setContent(''); setExpanded(false); onSaved()
    } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="library-form">{!expanded ? <button className="secondary-button" onClick={() => setExpanded(true)}><Icon name="plus" size={16} />{kind === 'memory' ? 'Добавить запись' : 'Добавить навык'}</button> : <form onSubmit={submit}><label>Название<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} /></label><label>{kind === 'memory' ? 'Что нужно запомнить' : 'Инструкции навыка'}<textarea rows={4} value={content} onChange={event => setContent(event.target.value)} required /></label><div className="form-actions"><select aria-label="Область действия" value={scope} onChange={event => setScope(event.target.value as MemoryScope)}>{kind === 'memory' && <option value="chat" disabled={!workspace || !chatId}>Только этот чат</option>}<option value="project" disabled={!workspace}>Только этот проект</option><option value="global">Все проекты</option></select><button type="button" className="text-button" onClick={() => setExpanded(false)}>Отмена</button><button className="primary-button" disabled={busy || !title.trim() || !content.trim()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div></form>}</div>
}

function CapabilityCard({ entry, workspace, onSaved, onError }: { entry: Capability; workspace: string; onSaved: () => void; onError: (message: string) => void }) {
  const [detail, setDetail] = useState<Capability | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [revision, setRevision] = useState('')
  async function load() {
    if (detail || busy || !window.orbit) return
    setBusy(true)
    try { const loaded = await window.orbit.readCapability(entry.id, workspace); setDetail(loaded); setInstructions(loaded.instructions) }
    catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  async function mutate(action: 'save' | 'restore' | 'remove') {
    if (!window.orbit || busy) return
    setBusy(true)
    try {
      if (action === 'remove') await window.orbit.removeCapability(entry.id, workspace)
      else if (action === 'restore') await window.orbit.restoreCapability(entry.id, Number(revision), workspace)
      else if (detail) await window.orbit.installCapability({ ...detail, instructions: instructions.trim(), source: 'user' })
      onSaved()
    } catch (error) { onError(errorText(error)) }
    finally { setBusy(false) }
  }
  return <article className={`library-entry ${entry.pinned ? 'pinned' : ''}`}><div><strong>{entry.name}</strong><span className="scope-label">{entry.pinned ? 'закреплён · ' : ''}{entry.scope === 'global' ? 'Общий' : 'Проект'}{entry.version ? ` · v${entry.version}` : ''}</span><button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={`${entry.pinned ? 'Открепить' : 'Закрепить'} навык ${entry.name}`} onClick={() => { setBusy(true); window.orbit?.pinCapability(entry.id, !entry.pinned, workspace).then(onSaved).catch(error => onError(errorText(error))).finally(() => setBusy(false)) }}><Icon name="pin" size={14} /></button><button className="icon-button" disabled={busy} aria-label={`Удалить навык ${entry.name}`} onClick={() => void mutate('remove')}><Icon name="trash" size={15} /></button></div><p>{entry.description}</p>{entry.whenToUse && <p className="skill-when">Когда применять: {entry.whenToUse}</p>}<small className="entry-meta">{entry.uses ? `Применялся: ${entry.uses} · успешно ${Math.round((entry.reliability ?? 0.5) * 100)}%` : 'Ещё не применялся'}{entry.scope === 'global' && entry.usedIn?.length ? ` · проектов: ${entry.usedIn.length}` : ''}</small>{!!entry.lessons?.length && <ul className="skill-pitfalls" aria-label="Подводные камни">{entry.lessons.slice(0, 3).map(lesson => <li key={lesson}>{lesson}</li>)}</ul>}<details onToggle={event => { if (event.currentTarget.open) void load() }}><summary>Инструкции и версии</summary>{busy && !detail ? <p className="muted">Загружаем…</p> : detail && <><div className="capability-provenance">{detail.source === 'user' ? 'Добавлен пользователем' : `Источник: ${detail.source || 'агент'}`}{detail.editedBy ? ' · улучшен агентом' : ''}{detail.updatedAt ? ` · ${new Date(detail.updatedAt).toLocaleString('ru-RU')}` : ''}</div>{editing ? <><textarea aria-label="Инструкции навыка" rows={8} value={instructions} onChange={event => setInstructions(event.target.value)} /><div className="capability-actions"><button className="text-button" onClick={() => { setEditing(false); setInstructions(detail.instructions) }}>Отмена</button><button className="secondary-button" disabled={busy || !instructions.trim()} onClick={() => void mutate('save')}>Сохранить новую версию</button></div></> : <><Markdown text={detail.instructions} /><button className="text-button" onClick={() => setEditing(true)}>Редактировать</button></>}{!!detail.revisions?.length && <div className="revision-controls"><select aria-label="Предыдущая версия навыка" value={revision} onChange={event => setRevision(event.target.value)}><option value="">Предыдущие версии</option>{[...detail.revisions].reverse().map(item => <option key={item.version} value={item.version}>v{item.version} · {new Date(item.updatedAt).toLocaleDateString('ru-RU')}</option>)}</select><button className="text-button" disabled={busy || !revision} onClick={() => void mutate('restore')}>Восстановить</button></div>}</>}{!busy && !detail && <button className="text-button" onClick={() => void load()}>Повторить загрузку</button>}</details></article>
}

const TIER_NAMES: Record<MemoryScope, string> = { chat: 'Чат', project: 'Проект', global: 'Общая' }
function TierBar({ items }: { items: { name: string; stat?: TierStats; text?: string }[] }) {
  return <div className="tier-stats" role="status">{items.map(item => <span key={item.name} className={item.stat && item.stat.count >= item.stat.limit ? 'full' : ''}><strong>{item.name}</strong> {item.text ?? `${item.stat?.count ?? 0}/${item.stat?.limit ?? 0}`}</span>)}</div>
}
function sourceLabel(source?: string) { return source === 'user' ? 'вы' : source === 'promoted' ? 'поднято автоматически' : source === 'system' ? 'система' : 'агент' }

function MemoryCard({ entry, workspace, chatId, onChanged, onError }: { entry: MemoryEntry; workspace: string; chatId?: string; onChanged: () => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  async function act(action: () => Promise<unknown>) {
    if (busy || !window.orbit) return
    setBusy(true)
    try { await action(); onChanged() } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  return <article className={`library-entry ${entry.pinned ? 'pinned' : ''}`}>
    <div><strong>{entry.title}</strong><span className="scope-label">{entry.pinned ? 'закреплено · ' : ''}{sourceLabel(entry.source)}</span>
      <button className="icon-button" disabled={busy} aria-pressed={!!entry.pinned} aria-label={`${entry.pinned ? 'Открепить' : 'Закрепить'} запись ${entry.title}`} onClick={() => void act(() => window.orbit!.pinMemory(entry.id, !entry.pinned, workspace, chatId))}><Icon name="pin" size={14} /></button>
      <button className="icon-button" disabled={busy} aria-label={`Удалить запись ${entry.title}`} onClick={() => void act(() => window.orbit!.removeMemory(entry.id, workspace, chatId))}><Icon name="trash" size={15} /></button></div>
    <p>{entry.content}</p>
    <small className="entry-meta">{entry.uses ? `Использована: ${entry.uses}` : 'Ещё не использовалась'} · {new Date(entry.updated).toLocaleDateString('ru-RU')}</small>
  </article>
}

function MemoryPanel({ desktop, project, chat, entries, stats, loading, onChanged, onError }: { desktop: boolean; project?: Project; chat?: ChatThread; entries: MemoryEntry[]; stats: LibraryStats | null; loading: boolean; onChanged: () => void; onError: (message: string) => void }) {
  const workspace = project?.workspace.path || ''
  if (!desktop) return <p className="inline-notice">Память доступна в настольном приложении.</p>
  const groupTitle: Record<MemoryScope, string> = { chat: `ЧАТ · ${chat?.title || 'НЕ ВЫБРАН'}`, project: `ПРОЕКТ · ${project?.workspace.name || 'НЕ ВЫБРАН'}`, global: 'ОБЩАЯ ПАМЯТЬ' }
  return <>
    <p className="modal-intro">Три уровня. <b>Чат</b> — рабочие заметки этой задачи. <b>Проект</b> — знания о коде, общие для всех его чатов. <b>Общая</b> — то, что верно во всех проектах. Записи, к которым агенты не возвращаются, устаревают и вытесняются сами; то, что чат использовал снова и снова, поднимается в проект. Детали проекта в общую память не попадают.</p>
    {stats && <TierBar items={(['chat', 'project', 'global'] as const).map(scope => ({ name: TIER_NAMES[scope], stat: stats.memory[scope] }))} />}
    <LibraryForm kind="memory" workspace={workspace} chatId={chat?.id} onSaved={onChanged} onError={onError} />
    {loading ? <p className="muted">Загружаем записи…</p> : entries.length ? (['chat', 'project', 'global'] as const).map(scope => {
      const group = entries.filter(entry => entry.scope === scope)
      if (!group.length && scope === 'chat') return null
      return <div key={scope} className="library-group"><div className="section-label">{groupTitle[scope]}<span>{group.length}</span></div>{group.map(entry => <MemoryCard key={entry.id} entry={entry} workspace={workspace} chatId={chat?.id} onChanged={onChanged} onError={onError} />)}</div>
    }) : <div className="empty-library"><Icon name="memory" size={28} /><p>Память пока пуста. Добавьте важный контекст или попросите агента его запомнить.</p></div>}
  </>
}

function SkillsPanel({ desktop, workspace, skills, stats, loading, onChanged, onError }: { desktop: boolean; workspace: string; skills: Capability[]; stats: LibraryStats | null; loading: boolean; onChanged: () => void; onError: (message: string) => void }) {
  if (!desktop) return <p className="inline-notice">Навыки доступны в настольном приложении.</p>
  const ordered = [...skills].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.uses ?? 0) - (a.uses ?? 0))
  return <>
    <p className="modal-intro">Навык — проверенная процедура, которой агент научился в работе, например поднять изолированное окружение. Агент находит подходящий навык по задаче, применяет его, оценивает результат и дописывает подводные камни, так что набор растёт и улучшается сам. Общие навыки доступны во всех проектах, проектные остаются в своём.</p>
    {stats && <TierBar items={[{ name: 'Проект', stat: stats.skills.project }, { name: 'Общие', stat: stats.skills.global }, { name: 'Применялись', text: String(stats.skills.used) }]} />}
    <LibraryForm kind="capability" workspace={workspace} onSaved={onChanged} onError={onError} />
    {loading ? <p className="muted">Загружаем навыки…</p> : ordered.length ? ordered.map(entry => <CapabilityCard key={`${entry.id}-${entry.version}-${entry.uses}-${entry.pinned}`} entry={entry} workspace={workspace} onSaved={onChanged} onError={onError} />) : <div className="empty-library"><Icon name="skill" size={28} /><p>Навыков пока нет. Агент создаёт их по мере работы, когда находит повторяемую процедуру; вы также можете добавить свой.</p></div>}
  </>
}
