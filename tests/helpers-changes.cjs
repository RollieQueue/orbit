// Fixtures shared by the parts of tests/file-changes*.test.cjs: a temporary folder that goes away with its test, and a file
// written below it. Not a test file (the runner takes only *.test.cjs).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-changes-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return directory
}
const write = (workspace, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true })
  fs.writeFileSync(path.join(workspace, rel), text)
}

module.exports = { folder, write }
