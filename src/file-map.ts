import type { Agent, FileTouch, RunSnapshot } from './types'

// Live events carry each agent's own file lists, so the team-wide view is derived from them.
export function fileMap(agents: Agent[]): FileTouch[] {
  const files = new Map<string, FileTouch>()
  const entry = (path: string) => { let item = files.get(path); if (!item) { item = { path, readers: [], writers: [] }; files.set(path, item) } return item }
  for (const agent of agents) {
    for (const path of agent.files?.wrote || []) entry(path).writers.push(agent.id)
    for (const path of agent.files?.read || []) entry(path).readers.push(agent.id)
  }
  return [...files.values()]
}
export const changedFiles = (run?: RunSnapshot) => new Set((run?.agents || []).flatMap(agent => agent.files?.wrote || [])).size
// Written by somebody and touched by more than one agent.
export const isSharedFile = (file: FileTouch) => file.writers.length > 0 && new Set([...file.writers, ...file.readers]).size > 1
// Written by two or more different agents.
export const isConflictFile = (file: FileTouch) => new Set(file.writers).size > 1
