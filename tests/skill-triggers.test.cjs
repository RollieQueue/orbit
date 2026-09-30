const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/improvement-loop.test.cjs: vite's oxc transform, then an ES module from a data URL.
// skill-triggers.ts only has type imports, which the transform erases.
let triggers
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'skill-triggers.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  triggers = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
})

const param = (key, type, value) => ({ key, label: key, type, default: value, value })
const skill = (over = {}) => ({
  id: 's', name: 'Праздник', description: '', instructions: '', scope: 'project',
  package: { id: 'pkg-s', dir: 'C:\\skills\\pkg-s' }, triggers: [{ on: 'task-completed', show: 'page.html' }], ...over,
})

test('isCompletion is true only for a finished run that completed', () => {
  assert.equal(triggers.isCompletion({ type: 'run.finished' }), true)
  assert.equal(triggers.isCompletion({ type: 'run.finished', status: 'completed' }), true)
  for (const status of ['restarting', 'failed', 'cancelled', 'running']) assert.equal(triggers.isCompletion({ type: 'run.finished', status }), false, status)
  for (const type of ['run.failed', 'run.cancelled', 'run.started', 'message.added']) assert.equal(triggers.isCompletion({ type, status: 'completed' }), false, type)
})

test('missedCompletions lists completed, unseen runs finished within the window, newest first', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  const ago = seconds => new Date(now - seconds * 1000).toISOString()
  const runs = [
    { id: 'old', status: 'completed', finishedAt: ago(300) },
    { id: 'edge', status: 'completed', finishedAt: ago(120) },
    { id: 'newer', status: 'completed', finishedAt: ago(10) },
    { id: 'older', status: 'completed', finishedAt: ago(90) },
    { id: 'seen', status: 'completed', finishedAt: ago(5) },
    { id: 'failed', status: 'failed', finishedAt: ago(5) },
    { id: 'restarting', status: 'restarting', finishedAt: ago(5) },
    { id: 'running', status: 'running' },
    { id: 'no-time', status: 'completed' },
    { id: 'bad-time', status: 'completed', finishedAt: 'yesterday-ish' },
  ]
  assert.deepEqual(triggers.missedCompletions(runs, new Set(['seen']), now), ['newer', 'older', 'edge'])
  assert.deepEqual(triggers.missedCompletions(runs, new Set(['seen']), now, 60_000), ['newer'])
  assert.deepEqual(triggers.missedCompletions(runs, new Set(), now, 20_000), ['seen', 'newer'])
  assert.deepEqual(triggers.missedCompletions(runs, new Set(['seen', 'newer']), now, 60_000), [])
  assert.deepEqual(triggers.missedCompletions([], new Set(), now), [])
})

test('a run that ended restarting does not trigger, its continuation does', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  const finishedAt = new Date(now - 5000).toISOString()
  const runs = [{ id: 'first', status: 'restarting', finishedAt }, { id: 'continued', status: 'completed', finishedAt }]
  assert.deepEqual(triggers.missedCompletions(runs, new Set(), now), ['continued'])
  assert.equal(triggers.isCompletion({ type: 'run.finished', status: 'restarting' }), false)
  assert.equal(triggers.isCompletion({ type: 'run.finished', status: 'completed' }), true)
})

test('triggeredSkills takes enabled skills with a task-completed trigger and a package, project before global', () => {
  const global = skill({ id: 'g', scope: 'global' })
  const project = skill({ id: 'p', scope: 'project', triggers: [{ on: 'task-completed', show: 'a.html' }, { on: 'task-completed', show: 'b.html' }] })
  assert.deepEqual(triggers.triggeredSkills([]), [])
  assert.deepEqual(triggers.triggeredSkills([global, project]).map(page => [page.skill.id, page.show]), [['p', 'a.html'], ['p', 'b.html'], ['g', 'page.html']])
  // Switched off (undefined means on), no package, no trigger, another event: skipped.
  assert.deepEqual(triggers.triggeredSkills([{ ...project, enabled: false }, global]).map(page => page.skill.id), ['g'])
  assert.deepEqual(triggers.triggeredSkills([{ ...project, enabled: true }]).map(page => page.skill.id), ['p', 'p'])
  assert.deepEqual(triggers.triggeredSkills([skill({ package: undefined })]), [])
  assert.deepEqual(triggers.triggeredSkills([skill({ triggers: [] }), skill({ triggers: undefined })]), [])
  assert.deepEqual(triggers.triggeredSkills([skill({ triggers: [{ on: 'something-else', show: 'page.html' }] })]), [])
})

test('completionPages ignores the enabled switch (a preview shows a switched-off skill too)', () => {
  assert.equal(triggers.completionPages(skill({ enabled: false })).length, 1)
  assert.deepEqual(triggers.completionPages(skill({ package: undefined })), [])
})

test('skillPageUrl points into the package and carries every parameter, the event and the run', () => {
  const params = [param('video', 'url', 'https://www.youtube.com/watch?v=6-8E4Nirh9s'), param('start', 'seconds', 42), param('text', 'text', 'ГОТОВО & готово'), param('confetti', 'boolean', false)]
  const url = new URL(triggers.skillPageUrl(skill({ params }), 'page.html', { orbit_event: 'task-completed', orbit_run: 'run-1' }))
  assert.equal(url.protocol, 'orbit-skill:')
  assert.equal(url.host, 'pkg-s')
  assert.equal(url.pathname, '/page.html')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    video: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', start: '42', text: 'ГОТОВО & готово', confetti: 'false', orbit_event: 'task-completed', orbit_run: 'run-1',
  })
  assert.equal(new URL(triggers.skillPageUrl(skill({ params: [param('confetti', 'boolean', true)] }), 'page.html', { orbit_event: 'preview' })).searchParams.get('confetti'), 'true')
})

test('skillPageUrl leaves orbit_run out when the run is unknown and encodes the path, not the slashes', () => {
  const url = triggers.skillPageUrl(skill(), 'pages/мой файл.html', { orbit_event: 'preview' })
  assert.equal(url, 'orbit-skill://pkg-s/pages/%D0%BC%D0%BE%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB.html?orbit_event=preview')
  assert.ok(!url.includes('orbit_run'))
  // A parameter named like the event cannot override it.
  const clash = new URL(triggers.skillPageUrl(skill({ params: [param('orbit_event', 'text', 'fake')] }), 'page.html', { orbit_event: 'task-completed' }))
  assert.equal(clash.searchParams.get('orbit_event'), 'task-completed')
})
