const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { CapabilityStore } = require('../electron/capabilities.mts')
const { resolvePackageFile } = require('../electron/skill-files.mts')

// The celebration ships as a skill package in the repository (skills/task-completed-celebration). An agent installs it
// with capability_install {fromDir}: this is the same store call, so the package must stay installable as it is.
const repo = path.resolve(__dirname, '..')
const folder = path.join(repo, 'skills', 'task-completed-celebration')

test('the celebration package installs from its folder as an agent would, and orbit-skill:// finds its page and assets', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-celebration-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const store = new CapabilityStore(userData)
  const { entry } = store.save({ fromDir: folder, workspace: repo, source: 'agent' }, { origin: 'agent' })
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'skill.json'), 'utf8'))
  assert.equal(entry.name, manifest.name)
  assert.equal(entry.scope, 'global')
  assert.deepEqual(entry.triggers, [{ on: 'task-completed', show: 'page.html' }])
  const values = Object.fromEntries(entry.params.map(param => [param.key, param.value]))
  assert.deepEqual(values, { video: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', start: 42, end: 73, text: 'TASK COMPLETED', confetti: true })
  const [listed] = store.list(repo)
  assert.equal(listed.id, entry.id)
  assert.ok(listed.package && listed.enabled !== false, 'the panel gets the package and the switch')
  const page = resolvePackageFile(userData, listed.package.id, 'page.html')
  assert.ok(page && fs.existsSync(page), 'the page is served from the package folder')
  const html = fs.readFileSync(page, 'utf8')
  // Every file the page loads is part of the package (no external scripts besides the YouTube frame).
  for (const [, file] of html.matchAll(/(?:src|href)="(?!https?:)([^"#?]+)"/g)) {
    assert.ok(entry.files.some(item => item.path === file), `${file} is in the package`)
    assert.ok(fs.existsSync(resolvePackageFile(userData, listed.package.id, file)), `${file} is on disk`)
  }
  assert.doesNotMatch(html, /<script[^>]+src="https?:/, 'no external script')
})

// celebration.js against a minimal page: a 1600×900 window, a 800×300 text box, an invalid video link (no player frame).
// Returns what the page asked for: animation frames, drawing calls on the confetti canvas, the text's place, its listeners
// and what it posted to the stage.
function runCelebration({ reduced }) {
  const frames = []
  const drawing = []
  const posted = []
  const listeners = {}
  const element = () => ({ style: {}, hidden: false, children: [], addEventListener() {}, removeAttribute() {}, appendChild(child) { this.children.push(child) } })
  const context = new Proxy({}, { get: (target, key) => key in target ? target[key] : () => { drawing.push(key) } })
  const elements = { stage: element(), video: element(), catcher: element(), flyer: Object.assign(element(), { offsetWidth: 800, offsetHeight: 300 }), words: element(), spin: element(),
    confetti: Object.assign(element(), { getContext: () => context }) }
  const page = {
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1, parent: { postMessage: message => posted.push(message.type) },
    matchMedia: query => ({ matches: reduced && query === '(prefers-reduced-motion: reduce)' }),
    addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener) },
    removeEventListener: (type, listener) => { listeners[type] = (listeners[type] || []).filter(item => item !== listener) }, focus() {},
    document: { getElementById: id => elements[id], createElement: () => element() },
    location: { search: '?video=not-a-link' }, navigator: { onLine: true }, performance: { now: () => 0 },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length }, cancelAnimationFrame() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, URL, URLSearchParams,
  }
  page.window = page
  vm.runInNewContext(fs.readFileSync(path.join(folder, 'celebration.js'), 'utf8'), page)
  const resize = (width, height) => { Object.assign(page, { innerWidth: width, innerHeight: height }); for (const listener of listeners.resize || []) listener() }
  const press = key => { for (const listener of listeners.keydown || []) listener({ key }) }
  return { frames, drawing, posted, listeners, state: page.celebrationState, flyer: elements.flyer, resize, press }
}
// Every piece of confetti is one of these calls.
const pieces = calls => calls.filter(call => /^(fillRect|arc|fillText)$/.test(call)).length

test('with prefers-reduced-motion nothing moves but the video: the text stands in the middle, the confetti lies still', () => {
  const still = runCelebration({ reduced: true })
  assert.equal(still.state.error, undefined)
  assert.equal(still.frames.length, 0, 'no animation frame is ever asked for')
  assert.equal(still.flyer.style.transform, 'translate3d(400px,300px,0)')
  assert.deepEqual([still.state.textX, still.state.textY], [400, 300])
  assert.ok(still.state.pieces >= 40 && pieces(still.drawing) === still.state.pieces, 'the confetti is drawn once, piece by piece')
  const drawn = still.drawing.length
  still.resize(1000, 900)
  assert.equal(still.flyer.style.transform, 'translate3d(100px,300px,0)', 'a resized window keeps the text in the middle')
  assert.equal(pieces(still.drawing.slice(drawn)), still.state.pieces, 'and gets its confetti again')
  assert.equal(still.frames.length, 0)
  // Esc closes the page: the stage is told, and no resize handler is left behind.
  still.press('Escape')
  assert.deepEqual([still.posted, still.listeners.resize], [['orbit-skill:close'], []])
  // Without the preference the text flies and the confetti falls, frame by frame.
  const moving = runCelebration({ reduced: false })
  assert.equal(moving.frames.length, 2, 'the text and the confetti each ask for frames')
  const [transform, before] = [moving.flyer.style.transform, moving.drawing.length]
  for (const frame of moving.frames.slice()) frame(16)
  assert.equal(moving.state.error, undefined)
  assert.notEqual(moving.flyer.style.transform, transform, 'a frame moves the text')
  assert.ok(pieces(moving.drawing.slice(before)) > 0, 'a frame draws the confetti')
  assert.equal(moving.frames.length, 4, 'and asks for the next one')
  moving.press('Escape')
  assert.deepEqual([moving.posted, moving.listeners.resize], [['orbit-skill:close'], []])
})
