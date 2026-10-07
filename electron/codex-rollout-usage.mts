import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { serverUsage } from './codex-usage.mts'
import type { CodexTokens } from './codex-usage.mts'

// `codex exec --json` reports usage only when the Orbit turn ends. Its rollout already contains a token_count
// after each model call, including cache hits. Read only our named thread, in this subscription's CODEX_HOME.
// The rollout and the final stdout report share codex-usage's totals, so neither can charge a call twice.
export function createCodexRolloutMeter(home: string, startedAt: number, emit: (usage: CodexTokens) => void) {
  let thread = '', file = '', offset = 0, pending = '', skipping = false, closed = false, searchedAt = 0
  let decoder = new StringDecoder('utf8')
  let timer: ReturnType<typeof setInterval> | undefined
  const buffer = Buffer.alloc(64 * 1024)
  const root = path.join(home, 'sessions')

  const locate = (): string => {
    // Rollouts are sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl. Start with today; a resume can live in an older day.
    const now = new Date(startedAt)
    const today = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    const visit = (folder: string, depth: number): string => {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(folder, { withFileTypes: true }) } catch { return '' }
      const match = entries.find(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${thread}.jsonl`))
      if (match) return path.join(folder, match.name)
      if (depth > 0) for (const entry of entries) if (entry.isDirectory()) {
        const found = visit(path.join(folder, entry.name), depth - 1)
        if (found) return found
      }
      return ''
    }
    return visit(today, 0) || visit(root, 3)
  }
  const line = (text: string) => {
    if (!text.includes('"token_count"')) return
    try {
      const event = JSON.parse(text)
      if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload.info) return
      const at = Date.parse(event.timestamp)
      if (!Number.isFinite(at)) return
      const info = event.payload.info
      // Replayed records before this process began establish the baseline, without charging an old turn to this run.
      const usage = serverUsage(thread, { total: info.total_token_usage, last: info.last_token_usage }, at >= startedAt)
      if (usage) emit(usage)
    } catch { /* A malformed or unrelated rollout record must not interrupt the agent. */ }
  }
  const consume = (chunk: string) => {
    const lines = chunk.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const complete = index < lines.length - 1
      if (!skipping) pending += lines[index]
      // Large tool-output records contain no usage. Bound memory even if a CLI writes a very large single line.
      if (pending.length > 2 * 1024 * 1024) { pending = ''; skipping = true }
      if (complete) {
        if (!skipping) line(pending)
        pending = ''; skipping = false
      }
    }
  }
  const flush = () => {
    if (closed || !thread) return
    if (!file) {
      // A rollout may not exist when thread.started arrives. Retry metadata discovery, never borrow another agent's file.
      if (searchedAt && Date.now() - searchedAt < 1000) return
      searchedAt = Date.now(); file = locate()
      if (!file) return
    }
    let fd: number | undefined
    try {
      fd = fs.openSync(file, 'r')
      const size = fs.fstatSync(fd).size
      if (size < offset) { offset = 0; pending = ''; skipping = false; decoder = new StringDecoder('utf8') }
      // Read a snapshot, so an actively growing log cannot keep this synchronous operation running indefinitely.
      while (offset < size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
        if (!count) break
        offset += count; consume(decoder.write(buffer.subarray(0, count)))
      }
    } catch { /* No rollout (or a locked one): the normal final stdout report remains available. */ }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  return {
    start(id: string) {
      if (closed || thread) return
      thread = id
      flush()
      timer = setInterval(flush, 500)
      timer.unref?.()
    },
    flush,
    close() {
      if (closed) return
      flush(); closed = true
      clearInterval(timer)
    },
  }
}
