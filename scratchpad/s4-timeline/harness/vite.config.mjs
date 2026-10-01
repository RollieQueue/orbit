import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A mini Vite project: the harness page imports the real components from src/ and is built into ../harness-dist, which capture.cjs loads.
//   npx vite build --config scratchpad/s4-timeline/harness/vite.config.mjs
const here = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: here,
  plugins: [react()],
  base: './',
  logLevel: 'warn',
  build: { outDir: path.join(here, '..', 'harness-dist'), emptyOutDir: true },
})
