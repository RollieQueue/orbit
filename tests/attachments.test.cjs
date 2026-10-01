const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { configureAttachments, saveAttachments, discardAttachments, sweepDiscarded, readAttachmentImage, trustedAttachments, attachmentBlock, safeName, attachmentsRoot, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } = require('../electron/attachments.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')
const { _testing } = require('../electron/providers.mts')

// Files attached to a chat message: stored under <userData>/attachments, confined there, and handed to the agents as paths
// in the first prompt of a run and in the mail that reaches a working agent.

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-attachments-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const upload = (name, text, type) => ({ name, type, data: Buffer.from(text).toString('base64') })
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('save: files land under <userData>/attachments/<chat>/ with an id and a safe name, and come back as attachments', async t => {
  const userData = folder(t)
  const saved = await saveAttachments(userData, 'chat-1', [upload('notes.txt', 'hello', 'text/plain'), upload('report.pdf', '%PDF', ''), { name: 'pic.PNG', type: 'image/png', data: PNG }])
  assert.equal(saved.length, 3)
  const [notes, report, pic] = saved
  assert.match(path.basename(notes.path), /^[0-9a-f]{8}-notes\.txt$/)
  assert.equal(path.dirname(notes.path), path.join(attachmentsRoot(userData), 'chat-1'))
  assert.deepEqual([notes.name, notes.type, notes.size], ['notes.txt', 'text/plain', 5])
  assert.equal(fs.readFileSync(notes.path, 'utf8'), 'hello')
  assert.equal(report.type, 'application/pdf', 'no type in the upload: by the extension')
  assert.equal(pic.type, 'image/png'); assert.equal(pic.size, Buffer.from(PNG, 'base64').length)
  assert.equal(new Set(saved.map(item => item.id)).size, 3, 'two uploads never share a file')
  const again = await saveAttachments(userData, 'chat-1', [upload('notes.txt', 'second', 'text/plain')])
  assert.notEqual(again[0].path, notes.path); assert.equal(fs.readFileSync(notes.path, 'utf8'), 'hello', 'the same name does not overwrite')
})

test('save: names and chat ids are sanitised and cannot leave the folder', async t => {
  const userData = folder(t)
  const root = attachmentsRoot(userData)
  const saved = await saveAttachments(userData, '../../evil', [
    upload('..\\..\\windows\\system32\\config.txt', 'x', 'text/plain'), upload('a/b/c.png', 'x', 'image/png'), upload('bad<>:"|?*name.txt', 'x', 'text/plain'),
    upload('CON.txt', 'x', 'text/plain'), upload('...', 'x', ''), upload('x'.repeat(300) + '.txt', 'x', 'text/plain'),
  ])
  for (const item of saved) {
    const relative = path.relative(root, item.path)
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${item.path} stays inside`)
    assert.equal(path.dirname(path.relative(root, item.path)).includes(path.sep), false, 'one folder level: the chat')
  }
  assert.deepEqual(saved.map(item => item.name).slice(0, 4), ['config.txt', 'c.png', 'bad_______name.txt', '_CON.txt'])
  assert.equal(saved[4].name, 'file')
  assert.ok(saved[5].name.length <= 100 && saved[5].name.endsWith('.txt'))
  assert.equal(path.basename(path.dirname(saved[0].path)), '_.._evil')
  assert.equal(safeName(''), 'file'); assert.equal(safeName(undefined), 'file')
  assert.doesNotThrow(() => fs.statSync(saved[0].path))
})

test('save: limits on the number, size and total are refused with a clear text and leave nothing behind', async t => {
  const userData = folder(t)
  const many = Array.from({ length: MAX_FILES + 1 }, (_, index) => upload(`f${index}.txt`, 'x', 'text/plain'))
  await assert.rejects(saveAttachments(userData, 'c', many), /не больше 10 файлов/)
  const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64')
  await assert.rejects(saveAttachments(userData, 'c', [{ name: 'big.bin', type: '', data: big }]), /«big\.bin» больше 20 МБ/)
  const chunk = Buffer.alloc(MAX_FILE_BYTES).toString('base64')
  await assert.rejects(saveAttachments(userData, 'c', [{ name: 'a.bin', data: chunk }, { name: 'b.bin', data: chunk }, { name: 'c.bin', data: chunk }]), /вместе больше 50 МБ/)
  assert.ok(MAX_TOTAL_BYTES < 3 * MAX_FILE_BYTES)
  await assert.rejects(saveAttachments(userData, 'c', []), /Нет файлов/)
  await assert.rejects(saveAttachments(userData, 'c', 'nope'), /Нет файлов/)
  await assert.rejects(saveAttachments(userData, 'c', [{ name: 'x.txt' }]), /пуст или повреждён/)
  assert.ok(!fs.existsSync(path.join(attachmentsRoot(userData), 'c')), 'a refused message saves none of its files')
})

test('readAttachmentImage: an image of the attachments folder becomes a data URL; everything else is null', async t => {
  const userData = folder(t)
  const [pic, text] = await saveAttachments(userData, 'chat', [{ name: 'pic.png', type: 'image/png', data: PNG }, upload('notes.txt', 'hi', 'text/plain')])
  assert.equal(await readAttachmentImage(userData, pic.path), `data:image/png;base64,${PNG}`)
  assert.equal(await readAttachmentImage(userData, text.path), null, 'not an image')
  assert.equal(await readAttachmentImage(userData, path.join(attachmentsRoot(userData), 'chat', 'missing.png')), null)
  const outside = path.join(userData, 'secret.png')
  fs.writeFileSync(outside, Buffer.from(PNG, 'base64'))
  assert.equal(await readAttachmentImage(userData, outside), null, 'an image outside the folder is not read')
  assert.equal(await readAttachmentImage(userData, path.join(attachmentsRoot(userData), '..', 'secret.png')), null, '.. does not climb out')
  assert.equal(await readAttachmentImage(userData, 'relative.png'), null)
  assert.equal(await readAttachmentImage(userData, 42), null)
  const huge = path.join(attachmentsRoot(userData), 'chat', 'huge.png')
  fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.equal(await readAttachmentImage(userData, huge), null, 'over 2 MB: shown as a file, not as a thumbnail')
})

test('trustedAttachments keeps only existing files of the attachments folder and takes their facts from disk', async t => {
  const userData = folder(t)
  const [real] = await saveAttachments(userData, 'chat', [upload('notes.txt', 'twelve bytes', 'text/plain')])
  const outside = path.join(userData, 'outside.txt')
  fs.writeFileSync(outside, 'x')
  const kept = trustedAttachments(userData, [
    { ...real, size: 1, name: 'lie.exe' }, { id: 'x', name: 'outside.txt', type: 'text/plain', size: 1, path: outside },
    { ...real, path: path.join(attachmentsRoot(userData), '..', 'outside.txt') }, { ...real, path: path.join(attachmentsRoot(userData), 'chat', 'gone.txt') },
    { ...real, path: 'notes.txt' }, null, 7, { id: 'y' },
  ])
  assert.equal(kept.length, 1)
  assert.deepEqual([kept[0].path, kept[0].name, kept[0].size, kept[0].type], [real.path, 'notes.txt', 12, 'text/plain'])
  assert.deepEqual(trustedAttachments(userData, undefined), []); assert.deepEqual(trustedAttachments(userData, 'x'), [])
})

test('discard: the named files of the chat folder go, nothing else; an empty list is not the whole folder', async t => {
  const userData = folder(t)
  const [a, b, c] = await saveAttachments(userData, 'chat-1', [upload('a.txt', 'a', 'text/plain'), upload('b.txt', 'b', 'text/plain'), upload('c.txt', 'c', 'text/plain')])
  const [other] = await saveAttachments(userData, 'chat-2', [upload('other.txt', 'o', 'text/plain')])
  const chatFolder = path.dirname(a.path)
  const outside = path.join(userData, '0123abcd-outside.txt')
  fs.writeFileSync(outside, 'x')
  fs.writeFileSync(path.join(chatFolder, 'plain.txt'), 'not saved by Orbit')
  fs.mkdirSync(path.join(chatFolder, 'deadbeef-folder'))
  assert.equal(await discardAttachments(userData, 'chat-1', [
    a.path, b.path, other.path, outside, path.join(chatFolder, '..', '..', '0123abcd-outside.txt'), path.join(chatFolder, 'plain.txt'),
    path.join(chatFolder, 'deadbeef-folder'), path.join(chatFolder, 'deadbeef-gone.txt'), 'deadbeef-relative.txt', 7, null,
  ]), 2)
  assert.deepEqual([a, b, c, other].map(item => fs.existsSync(item.path)), [false, false, true, true], 'only the named files of chat-1')
  assert.ok(fs.existsSync(outside) && fs.existsSync(path.join(chatFolder, 'plain.txt')) && fs.existsSync(path.join(chatFolder, 'deadbeef-folder')))
  assert.equal(await discardAttachments(userData, 'chat-1', []), 0)
  assert.equal(await discardAttachments(userData, 'chat-1', 'x'), 0)
  assert.equal(await discardAttachments(userData, '', [c.path]), 0)
  assert.ok(fs.existsSync(c.path), 'an empty list, a wrong value or no chat removes nothing')
})

test('discard: a deleted chat takes its whole folder, another chat keeps its files, and a link inside is not followed', async t => {
  const userData = folder(t)
  const [mine] = await saveAttachments(userData, 'chat-1', [upload('a.txt', 'a', 'text/plain')])
  const [theirs] = await saveAttachments(userData, 'chat-2', [upload('b.txt', 'b', 'text/plain')])
  const target = path.join(folder(t), 'elsewhere')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
  fs.symlinkSync(target, path.join(path.dirname(mine.path), 'deadbeef-link'), 'junction')
  assert.equal(await discardAttachments(userData, 'chat-1'), 2)
  assert.ok(!fs.existsSync(path.dirname(mine.path)), 'the folder is gone')
  assert.ok(fs.existsSync(theirs.path), 'another chat keeps its files')
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep', 'what the link pointed to stays')
  assert.equal(await discardAttachments(userData, 'chat-2', null), 1, "null (a child runtime's missing argument) is the whole folder too")
  assert.equal(await discardAttachments(userData, 'chat-3'), 0, 'a chat without files')
  assert.ok(fs.existsSync(attachmentsRoot(userData)))
})

test('discard: a folder Windows cannot delete yet (a file open in another program) stays marked and goes at a later sweep or chat deletion', async t => {
  const userData = folder(t)
  const root = attachmentsRoot(userData)
  const [held] = await saveAttachments(userData, 'chat-1', [upload('open.pdf', '%PDF', 'application/pdf'), upload('b.txt', 'b', 'text/plain')])
  const chatFolder = path.dirname(held.path)
  // What Windows does while a viewer holds the PDF: the other files go, that one does not (EBUSY), and so neither does the folder.
  const rm = fs.promises.rm
  const removals = []
  let holding = true
  fs.promises.rm = async (target, options) => {
    removals.push(path.resolve(String(target)))
    if (!holding || path.resolve(String(target)) !== chatFolder) return rm(target, options)
    for (const name of fs.readdirSync(chatFolder)) if (path.join(chatFolder, name) !== held.path) fs.rmSync(path.join(chatFolder, name))
    throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${held.path}'`), { code: 'EBUSY' })
  }
  t.after(() => { fs.promises.rm = rm })
  assert.equal(await discardAttachments(userData, 'chat-1'), 1, 'what could go went')
  assert.deepEqual(fs.readdirSync(chatFolder), [path.basename(held.path)])
  assert.ok(fs.existsSync(`${chatFolder}.discard`), 'the folder is marked for later')
  assert.equal(await sweepDiscarded(userData), 0, 'still held: it stays marked')
  assert.ok(fs.existsSync(`${chatFolder}.discard`))
  // Another chat deleted meanwhile goes first, before the held one is tried again (an Orbit that quits during those
  // retries must not leave it unmarked).
  const [other] = await saveAttachments(userData, 'chat-2', [upload('c.txt', 'c', 'text/plain')])
  removals.length = 0
  assert.equal(await discardAttachments(userData, 'chat-2'), 1)
  assert.equal(removals[0], path.dirname(other.path), 'its own folder is removed before the others are tried')
  assert.deepEqual(fs.readdirSync(root).sort(), ['chat-1', 'chat-1.discard'])
  // The viewer is closed; the next chat deletion, even of a chat without files, takes the earlier folder along.
  holding = false
  assert.equal(await discardAttachments(userData, 'chat-3'), 0)
  assert.deepEqual(fs.readdirSync(root), [], 'the folder and its mark are gone')
  // Only a file named after a chat folder is a mark: a stray mark reaches neither the attachments folder nor anything
  // above it, the folder of a chat whose id ends in .discard is no mark, and a mark whose folder is gone goes.
  fs.mkdirSync(path.join(root, 'keep')); fs.writeFileSync(path.join(root, 'keep', 'deadbeef-x.txt'), 'x')
  fs.mkdirSync(path.join(root, 'keep.discard'))
  for (const name of ['.discard', '..discard', '...discard', 'a b.discard', 'gone.discard']) fs.writeFileSync(path.join(root, name), '')
  assert.equal(await sweepDiscarded(userData), 1)
  assert.deepEqual(fs.readdirSync(root).sort(), ['...discard', '..discard', '.discard', 'a b.discard', 'keep', 'keep.discard'])
  assert.equal(fs.readFileSync(path.join(root, 'keep', 'deadbeef-x.txt'), 'utf8'), 'x')
  assert.equal(await sweepDiscarded(folder(t)), 0, 'no attachments folder yet')
})

// ---- The prompts ----
const payload = (workspace, extra = {}) => ({ workspace, projectId: 'project-1', chatId: 'chat-1', providerId: 'test', prompt: 'Look at my files', ...extra })
async function finished(runtime, start) {
  let resolve
  const terminal = new Promise(done => { resolve = done })
  const unsub = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start(start)
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 5000)
  const event = await terminal
  clearTimeout(timer); unsub()
  assert.notEqual(event.type, 'test.timeout', 'the run must complete')
  return runtime.getRun(runId)
}
const listed = item => `- ${item.path} (${item.type}, `

test('start: the root agent\'s task lists the attachments after the user\'s text, and the run keeps the text as it was', async t => {
  const userData = folder(t), workspace = folder(t)
  const files = await saveAttachments(userData, 'chat-1', [{ name: 'screen shot.png', type: 'image/png', data: PNG }, upload('spec.pdf', '%PDF-1.4', 'application/pdf')])
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => { prompts.push(options.prompt); return { text: 'DONE' } } })
  const snapshot = await finished(runtime, payload(workspace, { attachments: files }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const task = prompts[0].split('YOUR CURRENT TASK:\n')[1]
  assert.ok(task.startsWith('Look at my files\n\nATTACHMENTS FROM THE USER (files attached to this message; read them with your file tools — an image is shown to you when you read it):\n'), task.slice(0, 300))
  for (const item of files) assert.ok(task.includes(listed(item)), `${item.name} is listed with its absolute path`)
  assert.match(task, /screen shot\.png \(image\/png, \d+ B\)/)
  assert.equal(snapshot.prompt, 'Look at my files')
  assert.equal(attachmentBlock([]), ''); assert.equal(attachmentBlock(undefined), '')
})

test('start: files alone make a message; no text and no files is still refused; a restart continuation does not carry them again', async t => {
  const userData = folder(t), workspace = folder(t)
  const files = await saveAttachments(userData, 'chat-1', [upload('a.txt', 'a', 'text/plain')])
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => { prompts.push(options.prompt); return { text: 'DONE' } } })
  const snapshot = await finished(runtime, payload(workspace, { prompt: '  ', attachments: files }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.match(prompts[0], /YOUR CURRENT TASK:\n\(no text, only the attached files\)\n\nATTACHMENTS FROM THE USER/)
  await assert.rejects(runtime.start(payload(workspace, { prompt: ' ', attachments: [] })), /A message is required/)
  const run = [...runtime.runs.values()][0]
  assert.equal(run.startPayload.attachments, undefined, 'a continuation after a restart brings its own message')
})

function fakeMcp() {
  let issued = 0
  return { url: 'http://127.0.0.1:65500/mcp', async start() {}, issueToken({ agentId }) { return `token-${agentId}-${issued++}` }, revoke() {}, stop() {} }
}

test('steering mail (envelope): a message with attachments lists the files under the user\'s words, and is stored with them', async t => {
  const userData = folder(t), workspace = folder(t)
  const files = await saveAttachments(userData, 'chat-1', [upload('log.txt', 'boom', 'text/plain')])
  const prompts = []
  const runtime = new OrbitRuntime({ runProvider: async options => {
    prompts.push(options.prompt)
    if (prompts.length === 1) { assert.equal(runtime.postUserMessage([...runtime.runs.keys()][0], 'root', 'see the log', files).ok, true); return { text: 'Premature' } }
    return { text: 'FINAL' }
  } })
  const snapshot = await finished(runtime, payload(workspace))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  assert.doesNotMatch(prompts[0], /Attached files/)
  assert.match(prompts[1], /MESSAGE FROM THE USER[^\n]*:\n\[[^\]]+\] see the log\nAttached files \(read them with your file tools; an image is shown to you when you read it\):\n- /)
  assert.ok(prompts[1].includes(listed(files[0])))
  const [message] = snapshot.communications.filter(item => item.fromAgentId === 'user' && item.kind === 'message')
  assert.deepEqual(message.attachments.map(item => item.path), [files[0].path])
  assert.ok(snapshot.traces.some(trace => trace.kind === 'message' && trace.text === 'From the user: see the log [log.txt]'))
})

test('a run keeps the newest 20 files attached in it (its first message, then messages to its agents) for its continuation', async t => {
  const workspace = folder(t)
  const file = id => ({ id, name: `${id}.txt`, type: 'text/plain', size: 1, path: path.join(os.tmpdir(), `${id}.txt`) })
  const runtime = new OrbitRuntime({ runProvider: async () => {
    const [runId] = runtime.runs.keys()
    if (runtime.runs.get(runId).communications.some(item => item.fromAgentId === 'user' && item.kind === 'message')) return { text: 'FINAL' }
    runtime.postUserMessage(runId, 'root', 'two more', [file('m1'), file('m2')])
    return { text: 'Premature' }
  } })
  const snapshot = await finished(runtime, payload(workspace, { attachments: Array.from({ length: 22 }, (_, index) => file(`f${index + 1}`)) }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
  const kept = snapshot.attachments.map(item => item.id)
  assert.equal(kept.length, 20)
  assert.deepEqual([kept[0], kept.at(-3), kept.at(-1)], ['f5', 'f22', 'm2'], 'the oldest go first')
})

test('steering mail (session): files alone ride on the next Orbit tool result; no text and no files is refused', async t => {
  const userData = folder(t), workspace = folder(t)
  const files = await saveAttachments(userData, 'chat-1', [upload('data.csv', 'a,b', 'text/csv')])
  const runtime = new OrbitRuntime({ mcp: fakeMcp(), transportFor: () => 'session', runProvider: async options => {
    const runId = [...runtime.runs.keys()][0]
    assert.throws(() => runtime.postUserMessage(runId, 'root', '   ', []), /Сообщение пустое/)
    runtime.postUserMessage(runId, 'root', '', files)
    const result = await runtime.dispatchMcp(options.session.token, 'list_agents', {})
    assert.match(result.text, /\n\n\[orbit:[0-9a-f]{10}\] MESSAGE FROM THE USER \([^\n]*\):\n\[[^\]]+\] \(no text, only the attached files\)\nAttached files \([^\n]*\):\n- /)
    assert.ok(result.text.includes(listed(files[0])))
    return { text: 'FINAL' }
  } })
  const snapshot = await finished(runtime, payload(workspace, { providerId: 'claude' }))
  assert.equal(snapshot.status, 'completed', snapshot.error)
})

// ---- Claude's arguments ----
test('Claude gets --add-dir for the attachments folder, in session and non-session arguments, and only when it knows the profile folder', t => {
  const userData = folder(t)
  const { buildClaudeArgs, buildClaudeSessionArgs, claudeAttachmentArgs } = _testing
  const expected = path.join(userData, 'attachments')
  assert.deepEqual(claudeAttachmentArgs({}), [])
  assert.deepEqual(claudeAttachmentArgs({ ORBIT_USER_DATA_DIR: userData }), ['--add-dir', expected])
  assert.ok(fs.statSync(expected).isDirectory(), 'the folder exists before Claude is told about it')
  const before = process.env.ORBIT_USER_DATA_DIR
  process.env.ORBIT_USER_DATA_DIR = userData
  t.after(() => { if (before === undefined) delete process.env.ORBIT_USER_DATA_DIR; else process.env.ORBIT_USER_DATA_DIR = before })
  const session = { id: '7d3b2a64-2d63-4c7b-8c3e-0f7d43bd4d11', resume: false, mcpUrl: null, token: null }
  for (const args of [buildClaudeArgs({ accessMode: 'read-only' }), buildClaudeSessionArgs({ accessMode: 'read-only' }, session), buildClaudeSessionArgs({ accessMode: 'danger-full-access', approvalPolicy: 'never' }, session)]) {
    assert.equal(args[args.indexOf('--add-dir') + 1], expected)
    assert.equal(args.filter(arg => arg === '--add-dir').length, 1)
  }
  delete process.env.ORBIT_USER_DATA_DIR
  configureAttachments(null)
  assert.ok(!buildClaudeArgs({ accessMode: 'read-only' }).includes('--add-dir'))
})

// The app never has ORBIT_USER_DATA_DIR in the runtime's environment (the child deletes it, in-process never set it): the
// runtime host is what knows the profile folder, so the arguments are checked after a host is built, with no variable.
test('the runtime host configures the attachments folder: Claude args get --add-dir with no environment variable, and the service saves there', async t => {
  const userData = folder(t)
  const before = process.env.ORBIT_USER_DATA_DIR
  delete process.env.ORBIT_USER_DATA_DIR
  t.after(() => { configureAttachments(null); if (before !== undefined) process.env.ORBIT_USER_DATA_DIR = before })
  const { buildClaudeArgs, buildClaudeSessionArgs } = _testing
  const session = { id: '7d3b2a64-2d63-4c7b-8c3e-0f7d43bd4d11', resume: true, mcpUrl: 'http://127.0.0.1:1/mcp', token: 't' }
  assert.ok(!buildClaudeArgs({ accessMode: 'read-only' }).includes('--add-dir'), 'nothing before a host exists')
  // A deleted chat's folder an earlier Orbit could not remove (a file was held open) goes when the runtime starts.
  const leftover = path.join(attachmentsRoot(userData), 'old-chat')
  fs.mkdirSync(leftover, { recursive: true }); fs.writeFileSync(path.join(leftover, 'deadbeef-a.txt'), 'a'); fs.writeFileSync(`${leftover}.discard`, '')
  const { createRuntimeService } = require('../electron/runtime-host.mts')
  const service = createRuntimeService({ userData, repoRoot: path.join(__dirname, '..'), emit() {}, requestApproval: async () => false, log() {}, overrides: { runProvider: async () => ({ text: 'x' }), inspectProviders: async () => [] } })
  t.after(() => service.shutdown('quit'))
  for (const deadline = Date.now() + 4000; fs.existsSync(`${leftover}.discard`) && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(!fs.existsSync(leftover) && !fs.existsSync(`${leftover}.discard`), 'swept at the start')
  const expected = path.join(userData, 'attachments')
  for (const args of [buildClaudeArgs({ accessMode: 'read-only' }), buildClaudeSessionArgs({ accessMode: 'workspace-write' }, session)]) assert.equal(args[args.indexOf('--add-dir') + 1], expected)
  const [saved] = await service.call('attachments:save', ['chat-9', [upload('a.txt', 'hello', 'text/plain')]])
  assert.equal(path.dirname(path.dirname(saved.path)), expected)
  assert.equal((await service.call('attachments:image', [saved.path])), null)
  // The files a continuation names are trusted from the window only inside the attachments folder, like its attachments.
  const outside = path.join(userData, 'deadbeef-outside.txt')
  fs.writeFileSync(outside, 'x')
  const runId = await service.call('runtime:start', [{ workspace: folder(t), projectId: 'p', chatId: 'chat-9', providerId: 'test', prompt: 'hi', resumeAttachments: [{ ...saved, path: outside }, saved] }])
  assert.deepEqual((await service.call('runtime:get', [runId])).attachments.map(item => item.path), [saved.path])
  assert.equal(await service.call('attachments:discard', ['chat-9', [saved.path]]), 1)
  assert.ok(!fs.existsSync(saved.path))
})

// ---- The window's side: limits before anything is read, the note history carries ----
async function windowSide() {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'attachments.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  return import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
}
const fakeFile = (name, size, lastModified = 1) => ({ name, size, lastModified, type: '' })

test('window: addFiles takes what fits, names the first reason for the rest and ignores a file chosen twice', async () => {
  const w = await windowSide()
  const ok = w.addFiles([], [fakeFile('a.txt', 10), fakeFile('a.txt', 10), fakeFile('a.txt', 10, 2)])
  assert.deepEqual(ok.files.map(file => file.lastModified), [1, 2]); assert.equal(ok.error, '')
  const big = w.addFiles([], [fakeFile('huge.bin', w.MAX_FILE_BYTES + 1), fakeFile('small.txt', 1)])
  assert.deepEqual(big.files.map(file => file.name), ['small.txt']); assert.match(big.error, /«huge\.bin» больше 20 МБ/)
  const eleven = w.addFiles([], Array.from({ length: 11 }, (_, index) => fakeFile(`f${index}`, 1)))
  assert.equal(eleven.files.length, 10); assert.match(eleven.error, /не больше 10 файлов/)
  const total = w.addFiles([], [fakeFile('a', 19 * 1048576), fakeFile('b', 19 * 1048576), fakeFile('c', 19 * 1048576)])
  assert.deepEqual(total.files.map(file => file.name), ['a', 'b']); assert.match(total.error, /вместе больше 50 МБ/)
  assert.equal(w.MAX_FILES, MAX_FILES); assert.equal(w.MAX_FILE_BYTES, MAX_FILE_BYTES); assert.equal(w.MAX_TOTAL_BYTES, MAX_TOTAL_BYTES)
})

test('window: isImage by type or extension, sizes in Russian units, and the history note names the paths', async () => {
  const w = await windowSide()
  assert.equal(w.isImage({ type: 'image/png', name: 'x' }), true); assert.equal(w.isImage({ type: '', name: 'Shot.JPG' }), true)
  assert.equal(w.isImage({ type: 'application/pdf', name: 'a.pdf' }), false); assert.equal(w.isImage({ type: 'image/svg+xml', name: 'a.svg' }), false)
  assert.deepEqual([500, 2048, 1572864, 30 * 1048576].map(w.formatSize), ['500 Б', '2 КБ', '1.5 МБ', '30 МБ'])
  assert.equal(w.attachmentNote(undefined), ''); assert.equal(w.attachmentNote([]), '')
  assert.equal(w.attachmentNote([{ id: '1', name: 'a.png', type: 'image/png', size: 1, path: 'C:\o\a.png' }]), '[Вложения этого сообщения: C:\o\a.png (image/png)]')
})

test('window: a message being sent names its files until they are saved; a refused send discards only its own saved copies', async t => {
  const w = await windowSide()
  const pending = w.pendingAttachments([{ name: 'shot.png', size: 5, type: 'image/png' }, { name: '', size: 1, type: '' }])
  assert.deepEqual(pending, [{ id: 'pending-0', name: 'shot.png', type: 'image/png', size: 5, path: '' }, { id: 'pending-1', name: 'файл', type: '', size: 1, path: '' }])
  assert.equal(w.attachmentNote(pending), '', 'a file not saved yet is nothing a later run could open')
  const saved = { id: '1', name: 'a.png', type: 'image/png', size: 1, path: path.join(os.tmpdir(), 'a.png') }
  const calls = []
  const before = globalThis.window
  globalThis.window = { orbit: { discardAttachments: async (...args) => { calls.push(args); return 0 } } }
  t.after(() => { if (before === undefined) delete globalThis.window; else globalThis.window = before })
  w.discardFiles('chat-1', [])
  w.discardFiles('chat-1', pending)
  assert.deepEqual(calls, [], 'no saved copy, no call: never the whole folder by accident')
  w.discardFiles('chat-1', [...pending, saved])
  w.discardChatFiles('chat-2')
  assert.deepEqual(calls, [['chat-1', [saved.path]], ['chat-2']])
  globalThis.window = { orbit: { discardAttachments: async () => { throw new Error('runtime stopped') } } }
  w.discardFiles('chat-1', [saved]); w.discardChatFiles('chat-1')
  await new Promise(resolve => setTimeout(resolve, 10))
  globalThis.window = {}
  assert.doesNotThrow(() => { w.discardFiles('chat-1', [saved]); w.discardChatFiles('chat-1') }, 'a plain browser has no desktop')
})
