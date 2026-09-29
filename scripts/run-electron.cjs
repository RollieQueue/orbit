const { spawn } = require('node:child_process')

// Some managed developer environments export ELECTRON_RUN_AS_NODE=1 globally.
// Remove it before spawning the actual Electron binary so ipcMain/BrowserWindow
// are available in the desktop process.
const electronBinary = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBinary, process.argv.slice(2), {
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
