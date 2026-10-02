const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CapabilityStore, renderSkills } = require('../electron/capabilities.mts')
const { skillPackageDir, skillPackageId } = require('../electron/skill-files.mts')
const { executeKnowledgeTool } = require('../electron/runtime/knowledge.mts')

const DAY = 86400000
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-skill-packages-'))
  const a = path.join(root, 'project-a')
  fs.mkdirSync(a)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const time = { now: Date.parse('2026-03-01T10:00:00Z') }
  return { root, a, time, file: path.join(root, 'capabilities.json'), open: () => new CapabilityStore(root, { clock: () => time.now }) }
}
const agent = { origin: 'agent' }
const base = a => ({ name: 'Party page', description: 'A page Orbit shows', whenToUse: 'a task completes', scope: 'project', workspace: a, instructions: 'Edit page.html to change the party.' })
const page = { path: 'page.html', content: '<!doctype html><title>party</title>' }
const listing = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []
const dirOf = (root, id) => skillPackageDir(root, id)

test('files are written into the package folder, replaced, removed, and present() says where they are', t => {
  const { root, a, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), files: [page, { path: 'js/app.js', content: 'console.log(1)' }] }).entry
  const dir = dirOf(root, saved.id)
  assert.deepEqual(saved.files, [{ path: 'js/app.js', size: 14 }, { path: 'page.html', size: page.content.length }])
  assert.equal(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'), 'console.log(1)')
  assert.deepEqual(saved.package, { id: skillPackageId(saved.id), dir })
  assert.deepEqual(skills.list(a)[0].package, { id: skillPackageId(saved.id), dir }, 'lists carry it too')
  assert.equal(skills.list(a)[0].instructions, undefined)
  assert.deepEqual(skills.read(saved.id, a).package, { id: skillPackageId(saved.id), dir })
  assert.equal(skills.save({ ...base(a), name: 'Plain', instructions: 'steps only' }).entry.package, undefined, 'no files, no package')

  // A second save replaces one file and leaves the other; omitting `files` keeps them all.
  const second = skills.save({ ...base(a), id: saved.id, files: [{ path: 'js/app.js', content: 'console.log(2)' }] }).entry
  assert.equal(second.version, 2)
  assert.equal(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'), 'console.log(2)')
  assert.deepEqual(second.files.map(file => file.path), ['js/app.js', 'page.html'])
  assert.deepEqual(skills.save({ ...base(a), id: saved.id }).entry.files.map(file => file.path), ['js/app.js', 'page.html'])

  // removeFiles deletes files and the folders they leave empty.
  const removed = skills.save({ ...base(a), id: saved.id, removeFiles: ['js/app.js'] }).entry
  assert.deepEqual(removed.files.map(file => file.path), ['page.html'])
  assert.deepEqual(listing(dir), ['page.html'])
  assert.deepEqual(open().read(saved.id, a).files, removed.files, 'and the list is stored')
  // Removing the last file removes the folder, and the skill has no package any more.
  const empty = skills.save({ ...base(a), id: saved.id, removeFiles: ['page.html'] }).entry
  assert.equal(empty.package, undefined)
  assert.equal(fs.existsSync(dir), false)
})

test('a file path cannot leave the package: no .., absolute, hidden or odd names; a failed save changes nothing', t => {
  const { root, a, file, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), files: [page] }).entry
  const dir = dirOf(root, saved.id)
  for (const bad of ['../x.txt', 'a/../../x.txt', '/etc/x.txt', 'C:/x.txt', '.hidden', 'dir/.env', 'a\\..\\b.txt', '', 'a'.repeat(200), 'nul\0.txt', 'sp ace.txt', '1/2/3/4/5/6/7/8/9.txt']) {
    assert.throws(() => skills.save({ ...base(a), id: saved.id, files: [page, { path: bad, content: 'x' }] }), /files\[1\]\.path/, JSON.stringify(bad))
    assert.throws(() => skills.save({ ...base(a), id: saved.id, removeFiles: [bad] }), /removeFiles\[0\]/, JSON.stringify(bad))
  }
  assert.throws(() => skills.save({ ...base(a), id: saved.id, files: [{ path: 'x.txt', content: 5 }] }), /content must be text/)
  assert.throws(() => skills.save({ ...base(a), id: saved.id, files: 'page.html' }), /files must be an array/)
  assert.throws(() => skills.save({ ...base(a), id: saved.id, files: [{ path: 'Page.HTML', content: 'x' }] }), /only by letter case/)
  assert.throws(() => skills.save({ ...base(a), id: saved.id, files: [{ path: 'page.html/inner.txt', content: 'x' }] }), /both a file and a folder/)
  assert.deepEqual(listing(dir), ['page.html'])
  assert.equal(skills.read(saved.id, a).version, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), page.content)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].version, 1)
  assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), [skillPackageId(saved.id)], 'nothing was written elsewhere')
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false)
})

test('limits: 40 files, 512 KB a file, 4 MB a package, for the user and for an agent; the error names the limit', t => {
  const { root, a, open } = fixture(t), skills = open()
  const many = count => Array.from({ length: count }, (_, index) => ({ path: `f${index}.txt`, content: 'x' }))
  for (const options of [undefined, agent]) {
    assert.throws(() => skills.save({ ...base(a), name: 'Many', files: many(41) }, options), /at most 40 files/)
    assert.throws(() => skills.save({ ...base(a), name: 'Big', files: [{ path: 'big.bin', content: 'x'.repeat(512 * 1024 + 1) }] }, options), /"big\.bin" is larger than 512 KB/)
    const chunk = 'x'.repeat(500 * 1024)
    assert.throws(() => skills.save({ ...base(a), name: 'Total', files: Array.from({ length: 9 }, (_, index) => ({ path: `c${index}.txt`, content: chunk })) }, options), /at most 4 MB in total/)
  }
  assert.equal(fs.existsSync(path.join(root, 'skills')), false, 'refused saves write nothing')
  const ok = skills.save({ ...base(a), name: 'Exactly', files: [...many(39), { path: 'big.txt', content: 'x'.repeat(512 * 1024) }] }, agent).entry
  assert.equal(ok.files.length, 40)
  assert.throws(() => skills.save({ ...base(a), id: ok.id, files: [{ path: 'extra.txt', content: 'x' }] }, agent), /at most 40 files/, 'the limit counts the files already there')
  assert.equal(skills.read(ok.id, a).files.length, 40)
})

test('fromDir replaces the package with a folder; its skill.json fills what the call leaves out; dot files, node_modules and links are skipped', t => {
  const { root, a, open } = fixture(t), skills = open()
  const source = path.join(root, 'build')
  fs.mkdirSync(path.join(source, 'assets'), { recursive: true }); fs.mkdirSync(path.join(source, 'node_modules', 'dep'), { recursive: true }); fs.mkdirSync(path.join(source, '.git'))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 13, 10])
  fs.writeFileSync(path.join(source, 'page.html'), page.content)
  fs.writeFileSync(path.join(source, 'assets', 'logo.png'), png)
  fs.writeFileSync(path.join(source, '.env'), 'SECRET=1'); fs.writeFileSync(path.join(source, '.git', 'HEAD'), 'ref'); fs.writeFileSync(path.join(source, 'node_modules', 'dep', 'index.js'), 'x')
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({
    name: 'Packaged party', description: 'From a folder', whenToUse: 'a task completes', instructions: 'Edit page.html.', scope: 'global',
    params: [{ key: 'text', label: 'Text', type: 'text', default: 'DONE' }], triggers: [{ on: 'task-completed', show: 'page.html' }], commands: [{ name: 'check', run: 'node check.js' }],
  }))
  const saved = skills.save({ workspace: a, fromDir: source }, agent).entry
  assert.equal(saved.name, 'Packaged party'); assert.equal(saved.scope, 'global'); assert.equal(saved.instructions, 'Edit page.html.')
  assert.deepEqual(saved.files.map(file => file.path), ['assets/logo.png', 'page.html', 'skill.json'])
  assert.deepEqual(fs.readFileSync(path.join(dirOf(root, saved.id), 'assets', 'logo.png')), png, 'binary files are copied as they are')
  assert.deepEqual(saved.triggers, [{ on: 'task-completed', show: 'page.html' }])
  assert.deepEqual(saved.commands, [{ name: 'check', run: 'node check.js' }])
  assert.equal(saved.params[0].value, 'DONE')

  // What the call says wins over the manifest; a second fromDir replaces the files (the old ones go).
  fs.rmSync(path.join(source, 'assets'), { recursive: true }); fs.writeFileSync(path.join(source, 'extra.js'), '1')
  const again = skills.save({ id: saved.id, name: 'Renamed', workspace: a, scope: 'global', fromDir: source }, agent).entry
  assert.equal(again.name, 'Renamed'); assert.equal(again.instructions, 'Edit page.html.')
  assert.deepEqual(listing(dirOf(root, saved.id)), ['extra.js', 'page.html', 'skill.json'])
  // A call's `files` are added after the folder's.
  const plus = skills.save({ id: saved.id, workspace: a, scope: 'global', fromDir: source, files: [{ path: 'extra.js', content: '2' }] }, agent).entry
  assert.equal(fs.readFileSync(path.join(dirOf(root, saved.id), 'extra.js'), 'utf8'), '2'); assert.equal(plus.files.length, 3)

  assert.throws(() => skills.save({ ...base(a), name: 'Bad', fromDir: path.join(root, 'missing') }), /not a folder/)
  assert.throws(() => skills.save({ ...base(a), name: 'Bad', fromDir: 'relative/dir' }), /absolute/)
  fs.writeFileSync(path.join(source, 'skill.json'), '{ nope')
  assert.throws(() => skills.save({ workspace: a, fromDir: source }, agent), /skill\.json is not valid JSON/)
  fs.writeFileSync(path.join(source, 'skill.json'), '{}')
  assert.throws(() => skills.save({ workspace: a, fromDir: source }, agent), /name and instructions are required/)
  fs.writeFileSync(path.join(source, 'odd name.txt'), 'x'); fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ name: 'n', instructions: 'i' }))
  assert.throws(() => skills.save({ workspace: a, fromDir: source }, agent), /Cannot install "odd name\.txt"/)
  assert.equal(skills.read(saved.id, a).files.length, 3, 'failed installs changed nothing')
})

test('an agent installs from a folder inside its project or the temp folder only; the user may choose any', t => {
  const { a, open } = fixture(t), skills = open()
  const outside = fs.mkdtempSync(path.join(process.cwd(), 'skill-src-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'page.html'), page.content)
  const input = { ...base(a), fromDir: outside }
  assert.throws(() => skills.save(input, agent), /inside the project folder or the temp folder/)
  assert.equal(skills.save(input).entry.files.length, 1, 'the user picked it')
  const inProject = path.join(a, 'pack'); fs.mkdirSync(inProject); fs.writeFileSync(path.join(inProject, 'page.html'), page.content)
  assert.equal(skills.save({ ...base(a), name: 'Project pack', fromDir: inProject }, agent).entry.files.length, 1)
})

test('params: validated, defaults typed, seconds normalised; an update keeps the user\'s value while key and type stay', t => {
  const { a, open } = fixture(t), skills = open()
  const params = [
    { key: 'video', label: 'Video', type: 'url', default: 'https://www.youtube.com/watch?v=6-8E4Nirh9s', hint: 'A YouTube link' },
    { key: 'start', label: 'Start', type: 'seconds', default: '0:42' }, { key: 'end', label: 'End', type: 'seconds', default: 73 },
    { key: 'text', label: 'Text', type: 'text', default: 'TASK COMPLETED', hint: null }, { key: 'confetti', label: 'Confetti', type: 'boolean', default: true }, { key: 'count', label: 'Count', type: 'number', default: '3' },
  ]
  const saved = skills.save({ ...base(a), params }).entry
  assert.deepEqual(saved.params.map(param => [param.key, param.type, param.default, param.value]), [
    ['video', 'url', 'https://www.youtube.com/watch?v=6-8E4Nirh9s', 'https://www.youtube.com/watch?v=6-8E4Nirh9s'], ['start', 'seconds', 42, 42], ['end', 'seconds', 73, 73],
    ['text', 'text', 'TASK COMPLETED', 'TASK COMPLETED'], ['confetti', 'boolean', true, true], ['count', 'number', 3, 3],
  ])
  assert.equal(saved.params[0].hint, 'A YouTube link'); assert.equal('hint' in saved.params[3], false, 'a null hint is no hint')
  const seconds = value => skills.save({ ...base(a), name: `S ${String(value)}`, params: [{ key: 's', label: 'S', type: 'seconds', default: value }] }).entry.params[0].default
  assert.deepEqual(['42', '42s', '1:13', '1:00:00', 7.5, 0].map(seconds), [42, 42, 73, 3600, 7.5, 0])

  const bad = (param, message) => assert.throws(() => skills.save({ ...base(a), name: 'Bad', params: Array.isArray(param) ? param : [{ key: 'k', label: 'K', type: 'text', default: 'd', ...param }] }), message, JSON.stringify(param))
  for (const key of ['Upper', '1a', 'has-dash', '', 'x'.repeat(33), 5]) bad({ key }, /key must be lowercase/)
  bad([{ key: 'k', label: 'K', type: 'text', default: '' }, { key: 'k', label: 'K2', type: 'text', default: '' }], /given twice/)
  bad({ label: '' }, /needs a label/); bad({ label: 'L'.repeat(81) }, /needs a label of at most 80/)
  bad({ type: 'color' }, /type must be one of/); bad({ hint: 'h'.repeat(301) }, /hint is longer than 300/)
  bad({ default: 'x'.repeat(501) }, /longer than 500/); bad({ default: 5 }, /must be text/)
  bad({ type: 'url', default: 'ftp://host/x' }, /http\(s\) link/); bad({ type: 'url', default: 'not a url' }, /http\(s\) link/); bad({ type: 'url', default: `https://x.io/${'a'.repeat(2000)}` }, /at most 2000/)
  bad({ type: 'number', default: 'abc' }, /must be a number/); bad({ type: 'number', default: Infinity }, /must be a number/)
  bad({ type: 'seconds', default: -1 }, /must be seconds/); bad({ type: 'seconds', default: '1:75' }, /must be seconds/); bad({ type: 'seconds', default: 'soon' }, /must be seconds/)
  bad({ type: 'boolean', default: 'yes' }, /true or false/)
  bad(Array.from({ length: 21 }, (_, index) => ({ key: `p${index}`, label: 'P', type: 'text', default: '' })), /at most 20/)
  assert.throws(() => skills.save({ ...base(a), name: 'Bad', params: 'nope' }), /params must be an array/); bad(['nope'], /params\[0\] must be an object/)

  // The user's choice survives an edit while a parameter keeps its key and type; a new or retyped one starts at its default.
  skills.setParams(saved.id, { text: 'DONE!', start: '1:00', confetti: false }, a)
  const edited = skills.save({ ...base(a), id: saved.id, params: [
    { key: 'text', label: 'Banner', type: 'text', default: 'NEW DEFAULT' }, { key: 'start', label: 'Start', type: 'number', default: 5 }, { key: 'confetti', label: 'Confetti', type: 'boolean', default: true }, { key: 'extra', label: 'Extra', type: 'text', default: 'e' },
  ] }).entry
  assert.deepEqual(edited.params.map(param => [param.key, param.default, param.value]), [['text', 'NEW DEFAULT', 'DONE!'], ['start', 5, 5], ['confetti', true, false], ['extra', 'e', 'e']])
  assert.equal(edited.params[0].label, 'Banner')
  assert.deepEqual(skills.save({ ...base(a), id: saved.id }).entry.params.map(param => param.value), ['DONE!', 5, false, 'e'], 'leaving params out keeps them')
  assert.deepEqual(skills.save({ ...base(a), id: saved.id, params: [] }).entry.params, [], 'an empty list clears')
})

test('setParams checks every key and value first, changes only values and is not a new version', t => {
  const { a, file, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), files: [page], params: [{ key: 'text', label: 'Text', type: 'text', default: 'A' }, { key: 'loops', label: 'Loops', type: 'number', default: 1 }, { key: 'on', label: 'On', type: 'boolean', default: true }] }).entry
  const updated = skills.setParams(saved.id, { text: 'B', loops: '4' }, a)
  assert.deepEqual(updated.params.map(param => [param.key, param.default, param.value]), [['text', 'A', 'B'], ['loops', 1, 4], ['on', true, true]])
  assert.equal(updated.version, 1); assert.equal(updated.instructions, undefined); assert.ok(updated.package, 'returns the summary as list() does')
  assert.equal(skills.read(saved.id, a).revisions.length, 0)
  assert.equal(open().list(a)[0].params[0].value, 'B', 'stored')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].params[1].value, 4)
  assert.equal(skills.setParams(saved.id.slice(0, 8), {}, a).params[0].value, 'B', 'an id prefix works; no values changes nothing')
  assert.throws(() => skills.setParams(saved.id, { text: 'C', nope: 1 }, a), /no parameter "nope"/)
  assert.throws(() => skills.setParams(saved.id, { text: 'C', loops: 'many' }, a), /must be a number/)
  assert.throws(() => skills.setParams(saved.id, ['C'], a), /must be an object/)
  assert.throws(() => skills.setParams('missing-id', {}, a), /Capability was not found/)
  assert.equal(skills.list(a)[0].params[0].value, 'B', 'a refused call changed nothing')
})

test('a trigger must name an html page that exists after the save; a page cannot be removed from under a trigger', t => {
  const { a, open } = fixture(t), skills = open()
  const trigger = { on: 'task-completed', show: 'page.html' }
  assert.throws(() => skills.save({ ...base(a), triggers: [trigger] }), /"page\.html" is not a file of this package/)
  assert.throws(() => skills.save({ ...base(a), files: [{ path: 'notes.txt', content: 'x' }], triggers: [{ on: 'task-completed', show: 'notes.txt' }] }), /must be an \.html page/)
  assert.throws(() => skills.save({ ...base(a), files: [page], triggers: [{ on: 'task-failed', show: 'page.html' }] }), /on must be "task-completed"/)
  assert.throws(() => skills.save({ ...base(a), files: [page], triggers: [{ on: 'task-completed', show: '../page.html' }] }), /must be an \.html page/)
  assert.throws(() => skills.save({ ...base(a), files: [page], triggers: Array.from({ length: 6 }, (_, index) => ({ on: 'task-completed', show: `p${index}.html` })) }), /at most 5/)
  assert.throws(() => skills.save({ ...base(a), files: [page], triggers: 'page.html' }), /triggers must be an array/)
  assert.deepEqual(skills.list(a), [], 'nothing was saved')
  const saved = skills.save({ ...base(a), files: [page, { path: 'sub/other.htm', content: '<p>x</p>' }], triggers: [trigger, { ...trigger }, { on: 'task-completed', show: 'sub\\other.htm' }] }).entry
  assert.deepEqual(saved.triggers, [trigger, { on: 'task-completed', show: 'sub/other.htm' }], 'duplicates fold, separators are normalised')
  assert.throws(() => skills.save({ ...base(a), id: saved.id, removeFiles: ['page.html'] }), /"page\.html" is not a file of this package/)
  assert.deepEqual(skills.save({ ...base(a), id: saved.id, removeFiles: ['page.html'], triggers: [] }).entry.files.map(file => file.path), ['sub/other.htm'], 'removing the trigger too is fine')
})

test('commands: validated names, run lines and descriptions; omitted keeps, [] clears', t => {
  const { a, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), commands: [{ name: 'up', run: 'wsl -d Orbit', description: 'Start it' }, { name: 'check-2', run: ' node check.js ', description: null }] }).entry
  assert.deepEqual(saved.commands, [{ name: 'up', run: 'wsl -d Orbit', description: 'Start it' }, { name: 'check-2', run: 'node check.js' }])
  const bad = (command, message) => assert.throws(() => skills.save({ ...base(a), name: 'Bad', commands: Array.isArray(command) ? command : [{ name: 'go', run: 'node go.js', ...command }] }), message, JSON.stringify(command))
  for (const name of ['Up', '1up', 'up_now', '', 'x'.repeat(41), 'up now']) bad({ name }, /name must be lowercase/)
  bad([{ name: 'go', run: 'a' }, { name: 'go', run: 'b' }], /given twice/)
  bad({ run: '' }, /needs a run line/); bad({ run: 'x'.repeat(1001) }, /at most 1000/); bad({ run: 5 }, /needs a run line/)
  bad({ description: 'd'.repeat(301) }, /longer than 300/); bad({ description: 4 }, /must be text/)
  bad(Array.from({ length: 21 }, (_, index) => ({ name: `c${index}`, run: 'x' })), /at most 20/); assert.throws(() => skills.save({ ...base(a), name: 'Bad', commands: 'go' }), /commands must be an array/); bad([5], /commands\[0\] must be an object/)
  assert.equal(skills.save({ ...base(a), id: saved.id }).entry.commands.length, 2)
  assert.deepEqual(skills.save({ ...base(a), id: saved.id, commands: [] }).entry.commands, [])
  assert.match(renderSkills({ total: 1, skills: [{ ...skills.save({ ...base(a), name: 'Pack', commands: saved.commands }).entry, reliability: 0.5 }] }), /Pack \[commands: up, check-2\] —/, 'the prompt block names the commands')
})

test('remove deletes the package folder; evicted and expired skills take theirs along; a package skill is never dropped or merged', t => {
  const { root, a, time, open } = fixture(t), skills = open()
  const pack = skills.save({ ...base(a), source: 'agent:x', files: [page], triggers: [{ on: 'task-completed', show: 'page.html' }] }, agent).entry
  const dir = dirOf(root, pack.id)
  assert.ok(fs.existsSync(dir))
  assert.equal(skills.remove('nope', a), false); assert.ok(fs.existsSync(dir))
  assert.equal(skills.remove(pack.id, a), true)
  assert.equal(fs.existsSync(dir), false, 'the folder goes with the skill')
  assert.equal(fs.existsSync(path.join(root, 'skills', skillPackageId(pack.id))), false)

  // maintain: an old unused package skill (agent source, so only the package protects it) stays; a plain one expires.
  const keep = skills.save({ ...base(a), name: 'Old package', source: 'agent:x', files: [page] }, agent).entry
  const cmds = skills.save({ ...base(a), name: 'Old commands', source: 'agent:x', commands: [{ name: 'go', run: 'node go.js' }] }, agent).entry
  const plain = skills.save({ name: 'Rotate the logs', instructions: 'Archive the log directory and truncate the files.', scope: 'project', workspace: a }, agent).entry
  time.now += 200 * DAY
  assert.equal(skills.maintain({ workspace: a }).expired, 1)
  assert.deepEqual(skills.list(a).map(item => item.id).sort(), [keep.id, cmds.id].sort())
  assert.ok(fs.existsSync(dirOf(root, keep.id)) && !plain.files.length)

  // Eviction: the cap drops unproven plain skills, never a package skill, and a dropped plain skill has no folder to leave.
  for (let index = 0; index < 70; index++) skills.save({ name: `Filler ${index} ${'zq'.repeat(index % 7 + 1)}${index}`, description: `unique ${index * 7919}`, instructions: `step ${index * 104729} lorem${index}${'x'.repeat(index)} ipsum`, scope: 'project', workspace: a }, agent)
  assert.ok(skills.list(a).some(item => item.id === keep.id) && skills.list(a).some(item => item.id === cmds.id), 'package skills survive the cap')
  assert.ok(skills.list(a).length <= 62)
  assert.ok(fs.existsSync(dirOf(root, keep.id)))

  // maintain never merges a package skill with a near-identical one, in either direction.
  const fx = fixture(t), other = fx.open(), text = 'Open the release checklist, tick every item, tag the commit and publish the notes to the team channel.'
  const party = other.save({ name: 'Release checklist', instructions: text, scope: 'project', workspace: fx.a, files: [page] }, agent).entry
  other.save({ name: 'Release checklist copy', instructions: text, scope: 'project', workspace: fx.a }, agent)
  assert.deepEqual(other.maintain({ workspace: fx.a }), { expired: 0, merged: 0, evicted: 0, shared: 0 })
  assert.equal(other.list(fx.a).length, 2)
  assert.ok(other.list(fx.a).some(item => item.id === party.id))
})

test('an agent save never merges into a package skill, nor a package into a plain twin', t => {
  const { a, open } = fixture(t), skills = open()
  const text = 'Open the release checklist, tick every item, tag the commit and publish the notes to the team channel.'
  // Control: two plain near-identical skills do merge for an agent, so the checks below really exercise the guard.
  const plain = skills.save({ name: 'Release checklist', instructions: text, scope: 'project', workspace: a }, agent).entry
  const twin = skills.save({ name: 'Release checklist steps', instructions: `${text} Then archive.`, scope: 'project', workspace: a }, agent)
  assert.equal(twin.merged, true); assert.equal(twin.entry.id, plain.id)
  const incoming = skills.save({ name: 'Release checklist tasks', instructions: `${text} Then notify.`, scope: 'project', workspace: a, files: [page] }, agent)
  assert.equal(incoming.merged, false, 'a package does not become a plain twin\'s improvement'); assert.notEqual(incoming.entry.id, plain.id)
  const copy = skills.save({ name: 'Release checklist again', instructions: `${text} Then notify.`, scope: 'project', workspace: a }, agent)
  assert.notEqual(copy.entry.id, incoming.entry.id, 'and a plain one does not merge into the package')
  assert.equal(skills.read(incoming.entry.id, a).version, 1)
})

test('suggest() skips trigger-only skills, keeps skills with commands; search and list keep everything; disabled skills stay hidden from agents', t => {
  const { a, open } = fixture(t), skills = open()
  const deploy = skills.save({ name: 'Deploy the staging site', description: 'Push the build to staging', whenToUse: 'deploying staging', instructions: 'Run the deploy script, then check the health endpoint.', scope: 'project', workspace: a }).entry
  const party = skills.save({ ...base(a), name: 'Deploy party', description: 'Celebrate the staging deploy', whenToUse: 'a deploy completes', files: [page], triggers: [{ on: 'task-completed', show: 'page.html' }] }).entry
  const both = skills.save({ ...base(a), name: 'Deploy helper page', description: 'Staging deploy dashboard', whenToUse: 'deploying staging', files: [page], triggers: [{ on: 'task-completed', show: 'page.html' }], commands: [{ name: 'dash', run: 'node dash.js' }] }).entry
  assert.deepEqual(skills.search('deploy staging', a).map(item => item.id).sort(), [deploy.id, party.id, both.id].sort(), 'search finds them all')
  assert.deepEqual(skills.suggest('deploy staging', a).skills.map(item => item.id).sort(), [deploy.id, both.id].sort(), 'suggest skips the trigger-only page')
  assert.equal(skills.suggest('deploy staging', a).total, 2)
  assert.equal(skills.list(a).length, 3)
  skills.setEnabled(deploy.id, false, a); skills.setEnabled(both.id, false, a)
  assert.deepEqual(skills.search('deploy staging', a).map(item => item.id), [party.id])
  assert.deepEqual(skills.suggest('deploy staging', a).skills, [])
  assert.equal(skills.list(a).length, 3, 'the panel still lists disabled skills')
})

test('enabled defaults to true, persists, is not a new version, and a new version keeps the switch and the package', t => {
  const { root, a, file, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), files: [page], params: [{ key: 'text', label: 'Text', type: 'text', default: 'A' }], commands: [{ name: 'go', run: 'node go.js' }] }).entry
  assert.equal(saved.enabled, true)
  const off = skills.setEnabled(saved.id, false, a)
  assert.equal(off.enabled, false); assert.equal(off.version, 1); assert.equal(off.instructions, undefined)
  assert.equal(skills.read(saved.id, a).revisions.length, 0)
  assert.equal(open().list(a)[0].enabled, false, 'persists across a reopen')
  assert.equal(skills.setEnabled(saved.id.slice(0, 8), true, a).enabled, true, 'an id prefix works, as for pin')
  assert.throws(() => skills.setEnabled('missing-id', false, a), /Capability was not found in this project or shared library/)
  skills.setEnabled(saved.id, false, a)
  skills.setParams(saved.id, { text: 'B' }, a)
  const next = skills.save({ ...base(a), id: saved.id, instructions: 'A plainer procedure now.' }).entry
  assert.equal(next.enabled, false); assert.equal(next.version, 2)
  assert.deepEqual([next.files.length, next.params[0].value, next.commands.length], [1, 'B', 1], 'package state is current state, not part of the text')
  // Revisions keep the text only; restoring brings the text back as a new version and leaves the package alone.
  const revision = skills.read(saved.id, a).revisions[0]
  assert.deepEqual(Object.keys(revision).sort(), ['description', 'instructions', 'name', 'updatedAt', 'version', 'whenToUse'])
  const restored = skills.restore(saved.id, 1, a)
  assert.equal(restored.instructions, base(a).instructions); assert.equal(restored.version, 3)
  assert.deepEqual([restored.files.length, restored.params[0].value, restored.commands.length, restored.enabled], [1, 'B', 1, false])
  assert.ok(fs.existsSync(path.join(dirOf(root, saved.id), 'page.html')))
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].enabled, false)
})

test('revive coerces what is on disk and never throws', t => {
  const { a, file, open } = fixture(t)
  const stored = { description: '', whenToUse: '', scope: 'global', source: 'agent', version: 1 }
  fs.writeFileSync(file, JSON.stringify([
    { ...stored, id: 'old', name: 'Old', instructions: 'A skill saved before packages existed.' },
    { ...stored, id: 'odd', name: 'Odd', instructions: 'Garbage in the new fields.', files: [{ path: '../x', size: 1 }, { path: 'ok.html', size: 3 }, 'no', { path: 'a.txt' }], params: [{ key: 'Bad', label: 'x', type: 'text', default: '' }, { key: 'n', label: 'N', type: 'number', default: 2, value: 'many' }, { key: 'n', label: 'Dup', type: 'number', default: 3 }, { key: 't', label: 'T', type: 'text', default: 'd', value: 'mine' }], triggers: [{ on: 'never', show: 'x.html' }], commands: [{ name: 'Bad', run: 'x' }, { name: 'go', run: 'node go.js' }, { name: 'go', run: 'again' }] },
    { ...stored, id: 'wrong', name: 'Wrong', instructions: 'Wrong types.', files: 'x', params: 5, triggers: {}, commands: null },
  ]))
  const skills = open(), byId = id => skills.list(a).find(item => item.id === id)
  assert.deepEqual([byId('old').files, byId('old').params, byId('old').triggers, byId('old').commands], [[], [], [], []])
  assert.equal(byId('old').package, undefined)
  assert.deepEqual(byId('odd').files, [{ path: 'ok.html', size: 3 }])
  assert.deepEqual(byId('odd').params.map(param => [param.key, param.value]), [['n', 2], ['t', 'mine']], 'bad and duplicate parameters drop, a value that does not fit resets to the default')
  assert.deepEqual(byId('odd').triggers, []); assert.deepEqual(byId('odd').commands, [{ name: 'go', run: 'node go.js' }])
  assert.deepEqual([byId('wrong').files, byId('wrong').params, byId('wrong').triggers, byId('wrong').commands], [[], [], [], []])
})

test('agent tools: capability_install builds a package, capability_read shows it, a disabled skill is refused, listings show kinds', async t => {
  const { root, a, open } = fixture(t), skills = open()
  const run = { workspace: a, globalMemoryEnabled: true, skillUse: new Map(), skillSaved: false }
  const worker = { id: 'root', memoryProfile: 'project-global' }
  const call = (name, args, who = worker) => executeKnowledgeTool({ capabilityStore: skills }, run, who, name, args)

  const installed = await call('capability_install', {
    name: 'Party page', description: 'Shows a page', whenToUse: 'a task completes', instructions: 'Edit page.html to change the party.', scope: 'project',
    files: [page], params: [{ key: 'text', label: 'Text', type: 'text', default: 'DONE', hint: null }], triggers: [{ on: 'task-completed', show: 'page.html' }], commands: [{ name: 'lint', run: 'node lint.js' }],
  })
  assert.equal(installed.ok, true); assert.equal(run.skillSaved, true)
  const dir = dirOf(root, installed.id)
  assert.equal(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), page.content)

  const read = await call('capability_read', { id: installed.id })
  assert.deepEqual(read.package, { id: skillPackageId(installed.id), dir })
  assert.deepEqual(read.files, [{ path: 'page.html', size: page.content.length }])
  assert.deepEqual(read.params, [{ key: 'text', label: 'Text', type: 'text', value: 'DONE', default: 'DONE' }])
  assert.deepEqual(read.triggers, [{ on: 'task-completed', show: 'page.html' }]); assert.deepEqual(read.commands, [{ name: 'lint', run: 'node lint.js' }])
  assert.match(read.note, /package folder/); assert.equal(read.instructions, 'Edit page.html to change the party.')
  assert.deepEqual(Object.keys(read).slice(-2), ['note', 'instructions'], 'the instructions stay last')
  const plain = await call('capability_install', { name: 'Plain routine', description: 'd', instructions: 'Do the three steps.' })
  assert.equal((await call('capability_read', { id: plain.id })).package, undefined)

  const kinds = Object.fromEntries((await call('capability_list', {})).map(item => [item.name, item]))
  assert.deepEqual(kinds['Party page'].kinds, ['instructions', 'page', 'commands']); assert.equal(kinds['Party page'].files, 1)
  assert.deepEqual(kinds['Plain routine'].kinds, ['instructions']); assert.equal('files' in kinds['Plain routine'], false)
  assert.deepEqual((await call('capability_search', { query: 'party page' }))[0].kinds, ['instructions', 'page', 'commands'])

  // Changing one file of an existing skill needs only its id and the file; the text, params and commands stay.
  await call('capability_install', { id: installed.id, files: [{ path: 'page.html', content: '<p>v2</p>' }] })
  assert.equal(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), '<p>v2</p>')
  assert.equal(skills.read(installed.id, a).instructions, 'Edit page.html to change the party.'); assert.equal(skills.read(installed.id, a).commands.length, 1)
  await assert.rejects(call('capability_install', { description: 'no name' }), /name and instructions are required/)
  await assert.rejects(call('capability_install', { name: 'Bad page', instructions: 'i', triggers: [{ on: 'task-completed', show: 'missing.html' }] }), /not a file of this package/)

  // fromDir: a folder in the project carries its own manifest, scope included (a shared skill that names the project stays in the project).
  const source = path.join(a, 'pack'); fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'page.html'), page.content)
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ name: 'Global pack', instructions: 'Shows the page.', scope: 'global', triggers: [{ on: 'task-completed', show: 'page.html' }] }))
  const shared = await call('capability_install', { fromDir: source })
  assert.equal(shared.scope, 'global'); assert.equal(skills.read(shared.id, a).files.length, 2)
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ name: 'Names the project', instructions: `Open ${a} first.`, scope: 'global' }))
  const kept = await call('capability_install', { fromDir: source })
  assert.equal(kept.scope, 'project'); assert.equal(kept.demoted, true)
  await assert.rejects(call('capability_install', { name: 'x', instructions: 'y', fromDir: os.homedir() }), /inside the project folder or the temp folder/)

  // A skill the user switched off is invisible to agents: not listed, not found, and not readable or ratable.
  skills.setEnabled(installed.id, false, a)
  assert.ok(!(await call('capability_list', {})).some(item => item.id === installed.id))
  assert.ok(!(await call('capability_search', { query: 'party page' })).some(item => item.id === installed.id))
  await assert.rejects(call('capability_read', { id: installed.id }), /This skill is switched off/)
  await assert.rejects(call('capability_feedback', { id: installed.id, outcome: 'worked' }), /This skill is switched off/)
  assert.equal((await call('capability_feedback', { id: plain.id, outcome: 'worked' })).ok, true)
})

test('a case-only rename through fromDir keeps the file that was just written', t => {
  const { root, a, open } = fixture(t), skills = open()
  const saved = skills.save({ ...base(a), files: [{ path: 'Page.html', content: 'old' }] }).entry
  const source = path.join(root, 'build'); fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'page.html'), 'new')
  const again = skills.save({ ...base(a), id: saved.id, fromDir: source }).entry
  const dir = dirOf(root, saved.id)
  assert.deepEqual(again.files.map(file => file.path), ['page.html'])
  assert.equal(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), 'new', 'the new file exists (on a case-insensitive disk it is the same file)')
  assert.deepEqual(fs.readdirSync(dir), ['page.html'], 'and the old-case name is gone')
})

test('an agent changes a package skill only by its id; by name alone the save is refused and names the id', t => {
  const { a, open } = fixture(t), skills = open()
  const mine = skills.save({ ...base(a), source: 'user', files: [page], triggers: [{ on: 'task-completed', show: 'page.html' }] }).entry
  for (const input of [{ ...base(a) }, { ...base(a), triggers: [] }, { ...base(a), files: [{ path: 'x.txt', content: 'x' }] }]) {
    assert.throws(() => skills.save(input, agent), new RegExp(`pass its id "${mine.id}"`))
  }
  const kept = skills.read(mine.id, a)
  assert.deepEqual([kept.version, kept.source, kept.triggers.length, kept.files.length], [1, 'user', 1, 1], 'nothing changed')
  const byId = skills.save({ ...base(a), id: mine.id, instructions: 'Edited by id.' }, agent).entry
  assert.deepEqual([byId.version, byId.source, byId.triggers.length], [2, 'user', 1], 'by id it works, and the skill stays the user\'s')
  assert.equal(skills.save({ ...base(a) }).entry.version, 3, 'the user\'s own save by name is not restricted')
})

test('the per-scope cap holds for package skills: a new skill that cannot displace anything is refused, updates still work', t => {
  const { a, open } = fixture(t), skills = open()
  const pack = index => ({ name: `Package ${index}`, instructions: `unique steps ${index}`, scope: 'project', workspace: a, source: 'agent:x', files: [{ path: 'a.txt', content: String(index) }] })
  const saved = []
  for (let index = 0; index < 60; index++) saved.push(skills.save(pack(index), agent).entry)
  assert.throws(() => skills.save(pack(60), agent), /Skill limit: at most 60 project skills/)
  assert.equal(skills.list(a).length, 60)
  assert.equal(skills.save({ ...pack(3), id: saved[3].id, instructions: 'improved' }, agent).entry.version, 2, 'an update of an existing skill is allowed')
  // A plain skill can still be evicted to make room for a new one.
  skills.remove(saved[0].id, a)
  skills.save({ name: 'Plain', instructions: 'plain steps', scope: 'project', workspace: a }, agent)
  assert.equal(skills.list(a).length, 60)
  assert.equal(skills.save({ name: 'Another plain', instructions: 'other unrelated words', scope: 'project', workspace: a }, agent).evicted, 1)
  assert.equal(skills.save(pack(61), agent).evicted, 1, 'a package displaces the last plain skill')
  assert.throws(() => skills.save(pack(62), agent), /Skill limit/, 'and then nothing is left to displace')
})

test('fromDir parses SKILL.md frontmatter; skill.json wins on conflicts; oversized files yield a precise error', t => {
  const { root, a, open } = fixture(t), skills = open()
  const source = path.join(root, 'skill-source')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: MD Name\ndescription: MD Desc. Use when MD.\n---\nMD Instructions')
  
  const savedMd = skills.save({ workspace: a, fromDir: source }, agent).entry
  assert.equal(savedMd.name, 'MD Name')
  assert.equal(savedMd.description, 'MD Desc. Use when MD.')
  assert.equal(savedMd.whenToUse, 'Use when MD.')
  assert.match(savedMd.instructions, /relative paths are relative to the package folder/)
  assert.match(savedMd.instructions, /MD Instructions/)
  
  // both present
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ name: 'JSON Name' }))
  const savedBoth = skills.save({ workspace: a, fromDir: source }, agent).entry
  assert.equal(savedBoth.name, 'JSON Name')
  assert.equal(savedBoth.description, 'MD Desc. Use when MD.')
  
  // oversize handling
  const bigSource = path.join(root, 'skill-source-big')
  fs.mkdirSync(bigSource)
  fs.writeFileSync(path.join(bigSource, 'SKILL.md'), '---\nname: Big\n---\nBig')
  const bigBuffer = Buffer.alloc(1024 * 513) // 513 KB
  fs.writeFileSync(path.join(bigSource, 'large1.docx'), bigBuffer)
  fs.writeFileSync(path.join(bigSource, 'large2.pptx'), bigBuffer)
  
  assert.throws(() => skills.save({ workspace: a, fromDir: bigSource }, agent), /2 files are larger than 512 KB: "large1.docx" \(513 KB\), "large2.pptx" \(513 KB\)/)

  // SKILL.md with no name -> error
  const noName = path.join(root, 'skill-no-name')
  fs.mkdirSync(noName)
  fs.writeFileSync(path.join(noName, 'SKILL.md'), '---\ndescription: No name here\n---\nBody')
  assert.throws(() => skills.save({ workspace: a, fromDir: noName }, agent), /name and instructions are required/)

  // block scalar and quoted strings in frontmatter
  const blockSource = path.join(root, 'skill-block')
  fs.mkdirSync(blockSource)
  fs.writeFileSync(path.join(blockSource, 'SKILL.md'), '---\nname: "Block Skill"\ndescription: >\n  A long description\n  that spans lines. Use when block.\n---\nBlock body')
  const savedBlock = skills.save({ workspace: a, fromDir: blockSource }, agent).entry
  assert.equal(savedBlock.name, 'Block Skill')
  assert.match(savedBlock.description, /long description/)
  assert.equal(savedBlock.whenToUse, 'Use when block.')
  assert.match(savedBlock.instructions, /Block body/)
})

// Agent Skills frontmatter as the ecosystem writes it: a block scalar before other keys must not swallow them, nested
// mappings are skipped, a closing --- may end the file; a package of exactly the file limit installs.
test('SKILL.md: block scalars end at the next key, nested keys are skipped, the file limit is inclusive', t => {
  const { root, a, open } = fixture(t), skills = open()
  const folded = path.join(root, 'skill-folded')
  fs.mkdirSync(folded)
  fs.writeFileSync(path.join(folded, 'SKILL.md'), '\uFEFF---\r\ndescription: >\r\n  Builds charts\r\n  from tables.\r\n\r\n  Use when the user asks for a chart, e.g. a bar chart.\r\nmetadata:\r\n  name: nested-not-the-name\r\nname: chart-maker # the id\r\nlicense: MIT\r\n---')
  const chart = skills.save({ workspace: a, fromDir: folded }, agent).entry
  assert.equal(chart.name, 'chart-maker')
  assert.equal(chart.description, 'Builds charts from tables.\nUse when the user asks for a chart, e.g. a bar chart.')
  assert.equal(chart.whenToUse, 'Use when the user asks for a chart, e.g. a bar chart.')
  const literal = path.join(root, 'skill-literal')
  fs.mkdirSync(literal)
  fs.writeFileSync(path.join(literal, 'SKILL.md'), "---\nname: 'it''s'\ndescription: |\n  line one\n    indented\n---\nBody")
  const kept = skills.save({ workspace: a, fromDir: literal }, agent).entry
  assert.equal(kept.name, "it's")
  assert.equal(kept.description, 'line one\n  indented')
  const full = path.join(root, 'skill-full')
  fs.mkdirSync(full)
  fs.writeFileSync(path.join(full, 'SKILL.md'), '---\nname: full\ndescription: Forty files.\n---\nBody')
  for (let i = 1; i < 40; i++) fs.writeFileSync(path.join(full, `f${i}.txt`), 'x')
  assert.equal(skills.save({ workspace: a, fromDir: full }, agent).entry.name, 'full', 'exactly 40 files install')
  fs.writeFileSync(path.join(full, 'f40.txt'), 'x')
  assert.throws(() => skills.save({ workspace: a, fromDir: full }, agent), /at most 40 files \(found 41\)/)
})
