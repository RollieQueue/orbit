// The JSON tool envelope of the envelope transport: a model's response parsed into content and tool calls. A parse
// failure on plain text is the normal path for a prose answer, not an error, so the two silent catches below stay silent.
import { randomUUID } from 'node:crypto'
import type { ParsedResponse, ToolArgs, ToolCall } from '../types.mts'
import { isRecord } from './util.mts'

// A JSON object with a `tool_calls` key: the envelope before its calls are checked.
type Envelope = Record<string, unknown> & { tool_calls: unknown }

class ToolProtocolError extends Error {
  constructor(message: string) { super(`Invalid Orbit tool envelope: ${message}`); this.name = 'ToolProtocolError' }
}
const hasToolCalls = (value: unknown): value is Envelope => isRecord(value) && Object.hasOwn(value, 'tool_calls')
function parseResponse(value: unknown): ParsedResponse {
  if (hasToolCalls(value)) return parseEnvelope(value)
  const raw = String(value || '').replace(/^﻿/, '').trim()
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidates = fenced ? [fenced] : [raw]
  let parsed: unknown
  for (const candidate of candidates) {
    try { parsed = JSON.parse(candidate); break } catch { /* Models sometimes add a short preface around the envelope. */ }
  }
  if (!parsed) parsed = findToolEnvelope(raw)
  if (isRecord(parsed) && (hasToolCalls(parsed) || (typeof parsed.content === 'string' && Object.keys(parsed).every((key) => ['content', 'tool_calls'].includes(key))))) return parseEnvelope(parsed)
  return { content: raw, calls: [] }
}
function findToolEnvelope(raw: string): Envelope | null {
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false; let stringStart = -1; let toolEnvelope = false
    for (let index = start; index < raw.length; index++) {
      const character = raw[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') {
          quoted = false
          if (depth === 1 && /^\s*:/.test(raw.slice(index + 1))) {
            try { if (JSON.parse(raw.slice(stringStart, index + 1)) === 'tool_calls') toolEnvelope = true } catch { /* Not a valid property name. */ }
          }
        }
        continue
      }
      if (character === '"') { quoted = true; stringStart = index; continue }
      if (character === '{') depth++
      else if (character === '}' && --depth === 0) {
        let candidate: unknown
        try { candidate = JSON.parse(raw.slice(start, index + 1)) }
        catch (error) { if (toolEnvelope) throw new ToolProtocolError((error as Error).message) }
        if (hasToolCalls(candidate)) return candidate
        break
      }
    }
    // Never execute a nested/partial call from a broken outer envelope.
    if (toolEnvelope) throw new ToolProtocolError('Incomplete JSON; resend the entire envelope')
  }
  return null
}
function parseEnvelope(envelope: Record<string, unknown>): ParsedResponse {
  if (hasToolCalls(envelope) && !Array.isArray(envelope.tool_calls)) throw new ToolProtocolError('tool_calls must be an array')
  // After the check above a present `tool_calls` is an array; an absent or falsy one means no calls.
  const calls: unknown[] = Array.isArray(envelope.tool_calls) ? envelope.tool_calls : []
  return { content: typeof envelope.content === 'string' ? envelope.content : '', calls: calls.map((call): ToolCall => {
    if (!isRecord(call)) throw new ToolProtocolError('Each tool call must be a JSON object')
    const func = isRecord(call.function) ? call.function : undefined
    let args: unknown = call.arguments ?? func?.arguments ?? {}
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = { __invalidArguments: true } } }
    if (isRecord(args)) args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null))
    return { id: String(call.id || randomUUID()), name: String(call.name || func?.name || ''), arguments: isRecord(args) ? args as ToolArgs : { __invalidArguments: true } }
  }) }
}

export { ToolProtocolError, hasToolCalls, parseResponse }
