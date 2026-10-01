// Files the user attaches to a chat message. The window sends them as base64 (the renderer cannot write to disk), the
// runtime saves them under <userData>/attachments/<chat>/ and from then on an attachment is only a path: the agents read
// it with their file tools, the window shows it (thumbnail, open). Every path that comes back from the window is trusted
// only inside that folder (`inside`), so a forged attachment cannot make an agent or the window read another file.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Attachment, AttachmentUpload } from './types.mts'

const ATTACHMENTS_DIR = 'attachments'
const MAX_FILES = 10
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
// A thumbnail travels as a data URL and stays in the window's cache, so only small images get one; a bigger one shows as a file.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_NAME_CHARS = 100
const FALLBACK_TYPE = 'application/octet-stream'
// What a file the window sent without a type is taken for; images are also what readAttachmentImage shows.
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }
const TYPES: Record<string, string> = {
  ...IMAGE_TYPES, '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.xml': 'application/xml', '.zip': 'application/zip', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const MIME = /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/i

const attachmentsRoot = (userData: string): string => path.join(userData, ATTACHMENTS_DIR)
// The profile folder the runtime host was built with (electron/runtime-host.mts, in the child process and in-process
// alike). Providers ask for the folder here: the child deletes ORBIT_USER_DATA_DIR from its environment at load and the
// in-process runtime never had it, so the environment is only a fallback for a runtime built some other way.
let configuredUserData: string | null = null
const configureAttachments = (userData: string | null): void => { configuredUserData = userData || null }
function attachmentsFolder(env: NodeJS.ProcessEnv = process.env): string | null {
  const userData = configuredUserData || env.ORBIT_USER_DATA_DIR
  return userData ? attachmentsRoot(userData) : null
}
const megabytes = (bytes: number): string => `${Math.round(bytes / 1048576)} МБ`
// Whether `target` is (inside) `root`, by the path as written: no `..` that climbs out, nothing on another drive.
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, path.resolve(target))
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}
// A file name that is safe on every platform and keeps its extension: no folders, no characters Windows refuses, no
// reserved device names, at most MAX_NAME_CHARS.
function safeName(value: unknown): string {
  const base = String(value ?? '').split(/[\\/]/).pop() || ''
  let name = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
  const extension = path.extname(name)
  if (name.length > MAX_NAME_CHARS) name = name.slice(0, Math.max(1, MAX_NAME_CHARS - extension.length)) + extension
  if (RESERVED.test(path.basename(name, extension))) name = `_${name}`
  return name || 'file'
}
const safeFolder = (chatId: string): string => String(chatId ?? '').replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(0, 64) || 'chat'
const typeOf = (name: string, claimed: unknown): string => typeof claimed === 'string' && MIME.test(claimed.trim()) ? claimed.trim().toLowerCase() : TYPES[path.extname(name).toLowerCase()] || FALLBACK_TYPE
// The bytes a base64 text decodes to, without decoding it (a limit is checked before memory is spent).
const decodedBytes = (data: string): number => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

// Saves the uploads of one message; the error text is shown to the user as it is. Nothing is kept when one file is refused.
async function saveAttachments(userData: string, chatId: string, uploads: unknown): Promise<Attachment[]> {
  if (!Array.isArray(uploads) || !uploads.length) throw new Error('Нет файлов для вложения.')
  if (uploads.length > MAX_FILES) throw new Error(`Можно прикрепить не больше ${MAX_FILES} файлов к одному сообщению.`)
  const prepared: { name: string; type: string; bytes: Buffer }[] = []
  let total = 0
  for (const upload of uploads as Partial<AttachmentUpload>[]) {
    const name = safeName(upload?.name)
    if (typeof upload?.data !== 'string') throw new Error(`Файл «${name}» пуст или повреждён.`)
    if (decodedBytes(upload.data) > MAX_FILE_BYTES) throw new Error(`Файл «${name}» больше ${megabytes(MAX_FILE_BYTES)}.`)
    const bytes = Buffer.from(upload.data, 'base64')
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw new Error(`Вложения одного сообщения вместе больше ${megabytes(MAX_TOTAL_BYTES)}.`)
    prepared.push({ name, type: typeOf(name, upload.type), bytes })
  }
  const folder = path.join(attachmentsRoot(userData), safeFolder(chatId))
  await fs.promises.mkdir(folder, { recursive: true })
  const saved: Attachment[] = []
  try {
    for (const item of prepared) {
      const id = randomBytes(4).toString('hex')
      const file = path.join(folder, `${id}-${item.name}`)
      await fs.promises.writeFile(file, item.bytes, { flag: 'wx' })
      saved.push({ id, name: item.name, type: item.type, size: item.bytes.length, path: file })
    }
  } catch (error) {
    await Promise.all(saved.map(item => fs.promises.rm(item.path, { force: true })))
    throw error
  }
  return saved
}

// Deletes saved files that no message will carry. With `paths`, those files of the chat's folder: a send or a message
// that was refused keeps its files in the composer, and the next try saves them again. Without (null or undefined: the
// JSON of a child runtime turns a missing argument into null), the chat's whole folder: the chat was deleted. Only what
// saveAttachments wrote there can go; a link is removed, not followed. Answers how many entries were removed.
async function discardAttachments(userData: string, chatId: string, paths?: unknown): Promise<number> {
  if (!chatId) return 0
  const folder = path.join(attachmentsRoot(userData), safeFolder(chatId))
  if (paths === undefined || paths === null) {
    let count = 0
    try { count = (await fs.promises.readdir(folder)).length } catch { return 0 }
    // A file Windows holds for a moment (an antivirus scan, the indexer) is tried again.
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 })
    return count
  }
  if (!Array.isArray(paths)) return 0
  let removed = 0
  for (const item of paths.slice(0, MAX_FILES)) {
    if (typeof item !== 'string' || !path.isAbsolute(item)) continue
    const name = path.relative(folder, path.resolve(item))
    if (name !== path.basename(name) || !/^[0-9a-f]{8}-/.test(name)) continue
    // The file checked is the file removed: the name joined to the folder, not the path as the window wrote it.
    const file = path.join(folder, name)
    try {
      if ((await fs.promises.lstat(file)).isDirectory()) continue
      await fs.promises.unlink(file)
      removed++
    } catch { /* already gone */ }
  }
  return removed
}

// An image of the attachments folder as a data URL for the window's thumbnail; null for anything else (another folder, a
// missing file, not an image, over MAX_IMAGE_BYTES).
async function readAttachmentImage(userData: string, target: unknown): Promise<string | null> {
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) return null
  const mime = IMAGE_TYPES[path.extname(target).toLowerCase()]
  if (!mime || !inside(attachmentsRoot(userData), target)) return null
  try {
    const real = await fs.promises.realpath(target)
    if (!inside(await fs.promises.realpath(attachmentsRoot(userData)), real)) return null
    const stat = await fs.promises.stat(real)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null
    return `data:${mime};base64,${(await fs.promises.readFile(real)).toString('base64')}`
  } catch { return null }
}

// What the runtime may hand to an agent from the window's list: the attachments that exist as files of the attachments
// folder. Name, type and size are taken from the file, not from what the window said.
function trustedAttachments(userData: string, value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  const root = attachmentsRoot(userData)
  const kept: Attachment[] = []
  for (const item of value.slice(0, MAX_FILES) as Partial<Attachment>[]) {
    if (typeof item?.path !== 'string' || !path.isAbsolute(item.path) || !inside(root, item.path)) continue
    try {
      const stat = fs.statSync(item.path)
      if (!stat.isFile()) continue
      const name = path.basename(item.path).replace(/^[0-9a-f]{8}-/, '')
      kept.push({ id: typeof item.id === 'string' ? item.id.slice(0, 32) : '', name, type: typeOf(name, item.type), size: stat.size, path: item.path })
    } catch { /* a file that is gone is not attached */ }
  }
  return kept
}

const sizeText = (bytes: number): string => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`
const ATTACHMENTS_HEADER = 'ATTACHMENTS FROM THE USER (files attached to this message; read them with your file tools — an image is shown to you when you read it):'
// The lines of a prompt that name the files: the absolute path is what an agent opens.
const attachmentLines = (attachments: Attachment[] | undefined): string => (attachments || []).map(item => `- ${item.path} (${item.type}, ${sizeText(item.size)})`).join('\n')
const attachmentBlock = (attachments: Attachment[] | undefined): string => attachments?.length ? `${ATTACHMENTS_HEADER}\n${attachmentLines(attachments)}` : ''

export { ATTACHMENTS_DIR, ATTACHMENTS_HEADER, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_IMAGE_BYTES, attachmentsRoot, configureAttachments, attachmentsFolder, safeName, saveAttachments, discardAttachments, readAttachmentImage, trustedAttachments, attachmentLines, attachmentBlock }
