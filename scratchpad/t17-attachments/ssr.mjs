import { createServer } from 'vite'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { Composer } = await server.ssrLoadModule('/src/Composer.tsx')
const { MessageAttachments } = await server.ssrLoadModule('/src/AttachmentChips.tsx')
const settings = { providerId: 'claude', models: {}, providerOptions: {}, accessMode: 'workspace-write', approvalPolicy: 'never' }
const project = { id: 'p', workspace: { path: 'C:/x', name: 'x' }, chats: [] }
globalThis.window = { orbit: {} }
const file = new File(['x'.repeat(204800)], 'shot.png', { type: 'image/png' })
const html = renderToStaticMarkup(createElement(Composer, { settings, project, chat: { id: 'c', messages: [] }, modelChoices: [], selectedEffort: '', quotas: {}, draft: '', files: [file], onAttach: () => '', onDetach() {}, running: false, canSteer: false, restartWait: false, ready: true, desktop: true, onDraft() {}, onSend: () => true, onStop() {}, onTogglePause() {}, onSettings() {}, onOpenQuota() {} }))
console.log(/attach-button/.test(html), /attachment-chip/.test(html), /shot\.png/.test(html), /200 КБ/.test(html), /disabled=""[^>]*aria-label="Отправить сообщение"|aria-label="Отправить сообщение"[^>]*disabled/.test(html))
console.log(renderToStaticMarkup(createElement(MessageAttachments, { attachments: [{ id: 'a', name: 'a.pdf', type: 'application/pdf', size: 10, path: 'C:\o\a.pdf' }] })).slice(0, 300))
await server.close()
