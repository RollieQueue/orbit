// String helpers shared by the main-process modules, so a shortened text looks the same everywhere: at most `limit`
// characters, with "…" in the last kept position when something was cut. Any value is accepted; null and undefined
// read as empty text.

// `value` cut to `limit` characters; line breaks and spacing stay as they are.
const ellipsis = (value: unknown, limit: number): string => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text }
// One line of at most `limit` characters: whitespace runs become one space, the ends are trimmed, then `ellipsis`.
const clip = (value: unknown, limit: number): string => ellipsis(String(value ?? '').replace(/\s+/g, ' ').trim(), limit)

// A window of a long text for a tool that pages: `maxChars` characters (default `fallback`, at most PAGE_CEILING) from `offset`,
// with the whole length and the offset that continues it (null at the end). The text is cut as it is, so the pages joined are
// exactly the original; an offset past the end gives an empty page.
const PAGE_CEILING = 20000
interface TextPage { text: string; totalChars: number; offset: number; nextOffset: number | null }
function pageText(value: unknown, offset: unknown, maxChars: unknown, fallback: number): TextPage {
  const whole = String(value ?? ''), start = Math.max(0, Math.floor(Number(offset)) || 0)
  const size = Math.max(1, Math.min(Math.floor(Number(maxChars)) || fallback, PAGE_CEILING))
  const text = whole.slice(start, start + size), end = start + text.length
  return { text, totalChars: whole.length, offset: start, nextOffset: end < whole.length ? end : null }
}

export { clip, clip as oneLine, ellipsis, pageText, PAGE_CEILING }
export type { TextPage }
