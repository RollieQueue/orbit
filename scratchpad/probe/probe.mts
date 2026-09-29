import type { QuotaMonitorLike, RunProvider, TransportFor, CloseSession, ProviderEvent as TE, QuotaSnapshot as TS, QuotaWindow as TW, HandoverRequest, CatalogEntry as TC, PoolMember as TP, AgentRecord, RunRecord } from '../../electron/types.mts'
import { QuotaMonitor, assess, classifyQuotaError } from '../../electron/quota.mts'
import type { QuotaSnapshot, QuotaWindow, OutputEvent } from '../../electron/quota.mts'
import { runProvider, transportFor, closeSession } from '../../electron/providers.mts'
import type { ProviderEvent, ToolEvent } from '../../electron/providers.mts'
import { replacements, handoverNote } from '../../electron/failover.mts'
declare const monitor: QuotaMonitor
const a: QuotaMonitorLike = monitor
const b: RunProvider = runProvider
const c: TransportFor = transportFor
const d: CloseSession = closeSession
declare const ev: ProviderEvent
const e: TE = ev
declare const tool: ToolEvent
const f: TE = tool
declare const snap: QuotaSnapshot
const g: TS = snap
declare const win: QuotaWindow
const h: TW = win
declare const agent: AgentRecord
declare const run: RunRecord
declare const catalog: TC[]
const r = replacements({ agent, catalog, pool: run.providerPool, models: run.models as Record<string, string>, quota: monitor, config: run.failover, now: 1, skip: new Set<string>() })
declare const req: HandoverRequest
const note = handoverNote({ agent, from: { providerId: 'x', model: 'y' }, to: { providerId: 'x', model: 'y' }, reason: req.reason, level: req.level, error: req.error, interrupted: req.interrupted, team: { running: [], finished: [] }, unread: 0, actions: [] })
interface A { x: number }
declare const aa: A
const idx: { [k: string]: unknown } = aa
