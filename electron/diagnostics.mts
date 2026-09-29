// Where an error Orbit deliberately swallows can still be seen. Silent unless ORBIT_DEBUG is set (1, true, yes, on):
// the main process prints nothing a user cannot act on, and a developer who wants the reasons turns them on for one
// session. `report` never throws, so it is safe inside any catch; it returns whether it printed.
const enabled = (): boolean => /^(?:1|true|yes|on)$/i.test(String(process.env.ORBIT_DEBUG ?? '').trim())

function report(where: string, error: unknown): boolean {
  if (!enabled()) return false
  // Anything can be thrown; an Error's stack is the most useful text, then a message, then the value itself.
  const described = error as { stack?: unknown, message?: unknown } | null | undefined
  try { console.warn(`[orbit] ${where}: ${described?.stack || described?.message || error}`) } catch { /* A broken console must not fail the caller. */ }
  return true
}

export { report, enabled }
