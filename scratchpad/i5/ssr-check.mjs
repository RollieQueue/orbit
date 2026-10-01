import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
try {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const chips = await server.ssrLoadModule('/src/AttachmentChips.tsx')
  const pending = [{ id: 'pending-0', name: 'shot.png', type: 'image/png', size: 2048, path: '' }, { id: 'pending-1', name: 'spec.pdf', type: 'application/pdf', size: 5, path: '' }]
  const saved = [{ id: 'ab12cd34', name: 'spec.pdf', type: 'application/pdf', size: 5, path: 'C:/x/attachments/c/ab12cd34-spec.pdf' }]
  console.log('PENDING:', renderToStaticMarkup(createElement(chips.MessageAttachments, { attachments: pending })))
  console.log('SAVED:', renderToStaticMarkup(createElement(chips.MessageAttachments, { attachments: saved })))
} finally { await server.close() }
