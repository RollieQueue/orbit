import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Agent, AppState, Capability, ChatThread, MemoryEntry, Message, Project, RunSnapshot, RunStatus, Settings, Workspace } from './types'
import { AgentGraph } from './AgentGraph'
import { SwarmSettings } from './SwarmSettings'
import { ReasoningPicker, reasoningLevels, effortLabels } from './ReasoningPicker'

const providers = [
  { id: 'codex', name: 'Codex', description: 'CLI · подписка или API', help: 'Установите Codex CLI и выполните codex login в терминале.' },
  { id: 'claude', name: 'Claude Code', description: 'CLI · подписка или API', help: 'Установите Claude Code и войдите в аккаунт командой claude.' },
  { id: 'antigravity', name: 'Antigravity', description: 'CLI · Google AI Pro / Ultra', help: 'Установите Antigravity CLI и войдите в Google-аккаунт через agy. Доступ зависит от подписки и поддерживаемого Google региона аккаунта.' },
  { id: 'cursor', name: 'Cursor', description: 'CLI · подписка Cursor', help: 'Cursor IDE и Cursor CLI устанавливаются отдельно. Для Orbit установите Cursor CLI и выполните agent login. Модели загружаются из CLI.' },
  { id: 'ollama', name: 'Ollama', description: 'Локальные модели', help: 'Запустите Ollama. Модель можно указать в настройках; адрес сервера задаётся через ORBIT_OLLAMA_URL.' },
  { id: 'custom', name: 'OpenAI-compatible', description: 'Совместимый API', help: 'Задайте ORBIT_OPENAI_BASE_URL, ORBIT_OPENAI_API_KEY и ORBIT_OPENAI_MODEL в окружении приложения.' },
]
const defaults: Settings = { providerId: 'codex', models: {}, limitVersion: 2, improvementMode: false, providerPool: [], providerOptions: {}, memoryEnabled: true, accessMode: 'workspace-write', approvalPolicy: 'on-request', reasoningEffort: '', agentInstructions: '', limits: { maxAgents: null, maxDepth: null, maxConcurrent: null, maxTurns: null, maxTotalTurns: null } }
const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const nameOf = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Проект'
const active = (status?: RunStatus) => status === 'working' || status === 'waiting'
const statusText = (status?: RunStatus) => ({ idle: 'Готов', waiting: 'В очереди', working: 'Работает', done: 'Завершён', completed: 'Завершён', error: 'Ошибка', failed: 'Ошибка', cancelled: 'Остановлен', interrupted: 'Прерван' }[status || 'idle'])
const timeOf = (time?: string) => { if (!time) return ''; const date = new Date(time); return Number.isNaN(date.valueOf()) ? time : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
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
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.chat}</svg>
}
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" onClick={e => { if (window.orbit) { e.preventDefault(); void window.orbit.openExternal(link[2]) } }}>{link[1]}</a>
    return part
  })
}
function assistantOutput(text: string): string {
  if (!/^\s*\{/.test(text)) return text
  try {
    const envelope = JSON.parse(text)
    if (typeof envelope.content === 'string') return envelope.content || 'Выполняет действия…'
  } catch { /* Display the content string while the envelope is streaming. */ }
  const match = text.match(/^\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (match) {
    // A chunk can end inside a JSON escape (including a Unicode escape).
    const content = match[1].replace(/\\u[0-9a-f]{0,3}$/i, '')
    try { return JSON.parse(`"${content}"`) || 'Формирует ответ…' } catch { /* Wait for a complete escape. */ }
  }
  return 'Формирует ответ…'
}

function Markdown({ text }: { text: string }) {
  return <div className="markdown">{text.split(/(```[\s\S]*?```)/g).map((block, index) => {
    if (block.startsWith('```')) { const split = block.indexOf('\n'); return <pre key={index}><span className="code-language">{split < 0 ? 'code' : block.slice(3, split)}</span><code>{split < 0 ? block.slice(3, -3) : block.slice(split + 1, -3)}</code></pre> }
    return block.split(/\n\s*\n/).filter(Boolean).map((part, n) => {
      const lines = part.split('\n')
      if (lines.every(line => /^\s*[-*] /.test(line))) return <ul key={`${index}-${n}`}>{lines.map((line, j) => <li key={j}>{inline(line.replace(/^\s*[-*] /, ''))}</li>)}</ul>
      if (lines.every(line => /^\s*\d+\. /.test(line))) return <ol key={`${index}-${n}`}>{lines.map((line, j) => <li key={j}>{inline(line.replace(/^\s*\d+\. /, ''))}</li>)}</ol>
      return <p key={`${index}-${n}`}>{lines.map((line, j) => <span key={j}>{j > 0 && <br />}{/^#{1,6} /.test(line) ? <strong className="md-heading">{inline(line.replace(/^#{1,6} /, ''))}</strong> : inline(line)}</span>)}</p>
    })
  })}</div>
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
  const [panel, setPanel] = useState<'settings' | 'memory' | 'capabilities' | 'add' | null>(null)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectMenu, setProjectMenu] = useState(false)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [selectedAgent, setSelectedAgent] = useState('root')
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState('')
  const [runtimeStorageError, setRuntimeStorageError] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [remote, setRemote] = useState('')
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [libraryRevision, setLibraryRevision] = useState(0)
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
  const selected = currentRun?.agents.find(a => a.id === selectedAgent) || currentRun?.agents[0]
  const currentHealth = health.find(p => p.id === state.settings.providerId)
  const modelChoices = [...new Set([...(currentHealth?.models || []), ...(currentHealth?.model ? [currentHealth.model] : []), ...Object.values(runs).filter(run => run.providerId === state.settings.providerId && run.model).map(run => run.model!)])]
  const effortLevels = reasoningLevels(state.settings.providerId, state.settings.models[state.settings.providerId] || '', currentHealth)
  const savedEffort = state.settings.providerOptions?.[state.settings.providerId]?.reasoningEffort || ''
  const selectedEffort = effortLevels.includes(savedEffort) ? savedEffort : ''
  const accessChoice = state.settings.approvalPolicy === 'on-request' ? 'ask' : state.settings.accessMode
  function chooseAccess(value: string) { updateSettings({ accessMode: value === 'ask' ? 'workspace-write' : value as Settings['accessMode'], approvalPolicy: value === 'ask' ? 'on-request' : 'never' }) }
  const draft = drafts[chatKey] || ''
  const desktop = !!window.orbit

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
        if (event.type === 'run.started') run.status = 'working'
        if (event.agent) { const exists = run.agents.some(a => a.id === event.agent!.id); run.agents = exists ? run.agents.map(a => a.id === event.agent!.id ? { ...a, ...event.agent } : a) : [...run.agents, event.agent] }
        if (event.trace) run.traces = (run.traces.some(t => t.id === event.trace!.id) ? run.traces.map(t => t.id === event.trace!.id ? event.trace! : t) : [...run.traces, event.trace]).slice(-1500)
        if (event.message) run.messages = mergeMessage(run.messages, { ...event.message, runId: event.runId })
        if (event.communication) {
          const communication = event.communication
          const existing = run.communications || []
          run.communications = existing.some(item => item.id === communication.id) ? existing.map(item => item.id === communication.id ? { ...item, ...communication } : item) : [...existing, communication]
        }
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
      if (event.type === 'run.finished' || event.type === 'run.failed' || event.type === 'run.cancelled') setLibraryRevision(n => n + 1)
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

  useEffect(() => { nearBottom.current = true; bottom.current?.scrollIntoView({ behavior: 'instant' }); setSelectedAgent('root') }, [chatKey])
  useEffect(() => { if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat?.messages.length, running])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7500); return () => clearTimeout(timer) }, [notice])
  useEffect(() => {
    if (panel !== 'memory' && panel !== 'capabilities') return
    const api = window.orbit
    if (!api) return
    let mounted = true
    setLoadingLibrary(true)
    setMemory([]); setCapabilities([])
    void Promise.all([api.listMemory(project?.workspace.path || ''), api.listCapabilities(project?.workspace.path || '')]).then(([entries, skills]) => { if (mounted) { setMemory(entries); setCapabilities(skills) } }).catch(error => { if (mounted) setNotice(errorText(error)) }).finally(() => { if (mounted) setLoadingLibrary(false) })
    return () => { mounted = false }
  }, [panel, project?.workspace.path, libraryRevision])
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
    try {
      const runId = await window.orbit.startTask({ projectId: targetProject, chatId: targetChat, prompt, history, workspace: project.workspace.path, ...state.settings, memoryEnabled: true, globalMemoryEnabled, reasoningEffort: selectedEffort, model: state.settings.models[state.settings.providerId]?.trim() || undefined })
      setRuns(previous => ({ ...previous, [runId]: { ...(previous[runId] || snapshotBase({ runId, projectId: targetProject, chatId: targetChat })), workspace: project.workspace.path, prompt, providerId: state.settings.providerId } }))
      setSelection(previous => ({ ...previous, [key]: runId }))
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
      return <div key={agent.id}><button className={`agent-row ${selected?.id === agent.id ? 'selected' : ''}`} style={{ paddingLeft: 14 + Math.min(depth, 8) * 16 }} onClick={() => setSelectedAgent(agent.id)}><span className={`status-dot ${agent.status}`} /><span className="agent-row-label"><strong>{agent.name || agent.id}</strong><small title={modelLabel}>{modelLabel}</small>{agent.role && <small>{agent.role}</small>}</span><span className="agent-state">{statusText(agent.status)}</span></button>{agentTree(items, agent.id, depth + 1, nextSeen)}</div>
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
      <button className="new-chat" onClick={project ? createChat : () => setPanel('add')}><Icon name="plus" />{project ? 'Новый чат' : 'Добавить проект'}<kbd>＋</kbd></button>
      <div className="section-label">ЧАТЫ ПРОЕКТА <span>{project?.chats.length || ''}</span></div>
      <nav className="chat-list" aria-label="Чаты проекта">{project?.chats.map(c => {
        const isRunning = Object.values(runs).some(r => r.projectId === project.id && r.chatId === c.id && active(r.status)) || pending.has(`${project.id}/${c.id}`)
        return <div key={c.id} className="chat-row"><button className={`chat-item ${c.id === chat?.id ? 'active' : ''}`} onClick={() => { setState(previous => ({ ...previous, projects: previous.projects.map(p => p.id === project.id ? { ...p, activeChatId: c.id } : p) })); setSidebarOpen(false) }}><Icon name="chat" size={16} /><span>{c.title}</span>{isRunning && <span className="status-dot working" />}</button><button className="chat-delete" aria-label={`Удалить чат «${c.title}»`} title={isRunning ? 'Сначала остановите агентов' : 'Удалить чат'} disabled={isRunning || !ready} onClick={() => deleteChat(c.id)}><Icon name="trash" size={14} /></button></div>
      })}{!project && <p className="sidebar-empty">Подключите папку или репозиторий, чтобы начать.</p>}</nav>
      <div className="sidebar-bottom"><button onClick={() => setPanel('memory')}><Icon name="memory" />Память</button><button onClick={() => setPanel('capabilities')}><Icon name="skill" />Навыки</button><button onClick={() => setPanel('settings')}><Icon name="settings" />Настройки<span className={`status-dot ${currentHealth?.available ? 'done' : 'idle'}`} /></button><div className="local-label"><span className="status-dot idle" />{desktop ? 'История хранится на устройстве' : 'Предпросмотр интерфейса'}</div></div>
    </aside>

    <main className="main-pane">
      <header className="chat-header"><button className="icon-button mobile-menu" title="Открыть меню" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><div className="chat-heading"><span>{project?.workspace.name || 'Ваше пространство'}</span><span className="header-slash">/</span><strong>{chat?.title || 'Начало работы'}</strong></div><button className={`agents-toggle ${agentsOpen ? 'active' : ''}`} onClick={() => setAgentsOpen(!agentsOpen)} aria-expanded={agentsOpen}><Icon name="agents" size={17} /><span>Агенты</span>{!!currentRun?.agents.length && <b>{currentRun.agents.length}</b>}</button></header>
      {!desktop && <div className="preview-banner"><Icon name="terminal" size={16} /><span>Предпросмотр. Подключение проектов и работа агентов доступны в настольном Orbit.</span></div>}
      {(storageError || runtimeStorageError) && <div className="error-banner" role="alert">{storageError || runtimeStorageError}</div>}
      {!!otherActiveChats && <div className="parallel-chat-notice" role="status">Других активных чатов в проекте: {otherActiveChats}. Файлы общие — поручайте изменения разных участков.</div>}
      <div className="conversation" onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100 }}>
        {!chat?.messages.length ? <div className="welcome"><div className="welcome-symbol"><span className="brand-mark"><span /></span></div><div className="eyebrow">{project ? 'ПРОСТРАНСТВО ДЛЯ ВАШИХ ИДЕЙ' : 'ОДИН АГЕНТ. ВАШИ ПРОЕКТЫ.'}</div><h1>{project ? 'Над чем поработаем?' : 'Начните с проекта.'}</h1><p>{project ? 'Обсудите идею, задайте вопрос или поручите задачу. Агент сам выберет подход и подключит помощников, когда это полезно.' : 'Подключите локальную папку или Git-репозиторий. Чаты, память и работа агентов останутся в контексте проекта.'}</p>{project ? <div className="prompt-suggestions">{['Помоги разобраться в проекте', 'Давай обсудим новую функцию', 'Найди, что можно улучшить'].map(text => <button key={text} disabled={!desktop} onClick={() => setDrafts(previous => ({ ...previous, [chatKey]: text }))}>{text}<Icon name="arrow" size={14} /></button>)}</div> : <button className="primary-button" onClick={() => setPanel('add')}><Icon name="plus" />Подключить проект</button>}<div className="welcome-footnote">Отдельные чаты · Общая и проектная память · Агенты по задаче</div></div> : <div className="message-list">{chat.messages.map(message => <article key={message.id} className={`message ${message.author}`}><div className="message-avatar">{message.author === 'user' ? 'В' : message.author === 'system' ? '!' : <span className="tiny-orbit" />}</div><div className="message-content"><div className="message-meta"><strong>{message.author === 'user' ? 'Вы' : message.author === 'system' ? 'Система' : 'Orbit'}</strong>{message.model && <span>{message.model}</span>}<time>{timeOf(message.time)}</time></div><Markdown text={message.text} /></div></article>)}{running && <div className="working-indicator"><span className="status-dot working" /><span>{pending.has(chatKey) && !workingRun ? 'Запускаем агента…' : 'Агент работает'}</span><button onClick={() => setAgentsOpen(true)}>Посмотреть действия <Icon name="agents" size={14} /></button></div>}{currentRun && !running && ['failed', 'error', 'cancelled', 'interrupted'].includes(currentRun.status) && <div className={`run-notice ${currentRun.status}`}><span className={`status-dot ${currentRun.status}`} /><span>{statusText(currentRun.status)}{currentRun.error ? `: ${currentRun.error}` : currentRun.status === 'interrupted' ? '. Приложение закрылось во время работы. Можно продолжить новым сообщением.' : ''}</span><button onClick={() => setAgentsOpen(true)}>Подробности</button></div>}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer-area"><label className="improvement-toggle"><input type="checkbox" checked={!!state.settings.improvementMode} onChange={event => updateSettings({ improvementMode: event.target.checked })} />Бесконечное улучшение{running && <small> · для следующей задачи</small>}</label><form className={`composer ${running ? 'is-running' : ''}`} onSubmit={send}><textarea aria-label="Сообщение агенту" placeholder={!project ? 'Сначала подключите проект' : running ? 'Можно подготовить следующее сообщение…' : 'Напишите агенту…'} value={draft} disabled={!desktop || !project || !chat || !ready} onChange={event => setDrafts(previous => ({ ...previous, [chatKey]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running) void send() } }} rows={2} /><div className="composer-toolbar"><div className="composer-options"><select aria-label="Провайдер" value={state.settings.providerId} onChange={event => updateSettings({ providerId: event.target.value })}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ModelPicker key={state.settings.providerId} value={state.settings.models[state.settings.providerId] || ''} models={modelChoices} onChange={model => updateSettings({ models: { ...state.settings.models, [state.settings.providerId]: model } })} /><ReasoningPicker providerId={state.settings.providerId} model={state.settings.models[state.settings.providerId] || ''} health={currentHealth} value={selectedEffort} onChange={reasoningEffort => updateSettings({ providerOptions: { ...state.settings.providerOptions, [state.settings.providerId]: { ...state.settings.providerOptions?.[state.settings.providerId], reasoningEffort } } })} /><select aria-label="Уровень доступа" title="Доступ наследуется всеми агентами задачи" value={accessChoice} onChange={event => chooseAccess(event.target.value)}><option value="ask">Ask — спрашивать</option><option value="danger-full-access">Full access</option><option value="workspace-write">Только проект</option><option value="read-only">Только чтение</option></select></div>{running ? <button type="button" className="send-button stop-button" aria-label="Остановить агентов" disabled={!workingRun} onClick={() => void stop()}><Icon name="stop" /></button> : <button className="send-button" type="submit" aria-label="Отправить сообщение" disabled={!draft.trim() || !desktop || !project || !chat || !ready}><Icon name="arrow" /></button>}</div></form><div className="composer-caption"><span>{!ready ? 'Восстанавливаем историю…' : currentHealth && !currentHealth.available ? `${providers.find(p => p.id === currentHealth.id)?.name}: ${currentHealth.detail}` : state.settings.models[state.settings.providerId] || 'Модель по настройкам провайдера'}</span><span>Enter — отправить · Shift + Enter — новая строка</span></div></div>
    </main>

    {agentsOpen && <aside className="agents-panel">
      <header><div><Icon name="agents" /><strong>Агенты</strong></div><button className="icon-button" aria-label="Закрыть панель агентов" onClick={() => setAgentsOpen(false)}><Icon name="close" /></button></header>
      {chatRuns.length > 1 && <select className="run-select" aria-label="Запуск" value={currentRun?.runId || ''} onChange={event => { setSelection(previous => ({ ...previous, [chatKey]: event.target.value })); setSelectedAgent('root') }}>{[...chatRuns].reverse().map((run, i) => <option key={run.runId} value={run.runId}>{i === 0 ? 'Последний' : timeOf(run.startedAt)} · {statusText(run.status)} · {run.prompt.slice(0, 28)}</option>)}</select>}
      {!currentRun?.agents.length ? <div className="panel-empty"><Icon name="agents" size={34} /><h3>Команда появится здесь</h3><p>После отправки сообщения здесь будут реальные агенты, их задачи и действия. Подагенты создаются по необходимости.</p></div> : <>
        <div className="run-summary"><span className={`status-dot ${currentRun.status}`} />{statusText(currentRun.status)}<span>{currentRun.agents.length} агентов</span></div>
        <div className="agent-tree">{agentTree(currentRun.agents)}</div>
        {selected && <AgentInspector key={currentRun.runId} run={currentRun} agent={selected} onSelect={setSelectedAgent} />}
      </>}
    </aside>}

    {panel && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPanel(null) }}><section className={`modal ${panel === 'add' ? 'compact-modal' : ''}`} role="dialog" aria-modal="true" aria-label={{ settings: 'Настройки', memory: 'Память', capabilities: 'Навыки', add: 'Добавить проект' }[panel]}><header className="modal-header"><div><div className="eyebrow">ORBIT WORKSPACE</div><h2>{{ settings: 'Настройки', memory: 'Память', capabilities: 'Навыки', add: 'Добавить проект' }[panel]}</h2></div><button className="icon-button" aria-label="Закрыть" onClick={() => setPanel(null)}><Icon name="close" /></button></header><div className="modal-content">
      {panel === 'add' && <><p className="modal-intro">Каждый проект — отдельное пространство для чатов и памяти.</p>{!desktop && <p className="inline-notice">Откройте настольное приложение Orbit, чтобы подключить проект.</p>}<button className="local-project-option" disabled={!desktop || projectBusy} onClick={() => void addProject('local')}><span className="option-icon"><Icon name="folder" size={25} /></span><span><strong>Открыть локальную папку</strong><small>Работает и без Git</small></span><Icon name="plus" /></button><div className="divider-label">или клонировать репозиторий</div><form onSubmit={event => { event.preventDefault(); if (remote.trim()) void addProject('git') }}><label>URL репозитория<input autoFocus placeholder="https://github.com/owner/project.git" value={remote} onChange={event => setRemote(event.target.value)} disabled={!desktop || projectBusy} /></label><button className="primary-button full-width" disabled={!desktop || projectBusy || !remote.trim()}><Icon name="git" />{projectBusy ? 'Подключаем проект…' : 'Клонировать и открыть'}</button><p className="field-hint">Orbit предложит выбрать папку для клонирования.</p></form></>}
      {panel === 'settings' && <><p className="modal-intro">Агент использует выбранный провайдер. Подключения и авторизация CLI берутся из вашего окружения.</p><div className="settings-section-heading"><h3>Провайдеры</h3><button className="text-button" disabled={!desktop || checking} onClick={() => void refreshProviders()}><Icon name="refresh" size={14} />{checking ? 'Проверяем…' : 'Проверить'}</button></div><div className="provider-list">{providers.map(provider => { const status = health.find(p => p.id === provider.id); return <button key={provider.id} className={`provider-card ${state.settings.providerId === provider.id ? 'selected' : ''}`} onClick={() => updateSettings({ providerId: provider.id })}><div className="provider-monogram">{provider.name[0]}</div><span><strong>{provider.name}</strong><small>{status?.detail || provider.description}</small></span><span className={`provider-badge ${status?.available ? 'available' : ''}`}>{status ? status.available ? 'Доступен' : 'Не подключён' : 'Не проверен'}</span></button> })}</div><p className="field-hint">{providers.find(p => p.id === state.settings.providerId)?.help}</p><div className="settings-model"><span>Модель</span><ModelPicker key={state.settings.providerId} label="Модель в настройках" value={state.settings.models[state.settings.providerId] || ''} models={modelChoices} onChange={model => updateSettings({ models: { ...state.settings.models, [state.settings.providerId]: model } })} /><p className="field-hint">Выбор сохраняется отдельно для каждого провайдера и применяется к следующим сообщениям. Если модели нет в списке, укажите её идентификатор.</p></div><label>Ваши инструкции агенту<textarea rows={4} placeholder="Предпочтения в работе, языке и проверке результатов…" value={state.settings.agentInstructions} onChange={event => updateSettings({ agentInstructions: event.target.value })} /></label><details className="advanced-settings"><summary>Доступ и ограничения роя</summary><label>Доступ для всех агентов<select value={accessChoice} onChange={event => chooseAccess(event.target.value)}><option value="ask">Ask — спрашивать разрешение</option><option value="danger-full-access">Full access — полный доступ</option><option value="workspace-write">Только проект</option><option value="read-only">Только чтение</option></select></label><p className="field-hint">Выбранный доступ и уровень мышления применяются к новым задачам и наследуются подагентами. В режиме Ask запросы разрешения показываются в отдельном окне.</p><SwarmSettings settings={state.settings} update={updateSettings} providers={providers} health={health} /></details><p className="autosave-label"><Icon name="check" size={14} />Настройки сохраняются автоматически</p></>}
      {panel === 'memory' && <><p className="modal-intro">Общая память доступна во всех проектах. Память проекта привязана к его папке и сохраняется между чатами.</p>{!desktop ? <p className="inline-notice">Память доступна в настольном приложении.</p> : <><LibraryForm kind="memory" workspace={project?.workspace.path || ''} onSaved={() => setLibraryRevision(n => n + 1)} onError={setNotice} />{loadingLibrary ? <p className="muted">Загружаем записи…</p> : memory.length ? (['project', 'global'] as const).map(scope => <div key={scope} className="library-group"><div className="section-label">{scope === 'project' ? `ПРОЕКТ · ${project?.workspace.name || 'НЕ ВЫБРАН'}` : 'ОБЩАЯ ПАМЯТЬ'}<span>{memory.filter(entry => entry.scope === scope).length}</span></div>{memory.filter(entry => entry.scope === scope).map(entry => <article className="library-entry" key={entry.id}><div><strong>{entry.title}</strong><button className="icon-button" aria-label={`Удалить запись ${entry.title}`} onClick={() => { void window.orbit!.removeMemory(entry.id, project?.workspace.path || '').then(() => setLibraryRevision(n => n + 1)).catch(error => setNotice(errorText(error))) }}><Icon name="trash" size={15} /></button></div><p>{entry.content}</p></article>)}</div>) : <div className="empty-library"><Icon name="memory" size={28} /><p>Память пока пуста. Добавьте важный контекст или попросите агента его запомнить.</p></div>}</>}</>}
      {panel === 'capabilities' && <><p className="modal-intro">Навык — сохранённые инструкции и способы работы, которые агент может использовать и улучшать в следующих задачах.</p>{!desktop ? <p className="inline-notice">Навыки доступны в настольном приложении.</p> : <><LibraryForm kind="capability" workspace={project?.workspace.path || ''} onSaved={() => setLibraryRevision(n => n + 1)} onError={setNotice} />{loadingLibrary ? <p className="muted">Загружаем навыки…</p> : capabilities.length ? capabilities.map(entry => <CapabilityCard key={`${entry.id}-${entry.version}`} entry={entry} workspace={project?.workspace.path || ''} onSaved={() => setLibraryRevision(n => n + 1)} onError={setNotice} />) : <div className="empty-library"><Icon name="skill" size={28} /><p>Навыков пока нет. Агент может создавать их по мере работы над проектом; вы также можете добавить свой.</p></div>}</>}</>}
    </div></section></div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setNotice('')}><Icon name="close" size={15} /></button></div>}
  </div>
}

function AgentInspector({ run, agent, onSelect }: { run: RunSnapshot; agent: Agent; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<'activity' | 'communications' | 'graph'>('activity')
  const [onlySelected, setOnlySelected] = useState(false)
  const allMessages = run.communications || []
  const communications = onlySelected ? allMessages.filter(message => message.fromAgentId === agent.id || message.toAgentId === agent.id) : allMessages
  const traces = run.traces.filter(trace => (trace.agentId || 'root') === agent.id)
  const replies = run.messages.filter(message => (message.agentId || 'root') === agent.id)
  return <div className="agent-inspector-shell">
    <nav className="inspector-tabs" aria-label="Сведения об агентах">
      <button className={tab === 'activity' ? 'active' : ''} aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Действия</button>
      <button className={`communication-tab ${tab === 'communications' ? 'active' : ''}`} aria-label="Переписка" aria-pressed={tab === 'communications'} onClick={() => setTab('communications')}>Переписка{!!allMessages.length && <span>{allMessages.length}</span>}</button>
      <button className={tab === 'graph' ? 'active' : ''} aria-label="Граф агентов" aria-pressed={tab === 'graph'} onClick={() => setTab('graph')}>Граф</button>
    </nav>
    <div className="agent-inspector">
    {tab === 'activity' ? <>
      <div className="inspector-heading"><div className="eyebrow">{agent.parentId ? 'ПОДАГЕНТ' : 'ОСНОВНОЙ АГЕНТ'}</div><h3>{agent.name}</h3><span>{providers.find(provider => provider.id === agent.providerId)?.name || agent.providerId || run.providerId}{agent.model ? ` · ${agent.model}` : ''}{agent.reasoningEffort ? ` · Рассуждения: ${effortLabels[agent.reasoningEffort] || agent.reasoningEffort}` : ''}{agent.generation ? ` · Продолжение ${agent.generation}` : ''}</span></div>
      {agent.task && <div className="agent-task">{agent.task}</div>}
      {agent.reason && <p className="agent-reason">{agent.reason}</p>}
      <p className="agent-budget">{agent.parentId ? `Ходы: ${agent.turns || 0} / ${run.limits?.maxTurns ?? '∞'}` : `Ходы: ${agent.turns || 0} · без ограничения`}{agent.budgetLimited && (agent.stalled ? ' · Остановлен: повторял одни и те же вызовы, результаты сохранены' : ' · Лимит достигнут, результаты сохранены')}</p>
      {run.usage && <p className="agent-budget">Работают: {run.agents.filter(member => member.status === 'working').length} · Ходы помощников: {run.usage.workerTurns ?? '—'} / {run.limits?.maxTotalTurns ?? '∞'}</p>}
      {agent.id === 'root' && !!run.improvements?.length && <div className="improvement-progress"><strong>Улучшения: {run.improvements.filter(task => task.status === 'done').length} / {run.improvements.length}</strong>{run.improvements.map(task => <details key={task.id}><summary>{({ pending: '○', working: '◐', done: '✓', blocked: '!' })[task.status]} {task.title}</summary><p>{task.evidence || 'Ожидает выполнения'}</p></details>)}</div>}
      <div className="section-label">ДЕЙСТВИЯ И РЕЗУЛЬТАТЫ</div>
      <div className="agent-events">
        {traces.map(trace => ['output', 'assistant_update'].includes(trace.kind)
          ? <div className="agent-output" key={trace.id}><div className="eyebrow">СООБЩЕНИЕ · {timeOf(trace.time)}</div><Markdown text={assistantOutput(trace.text)} /></div>
          : <details className="trace-item" key={trace.id}><summary><span className={`trace-kind ${trace.kind}`} /><span>{trace.text.slice(0, 120) || trace.kind}</span><time>{timeOf(trace.time)}</time></summary><pre>{trace.text}</pre></details>)}
        {replies.map(message => <div className="agent-output" key={message.id}><div className="eyebrow">ОТВЕТ · {timeOf(message.time)}</div><Markdown text={message.text} /></div>)}
        {!traces.length && !replies.length && <p className="muted">{agent.detail || 'Событий пока нет.'}</p>}
      </div>
    </> : tab === 'graph' ? <AgentGraph agents={run.agents} selectedId={agent.id} onSelect={onSelect} /> : <div className="agent-communications">
      <div className="communications-heading"><h3>{onlySelected ? agent.name : 'Вся команда'}</h3><p>Сообщения между агентами этого запуска.</p></div>
      <label className="communications-filter"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} /><span>Только с участием {agent.name}</span></label>
      {!communications.length ? <div className="communications-empty"><Icon name="chat" size={26} /><p>{onlySelected ? 'У этого агента пока нет переписки.' : 'Агенты ещё не обменивались сообщениями.'}</p></div> : communications.map(message => <article className="communication-item" key={message.id}>
        <div className="communication-kind">{message.kind === 'spawn' ? 'Создание агента · исходная задача' : message.kind === 'followup' ? 'Новая задача существующему агенту' : message.discussionId ? 'Сообщение группе' : message.replyTo ? 'Ответ в обсуждении' : 'Сообщение'}</div>
        <div className="communication-route"><strong title={message.fromAgentId}>{message.fromAgentName || message.fromAgentId}</strong><span aria-label="пишет">→</span><strong title={message.toAgentId}>{message.toAgentName || message.toAgentId}</strong></div>
        {message.reason && <p className="agent-reason">{message.reason}</p>}
        {message.replyTo && <blockquote className="communication-reply">{allMessages.find(item => item.id === message.replyTo)?.text.slice(0, 160) || 'Ответ на более раннее сообщение'}</blockquote>}
        <Markdown text={message.text} />
        <div className="communication-meta"><time dateTime={message.time}>{timeOf(message.time)}</time><span className={`delivery-status ${message.status}`} title={message.readAt ? `Прочитано ${timeOf(message.readAt)}` : message.deliveredAt ? `Доставлено ${timeOf(message.deliveredAt)}` : 'Будет доступно агенту на следующем ходе'}>{{ queued: 'В очереди', delivered: 'Доставлено', read: 'Прочитано' }[message.status] || 'Отправлено'}</span></div>
      </article>)}
    </div>}
    </div>
  </div>
}

function LibraryForm({ kind, workspace, onSaved, onError }: { kind: 'memory' | 'capability'; workspace: string; onSaved: () => void; onError: (message: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [scope, setScope] = useState<'project' | 'global'>(workspace ? 'project' : 'global')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim() || !content.trim() || !window.orbit) return
    setBusy(true)
    try {
      if (kind === 'memory') await window.orbit.saveMemory({ id: uid(), title: title.trim(), content: content.trim(), type: 'fact', scope, workspace: scope === 'project' ? workspace : undefined, updated: now(), confidence: 100 })
      else await window.orbit.installCapability({ name: title.trim(), description: content.trim().split('\n')[0].slice(0, 200), instructions: content.trim(), scope, workspace: scope === 'project' ? workspace : undefined, source: 'user' })
      setTitle(''); setContent(''); setExpanded(false); onSaved()
    } catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  return <div className="library-form">{!expanded ? <button className="secondary-button" onClick={() => setExpanded(true)}><Icon name="plus" size={16} />{kind === 'memory' ? 'Добавить запись' : 'Добавить навык'}</button> : <form onSubmit={submit}><label>Название<input autoFocus value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} /></label><label>{kind === 'memory' ? 'Что нужно запомнить' : 'Инструкции навыка'}<textarea rows={4} value={content} onChange={event => setContent(event.target.value)} required /></label><div className="form-actions"><select aria-label="Область действия" value={scope} onChange={event => setScope(event.target.value as 'project' | 'global')}><option value="project" disabled={!workspace}>Только этот проект</option><option value="global">Все проекты</option></select><button type="button" className="text-button" onClick={() => setExpanded(false)}>Отмена</button><button className="primary-button" disabled={busy || !title.trim() || !content.trim()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div></form>}</div>
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
  return <article className="library-entry"><div><strong>{entry.name}</strong><span className="scope-label">{entry.scope === 'global' ? 'Общий' : 'Проект'}{entry.version ? ` · v${entry.version}` : ''}</span><button className="icon-button" disabled={busy} aria-label={`Удалить навык ${entry.name}`} onClick={() => void mutate('remove')}><Icon name="trash" size={15} /></button></div><p>{entry.description}</p><details onToggle={event => { if (event.currentTarget.open) void load() }}><summary>Инструкции и версии</summary>{busy && !detail ? <p className="muted">Загружаем…</p> : detail && <><div className="capability-provenance">{detail.source === 'user' ? 'Добавлен пользователем' : `Источник: ${detail.source || 'агент'}`}{detail.updatedAt ? ` · ${new Date(detail.updatedAt).toLocaleString('ru-RU')}` : ''}</div>{editing ? <><textarea aria-label="Инструкции навыка" rows={8} value={instructions} onChange={event => setInstructions(event.target.value)} /><div className="capability-actions"><button className="text-button" onClick={() => { setEditing(false); setInstructions(detail.instructions) }}>Отмена</button><button className="secondary-button" disabled={busy || !instructions.trim()} onClick={() => void mutate('save')}>Сохранить новую версию</button></div></> : <><Markdown text={detail.instructions} /><button className="text-button" onClick={() => setEditing(true)}>Редактировать</button></>}{!!detail.revisions?.length && <div className="revision-controls"><select aria-label="Предыдущая версия навыка" value={revision} onChange={event => setRevision(event.target.value)}><option value="">Предыдущие версии</option>{[...detail.revisions].reverse().map(item => <option key={item.version} value={item.version}>v{item.version} · {new Date(item.updatedAt).toLocaleDateString('ru-RU')}</option>)}</select><button className="text-button" disabled={busy || !revision} onClick={() => void mutate('restore')}>Восстановить</button></div>}</>}{!busy && !detail && <button className="text-button" onClick={() => void load()}>Повторить загрузку</button>}</details></article>
}
