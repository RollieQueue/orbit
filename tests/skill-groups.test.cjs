const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Same loader as tests/skill-triggers.test.cjs: vite's oxc transform, then an ES module from a data URL (skill-groups.ts has type imports only).
let groups
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const file = path.join(__dirname, '..', 'src', 'skill-groups.ts')
  const out = await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })
  groups = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
})

const skill = (id, over = {}) => ({ id, name: id, description: '', instructions: '', scope: 'project', ...over })
const pkg = { id: 'pkg', dir: 'C:\skills\pkg' }

test('groupOf: commands make a tool, then pages, then files, else an instruction', () => {
  assert.equal(groups.groupOf(skill('a')), 'instructions')
  assert.equal(groups.groupOf(skill('b', { files: [{ path: 'x.txt', size: 1 }], package: pkg })), 'files')
  assert.equal(groups.groupOf(skill('c', { package: pkg, triggers: [{ on: 'task-completed', show: 'p.html' }] })), 'pages')
  assert.equal(groups.groupOf(skill('d', { package: pkg, triggers: [{ on: 'quota-panel', show: 'p.html' }], files: [{ path: 'p.html', size: 1 }] })), 'pages')
  assert.equal(groups.groupOf(skill('e', { package: pkg, commands: [{ name: 'run', run: 'node x.js' }], triggers: [{ on: 'task-completed', show: 'p.html' }] })), 'tools')
  assert.equal(groups.groupOf(skill('f', { triggers: [{ on: 'task-completed', show: 'p.html' }] })), 'instructions', 'a trigger without a package shows nothing')
})

test('groupSkills: fixed group order, counts include connectors, pinned then uses inside a group, empty groups hidden except tools', () => {
  const list = [
    skill('i1', { uses: 1 }), skill('i2', { uses: 5 }), skill('i3', { uses: 9, pinned: true }),
    skill('t1', { commands: [{ name: 'x', run: 'y' }], uses: 2 }), skill('t2', { commands: [{ name: 'x', run: 'y' }], uses: 7 }),
    skill('p1', { package: pkg, triggers: [{ on: 'quota-panel', show: 'p.html' }] }),
  ]
  const result = groups.groupSkills(list, 3)
  assert.deepEqual(result.map(group => [group.id, group.title, group.count]), [['tools', 'Инструменты', 5], ['pages', 'Страницы', 1], ['instructions', 'Инструкции', 3]])
  assert.deepEqual(result[0].skills.map(item => item.id), ['t2', 't1'])
  assert.deepEqual(result[2].skills.map(item => item.id), ['i3', 'i2', 'i1'])
  assert.deepEqual(list.map(item => item.id), ['i1', 'i2', 'i3', 't1', 't2', 'p1'], 'the input is not reordered')
  assert.deepEqual(groups.groupSkills([], 0).map(group => [group.id, group.count]), [['tools', 0]])
  assert.deepEqual(groups.groupSkills([], 2).map(group => [group.id, group.count]), [['tools', 2]])
})

test('sortSkills: by use or by date, pinned first, undated last, stable', () => {
  const list = [
    skill('old', { updatedAt: '2026-01-01T00:00:00Z', uses: 9 }), skill('new', { updatedAt: '2026-09-01T00:00:00Z', uses: 1 }),
    skill('none', { uses: 4 }), skill('pin', { updatedAt: '2025-01-01T00:00:00Z', pinned: true }),
  ]
  assert.deepEqual(groups.sortSkills(list, 'uses').map(item => item.id), ['pin', 'old', 'none', 'new'])
  assert.deepEqual(groups.sortSkills(list, 'date').map(item => item.id), ['pin', 'new', 'old', 'none'])
})

test('parseOrder keeps a known order and falls back to by type', () => {
  for (const order of ['type', 'uses', 'date']) assert.equal(groups.parseOrder(order), order)
  for (const value of [null, undefined, '', 'name', 7]) assert.equal(groups.parseOrder(value), 'type')
})

test('connectors:* handlers list, switch, test and remove by name and scope without secrets', async () => {
  const { createRuntimeApi } = require('../electron/runtime-api.mts')
  const { ConnectorStore } = require('../electron/connectors.mts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-conn-ui-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-conn-ws-'))
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }) })
  const connectorStore = new ConnectorStore(dir)
  connectorStore.add({ name: 'alpha', description: 'a', command: process.execPath, args: ['-e', '0'], env: ['TOKEN=secret-value-1'] }, { scope: 'global' })
  connectorStore.add({ name: 'beta', description: 'b', url: 'http://127.0.0.1:9/mcp?key=secret-value-2', headers: ['Authorization: Bearer secret-value-3'] }, { scope: 'project', workspace: work })
  const handlers = createRuntimeApi({ runtime: {}, quota: {}, stores: { connectorStore }, userData: dir, inspectProviders: async () => [] })
  const call = (channel, ...args) => handlers.get(channel)(...args)

  const listed = call('connectors:list', work)
  assert.deepEqual(listed.map(item => [item.name, item.scope, item.enabled]), [['beta', 'project', true], ['alpha', 'global', true]])
  assert.ok(!JSON.stringify(listed).includes('secret-value'), 'no env or header value in the list')
  assert.deepEqual(listed[1].envKeys, ['TOKEN'])

  assert.equal(call('connectors:enable', 'alpha', false, 'global', work).enabled, false)
  assert.equal(call('connectors:list', work).find(item => item.name === 'alpha').enabled, false)
  assert.throws(() => call('connectors:enable', 'alpha', true, 'bogus', work), /scope must be/)
  assert.throws(() => call('connectors:enable', 'nope', true, 'global', work), /No connector named "nope"/)

  const failed = await call('connectors:test', 'beta', 'project', work)
  assert.equal(failed.ok, false)
  assert.ok(!JSON.stringify(failed).includes('secret-value'), 'the test result hides secrets')
  await assert.rejects(async () => call('connectors:test', 'alpha', 'project', work), /No connector named "alpha"/)

  assert.equal(call('connectors:remove', 'beta', 'project', work).name, 'beta')
  assert.throws(() => call('connectors:remove', 'beta', 'project', work), /No connector named "beta"/)
  assert.deepEqual(call('connectors:list', work).map(item => item.name), ['alpha'])
})
