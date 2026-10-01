import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// npx vite build --config scratchpad/agent-filter/harness/vite.config.mjs  (then: node scripts/run-electron.cjs scratchpad/agent-filter/capture.cjs)
const here = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({ root: here, plugins: [react()], base: './', logLevel: 'warn', build: { outDir: path.join(here, '..', 'harness-dist'), emptyOutDir: true } })
