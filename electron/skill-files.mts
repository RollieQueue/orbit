// Skill packages on disk. A skill that carries files (a page, scripts, assets) keeps them in its own folder under
// <userData>/skills. The window loads a skill's pages from there through the orbit-skill:// protocol (electron/main.cjs),
// and the store (electron/capabilities.mts) writes and removes the files. Both go through these helpers, so a path can
// never leave its package.
import path from 'node:path'
import { createHash } from 'node:crypto'

const SKILLS_DIR = 'skills'
// orbit-skill://<package id>/<file>: a standard, secure scheme registered by main before the app is ready.
const SKILL_SCHEME = 'orbit-skill'
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/

// The folder (and the orbit-skill:// host, which a URL lowercases) of a skill: its id when that already is a safe
// lowercase name, else a hash of it.
function skillPackageId(skillId: string): string {
  const id = String(skillId || '')
  return PACKAGE_ID.test(id) ? id : `s-${createHash('sha1').update(id).digest('hex').slice(0, 24)}`
}
function skillPackageDir(userData: string, skillId: string): string { return path.join(userData, SKILLS_DIR, skillPackageId(skillId)) }
// A file of a package as the skill names it: forward slashes, 1–8 segments of letters, digits, `.`, `_` and `-` that
// do not start with a dot (so no `..`, no hidden files), 160 characters at most. Null when it is not one.
function packagePath(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(/\\/g, '/')
  if (!text || text.length > 160 || text.startsWith('/')) return null
  const parts = text.split('/')
  return parts.length <= 8 && parts.every(part => SEGMENT.test(part)) ? parts.join('/') : null
}
// The absolute file behind orbit-skill://<packageId>/<relative>, or null when either part is invalid or the result
// would leave the package folder.
function resolvePackageFile(userData: string, packageId: string, relative: string): string | null {
  const rel = PACKAGE_ID.test(packageId) ? packagePath(relative) : null
  if (!rel) return null
  const root = path.join(userData, SKILLS_DIR, packageId)
  const file = path.join(root, ...rel.split('/'))
  const inside = path.relative(root, file)
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? file : null
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
}
const mimeType = (file: string): string => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'

export { SKILLS_DIR, SKILL_SCHEME, skillPackageId, skillPackageDir, packagePath, resolvePackageFile, mimeType }
