import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Electron loads the production renderer from file://, so asset URLs must
  // stay relative instead of pointing at the filesystem root.
  base: './',
  clearScreen: false,
})
