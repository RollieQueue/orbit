// SSR render of WorkingStatus with an open root turn that thinks: prints the status line and its title.
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(path.join(root, 'package.json'))
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href)
const React = require('react')
const { renderToString } = require('react-dom/server')

const server = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const { WorkingStatus } = await server.ssrLoadModule('/src/ChatNotices.tsx')
  const startedAt = new Date(Date.now() - 125_000).toISOString()
  const run = (thinking) => ({
    runId: 'r', projectId: 'p', chatId: 'c', workspace: '', prompt: '', status: 'working', traces: [], messages: [], communications: [], startedAt,
    agents: [{ id: 'root', name: 'Orbit', status: 'working', turnTimings: [{ turn: 1, transport: 'session', startedAt, endedAt: null, nativeToolCalls: 3, orbitToolCalls: 0, ...(thinking === undefined ? {} : { thinking }) }] }],
  })
  for (const thinking of [undefined, 0, 219, 4240, 18_400]) {
    const html = renderToString(React.createElement(WorkingStatus, { run: run(thinking), starting: false, label: t => t.providerId }))
    const text = html.replace(/<!-- -->/g, '').match(/<span title="([^"]*)">([^<]*)<\/span>/)
    console.log(JSON.stringify(thinking), '→', text?.[2], '| title ends:', text?.[1].slice(-90))
  }
} finally { await server.close() }
