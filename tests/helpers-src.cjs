const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// The renderer's src/*.ts modules for node tests: transformed with vite's oxc (as tests/state-store.test.cjs does) and written as
// .mjs files into a temporary directory with their ./relative imports rewritten, so a module that imports others runs as it is.
// All the named modules share one directory, so they share the modules they import. Returns them and the directory (the caller removes it).
async function loadSrcs(names) {
  const { transformWithOxc } = await import('vite')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-src-'))
  const done = new Set()
  async function emit(module) {
    if (done.has(module)) return
    done.add(module)
    const file = path.join(__dirname, '..', 'src', `${module}.ts`)
    const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
    const deps = []
    const code = out.code.replace(/from\s+(['"])\.\/([\w-]+)\1/g, (_match, quote, dep) => { deps.push(dep); return `from ${quote}./${dep}.mjs${quote}` })
    fs.writeFileSync(path.join(dir, `${module}.mjs`), code)
    for (const dep of deps) await emit(dep)
  }
  for (const name of names) await emit(name)
  const modules = {}
  for (const name of names) modules[name] = await import(pathToFileURL(path.join(dir, `${name}.mjs`)).href)
  return { modules, dir }
}
// One module (with what it imports); the module and the temporary directory.
async function loadSrc(name) {
  const { modules, dir } = await loadSrcs([name])
  return { module: modules[name], dir }
}

module.exports = { loadSrc, loadSrcs }
