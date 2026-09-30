const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _testing: { createClaudeParser } } = require('../electron/providers.mts')
const { RunStore } = require('../electron/run-store.mts')
const { OrbitRuntime } = require('../electron/runtime.mts')

// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-trace-images-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('a Claude tool result with an image carries the image and names it in the text instead of its bytes', () => {
  const events = []
  const parser = createClaudeParser(event => events.push(event), 'claude-opus-5-5')
  parser.line(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'shot.png' } }] } }))
  // The shape `claude -p --output-format stream-json` prints for the Read tool on a PNG.
  parser.line(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } }] }] } }))
  const result = events.find(event => event.kind === 'tool' && event.status === 'completed')
  assert.deepEqual(result.images, [{ mediaType: 'image/png', data: PNG }])
  assert.equal(result.output, 'Изображение (image/png, 1 КБ)')
  assert.ok(!result.text.includes(PNG), 'the base64 bytes stay out of the trace text')
  // Content without an image reads as before.
  parser.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'hi' }] }] } }))
  const plain = events.at(-1)
  assert.equal(plain.output, JSON.stringify([{ type: 'text', text: 'hi' }]))
  assert.equal(plain.images, undefined)
})

test('the run store keeps an image as its own file and reads back only a name it could have made', t => {
  const root = tempDir(t)
  const store = new RunStore(root)
  const saved = store.saveImage('run-1', { mediaType: 'image/png', data: PNG })
  assert.match(saved.id, /^[\w-]+\.png$/)
  assert.equal(saved.bytes, Buffer.from(PNG, 'base64').length)
  assert.equal(store.readImage('run-1', saved.id), `data:image/png;base64,${PNG}`)
  assert.equal(store.readImage('run-1', '../run-1.json'), null)
  assert.equal(store.readImage('..', saved.id), null)
  assert.equal(store.readImage('run-2', saved.id), null)
  assert.equal(store.saveImage('run-1', { mediaType: 'image/svg+xml', data: PNG }), null)
  // The image folder is not taken for a run file when the store loads again.
  assert.equal(new RunStore(root).list().length, 0)
})

test('a provider tool event with an image becomes a trace that names the saved file', async t => {
  const root = tempDir(t)
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace)
  const store = new RunStore(root)
  const runtime = new OrbitRuntime({ runStore: store, runProvider: async ({ onEvent }) => {
    onEvent({ kind: 'tool', text: 'Изображение (image/png, 1 КБ)', output: 'Изображение (image/png, 1 КБ)', toolId: 't1', tool: 'Read', status: 'completed', native: true, images: [{ mediaType: 'image/png', data: PNG }] })
    return { text: 'Looked at the screenshot.' }
  } })
  let resolve
  const done = new Promise(r => { resolve = r })
  const off = runtime.onEvent(event => { if (['run.finished', 'run.failed', 'run.cancelled'].includes(event.type)) resolve(event) })
  const runId = await runtime.start({ providerId: 'test', prompt: 'Look at the screenshot', accessMode: 'read-only', workspace })
  const timer = setTimeout(() => { runtime.stop(runId); resolve({ type: 'test.timeout' }) }, 8000)
  const ended = await done; clearTimeout(timer); off()
  assert.equal(ended.type, 'run.finished')
  const traces = runtime.getRun(runId).traces.filter(trace => trace.images)
  assert.equal(traces.length, 1)
  assert.equal(traces[0].images[0].mediaType, 'image/png')
  assert.ok(!traces[0].text.includes(PNG))
  assert.equal(store.readImage(runId, traces[0].images[0].id), `data:image/png;base64,${PNG}`)
})
