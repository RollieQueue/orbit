const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Same loader as tests/run-events.test.cjs (vite's oxc transform, then an ES module from a data URL). agent-activity.ts imports
// shownStatus from ./run-events, which a data URL cannot resolve: that module is loaded the same way and its specifier replaced.
let activityOf, waitingReasonOf, activityLabel, countActivities, visibleAgents, matchesFilter, isAgentFilter, WAITING_DETAILS, AGENT_FILTERS, filterNames, effortSourceNames
const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
test.before(async () => {
  const { transformWithOxc } = await import('vite')
  const load = async name => {
    const file = path.join(__dirname, '..', 'src', `${name}.ts`)
    return (await transformWithOxc(fs.readFileSync(file, 'utf8'), file, { lang: 'ts' })).code
  }
  const events = dataUrl(await load('run-events'))
  const code = (await load('agent-activity')).replace(/(from\s+)(['"])\.\/run-events\2/, `$1"${events}"`)
  assert.ok(code.includes(events), 'the run-events import was replaced')
  ;({ activityOf, waitingReasonOf, activityLabel, countActivities, visibleAgents, matchesFilter, isAgentFilter, WAITING_DETAILS, AGENT_FILTERS, filterNames, effortSourceNames } = await import(dataUrl(code)))
})

const agent = (id, status, extra = {}) => ({ id, name: id, status, parentId: id === 'root' ? null : 'root', ...extra })

test('status maps to one activity; the user\'s pause wins over working and waiting', () => {
  assert.equal(activityOf(agent('a', 'working')), 'working')
  assert.equal(activityOf(agent('a', 'done')), 'done')
  assert.equal(activityOf(agent('a', 'error')), 'error')
  assert.equal(activityOf(agent('a', 'cancelled')), 'cancelled')
  assert.equal(activityOf(agent('a', 'interrupted')), 'cancelled')
  assert.equal(activityOf(agent('a', 'restarting')), 'cancelled')
  assert.equal(activityOf(agent('a', 'paused')), 'paused')
  assert.equal(activityOf(agent('a', 'working', { paused: true })), 'paused')
  assert.equal(activityOf(agent('a', 'waiting', { paused: true, detail: 'Queued' })), 'paused')
  // a finished agent that still carries the flag is not shown as paused
  assert.equal(activityOf(agent('a', 'done', { paused: true })), 'done')
})

test('waiting is split by the detail the runtime sets; every other detail is the queue', () => {
  assert.equal(activityOf(agent('a', 'waiting', { detail: 'Waiting for delegated results' })), 'waiting')
  assert.equal(waitingReasonOf(agent('a', 'waiting', { detail: 'Waiting for delegated results' })), 'helpers')
  assert.equal(waitingReasonOf(agent('a', 'waiting', { detail: 'Waiting for a message' })), 'message')
  assert.equal(waitingReasonOf(agent('a', 'waiting', { detail: 'Waiting for your permission' })), 'approval')
  for (const detail of ['Queued', 'Queued follow-up', 'Waiting for a provider slot', 'Continuing conversation', 'Something new', '', undefined]) {
    const queued = agent('a', 'waiting', { detail })
    assert.equal(activityOf(queued), 'queued', String(detail))
    assert.equal(waitingReasonOf(queued), undefined)
  }
  // the detail of a working agent (its progress text) never makes it waiting
  assert.equal(activityOf(agent('a', 'working', { detail: 'Waiting for a message' })), 'working')
  assert.equal(waitingReasonOf(agent('a', 'working', { detail: 'Waiting for a message' })), undefined)
})

test('Russian labels', () => {
  const label = (status, extra) => activityLabel(agent('a', status, extra))
  assert.equal(label('working'), 'Работает')
  assert.equal(label('waiting', { detail: 'Queued' }), 'В очереди')
  assert.equal(label('waiting'), 'В очереди')
  assert.equal(label('waiting', { detail: 'Waiting for delegated results' }), 'Ждёт помощников')
  assert.equal(label('waiting', { detail: 'Waiting for a message' }), 'Ждёт сообщения')
  assert.equal(label('waiting', { detail: 'Waiting for your permission' }), 'Ждёт разрешения')
  assert.equal(label('working', { paused: true }), 'Пауза')
  assert.equal(label('done'), 'Завершён')
  assert.equal(label('error'), 'Ошибка')
  assert.equal(label('cancelled'), 'Остановлен')
  assert.equal(label('interrupted'), 'Прерван')
  assert.equal(label('restarting'), 'Перезапуск Orbit')
  assert.deepEqual(Object.values(filterNames), ['Все', 'Активные', 'Работают', 'В очереди', 'Ждут', 'На паузе', 'Завершены', 'С ошибкой', 'Остановлены'])
})

const team = [
  agent('root', 'waiting', { detail: 'Waiting for delegated results' }),
  agent('lead', 'waiting', { detail: 'Waiting for delegated results', parentId: 'root' }),
  agent('w1', 'working', { parentId: 'lead' }),
  agent('w2', 'working', { parentId: 'lead' }),
  agent('q', 'waiting', { detail: 'Queued' }),
  agent('m', 'waiting', { detail: 'Waiting for a message' }),
  agent('ok', 'done'),
  agent('bad', 'error', { parentId: 'ok' }),
  agent('stop', 'cancelled'),
  agent('hold', 'working', { paused: true }),
]

test('counts: groups, the active total and the waiting reasons', () => {
  const counts = countActivities(team)
  assert.deepEqual({ ...counts, waitingBy: undefined }, { all: 10, active: 7, working: 2, queued: 1, waiting: 3, paused: 1, done: 1, error: 1, cancelled: 1, waitingBy: undefined })
  assert.deepEqual(counts.waitingBy, { helpers: 2, message: 1, approval: 0 })
  assert.equal(countActivities([]).all, 0)
})

test('filter: matches, dimmed ancestors, hidden branches', () => {
  const ids = filter => [...visibleAgents(team, filter)].map(([id, kind]) => `${id}:${kind}`).sort()
  assert.deepEqual(ids('working'), ['lead:context', 'root:context', 'w1:match', 'w2:match'])
  assert.deepEqual(ids('error'), ['bad:match', 'ok:context', 'root:context'])
  assert.deepEqual(ids('done'), ['ok:match', 'root:context'])
  assert.deepEqual(ids('queued'), ['q:match', 'root:context'])
  // a parent that matches too is a match, not context
  assert.deepEqual(ids('waiting'), ['lead:match', 'm:match', 'root:match'])
  assert.deepEqual(ids('active').length, 7)
  assert.equal(visibleAgents(team, 'all').size, 10)
  assert.ok([...visibleAgents(team, 'all').values()].every(kind => kind === 'match'))
  assert.equal(visibleAgents(team, 'cancelled').size, 2)
  assert.equal(visibleAgents([], 'working').size, 0)
})

test('filter: a missing parent ends the chain and a parent cycle does not hang', () => {
  const orphan = [agent('a', 'working', { parentId: 'gone' })]
  assert.deepEqual([...visibleAgents(orphan, 'working')], [['a', 'match']])
  const loop = [agent('x', 'working', { parentId: 'y' }), agent('y', 'done', { parentId: 'x' })]
  assert.deepEqual([...visibleAgents(loop, 'working')].sort(), [['x', 'match'], ['y', 'context']])
})

test('filter ids are validated', () => {
  assert.ok(AGENT_FILTERS.every(isAgentFilter))
  assert.equal(isAgentFilter('nonsense'), false)
  assert.equal(isAgentFilter(null), false)
  assert.equal(matchesFilter('active', 'done'), false)
  assert.equal(matchesFilter('active', 'paused'), true)
  assert.equal(matchesFilter('all', 'error'), true)
  assert.equal(matchesFilter('error', 'error'), true)
})

test('effort source names cover the runtime values', () => {
  assert.deepEqual(Object.keys(effortSourceNames), ['caller', 'routing', 'pool', 'parent', 'settings'])
})

// Drift guard: the strings above are the ones the runtime sets. A renamed detail must fail here, not silently read «В очереди».
test('the runtime still sets the waiting details the filter relies on', () => {
  const dir = path.join(__dirname, '..', 'electron', 'runtime')
  const source = fs.readdirSync(dir).filter(name => name.endsWith('.mts')).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
  for (const [reason, detail] of Object.entries(WAITING_DETAILS)) assert.ok(source.includes(`'${detail}'`), `${reason}: electron/runtime/*.mts no longer sets detail '${detail}'`)
})
