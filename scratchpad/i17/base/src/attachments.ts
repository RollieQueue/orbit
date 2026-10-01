import type { Attachment, AttachmentUpload } from './types'

// The limits the runtime enforces (electron/attachments.mts); the window checks first so that the user hears about a
// refusal before anything is read or sent.
export const MAX_FILES = 10
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} МБ`
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} КБ` : `${bytes} Б`
}
export const isImage = (item: { type: string; name: string }): boolean => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(item.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(item.name)

// `incoming` joins the files already chosen, as far as the limits allow: the files that do not fit are left out and
// `error` says why (the first reason only). The same file chosen twice (name, size and modification time) is kept once.
export function addFiles(current: File[], incoming: File[]): { files: File[]; error: string } {
  const files = [...current]
  let total = files.reduce((sum, file) => sum + file.size, 0)
  let error = ''
  for (const file of incoming) {
    const name = file.name || 'файл'
    if (files.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue
    if (file.size > MAX_FILE_BYTES) { error ||= `Файл «${name}» больше ${MAX_FILE_BYTES / 1048576} МБ.`; continue }
    if (files.length >= MAX_FILES) { error ||= `К одному сообщению можно прикрепить не больше ${MAX_FILES} файлов.`; continue }
    if (total + file.size > MAX_TOTAL_BYTES) { error ||= `Вложения одного сообщения вместе больше ${MAX_TOTAL_BYTES / 1048576} МБ.`; continue }
    files.push(file); total += file.size
  }
  return { files, error }
}

// The file as the desktop takes it: its content as base64 (what follows the comma of a data URL).
function readUpload(file: File): Promise<AttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}».`))
    reader.onload = () => resolve({ name: file.name || 'image.png', type: file.type, data: String(reader.result).slice(String(reader.result).indexOf(',') + 1) })
    reader.readAsDataURL(file)
  })
}
export const readUploads = (files: File[]): Promise<AttachmentUpload[]> => Promise.all(files.map(readUpload))

// Saves the files for the chat in the desktop's attachments folder; the attachments it returns are what the message carries.
export async function saveFiles(chatId: string, files: File[]): Promise<Attachment[]> {
  if (!window.orbit) throw new Error('Вложения доступны только в настольном Orbit')
  return window.orbit.saveAttachments(chatId, await readUploads(files))
}

// The files of a message being sent, shown under it until the desktop has saved them: no path yet, nothing to open.
export const pendingAttachments = (files: File[]): Attachment[] =>
  files.map((file, index) => ({ id: `pending-${index}`, name: file.name || 'файл', type: file.type, size: file.size, path: '' }))

// Saved copies no message will carry. A refused send or message deletes its own (the files stay chosen, and the next try
// saves them again); a deleted chat takes its whole folder. The desktop only deletes inside that chat's folder.
export function discardFiles(chatId: string, attachments: Attachment[]): void {
  const paths = attachments.map(item => item.path).filter(Boolean)
  if (paths.length) void window.orbit?.discardAttachments(chatId, paths).catch(() => undefined)
}
export function discardChatFiles(chatId: string): void { void window.orbit?.discardAttachments(chatId).catch(() => undefined) }

// What a later run of the chat is told about the files of an earlier message: the paths, so that it can open them again.
export function attachmentNote(attachments: Attachment[] | undefined): string {
  const saved = (attachments || []).filter(item => item.path)
  return saved.length ? `[Вложения этого сообщения: ${saved.map(item => `${item.path} (${item.type})`).join('; ')}]` : ''
}
