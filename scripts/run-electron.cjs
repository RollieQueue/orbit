'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

// Some managed developer environments export ELECTRON_RUN_AS_NODE=1 globally.
// Remove it before spawning the actual Electron binary so ipcMain/BrowserWindow
// are available in the desktop process.
const electronBinary = require('electron')
const root = path.resolve(__dirname, '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Without a script argument Orbit itself starts from the repository, the same command Orbit.cmd runs
// (flags such as --relaunch, --restart-runtime and --reload-renderer pass through, so `npm start -- --restart-runtime`
// signals a running Orbit). A script argument runs that file inside Electron (smoke:desktop).
const args = process.argv.slice(2)
const runsApp = args.length === 0 || args[0].startsWith('--')
if (runsApp) args.unshift(root)

if (typeof electronBinary !== 'string' || !fs.existsSync(electronBinary)) {
  console.error(`Electron binary is missing (${electronBinary}). Run "npm install" first.`)
  process.exit(1)
}
if (runsApp && env.ORBIT_DEV !== '1' && !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run "npm run build" first (or "npm run dev" for the Vite dev server).')
  process.exit(1)
}

const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  windowsHide: true,
  env,
})

child.on('error', (error) => {
  console.error(`Could not launch Electron: ${error.message}`)
  process.exitCode = 1
})

child.on('close', (code, signal) => {
  if (code === null) {
    console.error(`Electron exited with signal ${signal}`)
    process.exit(1)
  }
  process.exit(code)
})
