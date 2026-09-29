// String helpers shared by the main-process modules, so a shortened text looks the same everywhere: at most `limit`
// characters, with "…" in the last kept position when something was cut. Any value is accepted; null and undefined
// read as empty text.

// `value` cut to `limit` characters; line breaks and spacing stay as they are.
const ellipsis = (value: unknown, limit: number): string => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text }
// One line of at most `limit` characters: whitespace runs become one space, the ends are trimmed, then `ellipsis`.
const clip = (value: unknown, limit: number): string => ellipsis(String(value ?? '').replace(/\s+/g, ' ').trim(), limit)

export { clip, clip as oneLine, ellipsis }
