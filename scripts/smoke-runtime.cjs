const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { OrbitMemoryStore } = require('../electron/memory.cjs')
const { inspectProviders } = require('../electron/providers.cjs')
const { OrbitRuntime } = require('../electron/runtime.cjs')
const { createWorktree, collectPatch, applyPatch, removeWorktree, verifyWorktree } = require('../electron/worktree.cjs')

const run = (file, args, cwd) => new Promise((resolve, reject) => {
  require('node:child_process').execFile(file, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || stdout || error.message).trim()))
    else resolve((stdout || '').trim())
  })
})

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-smoke-'))
  try {
    const first = new OrbitMemoryStore(temp)
    first.upsert({ id: 'smoke-memory', title: 'Smoke memory', content: 'provider routing contract api_key=sk-test-123456789012345', type: 'fact', scope: 'global', confidence: 100 })
    first.upsert({ id: 'scoped-memory', title: 'Scoped memory', content: 'only for repo-a', type: 'fact', scope: 'project', workspace: path.join(temp, 'repo-a'), confidence: 100 })
    const second = new OrbitMemoryStore(temp)
    if (!second.list().some((entry) => entry.id === 'smoke-memory')) throw new Error('memory persistence failed')
    if (second.list().find((entry) => entry.id === 'smoke-memory').content.includes('sk-test-')) throw new Error('memory redaction failed')
    if (second.search('only for repo-a', path.join(temp, 'repo-b')).some((entry) => entry.id === 'scoped-memory')) throw new Error('memory workspace scoping failed')

    const providers = await inspectProviders()
    if (!providers.some((provider) => provider.id === 'codex')) throw new Error('provider health contract failed')

    const runtime = new OrbitRuntime({ runProvider: async ({ signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (signal.aborted) throw new Error('cancelled')
      return { text: 'Smoke test provider completed', model: 'fixture', providerId: 'custom' }
    }, memoryStore: second })
    let resolveFinished
    let rejectFinished
    const finishedPromise = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject })
    let cancelled = false
    runtime.onEvent((event) => {
      if (event.type === 'run.finished') resolveFinished()
      if (event.type === 'run.cancelled') cancelled = true
      if (event.type === 'run.failed') rejectFinished(new Error(event.error || 'runtime failed'))
    })
    await runtime.start({ prompt: 'inspect repository', projectId: 'smoke', chatId: 'smoke-chat', providerId: 'custom', workspace: temp, memoryEnabled: true, memoryContext: second.search('provider routing', temp) })
    let deadline
    try { await Promise.race([finishedPromise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('runtime did not finish')), 10000) })]) }
    finally { clearTimeout(deadline) }

    const cancelId = await runtime.start({ prompt: 'cancel me', projectId: 'smoke', chatId: 'cancel-chat', providerId: 'custom', workspace: temp, memoryEnabled: false })
    runtime.stop(cancelId)
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!cancelled) throw new Error('runtime cancel failed')

    const repo = path.join(temp, 'repo')
    await run('git', ['init', '-q', repo], temp)
    await run('git', ['config', 'user.email', 'orbit-smoke@example.test'], repo)
    await run('git', ['config', 'user.name', 'Orbit Smoke'], repo)
    fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n', 'utf8')
    await run('git', ['add', 'README.md'], repo)
    await run('git', ['commit', '-qm', 'initial'], repo)
    const worktree = await createWorktree(repo, 'smoke-worktree', path.join(temp, 'artifacts'))
    if (!worktree.ok) throw new Error(worktree.detail)
    fs.writeFileSync(path.join(worktree.path, 'feature.txt'), 'created in isolated lane\n', 'utf8')
    fs.writeFileSync(path.join(worktree.path, 'feature.cjs'), 'module.exports = "smoke"\n', 'utf8')
    const artifact = await collectPatch(worktree.path, path.join(temp, 'artifacts'), 'smoke-worktree')
    const verified = await verifyWorktree(worktree.path)
    if (!artifact.hasChanges || !verified.ok) throw new Error('worktree artifact verification failed')
    fs.writeFileSync(path.join(worktree.path, 'feature.cjs'), 'module.exports = ;\n', 'utf8')
    const rejected = await verifyWorktree(worktree.path)
    if (rejected.ok) throw new Error('syntax gate failed to reject invalid JavaScript')
    fs.writeFileSync(path.join(worktree.path, 'feature.cjs'), 'module.exports = "smoke"\n', 'utf8')
    const applied = await applyPatch({ workspace: repo, patchPath: artifact.patchPath, artifactRoot: path.join(temp, 'artifacts') })
    if (!applied.ok || !fs.existsSync(path.join(repo, 'feature.txt'))) throw new Error(`patch apply failed: ${JSON.stringify(applied)}`)
    await removeWorktree(repo, worktree.path)
    console.log(JSON.stringify({ ok: true, memoryEntries: second.list().length, providers: providers.length, runtime: 'finished + cancelled', worktree: 'created + verified + applied' }))
  } finally {
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe smoke cleanup path')
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
